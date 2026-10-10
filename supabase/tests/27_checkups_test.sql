-- Checkup patients (people who came for a checkup and have no Mr#): the match key, who sees what, the import of the old
-- checkup list, and the one-click patient file. Everything below uses made-up people (phones 0300-555xxxx).
--   1. the key functions give the pinned strings;           2. RLS: branch-limited desk, accountant, patient login, anon;
--   3. import_checkups: rules, cleaning, skips, limits, idempotence (4, 200 and 500 rows);
--   4. fill versus overwrite, and what staff may change on an old-list row;
--   5. the unique key of the old list;                      6. register_checkup_as_patient and link_checkup_to_patient;
--   7. the audit log;  8. the guard on the columns only the system sets (source, sheet link, patient link, created_by).
\set ON_ERROR_STOP 1
\set admin  '''00000000-0000-0000-0000-000000002700'''
\set fd     '''00000000-0000-0000-0000-000000002701'''
\set coord  '''00000000-0000-0000-0000-000000002702'''
\set acct   '''00000000-0000-0000-0000-000000002703'''
\set portal '''00000000-0000-0000-0000-000000002704'''
\set viewer '''00000000-0000-0000-0000-000000002705'''
\set noedit '''00000000-0000-0000-0000-000000002706'''

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
-- Same, and the SQLSTATE must be the expected one too (the website tells the errors apart by their text, the SQL editor by code).
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
-- Who the next statements run as (the role stays as it is).
create or replace function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, false) $$;
-- One row the way the website sends it to import_checkups.
create or replace function pg_temp.wire(r int, month text, name text, phone text, branch text, status text default 'Not Contacted', notes text default null)
returns jsonb language sql as $$
  select jsonb_build_object('row', r, 'month', month, 'name', name, 'phone', phone, 'city', 'Karachi', 'branch', branch,
    'doctors', 'Dr. Sample (sample)', 'checkup_for', 'Scaling', 'est_fee', 8000, 'follow_up', status, 'notes', notes, 'source_tab', 'Sample tab A') $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

begin;
select set_config('test.admin', :admin, false), set_config('test.fd', :fd, false), set_config('test.coord', :coord, false),
       set_config('test.acct', :acct, false), set_config('test.portal', :portal, false), set_config('test.viewer', :viewer, false), set_config('test.noedit', :noedit, false),
       set_config('test.nn', (select id::text from public.branches where code = 'NN'), false),
       set_config('test.gul', (select id::text from public.branches where code = 'GUL'), false),
       set_config('test.gul_name', (select name from public.branches where code = 'GUL'), false),
       set_config('test.nn_name', (select name from public.branches where code = 'NN'), false);
insert into auth.users (id, email) values
  (:admin, 'admin27@dralirashid.com'), (:fd, 'fd27@dralirashid.com'), (:coord, 'coord27@dralirashid.com'),
  (:acct, 'acct27@dralirashid.com'), (:portal, 'portal27@example.com'), (:viewer, 'viewer27@dralirashid.com'), (:noedit, 'noedit27@dralirashid.com');
insert into public.staff (id, full_name, email, role) values
  (:admin,  'Admin', 'admin27@dralirashid.com', 'admin'),
  (:fd,     'Front Desk NN', 'fd27@dralirashid.com', 'front_desk'),
  (:coord,  'Coordinator', 'coord27@dralirashid.com', 'coordinator'),
  (:acct,   'Accountant', 'acct27@dralirashid.com', 'accountant'),
  (:viewer, 'Accountant without patient files', 'viewer27@dralirashid.com', 'accountant'),
  (:noedit, 'Front desk without list editing', 'noedit27@dralirashid.com', 'front_desk');
update public.staff set restrict_to_branches = true, branch_ids = array[(select id from public.branches where code = 'NN')] where id = :fd;
-- This accountant may open the lists but not the patient files.
insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (:viewer, 'patients.view', false);
-- This front desk may register patients but has "Add and edit Aaj ki List entries" turned off.
insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (:noedit, 'sheet.edit', false);
-- A patient with a portal login (a signed-in user who is not staff), and two patient files for the link tests.
insert into public.patients (full_name, phone, portal_user_id) values ('Portal Person (sample)', '03005550999', :portal);
insert into public.patients (mr_number, full_name, phone) values ('27001', 'Sample Existing One', '03005550801'), ('27002', 'Sample Existing Two', '03005550802');

-- 1. The keys: the same strings the website's own copy (web/js/lib/checkups.js) must give.
do $$
begin
  perform pg_temp.check(private.checkup_key('0300-5550142', '  Sample   Person ', '2024-12-01') = '03005550142|sample person|202412', 'key: phone, name and month are normalised');
  perform pg_temp.check(private.checkup_phone('+923005550142') = '03005550142', 'phone: +92 form');
  perform pg_temp.check(private.checkup_phone('3005550142') = '03005550142', 'phone: ten digits starting with 3 get the leading 0');
  perform pg_temp.check(private.checkup_phone('0300 5550142') = '03005550142' and private.checkup_phone('(0300) 555-0142') = '03005550142', 'phone: spaces and punctuation are ignored');
  perform pg_temp.check(private.checkup_phone('12345') is null and private.checkup_phone('123456') is null and private.checkup_phone(null) is null and private.checkup_phone('') is null,
    'phone: fewer than 7 digits is not a number');
  perform pg_temp.check(private.checkup_phone('1234567') = '1234567', 'phone: 7 digits are kept as they are');
  perform pg_temp.check(private.checkup_phone('92300555014') = '92300555014', 'phone: 11 digits starting with 92 are kept as they are');
  perform pg_temp.check(private.checkup_key(null, 'A B', null) = '|a b|', 'key: no phone and no date');
  perform pg_temp.check(private.checkup_key('03005550142', 'SAMPLE person', '2024-12-31') = private.checkup_key('+92 300 5550142', E'sample\tPERSON', '2024-12-01'),
    'key: the same person and month give the same key whatever the day, case, spacing and phone form');
  perform pg_temp.check(private.checkup_key('03005550142', 'Sample Person', '2024-11-30') <> private.checkup_key('03005550142', 'Sample Person', '2024-12-01'), 'key: another month is another key');
  perform pg_temp.check(private.checkup_key('03005550143', 'Sample Person', '2024-12-01') <> private.checkup_key('03005550142', 'Sample Person', '2024-12-01'), 'key: another phone is another key');
  perform pg_temp.check(private.checkup_key('03005550142', 'Sample Persons', '2024-12-01') <> private.checkup_key('03005550142', 'Sample Person', '2024-12-01'), 'key: another name is another key');
  perform pg_temp.check(private.checkup_text(chr(8212), 10) is null and private.checkup_text(chr(8211) || ' ', 10) is null and private.checkup_text(' - ', 10) is null
    and private.checkup_text('', 10) is null and private.checkup_text(null, 10) is null, 'cell cleaning: empty and dash-only cells are null');
  perform pg_temp.check(private.checkup_text('  hello world ', 5) = 'hello' and private.checkup_text(E'\t x \n', 5) = 'x', 'cell cleaning: trimmed and cut to the limit');
  perform pg_temp.check(private.checkup_text('a-b', 5) = 'a-b', 'cell cleaning: a dash inside text stays');
end $$;

-- 2. The grants as they stand: the list is for signed-in staff only, the three functions are not for the public, private stays private.
do $$
begin
  perform pg_temp.check(has_table_privilege('authenticated', 'public.checkup_list', 'select') and not has_table_privilege('authenticated', 'public.checkup_list', 'insert')
    and not has_table_privilege('authenticated', 'public.checkup_list', 'update') and not has_table_privilege('authenticated', 'public.checkup_list', 'delete'), 'grants: signed-in staff may only read the checkup list');
  perform pg_temp.check(not has_table_privilege('anon', 'public.checkup_list', 'select') and not has_table_privilege('anon', 'public.checkups', 'select'), 'grants: the public has no access to the list or the table');
  perform pg_temp.check(not has_function_privilege('anon', 'public.import_checkups(jsonb, boolean)', 'execute') and has_function_privilege('authenticated', 'public.import_checkups(jsonb, boolean)', 'execute')
    and not has_function_privilege('anon', 'public.register_checkup_as_patient(uuid)', 'execute') and has_function_privilege('authenticated', 'public.register_checkup_as_patient(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.link_checkup_to_patient(uuid, uuid)', 'execute') and has_function_privilege('authenticated', 'public.link_checkup_to_patient(uuid, uuid)', 'execute'),
    'grants: the three functions are for signed-in staff only');
  perform pg_temp.check(not has_function_privilege('authenticated', 'private.checkup_text(text, int)', 'execute') and not has_function_privilege('anon', 'private.checkup_text(text, int)', 'execute'),
    'grants: the import''s cell cleaner is not callable by staff or the public');
  perform pg_temp.check(has_function_privilege('authenticated', 'private.checkup_key(text, text, date)', 'execute') and has_function_privilege('authenticated', 'private.checkup_phone(text)', 'execute'),
    'grants: the key functions stay callable (the unique index and the view call them as the signed-in role)');
  perform pg_temp.check(not has_schema_privilege('authenticated', 'private', 'usage') and not has_schema_privilege('anon', 'private', 'usage'), 'grants: staff and the public have no USAGE on schema private');
end $$;

-- 2b. Private stays private; the desk cannot call the key functions by name, but the view and the index still work for it.
set role authenticated;
select pg_temp.act_as(:fd);
select pg_temp.expect_error($$select private.checkup_phone('0300-5550101')$$, 'permission denied', 'a signed-in user cannot call private.checkup_phone by name');
select pg_temp.expect_error($$select private.checkup_text('x', 5)$$, 'permission denied', 'a signed-in user cannot call private.checkup_text by name');

-- 3. A front desk limited to North Nazimabad.
do $$
declare
  v_fd text := current_setting('test.fd'); v_admin text := current_setting('test.admin');
  v_nn smallint := current_setting('test.nn')::smallint; v_gul smallint := current_setting('test.gul')::smallint;
  n int; s text;
begin
  perform pg_temp.act_as(v_fd);
  insert into public.checkups (checkup_date, branch_id, patient_name, phone, checkup_for, day_status)
    values ('2026-10-09', v_nn, 'Sample Walkin NN', '0300-555 0001', 'Checkup', 'waiting');
  perform pg_temp.check(exists (select 1 from public.checkups where patient_name = 'Sample Walkin NN' and source = 'website' and not date_is_month and follow_up = 'Not Contacted' and created_by = v_fd::uuid),
    'front desk: adds a website checkup at their own branch (source website, follow-up Not Contacted, created_by set)');
  perform pg_temp.expect_error(format('insert into public.checkups (checkup_date, branch_id, patient_name) values (''2026-10-09'', %s, ''Sample Walkin GUL'')', v_gul),
    'row-level security', 'front desk: cannot add a checkup at another branch');
  perform pg_temp.expect_state('insert into public.checkups (checkup_date, patient_name, source) values (''2026-10-09'', ''Sample Odd'', ''spreadsheet'')',
    '42501', 'NOT_ALLOWED', 'front desk: a source other than website is refused (the guard answers before the table''s own check)');

  -- The admin adds one at Gulshan and one with no branch.
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect_error('insert into public.checkups (checkup_date, patient_name, source) values (''2026-10-09'', ''Sample Odd'', ''spreadsheet'')',
    'checkups_source_check', 'a source other than website / google_sheet / archive is refused by the table itself');
  insert into public.checkups (checkup_date, branch_id, patient_name, phone, checkup_for, day_status)
    values ('2026-10-09', v_gul, 'Sample Walkin GUL', '0300-555 0002', 'Checkup', 'waiting');
  insert into public.checkups (checkup_date, branch_id, patient_name, phone, checkup_for)
    values ('2026-10-08', null, 'Sample Nobranch Website', '0300-555 0003', 'Checkup');

  perform pg_temp.act_as(v_fd);
  select count(*) into n from public.checkup_list where branch_id = v_gul;
  perform pg_temp.check(n = 0, 'front desk: sees no Gulshan checkup in the list');
  select count(*) into n from public.checkups where branch_id = v_gul;
  perform pg_temp.check(n = 0, 'front desk: sees no Gulshan checkup in the table either');
  perform pg_temp.check(exists (select 1 from public.checkup_list where patient_name = 'Sample Walkin NN')
    and exists (select 1 from public.checkup_list where patient_name = 'Sample Nobranch Website'), 'front desk: sees their branch and the rows with no branch');
  select phone_key into s from public.checkup_list where patient_name = 'Sample Walkin NN';
  perform pg_temp.check(s = '03005550001', 'checkup_list: phone_key of "0300-555 0001" is 03005550001 (searchable however the phone was written)');
  perform pg_temp.check((select mr_number from public.checkup_list where patient_name = 'Sample Walkin NN') is null, 'checkup_list: no Mr# before a patient file exists');
end $$;

-- 3b. Anyone who is not staff sees nothing: a patient login, the public (anon), and an accountant may read but not change.
do $$
declare
  v_portal text := current_setting('test.portal'); v_acct text := current_setting('test.acct');
  v_nn smallint := current_setting('test.nn')::smallint;
  n int; v_id uuid;
begin
  perform pg_temp.act_as(v_portal);
  select count(*) into n from public.checkups;
  perform pg_temp.check(n = 0, 'patient login: sees no checkup row in the table');
  select count(*) into n from public.checkup_list;
  perform pg_temp.check(n = 0, 'patient login: sees no checkup row in the list');
  perform pg_temp.expect_error(format('insert into public.checkups (checkup_date, branch_id, patient_name) values (''2026-10-09'', %s, ''Sample Portal Try'')', v_nn),
    'row-level security', 'patient login: cannot add a checkup');
  perform pg_temp.expect_state('select public.import_checkups(''[]''::jsonb)', '42501', 'NOT_ALLOWED', 'patient login: cannot import the checkup list');
  perform pg_temp.expect_state('select public.register_checkup_as_patient(gen_random_uuid())', '42501', 'NOT_ALLOWED', 'patient login: cannot register a patient from a checkup');
  perform pg_temp.expect_state('select public.link_checkup_to_patient(gen_random_uuid(), gen_random_uuid())', '42501', 'NOT_ALLOWED', 'patient login: cannot link a checkup');

  perform pg_temp.act_as(v_acct);
  select count(*) into n from public.checkup_list;
  perform pg_temp.check(n >= 3, 'accountant: may read the checkup list');
  select id into v_id from public.checkups where patient_name = 'Sample Walkin NN';
  update public.checkups set notes = 'accountant note' where id = v_id;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0, 'accountant (no "add and edit Aaj ki List entries"): an update reaches no row');
  perform pg_temp.expect_error(format('insert into public.checkups (checkup_date, branch_id, patient_name) values (''2026-10-09'', %s, ''Sample Acct Try'')', v_nn),
    'row-level security', 'accountant: cannot add a checkup');
  perform pg_temp.expect_state('select public.import_checkups(''[]''::jsonb)', '42501', 'NOT_ALLOWED', 'accountant: cannot import the checkup list');
  perform pg_temp.expect_state(format('select public.register_checkup_as_patient(%L)', v_id), '42501', 'NOT_ALLOWED', 'accountant: registering a patient needs the "Register new patients" right');
  perform pg_temp.expect_state(format('select public.link_checkup_to_patient(%L, gen_random_uuid())', v_id), '42501', 'NOT_ALLOWED', 'accountant: linking needs "Add and edit Aaj ki List entries"');
end $$;
reset role;
set role anon;
select pg_temp.expect_error($$select count(*) from public.checkups$$, 'permission denied', 'anon: cannot read the checkups table');
select pg_temp.expect_error($$select count(*) from public.checkup_list$$, 'permission denied', 'anon: cannot read the checkup list');
select pg_temp.expect_error($$select public.import_checkups('[]'::jsonb)$$, 'permission denied', 'anon: cannot run the import');
select pg_temp.expect_error($$select public.register_checkup_as_patient(gen_random_uuid())$$, 'permission denied', 'anon: cannot register a patient from a checkup');
select pg_temp.expect_error($$select public.link_checkup_to_patient(gen_random_uuid(), gen_random_uuid())$$, 'permission denied', 'anon: cannot link a checkup');
reset role;

-- 4. import_checkups
set role authenticated;
-- A work table of the same name that somebody else left in this database connection is never the one the import uses.
create temp table checkup_import (not_ours int);
do $$
declare
  v_admin text := current_setting('test.admin'); v_fd text := current_setting('test.fd');
  v_nn smallint := current_setting('test.nn')::smallint; v_gul smallint := current_setting('test.gul')::smallint;
  rows4 jsonb; r jsonb; extra jsonb; c record; n int; big jsonb;
begin
  perform pg_temp.act_as(v_fd);
  perform pg_temp.expect_state('select public.import_checkups(''[]''::jsonb)', '42501', 'NOT_ALLOWED', 'front desk: cannot import the checkup list');

  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect_state('select public.import_checkups(''{"a":1}''::jsonb)', '22023', 'BAD_ROWS', 'a JSON object instead of a list is refused');
  perform pg_temp.expect_state('select public.import_checkups(null)', '22023', 'BAD_ROWS', 'null instead of a list is refused');
  perform pg_temp.expect_state($q$select public.import_checkups((select jsonb_agg(jsonb_build_object('name', 'Sample Over ' || g)) from generate_series(1, 501) g))$q$,
    '22023', 'TOO_MANY_ROWS', '501 rows in one call are refused');
  perform pg_temp.check(not exists (select 1 from public.checkups where patient_name like 'Sample Over%'), 'the refused call stored nothing');

  -- Four made-up rows: Gulshan, North Nazimabad, no branch, and no month.
  rows4 := jsonb_build_array(
    jsonb_set(pg_temp.wire(5, '2024-12-01', 'Sample Alpha', '0300-5550101', 'GUL', 'Follow-up Sent', 'called twice'), '{doctors}', '"Dr. Ali Rashid, Dr. Sample (sample)"'),
    pg_temp.wire(6, '2025-03-01', 'Sample Bravo', '0300-5550102', 'NN', 'Interested'),
    pg_temp.wire(7, '2025-06-01', 'Sample Charlie', '0300-5550103', null),
    pg_temp.wire(8, null, 'Sample Delta', '0300-5550104', 'NN'));
  r := public.import_checkups(rows4);
  perform pg_temp.check((r->>'given')::int = 4 and (r->>'inserted')::int = 4 and (r->>'updated')::int = 0 and (r->>'unchanged')::int = 0 and (r->>'kept')::int = 0
    and (r->>'skipped_count')::int = 0 and r->'skipped' = '[]'::jsonb, 'import: four new rows are inserted, nothing else happens');
  select * into c from public.checkups where patient_name = 'Sample Alpha';
  perform pg_temp.check(c.source = 'archive' and c.date_is_month and c.checkup_date = '2024-12-01' and c.branch_id = v_gul and c.phone = '0300-5550101' and c.city = 'Karachi'
    and c.doctors = 'Dr. Ali Rashid, Dr. Sample (sample)' and c.checkup_for = 'Scaling' and c.est_fee = 8000 and c.follow_up = 'Follow-up Sent' and c.notes = 'called twice'
    and c.source_tab = 'Sample tab A' and c.day_status is null and c.token is null and c.details is null and c.sheet_key is null and c.patient_id is null,
    'import: the row is stored as an old-list row (month only, branch by code, phone as written, no day status, token or details)');
  perform pg_temp.check((select branch_id from public.checkups where patient_name = 'Sample Bravo') = v_nn
    and (select branch_id from public.checkups where patient_name = 'Sample Charlie') is null
    and (select checkup_date from public.checkups where patient_name = 'Sample Delta') is null
    and (select date_is_month from public.checkups where patient_name = 'Sample Delta'), 'import: the NN row, the row with no branch and the row with no month are stored');

  perform pg_temp.check(exists (select 1 from pg_attribute att join pg_class rel on rel.oid = att.attrelid where rel.relname = 'checkup_import' and rel.relpersistence = 't' and att.attname = 'rn' and not att.attisdropped)
    and not exists (select 1 from pg_attribute att join pg_class rel on rel.oid = att.attrelid where rel.relname = 'checkup_import' and rel.relpersistence = 't' and att.attname = 'not_ours'),
    'import: a work table of the same name left by somebody else was replaced, not used');

  -- The same call again changes nothing (idempotent).
  r := public.import_checkups(rows4);
  perform pg_temp.check((r->>'inserted')::int = 0 and (r->>'unchanged')::int = 4 and (r->>'updated')::int = 0 and (r->>'kept')::int = 0, 'import: the same rows again add nothing and change nothing');
  select count(*) into n from public.checkups where source = 'archive' and patient_name in ('Sample Alpha', 'Sample Bravo', 'Sample Charlie', 'Sample Delta');
  perform pg_temp.check(n = 4, 'import: still one row per person after the second call');

  -- A row without a name, and the same person and month twice in one call (written differently).
  extra := rows4 || jsonb_build_array(
    pg_temp.wire(9, '2025-01-01', chr(8212), '0300-5550199', 'NN'),
    pg_temp.wire(10, '2025-01-01', null, '0300-5550198', 'NN'),
    pg_temp.wire(11, '2024-12-15', '  SAMPLE   alpha ', '+92 300 5550101', 'GUL', 'Completed'));
  r := public.import_checkups(extra);
  perform pg_temp.check((r->>'given')::int = 7 and (r->>'inserted')::int = 0 and (r->>'unchanged')::int = 4 and (r->>'skipped_count')::int = 3, 'import: three rows skipped and counted, the rest unchanged');
  perform pg_temp.check(r->'skipped' = '[{"row": 9, "reason": "No patient name"}, {"row": 10, "reason": "No patient name"}, {"row": 11, "reason": "Same person and month as row 5"}]'::jsonb,
    'import: skipped rows are listed with their row number and a reason');
  perform pg_temp.check((select count(*) from public.checkups where lower(patient_name) like '%alpha%' and source = 'archive') = 1, 'import: the same key twice in one call stays one row');

  -- Dirty cells never fail the batch.
  r := public.import_checkups(jsonb_build_array(
    jsonb_build_object('row', 20, 'month', '2025-13-01', 'name', '  Sample Echo  ', 'phone', chr(8212), 'city', chr(8212), 'branch', 'XXX', 'doctors', '-', 'checkup_for', chr(8211),
      'est_fee', -5, 'follow_up', '', 'notes', repeat('n', 2500), 'source_tab', repeat('t', 300)),
    jsonb_build_object('row', 21, 'month', '2025-02-30', 'name', 'Sample Foxtrot', 'phone', '0300-5550106', 'branch', 'nn', 'est_fee', 1234.567, 'follow_up', repeat('f', 80), 'unknown_key', 'ignored'),
    jsonb_build_object('row', 22, 'month', '2025-02-01', 'name', 'Sample Golf', 'phone', '0300-5550107', 'est_fee', '8000'),
    jsonb_build_object('row', 23, 'month', 45627, 'name', 'Sample Hotel', 'phone', '0300-5550108', 'est_fee', 1e30),
    jsonb_build_object('row', 'x', 'month', '0000-01-01', 'name', 'Sample India', 'phone', '0300-5550109'),
    to_jsonb('just a string'::text), to_jsonb(5), 'null'::jsonb));
  perform pg_temp.check((r->>'given')::int = 8 and (r->>'inserted')::int = 5 and (r->>'skipped_count')::int = 3, 'import: bad cells and bad elements do not fail the batch (5 stored, the 3 non-objects skipped)');
  select * into c from public.checkups where patient_name = 'Sample Echo';
  perform pg_temp.check(c.id is not null and c.phone is null and c.city is null and c.branch_id is null and c.doctors is null and c.checkup_for is null and c.est_fee is null
    and c.follow_up = 'Not Contacted' and length(c.notes) = 2000 and length(c.source_tab) = 120 and c.checkup_date is null and c.date_is_month,
    'import: dash-only cells are empty, long text is cut (note to 2000), a fee below 0 and an unknown branch are dropped, an impossible month is "no month"');
  select * into c from public.checkups where patient_name = 'Sample Foxtrot';
  perform pg_temp.check(c.est_fee = 1234.57 and c.branch_id = v_nn and c.checkup_date = '2025-02-01' and length(c.follow_up) = 60 and c.phone = '0300-5550106',
    'import: fee rounded to 2 places, branch code in lower case accepted, 2025-02-30 stored as the month 2025-02-01, status cut to 60');
  perform pg_temp.check((select est_fee from public.checkups where patient_name = 'Sample Golf') is null, 'import: a fee given as text is not a number, so no fee');
  perform pg_temp.check((select est_fee from public.checkups where patient_name = 'Sample Hotel') is null and (select checkup_date from public.checkups where patient_name = 'Sample Hotel') is null,
    'import: a fee too large and a month that is not text are dropped');
  perform pg_temp.check((select checkup_date from public.checkups where patient_name = 'Sample India') is null, 'import: year 0000 is "no month"');
  perform pg_temp.check(r->'skipped' = '[{"row": 6, "reason": "No patient name"}, {"row": 7, "reason": "No patient name"}, {"row": 8, "reason": "No patient name"}]'::jsonb,
    'import: an element that is not an object is skipped with its position as the row number');

  -- 200 made-up rows: dash cells, month-only dates, rows without a month, unknown clinics. Twice: the second call adds nothing.
  big := (select jsonb_agg(jsonb_build_object('row', g + 4, 'month',
            case when g % 9 = 0 then null when g % 11 = 0 then 'Not recorded' else to_char(date '2024-10-01' + ((g % 25) || ' months')::interval, 'YYYY-MM-DD') end,
            'name', 'Sample Bulk ' || g, 'phone', case when g % 13 = 0 then null else '0300-555' || lpad(g::text, 4, '0') end,
            'city', case when g % 5 = 0 then chr(8212) else 'Karachi' end,
            'branch', case when g % 7 = 0 then 'XXX' else (array['GUL', 'NN', 'DHA', 'LHR', 'ISB'])[1 + g % 5] end,
            'doctors', case when g % 3 = 0 then chr(8212) else 'Dr. Sample (sample)' end,
            'checkup_for', 'Checkup', 'est_fee', case when g % 17 = 0 then 8000 else null end,
            'follow_up', (array['Not Contacted', 'Follow-up Sent', 'No Response', 'Interested', 'Scheduled', 'Started', 'Completed', 'Did Not Come', 'Not Interested', 'Referred', 'Not Recorded'])[1 + g % 11],
            'notes', case when g % 4 = 0 then 'note ' || g end, 'source_tab', 'Sample tab ' || (g % 3)) order by g)
          from generate_series(1, 200) g);
  r := public.import_checkups(big);
  perform pg_temp.check((r->>'given')::int = 200 and (r->>'inserted')::int = 200 and (r->>'skipped_count')::int = 0, 'import 200 rows: all inserted');
  perform pg_temp.check((select count(*) from public.checkups where patient_name like 'Sample Bulk %') = 200, 'import 200 rows: 200 rows on the website');
  perform pg_temp.check((select count(*) from public.checkups where patient_name like 'Sample Bulk %' and branch_id is null) = (select count(*) from generate_series(1, 200) g where g % 7 = 0),
    'import 200 rows: exactly the unknown clinics have no branch');
  perform pg_temp.check((select count(*) from public.checkups where patient_name like 'Sample Bulk %' and checkup_date is null) = (select count(*) from generate_series(1, 200) g where g % 9 = 0 or g % 11 = 0),
    'import 200 rows: exactly the rows without a valid month have no month');
  perform pg_temp.check((select count(*) from public.checkups where patient_name like 'Sample Bulk %' and city is null) = (select count(*) from generate_series(1, 200) g where g % 5 = 0),
    'import 200 rows: dash cities are empty');
  r := public.import_checkups(big);
  perform pg_temp.check((r->>'inserted')::int = 0 and (r->>'updated')::int = 0 and (r->>'kept')::int = 0 and (r->>'unchanged')::int = 200 and (r->>'skipped_count')::int = 0,
    'import 200 rows again: nothing added, nothing changed, 200 already there');
  perform pg_temp.check((select count(*) from public.checkups where patient_name like 'Sample Bulk %') = 200, 'import 200 rows again: still 200 rows');

  -- given = inserted + updated + unchanged + kept + skipped, whatever the mix.
  r := public.import_checkups(big || jsonb_build_array(pg_temp.wire(300, '2025-01-01', 'Sample Fresh', '0300-5550200', 'NN'), pg_temp.wire(301, '2025-01-01', null, null, null)));
  perform pg_temp.check((r->>'given')::int = (r->>'inserted')::int + (r->>'updated')::int + (r->>'unchanged')::int + (r->>'kept')::int + (r->>'skipped_count')::int
    and (r->>'inserted')::int = 1 and (r->>'skipped_count')::int = 1, 'import: the counts always add up to the rows given');

  -- Exactly 500 rows are accepted.
  big := (select jsonb_agg(jsonb_build_object('row', g, 'month', '2025-05-01', 'name', 'Sample Max ' || g, 'phone', '0300-556' || lpad(g::text, 4, '0'), 'branch', 'LHR') order by g) from generate_series(1, 500) g);
  r := public.import_checkups(big);
  perform pg_temp.check((r->>'inserted')::int = 500, 'import: exactly 500 rows are accepted in one call');
  r := public.import_checkups(big);
  perform pg_temp.check((r->>'inserted')::int = 0 and (r->>'unchanged')::int = 500, 'import: 500 rows again add nothing');

  -- Only the first 100 skipped rows are listed; the count is complete.
  big := (select jsonb_agg(jsonb_build_object('row', g, 'name', chr(8212), 'phone', '0300-5550000') order by g) from generate_series(1, 150) g);
  r := public.import_checkups(big);
  perform pg_temp.check(jsonb_array_length(r->'skipped') = 100 and (r->>'skipped_count')::int = 150 and (r->>'inserted')::int = 0, 'import: 150 skipped rows are counted, the first 100 are listed');
  perform pg_temp.check((r->'skipped'->0->>'row')::int = 1 and (r->'skipped'->99->>'row')::int = 100, 'import: the listed skipped rows are the first ones, in order');
end $$;

-- 5. Fill versus overwrite, and what the desk may change on an old-list row.
do $$
declare
  v_admin text := current_setting('test.admin'); v_fd text := current_setting('test.fd');
  v_nn smallint := current_setting('test.nn')::smallint; v_gul smallint := current_setting('test.gul')::smallint;
  r jsonb; c record; n int; v_id uuid; v_updated timestamptz;
begin
  perform pg_temp.act_as(v_admin);
  -- The website still says "Not Contacted" and has no notes: the file's status and notes are taken.
  r := public.import_checkups(jsonb_build_array(pg_temp.wire(7, '2025-06-01', 'Sample Charlie', '0300-5550103', null, 'Interested', 'asked about the price')));
  perform pg_temp.check((r->>'updated')::int = 1 and (r->>'kept')::int = 0 and (r->>'inserted')::int = 0 and (r->>'unchanged')::int = 0, 'fill: where the website says Not Contacted and has no note, the file is taken (updated)');
  select * into c from public.checkups where patient_name = 'Sample Charlie';
  perform pg_temp.check(c.follow_up = 'Interested' and c.notes = 'asked about the price', 'fill: status and notes are now the file''s');
  r := public.import_checkups(jsonb_build_array(pg_temp.wire(7, '2025-06-01', 'Sample Charlie', '0300-5550103', null, 'Interested', 'asked about the price')));
  perform pg_temp.check((r->>'unchanged')::int = 1 and (r->>'updated')::int = 0 and (r->>'kept')::int = 0, 'fill: the same file again changes nothing');
  -- A blank note on the website counts as empty.
  update public.checkups set notes = '   ' where patient_name = 'Sample Delta';
  r := public.import_checkups(jsonb_build_array(pg_temp.wire(8, null, 'Sample Delta', '0300-5550104', 'NN', 'Not Contacted', 'filled from file')));
  perform pg_temp.check((r->>'updated')::int = 1 and (select notes from public.checkups where patient_name = 'Sample Delta') = 'filled from file', 'fill: a blank website note is replaced by the file''s note');

  -- Work done on the website is kept: the desk set "Interested" and a note on Bravo (North Nazimabad).
  perform pg_temp.act_as(v_fd);
  -- (the phone is rewritten too, as the Edit dialog would: that evaluates the unique key of the old list as the desk's role)
  update public.checkups set follow_up = 'Interested', notes = 'call back Monday', phone = '0300 555 0102' where patient_name = 'Sample Bravo' and source = 'archive';
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'front desk: can change the follow-up status and notes of an old-list row at their branch (the private key function works in the index for them)');
  perform pg_temp.act_as(v_admin);
  select updated_at into v_updated from public.checkups where patient_name = 'Sample Bravo';
  r := public.import_checkups(jsonb_build_array(pg_temp.wire(6, '2025-03-01', 'Sample Bravo', '0300-5550102', 'NN', 'No Response', 'file note')));
  perform pg_temp.check((r->>'kept')::int = 1 and (r->>'updated')::int = 0 and (r->>'unchanged')::int = 0, 'fill: a different status and note in the file are NOT taken over the desk''s (kept)');
  select * into c from public.checkups where patient_name = 'Sample Bravo';
  perform pg_temp.check(c.follow_up = 'Interested' and c.notes = 'call back Monday' and c.updated_at = v_updated, 'fill: the database still has the desk''s status and note (row not touched)');
  -- The file is newer: overwrite.
  r := public.import_checkups(jsonb_build_array(pg_temp.wire(6, '2025-03-01', 'Sample Bravo', '0300-5550102', 'NN', 'No Response', 'file note')), true);
  perform pg_temp.check((r->>'updated')::int = 1 and (r->>'kept')::int = 0, 'overwrite: the file wins (updated)');
  select * into c from public.checkups where patient_name = 'Sample Bravo';
  perform pg_temp.check(c.follow_up = 'No Response' and c.notes = 'file note', 'overwrite: status and note are the file''s');
  -- An empty note in the file never wipes a note.
  perform pg_temp.act_as(v_fd);
  update public.checkups set notes = 'second desk note' where patient_name = 'Sample Bravo' and source = 'archive';
  perform pg_temp.act_as(v_admin);
  r := public.import_checkups(jsonb_build_array(pg_temp.wire(6, '2025-03-01', 'Sample Bravo', '0300-5550102', 'NN', 'Completed', null)), true);
  perform pg_temp.check((r->>'updated')::int = 1, 'overwrite with an empty file note: the status is updated');
  select * into c from public.checkups where patient_name = 'Sample Bravo';
  perform pg_temp.check(c.follow_up = 'Completed' and c.notes = 'second desk note', 'overwrite with an empty file note: the website note stays');
  r := public.import_checkups(jsonb_build_array(pg_temp.wire(6, '2025-03-01', 'Sample Bravo', '0300-5550102', 'NN', 'Completed', null)), true);
  perform pg_temp.check((r->>'unchanged')::int = 1 and (r->>'updated')::int = 0, 'overwrite: the same file again changes nothing');

  -- Nothing but the status and the notes is ever touched on a matched row (even when the file says otherwise).
  r := public.import_checkups(jsonb_build_array(
    jsonb_build_object('row', 5, 'month', '2024-12-01', 'name', 'Sample Alpha', 'phone', '0300-5550101', 'branch', 'NN', 'city', 'Lahore', 'doctors', 'Someone Else', 'checkup_for', 'Different',
      'est_fee', 99999, 'follow_up', 'Completed', 'notes', 'another note', 'source_tab', 'Other tab')), true);
  perform pg_temp.check((r->>'updated')::int = 1, 'overwrite: the matched row is updated');
  select * into c from public.checkups where patient_name = 'Sample Alpha';
  perform pg_temp.check(c.branch_id = v_gul and c.city = 'Karachi' and c.doctors = 'Dr. Ali Rashid, Dr. Sample (sample)' and c.checkup_for = 'Scaling' and c.est_fee = 8000 and c.source_tab = 'Sample tab A'
    and c.phone = '0300-5550101' and c.checkup_date = '2024-12-01' and c.follow_up = 'Completed' and c.notes = 'another note',
    'overwrite: branch, city, doctors, treatment, fee, tab, phone and month of the existing row are not touched');

  -- Deleting: the desk may remove its own website rows, never an old-list row; the admin may remove either.
  perform pg_temp.act_as(v_admin);
  perform public.import_checkups(jsonb_build_array(pg_temp.wire(30, '2025-07-01', 'Sample Zulu', '0300-5550301', 'NN')));
  perform pg_temp.act_as(v_fd);
  delete from public.checkups where patient_name = 'Sample Zulu';
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0, 'front desk: cannot delete an old-list row');
  delete from public.checkups where patient_name = 'Sample Walkin GUL';
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0, 'front desk: cannot delete a row of another branch (not even visible)');
  insert into public.checkups (checkup_date, branch_id, patient_name, phone) values ('2026-10-09', v_nn, 'Sample Wrong Entry', '0300-5550302');
  delete from public.checkups where patient_name = 'Sample Wrong Entry';
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'front desk: can remove a wrong entry of the day (a website row at their branch)');
  perform pg_temp.act_as(v_admin);
  delete from public.checkups where patient_name = 'Sample Zulu';
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'admin: can delete an old-list row');
  perform pg_temp.check((select count(*) from public.checkups where patient_name = 'Sample Zulu') = 0, 'admin: the old-list row is gone');
  -- ... and it is added again by the next import of the same file (the known limit the Remove dialog warns about).
  r := public.import_checkups(jsonb_build_array(pg_temp.wire(30, '2025-07-01', 'Sample Zulu', '0300-5550301', 'NN')));
  perform pg_temp.check((r->>'inserted')::int = 1, 'a removed old-list row comes back with the next import of the same file');
end $$;

-- 6. The unique key of the old list.
do $$
declare v_admin text := current_setting('test.admin'); v_nn smallint := current_setting('test.nn')::smallint; r jsonb;
begin
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect_state(format('insert into public.checkups (checkup_date, date_is_month, branch_id, patient_name, phone, source) values (''2024-12-15'', true, %s, ''SAMPLE   alpha'', ''+92 300 5550101'', ''archive'')', v_nn),
    '23505', 'checkups_archive_key_idx', 'a second old-list row for the same person and month is refused by the database');
  insert into public.checkups (checkup_date, branch_id, patient_name, phone, source) values ('2024-12-15', v_nn, 'SAMPLE   alpha', '+92 300 5550101', 'website');
  insert into public.checkups (checkup_date, branch_id, patient_name, phone, source, sheet_key) values ('2024-12-20', v_nn, 'Sample Alpha', '0300-5550101', 'google_sheet', 'S-test2700001');
  perform pg_temp.check((select count(*) from public.checkups where lower(btrim(patient_name)) like '%alpha%' and regexp_replace(phone, '[^0-9]', '', 'g') in ('03005550101', '923005550101')) = 3,
    'a website row and a sheet row for the same person and month are allowed next to the old-list row');
  delete from public.checkups where source <> 'archive' and lower(btrim(patient_name)) like '%alpha%';

  -- The import only looks at old-list rows: a person who is on the website alone for that month still gets their old-list row.
  insert into public.checkups (checkup_date, branch_id, patient_name, phone, source) values ('2025-04-10', v_nn, 'Sample Webonly', '0300-5550501', 'website');
  r := public.import_checkups(jsonb_build_array(pg_temp.wire(40, '2025-04-01', 'Sample Webonly', '0300-5550501', 'NN', 'Interested', 'from the file')));
  perform pg_temp.check((r->>'inserted')::int = 1 and (r->>'updated')::int = 0 and (r->>'unchanged')::int = 0 and (r->>'kept')::int = 0,
    'import: a website row of the same person and month is not the old-list row (the old-list row is added next to it)');
  perform pg_temp.check((select count(*) from public.checkups where patient_name = 'Sample Webonly') = 2
    and exists (select 1 from public.checkups where patient_name = 'Sample Webonly' and source = 'website' and follow_up = 'Not Contacted' and notes is null),
    'import: the website row of that person is left as it was');
end $$;

-- 6b. Two imports at the same moment. A stand-in trigger plays the other import: when this import writes "Sample Race", the
--     other one has just added the same person and month. The unique key must make this import skip it, without an error.
reset role;
create function public.zz_checkup_race() returns trigger language plpgsql as $$
begin
  if pg_trigger_depth() = 1 and new.patient_name = 'Sample Race' then
    insert into public.checkups (checkup_date, date_is_month, patient_name, phone, source, follow_up)
    values (new.checkup_date, true, new.patient_name, new.phone, 'archive', 'Interested');
  end if;
  return new;
end $$;
create trigger zz_checkup_race before insert on public.checkups for each row execute function public.zz_checkup_race();
set role authenticated;
do $$
declare r jsonb;
begin
  perform pg_temp.act_as(current_setting('test.admin'));
  r := public.import_checkups(jsonb_build_array(pg_temp.wire(50, '2025-05-01', 'Sample Race', '0300-5550601', 'NN', 'Follow-up Sent'),
                                                pg_temp.wire(51, '2025-05-01', 'Sample After Race', '0300-5550602', 'NN')));
  perform pg_temp.check((r->>'given')::int = 2 and (r->>'inserted')::int = 1 and (r->>'unchanged')::int = 1 and (r->>'updated')::int = 0 and (r->>'kept')::int = 0,
    'two imports at once: the row the other import added first is "already there", the rest is inserted, no error');
  perform pg_temp.check((select count(*) from public.checkups where patient_name = 'Sample Race') = 1
    and (select follow_up from public.checkups where patient_name = 'Sample Race') = 'Interested', 'two imports at once: one row for that person, the first import''s');
end $$;
reset role;
drop trigger zz_checkup_race on public.checkups;
drop function public.zz_checkup_race();
set role authenticated;

-- 7. Register a checkup patient as a patient (Mr# from the normal counter) and link to an existing patient file.
do $$
declare
  v_admin text := current_setting('test.admin'); v_fd text := current_setting('test.fd'); v_coord text := current_setting('test.coord');
  v_acct text := current_setting('test.acct'); v_viewer text := current_setting('test.viewer');
  v_nn smallint := current_setting('test.nn')::smallint; v_gul smallint := current_setting('test.gul')::smallint;
  v_gul_name text := current_setting('test.gul_name'); v_nn_name text := current_setting('test.nn_name');
  w1 uuid; w2 uuid; w3 uuid; w4 uuid; w5 uuid; w6 uuid; w7 uuid; w8 uuid; a1 uuid;
  r jsonb; p record; c record; n int; before_n int; v_ex1 uuid; v_ex2 uuid;
begin
  perform pg_temp.act_as(v_admin);
  insert into public.checkups (checkup_date, branch_id, patient_name, phone, city, checkup_for, day_status)
    values ('2026-10-09', v_nn, '  Sample   Reg One ', '0300-555 0201', 'karachi', 'Scaling', 'waiting') returning id into w1;
  insert into public.checkups (checkup_date, branch_id, patient_name, phone, checkup_for) values ('2026-10-09', v_gul, 'Sample Reg Gulshan', '0300-555 0202', 'Checkup') returning id into w2;
  insert into public.checkups (checkup_date, branch_id, patient_name, phone) values ('2026-10-09', v_nn, 'A', '0300-555 0203') returning id into w3;
  insert into public.checkups (checkup_date, branch_id, patient_name, phone) values ('2026-10-09', v_nn, 'Sample Short Phone', '123') returning id into w4;
  insert into public.checkups (checkup_date, branch_id, patient_name, phone, follow_up) values ('2026-10-09', v_nn, 'Sample Done Already', '0300-555 0205', 'Completed') returning id into w5;
  insert into public.checkups (checkup_date, branch_id, patient_name, phone) values (null, null, 'Sample No Date', '0300-555 0206') returning id into w6;
  insert into public.checkups (checkup_date, date_is_month, branch_id, patient_name, phone, checkup_for, source, follow_up)
    values ('2024-12-01', true, v_gul, 'Sample Old Month', '0300-555 0207', 'Braces checkup', 'archive', 'Started') returning id into w7;
  insert into public.checkups (checkup_date, branch_id, patient_name, phone, city) values ('2026-10-09', v_nn, 'Sample Other City', '0300-555 0208', 'Islamabad') returning id into w8;

  -- Who may.
  perform pg_temp.act_as(v_acct);
  perform pg_temp.expect_state(format('select public.register_checkup_as_patient(%L)', w1), '42501', 'NOT_ALLOWED', 'register: an accountant (no "Register new patients", no list editing) is refused');
  perform pg_temp.act_as(current_setting('test.noedit'));
  select count(*) into before_n from public.patients;
  perform pg_temp.expect_state(format('select public.register_checkup_as_patient(%L)', w1), '42501', 'NOT_ALLOWED: registering a patient needs "Register new patients" and "Add and edit Aaj ki List entries"',
    'register: "Register new patients" alone is not enough, the person must also be allowed to edit the list');
  perform pg_temp.check((select count(*) from public.patients) = before_n and (select patient_id from public.checkups where id = w1) is null and (select follow_up from public.checkups where id = w1) = 'Not Contacted',
    'register: the refused call created no patient file and did not touch the checkup');
  perform pg_temp.act_as(v_fd);
  perform pg_temp.expect_state(format('select public.register_checkup_as_patient(%L)', w2), 'P0002', 'NOT_FOUND', 'register: a checkup at another branch is "not on your list" for a limited front desk');
  perform pg_temp.expect_state('select public.register_checkup_as_patient(gen_random_uuid())', 'P0002', 'NOT_FOUND', 'register: an unknown checkup is "not on your list"');
  perform pg_temp.expect_state('select public.register_checkup_as_patient(null)', 'P0002', 'NOT_FOUND', 'register: no checkup given is "not on your list"');
  select count(*) into before_n from public.patients;

  -- The front desk registers the North Nazimabad checkup.
  r := public.register_checkup_as_patient(w1);
  perform pg_temp.check(r->>'mr_number' ~ '^[0-9]+$' and r->>'full_name' = 'Sample Reg One' and r->>'patient_id' is not null, 'register: the result holds a numeric Mr#, the cleaned name and the patient id');
  select * into p from public.patients where id = (r->>'patient_id')::uuid;
  perform pg_temp.check(p.mr_number = r->>'mr_number' and (select count(*) from public.patients where mr_number = p.mr_number) = 1, 'register: the Mr# is new and belongs to the new patient file');
  perform pg_temp.check(p.full_name = 'Sample Reg One' and p.phone = '03005550201' and p.first_branch_id = v_nn and p.city_id = (select id from public.cities where name = 'Karachi'),
    'register: the patient file has the name, the phone as digits, the checkup branch and the city');
  perform pg_temp.check(p.notes = 'From the checkup list: checkup 09 Oct 2026 at ' || v_nn_name || ', for Scaling', 'register: the note says where the file came from (' || p.notes || ')');
  perform pg_temp.check(p.created_by = v_fd::uuid, 'register: created_by is the person who clicked');
  select * into c from public.checkups where id = w1;
  perform pg_temp.check(c.patient_id = p.id and c.follow_up = 'Started', 'register: the checkup is linked and its follow-up becomes Started');
  perform pg_temp.check((select mr_number from public.checkup_list where id = w1) = p.mr_number, 'register: the checkup list now shows the Mr#');
  perform pg_temp.check((select count(*) from public.patients) = before_n + 1, 'register: exactly one patient file was added');
  perform pg_temp.expect_state(format('select public.register_checkup_as_patient(%L)', w1), '23505', 'ALREADY_REGISTERED: Sample Reg One already has a patient file (Mr# ' || p.mr_number || ')',
    'register: a second click is refused with the Mr# of the first');
  perform pg_temp.check((select count(*) from public.patients) = before_n + 1, 'register: the refused second call added no patient file');
  -- The next patient file gets the next number.
  r := public.register_checkup_as_patient(w5);
  perform pg_temp.check((r->>'mr_number')::bigint > p.mr_number::bigint, 'register: the next registration gets a higher Mr# from the same counter');
  perform pg_temp.check((select follow_up from public.checkups where id = w5) = 'Completed', 'register: a follow-up of Completed stays Completed');

  -- Name too short, phone too short, no branch and no date, other city, an old-list row (month only).
  perform pg_temp.act_as(v_coord);
  select count(*) into before_n from public.patients;
  perform pg_temp.expect_state(format('select public.register_checkup_as_patient(%L)', w3), '23514', 'NAME_TOO_SHORT', 'register: a one-letter name is refused with a plain message');
  perform pg_temp.check((select count(*) from public.patients) = before_n and (select patient_id from public.checkups where id = w3) is null, 'register: nothing was created for the short name');
  r := public.register_checkup_as_patient(w4);
  perform pg_temp.check((select phone from public.patients where id = (r->>'patient_id')::uuid) is null, 'register: a phone of fewer than 7 characters is left out (the patient file needs 7 or none)');
  r := public.register_checkup_as_patient(w6);
  select * into p from public.patients where id = (r->>'patient_id')::uuid;
  perform pg_temp.check(p.first_branch_id is null and p.city_id is null and p.notes = 'From the checkup list: checkup date not recorded', 'register: a checkup with no branch and no date is registered with empty branch and city, and says so');
  r := public.register_checkup_as_patient(w7);
  select * into p from public.patients where id = (r->>'patient_id')::uuid;
  perform pg_temp.check(p.notes = 'From the checkup list: checkup Dec 2024 at ' || v_gul_name || ', for Braces checkup' and p.city_id = (select city_id from public.branches where id = v_gul),
    'register: an old-list row (month only) says the month; with no city written the branch''s city is used');
  perform pg_temp.check((select follow_up from public.checkups where id = w7) = 'Started', 'register: Started stays Started');
  r := public.register_checkup_as_patient(w8);
  perform pg_temp.check((select city_id from public.patients where id = (r->>'patient_id')::uuid) = (select id from public.cities where name = 'Islamabad'), 'register: the city written on the checkup wins over the branch''s city');

  -- A reader who may not open patient files sees no Mr#.
  perform pg_temp.act_as(v_viewer);
  perform pg_temp.check((select count(*) from public.checkup_list where id = w1) = 1 and (select mr_number from public.checkup_list where id = w1) is null,
    'checkup_list: a reader without "View patient profiles" can see the checkup but not its Mr#');

  -- Link to a patient file that already exists.
  perform pg_temp.act_as(v_admin);
  select id into v_ex1 from public.patients where mr_number = '27001';
  select id into v_ex2 from public.patients where mr_number = '27002';
  insert into public.checkups (checkup_date, branch_id, patient_name, phone) values ('2026-10-09', v_nn, 'Sample Link One', '0300-555 0801') returning id into w1;
  insert into public.checkups (checkup_date, branch_id, patient_name, phone, follow_up) values ('2026-10-09', v_nn, 'Sample Link Two', '0300-555 0802', 'Completed') returning id into w2;
  insert into public.checkups (checkup_date, branch_id, patient_name, phone) values ('2026-10-09', v_gul, 'Sample Link Gulshan', '0300-555 0803') returning id into w3;
  perform pg_temp.act_as(v_acct);
  perform pg_temp.expect_state(format('select public.link_checkup_to_patient(%L, %L)', w1, v_ex1), '42501', 'NOT_ALLOWED', 'link: an accountant (cannot edit the list) is refused');
  perform pg_temp.act_as(v_fd);
  r := public.link_checkup_to_patient(w1, v_ex1);
  perform pg_temp.check(r->>'mr_number' = '27001' and r->>'full_name' = 'Sample Existing One' and (r->>'patient_id')::uuid = v_ex1, 'link: the result is the existing patient file');
  perform pg_temp.check((select patient_id from public.checkups where id = w1) = v_ex1 and (select follow_up from public.checkups where id = w1) = 'Started', 'link: the checkup is linked and its follow-up becomes Started');
  perform pg_temp.check((select mr_number from public.checkup_list where id = w1) = '27001', 'link: the checkup list shows Mr# 27001');
  r := public.link_checkup_to_patient(w1, v_ex1);
  perform pg_temp.check(r->>'mr_number' = '27001', 'link: linking again to the same patient file is fine (nothing changes)');
  perform pg_temp.expect_state(format('select public.link_checkup_to_patient(%L, %L)', w1, v_ex2), '23505', 'ALREADY_REGISTERED', 'link: a checkup that belongs to another patient file is refused');
  perform pg_temp.check((select patient_id from public.checkups where id = w1) = v_ex1, 'link: the refused call left the first link as it was');
  r := public.link_checkup_to_patient(w2, v_ex2);
  perform pg_temp.check((select follow_up from public.checkups where id = w2) = 'Completed', 'link: Completed stays Completed');
  perform pg_temp.expect_state(format('select public.link_checkup_to_patient(%L, gen_random_uuid())', w3), 'P0002', 'NOT_FOUND: this checkup', 'link: a checkup at another branch is "not on your list" for a limited front desk');
  perform pg_temp.act_as(v_coord);
  perform pg_temp.expect_state(format('select public.link_checkup_to_patient(%L, gen_random_uuid())', w3), 'P0002', 'NOT_FOUND: that patient file', 'link: a patient file that does not exist is refused');
  perform pg_temp.expect_state(format('select public.link_checkup_to_patient(%L, null)', w3), 'P0002', 'NOT_FOUND: that patient file', 'link: no patient file given is refused');
  r := public.link_checkup_to_patient(w3, v_ex2);
  perform pg_temp.check(r->>'mr_number' = '27002', 'link: a coordinator can link a Gulshan checkup');
  -- Registering a checkup that is already linked is refused too.
  perform pg_temp.expect_state(format('select public.register_checkup_as_patient(%L)', w3), '23505', 'ALREADY_REGISTERED: Sample Link Gulshan already has a patient file (Mr# 27002)', 'register: a linked checkup cannot get a second patient file');
end $$;

-- 7b. The columns only the system sets: a signed-in colleague writing through the API directly (the website never sends these).
do $$
declare
  v_admin text := current_setting('test.admin'); v_fd text := current_setting('test.fd');
  v_nn smallint := current_setting('test.nn')::smallint;
  v_ex2 uuid; a1 uuid; w1 uuid; r jsonb; n int; before_n int; v_by uuid;
begin
  perform pg_temp.act_as(v_admin);
  select id into v_ex2 from public.patients where mr_number = '27002';
  perform public.import_checkups(jsonb_build_array(pg_temp.wire(60, '2025-08-01', 'Sample Guard Archive', '0300-5550701', 'NN')));
  select id into a1 from public.checkups where patient_name = 'Sample Guard Archive';
  insert into public.checkups (checkup_date, branch_id, patient_name, phone) values ('2026-10-09', v_nn, 'Sample Guard Reg', '0300-555 0702') returning id into w1;

  perform pg_temp.act_as(v_fd);
  -- Getting around "old-list rows are removed by Dr. Ali only": change the source first, then delete.
  perform pg_temp.expect_state(format('update public.checkups set source = ''website'' where id = %L', a1), '42501', 'NOT_ALLOWED', 'guard: the desk cannot turn an old-list row into a website row');
  perform pg_temp.expect_state(format('update public.checkups set source = ''website'' where branch_id = %s and source = ''archive''', v_nn), '42501', 'NOT_ALLOWED', 'guard: not in bulk either');
  delete from public.checkups where id = a1;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0 and (select source from public.checkups where id = a1) = 'archive', 'guard: so the old-list row can still not be deleted by the desk');
  -- The other system columns.
  perform pg_temp.expect_state(format('update public.checkups set patient_id = %L where id = %L', v_ex2, a1), '42501', 'NOT_ALLOWED', 'guard: the desk cannot link a checkup to a patient file by hand');
  -- (a1 was imported by the admin, so created_by is already the admin: the desk puts its own id there instead)
  perform pg_temp.expect_state(format('update public.checkups set created_by = %L where id = %L', v_fd, a1), '42501', 'NOT_ALLOWED', 'guard: the desk cannot rewrite who created a row');
  perform pg_temp.expect_state(format('update public.checkups set sheet_key = ''S-guard00000001'' where id = %L', w1), '42501', 'NOT_ALLOWED', 'guard: the desk cannot write a Google Sheet link');
  perform pg_temp.expect_state(format('update public.checkups set date_is_month = true where id = %L', w1), '42501', 'NOT_ALLOWED', 'guard: the desk cannot turn a day row into a month row');
  -- New rows from the API are website rows made by the signed-in person, nothing else.
  perform pg_temp.expect_state(format('insert into public.checkups (checkup_date, branch_id, patient_name, source) values (''2026-10-09'', %s, ''Sample Guard Pose'', ''archive'')', v_nn), '42501', 'NOT_ALLOWED', 'guard: the desk cannot add a row that poses as an old-list row');
  perform pg_temp.expect_state(format('insert into public.checkups (checkup_date, branch_id, patient_name, source, sheet_key) values (''2026-10-09'', %s, ''Sample Guard Pose'', ''google_sheet'', ''S-guard00000002'')', v_nn), '42501', 'NOT_ALLOWED', 'guard: nor a row that takes a Google Sheet key');
  perform pg_temp.expect_state(format('insert into public.checkups (checkup_date, branch_id, patient_name, sheet_key) values (''2026-10-09'', %s, ''Sample Guard Pose'', ''S-guard00000003'')', v_nn), '42501', 'NOT_ALLOWED', 'guard: a sheet key on a website row is refused too');
  perform pg_temp.expect_state(format('insert into public.checkups (checkup_date, branch_id, patient_name, patient_id) values (''2026-10-09'', %s, ''Sample Guard Pose'', %L)', v_nn, v_ex2), '42501', 'NOT_ALLOWED', 'guard: a new row cannot start out linked to a patient file');
  perform pg_temp.expect_state(format('insert into public.checkups (checkup_date, date_is_month, branch_id, patient_name) values (''2026-10-01'', true, %s, ''Sample Guard Pose'')', v_nn), '42501', 'NOT_ALLOWED', 'guard: a new row cannot be a month-only row');
  perform pg_temp.check(not exists (select 1 from public.checkups where patient_name = 'Sample Guard Pose'), 'guard: none of the refused rows was stored');
  insert into public.checkups (checkup_date, branch_id, patient_name, created_by) values ('2026-10-09', v_nn, 'Sample Guard Mine', v_admin::uuid) returning created_by into v_by;
  perform pg_temp.check(v_by = v_fd::uuid, 'guard: created_by is always the person who added the row, whatever the request says');
  -- Everything the website does still works.
  update public.checkups set follow_up = 'Interested', notes = 'guard test note', phone = '0300 555 0701', checkup_for = 'Scaling', doctors = 'Dr. Sample (sample)', details = 'x', est_fee = 5000, city = 'Karachi'
   where id = a1;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'guard: the desk can still change the status, notes, phone, treatment, doctor, details, fee and city');
  update public.checkups set follow_up = follow_up, source = source, sheet_key = sheet_key, patient_id = patient_id where id = a1;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'guard: sending a system column with its unchanged value is fine');

  -- Registering still links the checkup (the function runs as its owner, the guard does not hold it back), and the desk cannot undo the link.
  select count(*) into before_n from public.patients;
  r := public.register_checkup_as_patient(w1);
  perform pg_temp.check((select patient_id from public.checkups where id = w1) = (r->>'patient_id')::uuid, 'guard: register still links the checkup');
  perform pg_temp.expect_state(format('update public.checkups set patient_id = null where id = %L', w1), '42501', 'NOT_ALLOWED', 'guard: the desk cannot clear the link to get a second patient file');
  perform pg_temp.expect_state(format('select public.register_checkup_as_patient(%L)', w1), '23505', 'ALREADY_REGISTERED', 'guard: so a second Register still says the person already has a file');
  perform pg_temp.check((select count(*) from public.patients) = before_n + 1, 'guard: one checkup, one patient file');

  -- Dr. Ali (admin) may still set them.
  perform pg_temp.act_as(v_admin);
  update public.checkups set source = 'google_sheet', sheet_key = 'S-guard00000004' where id = w1;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'guard: the admin can change the system columns');
  update public.checkups set source = 'website', sheet_key = null where id = w1;
end $$;
-- The Google Sheet sync (the service role) and the SQL editor (a database role that is not the API role) are not held back either.
reset role;
select pg_temp.act_as('');
set role service_role;
do $$
declare n int;
begin
  insert into public.checkups (checkup_date, patient_name, source, sheet_key) values ('2026-10-09', 'Sample Guard Sheet', 'google_sheet', 'S-guard00000005');
  update public.checkups set patient_id = (select id from public.patients where mr_number = '27001') where sheet_key = 'S-guard00000005';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'TEST FAILED: guard: the service role (the sheet sync) could not write source, sheet key and patient link'; end if;
  raise notice 'ok - guard: the service role (the sheet sync) can write source, sheet key and patient link';
end $$;
reset role;
select pg_temp.act_as(current_setting('test.fd'));
insert into public.checkups (checkup_date, patient_name, source, sheet_key) values ('2026-10-09', 'Sample Guard Editor', 'google_sheet', 'S-guard00000006');
select pg_temp.check(exists (select 1 from public.checkups where sheet_key = 'S-guard00000006'), 'guard: the SQL editor is not held back');
set role authenticated;
reset role;

-- 8. The audit log has the checkup rows (who added them, who changed them, who deleted them).
do $$
begin
  perform pg_temp.check((select count(*) from public.audit_log where table_name = 'checkups' and action = 'INSERT') >= 700, 'audit log: every inserted checkup is recorded');
  perform pg_temp.check(exists (select 1 from public.audit_log where table_name = 'checkups' and action = 'INSERT' and actor = current_setting('test.admin')::uuid and new_data ->> 'source' = 'archive'),
    'audit log: an imported row is recorded with the admin as actor');
  perform pg_temp.check(exists (select 1 from public.audit_log where table_name = 'checkups' and action = 'UPDATE' and actor = current_setting('test.fd')::uuid and new_data ->> 'follow_up' = 'Interested'),
    'audit log: the desk''s status change is recorded with the old and the new row');
  perform pg_temp.check(exists (select 1 from public.audit_log where table_name = 'checkups' and action = 'DELETE' and actor = current_setting('test.admin')::uuid and old_data ->> 'patient_name' = 'Sample Zulu'),
    'audit log: a deleted row is recorded with what it held');
end $$;

-- 9. Live updates: when the realtime publication exists (Supabase), checkups are in it.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    perform pg_temp.check(exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'checkups'), 'realtime: checkups are published');
  else
    raise notice 'ok - realtime: no publication in this database, nothing to check';
  end if;
end $$;
rollback;

-- 10. In its own transaction (as the SQL editor runs it, nobody signed in) the import leaves nothing behind in the connection:
--     its work table, which held the people's names, is gone when the call ends.
select pg_temp.act_as('');
select public.import_checkups('[]'::jsonb);
select pg_temp.check(not exists (select 1 from pg_class where relname = 'checkup_import' and relpersistence = 't'), 'import: the work table does not outlive the call');
