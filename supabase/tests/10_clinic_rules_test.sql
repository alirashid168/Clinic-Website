-- =====================================================================
-- Database rule tests. Each check raises an error if it fails.
-- Runs as superuser for setup, then as each staff member / patient.
-- =====================================================================
\set ON_ERROR_STOP 1

-- Fixed ids --------------------------------------------------------------
\set admin       '''00000000-0000-0000-0000-0000000000a1'''
\set fd_nn       '''00000000-0000-0000-0000-0000000000f1'''
\set assistant   '''00000000-0000-0000-0000-0000000000b1'''
\set accountant  '''00000000-0000-0000-0000-0000000000c1'''
\set coord       '''00000000-0000-0000-0000-0000000000d1'''
\set pat_user    '''00000000-0000-0000-0000-0000000000e1'''
\set pat_user2   '''00000000-0000-0000-0000-0000000000e2'''

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'TEST FAILED: %', msg; end if;
  raise notice 'ok - %', msg;
end $$;

-- Expect a statement to fail; returns the error text.
create or replace function pg_temp.expect_error(sql text, needle text, msg text) returns void language plpgsql as $$
begin
  execute sql;
  raise exception 'TEST FAILED (no error): %', msg;
exception when others then
  if sqlerrm like 'TEST FAILED%' then raise; end if;
  if position(needle in sqlerrm) = 0 then
    raise exception 'TEST FAILED: % (unexpected error: %)', msg, sqlerrm;
  end if;
  raise notice 'ok - % (blocked: %)', msg, left(sqlerrm, 70);
end $$;

grant execute on all functions in schema pg_temp to authenticated, anon;

-- Setup (superuser) -----------------------------------------------------
insert into auth.users (id, email) values
  (:admin, 'ali@dralirashid.com'), (:fd_nn, 'frontdesk.nn@dralirashid.com'),
  (:assistant, 'assistant@dralirashid.com'), (:accountant, 'accounts@dralirashid.com'),
  (:coord, 'coordinator@dralirashid.com'), (:pat_user, null), (:pat_user2, null);

insert into public.staff (id, full_name, email, role) values
  (:admin, 'Dr. Ali Rashid', 'ali@dralirashid.com', 'admin'),
  (:assistant, 'Sheraz', 'assistant@dralirashid.com', 'assistant'),
  (:accountant, 'Sadia', 'accounts@dralirashid.com', 'accountant'),
  (:coord, 'Coordinator', 'coordinator@dralirashid.com', 'coordinator');
insert into public.staff (id, full_name, email, role, restrict_to_branches, branch_ids, home_branch_id) values
  (:fd_nn, 'Front Desk NN', 'frontdesk.nn@dralirashid.com', 'front_desk', true,
   array[(select id from public.branches where code = 'NN')], (select id from public.branches where code = 'NN'));
update public.clinicians set staff_id = :admin where display_name = 'Dr. Ali Rashid';

-- Legacy patients from Healthwire keep their numbers. The website's own numbers start at 50000, whatever Healthwire has reached
-- (20261009000400: sync_mr_sequence() ignores everything below 50000).
insert into public.patients (mr_number, full_name, phone, legacy_source, legacy_name)
values ('9840', 'Shuhrad', '03001234567', 'healthwire', 'Shuhrad'),
       ('347-1', 'Shahzain Tariq', '03007654321', 'aaj_ki_list', 'Shahzain Tariq');
select public.sync_mr_sequence();

-- =====================================================================
-- 1. Patients and Mr#
-- =====================================================================
select set_config('request.jwt.claim.sub', :fd_nn, false);
set role authenticated;

insert into public.patients (full_name, phone, first_branch_id)
values ('  Aiza   Azeem ', '0300-111 2222', (select id from public.branches where code = 'NN'));
select pg_temp.check((select mr_number from public.patients where full_name = 'Aiza Azeem') = '50000',
  'new patient gets the first website Mr# (50000, not after the highest Healthwire number 9840), name cleaned');
select pg_temp.check((select phone from public.patients where full_name = 'Aiza Azeem') = '03001112222',
  'phone number normalised');
insert into public.patients (full_name, phone) values ('Maham Habib', '03002223333');
select pg_temp.check((select mr_number from public.patients where full_name = 'Maham Habib') = '50001',
  'second new patient gets 50001');
select pg_temp.check((select count(*) from public.patients where mr_number = '347-1') = 1,
  'odd legacy Mr# 347-1 kept as is');
select pg_temp.expect_error($$update public.patients set mr_number = '1' where full_name = 'Maham Habib'$$,
  'cannot be changed', 'front desk cannot change Mr#');
select pg_temp.expect_error($$insert into public.patients (full_name, phone) values ('No Phone', '')$$,
  'phone_not_blank', 'phone number is mandatory');
reset role; select set_config('request.jwt.claim.sub', '', false);

select set_config('request.jwt.claim.sub', :assistant, false);
set role authenticated;
select pg_temp.expect_error($$insert into public.patients (full_name, phone) values ('X Y', '03009998887')$$,
  'row-level security', 'assistant cannot register patients (not ticked in grid)');
reset role; select set_config('request.jwt.claim.sub', '', false);

-- =====================================================================
-- 2. Tokens and branch restriction
-- =====================================================================
select set_config('request.jwt.claim.sub', :fd_nn, false);
set role authenticated;
insert into public.visits (patient_id, branch_id, treatment_label)
select id, (select id from public.branches where code = 'NN'), 'Checkup'
  from public.patients where full_name in ('Aiza Azeem', 'Maham Habib');
select pg_temp.check((select array_agg(token_no order by token_no) from public.visits) = '{1,2}',
  'tokens 1 and 2 assigned at NN today');
select pg_temp.expect_error($$insert into public.visits (patient_id, branch_id)
  select id, (select id from public.branches where code = 'DHA') from public.patients limit 1$$,
  'row-level security', 'NN front desk cannot add visits at DHA');
reset role; select set_config('request.jwt.claim.sub', '', false);

-- A DHA visit created by admin is invisible to NN front desk.
select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
insert into public.visits (patient_id, branch_id, treatment_label)
select id, (select id from public.branches where code = 'DHA'), 'Checkup'
  from public.patients where mr_number = '9840';
select pg_temp.check((select token_no from public.visits v join public.branches b on b.id = v.branch_id
  where b.code = 'DHA') = 1, 'DHA has its own token count starting at 1');
reset role; select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.sub', :fd_nn, false);
set role authenticated;
select pg_temp.check((select count(*) from public.visits) = 2, 'NN front desk only sees NN visits');
reset role; select set_config('request.jwt.claim.sub', '', false);

-- =====================================================================
-- 3. Braces protocol
-- =====================================================================
-- Aiza: braces case with 3 completed months, so next visit is Month 4.
insert into public.braces_cases (patient_id, start_date, extraction_plan)
select id, current_date - 100, 'undecided' from public.patients where full_name = 'Aiza Azeem';
insert into public.visits (patient_id, branch_id, visit_date, status, braces_case_id, braces_month, protocol_override_by)
select bc.patient_id, (select id from public.branches where code = 'NN'), current_date - (100 - m * 30),
       'completed', bc.id, m, :admin
  from public.braces_cases bc, generate_series(1, 3) m;
select pg_temp.check(public.next_braces_month((select id from public.braces_cases)) = 4,
  'next braces month = 4 after three completed months');

select set_config('request.jwt.claim.sub', :assistant, false);
set role authenticated;
select pg_temp.check((public.braces_guidance((select id from public.patients where full_name = 'Aiza Azeem')) ->> 'month')::int = 4,
  'guidance shows Month 4');
select pg_temp.check((public.braces_guidance((select id from public.patients where full_name = 'Aiza Azeem')) ->> 'photo_required')::boolean,
  'Month 4 is a photo month');
select pg_temp.check((public.braces_guidance((select id from public.patients where full_name = 'Aiza Azeem')) -> 'alerts')::text
  like '%Decide and do extractions%', 'Month 4 asks to decide extractions');

insert into public.visits (patient_id, branch_id, braces_case_id, status, treatment_label)
select patient_id, (select id from public.branches where code = 'NN'), id, 'waiting', 'Monthly'
  from public.braces_cases;
select pg_temp.check((select braces_month from public.visits where status = 'waiting' and braces_case_id is not null) = 4,
  'new braces visit auto-filled as Month 4');
select pg_temp.check((select photo_required and checker_required from public.visits where status = 'waiting' and braces_month = 4),
  'Month 4 visit needs photo and checker');

select pg_temp.expect_error($$insert into public.visit_staff (visit_id, clinician_id, role)
  select v.id, c.id, 'doctor' from public.visits v, public.clinicians c
   where v.braces_month = 4 and v.status = 'waiting' and c.display_name = 'Dr. Haniya Siddiqui'$$,
  'GROUP_NOT_ALLOWED', 'Group 3 doctor cannot treat a Month 4 patient');
insert into public.visit_staff (visit_id, clinician_id, role)
select v.id, c.id, 'doctor' from public.visits v, public.clinicians c
 where v.braces_month = 4 and v.status = 'waiting' and c.display_name = 'Dr. Urooj Jawed';
select pg_temp.check(true, 'Group 2 doctor can treat Month 4');
insert into public.visit_staff (visit_id, clinician_id, role)
select v.id, c.id, 'assistant' from public.visits v, public.clinicians c
 where v.braces_month = 4 and v.status = 'waiting' and c.display_name = 'Hira Anis';
select pg_temp.check(true, 'assistants are not limited by group');

update public.visits set status = 'in_treatment' where braces_month = 4 and status = 'waiting';
select pg_temp.expect_error($$update public.visits set status = 'completed' where braces_month = 4 and status = 'in_treatment'$$,
  'PHOTO_REQUIRED', 'cannot complete a photo month without photos');
reset role;
insert into storage.objects (bucket_id, name) values ('clinic-photos', 'inbox/NN/test/front.jpg');
select set_config('request.jwt.claim.sub', :assistant, false);
set role authenticated;
insert into public.photos (patient_id, visit_id, storage_path, view_label)
select patient_id, id, 'inbox/NN/test/missing.jpg', 'front' from public.visits where braces_month = 4 and status = 'in_treatment';
select pg_temp.check((select not photos_uploaded from public.visits where braces_month = 4 and status = 'in_treatment'),
  'a photo row without a real file does not tick the photo box');
insert into public.photos (patient_id, visit_id, storage_path, view_label)
select patient_id, id, 'inbox/NN/test/front.jpg', 'front' from public.visits where braces_month = 4 and status = 'in_treatment';
select pg_temp.expect_error($$update public.visits set status = 'completed' where braces_month = 4 and status = 'in_treatment'$$,
  'CHECK_REQUIRED', 'cannot complete without checker sign-off');
select pg_temp.expect_error($$insert into public.visit_staff (visit_id, clinician_id, role)
  select v.id, c.id, 'checker' from public.visits v, public.clinicians c
   where v.braces_month = 4 and v.status = 'in_treatment' and c.display_name = 'Dr. Urooj Jawed'$$,
  'CHECKER_NOT_ALLOWED', 'Month 4 must be checked by Group 1, not Group 2');
insert into public.visit_staff (visit_id, clinician_id, role)
select v.id, c.id, 'checker' from public.visits v, public.clinicians c
 where v.braces_month = 4 and v.status = 'in_treatment' and c.display_name = 'Dr. Samrah Khan';
update public.visits set status = 'completed' where braces_month = 4 and status = 'in_treatment';
select pg_temp.check((select status = 'completed' and checked_by is not null and photos_uploaded
  from public.visits where braces_month = 4), 'Month 4 completes after photos + Group 1 check');
select pg_temp.expect_error($$update public.visits set protocol_override_by = auth.uid() where braces_month = 3$$,
  'not allowed to override', 'assistant cannot override the braces protocol');
reset role; select set_config('request.jwt.claim.sub', '', false);

-- =====================================================================
-- 4. Billing, dues hold, discounts, refunds
-- =====================================================================
select set_config('request.jwt.claim.sub', :accountant, false);
set role authenticated;
insert into public.invoices (patient_id, branch_id)
select id, (select id from public.branches where code = 'NN') from public.patients where full_name = 'Maham Habib';
insert into public.invoice_items (invoice_id, description, unit_price)
select id, 'Bonding 70k kit', 70000 from public.invoices;
select pg_temp.check((select subtotal from public.invoices) = 70000, 'invoice subtotal follows its items');
select pg_temp.check((select invoice_no like 'INV-____-000001' from public.invoices), 'invoice number generated');
insert into public.payments (patient_id, branch_id, amount, method)
select id, (select id from public.branches where code = 'NN'), 35000, 'cash' from public.patients where full_name = 'Maham Habib';
select pg_temp.check(public.patient_dues((select id from public.patients where full_name = 'Maham Habib')) = 35000,
  'dues = 70,000 billed - 35,000 paid');
select pg_temp.check((select dues from public.patient_balances b join public.patients p on p.id = b.patient_id
  where p.full_name = 'Maham Habib') = 35000, 'patient_balances view agrees');
reset role; select set_config('request.jwt.claim.sub', '', false);

select set_config('request.jwt.claim.sub', :assistant, false);
set role authenticated;
update public.visits set status = 'in_treatment'
 where patient_id = (select id from public.patients where full_name = 'Maham Habib');
select pg_temp.check((select dues_at_checkin from public.visits
  where patient_id = (select id from public.patients where full_name = 'Maham Habib')) = 35000,
  'warn mode: treatment can start, dues recorded on the visit');
update public.visits set status = 'waiting'
 where patient_id = (select id from public.patients where full_name = 'Maham Habib');
reset role; select set_config('request.jwt.claim.sub', '', false);

update public.app_settings set value = '"block"' where key = 'dues_hold_mode';
select set_config('request.jwt.claim.sub', :assistant, false);
set role authenticated;
select pg_temp.expect_error($$update public.visits set status = 'in_treatment'
  where patient_id = (select id from public.patients where full_name = 'Maham Habib')$$,
  'DUES_HOLD', 'block mode: treatment cannot start with pending dues');
select pg_temp.expect_error($$update public.visits set dues_override_by = auth.uid(), status = 'in_treatment'
  where patient_id = (select id from public.patients where full_name = 'Maham Habib')$$,
  'not allowed to override', 'assistant cannot override the dues hold');
reset role; select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.sub', :accountant, false);
set role authenticated;
update public.visits set status = 'completed'
 where patient_id = (select id from public.patients where full_name = 'Maham Habib');
select pg_temp.check(not exists (select 1 from public.visits where status = 'completed'
  and patient_id = (select id from public.patients where full_name = 'Maham Habib')),
  'accountant cannot edit the daily list (update silently changes nothing)');
reset role; select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
update public.visits set dues_override_by = auth.uid(), dues_override_reason = 'Dr. Ali allowed', status = 'in_treatment'
 where patient_id = (select id from public.patients where full_name = 'Maham Habib');
select pg_temp.check((select status = 'in_treatment' from public.visits
  where patient_id = (select id from public.patients where full_name = 'Maham Habib')), 'admin override lets treatment start');
reset role; select set_config('request.jwt.claim.sub', '', false);
update public.app_settings set value = '"warn"' where key = 'dues_hold_mode';

-- Discount above front desk cap (10% / Rs 5,000) needs approval.
select set_config('request.jwt.claim.sub', :fd_nn, false);
set role authenticated;
insert into public.invoices (patient_id, branch_id, subtotal, discount_amount, discount_reason, status)
select id, (select id from public.branches where code = 'NN'), 20000, 1000, 'small discount', 'issued'
  from public.patients where full_name = 'Aiza Azeem';
select pg_temp.check((select status from public.invoices where discount_amount = 1000) = 'issued',
  'discount within cap (5%) is issued directly');
insert into public.invoices (patient_id, branch_id, subtotal, discount_amount, discount_reason, status)
select id, (select id from public.branches where code = 'NN'), 20000, 4000, 'family discount', 'issued'
  from public.patients where full_name = 'Aiza Azeem';
select pg_temp.check((select status from public.invoices where discount_amount = 4000) = 'pending_approval',
  '20% discount goes to approval');
select pg_temp.check((select count(*) from public.discount_requests where status = 'pending') = 1,
  'discount request raised automatically');
select pg_temp.expect_error($$select public.decide_discount((select id from public.discount_requests limit 1), true)$$,
  'not allowed', 'front desk cannot approve its own discount');
select pg_temp.expect_error($$insert into public.payments (patient_id, branch_id, amount)
  select id, (select id from public.branches where code = 'NN'), -500 from public.patients where full_name = 'Aiza Azeem'$$,
  'row-level security', 'front desk cannot give refunds');
reset role; select set_config('request.jwt.claim.sub', '', false);

select set_config('request.jwt.claim.sub', :accountant, false);
set role authenticated;
select public.decide_discount((select id from public.discount_requests limit 1), true);
select pg_temp.check((select status from public.invoices where discount_amount = 4000) = 'issued',
  'accountant approval issues the invoice');
insert into public.payments (patient_id, branch_id, amount, notes)
select id, (select id from public.branches where code = 'NN'), -500, 'refund test' from public.patients where full_name = 'Aiza Azeem';
select pg_temp.check((select count(*) from public.payments where is_refund) = 1, 'accountant can refund');
select pg_temp.expect_error($$update public.invoices set status = 'void' where discount_amount = 1000$$,
  'reason is required', 'voiding needs a reason');
reset role; select set_config('request.jwt.claim.sub', '', false);

-- =====================================================================
-- 5. Cash closing and expenses
-- =====================================================================
select set_config('request.jwt.claim.sub', :fd_nn, false);
set role authenticated;
select public.close_cash((select id from public.branches where code = 'NN'), (now() at time zone 'Asia/Karachi')::date, 34000, 'short by 500');
select pg_temp.check((select expected_cash = 34500 and difference = -500 from public.cash_closings),
  'cash closing compares counted cash with cash payments minus refunds (shows Rs -500)');
select pg_temp.expect_error($$select public.close_cash((select id from public.branches where code = 'DHA'), current_date, 0)$$,
  'not allowed', 'NN front desk cannot close DHA cash');
select pg_temp.check((select count(*) from public.expenses) = 0, 'front desk sees no expenses');
reset role; select set_config('request.jwt.claim.sub', '', false);

select set_config('request.jwt.claim.sub', :accountant, false);
set role authenticated;
insert into public.expenses (branch_id, city_id, category_id, amount, paid_to)
values ((select id from public.branches where code = 'NN'), (select id from public.cities where name = 'Karachi'),
        (select id from public.expense_categories where name = 'Rent'), 150000, 'Landlord');
update public.cash_closings set verified_by = auth.uid(), verified_at = now();
select pg_temp.check((select expenses from public.branch_monthly_pnl p join public.branches b on b.id = p.branch_id
   where b.code = 'NN') = 150000, 'branch P&L shows NN rent');
reset role; select set_config('request.jwt.claim.sub', '', false);

-- =====================================================================
-- 6. Patient portal, complaints, flags, ratings
-- =====================================================================
update public.patients set portal_user_id = :pat_user where full_name = 'Aiza Azeem';
update public.patients set portal_user_id = :pat_user2 where full_name = 'Maham Habib';

select set_config('request.jwt.claim.sub', :pat_user, false);
set role authenticated;
select pg_temp.check((select count(*) from public.patients) = 1, 'patient sees only own profile');
select pg_temp.check((select count(*) from public.invoices) = 2 and
  (select bool_and(patient_id = public.current_patient_id()) from public.invoices), 'patient sees only own issued invoices');
select pg_temp.check((select count(*) from public.photos) = 0, 'patient cannot see raw photos');
select pg_temp.expect_error($$select public.patient_dues((select id from public.patients p where p.mr_number = '50001'))$$,
  'not allowed', 'patient cannot look up someone else''s dues (even by id)');
insert into public.complaints (patient_id, subject, body)
values (public.current_patient_id(), 'Waiting time', 'Waited 2 hours on Saturday');
select pg_temp.expect_error($$insert into public.complaints (patient_id, subject, body)
  values ((select id from public.patients where mr_number = '9840'), 'fake', 'fake')$$,
  'row-level security', 'patient cannot file a complaint as someone else');
insert into public.visit_ratings (visit_id, patient_id, stars)
select id, patient_id, 2 from public.visits where braces_month = 4;
select pg_temp.check(true, 'patient can rate own completed visit');
reset role; select set_config('request.jwt.claim.sub', '', false);

select set_config('request.jwt.claim.sub', :pat_user2, false);
set role authenticated;
select pg_temp.check((select count(*) from public.complaints) = 0, 'other patient cannot see the complaint');
reset role; select set_config('request.jwt.claim.sub', '', false);

select set_config('request.jwt.claim.sub', :coord, false);
set role authenticated;
select pg_temp.check((select count(*) from public.complaints) = 1, 'coordinator sees the complaint');
reset role; select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
select pg_temp.check((select count(*) from public.complaints) = 1, 'Dr. Ali sees the complaint');
reset role; select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.sub', :assistant, false);
set role authenticated;
select pg_temp.check((select count(*) from public.complaints) = 0, 'assistant does not see complaints');
insert into public.patient_flags (patient_id, reason, raised_by)
select id, 'Bracket keeps breaking, needs Dr. Ali', auth.uid() from public.patients where full_name = 'Aiza Azeem';
update public.patient_flags set cleared_at = now();
select pg_temp.check((select count(*) from public.patient_flags where cleared_at is null) = 1,
  'assistant cannot clear the Dr. Ali flag (update changes nothing)');
reset role; select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
select pg_temp.check((select count(*) from public.dr_ali_review_list where source = 'flag') = 1,
  'flagged patient on Dr. Ali review list');
reset role; select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.sub', :pat_user, false);
set role authenticated;
select pg_temp.check((select count(*) from public.patient_flags where cleared_at is null) = 1,
  'patient sees "see Dr. Ali" message');
reset role; select set_config('request.jwt.claim.sub', '', false);

-- =====================================================================
-- 7. Permissions grid overrides, deactivation, audit, public access
-- =====================================================================
insert into public.staff_permission_overrides (staff_id, permission_key, allowed)
values (:assistant, 'patients.create', true);
select set_config('request.jwt.claim.sub', :assistant, false);
set role authenticated;
insert into public.patients (full_name, phone) values ('Override Test', '03005556666');
select pg_temp.check(true, 'personal override lets this assistant register patients');
reset role; select set_config('request.jwt.claim.sub', '', false);

select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
select public.deactivate_staff(:assistant);
reset role; select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.sub', :assistant, false);
set role authenticated;
select pg_temp.check((select count(*) from public.patients) = 0 and (select count(*) from public.visits) = 0,
  'deactivated staff instantly sees nothing');
reset role; select set_config('request.jwt.claim.sub', '', false);

select set_config('request.jwt.claim.sub', :fd_nn, false);
set role authenticated;
select pg_temp.check((select count(*) from public.audit_log) = 0, 'front desk cannot read the audit log');
reset role; select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
select pg_temp.check((select count(*) from public.audit_log where table_name = 'payments' and action = 'INSERT') = 2,
  'audit log records payments');
select pg_temp.check((select count(*) from public.audit_log where table_name = 'staff' and action = 'UPDATE'
  and actor = :admin) = 1, 'audit log records who deactivated staff');
reset role; select set_config('request.jwt.claim.sub', '', false);

select set_config('request.jwt.claim.sub', '', false);
set role anon;
select pg_temp.check((select count(*) from public.branches) = 5, 'website visitors can see the 5 branches');
select pg_temp.check((select count(*) from public.patients) = 0, 'website visitors see no patients');
select pg_temp.check((select count(*) from public.invoices) = 0, 'website visitors see no invoices');
select pg_temp.expect_error($$select public.braces_guidance(gen_random_uuid())$$, 'permission denied',
  'website visitors cannot call internal functions');
select pg_temp.expect_error($$select public.expected_cash(1::smallint, current_date)$$, 'permission denied',
  'website visitors cannot read branch cash totals');
reset role; select set_config('request.jwt.claim.sub', '', false);

-- =====================================================================
-- 8. Overrun detection
-- =====================================================================
insert into public.patients (full_name, phone) values ('Long Case', '03007778888');
insert into public.braces_cases (patient_id, start_date, extraction_plan)
select id, current_date - 450, 'non_extraction' from public.patients where full_name = 'Long Case';
insert into public.visits (patient_id, branch_id, visit_date, status, braces_case_id, braces_month, protocol_override_by)
select bc.patient_id, (select id from public.branches where code = 'GUL'), current_date - (450 - m * 30),
       'completed', bc.id, m, :admin
  from public.braces_cases bc join public.patients p on p.id = bc.patient_id
  cross join generate_series(1, 14) m where p.full_name = 'Long Case';
select pg_temp.check((select count(*) from public.dr_ali_review_list where source = 'overrun') = 1,
  'non-extraction case at month 14 appears as overrun');

\echo 'clinic rules: all checks passed'
