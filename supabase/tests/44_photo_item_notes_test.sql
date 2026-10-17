-- A note with each photo of the Photo inbox (20261017000800_photo_item_notes.sql). Made-up people only.
--   0. the file runs again, twice (after 43 ran 20261017000600 once more): one note column with its 500-character check, the save function
--      for signed-in staff only, the helpers for nobody;
--   1. who may save a photo's note: the front desk, anonymous visitors and a patient login are refused; an assistant of another city (with
--      "Use the Photo inbox") may; a patient login reads no photo row and no note;
--   2. a note typed before the photo is registered comes with it (tidied); a note typed later is saved (tidied, 500 characters at most,
--      empty = none) with an audit row (the note before and after); the same note again changes nothing and writes no audit row;
--   3. note_mr from a photo's own note: one Mr# over the photos' notes + the upload's note files the set (a photo's note is about that
--      photo, so a whole day's upload does not stop it); an Mr# named only by the upload's note keeps the 2-hour rule; two different Mr#s
--      (two photos, or a photo and the upload) wait; a name never files; a time filing is refused when a photo's note names another
--      patient; a photo whose note names another patient never joins a filed set;
--   4. old_note_mr from a photo's own note (and its "Month 6"); two Mr#s in two photos' notes wait; photo_inbox_day answers each photo's
--      note and the patients the notes name (by Mr#, and by name for old photos); the note never reaches the patient's photo rows.
\set ON_ERROR_STOP 1
\set fd44    '''00000000-0000-0000-0000-000000004401'''
\set asst44  '''00000000-0000-0000-0000-000000004402'''
\set lhr44   '''00000000-0000-0000-0000-000000004403'''
\set pat44   '''00000000-0000-0000-0000-000000004404'''
\set bA      '''00000000-0000-4000-8000-0000000044a1'''
\set bB      '''00000000-0000-4000-8000-0000000044b1'''
\set bC      '''00000000-0000-4000-8000-0000000044c1'''
\set bD      '''00000000-0000-4000-8000-0000000044d1'''
\set bE      '''00000000-0000-4000-8000-0000000044e1'''
\set bF      '''00000000-0000-4000-8000-0000000044f1'''
\set bO      '''00000000-0000-4000-8000-0000000044f7'''
\set bP      '''00000000-0000-4000-8000-0000000044f8'''

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
create or replace function pg_temp.obj44(p_name text) returns void language sql as $$
  insert into storage.objects (bucket_id, name, owner, metadata) values ('clinic-photos', p_name, auth.uid(), jsonb_build_object('size', 100)) on conflict (bucket_id, name) do nothing $$;
create or replace function pg_temp.p44(p_sha text, p_day date) returns text language sql as $$
  select 'inbox/karachi/' || to_char(p_day, 'YYYY-MM-DD') || '/' || p_sha || '.jpg' $$;
create or replace function pg_temp.sha44(c text) returns text language sql as $$ select repeat(c, 64) $$;
-- A photo of Karachi (stored first), with its camera time, upload and note.
create or replace function pg_temp.it44(p_sha text, p_day date, p_at timestamptz, p_batch text, p_note text default null, p_source text default 'exif')
returns jsonb language plpgsql as $$
begin
  perform pg_temp.obj44(pg_temp.p44(p_sha, p_day));
  return jsonb_build_object('city_id', 1, 'sha256', p_sha, 'ext', 'jpg', 'photo_day', p_day, 'file_name', 'IMG_' || left(p_sha, 4) || '.JPG',
    'mime_type', 'image/jpeg', 'byte_size', 100, 'width', 4032, 'height', 3024, 'taken_at', p_at,
    'time_source', case when p_at is null then 'none' else p_source end, 'clock_ok', p_at is not null, 'camera', 'apple|iphone 13',
    'branch_hint', null, 'upload_batch', p_batch, 'thumb', false, 'edited', false, 'note', p_note);
end $$;
create or replace function pg_temp.id44(c text) returns uuid language sql as $$ select id from public.photo_inbox_items where sha256 = repeat(c, 64) $$;
create or replace function pg_temp.set44(c text) returns uuid language sql as $$ select set_id from public.photo_inbox_items where sha256 = repeat(c, 64) $$;
create or replace function pg_temp.plan44(p_groups jsonb) returns jsonb language sql as $$
  select jsonb_build_object('matcher_version', 1,
    'regroup_item_ids', (select jsonb_agg(x) from jsonb_array_elements(p_groups) g, jsonb_array_elements(g -> 'item_ids') x),
    'groups', p_groups, 'fixed_updates', '[]'::jsonb) $$;
create or replace function pg_temp.grp44(p_items jsonb, p_auto jsonb default null, p_join uuid default null) returns jsonb language sql as $$
  select jsonb_build_object('item_ids', p_items, 'join_set_id', p_join, 'wait_reason', 'AMBIGUOUS', 'candidates', '[]'::jsonb, 'auto', p_auto) $$;
create or replace function pg_temp.auto44(p_kind text, p_visit uuid, p_patient uuid) returns jsonb language sql as $$
  select jsonb_build_object('rule_kind', p_kind, 'visit_id', p_visit, 'patient_id', p_patient, 'rule', 'the page''s sentence') $$;
create or replace function pg_temp.whys44(r jsonb) returns text language sql as $$
  select coalesce(string_agg(x ->> 'why', ' | ' order by x ->> 'why'), '') from jsonb_array_elements(r -> 'server_refused') x $$;
grant execute on all functions in schema pg_temp to authenticated, anon;
reset role;
select pg_temp.act_as('');

-- 0. The file again, twice (43 ran 20261017000600 once more: this puts the photo notes back, and shows the file runs twice).
\ir ../migrations/20261017000800_photo_item_notes.sql
\ir ../migrations/20261017000800_photo_item_notes.sql
select pg_temp.check((select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'photo_inbox_items'
                        and column_name in ('note', 'name_patient_ids')) = 2
                     and (select count(*) from pg_constraint where conname = 'photo_inbox_items_note_check') = 1
                     and (select pg_get_constraintdef(oid) like '%500%' from pg_constraint where conname = 'photo_inbox_items_note_check')
                     and has_function_privilege('authenticated', 'public.photo_inbox_item_note(uuid, text)', 'execute')
                     and not has_function_privilege('anon', 'public.photo_inbox_item_note(uuid, text)', 'execute')
                     and not has_function_privilege('authenticated', 'private.photo_inbox_item_note_mrs(uuid)', 'execute')
                     and not has_function_privilege('authenticated', 'private.photo_inbox_name_patients(text[], smallint)', 'execute')
                     and not has_table_privilege('authenticated', 'public.photo_inbox_items', 'update'),
  'the file runs twice: one note column with its 500-character check; the save function for signed-in staff; nobody writes the table');

begin;
insert into auth.users (id, email) values (:fd44, 'fd44@dralirashid.com'), (:asst44, 'asst44@dralirashid.com'), (:lhr44, 'lhr44@dralirashid.com'),
  (:pat44, 'samplepatient-44@dralirashid.com');
insert into public.staff (id, full_name, email, role, restrict_to_branches, branch_ids) values
  (:fd44, 'Front Desk Fortyfour', 'fd44@dralirashid.com', 'front_desk', true, '{1}'),
  (:asst44, 'Assistant Fortyfour', 'asst44@dralirashid.com', 'assistant', true, '{1}'),
  (:lhr44, 'Assistant Lahore Fortyfour', 'lhr44@dralirashid.com', 'assistant', true, '{4}');
insert into public.patients (mr_number, full_name, phone, first_branch_id, portal_user_id) values ('44001', 'Sample Fortyfour One', '03005554401', 3, :pat44);
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('44002', 'Sample Fortyfour Two', '03005554402', 3);
select id as p1 from public.patients where mr_number = '44001' \gset
select id as p2 from public.patients where mr_number = '44002' \gset
select ((now() at time zone 'Asia/Karachi')::date - 1)::text as d1 \gset
-- Yesterday at DHA: two photo months in the chair at the same time (p1 from 18:31, p2 from 18:30): by time alone the photos wait.
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, photo_required, started_at)
values (:'p1', 3, :'d1', 'in_treatment', 'Monthly', true, (:'d1' || ' 18:31:00+05')::timestamptz);
select id as v1 from public.visits where patient_id = :'p1' and visit_date = :'d1' \gset
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, photo_required, started_at)
values (:'p2', 3, :'d1', 'in_treatment', 'Monthly', true, (:'d1' || ' 18:30:00+05')::timestamptz);
select id as v2 from public.visits where patient_id = :'p2' and visit_date = :'d1' \gset

-- 2. A note typed before the photo is registered comes with it.
set role authenticated;
select pg_temp.act_as(:asst44);
select public.photo_inbox_start_batch(:bA, 1::smallint, 'day', null);
select public.photo_inbox_start_batch(:bB, 1::smallint, 'day', null);
select public.photo_inbox_start_batch(:bC, 1::smallint, 'day', 'Mr# 44002');
select public.photo_inbox_start_batch(:bD, 1::smallint, 'day', null);
select public.photo_inbox_start_batch(:bE, 1::smallint, 'day', null);
select public.photo_inbox_start_batch(:bF, 1::smallint, 'day', 'Mr# 44001');
select public.photo_inbox_start_batch(:bO, 1::smallint, 'old', null);
select public.photo_inbox_start_batch(:bP, 1::smallint, 'old', null);
create temp table t44_add as select public.photo_inbox_add_items(jsonb_build_array(
  pg_temp.it44(pg_temp.sha44('1'), :'d1'::date, (:'d1' || ' 18:35:00+05')::timestamptz, :bA, '  Mr#   44001' || chr(10) || ' front '),
  pg_temp.it44(pg_temp.sha44('2'), :'d1'::date, (:'d1' || ' 18:35:30+05')::timestamptz, :bA),
  pg_temp.it44(pg_temp.sha44('3'), :'d1'::date, (:'d1' || ' 12:00:00+05')::timestamptz, :bA),
  pg_temp.it44(pg_temp.sha44('4'), :'d1'::date, (:'d1' || ' 18:50:00+05')::timestamptz, :bB, 'Mr# 44001'),
  pg_temp.it44(pg_temp.sha44('5'), :'d1'::date, (:'d1' || ' 18:50:30+05')::timestamptz, :bB, 'Mr# 44002'),
  pg_temp.it44(pg_temp.sha44('6'), :'d1'::date, (:'d1' || ' 19:00:00+05')::timestamptz, :bC, 'Mr# 44001'),
  pg_temp.it44(pg_temp.sha44('7'), :'d1'::date, (:'d1' || ' 19:10:00+05')::timestamptz, :bD),
  pg_temp.it44(pg_temp.sha44('8'), :'d1'::date, (:'d1' || ' 19:20:00+05')::timestamptz, :bE, 'Mr# 44002'),
  pg_temp.it44(pg_temp.sha44('9'), :'d1'::date, (:'d1' || ' 19:30:00+05')::timestamptz, :bF),
  pg_temp.it44(pg_temp.sha44('a'), :'d1'::date, (:'d1' || ' 13:00:00+05')::timestamptz, :bF))) as r;
select pg_temp.check((select x ->> 'note' = 'Mr# 44001 front' and x ->> 'state' = 'added' from t44_add, jsonb_array_elements(r) x where x ->> 'sha256' = pg_temp.sha44('1'))
                     and (select count(*) from t44_add, jsonb_array_elements(r) x where x ? 'note' and x ->> 'note' is null) = 5,
  'a note typed before the photo is registered comes with it (tidied); every answer has the photo''s note');
select pg_temp.check((select note from public.photo_inbox_items where id = pg_temp.id44('1')) = 'Mr# 44001 front'
                     and (select note is null from public.photo_inbox_items where id = pg_temp.id44('2')),
  'the note is stored with that photo only');
select pg_temp.check((select x ->> 'state' = 'duplicate' and x ->> 'note' = 'Mr# 44001 front'
                        from jsonb_array_elements(public.photo_inbox_add_items(jsonb_build_array(
                               pg_temp.it44(pg_temp.sha44('1'), :'d1'::date, (:'d1' || ' 18:35:00+05')::timestamptz, :bA, 'another note')))) x)
                     and (select note from public.photo_inbox_items where id = pg_temp.id44('1')) = 'Mr# 44001 front',
  'the same photo again keeps its own note');
select pg_temp.expect_error(format('select public.photo_inbox_add_items(jsonb_build_array(pg_temp.it44(%L, %L::date, %L::timestamptz, %L, %L)))',
  pg_temp.sha44('b'), :'d1', :'d1' || ' 18:40:00+05', :bA, repeat('x', 501)), 'PHOTO_BAD_INPUT', 'a photo''s note longer than 500 characters is refused');

-- 1. Who may save a photo's note.
reset role;
select pg_temp.id44('2') as a2 \gset
select pg_temp.id44('7') as dd1 \gset
set role authenticated;
select pg_temp.act_as(:fd44);
select pg_temp.expect_error(format('select public.photo_inbox_item_note(%L, %L)', :'a2', 'x'), 'NOT_ALLOWED', 'the front desk saves no photo note');
select pg_temp.check((select count(*) from public.photo_inbox_items) = 0, 'the front desk reads no photo (and no note)');
select pg_temp.act_as(:pat44);
select pg_temp.expect_error(format('select public.photo_inbox_item_note(%L, %L)', :'a2', 'x'), 'NOT_ALLOWED', 'a patient login saves no photo note');
select pg_temp.check((select count(*) from public.photo_inbox_items) = 0 and (select count(*) from public.photo_inbox_batches) = 0,
  'a patient login reads no photo row and no note (nor an upload''s note)');
select pg_temp.expect_error(format('select public.photo_inbox_day(1::smallint, %L::date)', :'d1'), 'NOT_ALLOWED', 'nor the day of the Photo inbox');
reset role;
set role anon;
select pg_temp.expect_error(format('select public.photo_inbox_item_note(%L, %L)', :'a2', 'x'), 'permission denied', 'anonymous visitors cannot save a note');
reset role;
set role authenticated;
select pg_temp.act_as(:lhr44);
select pg_temp.check((public.photo_inbox_item_note(:'a2', 'Lahore desk was here') ->> 'changed')::boolean,
  'an assistant of another city (with "Use the Photo inbox") may save a note on a Karachi photo');

-- 2. A note typed after the photo was registered: saved, tidied, audited.
select pg_temp.act_as(:asst44);
select pg_temp.check((public.photo_inbox_item_note(:'a2', '  Sample Fortyfour One ' || chr(10) || ' left side ') ->> 'note') = 'Sample Fortyfour One left side',
  'a note typed after the photo was registered is saved (spaces and line breaks tidied)');
select pg_temp.check(not (public.photo_inbox_item_note(:'a2', 'Sample Fortyfour One left side') ->> 'changed')::boolean,
  'the same note again changes nothing');
select pg_temp.expect_error(format('select public.photo_inbox_item_note(%L, %L)', :'a2', repeat('y', 501)), 'PHOTO_BAD_INPUT', 'a note longer than 500 characters is refused');
select pg_temp.expect_error(format('select public.photo_inbox_item_note(%L, %L)', '00000000-0000-4000-8000-000000000000', 'x'), 'PHOTO_BAD_INPUT', 'a photo that is not there is refused');
select public.photo_inbox_item_note(:'dd1', 'Sample Fortyfour One');
select public.photo_inbox_item_note(pg_temp.id44('9'), '   ');
reset role;
select pg_temp.check((select count(*) from public.audit_log where table_name = 'photo_inbox_items' and row_id = :'a2' and action = 'PHOTO_NOTE') = 2
                     and (select new_data ->> 'note' = 'Sample Fortyfour One left side' and old_data ->> 'note' = 'Lahore desk was here' and actor = :asst44::uuid
                            from public.audit_log where table_name = 'photo_inbox_items' and row_id = :'a2' and action = 'PHOTO_NOTE' order by id desc limit 1)
                     and (select note is null from public.photo_inbox_items where id = pg_temp.id44('9'))
                     and not exists (select 1 from public.audit_log where table_name = 'photo_inbox_items' and row_id = pg_temp.id44('9')::text),
  'each change is in the audit log (the note before and after, who); an empty note is no note and no change');

-- 3. Today's photos filed by a photo's own note.
-- Groups: a1 + a2 (a1's note: Mr# 44001; a2's: a name; the upload also has a1 6 hours earlier), a3 alone, b1 + b2 (two photos, two Mr#s),
-- c1 (its note 44001, its upload's 44002), d1 (a name only), e1 (time filing to p1, its note names 44002), f1 (Mr# only in the upload's
-- note, the upload over 6 hours), f2 alone.
set role authenticated;
select pg_temp.act_as(:asst44);
create temp table t44_apply as select public.photo_inbox_apply(1::smallint, :'d1'::date, pg_temp.plan44(jsonb_build_array(
  pg_temp.grp44(jsonb_build_array(pg_temp.id44('1'), pg_temp.id44('2')), pg_temp.auto44('note_mr', :'v1', :'p1')),
  pg_temp.grp44(jsonb_build_array(pg_temp.id44('3'))),
  pg_temp.grp44(jsonb_build_array(pg_temp.id44('4'), pg_temp.id44('5')), pg_temp.auto44('note_mr', :'v1', :'p1')),
  pg_temp.grp44(jsonb_build_array(pg_temp.id44('6')), pg_temp.auto44('note_mr', :'v1', :'p1')),
  pg_temp.grp44(jsonb_build_array(pg_temp.id44('7')), pg_temp.auto44('note_mr', :'v1', :'p1')),
  pg_temp.grp44(jsonb_build_array(pg_temp.id44('8')), jsonb_build_object('visit_id', :'v1', 'patient_id', :'p1', 'rule', 'Automatic: the only photo-month patient')),
  pg_temp.grp44(jsonb_build_array(pg_temp.id44('9')), pg_temp.auto44('note_mr', :'v1', :'p1')),
  pg_temp.grp44(jsonb_build_array(pg_temp.id44('a')))))) as r;
reset role;
select pg_temp.set44('1') as sa \gset
select pg_temp.check((select (r ->> 'filed')::int = 1 from t44_apply)
                     and (select status = 'filed' and filed_how = 'auto' and patient_id = :'p1'::uuid and visit_id = :'v1'::uuid
                            and filed_rule like 'Automatic (note_mr):%Mr# 44001%' from public.photo_inbox_sets where id = :'sa')
                     and pg_temp.set44('2') = :'sa'::uuid,
  'one Mr# over the photos'' own notes files the set by itself (rule note_mr), though the upload holds a photo 6 hours earlier');
select pg_temp.check((select pg_temp.whys44(r) from t44_apply)
                       = 'the note does not name exactly one Mr# | the note does not name exactly one Mr# | the note does not name exactly one Mr# | '
                         || 'the photos'' own notes name another patient | the upload is more than one visit',
  'two Mr#s (two photos, or a photo and its upload) wait; a name never files; a time filing is refused when a photo''s note names another patient; an Mr# only in the upload''s note keeps the 2-hour rule');
select pg_temp.check((select bool_and(status = 'waiting' and wait_reason = 'SERVER_CHECK') from public.photo_inbox_sets
                       where id in (pg_temp.set44('4'), pg_temp.set44('6'), pg_temp.set44('7'), pg_temp.set44('8'), pg_temp.set44('9')))
                     and pg_temp.set44('4') = pg_temp.set44('5'),
  'they wait on "Which patient?" (the two photos naming two Mr#s together, both to choose from)');
select pg_temp.check(not exists (select 1 from public.photos where row_to_json(photos)::text like '%Fortyfour One left%' or row_to_json(photos)::text like '%44001 front%'),
  'the notes are not copied to the patient''s photo rows (never in the portal)');

-- A photo whose note names another patient never joins the filed set (the rest of the sitting, 30 seconds later).
set role authenticated;
select pg_temp.act_as(:asst44);
select public.photo_inbox_add_items(jsonb_build_array(pg_temp.it44(pg_temp.sha44('c'), :'d1'::date, (:'d1' || ' 18:36:00+05')::timestamptz, :bA, 'Mr# 44002')));
create temp table t44_join as select public.photo_inbox_apply(1::smallint, :'d1'::date, pg_temp.plan44(jsonb_build_array(
  pg_temp.grp44(jsonb_build_array(pg_temp.id44('3'))),
  pg_temp.grp44(jsonb_build_array(pg_temp.id44('4'), pg_temp.id44('5'))),
  pg_temp.grp44(jsonb_build_array(pg_temp.id44('6'))), pg_temp.grp44(jsonb_build_array(pg_temp.id44('7'))),
  pg_temp.grp44(jsonb_build_array(pg_temp.id44('8'))), pg_temp.grp44(jsonb_build_array(pg_temp.id44('9'))),
  pg_temp.grp44(jsonb_build_array(pg_temp.id44('a'))),
  pg_temp.grp44(jsonb_build_array(pg_temp.id44('c')), null, :'sa')))) as r;
reset role;
select pg_temp.check((select (r ->> 'joined')::int = 0 from t44_join) and pg_temp.set44('c') <> :'sa'::uuid
                     and (select status = 'waiting' from public.photo_inbox_sets where id = pg_temp.set44('c'))
                     and (select photo_count from public.photo_inbox_sets where id = :'sa') = 2,
  'a photo whose note names another patient does not join the filed set of the sitting: it waits');

-- 4. Old photos filed by a photo's own note.
set role authenticated;
select pg_temp.act_as(:asst44);
select public.photo_inbox_add_items(jsonb_build_array(
  pg_temp.it44(pg_temp.sha44('d'), date '2024-05-20', '2024-05-20 11:00:00+05'::timestamptz, :bO, 'Mr# 44002 M6', 'exif_modified'),
  pg_temp.it44(pg_temp.sha44('e'), date '2024-05-20', '2024-05-20 11:01:00+05'::timestamptz, :bO, null, 'exif_modified'),
  pg_temp.it44(pg_temp.sha44('f'), date '2024-05-20', '2024-05-20 15:00:00+05'::timestamptz, :bO, null, 'exif_modified'),
  pg_temp.it44(pg_temp.sha44('0'), date '2024-05-20', '2024-05-20 16:00:00+05'::timestamptz, :bP, '44001', 'exif_modified'),
  pg_temp.it44(pg_temp.sha44('b'), date '2024-05-20', '2024-05-20 16:01:00+05'::timestamptz, :bP, '44002', 'exif_modified')));
select public.photo_inbox_item_note(pg_temp.id44('f'), 'Sample Fortyfour Two, front');
reset role;
select pg_temp.check((select name_patient_ids[1] = :'p2'::uuid from public.photo_inbox_items where id = pg_temp.id44('f'))
                     and (select cardinality(name_patient_ids) = 0 from public.photo_inbox_items where id = pg_temp.id44('d')),
  'old photos: the patients a name in a photo''s note fits are found when the note is saved (the most name words first)');
set role authenticated;
select pg_temp.act_as(:asst44);
create temp table t44_old as select public.photo_inbox_apply(1::smallint, date '2024-05-20', pg_temp.plan44(jsonb_build_array(
  pg_temp.grp44(jsonb_build_array(pg_temp.id44('d'), pg_temp.id44('e')), pg_temp.auto44('old_note_mr', null, :'p2')),
  pg_temp.grp44(jsonb_build_array(pg_temp.id44('f'))),
  pg_temp.grp44(jsonb_build_array(pg_temp.id44('0'), pg_temp.id44('b')), pg_temp.auto44('old_note_mr', null, :'p1'))))) as r;
create temp table t44_oday as select public.photo_inbox_day(1::smallint, date '2024-05-20') as r;
reset role;
select pg_temp.check((select (r ->> 'filed')::int = 1 and pg_temp.whys44(r) = 'the note does not name exactly one Mr#' from t44_old)
                     and (select status = 'filed' and kind = 'old' and patient_id = :'p2'::uuid and visit_id is null and occasion = 'Month 6'
                            and filed_rule like 'Automatic (old_note_mr):%Mr# 44002%' from public.photo_inbox_sets where id = pg_temp.set44('d'))
                     and (select count(*) from public.photos where intake_set_id = pg_temp.set44('d') and kind = 'raw' and braces_month = 6) = 2,
  'old photos: one Mr# in a photo''s own note files the set (old_note_mr, "Month 6" from that note); two photos naming two Mr#s wait');
select pg_temp.check((select x ->> 'note' = 'Mr# 44002 M6' from t44_oday, jsonb_array_elements(r -> 'items') x where (x ->> 'item_id')::uuid = pg_temp.id44('d'))
                     and (select count(*) from t44_oday, jsonb_array_elements(r -> 'note_patients') x where x ->> 'mr_number' in ('44001', '44002')) = 2
                     and (select count(*) from t44_oday, jsonb_array_elements(r -> 'note_patients') x where (x ->> 'patient_id')::uuid = :'p2'::uuid) = 1,
  'the day answers each photo''s note and the patients the notes name (by Mr#, and by name for old photos), each once');
select pg_temp.act_as('');
rollback;
