-- =====================================================================
-- Security hardening after an independent review. Each block closes a
-- confirmed way for someone to see or change what they should not.
-- =====================================================================

-- 1. Patient portal logins can only be linked by the invite function (or admin),
--    never by editing the patient row.
create or replace function public.guard_patient_portal_link() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if tg_op = 'INSERT' and new.portal_user_id is not null then
      raise exception 'Portal logins are linked by the invite function only';
    elsif tg_op = 'UPDATE' and new.portal_user_id is distinct from old.portal_user_id then
      raise exception 'Portal logins are linked by the invite function only';
    end if;
    -- Once a patient has a portal login, only admin may change the email it was sent to.
    if tg_op = 'UPDATE' and old.portal_user_id is not null and new.email is distinct from old.email then
      raise exception 'This patient has a portal login. Only Dr. Ali can change their email.';
    end if;
  end if;
  return new;
end $$;
create trigger patients_guard_portal before insert or update on public.patients
  for each row execute function public.guard_patient_portal_link();

-- Separate permission for sending portal invitations.
insert into public.permissions (key, label, category, sort_order) values
  ('portal.invite', 'Invite patients to the patient portal', 'Patients', 13);
insert into public.role_permissions (role, permission_key, allowed)
select r, 'portal.invite', r in ('coordinator', 'admin')
  from unnest(enum_range(null::public.staff_role)) as r;

-- 2. Nobody but admin can create or change admin accounts, change their own
--    role/branches/active flag, change their own permissions, or edit the role grid.
create or replace function public.guard_staff_row() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.is_admin() then return new; end if;
  if new.role = 'admin' then raise exception 'Only admin can create or promote admin accounts'; end if;
  if tg_op = 'UPDATE' then
    if old.role = 'admin' then raise exception 'Only admin can change an admin account'; end if;
    if new.id = auth.uid() and (new.role, new.active, new.restrict_to_branches, new.branch_ids)
       is distinct from (old.role, old.active, old.restrict_to_branches, old.branch_ids) then
      raise exception 'You cannot change your own role, branches or active flag';
    end if;
  end if;
  return new;
end $$;
create trigger staff_guard before insert or update on public.staff
  for each row execute function public.guard_staff_row();

create or replace function public.guard_staff_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() and (old.role = 'admin' or old.id = auth.uid()) then
    raise exception 'Only admin can delete this account';
  end if;
  return old;
end $$;
create trigger staff_guard_delete before delete on public.staff
  for each row execute function public.guard_staff_delete();

create or replace function public.guard_own_overrides() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin()
     and (coalesce(new.staff_id, old.staff_id) = auth.uid()
          or exists (select 1 from public.staff where id = coalesce(new.staff_id, old.staff_id) and role = 'admin')) then
    raise exception 'You cannot change your own (or an admin''s) permissions';
  end if;
  return coalesce(new, old);
end $$;
create trigger overrides_guard before insert or update or delete on public.staff_permission_overrides
  for each row execute function public.guard_own_overrides();

alter policy "admin edits role grid" on public.role_permissions
  using (public.is_admin()) with check (public.is_admin());

-- 3. Discounts above the cap cannot be self-approved or pushed to "issued".
create or replace function public.invoice_guard_approval() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.has_perm('discount.approve') then return new; end if;
  if tg_op = 'INSERT' and new.discount_approved_by is not null then
    raise exception 'Only an approver can set discount_approved_by';
  end if;
  if tg_op = 'UPDATE' then
    if new.discount_approved_by is distinct from old.discount_approved_by then
      raise exception 'Only an approver can set discount_approved_by';
    end if;
    if old.status = 'pending_approval' and new.status not in ('pending_approval', 'void') then
      raise exception 'This invoice is waiting for discount approval';
    end if;
    if old.status = 'issued' and (new.subtotal, new.discount_amount) is distinct from (old.subtotal, old.discount_amount)
       and not public.has_perm('billing.edit') then
      raise exception 'Issued invoices can only be changed by the accountant';
    end if;
  end if;
  return new;
end $$;
create trigger invoices_guard_approval before insert or update on public.invoices
  for each row execute function public.invoice_guard_approval();

-- 4. Raw photos only for staff allowed to see raw photos; others see edited ones.
alter policy "staff read clinic photos" on storage.objects
  using (bucket_id = 'clinic-photos'
         and (public.has_perm('photos.view_raw')
              or ((storage.foldername(name))[2] = 'edited' and public.has_perm('patients.view'))));

-- 5. Only Dr. Ali can record himself as the checker.
create or replace function public.guard_admin_checker() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.role = 'checker' and auth.uid() is not null and exists (
       select 1 from public.clinicians c join public.staff s on s.id = c.staff_id
        where c.id = new.clinician_id and s.role = 'admin' and s.id <> auth.uid()) then
    raise exception 'Only Dr. Ali can record his own check';
  end if;
  return new;
end $$;
create trigger visit_staff_guard_admin_checker before insert or update on public.visit_staff
  for each row execute function public.guard_admin_checker();

-- 6. Branch restriction also covers who is recorded on a visit.
alter policy "edit visit staff" on public.visit_staff
  using ((public.has_perm('treatment.enter') or public.has_perm('sheet.edit'))
         and exists (select 1 from public.visits v where v.id = visit_id and public.can_access_branch(v.branch_id)))
  with check ((public.has_perm('treatment.enter') or public.has_perm('sheet.edit'))
         and exists (select 1 from public.visits v where v.id = visit_id and public.can_access_branch(v.branch_id)));

-- 7. Verifying a cash closing cannot change the amounts.
create or replace function public.cash_closing_verify_only() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if (new.branch_id, new.closing_date, new.expected_cash, new.counted_cash, new.closed_by, new.closed_at)
       is distinct from (old.branch_id, old.closing_date, old.expected_cash, old.counted_cash, old.closed_by, old.closed_at) then
      raise exception 'Only verification fields can be changed';
    end if;
    new.verified_by := auth.uid();
    new.verified_at := now();
  end if;
  return new;
end $$;
create trigger cash_closings_verify_only before update on public.cash_closings
  for each row execute function public.cash_closing_verify_only();

-- 8. Front desk adds lines to their own draft or pending invoices.
alter policy "edit invoice items" on public.invoice_items
  using (exists (select 1 from public.invoices i where i.id = invoice_id
                 and (public.has_perm('billing.edit')
                      or (public.has_perm('billing.create') and i.created_by = auth.uid() and i.status in ('draft', 'pending_approval')))))
  with check (exists (select 1 from public.invoices i where i.id = invoice_id
                 and (public.has_perm('billing.edit')
                      or (public.has_perm('billing.create') and i.created_by = auth.uid() and i.status in ('draft', 'pending_approval')))));

-- 9. Who-did-it and when fields are stamped by the database, not the browser.
create or replace function public.payment_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if tg_op = 'INSERT' then
      new.received_by := auth.uid();
      new.received_at := now();
    elsif new.received_at is distinct from old.received_at or new.received_by is distinct from old.received_by then
      raise exception 'Payment time and receiver cannot be changed';
    end if;
  end if;
  return new;
end $$;
create trigger payments_stamp before insert or update on public.payments
  for each row execute function public.payment_stamp();

create or replace function public.complaint_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_staff() then
    new.status := 'new'; new.resolved_by := null; new.resolved_at := null; new.created_at := now();
  end if;
  return new;
end $$;
create trigger complaints_stamp before insert on public.complaints
  for each row execute function public.complaint_stamp();

create or replace function public.rating_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_staff() then
    new.followed_up_by := null; new.followed_up_at := null; new.created_at := now();
  end if;
  return new;
end $$;
create trigger ratings_stamp before insert on public.visit_ratings
  for each row execute function public.rating_stamp();

create or replace function public.flag_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' then new.raised_by := auth.uid(); new.raised_at := now(); new.cleared_at := null; new.cleared_by := null;
    elsif new.cleared_at is not null and old.cleared_at is null then new.cleared_by := auth.uid(); new.cleared_at := now();
    end if;
  end if;
  return new;
end $$;
create trigger patient_flags_stamp before insert or update on public.patient_flags
  for each row execute function public.flag_stamp();

create or replace function public.expense_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and tg_op = 'INSERT' then new.created_by := auth.uid(); new.created_at := now(); end if;
  return new;
end $$;
create trigger expenses_stamp before insert on public.expenses
  for each row execute function public.expense_stamp();

-- 10. Dues for the screens: staff with the $$ permission see real dues
--     (the patient_balances view follows billing permissions, so assistants
--     would otherwise see zero).
create or replace function public.dues_for(p_patients uuid[])
returns table (patient_id uuid, dues numeric)
language sql stable security definer set search_path = public
as $$
  select p.id,
         coalesce((select sum(total) from public.invoices i where i.patient_id = p.id and i.status = 'issued'), 0)
       - coalesce((select sum(amount) from public.payments y where y.patient_id = p.id), 0)
    from public.patients p
   where p.id = any(p_patients)
     and (public.has_perm('dues.view') or p.id = public.current_patient_id())
$$;
revoke execute on function public.dues_for(uuid[]) from public, anon;
grant execute on function public.dues_for(uuid[]) to authenticated;

-- 11. Smaller hardening.
revoke execute on function public.setting(text) from public, anon;
revoke execute on function public.next_braces_month(uuid) from public, anon;
revoke truncate, trigger, references on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke truncate, trigger, references on tables from anon, authenticated;

-- The public before/after gallery must be listable by website visitors.
create policy "anyone lists public cases" on storage.objects for select
  using (bucket_id = 'public-cases');
