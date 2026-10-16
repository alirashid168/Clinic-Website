-- Delete for pictures and X-rays (20261016000200_photo_xray_delete.sql). Made-up people only.
--   0. the file runs twice: the second run changes no grid cell and writes no audit row; the policies, triggers and functions are there
--      once each, and no DELETE policy lets anyone delete photo or X-ray rows directly;
--   1. the grid: "Delete clinic photos and X-rays" (photos.delete) for the assistant, the coordinator and Dr. Ali; not the front desk, the
--      doctor or the accountant (owner, 16 Oct 2026: "they can delete assistant and coordinator");
--   2. the front desk, the doctor, the accountant, a switched-off account, a patient login and anonymous visitors delete no picture and no
--      X-ray: not through the functions, not with a direct delete of the rows, not by removing the files in Storage (the front desk not
--      even the picture it uploaded); an assistant's direct delete of a row reaches nothing either (only the functions delete rows);
--   3. an assistant (who works at one branch) deletes a raw picture that an edited picture was made from: its file and small copy through
--      Storage, then the row; the edited picture stays and no longer points at it; the visit keeps its "photos uploaded" tick while
--      another picture of it is left, and loses it with the visit's last picture (the completed visit stays completed); she deletes an
--      X-ray (file, then row); she cannot remove files that belong to no picture or X-ray (the raw inbox, a stray X-ray file);
--   4. the coordinator deletes an edited picture that may be on the website: its gallery copy comes off the website too (only that copy:
--      not another file in the gallery, not a name that only looks like it), and an X-ray of a patient registered at a branch she does not
--      work at (patients, pictures and X-rays are seen at every branch, and so deleted);
--   5. with photos.delete ticked for the front desk (Dr. Ali could), it deletes the pictures it sees (its own raw ones, edited ones), never
--      a raw picture someone else took (row or file); Dr. Ali deletes any;
--   6. the audit log: every picture and X-ray added, changed (the edited picture let go of the raw one) and deleted, by whom, with the
--      whole row; a picture or X-ray already gone answers deleted = false.
\set ON_ERROR_STOP 1
\set admin  '''00000000-0000-0000-0000-000000003900'''
\set fd     '''00000000-0000-0000-0000-000000003901'''
\set asst   '''00000000-0000-0000-0000-000000003902'''
\set doc    '''00000000-0000-0000-0000-000000003903'''
\set coord  '''00000000-0000-0000-0000-000000003904'''
\set acct   '''00000000-0000-0000-0000-000000003905'''
\set off    '''00000000-0000-0000-0000-000000003906'''
\set pat    '''00000000-0000-0000-0000-000000003907'''
-- The pictures and X-rays (fixed ids: the website names a gallery copy after the first 8 characters of the picture's id).
\set r1   '''a1390001-0000-4000-8000-000000003901'''
\set r1b  '''a2390002-0000-4000-8000-000000003902'''
\set e1   '''e1390003-0000-4000-8000-000000003903'''
\set f1   '''f1390004-0000-4000-8000-000000003904'''
\set q2   '''b1390005-0000-4000-8000-000000003905'''
\set e2   '''e2390006-0000-4000-8000-000000003906'''
\set x1   '''c1390007-0000-4000-8000-000000003907'''
\set x2   '''c2390008-0000-4000-8000-000000003908'''
\set nil  '''00000000-0000-0000-0000-000000000000'''

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
-- Removing files as the signed-in person, the way Storage's remove() does it (row-level security decides): how many went.
create or replace function pg_temp.rm(p_bucket text, variadic p_names text[]) returns int language plpgsql as $$
declare n int;
begin
  delete from storage.objects where bucket_id = p_bucket and name = any (p_names);
  get diagnostics n = row_count;
  return n;
end $$;
-- A direct delete of rows through the API, as the signed-in person: how many went.
create or replace function pg_temp.del(p_table text, p_id uuid) returns int language plpgsql as $$
declare n int;
begin
  execute format('delete from public.%I where id = $1', p_table) using p_id;
  get diagnostics n = row_count;
  return n;
end $$;
-- has_perm(key) as the person p_staff (what the website asks when it shows a button).
create or replace function pg_temp.perm_as(p_staff uuid, p_key text) returns boolean language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_staff::text, false);
  return public.has_perm(p_key);
end $$;
create or replace function pg_temp.grid39() returns text language sql as $$
  select md5(string_agg(role::text || ':' || permission_key || ':' || allowed::text, ',' order by role, permission_key)) from public.role_permissions $$;
grant execute on all functions in schema pg_temp to authenticated, anon;
reset role;
select pg_temp.act_as('');

-- 0. The file again (it commits, so it runs before the transaction below): nothing changes the second time.
create temp table t39_before as
  select pg_temp.grid39() as grid, coalesce((select max(id) from public.audit_log), 0) as audit_id;
\ir ../migrations/20261016000200_photo_xray_delete.sql
select pg_temp.check((select grid from t39_before) = pg_temp.grid39()
                     and not exists (select 1 from public.audit_log where id > (select audit_id from t39_before) and table_name = 'role_permissions'),
  'the file run a second time changes no grid cell and writes no audit row');
select pg_temp.check((select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname in
                       ('photo deleters remove clinic photos', 'photo deleters remove xray files', 'photo deleters remove website copies')) = 3
                     and not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('photos', 'xrays') and cmd in ('DELETE', 'ALL')),
  'the three file policies are there once each, and no policy deletes photo or X-ray rows directly (only the functions do)');
select pg_temp.check((select count(*) from pg_trigger where not tgisinternal and tgname in ('photos_audit', 'xrays_audit')) = 2,
  'the two audit triggers are there once each');
select pg_temp.check(not has_function_privilege('anon', 'public.delete_patient_photo(uuid)', 'execute')
                     and has_function_privilege('authenticated', 'public.delete_patient_photo(uuid)', 'execute')
                     and not has_function_privilege('anon', 'public.delete_patient_xray(uuid)', 'execute')
                     and has_function_privilege('authenticated', 'public.delete_patient_xray(uuid)', 'execute')
                     and not has_function_privilege('anon', 'public.website_copy_photo(text)', 'execute'),
  'the delete functions are for signed-in users only');

begin;
-- 1. The grid.
select pg_temp.check((select label = 'Delete clinic photos and X-rays' and category = 'Photos' from public.permissions where key = 'photos.delete'),
  'the access list has "Delete clinic photos and X-rays" under Photos');
select pg_temp.check((select string_agg(role::text || '=' || allowed::text, ',' order by role::text) from public.role_permissions where permission_key = 'photos.delete')
                      = 'accountant=false,admin=true,assistant=true,coordinator=true,doctor=false,front_desk=false',
  'photos.delete: the assistant, the coordinator and Dr. Ali; not the front desk, the doctor or the accountant (every role has its cell)');

insert into auth.users (id, email) values
  (:admin, 'admin39@dralirashid.com'), (:fd, 'fd39@dralirashid.com'), (:asst, 'asst39@dralirashid.com'), (:doc, 'doc39@dralirashid.com'),
  (:coord, 'coord39@dralirashid.com'), (:acct, 'acct39@dralirashid.com'), (:off, 'off39@dralirashid.com'), (:pat, 'samplepatient-39@dralirashid.com');
insert into public.staff (id, full_name, email, role, restrict_to_branches, branch_ids) values
  (:admin, 'Admin Thirtynine', 'admin39@dralirashid.com', 'admin', false, '{}'),
  (:fd, 'Front Desk Thirtynine', 'fd39@dralirashid.com', 'front_desk', true, '{1}'),
  (:asst, 'Assistant Thirtynine', 'asst39@dralirashid.com', 'assistant', true, '{1}'),
  (:doc, 'Doctor Thirtynine', 'doc39@dralirashid.com', 'doctor', false, '{}'),
  (:coord, 'Coordinator Thirtynine', 'coord39@dralirashid.com', 'coordinator', true, '{1,2,3}'),
  (:acct, 'Accountant Thirtynine', 'acct39@dralirashid.com', 'accountant', false, '{}');
insert into public.staff (id, full_name, email, role, active) values (:off, 'Switched Off Thirtynine', 'off39@dralirashid.com', 'assistant', false);
-- p1 registered at branch 1 (with a portal login); p2 registered at branch 4, where neither the assistant nor the coordinator works.
insert into public.patients (mr_number, full_name, phone, first_branch_id, portal_user_id) values ('39001', 'Sample Thirtynine One', '03005553901', 1, :pat);
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('39002', 'Sample Thirtynine Two', '03005553902', 4);
select id as p1 from public.patients where mr_number = '39001' \gset
select id as p2 from public.patients where mr_number = '39002' \gset

select pg_temp.check((select string_agg(s.role::text || '=' || pg_temp.perm_as(s.id, 'photos.delete')::text, ',' order by s.role::text)
                        from public.staff s where s.id in (:admin, :fd, :asst, :doc, :coord, :acct))
                      = 'accountant=false,admin=true,assistant=true,coordinator=true,doctor=false,front_desk=false',
  'has_perm(photos.delete) for each role, as the website asks it');
select pg_temp.act_as('');

-- A completed visit of p1 with two raw pictures (its "photos uploaded" tick comes from them), an edited picture made from the first
-- (marked for the website, with its copy in the gallery), a raw picture the front desk uploaded, a raw and an edited picture of p2, and
-- an X-ray of each patient; their files as Storage keeps them, and files that belong to none of them.
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label) values (:'p1', 1, '2026-10-10', 'completed', 'Checkup');
select id as v1 from public.visits where patient_id = :'p1' \gset
insert into public.photos (id, patient_id, visit_id, branch_id, taken_on, kind, view_label, storage_path, thumb_path, uploaded_by) values
  (:r1, :'p1', :'v1', 1, '2026-10-10', 'raw', 'Front', :'p1' || '/raw/2026-10-10_Front_a1390001.jpg', :'p1' || '/raw/thumbs/2026-10-10_Front_a1390001.jpg', :asst),
  (:r1b, :'p1', :'v1', 1, '2026-10-10', 'raw', 'Left', :'p1' || '/raw/2026-10-10_Left_a2390002.jpg', null, :asst),
  (:f1, :'p1', null, 1, '2026-10-13', 'raw', 'Desk', :'p1' || '/raw/2026-10-13_Desk_f1390004.jpg', :'p1' || '/raw/thumbs/2026-10-13_Desk_f1390004.jpg', :fd),
  (:q2, :'p2', null, 4, '2026-10-14', 'raw', 'Front', :'p2' || '/raw/2026-10-14_Front_b1390005.jpg', null, :asst),
  (:e2, :'p2', null, 4, '2026-10-14', 'edited', 'After', :'p2' || '/edited/2026-10-14_After_e2390006.jpg', null, :asst);
insert into public.photos (id, patient_id, taken_on, kind, view_label, storage_path, thumb_path, edited_from, public_ok, uploaded_by) values
  (:e1, :'p1', '2026-10-12', 'edited', 'After', :'p1' || '/edited/2026-10-12_After_e1390003.png', :'p1' || '/edited/thumbs/2026-10-12_After_e1390003.jpg', :r1, true, :asst);
insert into public.xrays (id, patient_id, kind, taken_on, storage_path, uploaded_by) values
  (:x1, :'p1', 'OPG', '2026-10-15', :'p1' || '/2026-10-15_OPG_c1390007.png', :asst),
  (:x2, :'p2', 'OPG', '2026-10-15', :'p2' || '/2026-10-15_OPG_c2390008.png', :asst);
insert into storage.objects (bucket_id, name) values
  ('clinic-photos', :'p1' || '/raw/2026-10-10_Front_a1390001.jpg'), ('clinic-photos', :'p1' || '/raw/thumbs/2026-10-10_Front_a1390001.jpg'),
  ('clinic-photos', :'p1' || '/raw/2026-10-10_Left_a2390002.jpg'),
  ('clinic-photos', :'p1' || '/raw/2026-10-13_Desk_f1390004.jpg'), ('clinic-photos', :'p1' || '/raw/thumbs/2026-10-13_Desk_f1390004.jpg'),
  ('clinic-photos', :'p2' || '/raw/2026-10-14_Front_b1390005.jpg'), ('clinic-photos', :'p2' || '/edited/2026-10-14_After_e2390006.jpg'),
  ('clinic-photos', :'p1' || '/edited/2026-10-12_After_e1390003.png'), ('clinic-photos', :'p1' || '/edited/thumbs/2026-10-12_After_e1390003.jpg'),
  ('clinic-photos', 'inbox/GUL/2026-10-16/IMG_3901.jpg'),
  ('xrays', :'p1' || '/2026-10-15_OPG_c1390007.png'), ('xrays', :'p2' || '/2026-10-15_OPG_c2390008.png'), ('xrays', :'p1' || '/2026-10-15_OPG_99999999.png'),
  ('public-cases', '2026-10-12_After_e1390003.png'), ('public-cases', '2026-10-12_Other_12345678.png'), ('public-cases', '2026-10-11_After_e1390003.png');
select pg_temp.check((select photos_uploaded from public.visits where id = :'v1'), 'the visit''s "photos uploaded" is ticked by its pictures');
select pg_temp.check(public.website_copy_photo('2026-10-12_After_e1390003.png') = :e1::uuid
                     and public.website_copy_photo('2026-10-12_Other-label_e1390003.jpeg') = :e1::uuid
                     and public.website_copy_photo('2026-10-11_After_e1390003.png') is null
                     and public.website_copy_photo('2026-10-12_Other_12345678.png') is null
                     and public.website_copy_photo('2026-10-10_Front_a1390001.jpg') is null
                     and public.website_copy_photo('x/2026-10-12_After_e1390003.png') is null
                     and public.website_copy_photo('2026-10-12_Aftere1390003.png') is null
                     and public.website_copy_photo('2026-10-12_After_E1390003.png') is null
                     and public.website_copy_photo('noextension') is null and public.website_copy_photo(null) is null,
  'website_copy_photo: a gallery file''s picture from its date and id (an edited picture only); anything else is no picture');

create temp table t39_counts as
  select (select count(*) from public.photos where patient_id in (:'p1', :'p2')) as photos,
         (select count(*) from public.xrays where patient_id in (:'p1', :'p2')) as xrays,
         (select count(*) from storage.objects where bucket_id in ('clinic-photos', 'xrays', 'public-cases')) as files;
grant select on t39_counts to authenticated, anon;
create or replace function pg_temp.nothing_gone() returns boolean language sql as $$
  select (select count(*) from public.photos where patient_id in (select id from public.patients where mr_number in ('39001', '39002'))) = c.photos
     and (select count(*) from public.xrays where patient_id in (select id from public.patients where mr_number in ('39001', '39002'))) = c.xrays
     and (select count(*) from storage.objects where bucket_id in ('clinic-photos', 'xrays', 'public-cases')) = c.files
    from t39_counts c $$;

-- 2. Who may not delete: the functions refuse them, and their direct deletes of rows and files reach nothing.
set role authenticated;
select pg_temp.act_as(:fd);
select pg_temp.expect_error(format('select public.delete_patient_photo(%L)', :f1), 'NOT_ALLOWED', 'the front desk cannot delete a picture, not even the one it uploaded');
select pg_temp.expect_error(format('select public.delete_patient_xray(%L)', :x1), 'NOT_ALLOWED', 'nor an X-ray');
select pg_temp.expect_error(format('select public.delete_patient_photo(%L)', :nil), 'NOT_ALLOWED', 'it is refused before any row is looked at (the website''s first question)');
select pg_temp.check(pg_temp.del('photos', :f1) + pg_temp.del('photos', :e1) + pg_temp.del('xrays', :x1) = 0,
  'its direct deletes of photo and X-ray rows reach nothing');
select pg_temp.check(pg_temp.rm('clinic-photos', :'p1' || '/raw/2026-10-13_Desk_f1390004.jpg', :'p1' || '/raw/thumbs/2026-10-13_Desk_f1390004.jpg',
                                :'p1' || '/edited/2026-10-12_After_e1390003.png') = 0
                     and pg_temp.rm('xrays', :'p1' || '/2026-10-15_OPG_c1390007.png') = 0
                     and pg_temp.rm('public-cases', '2026-10-12_After_e1390003.png') = 0,
  'and it removes no file in Storage: not its own picture, an edited one, an X-ray or a gallery copy');
select pg_temp.act_as(:doc);
select pg_temp.expect_error(format('select public.delete_patient_photo(%L)', :r1b), 'NOT_ALLOWED', 'a doctor cannot delete a picture');
select pg_temp.expect_error(format('select public.delete_patient_xray(%L)', :x1), 'NOT_ALLOWED', 'nor an X-ray');
select pg_temp.check(pg_temp.del('photos', :r1b) + pg_temp.del('xrays', :x1) = 0
                     and pg_temp.rm('clinic-photos', :'p1' || '/raw/2026-10-10_Left_a2390002.jpg') + pg_temp.rm('xrays', :'p1' || '/2026-10-15_OPG_c1390007.png') = 0,
  'nor directly, rows or files (a doctor sees them all)');
select pg_temp.act_as(:acct);
select pg_temp.expect_error(format('select public.delete_patient_photo(%L)', :e1), 'NOT_ALLOWED', 'an accountant cannot delete a picture');
select pg_temp.expect_error(format('select public.delete_patient_xray(%L)', :x1), 'NOT_ALLOWED', 'nor an X-ray');
select pg_temp.check(pg_temp.del('photos', :e1) + pg_temp.rm('clinic-photos', :'p1' || '/edited/2026-10-12_After_e1390003.png') + pg_temp.rm('public-cases', '2026-10-12_After_e1390003.png') = 0,
  'nor directly');
select pg_temp.act_as(:off);
select pg_temp.expect_error(format('select public.delete_patient_photo(%L)', :r1b), 'NOT_ALLOWED', 'a switched-off assistant cannot delete a picture');
select pg_temp.check(pg_temp.rm('clinic-photos', :'p1' || '/raw/2026-10-10_Left_a2390002.jpg') = 0, 'nor remove its file');
select pg_temp.act_as(:pat);
select pg_temp.expect_error(format('select public.delete_patient_photo(%L)', :e1), 'NOT_ALLOWED', 'a patient cannot delete a picture of their own');
select pg_temp.expect_error(format('select public.delete_patient_xray(%L)', :x1), 'NOT_ALLOWED', 'nor an X-ray of their own');
select pg_temp.check(pg_temp.del('photos', :e1) + pg_temp.del('xrays', :x1) = 0
                     and pg_temp.rm('clinic-photos', :'p1' || '/edited/2026-10-12_After_e1390003.png') + pg_temp.rm('xrays', :'p1' || '/2026-10-15_OPG_c1390007.png') = 0,
  'nor directly (the patient reads them)');
select pg_temp.act_as(:asst);
select pg_temp.check(pg_temp.del('photos', :r1b) + pg_temp.del('xrays', :x1) = 0,
  'an assistant''s direct delete of a row reaches nothing either: rows are deleted only through the functions');
reset role;
select pg_temp.act_as('');
set role anon;
select pg_temp.expect_error(format('select public.delete_patient_photo(%L)', :e1), 'permission denied', 'an anonymous visitor cannot call the picture function');
select pg_temp.expect_error(format('select public.delete_patient_xray(%L)', :x1), 'permission denied', 'nor the X-ray function');
select pg_temp.check(pg_temp.rm('clinic-photos', :'p1' || '/edited/2026-10-12_After_e1390003.png') + pg_temp.rm('public-cases', '2026-10-12_After_e1390003.png') = 0,
  'nor remove files');
reset role;
select pg_temp.check(pg_temp.nothing_gone(), 'after all that, every picture, X-ray and file is still there');

-- 3. The assistant (branch 1 only) deletes the raw picture the edited one was made from, as the website does: files first, then the row.
set role authenticated;
select pg_temp.act_as(:asst);
select pg_temp.check(public.delete_patient_photo(:nil) = '{"deleted": false, "edited_copies": 0, "visit_unticked": false}'::jsonb,
  'the website''s first question (no picture) answers deleted = false and changes nothing');
select pg_temp.check(pg_temp.rm('clinic-photos', :'p1' || '/raw/2026-10-10_Front_a1390001.jpg', :'p1' || '/raw/thumbs/2026-10-10_Front_a1390001.jpg') = 2,
  'the assistant removes the picture and its small copy in Storage');
select pg_temp.check(pg_temp.rm('clinic-photos', 'inbox/GUL/2026-10-16/IMG_3901.jpg') = 0
                     and pg_temp.rm('xrays', :'p1' || '/2026-10-15_OPG_99999999.png') = 0,
  'but no file that belongs to no picture or X-ray (the raw inbox, a stray X-ray file)');
select pg_temp.check(public.delete_patient_photo(:r1) = '{"deleted": true, "edited_copies": 1, "visit_unticked": false}'::jsonb,
  'then the row: deleted, one edited picture was made from it, and the visit keeps its tick (another picture of it is left)');
select pg_temp.check(public.delete_patient_photo(:r1) = '{"deleted": false, "edited_copies": 0, "visit_unticked": false}'::jsonb,
  'a picture already gone (another tab) answers deleted = false');
reset role;
select pg_temp.check(not exists (select 1 from public.photos where id = :r1)
                     and (select edited_from is null and public_ok from public.photos where id = :e1),
  'the raw picture is gone; the edited picture made from it stays, no longer pointing at it');
select pg_temp.check((select photos_uploaded and status = 'completed' from public.visits where id = :'v1'), 'the visit still shows photos uploaded');
set role authenticated;
select pg_temp.act_as(:asst);
select pg_temp.check(pg_temp.rm('clinic-photos', :'p1' || '/raw/2026-10-10_Left_a2390002.jpg') = 1
                     and public.delete_patient_photo(:r1b) = '{"deleted": true, "edited_copies": 0, "visit_unticked": true}'::jsonb,
  'the visit''s last picture: file and row deleted, and the answer says the visit''s tick came off');
reset role;
select pg_temp.check((select not photos_uploaded and status = 'completed' from public.visits where id = :'v1'),
  'the visit asks for photos again ("photos uploaded" off) and stays completed');
select pg_temp.check((select count(*) from public.audit_log where table_name = 'visits' and row_id = :'v1' and action = 'UPDATE' and actor = :asst::uuid
                       and (old_data ->> 'photos_uploaded')::boolean and not (new_data ->> 'photos_uploaded')::boolean) = 1,
  'the tick coming off is in the audit log, by the assistant');
set role authenticated;
select pg_temp.act_as(:asst);
select pg_temp.check(pg_temp.rm('xrays', :'p1' || '/2026-10-15_OPG_c1390007.png') = 1 and public.delete_patient_xray(:x1) = '{"deleted": true}'::jsonb,
  'the assistant deletes an X-ray: its file in Storage, then the row');
select pg_temp.check(public.delete_patient_xray(:x1) = '{"deleted": false}'::jsonb, 'an X-ray already gone answers deleted = false');
select pg_temp.check(public.delete_patient_xray(:nil) = '{"deleted": false}'::jsonb, 'and the website''s first question (no X-ray) changes nothing');
reset role;
select pg_temp.check(not exists (select 1 from public.xrays where id = :x1) and not exists (select 1 from storage.objects where bucket_id = 'xrays' and name = :'p1' || '/2026-10-15_OPG_c1390007.png'),
  'the X-ray''s row and file are gone');

-- 4. The coordinator deletes the edited picture marked for the website: its gallery copy, its files, then the row.
set role authenticated;
select pg_temp.act_as(:coord);
select pg_temp.check(pg_temp.rm('public-cases', '2026-10-12_Other_12345678.png', '2026-10-11_After_e1390003.png') = 0,
  'the coordinator cannot remove another gallery file, nor a name that only looks like the picture''s copy (another date)');
select pg_temp.check(pg_temp.rm('public-cases', '2026-10-12_After_e1390003.png') = 1, 'she removes the picture''s copy from the website gallery');
select pg_temp.check(pg_temp.rm('clinic-photos', :'p1' || '/edited/2026-10-12_After_e1390003.png', :'p1' || '/edited/thumbs/2026-10-12_After_e1390003.jpg') = 2
                     and public.delete_patient_photo(:e1) = '{"deleted": true, "edited_copies": 0, "visit_unticked": false}'::jsonb,
  'and the picture and its small copy, then the row');
select pg_temp.check(pg_temp.rm('xrays', :'p2' || '/2026-10-15_OPG_c2390008.png') = 1 and public.delete_patient_xray(:x2) = '{"deleted": true}'::jsonb,
  'she deletes an X-ray of a patient registered at a branch she does not work at (patients and X-rays are seen at every branch)');
select pg_temp.act_as(:pat);
select pg_temp.check((select count(*) from public.photos where patient_id = :'p1') = 0, 'the patient no longer sees the edited picture on their page');
reset role;
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'public-cases'
                        and name in ('2026-10-12_After_e1390003.png', '2026-10-12_Other_12345678.png', '2026-10-11_After_e1390003.png')) = 2
                     and not exists (select 1 from storage.objects where bucket_id = 'public-cases' and name = '2026-10-12_After_e1390003.png'),
  'the gallery lost only that copy');

-- 5. The front desk with photos.delete ticked (Dr. Ali could): the pictures it sees, never someone else's raw picture.
select pg_temp.act_as('');
insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (:fd, 'photos.delete', true);
set role authenticated;
select pg_temp.act_as(:fd);
select pg_temp.expect_error(format('select public.delete_patient_photo(%L)', :q2), 'NOT_ALLOWED', 'ticked, the front desk still cannot delete a raw picture someone else took');
select pg_temp.check(pg_temp.rm('clinic-photos', :'p2' || '/raw/2026-10-14_Front_b1390005.jpg') = 0, 'nor remove its file');
select pg_temp.check(pg_temp.rm('clinic-photos', :'p1' || '/raw/2026-10-13_Desk_f1390004.jpg', :'p1' || '/raw/thumbs/2026-10-13_Desk_f1390004.jpg') = 2
                     and (public.delete_patient_photo(:f1) ->> 'deleted')::boolean,
  'it deletes the raw picture it uploaded itself (files, then row)');
select pg_temp.check(pg_temp.rm('clinic-photos', :'p2' || '/edited/2026-10-14_After_e2390006.jpg') = 1 and (public.delete_patient_photo(:e2) ->> 'deleted')::boolean,
  'and an edited picture (which it sees)');
reset role;
select pg_temp.act_as('');
delete from public.staff_permission_overrides where staff_id = :fd and permission_key = 'photos.delete';
set role authenticated;
select pg_temp.act_as(:admin);
select pg_temp.check(pg_temp.rm('clinic-photos', :'p2' || '/raw/2026-10-14_Front_b1390005.jpg') = 1 and (public.delete_patient_photo(:q2) ->> 'deleted')::boolean,
  'Dr. Ali deletes any picture');
reset role;
select pg_temp.check(not exists (select 1 from public.photos where patient_id in (:'p1', :'p2')) and not exists (select 1 from public.xrays where patient_id in (:'p1', :'p2'))
                     and (select count(*) from storage.objects where bucket_id = 'clinic-photos'
                           and (split_part(name, '/', 1) in (:'p1', :'p2') or name = 'inbox/GUL/2026-10-16/IMG_3901.jpg')) = 1
                     and (select count(*) from storage.objects where bucket_id = 'xrays' and split_part(name, '/', 1) in (:'p1', :'p2')) = 1,
  'every picture and X-ray is gone, with its files; the inbox file and the stray X-ray file stay');

-- 6. The audit log: added, changed and deleted, by whom, with the whole row.
select pg_temp.check((select count(*) from public.audit_log where table_name = 'photos' and action = 'INSERT' and row_id in (:r1, :r1b, :e1, :f1, :q2, :e2)) = 6
                     and (select count(*) from public.audit_log where table_name = 'xrays' and action = 'INSERT' and row_id in (:x1, :x2)) = 2,
  'every picture and X-ray added is in the audit log');
select pg_temp.check((select count(*) from public.audit_log where table_name = 'photos' and row_id = :r1 and action = 'DELETE' and actor = :asst::uuid
                       and old_data ->> 'storage_path' = :'p1' || '/raw/2026-10-10_Front_a1390001.jpg'
                       and old_data ->> 'thumb_path' = :'p1' || '/raw/thumbs/2026-10-10_Front_a1390001.jpg'
                       and old_data ->> 'patient_id' = :'p1' and old_data ->> 'visit_id' = :'v1' and old_data ->> 'kind' = 'raw'
                       and old_data ->> 'view_label' = 'Front' and old_data ->> 'uploaded_by' = :asst and new_data is null) = 1,
  'the raw picture''s delete, by the assistant, with the whole row (files, patient, visit, kind, label, who uploaded it)');
select pg_temp.check((select count(*) from public.audit_log where table_name = 'photos' and row_id = :e1 and action = 'UPDATE' and actor = :asst::uuid
                       and old_data ->> 'edited_from' = :r1 and new_data ->> 'edited_from' is null) = 1,
  'the edited picture letting go of the raw one, by the assistant');
select pg_temp.check((select count(*) from public.audit_log where table_name = 'photos' and row_id = :e1 and action = 'DELETE' and actor = :coord::uuid
                       and (old_data ->> 'public_ok')::boolean and old_data ->> 'kind' = 'edited') = 1,
  'the edited picture''s delete, by the coordinator (marked for the website, in the row)');
select pg_temp.check((select count(*) from public.audit_log where table_name = 'xrays' and row_id = :x1 and action = 'DELETE' and actor = :asst::uuid
                       and old_data ->> 'storage_path' = :'p1' || '/2026-10-15_OPG_c1390007.png' and old_data ->> 'kind' = 'OPG'
                       and old_data ->> 'patient_id' = :'p1' and new_data is null) = 1
                     and (select count(*) from public.audit_log where table_name = 'xrays' and row_id = :x2 and action = 'DELETE' and actor = :coord::uuid) = 1,
  'the X-rays'' deletes, by the assistant and the coordinator, with the whole row');
select pg_temp.check((select count(*) from public.audit_log where table_name = 'photos' and action = 'DELETE' and row_id in (:f1, :e2) and actor = :fd::uuid) = 2
                     and (select count(*) from public.audit_log where table_name = 'photos' and action = 'DELETE' and row_id = :q2 and actor = :admin::uuid) = 1,
  'and the front desk''s (ticked) and Dr. Ali''s');
-- A picture and an X-ray saved through the website are in the audit log too, by the person who saved them.
set role authenticated;
select pg_temp.act_as(:asst);
insert into storage.objects (bucket_id, name) values ('xrays', :'p1' || '/2026-10-16_OPG_c3390009.png');
insert into public.xrays (patient_id, kind, storage_path, uploaded_by) values (:'p1', 'Bitewing', :'p1' || '/2026-10-16_OPG_c3390009.png', auth.uid());
insert into public.photos (patient_id, kind, view_label, storage_path) values (:'p1', 'raw', 'Right', :'p1' || '/raw/2026-10-16_Right_a3390010.jpg');
reset role;
select pg_temp.check((select count(*) from public.audit_log where table_name = 'xrays' and action = 'INSERT' and actor = :asst::uuid and new_data ->> 'kind' = 'Bitewing') = 1
                     and (select count(*) from public.audit_log where table_name = 'photos' and action = 'INSERT' and actor = :asst::uuid and new_data ->> 'view_label' = 'Right'
                           and new_data ->> 'uploaded_by' = :asst) = 1,
  'an X-ray and a picture the assistant saves: in the audit log, by her, with the row');
select pg_temp.act_as('');
rollback;
