-- The front desk uploads pictures and X-rays; the coordinator sees each patient's installments due, never a total
-- (20261016000100_desk_uploads_coordinator_dues.sql). Made-up people only, with the access list as the clinic has it live (the front
-- desk and the coordinator without "View invoices and payments").
--   0. the file runs twice: the second run changes nothing (no grid cell, no audit row); the policies and functions are there once,
--      and public.photo_thumb_path makes the same small-copy path as the website's thumbPathFor;
--   1. the grid: the front desk has photos.upload now, and still not photos.view_raw;
--   2. the front desk saves a picture (file, small copy and row, read back in the same request as the website does) and sees it, the
--      row and both files; who saved it is always the person saving it; it does not see raw photos someone else saved (another front
--      desk login neither sees its picture), and cannot get at one: not by writing its name on it, a second row for its file, a row
--      whose small copy is that file, a row of the same name (whose small copy would be the other photo's), a row for the other photo's
--      small copy, a row outside the patient's folder (the raw inbox), a row for a file Storage recorded as someone else's, or by
--      changing a photo's kind, file or patient afterwards; it changes only its own photos, and nobody but Dr. Ali changes "may be
--      shown on the website" after saving;
--   3. the front desk saves an X-ray (file and row) and sees both, and a consent form (file and row) and deletes it again;
--   4. an assistant uploads all three (picture, X-ray, consent form) and sees them; the accountant uploads none;
--   5. installment plans by branch: the coordinator reads the payment plans, installments and installment_status rows of the patients of
--      her branches (registered there, or with an invoice or a payment there) and of no other patient, with "paid" counting the
--      patient's payments at every branch; she cannot move a patient's branch, an invoice or a payment to reach another patient's plan;
--      without billing.edit she reads none; the assistant and the doctor still read no plan; the front desk reads the plans of its
--      branch's patients and the plan it saves for a patient of another branch (and no payments of that patient), changes only those,
--      and still saves a plan;
--   6. no total opens: payments_summary(), total_dues(), clinic_report() and the branch income views still refuse the coordinator and
--      the front desk, and no view or function adds up plans or installments across patients.
\set ON_ERROR_STOP 1
\set admin  '''00000000-0000-0000-0000-000000003800'''
\set fd     '''00000000-0000-0000-0000-000000003801'''
\set fd2    '''00000000-0000-0000-0000-000000003802'''
\set asst   '''00000000-0000-0000-0000-000000003803'''
\set doc    '''00000000-0000-0000-0000-000000003804'''
\set coord  '''00000000-0000-0000-0000-000000003805'''
\set acct   '''00000000-0000-0000-0000-000000003806'''

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
create or replace function pg_temp.expect_state(sql text, state text, needle text, msg text) returns void language plpgsql as $$
declare st text; m text;
begin
  execute sql;
  raise exception 'TEST FAILED (no error): %', msg;
exception when others then
  st := sqlstate; m := sqlerrm;
  if m like 'TEST FAILED%' then raise; end if;
  if st <> state or position(needle in m) = 0 then raise exception 'TEST FAILED: % (expected % "%", got % %)', msg, state, needle, st, m; end if;
  raise notice 'ok - % (blocked: % %)', msg, st, left(m, 60);
end $$;
create or replace function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, false) $$;
-- This file's patients (Mr# 38001-38005).
create or replace function pg_temp.p38(p_mr text) returns uuid language sql as $$ select id from public.patients where mr_number = p_mr $$;
-- The plan 'Sample plan 38' of one of them (its id kept when the plans are made, so it is the same whoever asks).
create or replace function pg_temp.plan38(p_mr text) returns uuid language sql as $$
  select nullif(current_setting('test.plan' || p_mr, true), '')::uuid $$;
create or replace function pg_temp.grid38() returns text language sql as $$
  select md5(string_agg(role::text || ':' || permission_key || ':' || allowed::text, ',' order by role, permission_key)) from public.role_permissions $$;
grant execute on all functions in schema pg_temp to authenticated, anon;
reset role;
select pg_temp.act_as('');

-- 0. The file again (it commits, so it runs before the transaction below): nothing changes the second time.
create temp table t38_before as
  select pg_temp.grid38() as grid, coalesce((select max(id) from public.audit_log), 0) as audit_id;
\ir ../migrations/20261016000100_desk_uploads_coordinator_dues.sql
select pg_temp.check((select grid from t38_before) = pg_temp.grid38()
                     and not exists (select 1 from public.audit_log where id > (select audit_id from t38_before) and table_name = 'role_permissions'),
  'the file run a second time changes no grid cell and writes no audit row');
select pg_temp.check((select count(*) from pg_policies where (schemaname, tablename, policyname) in
                       (('public', 'photos', 'uploaders see their photos'), ('storage', 'objects', 'uploaders read their clinic photos'),
                        ('public', 'payment_plans', 'branch billers view plans'), ('public', 'payment_plans', 'billers add plans'),
                        ('public', 'payment_plans', 'billers change plans'), ('public', 'payment_plans', 'billers remove plans'),
                        ('public', 'plan_installments', 'branch billers view installments'), ('public', 'plan_installments', 'billers add installments'),
                        ('public', 'plan_installments', 'billers change installments'), ('public', 'plan_installments', 'billers remove installments'))) = 10
                     and not exists (select 1 from pg_policies where schemaname = 'public' and policyname in ('manage plans', 'manage installments')),
  'the ten policies are there once each, and "manage plans" / "manage installments" (every plan of every branch) are gone');
select pg_temp.check((select count(*) from pg_trigger where not tgisinternal and tgname in
                       ('photos_guard', 'patients_guard_branch', 'invoices_guard_patient', 'payments_guard_patient', 'payment_plans_created_by')) = 5,
  'the five guards are there once each');
select pg_temp.check(not has_function_privilege('anon', 'public.biller_sees_plans_of(uuid)', 'execute')
                     and has_function_privilege('authenticated', 'public.biller_sees_plans_of(uuid)', 'execute')
                     and not has_function_privilege('anon', 'public.plan_paid(uuid)', 'execute')
                     and has_function_privilege('authenticated', 'public.plan_paid(uuid)', 'execute')
                     and has_function_privilege('authenticated', 'public.photo_thumb_path(text)', 'execute')
                     and not has_function_privilege('authenticated', 'private.photo_guard()', 'execute')
                     and not has_function_privilege('authenticated', 'private.guard_patient_branch()', 'execute')
                     and not has_function_privilege('authenticated', 'private.guard_money_patient()', 'execute')
                     and not has_function_privilege('authenticated', 'private.plan_created_by()', 'execute'),
  'biller_sees_plans_of and plan_paid are for signed-in users only; the guard functions cannot be called');
select pg_temp.check(public.photo_thumb_path('p/raw/2026-10-16_Front_ab12cd34.jpg') = 'p/raw/thumbs/2026-10-16_Front_ab12cd34.jpg'
                     and public.photo_thumb_path('p/edited/a.b.PNG') = 'p/edited/thumbs/a.b.jpg'
                     and public.photo_thumb_path('p/raw/noext') = 'p/raw/thumbs/noext.jpg'
                     and public.photo_thumb_path('x.heic') = 'thumbs/x.jpg' and public.photo_thumb_path(null) is null,
  'photo_thumb_path: the small copy''s path as the website''s thumbPathFor makes it');

begin;
-- The access list as live (15 Oct 2026): the front desk bills without "View invoices and payments" or "Give discounts", the coordinator
-- edits invoices without "View invoices and payments".
update public.role_permissions set allowed = false
 where (role::text, permission_key) in (('front_desk', 'billing.view'), ('front_desk', 'discount.give'), ('coordinator', 'billing.view'));
update public.role_permissions set allowed = true
 where (role::text, permission_key) in (('front_desk', 'billing.create'), ('coordinator', 'billing.edit'));

-- 1. The grid.
select pg_temp.check((select string_agg(role::text || '=' || allowed::text, ',' order by role::text) from public.role_permissions where permission_key = 'photos.upload')
                      = 'accountant=false,admin=true,assistant=true,coordinator=true,doctor=true,front_desk=true',
  'photos.upload: the front desk now, with the assistant, the doctor, the coordinator and Dr. Ali; the accountant still no');
select pg_temp.check((select string_agg(role::text || '=' || allowed::text, ',' order by role::text) from public.role_permissions where permission_key = 'photos.view_raw')
                      = 'accountant=false,admin=true,assistant=true,coordinator=true,doctor=true,front_desk=false',
  'photos.view_raw is unchanged: the front desk does not see every raw photo');

insert into auth.users (id, email) values
  (:admin, 'admin38@dralirashid.com'), (:fd, 'fd38@dralirashid.com'), (:fd2, 'fd38b@dralirashid.com'), (:asst, 'asst38@dralirashid.com'),
  (:doc, 'doc38@dralirashid.com'), (:coord, 'coord38@dralirashid.com'), (:acct, 'acct38@dralirashid.com');
insert into public.staff (id, full_name, email, role, restrict_to_branches, branch_ids) values
  (:admin, 'Admin Thirtyeight', 'admin38@dralirashid.com', 'admin', false, '{}'),
  (:fd, 'Front Desk Thirtyeight', 'fd38@dralirashid.com', 'front_desk', true, '{1}'),
  (:fd2, 'Front Desk Thirtyeight Two', 'fd38b@dralirashid.com', 'front_desk', true, '{1}'),
  (:asst, 'Assistant Thirtyeight', 'asst38@dralirashid.com', 'assistant', true, '{1}'),
  (:doc, 'Doctor Thirtyeight', 'doc38@dralirashid.com', 'doctor', false, '{}'),
  (:coord, 'Coordinator Thirtyeight', 'coord38@dralirashid.com', 'coordinator', true, '{1,2}'),
  (:acct, 'Accountant Thirtyeight', 'acct38@dralirashid.com', 'accountant', false, '{}');
-- p1 registered at branch 1; p2 registered at branch 3 with an invoice at branch 2; p3 registered at branch 4, billed and paid there only;
-- p4 registered at branch 3 with a payment (and no invoice) at branch 1 and another at branch 3; p5 for the assistant's uploads.
insert into public.patients (mr_number, full_name, phone, first_branch_id) values
  ('38001', 'Sample Thirtyeight One', '03005553801', 1), ('38002', 'Sample Thirtyeight Two', '03005553802', 3),
  ('38003', 'Sample Thirtyeight Three', '03005553803', 4), ('38004', 'Sample Thirtyeight Four', '03005553804', 3),
  ('38005', 'Sample Thirtyeight Five', '03005553805', 1);
select id as p1 from public.patients where mr_number = '38001' \gset
select id as p2 from public.patients where mr_number = '38002' \gset
select id as p3 from public.patients where mr_number = '38003' \gset
select id as p4 from public.patients where mr_number = '38004' \gset
select id as p5 from public.patients where mr_number = '38005' \gset
select set_config('test.p1', :'p1', false), set_config('test.p2', :'p2', false), set_config('test.p3', :'p3', false), set_config('test.p4', :'p4', false);

-- 2. The front desk saves a picture as the website does: the file, its small copy, then the row read back in the same request.
-- (uploaded_by is sent as someone else's on purpose: the database writes who really saved it.)
set role authenticated;
select pg_temp.act_as(:fd);
select pg_temp.check(public.has_perm('photos.upload') and not public.has_perm('photos.view_raw') and public.has_perm('xrays.view'),
  'the front desk: photos.upload and xrays.view, not photos.view_raw');
insert into storage.objects (bucket_id, name) values
  ('clinic-photos', :'p1' || '/raw/2026-10-16_Front_38aaaaaa.jpg'), ('clinic-photos', :'p1' || '/raw/thumbs/2026-10-16_Front_38aaaaaa.jpg');
insert into public.photos (patient_id, branch_id, kind, view_label, storage_path, thumb_path, uploaded_by)
values (:'p1', 1, 'raw', 'Front', :'p1' || '/raw/2026-10-16_Front_38aaaaaa.jpg', :'p1' || '/raw/thumbs/2026-10-16_Front_38aaaaaa.jpg', :asst)
returning id, kind, view_label;
select pg_temp.check((select count(*) from public.photos where patient_id = :'p1') = 1
                     and (select uploaded_by from public.photos where patient_id = :'p1') = :fd::uuid,
  'the front desk saves a raw picture and reads its row back (the website''s insert-and-select); uploaded_by is the front desk, not what was sent');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'clinic-photos' and name like :'p1' || '/raw/%38aaaaaa.jpg') = 2,
  'and reads the picture and its small copy in storage (the profile signs both)');
select pg_temp.expect_error(format($$insert into public.photos (patient_id, kind, storage_path) values (%L, 'raw', %L)$$, :'p1', :'p1' || '/raw/2026-10-16_Front_38aaaaaa.jpg'),
  'duplicate key', 'saving the same picture again answers "duplicate key", as the website''s retry expects');
-- A file Storage recorded as the front desk's (owner: the uploader's login, as Storage fills it in), before any row names it.
insert into storage.objects (bucket_id, name, owner) values ('clinic-photos', :'p1' || '/raw/2026-10-16_Right_38ffffff.jpg', auth.uid());
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'clinic-photos' and name like :'p1' || '/raw/%38ffffff.jpg') = 1,
  'a file Storage recorded as the front desk''s is readable by it before its row is saved (the moment between the two)');
select pg_temp.act_as(:fd2);
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'clinic-photos' and name like :'p1' || '/raw/%38ffffff.jpg') = 0,
  'but not by another front desk login');
select pg_temp.act_as(:fd);
reset role;

-- Someone else's raw photo of the same patient (the assistant's), a file Storage recorded as the assistant's that no row names yet, and a
-- file in the raw inbox.
set role authenticated;
select pg_temp.act_as(:asst);
insert into storage.objects (bucket_id, name) values
  ('clinic-photos', :'p1' || '/raw/2026-10-16_Left_38bbbbbb.jpg'), ('clinic-photos', :'p1' || '/raw/thumbs/2026-10-16_Left_38bbbbbb.jpg');
insert into public.photos (patient_id, kind, view_label, storage_path, thumb_path)
values (:'p1', 'raw', 'Left', :'p1' || '/raw/2026-10-16_Left_38bbbbbb.jpg', :'p1' || '/raw/thumbs/2026-10-16_Left_38bbbbbb.jpg')
returning id;
insert into storage.objects (bucket_id, name, owner) values ('clinic-photos', :'p1' || '/raw/2026-10-16_Upper_38abab12.jpg', auth.uid());
reset role;
select pg_temp.act_as('');
insert into storage.objects (bucket_id, name) values ('clinic-photos', 'inbox/GUL/2026-10-16/IMG_3801.jpg');

set role authenticated;
select pg_temp.act_as(:fd);
select pg_temp.check((select count(*) from public.photos where patient_id = :'p1') = 1
                     and (select count(*) from storage.objects where bucket_id = 'clinic-photos' and name like :'p1' || '/raw/%38bbbbbb.jpg') = 0
                     and (select count(*) from storage.objects where bucket_id = 'clinic-photos' and name like '%38abab12%') = 0,
  'the front desk does not see the assistant''s raw photos, rows or files (that needs "View raw clinic photos folder")');
update public.photos set uploaded_by = auth.uid() where view_label = 'Left';
update public.photos set uploaded_by = auth.uid();
select pg_temp.check((select count(*) from public.photos where patient_id = :'p1') = 1,
  'it cannot claim the assistant''s photo by writing its own name on it');
select pg_temp.expect_error(format($$insert into public.photos (patient_id, kind, storage_path) values (%L, 'raw', %L)$$, :'p1', :'p1' || '/raw/2026-10-16_Left_38bbbbbb.jpg'),
  'duplicate key', 'nor by saving a second row for the assistant''s file');
select pg_temp.expect_state(format($$insert into public.photos (patient_id, kind, storage_path, thumb_path) values (%L, 'raw', %L, %L)$$,
                                   :'p1', :'p1' || '/raw/2026-10-16_Mine_38999999.jpg', :'p1' || '/raw/2026-10-16_Left_38bbbbbb.jpg'),
  '42501', 'own folder', 'nor by a row of its own whose "small copy" is the assistant''s picture');
select pg_temp.expect_state(format($$insert into public.photos (patient_id, kind, storage_path) values (%L, 'raw', %L)$$, :'p1', :'p1' || '/raw/2026-10-16_Left_38bbbbbb.png'),
  '42501', 'already saved', 'nor by a row of the same name (its small copy would be the assistant''s)');
select pg_temp.expect_state(format($$insert into public.photos (patient_id, kind, storage_path) values (%L, 'raw', %L)$$, :'p1', :'p1' || '/raw/thumbs/2026-10-16_Left_38bbbbbb.jpg'),
  '42501', 'own folder', 'nor by a row for the assistant''s small copy');
select pg_temp.expect_state(format($$insert into public.photos (patient_id, kind, storage_path) values (%L, 'raw', %L)$$, :'p1', :'p1' || '/raw/2026-10-16_Upper_38abab12.jpg'),
  '42501', 'already saved', 'nor by a row for a file Storage recorded as the assistant''s');
select pg_temp.expect_state(format($$insert into public.photos (patient_id, kind, storage_path) values (%L, 'raw', 'inbox/GUL/2026-10-16/IMG_3801.jpg')$$, :'p1'),
  '42501', 'own folder', 'nor by a row naming a raw inbox file (no patient''s folder)');
select pg_temp.expect_state(format($$insert into public.photos (patient_id, kind, storage_path) values (%L, 'raw', %L)$$, :'p5', :'p1' || '/raw/2026-10-16_Other_38121212.jpg'),
  '42501', 'own folder', 'nor by a row of one patient for a file in another patient''s folder');
select pg_temp.expect_state(format($$insert into public.photos (patient_id, kind, storage_path) values (%L, 'edited', %L)$$, :'p1', :'p1' || '/raw/2026-10-16_Other_38343434.jpg'),
  '42501', 'own folder', 'nor by an "edited" row for a file in the raw folder');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'clinic-photos' and (name like '%38bbbbbb%' or name like '%38abab12%' or name like 'inbox/%')) = 0,
  'after all that it still reads none of the assistant''s files and nothing in the inbox');
-- Changing a saved photo: only its own, and never its file, patient, kind or "may be shown on the website".
select pg_temp.expect_state($$update public.photos set kind = 'edited'$$, '42501', 'keeps its file', 'a photo''s kind stays as saved (a bare update cannot turn raw photos into edited ones)');
select pg_temp.expect_state(format($$update public.photos set thumb_path = %L$$, :'p1' || '/raw/2026-10-16_Left_38bbbbbb.jpg'), '42501', 'keeps its file', 'nor its small copy');
select pg_temp.expect_state(format($$update public.photos set patient_id = %L$$, :'p5'), '42501', 'keeps its file', 'nor its patient');
select pg_temp.expect_state($$update public.photos set public_ok = true$$, '42501', 'only Dr. Ali', 'nor "may be shown on the website"');
update public.photos set view_label = 'Changed by the desk' where view_label = 'Left';
update public.photos set view_label = 'Front (desk)' where view_label = 'Front';
select pg_temp.check((select view_label from public.photos where patient_id = :'p1') = 'Front (desk)', 'it corrects the view of its own picture');
select pg_temp.act_as(:fd2);
select pg_temp.check((select count(*) from public.photos where patient_id = :'p1') = 0
                     and (select count(*) from storage.objects where bucket_id = 'clinic-photos' and name like :'p1' || '/raw/%') = 0,
  'another front desk login does not see the first one''s picture (each sees what it saved itself)');
reset role;
select pg_temp.act_as('');
select pg_temp.check((select string_agg(view_label || ':' || kind::text || ':' || public_ok::text, ',' order by view_label) from public.photos where patient_id = :'p1')
                      = 'Front (desk):raw:false,Left:raw:false',
  'the assistant''s photo is unchanged (view, kind, website flag), and so is the front desk''s but for its view');
set role authenticated;
select pg_temp.act_as(:asst);
select pg_temp.check((select uploaded_by from public.photos where view_label = 'Left') = :asst::uuid,
  'the assistant''s photo is still the assistant''s');
update public.photos set view_label = 'Front' where view_label = 'Front (desk)';
select pg_temp.check((select count(*) from public.photos where view_label = 'Front' and uploaded_by = :fd::uuid) = 1,
  'the assistant ("View raw clinic photos folder") still corrects any photo, and it stays the front desk''s');
select pg_temp.expect_state($$update public.photos set public_ok = true where view_label = 'Left'$$, '42501', 'only Dr. Ali',
  'the assistant does not change "may be shown on the website" after saving either');
select pg_temp.act_as(:admin);
update public.photos set public_ok = true where view_label = 'Left';
select pg_temp.check((select public_ok from public.photos where view_label = 'Left'), 'Dr. Ali does');
update public.photos set public_ok = false where view_label = 'Left';
reset role;
select pg_temp.act_as('');

-- 3. The front desk saves an X-ray (file and row) and sees both; a consent form, and deletes it.
set role authenticated;
select pg_temp.act_as(:fd);
insert into storage.objects (bucket_id, name) values ('xrays', :'p1' || '/2026-10-16_OPG_38cccccc.png');
insert into public.xrays (patient_id, kind, taken_on, storage_path, uploaded_by) values (:'p1', 'OPG', '2026-10-16', :'p1' || '/2026-10-16_OPG_38cccccc.png', auth.uid())
returning id, kind;
select pg_temp.check((select count(*) from public.xrays where patient_id = :'p1') = 1
                     and (select count(*) from storage.objects where bucket_id = 'xrays' and name like :'p1' || '/%') = 1,
  'the front desk saves an X-ray, file and row, and sees both');
insert into storage.objects (bucket_id, name) values ('patient-documents', :'p1' || '/2026-10-16_Consent_38dddddd.jpg');
insert into public.patient_documents (patient_id, kind, title, storage_path, added_on)
values (:'p1', 'consent', 'Consent and information form', :'p1' || '/2026-10-16_Consent_38dddddd.jpg', '2026-10-16') returning id;
select pg_temp.check((select count(*) from public.patient_documents where patient_id = :'p1') = 1
                     and (select count(*) from storage.objects where bucket_id = 'patient-documents' and name like :'p1' || '/%') = 1,
  'the front desk saves a consent form, file and row, and sees both');
delete from storage.objects where bucket_id = 'patient-documents' and name = :'p1' || '/2026-10-16_Consent_38dddddd.jpg';
select pg_temp.check((select public.delete_patient_document((select id from public.patient_documents where patient_id = :'p1')) ->> 'deleted') = 'true',
  'and deletes it again (the file, then the row)');
select pg_temp.check(not exists (select 1 from public.patient_documents where patient_id = :'p1'), 'the consent form is gone');
reset role;
select pg_temp.act_as('');

-- 4. The assistant uploads all three; the accountant none.
set role authenticated;
select pg_temp.act_as(:asst);
insert into storage.objects (bucket_id, name) values
  ('clinic-photos', :'p5' || '/raw/2026-10-16_Front_38eeeeee.jpg'), ('xrays', :'p5' || '/2026-10-16_OPG_38eeeeee.png'),
  ('patient-documents', :'p5' || '/2026-10-16_Consent_38eeeeee.pdf');
insert into public.photos (patient_id, kind, storage_path) values (:'p5', 'raw', :'p5' || '/raw/2026-10-16_Front_38eeeeee.jpg') returning id;
insert into public.xrays (patient_id, storage_path) values (:'p5', :'p5' || '/2026-10-16_OPG_38eeeeee.png') returning id;
insert into public.patient_documents (patient_id, kind, title, storage_path) values (:'p5', 'consent', 'Consent form', :'p5' || '/2026-10-16_Consent_38eeeeee.pdf') returning id;
select pg_temp.check((select count(*) from public.photos where patient_id = :'p5') = 1 and (select count(*) from public.xrays where patient_id = :'p5') = 1
                     and (select count(*) from public.patient_documents where patient_id = :'p5') = 1
                     and (select count(*) from storage.objects where name like :'p5' || '/%') = 3,
  'the assistant uploads a picture, an X-ray and a consent form, and sees all three rows and files');
select pg_temp.act_as(:acct);
select pg_temp.expect_error(format($$insert into public.photos (patient_id, storage_path) values (%L, 'x38.jpg')$$, :'p5'), 'row-level security', 'the accountant saves no photo');
select pg_temp.expect_error(format($$insert into public.xrays (patient_id, storage_path) values (%L, 'x38.png')$$, :'p5'), 'row-level security', 'no X-ray');
select pg_temp.expect_error(format($$insert into public.patient_documents (patient_id, title, storage_path) values (%L, 'x', 'x38.pdf')$$, :'p5'), 'row-level security', 'no document');
select pg_temp.expect_error($$insert into storage.objects (bucket_id, name) values ('clinic-photos', 'x38/raw/a.jpg')$$, 'row-level security', 'and no file in clinic photos');
select pg_temp.expect_error($$insert into storage.objects (bucket_id, name) values ('xrays', 'x38/a.png')$$, 'row-level security', 'or X-rays');
reset role;
select pg_temp.act_as('');

-- 5. Installment plans. p2 has an invoice at branch 2, p3 an invoice and a payment at branch 4, p4 a payment at branch 1 and one at
-- branch 3.
insert into public.invoices (patient_id, branch_id, subtotal) values (:'p2', 2, 1000), (:'p3', 4, 1000);
insert into public.payments (patient_id, branch_id, amount, received_at) values
  (:'p4', 1, 500, now() - interval '30 days'), (:'p4', 3, 5000, now() - interval '20 days'), (:'p3', 4, 5000, now() - interval '20 days');
insert into public.payment_plans (patient_id, total_fee, starts_on, notes)
select id, 15000, current_date - 40, 'Sample plan 38' from public.patients where mr_number in ('38001', '38002', '38003', '38004');
insert into public.plan_installments (plan_id, due_date, amount, note)
select pl.id, d.due, 5000, d.note from public.payment_plans pl
  cross join (values (current_date - 10, 'Installment 1'), (current_date + 3, 'Installment 2'), (current_date + 40, 'Installment 3')) as d(due, note)
 where pl.notes = 'Sample plan 38';
select set_config('test.plan' || pt.mr_number, pl.id::text, false)
  from public.payment_plans pl join public.patients pt on pt.id = pl.patient_id where pl.notes = 'Sample plan 38';

set role authenticated;
select pg_temp.act_as(:coord);
select pg_temp.check(public.has_perm('billing.edit') and not public.has_perm('billing.view') and not public.has_perm('billing.create'),
  'the coordinator: billing.edit, without billing.view or billing.create (as live)');
select pg_temp.check((select string_agg(pt.mr_number, ',' order by pt.mr_number) from public.payment_plans pl join public.patients pt on pt.id = pl.patient_id
                       where pl.notes = 'Sample plan 38') = '38001,38002,38004',
  'the coordinator reads the plans of patients registered at her branches (38001), billed there (38002) or paid there (38004), not 38003');
select pg_temp.check((select count(*) from public.plan_installments i join public.payment_plans pl on pl.id = i.plan_id where pl.notes = 'Sample plan 38') = 9,
  'and their installments, three each');
select pg_temp.check((select string_agg(pt.mr_number || ':' || s.status, ',' order by pt.mr_number, s.due_date) from public.installment_status s join public.patients pt on pt.id = s.patient_id
                       where s.patient_id in (pg_temp.p38('38001'), pg_temp.p38('38002'), pg_temp.p38('38003'), pg_temp.p38('38004'))
                         and s.status in ('overdue', 'due_soon'))
                      = '38001:overdue,38001:due_soon,38002:overdue,38002:due_soon,38004:due_soon',
  'her "Installments due": each of her patients'' overdue and due-soon installments, one row each, and nothing of 38003 (38004''s first one is paid)');
select pg_temp.check((select count(*) from public.payments where patient_id = pg_temp.p38('38004')) = 1
                     and (select string_agg(status, ',' order by due_date) from public.installment_status where patient_id = pg_temp.p38('38004')) = 'paid,due_soon,upcoming'
                     and (select bool_and(paid = 5500) from public.installment_status where patient_id = pg_temp.p38('38004'))
                     and (select remaining from public.installment_status where patient_id = pg_temp.p38('38004') and status = 'due_soon') = 4500,
  '"paid" counts the patient''s payments at every branch (Rs 500 at hers, Rs 5,000 at branch 3, whose payment row she does not read), so she does not call a patient who is up to date');
select pg_temp.check(public.biller_sees_plans_of(pg_temp.p38('38001')) and public.biller_sees_plans_of(pg_temp.p38('38002'))
                     and public.biller_sees_plans_of(pg_temp.p38('38004')) and not public.biller_sees_plans_of(pg_temp.p38('38003'))
                     and not public.biller_sees_plans_of(null),
  'biller_sees_plans_of: yes for her branches'' patients, no for the others');
select pg_temp.check(public.plan_paid(pg_temp.plan38('38004')) = 5500 and public.plan_paid(pg_temp.plan38('38003')) is null,
  'plan_paid answers for her patients'' plans only');
select pg_temp.expect_error(format($$insert into public.payment_plans (patient_id, total_fee) values (%L, 1000)$$, pg_temp.p38('38001')),
  'row-level security', 'she reads plans but does not make them (that stays with billing.create)');
update public.plan_installments set amount = 1 where note = 'Installment 1';
delete from public.payment_plans where notes = 'Sample plan 38';
-- Nor can she move a patient of another branch, an invoice or a payment so as to read 38003's plan.
select pg_temp.expect_state(format($$update public.patients set first_branch_id = 1 where id = %L$$, pg_temp.p38('38003')),
  '42501', 'change the branch a patient was registered at', 'she cannot move 38003 (branch 4) to one of her branches');
update public.patients set first_branch_id = 2 where id = pg_temp.p38('38001');
select pg_temp.check((select first_branch_id from public.patients where id = pg_temp.p38('38001')) = 2, 'but moves a patient between her own two branches');
update public.patients set first_branch_id = 1 where id = pg_temp.p38('38001');
select pg_temp.expect_state(format($$update public.payments set patient_id = %L where patient_id = %L$$, pg_temp.p38('38003'), pg_temp.p38('38004')),
  '42501', 'only Dr. Ali moves a payment', 'she cannot move a payment of her branch to 38003');
select pg_temp.expect_state(format($$update public.invoices set patient_id = %L where patient_id = %L$$, pg_temp.p38('38003'), pg_temp.p38('38002')),
  '42501', 'only Dr. Ali moves an invoice', 'nor an invoice');
select pg_temp.check(not public.biller_sees_plans_of(pg_temp.p38('38003')) and (select count(*) from public.payment_plans where patient_id = pg_temp.p38('38003')) = 0,
  '38003''s plan stays out of her reach');
reset role;
select pg_temp.act_as('');
select pg_temp.check((select count(*) from public.plan_installments i join public.payment_plans pl on pl.id = i.plan_id where pl.notes = 'Sample plan 38' and i.amount = 5000) = 12,
  'nor changes or removes them');

-- Without billing.edit (a personal untick), the coordinator reads no plan.
insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (:coord, 'billing.edit', false);
set role authenticated;
select pg_temp.act_as(:coord);
select pg_temp.check((select count(*) from public.payment_plans where notes = 'Sample plan 38') = 0
                     and (select count(*) from public.installment_status where patient_id in (pg_temp.p38('38001'), pg_temp.p38('38002'), pg_temp.p38('38004'))) = 0
                     and public.plan_paid(pg_temp.plan38('38001')) is null,
  'with "Edit or void invoices" unticked for her, she reads no plan and no installment');
reset role;
select pg_temp.act_as('');
delete from public.staff_permission_overrides where staff_id = :coord and permission_key = 'billing.edit';

set role authenticated;
select pg_temp.act_as(:asst);
select pg_temp.check((select count(*) from public.payment_plans where notes = 'Sample plan 38') = 0 and (select count(*) from public.plan_installments) = 0
                     and (select count(*) from public.installment_status) = 0 and public.plan_paid(pg_temp.plan38('38001')) is null,
  'the assistant still reads no plan, installment or installment status');
select pg_temp.act_as(:doc);
select pg_temp.check((select count(*) from public.payment_plans where notes = 'Sample plan 38') = 0 and (select count(*) from public.plan_installments) = 0
                     and (select count(*) from public.installment_status) = 0, 'nor the doctor');

-- The front desk ("Create invoices and take payments", branch 1): the plans of its branch's patients, not every branch's.
select pg_temp.act_as(:fd);
select pg_temp.check((select string_agg(pt.mr_number, ',' order by pt.mr_number) from public.payment_plans pl join public.patients pt on pt.id = pl.patient_id
                       where pl.notes = 'Sample plan 38') = '38001,38004'
                     and (select count(*) from public.plan_installments i join public.payment_plans pl on pl.id = i.plan_id where pl.notes = 'Sample plan 38') = 6,
  'the front desk reads the plans and installments of patients registered (38001) or paid (38004) at its branch, not of 38002 or 38003');
-- It saves a plan for 38003 (branch 4) and reads that one back, and no more of 38003.
select pg_temp.check((public.save_installment_plan(null, jsonb_build_object('patient_id', pg_temp.p38('38003'), 'total_fee', 10000, 'notes', 'Desk plan 38',
                                                                            'starts_on', current_date - 40, 'created_by', :asst::text),
                       jsonb_build_array(jsonb_build_object('due_date', current_date - 5, 'amount', 10000))) ->> 'notes') = 'Desk plan 38',
  'the front desk saves an installment plan for a patient of another branch (the plan comes back from the save)');
select pg_temp.check((select string_agg(pl.notes || ':' || (pl.created_by = :fd::uuid)::text || ':' || (select count(*) from public.plan_installments i where i.plan_id = pl.id)::text, ',')
                        from public.payment_plans pl where pl.patient_id = pg_temp.p38('38003')) = 'Desk plan 38:true:1',
  'and reads it back with its installment (it made it), but not the other plan of 38003');
select pg_temp.check(public.plan_paid((select id from public.payment_plans where notes = 'Desk plan 38')) is null
                     and (select string_agg(status, ',') from public.installment_status where patient_id = pg_temp.p38('38003')) = 'overdue'
                     and (select paid from public.installment_status where patient_id = pg_temp.p38('38003')) = 0,
  'its own plan counts only the payments it reads: 38003''s payment at branch 4 is not shown to it, not even as "paid"');
update public.payment_plans set created_by = null, notes = 'Desk plan 38 (edited)' where notes = 'Desk plan 38';
update public.plan_installments set note = coalesce(note, '') || ' (desk)' where plan_id in (select id from public.payment_plans);
update public.plan_installments set note = 'Changed by the desk' where plan_id = pg_temp.plan38('38002');
delete from public.payment_plans where id = pg_temp.plan38('38002');
reset role;
select pg_temp.act_as('');
select pg_temp.check((select created_by from public.payment_plans where notes = 'Desk plan 38 (edited)') = :fd::uuid,
  'who made a plan stays the person who saved it');
select pg_temp.check((select string_agg(distinct pt.mr_number, ',' order by pt.mr_number) from public.plan_installments i join public.payment_plans pl on pl.id = i.plan_id
                       join public.patients pt on pt.id = pl.patient_id where i.note like '% (desk)') = '38001,38003,38004'
                     and exists (select 1 from public.payment_plans where patient_id = pg_temp.p38('38002'))
                     and not exists (select 1 from public.plan_installments where note = 'Changed by the desk'),
  'the front desk changes only the plans it reads (38001, 38004 and its own for 38003) and removes no plan of 38002');

-- 6. No total opens for the coordinator or the front desk.
do $$
declare who text;
begin
  foreach who in array array['coord', 'fd'] loop
    perform pg_temp.act_as(case who when 'coord' then '00000000-0000-0000-0000-000000003805' else '00000000-0000-0000-0000-000000003801' end);
    perform pg_temp.expect_state('select public.payments_summary(null, null)', '42501', 'NOT_ALLOWED: money totals', 'payments_summary: still refused for the ' || who);
    perform pg_temp.expect_state('select public.total_dues()', '42501', 'NOT_ALLOWED: money totals', 'total_dues: still refused for the ' || who);
    perform pg_temp.expect_state('select public.clinic_report(''dues_by_branch'', current_date - 30, current_date)', '42501', 'Only accounts and Dr. Ali',
      'clinic_report (pending dues by branch): still refused for the ' || who);
    perform pg_temp.check((select count(*) from public.branch_daily_income) = 0 and (select count(*) from public.branch_monthly_pnl) = 0,
      'the branch income views add up nothing for the ' || who);
  end loop;
end $$;
reset role;
select pg_temp.act_as('');
select pg_temp.check((select string_agg(viewname, ',' order by viewname) from pg_views where schemaname = 'public' and (definition like '%plan_installments%' or definition like '%payment_plans%'))
                      = 'installment_status',
  'the only view that reads plans or installments is installment_status (one row per installment, nothing added up across patients)');
select pg_temp.check((select string_agg(distinct proname, ',' order by proname) from pg_proc where pronamespace = 'public'::regnamespace
                       and (prosrc like '%plan_installments%' or prosrc like '%payment_plans%'))
                      = 'merge_patients,plan_paid,save_installment_plan',
  'and the only functions are merge_patients, save_installment_plan and plan_paid (one patient''s plan); none adds them up across patients');
rollback;
