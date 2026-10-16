-- Delete for pictures and X-rays (20261016000200_photo_xray_delete.sql). Made-up people only.
--   0. the file runs twice: the second run changes no grid cell and writes no audit row; the file policy, triggers and functions are there
--      once each, and no DELETE policy lets anyone delete photo or X-ray rows directly;
--   1. the grid: "Delete clinic photos and X-rays" (photos.delete) for the assistant, the coordinator and Dr. Ali; not the front desk, the
--      doctor or the accountant (owner, 16 Oct 2026: "they can delete assistant and coordinator");
--   2. the front desk, the doctor, the accountant, a switched-off account, a patient login and anonymous visitors delete no picture and no
--      X-ray: not through the functions, not with a direct delete of the rows, not by removing the files in Storage (the front desk not
--      even the picture it uploaded); an assistant removes no file she has not asked for through begin_photo_delete / begin_xray_delete,
--      and her direct delete of a row reaches nothing either (only the functions delete rows);
--   3. the files go with the row they belong to, never another's: a doctor (who sees and changes every raw picture but may not delete)
--      points a picture's small copy at another patient's picture, and the assistant's Delete of it removes its own file and the small
--      copy made from its path (left behind with no name on the row), not the other patient's picture; a picture whose small copy would
--      be another picture's takes only its own file; a row pointed at a small copy, at the raw inbox or at another patient's file takes
--      nothing with it; the row goes only once its files are gone (FILES_LEFT); a request is good for 15 minutes; the assistant (who works
--      at one branch) deletes a raw picture that an edited picture was made from (the edited picture stays and no longer points at it),
--      the visit keeps its "photos uploaded" tick while another picture of it is left and loses it with the visit's last picture (a
--      completed visit stays completed and asks for nothing; a photo month not yet completed asks for photos again); she deletes an X-ray;
--      an X-ray row the front desk pointed at another patient's file takes nothing with it;
--   4. the coordinator deletes an edited picture that may be on the website: its gallery copy comes off the website too (only that copy:
--      not another file in the gallery, not a name that only looks like it, not an older copy made before the picture was saved), a
--      picture saved with a made-up id takes no gallery copy (its saved time is the moment it was saved), and she deletes an X-ray of a
--      patient registered at a branch she does not work at (patients, pictures and X-rays are seen at every branch, and so deleted);
--   5. with photos.delete ticked for the front desk (Dr. Ali could), it deletes the pictures it sees (its own raw ones, edited ones), never
--      a raw picture someone else took or nobody is recorded as taking (row or file); Dr. Ali deletes any;
--   6. the audit log: who asked for which files (with the whole row) before they went, and every picture and X-ray added, changed (the
--      doctor's change, the edited picture letting go of the raw one) and deleted, by whom, with the whole row; a picture or X-ray
--      already gone answers deleted = false.
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
\set g1   '''a4390011-0000-4000-8000-000000003911'''
\set w1   '''a5390012-0000-4000-8000-000000003912'''
\set k1   '''a6390013-0000-4000-8000-000000003913'''
\set n1   '''a8390015-0000-4000-8000-000000003915'''
\set c3   '''e1390003-0000-4000-8000-0000000039ff'''
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
-- The files list begin_* answers: [{bucket, name}] from (bucket, name) pairs.
create or replace function pg_temp.files(variadic p text[]) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('bucket', p[i], 'name', p[i + 1]) order by i), '[]'::jsonb)
    from generate_series(1, coalesce(array_length(p, 1), 0), 2) as i $$;
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
select pg_temp.check((select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'photo deleters remove the files they asked for') = 1
                     and not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('photos', 'xrays') and cmd in ('DELETE', 'ALL')),
  'the file policy is there once, and no policy deletes photo or X-ray rows directly (only the functions do)');
select pg_temp.check((select count(*) from pg_trigger where not tgisinternal and tgname in ('photos_audit', 'xrays_audit')) = 2
                     and (select count(*) from pg_trigger where not tgisinternal and tgname = 'photos_guard') = 1,
  'the two audit triggers are there once each, and the photo guard once');
select pg_temp.check(not has_function_privilege('anon', 'public.begin_photo_delete(uuid)', 'execute')
                     and has_function_privilege('authenticated', 'public.begin_photo_delete(uuid)', 'execute')
                     and not has_function_privilege('anon', 'public.delete_patient_photo(uuid)', 'execute')
                     and has_function_privilege('authenticated', 'public.delete_patient_photo(uuid)', 'execute')
                     and not has_function_privilege('anon', 'public.begin_xray_delete(uuid)', 'execute')
                     and has_function_privilege('authenticated', 'public.begin_xray_delete(uuid)', 'execute')
                     and not has_function_privilege('anon', 'public.delete_patient_xray(uuid)', 'execute')
                     and has_function_privilege('authenticated', 'public.delete_patient_xray(uuid)', 'execute')
                     and not has_function_privilege('anon', 'public.photo_file_removable(text, text)', 'execute')
                     and not has_function_privilege('authenticated', 'private.photo_files(public.photos)', 'execute')
                     and not has_function_privilege('authenticated', 'private.xray_files(public.xrays)', 'execute'),
  'the delete functions are for signed-in users only; the helpers that name the files are not reachable');

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

-- A completed visit of p1 with two raw pictures (its "photos uploaded" tick comes from them) and a photo month of p1 still waiting, with
-- one picture; an edited picture made from the first raw one (marked for the website, saved two days ago, its copy put in the gallery a
-- day ago); a raw picture the front desk uploaded; a raw picture whose file has the same name as the first raw one but another ending
-- (so the small copy made from its path is the first one's); two spare rows; a raw and an edited picture of p2; an X-ray of each
-- patient; their files as Storage keeps them, and files that belong to none of them.
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label) values (:'p1', 1, '2026-10-10', 'completed', 'Checkup');
select id as v1 from public.visits where patient_id = :'p1' and visit_date = '2026-10-10' \gset
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, photo_required) values (:'p1', 1, '2026-10-16', 'waiting', 'Braces', true);
select id as v2 from public.visits where patient_id = :'p1' and visit_date = '2026-10-16' \gset
insert into public.photos (id, patient_id, visit_id, branch_id, taken_on, kind, view_label, storage_path, thumb_path, uploaded_by) values
  (:r1, :'p1', :'v1', 1, '2026-10-10', 'raw', 'Front', :'p1' || '/raw/2026-10-10_Front_a1390001.jpg', :'p1' || '/raw/thumbs/2026-10-10_Front_a1390001.jpg', :asst),
  (:r1b, :'p1', :'v1', 1, '2026-10-10', 'raw', 'Left', :'p1' || '/raw/2026-10-10_Left_a2390002.jpg', null, :asst),
  (:w1, :'p1', :'v2', 1, '2026-10-16', 'raw', 'Front', :'p1' || '/raw/2026-10-16_Front_a5390012.jpg', null, :asst),
  (:f1, :'p1', null, 1, '2026-10-13', 'raw', 'Desk', :'p1' || '/raw/2026-10-13_Desk_f1390004.jpg', :'p1' || '/raw/thumbs/2026-10-13_Desk_f1390004.jpg', :fd),
  (:g1, :'p1', null, 1, '2026-10-10', 'raw', 'Front', :'p1' || '/raw/2026-10-10_Front_a1390001.png', null, :asst),
  (:k1, :'p1', null, 1, '2026-10-11', 'raw', 'Spare', :'p1' || '/raw/2026-10-11_Spare_a6390013.jpg', null, :asst),
  (:n1, :'p1', null, 1, '2026-10-11', 'raw', 'Unknown', :'p1' || '/raw/2026-10-11_Unknown_a8390015.jpg', null, null),
  (:q2, :'p2', null, 4, '2026-10-14', 'raw', 'Front', :'p2' || '/raw/2026-10-14_Front_b1390005.jpg', null, :asst),
  (:e2, :'p2', null, 4, '2026-10-14', 'edited', 'After', :'p2' || '/edited/2026-10-14_After_e2390006.jpg', null, :asst);
insert into public.photos (id, patient_id, taken_on, kind, view_label, storage_path, thumb_path, edited_from, public_ok, uploaded_by, created_at) values
  (:e1, :'p1', '2026-10-12', 'edited', 'After', :'p1' || '/edited/2026-10-12_After_e1390003.png', :'p1' || '/edited/thumbs/2026-10-12_After_e1390003.jpg', :r1, true, :asst, now() - interval '2 days');
insert into public.xrays (id, patient_id, kind, taken_on, storage_path, uploaded_by) values
  (:x1, :'p1', 'OPG', '2026-10-15', :'p1' || '/2026-10-15_OPG_c1390007.png', :asst),
  (:x2, :'p2', 'OPG', '2026-10-15', :'p2' || '/2026-10-15_OPG_c2390008.png', :asst);
insert into storage.objects (bucket_id, name) values
  ('clinic-photos', :'p1' || '/raw/2026-10-10_Front_a1390001.jpg'), ('clinic-photos', :'p1' || '/raw/thumbs/2026-10-10_Front_a1390001.jpg'),
  ('clinic-photos', :'p1' || '/raw/2026-10-10_Left_a2390002.jpg'), ('clinic-photos', :'p1' || '/raw/thumbs/2026-10-10_Left_a2390002.jpg'),
  ('clinic-photos', :'p1' || '/raw/2026-10-16_Front_a5390012.jpg'),
  ('clinic-photos', :'p1' || '/raw/2026-10-13_Desk_f1390004.jpg'), ('clinic-photos', :'p1' || '/raw/thumbs/2026-10-13_Desk_f1390004.jpg'),
  ('clinic-photos', :'p1' || '/raw/2026-10-10_Front_a1390001.png'),
  ('clinic-photos', :'p1' || '/raw/2026-10-11_Unknown_a8390015.jpg'),
  ('clinic-photos', :'p2' || '/raw/2026-10-14_Front_b1390005.jpg'), ('clinic-photos', :'p2' || '/edited/2026-10-14_After_e2390006.jpg'),
  ('clinic-photos', :'p1' || '/edited/2026-10-12_After_e1390003.png'), ('clinic-photos', :'p1' || '/edited/thumbs/2026-10-12_After_e1390003.jpg'),
  ('clinic-photos', 'inbox/GUL/2026-10-16/IMG_3901.jpg'), ('clinic-photos', :'p1' || '/raw/2026-10-09_Lost_a7390014.jpg'),
  ('xrays', :'p1' || '/2026-10-15_OPG_c1390007.png'), ('xrays', :'p2' || '/2026-10-15_OPG_c2390008.png'), ('xrays', :'p1' || '/2026-10-15_OPG_99999999.png'),
  ('public-cases', '2026-10-12_Other_12345678.png'), ('public-cases', '2026-10-11_After_e1390003.png');
insert into storage.objects (bucket_id, name, created_at) values
  ('public-cases', '2026-10-12_After_e1390003.png', now() - interval '1 day'), ('public-cases', '2026-10-12_Old_e1390003.png', now() - interval '3 days');
select pg_temp.check((select photos_uploaded from public.visits where id = :'v1') and (select photos_uploaded from public.visits where id = :'v2'),
  'the visits'' "photos uploaded" is ticked by their pictures');

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
create or replace function pg_temp.file_there(p_bucket text, p_name text) returns boolean language sql as $$
  select exists (select 1 from storage.objects where bucket_id = p_bucket and name = p_name) $$;

-- 2. Who may not delete: the functions refuse them, and their direct deletes of rows and files reach nothing.
set role authenticated;
select pg_temp.act_as(:fd);
select pg_temp.expect_error(format('select public.begin_photo_delete(%L)', :f1), 'NOT_ALLOWED', 'the front desk cannot delete a picture, not even the one it uploaded');
select pg_temp.expect_error(format('select public.delete_patient_photo(%L)', :f1), 'NOT_ALLOWED', 'not at any step');
select pg_temp.expect_error(format('select public.begin_xray_delete(%L)', :x1), 'NOT_ALLOWED', 'nor an X-ray');
select pg_temp.expect_error(format('select public.delete_patient_xray(%L)', :x1), 'NOT_ALLOWED', 'at any step');
select pg_temp.expect_error(format('select public.begin_photo_delete(%L)', :nil), 'NOT_ALLOWED', 'it is refused before any row is looked at');
select pg_temp.check(pg_temp.del('photos', :f1) + pg_temp.del('photos', :e1) + pg_temp.del('xrays', :x1) = 0,
  'its direct deletes of photo and X-ray rows reach nothing');
select pg_temp.check(pg_temp.rm('clinic-photos', :'p1' || '/raw/2026-10-13_Desk_f1390004.jpg', :'p1' || '/raw/thumbs/2026-10-13_Desk_f1390004.jpg',
                                :'p1' || '/edited/2026-10-12_After_e1390003.png') = 0
                     and pg_temp.rm('xrays', :'p1' || '/2026-10-15_OPG_c1390007.png') = 0
                     and pg_temp.rm('public-cases', '2026-10-12_After_e1390003.png') = 0,
  'and it removes no file in Storage: not its own picture, an edited one, an X-ray or a gallery copy');
select pg_temp.act_as(:doc);
select pg_temp.expect_error(format('select public.begin_photo_delete(%L)', :r1b), 'NOT_ALLOWED', 'a doctor cannot delete a picture');
select pg_temp.expect_error(format('select public.delete_patient_photo(%L)', :r1b), 'NOT_ALLOWED', 'at any step');
select pg_temp.expect_error(format('select public.begin_xray_delete(%L)', :x1), 'NOT_ALLOWED', 'nor an X-ray');
select pg_temp.check(pg_temp.del('photos', :r1b) + pg_temp.del('xrays', :x1) = 0
                     and pg_temp.rm('clinic-photos', :'p1' || '/raw/2026-10-10_Left_a2390002.jpg') + pg_temp.rm('xrays', :'p1' || '/2026-10-15_OPG_c1390007.png') = 0,
  'nor directly, rows or files (a doctor sees them all)');
select pg_temp.act_as(:acct);
select pg_temp.expect_error(format('select public.begin_photo_delete(%L)', :e1), 'NOT_ALLOWED', 'an accountant cannot delete a picture');
select pg_temp.expect_error(format('select public.begin_xray_delete(%L)', :x1), 'NOT_ALLOWED', 'nor an X-ray');
select pg_temp.check(pg_temp.del('photos', :e1) + pg_temp.rm('clinic-photos', :'p1' || '/edited/2026-10-12_After_e1390003.png') + pg_temp.rm('public-cases', '2026-10-12_After_e1390003.png') = 0,
  'nor directly');
select pg_temp.act_as(:off);
select pg_temp.expect_error(format('select public.begin_photo_delete(%L)', :r1b), 'NOT_ALLOWED', 'a switched-off assistant cannot delete a picture');
select pg_temp.check(pg_temp.rm('clinic-photos', :'p1' || '/raw/2026-10-10_Left_a2390002.jpg') = 0, 'nor remove its file');
select pg_temp.act_as(:pat);
select pg_temp.expect_error(format('select public.begin_photo_delete(%L)', :e1), 'NOT_ALLOWED', 'a patient cannot delete a picture of their own');
select pg_temp.expect_error(format('select public.delete_patient_xray(%L)', :x1), 'NOT_ALLOWED', 'nor an X-ray of their own');
select pg_temp.check(pg_temp.del('photos', :e1) + pg_temp.del('xrays', :x1) = 0
                     and pg_temp.rm('clinic-photos', :'p1' || '/edited/2026-10-12_After_e1390003.png') + pg_temp.rm('xrays', :'p1' || '/2026-10-15_OPG_c1390007.png') = 0,
  'nor directly (the patient reads them)');
select pg_temp.act_as(:asst);
select pg_temp.check(pg_temp.del('photos', :r1b) + pg_temp.del('xrays', :x1) = 0,
  'an assistant''s direct delete of a row reaches nothing either: rows are deleted only through the functions');
select pg_temp.check(pg_temp.rm('clinic-photos', :'p1' || '/raw/2026-10-10_Front_a1390001.jpg', :'p1' || '/raw/thumbs/2026-10-10_Front_a1390001.jpg') = 0
                     and pg_temp.rm('xrays', :'p1' || '/2026-10-15_OPG_c1390007.png') = 0
                     and pg_temp.rm('public-cases', '2026-10-12_After_e1390003.png') = 0,
  'and she removes no file she has not asked for (the audit log would not know who took it): not a picture, an X-ray or a gallery copy');
reset role;
select pg_temp.act_as('');
set role anon;
select pg_temp.expect_error(format('select public.begin_photo_delete(%L)', :e1), 'permission denied', 'an anonymous visitor cannot call the picture functions');
select pg_temp.expect_error(format('select public.delete_patient_photo(%L)', :e1), 'permission denied', 'either of them');
select pg_temp.expect_error(format('select public.begin_xray_delete(%L)', :x1), 'permission denied', 'nor the X-ray functions');
select pg_temp.check(pg_temp.rm('clinic-photos', :'p1' || '/edited/2026-10-12_After_e1390003.png') + pg_temp.rm('public-cases', '2026-10-12_After_e1390003.png') = 0,
  'nor remove files');
reset role;
select pg_temp.check(pg_temp.nothing_gone(), 'after all that, every picture, X-ray and file is still there');

-- 3. The files go with their own row. A doctor (photos.upload and photos.view_raw: sees and changes every raw picture, may not delete)
-- points the second raw picture's small copy at p2's picture.
set role authenticated;
select pg_temp.act_as(:doc);
update public.photos set thumb_path = :'p2' || '/raw/2026-10-14_Front_b1390005.jpg' where id = :r1b;
-- ... and the spare row's file at the first raw picture's small copy.
update public.photos set storage_path = :'p1' || '/raw/thumbs/2026-10-10_Front_a1390001.jpg' where id = :k1;
select pg_temp.act_as(:asst);
select pg_temp.check(public.begin_photo_delete(:r1b) = jsonb_build_object('found', true, 'files',
                       pg_temp.files('clinic-photos', :'p1' || '/raw/2026-10-10_Left_a2390002.jpg', 'clinic-photos', :'p1' || '/raw/thumbs/2026-10-10_Left_a2390002.jpg')),
  'the assistant asks to delete it: its own file and the small copy made from its path (the row names none: it was left behind), not the p2 picture its row now names');
select pg_temp.check(pg_temp.rm('clinic-photos', :'p2' || '/raw/2026-10-14_Front_b1390005.jpg') = 0,
  'so she cannot remove p2''s picture (she may delete it, but did not ask for it)');
select pg_temp.check(pg_temp.rm('clinic-photos', :'p1' || '/raw/2026-10-10_Left_a2390002.jpg', :'p1' || '/raw/thumbs/2026-10-10_Left_a2390002.jpg') = 2,
  'she removes the picture and its forgotten small copy');
select pg_temp.check(public.delete_patient_photo(:r1b) = '{"deleted": true, "edited_copies": 0, "visit_unticked": false, "visit_asks_photos": false}'::jsonb,
  'then the row: deleted, and the visit keeps its tick (another picture of it is left)');
select pg_temp.check(pg_temp.file_there('clinic-photos', :'p2' || '/raw/2026-10-14_Front_b1390005.jpg'), 'p2''s picture is still there');
select pg_temp.check(public.begin_photo_delete(:k1) = '{"found": true, "files": []}'::jsonb
                     and pg_temp.rm('clinic-photos', :'p1' || '/raw/thumbs/2026-10-10_Front_a1390001.jpg') = 0
                     and (public.delete_patient_photo(:k1) ->> 'deleted')::boolean
                     and pg_temp.file_there('clinic-photos', :'p1' || '/raw/thumbs/2026-10-10_Front_a1390001.jpg'),
  'the spare row pointed at a small copy takes no file with it (it is no picture''s file, and another picture names it): the row goes, the small copy stays');
select pg_temp.check(public.begin_photo_delete(:g1) -> 'files' = pg_temp.files('clinic-photos', :'p1' || '/raw/2026-10-10_Front_a1390001.png'),
  'a picture whose small copy would be another picture''s (same name, other ending) asks only for its own file');
select pg_temp.expect_error(format('select public.delete_patient_photo(%L)', :g1), 'FILES_LEFT', 'its row does not go while its file is still stored');
select pg_temp.check(pg_temp.rm('clinic-photos', :'p1' || '/raw/2026-10-10_Front_a1390001.png', :'p1' || '/raw/thumbs/2026-10-10_Front_a1390001.jpg') = 1
                     and (public.delete_patient_photo(:g1) ->> 'deleted')::boolean,
  'once the file is gone the row goes (the other picture''s small copy could not be removed with it)');
-- A row she points at the raw inbox, or at another patient's file nobody has saved a row for, takes nothing with it.
insert into public.photos (patient_id, kind, view_label, storage_path) values (:'p2', 'raw', 'Inbox', 'inbox/GUL/2026-10-16/IMG_3901.jpg');
insert into public.photos (patient_id, kind, view_label, storage_path) values (:'p2', 'raw', 'Lost', :'p1' || '/raw/2026-10-09_Lost_a7390014.jpg');
select id as c1 from public.photos where storage_path = 'inbox/GUL/2026-10-16/IMG_3901.jpg' \gset
select id as c2 from public.photos where storage_path = :'p1' || '/raw/2026-10-09_Lost_a7390014.jpg' \gset
select pg_temp.check(public.begin_photo_delete(:'c1') -> 'files' = '[]'::jsonb and public.begin_photo_delete(:'c2') -> 'files' = '[]'::jsonb
                     and pg_temp.rm('clinic-photos', 'inbox/GUL/2026-10-16/IMG_3901.jpg', :'p1' || '/raw/2026-10-09_Lost_a7390014.jpg') = 0
                     and (public.delete_patient_photo(:'c1') ->> 'deleted')::boolean and (public.delete_patient_photo(:'c2') ->> 'deleted')::boolean,
  'rows pointed at the raw inbox and at another patient''s file take nothing with them: the rows go, the files stay');
-- The raw picture the edited one was made from.
select pg_temp.check(public.begin_photo_delete(:r1) -> 'files'
                       = pg_temp.files('clinic-photos', :'p1' || '/raw/2026-10-10_Front_a1390001.jpg', 'clinic-photos', :'p1' || '/raw/thumbs/2026-10-10_Front_a1390001.jpg'),
  'the first raw picture: its file and its small copy');
select pg_temp.check(pg_temp.rm('clinic-photos', :'p1' || '/raw/2026-10-10_Front_a1390001.jpg', :'p1' || '/raw/thumbs/2026-10-10_Front_a1390001.jpg') = 2,
  'she removes them');
select pg_temp.check(pg_temp.rm('clinic-photos', 'inbox/GUL/2026-10-16/IMG_3901.jpg') = 0 and pg_temp.rm('xrays', :'p1' || '/2026-10-15_OPG_99999999.png') = 0,
  'but no file that belongs to no picture or X-ray (the raw inbox, a stray X-ray file)');
select pg_temp.check(public.delete_patient_photo(:r1) = '{"deleted": true, "edited_copies": 1, "visit_unticked": true, "visit_asks_photos": false}'::jsonb,
  'then the row: deleted, one edited picture was made from it; it was the visit''s last picture, but a completed visit asks for nothing');
select pg_temp.check(public.delete_patient_photo(:r1) = '{"deleted": false, "edited_copies": 0, "visit_unticked": false, "visit_asks_photos": false}'::jsonb
                     and public.begin_photo_delete(:r1) = '{"found": false, "files": []}'::jsonb,
  'a picture already gone (another tab) answers deleted = false, found = false');
reset role;
select pg_temp.check(not exists (select 1 from public.photos where id = :r1)
                     and (select edited_from is null and public_ok from public.photos where id = :e1),
  'the raw picture is gone; the edited picture made from it stays, no longer pointing at it');
select pg_temp.check((select not photos_uploaded and status = 'completed' from public.visits where id = :'v1'),
  'the visit no longer shows photos uploaded, and stays completed');
select pg_temp.check((select count(*) from public.audit_log where table_name = 'visits' and row_id = :'v1' and action = 'UPDATE' and actor = :asst::uuid
                       and (old_data ->> 'photos_uploaded')::boolean and not (new_data ->> 'photos_uploaded')::boolean) = 1,
  'the tick coming off is in the audit log, by the assistant');
-- A request is good for 15 minutes.
set role authenticated;
select pg_temp.act_as(:asst);
select pg_temp.check(public.begin_photo_delete(:w1) -> 'files' = pg_temp.files('clinic-photos', :'p1' || '/raw/2026-10-16_Front_a5390012.jpg', 'clinic-photos', :'p1' || '/raw/thumbs/2026-10-16_Front_a5390012.jpg'),
  'the photo month''s only picture: its file (and the small copy made from its path)');
reset role;
update public.audit_log set at = at - interval '20 minutes' where action = 'DELETE_FILES' and row_id = :w1;
set role authenticated;
select pg_temp.act_as(:asst);
select pg_temp.check(pg_temp.rm('clinic-photos', :'p1' || '/raw/2026-10-16_Front_a5390012.jpg') = 0, 'asked more than 15 minutes ago: the file cannot be removed');
select pg_temp.check((public.begin_photo_delete(:w1) ->> 'found')::boolean and pg_temp.rm('clinic-photos', :'p1' || '/raw/2026-10-16_Front_a5390012.jpg') = 1,
  'asked again, it can');
select pg_temp.check(public.delete_patient_photo(:w1) = '{"deleted": true, "edited_copies": 0, "visit_unticked": true, "visit_asks_photos": true}'::jsonb,
  'the row goes, and the answer says the photo month (not completed) asks for photos again');
reset role;
select pg_temp.check((select not photos_uploaded and status = 'waiting' from public.visits where id = :'v2'), 'the photo month shows no photos uploaded');
-- X-rays.
set role authenticated;
select pg_temp.act_as(:asst);
select pg_temp.check(public.begin_xray_delete(:x1) = jsonb_build_object('found', true, 'files', pg_temp.files('xrays', :'p1' || '/2026-10-15_OPG_c1390007.png')),
  'the assistant asks to delete an X-ray: its file');
select pg_temp.expect_error(format('select public.delete_patient_xray(%L)', :x1), 'FILES_LEFT', 'its row does not go while the file is still stored');
select pg_temp.check(pg_temp.rm('xrays', :'p1' || '/2026-10-15_OPG_c1390007.png') = 1 and public.delete_patient_xray(:x1) = '{"deleted": true}'::jsonb,
  'she removes the file, then the row goes');
select pg_temp.check(public.delete_patient_xray(:x1) = '{"deleted": false}'::jsonb and public.begin_xray_delete(:nil) = '{"found": false, "files": []}'::jsonb,
  'an X-ray already gone answers deleted = false; no X-ray, found = false');
-- An X-ray row the front desk saves for p2 with p1's stray file takes nothing with it.
select pg_temp.act_as(:fd);
insert into public.xrays (patient_id, kind, storage_path, uploaded_by) values (:'p2', 'OPG', :'p1' || '/2026-10-15_OPG_99999999.png', auth.uid());
select id as x3 from public.xrays where storage_path = :'p1' || '/2026-10-15_OPG_99999999.png' \gset
select pg_temp.act_as(:asst);
select pg_temp.check(public.begin_xray_delete(:'x3') -> 'files' = '[]'::jsonb and pg_temp.rm('xrays', :'p1' || '/2026-10-15_OPG_99999999.png') = 0
                     and public.delete_patient_xray(:'x3') = '{"deleted": true}'::jsonb,
  'an X-ray row pointed at another patient''s file takes nothing with it: the row goes, the file stays');
reset role;
select pg_temp.check(not exists (select 1 from public.xrays where id = :x1) and not pg_temp.file_there('xrays', :'p1' || '/2026-10-15_OPG_c1390007.png')
                     and pg_temp.file_there('xrays', :'p1' || '/2026-10-15_OPG_99999999.png'),
  'the X-ray''s row and file are gone; the stray file stays');

-- 4. The website gallery. A picture saved with a made-up id (the edited picture's first 8 characters, its date) and a made-up saved time.
set role authenticated;
select pg_temp.act_as(:asst);
insert into public.photos (id, patient_id, taken_on, kind, view_label, storage_path, public_ok, created_at)
  values (:c3, :'p2', '2026-10-12', 'edited', 'After', :'p2' || '/edited/2026-10-12_After_e1390003.png', true, '2026-01-01');
reset role;
select pg_temp.check((select created_at = now() from public.photos where id = :c3), 'its saved time is the moment it was saved, not the one it gave');
set role authenticated;
select pg_temp.act_as(:asst);
select pg_temp.check(not (public.begin_photo_delete(:c3) -> 'files' @> jsonb_build_array(jsonb_build_object('bucket', 'public-cases', 'name', '2026-10-12_After_e1390003.png')))
                     and pg_temp.rm('public-cases', '2026-10-12_After_e1390003.png') = 0
                     and (public.delete_patient_photo(:c3) ->> 'deleted')::boolean,
  'so it takes no gallery copy (the copy was put there before it was saved): it goes, the copy stays');
-- The coordinator deletes the edited picture marked for the website: its gallery copy, its files, then the row.
select pg_temp.act_as(:coord);
select pg_temp.check(public.begin_photo_delete(:e1) -> 'files'
                       = pg_temp.files('clinic-photos', :'p1' || '/edited/2026-10-12_After_e1390003.png', 'clinic-photos', :'p1' || '/edited/thumbs/2026-10-12_After_e1390003.jpg',
                                       'public-cases', '2026-10-12_After_e1390003.png'),
  'the coordinator asks to delete the edited picture: its file, its small copy and its copy in the gallery (not the older copy made before it was saved)');
select pg_temp.check(pg_temp.rm('public-cases', '2026-10-12_Other_12345678.png', '2026-10-11_After_e1390003.png', '2026-10-12_Old_e1390003.png') = 0,
  'she cannot remove another gallery file, nor a name that only looks like the picture''s copy (another date, made before it)');
select pg_temp.check(pg_temp.rm('public-cases', '2026-10-12_After_e1390003.png') = 1, 'she removes the picture''s copy from the website gallery');
select pg_temp.check(pg_temp.rm('clinic-photos', :'p1' || '/edited/2026-10-12_After_e1390003.png', :'p1' || '/edited/thumbs/2026-10-12_After_e1390003.jpg') = 2
                     and public.delete_patient_photo(:e1) = '{"deleted": true, "edited_copies": 0, "visit_unticked": false, "visit_asks_photos": false}'::jsonb,
  'and the picture and its small copy, then the row');
select pg_temp.check((public.begin_xray_delete(:x2) ->> 'found')::boolean and pg_temp.rm('xrays', :'p2' || '/2026-10-15_OPG_c2390008.png') = 1
                     and public.delete_patient_xray(:x2) = '{"deleted": true}'::jsonb,
  'she deletes an X-ray of a patient registered at a branch she does not work at (patients and X-rays are seen at every branch)');
select pg_temp.act_as(:pat);
select pg_temp.check((select count(*) from public.photos where patient_id = :'p1' and kind = 'edited') = 0, 'the patient no longer sees the edited picture on their page');
reset role;
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'public-cases'
                        and name in ('2026-10-12_Other_12345678.png', '2026-10-11_After_e1390003.png', '2026-10-12_Old_e1390003.png')) = 3
                     and not pg_temp.file_there('public-cases', '2026-10-12_After_e1390003.png'),
  'the gallery lost only that copy');

-- 5. The front desk with photos.delete ticked (Dr. Ali could): the pictures it sees, never someone else's raw picture.
select pg_temp.act_as('');
insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (:fd, 'photos.delete', true);
set role authenticated;
select pg_temp.act_as(:fd);
select pg_temp.expect_error(format('select public.begin_photo_delete(%L)', :q2), 'NOT_ALLOWED', 'ticked, the front desk still cannot delete a raw picture someone else took');
select pg_temp.expect_error(format('select public.delete_patient_photo(%L)', :q2), 'NOT_ALLOWED', 'at any step');
select pg_temp.expect_error(format('select public.begin_photo_delete(%L)', :n1), 'NOT_ALLOWED', 'nor one nobody is recorded as taking');
select pg_temp.expect_error(format('select public.delete_patient_photo(%L)', :n1), 'NOT_ALLOWED', 'at any step');
select pg_temp.check(pg_temp.rm('clinic-photos', :'p2' || '/raw/2026-10-14_Front_b1390005.jpg', :'p1' || '/raw/2026-10-11_Unknown_a8390015.jpg') = 0, 'nor remove their files');
select pg_temp.check((public.begin_photo_delete(:f1) ->> 'found')::boolean
                     and pg_temp.rm('clinic-photos', :'p1' || '/raw/2026-10-13_Desk_f1390004.jpg', :'p1' || '/raw/thumbs/2026-10-13_Desk_f1390004.jpg') = 2
                     and (public.delete_patient_photo(:f1) ->> 'deleted')::boolean,
  'it deletes the raw picture it uploaded itself (files, then row)');
select pg_temp.check((public.begin_photo_delete(:e2) ->> 'found')::boolean and pg_temp.rm('clinic-photos', :'p2' || '/edited/2026-10-14_After_e2390006.jpg') = 1
                     and (public.delete_patient_photo(:e2) ->> 'deleted')::boolean,
  'and an edited picture (which it sees)');
reset role;
select pg_temp.act_as('');
delete from public.staff_permission_overrides where staff_id = :fd and permission_key = 'photos.delete';
set role authenticated;
select pg_temp.act_as(:admin);
select pg_temp.check((public.begin_photo_delete(:q2) ->> 'found')::boolean and pg_temp.rm('clinic-photos', :'p2' || '/raw/2026-10-14_Front_b1390005.jpg') = 1
                     and (public.delete_patient_photo(:q2) ->> 'deleted')::boolean
                     and (public.begin_photo_delete(:n1) ->> 'found')::boolean and pg_temp.rm('clinic-photos', :'p1' || '/raw/2026-10-11_Unknown_a8390015.jpg') = 1
                     and (public.delete_patient_photo(:n1) ->> 'deleted')::boolean,
  'Dr. Ali deletes any picture');
reset role;
select pg_temp.check(not exists (select 1 from public.photos where patient_id in (:'p1', :'p2')) and not exists (select 1 from public.xrays where patient_id in (:'p1', :'p2'))
                     and (select string_agg(name, ',' order by name) from storage.objects where bucket_id = 'clinic-photos'
                           and (split_part(name, '/', 1) in (:'p1', :'p2') or name = 'inbox/GUL/2026-10-16/IMG_3901.jpg'))
                         = :'p1' || '/raw/2026-10-09_Lost_a7390014.jpg,inbox/GUL/2026-10-16/IMG_3901.jpg'
                     and (select count(*) from storage.objects where bucket_id = 'xrays' and split_part(name, '/', 1) in (:'p1', :'p2')) = 1,
  'every picture and X-ray is gone, with its files; the inbox file, the file nobody saved a row for and the stray X-ray file stay');

-- 6. The audit log: who asked for which files before they went, and added, changed and deleted, by whom, with the whole row.
select pg_temp.check((select count(*) from public.audit_log where table_name = 'photos' and row_id = :r1 and action = 'DELETE_FILES' and actor = :asst::uuid
                       and old_data ->> 'storage_path' = :'p1' || '/raw/2026-10-10_Front_a1390001.jpg' and old_data ->> 'patient_id' = :'p1'
                       and new_data -> 'files' = pg_temp.files('clinic-photos', :'p1' || '/raw/2026-10-10_Front_a1390001.jpg', 'clinic-photos', :'p1' || '/raw/thumbs/2026-10-10_Front_a1390001.jpg')) = 1
                     and (select count(*) from public.audit_log where table_name = 'xrays' and row_id = :x1 and action = 'DELETE_FILES' and actor = :asst::uuid
                           and old_data ->> 'kind' = 'OPG' and new_data -> 'files' = pg_temp.files('xrays', :'p1' || '/2026-10-15_OPG_c1390007.png')) = 1
                     and (select count(*) from public.audit_log where table_name = 'photos' and row_id = :e1 and action = 'DELETE_FILES' and actor = :coord::uuid
                           and new_data -> 'files' @> pg_temp.files('public-cases', '2026-10-12_After_e1390003.png')) = 1,
  'every file request is in the audit log before the files went: by whom, the whole row and the files');
select pg_temp.check(not exists (select 1 from public.audit_log where action = 'DELETE_FILES' and row_id = :k1),
  'a row that takes no file with it writes no file request');
select pg_temp.check((select count(*) from public.audit_log where table_name = 'photos' and action = 'INSERT' and row_id in (:r1, :r1b, :e1, :f1, :q2, :e2)) = 6
                     and (select count(*) from public.audit_log where table_name = 'xrays' and action = 'INSERT' and row_id in (:x1, :x2)) = 2,
  'every picture and X-ray added is in the audit log');
select pg_temp.check((select count(*) from public.audit_log where table_name = 'photos' and row_id = :r1b and action = 'UPDATE' and actor = :doc::uuid
                       and old_data ->> 'thumb_path' is null and new_data ->> 'thumb_path' = :'p2' || '/raw/2026-10-14_Front_b1390005.jpg') = 1,
  'the doctor pointing the small copy elsewhere is in the audit log, by the doctor');
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
                     and (select count(*) from public.audit_log where table_name = 'photos' and action = 'DELETE' and row_id in (:q2, :n1) and actor = :admin::uuid) = 2,
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
