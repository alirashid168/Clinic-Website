-- =============================================================================
-- The billing desk: the invoice form like Healthwire's (a discount and a doctor per line), the clinic's price list, and editing an
-- invoice or a payment afterwards.
--
-- The owner (Dr. Ali, 15 Oct 2026): "create an invoice should have this page, so we can add it like this: quantity, price,
-- description, discount and the total given below"; "braces kit should be given separate amounts as they are different. please take
-- all payments from the treatment price from healthwire"; "admin and accounts should have edit button. if we enter cash payment as
-- card or vice versa, it creates a problem. so edit option should be given and also clinic coordinator should have this option to
-- edit the invoice".
--
-- 1. invoice_items.discount_amount: the discount on one line, in rupees (the form turns a % into rupees). It is a part of the
--    invoice's own discount_amount, never on top of it: invoices.discount_amount stays the whole discount (lines + the discount on the
--    total), so invoices.total, the discount limits and their approval, dues and every report keep reading the one column they read
--    now. A line's discount can be at most that line's amount, and save_invoice refuses lines whose discounts add up to more than the
--    invoice's discount.
-- 2. invoice_items.clinician_id: "Performed by", the doctor who did that line's treatment (any of the clinic's clinicians).
-- 3. treatments.price_list: true for the price list (what is billed and for how much: "Braces Kit (Made in China)", "Braces Monthly
--    Payment", ...). The rest of public.treatments are the visit types of the Aaj ki List (Monthly, Bonding, Checkup ...), whose
--    drop-downs leave price-list items out; the invoice form shows the price list first, then visit types that have a price. Being
--    rows of public.treatments, invoice lines point at them with invoice_items.treatment_id, and the treatments report counts them.
--    The clinic's own list is loaded by the clinic, never in this public repository:
--      insert into public.treatments (name, category, default_price, price_list, sort_order)
--      values ('<item>', 'braces', <price>, true, 1), ...
--      on conflict (name) do update set default_price = excluded.default_price, active = true;
--    (names are unique among all treatments: an item called like a visit type stays that visit type, now with a price, and the
--    invoice form offers it after the price list; the conflict clause leaves price_list alone so the Aaj ki List keeps it.)
--    The price list is read by staff only: "staff read treatments" let anyone read an active treatment (the visit types), and now
--    leaves price-list items to staff (the website's visitors and patients never needed them).
-- 4. save_invoice: the same function as 20261015000800_invoice_note.sql (idempotency key, the hash of the details, notes, row-level
--    security), now also writing each line's treatment_id, discount_amount and clinician_id. An older page that sends none of them
--    still saves as before.
-- 5. edit_invoice(id, invoice, items): changes an issued invoice's lines, discounts and note in one go, for "Edit or void invoices"
--    (billing.edit) at the branches the person works at. The discount limits and their approval: an edit that makes the discount
--    bigger than it was before the edit (in rupees, or as a share of the sub-total) is checked against the person's limit like a new
--    invoice (over it, the invoice waits for approval and the request is raised); a discount that is not made bigger stays as it was
--    approved or given. A discount that was approved (the invoice's latest discount request was approved: a rejection fills in
--    discount_approved_by too, so that column alone does not say it) cannot be made bigger in rupees without an approver, and an
--    invoice waiting for approval or void is not changed. The same edit sent twice (a slow line) changes nothing the second time.
--    Every change is in the audit log (invoices and invoice_items are audited).
--    decide_discount (20261005000200) is the same but for one addition: a rejected discount also takes the lines' discounts off
--    (the invoice's discount becomes 0, and its lines' discounts are a part of it), so Edit never shows, or saves again, a discount
--    that was rejected.
--    invoice_before_write (the discount-limit rule of every invoice change, last set by 20261007002000_audit_fixes.sql) is the same
--    function with one addition: while edit_invoice swaps an invoice's lines it leaves that invoice's limit check to edit_invoice,
--    which compares with the invoice as it was before the edit (the rule sees one row change at a time: lines going out and in one by
--    one would look like a bigger discount, or a smaller one, on the way). Only edit_invoice sets the marker, for its own transaction.
-- 6. Payments: billing.edit may change a payment's method, amount, time and note (the "edit payments" policy, now also at the
--    person's branches only); payment_stamp lets them correct the time, and keeps a refund's amount (or turning a payment into a
--    refund) for "Give refunds": the method or note of a refund may be corrected by any billing.edit. Who took the payment still
--    cannot be changed. Every change is in the audit log (payments are audited).
--    cash_day_closed(branch, day): whether that day's cash is closed at that branch (yes or no, never an amount), so the payment form
--    warns before a payment of a closed day is changed (that closing's expected cash was counted with the payment as it was).
-- 7. The role grid: the clinic coordinator gets billing.edit ("Edit or void invoices"), on purpose (the owner asked); with the
--    accountant and Dr. Ali that makes three.
-- 8. Reading back what they edit: like the "billers view" policies of 20261015000500 for billing.create, billing.edit may read the
--    invoices, invoice lines and payments of the branches they work at. No totals come with it once 20261015000400_finance_privacy.sql
--    is in: it refuses payments_summary() and total_dues() and empties the branch income views for whoever has neither billing.view
--    nor finance.view. Before it, those add up whatever payments the caller may read. So this file refuses to run while a role has
--    billing.edit without billing.view or finance.view (live: the coordinator) and 20261015000400 is not in yet.
--
-- Additive and safe to run more than once.
-- HOW TO APPLY: Supabase dashboard -> SQL Editor -> paste this whole file -> Run, after 20261015000400_finance_privacy.sql and
-- 20261015000800_invoice_note.sql (order on live: 000400, 000800, 000900).
-- =============================================================================
begin;

-- 1-3. The new columns.
alter table public.invoice_items add column if not exists discount_amount numeric(12,2) not null default 0;
alter table public.invoice_items add column if not exists clinician_id uuid references public.clinicians(id);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoice_items_discount_check' and conrelid = 'public.invoice_items'::regclass) then
    alter table public.invoice_items add constraint invoice_items_discount_check
      check (discount_amount >= 0 and discount_amount <= round(quantity * unit_price, 2));
  end if;
end $$;
comment on column public.invoice_items.discount_amount is
  'The discount on this line in rupees (at most the line''s amount). Part of invoices.discount_amount, which is the whole discount of the invoice.';
comment on column public.invoice_items.clinician_id is
  'Performed by: the doctor who did this line''s treatment (the invoice form''s "Performed by"). NULL = not recorded.';

alter table public.treatments add column if not exists price_list boolean not null default false;
comment on column public.treatments.price_list is
  'true = an item of the clinic''s price list (billed on invoices at default_price); false = a visit type of the Aaj ki List.';
alter policy "staff read treatments" on public.treatments using (public.is_staff() or (active and not price_list));

-- 4. save_invoice with the line fields.
create or replace function public.save_invoice(p_idempotency_key uuid, p_invoice jsonb, p_items jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_head public.invoices%rowtype;
  v_inv  public.invoices%rowtype;
  v_subtotal numeric;
  v_line_discounts numeric;
  v_prev text;
  v_prev_hash text;
  v_hash text;
  v_rows integer;
  v_out  jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'An invoice needs at least one line.';
  end if;

  -- jsonb text is normalised (key order, spacing), so the same details always give the same hash.
  v_hash := md5(jsonb_build_object('invoice', p_invoice, 'items', p_items)::text);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (key, kind, request_hash) values (p_idempotency_key, 'invoice', v_hash)
      on conflict (key) do nothing;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      -- Saved already (an earlier attempt whose answer never arrived): return that invoice,
      -- unless this retry carries different details (then the earlier invoice is NOT what was asked for).
      select k.result_id, k.request_hash into v_prev, v_prev_hash from public.idempotency_keys k
        where k.key = p_idempotency_key and k.kind = 'invoice';
      if v_prev is null then
        raise exception 'This invoice was already saved. Refresh the page to see it.';
      end if;
      select to_jsonb(inv) || jsonb_build_object('items', coalesce(
               (select jsonb_agg(to_jsonb(it)) from public.invoice_items it where it.invoice_id = inv.id), '[]'::jsonb))
        into v_out
        from public.invoices inv where inv.id::text = v_prev;
      if v_out is null then
        raise exception 'This invoice was already saved. Refresh the page to see it.';
      end if;
      if v_prev_hash is not null and v_prev_hash <> v_hash then
        raise exception 'IDEMPOTENCY_MISMATCH: an earlier attempt already saved invoice % with different details. Refresh the patient record and check it (void it if it is wrong) before saving again.', v_out->>'invoice_no';
      end if;
      return v_out;
    end if;
  end if;

  v_head := jsonb_populate_record(null::public.invoices, p_invoice);
  select coalesce(sum(coalesce(i.quantity, 1) * coalesce(i.unit_price, 0)), 0), coalesce(sum(coalesce(i.discount_amount, 0)), 0)
    into v_subtotal, v_line_discounts
    from jsonb_populate_recordset(null::public.invoice_items, p_items) i;
  if v_line_discounts > coalesce(v_head.discount_amount, 0) then
    raise exception 'The discounts on the lines (Rs %) are more than the invoice''s discount (Rs %). The invoice''s discount includes its lines'' discounts.',
      v_line_discounts, coalesce(v_head.discount_amount, 0);
  end if;

  insert into public.invoices (patient_id, branch_id, visit_id, subtotal, discount_amount, discount_reason, notes, status)
  values (v_head.patient_id, v_head.branch_id, v_head.visit_id, v_subtotal,
          coalesce(v_head.discount_amount, 0), v_head.discount_reason, nullif(btrim(v_head.notes), ''), 'draft')
  returning * into v_inv;

  insert into public.invoice_items (invoice_id, treatment_id, description, quantity, unit_price, discount_amount, clinician_id)
  select v_inv.id, i.treatment_id, i.description, coalesce(i.quantity, 1), i.unit_price, coalesce(i.discount_amount, 0), i.clinician_id
    from jsonb_populate_recordset(null::public.invoice_items, p_items) i;

  if v_inv.status::text = 'draft' then
    update public.invoices set status = 'issued' where id = v_inv.id;
  end if;

  if p_idempotency_key is not null then
    update public.idempotency_keys set result_id = v_inv.id::text where key = p_idempotency_key;
  end if;

  select to_jsonb(inv) || jsonb_build_object('items', coalesce(
           (select jsonb_agg(to_jsonb(it)) from public.invoice_items it where it.invoice_id = inv.id), '[]'::jsonb))
    into v_out
    from public.invoices inv where inv.id = v_inv.id;
  return v_out;
end;
$$;
revoke all on function public.save_invoice(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.save_invoice(uuid, jsonb, jsonb) to authenticated;

-- 5. The discount-limit rule, unchanged but for the marker of edit_invoice (app.editing_invoice, local to edit_invoice's transaction).
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

  -- Discount cap check for the person making the change (edit_invoice checks the invoice it is changing itself).
  if new.discount_amount > 0 and new.discount_approved_by is null
     and (tg_op = 'INSERT' or new.discount_amount is distinct from old.discount_amount
          or new.subtotal is distinct from old.subtotal)
     and (tg_op = 'INSERT' or coalesce(current_setting('app.editing_invoice', true), '') is distinct from new.id::text) then
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

  if new.status = 'void' and (tg_op = 'INSERT' or old.status <> 'void')
     and coalesce(btrim(new.void_reason, E' \t\r\n'), '') = '' then
    raise exception 'A reason is required to void an invoice';
  end if;
  return new;
end $$;

-- Whether an invoice's discount stands approved: its latest discount request was approved. (A rejection fills in
-- invoices.discount_approved_by too, so that column does not say it.) Security definer: whoever changes the invoice may not read the
-- requests themselves (only approvers and the requester do). Staff only; yes or no, nothing else.
create or replace function public.invoice_discount_approved(p_invoice uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.is_staff() and coalesce((select r.status = 'approved' from public.discount_requests r where r.invoice_id = p_invoice
                                          order by r.created_at desc limit 1), false)
$$;
revoke all on function public.invoice_discount_approved(uuid) from public, anon;
grant execute on function public.invoice_discount_approved(uuid) to authenticated;

-- decide_discount as 20261005000200 left it, and a rejection takes the lines' discounts off with the invoice's (they are a part of it).
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
    update public.invoice_items set discount_amount = 0 where invoice_id = v_req.invoice_id and discount_amount <> 0;
    update public.invoices set status = 'issued', discount_amount = 0, discount_approved_by = auth.uid()
     where id = v_req.invoice_id;
  end if;
end $$;

-- edit_invoice: an issued invoice's lines, discounts and note, all or nothing.
create or replace function public.edit_invoice(p_invoice_id uuid, p_invoice jsonb, p_items jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_old  public.invoices%rowtype;
  v_head public.invoices%rowtype;
  v_discount numeric;
  v_line_discounts numeric;
  v_now_items text;
  v_new_items text;
  v_subtotal numeric;
  v_role public.staff_role;
  v_cap  public.discount_caps;
  v_pct  numeric;
  v_over boolean;
  v_out jsonb;
begin
  if auth.uid() is null or not public.has_perm('billing.edit') then
    raise exception 'NOT_ALLOWED: changing an invoice needs "Edit or void invoices" in the access list.' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'An invoice needs at least one line.';
  end if;
  select * into v_old from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'This invoice was not found. Refresh the page.';
  end if;
  if not public.can_access_branch(v_old.branch_id) then
    raise exception 'NOT_ALLOWED: you can change invoices only at the branches you work at.' using errcode = '42501';
  end if;
  if v_old.status = 'void' then
    raise exception 'This invoice is void and cannot be changed.';
  end if;
  if v_old.status = 'pending_approval' then
    raise exception 'This invoice''s discount is waiting for approval. Approve or reject the discount first, then change the invoice.';
  end if;

  v_head := jsonb_populate_record(null::public.invoices, p_invoice);
  v_discount := coalesce(v_head.discount_amount, 0);
  select coalesce(sum(coalesce(i.discount_amount, 0)), 0) into v_line_discounts
    from jsonb_populate_recordset(null::public.invoice_items, p_items) i;
  if v_line_discounts > v_discount then
    raise exception 'The discounts on the lines (Rs %) are more than the invoice''s discount (Rs %). The invoice''s discount includes its lines'' discounts.',
      v_line_discounts, v_discount;
  end if;
  -- An approved discount was approved for its amount: a bigger one needs an approver again (a smaller one never does).
  if v_discount > v_old.discount_amount and public.invoice_discount_approved(p_invoice_id) and not public.has_perm('discount.approve') then
    raise exception 'This invoice''s discount was approved by the accountant or Dr. Ali. A bigger discount needs one of them.';
  end if;

  -- The lines, compared as a set: the same lines again (a retry, or only the note changed) are left as they are.
  select coalesce(string_agg(x, '|' order by x), '') into v_now_items from (
    select jsonb_build_array(it.treatment_id, it.description, it.quantity::numeric, it.unit_price::numeric, it.discount_amount::numeric, it.clinician_id)::text as x
      from public.invoice_items it where it.invoice_id = p_invoice_id) s;
  select coalesce(string_agg(x, '|' order by x), '') into v_new_items from (
    select jsonb_build_array(i.treatment_id, i.description, coalesce(i.quantity, 1)::numeric(8,2)::numeric, i.unit_price::numeric(12,2)::numeric,
                             coalesce(i.discount_amount, 0)::numeric(12,2)::numeric, i.clinician_id)::text as x
      from jsonb_populate_recordset(null::public.invoice_items, p_items) i) s;

  -- The limit check of this invoice is made below, against the invoice as it was before the edit (see invoice_before_write).
  perform set_config('app.editing_invoice', p_invoice_id::text, true);
  if v_now_items is distinct from v_new_items then
    delete from public.invoice_items where invoice_id = p_invoice_id;
    insert into public.invoice_items (invoice_id, treatment_id, description, quantity, unit_price, discount_amount, clinician_id)
    select p_invoice_id, i.treatment_id, i.description, coalesce(i.quantity, 1), i.unit_price, coalesce(i.discount_amount, 0), i.clinician_id
      from jsonb_populate_recordset(null::public.invoice_items, p_items) i;
  end if;

  update public.invoices
     set discount_amount = v_discount,
         discount_reason = case when v_discount > 0 then nullif(btrim(v_head.discount_reason), '') end,
         notes = nullif(btrim(v_head.notes), '')
   where id = p_invoice_id
     and (discount_amount, discount_reason, notes) is distinct from
         (v_discount, case when v_discount > 0 then nullif(btrim(v_head.discount_reason), '') end, nullif(btrim(v_head.notes), ''));
  perform set_config('app.editing_invoice', '', true);

  -- A discount made bigger than before the edit, in rupees or as a share of the sub-total, is checked against the person's limit as
  -- for a new invoice: over it (or with no limit set), the invoice waits for approval and the request is raised (invoice_after_write).
  select subtotal into v_subtotal from public.invoices where id = p_invoice_id;
  v_role := public.current_staff_role();
  if v_discount > 0 and (v_discount > v_old.discount_amount or v_discount * v_old.subtotal > v_old.discount_amount * v_subtotal)
     and v_role is not null and v_role <> 'admin' and not public.has_perm('discount.approve') then
    select * into v_cap from public.discount_caps where role = v_role;
    v_pct := case when v_subtotal > 0 then v_discount * 100 / v_subtotal else 100 end;
    if not found then
      v_over := true;
    else
      v_over := (v_cap.max_percent is not null and v_pct > v_cap.max_percent) or (v_cap.max_amount is not null and v_discount > v_cap.max_amount);
    end if;
    if v_over then
      update public.invoices set status = 'pending_approval' where id = p_invoice_id;
    end if;
  end if;

  select to_jsonb(inv) || jsonb_build_object('items', coalesce(
           (select jsonb_agg(to_jsonb(it)) from public.invoice_items it where it.invoice_id = inv.id), '[]'::jsonb))
    into v_out
    from public.invoices inv where inv.id = p_invoice_id;
  return v_out;
end;
$$;
revoke all on function public.edit_invoice(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.edit_invoice(uuid, jsonb, jsonb) to authenticated;

-- 6. Payments: billing.edit corrects the method, amount, time and note, at their branches. A refund's amount (and making a payment a
-- refund) stays a refund-giver's: payment_stamp sees the amount before and after, which a policy cannot, so the method or note of a
-- refund is still corrected by any billing.edit (a cash refund entered as card). New payments keep the "take payments" policy.
alter policy "edit payments" on public.payments
  using (public.has_perm('billing.edit') and public.can_access_branch(branch_id))
  with check (public.has_perm('billing.edit') and public.can_access_branch(branch_id));

create or replace function public.payment_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if tg_op = 'INSERT' then
      new.received_by := auth.uid();
      new.received_at := now();
    elsif new.received_by is distinct from old.received_by
          or (new.received_at is distinct from old.received_at and not public.has_perm('billing.edit')) then
      raise exception 'Payment time and receiver cannot be changed';
    elsif new.amount is distinct from old.amount and (new.amount < 0 or old.amount < 0) and not public.has_perm('billing.refund') then
      raise exception 'Only staff who give refunds ("Give refunds" in the access list) change the amount of a refund or turn a payment into one.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

-- Whether the cash of a day is closed at a branch: yes or no, never an amount (the payment form warns before a payment of a closed day
-- is changed). For billing.edit at their branches.
create or replace function public.cash_day_closed(p_branch smallint, p_day date)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is null or not public.has_perm('billing.edit') or not public.can_access_branch(p_branch) then
    raise exception 'NOT_ALLOWED: this is for "Edit or void invoices" at the branches you work at.' using errcode = '42501';
  end if;
  return exists (select 1 from public.cash_closings c where c.branch_id = p_branch and c.closing_date = p_day);
end $$;
revoke all on function public.cash_day_closed(smallint, date) from public, anon;
grant execute on function public.cash_day_closed(smallint, date) to authenticated;

-- 7. The clinic coordinator edits invoices and payments.
insert into public.role_permissions (role, permission_key, allowed)
values ('coordinator', 'billing.edit', true)
on conflict (role, permission_key) do update set allowed = true where public.role_permissions.allowed is distinct from true;

-- 8. billing.edit reads what it edits, at its branches.
drop policy if exists "editors view invoices" on public.invoices;
create policy "editors view invoices" on public.invoices for select
  using (public.has_perm('billing.edit') and public.can_access_branch(branch_id));

drop policy if exists "editors view invoice items" on public.invoice_items;
create policy "editors view invoice items" on public.invoice_items for select
  using (exists (select 1 from public.invoices i
                  where i.id = invoice_items.invoice_id
                    and public.has_perm('billing.edit') and public.can_access_branch(i.branch_id)));

drop policy if exists "editors view payments" on public.payments;
create policy "editors view payments" on public.payments for select
  using (public.has_perm('billing.edit') and public.can_access_branch(branch_id));

-- 9. No totals through these reads: until 20261015000400_finance_privacy.sql is in, payments_summary(), total_dues() and the branch
-- income views add up every payment the caller may read. A role with billing.edit but neither billing.view nor finance.view (live:
-- the coordinator) would get its branches' totals from them, so this file is undone (the whole transaction) until 000400 is applied.
-- (000400's payments_summary refuses with NOT_ALLOWED; it runs the same before or after this file.) Only the role grid is looked
-- at, not a tick for one person (staff_permission_overrides).
do $$
declare
  v_role text;
begin
  select rp.role::text into v_role
    from public.role_permissions rp
   where rp.permission_key = 'billing.edit' and rp.allowed and rp.role::text <> 'admin'
     and not exists (select 1 from public.role_permissions v
                      where v.role = rp.role and v.permission_key in ('billing.view', 'finance.view') and v.allowed)
   order by rp.role::text limit 1;
  if v_role is not null
     and position('NOT_ALLOWED' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.payments_summary(date, date, bigint, text)')), '')) = 0 then
    raise exception 'Apply 20261015000400_finance_privacy.sql before this file. The role "%" gets "Edit or void invoices" without "View invoices and payments", and until that file is in, the payments it may read would be added up into branch and day totals for it. Nothing in this file was applied.', v_role;
  end if;
end $$;

commit;

-- Tell the API about the new columns and functions straight away.
notify pgrst, 'reload schema';
