-- The Photo inbox (20261017000200_photo_intake.sql). Made-up people only.
--   0. the file runs twice: the second run changes no grid cell and writes no audit row; policies and triggers are there once;
--   1. the grid: "Use the Photo inbox" (photos.intake) for the assistant, the coordinator and Dr. Ali only, a cell for every role;
--   2. the front desk, the doctor, the accountant, a patient and anonymous visitors use no Photo inbox function (the badge answers zeros,
--      the city list is empty); an assistant who works at a Karachi branch uses Karachi, not Lahore;
--   3. uploads: the front desk cannot store into inbox/, the assistant can (only in her city); photos are registered only at the exact path
--      made from city, day and hash, with the size given, the day its camera time says; the same photo twice is one photo;
--   4. matching: a plan that does not cover today's regroupable photos is refused; a regrouped set keeps its id; an automatic filing is
--      checked again (not a photo month, another city, a visit with photos, photos 3 hours after the start: all refused, SERVER_CHECK) and
--      the right one files: raw rows in the patient's file, the visit's "photos uploaded" ticked, PHOTO_FILED in the audit log;
--   5. one tap: an old screen is refused (PHOTO_STALE); split, set aside and put back; search a patient with no visit;
--   6. the edited copy: saved before filing (no row), after filing (the edited row with its window and held back while hidden or flagged);
--      the patient sees it only after its window and not while held back (rows and files); the front desk reads a filed edited copy but
--      not an unfiled one or an original;
--   7. move, undo, take out: need "Delete clinic photos and X-rays"; rows follow, visits ticked and unticked; the photos are kept;
--   8. Claude's answers are written only by the service role (cost logged, mixed people flagged and held back); costs for Dr. Ali and
--      accounts only; the library shows edited photos to the front desk and originals only to raw viewers; the profile's Delete of an
--      inbox photo removes the row and names no file.
\set ON_ERROR_STOP 1
\set admin  '''00000000-0000-0000-0000-000000004000'''
\set fd     '''00000000-0000-0000-0000-000000004001'''
\set asst   '''00000000-0000-0000-0000-000000004002'''
\set doc    '''00000000-0000-0000-0000-000000004003'''
\set coord  '''00000000-0000-0000-0000-000000004004'''
\set acct   '''00000000-0000-0000-0000-000000004005'''
\set pat    '''00000000-0000-0000-0000-000000004006'''
\set asst2  '''00000000-0000-0000-0000-000000004007'''

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
-- A file stored as the signed-in person (Storage's rules decide), with its size as Storage records it.
create or replace function pg_temp.obj(p_name text, p_size int default 100) returns void language sql as $$
  insert into storage.objects (bucket_id, name, owner, metadata) values ('clinic-photos', p_name, auth.uid(), jsonb_build_object('size', p_size)) $$;
create or replace function pg_temp.path(p_sha text, p_day date) returns text language sql as $$
  select 'inbox/karachi/' || to_char(p_day, 'YYYY-MM-DD') || '/' || p_sha || '.jpg' $$;
-- One photo as the website registers it.
create or replace function pg_temp.item(p_sha text, p_day date, p_at timestamptz, p_seq int, p_hint int default 3, p_size int default 100) returns jsonb language sql as $$
  select jsonb_build_object('city_id', 1, 'sha256', p_sha, 'ext', 'jpg', 'photo_day', p_day, 'file_name', 'IMG_' || p_seq || '.JPG', 'mime_type', 'image/jpeg',
    'byte_size', p_size, 'width', 4032, 'height', 3024, 'taken_at', p_at, 'time_source', case when p_at is null then 'none' else 'exif' end,
    'clock_ok', p_at is not null, 'camera', 'apple|iphone 13', 'branch_hint', p_hint, 'file_seq_prefix', 'IMG_', 'file_seq', p_seq, 'thumb', true) $$;
create or replace function pg_temp.sha(c text) returns text language sql as $$ select repeat(c, 64) $$;
create or replace function pg_temp.grid40() returns text language sql as $$
  select md5(string_agg(role::text || ':' || permission_key || ':' || allowed::text, ',' order by role, permission_key)) from public.role_permissions $$;
grant execute on all functions in schema pg_temp to authenticated, anon;
reset role;
select pg_temp.act_as('');

-- 0. The file again: nothing changes the second time.
create temp table t40_before as
  select pg_temp.grid40() as grid, coalesce((select max(id) from public.audit_log), 0) as audit_id;
\ir ../migrations/20261017000200_photo_intake.sql
select pg_temp.check((select grid from t40_before) = pg_temp.grid40()
                     and not exists (select 1 from public.audit_log where id > (select audit_id from t40_before) and table_name = 'role_permissions'),
  'the file run a second time changes no grid cell and writes no audit row');
select pg_temp.check((select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
                       and policyname in ('photo inbox uploads', 'staff read filed intake edits', 'patients read visible intake photos')) = 3
                     and (select count(*) from pg_trigger where not tgisinternal and tgname in ('photos_mark_visit', 'photo_inbox_sets_audit')) = 2
                     and not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('photo_inbox_sets', 'photo_inbox_items', 'photo_ai_calls') and cmd <> 'SELECT'),
  'the storage policies and triggers are there once each; the inbox tables have read policies only');
select pg_temp.check(not has_function_privilege('anon', 'public.photo_inbox_day(smallint, date)', 'execute')
                     and has_function_privilege('authenticated', 'public.photo_inbox_apply(smallint, date, jsonb)', 'execute')
                     and not has_function_privilege('authenticated', 'public.photo_inbox_ai_record(jsonb, jsonb)', 'execute')
                     and has_function_privilege('service_role', 'public.photo_inbox_ai_record(jsonb, jsonb)', 'execute')
                     and not has_function_privilege('authenticated', 'private.photo_inbox_file_rows(uuid)', 'execute')
                     and not has_table_privilege('authenticated', 'public.photo_inbox_items', 'insert')
                     and not has_table_privilege('authenticated', 'public.photo_inbox_sets', 'update'),
  'the functions are for signed-in staff; Claude''s answers for the service role only; nobody writes the tables directly');

begin;
-- 1. The grid.
select pg_temp.check((select label = 'Use the Photo inbox' and category = 'Photos' and sort_order = 54 from public.permissions where key = 'photos.intake'),
  'the access list has "Use the Photo inbox" under Photos');
select pg_temp.check((select string_agg(role::text || '=' || allowed::text, ',' order by role::text) from public.role_permissions where permission_key = 'photos.intake')
                      = 'accountant=false,admin=true,assistant=true,coordinator=true,doctor=false,front_desk=false',
  'photos.intake: the assistant, the coordinator and Dr. Ali; not the front desk, the doctor or the accountant (every role has its cell)');
select pg_temp.check((select string_agg(role::text, ',' order by role::text) from public.role_permissions where permission_key = 'photos.upload' and allowed)
                      = 'admin,assistant,coordinator,doctor,front_desk',
  'photos.upload is unchanged: the front desk keeps its profile uploads');

insert into auth.users (id, email) values
  (:admin, 'admin40@dralirashid.com'), (:fd, 'fd40@dralirashid.com'), (:asst, 'asst40@dralirashid.com'), (:doc, 'doc40@dralirashid.com'),
  (:coord, 'coord40@dralirashid.com'), (:acct, 'acct40@dralirashid.com'), (:pat, 'samplepatient-40@dralirashid.com'), (:asst2, 'asst2-40@dralirashid.com');
insert into public.staff (id, full_name, email, role, restrict_to_branches, branch_ids) values
  (:admin, 'Admin Forty', 'admin40@dralirashid.com', 'admin', false, '{}'),
  (:fd, 'Front Desk Forty', 'fd40@dralirashid.com', 'front_desk', true, '{1}'),
  (:asst, 'Assistant Forty', 'asst40@dralirashid.com', 'assistant', true, '{1}'),
  (:doc, 'Doctor Forty', 'doc40@dralirashid.com', 'doctor', false, '{}'),
  (:coord, 'Coordinator Forty', 'coord40@dralirashid.com', 'coordinator', true, '{1,2,3}'),
  (:acct, 'Accountant Forty', 'acct40@dralirashid.com', 'accountant', false, '{}'),
  (:asst2, 'Assistant Lahore Forty', 'asst2-40@dralirashid.com', 'assistant', true, '{4}');
insert into public.patients (mr_number, full_name, phone, first_branch_id, portal_user_id) values ('40001', 'Sample Forty One', '03005554001', 3, :pat);
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('40002', 'Sample Forty Two', '03005554002', 3);
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('40003', 'Sample Forty Three', '03005554003', 4);
select id as p1 from public.patients where mr_number = '40001' \gset
select id as p2 from public.patients where mr_number = '40002' \gset
select id as p3 from public.patients where mr_number = '40003' \gset
select ((now() at time zone 'Asia/Karachi')::date - 1)::text as d1 \gset

-- Yesterday at DHA (branch 3, Karachi): v1 a photo month in treatment since 18:31; v2 Scaling at the same time; v4 a photo month that has
-- photos already. v3 a photo month in Lahore (branch 4). v5 a photo month at DHA that started at 15:30.
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, photo_required, started_at, checked_in_at)
values (:'p1', 3, :'d1', 'in_treatment', 'Monthly', true, (:'d1' || ' 18:31:00+05')::timestamptz, (:'d1' || ' 18:20:00+05')::timestamptz);
select id as v1 from public.visits where patient_id = :'p1' and visit_date = :'d1' \gset
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, photo_required, started_at)
values (:'p2', 3, :'d1', 'in_treatment', 'Scaling', false, (:'d1' || ' 18:30:00+05')::timestamptz);
select id as v2 from public.visits where patient_id = :'p2' and treatment_label = 'Scaling' \gset
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, photo_required, started_at)
values (:'p3', 4, :'d1', 'in_treatment', 'Monthly', true, (:'d1' || ' 18:31:00+05')::timestamptz);
select id as v3 from public.visits where patient_id = :'p3' \gset
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, photo_required, photos_uploaded, started_at)
values (:'p2', 3, :'d1', 'in_treatment', 'Monthly', true, true, (:'d1' || ' 18:32:00+05')::timestamptz);
select id as v4 from public.visits where patient_id = :'p2' and treatment_label = 'Monthly' \gset
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, photo_required, started_at)
values (:'p1', 3, :'d1', 'in_treatment', 'Bonding', true, (:'d1' || ' 15:30:00+05')::timestamptz);
select id as v5 from public.visits where patient_id = :'p1' and treatment_label = 'Bonding' \gset

-- 2. Who may.
set role authenticated;
select pg_temp.act_as(:fd);
select pg_temp.check(public.photo_inbox_cities() = '[]'::jsonb and public.photo_inbox_counts() = '{"waiting": 0, "check": 0}'::jsonb
                     and not public.photo_inbox_ai_allowed(),
  'the front desk: no city folders, the badge says zero, the AI check says no');
select pg_temp.expect_error(format('select public.photo_inbox_day(1::smallint, %L::date)', :'d1'), 'NOT_ALLOWED', 'the front desk cannot open a city''s day');
select pg_temp.expect_error($q$select public.photo_inbox_add_items('[]'::jsonb)$q$, 'NOT_ALLOWED', 'the front desk cannot register photos');
select pg_temp.expect_error($q$select public.photo_inbox_counts(); select public.photo_inbox_claim_edits(5, false)$q$, 'NOT_ALLOWED', 'the front desk takes no edits');
select pg_temp.act_as(:doc);
select pg_temp.expect_error(format('select public.photo_inbox_overview(1::smallint)'), 'NOT_ALLOWED', 'the doctor (raw photos but no inbox) is refused');
select pg_temp.act_as(:acct);
select pg_temp.expect_error(format('select public.photo_inbox_day(1::smallint, %L::date)', :'d1'), 'NOT_ALLOWED', 'the accountant is refused');
select pg_temp.act_as(:pat);
select pg_temp.expect_error(format('select public.photo_inbox_day(1::smallint, %L::date)', :'d1'), 'NOT_ALLOWED', 'a patient login is refused');
select pg_temp.check(public.photo_inbox_counts() = '{"waiting": 0, "check": 0}'::jsonb, 'a patient: zeros');
select pg_temp.act_as(:asst);
select pg_temp.check((select string_agg(x ->> 'name', ',') from jsonb_array_elements(public.photo_inbox_cities()) x) = 'Karachi'
                     and (select jsonb_array_length(public.photo_inbox_cities() -> 0 -> 'branches')) = 3
                     and public.photo_inbox_cities() -> 0 ->> 'slug' = 'karachi',
  'the assistant working at Gulshan has the Karachi folder (with its three branches), not Lahore or Islamabad');
select pg_temp.check(public.photo_inbox_day(1::smallint, :'d1'::date) -> 'visits' @> jsonb_build_array(jsonb_build_object('visit_id', :'v1', 'full_name', 'Sample Forty One')),
  'she sees the whole city''s day list (DHA too) for matching');
select pg_temp.expect_error(format('select public.photo_inbox_day(2::smallint, %L::date)', :'d1'), 'NOT_ALLOWED', 'but not Lahore''s');
reset role;
set role anon;
select pg_temp.act_as('');
select pg_temp.expect_error('select public.photo_inbox_counts()', 'permission denied', 'anonymous visitors cannot call the functions at all');
reset role;

-- 3. Uploads.
set role authenticated;
select pg_temp.act_as(:fd);
select pg_temp.expect_error(format('select pg_temp.obj(%L)', pg_temp.path(pg_temp.sha('f'), :'d1'::date)), 'row-level security', 'the front desk cannot store into the Photo inbox');
select pg_temp.obj(:'p1' || '/raw/2026-10-16_Front_aa400001.jpg');
select pg_temp.check(true, 'the front desk still stores a picture in the patient''s own folder');
select pg_temp.act_as(:asst2);
select pg_temp.expect_error(format('select pg_temp.obj(%L)', pg_temp.path(pg_temp.sha('9'), :'d1'::date)), 'row-level security', 'a Lahore assistant cannot store into the Karachi folder');
select pg_temp.act_as(:asst);
select pg_temp.obj(pg_temp.path(pg_temp.sha('a'), :'d1'::date), 100);
select pg_temp.obj(public.photo_thumb_path(pg_temp.path(pg_temp.sha('a'), :'d1'::date)), 10);
select pg_temp.obj(pg_temp.path(pg_temp.sha('b'), :'d1'::date), 100);
select pg_temp.obj(pg_temp.path(pg_temp.sha('c'), :'d1'::date), 100);
select pg_temp.obj(pg_temp.path(pg_temp.sha('d'), :'d1'::date), 100);
select pg_temp.obj('inbox/karachi/' || :'d1' || '/elsewhere.jpg', 100);
select pg_temp.check(true, 'the assistant stores photos in the Karachi folder');
select pg_temp.expect_error(format('select public.photo_inbox_add_items(jsonb_build_array(pg_temp.item(%L, %L::date, %L::timestamptz, 101, 3, 999)))',
  pg_temp.sha('a'), :'d1', :'d1' || ' 18:35:00+05'), 'PHOTO_FILE_MISSING', 'a size other than the stored file''s is refused');
select pg_temp.expect_error(format('select public.photo_inbox_add_items(jsonb_build_array(pg_temp.item(%L, %L::date, %L::timestamptz, 101)))',
  pg_temp.sha('e'), :'d1', :'d1' || ' 18:35:00+05'), 'PHOTO_FILE_MISSING', 'a photo whose file is not stored at its own path is refused');
select pg_temp.expect_error(format('select public.photo_inbox_add_items(jsonb_build_array(pg_temp.item(%L, %L::date, %L::timestamptz, 101)))',
  pg_temp.sha('a'), :'d1', (:'d1'::date - 1) || ' 18:35:00+05'), 'PHOTO_BAD_INPUT', 'a day other than its camera time says is refused');
select pg_temp.expect_error(format('select public.photo_inbox_add_items(jsonb_build_array(pg_temp.item(%L, %L::date, %L::timestamptz, 101, 4)))',
  pg_temp.sha('a'), :'d1', :'d1' || ' 18:35:00+05'), 'PHOTO_BAD_INPUT', 'a branch hint of another city is refused');
create temp table t40_added as select public.photo_inbox_add_items(jsonb_build_array(
  pg_temp.item(pg_temp.sha('a'), :'d1'::date, (:'d1' || ' 18:35:00+05')::timestamptz, 101),
  pg_temp.item(pg_temp.sha('b'), :'d1'::date, (:'d1' || ' 18:35:40+05')::timestamptz, 102),
  pg_temp.item(pg_temp.sha('c'), :'d1'::date, (:'d1' || ' 18:36:30+05')::timestamptz, 103))) as r;
select pg_temp.check((select string_agg(x ->> 'state', ',') from t40_added, jsonb_array_elements(r) x) = 'added,added,added', 'three photos registered');
select id as i1 from public.photo_inbox_items where sha256 = pg_temp.sha('a') \gset
select id as i2 from public.photo_inbox_items where sha256 = pg_temp.sha('b') \gset
select id as i3 from public.photo_inbox_items where sha256 = pg_temp.sha('c') \gset
select pg_temp.check((select thumb_path = public.photo_thumb_path(storage_path) and uploaded_by = :asst::uuid and set_id is null from public.photo_inbox_items where id = :'i1')
                     and (select thumb_path is null from public.photo_inbox_items where id = :'i2'),
  'the small copy is named only when it is stored; the uploader is recorded; no set until matching');
select pg_temp.check((select r -> 0 ->> 'state' from (select public.photo_inbox_add_items(jsonb_build_array(pg_temp.item(pg_temp.sha('a'), :'d1'::date, (:'d1' || ' 18:35:00+05')::timestamptz, 101))) as r) x) = 'duplicate'
                     and (select count(*) from public.photo_inbox_items where sha256 = pg_temp.sha('a')) = 1,
  'the same photo again is one photo (duplicate)');
select pg_temp.check((select x ->> 'city_name' from jsonb_array_elements(public.photo_inbox_known(array[pg_temp.sha('a'), pg_temp.sha('9')])) x) = 'Karachi',
  'known() names where a photo is already');

-- 4. Matching.
create or replace function pg_temp.plan(p_regroup jsonb, p_groups jsonb, p_fixed jsonb default '[]'::jsonb) returns jsonb language sql as $$
  select jsonb_build_object('matcher_version', 1, 'regroup_item_ids', p_regroup, 'groups', p_groups, 'fixed_updates', p_fixed) $$;
create or replace function pg_temp.grp(p_items jsonb, p_visit uuid default null, p_reason text default 'AMBIGUOUS') returns jsonb language sql as $$
  select jsonb_build_object('item_ids', p_items, 'join_set_id', null, 'wait_reason', p_reason, 'candidates', '[]'::jsonb,
    'auto', case when p_visit is null then null else jsonb_build_object('visit_id', p_visit, 'rule', 'Automatic: test rule') end) $$;
select pg_temp.expect_error(format('select public.photo_inbox_apply(1::smallint, %L::date, pg_temp.plan(%L::jsonb, %L::jsonb))', :'d1',
  jsonb_build_array(:'i1', :'i2'), jsonb_build_array(pg_temp.grp(jsonb_build_array(:'i1', :'i2')))), 'PHOTO_STALE_PLAN', 'a plan missing a photo is refused');
select pg_temp.expect_error(format('select public.photo_inbox_apply(1::smallint, %L::date, pg_temp.plan(%L::jsonb, %L::jsonb))', :'d1',
  jsonb_build_array(:'i1', :'i2', :'i3'), jsonb_build_array(pg_temp.grp(jsonb_build_array(:'i1', :'i2', :'i3')), pg_temp.grp(jsonb_build_array(:'i3')))), 'PHOTO_STALE_PLAN',
  'a plan with a photo twice is refused');
-- Each refused automatic filing: not a photo month (v2), another city (v3), a visit with photos (v4), photos 3 hours after the start (v5).
create temp table t40_refusals as select v, public.photo_inbox_apply(1::smallint, :'d1'::date,
    pg_temp.plan(jsonb_build_array(:'i1', :'i2', :'i3'), jsonb_build_array(pg_temp.grp(jsonb_build_array(:'i1', :'i2', :'i3'), v::uuid)))) as r
  from unnest(array[:'v2', :'v3', :'v4', :'v5']) as v;
select pg_temp.check((select bool_and((r ->> 'filed')::int = 0 and r -> 'server_refused' -> 0 ->> 'why' is not null) from t40_refusals)
                     and (select string_agg(r -> 'server_refused' -> 0 ->> 'why', ' | ' order by v) from t40_refusals) is not null,
  'automatic filing is refused onto a non-photo-month visit, a visit of another city, a visit with photos, and photos 3 hours after the start');
select pg_temp.check((select count(distinct r -> 'sets' -> 0 ->> 'set_id') from t40_refusals) = 1,
  'each new plan of the same photos reuses the set of their earliest photo');
select set_id as s1 from public.photo_inbox_items where id = :'i1' \gset
select pg_temp.check((select status = 'waiting' and wait_reason = 'SERVER_CHECK' and photo_count = 3 and time_ok and branch_hint = 3 and camera = 'apple|iphone 13'
                        and first_at = (:'d1' || ' 18:35:00+05')::timestamptz from public.photo_inbox_sets where id = :'s1')
                     and (select string_agg(position::text, ',' order by position) from public.photo_inbox_items where set_id = :'s1') = '1,2,3',
  'the set waits with SERVER_CHECK; its times, count, hint and camera are worked out; its photos are numbered 1-3');
create temp table t40_auto as select public.photo_inbox_apply(1::smallint, :'d1'::date,
  pg_temp.plan(jsonb_build_array(:'i1', :'i2', :'i3'), jsonb_build_array(pg_temp.grp(jsonb_build_array(:'i1', :'i2', :'i3'), :'v1'::uuid)))) as r;
select pg_temp.check((select (r ->> 'filed')::int = 1 and jsonb_array_length(r -> 'server_refused') = 0 from t40_auto)
                     and (select status = 'filed' and filed_how = 'auto' and filed_rule = 'Automatic: test rule' and patient_id = :'p1'::uuid and visit_id = :'v1'::uuid
                            and branch_id = 3 and occasion = 'Monthly' and release_after > now() + interval '23 hours' from public.photo_inbox_sets where id = :'s1'),
  'the right automatic filing files: the photo month of that city and day, in treatment, started 4 minutes before the photos');
reset role;
select pg_temp.check((select count(*) from public.photos where intake_set_id = :'s1' and kind = 'raw' and patient_id = :'p1' and visit_id = :'v1'
                        and storage_path like 'inbox/karachi/%' and view_label = 'Monthly ' || chr(183) || ' Photo ' || (select position from public.photo_inbox_items where id = photos.intake_item_id)
                        and uploaded_by = :asst::uuid and not public_ok) = 3
                     and (select photos_uploaded from public.visits where id = :'v1')
                     and (select count(*) from public.audit_log where table_name = 'photo_inbox_sets' and row_id = :'s1' and action = 'PHOTO_FILED' and actor = :asst::uuid
                           and new_data ->> 'how' = 'auto' and (new_data ->> 'photos')::int = 3) = 1,
  'three raw rows in the patient''s file ("Monthly · Photo n"), the visit''s "photos uploaded" ticked, PHOTO_FILED in the audit log');

-- 5. One tap, split, set aside, put back.
set role authenticated;
select pg_temp.act_as(:asst);
select public.photo_inbox_add_items(jsonb_build_array(
  pg_temp.item(pg_temp.sha('d'), :'d1'::date, null, 201)));
select id as i4 from public.photo_inbox_items where sha256 = pg_temp.sha('d') \gset
select public.photo_inbox_apply(1::smallint, :'d1'::date, pg_temp.plan(jsonb_build_array(:'i4'), jsonb_build_array(pg_temp.grp(jsonb_build_array(:'i4'), null, 'NO_TIME'))));
select set_id as s4 from public.photo_inbox_items where id = :'i4' \gset
select version as s4v from public.photo_inbox_sets where id = :'s4' \gset
select pg_temp.expect_error(format('select public.photo_inbox_file_set(%L, %L, null, %s)', :'s4', :'v1', :s4v - 1), 'PHOTO_STALE', 'a tap on an old screen is refused');
select pg_temp.expect_error(format('select public.photo_inbox_file_set(%L, %L, null, %s)', :'s4', :'v3', :s4v), 'PHOTO_VISIT_INVALID', 'a visit of another city is refused');
create temp table t40_aside as select public.photo_inbox_set_aside(:'s4', :s4v) as r;
select pg_temp.check((select (r ->> 'set_aside')::boolean from t40_aside)
                     and (select status = 'set_aside' and set_aside_reason = 'not_patient' from public.photo_inbox_sets where id = :'s4'),
  '"Not a patient photo" puts it aside');
create temp table t40_back as select public.photo_inbox_put_back(:'s4') as r;
select pg_temp.check((select (r ->> 'waiting')::boolean from t40_back)
                     and (select status = 'waiting' and manual and wait_reason = 'MANUAL' from public.photo_inbox_sets where id = :'s4'),
  '"Put back" brings it back to "Which patient?" (a person''s set from now on)');
select version as s4v from public.photo_inbox_sets where id = :'s4' \gset
create temp table t40_search as select public.photo_inbox_file_set(:'s4', null, :'p2', :s4v) as r;
select pg_temp.check((select (r ->> 'filed')::boolean from t40_search)
                     and (select status = 'filed' and patient_id = :'p2'::uuid and visit_id is null and filed_how = 'confirmed' and filed_by = :asst::uuid
                            from public.photo_inbox_sets where id = :'s4'),
  '"Search all patients": a patient with two visits that day is filed without a visit, confirmed by the assistant');
-- Split: a waiting set of three (back from the filed one: undo below needs photos.delete, which the assistant has).
select pg_temp.check((public.photo_inbox_unfile_set(:'s1') ->> 'removed_photos')::int = 3, 'undo filing removes the three rows');
reset role;
select pg_temp.check((select count(*) from public.photos where intake_set_id = :'s1') = 0
                     and (select count(*) from public.photo_inbox_items where set_id = :'s1') = 3
                     and not (select photos_uploaded from public.visits where id = :'v1')
                     and (select status = 'waiting' and manual and wait_reason = 'UNDONE' and patient_id is null from public.photo_inbox_sets where id = :'s1')
                     and exists (select 1 from storage.objects where name = pg_temp.path(pg_temp.sha('a'), :'d1'::date))
                     and (select count(*) from public.audit_log where action = 'PHOTO_UNFILED' and row_id = :'s1') = 1,
  'the photos stay (items and files), the visit''s tick comes off, the set waits again (UNDONE), PHOTO_UNFILED in the audit log');
set role authenticated;
select pg_temp.act_as(:asst);
select version as s1v from public.photo_inbox_sets where id = :'s1' \gset
select pg_temp.expect_error(format('select public.photo_inbox_split_set(%L, %L, %s)', :'s1', :'i1', :s1v), 'PHOTO_BAD_INPUT', 'a split cannot start at the first photo');
select (public.photo_inbox_split_set(:'s1', :'i3', :s1v) ->> 'set_b') as s1b \gset
select pg_temp.check((select photo_count from public.photo_inbox_sets where id = :'s1') = 2 and (select photo_count from public.photo_inbox_sets where id = :'s1b') = 1
                     and (select set_id from public.photo_inbox_items where id = :'i3') = :'s1b'::uuid,
  'split: the chosen photo and the ones after it are a set of their own');
select version as s1v from public.photo_inbox_sets where id = :'s1' \gset
select pg_temp.check((public.photo_inbox_file_set(:'s1', :'v1', null, :s1v) ->> 'photos')::int = 2, 'one tap files the first two photos to the photo month');
reset role;
select pg_temp.check((select photos_uploaded from public.visits where id = :'v1'), 'and the visit is ticked again');

-- 6. The edited copy and the 24-hour window.
set role authenticated;
select pg_temp.act_as(:asst);
create temp table t40_claim as select public.photo_inbox_claim_edits(10, false) as r;
select pg_temp.check((select jsonb_array_length(r) >= 1 and r -> 0 ->> 'set_status' = 'filed' from t40_claim),
  'the edit worker takes a filed set first');
-- the edited copy of i3 (in a waiting set): saved, no row yet
select pg_temp.obj('inbox/karachi/' || :'d1' || '/edited/' || pg_temp.sha('c') || '.jpg', 50);
select pg_temp.obj('inbox/karachi/' || :'d1' || '/edited/thumbs/' || pg_temp.sha('c') || '.jpg', 5);
select pg_temp.expect_error(format('select public.photo_inbox_save_edit(%L, %L, null, 1, false)', :'i3', 'inbox/karachi/' || :'d1' || '/edited/other.jpg'),
  'PHOTO_BAD_INPUT', 'an edited copy at another path is refused');
select pg_temp.check((public.photo_inbox_save_edit(:'i3', 'inbox/karachi/' || :'d1' || '/edited/' || pg_temp.sha('c') || '.jpg',
                       'inbox/karachi/' || :'d1' || '/edited/thumbs/' || pg_temp.sha('c') || '.jpg', 1, false) ->> 'edited_photo_id') is null,
  'an edited copy of a waiting photo is kept on the photo; no patient row yet');
-- Claude's answer for i1 (service role only), then its edited copy: the edited row comes with its window
reset role;
set role service_role;
select pg_temp.check((public.photo_inbox_ai_record(jsonb_build_object('set_id', :'s1', 'item_ids', jsonb_build_array(:'i1', :'i2'), 'photo_count', 2,
    'model', 'claude-opus-5-5', 'served_model', 'claude-opus-5-5', 'status', 'ok', 'input_tokens', 2000, 'output_tokens', 1500, 'cache_read_input_tokens', 1600,
    'cost_usd', 0.03832, 'one_sitting', 'yes', 'called_by', :asst),
  jsonb_build_array(jsonb_build_object('item_id', :'i1', 'result', jsonb_build_object('kind', 'intraoral', 'view', 'intra_front')),
                    jsonb_build_object('item_id', :'i2', 'result', jsonb_build_object('kind', 'intraoral', 'view', 'intra_upper')),
                    jsonb_build_object('item_id', :'i4', 'result', jsonb_build_object('kind', 'not_clinical', 'view', 'other')))) ->> 'call_id') is not null,
  'the service role records Claude''s answer and its cost');
reset role;
select pg_temp.check((select ai_status = 'done' and ai_result ->> 'view' = 'intra_front' from public.photo_inbox_items where id = :'i1')
                     and (select ai_status = 'pending' from public.photo_inbox_items where id = :'i4')
                     and (select cost_usd = 0.03832 and cache_read_input_tokens = 1600 and called_by = :asst::uuid from public.photo_ai_calls order by id desc limit 1),
  'the answers land on the set''s photos only (a photo of another set is ignored); tokens and cost are logged');
set role authenticated;
select pg_temp.act_as(:asst);
select pg_temp.expect_error(format('select public.photo_inbox_ai_record(%L::jsonb, %L::jsonb)', '{}', '[]'), 'permission denied', 'signed-in staff cannot write Claude''s answers');
select pg_temp.obj('inbox/karachi/' || :'d1' || '/edited/' || pg_temp.sha('a') || '.jpg', 50);
select pg_temp.obj('inbox/karachi/' || :'d1' || '/edited/thumbs/' || pg_temp.sha('a') || '.jpg', 5);
select (public.photo_inbox_save_edit(:'i1', 'inbox/karachi/' || :'d1' || '/edited/' || pg_temp.sha('a') || '.jpg',
  'inbox/karachi/' || :'d1' || '/edited/thumbs/' || pg_temp.sha('a') || '.jpg', 1, false) ->> 'edited_photo_id') as e1 \gset
reset role;
select pg_temp.check((select kind = 'edited' and edited_from = (select raw_photo_id from public.photo_inbox_items where id = :'i1') and view_key = 'intra_front'
                        and view_label = 'Monthly ' || chr(183) || ' Front' and release_after > now() + interval '23 hours' and not held_back and not public_ok
                        from public.photos where id = :'e1')
                     and (select view_label = 'Monthly ' || chr(183) || ' Front' from public.photos where id = (select raw_photo_id from public.photo_inbox_items where id = :'i1')),
  'after filing: the edited row ("Monthly · Front", made from the raw one, its window 24 hours ahead); the raw row gets the view too');
set role authenticated;
select pg_temp.act_as(:pat);
select pg_temp.check(not exists (select 1 from public.photos where id = :'e1') and not public.photo_object_visible_to_patient('inbox/karachi/' || :'d1' || '/edited/' || pg_temp.sha('a') || '.jpg')
                     and not exists (select 1 from storage.objects where name = 'inbox/karachi/' || :'d1' || '/edited/' || pg_temp.sha('a') || '.jpg'),
  'the patient does not see it during its window (row and file)');
reset role;
update public.photos set release_after = now() - interval '1 minute' where id = :'e1';
set role authenticated;
select pg_temp.act_as(:pat);
select pg_temp.check(exists (select 1 from public.photos where id = :'e1')
                     and exists (select 1 from storage.objects where name = 'inbox/karachi/' || :'d1' || '/edited/' || pg_temp.sha('a') || '.jpg')
                     and not exists (select 1 from storage.objects where name = pg_temp.path(pg_temp.sha('a'), :'d1'::date)),
  'after its window the patient sees the edited copy (row and file), never the original');
select pg_temp.act_as(:asst);
select public.photo_inbox_hide_set(:'s1', true);
select pg_temp.act_as(:pat);
select pg_temp.check(not exists (select 1 from public.photos where id = :'e1')
                     and not exists (select 1 from storage.objects where name = 'inbox/karachi/' || :'d1' || '/edited/' || pg_temp.sha('a') || '.jpg'),
  '"Hide from patient" takes it away again');
select pg_temp.act_as(:asst);
select public.photo_inbox_hide_set(:'s1', false);
select pg_temp.act_as(:fd);
select pg_temp.check(exists (select 1 from storage.objects where name = 'inbox/karachi/' || :'d1' || '/edited/' || pg_temp.sha('a') || '.jpg')
                     and not exists (select 1 from storage.objects where name = 'inbox/karachi/' || :'d1' || '/edited/' || pg_temp.sha('c') || '.jpg')
                     and not exists (select 1 from storage.objects where name = pg_temp.path(pg_temp.sha('a'), :'d1'::date)),
  'the front desk reads a filed edited copy, not an unfiled one, not an original');
select pg_temp.check((public.photo_library(p_query => '40001') ->> 'total')::int = 1
                     and (public.photo_library(p_query => '40001', p_kind => 'raw') ->> 'total')::int = 0,
  'the library: the front desk finds the edited photo by Mr#, no originals');
select pg_temp.act_as(:asst);
select pg_temp.check((public.photo_library(p_query => 'forty one', p_kind => 'raw') ->> 'total')::int = 2
                     and public.photo_library(p_query => '40001') -> 'rows' -> 0 ->> 'view_key' = 'intra_front',
  'the assistant finds the originals by name too');
-- Claude sees two people: the set is flagged and the edited copies held back.
reset role;
set role service_role;
select public.photo_inbox_ai_record(jsonb_build_object('set_id', :'s1', 'item_ids', jsonb_build_array(:'i2'), 'status', 'ok', 'one_sitting', 'no', 'model', 'claude-opus-5-5'),
  jsonb_build_array(jsonb_build_object('item_id', :'i2', 'result', jsonb_build_object('kind', 'intraoral', 'view', 'intra_upper'))));
reset role;
select pg_temp.check((select ai_flag = 'mixed_people' from public.photo_inbox_sets where id = :'s1') and (select held_back from public.photos where id = :'e1'),
  'one_sitting "no": the set is flagged and its edited copies are held back');
set role authenticated;
select pg_temp.act_as(:asst);
select pg_temp.check((public.photo_inbox_counts() ->> 'check')::int = 1, 'the badge counts it under "Check these"');
select public.photo_inbox_resolve_flag(:'s1');
reset role;
select pg_temp.check((select ai_flag is null from public.photo_inbox_sets where id = :'s1') and not (select held_back from public.photos where id = :'e1'),
  '"It''s fine" clears the flag and the hold');

-- 7. Move and take out.
set role authenticated;
select pg_temp.act_as(:fd);
select pg_temp.expect_error(format('select public.photo_inbox_move_set(%L, %L, null)', :'s1', :'v4'), 'NOT_ALLOWED', 'the front desk cannot move a filed set');
reset role;
insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (:coord, 'photos.delete', false);
set role authenticated;
select pg_temp.act_as(:coord);
select pg_temp.expect_error(format('select public.photo_inbox_move_set(%L, %L, null)', :'s1', :'v4'), 'NOT_ALLOWED', 'without "Delete clinic photos and X-rays" nobody moves a filed set');
select pg_temp.act_as(:asst);
select pg_temp.check((public.photo_inbox_move_set(:'s1', :'v2', null) ->> 'moved_photos')::int = 3, 'the assistant moves the set to another patient (two raw rows and one edited)');
reset role;
select pg_temp.check((select count(*) from public.photos where intake_set_id = :'s1' and patient_id = :'p2' and visit_id = :'v2' and occasion = 'Scaling') = 3
                     and (select view_label = 'Scaling ' || chr(183) || ' Front' and release_after > now() + interval '23 hours' from public.photos where id = :'e1')
                     and (select photos_uploaded from public.visits where id = :'v2') and not (select photos_uploaded from public.visits where id = :'v1')
                     and (select count(*) from public.audit_log where action = 'PHOTO_MOVED' and row_id = :'s1' and new_data ->> 'visit_id' = :'v2') = 1,
  'the rows follow (patient, visit, occasion, label, a new window), the new visit is ticked and the old one unticked, PHOTO_MOVED in the audit log');
set role authenticated;
select pg_temp.act_as(:asst);
select (public.photo_inbox_take_out(:'i2') ->> 'set_id') as s2out \gset
reset role;
select pg_temp.check((select status = 'set_aside' and set_aside_reason = 'taken_out' from public.photo_inbox_sets where id = :'s2out')
                     and not exists (select 1 from public.photos where intake_item_id = :'i2')
                     and (select photo_count from public.photo_inbox_sets where id = :'s1') = 1,
  'take out: the photo leaves the file and is set aside on its own');

-- 8. The profile's Delete of an inbox photo, costs, the badge.
set role authenticated;
select pg_temp.act_as(:asst);
select (select raw_photo_id from public.photo_inbox_items where id = :'i1') as r1 \gset
select pg_temp.check(public.begin_photo_delete(:'r1') -> 'files' = '[]'::jsonb and (public.delete_patient_photo(:'r1') ->> 'deleted')::boolean,
  'the profile''s Delete of an inbox photo names no file and removes the row');
reset role;
select pg_temp.check(exists (select 1 from storage.objects where name = pg_temp.path(pg_temp.sha('a'), :'d1'::date))
                     and (select raw_photo_id is null from public.photo_inbox_items where id = :'i1'),
  'the original stays in the inbox');
set role authenticated;
select pg_temp.act_as(:acct);
select pg_temp.check((public.photo_ai_costs() -> 0 ->> 'calls')::int = 2 and (public.photo_ai_costs() -> 0 ->> 'cost_usd')::numeric = 0.03832,
  'accounts see the cost by month');
select pg_temp.act_as(:asst);
select pg_temp.expect_error('select public.photo_ai_costs()', 'NOT_ALLOWED', 'the assistant does not see what Claude cost');
select pg_temp.check((public.photo_inbox_counts() ->> 'waiting')::int = (select count(*) from public.photo_inbox_sets where status = 'waiting'),
  'the badge counts the waiting sets');
reset role;
select pg_temp.act_as('');
rollback;
