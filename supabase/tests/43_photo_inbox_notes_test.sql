-- The note box and old photos (20261017000600_photo_inbox_notes.sql). Made-up people only.
--   0. the file runs again (after 41 ran 20261017000200 once more): nothing breaks; the ai_status check takes 'skipped'; one read policy;
--   1. who may: the front desk and anonymous visitors start no upload; nobody writes the uploads table directly; the uploads are read by
--      Photo inbox staff (the city rule photo_inbox_city_ok of 20261017000500), never by the front desk;
--   2. the note is stored (spaces tidied, at most 500 characters); the same upload again answers the stored one; another kind, city or
--      person is refused; photos cannot be registered under another person's upload;
--   3. the note is read like the website reads it (Mr#s without phone numbers, dates and years; the month);
--   4. old photos: any past day (their own date, else the upload day), never a trusted time, never sent to Claude, registered edited when
--      their as-it-is copy is stored (and refused when it is not); today's photos keep the last-week rule;
--   5. note_mr: a note with one Mr# files a set of today's photos to that patient's visit; refused for the wrong patient, a name only, two
--      Mr#s, a whole day of photos, a patient without a visit in this city that day; the rule code is in filed_rule;
--   6. old_note_mr: filed to the patient without a visit, "Month 6" from the note on the set and the photo rows (raw and edited), the
--      photo's own date; refused for two Mr#s or a name only; never filed by time; one tap and "Move" keep them without a visit;
--      photo_inbox_day names the uploads, their Mr# and name patients; the overview lists the old day.
\set ON_ERROR_STOP 1
\set fd43    '''00000000-0000-0000-0000-000000004301'''
\set asst43  '''00000000-0000-0000-0000-000000004302'''
\set nn43    '''00000000-0000-0000-0000-000000004303'''
\set bA      '''00000000-0000-4000-8000-0000000043a1'''
\set bB      '''00000000-0000-4000-8000-0000000043b1'''
\set bC      '''00000000-0000-4000-8000-0000000043c1'''
\set bD      '''00000000-0000-4000-8000-0000000043d1'''
\set bE      '''00000000-0000-4000-8000-0000000043e1'''
\set bO      '''00000000-0000-4000-8000-0000000043f1'''
\set bP      '''00000000-0000-4000-8000-0000000043f2'''
\set bQ      '''00000000-0000-4000-8000-0000000043f3'''

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
create or replace function pg_temp.obj43(p_name text) returns void language sql as $$
  insert into storage.objects (bucket_id, name, owner, metadata) values ('clinic-photos', p_name, auth.uid(), jsonb_build_object('size', 100)) $$;
create or replace function pg_temp.p43(p_sha text, p_day date) returns text language sql as $$
  select 'inbox/karachi/' || to_char(p_day, 'YYYY-MM-DD') || '/' || p_sha || '.jpg' $$;
create or replace function pg_temp.e43(p_sha text, p_day date) returns text language sql as $$
  select 'inbox/karachi/' || to_char(p_day, 'YYYY-MM-DD') || '/edited/' || p_sha || '.jpg' $$;
create or replace function pg_temp.it43(p_sha text, p_day date, p_at timestamptz, p_batch text, p_source text default 'exif', p_edited boolean default false)
returns jsonb language sql as $$
  select jsonb_build_object('city_id', 1, 'sha256', p_sha, 'ext', 'jpg', 'photo_day', p_day, 'file_name', 'IMG_' || left(p_sha, 4) || '.JPG',
    'mime_type', 'image/jpeg', 'byte_size', 100, 'width', 4032, 'height', 3024, 'taken_at', p_at,
    'time_source', case when p_at is null then 'none' else p_source end, 'clock_ok', p_at is not null, 'camera', 'apple|iphone 13',
    'branch_hint', null, 'upload_batch', p_batch, 'thumb', false, 'edited', p_edited) $$;
create or replace function pg_temp.sha43(c text) returns text language sql as $$ select repeat(c, 64) $$;
create or replace function pg_temp.plan43(p_regroup jsonb, p_groups jsonb) returns jsonb language sql as $$
  select jsonb_build_object('matcher_version', 1, 'regroup_item_ids', p_regroup, 'groups', p_groups, 'fixed_updates', '[]'::jsonb) $$;
create or replace function pg_temp.grp43(p_items jsonb, p_auto jsonb default null, p_reason text default 'AMBIGUOUS') returns jsonb language sql as $$
  select jsonb_build_object('item_ids', p_items, 'join_set_id', null, 'wait_reason', p_reason, 'candidates', '[]'::jsonb, 'auto', p_auto) $$;
create or replace function pg_temp.auto43(p_kind text, p_visit uuid, p_patient uuid) returns jsonb language sql as $$
  select jsonb_build_object('rule_kind', p_kind, 'visit_id', p_visit, 'patient_id', p_patient, 'rule', 'the page''s sentence') $$;
grant execute on all functions in schema pg_temp to authenticated, anon;
reset role;
select pg_temp.act_as('');

-- 0. The file again (41 ran 20261017000200 once more: this puts the notes back, and shows the file runs twice).
\ir ../migrations/20261017000600_photo_inbox_notes.sql
select pg_temp.check((select pg_get_constraintdef(oid) like '%skipped%' from pg_constraint where conname = 'photo_inbox_items_ai_status_check')
                     and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'photo_inbox_batches') = 1
                     and exists (select 1 from information_schema.columns where table_name = 'photo_inbox_sets' and column_name = 'kind')
                     and not has_table_privilege('authenticated', 'public.photo_inbox_batches', 'insert')
                     and not has_function_privilege('anon', 'public.photo_inbox_start_batch(uuid, smallint, text, text)', 'execute')
                     and not has_function_privilege('authenticated', 'private.photo_inbox_note_mrs(text)', 'execute'),
  'the file runs again; old photos may be "skipped" by Claude; the uploads table has one read policy and no direct writes');

-- 3. The note read like the website reads it (tests/photo-intake.test.ts has the same notes).
select pg_temp.check(private.photo_inbox_note_mrs('Ayesha Khan Mr# 50013, month 6, phone 0300-5551234, 17-10-2026, Oct 2025') = array['50013']
                     and private.photo_inbox_note_mrs('347-1 and 9815') = array['347-1', '9815']
                     and private.photo_inbox_note_mrs('#025 mr50013 +92 300 5551234') = array['025', '50013']
                     and private.photo_inbox_note_mrs('50013-50014 then 9815, 9815 again') = array['50013', '50014', '9815']
                     and private.photo_inbox_note_mrs('12 1234567 2026/10/17 1999 M6') = '{}'::text[]
                     and private.photo_inbox_note_mrs(null) = '{}'::text[],
  'the Mr#s of a note: 3-6 digits or an old one with a dash; never a phone number, a date or a year');
select pg_temp.check(private.photo_inbox_note_month('Ayesha month 6') = 6 and private.photo_inbox_note_month('M6 front') = 6
                     and private.photo_inbox_note_month('m 12') = 12 and private.photo_inbox_note_month('Month: 14') = 14
                     and private.photo_inbox_note_month('her 6th month') = 6 and private.photo_inbox_note_month('Mr 50013') is null
                     and private.photo_inbox_note_month('room 12') is null and private.photo_inbox_note_month('month 0') is null,
  'the braces month of a note');
select pg_temp.check(cardinality(private.photo_inbox_note_words('Aisha Khan photos Month 6 Mr# 50013 front')) = 2
                     and private.aaj_name_spelling('Ayesha') = any (private.photo_inbox_note_words('Aisha Khan photos Month 6 Mr# 50013 front')),
  'the name words of a note, in their everyday spelling ("Aisha" = "Ayesha")');

begin;
insert into auth.users (id, email) values (:fd43, 'fd43@dralirashid.com'), (:asst43, 'asst43@dralirashid.com'), (:nn43, 'nn43@dralirashid.com');
insert into public.staff (id, full_name, email, role, restrict_to_branches, branch_ids) values
  (:fd43, 'Front Desk Fortythree', 'fd43@dralirashid.com', 'front_desk', true, '{1}'),
  (:asst43, 'Assistant Fortythree', 'asst43@dralirashid.com', 'assistant', true, '{1}'),
  (:nn43, 'Assistant NN Fortythree', 'nn43@dralirashid.com', 'assistant', true, '{2}');
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('43001', 'Sample Fortythree One', '03005554301', 3);
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('43002', 'Sample Fortythree Two', '03005554302', 3);
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('43003', 'Sample Fortythree Three', '03005554303', 4);
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('43004', 'Sample Fortythree Four', '03005554304', 3);
select id as p1 from public.patients where mr_number = '43001' \gset
select id as p2 from public.patients where mr_number = '43002' \gset
select id as p3 from public.patients where mr_number = '43003' \gset
select id as p4 from public.patients where mr_number = '43004' \gset
select ((now() at time zone 'Asia/Karachi')::date - 1)::text as d1 \gset
-- Yesterday at DHA: two photo months in the chair at the same time (p1 from 18:31, p4 from 18:30: by time alone the photos wait); p3 in Lahore.
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, photo_required, started_at)
values (:'p1', 3, :'d1', 'in_treatment', 'Monthly', true, (:'d1' || ' 18:31:00+05')::timestamptz);
select id as v1 from public.visits where patient_id = :'p1' and visit_date = :'d1' \gset
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, photo_required, started_at)
values (:'p4', 3, :'d1', 'in_treatment', 'Monthly', true, (:'d1' || ' 18:30:00+05')::timestamptz);
select id as v4 from public.visits where patient_id = :'p4' and visit_date = :'d1' \gset
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, photo_required, started_at)
values (:'p3', 4, :'d1', 'in_treatment', 'Monthly', true, (:'d1' || ' 18:31:00+05')::timestamptz);
select id as v3 from public.visits where patient_id = :'p3' and visit_date = :'d1' \gset

-- 1. Who may.
set role authenticated;
select pg_temp.act_as(:fd43);
select pg_temp.expect_error(format('select public.photo_inbox_start_batch(%L, 1::smallint, %L, %L)', :bA, 'day', 'x'), 'NOT_ALLOWED', 'the front desk starts no upload');
select pg_temp.check((select qual from pg_policies where schemaname = 'public' and tablename = 'photo_inbox_batches') like '%photo_inbox_city_ok%',
  'the uploads are read by the Photo inbox city rule (photo_inbox_city_ok: every "Use the Photo inbox" holder, every city folder)');
select pg_temp.act_as(:asst43);
select pg_temp.expect_error(format('insert into public.photo_inbox_batches (id, city_id, kind, created_by) values (%L, 1, %L, %L)', :bA, 'day', :asst43),
  'permission denied', 'nobody writes the uploads table directly');
reset role;
set role anon;
select pg_temp.expect_error(format('select public.photo_inbox_start_batch(%L, 1::smallint, %L, %L)', :bA, 'day', 'x'), 'permission denied', 'anonymous visitors cannot start an upload');
reset role;

-- 2. The note is stored with its upload.
set role authenticated;
select pg_temp.act_as(:asst43);
select pg_temp.check((public.photo_inbox_start_batch(:bA, 1::smallint, 'day', '  Sample Fortythree One' || chr(10) || ' Mr# 43001   month 6 ') ->> 'note')
                       = 'Sample Fortythree One Mr# 43001 month 6',
  'the note is stored with its upload (spaces and line breaks tidied)');
select pg_temp.check((public.photo_inbox_start_batch(:bA, 1::smallint, 'day', 'another text') ->> 'note') = 'Sample Fortythree One Mr# 43001 month 6',
  'the same upload again (a lost connection) answers the stored note');
select pg_temp.expect_error(format('select public.photo_inbox_start_batch(%L, 1::smallint, %L, null)', :bA, 'old'), 'PHOTO_BAD_INPUT', 'the same upload cannot change its kind');
select pg_temp.expect_error(format('select public.photo_inbox_start_batch(%L, 1::smallint, %L, %L)', :bB, 'day', repeat('x', 501)), 'PHOTO_BAD_INPUT', 'a note longer than 500 characters is refused');
select pg_temp.expect_error(format('select public.photo_inbox_start_batch(%L, 1::smallint, %L, null)', :bB, 'weekly'), 'PHOTO_BAD_INPUT', 'an unknown kind is refused');
select public.photo_inbox_start_batch(:bB, 1::smallint, 'day', 'Sample Fortythree One');
select public.photo_inbox_start_batch(:bC, 1::smallint, 'day', 'Mr# 43001 or 43004?');
select public.photo_inbox_start_batch(:bD, 1::smallint, 'day', 'Mr# 43001');
select public.photo_inbox_start_batch(:bE, 1::smallint, 'day', 'Mr# 43003');
select public.photo_inbox_start_batch(:bO, 1::smallint, 'old', 'Sample Fortythree Two, Mr# 43002, M6');
select public.photo_inbox_start_batch(:bP, 1::smallint, 'old', '43001 43002');
select public.photo_inbox_start_batch(:bQ, 1::smallint, 'old', 'Sample Fortythree Two');
select pg_temp.check((select count(*) from public.photo_inbox_batches where created_by = :asst43::uuid) = 8
                     and (select kind from public.photo_inbox_batches where id = :bO) = 'old',
  'the assistant reads her uploads (8: 5 of today''s photos, 3 of old photos)');
select pg_temp.act_as(:fd43);
select pg_temp.check((select count(*) from public.photo_inbox_batches) = 0, 'the front desk reads no upload');
select pg_temp.act_as(:nn43);
select pg_temp.check((select count(*) from public.photo_inbox_batches where city_id = 1) = 8, 'another assistant with "Use the Photo inbox" reads the uploads of the folder (with their notes)');
select pg_temp.expect_error(format('select public.photo_inbox_start_batch(%L, 1::smallint, %L, null)', :bA, 'day'), 'PHOTO_BAD_INPUT', 'but cannot take over one');

-- 4. Old photos: any past day, no trusted time, no Claude; registered edited with their as-it-is copy. Today's photos keep the week.
select pg_temp.act_as(:asst43);
select pg_temp.obj43(pg_temp.p43(pg_temp.sha43('1'), :'d1'::date));
select pg_temp.obj43(pg_temp.p43(pg_temp.sha43('2'), :'d1'::date));
select pg_temp.obj43(pg_temp.p43(pg_temp.sha43('3'), :'d1'::date));
select pg_temp.obj43(pg_temp.p43(pg_temp.sha43('4'), :'d1'::date));
select pg_temp.obj43(pg_temp.p43(pg_temp.sha43('5'), :'d1'::date));
select pg_temp.obj43(pg_temp.p43(pg_temp.sha43('6'), :'d1'::date));
select pg_temp.obj43(pg_temp.p43(pg_temp.sha43('7'), date '2024-03-10'));
select pg_temp.obj43(pg_temp.p43(pg_temp.sha43('8'), date '2024-03-10'));
select pg_temp.obj43(pg_temp.e43(pg_temp.sha43('7'), date '2024-03-10'));
select pg_temp.obj43(pg_temp.e43(pg_temp.sha43('8'), date '2024-03-10'));
select pg_temp.obj43(pg_temp.p43(pg_temp.sha43('9'), date '2024-03-10'));
select pg_temp.obj43(pg_temp.e43(pg_temp.sha43('9'), date '2024-03-10'));
select pg_temp.obj43(pg_temp.p43(pg_temp.sha43('a'), date '2024-03-10'));
select pg_temp.obj43(pg_temp.e43(pg_temp.sha43('a'), date '2024-03-10'));
select pg_temp.obj43(pg_temp.p43(pg_temp.sha43('b'), date '2024-03-10'));
select pg_temp.expect_error(format('select public.photo_inbox_add_items(jsonb_build_array(pg_temp.it43(%L, %L::date, %L::timestamptz, %L)))',
  pg_temp.sha43('7'), '2024-03-10', '2024-03-10 11:00:00+05', :bA), 'PHOTO_BAD_INPUT', 'today''s photos: a day of 2024 is refused (the last week only)');
select pg_temp.expect_error(format('select public.photo_inbox_add_items(jsonb_build_array(pg_temp.it43(%L, %L::date, null, %L)))',
  pg_temp.sha43('b'), '2024-03-10', :bO), 'PHOTO_BAD_INPUT', 'an old photo without its own date cannot pick a day (it goes to the upload day)');
select pg_temp.expect_error(format('select public.photo_inbox_add_items(jsonb_build_array(pg_temp.it43(%L, %L::date, %L::timestamptz, %L, %L, true)))',
  pg_temp.sha43('b'), '2024-03-10', '2024-03-10 11:00:00+05', :bO, 'exif_modified'), 'PHOTO_FILE_MISSING', 'an old photo said to have its copy, without the copy, is refused');
select pg_temp.expect_error(format('select public.photo_inbox_add_items(jsonb_build_array(pg_temp.it43(%L, %L::date, %L::timestamptz, %L, %L, true)))',
  pg_temp.sha43('7'), '2024-03-11', '2024-03-10 11:00:00+05', :bO, 'exif_modified'), 'PHOTO_BAD_INPUT', 'an old photo goes to the day its own time says');
reset role;
set role authenticated;
select pg_temp.act_as(:nn43);
select pg_temp.expect_error(format('select public.photo_inbox_add_items(jsonb_build_array(pg_temp.it43(%L, %L::date, %L::timestamptz, %L)))',
  pg_temp.sha43('1'), :'d1', :'d1' || ' 18:35:00+05', :bA), 'PHOTO_BAD_INPUT', 'nor register photos under another person''s upload (and its note)');
select pg_temp.act_as(:asst43);
select public.photo_inbox_add_items(jsonb_build_array(
  pg_temp.it43(pg_temp.sha43('1'), :'d1'::date, (:'d1' || ' 18:35:00+05')::timestamptz, :bA),
  pg_temp.it43(pg_temp.sha43('2'), :'d1'::date, (:'d1' || ' 18:36:00+05')::timestamptz, :bB),
  pg_temp.it43(pg_temp.sha43('3'), :'d1'::date, (:'d1' || ' 18:37:00+05')::timestamptz, :bC),
  pg_temp.it43(pg_temp.sha43('4'), :'d1'::date, (:'d1' || ' 12:00:00+05')::timestamptz, :bD),
  pg_temp.it43(pg_temp.sha43('5'), :'d1'::date, (:'d1' || ' 18:40:00+05')::timestamptz, :bD),
  pg_temp.it43(pg_temp.sha43('6'), :'d1'::date, (:'d1' || ' 18:41:00+05')::timestamptz, :bE)));
select public.photo_inbox_add_items(jsonb_build_array(
  pg_temp.it43(pg_temp.sha43('7'), date '2024-03-10', '2024-03-10 11:00:00+05'::timestamptz, :bO, 'exif_modified', true),
  pg_temp.it43(pg_temp.sha43('8'), date '2024-03-10', '2024-03-10 11:01:00+05'::timestamptz, :bO, 'exif', true),
  pg_temp.it43(pg_temp.sha43('9'), date '2024-03-10', '2024-03-10 15:00:00+05'::timestamptz, :bP, 'exif_modified', true),
  pg_temp.it43(pg_temp.sha43('a'), date '2024-03-10', '2024-03-10 16:00:00+05'::timestamptz, :bQ, 'exif_modified', true)));
reset role;
select id as a1 from public.photo_inbox_items where sha256 = pg_temp.sha43('1') \gset
select id as b1 from public.photo_inbox_items where sha256 = pg_temp.sha43('2') \gset
select id as c1 from public.photo_inbox_items where sha256 = pg_temp.sha43('3') \gset
select id as dd1 from public.photo_inbox_items where sha256 = pg_temp.sha43('4') \gset
select id as dd2 from public.photo_inbox_items where sha256 = pg_temp.sha43('5') \gset
select id as e1 from public.photo_inbox_items where sha256 = pg_temp.sha43('6') \gset
select id as o1 from public.photo_inbox_items where sha256 = pg_temp.sha43('7') \gset
select id as o2 from public.photo_inbox_items where sha256 = pg_temp.sha43('8') \gset
select id as q1 from public.photo_inbox_items where sha256 = pg_temp.sha43('9') \gset
select id as r1 from public.photo_inbox_items where sha256 = pg_temp.sha43('a') \gset
select pg_temp.check((select bool_and(not clock_ok and ai_status = 'skipped' and edit_status = 'done' and edited_path = pg_temp.e43(sha256, photo_day)
                                      and photo_day = date '2024-03-10' and upload_batch is not null)
                        from public.photo_inbox_items where id in (:'o1', :'o2', :'q1', :'r1'))
                     and (select bool_and(clock_ok and ai_status = 'pending' and edit_status = 'pending') from public.photo_inbox_items where id in (:'a1', :'b1')),
  'old photos: on their own date of 2024, no trusted time, not for Claude, registered with their as-it-is copy; today''s photos as before');
set role authenticated;
select pg_temp.act_as(:asst43);
select pg_temp.check(not exists (select 1 from jsonb_array_elements(public.photo_inbox_claim_edits(10, false)) x where (x ->> 'item_id')::uuid in (:'o1', :'o2', :'q1', :'r1')),
  'the editing worker is never handed an old photo that has its copy');

-- 5. note_mr: today's photos filed by the note's single Mr# (checked again by the database).
-- Groups: a1 (note: Mr# 43001), b1 (a name only), c1 (two Mr#s), d1 + d2 (one upload over 6 hours), e1 (a Lahore patient's Mr#).
create temp table t43_wrong as select public.photo_inbox_apply(1::smallint, :'d1'::date, pg_temp.plan43(
  jsonb_build_array(:'a1', :'b1', :'c1', :'dd1', :'dd2', :'e1'),
  jsonb_build_array(pg_temp.grp43(jsonb_build_array(:'a1'), pg_temp.auto43('note_mr', :'v4', :'p4')),
                    pg_temp.grp43(jsonb_build_array(:'b1')), pg_temp.grp43(jsonb_build_array(:'c1')), pg_temp.grp43(jsonb_build_array(:'dd1')),
                    pg_temp.grp43(jsonb_build_array(:'dd2')), pg_temp.grp43(jsonb_build_array(:'e1'))))) as r;
select pg_temp.check((select (r ->> 'filed')::int = 0 and r -> 'server_refused' -> 0 ->> 'why' = 'the patient is not the one the note names' from t43_wrong),
  'note_mr to another patient than the note''s Mr# is refused');
create temp table t43_note as select public.photo_inbox_apply(1::smallint, :'d1'::date, pg_temp.plan43(
  jsonb_build_array(:'a1', :'b1', :'c1', :'dd1', :'dd2', :'e1'),
  jsonb_build_array(pg_temp.grp43(jsonb_build_array(:'a1'), pg_temp.auto43('note_mr', :'v1', :'p1')),
                    pg_temp.grp43(jsonb_build_array(:'b1'), pg_temp.auto43('note_mr', :'v1', :'p1')),
                    pg_temp.grp43(jsonb_build_array(:'c1'), pg_temp.auto43('note_mr', :'v1', :'p1')),
                    pg_temp.grp43(jsonb_build_array(:'dd1')),
                    pg_temp.grp43(jsonb_build_array(:'dd2'), pg_temp.auto43('note_mr', :'v1', :'p1')),
                    pg_temp.grp43(jsonb_build_array(:'e1'), pg_temp.auto43('note_mr', :'v3', :'p3'))))) as r;
reset role;
select set_id as sa from public.photo_inbox_items where id = :'a1' \gset
select pg_temp.check((select (r ->> 'filed')::int = 1 from t43_note)
                     and (select status = 'filed' and filed_how = 'auto' and patient_id = :'p1'::uuid and visit_id = :'v1'::uuid and occasion = 'Monthly'
                            and filed_rule = 'Automatic (note_mr): the note with these photos names Mr# 43001, on the DHA list that day'
                            from public.photo_inbox_sets where id = :'sa')
                     and (select count(*) from public.photos where intake_set_id = :'sa' and kind = 'raw' and visit_id = :'v1') = 1,
  'the note''s single Mr# files the set to that patient''s visit (rule note_mr in filed_rule), though by time two photo months were in the chair');
select pg_temp.check((select count(*) = 4
                               and count(*) filter (where x ->> 'why' = 'the note does not name exactly one Mr#') = 2
                               and count(*) filter (where x ->> 'why' = 'the note''s patient has no visit that day in this city') = 1
                               and count(*) filter (where x ->> 'why' = 'the upload is more than one visit') = 1
                          from t43_note, jsonb_array_elements(r -> 'server_refused') x),
  'never by a name alone, nor two Mr#s, nor a whole day of photos, nor a patient without a visit in this city that day');
select pg_temp.check((select bool_and(status = 'waiting' and wait_reason = 'SERVER_CHECK') from public.photo_inbox_sets s
                       where s.id in (select set_id from public.photo_inbox_items where id in (:'b1', :'c1', :'dd2', :'e1'))),
  'the refused sets wait on "Which patient?"');

-- 6. old_note_mr: old photos filed by the note's single Mr#, without a visit, with the note's month.
set role authenticated;
select pg_temp.act_as(:asst43);
create temp table t43_old as select public.photo_inbox_apply(1::smallint, date '2024-03-10', pg_temp.plan43(
  jsonb_build_array(:'o1', :'o2', :'q1', :'r1'),
  jsonb_build_array(pg_temp.grp43(jsonb_build_array(:'o1', :'o2'), pg_temp.auto43('old_note_mr', null, :'p2')),
                    pg_temp.grp43(jsonb_build_array(:'q1'), pg_temp.auto43('old_note_mr', null, :'p1')),
                    pg_temp.grp43(jsonb_build_array(:'r1'), jsonb_build_object('visit_id', :'v1', 'patient_id', :'p2', 'rule', 'time'))))) as r;
reset role;
select set_id as so from public.photo_inbox_items where id = :'o1' \gset
select set_id as sq from public.photo_inbox_items where id = :'q1' \gset
select set_id as sr from public.photo_inbox_items where id = :'r1' \gset
select pg_temp.check((select (r ->> 'filed')::int = 1 from t43_old)
                     and (select status = 'filed' and kind = 'old' and filed_how = 'auto' and patient_id = :'p2'::uuid and visit_id is null and branch_id = 3
                            and occasion = 'Month 6' and filed_rule = 'Automatic (old_note_mr): old photos; the note with them names Mr# 43002'
                            from public.photo_inbox_sets where id = :'so'),
  'old photos with a note of one Mr#: filed to that patient, no visit, "Month 6" from the note (rule old_note_mr)');
select pg_temp.check((select count(*) from public.photos where intake_set_id = :'so' and kind = 'raw' and patient_id = :'p2' and visit_id is null
                        and braces_month = 6 and taken_on = date '2024-03-10' and occasion = 'Month 6') = 2
                     and (select count(*) from public.photos where intake_set_id = :'so' and kind = 'edited' and braces_month = 6
                            and storage_path like '%/edited/%' and release_after > now() + interval '23 hours' and edited_from is not null) = 2,
  'the patient''s rows: the originals (staff only) and the as-it-is copies as edited photos, Month 6, on the photo''s own date, after the 24-hour window');
select pg_temp.check((select count(*) = 2
                               and count(*) filter (where x ->> 'why' = 'the note does not name exactly one Mr#') = 1
                               and count(*) filter (where x ->> 'why' = 'the photos are not clear enough') = 1
                          from t43_old, jsonb_array_elements(r -> 'server_refused') x),
  'old photos are not filed for a note of two Mr#s, nor ever by time');
select pg_temp.check((select kind = 'old' and status = 'waiting' from public.photo_inbox_sets where id = :'sq'), 'the set of old photos waits');
set role authenticated;
select pg_temp.act_as(:asst43);
create temp table t43_day as select public.photo_inbox_day(1::smallint, date '2024-03-10') as r;
select pg_temp.check((select x -> 'mr_patients' -> 0 ->> 'mr_number' = '43002' and x ->> 'kind' = 'old' and x -> 'mrs' = '["43002"]'::jsonb
                        from t43_day, jsonb_array_elements(r -> 'batches') x where x ->> 'batch_id' = :bO)
                     and (select jsonb_array_length(x -> 'mr_patients') = 2 from t43_day, jsonb_array_elements(r -> 'batches') x where x ->> 'batch_id' = :bP)
                     and exists (select 1 from t43_day, jsonb_array_elements(r -> 'batches') x, jsonb_array_elements(x -> 'name_patients') np
                                  where x ->> 'batch_id' = :bQ and np ->> 'mr_number' = '43002' and (np ->> 'hits')::int = 3)
                     and (select bool_and(s ->> 'kind' = 'old') from t43_day, jsonb_array_elements(r -> 'sets') s),
  'the day of old photos names its uploads: the note, its Mr#s and their patients, the patients a name fits (old photos only)');
select pg_temp.check(exists (select 1 from jsonb_array_elements(public.photo_inbox_overview(1::smallint) -> 'days') x where x ->> 'day' = '2024-03-10'),
  'the overview lists the day of old photos uploaded now (Filed shows them)');
select version as sqv from public.photo_inbox_sets where id = :'sq' \gset
select pg_temp.check((public.photo_inbox_file_set(:'sq', :'v1', null, :sqv) ->> 'filed')::boolean, 'one tap files a set of old photos (a visit given counts for its patient)');
reset role;
select pg_temp.check((select patient_id = :'p1'::uuid and visit_id is null and occasion = 'Old photo' and filed_how = 'confirmed' from public.photo_inbox_sets where id = :'sq')
                     and (select count(*) from public.photos where intake_set_id = :'sq' and visit_id is null and braces_month is null and occasion = 'Old photo') = 2,
  'old photos filed by a tap: that patient, no visit, "Old photo" (no month in the note)');
set role authenticated;
select pg_temp.act_as(:asst43);
select public.photo_inbox_move_set(:'so', null, :'p4');
reset role;
select pg_temp.check((select patient_id = :'p4'::uuid and visit_id is null and occasion = 'Month 6' from public.photo_inbox_sets where id = :'so')
                     and (select count(*) from public.photos where intake_set_id = :'so' and patient_id = :'p4' and visit_id is null and braces_month = 6) = 4,
  '"Move to another patient" keeps old photos without a visit, with their Month');
select pg_temp.act_as('');
rollback;
