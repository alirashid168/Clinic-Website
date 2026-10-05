-- =====================================================================
-- Row-level security. Access is enforced in the database itself:
-- every query from the website runs as the logged-in person.
--   staff    -> has_perm('<key>') from the checkbox grid + branch scope
--   patients -> only their own rows (current_patient_id())
--   public   -> branches, calendar, braces protocol (read only)
-- =====================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'app_settings','cities','branches','doctor_groups','staff','clinicians','permissions',
    'role_permissions','staff_permission_overrides','discount_caps','patients','treatments',
    'braces_protocol','braces_cases','visits','visit_staff','retainer_cases','invoice_templates',
    'invoices','invoice_items','payments','payment_plans','plan_installments','discount_requests',
    'expense_categories','expenses','cash_closings','doctor_commission_rules','photos','xrays',
    'lab_cases','reminders','complaints','complaint_messages','patient_flags','visit_ratings',
    'inventory_items','inventory_stock','inventory_moves','dr_ali_schedule','audit_log'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Public reference data
-- ---------------------------------------------------------------------
create policy "anyone reads cities"   on public.cities   for select using (true);
create policy "anyone reads branches" on public.branches for select using (active or public.is_staff());
create policy "anyone reads calendar" on public.dr_ali_schedule for select using (true);
create policy "anyone reads protocol" on public.braces_protocol for select using (true);
create policy "anyone reads groups"   on public.doctor_groups for select using (true);
create policy "staff read treatments" on public.treatments for select using (public.is_staff() or active);
create policy "staff read templates"  on public.invoice_templates for select using (public.is_staff());
create policy "staff read expense categories" on public.expense_categories for select using (public.is_staff());
create policy "staff read permission list" on public.permissions for select using (public.is_staff());
create policy "staff read settings" on public.app_settings for select using (public.is_staff());
create policy "anyone reads public settings" on public.app_settings for select
  using (key in ('whatsapp_number', 'clinic_timings'));

create policy "admin manages cities"   on public.cities   for all using (public.is_admin()) with check (public.is_admin());
create policy "admin manages branches" on public.branches for all using (public.is_admin()) with check (public.is_admin());
create policy "calendar editors" on public.dr_ali_schedule for all
  using (public.has_perm('schedule.manage')) with check (public.has_perm('schedule.manage'));
create policy "admin manages protocol" on public.braces_protocol for all using (public.is_admin()) with check (public.is_admin());
create policy "admin manages groups"   on public.doctor_groups for all using (public.is_admin()) with check (public.is_admin());
create policy "admin manages treatments" on public.treatments for all
  using (public.has_perm('settings.manage')) with check (public.has_perm('settings.manage'));
create policy "admin manages templates" on public.invoice_templates for all
  using (public.has_perm('settings.manage')) with check (public.has_perm('settings.manage'));
create policy "accounts manage expense categories" on public.expense_categories for all
  using (public.has_perm('expenses.manage')) with check (public.has_perm('expenses.manage'));
create policy "admin manages settings" on public.app_settings for all using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- Staff, permissions
-- ---------------------------------------------------------------------
create policy "staff see staff list" on public.staff for select using (public.is_staff() or id = auth.uid());
create policy "admin manages staff"  on public.staff for all
  using (public.has_perm('users.manage')) with check (public.has_perm('users.manage'));

create policy "staff see clinicians" on public.clinicians for select using (public.is_staff());
create policy "admin manages clinicians" on public.clinicians for all
  using (public.has_perm('users.manage')) with check (public.has_perm('users.manage'));

create policy "staff see role grid" on public.role_permissions for select using (public.is_staff());
create policy "admin edits role grid" on public.role_permissions for all
  using (public.has_perm('users.manage')) with check (public.has_perm('users.manage'));
create policy "see own overrides" on public.staff_permission_overrides for select
  using (staff_id = auth.uid() or public.has_perm('users.manage'));
create policy "admin edits overrides" on public.staff_permission_overrides for all
  using (public.has_perm('users.manage')) with check (public.has_perm('users.manage'));
create policy "staff see caps" on public.discount_caps for select using (public.is_staff());
create policy "admin edits caps" on public.discount_caps for all using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- Patients
-- ---------------------------------------------------------------------
create policy "staff view patients" on public.patients for select
  using (public.has_perm('patients.view') or id = public.current_patient_id());
create policy "staff create patients" on public.patients for insert
  with check (public.has_perm('patients.create'));
create policy "staff edit patients" on public.patients for update
  using (public.has_perm('patients.edit')) with check (public.has_perm('patients.edit'));
create policy "admin deletes patients" on public.patients for delete using (public.is_admin());

-- ---------------------------------------------------------------------
-- Braces and retainers
-- ---------------------------------------------------------------------
create policy "view braces cases" on public.braces_cases for select
  using (public.has_perm('patients.view') or patient_id = public.current_patient_id());
create policy "manage braces cases" on public.braces_cases for all
  using (public.has_perm('braces.manage')) with check (public.has_perm('braces.manage'));

create policy "view retainers" on public.retainer_cases for select
  using (public.has_perm('patients.view') or patient_id = public.current_patient_id());
create policy "manage retainers" on public.retainer_cases for all
  using (public.has_perm('retainers.manage')) with check (public.has_perm('retainers.manage'));

-- ---------------------------------------------------------------------
-- Visits (Aaj ki List)
-- ---------------------------------------------------------------------
create policy "view visits" on public.visits for select
  using ((public.has_perm('sheet.view') and public.can_access_branch(branch_id))
         or patient_id = public.current_patient_id());
create policy "add visits" on public.visits for insert
  with check (public.has_perm('sheet.edit') and public.can_access_branch(branch_id));
create policy "edit visits" on public.visits for update
  using (public.has_perm('sheet.edit') and public.can_access_branch(branch_id))
  with check (public.has_perm('sheet.edit') and public.can_access_branch(branch_id));
create policy "admin deletes visits" on public.visits for delete using (public.is_admin());

create policy "view visit staff" on public.visit_staff for select
  using (exists (select 1 from public.visits v where v.id = visit_id
                 and ((public.has_perm('sheet.view') and public.can_access_branch(v.branch_id))
                      or v.patient_id = public.current_patient_id())));
create policy "edit visit staff" on public.visit_staff for all
  using (public.has_perm('treatment.enter') or public.has_perm('sheet.edit'))
  with check (public.has_perm('treatment.enter') or public.has_perm('sheet.edit'));

-- ---------------------------------------------------------------------
-- Billing
-- ---------------------------------------------------------------------
create policy "view invoices" on public.invoices for select
  using ((public.has_perm('billing.view') and public.can_access_branch(branch_id))
         or (patient_id = public.current_patient_id() and status = 'issued'));
create policy "create invoices" on public.invoices for insert
  with check (public.has_perm('billing.create') and public.can_access_branch(branch_id));
-- Front desk may finish their own drafts; editing issued invoices needs billing.edit.
create policy "edit invoices" on public.invoices for update
  using (public.has_perm('billing.edit')
         or (public.has_perm('billing.create') and created_by = auth.uid() and status in ('draft', 'pending_approval')))
  with check (public.has_perm('billing.edit')
         or (public.has_perm('billing.create') and created_by = auth.uid() and status in ('draft', 'pending_approval', 'issued')));

create policy "view invoice items" on public.invoice_items for select
  using (exists (select 1 from public.invoices i where i.id = invoice_id
                 and ((public.has_perm('billing.view') and public.can_access_branch(i.branch_id))
                      or (i.patient_id = public.current_patient_id() and i.status = 'issued'))));
create policy "edit invoice items" on public.invoice_items for all
  using (exists (select 1 from public.invoices i where i.id = invoice_id
                 and (public.has_perm('billing.edit')
                      or (public.has_perm('billing.create') and i.created_by = auth.uid() and i.status = 'draft'))))
  with check (exists (select 1 from public.invoices i where i.id = invoice_id
                 and (public.has_perm('billing.edit')
                      or (public.has_perm('billing.create') and i.created_by = auth.uid() and i.status = 'draft'))));

create policy "view payments" on public.payments for select
  using ((public.has_perm('billing.view') and public.can_access_branch(branch_id))
         or patient_id = public.current_patient_id());
create policy "take payments" on public.payments for insert
  with check (public.has_perm('billing.create') and public.can_access_branch(branch_id)
              and (amount > 0 or public.has_perm('billing.refund')));
create policy "edit payments" on public.payments for update
  using (public.has_perm('billing.edit')) with check (public.has_perm('billing.edit'));

create policy "view plans" on public.payment_plans for select
  using (public.has_perm('billing.view') or patient_id = public.current_patient_id());
create policy "manage plans" on public.payment_plans for all
  using (public.has_perm('billing.create')) with check (public.has_perm('billing.create'));
create policy "view installments" on public.plan_installments for select
  using (exists (select 1 from public.payment_plans p where p.id = plan_id
                 and (public.has_perm('billing.view') or p.patient_id = public.current_patient_id())));
create policy "manage installments" on public.plan_installments for all
  using (public.has_perm('billing.create')) with check (public.has_perm('billing.create'));

create policy "view discount requests" on public.discount_requests for select
  using (public.has_perm('discount.approve') or requested_by = auth.uid());
-- Requests are created by trigger and decided through decide_discount().

-- ---------------------------------------------------------------------
-- Money: expenses, cash closing, commissions
-- ---------------------------------------------------------------------
create policy "view expenses" on public.expenses for select using (public.has_perm('finance.view'));
create policy "manage expenses" on public.expenses for all
  using (public.has_perm('expenses.manage')) with check (public.has_perm('expenses.manage'));

create policy "view closings" on public.cash_closings for select
  using (public.has_perm('finance.view') or (public.has_perm('cash.close') and public.can_access_branch(branch_id)));
create policy "verify closings" on public.cash_closings for update
  using (public.has_perm('cash.verify')) with check (public.has_perm('cash.verify'));

create policy "view commission rules" on public.doctor_commission_rules for select
  using (public.has_perm('commission.view_all')
         or (public.has_perm('commission.view_own')
             and clinician_id in (select id from public.clinicians where staff_id = auth.uid())));
create policy "manage commission rules" on public.doctor_commission_rules for all
  using (public.has_perm('commission.manage')) with check (public.has_perm('commission.manage'));

-- ---------------------------------------------------------------------
-- Photos and X-rays
-- ---------------------------------------------------------------------
create policy "staff view photos" on public.photos for select
  using ((kind = 'edited' and public.has_perm('patients.view'))
         or public.has_perm('photos.view_raw')
         or (patient_id = public.current_patient_id() and kind = 'edited'));
create policy "staff upload photos" on public.photos for insert with check (public.has_perm('photos.upload'));
create policy "staff edit photos" on public.photos for update
  using (public.has_perm('photos.upload')) with check (public.has_perm('photos.upload'));

create policy "view xrays" on public.xrays for select
  using (public.has_perm('xrays.view') or patient_id = public.current_patient_id());
create policy "upload xrays" on public.xrays for insert with check (public.has_perm('photos.upload'));

-- ---------------------------------------------------------------------
-- Coordinator
-- ---------------------------------------------------------------------
create policy "view lab cases" on public.lab_cases for select using (public.has_perm('lab.manage') or public.has_perm('patients.view'));
create policy "manage lab cases" on public.lab_cases for all
  using (public.has_perm('lab.manage')) with check (public.has_perm('lab.manage'));

create policy "view reminders" on public.reminders for select using (public.has_perm('reminders.manage'));
create policy "manage reminders" on public.reminders for all
  using (public.has_perm('reminders.manage')) with check (public.has_perm('reminders.manage'));

-- ---------------------------------------------------------------------
-- Complaints: patients write, Dr. Ali + coordinator read
-- ---------------------------------------------------------------------
create policy "complaints visible" on public.complaints for select
  using (public.has_perm('complaints.view') or patient_id = public.current_patient_id());
create policy "patients file complaints" on public.complaints for insert
  with check (patient_id = public.current_patient_id() or public.has_perm('complaints.view'));
create policy "staff update complaints" on public.complaints for update
  using (public.has_perm('complaints.view')) with check (public.has_perm('complaints.view'));

create policy "complaint messages visible" on public.complaint_messages for select
  using (public.has_perm('complaints.view')
         or (not internal_note and exists (select 1 from public.complaints c
                where c.id = complaint_id and c.patient_id = public.current_patient_id())));
create policy "complaint messages write" on public.complaint_messages for insert
  with check ((public.has_perm('complaints.view') and author_staff = auth.uid())
           or (author_staff is null and not internal_note and exists (select 1 from public.complaints c
                where c.id = complaint_id and c.patient_id = public.current_patient_id())));

-- ---------------------------------------------------------------------
-- Dr. Ali flag, ratings
-- ---------------------------------------------------------------------
create policy "flags visible" on public.patient_flags for select
  using (public.is_staff() or patient_id = public.current_patient_id());
create policy "flags raise" on public.patient_flags for insert
  with check (public.has_perm('flags.raise') and raised_by = auth.uid());
create policy "flags clear" on public.patient_flags for update
  using (public.has_perm('flags.clear')) with check (public.has_perm('flags.clear'));

create policy "ratings visible" on public.visit_ratings for select
  using (public.has_perm('reminders.manage') or public.is_admin() or patient_id = public.current_patient_id());
create policy "patients rate own visits" on public.visit_ratings for insert
  with check (patient_id = public.current_patient_id()
              and exists (select 1 from public.visits v where v.id = visit_id
                          and v.patient_id = public.current_patient_id() and v.status = 'completed'));
create policy "coordinator follows up ratings" on public.visit_ratings for update
  using (public.has_perm('reminders.manage')) with check (public.has_perm('reminders.manage'));

-- ---------------------------------------------------------------------
-- Inventory
-- ---------------------------------------------------------------------
create policy "view inventory items" on public.inventory_items for select using (public.is_staff());
create policy "manage inventory items" on public.inventory_items for all
  using (public.has_perm('inventory.manage')) with check (public.has_perm('inventory.manage'));
create policy "view stock" on public.inventory_stock for select using (public.is_staff());
create policy "manage stock" on public.inventory_stock for all
  using (public.has_perm('inventory.manage') and public.can_access_branch(branch_id))
  with check (public.has_perm('inventory.manage') and public.can_access_branch(branch_id));
create policy "view moves" on public.inventory_moves for select using (public.has_perm('inventory.manage'));
create policy "record moves" on public.inventory_moves for insert
  with check (public.has_perm('inventory.manage') and public.can_access_branch(branch_id));

-- ---------------------------------------------------------------------
-- Audit log: admin read only; written by triggers only
-- ---------------------------------------------------------------------
create policy "admin reads audit" on public.audit_log for select using (public.has_perm('audit.view'));

-- ---------------------------------------------------------------------
-- Function grants: anonymous visitors cannot call internal functions
-- ---------------------------------------------------------------------
revoke execute on function public.sync_mr_sequence(bigint) from public, anon, authenticated;
revoke execute on function public.deactivate_staff(uuid) from public, anon;
revoke execute on function public.decide_discount(uuid, boolean) from public, anon;
revoke execute on function public.close_cash(smallint, date, numeric, text) from public, anon;
revoke execute on function public.braces_guidance(uuid) from public, anon;
revoke execute on function public.patient_dues(uuid) from public, anon;
grant execute on function public.deactivate_staff(uuid) to authenticated;
grant execute on function public.decide_discount(uuid, boolean) to authenticated;
grant execute on function public.close_cash(smallint, date, numeric, text) to authenticated;
grant execute on function public.braces_guidance(uuid) to authenticated;
grant execute on function public.patient_dues(uuid) to authenticated;
revoke execute on function public.expected_cash(smallint, date) from public, anon;
revoke execute on function public.next_braces_month(uuid) from public, anon;
revoke execute on function public.find_possible_duplicates(text, text) from public, anon;
grant execute on function public.next_braces_month(uuid) to authenticated;
grant execute on function public.find_possible_duplicates(text, text) to authenticated;
-- expected_cash is only used inside close_cash(); no direct access for anyone.
revoke execute on function public.expected_cash(smallint, date) from authenticated;
