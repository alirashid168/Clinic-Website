-- =====================================================================
-- Business rules: identity helpers, permissions, Mr#, tokens, braces
-- protocol enforcement, dues hold, discount caps, invoice numbers,
-- audit log, reporting views.
-- =====================================================================

-- Staff and patient logins live in Supabase Auth.
alter table public.staff
  add constraint staff_auth_user_fk foreign key (id) references auth.users(id) on delete cascade;
alter table public.patients
  add constraint patients_portal_user_fk foreign key (portal_user_id) references auth.users(id) on delete set null;

-- ---------------------------------------------------------------------
-- Identity helpers (security definer so RLS policies can call them)
-- ---------------------------------------------------------------------
create or replace function public.current_staff_role()
returns public.staff_role
language sql stable security definer set search_path = public
as $$
  select role from public.staff where id = auth.uid() and active
$$;

create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.staff where id = auth.uid() and active)
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(public.current_staff_role() = 'admin', false)
$$;

-- Permission check: admin always yes; personal override beats role default.
create or replace function public.has_perm(p_key text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select case
    when public.current_staff_role() is null then false
    when public.current_staff_role() = 'admin' then true
    else coalesce(
      (select o.allowed from public.staff_permission_overrides o
        where o.staff_id = auth.uid() and o.permission_key = p_key),
      (select rp.allowed from public.role_permissions rp
        where rp.role = public.current_staff_role() and rp.permission_key = p_key),
      false)
  end
$$;

-- Branch restriction: staff can be limited to some branches.
create or replace function public.can_access_branch(p_branch smallint)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.staff s
    where s.id = auth.uid() and s.active
      and (s.role = 'admin' or not s.restrict_to_branches or p_branch = any(s.branch_ids))
  )
$$;

create or replace function public.current_patient_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select id from public.patients where portal_user_id = auth.uid()
$$;

create or replace function public.setting(p_key text)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select value from public.app_settings where key = p_key
$$;

-- ---------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger patients_touch before update on public.patients
  for each row execute function public.touch_updated_at();
create trigger visits_touch before update on public.visits
  for each row execute function public.touch_updated_at();
create trigger invoices_touch before update on public.invoices
  for each row execute function public.touch_updated_at();
create trigger expenses_touch before update on public.expenses
  for each row execute function public.touch_updated_at();
create trigger retainer_touch before update on public.retainer_cases
  for each row execute function public.touch_updated_at();
create trigger lab_touch before update on public.lab_cases
  for each row execute function public.touch_updated_at();
create trigger reminders_touch before update on public.reminders
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Mr# generation
-- ---------------------------------------------------------------------
-- Call once after importing old patients: next Mr# = highest numeric Mr# + 1.
-- Odd legacy values like '347-1' are kept and ignored by the sequence.
create or replace function public.sync_mr_sequence(p_minimum bigint default 9841)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
  v_next bigint;
begin
  select greatest(coalesce(max(mr_number::bigint), 0) + 1, p_minimum)
    into v_next
    from public.patients
   where mr_number ~ '^[0-9]+$';
  perform setval('public.mr_number_seq', v_next, false);
  return v_next;
end $$;

create or replace function public.assign_mr_number()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_candidate text;
begin
  if new.mr_number is null or btrim(new.mr_number) = '' then
    loop
      v_candidate := nextval('public.mr_number_seq')::text;
      exit when not exists (select 1 from public.patients where mr_number = v_candidate);
    end loop;
    new.mr_number := v_candidate;
  else
    new.mr_number := btrim(new.mr_number);
  end if;
  new.full_name := regexp_replace(btrim(new.full_name), '\s+', ' ', 'g');
  new.phone := regexp_replace(new.phone, '[^0-9+]', '', 'g');
  if auth.uid() is not null then new.created_by := auth.uid(); end if;
  return new;
end $$;

create trigger patients_assign_mr before insert on public.patients
  for each row execute function public.assign_mr_number();

-- Mr# can never be changed after creation, except by admin (e.g. merging duplicates).
create or replace function public.protect_mr_number()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.mr_number is distinct from old.mr_number and not coalesce(public.is_admin(), false)
     and auth.uid() is not null then
    raise exception 'Mr# cannot be changed (only admin can)';
  end if;
  return new;
end $$;

create trigger patients_protect_mr before update of mr_number on public.patients
  for each row execute function public.protect_mr_number();

-- Possible duplicates for the new-patient form.
create or replace function public.find_possible_duplicates(p_name text, p_phone text)
returns setof public.patients
language sql stable security invoker set search_path = public
as $$
  select * from public.patients p
   where regexp_replace(p.phone, '[^0-9]', '', 'g') = regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')
      or lower(p.full_name) = lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'))
   limit 20
$$;

-- ---------------------------------------------------------------------
-- Dues
-- ---------------------------------------------------------------------
create or replace view public.patient_balances
with (security_invoker = true)
as
select p.id as patient_id,
       coalesce(i.billed, 0)  as billed,
       coalesce(pay.paid, 0)  as paid,
       coalesce(i.billed, 0) - coalesce(pay.paid, 0) as dues
  from public.patients p
  left join (
    select patient_id, sum(total) as billed
      from public.invoices where status = 'issued' group by patient_id
  ) i on i.patient_id = p.id
  left join (
    select patient_id, sum(amount) as paid
      from public.payments group by patient_id
  ) pay on pay.patient_id = p.id;

create or replace function public.patient_dues(p_patient uuid)
returns numeric
language plpgsql stable security definer set search_path = public
as $$
begin
  -- Staff (or server jobs with no user) can check anyone; patients only themselves.
  if auth.uid() is not null and not public.is_staff()
     and public.current_patient_id() is distinct from p_patient then
    raise exception 'not allowed';
  end if;
  return coalesce((select sum(total) from public.invoices
                    where patient_id = p_patient and status = 'issued'), 0)
       - coalesce((select sum(amount) from public.payments where patient_id = p_patient), 0);
end $$;

-- ---------------------------------------------------------------------
-- Braces protocol helpers
-- ---------------------------------------------------------------------
-- Next braces month for a case = last completed month + 1.
create or replace function public.next_braces_month(p_case uuid)
returns smallint
language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_staff()
     and not exists (select 1 from public.braces_cases where id = p_case and patient_id = public.current_patient_id()) then
    raise exception 'not allowed';
  end if;
  return (select (coalesce(max(braces_month), 0) + 1)::smallint
            from public.visits
           where braces_case_id = p_case and status = 'completed' and braces_month is not null);
end $$;

-- Rule for a month; months beyond the defined table reuse the last defined row
-- and are flagged as unconfirmed.
create or replace function public.protocol_for_month(p_month smallint)
returns public.braces_protocol
language sql stable security definer set search_path = public
as $$
  select * from public.braces_protocol
   where month = least(p_month, (select max(month) from public.braces_protocol))
$$;

-- Everything the assistant needs to see for a braces patient on check-in.
create or replace function public.braces_guidance(p_patient uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_case   public.braces_cases;
  v_month  smallint;
  v_rule   public.braces_protocol;
  v_max    smallint;
  v_alerts text[] := '{}';
  v_dues   numeric;
begin
  if not (public.is_staff() or public.current_patient_id() = p_patient) then
    raise exception 'not allowed';
  end if;

  select * into v_case from public.braces_cases
   where patient_id = p_patient and status = 'active';
  if not found then
    return jsonb_build_object('has_active_case', false);
  end if;

  v_month := public.next_braces_month(v_case.id);
  v_rule  := public.protocol_for_month(v_month);
  select max(month) into v_max from public.braces_protocol;
  v_dues  := public.patient_dues(p_patient);

  if v_month > v_max then
    v_alerts := array_append(v_alerts, format('Month %s is beyond the defined protocol (%s months). Rule to confirm with Dr. Ali.', v_month, v_max)::text);
  end if;
  if v_rule.photo_required and v_month <= v_max then
    v_alerts := array_append(v_alerts, 'PHOTO MONTH: click photos before closing this visit.'::text);
  end if;
  if v_rule.requires_dr_ali_plan and v_case.treatment_plan_by_dr_ali is null then
    v_alerts := array_append(v_alerts, 'Ask treatment plan from Dr. Ali.'::text);
  end if;
  if v_rule.extraction_decision and v_case.extraction_plan = 'undecided' then
    v_alerts := array_append(v_alerts, 'Decide and do extractions (record extraction / non-extraction).'::text);
  end if;
  if v_rule.extraction_deadline then
    v_alerts := array_append(v_alerts, 'No extractions beyond this month. Make sure all extractions are done.'::text);
  end if;
  if v_month > 7 and v_case.extraction_plan = 'extraction' and not v_case.extractions_done then
    v_alerts := array_append(v_alerts, 'Extraction case past Month 7 with extractions not marked done. Send to Dr. Ali.'::text);
  end if;
  if v_rule.dues_checkpoint and v_dues > 0 then
    v_alerts := array_append(v_alerts, format('Dues checkpoint: Rs %s must be cleared this month.', to_char(v_dues, 'FM999,999,999'))::text);
  end if;
  if v_rule.retainer_payment_reminder then
    v_alerts := array_append(v_alerts, 'Remind patient about retainer payment.'::text);
  end if;
  if v_case.extraction_plan = 'non_extraction' and v_month > 12 then
    v_alerts := array_append(v_alerts, 'Overrun: non-extraction case past Month 12. On Dr. Ali review list.'::text);
  elsif v_case.extraction_plan = 'extraction' and v_month > 18 then
    v_alerts := array_append(v_alerts, 'Overrun: extraction case past Month 18. On Dr. Ali review list.'::text);
  elsif v_rule.ends_non_extraction and v_case.extraction_plan = 'non_extraction' then
    v_alerts := array_append(v_alerts, 'Target end month for non-extraction case.'::text);
  elsif v_rule.ends_extraction and v_case.extraction_plan = 'extraction' then
    v_alerts := array_append(v_alerts, 'Target end month for extraction case.'::text);
  end if;

  return jsonb_build_object(
    'has_active_case', true,
    'case_id', v_case.id,
    'month', v_month,
    'treating_groups', to_jsonb(v_rule.treating_groups),
    'checker_group', v_rule.checker_group,
    'planned_wire', v_rule.planned_wire,
    'photo_required', v_rule.photo_required and v_month <= v_max,
    'rule_confirmed', v_rule.confirmed and v_month <= v_max,
    'instructions', to_jsonb(v_rule.instructions),
    'dues', v_dues,
    'extraction_plan', v_case.extraction_plan,
    'extractions_done', v_case.extractions_done,
    'has_dr_ali_plan', v_case.treatment_plan_by_dr_ali is not null,
    'alerts', to_jsonb(v_alerts)
  );
end $$;

-- ---------------------------------------------------------------------
-- Visits: tokens, protocol defaults, status rules
-- ---------------------------------------------------------------------
create or replace function public.visit_before_write()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_rule  public.braces_protocol;
  v_mode  text;
  v_dues  numeric;
  v_has_checker boolean;
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.created_by := auth.uid(); end if;
    -- Token: next number for this branch and day.
    if new.token_no is null and new.status <> 'scheduled' and new.legacy_source is null then
      perform pg_advisory_xact_lock(hashtext('token:' || new.branch_id || ':' || new.visit_date));
      select coalesce(max(token_no), 0) + 1 into new.token_no
        from public.visits where branch_id = new.branch_id and visit_date = new.visit_date;
    end if;
    -- Braces case: default to the patient's active case and next month.
    if new.braces_case_id is null and new.braces_month is not null then
      select id into new.braces_case_id from public.braces_cases
       where patient_id = new.patient_id and status = 'active';
    end if;
    if new.braces_case_id is not null and new.braces_month is null then
      new.braces_month := public.next_braces_month(new.braces_case_id);
    end if;
  else
    new.updated_by := auth.uid();
    -- Token when a scheduled patient arrives.
    if new.token_no is null and new.status in ('waiting', 'in_treatment') then
      perform pg_advisory_xact_lock(hashtext('token:' || new.branch_id || ':' || new.visit_date));
      select coalesce(max(token_no), 0) + 1 into new.token_no
        from public.visits where branch_id = new.branch_id and visit_date = new.visit_date;
    end if;
  end if;

  -- Protocol defaults for braces visits.
  -- Always derive protocol flags; clients cannot switch them off.
  if new.braces_month is not null then
    v_rule := public.protocol_for_month(new.braces_month);
    new.photo_required   := coalesce(v_rule.photo_required, false);
    new.checker_required := v_rule.checker_group is not null;
    if new.doctor_group_id is null and array_length(v_rule.treating_groups, 1) = 1 then
      new.doctor_group_id := v_rule.treating_groups[1];
    end if;
  end if;

  -- Status timestamps and rules.
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    if new.status = 'waiting' and new.checked_in_at is null then
      new.checked_in_at := now();
    end if;

    if new.status in ('in_treatment', 'completed')
       and (tg_op = 'INSERT' or old.status not in ('in_treatment', 'completed')) then
      if new.status = 'in_treatment' then new.started_at := coalesce(new.started_at, now()); end if;
      v_dues := public.patient_dues(new.patient_id);
      new.dues_at_checkin := v_dues;
      v_mode := coalesce(public.setting('dues_hold_mode') #>> '{}', 'warn');
      if v_dues > 0 and new.dues_override_by is null then
        if v_mode = 'block'
           or (v_mode = 'block_at_checkpoints' and new.braces_month is not null
               and coalesce((public.protocol_for_month(new.braces_month)).dues_checkpoint, false)) then
          raise exception 'DUES_HOLD: patient has pending dues of Rs %. Clear dues first or get an override.', v_dues
            using errcode = 'P0001';
        end if;
      end if;
    end if;

    if new.status = 'completed' then
      new.completed_at := coalesce(new.completed_at, now());
      if new.protocol_override_by is null then
        if new.photo_required and not new.photos_uploaded then
          raise exception 'PHOTO_REQUIRED: this is a photo month. Upload photos before completing the visit.'
            using errcode = 'P0001';
        end if;
        if new.checker_required and new.checked_by is null then
          raise exception 'CHECK_REQUIRED: this visit must be checked by the checker group before completing.'
            using errcode = 'P0001';
        end if;
      end if;
    end if;
  end if;

  -- checked_by / photos_uploaded are set only by visit_staff_check() / photo_marks_visit().
  if pg_trigger_depth() = 1 and auth.uid() is not null and not public.has_perm('braces.override') then
    if new.checked_by is not null and (tg_op = 'INSERT' or new.checked_by is distinct from old.checked_by) then
      raise exception 'Add the checker on the visit instead of setting checked_by';
    end if;
    if new.photos_uploaded and (tg_op = 'INSERT' or not old.photos_uploaded) then
      raise exception 'photos_uploaded is set by uploading photos';
    end if;
  end if;

  -- Overrides can only be given by people with the right permission.
  if new.dues_override_by is not null
     and (tg_op = 'INSERT' or new.dues_override_by is distinct from old.dues_override_by) then
    if auth.uid() is not null and not public.has_perm('dues.override') then
      raise exception 'You are not allowed to override the dues hold';
    end if;
    new.dues_override_by := coalesce(auth.uid(), new.dues_override_by);
  end if;
  if new.protocol_override_by is not null
     and (tg_op = 'INSERT' or new.protocol_override_by is distinct from old.protocol_override_by) then
    if auth.uid() is not null and not public.has_perm('braces.override') then
      raise exception 'You are not allowed to override the braces protocol';
    end if;
    new.protocol_override_by := coalesce(auth.uid(), new.protocol_override_by);
  end if;

  return new;
end $$;

create trigger visits_before_write before insert or update on public.visits
  for each row execute function public.visit_before_write();

-- Doctors on a braces visit must be in the allowed group for that month;
-- checkers must be in the checker group.
create or replace function public.visit_staff_check()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_visit public.visits;
  v_rule  public.braces_protocol;
  v_group smallint;
  v_is_doctor boolean;
begin
  select * into v_visit from public.visits where id = new.visit_id;
  if v_visit.braces_month is null or v_visit.protocol_override_by is not null then
    return new;
  end if;
  select doctor_group_id, is_doctor into v_group, v_is_doctor
    from public.clinicians where id = new.clinician_id;
  if not coalesce(v_is_doctor, false) then
    if new.role = 'checker' then
      raise exception 'CHECKER_NOT_ALLOWED: only a doctor from the checker group can check this visit' using errcode = 'P0001';
    end if;
    return new;     -- assistants are not restricted by group
  end if;
  -- Dr. Ali himself (no group, admin) may always treat and check.
  if exists (select 1 from public.clinicians c join public.staff s on s.id = c.staff_id
              where c.id = new.clinician_id and s.role = 'admin') then
    if new.role = 'checker' then
      update public.visits set checked_by = new.clinician_id, checked_at = now() where id = new.visit_id;
    end if;
    return new;
  end if;
  v_rule := public.protocol_for_month(v_visit.braces_month);
  if new.role = 'doctor' and (v_group is null or not (v_group = any(v_rule.treating_groups))) then
    raise exception 'GROUP_NOT_ALLOWED: Month % braces visits are for Group %. This doctor is in Group %.',
      v_visit.braces_month, array_to_string(v_rule.treating_groups, ' / '), coalesce(v_group::text, 'none')
      using errcode = 'P0001';
  end if;
  if new.role = 'checker' then
    if v_rule.checker_group is not null and v_group is distinct from v_rule.checker_group then
      raise exception 'CHECKER_NOT_ALLOWED: Month % must be checked by Group %.',
        v_visit.braces_month, v_rule.checker_group using errcode = 'P0001';
    end if;
    update public.visits set checked_by = new.clinician_id, checked_at = now() where id = new.visit_id;
  end if;
  return new;
end $$;

create trigger visit_staff_check before insert or update on public.visit_staff
  for each row execute function public.visit_staff_check();

-- Photos uploaded for a visit tick the visit's photo box.
create or replace function public.photo_marks_visit()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  -- Only a photo whose file really exists in storage ticks the visit's photo box.
  if new.visit_id is not null
     and (auth.uid() is null or exists (select 1 from storage.objects
           where bucket_id = 'clinic-photos' and name = new.storage_path)) then
    update public.visits set photos_uploaded = true where id = new.visit_id and not photos_uploaded;
  end if;
  return new;
end $$;

create trigger photos_mark_visit after insert on public.photos
  for each row execute function public.photo_marks_visit();

-- ---------------------------------------------------------------------
-- Invoices: numbers, subtotal from items, discount caps
-- ---------------------------------------------------------------------
create or replace function public.invoice_before_write()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_role public.staff_role;
  v_cap  public.discount_caps;
  v_pct  numeric;
  v_over boolean := false;
begin
  if tg_op = 'INSERT' then
    if new.invoice_no is null or new.invoice_no = '' then
      new.invoice_no := 'INV-' || to_char(new.issue_date, 'YYYY') || '-'
                        || lpad(nextval('public.invoice_number_seq')::text, 6, '0');
    end if;
    if auth.uid() is not null then new.created_by := auth.uid(); end if;
    if new.template_key is null then
      select key into new.template_key from public.invoice_templates where is_default limit 1;
    end if;
  end if;

  -- Discount cap check for the person making the change.
  if new.discount_amount > 0 and new.discount_approved_by is null
     and (tg_op = 'INSERT' or new.discount_amount is distinct from old.discount_amount
          or new.subtotal is distinct from old.subtotal) then
    v_role := public.current_staff_role();
    if v_role is not null and v_role <> 'admin' then
      select * into v_cap from public.discount_caps where role = v_role;
      v_pct := case when new.subtotal > 0 then new.discount_amount * 100 / new.subtotal else 100 end;
      if not found then
        v_over := true;              -- no cap configured = needs approval
      else
        v_over := (v_cap.max_percent is not null and v_pct > v_cap.max_percent)
               or (v_cap.max_amount is not null and new.discount_amount > v_cap.max_amount);
      end if;
      if v_over and not public.has_perm('discount.approve') then
        new.status := 'pending_approval';
      end if;
    end if;
  end if;

  if new.status = 'void' and (tg_op = 'INSERT' or old.status <> 'void') and new.void_reason is null then
    raise exception 'A reason is required to void an invoice';
  end if;
  return new;
end $$;

create trigger invoices_before_write before insert or update on public.invoices
  for each row execute function public.invoice_before_write();

-- Discount requests are raised automatically for invoices waiting on approval.
create or replace function public.invoice_after_write()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'pending_approval'
     and (tg_op = 'INSERT' or old.status is distinct from 'pending_approval') then
    insert into public.discount_requests (invoice_id, requested_by, discount_amount, reason)
    values (new.id, coalesce(auth.uid(), new.created_by, '00000000-0000-0000-0000-000000000000'),
            new.discount_amount, new.discount_reason);
  end if;
  return new;
end $$;

create trigger invoices_after_write after insert or update on public.invoices
  for each row execute function public.invoice_after_write();

create or replace function public.recalc_invoice_subtotal()
returns trigger language plpgsql security definer set search_path = public
as $$
declare v_id uuid := coalesce(new.invoice_id, old.invoice_id);
begin
  update public.invoices i
     set subtotal = coalesce((select sum(line_total) from public.invoice_items where invoice_id = v_id), 0)
   where i.id = v_id;
  return null;
end $$;

create trigger invoice_items_recalc after insert or update or delete on public.invoice_items
  for each row execute function public.recalc_invoice_subtotal();

-- Approve / reject a discount (accountant or admin).
create or replace function public.decide_discount(p_request uuid, p_approve boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_req public.discount_requests;
begin
  if not public.has_perm('discount.approve') then
    raise exception 'You are not allowed to approve discounts';
  end if;
  select * into v_req from public.discount_requests where id = p_request for update;
  if v_req.status <> 'pending' then raise exception 'Already decided'; end if;
  update public.discount_requests
     set status = case when p_approve then 'approved'::public.approval_status else 'rejected' end,
         decided_by = auth.uid(), decided_at = now()
   where id = p_request;
  if p_approve then
    update public.invoices set status = 'issued', discount_approved_by = auth.uid()
     where id = v_req.invoice_id;
  else
    update public.invoices set status = 'issued', discount_amount = 0, discount_approved_by = auth.uid()
     where id = v_req.invoice_id;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Cash closing
-- ---------------------------------------------------------------------
create or replace function public.expected_cash(p_branch smallint, p_date date)
returns numeric
language sql stable security definer set search_path = public
as $$
  select coalesce(sum(amount), 0) from public.payments
   where branch_id = p_branch and method = 'cash'
     and (received_at at time zone 'Asia/Karachi')::date = p_date
$$;

create or replace function public.close_cash(p_branch smallint, p_date date, p_counted numeric, p_notes text default null)
returns public.cash_closings
language plpgsql security definer set search_path = public
as $$
declare v_row public.cash_closings;
begin
  if not public.has_perm('cash.close') or not public.can_access_branch(p_branch) then
    raise exception 'You are not allowed to close cash for this branch';
  end if;
  insert into public.cash_closings (branch_id, closing_date, expected_cash, counted_cash, closed_by, notes)
  values (p_branch, p_date, public.expected_cash(p_branch, p_date), p_counted, auth.uid(), p_notes)
  returning * into v_row;
  return v_row;
end $$;

-- ---------------------------------------------------------------------
-- Staff deactivation (instant lock-out from all data)
-- ---------------------------------------------------------------------
create or replace function public.deactivate_staff(p_staff uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Only admin can deactivate staff'; end if;
  if p_staff = auth.uid() then raise exception 'You cannot deactivate yourself'; end if;
  update public.staff set active = false, deactivated_at = now(), deactivated_by = auth.uid()
   where id = p_staff;
end $$;

-- ---------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------
create or replace function public.audit_row()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
  values (tg_table_name,
          coalesce(to_jsonb(new) ->> 'id', to_jsonb(old) ->> 'id'),
          tg_op,
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end,
          auth.uid());
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'patients', 'visits', 'visit_staff', 'invoices', 'invoice_items', 'payments',
    'expenses', 'cash_closings', 'discount_requests', 'braces_cases', 'retainer_cases',
    'staff', 'role_permissions', 'staff_permission_overrides', 'discount_caps',
    'patient_flags', 'complaints', 'payment_plans', 'plan_installments',
    'doctor_commission_rules', 'app_settings', 'lab_cases'
  ] loop
    execute format(
      'create trigger %I after insert or update or delete on public.%I
         for each row execute function public.audit_row()', t || '_audit', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Reporting views (security_invoker = RLS of the viewer applies)
-- ---------------------------------------------------------------------
create or replace view public.branch_daily_income
with (security_invoker = true) as
select branch_id,
       (received_at at time zone 'Asia/Karachi')::date as day,
       sum(amount) filter (where amount > 0) as received,
       -sum(amount) filter (where amount < 0) as refunded,
       sum(amount) as net
  from public.payments
 group by 1, 2;

create or replace view public.branch_monthly_pnl
with (security_invoker = true) as
with inc as (
  select branch_id, date_trunc('month', received_at at time zone 'Asia/Karachi')::date as month,
         sum(amount) as income
    from public.payments group by 1, 2
), exp as (
  select branch_id, date_trunc('month', expense_date)::date as month, sum(amount) as expenses
    from public.expenses where branch_id is not null group by 1, 2
)
select coalesce(inc.branch_id, exp.branch_id) as branch_id,
       coalesce(inc.month, exp.month) as month,
       coalesce(inc.income, 0) as income,
       coalesce(exp.expenses, 0) as expenses,
       coalesce(inc.income, 0) - coalesce(exp.expenses, 0) as profit
  from inc full join exp on inc.branch_id = exp.branch_id and inc.month = exp.month;

-- Braces patients who have not been seen for 6+ weeks (drop-off list).
create or replace view public.braces_dropoffs
with (security_invoker = true) as
select bc.patient_id, bc.id as braces_case_id, max(v.visit_date) as last_visit,
       current_date - max(v.visit_date) as days_since
  from public.braces_cases bc
  left join public.visits v on v.braces_case_id = bc.id and v.status = 'completed'
 where bc.status = 'active'
 group by bc.patient_id, bc.id
having max(v.visit_date) is null or max(v.visit_date) < current_date - 42;

-- Dr. Ali review list: flagged patients + braces overruns.
create or replace view public.dr_ali_review_list
with (security_invoker = true) as
select f.patient_id, 'flag'::text as source, f.reason, f.raised_at as since
  from public.patient_flags f where f.cleared_at is null and f.kind = 'see_dr_ali'
union all
select bc.patient_id, 'overrun',
       format('%s case at month %s', replace(bc.extraction_plan::text, '_', '-'),
              public.next_braces_month(bc.id) - 1),
       bc.start_date::timestamptz
  from public.braces_cases bc
 where bc.status = 'active'
   and ((bc.extraction_plan = 'non_extraction' and public.next_braces_month(bc.id) - 1 > 12)
     or (bc.extraction_plan = 'extraction' and public.next_braces_month(bc.id) - 1 > 18));

-- Doctor activity per day (doctor daily log / dashboard).
create or replace view public.clinician_daily_log
with (security_invoker = true) as
select vs.clinician_id, v.visit_date, v.branch_id, vs.role,
       count(*) as visits,
       array_agg(v.id) as visit_ids
  from public.visit_staff vs join public.visits v on v.id = vs.visit_id
 where v.status = 'completed'
 group by 1, 2, 3, 4;
