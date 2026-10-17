-- Patient logins made simple, self-registration and "Please upload my photos" (20261017000300_patient_login_simple.sql). Made-up people only.
--   0. the file runs twice: the second run changes no grid cell and writes no audit row; policies, triggers and functions are there once;
--   1. the grid: "Create patient logins" (portal.invite, relabelled) for the front desk, the assistant, the coordinator and Dr. Ali;
--      not the doctor or the accountant; has_perm agrees;
--   2. a patient with an approved login reads their own record and documents and nobody else's (as before); a patient whose registration
--      is pending is nobody: current_patient_id() answers nothing, no record, no documents, no photo request; my_portal_status() says
--      'approved' / 'pending' / nothing, and anonymous visitors cannot call it;
--   3. the "New registrations" list and its decisions: login makers see the pending rows (with what was typed beside the patient), a doctor
--      sees none; approving needs portal.invite, opens the record to the patient, is audited and cannot be done twice; rejecting unlinks
--      the login (nobody from then on), answers the login id for the function to unlink and remove, and is audited with the reason;
--   4. photo requests: a patient opens one for themselves only, one at a time, cancels it; staff who use the Photo inbox or upload photos
--      list the open ones (with Mr#, branch and last visit) and mark them done, the accountant does neither; a photo saved for the patient
--      closes the request by itself; every change is in the audit log.
\set ON_ERROR_STOP 1
\set admin '''00000000-0000-0000-0000-000000004200'''
\set fd    '''00000000-0000-0000-0000-000000004201'''
\set asst  '''00000000-0000-0000-0000-000000004202'''
\set doc   '''00000000-0000-0000-0000-000000004203'''
\set acct  '''00000000-0000-0000-0000-000000004205'''
\set pat   '''00000000-0000-0000-0000-000000004206'''
\set pat2  '''00000000-0000-0000-0000-000000004207'''
\set pat3  '''00000000-0000-0000-0000-000000004208'''

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
create or replace function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, false) $$;
create or replace function pg_temp.perm_as(p_staff uuid, p_key text) returns boolean language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_staff::text, false);
  return public.has_perm(p_key);
end $$;
create or replace function pg_temp.grid42() returns text language sql as $$
  select md5(string_agg(role::text || ':' || permission_key || ':' || allowed::text, ',' order by role, permission_key)) from public.role_permissions $$;
-- A row inserted as the signed-in person (row-level security decides): true when it went in.
create or replace function pg_temp.try(sql text) returns boolean language plpgsql as $$
begin
  execute sql;
  return true;
exception when others then
  return false;
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon;
reset role;
select pg_temp.act_as('');

-- 0. The file again (it commits, so it runs before the transaction below): nothing changes the second time.
create temp table t42_before as
  select pg_temp.grid42() as grid, coalesce((select max(id) from public.audit_log), 0) as audit_id;
\ir ../migrations/20261017000300_patient_login_simple.sql
select pg_temp.check((select grid from t42_before) = pg_temp.grid42()
                     and not exists (select 1 from public.audit_log where id > (select audit_id from t42_before) and table_name = 'role_permissions'),
  'the file run a second time changes no grid cell and writes no audit row');
select pg_temp.check((select count(*) from pg_policies where schemaname = 'public' and tablename = 'patient_registrations') = 1
                     and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'photo_requests') = 4
                     and (select count(*) from pg_trigger where not tgisinternal and tgname in ('patient_registrations_audit', 'photo_requests_audit', 'photos_close_request')) = 3,
  'the policies and triggers are there once each');
select pg_temp.check(not has_function_privilege('anon', 'public.my_portal_status()', 'execute')
                     and has_function_privilege('authenticated', 'public.my_portal_status()', 'execute')
                     and not has_function_privilege('anon', 'public.pending_registrations()', 'execute')
                     and not has_function_privilege('anon', 'public.approve_registration(uuid)', 'execute')
                     and not has_function_privilege('anon', 'public.reject_registration(uuid, text)', 'execute')
                     and not has_function_privilege('anon', 'public.photo_requests_open()', 'execute')
                     and not has_function_privilege('anon', 'public.photo_request_done(uuid)', 'execute'),
  'the new functions are for signed-in users only');

begin;
-- 1. The grid.
select pg_temp.check((select label = 'Create patient logins' and category = 'Patients' from public.permissions where key = 'portal.invite'),
  'the access list row is now "Create patient logins" under Patients');
select pg_temp.check((select string_agg(role::text || '=' || allowed::text, ',' order by role::text) from public.role_permissions where permission_key = 'portal.invite')
                      = 'accountant=false,admin=true,assistant=true,coordinator=true,doctor=false,front_desk=true',
  'portal.invite: the front desk, the assistant, the coordinator and Dr. Ali; not the doctor or the accountant');

insert into auth.users (id, email) values
  (:admin, 'admin42@dralirashid.com'), (:fd, 'fd42@dralirashid.com'), (:asst, 'asst42@dralirashid.com'), (:doc, 'doc42@dralirashid.com'),
  (:acct, 'acct42@dralirashid.com'), (:pat, 'mr-42001@dralirashid.com'), (:pat2, 'mr-42002@dralirashid.com'), (:pat3, 'mr-42003@dralirashid.com');
insert into public.staff (id, full_name, email, role, restrict_to_branches, branch_ids) values
  (:admin, 'Admin Fortytwo', 'admin42@dralirashid.com', 'admin', false, '{}'),
  (:fd, 'Front Desk Fortytwo', 'fd42@dralirashid.com', 'front_desk', true, '{1}'),
  (:asst, 'Assistant Fortytwo', 'asst42@dralirashid.com', 'assistant', true, '{1}'),
  (:doc, 'Doctor Fortytwo', 'doc42@dralirashid.com', 'doctor', false, '{}'),
  (:acct, 'Accountant Fortytwo', 'acct42@dralirashid.com', 'accountant', false, '{}');
select pg_temp.check((select string_agg(s.role::text || '=' || pg_temp.perm_as(s.id, 'portal.invite')::text, ',' order by s.role::text)
                        from public.staff s where s.id in (:admin, :fd, :asst, :doc, :acct))
                      = 'accountant=false,admin=true,assistant=true,doctor=false,front_desk=true',
  'has_perm(portal.invite) for each role, as the website asks it');
select pg_temp.act_as('');

-- p1: a login the clinic made (approved by nature). p2: registered themselves, pending. p3: registered themselves, pending (to be rejected).
insert into public.patients (mr_number, full_name, phone, first_branch_id, portal_user_id) values
  ('42001', 'Sample Fortytwo One', '03005554201', 1, :pat),
  ('42002', 'Sample Fortytwo Two', '03005554202', 2, :pat2),
  ('42003', 'Sample Fortytwo Three', '03005554203', 1, :pat3);
select id as p1 from public.patients where mr_number = '42001' \gset
select id as p2 from public.patients where mr_number = '42002' \gset
select id as p3 from public.patients where mr_number = '42003' \gset
insert into public.patient_registrations (patient_id, user_id, typed_name, typed_phone) values
  (:'p2', :pat2, 'Sample Two', '03005554202'),
  (:'p3', :pat3, 'Sample Three', '03005554203');
insert into public.patient_documents (patient_id, kind, title, storage_path) values
  (:'p1', 'consent', 'Treatment consent', :'p1' || '/consent-42.pdf'),
  (:'p2', 'consent', 'Treatment consent', :'p2' || '/consent-42.pdf');
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label) values (:'p1', 1, '2026-10-10', 'completed', 'Checkup');

-- 2. Who the login is.
select pg_temp.act_as(:pat);
select pg_temp.check(public.current_patient_id() = :'p1' and public.my_portal_status() = 'approved', 'a login the clinic made: the patient, approved');
select pg_temp.act_as(:pat2);
select pg_temp.check(public.current_patient_id() is null and public.my_portal_status() = 'pending', 'a pending registration: nobody yet, status pending');
select pg_temp.act_as(:doc);
select pg_temp.check(public.current_patient_id() is null and public.my_portal_status() is null, 'a staff login: no patient, no status');
select pg_temp.act_as('');

set role authenticated;
select pg_temp.act_as(:pat);
select pg_temp.check((select string_agg(mr_number, ',') from public.patients) = '42001'
                     and (select count(*) from public.patient_documents) = 1
                     and (select count(*) from public.patient_documents where patient_id = :'p1') = 1,
  'the approved patient reads their own record and their own consent form, nobody else''s');
select pg_temp.act_as(:pat2);
select pg_temp.check(not exists (select 1 from public.patients) and not exists (select 1 from public.patient_documents)
                     and not exists (select 1 from public.visits) and not exists (select 1 from public.patient_registrations),
  'the pending patient reads nothing: no record, no documents, no visits, not even their own registration');
select pg_temp.check(not pg_temp.try(format('insert into public.photo_requests (patient_id) values (%L)', :'p2')), 'and cannot ask for photos yet');
reset role;
select pg_temp.act_as('');

-- 3. New registrations.
set role authenticated;
select pg_temp.act_as(:asst);
select pg_temp.check((select string_agg(typed_name || '/' || mr_number || '/' || first_branch_id::text, ',' order by typed_name) from public.pending_registrations()) = 'Sample Three/42003/1,Sample Two/42002/2'
                     and (select count(*) from public.patient_registrations) = 2,
  'an assistant sees the two pending registrations, what was typed beside the patient file (name, Mr#, branch)');
select pg_temp.act_as(:doc);
select pg_temp.check(not exists (select 1 from public.pending_registrations()) and not exists (select 1 from public.patient_registrations),
  'a doctor sees none (no "Create patient logins")');
select pg_temp.expect_error(format('select public.approve_registration(%L)', :'p2'), 'not allowed', 'a doctor cannot approve');
select pg_temp.expect_error(format('select public.reject_registration(%L, %L)', :'p2', 'no'), 'not allowed', 'nor reject');
select pg_temp.act_as(:asst);
select public.approve_registration(:'p2');
select pg_temp.check((select status = 'approved' and decided_by = :asst and decided_at is not null from public.patient_registrations where patient_id = :'p2')
                     and (select count(*) from public.pending_registrations()) = 1,
  'the assistant approves: the row says approved, by whom and when; one is left on the list');
select pg_temp.expect_error(format('select public.approve_registration(%L)', :'p2'), 'already decided', 'approving again is refused');
select pg_temp.act_as(:pat2);
select pg_temp.check(public.current_patient_id() = :'p2' and public.my_portal_status() = 'approved'
                     and (select string_agg(mr_number, ',') from public.patients) = '42002'
                     and (select count(*) from public.patient_documents where patient_id = :'p2') = 1,
  'now the patient is approved: their record and their consent form open to them');
select pg_temp.act_as(:fd);
select public.reject_registration(:'p3', 'Not this family''s number') as rejected_user \gset
select pg_temp.check(:'rejected_user'::uuid = :pat3::uuid, 'rejecting answers the login id (the function then removes the login)');
reset role;
select pg_temp.check((select status = 'rejected' and decided_by = :fd and reason = 'Not this family''s number' from public.patient_registrations where patient_id = :'p3'),
  'the row says rejected with the reason (the function unlinks the patient and removes the login next)');
select pg_temp.check((select count(*) from public.audit_log where action = 'REGISTRATION_APPROVED' and row_id = :'p2'::text and actor = :asst) = 1
                     and (select count(*) from public.audit_log where action = 'REGISTRATION_REJECTED' and row_id = :'p3'::text and actor = :fd and new_data ->> 'reason' = 'Not this family''s number') = 1
                     and (select count(*) from public.audit_log where table_name = 'patient_registrations' and action = 'UPDATE') = 2,
  'both decisions are in the audit log (the decision rows and the registration rows themselves)');
set role authenticated;
select pg_temp.act_as(:pat3);
select pg_temp.check(public.current_patient_id() is null and public.my_portal_status() is null and not exists (select 1 from public.patients)
                     and not exists (select 1 from public.patient_documents),
  'the rejected login is nobody, even before the function has unlinked it');
reset role;
select pg_temp.act_as('');

-- 4. Photo requests.
set role authenticated;
select pg_temp.act_as(:pat);
select pg_temp.check(not pg_temp.try(format('insert into public.photo_requests (patient_id) values (%L)', :'p2')), 'a patient cannot ask on behalf of another patient');
select pg_temp.check(not pg_temp.try(format('insert into public.photo_requests (patient_id, status) values (%L, %L)', :'p1', 'done')), 'nor open a request that is already done');
insert into public.photo_requests (patient_id) values (:'p1');
select pg_temp.check(not pg_temp.try(format('insert into public.photo_requests (patient_id) values (%L)', :'p1')), 'one open request at a time');
select pg_temp.check((select count(*) from public.photo_requests where patient_id = :'p1' and status = 'open') = 1, 'the patient sees their open request');
select pg_temp.act_as(:acct);
select pg_temp.check(not exists (select 1 from public.photo_requests) and not exists (select 1 from public.photo_requests_open()),
  'the accountant sees no requests (no Photo inbox, no uploads)');
select pg_temp.act_as(:asst);
select pg_temp.check((select string_agg(full_name || '/' || mr_number || '/' || first_branch_id::text || '/' || last_visit::text, ',') from public.photo_requests_open()) = 'Sample Fortytwo One/42001/1/2026-10-10',
  'the assistant lists it: the patient, Mr#, branch and last visit');
select id as q1 from public.photo_requests where patient_id = :'p1' and status = 'open' \gset
select pg_temp.check(not pg_temp.try(format('update public.photo_requests set status = %L where id = %L', 'done', :'q1'))
                     or (select status from public.photo_requests where id = :'q1') = 'open',
  'staff do not change a request through the table (only photo_request_done)');
select pg_temp.act_as(:pat);
update public.photo_requests set status = 'cancelled' where id = :'q1';
select pg_temp.check((select status from public.photo_requests where id = :'q1') = 'cancelled', 'the patient cancels their own request');
select pg_temp.try(format('update public.photo_requests set status = %L where id = %L', 'open', :'q1'));
select pg_temp.check((select status from public.photo_requests where id = :'q1') = 'cancelled', 'and cannot reopen it (a new one is made instead)');
insert into public.photo_requests (patient_id) values (:'p1');
select id as q2 from public.photo_requests where patient_id = :'p1' and status = 'open' \gset
select pg_temp.act_as(:acct);
select pg_temp.expect_error(format('select public.photo_request_done(%L)', :'q2'), 'not allowed', 'the accountant cannot mark a request done');
-- A picture the assistant saves for the patient closes the request by itself.
select pg_temp.act_as(:asst);
insert into public.photos (patient_id, kind, view_label, storage_path, uploaded_by) values (:'p1', 'raw', 'Front', :'p1' || '/raw/2026-10-17_Front_a4200001.jpg', auth.uid());
select pg_temp.check((select status = 'done' and done_by = :asst and done_at is not null from public.photo_requests where id = :'q2'),
  'a photo saved for the patient marks the request done, by the uploader');
select pg_temp.act_as(:pat);
insert into public.photo_requests (patient_id) values (:'p1');
select id as q3 from public.photo_requests where patient_id = :'p1' and status = 'open' \gset
select pg_temp.act_as(:fd);
select public.photo_request_done(:'q3');
select pg_temp.check((select status = 'done' and done_by = :fd from public.photo_requests where id = :'q3'), 'the front desk (uploads photos) marks a request done');
select pg_temp.expect_error(format('select public.photo_request_done(%L)', :'q3'), 'already closed', 'marking it done again is refused');
reset role;
select pg_temp.check((select count(*) from public.audit_log where table_name = 'photo_requests' and action = 'INSERT') = 3
                     and (select count(*) from public.audit_log where table_name = 'photo_requests' and action = 'UPDATE') = 3,
  'every request and every change is in the audit log');
select pg_temp.act_as('');
rollback;
