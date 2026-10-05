-- =====================================================================
-- Security regression tests: each confirmed issue from the review stays fixed.
-- Runs after 10_clinic_rules_test.sql (same database and users).
-- =====================================================================
\set ON_ERROR_STOP 1
\set admin       '''00000000-0000-0000-0000-0000000000a1'''
\set fd_nn       '''00000000-0000-0000-0000-0000000000f1'''
\set accountant  '''00000000-0000-0000-0000-0000000000c1'''
\set coord       '''00000000-0000-0000-0000-0000000000d1'''
\set pat_user    '''00000000-0000-0000-0000-0000000000e1'''
\set outsider    '''00000000-0000-0000-0000-0000000000ff'''

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'TEST FAILED: %', msg; end if;
  raise notice 'ok - %', msg;
end $$;
create or replace function pg_temp.expect_error(sql text, needle text, msg text) returns void language plpgsql as $$
begin
  execute sql;
  raise exception 'TEST FAILED (no error): %', msg;
exception when others then
  if sqlerrm like 'TEST FAILED%' then raise; end if;
  if position(needle in sqlerrm) = 0 then raise exception 'TEST FAILED: % (unexpected error: %)', msg, sqlerrm; end if;
  raise notice 'ok - % (blocked: %)', msg, left(sqlerrm, 70);
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

insert into auth.users (id, email) values (:outsider, 'stranger@example.com');

-- 1. Linking a portal login to a patient
select set_config('request.jwt.claim.sub', :fd_nn, false); set role authenticated;
select pg_temp.expect_error($$update public.patients set portal_user_id = '00000000-0000-0000-0000-0000000000ff' where mr_number = '9840'$$,
  'invite function only', 'front desk cannot link a login to a patient record');
select pg_temp.expect_error($$update public.patients set email = 'attacker@example.com' where full_name = 'Aiza Azeem'$$,
  'Only Dr. Ali can change their email', 'front desk cannot change the email of a patient who has a portal login');
reset role; select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.sub', :outsider, false); set role authenticated;
select pg_temp.check((select count(*) from public.patients) = 0, 'an unlinked login sees no patients');
reset role; select set_config('request.jwt.claim.sub', '', false);

-- 2. Escalating to admin
insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (:coord, 'users.manage', true);
select set_config('request.jwt.claim.sub', :coord, false); set role authenticated;
select pg_temp.expect_error($$update public.staff set role = 'admin' where id = auth.uid()$$, 'Only admin', 'user manager cannot promote themselves to admin');
select pg_temp.expect_error($$update public.staff set active = false where role = 'admin'$$, 'Only admin', 'user manager cannot switch off the admin');
select pg_temp.expect_error($$delete from public.staff where role = 'admin'$$, 'Only admin', 'user manager cannot delete the admin');
select pg_temp.expect_error($$insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (auth.uid(), 'finance.view', true)$$,
  'own', 'user manager cannot give themselves extra permissions');
update public.role_permissions set allowed = true where role = 'front_desk' and permission_key = 'finance.view';
select pg_temp.check(not (select allowed from public.role_permissions where role = 'front_desk' and permission_key = 'finance.view'),
  'only admin edits the role grid');
reset role; select set_config('request.jwt.claim.sub', '', false);
delete from public.staff_permission_overrides where staff_id = :coord and permission_key = 'users.manage';

-- 3. Skipping discount approval
select set_config('request.jwt.claim.sub', :fd_nn, false); set role authenticated;
select pg_temp.expect_error($$insert into public.invoices (patient_id, branch_id, subtotal, discount_amount, status, discount_approved_by)
  select id, (select id from public.branches where code = 'NN'), 50000, 50000, 'issued', '00000000-0000-0000-0000-0000000000a1'
    from public.patients where full_name = 'Aiza Azeem'$$, 'approver', 'front desk cannot mark their own discount as approved');
insert into public.invoices (patient_id, branch_id, subtotal, discount_amount, discount_reason, status)
select id, (select id from public.branches where code = 'NN'), 10000, 5000, 'test', 'issued' from public.patients where full_name = 'Aiza Azeem';
select pg_temp.expect_error($$update public.invoices set status = 'issued' where status = 'pending_approval' and subtotal = 10000$$,
  'waiting for discount approval', 'front desk cannot push a pending discount to issued');
reset role; select set_config('request.jwt.claim.sub', '', false);

-- 4. Raw photos in storage
insert into storage.objects (bucket_id, name) values
  ('clinic-photos', '11111111-1111-1111-1111-111111111111/raw/2026-10-05_front.jpg'),
  ('clinic-photos', '11111111-1111-1111-1111-111111111111/edited/2026-10-05_front.jpg');
select set_config('request.jwt.claim.sub', :accountant, false); set role authenticated;
select pg_temp.check((select count(*) from storage.objects where name like '%/raw/%') = 0, 'staff without raw-photo access cannot read raw photo files');
select pg_temp.check((select count(*) from storage.objects where name like '%/edited/%') = 1, 'staff can read edited photo files');
reset role; select set_config('request.jwt.claim.sub', '', false);

-- 6. Branch restriction on visit staff
select set_config('request.jwt.claim.sub', :fd_nn, false); set role authenticated;
reset role; select set_config('request.jwt.claim.sub', '', false);
select id as dha_visit from public.visits where branch_id = (select id from public.branches where code = 'DHA') limit 1 \gset
select set_config('request.jwt.claim.sub', :fd_nn, false); set role authenticated;
select pg_temp.expect_error(format($$insert into public.visit_staff (visit_id, clinician_id, role)
  values (%L, (select id from public.clinicians where display_name = 'Dr. Haniya Siddiqui'), 'doctor')$$, :'dha_visit'),
  'row-level security', 'NN front desk cannot change who treated a DHA patient');
reset role; select set_config('request.jwt.claim.sub', '', false);

-- 7. Cash closing amounts
select set_config('request.jwt.claim.sub', :accountant, false); set role authenticated;
select pg_temp.expect_error($$update public.cash_closings set counted_cash = expected_cash$$, 'Only verification fields',
  'verifying a cash closing cannot change the counted cash');
reset role; select set_config('request.jwt.claim.sub', '', false);

-- 9. Faked who/when fields
select set_config('request.jwt.claim.sub', :fd_nn, false); set role authenticated;
insert into public.payments (patient_id, branch_id, amount, received_by, received_at, notes)
select id, (select id from public.branches where code = 'NN'), 100, '00000000-0000-0000-0000-0000000000c1', '2020-01-01', 'stamp test'
  from public.patients where full_name = 'Aiza Azeem';
select pg_temp.check((select received_by = auth.uid() and received_at > now() - interval '1 minute' from public.payments where notes = 'stamp test'),
  'payment receiver and time are stamped by the database');
reset role; select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.sub', :pat_user, false); set role authenticated;
insert into public.complaints (patient_id, subject, body, status, resolved_by)
values (public.current_patient_id(), 'Stamp test', 'x', 'resolved', '00000000-0000-0000-0000-0000000000d1');
select pg_temp.check((select status = 'new' and resolved_by is null from public.complaints where subject = 'Stamp test'),
  'a patient cannot file a complaint that is already "resolved"');
select pg_temp.expect_error($$select public.next_braces_month((select id from public.braces_cases limit 1 offset 1))$$, 'not allowed',
  'a patient cannot read another patient''s braces progress');
reset role; select set_config('request.jwt.claim.sub', '', false);

-- 10. Dues on screen and anonymous access
select set_config('request.jwt.claim.sub', :coord, false); set role authenticated;
select pg_temp.check((select dues from public.dues_for(array(select id from public.patients where full_name = 'Maham Habib'))) > 0,
  'staff with the $$ permission see real dues');
reset role; select set_config('request.jwt.claim.sub', '', false);
set role anon;
select pg_temp.expect_error($$select public.setting('dues_hold_mode')$$, 'permission denied', 'website visitors cannot read internal settings');
select pg_temp.expect_error($$truncate public.audit_log$$, 'permission denied', 'website visitors cannot wipe tables');
reset role;

\echo 'security: all checks passed'
