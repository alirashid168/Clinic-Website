-- Aaj ki List two-way sync (public.aaj_sync). Every case prints "ok - ..." or the file fails.
-- Conventions of 19_aaj_sheet_import_test.sql. The sheet's script calls aaj_sync as role anon with the publishable key,
-- so pg_temp.s25_sync() switches to anon. Everything runs in one transaction (now() is fixed), edit times are passed explicitly.
-- Owner rules covered here (9 Oct 2026): a Completed row completes the visit and says so; a deleted row removes the visit / checkup
-- safely; Mr# 50000 and above is a typo, below is a Healthwire number; a row with no Mr# is a checkup patient (public.checkups).
\set ON_ERROR_STOP 1
\set admin '''00000000-0000-0000-0000-000000025001'''
\set pa    '''00000000-0000-0000-0000-000000025011'''
\set pb    '''00000000-0000-0000-0000-000000025012'''
\set pu    '''00000000-0000-0000-0000-000000025013'''
\set ps    '''00000000-0000-0000-0000-000000025014'''
\set ph    '''00000000-0000-0000-0000-000000025015'''
\set pd1   '''00000000-0000-0000-0000-000000025016'''
\set pd2   '''00000000-0000-0000-0000-000000025017'''
\set pk    '''00000000-0000-0000-0000-000000025018'''
\set pl    '''00000000-0000-0000-0000-000000025019'''
\set pm    '''00000000-0000-0000-0000-00000002501a'''
\set pn    '''00000000-0000-0000-0000-00000002501b'''
\set po    '''00000000-0000-0000-0000-00000002501c'''
\set pq    '''00000000-0000-0000-0000-00000002501d'''
\set p7a   '''00000000-0000-0000-0000-00000002501e'''
\set p7b   '''00000000-0000-0000-0000-00000002501f'''

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

-- ---- helpers that build the script's payload (design section 2) ----
create or replace function pg_temp.s25_k(n int) returns text language sql as $$ select 'S-' || lpad(to_hex(n), 12, '0') $$;
create or replace function pg_temp.s25_today() returns date language sql as $$ select (now() at time zone 'Asia/Karachi')::date $$;
create or replace function pg_temp.s25_now_ms() returns numeric language sql as $$ select floor(extract(epoch from now()) * 1000)::numeric $$;
create or replace function pg_temp.s25_row(p_key text, p_set jsonb, p_new boolean default true, p_base jsonb default null, p_edited numeric default null) returns jsonb language sql as $$
  select jsonb_build_object('key', p_key, 'new', p_new, 'set', p_set)
         || case when p_base is not null then jsonb_build_object('base', p_base) else '{}'::jsonb end
         || case when p_edited is not null then jsonb_build_object('edited_at', p_edited) else '{}'::jsonb end $$;
create or replace function pg_temp.s25_tab(p_branch text, p_rows jsonb default '[]', p_present text[] default '{}', p_hash text default null) returns jsonb language sql as $$
  select jsonb_build_object('branch', p_branch, 'tab', case p_branch when 'GUL' then 'Gulshan KHI' when 'NN' then 'North Nazimabad' when 'DHA' then 'DHA KHI'
                                                                   when 'LHR' then 'Gulberg Lhr' else 'Islamabad' end,
                            'hash', p_hash, 'present', to_jsonb(p_present), 'rows', p_rows) $$;
create or replace function pg_temp.s25_pl(p_tabs jsonb, p_check boolean default false, p_date date default null) returns jsonb language sql as $$
  select jsonb_build_object('date', coalesce(p_date, (now() at time zone 'Asia/Karachi')::date), 'check_removed', p_check, 'tabs', p_tabs) $$;
-- one tab, rows given as a jsonb array
create or replace function pg_temp.s25_one(p_branch text, p_rows jsonb, p_present text[] default null, p_check boolean default false) returns jsonb language sql as $$
  select pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab(p_branch, p_rows,
           coalesce(p_present, array(select r->>'key' from jsonb_array_elements(p_rows) r)))), p_check) $$;
create or replace function pg_temp.s25_sync(p jsonb) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  set local role anon;
  r := public.aaj_sync('sync-secret', p);
  reset role;
  return r;
end $$;
-- result i of tab t
create or replace function pg_temp.s25_res(resp jsonb, i int default 0, t int default 0) returns jsonb language sql as $$ select resp->'tabs'->t->'results'->i $$;
create or replace function pg_temp.s25_msg(resp jsonb, i int default 0, t int default 0) returns text language sql as $$ select resp->'tabs'->t->'results'->i->>'message' $$;
create or replace function pg_temp.s25_out(resp jsonb, i int default 0, t int default 0) returns text language sql as $$ select resp->'tabs'->t->'results'->i->>'outcome' $$;
create or replace function pg_temp.s25_vis(p_key text) returns public.visits language sql as $$ select v from public.visits v where v.sheet_key = p_key $$;
create or replace function pg_temp.s25_chk(p_key text) returns public.checkups language sql as $$ select c from public.checkups c where c.sheet_key = p_key $$;
create or replace function pg_temp.s25_docs(p_key text) returns text language sql as $$
  select coalesce(string_agg(c.display_name || ':' || vs.role, ', ' order by c.display_name), '') from public.visit_staff vs join public.clinicians c on c.id = vs.clinician_id
   where vs.visit_id = (select id from public.visits where sheet_key = p_key) $$;
-- the override is recorded under the clinic's first admin (other test files may have made one before this file runs)
create or replace function pg_temp.s25_admin() returns uuid language sql as $$ select id from public.staff where role = 'admin' and active order by created_at limit 1 $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

begin;
create extension if not exists pgcrypto;
insert into auth.users (id, email) values (:admin, 'ali25@dralirashid.com');
insert into public.staff (id, full_name, email, role) values (:admin, 'Dr. Ali Rashid', 'ali25@dralirashid.com', 'admin');
insert into private.sync_secrets (name, secret_hash) values ('aaj_sheet_sync', encode(digest('sync-secret', 'sha256'), 'hex'))
  on conflict (name) do update set secret_hash = excluded.secret_hash;
-- the old export's secret must not open the new door
insert into private.sync_secrets (name, secret_hash) values ('aaj_sheet_export', encode(digest('export-secret', 'sha256'), 'hex'))
  on conflict (name) do update set secret_hash = excluded.secret_hash;
-- the defaults of the door's settings (the migration's own values, before this file changes them)
select pg_temp.check((select value = '20' from private.aaj_sync_config where key = 'calls_per_minute'), 'the door accepts at most 20 calls a minute by default (a busy minute is about 10)');
select pg_temp.check((select value = '250' from private.aaj_sync_config where key = 'visits_per_branch_day'), 'the sync may make at most 250 visits for one branch and day by default (twice a busy day of 120 patients, RS12-1)');
select pg_temp.check((select value = 'override' from private.aaj_sync_config where key = 'rules'), 'the Completed rule defaults to the owner''s choice (override)');
-- this file makes more than 20 calls in one go: the rate limit has its own case near the end
update private.aaj_sync_config set value = '100000' where key = 'calls_per_minute';

insert into public.patients (id, mr_number, full_name, phone, first_branch_id) values
  (:pa,  '25001', 'Ayesha Khan',   '03001112221', 1),      -- a mother and a daughter on one phone
  (:pb,  '25002', 'Sadia Khan',    '+923001112221', 1),    -- (stored in another form: the match works on the number)
  (:pu,  '25003', 'Muhammad Umer', '03002223331', 1),
  (:ps,  '25004', 'Sana Ahmed',    '03003334441', 1),
  (:ph,  '25005', 'Hina Baig',     null, 1),
  (:pd1, '25006', 'Dina Rao',      '03004445551', 1),      -- two patients with the same name and phone
  (:pd2, '25007', 'Dina Rao',      '03004445551', 1),
  (:pk,  '25008', 'Kiran Javed',   '03005556661', 1),
  (:pl,  '25009', 'Laiba Noor',    '03006667771', 1),
  (:pm,  '25010', 'Mariam Zafar',  '03007778881', 1),
  (:pn,  '25011', 'Nida Sheikh',   '03008889991', 1),
  (:po,  '25012', 'Omar Siddiqui', '03009990001', 1),
  (:pq,  '25013', 'Qasim Ali',     '03000001112', 1),
  (:p7a, '25014', 'Rana Tahir',    '03010000001', 1),
  (:p7b, '25015', 'Samina Gul',    '03010000002', 1);

-- the website numbers its own patients from 50000 (20261009000400, live): the sequence is only saved here and put back at the end. Earlier test
-- files of a run keep website-numbered patients (50000, 50001 ...), so a "number nobody has" is looked up, never assumed.
create temp table s25_seq as select last_value, is_called from public.mr_number_seq;
create temp table s25_resp (n text primary key, resp jsonb);
create temp table s25_cnt (n text primary key, patients bigint, visits bigint, checkups bigint);
insert into s25_cnt select 'start', (select count(*) from public.patients), (select count(*) from public.visits), (select count(*) from public.checkups);

-- =====================================================================
-- 1. Who may call it
-- =====================================================================
select pg_temp.expect_error($$select public.aaj_sync('wrong', '{}'::jsonb)$$, 'Not allowed', 'a wrong secret is refused');
select pg_temp.expect_error($$select public.aaj_sync(null, '{}'::jsonb)$$, 'Not allowed', 'no secret is refused');
select pg_temp.expect_error($$select public.aaj_sync('export-secret', '{}'::jsonb)$$, 'Not allowed', 'the old export secret does not open the sync door');
select pg_temp.expect_error($$select public.aaj_sync('', '{}'::jsonb)$$, 'Not allowed', 'an empty secret is refused');
set role authenticated;
select pg_temp.expect_error($$select public.aaj_sync('sync-secret', '{}'::jsonb)$$, 'permission denied', 'a signed-in user cannot call aaj_sync, even with the secret');
reset role;
set role anon;
select pg_temp.expect_error($$select private.aaj_check_mr(1::smallint, current_date, '25001', 'x', null)$$, 'permission denied', 'anon cannot call the private helpers');
select pg_temp.expect_error($$select * from private.sync_secrets$$, 'permission denied', 'anon cannot read the secrets table');
select pg_temp.expect_error($$select private.aaj_norm_phone('03001112221')$$, 'permission denied', 'anon cannot even reach the private schema');
select pg_temp.expect_error($$select public.import_aaj_sheet('[]'::jsonb)$$, 'permission denied', 'anon cannot run the history import');
select pg_temp.expect_error($$select public.aaj_undo_removal(1)$$, 'permission denied', 'anon cannot undo a removal');
select pg_temp.expect_error($$select public.aaj_sync('wrong', pg_temp.s25_pl('[]'::jsonb))$$, 'Not allowed', 'anon with a wrong secret is refused');
select pg_temp.check((public.aaj_sync('sync-secret', pg_temp.s25_pl('[]'::jsonb))->>'ok')::boolean, 'anon with the right secret is let in');
reset role;
select pg_temp.check(not has_function_privilege('authenticated', 'public.aaj_sync(text, jsonb)', 'execute')
                     and has_function_privilege('anon', 'public.aaj_sync(text, jsonb)', 'execute')
                     and not has_function_privilege('anon', 'public.import_aaj_sheet(jsonb, boolean)', 'execute')
                     and not has_function_privilege('anon', 'public.aaj_undo_removal(bigint)', 'execute')
                     and has_function_privilege('authenticated', 'public.aaj_undo_removal(bigint)', 'execute')
                     and not has_function_privilege('anon', 'private.aaj_check_mr(smallint, date, text, text, text, uuid)', 'execute'),
  'grants: anon has the one door, authenticated does not, the import stays signed-in only, the undo is signed-in only');
select pg_temp.check((select prosecdef and exists (select 1 from unnest(proconfig) c where c like 'search_path=%') from pg_proc where proname = 'aaj_sync' and pronamespace = 'public'::regnamespace),
  'aaj_sync is SECURITY DEFINER with a fixed search_path');
select pg_temp.check((select count(*) from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname like 'aaj\_%' and p.proname <> 'aaj_norm_phone'
                         and has_function_privilege('anon', p.oid, 'execute') and p.proacl is not null) = 0,
  'no private helper is executable by anon (only aaj_norm_phone, which the phone indexes call, keeps its default)');
select pg_temp.check((select count(*) from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname like 'aaj\_%' and p.proname <> 'aaj_norm_phone'
                         and has_function_privilege('authenticated', p.oid, 'execute')) = 0,
  'no private helper is executable by a signed-in user either');

-- =====================================================================
-- 2. Date, size and shape limits
-- =====================================================================
select pg_temp.check(private.aaj_date_ok(pg_temp.s25_today(), now()), 'date: today is allowed');
select pg_temp.check(not private.aaj_date_ok(pg_temp.s25_today() + 1, now()), 'date: tomorrow is refused');
select pg_temp.check(not private.aaj_date_ok(pg_temp.s25_today() - 2, now()), 'date: two days ago is refused');
select pg_temp.check(private.aaj_date_ok(date '2026-10-08', timestamptz '2026-10-09 02:59:00+05'), 'date: yesterday at 02:59 Karachi is allowed (final flush before the archive)');
select pg_temp.check(not private.aaj_date_ok(date '2026-10-08', timestamptz '2026-10-09 03:00:00+05'), 'date: yesterday at 03:00 Karachi is refused');
select pg_temp.check(private.aaj_date_ok(date '2026-10-09', timestamptz '2026-10-08 20:30:00+00'), 'date: Karachi time decides, not UTC (01:30 on the 9th is the 9th)');
select pg_temp.expect_error(format($$select pg_temp.s25_sync(%L::jsonb)$$, pg_temp.s25_pl('[]'::jsonb, false, pg_temp.s25_today() + 1)), 'DATE_NOT_ALLOWED', 'tomorrow''s list cannot be written');
select pg_temp.expect_error(format($$select pg_temp.s25_sync(%L::jsonb)$$, pg_temp.s25_pl('[]'::jsonb, false, pg_temp.s25_today() - 3)), 'DATE_NOT_ALLOWED', 'an old day cannot be written');
select pg_temp.expect_error($$select pg_temp.s25_sync('{"tabs": []}'::jsonb)$$, 'BAD_PAYLOAD', 'a payload without a date is refused');
select pg_temp.expect_error($$select pg_temp.s25_sync('{"date": "not a date", "tabs": []}'::jsonb)$$, 'BAD_PAYLOAD', 'a date that is not a date is refused');
select pg_temp.expect_error($$select pg_temp.s25_sync('{"date": "today", "tabs": []}'::jsonb)$$, 'BAD_PAYLOAD', 'the word today is not a date either: only yyyy-mm-dd');
select pg_temp.expect_error(format($$select pg_temp.s25_sync(%L::jsonb)$$, jsonb_build_object('date', pg_temp.s25_today(), 'tabs', '{}'::jsonb)), 'BAD_PAYLOAD', 'tabs must be a list');
select pg_temp.expect_error(format($$select pg_temp.s25_sync(%L::jsonb)$$, pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('XX')))), 'UNKNOWN_BRANCH', 'a branch code that is not a branch is refused');
select pg_temp.expect_error(format($$select pg_temp.s25_sync(%L::jsonb)$$, pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('GUL'), pg_temp.s25_tab('GUL')))), 'PAYLOAD_TOO_LARGE', 'the same branch twice is refused');
select pg_temp.expect_error(format($$select pg_temp.s25_sync(%L::jsonb)$$, pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('GUL'), pg_temp.s25_tab('NN'), pg_temp.s25_tab('DHA'), pg_temp.s25_tab('LHR'), pg_temp.s25_tab('ISB'), pg_temp.s25_tab('XX')))),
  'PAYLOAD_TOO_LARGE', 'more than 5 tabs is refused');
select pg_temp.expect_error(format($$select pg_temp.s25_sync(%L::jsonb)$$, pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('GUL', '[]', array(select pg_temp.s25_k(g) from generate_series(1, 401) g))))),
  'PAYLOAD_TOO_LARGE', '401 rows in a tab is refused');
select pg_temp.expect_error(format($$select pg_temp.s25_sync(%L::jsonb)$$, pg_temp.s25_pl(jsonb_build_array(
    pg_temp.s25_tab('GUL', (select jsonb_agg(pg_temp.s25_row(pg_temp.s25_k(g), '{"name":"X"}')) from generate_series(1, 13) g)),
    pg_temp.s25_tab('NN', (select jsonb_agg(pg_temp.s25_row(pg_temp.s25_k(100 + g), '{"name":"X"}')) from generate_series(1, 13) g))))),
  'PAYLOAD_TOO_LARGE', '26 rows in one call is refused (anon''s 3 second limit)');
select pg_temp.expect_error(format($$select pg_temp.s25_sync(%L::jsonb)$$, pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('GUL', jsonb_build_array(
    pg_temp.s25_row(pg_temp.s25_k(1), jsonb_build_object('name', 'X', 'details', repeat('d', 300000)))))))),
  'PAYLOAD_TOO_LARGE', 'a payload over 300 KB is refused');
select pg_temp.check((select count(*) from public.visits) = (select visits from s25_cnt where n = 'start') and (select count(*) from public.checkups) = (select checkups from s25_cnt where n = 'start'),
  'refused calls changed nothing');
do $$
declare v_local time := (now() at time zone 'Asia/Karachi')::time; r jsonb;
begin
  if v_local < time '03:00' then
    r := pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('GUL', jsonb_build_array(
           pg_temp.s25_row(pg_temp.s25_k(950), '{"mr":"25011","name":"Nida Sheikh","treatment":"Checkup"}')), array[pg_temp.s25_k(950)])), true, pg_temp.s25_today() - 1));
    if r->'tabs'->0->'results'->0->>'outcome' <> 'created' or r->'tabs'->0->'removed' <> '[]'::jsonb
       or (select visit_date from public.visits where sheet_key = pg_temp.s25_k(950)) <> pg_temp.s25_today() - 1 then
      raise exception 'TEST FAILED: before 03:00 yesterday should be written, and only written (no removal pass)';
    end if;
    raise notice 'ok - before 03:00 Karachi yesterday''s list can still be written (the last flush), with no removal pass';
  else
    begin
      perform pg_temp.s25_sync(pg_temp.s25_pl('[]'::jsonb, false, pg_temp.s25_today() - 1));
      raise exception 'TEST FAILED: yesterday accepted after 03:00';
    exception when others then
      if sqlerrm like 'TEST FAILED%' then raise; end if;
      if sqlerrm not like '%DATE_NOT_ALLOWED%' then raise exception 'TEST FAILED: unexpected error %', sqlerrm; end if;
      raise notice 'ok - after 03:00 Karachi yesterday''s list is refused';
    end;
  end if;
end $$;

-- a bad key, a too long field and a row that raises an error each fail alone; the rest of the call goes through
insert into s25_resp select 'iso', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(
  pg_temp.s25_row('S-nothex', '{"mr":"25001","name":"Ayesha Khan"}'),
  pg_temp.s25_row(pg_temp.s25_k(900), jsonb_build_object('mr', '25001', 'name', 'Ayesha Khan', 'details', repeat('x', 501))),
  pg_temp.s25_row(pg_temp.s25_k(901), '{"mr":"25003","name":"Muhammad Umer","treatment":"Checkup"}'),
  jsonb_build_object('key', pg_temp.s25_k(902), 'new', 'abc', 'set', '{"mr":"9876","name":"Rollback Person"}'::jsonb),
  pg_temp.s25_row(pg_temp.s25_k(903), '{"mr":"25004","name":"Sana Ahmed","treatment":"Scaling"}')), array[pg_temp.s25_k(901), pg_temp.s25_k(903)]));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'iso'), 0) = 'error' and pg_temp.s25_msg((select resp from s25_resp where n = 'iso'), 0) = 'Bad row key.', 'a bad row key is that row''s error');
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'iso'), 1) = 'Too long: details (max 500 letters).', 'a too long field is that row''s error, in plain words');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'iso'), 3) = 'error' and pg_temp.s25_msg((select resp from s25_resp where n = 'iso'), 3) like 'Not saved: %', 'a row that raises an error is reported as not saved');
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'iso'), 3) = 'Not saved: a value is too long or not allowed.'
                     and (select last_detail like '%invalid input syntax%' from private.aaj_sync_state where branch_id = 1),
  'the database''s own error text goes to the owner''s diagnostics (aaj_sync_state.last_detail), not to the sheet');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'iso'), 2) = 'created' and pg_temp.s25_out((select resp from s25_resp where n = 'iso'), 4) = 'created'
                     and (select resp->>'ok' from s25_resp where n = 'iso') = 'true', 'one bad row never blocks the rows around it');
select pg_temp.check((select count(*) from public.patients where full_name = 'Rollback Person') = 0, 'the failed row made no patient');
-- loop 6 (abuse-privacy minor): a Month, Token or Group number ("v") that is not a whole number is refused before the row is looked at. (It
-- used to fail its cast after the Mr# check and roll back: a fitting name answered "not allowed", a wrong one "belongs to another patient", and
-- the fitting guess left no trace.) Now the right name and a wrong one get the same answer and nothing is looked up.
insert into s25_resp select 'badv', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(905), '{"mr":"25001","name":"Ayesha Khan","token":{"t":"abc","v":"abc"}}'),
  pg_temp.s25_row(pg_temp.s25_k(906), '{"mr":"25001","name":"Zz Wrong Guess","month":{"t":"4","v":"99999999999"}}'),
  pg_temp.s25_row(pg_temp.s25_k(907), '{"mr":"9877","name":"Group Typo","group":{"t":"Group 1","v":1.5}}'))));
select pg_temp.check((select bool_and(pg_temp.s25_out(resp, g::int) = 'error' and pg_temp.s25_msg(resp, g::int) = 'Not saved: a value is too long or not allowed.')
                        from s25_resp, generate_series(0, 2) g where n = 'badv')
                     and not exists (select 1 from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' in (pg_temp.s25_k(905), pg_temp.s25_k(906), pg_temp.s25_k(907)))
                     and not exists (select 1 from public.patients where mr_number = '9877')
                     and not exists (select 1 from public.visits where sheet_key in (pg_temp.s25_k(905), pg_temp.s25_k(906), pg_temp.s25_k(907))),
  'a Month, Token or Group number that is not a whole number is refused before the Mr# is checked: the same answer for a fitting and a wrong name, nothing looked up or made');
select pg_temp.check((select visit_date = pg_temp.s25_today() from pg_temp.s25_vis(pg_temp.s25_k(901))), 'the visit is dated by the payload (Karachi date), not by the database default');
-- every field has a size limit; an over-long field is that row's error and nothing is written
insert into s25_cnt select 'lim', (select count(*) from public.patients), (select count(*) from public.visits), (select count(*) from public.checkups);
insert into s25_resp select 'lim', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(930), jsonb_build_object('mr', '25001', 'name', repeat('n', 121))),
  pg_temp.s25_row(pg_temp.s25_k(931), jsonb_build_object('mr', '25001', 'name', 'Ayesha Khan', 'doctors', jsonb_build_object('t', 'x', 'v', (select jsonb_agg('Dr ' || g) from generate_series(1, 11) g)))),
  pg_temp.s25_row(pg_temp.s25_k(932), jsonb_build_object('mr', '25001', 'name', 'Ayesha Khan', 'doctors', jsonb_build_object('t', 'x', 'v', jsonb_build_array(repeat('d', 61))))),
  pg_temp.s25_row(pg_temp.s25_k(933), jsonb_build_object('mr', '25001', 'name', 'Ayesha Khan', 'month', jsonb_build_object('t', repeat('m', 301), 'v', null))),
  pg_temp.s25_row(pg_temp.s25_k(934), jsonb_build_object('mr', repeat('9', 21), 'name', 'Ayesha Khan')),
  pg_temp.s25_row(pg_temp.s25_k(935), jsonb_build_object('mr', '25001', 'name', 'Ayesha Khan', 'phone', repeat('0', 41))))));
select pg_temp.check((select string_agg(x->>'message', ' | ' order by o) from jsonb_array_elements((select resp->'tabs'->0->'results' from s25_resp where n = 'lim')) with ordinality t(x, o))
                     = 'Too long: name (max 120 letters). | Too long: doctors (max 10 names). | Too long: a doctor name (max 60 letters). | Too long: month (max 300 letters). | Too long: mr (max 20 letters). | Too long: phone (max 40 letters).',
  'limits: name 120, doctors 10 names of 60 letters, wording 300, Mr# 20, phone 40');
select pg_temp.check((select patients = (select count(*) from public.patients) and visits = (select count(*) from public.visits) and checkups = (select count(*) from public.checkups) from s25_cnt where n = 'lim'), 'rows over the limits wrote nothing');

-- the tab name in a payload is never trusted: it used to be copied into visits, patients and the audit log
insert into s25_resp select 'tabn', pg_temp.s25_sync(jsonb_build_object('date', pg_temp.s25_today(), 'check_removed', false, 'tabs', jsonb_build_array(
  jsonb_build_object('branch', 'GUL', 'tab', repeat('T', 200000), 'hash', null, 'present', jsonb_build_array(pg_temp.s25_k(940)),
                     'rows', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(940), '{"mr":"25005","name":"Hina Baig"}'))))));
select pg_temp.check((pg_temp.s25_vis(pg_temp.s25_k(940))).sheet_cells->>'tab' = 'Gulshan KHI'
                     and (select new_data->>'tab' = 'Gulshan KHI' from public.audit_log where action = 'SHEET_SYNC' and table_name = 'visits' and row_id = (pg_temp.s25_vis(pg_temp.s25_k(940))).id::text),
  'the tab name comes from the branch code, not from the caller (a 200 kB name changed nothing)');
select pg_temp.check((select max(length(sheet_cells::text)) < 2000 from public.visits where sheet_cells is not null), 'no visit row carries caller-sized text');

-- =====================================================================
-- 3. A new row for a patient that exists (Mr#), fields and doctors, audit; the same payload again
-- =====================================================================
insert into s25_resp select 'c3', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(1), jsonb_build_object(
  'mr', '25001', 'name', 'Ayesha Khan', 'legacy_name', 'ayesha khan ', 'phone', '03001112221',
  'treatment', 'Checkup', 'token', jsonb_build_object('t', '9', 'v', 9), 'status', jsonb_build_object('t', 'Waiting', 'v', 'waiting'),
  'group', jsonb_build_object('t', 'Group 3', 'v', 3),
  'doctors', jsonb_build_object('t', 'Dr Haniya, Hira Anis, Dr Unknown Person', 'v', jsonb_build_array('Dr Haniya', 'Hira Anis', 'Dr Unknown Person')),
  'details', 'u l 018', 'pp', '35k', 'healthwire', 'Done', 'reminder', 'Called')))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'c3')) = 'created' and pg_temp.s25_res((select resp from s25_resp where n = 'c3'))->>'patient_created' is null,
  'new row, existing Mr#: a visit is created, no patient');
select pg_temp.check((select v.sheet_key = pg_temp.s25_k(1) and v.patient_id = :pa and v.status = 'waiting' and v.treatment_label = 'Checkup'
                             and v.treatment_id = (select id from public.treatments where name = 'Checkup') and v.details_text = 'u l 018' and v.token_no = 9
                             and v.doctor_group_id = 3 and v.created_by = '00000000-0000-0000-0000-0000000aa500' and v.legacy_source is null and v.branch_id = 1
                        from pg_temp.s25_vis(pg_temp.s25_k(1)) v), 'the visit holds the key, status, treatment (and catalogue id), details, token, group, creator');
select pg_temp.check(pg_temp.s25_docs(pg_temp.s25_k(1)) = 'Dr. Haniya Siddiqui:doctor, Hira Anis:assistant', '"Dr Haniya" (an alias) is the doctor, "Hira Anis" the assistant');
select pg_temp.check((select v.sheet_cells->'doctors'->'unmatched' = '["Dr Unknown Person"]'::jsonb and v.sheet_cells->>'tab' = 'Gulshan KHI' from pg_temp.s25_vis(pg_temp.s25_k(1)) v),
  'a doctor the website does not know is kept as typed in sheet_cells');
select pg_temp.check((select t.pp = '35k' and t.healthwire = 'Done' and t.reminder = 'Called' from private.aaj_visit_text t where t.visit_id = (pg_temp.s25_vis(pg_temp.s25_k(1))).id)
                     and not ((pg_temp.s25_vis(pg_temp.s25_k(1))).sheet_cells ? 'pp') and not ((pg_temp.s25_vis(pg_temp.s25_k(1))).sheet_cells ? 'reminder'),
  'P.P, Healthwire and Reminder are kept apart from the visit row (a patient who reads her own visits does not see staff text)');
select pg_temp.check(pg_temp.s25_res((select resp from s25_resp where n = 'c3'))->>'level' = 'warn' and pg_temp.s25_msg((select resp from s25_resp where n = 'c3')) like '%Dr Unknown Person%',
  'the unknown doctor is named in the row''s warning');
select pg_temp.check((select count(*) = 1 and bool_and(actor = '00000000-0000-0000-0000-0000000aa500') and bool_and(new_data->>'outcome' = 'created')
                        from public.audit_log where action = 'SHEET_SYNC' and table_name = 'visits' and row_id = (pg_temp.s25_vis(pg_temp.s25_k(1))).id::text), 'the change has its own audit row, attributed to the sync actor');
insert into s25_resp select 'c3b', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(1), jsonb_build_object(
  'mr', '25001', 'name', 'Ayesha Khan', 'phone', '03001112221', 'treatment', 'Checkup', 'token', jsonb_build_object('t', '9', 'v', 9),
  'status', jsonb_build_object('t', 'Waiting', 'v', 'waiting'), 'group', jsonb_build_object('t', 'Group 3', 'v', 3),
  'doctors', jsonb_build_object('t', 'Dr Haniya, Hira Anis, Dr Unknown Person', 'v', jsonb_build_array('Dr Haniya', 'Hira Anis', 'Dr Unknown Person')),
  'details', 'u l 018', 'pp', '35k', 'healthwire', 'Done', 'reminder', 'Called')))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'c3b')) = 'unchanged'
                     and (select count(*) from public.visits where patient_id = :pa and visit_date = pg_temp.s25_today()) = 1, 'the same payload again (a lost answer, a retry) changes nothing and adds no visit');
select pg_temp.check((select count(*) from public.audit_log where action = 'SHEET_SYNC' and table_name = 'visits' and row_id = (pg_temp.s25_vis(pg_temp.s25_k(1))).id::text) = 1, 'a retry that changes nothing writes no audit row');

-- =====================================================================
-- 4. Status words, group text: Waiting / Treatment / Scheduled never become Completed
-- =====================================================================
insert into s25_resp select 'st', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(10), '{"mr":"25005","name":"Hina Baig","status":{"t":"Waiting","v":"waiting"}}'),
  pg_temp.s25_row(pg_temp.s25_k(11), '{"mr":"25006","name":"Dina Rao","status":{"t":"Treatment","v":"in_treatment"}}'),
  pg_temp.s25_row(pg_temp.s25_k(12), '{"mr":"25008","name":"Kiran Javed","status":{"t":"Scheduled","v":"scheduled"}}'),
  pg_temp.s25_row(pg_temp.s25_k(13), '{"mr":"25009","name":"Laiba Noor","status":{"t":"Completed","v":"completed"}}'),
  pg_temp.s25_row(pg_temp.s25_k(14), '{"mr":"25010","name":"Mariam Zafar","status":{"t":"Hmm","v":null},"group":{"t":"Group 1, Group 2","v":1}}'),
  pg_temp.s25_row(pg_temp.s25_k(15), '{"mr":"25011","name":"Nida Sheikh","group":{"t":"Group 4","v":null}}'))));
select pg_temp.check((select string_agg(v.status::text, ',' order by v.sheet_key) from public.visits v where v.sheet_key in (pg_temp.s25_k(10), pg_temp.s25_k(11), pg_temp.s25_k(12), pg_temp.s25_k(13)))
                     = 'waiting,in_treatment,scheduled,completed', 'status words map one to one: Waiting, Treatment, Scheduled, Completed are not all read as Completed');
select pg_temp.check((select v.status = 'waiting' from pg_temp.s25_vis(pg_temp.s25_k(14)) v) and pg_temp.s25_msg((select resp from s25_resp where n = 'st'), 4) like 'Status "Hmm" not understood%',
  'a status the sheet wrote that nobody understands leaves the status alone and says so');
select pg_temp.check((select v.doctor_group_id = 1 and private.aaj_canon(v.id)->>'group' = 'Group 1, Group 2' from pg_temp.s25_vis(pg_temp.s25_k(14)) v), 'a multi-group cell keeps the first group on the website and its own text in the sheet');
select pg_temp.check((select v.doctor_group_id is null and private.aaj_canon(v.id)->>'group' = 'Group 4' from pg_temp.s25_vis(pg_temp.s25_k(15)) v), '"Group 4" has no website group but its text comes back unchanged');
select pg_temp.check((select v.token_no is null from pg_temp.s25_vis(pg_temp.s25_k(12)) v), 'a scheduled visit gets no token yet (the website numbers it on arrival)');
select pg_temp.check((select v.status = 'completed' and v.protocol_override_by is null and v.dues_override_by is null from pg_temp.s25_vis(pg_temp.s25_k(13)) v)
                     and pg_temp.s25_res((select resp from s25_resp where n = 'st'), 3)->>'level' = 'ok',
  'a Completed row that no rule stops is simply completed: no override is recorded');

-- =====================================================================
-- 5. Mr# on the row: the website's patient, a Healthwire number (below 50000), or a typo (50000 and above)
-- =====================================================================
insert into s25_resp select 'hw', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(20),
  '{"mr":"9851","name":"Kaneez Fatima","legacy_name":"kaneez fatima gul","phone":"0300 777 0001","treatment":"RCT"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'hw')) = 'created' and pg_temp.s25_res((select resp from s25_resp where n = 'hw'))->>'patient_created' = '9851'
                     and pg_temp.s25_res((select resp from s25_resp where n = 'hw'))->>'level' = 'warn' and pg_temp.s25_msg((select resp from s25_resp where n = 'hw')) like '%Healthwire Mr# 9851%',
  'a Healthwire Mr# (below 50000) that is not here yet creates the patient with that Mr# and says "check the name and phone"');
select pg_temp.check((select p.legacy_source = 'aaj_sheet_sync' and p.notes like '%Healthwire%' and p.phone = '03007770001' and p.first_branch_id = 1 and p.created_by = '00000000-0000-0000-0000-0000000aa500'
                        and p.legacy_name = 'kaneez fatima gul' from public.patients p where p.mr_number = '9851'), 'that patient is flagged: made by the sync, with a note to check, a clean phone and the typed name kept');
select pg_temp.check((select count(*) = 1 from public.audit_log where table_name = 'patients' and action = 'SHEET_SYNC' and new_data->>'mr' = '9851'), 'the new patient has an audit row');
-- (abuse-privacy M-HW-SQUAT, 11 Oct 2026) a new Healthwire Mr# is taken only up to the highest Healthwire number the website has plus 100
-- (private.aaj_hw_top: here 25015, the patients above; 9851, which the sync just made, does not count). Above it Healthwire has not given the
-- number yet: a slip (9988 for 9898) would otherwise become a file that Healthwire's own patient of that number is later merged into by the
-- Healthwire import, under this row's name. Refused, audited and counted like any refused lookup, nothing made.
select pg_temp.check(private.aaj_hw_top() = (select max(mr_number::int) from (select mr_number from public.patients where mr_number ~ '^[1-9]' and mr_number !~ '[^0-9]' and length(mr_number) <= 5
                                                                   and coalesce(legacy_source, '') not in ('aaj_sheet_sync', 'aaj_ki_list')) x where mr_number::int < 50000)
                     and private.aaj_hw_top() >= 25015 and (select legacy_source = 'aaj_sheet_sync' from public.patients where mr_number = '9851'),
  'M-HW-SQUAT: the highest Healthwire number is that of the website''s own Healthwire-range patients, never of a file the sync made');
create temp table s25_top as select private.aaj_hw_top() as top;
insert into s25_cnt select 'hw49', (select count(*) from public.patients), (select count(*) from public.visits), (select count(*) from public.checkups);
insert into s25_resp select 'hw49', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(27), '{"mr":"49999","name":"Edge Below"}'),
  pg_temp.s25_row(pg_temp.s25_k(3001), jsonb_build_object('mr', ((select top from s25_top) + 101)::text, 'name', 'Ahead Person', 'phone', '03190003001')))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'hw49'), 0) = 'needs_patient'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'hw49'), 0) = 'Mr# 49999 is not on the website and is higher than the newest Healthwire numbers it knows, so it looks like a typo. Check the Mr#. If it is right (a new Healthwire patient), ask Dr. Ali to import the latest Healthwire patients; this row is tried again every few minutes.'
                     and pg_temp.s25_out((select resp from s25_resp where n = 'hw49'), 1) = 'needs_patient'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'hw49'), 1) = 'Mr# ' || ((select top from s25_top) + 101) || ' is not on the website and is higher than the newest Healthwire numbers it knows, so it looks like a typo. Check the Mr#. If it is right (a new Healthwire patient), ask Dr. Ali to import the latest Healthwire patients; this row is tried again every few minutes.',
  'M-HW-SQUAT: a Healthwire Mr# above the highest one the website has plus 100 (49999; the highest + 101) is refused as a probable typo');
select pg_temp.check((select patients = (select count(*) from public.patients) and visits = (select count(*) from public.visits) from s25_cnt where n = 'hw49')
                     and (select count(*) = 2 and bool_and(new_data->>'outcome' = 'mr_ahead') from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' in (pg_temp.s25_k(27), pg_temp.s25_k(3001))),
  'M-HW-SQUAT: nothing is made for them, and each refusal is audited (and counted) like any refused lookup');
insert into s25_resp select 'hw50', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3002), jsonb_build_object('mr', ((select top from s25_top) + 100)::text, 'name', 'Limit Person')))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'hw50')) = 'created'
                     and pg_temp.s25_res((select resp from s25_resp where n = 'hw50'))->>'patient_created' = ((select top from s25_top) + 100)::text,
  'M-HW-SQUAT: the highest Healthwire number plus 100 is still a new Healthwire patient');
insert into s25_resp select 'hw51', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3003), jsonb_build_object('mr', ((select top from s25_top) + 150)::text, 'name', 'Creep Person')))));
select pg_temp.check(private.aaj_hw_top() = (select top from s25_top) and pg_temp.s25_out((select resp from s25_resp where n = 'hw51')) = 'needs_patient'
                     and not exists (select 1 from public.patients where mr_number = ((select top from s25_top) + 150)::text),
  'M-HW-SQUAT: the file the sync just made does not raise the limit: 50 above it is still refused (no creeping up 100 at a time)');
-- (sheet-behaviour RW8-3, 11 Oct 2026) the limit moves with time: 10 more for every day since Healthwire registered the highest patient the
-- website has (the Healthwire import keeps that date as created_at). Two weeks after an import Healthwire's new patients (about 5 a day) are
-- still taken, and the sheet is warned when they come near the limit; a number above it is still a typo, and the answer no longer tells front
-- desk to add the patient on the website (a new patient there gets a 50000+ number: a second number for one person).
create temp table s25_topat as select created_at from public.patients where mr_number = (select top from s25_top)::text;
update public.patients set created_at = now() - interval '14 days' where mr_number = (select top from s25_top)::text;
insert into s25_resp select 'hw14', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3004), jsonb_build_object('mr', ((select top from s25_top) + 235)::text, 'name', 'Two Weeks Person')),
  pg_temp.s25_row(pg_temp.s25_k(3005), jsonb_build_object('mr', ((select top from s25_top) + 241)::text, 'name', 'Past Window Person')))));
select pg_temp.check(private.aaj_hw_limit() = (select top from s25_top) + 240 and private.aaj_hw_top() = (select top from s25_top)
                     and pg_temp.s25_out((select resp from s25_resp where n = 'hw14'), 0) = 'created'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'hw14'), 0) like 'New patient added with Healthwire Mr# % Healthwire numbers are close to the newest ones the website knows: ask Dr. Ali to import the latest Healthwire patients.'
                     and pg_temp.s25_out((select resp from s25_resp where n = 'hw14'), 1) = 'needs_patient'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'hw14'), 1) = 'Mr# ' || ((select top from s25_top) + 241) || ' is not on the website and is higher than the newest Healthwire numbers it knows, so it looks like a typo. Check the Mr#. If it is right (a new Healthwire patient), ask Dr. Ali to import the latest Healthwire patients; this row is tried again every few minutes.'
                     and not exists (select 1 from public.patients where mr_number = ((select top from s25_top) + 241)::text),
  'RW8-3: 14 days after Healthwire registered its highest patient the limit is that number + 100 + 140: a new patient 235 above is made (with a warning to import soon), 241 above is still refused');
update public.patients set created_at = (select created_at from s25_topat) where mr_number = (select top from s25_top)::text;

-- 50000 and above that nobody has: a typo, never a new patient (the website numbers its own patients from 50000). The number is the lowest
-- one from 50000 up that no patient has: on a database where the website has already given 50000, that one is a real patient (found below).
create temp table s25_typo as select min(n)::text as mr from generate_series(50000, 59999) n where not exists (select 1 from public.patients where mr_number = n::text);
insert into s25_cnt select 'typo', (select count(*) from public.patients), (select count(*) from public.visits), (select count(*) from public.checkups);
insert into s25_resp select 'typo', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(21), jsonb_build_object('mr', (select mr from s25_typo), 'name', 'Typo Person')),
  pg_temp.s25_row(pg_temp.s25_k(28), '{"mr":"123456","name":"Typo Too"}'),
  pg_temp.s25_row(pg_temp.s25_k(29), '{"mr":"0985","name":"Leading Zero"}'),
  pg_temp.s25_row(pg_temp.s25_k(31), '{"mr":"AB-12","name":"Letters Mr"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'typo'), 0) = 'needs_patient' and pg_temp.s25_msg((select resp from s25_resp where n = 'typo'), 0) = 'Mr# ' || (select mr from s25_typo) || ' is not on the website. Check the number.'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'typo'), 1) = 'Mr# 123456 is not on the website. Check the number.',
  'a Mr# of 50000 or more that does not exist is a typo: refused, "Needs attention"');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'typo'), 2) = 'needs_patient' and pg_temp.s25_out((select resp from s25_resp where n = 'typo'), 3) = 'needs_patient',
  'a number with a leading zero, or letters, is not made into a patient either');
select pg_temp.check((select patients = (select count(*) from public.patients) and visits = (select count(*) from public.visits) and checkups = (select count(*) from public.checkups) from s25_cnt where n = 'typo'),
  'refused Mr# rows create no patient, no visit and no checkup');
-- an existing patient with a number of 50000 or more is found like any other
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('50077', 'Website Made', '03111000077', 1);
insert into s25_resp select 'w50', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(32), '{"mr":"50077","name":"Website Made"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'w50')) = 'created' and (pg_temp.s25_vis(pg_temp.s25_k(32))).patient_id = (select id from public.patients where mr_number = '50077'),
  'a website Mr# (50000 and above) that exists is the patient');

-- loop 6 (abuse-privacy M2 / sheet-behaviour M2): retired numbers. 20261009000400 moved the website's 10000-10012 to 50000-50012 (the
-- patient's notes say "Mr# was 10003 until ..."), and merge_patients retires the number it merges away ("Merged with Mr# N (Name) on ...").
-- Healthwire will give 10000-10012 to NEW people within weeks (orchestrator decision, 10 Oct 2026). So a retired number with a name that fits
-- its patient (or with that patient's own phone) is refused and told the patient's Mr# now: audited and counted like any refusal, and never
-- a second patient file. With another name it is a Healthwire number like any other.
insert into public.patients (mr_number, full_name, phone, first_branch_id, notes) values
  ('50911', 'Renum Fit', null, 1, 'Mr# was 10911 until 09 Oct 2026 (the website now numbers from 50000)'),
  ('50912', 'Renum Busy', null, 1, 'Mr# was 10912 until 09 Oct 2026 (the website now numbers from 50000)'),
  ('50913', 'Renum Phone', '03130000013', 1, 'Mr# was 10913 until 09 Oct 2026 (the website now numbers from 50000)'),
  ('25020', 'Merge Kept', null, 1, 'Merged with Mr# 9620 (Merge Kept) on 08 Oct 2026'),
  ('25021', 'Merge Other', null, 1, 'Merged with Mr# 9621 (Merge Other) on 08 Oct 2026');
insert into s25_cnt select 'ret', (select count(*) from public.patients), (select count(*) from public.visits), (select count(*) from public.checkups);
insert into s25_resp select 'ret', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2001), '{"mr":"10911","name":"Renum Fit","month":{"t":"4","v":4}}'),
  pg_temp.s25_row(pg_temp.s25_k(2002), '{"mr":"10912","name":"Kashif Newcomer"}'),
  pg_temp.s25_row(pg_temp.s25_k(2003), '{"mr":"9620","name":"Merge Kept"}'),
  pg_temp.s25_row(pg_temp.s25_k(2004), '{"mr":"9621","name":"Totally Different"}'),
  pg_temp.s25_row(pg_temp.s25_k(2005), '{"mr":"10913","name":"بجٹ","phone":"03130000013"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ret'), 0) = 'needs_patient'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'ret'), 0) = 'Mr# 10911 is no longer used. This patient''s Mr# is now 50911. Use 50911.',
  'a renumbered website Mr# (10911, now 50911) typed with a name that fits that patient is refused and told the Mr# now');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ret'), 2) = 'needs_patient'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'ret'), 2) = 'Mr# 9620 is no longer used. This patient''s Mr# is now 25020. Use 25020.',
  'a merged-away Mr# typed with a name that fits the patient it was merged into is refused the same way');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ret'), 4) = 'needs_patient'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'ret'), 4) = 'Mr# 10913 is no longer used. This patient''s Mr# is now 50913. Use 50913.',
  'a renumbered Mr# with that patient''s own phone (a name nobody can read) is refused the same way');
select pg_temp.check((select count(*) from public.patients where mr_number in ('10911', '9620', '10913')) = 0
                     and not exists (select 1 from public.visits where sheet_key in (pg_temp.s25_k(2001), pg_temp.s25_k(2003), pg_temp.s25_k(2005)))
                     and not exists (select 1 from public.braces_cases b join public.patients p on p.id = b.patient_id where p.mr_number = '50911'),
  'no second patient file under the old number, no visit and no braces case for those rows');
select pg_temp.check((select count(*) = 3 and bool_and(new_data->>'outcome' = 'mr_moved') from public.audit_log
                       where action = 'SHEET_LOOKUP' and new_data->>'key' in (pg_temp.s25_k(2001), pg_temp.s25_k(2003), pg_temp.s25_k(2005))),
  'each of those refusals is audited (and counted) like any other refused lookup');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ret'), 1) = 'created'
                     and pg_temp.s25_res((select resp from s25_resp where n = 'ret'), 1)->>'patient_created' = '10912'
                     and (select full_name = 'Kashif Newcomer' and legacy_source = 'aaj_sheet_sync' from public.patients where mr_number = '10912')
                     and (pg_temp.s25_vis(pg_temp.s25_k(2002))).patient_id = (select id from public.patients where mr_number = '10912'),
  'a renumbered number typed with another person''s name is Healthwire''s own new patient: made with that Mr#, with the visit (never blocked)');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ret'), 3) = 'created'
                     and (select full_name = 'Totally Different' from public.patients where mr_number = '9621'),
  'a merged-away number typed with another person''s name is a Healthwire number too');
select pg_temp.check((select patients + 2 = (select count(*) from public.patients) and visits + 2 = (select count(*) from public.visits) from s25_cnt where n = 'ret'),
  'two patients and two visits made in all (the two new Healthwire patients), nothing for the refused rows');

-- the answer was lost and the script sends the same rows again: no second patient, no second visit, no second checkup
insert into s25_resp select 'rt1', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(960), '{"name":"Retry Person","phone":"03170000001","treatment":"Checkup"}'),
  pg_temp.s25_row(pg_temp.s25_k(961), '{"mr":"9871","name":"Retry Healthwire","phone":"03170000002"}'))));
insert into s25_resp select 'rt2', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(960), '{"name":"Retry Person","phone":"03170000001","treatment":"Checkup"}'),
  pg_temp.s25_row(pg_temp.s25_k(961), '{"mr":"9871","name":"Retry Healthwire","phone":"03170000002"}'))));
select pg_temp.check((select count(*) from public.patients where full_name in ('Retry Person', 'Retry Healthwire')) = 1
                     and (select count(*) from public.visits where sheet_key = pg_temp.s25_k(961)) = 1 and (select count(*) from public.checkups where sheet_key = pg_temp.s25_k(960)) = 1
                     and (select string_agg(x->>'outcome', ',' order by o) from jsonb_array_elements((select resp->'tabs'->0->'results' from s25_resp where n = 'rt2')) with ordinality t(x, o)) = 'unchanged,unchanged',
  'a lost answer, rows sent again: no second patient, visit or checkup (the checkup row never made a patient)');

-- the typed Mr# is somebody else's / not on file but the name and phone are on file under another Mr#
insert into s25_resp select 'mx', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(22), '{"mr":"25999","name":"Sana Ahmed","phone":"03003334441"}'),
  pg_temp.s25_row(pg_temp.s25_k(23), '{"mr":"25004","name":"Ayesha"}'),
  pg_temp.s25_row(pg_temp.s25_k(24), '{"mr":"25004","name":"Lamar Kamal"}'),
  pg_temp.s25_row(pg_temp.s25_k(25), '{"mr":"25001","name":"Aisha Khan"}'),
  pg_temp.s25_row(pg_temp.s25_k(26), '{"mr":"25003","name":"Ahmed Raza","phone":"0300-2223331"}'),
  pg_temp.s25_row(pg_temp.s25_k(2900), '{"mr":"25001","name":"Ayesh Khan"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'mx'), 0) = 'needs_patient' and pg_temp.s25_msg((select resp from s25_resp where n = 'mx'), 0) like '%Sana Ahmed with this phone is Mr# 25004. Use 25004.',
  'an absent Mr# whose name and phone belong to Mr# 25004 (a patient of this branch) asks to use 25004; no new patient');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'mx'), 1) = 'needs_patient' and pg_temp.s25_msg((select resp from s25_resp where n = 'mx'), 1) = 'Needs attention: the name in this row does not match Mr# 25004 on the website. Check the Mr#, or type the name as the website has it.',
  'a Mr# that exists but belongs to a different name is not linked (a new person typed with another patient''s Mr#), and the answer does not name that patient, even one this branch knows');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'mx'), 2) = 'needs_patient', 'the same Mr# typed for a second, different person is refused too');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'mx'), 3) = 'linked' and pg_temp.s25_res((select resp from s25_resp where n = 'mx'), 3)->>'level' = 'ok'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'mx'), 3) is null,
  'an everyday spelling of the first name with the same surname (Aisha Khan / Ayesha Khan) fits without doubt: linked with a plain tick');
-- orchestrator decision, 11 Oct 2026: a name that fits its Mr# only with doubt is refused like any other refusal
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'mx'), 4) = 'needs_patient'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'mx'), 4) = 'Needs attention: the name in this row does not match Mr# 25003 on the website. Check the Mr#, or type the name as the website has it.'
                     and pg_temp.s25_vis(pg_temp.s25_k(26)) is null,
  'a name that does not fit the Mr# is refused even when the phone number is that patient''s own (the phone is no proof of another name), with the same answer as any other name that does not fit');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'mx'), 5) = 'needs_patient'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'mx'), 5) = 'Needs attention: the name in this row does not match Mr# 25001 on the website. Check the Mr#, or type the name as the website has it.'
                     and pg_temp.s25_vis(pg_temp.s25_k(2900)) is null,
  'a slip in the first name (Ayesh / Ayesha) fits only with doubt: refused, nothing linked, the patient not named');
select pg_temp.check((select count(*) from public.visits v where v.sheet_key in (pg_temp.s25_k(22), pg_temp.s25_k(23), pg_temp.s25_k(24), pg_temp.s25_k(26), pg_temp.s25_k(2900))) = 0
                     and (select count(*) = 3 from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' in (pg_temp.s25_k(24), pg_temp.s25_k(26), pg_temp.s25_k(2900)) and new_data->>'outcome' = 'mr_name'),
  'refused rows left no visits behind, and the doubtful ones are audited like any other refused lookup');

-- a daughter typed with her mother's Mr# on the family phone is NOT linked to the mother (the phone waiver stops for families)
insert into s25_resp select 'fam1', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(33), '{"mr":"25001","name":"Sadia Khan","phone":"03001112221"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'fam1')) = 'needs_patient' and pg_temp.s25_msg((select resp from s25_resp where n = 'fam1')) = 'Needs attention: the name in this row does not match Mr# 25001 on the website. Check the Mr#, or type the name as the website has it.'
                     and (select count(*) from public.visits v where v.sheet_key = pg_temp.s25_k(33)) = 0,
  'the daughter''s name with the mother''s Mr# on their shared phone is refused, not linked to the mother');
insert into s25_resp select 'fam2', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(34), '{"mr":"25002","name":"Sadia Khan","phone":"03001112221"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'fam2')) = 'created' and (pg_temp.s25_vis(pg_temp.s25_k(34))).patient_id = :pb, 'and with her own Mr# she is found');

-- the secret is not a search: another patient's name is not given away, a refused lookup is audited once a day and capped
insert into s25_resp select 'orc', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(35), '{"mr":"25003","name":"Zzz Unknown"}'),
  pg_temp.s25_row(pg_temp.s25_k(36), '{"mr":"25999","name":"Sana Ahmed","phone":"03003334441"}'))));
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'orc'), 0) = 'Needs attention: the name in this row does not match Mr# 25003 on the website. Check the Mr#, or type the name as the website has it.' and pg_temp.s25_msg((select resp from s25_resp where n = 'orc'), 0) not like '%Umer%',
  'a patient this branch has never had is not named in the answer');
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'orc'), 1) = 'Mr# 25999 is not on the website, and this name and phone are filed under another Mr#. Check the number.'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'orc'), 1) not like '%25004%', 'nor is the Mr# of a name and phone given away');
select pg_temp.check((select count(*) from public.audit_log where action = 'SHEET_LOOKUP' and actor = '00000000-0000-0000-0000-0000000aa500' and new_data->>'key' in (pg_temp.s25_k(35), pg_temp.s25_k(36))) = 2,
  'every refused lookup is written to the audit log');
insert into s25_resp select 'orc2', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(35), '{"mr":"25003","name":"Zzz Unknown"}'))));
select pg_temp.check((select count(*) from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' = pg_temp.s25_k(35)) = 1, 'the same refused row sent again every few minutes is audited once');
create temp table s25_fake_lookups as select 0 as n;
insert into public.audit_log (table_name, row_id, action, new_data, actor)
  select 'patients', null, 'SHEET_LOOKUP', jsonb_build_object('key', 'S-ffffffff' || lpad(to_hex(g), 4, '0'), 'outcome', 'mr_name'), '00000000-0000-0000-0000-0000000aa500'
    from generate_series(1, 200) g;
insert into s25_resp select 'orc3', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(37), '{"mr":"25003","name":"Another Guess"}'),
  pg_temp.s25_row(pg_temp.s25_k(35), '{"mr":"25003","name":"Zzz Unknown"}'))));
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'orc3'), 0) = 'Too many rows the website could not place today. Add this patient on the website.'
                     and (select count(*) from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' = pg_temp.s25_k(37)) = 0,
  'after 200 refused lookups in a day a new one is refused without looking, and not audited again');
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'orc3'), 1) = 'Needs attention: the name in this row does not match Mr# 25003 on the website. Check the Mr#, or type the name as the website has it.', 'a row already audited today still gets its own message');
delete from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' like 'S-ffffffff%';

-- loop 3, finding 1: one row key with another Mr# each time is NOT one lookup. Every (key, Mr#) is audited and counted, a call stops looking after
-- five refusals, and no answer names a patient (these patients were all first seen at Gulshan, where the old answer would have named them).
insert into s25_resp select 'ork1', pg_temp.s25_sync(pg_temp.s25_one('GUL', (select jsonb_agg(pg_temp.s25_row(pg_temp.s25_k(1710), jsonb_build_object('mr', (25000 + g)::text, 'name', 'Zz Nobody')) order by g)
                                                                             from generate_series(1, 8) g)));
select pg_temp.check((select string_agg(pg_temp.s25_msg(resp, g::int), '|' order by g) from s25_resp, generate_series(0, 7) g where n = 'ork1')
                       = 'Needs attention: the name in this row does not match Mr# 25001 on the website. Check the Mr#, or type the name as the website has it.|Needs attention: the name in this row does not match Mr# 25002 on the website. Check the Mr#, or type the name as the website has it.|Needs attention: the name in this row does not match Mr# 25003 on the website. Check the Mr#, or type the name as the website has it.'
                         || '|Needs attention: the name in this row does not match Mr# 25004 on the website. Check the Mr#, or type the name as the website has it.|Needs attention: the name in this row does not match Mr# 25005 on the website. Check the Mr#, or type the name as the website has it.'
                         || '|Too many rows the website could not place at once. This row is tried again in a few minutes.'
                         || '|Too many rows the website could not place at once. This row is tried again in a few minutes.'
                         || '|Too many rows the website could not place at once. This row is tried again in a few minutes.',
  'one row key sent with eight Mr# in one call: five refusals that name nobody, then the rest of the call is not looked at');
select pg_temp.check((select count(*) = 5 and count(distinct new_data->>'mr') = 5 and min(new_data->>'mr') = '25001' and max(new_data->>'mr') = '25005'
                        from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' = pg_temp.s25_k(1710)),
  'each of the five refused lookups is in the audit log with its own Mr#, under the one key');
insert into s25_resp select 'ork2', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(1710), '{"mr":"25009","name":"Zz Nobody"}'))));
insert into s25_resp select 'ork3', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(1710), '{"mr":"25010","name":"Zz Nobody"}'))));
insert into s25_resp select 'ork4', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(1710), '{"mr":"25010","name":"Zz Nobody"}'))));
select pg_temp.check((select count(*) from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' = pg_temp.s25_k(1710)) = 7
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'ork4')) = 'Needs attention: the name in this row does not match Mr# 25010 on the website. Check the Mr#, or type the name as the website has it.',
  'the same key with a new Mr# in the next calls is a new audited lookup each time; the same key and Mr# sent again is not audited twice');
select pg_temp.check(not exists (select 1 from s25_resp r, generate_series(0, 7) g, public.patients p
                                  where r.n in ('ork1', 'ork2', 'ork3', 'ork4') and p.mr_number between '25001' and '25010'
                                    and position(lower(p.full_name) in lower(coalesce(pg_temp.s25_msg(r.resp, g::int), ''))) > 0),
  'no answer to those rows carries the name of any of those patients');
insert into public.audit_log (table_name, row_id, action, new_data, actor)
  select 'patients', null, 'SHEET_LOOKUP', jsonb_build_object('key', 'S-ffffffff' || lpad(to_hex(g), 4, '0'), 'mr', g::text, 'outcome', 'mr_name'), '00000000-0000-0000-0000-0000000aa500'
    from generate_series(1, 200) g;
insert into s25_resp select 'ork5', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(1710), '{"mr":"25011","name":"Zz Nobody"}'))));
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'ork5')) = 'Too many rows the website could not place today. Add this patient on the website.'
                     and not exists (select 1 from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'mr' = '25011'),
  'once the day''s 200 are used up, an already-audited key with a new Mr# gets no answer either');
delete from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' like 'S-ffffffff%';
-- rows refused earlier today that are sent again (the script retries them every few minutes) do not count for the call: a good row sent
-- with six of them is still looked at
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('28003', 'Fresh Legit', null, 1);
insert into s25_resp select 'ork6', pg_temp.s25_sync(pg_temp.s25_one('GUL', (select jsonb_agg(x order by o) from (
    select pg_temp.s25_row(pg_temp.s25_k(1710), jsonb_build_object('mr', m, 'name', 'Zz Nobody')) x, o
      from unnest(array['25001', '25002', '25003', '25004', '25005', '25009']) with ordinality u(m, o)
    union all select pg_temp.s25_row(pg_temp.s25_k(1711), '{"mr":"28003","name":"Fresh Legit"}'), 7) y)));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ork6'), 6) = 'created' and (pg_temp.s25_vis(pg_temp.s25_k(1711))).patient_id = (select id from public.patients where mr_number = '28003')
                     and (select count(*) from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' = pg_temp.s25_k(1710)) = 7,
  'six rows refused earlier today, sent again, do not use up the call: the good row with them is saved, and nothing is audited twice');

-- loop 5 (R5-1): once the day's 200 refused lookups are used up, a row that fits gets the same answer as one that does not, and nothing is made.
-- (Before, a fit still made a visit and handed back the phone and dues, while a miss got a refusal that was neither audited nor counted.)
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('28201', 'Budget Fit', '03001128201', 1);
insert into public.audit_log (table_name, row_id, action, new_data, actor)
  select 'patients', null, 'SHEET_LOOKUP', jsonb_build_object('key', 'S-ffffffff' || lpad(to_hex(g), 4, '0'), 'mr', g::text, 'outcome', 'mr_name'), '00000000-0000-0000-0000-0000000aa500'
    from generate_series(1, 200) g;
insert into s25_cnt select 'bud', (select count(*) from public.patients), (select count(*) from public.visits), (select count(*) from public.checkups);
insert into s25_resp select 'bud1', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(1800), '{"mr":"28201","name":"Budget Fit"}'),
  pg_temp.s25_row(pg_temp.s25_k(1801), '{"mr":"28201","name":"Zz Wrong Guess"}'),
  pg_temp.s25_row(pg_temp.s25_k(1802), '{"mr":"28201","name":"بجٹ","phone":"03001128201"}'),
  pg_temp.s25_row(pg_temp.s25_k(1803), '{"mr":"28202","name":"Budget Healthwire"}'))));
select pg_temp.check((select count(distinct pg_temp.s25_msg(resp, g::int)) = 1
                             and min(pg_temp.s25_msg(resp, g::int)) = 'Too many rows the website could not place today. Add this patient on the website.'
                             and bool_and(pg_temp.s25_out(resp, g::int) = 'needs_patient')
                        from s25_resp, generate_series(0, 3) g where n = 'bud1'),
  'after the day''s 200: the right name, a wrong name, an unreadable name with the patient''s own phone and a new Healthwire number all get one and the same answer');
select pg_temp.check((select patients = (select count(*) from public.patients) and visits = (select count(*) from public.visits) from s25_cnt where n = 'bud')
                     and not exists (select 1 from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' in (pg_temp.s25_k(1800), pg_temp.s25_k(1801), pg_temp.s25_k(1802), pg_temp.s25_k(1803)))
                     and (select resp::text not like '%03001128201%' and resp::text not like '%Budget Fit%' from s25_resp where n = 'bud1'),
  'and nothing was made: no visit, no patient, no audit row, and the answer carries neither the patient''s name nor phone');
insert into s25_resp select 'bud2', pg_temp.s25_sync(pg_temp.s25_one('DHA', (select jsonb_agg(pg_temp.s25_row(pg_temp.s25_k(1810 + g), jsonb_build_object('mr', '28201', 'name', 'Guess ' || g)) order by g)
                                                                              from generate_series(1, 7) g)));
select pg_temp.check((select string_agg(pg_temp.s25_msg(resp, g::int), '|' order by g) from s25_resp, generate_series(0, 6) g where n = 'bud2')
                       = repeat('Too many rows the website could not place today. Add this patient on the website.|', 5)
                         || 'Too many rows the website could not place at once. This row is tried again in a few minutes.'
                         || '|Too many rows the website could not place at once. This row is tried again in a few minutes.',
  'after the day''s 200, a call still stops looking after five new Mr# rows');
insert into s25_resp select 'bud3', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(1820), '{"mr":"28003","name":"Fresh Legit"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'bud3')) = 'linked' and (pg_temp.s25_vis(pg_temp.s25_k(1820))).patient_id = (select id from public.patients where mr_number = '28003'),
  'after the day''s 200, a row whose patient is on today''s list already still meets that visit (the sheet sees that patient anyway)');
delete from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' like 'S-ffffffff%';

-- loop 3, finding 2: a "name" stuffed with common first names fits nobody (a real name has at most four words besides the titles)
insert into s25_cnt select 'stuff', (select count(*) from public.patients), (select count(*) from public.visits), (select count(*) from public.checkups);
insert into s25_resp select 'stuff', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(1720), '{"mr":"25001","name":"Qq Ayesha Bilal Fatima Sana Hina"}'),
  pg_temp.s25_row(pg_temp.s25_k(1721), '{"mr":"25004","name":"Ayesha Fatima Hina Sana Bilal"}'),
  pg_temp.s25_row(pg_temp.s25_k(1722), '{"mr":"25004","name":"Bilal Fatima Sana"}'))));
select pg_temp.check((select string_agg(pg_temp.s25_msg(resp, g::int), '|' order by g) from s25_resp, generate_series(0, 2) g where n = 'stuff')
                       = 'Needs attention: the name in this row does not match Mr# 25001 on the website. Check the Mr#, or type the name as the website has it.|Needs attention: the name in this row does not match Mr# 25004 on the website. Check the Mr#, or type the name as the website has it.|Needs attention: the name in this row does not match Mr# 25004 on the website. Check the Mr#, or type the name as the website has it.'
                     and (select visits = (select count(*) from public.visits) from s25_cnt where n = 'stuff'),
  'a guessed Mr# with a cell full of first names is refused (five or more words, or the patient''s first name only third in the row), no visit is made, no phone or dues come back');

-- =====================================================================
-- 6. A row with no Mr# is a CHECKUP patient: public.checkups, never a patient file, never an Mr#
-- =====================================================================
insert into s25_cnt select 'chk0', (select count(*) from public.patients), (select count(*) from public.visits), (select count(*) from public.checkups);
insert into s25_resp select 'ck1', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(30), jsonb_build_object('name', 'Ayesha', 'phone', '03001112221', 'treatment', 'Checkup',
     'token', jsonb_build_object('t', 'Kit 80k', 'v', null), 'status', jsonb_build_object('t', 'Waiting', 'v', 'waiting'),
     'doctors', jsonb_build_object('t', 'Dr Haniya, Dr Unknown Person', 'v', jsonb_build_array('Dr Haniya', 'Dr Unknown Person')),
     'details', 'scaling advised', 'month', jsonb_build_object('t', '', 'v', null), 'pp', '2000')),     -- (a Month on a no-Mr# row is a braces patient: section 19b)
  pg_temp.s25_row(pg_temp.s25_k(31), '{"name":"M Umer","phone":"3002223331","treatment":"Xray checkup"}'),
  pg_temp.s25_row(pg_temp.s25_k(38), '{"mr":"NEW","name":"Walk In","treatment":"checkup / pain"}'),
  pg_temp.s25_row(pg_temp.s25_k(39), '{"name":"Dina Rao","phone":"03004445551","treatment":"Checkup"}'),
  pg_temp.s25_row(pg_temp.s25_k(41), '{"name":"X","treatment":"Checkup"}'),
  pg_temp.s25_row(pg_temp.s25_k(42), '{"mr":"","name":"Sadia Khan","phone":"+92 300 1112221","treatment":"Checkup","status":{"t":"Completed","v":"completed"}}'))));
select pg_temp.check((select string_agg(pg_temp.s25_out(resp, g::int), ',' order by g) from s25_resp, generate_series(0, 5) g where n = 'ck1') = 'created,created,created,created,needs_patient,created',
  'rows with no Mr# (empty, missing, or NEW) become checkups, whatever the name or phone');
select pg_temp.check((select count(*) from public.patients) = (select patients from s25_cnt where n = 'chk0') and (select count(*) from public.visits) = (select visits from s25_cnt where n = 'chk0'),
  'no patient file, no Mr# and no visit is made for a checkup (not even for "Ayesha" on the family phone, or Dina Rao who is on the phone twice)');
select pg_temp.check((select c.checkup_date = pg_temp.s25_today() and c.branch_id = 3 and c.patient_name = 'Ayesha' and c.phone = '03001112221' and c.checkup_for = 'Checkup'
                             and c.token = 'Kit 80k' and c.day_status = 'waiting' and c.doctors = 'Dr Haniya, Dr Unknown Person' and c.details = 'scaling advised'
                             and c.source = 'google_sheet' and c.patient_id is null and c.follow_up = 'Not Contacted' and not c.date_is_month and c.sheet_key = pg_temp.s25_k(30)
                        from pg_temp.s25_chk(pg_temp.s25_k(30)) c), 'the checkup holds the day, branch, name, phone, treatment, token text, status, doctors as typed, details, source google_sheet');
select pg_temp.check((select c.phone = '03002223331' and c.patient_name = 'M Umer' from pg_temp.s25_chk(pg_temp.s25_k(31)) c), 'a phone typed without its 0 is stored clean');
select pg_temp.check((select c.phone is null and c.patient_name = 'Walk In' from pg_temp.s25_chk(pg_temp.s25_k(38)) c), 'a checkup needs no phone');
select pg_temp.check((select c.day_status = 'completed' from pg_temp.s25_chk(pg_temp.s25_k(42)) c), 'a checkup can be Completed without any website rule (no photo, checker or dues)');
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'ck1'), 4) = 'Patient name is too short.', 'a checkup row needs a name');
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'ck1'), 0) = 'Checkup patient: no Mr#, no patient file.' and pg_temp.s25_res((select resp from s25_resp where n = 'ck1'), 0)->>'level' = 'ok',
  'the row tells staff it is a checkup');
select pg_temp.check((select count(*) = 1 and bool_and(actor = '00000000-0000-0000-0000-0000000aa500') from public.audit_log where table_name = 'checkups' and action = 'SHEET_SYNC' and row_id = (pg_temp.s25_chk(pg_temp.s25_k(30))).id::text),
  'the new checkup has its own audit row, attributed to the sync');
-- the day's list carries the checkups (no Mr#, kind checkup), after the visits
select pg_temp.check((select x->>'kind' = 'checkup' and x->>'mr' = '' and x->>'name' = 'Ayesha' and x->>'token' = 'Kit 80k' and x->>'status' = 'Waiting' and x->>'doctors' = 'Dr Haniya, Dr Unknown Person'
                             and x->>'month' = '' and x->>'group' = '' and x->>'pp' = '' and x->>'key' = pg_temp.s25_k(30)
                        from jsonb_array_elements(private.aaj_day_list(3::smallint, pg_temp.s25_today())) x where x->>'key' = pg_temp.s25_k(30)),
  'canon of a checkup: kind, no Mr#, the typed token text, the status label, no month, group or P.P');
-- retry of the same new row: still one checkup
insert into s25_resp select 'ck1b', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(31), '{"name":"M Umer","phone":"3002223331","treatment":"Xray checkup"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ck1b')) = 'unchanged' and (select count(*) from public.checkups where patient_name = 'M Umer') = 1, 'a lost answer, the same checkup row again: still one checkup');

-- two sides edit a checkup: the same per-field merge as a visit
insert into s25_resp select 'ck2', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(30), jsonb_build_object('treatment', 'Scaling', 'details', 'sheet details', 'status', jsonb_build_object('t', 'Treatment', 'v', 'in_treatment'),
     'name', 'Ayesha K', 'phone', '0300 111 2229'), false,
     '{"treatment":"Checkup","details":"scaling advised","status":"Waiting","name":"Ayesha","phone":"03001112221"}', pg_temp.s25_now_ms() + 1000))));
select pg_temp.check((select c.checkup_for = 'Scaling' and c.details = 'sheet details' and c.day_status = 'in_treatment' and c.patient_name = 'Ayesha K' and c.phone = '03001112229'
                        from pg_temp.s25_chk(pg_temp.s25_k(30)) c) and pg_temp.s25_out((select resp from s25_resp where n = 'ck2')) = 'updated',
  'sheet edits of a checkup (treatment, details, status, name, phone) reach the website');
update public.checkups set details = 'web details' where sheet_key = pg_temp.s25_k(30);
insert into s25_resp select 'ck3', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(30), '{"details":"sheet old"}', false, '{"details":"sheet details"}', pg_temp.s25_now_ms() - 60000))));
select pg_temp.check((pg_temp.s25_chk(pg_temp.s25_k(30))).details = 'web details' and pg_temp.s25_res((select resp from s25_resp where n = 'ck3'))->'kept_website' = '["details"]'::jsonb
                     and (select new_data->'sheet_text_not_applied' = '{"details":"sheet old"}'::jsonb from public.audit_log where action = 'SHEET_SYNC' and table_name = 'checkups' order by id desc limit 1),
  'both sides changed a checkup''s details and the sheet''s edit is older: the website''s text stays, the sheet is told, the lost text is in the audit log');
insert into s25_resp select 'ck4', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(30), '{"details":"sheet new","doctors":{"t":"Dr. Haniya Siddiqui / Dr Unknown Person","v":["Dr. Haniya Siddiqui","Dr Unknown Person"]}}', false,
  '{"details":"web details","doctors":["Dr Haniya","Dr Unknown Person"]}', pg_temp.s25_now_ms() + 60000))));
select pg_temp.check((pg_temp.s25_chk(pg_temp.s25_k(30))).details = 'sheet new' and pg_temp.s25_res((select resp from s25_resp where n = 'ck4'))->'kept_website' = '[]'::jsonb, 'a newer sheet edit of a checkup wins');
select pg_temp.check((pg_temp.s25_chk(pg_temp.s25_k(30))).doctors = 'Dr. Haniya Siddiqui / Dr Unknown Person', 'the doctors cell of a checkup is the sheet''s text');
insert into s25_resp select 'ck5', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(30), '{"doctors":{"t":"Dr Unknown Person, Dr. Haniya Siddiqui","v":["Dr Unknown Person","Dr. Haniya Siddiqui"]}}', false,
  '{"doctors":["Dr. Haniya Siddiqui","Dr Unknown Person"]}', pg_temp.s25_now_ms() - 600000))));
select pg_temp.check(pg_temp.s25_res((select resp from s25_resp where n = 'ck5'))->'kept_website' = '[]'::jsonb and pg_temp.s25_out((select resp from s25_resp where n = 'ck5')) = 'unchanged',
  'doctors of a checkup are compared as people, not as text: the same two doctors in another order or with another separator are no change and no conflict');
-- Scheduled is not a checkup status
insert into s25_resp select 'ck6', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(31), '{"status":{"t":"Scheduled","v":"scheduled"}}', false, '{"status":"Waiting"}', pg_temp.s25_now_ms() + 1000))));
select pg_temp.check((pg_temp.s25_chk(pg_temp.s25_k(31))).day_status = 'waiting' and pg_temp.s25_msg((select resp from s25_resp where n = 'ck6')) = 'A checkup cannot be Scheduled. Saved as Waiting.'
                     and pg_temp.s25_res((select resp from s25_resp where n = 'ck6'))->'kept_website' = '["status"]'::jsonb, 'a checkup cannot be Scheduled: saved as Waiting, and the sheet is told');

-- a NEW checkup typed with Scheduled is saved as Waiting, and the sheet is told which field it was
insert into s25_resp select 'ck6b', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(1000), '{"name":"Walk Scheduled","treatment":"Checkup","status":{"t":"Scheduled","v":"scheduled"}}'))));
select pg_temp.check((pg_temp.s25_chk(pg_temp.s25_k(1000))).day_status = 'waiting' and pg_temp.s25_res((select resp from s25_resp where n = 'ck6b'))->>'level' = 'warn'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'ck6b')) like 'A checkup cannot be Scheduled. Saved as Waiting.%'
                     and pg_temp.s25_res((select resp from s25_resp where n = 'ck6b'))->'kept_website' = '["status"]'::jsonb, 'a new checkup typed as Scheduled is saved as Waiting, with a warning, and the sheet is told');

-- a clock far in the future (a wrong computer clock) never wins a conflict: it counts as "now", so the website's change made just now stays
update public.checkups set details = 'web future' where sheet_key = pg_temp.s25_k(30);
insert into s25_resp select 'ckf', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(30), '{"details":"sheet future"}', false, '{"details":"older text"}', pg_temp.s25_now_ms() + 86400000))));
select pg_temp.check((pg_temp.s25_chk(pg_temp.s25_k(30))).details = 'web future' and pg_temp.s25_res((select resp from s25_resp where n = 'ckf'))->'kept_website' = '["details"]'::jsonb,
  'a checkup edit stamped a day in the future does not beat the website''s change of this moment');
update public.visits set details_text = 'web future' where sheet_key = pg_temp.s25_k(10);
insert into s25_resp select 'vf', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(10), '{"details":"sheet future"}', false, '{"details":"older text"}', pg_temp.s25_now_ms() + 86400000))));
select pg_temp.check((pg_temp.s25_vis(pg_temp.s25_k(10))).details_text = 'web future' and pg_temp.s25_res((select resp from s25_resp where n = 'vf'))->'kept_website' = '["details"]'::jsonb,
  'a visit edit stamped a day in the future does not beat the website''s change of this moment');

-- a checkup that is registered as a patient later gets its Mr# back in the sheet
update public.checkups set patient_id = :pk where sheet_key = pg_temp.s25_k(38);
select pg_temp.check((select x->>'mr' = '25008' and x->>'kind' = 'checkup' from jsonb_array_elements(private.aaj_day_list(3::smallint, pg_temp.s25_today())) x where x->>'key' = pg_temp.s25_k(38)),
  'canon of a registered checkup carries the new Mr# (the script writes it into the sheet row)');
insert into s25_resp select 'ck7', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(38), '{"mr":"25008"}', false, '{"mr":""}', pg_temp.s25_now_ms() - 5000),
  pg_temp.s25_row(pg_temp.s25_k(31), '{"mr":"25001"}', false, '{"mr":""}', pg_temp.s25_now_ms() - 5000))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ck7'), 0) = 'unchanged', 'the Mr# of the registered patient on the checkup row is fine');
-- (sheet-behaviour RW8-1, 11 Oct 2026) the script sends an Mr# typed into a checkup row under the checkup's key (the row's name is unchanged):
-- "M Umer" with the Mr# of Ayesha Khan does not fit her: refused, the checkup stays as it is (never removed for a slip, no patient file), and
-- the lookup is audited and counted like a new row's
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ck7'), 1) = 'error'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'ck7'), 1) = 'Needs attention: Mr# 25001 is not a patient on the website with this name, so this row stays a checkup. Clear the Mr# if this is a checkup patient (no Mr#), or check the number.'
                     and (pg_temp.s25_chk(pg_temp.s25_k(31))).patient_id is null and (pg_temp.s25_chk(pg_temp.s25_k(31))).patient_name = 'M Umer'
                     and exists (select 1 from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' = pg_temp.s25_k(31) and new_data->>'mr' = '25001' and new_data->>'outcome' = 'mr_name'),
  'RW8-1: an Mr# sent under the key of a checkup that is not registered, whose name does not fit that patient: refused, the checkup stays as it is, the lookup is audited (the sync never registers or links a checkup itself)');
insert into s25_cnt select 'ck7r', (select count(*) from public.patients), (select count(*) from public.visits), (select count(*) from public.checkups);
insert into s25_resp select 'ck7r', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(31), '{"mr":"25003"}', false, '{"mr":""}', pg_temp.s25_now_ms() - 5000),
  pg_temp.s25_row(pg_temp.s25_k(39), '{"mr":"7"}', false, '{"mr":""}', pg_temp.s25_now_ms() - 5000))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ck7r'), 0) = 'rekey' and pg_temp.s25_res((select resp from s25_resp where n = 'ck7r'), 0)->>'level' = 'warn'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'ck7r'), 0) = 'Mr# 25003 typed: this row is sent again as that patient''s visit.'
                     and (pg_temp.s25_chk(pg_temp.s25_k(31))).patient_id is null
                     and exists (select 1 from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' = pg_temp.s25_k(31) and new_data->>'mr' = '25003' and new_data->>'outcome' = 'mr')
                     and exists (select 1 from public.audit_log where action = 'SHEET_LETGO' and table_name = 'checkups' and row_id = (pg_temp.s25_chk(pg_temp.s25_k(31))).id::text and new_data->>'why' = 'mr')
                     and not exists (select 1 from public.audit_log where action = 'SHEET_LETGO' and new_data->>'key' = pg_temp.s25_k(39)),
  'RW8-1: an Mr# whose patient the checkup row''s name fits ("M Umer", Mr# of Muhammad Umer): the row is let go (it becomes that patient''s visit as a new row, RS5-E1); the checkup is not touched here, and even this lookup is audited');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ck7r'), 1) = 'error'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'ck7r'), 1) like 'Needs attention: Mr# 7 is not a patient on the website with this name, so this row stays a checkup.%'
                     and (select patients = (select count(*) from public.patients) and visits = (select count(*) from public.visits) and checkups = (select count(*) from public.checkups) from s25_cnt where n = 'ck7r')
                     and not exists (select 1 from public.patients where mr_number = '7' and legacy_source = 'aaj_sheet_sync'),
  'RW8-1: a stray 7 in the Mr# cell of a checkup row (a number nobody has, which a new row would make into a Healthwire patient): no patient file from a checkup row (owner rule 6), nothing made or removed');
-- once the day's 200 lookups are used up, a checkup row's Mr# that fits gets the same answer as one that does not (no free check of a name)
insert into public.audit_log (table_name, row_id, action, new_data, actor)
  select 'patients', null, 'SHEET_LOOKUP', jsonb_build_object('key', 'S-ffffffff' || lpad(to_hex(g), 4, '0'), 'mr', g::text, 'outcome', 'mr_name'), '00000000-0000-0000-0000-0000000aa500'
    from generate_series(1, 200) g;
insert into s25_resp select 'ck7u', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(31), '{"mr":"25003","name":"Muhammad Umer"}', false, '{"mr":"","name":"M Umer"}', pg_temp.s25_now_ms() - 5000),
  pg_temp.s25_row(pg_temp.s25_k(39), '{"mr":"25099"}', false, '{"mr":""}', pg_temp.s25_now_ms() - 5000))));
select pg_temp.check((select bool_and(pg_temp.s25_out(resp, g::int) = 'error' and pg_temp.s25_msg(resp, g::int) = 'Too many rows the website could not place today. Add this patient on the website.')
                        from s25_resp, generate_series(0, 1) g where n = 'ck7u')
                     and (pg_temp.s25_chk(pg_temp.s25_k(31))).patient_name = 'M Umer',
  'RW8-1: after the day''s 200, an Mr# on a checkup row gets one and the same answer whether the name fits or not, and nothing is saved');
delete from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' like 'S-ffffffff%';
insert into s25_resp select 'ck7b', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(38), '{"mr":"25001"}', false, '{"mr":"25008"}', pg_temp.s25_now_ms() - 5000))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ck7b')) = 'unchanged' and pg_temp.s25_res((select resp from s25_resp where n = 'ck7b'))->>'level' = 'warn'
                     and pg_temp.s25_res((select resp from s25_resp where n = 'ck7b'))->'kept_website' = '["mr"]'::jsonb
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'ck7b')) = 'Mr# 25001 is not this checkup''s patient, so Mr# 25008 is put back. If this row is another patient, delete it and type that patient in a new row.'
                     and (pg_temp.s25_chk(pg_temp.s25_k(38))).patient_id = :pk,
  'another Mr# typed on a registered checkup is refused for the checkup (never moved to another patient by the sync): its Mr# is written back into the row');

-- a branch can only make so many checkups a day through the sheet
insert into public.checkups (checkup_date, branch_id, patient_name, source, created_at)
  select pg_temp.s25_today(), 5, 'Cap Checkup ' || g, 'google_sheet', now() from generate_series(1, 150) g;
insert into s25_resp select 'ckcap', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(43), '{"name":"One Too Many","treatment":"Checkup"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ckcap')) = 'needs_patient' and pg_temp.s25_msg((select resp from s25_resp where n = 'ckcap')) = 'Too many new checkups from the sheet today. Add this one on the website.'
                     and (select count(*) from public.checkups where patient_name = 'One Too Many') = 0, 'after 150 sheet checkups for a branch in a day the next one is refused');
delete from public.checkups where patient_name like 'Cap Checkup %';
-- the checkup table's own audit trigger still runs
select pg_temp.check((select count(*) >= 1 from public.audit_log where table_name = 'checkups' and action = 'INSERT' and row_id = (pg_temp.s25_chk(pg_temp.s25_k(30))).id::text), 'the website''s own audit trigger on checkups logs the insert as well');

-- =====================================================================
-- 7. The same patient on both sides, the same day
-- =====================================================================
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, details_text) values
  (:p7a, 2, pg_temp.s25_today(), 'waiting', 'Monthly', 'website details'),
  (:p7b, 2, pg_temp.s25_today(), 'waiting', 'Scaling', null);
insert into s25_resp select 'ad', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('NN', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(50), '{"mr":"25014","name":"Rana Tahir","treatment":"Monthly"}')),
  array[pg_temp.s25_k(50), 'W-' || (select id from public.visits where patient_id = :p7b and branch_id = 2 and visit_date = pg_temp.s25_today())]))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ad')) = 'linked' and (select count(*) from public.visits where patient_id = :p7a and branch_id = 2 and visit_date = pg_temp.s25_today()) = 1
                     and (select sheet_key = pg_temp.s25_k(50) and details_text = 'website details' from public.visits where patient_id = :p7a and branch_id = 2 and visit_date = pg_temp.s25_today()),
  'a sheet row for a patient the website already has today adopts that visit (still one visit, now linked, website details kept)');
select pg_temp.check((select sheet_key = 'W-' || id from public.visits where patient_id = :p7b and branch_id = 2 and visit_date = pg_temp.s25_today()), 'a website visit whose key shows up in the tab is claimed (sheet_key stored)');
insert into s25_resp select 'dup', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('NN', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(51), '{"mr":"25015","name":"Samina Gul","treatment":"Scaling"}')),
  array[pg_temp.s25_k(51), 'W-' || (select id from public.visits where patient_id = :p7b and branch_id = 2 and visit_date = pg_temp.s25_today())]))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'dup')) = 'duplicate'
                     and pg_temp.s25_res((select resp from s25_resp where n = 'dup'))->>'duplicate_of' = 'W-' || (select id from public.visits where patient_id = :p7b and branch_id = 2 and visit_date = pg_temp.s25_today())
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'dup')) like 'Already on this list in another row (Mr# 25015).%'
                     and (select count(*) from public.visits where patient_id = :p7b and branch_id = 2 and visit_date = pg_temp.s25_today()) = 1,
  'a second row for a patient whose visit is already on another row is a duplicate: one visit stays');
select pg_temp.check((select count(*) from public.visits v where v.sheet_key = pg_temp.s25_k(51)) = 0, 'the duplicate row got no visit');
-- a checkup the website made is claimed by its W key too, and its edits come through that key
insert into public.checkups (checkup_date, branch_id, patient_name, phone, source, day_status) values (pg_temp.s25_today(), 2, 'Website Checkup', '03120000001', 'website', 'waiting');
create temp table s25_wc as select id, 'W-' || id as k from public.checkups where patient_name = 'Website Checkup';
insert into s25_resp select 'wc1', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('NN', '[]', array[(select k from s25_wc)]))));
select pg_temp.check((select sheet_key = (select k from s25_wc) from public.checkups where id = (select id from s25_wc))
                     and (select x->>'kind' = 'checkup' and x->>'name' = 'Website Checkup' from jsonb_array_elements((select resp->'tabs'->0->'visits' from s25_resp where n = 'wc1')) x where x->>'key' = (select k from s25_wc)),
  'a checkup made on the website is in the day''s list and claimed when its W key shows up in the tab');
insert into s25_resp select 'wc2', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(pg_temp.s25_row((select k from s25_wc), '{"treatment":"Whitening"}', false, '{"treatment":""}', pg_temp.s25_now_ms() - 5000)), array[(select k from s25_wc)]));
select pg_temp.check((select checkup_for = 'Whitening' from public.checkups where id = (select id from s25_wc)) and pg_temp.s25_out((select resp from s25_resp where n = 'wc2')) = 'updated', 'a sheet edit reaches a website checkup through its W key');
-- a key of another branch or day
insert into s25_resp select 'ol', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(25), '{"mr":"25001","name":"Ayesha Khan","details":"moved"}', false),
  pg_temp.s25_row(pg_temp.s25_k(52), '{"mr":"25001","name":"Ayesha Khan"}', false),
  pg_temp.s25_row('W-00000000-0000-0000-0000-00000000dead', '{"name":"Nobody"}', false))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ol'), 0) = 'other_list' and (pg_temp.s25_vis(pg_temp.s25_k(25))).details_text = 'u l 018', 'a key that belongs to another branch changes nothing (other_list)');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ol'), 1) = 'gone' and pg_temp.s25_out((select resp from s25_resp where n = 'ol'), 2) = 'gone'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'ol'), 1) = 'This visit was deleted on the website. Delete this row.', 'an unknown key that is not new, and a W key with no visit, are gone');
insert into s25_resp select 'ol2', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(31), '{"details":"moved"}', false))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ol2')) = 'other_list' and (pg_temp.s25_chk(pg_temp.s25_k(31))).details is null, 'a checkup key sent in another branch''s tab changes nothing either');

-- an ADOPTED visit keeps what the website says (a stale sheet must not set a Completed visit back to Waiting)
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('26020', 'Adopt Me', '03120000020', 2);
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, details_text, completed_at)
  select id, 2, pg_temp.s25_today(), 'completed', 'Filling', 'done on the website', now() from public.patients where mr_number = '26020';
insert into s25_resp select 'adp', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(53),
  '{"mr":"26020","name":"Adopt Me","treatment":"Checkup","details":"typed this morning","status":{"t":"Waiting","v":"waiting"}}', true, null, pg_temp.s25_now_ms() + 5000))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'adp')) = 'linked'
                     and (select v.status = 'completed' and v.treatment_label = 'Filling' and v.details_text = 'done on the website' from pg_temp.s25_vis(pg_temp.s25_k(53)) v)
                     and pg_temp.s25_res((select resp from s25_resp where n = 'adp'))->'kept_website' @> '["status","treatment","details"]'::jsonb,
  'a sheet row that meets a visit the website already has (install, repair) keeps the website''s status, treatment and details, even with a newer stamp, and says so');

-- =====================================================================
-- 8. A Completed row completes the visit (owner rule, 9 Oct 2026): photo, checker, doctor-group and dues rules are skipped,
--    and the record says exactly that. The website's rules are still kept for every row that is not Completed.
-- =====================================================================
insert into public.braces_cases (patient_id, start_date, status) values (:pm, pg_temp.s25_today() - 120, 'active'), (:pn, pg_temp.s25_today() - 10, 'active'), (:po, pg_temp.s25_today() - 100, 'active');
insert into s25_resp select 'r1', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(60), '{"mr":"25010","name":"Mariam Zafar","treatment":"Monthly","month":{"t":"05","v":5},"status":{"t":"Waiting","v":"waiting"}}'),
  pg_temp.s25_row(pg_temp.s25_k(61), '{"mr":"25011","name":"Nida Sheikh","treatment":"Monthly","month":{"t":"1 Photo","v":1},"status":{"t":"Completed","v":"completed"}}'),
  pg_temp.s25_row(pg_temp.s25_k(62), '{"mr":"25012","name":"Omar Siddiqui","treatment":"Monthly","month":{"t":"6","v":6},"doctors":{"t":"Dr. Samrah Khan","v":["Dr. Samrah Khan"]}}'))));
select pg_temp.check((select v.braces_month = 5 and v.braces_case_id = (select id from public.braces_cases where patient_id = :pm) and v.status = 'waiting' from pg_temp.s25_vis(pg_temp.s25_k(60)) v),
  'month 5 goes on the patient''s active braces case');
select pg_temp.check((select v.status = 'completed' and v.protocol_override_by = pg_temp.s25_admin() and v.protocol_override_reason = 'Completed in the Google Sheet (owner rule, 9 Oct 2026)'
                             and v.braces_month = 1 from pg_temp.s25_vis(pg_temp.s25_k(61)) v)
                     and pg_temp.s25_res((select resp from s25_resp where n = 'r1'), 1)->>'level' = 'ok'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'r1'), 1) = 'Completed from the sheet (owner rule: the website''s photo step is not needed).',
  'a Completed row on a photo month completes the visit; the override says "Completed in the Google Sheet (owner rule, 9 Oct 2026)" and the row says so as a tick (the owner''s normal path, not "need attention": RS13-M1)');
select pg_temp.check((select count(*) = 1 and bool_and(actor = '00000000-0000-0000-0000-0000000aa500') and bool_and(new_data->'overrides' = '["photo"]'::jsonb)
                        from public.audit_log where action = 'SHEET_SYNC' and row_id = (pg_temp.s25_vis(pg_temp.s25_k(61))).id::text),
  'the audit actor of that completion is the Google Sheet sync, and the override is listed in it');
select pg_temp.check((select v.protocol_override_by is null and v.protocol_override_reason is null from pg_temp.s25_vis(pg_temp.s25_k(62)) v) and pg_temp.s25_docs(pg_temp.s25_k(62)) = ''
                     and pg_temp.s25_res((select resp from s25_resp where n = 'r1'), 2)->>'level' = 'warn'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'r1'), 2) = 'Dr. Samrah Khan is outside this month''s doctor group. The name stays in the row; the website adds it when the visit is marked Completed (owner rule).',
  'a row that is NOT Completed keeps the doctor-group rule: the doctor is not added to the visit, no override is recorded, the row says why');
-- ...but the doctor the sheet typed is not erased: the cell is not rewritten (nothing "kept" for the sheet to overwrite), canon still lists the name
select pg_temp.check(pg_temp.s25_res((select resp from s25_resp where n = 'r1'), 2)->'kept_website' = '[]'::jsonb
                     and private.aaj_canon((pg_temp.s25_vis(pg_temp.s25_k(62))).id)->>'doctors' = 'Dr. Samrah Khan'
                     and (select (v.sheet_cells->'doctors'->'pending') = jsonb_build_array((select id::text from public.clinicians where display_name = 'Dr. Samrah Khan')) from pg_temp.s25_vis(pg_temp.s25_k(62)) v),
  'the refused doctor is kept as the sheet''s text (pending): the website does not tell the sheet to take the doctor out of the cell');
select pg_temp.check((select new_data->'sheet_text_not_applied' = '{}'::jsonb from public.audit_log where action = 'SHEET_SYNC' and row_id = (pg_temp.s25_vis(pg_temp.s25_k(62))).id::text order by id desc limit 1),
  'and nothing of the typed text is lost: the audit row records no text that was not applied');
-- the usual order of work: doctor first, Completed last. Completing the row adds the doctor, recorded as the owner rule
insert into s25_resp select 'r1c', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(62),
  '{"status":{"t":"Completed","v":"completed"}}', false, '{"status":"Waiting"}', pg_temp.s25_now_ms() + 1000)), array[pg_temp.s25_k(62)]));
select pg_temp.check((select v.status = 'completed' and v.protocol_override_by = pg_temp.s25_admin() and v.protocol_override_reason = 'Completed in the Google Sheet (owner rule, 9 Oct 2026)'
                             and v.sheet_cells->'doctors'->'pending' = '[]'::jsonb from pg_temp.s25_vis(pg_temp.s25_k(62)) v)
                     and pg_temp.s25_docs(pg_temp.s25_k(62)) = 'Dr. Samrah Khan:doctor' and private.aaj_canon((pg_temp.s25_vis(pg_temp.s25_k(62))).id)->>'doctors' = 'Dr. Samrah Khan'
                     and pg_temp.s25_res((select resp from s25_resp where n = 'r1c'))->'kept_website' = '[]'::jsonb
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'r1c')) = 'Completed from the sheet (owner rule: the website''s check step is not needed).'
                     and pg_temp.s25_res((select resp from s25_resp where n = 'r1c'))->>'level' = 'ok',
  'the doctor typed first is added when the row is marked Completed later (status alone is sent): the owner-rule override of the completion lets the group rule pass, and the cell was never rewritten');
select pg_temp.check((select count(*) = 1 from public.audit_log where action = 'SHEET_SYNC' and row_id = (pg_temp.s25_vis(pg_temp.s25_k(62))).id::text and new_data->'overrides' @> '["check"]'::jsonb
                             and new_data->'changed' @> '["status"]'::jsonb and actor = '00000000-0000-0000-0000-0000000aa500'),
  'and the completion with its override is in the audit log under the Google Sheet sync');
-- a pending doctor that the sheet takes out of the cell again is dropped for good: Completed later does not add them
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('26022', 'Pending Doc', '03120000022', 5);
insert into public.braces_cases (patient_id, start_date, status) select id, pg_temp.s25_today() - 100, 'active' from public.patients where mr_number = '26022';
insert into s25_resp select 'r1d', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(1300),
  '{"mr":"26022","name":"Pending Doc","treatment":"Monthly","month":{"t":"5","v":5},"doctors":{"t":"Dr. Samrah Khan, Hira Anis","v":["Dr. Samrah Khan","Hira Anis"]}}'))));
select pg_temp.check(pg_temp.s25_docs(pg_temp.s25_k(1300)) = 'Hira Anis:assistant' and private.aaj_canon((pg_temp.s25_vis(pg_temp.s25_k(1300))).id)->>'doctors' = 'Dr. Samrah Khan, Hira Anis'
                     and pg_temp.s25_res((select resp from s25_resp where n = 'r1d'))->'kept_website' = '[]'::jsonb,
  'a new row with one allowed and one refused doctor: the allowed one is added, the refused one stays pending, and the cell keeps the typed text');
insert into s25_resp select 'r1e', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(1300),
  '{"doctors":{"t":"Hira Anis","v":["Hira Anis"]}}', false, '{"doctors":["Dr. Samrah Khan","Hira Anis"]}', pg_temp.s25_now_ms() + 1000)), array[pg_temp.s25_k(1300)]));
insert into s25_resp select 'r1f', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(1300),
  '{"status":{"t":"Completed","v":"completed"}}', false, '{"status":"Waiting"}', pg_temp.s25_now_ms() + 2000)), array[pg_temp.s25_k(1300)]));
select pg_temp.check((pg_temp.s25_vis(pg_temp.s25_k(1300))).sheet_cells->'doctors'->'pending' = '[]'::jsonb and pg_temp.s25_docs(pg_temp.s25_k(1300)) = 'Hira Anis:assistant'
                     and private.aaj_canon((pg_temp.s25_vis(pg_temp.s25_k(1300))).id)->>'doctors' = 'Hira Anis' and (pg_temp.s25_vis(pg_temp.s25_k(1300))).status = 'completed',
  'the sheet took the refused doctor out of the cell: the pending name is gone, and marking the row Completed does not add them');
-- a second doctor is added while the first (refused) one is still pending: the pending doctor stays, and still joins when the row is Completed
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('26023', 'Pending Two', '03120000023', 5);
insert into public.braces_cases (patient_id, start_date, status) select id, pg_temp.s25_today() - 100, 'active' from public.patients where mr_number = '26023';
insert into s25_resp select 'r1g', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(1301),
  '{"mr":"26023","name":"Pending Two","treatment":"Monthly","month":{"t":"5","v":5},"doctors":{"t":"Dr. Samrah Khan","v":["Dr. Samrah Khan"]}}'))));
insert into s25_resp select 'r1h', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(1301),
  '{"doctors":{"t":"Dr. Samrah Khan, Hira Anis","v":["Dr. Samrah Khan","Hira Anis"]}}', false, '{"doctors":["Dr. Samrah Khan"]}', pg_temp.s25_now_ms() + 1000)), array[pg_temp.s25_k(1301)]));
select pg_temp.check(pg_temp.s25_docs(pg_temp.s25_k(1301)) = 'Hira Anis:assistant'
                     and (pg_temp.s25_vis(pg_temp.s25_k(1301))).sheet_cells->'doctors'->'pending' = jsonb_build_array((select id::text from public.clinicians where display_name = 'Dr. Samrah Khan'))
                     and private.aaj_canon((pg_temp.s25_vis(pg_temp.s25_k(1301))).id)->>'doctors' = 'Dr. Samrah Khan, Hira Anis',
  'another doctor added to the cell while the first is pending: the pending doctor is not dropped');
insert into s25_resp select 'r1i', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(1301),
  '{"status":{"t":"Completed","v":"completed"}}', false, '{"status":"Waiting"}', pg_temp.s25_now_ms() + 2000)), array[pg_temp.s25_k(1301)]));
select pg_temp.check(pg_temp.s25_docs(pg_temp.s25_k(1301)) = 'Dr. Samrah Khan:doctor, Hira Anis:assistant' and (pg_temp.s25_vis(pg_temp.s25_k(1301))).sheet_cells->'doctors'->'pending' = '[]'::jsonb,
  'and both doctors are on the visit once the row is Completed');

-- an existing visit set to Completed from the sheet (month 5: the checker group must check)
insert into s25_resp select 'r2', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(60),
  '{"status":{"t":"Completed","v":"completed"}}', false, '{"status":"Waiting"}', (pg_temp.s25_now_ms() + 1000)))));
select pg_temp.check((select v.status = 'completed' and v.protocol_override_by = pg_temp.s25_admin() and v.protocol_override_reason = 'Completed in the Google Sheet (owner rule, 9 Oct 2026)' from pg_temp.s25_vis(pg_temp.s25_k(60)) v)
                     and pg_temp.s25_out((select resp from s25_resp where n = 'r2')) = 'updated' and pg_temp.s25_msg((select resp from s25_resp where n = 'r2')) = 'Completed from the sheet (owner rule: the website''s check step is not needed).'
                     and pg_temp.s25_res((select resp from s25_resp where n = 'r2'))->>'level' = 'ok',
  'a Waiting visit marked Completed in the sheet: the checker rule is skipped, recorded as the owner rule, and the row is a tick');
select pg_temp.check((select count(*) from public.audit_log where table_name = 'visits' and action = 'SHEET_SYNC' and new_data->'overrides' = '["check"]'::jsonb and row_id = (pg_temp.s25_vis(pg_temp.s25_k(60))).id::text) = 1, 'the override is in the audit row');
-- a doctor outside the month's group on a visit that is Completed in the sheet: added, recorded as the owner rule
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('26021', 'Group Test', '03120000021', 5);
insert into public.braces_cases (patient_id, start_date, status) select id, pg_temp.s25_today() - 100, 'active' from public.patients where mr_number = '26021';
alter table public.visits disable trigger visits_before_write;        -- a month-5 visit that was Completed on the website with no override (the website's own checker did the check)
insert into public.visits (patient_id, branch_id, visit_date, status, braces_case_id, braces_month, treatment_label, completed_at)
  select p.id, 5, pg_temp.s25_today(), 'completed', c.id, 5, 'Monthly', now() from public.patients p join public.braces_cases c on c.patient_id = p.id where p.mr_number = '26021';
alter table public.visits enable trigger visits_before_write;
insert into s25_resp select 'r2g', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(66),
  '{"mr":"26021","name":"Group Test","status":{"t":"Completed","v":"completed"},"doctors":{"t":"Dr. Samrah Khan","v":["Dr. Samrah Khan"]}}'))));
select pg_temp.check(pg_temp.s25_docs(pg_temp.s25_k(66)) = 'Dr. Samrah Khan:doctor' and (select v.protocol_override_by = pg_temp.s25_admin() and v.protocol_override_reason = 'Completed in the Google Sheet (owner rule, 9 Oct 2026)' from pg_temp.s25_vis(pg_temp.s25_k(66)) v)
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'r2g')) like 'Dr. Samrah Khan is outside this month''s doctor group. Saved because the visit is Completed in the sheet (owner rule).'
                     and pg_temp.s25_res((select resp from s25_resp where n = 'r2g'))->>'level' = 'ok',
  'a doctor outside the month''s group on a Completed row is added, recorded as the owner rule, and the row is a tick');

-- dues hold (block mode): a Completed row completes, and the dues are not held; a Treatment row is held back by the website's rule
insert into public.invoices (patient_id, branch_id) values (:pq, 3);
insert into public.invoice_items (invoice_id, description, unit_price) select id, 'Bonding', 5000 from public.invoices where patient_id = :pq;
update public.app_settings set value = '"block"' where key = 'dues_hold_mode';
insert into s25_resp select 'r3', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(63),
  '{"mr":"25013","name":"Qasim Ali","status":{"t":"Completed","v":"completed"}}'))));
select pg_temp.check((select v.status = 'completed' and v.dues_override_by = pg_temp.s25_admin() and v.dues_override_reason = 'Completed in the Google Sheet (owner rule, 9 Oct 2026)' from pg_temp.s25_vis(pg_temp.s25_k(63)) v)
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'r3')) = 'Completed from the sheet. Pending dues Rs 5,000 were not held (owner rule).'
                     and pg_temp.s25_res((select resp from s25_resp where n = 'r3'))->>'level' = 'warn',
  'dues hold: a Completed row completes (not every patient owes money); the dues override is recorded as the owner rule and stays a warning (front desk may still collect)');
insert into s25_resp select 'r3b', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(67),
  '{"mr":"25013","name":"Qasim Ali","status":{"t":"Treatment","v":"in_treatment"}}'))));
select pg_temp.check((select v.status = 'waiting' and v.dues_override_by is null from pg_temp.s25_vis(pg_temp.s25_k(67)) v)
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'r3b')) = 'Not saved as Treatment: pending dues Rs 5,000.' and pg_temp.s25_res((select resp from s25_resp where n = 'r3b'))->'kept_website' = '["status"]'::jsonb,
  'dues hold: a row that is only Treatment is still held back by the website''s rule, with no override');

-- the other choice: hold the status back for every row (the owner can switch: update private.aaj_sync_config set value = 'hold' where key = 'rules')
update private.aaj_sync_config set value = 'hold' where key = 'rules';
update public.invoices set status = 'issued' where patient_id = :pq;
insert into s25_resp select 'r4', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(64), '{"mr":"25013","name":"Qasim Ali","status":{"t":"Completed","v":"completed"},"treatment":"Checkup"}'),
  pg_temp.s25_row(pg_temp.s25_k(65), '{"mr":"25012","name":"Omar Siddiqui","month":{"t":"4 Photo","v":4},"status":{"t":"Completed","v":"completed"}}'))));
select pg_temp.check(pg_temp.s25_res((select resp from s25_resp where n = 'r4'), 0)->>'level' = 'warn' and pg_temp.s25_res((select resp from s25_resp where n = 'r4'), 0)->>'kept_website' = '["status"]'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'r4'), 0) = 'Not saved as Completed: pending dues Rs 5,000.'
                     and (select v.status = 'waiting' and v.dues_override_by is null and v.treatment_label = 'Checkup' from pg_temp.s25_vis(pg_temp.s25_k(64)) v),
  'hold mode: the dues rule keeps the status back (waiting), the rest of the row is saved, no override, the sheet is told to take the website''s status');
select pg_temp.check((select v.status = 'in_treatment' and v.protocol_override_by is null from pg_temp.s25_vis(pg_temp.s25_k(65)) v) and pg_temp.s25_msg((select resp from s25_resp where n = 'r4'), 1) like 'Not saved as Completed: this is a photo month%',
  'hold mode: a photo month marked Completed is saved as Treatment, without any override');
select pg_temp.check((select new_data->'sheet_text_not_applied' = '{"status":"Completed"}'::jsonb and new_data->'kept_website' = '["status"]'::jsonb from public.audit_log where action = 'SHEET_SYNC' and row_id = (pg_temp.s25_vis(pg_temp.s25_k(64))).id::text order by id desc limit 1),
  'hold mode: the status text the website held back is in the audit log');
update private.aaj_sync_config set value = 'override' where key = 'rules';
update public.app_settings set value = '"warn"' where key = 'dues_hold_mode';

-- =====================================================================
-- 9. Both sides edit: per field, the later edit wins; what the website changed is kept; doctors merge
-- =====================================================================
insert into s25_resp select 'cf0', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(70),
  '{"mr":"25009","name":"Laiba Noor","treatment":"Checkup","details":"orig","token":{"t":"3","v":3}}'))));
update public.visits set details_text = 'web details' where sheet_key = pg_temp.s25_k(70);
-- an older sheet edit of the same field loses
insert into s25_resp select 'cf1', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(70),
  '{"details":"sheet old"}', false, '{"details":"orig"}', pg_temp.s25_now_ms() - 60000))));
select pg_temp.check((pg_temp.s25_vis(pg_temp.s25_k(70))).details_text = 'web details' and pg_temp.s25_res((select resp from s25_resp where n = 'cf1'))->'kept_website' = '["details"]'::jsonb, 'both sides changed details, the sheet''s edit is older: the website''s value stays and the sheet is told');
select pg_temp.check((select new_data->'sheet_text_not_applied' = '{"details":"sheet old"}'::jsonb from public.audit_log where action = 'SHEET_SYNC' and row_id = (pg_temp.s25_vis(pg_temp.s25_k(70))).id::text order by id desc limit 1),
  'the sheet''s text that lost is kept in the audit log: nothing is lost silently');
-- a newer one wins
insert into s25_resp select 'cf2', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(70),
  '{"details":"sheet new"}', false, '{"details":"orig"}', pg_temp.s25_now_ms() + 60000))));
select pg_temp.check((pg_temp.s25_vis(pg_temp.s25_k(70))).details_text = 'sheet new' and pg_temp.s25_res((select resp from s25_resp where n = 'cf2'))->'kept_website' = '[]'::jsonb, 'the sheet''s edit is newer: the sheet wins');
select pg_temp.check((select old_data->>'details' = 'web details' from public.audit_log where action = 'SHEET_SYNC' and row_id = (pg_temp.s25_vis(pg_temp.s25_k(70))).id::text order by id desc limit 1), 'the website value it replaced is in the audit log');
-- different fields: both are kept
update public.visits set treatment_label = 'Scaling' where sheet_key = pg_temp.s25_k(70);
insert into s25_resp select 'cf3', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(70),
  '{"details":"sheet 3"}', false, '{"details":"sheet new"}', pg_temp.s25_now_ms() - 60000))));
select pg_temp.check((select v.treatment_label = 'Scaling' and v.details_text = 'sheet 3' from pg_temp.s25_vis(pg_temp.s25_k(70)) v), 'the website changed the treatment while the sheet changed the details: both changes are kept (merge per field, not per row)');
-- a field the sheet did not change is never sent, so the website's value stays; an old edit of an untouched-by-web field applies
insert into s25_resp select 'cf4', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(70),
  '{"treatment":"Filling"}', false, '{"treatment":"Scaling"}', pg_temp.s25_now_ms() - 600000))));
select pg_temp.check((pg_temp.s25_vis(pg_temp.s25_k(70))).treatment_label = 'Filling' and (pg_temp.s25_vis(pg_temp.s25_k(70))).treatment_id = (select id from public.treatments where name = 'Filling'),
  'an old sheet edit still applies when the website did not touch that field since the sheet last saw it');

-- doctors: base [A]; the website adds B; the sheet removes A and adds C -> B and C
insert into s25_resp select 'dc0', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(71),
  '{"mr":"25010","name":"Mariam Zafar","doctors":{"t":"Dr Haniya","v":["Dr Haniya"]}}'))));
insert into public.visit_staff (visit_id, clinician_id, role)
  select (pg_temp.s25_vis(pg_temp.s25_k(71))).id, id, 'assistant' from public.clinicians where display_name = 'Hira Anis';
insert into s25_resp select 'dc1', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(71),
  '{"doctors":{"t":"Dr. Samrah Khan","v":["Dr. Samrah Khan"]}}', false, '{"doctors":["Dr Haniya"]}', pg_temp.s25_now_ms()))));
select pg_temp.check(pg_temp.s25_docs(pg_temp.s25_k(71)) = 'Dr. Samrah Khan:doctor, Hira Anis:assistant', 'doctors merge: base [Haniya], website added Hira, sheet swapped Haniya for Samrah -> Hira and Samrah');
select pg_temp.check(private.aaj_canon((pg_temp.s25_vis(pg_temp.s25_k(71))).id)->>'doctors' = 'Dr. Samrah Khan, Hira Anis', 'the merged doctor list reads doctor first, then assistant');

-- =====================================================================
-- 10. Tokens: one per branch and day here, per group in the sheet, kit text in the Token cell
-- =====================================================================
insert into s25_resp select 'tk', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(80), '{"mr":"25003","name":"Muhammad Umer","token":{"t":"41","v":41}}'),
  pg_temp.s25_row(pg_temp.s25_k(81), '{"mr":"25004","name":"Sana Ahmed","token":{"t":"41","v":41}}'),
  pg_temp.s25_row(pg_temp.s25_k(82), '{"mr":"25005","name":"Hina Baig","token":{"t":"Kit 80k","v":null}}'),
  pg_temp.s25_row(pg_temp.s25_k(83), '{"mr":"25006","name":"Dina Rao"}'))));
select pg_temp.check((select token_no from pg_temp.s25_vis(pg_temp.s25_k(80))) = 41, 'the first row asking for token 41 gets it');
select pg_temp.check((select v.token_no is distinct from 41 from pg_temp.s25_vis(pg_temp.s25_k(81)) v) and pg_temp.s25_msg((select resp from s25_resp where n = 'tk'), 1) like 'Token 41 is already used by %. Token not changed on the website.'
                     and pg_temp.s25_res((select resp from s25_resp where n = 'tk'), 1)->>'level' = 'warn', 'a token another visit already holds today is not given twice: warn, token unchanged on the website');
select pg_temp.check(private.aaj_canon((pg_temp.s25_vis(pg_temp.s25_k(81))).id)->>'token' = '41', 'and the sheet''s typed "1" is never overwritten by the website''s number');
select pg_temp.check((select v.token_no is distinct from 80 from pg_temp.s25_vis(pg_temp.s25_k(82)) v) and (pg_temp.s25_vis(pg_temp.s25_k(82))).sheet_cells->'token'->>'t' = 'Kit 80k'
                     and private.aaj_canon((pg_temp.s25_vis(pg_temp.s25_k(82))).id)->>'token' = 'Kit 80k', '"Kit 80k" in the Token cell is not a token: kept as the sheet''s text, even after the website numbered the visit');
select pg_temp.check(private.aaj_canon((pg_temp.s25_vis(pg_temp.s25_k(83))).id)->>'token' = (pg_temp.s25_vis(pg_temp.s25_k(83))).token_no::text and (pg_temp.s25_vis(pg_temp.s25_k(83))).token_no is not null,
  'a row with no token gets the website''s token, to be written into the empty cell');
-- a website token change shows up in a number cell the website owns, never in a text cell
update public.visits set token_no = 77 where sheet_key = pg_temp.s25_k(80);
update public.visits set token_no = 78 where sheet_key = pg_temp.s25_k(82);
select pg_temp.check(private.aaj_canon((pg_temp.s25_vis(pg_temp.s25_k(80))).id)->>'token' = '77' and private.aaj_canon((pg_temp.s25_vis(pg_temp.s25_k(82))).id)->>'token' = 'Kit 80k',
  'a token the website changes is shown in a number cell, but never over kit text');

-- =====================================================================
-- 11. How the website's list reads back (canon)
-- =====================================================================
insert into s25_resp select 'cn', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(90),
  '{"mr":"25013","name":"Qasim Ali","month":{"t":"21 Photo","v":21},"group":{"t":"Group 1, Group 2","v":1},"doctors":{"t":"Hira Anis, Dr Unknown Person","v":["Hira Anis","Dr Unknown Person"]},"details":"U L 018"}'))));
select pg_temp.check((select c->>'month' = '21 Photo' and c->>'group' = 'Group 1, Group 2' and c->>'doctors' = 'Hira Anis, Dr Unknown Person' and c->>'mr' = '25013' and c->>'key' = pg_temp.s25_k(90)
                             and c->>'pp' = '5,000' and c->>'name' = 'Qasim Ali' and c->>'phone' = '03000001112' and c->>'status' = 'Waiting' and (c->>'removed')::boolean = false and c->>'kind' = 'visit'
                        from (select private.aaj_canon((pg_temp.s25_vis(pg_temp.s25_k(90))).id) c) x),
  'canon: the sheet''s own wording for month, group and doctors is kept; the amount is formatted; the phone and Mr# are the patient''s');
select pg_temp.check((select array_agg(private.aaj_status_label(s::public.visit_status) order by o) from unnest(array['scheduled','waiting','in_treatment','completed','cancelled','no_show']) with ordinality t(s, o))
                     = array['Scheduled','Waiting','Treatment','Completed','Cancelled','No show'], 'status labels: Scheduled, Waiting, Treatment, Completed, Cancelled, No show');
update public.visits set braces_month = 22 where sheet_key = pg_temp.s25_k(90);
select pg_temp.check(private.aaj_canon((pg_temp.s25_vis(pg_temp.s25_k(90))).id)->>'month' = '22 Photo', 'when the website changes the month, the sheet gets the website''s month formatted the website''s way (not the old typed text)');
select pg_temp.check((select (c ? 'key') and (c ? 'id') and (c ? 'kind') and (c ? 'mr') and (c ? 'name') and (c ? 'phone') and (c ? 'month') and (c ? 'treatment') and (c ? 'token') and (c ? 'status') and (c ? 'group')
                             and (c ? 'doctors') and (c ? 'details') and (c ? 'pp') and (c ? 'removed') and (c ? 'claimed') and (c ? 'updated_at') and (select count(*) from jsonb_object_keys(c)) = 17
                             and (c->>'claimed')::boolean
                        from (select private.aaj_canon((pg_temp.s25_vis(pg_temp.s25_k(90))).id) c) x),
  'canon of a visit has exactly the seventeen fields of the contract (nothing more about the patient than the sheet already shows); a sheet row''s visit is "claimed"');

-- =====================================================================
-- 12. A row DELETED in the sheet removes the visit / checkup from the website (owner rule, 9 Oct 2026) - safely
-- =====================================================================
create or replace function pg_temp.s25_nn_keys(excl text[] default '{}') returns text[] language sql as $$
  select coalesce(array(select k from (
           select sheet_key as k from public.visits where branch_id = 2 and visit_date = pg_temp.s25_today()
           union all select sheet_key from public.checkups where branch_id = 2 and checkup_date = pg_temp.s25_today()) x
          where k is not null and k <> all (excl)), '{}') $$;
create or replace function pg_temp.s25_rm(p_resp jsonb, p_key text) returns jsonb language sql as $$
  select x from jsonb_array_elements(p_resp->'tabs'->0->'removed') x where x->>'key' = p_key $$;
grant execute on all functions in schema pg_temp to authenticated, anon;
-- an empty Northern list for today, then fifteen rows on it: 10 visits (one with a doctor, a token and sheet text), 2 checkups, 3 more visits
delete from public.visits where branch_id = 2 and visit_date = pg_temp.s25_today();
delete from public.checkups where branch_id = 2 and checkup_date = pg_temp.s25_today();
insert into public.patients (mr_number, full_name, phone, first_branch_id)
  select '2700' || g, 'Bulk Patient ' || chr(64 + g), '0312000010' || g, 2 from generate_series(1, 9) g;
insert into s25_resp select 'rm0', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(100), '{"mr":"25001","name":"Ayesha Khan","treatment":"Checkup","token":{"t":"5","v":5},"doctors":{"t":"Dr Haniya","v":["Dr Haniya"]},"pp":"35k","reminder":"call"}'),
  pg_temp.s25_row(pg_temp.s25_k(101), '{"mr":"25002","name":"Sadia Khan","treatment":"Checkup","status":{"t":"Completed","v":"completed"}}'),
  pg_temp.s25_row(pg_temp.s25_k(102), '{"mr":"25003","name":"Muhammad Umer","treatment":"Checkup","status":{"t":"Scheduled","v":"scheduled"}}'),
  pg_temp.s25_row(pg_temp.s25_k(103), '{"mr":"25004","name":"Sana Ahmed","treatment":"Checkup"}'),
  pg_temp.s25_row(pg_temp.s25_k(104), '{"mr":"25005","name":"Hina Baig"}'),
  pg_temp.s25_row(pg_temp.s25_k(120), '{"name":"Check One","phone":"03120000120","treatment":"Checkup"}'),
  pg_temp.s25_row(pg_temp.s25_k(121), '{"name":"Check Two","phone":"03120000121","treatment":"Checkup"}'),
  pg_temp.s25_row(pg_temp.s25_k(105), '{"mr":"27001","name":"Bulk Patient A"}'),
  pg_temp.s25_row(pg_temp.s25_k(106), '{"mr":"27002","name":"Bulk Patient B"}'),
  pg_temp.s25_row(pg_temp.s25_k(107), '{"mr":"27003","name":"Bulk Patient C"}'),
  pg_temp.s25_row(pg_temp.s25_k(108), '{"mr":"27004","name":"Bulk Patient D"}'),
  pg_temp.s25_row(pg_temp.s25_k(109), '{"mr":"27005","name":"Bulk Patient E"}'),
  pg_temp.s25_row(pg_temp.s25_k(110), '{"mr":"27006","name":"Bulk Patient F"}'),
  pg_temp.s25_row(pg_temp.s25_k(111), '{"mr":"27007","name":"Bulk Patient G"}'))));
select pg_temp.check((select count(*) = 14 and bool_and((x->>'outcome') = 'created') from jsonb_array_elements((select resp->'tabs'->0->'results' from s25_resp where n = 'rm0')) x), 'the Northern list for the removal cases: 12 visits and 2 checkups made from the sheet');
insert into public.invoices (visit_id, patient_id, branch_id) select id, patient_id, 2 from public.visits where sheet_key = pg_temp.s25_k(103);
create temp table s25_ids as select k, (select id from public.visits where sheet_key = k) as vid from (values (pg_temp.s25_k(100)), (pg_temp.s25_k(101)), (pg_temp.s25_k(102)), (pg_temp.s25_k(103))) t(k);
insert into s25_cnt select 'rm0', (select count(*) from public.patients), (select count(*) from public.visits), (select count(*) from public.checkups);

-- four rows gone at once (more than 3) is a mistake in the sheet, not a clinic decision: nothing is removed
insert into s25_resp select 'rm1', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('NN', '[]', pg_temp.s25_nn_keys(array[pg_temp.s25_k(100), pg_temp.s25_k(101), pg_temp.s25_k(102), pg_temp.s25_k(103)]),
  (select resp->'tabs'->0->>'hash' from s25_resp where n = 'rm0'))), true));
select pg_temp.check((select (resp->'tabs'->0->>'unchanged')::boolean = false and resp->'tabs'->0 ? 'visits' and jsonb_array_length(resp->'tabs'->0->'removed') = 4
                        and (select bool_and(x->>'action' = 'restore' and x->>'message' like 'Needs attention: 4 rows disappeared at once, so nothing was removed from the website.%') from jsonb_array_elements(resp->'tabs'->0->'removed') x) from s25_resp where n = 'rm1'),
  'four rows gone at once: all four are put back as "Needs attention" and the list comes with the answer (the script needs it to write the rows back)');
select pg_temp.check((select count(*) from public.visits where sheet_key in (pg_temp.s25_k(100), pg_temp.s25_k(101), pg_temp.s25_k(102), pg_temp.s25_k(103)) and status <> 'cancelled') = 4
                     and (select count(*) from public.visits) = (select visits from s25_cnt where n = 'rm0'), 'the guard removed and cancelled nothing');
-- the tab cleared by the archive (or by a mistake): nothing is removed, however many rows were there
insert into s25_resp select 'rm1b', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('NN', '[]', '{}')), true));
select pg_temp.check((select count(*) = 14 and bool_and(x->>'action' = 'restore') from jsonb_array_elements((select resp->'tabs'->0->'removed' from s25_resp where n = 'rm1b')) x)
                     and (select count(*) from public.visits) = (select visits from s25_cnt where n = 'rm0') and (select count(*) from public.checkups where branch_id = 2 and checkup_date = pg_temp.s25_today()) = 2,
  'a tab that reads empty (cleared by the nightly archive, or by a mistake) removes nothing: all 14 are put back');
-- no list of present rows at all (a quick check of the website's side only): the removal pass does not run
insert into s25_resp select 'rm1c', pg_temp.s25_sync(jsonb_build_object('date', pg_temp.s25_today(), 'check_removed', true, 'tabs', jsonb_build_array(jsonb_build_object('branch', 'NN', 'hash', null, 'rows', '[]'::jsonb))));
select pg_temp.check((select resp->'tabs'->0->'removed' = '[]'::jsonb from s25_resp where n = 'rm1c') and (select count(*) from public.visits) = (select visits from s25_cnt where n = 'rm0'),
  'a call that sends no list of present rows (a quick check for website changes) never removes anything');
-- check_removed false: rows that are missing are not looked at
insert into s25_resp select 'rm1d', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('NN', '[]', pg_temp.s25_nn_keys(array[pg_temp.s25_k(100)]))), false));
select pg_temp.check((select resp->'tabs'->0->'removed' from s25_resp where n = 'rm1d') = '[]'::jsonb and exists (select 1 from public.visits where sheet_key = pg_temp.s25_k(100)), 'check_removed false: rows that are missing are not looked at');

-- three rows gone: a plain waiting visit is removed, a Completed one is put back, one with an invoice is kept and marked Cancelled
insert into s25_resp select 'rm2', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('NN', '[]', pg_temp.s25_nn_keys(array[pg_temp.s25_k(100), pg_temp.s25_k(101), pg_temp.s25_k(103)]))), true));
select pg_temp.check((select x->>'action' = 'deleted' and x->>'message' like 'Row deleted in the sheet: the visit is removed from the website too.%' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'rm2'), pg_temp.s25_k(100)) x) y)
                     and not exists (select 1 from public.visits where sheet_key = pg_temp.s25_k(100)) and not exists (select 1 from public.visits where id = (select vid from s25_ids where k = pg_temp.s25_k(100))),
  'a waiting visit with nothing attached whose row is deleted is removed from the website');
select pg_temp.check((select a.old_data->>'id' = (select vid::text from s25_ids where k = pg_temp.s25_k(100)) and a.old_data->>'status' = 'waiting' and a.new_data->>'action' = 'deleted' and a.new_data->>'branch' = 'NN'
                             and a.new_data->>'key' = pg_temp.s25_k(100) and a.actor = '00000000-0000-0000-0000-0000000aa500' and jsonb_array_length(a.new_data->'staff') = 1 and a.new_data->'text'->>'pp' = '35k'
                        from public.audit_log a where a.action = 'SHEET_REMOVED' and a.table_name = 'visits' and a.row_id = (select vid::text from s25_ids where k = pg_temp.s25_k(100))),
  'the removal is in the audit log with the whole row, its doctors and its sheet text, attributed to the sync');
select pg_temp.check((select x->>'action' = 'restore' and x->>'message' = 'Not removed: this visit is Completed on the website. To take a patient off, set Status to Cancelled.' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'rm2'), pg_temp.s25_k(101)) x) y)
                     and (pg_temp.s25_vis(pg_temp.s25_k(101))).status = 'completed', 'a Completed visit is never removed by a deleted row: it is kept and put back');
select pg_temp.check((select x->>'action' = 'kept' and x->>'message' = 'Kept on the website and marked Cancelled: it has an attached record (invoices).' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'rm2'), pg_temp.s25_k(103)) x) y)
                     and (select v.status = 'cancelled' and v.notes like 'Row deleted in the Google Sheet (North Nazimabad) %: kept, marked Cancelled' and not (v.sheet_cells ? 'removed') from pg_temp.s25_vis(pg_temp.s25_k(103)) v),
  'a visit with an invoice is kept and marked Cancelled, with the reason in the row''s message and the visit''s note');
select pg_temp.check((select x->>'status' = 'Cancelled' from jsonb_array_elements((select resp->'tabs'->0->'visits' from s25_resp where n = 'rm2')) x where x->>'key' = pg_temp.s25_k(103))
                     and not exists (select 1 from jsonb_array_elements((select resp->'tabs'->0->'visits' from s25_resp where n = 'rm2')) x where x->>'key' = pg_temp.s25_k(100)),
  'the list that comes back shows the kept visit as Cancelled (so the row returns with that status) and no longer has the removed one');
select pg_temp.check((select count(*) from public.audit_log where action = 'SHEET_REMOVED' and new_data->>'action' = 'kept_cancelled' and row_id = (select vid::text from s25_ids where k = pg_temp.s25_k(103))) = 1, 'keeping a visit is audited too');
-- a Scheduled visit with nothing attached is removed too
insert into s25_resp select 'rm3', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('NN', '[]', pg_temp.s25_nn_keys(array[pg_temp.s25_k(102)]))), true));
select pg_temp.check((select x->>'action' = 'deleted' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'rm3'), pg_temp.s25_k(102)) x) y) and not exists (select 1 from public.visits where sheet_key = pg_temp.s25_k(102)),
  'a Scheduled visit with nothing attached is removed');

-- undo 1: the row comes back in the sheet (Ctrl+Z): the visit is put back with its key, token, doctors and sheet text
insert into s25_resp select 'rm4', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('NN', '[]', pg_temp.s25_nn_keys() || pg_temp.s25_k(100))), false));
select pg_temp.check((select v.id = (select vid from s25_ids where k = pg_temp.s25_k(100)) and v.status = 'waiting' and v.token_no = 5 and v.treatment_label = 'Checkup' from pg_temp.s25_vis(pg_temp.s25_k(100)) v)
                     and pg_temp.s25_docs(pg_temp.s25_k(100)) = 'Dr. Haniya Siddiqui:doctor'
                     and (select t.pp = '35k' and t.reminder = 'call' from private.aaj_visit_text t where t.visit_id = (select vid from s25_ids where k = pg_temp.s25_k(100)))
                     and exists (select 1 from jsonb_array_elements((select resp->'tabs'->0->'visits' from s25_resp where n = 'rm4')) x where x->>'key' = pg_temp.s25_k(100)),
  'undoing the deletion in the sheet puts the same visit back (same id, key, token, doctors, sheet text) and it is in the answer');
select pg_temp.check((select count(*) = 1 and bool_and(actor = '00000000-0000-0000-0000-0000000aa500') from public.audit_log where action = 'SHEET_RESTORED' and new_data->>'key' = pg_temp.s25_k(100)), 'the restore is audited');
insert into s25_resp select 'rm4b', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('NN', '[]', pg_temp.s25_nn_keys())), false));
select pg_temp.check((select count(*) from public.visits where sheet_key = pg_temp.s25_k(100)) = 1 and (select count(*) from public.audit_log where action = 'SHEET_RESTORED' and new_data->>'key' = pg_temp.s25_k(100)) = 1,
  'a second call does not restore it twice');
-- the deleted row of the visit that was put back with a different day or branch is not brought back into another list
insert into s25_resp select 'rm4c', pg_temp.s25_sync(pg_temp.s25_one('DHA', '[]', array[pg_temp.s25_k(102)], false));
select pg_temp.check(not exists (select 1 from public.visits where sheet_key = pg_temp.s25_k(102)), 'a removed row''s key sent in another branch''s tab does not bring it back there');

-- undo 2: Dr. Ali puts a removed visit back from the audit log (it comes back as a website visit, and the script adds it to the sheet)
select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
create temp table s25_undo as select public.aaj_undo_removal((select a.id from public.audit_log a where a.action = 'SHEET_REMOVED' and a.new_data->>'key' = pg_temp.s25_k(102) order by a.id desc limit 1)) as r;
create temp table s25_undo2 as select public.aaj_undo_removal((select a.id from public.audit_log a where a.action = 'SHEET_REMOVED' and a.new_data->>'key' = pg_temp.s25_k(102) order by a.id desc limit 1)) as r;
reset role; select set_config('request.jwt.claim.sub', '', false);
select pg_temp.check((select (r->>'ok')::boolean from s25_undo) and exists (select 1 from public.visits v where v.id = (select vid from s25_ids where k = pg_temp.s25_k(102)) and v.sheet_key is null and v.status = 'scheduled' and v.sheet_cells is null),
  'Dr. Ali can put a removed visit back (aaj_undo_removal): it comes back as a website visit with no sheet link');
select pg_temp.check(not (select (r->>'ok')::boolean from s25_undo2) and (select count(*) from public.visits where id = (select vid from s25_ids where k = pg_temp.s25_k(102))) = 1, 'and a second undo does nothing');
select pg_temp.check((select a.actor = :admin from public.audit_log a where a.action = 'SHEET_RESTORED' and a.new_data->>'key' = pg_temp.s25_k(102)), 'that undo is attributed to the person who did it');
select pg_temp.check((select x->>'key' = 'W-' || (select vid::text from s25_ids where k = pg_temp.s25_k(102)) and x->>'kind' = 'visit' from jsonb_array_elements(private.aaj_day_list(2::smallint, pg_temp.s25_today())) x
                       where x->>'id' = (select vid::text from s25_ids where k = pg_temp.s25_k(102))), 'it is in the day''s list under its website key, so the script appends it to the sheet');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000025099', 'fd25@dralirashid.com') on conflict (id) do nothing;
insert into public.staff (id, full_name, email, role) values ('00000000-0000-0000-0000-000000025099', 'Front Desk 25', 'fd25@dralirashid.com', 'front_desk');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000025099', false);
set role authenticated;
select pg_temp.expect_error($$select public.aaj_undo_removal(1)$$, 'Only Dr. Ali', 'a signed-in person who is not an admin cannot undo a removal');
reset role; select set_config('request.jwt.claim.sub', '', false);

-- checkups: an untouched one is removed (and comes back with Ctrl+Z); one that is already a patient or has follow-up work stays
update public.checkups set patient_id = :pk where sheet_key = pg_temp.s25_k(121);
insert into s25_resp select 'rm5', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('NN', '[]', pg_temp.s25_nn_keys(array[pg_temp.s25_k(120), pg_temp.s25_k(121)]))), true));
select pg_temp.check((select x->>'action' = 'deleted' and x->>'message' like 'Row deleted in the sheet: the checkup is removed from the website too.%' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'rm5'), pg_temp.s25_k(120)) x) y)
                     and not exists (select 1 from public.checkups where sheet_key = pg_temp.s25_k(120)), 'a checkup whose row is deleted is removed from the website');
select pg_temp.check((select x->>'action' = 'restore' and x->>'message' = 'Not removed: this checkup is already a patient, or has follow-up notes on the website.' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'rm5'), pg_temp.s25_k(121)) x) y)
                     and exists (select 1 from public.checkups where sheet_key = pg_temp.s25_k(121)), 'a checkup that is registered as a patient is kept and put back');
select pg_temp.check((select a.old_data->>'patient_name' = 'Check One' and a.new_data->>'kind' = 'checkup' and a.table_name = 'checkups' from public.audit_log a where a.action = 'SHEET_REMOVED' and a.new_data->>'key' = pg_temp.s25_k(120)),
  'a removed checkup is in the audit log with the whole row');
insert into s25_resp select 'rm6', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('NN', '[]', pg_temp.s25_nn_keys() || pg_temp.s25_k(120))), false));
select pg_temp.check((select c.patient_name = 'Check One' and c.phone = '03120000120' and c.source = 'google_sheet' from pg_temp.s25_chk(pg_temp.s25_k(120)) c), 'undoing the deletion in the sheet puts the checkup back');
update public.checkups set follow_up = 'Interested' where sheet_key = pg_temp.s25_k(120);
insert into s25_resp select 'rm7', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('NN', '[]', pg_temp.s25_nn_keys(array[pg_temp.s25_k(120)]))), true));
select pg_temp.check((select x->>'action' = 'restore' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'rm7'), pg_temp.s25_k(120)) x) y) and exists (select 1 from public.checkups where sheet_key = pg_temp.s25_k(120)),
  'a checkup that has follow-up work on the website is kept too');

-- anything that points at the visit keeps it, a table nobody has thought of yet included; so does a visit that treatment has started on
create table public.zz_attach_25 (visit_id uuid references public.visits(id));
insert into s25_resp select 'rm8a', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(130), '{"mr":"27008","name":"Bulk Patient H"}'), pg_temp.s25_row(pg_temp.s25_k(131), '{"mr":"27009","name":"Bulk Patient I"}'))));
insert into public.zz_attach_25 select id from public.visits where sheet_key = pg_temp.s25_k(130);
update public.visits set started_at = now() where sheet_key = pg_temp.s25_k(131);
insert into s25_resp select 'rm8', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('NN', '[]', pg_temp.s25_nn_keys(array[pg_temp.s25_k(130)]))), true));
insert into s25_resp select 'rm8b', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('NN', '[]', pg_temp.s25_nn_keys(array[pg_temp.s25_k(131)]))), true));
select pg_temp.check((select x->>'action' = 'kept' and x->>'message' like '%(zz_attach_25).' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'rm8'), pg_temp.s25_k(130)) x) y)
                     and (pg_temp.s25_vis(pg_temp.s25_k(130))).status = 'cancelled', 'any table with a foreign key to visits protects the visit, including one added later');
select pg_temp.check((select x->>'action' = 'kept' and x->>'message' = 'Kept on the website and marked Cancelled: treatment was recorded on it.' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'rm8b'), pg_temp.s25_k(131)) x) y)
                     and (pg_temp.s25_vis(pg_temp.s25_k(131))).status = 'cancelled', 'a visit that treatment has started on is kept too');
drop table public.zz_attach_25;
-- a cancelled visit whose row is gone is not a candidate
insert into s25_resp select 'rm9', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('NN', '[]', pg_temp.s25_nn_keys(array[pg_temp.s25_k(130), pg_temp.s25_k(131)]))), true));
select pg_temp.check((select resp->'tabs'->0->'removed' = '[]'::jsonb from s25_resp where n = 'rm9'), 'visits that are already Cancelled are left alone when their rows are gone');

-- no more than 15 removals a day for a branch with a small day (35 in 100 of the day's rows is less than 15 here): after that rows are put back
insert into public.audit_log (table_name, row_id, action, new_data, actor)
  select 'visits', null, 'SHEET_REMOVED', jsonb_build_object('branch', 'NN', 'action', 'deleted', 'key', 'S-fffffffff' || lpad(to_hex(g), 3, '0')), '00000000-0000-0000-0000-0000000aa500' from generate_series(1, 10) g;
insert into s25_resp select 'rm10', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('NN', '[]', pg_temp.s25_nn_keys(array[pg_temp.s25_k(104)]))), true));
select pg_temp.check((select x->>'action' = 'restore' and x->>'message' like 'Needs attention: too many rows were deleted from this tab today%' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'rm10'), pg_temp.s25_k(104)) x) y)
                     and exists (select 1 from public.visits where sheet_key = pg_temp.s25_k(104) and status <> 'cancelled'), 'after 15 removals in a day for a branch with a small day the next one is held, not applied (15 is the least; a busy day: RS12-1 at the end)');
delete from public.audit_log where action = 'SHEET_REMOVED' and new_data->>'key' like 'S-fffffffff%';

-- a quarter of a small tab gone at once is held: 2 rows of 8 held, 2 rows of 9 removed
delete from public.invoices where visit_id in (select id from public.visits where branch_id = 2 and visit_date = pg_temp.s25_today());
delete from public.visits where branch_id = 2 and visit_date = pg_temp.s25_today();
delete from public.checkups where branch_id = 2 and checkup_date = pg_temp.s25_today();
insert into public.visits (patient_id, branch_id, visit_date, status, sheet_key)
  select p.id, 2, pg_temp.s25_today(), 'waiting', pg_temp.s25_k(200 + g) from generate_series(1, 8) g join public.patients p on p.mr_number = '2700' || g;
insert into s25_resp select 'rm11', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('NN', '[]', pg_temp.s25_nn_keys(array[pg_temp.s25_k(201), pg_temp.s25_k(202)]))), true));
select pg_temp.check((select count(*) = 2 and bool_and(x->>'action' = 'restore') from jsonb_array_elements((select resp->'tabs'->0->'removed' from s25_resp where n = 'rm11')) x)
                     and (select count(*) from public.visits where branch_id = 2 and visit_date = pg_temp.s25_today()) = 8, 'two rows gone from a tab of eight (a quarter): held, nothing removed');
insert into public.visits (patient_id, branch_id, visit_date, status, sheet_key)
  select p.id, 2, pg_temp.s25_today(), 'waiting', pg_temp.s25_k(209) from public.patients p where p.mr_number = '27009';
insert into s25_resp select 'rm12', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('NN', '[]', pg_temp.s25_nn_keys(array[pg_temp.s25_k(201), pg_temp.s25_k(202)]))), true));
select pg_temp.check((select count(*) = 2 and bool_and(x->>'action' = 'deleted') from jsonb_array_elements((select resp->'tabs'->0->'removed' from s25_resp where n = 'rm12')) x)
                     and (select count(*) from public.visits where branch_id = 2 and visit_date = pg_temp.s25_today()) = 7, 'two rows gone from a tab of nine: removed');
select pg_temp.check((select count(*) from public.audit_log where action = 'SHEET_REMOVED' and new_data->>'action' = 'deleted' and new_data->>'key' in (pg_temp.s25_k(201), pg_temp.s25_k(202))) = 2, 'and both removals are in the audit log');

-- a big tab (24 rows): the "a quarter" rule does not catch four rows; "more than 3 at once" does. Three rows are fine.
create or replace function pg_temp.s25_bkeys(p_branch smallint, excl text[] default '{}') returns text[] language sql as $$
  select coalesce(array(select k from (
           select sheet_key as k from public.visits where branch_id = p_branch and visit_date = pg_temp.s25_today()
           union all select sheet_key from public.checkups where branch_id = p_branch and checkup_date = pg_temp.s25_today()) x
          where k is not null and k <> all (excl)), '{}') $$;
grant execute on all functions in schema pg_temp to authenticated, anon;
create temp table s25_bt as select count(*) as c from public.visits where branch_id = 1 and visit_date = pg_temp.s25_today();     -- Gulshan has visits from the cases above
insert into public.patients (mr_number, full_name, phone, first_branch_id)
  select '2900' || lpad(g::text, 2, '0'), 'Big Tab Patient ' || g, '03130000' || lpad(g::text, 3, '0'), 1 from generate_series(1, 24) g;
insert into public.visits (patient_id, branch_id, visit_date, status, sheet_key)
  select p.id, 1, pg_temp.s25_today(), 'waiting', pg_temp.s25_k(1100 + g) from generate_series(1, 24) g join public.patients p on p.mr_number = '2900' || lpad(g::text, 2, '0');
insert into s25_resp select 'bt1', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('GUL', '[]', pg_temp.s25_bkeys(1::smallint, array[pg_temp.s25_k(1101), pg_temp.s25_k(1102), pg_temp.s25_k(1103), pg_temp.s25_k(1104)]))), true));
select pg_temp.check((select count(*) = 4 and bool_and(x->>'action' = 'restore' and x->>'message' like 'Needs attention: 4 rows disappeared at once%') from jsonb_array_elements((select resp->'tabs'->0->'removed' from s25_resp where n = 'bt1')) x)
                     and (select count(*) from public.visits where branch_id = 1 and visit_date = pg_temp.s25_today() and sheet_key in (select pg_temp.s25_k(1100 + g) from generate_series(1, 24) g) and status = 'waiting') = 24
                     and (select count(*) from public.visits where branch_id = 1 and visit_date = pg_temp.s25_today()) = (select c from s25_bt) + 24, 'four rows gone at once from a tab of 24: held although it is far less than a quarter');
insert into s25_resp select 'bt2', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('GUL', '[]', pg_temp.s25_bkeys(1::smallint, array[pg_temp.s25_k(1101), pg_temp.s25_k(1102), pg_temp.s25_k(1103)]))), true));
select pg_temp.check((select count(*) = 3 and bool_and(x->>'action' = 'deleted') from jsonb_array_elements((select resp->'tabs'->0->'removed' from s25_resp where n = 'bt2')) x)
                     and (select count(*) from public.visits where branch_id = 1 and visit_date = pg_temp.s25_today()) = (select c from s25_bt) + 21, 'three rows gone from a tab of 24: removed');

-- the visit row itself also says "something real hangs on it": photos marked uploaded, a checker, a No show: none is deleted
update public.visits set photos_uploaded = true where sheet_key = pg_temp.s25_k(1104);
update public.visits set checked_by = (select id from public.clinicians order by id limit 1) where sheet_key = pg_temp.s25_k(1105);
update public.visits set status = 'no_show' where sheet_key = pg_temp.s25_k(1106);
insert into s25_resp select 'bt3', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('GUL', '[]', pg_temp.s25_bkeys(1::smallint, array[pg_temp.s25_k(1104), pg_temp.s25_k(1105), pg_temp.s25_k(1106)]))), true));
select pg_temp.check((select x->>'action' = 'kept' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'bt3'), pg_temp.s25_k(1104)) x) y) and (pg_temp.s25_vis(pg_temp.s25_k(1104))).status = 'cancelled',
  'a visit whose photos are marked uploaded is kept and marked Cancelled');
select pg_temp.check((select x->>'action' = 'kept' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'bt3'), pg_temp.s25_k(1105)) x) y) and (pg_temp.s25_vis(pg_temp.s25_k(1105))).status = 'cancelled',
  'a visit that a checker has checked is kept and marked Cancelled');
-- RS5-B2 (owner, 9 Oct 2026: "deleted patient means wrong entry, or patient didnt come. so deleting the row should delete from the website aaj ki
-- list too"): a No show is a patient who did not come. With nothing attached it goes like a Waiting one (audited, undone with Ctrl+Z).
select pg_temp.check((select x->>'action' = 'deleted' and x->>'message' like 'Row deleted in the sheet: the visit is removed from the website too.%' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'bt3'), pg_temp.s25_k(1106)) x) y)
                     and not exists (select 1 from public.visits where sheet_key = pg_temp.s25_k(1106))
                     and (select count(*) = 1 from public.audit_log where action = 'SHEET_REMOVED' and new_data->>'action' = 'deleted' and new_data->>'key' = pg_temp.s25_k(1106) and old_data->>'status' = 'no_show'),
  'RS5-B2: a No show visit with nothing attached whose row is deleted is removed from the website like a Waiting one, and audited');
insert into s25_resp select 'bt4', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('GUL', '[]', pg_temp.s25_bkeys(1::smallint) || pg_temp.s25_k(1106))), false));
select pg_temp.check((select v.status = 'no_show' from pg_temp.s25_vis(pg_temp.s25_k(1106)) v), 'RS5-B2: and Ctrl+Z (the row back with its key) puts the No show visit back');
delete from public.visits where sheet_key in (select pg_temp.s25_k(1100 + g) from generate_series(1, 24) g);
delete from public.patients where mr_number like '2900%';

-- =====================================================================
-- 13. The answer: hash, unchanged, list order
-- =====================================================================
insert into s25_resp select 'h1', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', '[]', array[pg_temp.s25_k(70), pg_temp.s25_k(71)]))));
select pg_temp.check((select (resp->'tabs'->0->>'unchanged')::boolean = false and resp->'tabs'->0 ? 'visits' and resp->'tabs'->0->>'hash' is not null from s25_resp where n = 'h1'), 'no hash sent: the full list comes back');
insert into s25_resp select 'h2', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', '[]', array[pg_temp.s25_k(70), pg_temp.s25_k(71)], (select resp->'tabs'->0->>'hash' from s25_resp where n = 'h1')))));
select pg_temp.check((select (resp->'tabs'->0->>'unchanged')::boolean and not (resp->'tabs'->0 ? 'visits') from s25_resp where n = 'h2'), 'the same hash and no rows: unchanged, and the list is not sent again');
update public.visits set details_text = 'changed on the website' where sheet_key = pg_temp.s25_k(70);
insert into s25_resp select 'h3', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', '[]', array[pg_temp.s25_k(70), pg_temp.s25_k(71)], (select resp->'tabs'->0->>'hash' from s25_resp where n = 'h1')))));
select pg_temp.check((select not (resp->'tabs'->0->>'unchanged')::boolean
                             and (select count(*) from jsonb_array_elements(resp->'tabs'->0->'visits') x where x->>'details' = 'changed on the website') = 1 from s25_resp where n = 'h3'),
  'after a website change the old hash no longer matches: the new list comes back');
select pg_temp.check((select array_agg(x->>'key' order by o) = (select array_agg(coalesce(sheet_key, 'W-' || id) order by token_no nulls last, created_at, id) from public.visits where branch_id = 4 and visit_date = pg_temp.s25_today())
                             and count(*) >= 4 from jsonb_array_elements((select resp->'tabs'->0->'visits' from s25_resp where n = 'h3')) with ordinality t(x, o) where x->>'kind' = 'visit'),
  'the list holds every visit of that branch and day, in token order (the token-less ones last)');
select pg_temp.check((select (jsonb_array_length(resp->'tabs'->0->'visits') > (select count(*) from jsonb_array_elements(resp->'tabs'->0->'visits') x where x->>'kind' = 'visit'))
                             and (resp->'tabs'->0->'visits'->-1->>'kind') = 'checkup' from s25_resp where n = 'h3'), 'checkups come after the visits in the same list');
select pg_temp.check((select (resp->'tabs'->0->>'hash') = md5((resp->'tabs'->0->'visits')::text) from s25_resp where n = 'h3'), 'the hash is the md5 of the list that is sent');
insert into s25_resp select 'h4', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', '[]', array[pg_temp.s25_k(70)], (select resp->'tabs'->0->>'hash' from s25_resp where n = 'h3')))));
update public.checkups set details = 'a checkup changed on the website' where sheet_key = pg_temp.s25_k(960);
insert into s25_resp select 'h5', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', '[]', array[pg_temp.s25_k(70)], (select resp->'tabs'->0->>'hash' from s25_resp where n = 'h3')))));
select pg_temp.check((select (resp->'tabs'->0->>'unchanged')::boolean from s25_resp where n = 'h4') and not (select (resp->'tabs'->0->>'unchanged')::boolean from s25_resp where n = 'h5'), 'a change to a checkup changes the hash too');

-- =====================================================================
-- 14. The patient's empty phone is filled from the sheet, never changed
-- =====================================================================
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('28001', 'Phone Less', null, 1), ('28002', 'Linked Phoneless', null, 1);
insert into public.visits (patient_id, branch_id, visit_date, status) select id, 1, pg_temp.s25_today(), 'waiting' from public.patients where mr_number = '28002';
insert into s25_resp select 'ph', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(110), '{"mr":"28001","name":"Phone Less","phone":"0300 999 8887"}'),
  pg_temp.s25_row(pg_temp.s25_k(111), '{"mr":"25004","name":"Sana Ahmed","phone":"03999999999"}'),
  pg_temp.s25_row(pg_temp.s25_k(112), '{"mr":"28002","name":"Linked Phoneless","phone":"0300 999 8886"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ph'), 0) = 'created' and (select phone from public.patients where mr_number = '28001') = '03009998887',
  'a patient with no phone gets the typed one (clean form) from the row that made the visit');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ph'), 2) = 'linked' and (select phone from public.patients where mr_number = '28002') is null,
  'a row that only meets a visit the website already had does not fill the patient''s phone (a typed phone is never slipped into a file that way)');
insert into s25_resp select 'ph1b', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(112), '{"phone":"0300 999 8885"}', false, '{}'::jsonb))));
select pg_temp.check((select phone from public.patients where mr_number = '28002') is null, 'nor does a later edit of the phone on a linked row');
select pg_temp.check((select phone from public.patients where id = :ps) = '03003334441', 'a patient who has a phone keeps it');

-- =====================================================================
-- 15. Doctor names: the port of matchClinician
-- =====================================================================
select pg_temp.check(private.aaj_match_clinician('Dr Haniya') = (select id from public.clinicians where display_name = 'Dr. Haniya Siddiqui'), 'doctor match: an alias (Dr Haniya)');
select pg_temp.check(private.aaj_match_clinician('Dr. Samrah Khan') = (select id from public.clinicians where display_name = 'Dr. Samrah Khan'), 'doctor match: the display name');
select pg_temp.check(private.aaj_match_clinician('Hira Anis') = (select id from public.clinicians where display_name = 'Hira Anis'), 'doctor match: an assistant');
select pg_temp.check(private.aaj_match_clinician('Dr Zunash') = (select id from public.clinicians where display_name = 'Dr. Zunash Suhail'), 'doctor match: one word that only one clinician starts with');
select pg_temp.check(private.aaj_match_clinician('Dr Ali') is null, 'doctor match: one word shared by two clinicians (Ali Rashid, Ali Ahmed) matches nobody');
select pg_temp.check(private.aaj_match_clinician('Dr. Unknown Person') is null and private.aaj_match_clinician('') is null and private.aaj_match_clinician(null) is null, 'doctor match: unknown, empty and null match nobody');
update public.clinicians set active = false where display_name = 'Dr. Zunash Suhail';
select pg_temp.check(private.aaj_match_clinician('Dr Zunash') is null and private.aaj_match_clinician('Dr. Zunash Suhail') is null and private.aaj_match_clinician('Dr Zunash Suhail') is null,
  'doctor match: a switched-off clinician is not matched, by first word, name or alias');
update public.clinicians set active = true where display_name = 'Dr. Zunash Suhail';

-- =====================================================================
-- 16. Too many new patients from the sheet in a day
-- =====================================================================
select pg_temp.check((select value = '30' from private.aaj_sync_config where key = 'new_patients_per_branch_day'), 'the sync may make at most 30 Healthwire patients for one branch and day by default');
insert into public.patients (mr_number, full_name, first_branch_id, legacy_source)
  select 'cap-' || g, 'Capped Person ' || g, 5, 'aaj_sheet_sync' from generate_series(1, 30) g;
insert into s25_resp select 'cap', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(120), '{"mr":"9900","name":"One Too Many","phone":"03555555555"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'cap')) = 'needs_patient' and pg_temp.s25_msg((select resp from s25_resp where n = 'cap')) = 'Too many new patients from the sheet today. Add this one on the website.'
                     and (select count(*) from public.patients where full_name = 'One Too Many') = 0, 'after 30 sync-created patients for a branch today the next creation is refused');
select pg_temp.check((select count(*) = 1 and bool_and(new_data->>'outcome' = 'mr_cap' and new_data->>'mr' = '9900') from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' = pg_temp.s25_k(120)),
  'that refusal is audited and counted like a refused lookup (an unused number never gets a free answer that a taken one does not, abuse-privacy minor)');
insert into s25_resp select 'cap2', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(121), '{"mr":"9901","name":"Other Branch Fine","phone":"03555555556"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'cap2')) = 'created', 'the cap is per branch');

-- =====================================================================
-- 17. import_aaj_sheet shares the patient rule
-- =====================================================================
select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
create temp table s25_imp as select public.import_aaj_sheet(jsonb_build_array(
  jsonb_build_array((pg_temp.s25_today() - 30)::text, 3, null, 'Zainab Khan', null, '03001112221', null, 'Filling', 1, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'DHA KHI', false, null),
  jsonb_build_array((pg_temp.s25_today() - 30)::text, 3, null, 'Ayesha', null, '03001112221', null, 'Scaling', 2, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'DHA KHI', false, null),
  jsonb_build_array((pg_temp.s25_today() - 30)::text, 3, null, 'Dina Rao', null, '03004445551', null, 'RCT', 3, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'DHA KHI', false, null),
  jsonb_build_array((pg_temp.s25_today() - 30)::text, 3, null, 'Kiran Javed', null, '03005556661', null, 'Checkup', 4, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'DHA KHI', false, null)), true) r;
reset role; select set_config('request.jwt.claim.sub', '', false);
select pg_temp.check((select (r->>'patients_created')::int = 0 and (r->>'rows_unmatched')::int = 2
                             and (select string_agg(u->>'name', ',' order by u->>'name') from jsonb_array_elements(r->'unmatched') u) = 'Dina Rao,Zainab Khan' from s25_imp),
  'history import, even with "Add patient records": a third name on a shared phone with no Mr# is not made a patient file (owner rule 4) and two same-name patients on one phone are not guessed between: both come back unmatched');
select pg_temp.check((select (r->>'checkups_skipped')::int = 1 from s25_imp)
                     and not exists (select 1 from public.visits v where v.patient_id = :pk and v.visit_date = pg_temp.s25_today() - 30),
  'history import: a row without an Mr# whose Treatment says checkup is a checkup patient, never a visit, even on the phone and name of a patient (Kiran Javed)');
select pg_temp.check((select count(*) = 0 from public.patients where full_name = 'Zainab Khan')
                     and (select count(*) from public.visits v where v.patient_id in (:pa, :pb) and v.visit_date = pg_temp.s25_today() - 30) = 1
                     and (select v.patient_id = :pa from public.visits v where v.patient_id in (:pa, :pb) and v.visit_date = pg_temp.s25_today() - 30), 'history import: the new family member is not attached to the mother or the daughter, "Ayesha" is Ayesha Khan');
select pg_temp.check((select count(*) from public.visits v join public.patients p on p.id = v.patient_id where p.full_name = 'Dina Rao' and v.visit_date = pg_temp.s25_today() - 30) = 0, 'history import: nothing is created or linked for the ambiguous rows');

-- =====================================================================
-- 18. Diagnostics and the phone indexes
-- =====================================================================
select pg_temp.check((select count(*) = 5 from private.aaj_sync_state where last_call_at is not null), 'aaj_sync_state has a row for every branch that was called');
select pg_temp.check((select rows_present = 1 and list_date = pg_temp.s25_today() and last_error is null and last_problems = 0 from private.aaj_sync_state where branch_id = 4), 'aaj_sync_state records the date and the number of rows present');
select pg_temp.check((select last_problems = 1 and last_error like 'Too many new patients%' from private.aaj_sync_state where branch_id = 5), 'aaj_sync_state records problems and the first error text');
-- staff keep saving patients with the two new expression indexes (they call a private function)
select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
insert into public.patients (full_name, phone, phone_alt, first_branch_id) values ('Index Check', '0300 555 0101', '+92 300 555 0102', 1);
update public.patients set phone = '03005550103' where full_name = 'Index Check';
reset role; select set_config('request.jwt.claim.sub', '', false);
select pg_temp.check((select phone = '03005550103' from public.patients where full_name = 'Index Check'), 'staff can still add and edit patients (the phone indexes run for signed-in users)');
select pg_temp.check((select count(*) = 2 from pg_indexes where tablename = 'patients' and indexname in ('patients_phone_norm_idx', 'patients_phone_alt_norm_idx')), 'both phone indexes exist');
select pg_temp.check((select count(*) = 1 from pg_indexes where tablename = 'visits' and indexname = 'visits_sheet_key_idx' and indexdef like '%UNIQUE%'), 'sheet_key is unique');
select pg_temp.expect_error($$update public.visits set sheet_key = 'not a key' where id = (select id from public.visits limit 1)$$, 'visits_sheet_key_format', 'a sheet key must have the S- or W- shape');
select pg_temp.expect_error(format($$update public.visits set sheet_key = %L where sheet_key = %L$$, pg_temp.s25_k(25), pg_temp.s25_k(70)), 'visits_sheet_key_idx', 'two visits cannot share a sheet key');


-- =====================================================================
-- 19. More of the rules: website-made visits, the Mr# on a linked row, braces months, a lost race for a token, hold mode and doctors
-- =====================================================================
create or replace function pg_temp.s25_pid(p_mr text) returns uuid language sql as $$ select id from public.patients where mr_number = p_mr $$;
grant execute on all functions in schema pg_temp to authenticated, anon;
insert into public.patients (mr_number, full_name, phone, first_branch_id) values
  ('26001', 'Wanda Key', '03020000001', 5), ('26002', 'Sue Per', '03020000002', 5), ('26003', 'Mira Link', '03020000003', 5),
  ('26004', 'Case Maker', '03020000004', 5), ('26005', 'Closed Case', '03020000005', 5), ('26006', 'Monthly Case', '03020000006', 5),
  ('26007', 'Race Runner', '03020000007', 5), ('26008', 'Hold Doctor', '03020000008', 5), ('26009', 'Cancel Me', '03020000009', 5), ('26010', 'Month Ninety', '03020000010', 5);

-- a visit the website made, once its key is in the tab, is updated through that W key
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, details_text) values (pg_temp.s25_pid('26001'), 5, pg_temp.s25_today(), 'waiting', 'Followup', 'wd');
create temp table s25_w as select 'W-' || id as k, id from public.visits where patient_id = pg_temp.s25_pid('26001');
insert into s25_resp select 'w1', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(pg_temp.s25_row((select k from s25_w), '{"treatment":"Scaling"}', false, '{"treatment":"Followup"}', pg_temp.s25_now_ms() - 5000)), array[(select k from s25_w)]));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'w1')) = 'updated' and (select treatment_label = 'Scaling' and sheet_key = (select k from s25_w) and details_text = 'wd' from public.visits where id = (select id from s25_w)),
  'a website visit updated through its W key: claimed, the changed field applied, the rest left alone');
-- a visit that already has an S key is not addressed through its W key any more
insert into s25_resp select 'w2', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(200), '{"mr":"26002","name":"Sue Per"}'))));
insert into s25_resp select 'w3', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(pg_temp.s25_row('W-' || (pg_temp.s25_vis(pg_temp.s25_k(200))).id, '{"details":"x"}', false)), array['W-' || (pg_temp.s25_vis(pg_temp.s25_k(200))).id]));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'w3')) = 'superseded', 'a W key for a visit that has its own S key is superseded');
select pg_temp.check((pg_temp.s25_vis(pg_temp.s25_k(200))).details_text is null, 'and changes nothing');
-- (sheet-behaviour RW8-1) a stray 7 in the Mr# cell of a linked row (front desk had made the patient on the website: not a file the sync made
-- from the row), sent with a real edit of the row: the edit is saved on the same visit, the Mr# is written back, nothing is made or removed
insert into s25_cnt select 'm2s', (select count(*) from public.patients), (select count(*) from public.visits), (select count(*) from public.checkups);
insert into s25_resp select 'm2s', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(200), '{"mr":"7","details":"slip and a detail"}', false, '{"mr":"26002","details":""}'::jsonb, pg_temp.s25_now_ms() + 1000)),
  pg_temp.s25_bkeys(5::smallint))), true));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'm2s')) = 'updated' and pg_temp.s25_res((select resp from s25_resp where n = 'm2s'))->'kept_website' = '["mr"]'::jsonb
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'm2s')) = 'Mr# 7 is not this visit''s patient, so Mr# 26002 is put back. If this row is another patient, delete it and type that patient in a new row.'
                     and (pg_temp.s25_vis(pg_temp.s25_k(200))).details_text = 'slip and a detail'
                     and (pg_temp.s25_vis(pg_temp.s25_k(200))).patient_id = pg_temp.s25_pid('26002')
                     and (select patients = (select count(*) from public.patients) and visits = (select count(*) from public.visits) from s25_cnt where n = 'm2s')
                     and jsonb_array_length((select resp->'tabs'->0->'removed' from s25_resp where n = 'm2s')) = 0,
  'RW8-1: a slip in the Mr# cell of a linked row never moves, removes or makes anything: the row''s other edit is saved on its visit and the Mr# is written back');

-- the Mr# and the name on a row that is already linked: the patient is never changed
insert into s25_resp select 'm1', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(201), '{"mr":"26003","name":"Mira Link","treatment":"Checkup"}'))));
insert into s25_resp select 'm2', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(201), '{"mr":""}', false),
  pg_temp.s25_row(pg_temp.s25_k(201), '{"mr":"25001"}', false),
  pg_temp.s25_row(pg_temp.s25_k(201), '{"mr":"26003"}', false),
  pg_temp.s25_row(pg_temp.s25_k(201), '{"name":"Zeeshan"}', false),
  pg_temp.s25_row(pg_temp.s25_k(201), '{"mr":"NEW"}', false)), array[pg_temp.s25_k(201)]));
select pg_temp.check(pg_temp.s25_res((select resp from s25_resp where n = 'm2'), 0)->'kept_website' = '["mr"]'::jsonb, 'an emptied Mr# cell: the sheet is told to write the Mr# back');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'm2'), 1) = 'unchanged' and pg_temp.s25_res((select resp from s25_resp where n = 'm2'), 1)->>'level' = 'warn'
                     and pg_temp.s25_res((select resp from s25_resp where n = 'm2'), 1)->'kept_website' = '["mr"]'::jsonb
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'm2'), 1) = 'Mr# 25001 is not this visit''s patient, so Mr# 26003 is put back. If this row is another patient, delete it and type that patient in a new row.',
  'another patient''s Mr# on a linked row (the name unchanged: a slip in the Mr# cell, RW8-1): a visit never moves to another patient; the sheet is told to write the Mr# back');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'm2'), 2) = 'unchanged', 'the same Mr# again: nothing to do');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'm2'), 3) = 'error' and pg_temp.s25_res((select resp from s25_resp where n = 'm2'), 3)->>'level' = 'error'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'm2'), 3) = 'Needs attention: the name in this row does not match Mr# 26003 on the website. Check the Mr# or the name: nothing in this row is saved until they match.'
                     and (select full_name from public.patients where mr_number = '26003') = 'Mira Link', 'a different name typed over a linked row is refused (never a plain tick), the patient''s name is not touched');
select pg_temp.check(pg_temp.s25_res((select resp from s25_resp where n = 'm2'), 4)->'kept_website' = '["mr"]'::jsonb, 'NEW on a linked row is read as an empty Mr# cell');
select pg_temp.check((pg_temp.s25_vis(pg_temp.s25_k(201))).patient_id = pg_temp.s25_pid('26003'), 'the visit is still the same patient''s');

-- braces months: the case behind them
insert into public.braces_cases (patient_id, start_date, status) values (pg_temp.s25_pid('26005'), pg_temp.s25_today() - 400, 'debonded'), (pg_temp.s25_pid('26006'), pg_temp.s25_today() - 70, 'active');
insert into s25_resp select 'b1', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(210), '{"mr":"26004","name":"Case Maker","treatment":"Monthly","month":{"t":"03","v":3}}'),
  pg_temp.s25_row(pg_temp.s25_k(211), '{"mr":"26005","name":"Closed Case","treatment":"Monthly","month":{"t":"7","v":7}}'),
  pg_temp.s25_row(pg_temp.s25_k(212), '{"mr":"26006","name":"Monthly Case","treatment":"Monthly"}'),
  pg_temp.s25_row(pg_temp.s25_k(213), '{"mr":"26010","name":"Month Ninety","month":{"t":"99","v":99}}', true)), array[pg_temp.s25_k(210), pg_temp.s25_k(211), pg_temp.s25_k(212), pg_temp.s25_k(213), (select k from s25_w)]));
select pg_temp.check((select c.start_date = pg_temp.s25_today() - 60 and c.status = 'active' and c.notes like 'From the Google Sheet: month 3 on %' and c.created_by = '00000000-0000-0000-0000-0000000aa500'
                             and v.braces_month = 3 and v.braces_case_id = c.id from pg_temp.s25_vis(pg_temp.s25_k(210)) v join public.braces_cases c on c.patient_id = v.patient_id),
  'a month for a patient with no braces case at all starts a case, dated back by the months (and says it is from the sheet)');
select pg_temp.check((select v.braces_month is null and v.braces_case_id is null and private.aaj_canon(v.id)->>'month' = '7' from pg_temp.s25_vis(pg_temp.s25_k(211)) v)
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'b1'), 1) = 'Month 7: this patient''s braces case is closed on the website. Check it there.',
  'a month for a patient whose braces case is closed: no month on the website, a warning, and the sheet''s "7" is not wiped');
select pg_temp.check((select v.braces_case_id = (select id from public.braces_cases where patient_id = v.patient_id) and v.braces_month = 1 from pg_temp.s25_vis(pg_temp.s25_k(212)) v),
  'a "Monthly" row with no month number goes on the active case and the website picks the month (as addVisit does)');
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'b1'), 3) = 'Month 99 is not a braces month (1 to 60).' and (pg_temp.s25_vis(pg_temp.s25_k(213))).braces_month is null, 'month 99 is not a braces month: warned, not stored');
insert into s25_resp select 'b2', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(210), '{"month":{"t":"","v":null}}', false, '{"month":"03"}', pg_temp.s25_now_ms() - 5000)), array[pg_temp.s25_k(210)]));
select pg_temp.check((select v.braces_month is null and v.braces_case_id is null from pg_temp.s25_vis(pg_temp.s25_k(210)) v) and pg_temp.s25_out((select resp from s25_resp where n = 'b2')) = 'updated', 'clearing the month cell clears the month on the visit');

-- the website's status words in the answer; Cancelled and No show from the sheet
insert into s25_resp select 's2', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(220), '{"mr":"26009","name":"Cancel Me","status":{"t":"Cancelled","v":"cancelled"}}'))));
select pg_temp.check((pg_temp.s25_vis(pg_temp.s25_k(220))).status = 'cancelled' and private.aaj_canon((pg_temp.s25_vis(pg_temp.s25_k(220))).id)->>'status' = 'Cancelled', 'Cancelled in the sheet cancels the visit');
insert into s25_resp select 's3', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(220), '{"status":{"t":"No show","v":"no_show"}}', false, '{"status":"Cancelled"}', pg_temp.s25_now_ms() - 5000)), array[pg_temp.s25_k(220)]));
select pg_temp.check((pg_temp.s25_vis(pg_temp.s25_k(220))).status = 'no_show', 'No show in the sheet is No show on the website');

-- somebody else takes the token between the check and the write: the row is saved without the token
create or replace function pg_temp.s25_race() returns trigger language plpgsql as $$
begin
  if new.sheet_key = pg_temp.s25_k(300) then
    insert into public.visits (patient_id, branch_id, visit_date, status, token_no) values (new.patient_id, new.branch_id, new.visit_date, 'scheduled', 300);
  end if;
  return new;
end $$;
create trigger aa_race before insert on public.visits for each row execute function pg_temp.s25_race();
insert into s25_resp select 'race', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(300), '{"mr":"26007","name":"Race Runner","token":{"t":"300","v":300}}'))));
drop trigger aa_race on public.visits;
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'race')) = 'created' and pg_temp.s25_msg((select resp from s25_resp where n = 'race')) = 'That token was just taken on the website. Token not changed on the website.'
                     and (pg_temp.s25_vis(pg_temp.s25_k(300))).token_no is distinct from 300 and (pg_temp.s25_vis(pg_temp.s25_k(300))).token_no is not null and private.aaj_canon((pg_temp.s25_vis(pg_temp.s25_k(300))).id)->>'token' = '300',
  'a token lost in a race with the website: the row is saved, the website numbers it, the sheet''s "300" stays');

-- hold mode and a doctor outside the month's group: not added, the sheet is told, no override
insert into public.braces_cases (patient_id, start_date, status) values (pg_temp.s25_pid('26008'), pg_temp.s25_today() - 100, 'active');
update private.aaj_sync_config set value = 'hold' where key = 'rules';
insert into s25_resp select 'hd', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(310),
  '{"mr":"26008","name":"Hold Doctor","treatment":"Monthly","month":{"t":"5","v":5},"doctors":{"t":"Dr. Samrah Khan, Hira Anis","v":["Dr. Samrah Khan","Hira Anis"]}}'))));
update private.aaj_sync_config set value = 'override' where key = 'rules';
select pg_temp.check(pg_temp.s25_docs(pg_temp.s25_k(310)) = 'Hira Anis:assistant' and (pg_temp.s25_vis(pg_temp.s25_k(310))).protocol_override_by is null
                     and pg_temp.s25_res((select resp from s25_resp where n = 'hd'))->'kept_website' = '["doctors"]'::jsonb
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'hd')) = 'Dr. Samrah Khan is not allowed for this month on the website. Not added.',
  'hold mode: a doctor outside the month''s group is not added, there is no override, and the sheet is told to take the website''s doctors');
select pg_temp.check(private.aaj_canon((pg_temp.s25_vis(pg_temp.s25_k(310))).id)->>'doctors' = 'Hira Anis', 'and the answer lists only the doctors the website has');

-- fields both sides already agree on are not applied again (an adopted visit keeps its braces case), and status words compare without case
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('26011', 'Agree Both', '03020000011', 5);
insert into public.braces_cases (patient_id, start_date, status) values (pg_temp.s25_pid('26011'), pg_temp.s25_today() - 500, 'debonded'), (pg_temp.s25_pid('26011'), pg_temp.s25_today() - 40, 'active');
insert into public.visits (patient_id, branch_id, visit_date, status, braces_case_id, braces_month, treatment_label, protocol_override_by, protocol_override_reason)
  select pg_temp.s25_pid('26011'), 5, pg_temp.s25_today(), 'completed', c.id, 3, 'Monthly', pg_temp.s25_admin(), 'website' from public.braces_cases c where c.patient_id = pg_temp.s25_pid('26011') and c.status = 'debonded';
insert into s25_resp select 'ag', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(320),
  '{"mr":"26011","name":"Agree Both","treatment":"Monthly","month":{"t":"3","v":3},"status":{"t":"completed","v":"completed"}}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ag')) = 'linked'
                     and (select v.braces_case_id = (select id from public.braces_cases where patient_id = v.patient_id and status = 'debonded') and v.braces_month = 3 and v.status = 'completed' and v.protocol_override_reason = 'website'
                            from pg_temp.s25_vis(pg_temp.s25_k(320)) v)
                     and pg_temp.s25_res((select resp from s25_resp where n = 'ag'))->'kept_website' = '[]'::jsonb,
  'both sides already say the same (month 3, "completed" in any case): nothing is applied again, no conflict is reported');

-- the sync's own audit rows
select pg_temp.check((select string_agg(distinct a.action, ',' order by a.action) from public.audit_log a where a.actor = '00000000-0000-0000-0000-0000000aa500') = 'SHEET_LETGO,SHEET_LOOKUP,SHEET_REMOVED,SHEET_RESTORED,SHEET_SYNC',
  'the sync''s own audit rows are SHEET_SYNC, SHEET_REMOVED, SHEET_RESTORED, SHEET_LOOKUP and SHEET_LETGO');
select pg_temp.check((select count(*) = 0 from public.audit_log where actor = '00000000-0000-0000-0000-0000000aa500' and action not in ('SHEET_SYNC', 'SHEET_REMOVED', 'SHEET_RESTORED', 'SHEET_LOOKUP', 'SHEET_LETGO')), 'the sync writes no other kind of audit row under its own name');
-- every override the sync left says what it is (the owner's wording), and was written under the sync's name
select pg_temp.check((select count(*) = 0 from public.visits v where v.sheet_key is not null and v.protocol_override_reason is not null and v.protocol_override_reason <> 'Completed in the Google Sheet (owner rule, 9 Oct 2026)' and v.protocol_override_reason <> 'website')
                     and (select count(*) = 0 from public.visits v where v.sheet_key is not null and v.dues_override_reason is not null and v.dues_override_reason <> 'Completed in the Google Sheet (owner rule, 9 Oct 2026)'),
  'every override the sync recorded carries the owner''s wording: "Completed in the Google Sheet (owner rule, 9 Oct 2026)"');
select pg_temp.check((select count(*) >= 4 and count(*) = (select count(distinct a.row_id) from public.audit_log a where a.action = 'SHEET_SYNC' and jsonb_array_length(a.new_data->'overrides') > 0
                                                              and a.actor = '00000000-0000-0000-0000-0000000aa500')
                        from public.visits v where v.sheet_key is not null and (v.protocol_override_reason = 'Completed in the Google Sheet (owner rule, 9 Oct 2026)' or v.dues_override_reason = 'Completed in the Google Sheet (owner rule, 9 Oct 2026)')),
  'and each of them has an audit row by the Google Sheet sync that lists it');

-- the sheet link can be written by the sync only, not by a signed-in user (the browser never sends these columns)
select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
select pg_temp.expect_error($$update public.visits set sheet_key = 'S-0000000000fe' where id = (select id from public.visits where sheet_key is not null order by sheet_key limit 1)$$, 'written by the sync only', 'a signed-in user cannot change a visit''s sheet key');
select pg_temp.expect_error($$update public.visits set sheet_cells = '{}'::jsonb where id = (select id from public.visits where sheet_key is not null order by sheet_key limit 1)$$, 'written by the sync only', 'a signed-in user cannot change a visit''s sheet cells');
select pg_temp.expect_error($$insert into public.visits (patient_id, branch_id, status, sheet_key) select id, 1, 'waiting', 'S-0000000000fd' from public.patients limit 1$$, 'written by the sync only', 'a signed-in user cannot make a visit with a sheet link');
update public.visits set details_text = coalesce(details_text, '') || '.' where id = (select id from public.visits where sheet_key is not null order by sheet_key limit 1);
select pg_temp.expect_error($$select * from private.aaj_visit_text$$, 'permission denied', 'a signed-in user (and so a patient on the portal) cannot read the sheet''s staff text');
reset role; select set_config('request.jwt.claim.sub', '', false);
select pg_temp.check((select count(*) = 1 from pg_trigger where tgname = 'visits_guard_sheet_cols' and tgrelid = 'public.visits'::regclass), 'the guard exists, and staff can still edit every other column of a visit');
select pg_temp.check((select count(*) = 0 from public.visits where sheet_cells ? 'pp' or sheet_cells ? 'healthwire' or sheet_cells ? 'reminder'), 'no visit row holds P.P, Healthwire or Reminder text any more (a patient can read her own visit rows)');

-- =====================================================================
-- 19b. Review round 3: a row with no Mr# is a checkup only when its Treatment says so; a name nobody can read links nobody; the daily cap on
--      visits the sync makes; one checkup for one person; the checkup key is the sync's own; a phone changed in the sheet is not hidden;
--      a visit with a payment or recorded treatment is never deleted
-- =====================================================================

-- (a) the owner's clarification of 9 Oct 2026, 13:20: "if the patient is checkup there ... he has no mr number ... and as for row 28 ... treatment says
--     filling and crown prep, but the staff didnt enter the mr number: you will have to fetch the mr number from our healthwire account"
select pg_temp.check(private.aaj_is_checkup_text('Checkup') and private.aaj_is_checkup_text('checkup / pain') and private.aaj_is_checkup_text('Xray checkup') and private.aaj_is_checkup_text('Check up')
                     and private.aaj_is_checkup_text('CHECK-UP') and private.aaj_is_checkup_text('chek up')
                     and not private.aaj_is_checkup_text('Filling & Crown prep') and not private.aaj_is_checkup_text('Rct followup') and not private.aaj_is_checkup_text('Monthly')
                     and not private.aaj_is_checkup_text('Bonding 80 Kit') and not private.aaj_is_checkup_text('Consultation') and not private.aaj_is_checkup_text('') and not private.aaj_is_checkup_text(null),
  'aaj_is_checkup_text: Checkup in its spellings is a checkup; fillings, RCT, Monthly, kits and an empty Treatment are not');
select pg_temp.check(private.aaj_is_checkup_text('Checkups') and private.aaj_is_checkup_text('checup') and private.aaj_is_checkup_text('Consultation checkup')
                     and not private.aaj_is_checkup_text('Wire check') and not private.aaj_is_checkup_text('Braces check') and not private.aaj_is_checkup_text('Retainer check')
                     and not private.aaj_is_checkup_text('RCT check') and not private.aaj_is_checkup_text('Post op check') and not private.aaj_is_checkup_text('Check wire')
                     and not private.aaj_is_checkup_text('Cheek filler') and not private.aaj_is_checkup_text('Check upper wire'),
  'aaj_is_checkup_text (loop 3): only the word checkup; "Wire check", "Braces check", "RCT check", "Check wire" and "Cheek filler" are treatments of existing patients');
insert into s25_cnt select 'k6', (select count(*) from public.patients), (select count(*) from public.visits), (select count(*) from public.checkups);
insert into s25_resp select 'k6', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(1730), '{"name":"Wire Forgot","phone":"03140000030","treatment":"Wire check","month":{"t":"6","v":6}}'),
  pg_temp.s25_row(pg_temp.s25_k(1731), '{"name":"Month Checkup","phone":"03140000031","treatment":"Checkup","month":{"t":"04 Photo","v":4}}'))));
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'k6'), 0) = 'Needs attention: add the Mr#. A row with no Mr# is a checkup only when its Treatment says checkup. Look the Mr# up in Healthwire.'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'k6'), 1) = 'Needs attention: add the Mr#. A row with a Month is a braces patient, never a checkup. Look the Mr# up in Healthwire.'
                     and (select checkups = (select count(*) from public.checkups) and patients = (select count(*) from public.patients) from s25_cnt where n = 'k6'),
  'a braces patient whose Mr# was forgotten ("Wire check", or a Month on the row even with "Checkup") is flagged, never filed as a checkup');
insert into s25_cnt select 'k1', (select count(*) from public.patients), (select count(*) from public.visits), (select count(*) from public.checkups);
insert into s25_resp select 'k1', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(1400), '{"name":"Faizan Ikram","phone":"03140000001","treatment":"Filling & Crown prep"}'),
  pg_temp.s25_row(pg_temp.s25_k(1401), '{"mr":"NEW","name":"Rct Person","phone":"03140000002","treatment":"Rct followup"}'),
  pg_temp.s25_row(pg_temp.s25_k(1402), '{"name":"No Treatment Yet","phone":"03140000003"}'),
  pg_temp.s25_row(pg_temp.s25_k(1403), '{"mr":"","name":"Monthly Person","treatment":"Monthly"}'),
  pg_temp.s25_row(pg_temp.s25_k(1404), '{"name":"Typo Checkup","phone":"03140000004","treatment":"chek up"}'),
  pg_temp.s25_row(pg_temp.s25_k(1405), '{"name":"Pain Checkup","treatment":"Checkup / pain"}'))));
select pg_temp.check((select string_agg(pg_temp.s25_out(resp, g::int), ',' order by g) from s25_resp, generate_series(0, 5) g where n = 'k1')
                       = 'needs_patient,needs_patient,needs_patient,needs_patient,created,created',
  'no Mr#: only a Treatment that says checkup (also "chek up", "Checkup / pain") makes a checkup; any other Treatment, or none, needs attention');
select pg_temp.check((select bool_and(pg_temp.s25_res(resp, g::int)->>'level' = 'error'
                                      and pg_temp.s25_msg(resp, g::int) = 'Needs attention: add the Mr#. A row with no Mr# is a checkup only when its Treatment says checkup. Look the Mr# up in Healthwire.')
                        from s25_resp, generate_series(0, 3) g where n = 'k1'),
  'the row says "Needs attention: add the Mr#" and points to Healthwire');
select pg_temp.check((select patients = (select count(*) from public.patients) and visits = (select count(*) from public.visits) and checkups + 2 = (select count(*) from public.checkups) from s25_cnt where n = 'k1')
                     and not exists (select 1 from public.checkups where patient_name in ('Faizan Ikram', 'Rct Person', 'No Treatment Yet', 'Monthly Person')),
  'the flagged rows made no checkup, no patient and no visit: an existing patient is never filed as a checkup nor made a new patient');
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('26050', 'Faizan Ikram', '03140000001', 1);
insert into s25_resp select 'k1b', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(1400), '{"mr":"26050","name":"Faizan Ikram","phone":"03140000001","treatment":"Filling & Crown prep"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'k1b')) = 'created' and (pg_temp.s25_vis(pg_temp.s25_k(1400))).patient_id = pg_temp.s25_pid('26050'),
  'once the Mr# is typed (looked up in Healthwire) the same row is the patient''s visit');

-- (b) a name nobody can read (Urdu script, punctuation, empty) fits no guessed Mr#: the secret is not a patient lookup
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('26051', 'بلال', '03140000051', 1);
insert into s25_cnt select 'nn0', (select count(*) from public.patients), (select count(*) from public.visits), (select count(*) from public.checkups);
insert into s25_resp select 'nn1', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(1410), jsonb_build_object('mr', '25003', 'name', 'بلال')),
  pg_temp.s25_row(pg_temp.s25_k(1411), jsonb_build_object('mr', '25003', 'name', '..', 'phone', '03999999999')),
  pg_temp.s25_row(pg_temp.s25_k(1412), jsonb_build_object('mr', '25003', 'name', '')),
  pg_temp.s25_row(pg_temp.s25_k(1413), jsonb_build_object('mr', '26051', 'name', 'Bilal')))));
select pg_temp.check((select string_agg(pg_temp.s25_out(resp, g::int), ',' order by g) from s25_resp, generate_series(0, 3) g where n = 'nn1') = 'needs_patient,needs_patient,needs_patient,needs_patient',
  'an unreadable name (Urdu script, punctuation, nothing) is not a fit for a guessed Mr#, with a wrong phone or none; nor is a readable name for a patient filed under an unreadable one');
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'nn1'), 0) = 'Needs attention: Mr# 25003: the name in this row cannot be read. Type the patient''s name in English letters, as the website has it.'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'nn1'), 3) = 'Needs attention: the name in this row does not match Mr# 26051 on the website. Check the Mr#, or type the name as the website has it.'
                     and (select bool_and(m not like '%Umer%' and m not like '%0300%' and m not like '%بلال%') from (select pg_temp.s25_msg(resp, g::int) m from s25_resp, generate_series(0, 3) g where n = 'nn1') x),
  'the refusal says what to do and gives away nothing about the patient (no name, no phone)');
select pg_temp.check((select patients = (select count(*) from public.patients) and visits = (select count(*) from public.visits) and checkups = (select count(*) from public.checkups) from s25_cnt where n = 'nn0')
                     and (select phone = '03002223331' and full_name = 'Muhammad Umer' from public.patients where mr_number = '25003'),
  'no visit, no patient, no checkup and no change to the patient file came out of them');
select pg_temp.check(not exists (select 1 from jsonb_array_elements((select resp->'tabs'->0->'visits' from s25_resp where n = 'nn1')) x where x->>'mr' in ('25003', '26051')),
  'and the answer''s list carries no data about those patients (their names, phones and dues stay out of it)');
select pg_temp.check((select count(*) = 3 from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' in (pg_temp.s25_k(1410), pg_temp.s25_k(1411), pg_temp.s25_k(1413)))
                     and (select count(*) = 2 from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'outcome' = 'mr_noname'),
  'each of those refused lookups is in the audit log (and counts against the day''s 200)');
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'nn1'), 2) = 'Patient name is too short.'
                     and not exists (select 1 from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' = pg_temp.s25_k(1412)),
  'an empty name is "too short" before anything is looked up (abuse-privacy minor: the answer never tells a free Healthwire number from a taken one)');
-- 11 Oct 2026: the patient's own phone is no proof of another name any more. The same rows WITH the patient's phone are refused too, with the
-- same answer as without it (a different answer would confirm the phone behind an Mr#)
insert into s25_resp select 'nn2', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(1414), jsonb_build_object('mr', '25003', 'name', 'بلال', 'phone', '0300 2223331')),
  pg_temp.s25_row(pg_temp.s25_k(1415), jsonb_build_object('mr', '26051', 'name', 'Bilal', 'phone', '0314-0000051')))));
select pg_temp.check((select string_agg(pg_temp.s25_out(resp, g::int), ',' order by g) from s25_resp, generate_series(0, 1) g where n = 'nn2') = 'needs_patient,needs_patient'
                     and pg_temp.s25_vis(pg_temp.s25_k(1414)) is null and pg_temp.s25_vis(pg_temp.s25_k(1415)) is null
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'nn2'), 0) = pg_temp.s25_msg((select resp from s25_resp where n = 'nn1'), 0)
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'nn2'), 1) = pg_temp.s25_msg((select resp from s25_resp where n = 'nn1'), 3),
  'another name typed with the patient''s own phone number is refused, word for word as without the phone: nothing is linked');
-- on a phone that somebody else shares too (a family) an unreadable name is refused as well; only the patient file's own name letter for letter,
-- with their own phone, goes through (an Urdu name kept in Urdu)
insert into s25_resp select 'nn3', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(1416), jsonb_build_object('mr', '25001', 'name', 'عائشہ', 'phone', '03001112221')),
  pg_temp.s25_row(pg_temp.s25_k(1417), jsonb_build_object('mr', '26051', 'name', 'بلال', 'phone', '03140000051')))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'nn3'), 0) = 'needs_patient'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'nn3'), 0) like 'Needs attention: Mr# 25001: the name in this row cannot be read.%'
                     and not exists (select 1 from public.visits where sheet_key = pg_temp.s25_k(1416)),
  'an unreadable name on a family phone (mother and daughter share it) is not linked to the Mr#''s patient');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'nn3'), 1) = 'created'
                     and pg_temp.s25_res((select resp from s25_resp where n = 'nn3'), 1)->>'level' = 'ok'
                     and (pg_temp.s25_vis(pg_temp.s25_k(1417))).patient_id = pg_temp.s25_pid('26051'),
  'the patient file''s own name, letter for letter, with their own phone is a plain tick');

-- (c) the sync makes only so many visits for a branch and day, whoever sends them
select pg_temp.check((select value = '250' from private.aaj_sync_config where key = 'visits_per_branch_day'), 'the default cap is 250 visits a day for one branch (twice the owner''s busy day of about 120 patients)');
insert into public.patients (mr_number, full_name, phone, first_branch_id) values
  ('26060', 'Cap One', '03150000060', 5), ('26061', 'Cap Two', '03150000061', 5), ('26062', 'Cap Three', '03150000062', 5), ('26063', 'Cap Website', '03150000063', 5);
insert into public.visits (patient_id, branch_id, visit_date, status) select id, 5, pg_temp.s25_today(), 'waiting' from public.patients where mr_number = '26063';
update private.aaj_sync_config set value = ((select count(*) from public.visits where branch_id = 5 and visit_date = pg_temp.s25_today() and created_by = '00000000-0000-0000-0000-0000000aa500') + 2)::text
 where key = 'visits_per_branch_day';
insert into s25_cnt select 'cap0', (select count(*) from public.patients), (select count(*) from public.visits), (select count(*) from public.checkups);
insert into s25_resp select 'vc', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(1420), '{"mr":"26060","name":"Cap One"}'),
  pg_temp.s25_row(pg_temp.s25_k(1421), '{"mr":"26061","name":"Cap Two"}'),
  pg_temp.s25_row(pg_temp.s25_k(1422), '{"mr":"26062","name":"Cap Three"}'),
  pg_temp.s25_row(pg_temp.s25_k(1423), '{"mr":"9955","name":"Healthwire Cap","phone":"03150000099"}'),
  pg_temp.s25_row(pg_temp.s25_k(1424), '{"mr":"26063","name":"Cap Website"}'))));
select pg_temp.check((select string_agg(pg_temp.s25_out(resp, g::int), ',' order by g) from s25_resp, generate_series(0, 4) g where n = 'vc') = 'created,created,needs_patient,needs_patient,linked'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'vc'), 2) = 'Too many patients added from the sheet today. Add this one on the website.'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'vc'), 3) = 'Too many patients added from the sheet today. Add this one on the website.',
  'at the daily cap new visits are refused (an existing patient and a new Healthwire number alike); a row that only adopts a visit the website already has still works');
select pg_temp.check(not exists (select 1 from public.patients where mr_number = '9955')
                     and (select patients = (select count(*) from public.patients) and visits + 2 = (select count(*) from public.visits) from s25_cnt where n = 'cap0'),
  'the refused Healthwire row made no patient either (the cap is checked before the patient is made)');
update private.aaj_sync_config set value = '250' where key = 'visits_per_branch_day';

-- (d) the checkup's sheet key is the sync's own: signed-in staff (the front desk) cannot write it; Dr. Ali and the SQL editor can
insert into public.checkups (checkup_date, branch_id, patient_name, source) values (pg_temp.s25_today(), 1, 'Guard Target', 'website');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000025099', false);
set role authenticated;
select pg_temp.expect_error($$update public.checkups set sheet_key = 'S-0000000000ee' where patient_name = 'Guard Target'$$, 'heet link', 'a signed-in user cannot give a checkup a sheet key');
select pg_temp.expect_error($$update public.checkups set sheet_key = '=HYPERLINK("http://example.invalid","x")' where patient_name = 'Guard Target'$$, 'heet link', 'nor a text that is not a key (a spreadsheet formula)');
select pg_temp.expect_error($$insert into public.checkups (checkup_date, branch_id, patient_name, sheet_key) values (current_date, 1, 'Sneaky', 'S-0000000000ed')$$, 'heet link', 'nor make a checkup that already has one');
update public.checkups set details = 'staff can still edit the rest', follow_up = 'Interested' where patient_name = 'Guard Target';
reset role; select set_config('request.jwt.claim.sub', '', false);
select pg_temp.check((select details = 'staff can still edit the rest' and sheet_key is null from public.checkups where patient_name = 'Guard Target'), 'staff still edit every other column of a checkup');
select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
update public.checkups set sheet_key = 'S-0000000000ef' where patient_name = 'Guard Target';
reset role; select set_config('request.jwt.claim.sub', '', false);
select pg_temp.check((select sheet_key = 'S-0000000000ef' from public.checkups where patient_name = 'Guard Target'), 'Dr. Ali (admin) is not held back, like the SQL editor');
select pg_temp.check((select count(*) = 1 from pg_trigger where tgname = 'checkups_guard_sheet_key' and tgrelid = 'public.checkups'::regclass), 'the guard is in place');
delete from public.checkups where patient_name = 'Guard Target';

-- (e) the same person typed as a checkup on both sides is one checkup (same name and phone), never guessed without a phone
insert into public.checkups (checkup_date, branch_id, patient_name, phone, checkup_for, source, day_status, details) values
  (pg_temp.s25_today(), 3, 'Zara Check', '03130000050', 'Checkup', 'website', 'waiting', 'website notes'),
  (pg_temp.s25_today(), 3, 'Zara Other', '03130000051', 'Checkup', 'website', 'waiting', null),
  (pg_temp.s25_today(), 3, 'Zara NoPhone', null, 'Checkup', 'website', 'waiting', null);
create temp table s25_zara as select patient_name as n, id, 'W-' || id as wk from public.checkups where patient_name like 'Zara %';
insert into s25_resp select 'ad1', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(1500), '{"name":"Zara Check","phone":"0313 000 0050","treatment":"Checkup","status":{"t":"Waiting","v":"waiting"},"details":"sheet notes"}', true, null, pg_temp.s25_now_ms() + 60000),
  pg_temp.s25_row(pg_temp.s25_k(1501), '{"name":"Zara Other","phone":"0313 000 0099","treatment":"Checkup"}'),
  pg_temp.s25_row(pg_temp.s25_k(1502), '{"name":"Zara NoPhone","treatment":"Checkup"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ad1'), 0) = 'linked' and (select count(*) = 1 from public.checkups where patient_name = 'Zara Check')
                     and (select sheet_key = pg_temp.s25_k(1500) and source = 'website' and phone = '03130000050' from public.checkups where patient_name = 'Zara Check')
                     and pg_temp.s25_res((select resp from s25_resp where n = 'ad1'), 0)->>'visit_id' = (select id::text from s25_zara where n = 'Zara Check'),
  'a sheet row for a person who already has a checkup today at this branch (same name and phone) adopts that checkup: one checkup, now linked to the row');
select pg_temp.check((select details = 'sheet notes' from public.checkups where patient_name = 'Zara Check') and pg_temp.s25_res((select resp from s25_resp where n = 'ad1'), 0)->'kept_website' = '[]'::jsonb,
  'RS5-A1: an adopted checkup takes what the row typed after the website''s last change (the newer edit wins, like a linked row)');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ad1'), 1) = 'created' and (select count(*) = 2 from public.checkups where patient_name = 'Zara Other'),
  'another phone is never guessed to be the same person');
-- loop 5 (RS5-2): with no phone on either side, a checkup of that full name today whose row is not on the sheet is the row's: a moved
-- no-phone checkup row is not deleted and made again.
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ad1'), 2) = 'linked' and (select count(*) = 1 from public.checkups where patient_name = 'Zara NoPhone')
                     and (select sheet_key = pg_temp.s25_k(1502) and source = 'website' from public.checkups where patient_name = 'Zara NoPhone'),
  'no phone on either side: the only checkup of that full name today is adopted, not made twice');
-- SB10-1 (11 Oct 2026): two walk-ins of one name with no phone whose rows were given new keys (a sort of the visible columns) each find their
-- own checkup again: the oldest one whose row is not on the sheet. Before, two of that name were never adopted: every sort made both again,
-- the old ones (Completed, Treatment) came back as rows, and the next sort doubled them again. A third one typed while both rows are on the
-- sheet (their keys present) is a new person.
insert into public.checkups (checkup_date, branch_id, patient_name, phone, checkup_for, source, day_status, details) values
  (pg_temp.s25_today(), 3, 'Zara Twice', null, 'Checkup', 'website', 'completed', 'first'), (pg_temp.s25_today(), 3, 'Zara Twice', null, 'Checkup', 'website', 'in_treatment', 'second');
create temp table s25_twice as select id, row_number() over (order by created_at, id) as n from public.checkups where patient_name = 'Zara Twice';
insert into s25_resp select 'ad1b', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(1504), '{"name":"Zara Twice","treatment":"Checkup"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ad1b')) = 'linked' and (select count(*) = 2 from public.checkups where patient_name = 'Zara Twice')
                     and (select sheet_key = pg_temp.s25_k(1504) from public.checkups where id = (select id from s25_twice where n = 1)),
  'SB10-1: two checkups of that name without a phone and neither row on the sheet: the row adopts the oldest, nothing is made');
insert into s25_resp select 'ad1c', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(1505), '{"name":"Zara Twice","treatment":"Checkup"}')),
  array[pg_temp.s25_k(1504), pg_temp.s25_k(1505)]));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ad1c')) = 'linked' and (select count(*) = 2 from public.checkups where patient_name = 'Zara Twice')
                     and (select sheet_key = pg_temp.s25_k(1505) from public.checkups where id = (select id from s25_twice where n = 2))
                     and (select sheet_key = pg_temp.s25_k(1504) from public.checkups where id = (select id from s25_twice where n = 1)),
  'SB10-1: the second row of that name adopts the other checkup (the first one''s row is on the sheet), never the one already taken');
insert into s25_resp select 'ad1d', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(1506), '{"name":"Zara Twice","treatment":"Checkup"}')),
  array[pg_temp.s25_k(1504), pg_temp.s25_k(1505), pg_temp.s25_k(1506)]));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ad1d')) = 'created' and (select count(*) = 3 from public.checkups where patient_name = 'Zara Twice'),
  'SB10-1: a third walk-in of that name typed while both other rows are on the sheet gets her own checkup');
insert into s25_resp select 'ad2', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('DHA',
  jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(1503), '{"name":"Zara Other","phone":"03130000051","treatment":"Checkup"}')),
  array[pg_temp.s25_k(1503), (select wk from s25_zara where n = 'Zara Other')]))));
-- (sheet-behaviour RV-1, 11 Oct 2026: before, this made a second checkup of the same name and phone)
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ad2')) = 'duplicate'
                     and pg_temp.s25_res((select resp from s25_resp where n = 'ad2'))->>'duplicate_of' = (select wk from s25_zara where n = 'Zara Other')
                     and (select count(*) = 1 from public.checkups where phone = '03130000051'),
  'when the website checkup''s own row is in the sheet (its key is present), a second row with the same name and phone is refused as a duplicate, never a second checkup');
delete from public.checkups where patient_name like 'Zara %';

-- (e2) loop 5 (RS5-2): a checkup row that lost its hidden key (cut and pasted with the visible cells only, the helper columns deleted, a sort
-- of the visible columns) is its checkup again, whatever its Treatment says and however the website wrote the phone. Nothing is removed as a
-- deleted row, nothing is made twice.
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('28210', 'Reg Checkup', '03001128210', 3);
insert into public.checkups (checkup_date, branch_id, patient_name, phone, checkup_for, source, day_status, follow_up, notes) values
  (pg_temp.s25_today(), 3, 'Amna Scaling', '0300-1117777', 'Scaling', 'website', 'waiting', 'Not Contacted', null),
  (pg_temp.s25_today(), 3, 'Braces Consult', '0300 1117778', 'Braces consultation', 'website', 'waiting', 'Interested', 'call after Eid'),
  (pg_temp.s25_today(), 3, 'Reg Checkup', '03001128210', 'Checkup', 'website', 'waiting', 'Not Contacted', null);
update public.checkups set sheet_key = 'W-' || id where patient_name in ('Amna Scaling', 'Braces Consult', 'Reg Checkup') and branch_id = 3;
update public.checkups set patient_id = (select id from public.patients where mr_number = '28210') where patient_name = 'Reg Checkup' and branch_id = 3;
create temp table s25_mv as select patient_name as n, id, sheet_key as wk from public.checkups where patient_name in ('Amna Scaling', 'Braces Consult', 'Reg Checkup') and branch_id = 3;
insert into s25_cnt select 'mv', (select count(*) from public.patients), (select count(*) from public.visits), (select count(*) from public.checkups);
insert into s25_resp select 'mv1', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('DHA', jsonb_build_array(
    pg_temp.s25_row(pg_temp.s25_k(1505), '{"mr":"","name":"Amna Scaling","phone":"03001117777","treatment":"Scaling","status":{"t":"Waiting","v":"waiting"}}'),
    pg_temp.s25_row(pg_temp.s25_k(1506), '{"mr":"","name":"Braces Consult","phone":"03001117778","treatment":"Braces consultation"}'),
    pg_temp.s25_row(pg_temp.s25_k(1507), '{"mr":"28210","name":"Reg Checkup","phone":"03001128210","treatment":"Checkup"}')),
  pg_temp.s25_bkeys(3::smallint, (select array_agg(wk) from s25_mv)) || array[pg_temp.s25_k(1505), pg_temp.s25_k(1506), pg_temp.s25_k(1507)])), true));
select pg_temp.check((select string_agg(pg_temp.s25_out(resp, g::int), ',' order by g) from s25_resp, generate_series(0, 2) g where n = 'mv1') = 'linked,linked,linked',
  'moved checkup rows (Treatment "Scaling", "Braces consultation", a registered checkup showing its Mr#) are their own checkups again');
select pg_temp.check((select bool_and(c.sheet_key = k) from (values ('Amna Scaling', pg_temp.s25_k(1505)), ('Braces Consult', pg_temp.s25_k(1506)), ('Reg Checkup', pg_temp.s25_k(1507))) x(n, k)
                        join s25_mv m on m.n = x.n join public.checkups c on c.id = m.id)
                     and (select checkups = (select count(*) from public.checkups) and visits = (select count(*) from public.visits) from s25_cnt where n = 'mv')
                     and jsonb_array_length((select resp from s25_resp where n = 'mv1')->'tabs'->0->'removed') = 0,
  'each checkup now carries its row''s new key: nothing was removed as a deleted row, no checkup or visit was made (the website''s phone "0300-1117777" is the same number)');
select pg_temp.check((select follow_up = 'Interested' and notes = 'call after Eid' from public.checkups where id = (select id from s25_mv where n = 'Braces Consult')),
  'and the checkup keeps its follow-up notes');
select pg_temp.check((select bool_and(pg_temp.s25_res(resp, g::int)->'kept_website' = '[]'::jsonb and pg_temp.s25_res(resp, g::int)->>'level' = 'ok') from s25_resp, generate_series(0, 2) g where n = 'mv1')
                     and (select phone = '0300-1117777' from public.checkups where id = (select id from s25_mv where n = 'Amna Scaling')),
  'the phone the website wrote with a dash is the same number: no "website change kept" warning, and the website''s text is left as it was');

-- (f) a phone changed in the sheet on a linked row does not reach the patient file: the row says so (no green tick)
select pg_temp.check((select phone = '03020000003' from public.patients where mr_number = '26003'), 'setup: the patient has a phone');
-- (sheet-behaviour L2-residual) the sheet still shows "Zeeshan" typed over this row (m2 above). The script keeps sending a name the website
-- refused, so every later edit of the row (a phone, Status Completed) comes with it: every answer is the refusal, and nothing is saved
insert into s25_resp select 'ph0', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(201), '{"name":"Zeeshan","legacy_name":"Zeeshan","phone":"0399 000 1111","treatment":"RCT","status":{"t":"Completed","v":"completed"}}', false,
                  '{"name":"Mira Link","phone":"03020000003","treatment":"Checkup","status":"Waiting"}', pg_temp.s25_now_ms() - 3000)), array[pg_temp.s25_k(201)]));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ph0')) = 'error' and pg_temp.s25_res((select resp from s25_resp where n = 'ph0'))->>'level' = 'error'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'ph0')) like 'Needs attention: the name in this row does not match Mr# 26003 on the website.%'
                     and (select v.status = 'waiting' and v.treatment_label = 'Checkup' and v.completed_at is null and v.protocol_override_by is null from pg_temp.s25_vis(pg_temp.s25_k(201)) v)
                     and (select phone = '03020000003' and full_name = 'Mira Link' from public.patients where mr_number = '26003'),
  'L2-residual: a later edit of a row whose name was typed over still gets the refusal; the visit stays Waiting / Checkup and the patient file is unchanged');
-- the name put back: the row goes through again (only the phone is new now)
insert into s25_resp select 'ph1', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(201), '{"phone":"0399 000 1111"}', false, '{"phone":""}', pg_temp.s25_now_ms() - 5000)), array[pg_temp.s25_k(201)]));
insert into s25_resp select 'ph2', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(201), '{"phone":"0302 000 0003"}', false, '{"phone":"03020000003"}', pg_temp.s25_now_ms() - 4000)), array[pg_temp.s25_k(201)]));
select pg_temp.check(pg_temp.s25_res((select resp from s25_resp where n = 'ph1'))->>'level' = 'warn'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'ph1')) = 'The phone in this row is not the patient''s phone on the website. Change it in the patient file.'
                     and (select phone = '03020000003' from public.patients where mr_number = '26003'),
  'a different phone typed on a linked row: the row is told the patient file keeps its number, and the patient file is not changed');
select pg_temp.check(pg_temp.s25_res((select resp from s25_resp where n = 'ph2'))->>'level' = 'ok' and pg_temp.s25_msg((select resp from s25_resp where n = 'ph2')) is null,
  'the same number written another way (spaces, dashes) is no warning');
-- (abuse-privacy minor, loop 6) the patient's second phone, which the sheet is never shown, gets the same answer as any other number: a row
-- of today's list is no free check of a guessed second number
update public.patients set phone_alt = '03020009999' where mr_number = '26003';
insert into s25_resp select 'ph3', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(201), '{"phone":"0302 000 9999"}', false, '{"phone":"03020000003"}', pg_temp.s25_now_ms() - 3500)), array[pg_temp.s25_k(201)]));
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'ph3')) = pg_temp.s25_msg((select resp from s25_resp where n = 'ph1'))
                     and (select phone = '03020000003' and phone_alt = '03020009999' from public.patients where mr_number = '26003'),
  'a phone typed on a linked row that is the patient''s second number gets the same answer as a wrong one, and the file is not changed');
update public.patients set phone_alt = null where mr_number = '26003';

-- (g) the owner: "never a visit that has an invoice, payment, photo or treatment record attached": a paid invoice and a recorded treatment keep the visit
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('26070', 'Paid Person', '03160000070', 5), ('26071', 'Treated Person', '03160000071', 5);
insert into s25_resp select 'pt0', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(1600), '{"mr":"26070","name":"Paid Person"}'), pg_temp.s25_row(pg_temp.s25_k(1601), '{"mr":"26071","name":"Treated Person"}'))));
insert into public.invoices (visit_id, patient_id, branch_id) select id, patient_id, 5 from public.visits where sheet_key = pg_temp.s25_k(1600);
insert into public.payments (patient_id, invoice_id, branch_id, amount) select patient_id, id, 5, 1000 from public.invoices where visit_id = (pg_temp.s25_vis(pg_temp.s25_k(1600))).id;
update public.visits set completed_at = now() where sheet_key = pg_temp.s25_k(1601);
insert into s25_resp select 'pt1', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('ISB', '[]', pg_temp.s25_bkeys(5::smallint, array[pg_temp.s25_k(1600)]))), true));
insert into s25_resp select 'pt2', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('ISB', '[]', pg_temp.s25_bkeys(5::smallint, array[pg_temp.s25_k(1601)]))), true));
select pg_temp.check((select x->>'action' = 'kept' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'pt1'), pg_temp.s25_k(1600)) x) y) and (pg_temp.s25_vis(pg_temp.s25_k(1600))).status = 'cancelled'
                     and exists (select 1 from public.payments where invoice_id in (select id from public.invoices where visit_id = (pg_temp.s25_vis(pg_temp.s25_k(1600))).id)),
  'a visit whose invoice has a payment on it is kept (marked Cancelled), never deleted, when its row is deleted');
select pg_temp.check((select x->>'action' = 'kept' and x->>'message' = 'Kept on the website and marked Cancelled: treatment was recorded on it.' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'pt2'), pg_temp.s25_k(1601)) x) y)
                     and (pg_temp.s25_vis(pg_temp.s25_k(1601))).status = 'cancelled',
  'a visit with a recorded treatment (completed_at set) is kept too');

-- =====================================================================
-- 20. The door is small: five tabs, a rate limit, helpers
-- =====================================================================
insert into public.branches (code, name, city_id) values ('TST', 'Test branch', (select id from public.cities limit 1));
select pg_temp.expect_error(format($$select pg_temp.s25_sync(%L::jsonb)$$, pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('TST')))), 'UNKNOWN_BRANCH', 'a real branch that is not one of the five tabs of the sheet is refused');
select pg_temp.check((select count(*) from private.aaj_sync_calls) > 10, 'every call is counted for the rate limit');
update private.aaj_sync_config set value = ((select count(*) from private.aaj_sync_calls where at > clock_timestamp() - interval '1 minute') + 2)::text where key = 'calls_per_minute';
select pg_temp.s25_sync(pg_temp.s25_pl('[]'::jsonb));
select pg_temp.s25_sync(pg_temp.s25_pl('[]'::jsonb));
select pg_temp.expect_error(format($$select pg_temp.s25_sync(%L::jsonb)$$, pg_temp.s25_pl('[]'::jsonb)), 'RATE_LIMIT', 'more calls than the limit in a minute are refused');
update private.aaj_sync_config set value = '20' where key = 'calls_per_minute';
select pg_temp.check(private.aaj_tab_name('GUL') = 'Gulshan KHI' and private.aaj_tab_name('NN') = 'North Nazimabad' and private.aaj_tab_name('DHA') = 'DHA KHI'
                     and private.aaj_tab_name('LHR') = 'Gulberg Lhr' and private.aaj_tab_name('ISB') = 'Islamabad' and private.aaj_tab_name('TST') is null, 'aaj_tab_name: the five tabs, nothing else');

-- helpers
select pg_temp.check(private.aaj_norm_phone('0300-1234567') = '03001234567' and private.aaj_norm_phone('3001234567') = '03001234567' and private.aaj_norm_phone('+92 300 1234567') = '03001234567'
                     and private.aaj_norm_phone('12345') is null and private.aaj_norm_phone(null) is null and private.aaj_norm_phone('0212345678') = '0212345678', 'aaj_norm_phone: the port of phoneOf');
select pg_temp.check(private.aaj_given_name('M Umer') = 'umer' and private.aaj_given_name('Muhammad  Umer Farooq') = 'umer' and private.aaj_given_name('Dr. Sana') = 'sana' and private.aaj_given_name('Syed Hafiz') = 'hafiz'
                     and private.aaj_given_name('') = '' and private.aaj_given_name('بلال') = '', 'aaj_given_name: titles are skipped, an Urdu name gives nothing to match on');
select pg_temp.check(private.aaj_doctor_key('Dr. Komal Rubab') = 'komal rubab' and private.aaj_doctor_key('Dr Verda') = 'verda' and private.aaj_doctor_key('  DR.  Ali  Ahmed ') = 'ali ahmed', 'aaj_doctor_key: the port of normaliseDoctorKey');
select pg_temp.check(private.aaj_people_key('Dr A, Dr. B and C') = 'a|b|c' and private.aaj_people_key('C / B & A') = 'a|b|c' and private.aaj_people_key('') = '' and private.aaj_people_key(null) = '' and private.aaj_people_key('Dr Haniya, dr. haniya') = 'haniya',
  'aaj_people_key: the same people give the same key, whatever the separators and order');
select pg_temp.check(private.aaj_name_close('Ayesha', 'Ayesha Khan') and private.aaj_name_close('Farooq Umer', 'Umer Farooq') and private.aaj_name_close('Ayesh', 'Ayesha Khan') and not private.aaj_name_close('Sara', 'Sana Ahmed')
                     and not private.aaj_name_close('Lamar Kamal', 'Sana Ahmed') and not private.aaj_name_close('', 'Sana') and not private.aaj_name_close('بلال', 'Sana') and not private.aaj_name_close('Sana', 'بلال')
                     and not private.aaj_name_close('..', 'Sana') and not private.aaj_name_close(null, 'Sana'),
  'aaj_name_close: close spellings fit, other people do not, a name nobody can read fits nothing (on either side)');
select pg_temp.check(private.aaj_name_close('Malik Asif', 'Asif Mehmood') and private.aaj_name_close('Syed Muhammad Ali Raza Khan', 'Ali Raza')
                     and not private.aaj_name_close('Qq Ayesha Bilal Fatima Sana', 'Ayesha Khan') and not private.aaj_name_close('Ayesha Fatima Hina Sana Bilal', 'Ayesha Khan')
                     and not private.aaj_name_close('Bilal Fatima Ayesha', 'Ayesha Khan'),
  'aaj_name_close (loop 3): a "name" of more than four words fits nobody; the patient''s first name counts as the other word of a two-word name only');
select pg_temp.check(not private.aaj_name_close('Raza', 'Muhammad Ali Raza') and not private.aaj_name_close('Qureshi', 'Zubaida Qureshi') and not private.aaj_name_close('Khan', 'Ayesha Khan')
                     and not private.aaj_name_close('Khan Zz', 'Ayesha Khan') and not private.aaj_name_close('Qureshi Begum', 'Zubaida Qureshi')
                     and private.aaj_name_close('Zubaida', 'Zubaida Qureshi') and private.aaj_name_close('Qureshi Zubaida', 'Zubaida Qureshi'),
  'aaj_name_close (loop 4): the patient''s first name must be in the typed name; a surname alone (or a surname with any other word) fits nobody');
select pg_temp.check(private.aaj_name_close('Rana Asif Ali', 'Asif Ali') and private.aaj_name_close('Ch Asif Ali Khan', 'Asif Ali Khan') and private.aaj_name_close('Sheikh Bilal Ahmed', 'Bilal Ahmed')
                     and not private.aaj_name_close('Rana Malik Asif Ali', 'Asif Ali') and not private.aaj_name_close('Rana Ali', 'Asif Ali')
                     and not private.aaj_names_conflict('Rana Asif Ali', 'Asif Ali'),
  'aaj_name_close (loop 4): the patient''s whole name with one family or caste word more in front ("Rana Asif Ali" for "Asif Ali") is close; two words more, or part of the name, is not');
select pg_temp.check(private.aaj_names_conflict('Ayesha Rajpoot', 'Ayesha Khan') and private.aaj_names_conflict('Ali Hassan', 'Muhammad Ali Raza')
                     and not private.aaj_names_conflict('Ayesha', 'Ayesha Khan') and not private.aaj_names_conflict('Umer Farooq', 'Muhammad Umer Farooq Khan')
                     and not private.aaj_names_conflict('Syed Ali', 'Ali Raza') and not private.aaj_names_conflict('', 'Ali Raza'),
  'aaj_names_conflict: two names of two or more words where neither holds all the other''s words');
select pg_temp.check(private.aaj_name_words('Syed Muhammad Ali Raza') = array['ali', 'raza'] and private.aaj_name_words('') = '{}'::text[] and private.aaj_name_words(null) = '{}'::text[],
  'aaj_name_words: the words of a name without the titles');
-- orchestrator decision, 11 Oct 2026: only a name that fits WITHOUT DOUBT is linked (aaj_name_fits); a name that is only close is refused
select pg_temp.check((select bool_and(private.aaj_name_fits(t, f)) from (values
    ('Ayesha Khan', 'Ayesha Khan'), ('Ayesha', 'Ayesha Khan'), ('Saima Akhtar', 'Saima Bibi Akhtar'), ('Asif Ali Khan', 'Asif Ali'), ('Muhammad Umer', 'Umer'),
    ('Syed Ali Raza', 'Ali Raza'), ('Bilal Ahmad', 'Bilal Ahmed'), ('Maryam Bibi', 'Mariam Bibi'), ('Eman Ali', 'Iman Ali'), ('AYESHA  KHAN', 'ayesha khan')) p(t, f)),
  'aaj_name_fits: the patient''s name, the first name alone, a name inside the stored one or with a word more behind, titles, and everyday spellings of any word fit without doubt');
select pg_temp.check((select bool_and(not private.aaj_name_fits(t, f)) from (values
    ('Ayesha Rajpoot', 'Ayesha Khan'), ('Ayesh Khan', 'Ayesha Khan'), ('Rana Asif Ali', 'Asif Ali'), ('Farooq Umer', 'Umer Farooq'), ('Malik Asif', 'Asif Mehmood'),
    ('Ali Hassan Raza', 'Hassan Raza'), ('Umair Farooq', 'Umar Farooq'), ('Umair Farooq', 'Umer Farooq'), ('Hussain Raza', 'Hassan Raza'), ('Rizwana Khan', 'Rizwan Khan'),
    ('Shahida Khan', 'Shahid Khan'), ('Alia Raza', 'Ali Raza'), ('Sania Ali', 'Sana Ali'), ('Kashaf Ali', 'Kashif Ali'), ('Zara Khan', 'Sara Khan'), ('Faisal Khan', 'Fazal Khan'),
    ('Nadia Khan', 'Nida Khan'), ('Saeed Ali', 'Saad Ali'), ('Ehsan Ali', 'Ahsan Ali'), ('Qq Ayesha Bilal Fatima Sana', 'Ayesha Khan'), ('بلال', 'بلال'), ('', 'Sana'),
    ('Khan', 'Ayesha Khan')) p(t, f)),
  'aaj_name_fits: another surname, a slip of the first name, a word more in front, another order, two names of two people (Umair / Umar, Hussain / Hassan, Rizwana / Rizwan, Sara / Zara), a stuffed or unreadable name, a surname alone: never without doubt');
select pg_temp.check(private.aaj_name_spelling('Ayesha') = 'aisha' and private.aaj_name_spelling('Aysha') = 'aisha' and private.aaj_name_spelling('Noor') = 'nur'
                     and private.aaj_name_spelling('Yousuf') = 'yusuf' and private.aaj_name_spelling('Umer') = 'umar' and private.aaj_name_spelling('Sanaa') = 'sana'
                     and private.aaj_name_spelling('Sabah') = 'saba' and private.aaj_name_spelling('Iqra') = 'ikra' and private.aaj_name_spelling('Heera') = 'hira'
                     and private.aaj_name_spelling('Umair') = 'umair' and private.aaj_name_spelling('') = '' and private.aaj_name_spelling(null) = '',
  'aaj_name_spelling: one word as it sounds without the everyday ways of writing it in English letters');

-- =====================================================================
-- 21. Loop 3: the same first name with another surname; a restore that cannot be done; a website visit's "claimed" flag
-- =====================================================================
update private.aaj_sync_config set value = '100000' where key = 'calls_per_minute';      -- (section 20 put the rate limit back)
-- (L2) "Rabia Rajpoot" typed with the Mr# of "Rabia Khan", "Bilal Hassan" with the Mr# of "Muhammad Bilal Raza": refused (11 Oct 2026: a name
-- that fits only with doubt is never linked, not even with a warning)
insert into public.patients (mr_number, full_name, phone, first_branch_id) values
  ('28011', 'Rabia Khan', null, 2), ('28012', 'Muhammad Bilal Raza', null, 2), ('28013', 'Nadia Rehman', null, 2), ('28014', 'Saima Bibi Akhtar', null, 2);
insert into s25_resp select 'l2', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(1740), '{"mr":"28011","name":"Rabia Rajpoot"}'),
  pg_temp.s25_row(pg_temp.s25_k(1741), '{"mr":"28012","name":"Bilal Hassan"}'),
  pg_temp.s25_row(pg_temp.s25_k(1742), '{"mr":"28013","name":"Nadia"}'),
  pg_temp.s25_row(pg_temp.s25_k(1743), '{"mr":"28014","name":"Saima Akhtar"}'))));
select pg_temp.check((select string_agg(pg_temp.s25_out(resp, g::int) || ':' || coalesce(pg_temp.s25_msg(resp, g::int), ''), '|' order by g) from s25_resp, generate_series(0, 3) g where n = 'l2')
                       = 'needs_patient:Needs attention: the name in this row does not match Mr# 28011 on the website. Check the Mr#, or type the name as the website has it.'
                         || '|needs_patient:Needs attention: the name in this row does not match Mr# 28012 on the website. Check the Mr#, or type the name as the website has it.|created:|created:'
                     and pg_temp.s25_vis(pg_temp.s25_k(1740)) is null and pg_temp.s25_vis(pg_temp.s25_k(1741)) is null,
  'the same first name with another surname is refused without naming the Mr#''s patient (nothing linked); a first name alone, or a name inside the stored one, is a plain tick');
insert into s25_resp select 'l2b', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(1742), '{"name":"Nadia Qureshi"}', false, '{}'::jsonb))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'l2b')) = 'error'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'l2b')) = 'Needs attention: the name in this row does not match Mr# 28013 on the website. Check the Mr# or the name: nothing in this row is saved until they match.',
  'a linked row whose name is changed to another surname is refused too');

-- (L3) a deleted row put back (Ctrl+Z) whose visit cannot come back (its braces case was deleted since) never stops the door. (The case is
-- the patient's own, made on the website: a case the sync started for the row is removed and put back with it, loop 7.)
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('28020', 'Restore Fail', '03160000020', 3);
insert into public.braces_cases (patient_id, start_date, status) select id, pg_temp.s25_today() - 150, 'active' from public.patients where mr_number = '28020';
insert into s25_resp select 'l3a', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(1750), '{"mr":"28020","name":"Restore Fail","month":{"t":"6","v":6}}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'l3a')) = 'created' and (pg_temp.s25_vis(pg_temp.s25_k(1750))).braces_case_id is not null, 'L3 setup: a braces visit made from the sheet, on the patient''s own braces case');
insert into s25_resp select 'l3b', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('DHA', '[]', pg_temp.s25_bkeys(3::smallint, array[pg_temp.s25_k(1750)]))), true));
select pg_temp.check((select x->>'action' = 'deleted' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'l3b'), pg_temp.s25_k(1750)) x) y), 'L3 setup: its row is deleted, the visit removed');
delete from public.braces_cases where patient_id = (select id from public.patients where mr_number = '28020');
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('28021', 'Other Branch Row', '03160000021', 1);
-- (the script sends the hash of the list it last had: the list itself did not change, and the website must still send it, loop 6)
insert into s25_resp select 'l3c', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(
  pg_temp.s25_tab('DHA', '[]', pg_temp.s25_bkeys(3::smallint) || pg_temp.s25_k(1750), md5(private.aaj_day_list(3::smallint, pg_temp.s25_today())::text)),
  pg_temp.s25_tab('GUL', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(1751), '{"mr":"28021","name":"Other Branch Row"}')), array[pg_temp.s25_k(1751)])), false));
select pg_temp.check((select (resp->>'ok')::boolean from s25_resp where n = 'l3c') and pg_temp.s25_out((select resp from s25_resp where n = 'l3c'), 0, 1) = 'created'
                     and not exists (select 1 from public.visits where sheet_key = pg_temp.s25_k(1750))
                     and (select resp->'tabs'->0->>'unchanged' = 'false' and jsonb_typeof(resp->'tabs'->0->'visits') = 'array' from s25_resp where n = 'l3c')
                     and not exists (select 1 from jsonb_array_elements((select resp->'tabs'->0->'visits' from s25_resp where n = 'l3c')) x where x->>'key' = pg_temp.s25_k(1750)),
  'the restore that cannot be done does not stop the call: the other tab''s row is saved, and the list is sent although it did not change, so the row reads "deleted on the website" (not a stale tick)');
select pg_temp.check((select count(*) = 1 and bool_and((new_data->>'failed')::boolean) and bool_and(actor = '00000000-0000-0000-0000-0000000aa500')
                        from public.audit_log where action = 'SHEET_RESTORED' and new_data->>'audit' = (select a.id::text from public.audit_log a where a.action = 'SHEET_REMOVED' and a.new_data->>'key' = pg_temp.s25_k(1750))),
  'the failed restore is written to the audit log once');
insert into s25_resp select 'l3d', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('DHA', '[]', pg_temp.s25_bkeys(3::smallint) || pg_temp.s25_k(1750))), true));
select pg_temp.check((select (resp->>'ok')::boolean from s25_resp where n = 'l3d')
                     and (select count(*) from public.audit_log where action = 'SHEET_RESTORED' and new_data->>'audit' = (select a.id::text from public.audit_log a where a.action = 'SHEET_REMOVED' and a.new_data->>'key' = pg_temp.s25_k(1750))) = 1,
  'the next calls answer too (with the removal check), and the restore is not tried again');

-- (L7) a website visit is "claimed" once its key is in the tab: a cancelled claimed visit whose row is deleted is not added to the sheet again
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('28030', 'Claim Me', '03160000030', 4);
insert into public.visits (patient_id, branch_id, visit_date, status) select id, 4, pg_temp.s25_today(), 'waiting' from public.patients where mr_number = '28030';
create temp table s25_cl as select v.id, 'W-' || v.id as k from public.visits v join public.patients p on p.id = v.patient_id where p.mr_number = '28030';
select pg_temp.check(not (private.aaj_canon((select id from s25_cl))->>'claimed')::boolean, 'a website visit the sheet has not seen yet is not claimed');
insert into s25_resp select 'l7', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', '[]', pg_temp.s25_bkeys(4::smallint) || (select k from s25_cl))), false));
select pg_temp.check((private.aaj_canon((select id from s25_cl))->>'claimed')::boolean
                     and exists (select 1 from jsonb_array_elements((select resp->'tabs'->0->'visits' from s25_resp where n = 'l7')) x where x->>'key' = (select k from s25_cl) and (x->>'claimed')::boolean),
  'once its key is in the tab it is claimed, and the list says so');

-- =====================================================================
-- 22. Loop 4: a guess of the name behind an Mr# is a lookup like any other
-- =====================================================================
insert into public.patients (mr_number, full_name, phone, first_branch_id) values
  ('28040', 'Kiran Ghazal', '03160000040', 2), ('28041', 'Zubaida Qureshi', '03160000041', 2), ('28042', 'Faraz Tariq', null, 2);
create temp table s25_guess as select g, 'Guess' || chr(97 + (g - 1) / 26) || chr(97 + (g - 1) % 26) as nm from generate_series(1, 30) g;
-- (a) one key and one Mr#, 24 wrong names and the right one in one call: five refusals are looked at and audited, then the call stops looking
insert into s25_resp select 'g1', pg_temp.s25_sync(pg_temp.s25_one('NN', (select jsonb_agg(x order by o) from (
    select pg_temp.s25_row(pg_temp.s25_k(1760), jsonb_build_object('mr', '28040', 'name', nm)) x, g o from s25_guess where g <= 24
    union all select pg_temp.s25_row(pg_temp.s25_k(1760), '{"mr":"28040","name":"Kiran Ghazal"}'), 25) y)));
select pg_temp.check((select count(*) filter (where pg_temp.s25_msg(resp, g::int) = 'Needs attention: the name in this row does not match Mr# 28040 on the website. Check the Mr#, or type the name as the website has it.') = 5
                            and count(*) filter (where pg_temp.s25_msg(resp, g::int) = 'Too many rows the website could not place at once. This row is tried again in a few minutes.') = 20
                       from s25_resp, generate_series(0, 24) g where n = 'g1')
                     and pg_temp.s25_out((select resp from s25_resp where n = 'g1'), 24) = 'needs_patient'
                     and not exists (select 1 from public.visits where sheet_key = pg_temp.s25_k(1760)),
  'one row key with one Mr# and 25 names in one call: five guesses are answered, the other twenty (the right name among them) are not looked at');
select pg_temp.check((select count(*) = 5 and count(distinct new_data->>'who') = 5 from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' = pg_temp.s25_k(1760)),
  'each of the five guesses is its own audited lookup (the same key and Mr# with another name is a new lookup)');
-- the next calls: five new names each, every one audited and counted
insert into s25_resp select 'gc' || c, pg_temp.s25_sync(pg_temp.s25_one('NN', (select jsonb_agg(pg_temp.s25_row(pg_temp.s25_k(1760), jsonb_build_object('mr', '28040', 'name', nm)) order by g)
                                                                            from s25_guess where g between 5 * c - 4 + 5 and 5 * c + 5)))
  from generate_series(1, 5) c;
select pg_temp.check((select count(*) from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' = pg_temp.s25_k(1760)) = 30
                     and (select count(distinct new_data->>'who') from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' = pg_temp.s25_k(1760)) = 30,
  '30 wrong names for one Mr# under one key are 30 audited lookups (counted against the day''s 200)');
select pg_temp.check(not exists (select 1 from public.audit_log a, s25_guess g where a.action = 'SHEET_LOOKUP' and a.new_data::text like '%' || g.nm || '%'),
  'the audit log keeps a fingerprint of each guess, not the guessed names');
insert into s25_resp select 'g7', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(1760), '{"mr":"28040","name":"Guessaa"}'))));
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'g7')) = 'Needs attention: the name in this row does not match Mr# 28040 on the website. Check the Mr#, or type the name as the website has it.'
                     and (select count(*) from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' = pg_temp.s25_k(1760)) = 30,
  'the same row sent again (same key, Mr#, name and phone) is not audited twice');
insert into s25_resp select 'g8', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(1760), '{"mr":"28040","name":"Kiran Ghazal"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'g8')) = 'created' and (pg_temp.s25_vis(pg_temp.s25_k(1760))).patient_id = (select id from public.patients where mr_number = '28040'),
  'the right name for that Mr# is then linked as usual (a real row that waited is not lost)');
-- (b) the day's visit cap is full: a fitting name and a wrong one get the same answer, nothing is made, nothing is looked up for the sheet
update private.aaj_sync_config set value = '0' where key = 'visits_per_branch_day';
insert into s25_cnt select 'g9', (select count(*) from public.patients), (select count(*) from public.visits), (select count(*) from public.checkups);
insert into s25_resp select 'g9', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(1761), '{"mr":"28042","name":"Faraz"}'),
  pg_temp.s25_row(pg_temp.s25_k(1762), '{"mr":"28042","name":"Bilal"}'),
  pg_temp.s25_row(pg_temp.s25_k(1763), '{"mr":"9956","name":"Healthwire Full"}'),
  pg_temp.s25_row(pg_temp.s25_k(1764), '{"mr":"28040","name":"Kiran Ghazal"}')),
  array[pg_temp.s25_k(1760), pg_temp.s25_k(1761), pg_temp.s25_k(1762), pg_temp.s25_k(1763), pg_temp.s25_k(1764)]));
select pg_temp.check((select string_agg(coalesce(pg_temp.s25_msg(resp, g::int), '(' || pg_temp.s25_out(resp, g::int) || ')'), '|' order by g) from s25_resp, generate_series(0, 2) g where n = 'g9')
                       = 'Too many patients added from the sheet today. Add this one on the website.|Too many patients added from the sheet today. Add this one on the website.'
                         || '|Too many patients added from the sheet today. Add this one on the website.',
  'once the day''s visit cap is full, the right name and a wrong name for an Mr# get the same answer (and so does a new Healthwire number)');
select pg_temp.check((select patients = (select count(*) from public.patients) and visits = (select count(*) from public.visits) from s25_cnt where n = 'g9')
                     and not exists (select 1 from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' in (pg_temp.s25_k(1761), pg_temp.s25_k(1762), pg_temp.s25_k(1763))),
  'nothing is made or looked up for those rows');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'g9'), 3) = 'duplicate',
  'a patient already on today''s list (the sheet sees them anyway) is still recognised at the cap: here as the same patient in another row');
update private.aaj_sync_config set value = '250' where key = 'visits_per_branch_day';
-- (c) a surname alone is not a fit: "Qureshi" typed with the Mr# of "Zubaida Qureshi" is refused and names nobody
insert into s25_resp select 'g10', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(1765), '{"mr":"28041","name":"Qureshi"}'),
  pg_temp.s25_row(pg_temp.s25_k(1766), '{"mr":"28011","name":"Khan"}'))));
select pg_temp.check((select string_agg(pg_temp.s25_msg(resp, g::int), '|' order by g) from s25_resp, generate_series(0, 1) g where n = 'g10')
                       = 'Needs attention: the name in this row does not match Mr# 28041 on the website. Check the Mr#, or type the name as the website has it.|Needs attention: the name in this row does not match Mr# 28011 on the website. Check the Mr#, or type the name as the website has it.'
                     and not exists (select 1 from public.visits where sheet_key in (pg_temp.s25_k(1765), pg_temp.s25_k(1766))),
  'a surname alone typed with a guessed Mr# is refused: no visit, and the patient''s name is not in the answer');

-- =====================================================================
-- 23. Loop 7 (10 Oct 2026): a retired Mr# needs the whole name; what the sync made for a corrected row goes with it; a Month is never a checkup
-- =====================================================================
-- (abuse-privacy M1) a retired Mr# is that patient only with their whole name (no other surname), or with their phone AND first name. The
-- answer "Use 50921" sends staff to that patient's file, so "Ali Raza" (a new Healthwire patient given 10921) must never get it.
insert into public.patients (mr_number, full_name, phone, first_branch_id, notes) values
  ('50921', 'Ali Khanzada', null, 4, 'Mr# was 10921 until 09 Oct 2026 (the website now numbers from 50000)'),
  ('50922', 'Hassan Ali', null, 4, 'Mr# was 10922 until 09 Oct 2026 (the website now numbers from 50000)'),
  ('50923', 'Hamid Ali', '03180000923', 4, 'Mr# was 10923 until 09 Oct 2026 (the website now numbers from 50000)'),
  ('50924', 'Bushra Naveed', null, 4, 'Mr# was 10924 until 09 Oct 2026 (the website now numbers from 50000)'),
  ('50925', 'Kamran Akmal', '03180000925', 4, 'Mr# was 10925 until 09 Oct 2026 (the website now numbers from 50000)');
insert into s25_resp select 'm1r', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2101), '{"mr":"10921","name":"Ali Raza"}'),
  pg_temp.s25_row(pg_temp.s25_k(2102), '{"mr":"10922","name":"Hasan Raza"}'),
  pg_temp.s25_row(pg_temp.s25_k(2103), '{"mr":"10923","name":"Zara Ali","phone":"03180000923"}'),
  pg_temp.s25_row(pg_temp.s25_k(2104), '{"mr":"10924","name":"Bushra Naveed"}'),
  pg_temp.s25_row(pg_temp.s25_k(2105), '{"mr":"10925","name":"Kamran Butt","phone":"0318-0000925"}'))));
select pg_temp.check((select string_agg(pg_temp.s25_out(resp, g::int) || ':' || coalesce(pg_temp.s25_res(resp, g::int)->>'patient_created', '-'), ',' order by g)
                        from s25_resp, generate_series(0, 2) g where n = 'm1r') = 'created:10921,created:10922,created:10923',
  'a retired Mr# typed with the same first name and another surname (Ali Raza / Ali Khanzada), a slip of the first name with another surname (Hasan Raza / Hassan Ali), or another first name on that patient''s phone (Zara Ali) is Healthwire''s new patient, never "use 5092x"');
select pg_temp.check((select count(*) from public.visits v join public.patients p on p.id = v.patient_id where p.mr_number in ('50921', '50922', '50923')) = 0
                     and (select string_agg(p.full_name, ',' order by p.mr_number) from public.visits v join public.patients p on p.id = v.patient_id
                           where v.sheet_key in (pg_temp.s25_k(2101), pg_temp.s25_k(2102), pg_temp.s25_k(2103))) = 'Ali Raza,Hasan Raza,Zara Ali',
  'their visits are on their own new files, nothing is on the renumbered patients'' files');
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'm1r'), 3) = 'Mr# 10924 is no longer used. This patient''s Mr# is now 50924. Use 50924.'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'm1r'), 4) = 'Mr# 10925 is no longer used. This patient''s Mr# is now 50925. Use 50925.'
                     and (select count(*) from public.patients where mr_number in ('10924', '10925')) = 0,
  'the renumbered patient''s whole name, or their phone with their first name (another surname), is still told the Mr# now, and nothing is made');

-- (abuse-privacy M2, as decided on 11 Oct 2026) a row whose name fits its Mr# only with doubt is refused: no visit, no braces case. Sent again
-- with a later edit it is refused again, every time; once the name is the patient's, the row goes through with its Month
insert into public.patients (mr_number, full_name, phone, first_branch_id) values
  ('28060', 'Ayesha Khanum', '03180000960', 4), ('28061', 'Rabia Saleem', '03180000961', 4), ('28062', 'Sana Mirza', '03180000962', 4);
insert into s25_resp select 'm2a', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2110), '{"mr":"28060","name":"Ayesha Rajpoot","month":{"t":"3","v":3}}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'm2a')) = 'needs_patient' and pg_temp.s25_res((select resp from s25_resp where n = 'm2a'))->>'level' = 'error'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'm2a')) = 'Needs attention: the name in this row does not match Mr# 28060 on the website. Check the Mr#, or type the name as the website has it.'
                     and not exists (select 1 from public.braces_cases b join public.patients p on p.id = b.patient_id where p.mr_number = '28060')
                     and pg_temp.s25_vis(pg_temp.s25_k(2110)) is null,
  'Ayesha Rajpoot typed with the Mr# of Ayesha Khanum and a Month: refused, no visit and no braces case on that patient');
insert into s25_resp select 'm2a2', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2110), '{"mr":"28060","name":"Ayesha Rajpoot","month":{"t":"3","v":3},"status":{"t":"Treatment","v":"in_treatment"}}'))));
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'm2a2')) = pg_temp.s25_msg((select resp from s25_resp where n = 'm2a'))
                     and pg_temp.s25_out((select resp from s25_resp where n = 'm2a2')) = 'needs_patient'
                     and pg_temp.s25_vis(pg_temp.s25_k(2110)) is null
                     and not exists (select 1 from public.braces_cases b join public.patients p on p.id = b.patient_id where p.mr_number = '28060')
                     and (select count(*) = 1 from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' = pg_temp.s25_k(2110)),
  'a later edit of that row (its Status) gets the refusal again: never a plain tick, still nothing made (and the same row is one audited lookup)');
insert into s25_resp select 'm2b', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2110), '{"mr":"28060","name":"Ayesha Khanum","month":{"t":"3","v":3},"status":{"t":"Treatment","v":"in_treatment"}}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'm2b')) = 'created' and pg_temp.s25_res((select resp from s25_resp where n = 'm2b'))->>'level' = 'ok'
                     and (pg_temp.s25_vis(pg_temp.s25_k(2110))).braces_month = 3 and (pg_temp.s25_vis(pg_temp.s25_k(2110))).status = 'in_treatment'
                     and (select count(*) from public.braces_cases b join public.patients p on p.id = b.patient_id where p.mr_number = '28060' and b.status = 'active') = 1,
  'once the name in the row is the patient''s, the row goes through: the visit is made with its Month and the braces case is started');
-- what the sync started for a row goes with it when the row is deleted, and comes back with Ctrl+Z
insert into s25_resp select 'm2c', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2111), '{"mr":"28061","name":"Rabia Saleem","month":{"t":"2","v":2}}'),
  pg_temp.s25_row(pg_temp.s25_k(2112), '{"mr":"28062","name":"Sana Javed","month":{"t":"4","v":4}}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'm2c'), 0) = 'created' and pg_temp.s25_out((select resp from s25_resp where n = 'm2c'), 1) = 'needs_patient'
                     and (select count(*) from public.braces_cases b join public.patients p on p.id = b.patient_id where p.mr_number = '28061') = 1
                     and (select count(*) from public.braces_cases b join public.patients p on p.id = b.patient_id where p.mr_number = '28062') = 0
                     and pg_temp.s25_vis(pg_temp.s25_k(2112)) is null,
  'setup: Rabia''s Month starts her braces case; Sana typed with another surname is refused: no visit, no braces case on the wrong patient');
insert into s25_resp select 'm2d', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', '[]', pg_temp.s25_bkeys(4::smallint, array[pg_temp.s25_k(2111)]))), true));
select pg_temp.check((select x->>'action' = 'deleted' and x->>'message' = 'Row deleted in the sheet: the visit is removed from the website too. So is the braces case its Month started. Put the row back to undo.'
                        from (select pg_temp.s25_rm((select resp from s25_resp where n = 'm2d'), pg_temp.s25_k(2111)) x) y)
                     and not exists (select 1 from public.braces_cases b join public.patients p on p.id = b.patient_id where p.mr_number = '28061')
                     and exists (select 1 from public.patients where mr_number = '28061'),
  'a deleted row takes the braces case its Month started with its visit (the patient file, made on the website, stays)');
insert into s25_resp select 'm2f', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', '[]', pg_temp.s25_bkeys(4::smallint) || pg_temp.s25_k(2111))), true));
select pg_temp.check((pg_temp.s25_vis(pg_temp.s25_k(2111))).braces_month = 2
                     and (pg_temp.s25_vis(pg_temp.s25_k(2111))).braces_case_id = (select b.id from public.braces_cases b join public.patients p on p.id = b.patient_id where p.mr_number = '28061' and b.status = 'active'),
  'Ctrl+Z puts the visit back with its braces case');

-- (sheet-behaviour M3) a Healthwire Mr# typed with a slip makes a patient file. When staff correct the Mr# (the script sends the row again under
-- a new key), the file made from the slip goes with its visit: no stray file holding a number Healthwire gives somebody else
insert into s25_resp select 'm3a', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2120), '{"mr":"19888","name":"Slip Person","phone":"03180001888","treatment":"Consultation","month":{"t":"1","v":1}}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'm3a')) = 'created' and pg_temp.s25_res((select resp from s25_resp where n = 'm3a'))->>'patient_created' = '19888'
                     and exists (select 1 from public.braces_cases b join public.patients p on p.id = b.patient_id where p.mr_number = '19888'),
  'setup: the slip 19888 made a patient file (and its Month a braces case)');
-- (sheet-behaviour RW8-1) the corrected Mr# reaches the website first under the row's own key (the name is unchanged): the file was made from
-- this very row today, so the row is let go ("rekey") and nothing is changed or removed in that call; the script then sends it again as a new
-- row (next call). A file the sync did not make from the row is never let go for a changed Mr# (the Mr# is written back, section 19).
-- a stray 7, or a digit too many (198880), on that same row is a slip on the new file too: written back, nothing let go, made or removed
insert into s25_resp select 'm3s', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2120), '{"mr":"7"}', false, '{"mr":"19888"}'::jsonb, pg_temp.s25_now_ms()),
  pg_temp.s25_row(pg_temp.s25_k(2120), '{"mr":"198880"}', false, '{"mr":"19888"}'::jsonb, pg_temp.s25_now_ms()))));
select pg_temp.check((select bool_and(pg_temp.s25_out(resp, g::int) in ('updated', 'unchanged') and pg_temp.s25_res(resp, g::int)->'kept_website' = '["mr"]'::jsonb) from s25_resp, generate_series(0, 1) g where n = 'm3s')
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'm3s'), 0) = 'Mr# 7 is not this visit''s patient, so Mr# 19888 is put back. If this row is another patient, delete it and type that patient in a new row.'
                     and (pg_temp.s25_vis(pg_temp.s25_k(2120))).patient_id = (select id from public.patients where mr_number = '19888')
                     and not exists (select 1 from public.patients where mr_number in ('7', '198880') and legacy_source = 'aaj_sheet_sync'),
  'RW8-1: a stray 7 or a digit too many on a row whose file the sync made today is written back, never let go');
insert into s25_resp select 'm3r', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2120), '{"mr":"19878"}', false, '{"mr":"19888"}'::jsonb, pg_temp.s25_now_ms()))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'm3r')) = 'rekey' and pg_temp.s25_res((select resp from s25_resp where n = 'm3r'))->>'level' = 'warn'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'm3r')) = 'Mr# changed from 19888 to 19878: this row is sent again with the new Mr#.'
                     and (pg_temp.s25_vis(pg_temp.s25_k(2120))).patient_id = (select id from public.patients where mr_number = '19888')
                     and not exists (select 1 from public.patients where mr_number = '19878')
                     and (select count(*) = 1 from public.audit_log where action = 'SHEET_LETGO' and table_name = 'visits' and new_data->>'key' = pg_temp.s25_k(2120) and new_data->>'why' = 'mr_slip'),
  'RW8-1: the Mr# corrected on a row whose patient file the sync made from it today: the row is let go (written down), nothing changed yet');
insert into s25_resp select 'm3b', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR',
  jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(2121), '{"mr":"19878","name":"Slip Person","phone":"03180001888","treatment":"Consultation","month":{"t":"1","v":1}}')),
  pg_temp.s25_bkeys(4::smallint, array[pg_temp.s25_k(2120)]) || pg_temp.s25_k(2121))), true));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'm3b')) = 'created' and pg_temp.s25_res((select resp from s25_resp where n = 'm3b'))->>'patient_created' = '19878'
                     and not exists (select 1 from public.patients where mr_number = '19888')
                     and not exists (select 1 from public.visits where sheet_key = pg_temp.s25_k(2120))
                     and (select x->>'action' = 'deleted' and x->>'message' like '%So is the patient file made from this row (Mr# 19888).%'
                            from (select pg_temp.s25_rm((select resp from s25_resp where n = 'm3b'), pg_temp.s25_k(2120)) x) y),
  'the Mr# corrected to 19878 (same name and phone): the right patient is made, never "use 19888"; the file made from the slip goes with its visit and braces case, and the sheet is told');
select pg_temp.check((select new_data->'patient'->>'mr_number' = '19888' and jsonb_typeof(new_data->'case') = 'object'
                        from public.audit_log where action = 'SHEET_REMOVED' and new_data->>'key' = pg_temp.s25_k(2120)),
  'the removed file and braces case are kept in the removal''s audit row');
insert into s25_resp select 'm3u', public.aaj_undo_removal((select id from public.audit_log where action = 'SHEET_REMOVED' and new_data->>'key' = pg_temp.s25_k(2120)));
select pg_temp.check((select resp->>'ok' = 'true' from s25_resp where n = 'm3u')
                     and exists (select 1 from public.visits v join public.patients p on p.id = v.patient_id join public.braces_cases b on b.id = v.braces_case_id
                                  where p.mr_number = '19888' and b.patient_id = p.id),
  'the undo puts the file, its braces case and the visit back');
insert into s25_resp select 'm3c', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(2122), '{"mr":"19889","name":"Keep Person"}'))));
insert into public.visits (patient_id, branch_id, visit_date, status) select id, 1, pg_temp.s25_today(), 'waiting' from public.patients where mr_number = '19889';
insert into s25_resp select 'm3d', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', '[]', pg_temp.s25_bkeys(4::smallint, array[pg_temp.s25_k(2122)]))), true));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'm3c')) = 'created'
                     and not exists (select 1 from public.visits where sheet_key = pg_temp.s25_k(2122)) and exists (select 1 from public.patients where mr_number = '19889')
                     and (select x->>'message' = 'Row deleted in the sheet: the visit is removed from the website too. Put the row back to undo.'
                            from (select pg_temp.s25_rm((select resp from s25_resp where n = 'm3d'), pg_temp.s25_k(2122)) x) y),
  'a file the sync made that has something else on it (here a visit at another branch) stays when the row''s visit is removed');

-- (sheet-behaviour M2) a Month typed into a checkup row: the person is a braces patient, never kept as a checkup
insert into s25_resp select 'm4a', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2130), '{"name":"Brace Forgot","phone":"03180001001","treatment":"Checkup"}'),
  pg_temp.s25_row(pg_temp.s25_k(2131), '{"name":"New Smile","phone":"03180001002","treatment":"Checkup"}'))));
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('28070', 'New Smile', '03180001002', 4);
update public.checkups set patient_id = (select id from public.patients where mr_number = '28070') where sheet_key = pg_temp.s25_k(2131);
insert into s25_resp select 'm4b', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2130), '{"month":{"t":"6","v":6},"treatment":"Wire change"}', false, '{"month":"","treatment":"Checkup"}'::jsonb),
  pg_temp.s25_row(pg_temp.s25_k(2131), '{"month":{"t":"1","v":1},"treatment":"Braces bonding","status":{"t":"Completed","v":"completed"}}', false,
                  '{"month":"","treatment":"Checkup","status":"Waiting"}'::jsonb))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'm4a'), 0) = 'created' and pg_temp.s25_out((select resp from s25_resp where n = 'm4a'), 1) = 'created'
                     and (select string_agg(pg_temp.s25_out(resp, g::int) || ':' || pg_temp.s25_msg(resp, g::int), '|' order by g) from s25_resp, generate_series(0, 1) g where n = 'm4b')
                       = 'rekey:A row with a Month is a braces patient, never a checkup: this row is sent again as a visit.'
                         || '|rekey:A row with a Month is a visit, not a checkup: this row is sent again as the visit of Mr# 28070. The checkup stays as it is.',
  'a Month typed into a checkup row lets the row go (the script sends it again as a visit): an unregistered checkup and a registered one alike');
select pg_temp.check(exists (select 1 from public.audit_log where action = 'SHEET_LETGO' and table_name = 'checkups' and new_data->>'key' = pg_temp.s25_k(2130) and new_data->>'why' = 'month')
                     and not exists (select 1 from public.audit_log where action = 'SHEET_LETGO' and new_data->>'key' = pg_temp.s25_k(2131)),
  'RV9-2: the website writes down that it let the unregistered checkup''s row go (it goes whatever its status once its key has left the sheet); a registered checkup is a patient''s and is not let go');
select pg_temp.check((pg_temp.s25_chk(pg_temp.s25_k(2130))).checkup_for = 'Checkup' and (pg_temp.s25_chk(pg_temp.s25_k(2131))).checkup_for = 'Checkup'
                     and (pg_temp.s25_chk(pg_temp.s25_k(2131))).day_status = 'waiting',
  'and nothing of such a row is put on the checkup (it does not become a braces "lead" for the follow-up team)');
-- the script then sends such a row as a new row: with no Mr# it needs the Mr# (it never takes the checkup of the same
-- name and phone); with the Mr# it is that patient's visit, and the registered checkup is not adopted
insert into s25_resp select 'm4c', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', jsonb_build_array(
    pg_temp.s25_row(pg_temp.s25_k(2132), '{"name":"Brace Forgot","phone":"03180001001","treatment":"Checkup","month":{"t":"6","v":6}}'),
    pg_temp.s25_row(pg_temp.s25_k(2133), '{"mr":"28070","name":"New Smile","phone":"03180001002","treatment":"Braces bonding","month":{"t":"1","v":1}}')),
  pg_temp.s25_bkeys(4::smallint, array[pg_temp.s25_k(2130), pg_temp.s25_k(2131)]) || array[pg_temp.s25_k(2132), pg_temp.s25_k(2133)])), false));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'm4c'), 0) = 'needs_patient'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'm4c'), 0) = 'Needs attention: add the Mr#. A row with a Month is a braces patient, never a checkup. Look the Mr# up in Healthwire.'
                     and (pg_temp.s25_chk(pg_temp.s25_k(2130))).id is not null,
  'a row with a Month and no Mr# needs the Mr#, even when a checkup of the same name and phone lost its row: that checkup is not taken');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'm4c'), 1) = 'created'
                     and (pg_temp.s25_vis(pg_temp.s25_k(2133))).patient_id = (select id from public.patients where mr_number = '28070')
                     and (pg_temp.s25_vis(pg_temp.s25_k(2133))).braces_month = 1
                     and (pg_temp.s25_chk(pg_temp.s25_k(2131))).patient_id = (select id from public.patients where mr_number = '28070'),
  'with the Mr# and a Month it is the patient''s visit (braces month 1), and the registered checkup stays as it was');

-- =====================================================================
-- 24. Loop 8 (10 Oct 2026): a released record is never removed; No show rows; adoption follows the newer edit; everyday name spellings
-- =====================================================================
insert into public.patients (mr_number, full_name, phone, first_branch_id) values
  ('28401', 'Rel Website', '03190000401', 3), ('28402', 'Rel Sheet', '03190000402', 3), ('28403', 'Rel Noshow', '03190000403', 3),
  ('28405', 'Echo Back', '03190000405', 3), ('28406', 'Adopt Forward', '03190000406', 3), ('28407', 'Adopt Busy', '03190000407', 3),
  ('28408', 'Adopt Older', '03190000408', 3), ('28409', 'Umer Farooq', null, 3), ('28410', 'Sara Khan', null, 3);
-- (a) RS5-D4: a website visit (W- key), claimed by the sheet, cancelled on the website, its row deleted: released, not removed. Set back to
-- Waiting on the website, it is still not removed (the old code deleted it as a deleted row), and the list says so for the script.
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label) select id, 3, pg_temp.s25_today(), 'waiting', 'Scaling' from public.patients where mr_number = '28401';
create temp table s25_rel as select 'W-' || id as wk, id from public.visits where patient_id = (select id from public.patients where mr_number = '28401') and visit_date = pg_temp.s25_today();
insert into s25_resp select 'rl0', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('DHA', '[]', pg_temp.s25_bkeys(3::smallint) || (select wk from s25_rel))), false));
update public.visits set status = 'cancelled' where id = (select id from s25_rel);
insert into s25_resp select 'rl1', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('DHA', '[]', pg_temp.s25_bkeys(3::smallint, array[(select wk from s25_rel)]))), true));
select pg_temp.check((select sheet_key = (select wk from s25_rel) from public.visits where id = (select id from s25_rel))
                     and exists (select 1 from private.aaj_released where visit_id = (select id from s25_rel))
                     and (select resp->'tabs'->0->'removed' = '[]'::jsonb from s25_resp where n = 'rl1')
                     and (select (x->>'removed')::boolean and (x->>'claimed')::boolean and x->>'status' = 'Cancelled' from jsonb_array_elements((select resp->'tabs'->0->'visits' from s25_resp where n = 'rl1')) x where x->>'key' = (select wk from s25_rel)),
  'RS5-D4: a cancelled website visit whose row left the sheet is released: not removed, and the list marks it "removed" for the script');
update public.visits set status = 'waiting' where id = (select id from s25_rel);
insert into s25_resp select 'rl2', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('DHA', '[]', pg_temp.s25_bkeys(3::smallint, array[(select wk from s25_rel)]))), true));
select pg_temp.check((select status = 'waiting' from public.visits where id = (select id from s25_rel))
                     and (select resp->'tabs'->0->'removed' = '[]'::jsonb from s25_resp where n = 'rl2')
                     and not exists (select 1 from public.audit_log where action = 'SHEET_REMOVED' and row_id = (select id::text from s25_rel))
                     and (select (x->>'removed')::boolean and x->>'status' = 'Waiting' from jsonb_array_elements((select resp->'tabs'->0->'visits' from s25_resp where n = 'rl2')) x where x->>'key' = (select wk from s25_rel)),
  'RS5-D4: set back to Waiting on the website, it is never removed as a deleted row; the list still marks it released (the script adds its row back)');
-- (abuse-privacy minor, loop 6) its key sent in ANOTHER branch's tab does not take the mark away: only its own tab does
insert into s25_resp select 'rl2b', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('GUL', '[]', pg_temp.s25_bkeys(1::smallint) || (select wk from s25_rel))), false));
select pg_temp.check(exists (select 1 from private.aaj_released where visit_id = (select id from s25_rel)),
  'a released visit''s key in another branch''s tab does not take its mark away');
insert into s25_resp select 'rl3', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('DHA', '[]', pg_temp.s25_bkeys(3::smallint))), true));
select pg_temp.check(not exists (select 1 from private.aaj_released where visit_id = (select id from s25_rel))
                     and (select not (x->>'removed')::boolean from jsonb_array_elements((select resp->'tabs'->0->'visits' from s25_resp where n = 'rl3')) x where x->>'key' = (select wk from s25_rel)),
  'RS5-D4: once its key is on the sheet again (the row was added back) it is an ordinary row again');
-- (b) the same for a visit made in the sheet (S- key) and for a checkup
insert into s25_resp select 'rl4', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2402), '{"mr":"28402","name":"Rel Sheet","treatment":"Filling"}'),
  pg_temp.s25_row(pg_temp.s25_k(2403), '{"name":"Rel Checkup","phone":"03190000499","treatment":"Checkup"}')), pg_temp.s25_bkeys(3::smallint) || array[pg_temp.s25_k(2402), pg_temp.s25_k(2403)]));
update public.visits set status = 'cancelled' where sheet_key = pg_temp.s25_k(2402);
update public.checkups set day_status = 'cancelled' where sheet_key = pg_temp.s25_k(2403);
insert into s25_resp select 'rl5', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('DHA', '[]', pg_temp.s25_bkeys(3::smallint, array[pg_temp.s25_k(2402), pg_temp.s25_k(2403)]))), true));
update public.visits set status = 'waiting' where sheet_key = pg_temp.s25_k(2402);
update public.checkups set day_status = 'waiting' where sheet_key = pg_temp.s25_k(2403);
insert into s25_resp select 'rl6', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('DHA', '[]', pg_temp.s25_bkeys(3::smallint, array[pg_temp.s25_k(2402), pg_temp.s25_k(2403)]))), true));
select pg_temp.check((select v.status = 'waiting' from pg_temp.s25_vis(pg_temp.s25_k(2402)) v) and (select c.day_status = 'waiting' from pg_temp.s25_chk(pg_temp.s25_k(2403)) c)
                     and (select resp->'tabs'->0->'removed' = '[]'::jsonb from s25_resp where n = 'rl6')
                     and (select count(*) = 2 from jsonb_array_elements((select resp->'tabs'->0->'visits' from s25_resp where n = 'rl6')) x
                           where x->>'key' in (pg_temp.s25_k(2402), pg_temp.s25_k(2403)) and (x->>'removed')::boolean and x->>'status' = 'Waiting'),
  'RS5-D4: a sheet-made visit (S- key) and a checkup, cancelled, their rows deleted, then set back to Waiting: neither is removed, both are marked for the script');
-- (c) RS5-B2: a No show with something attached (an invoice): kept as it is, its row is not put back, never a removal candidate again
insert into s25_resp select 'rl7', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(2404), '{"mr":"28403","name":"Rel Noshow","treatment":"RCT"}')),
  pg_temp.s25_bkeys(3::smallint) || pg_temp.s25_k(2404)));
update public.visits set status = 'no_show' where sheet_key = pg_temp.s25_k(2404);
insert into public.invoices (visit_id, patient_id, branch_id) select id, patient_id, 3 from public.visits where sheet_key = pg_temp.s25_k(2404);
insert into s25_resp select 'rl8', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('DHA', '[]', pg_temp.s25_bkeys(3::smallint, array[pg_temp.s25_k(2404)]))), true));
insert into s25_resp select 'rl9', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('DHA', '[]', pg_temp.s25_bkeys(3::smallint, array[pg_temp.s25_k(2404)]))), true));
select pg_temp.check((select x->>'action' = 'released' and x->>'message' = 'Row deleted in the sheet: the visit stays on the website as No show (it has an attached record (invoices)). Its row is not put back.'
                        from (select pg_temp.s25_rm((select resp from s25_resp where n = 'rl8'), pg_temp.s25_k(2404)) x) y)
                     and (select v.status = 'no_show' from pg_temp.s25_vis(pg_temp.s25_k(2404)) v)
                     and (select (x->>'removed')::boolean from jsonb_array_elements((select resp->'tabs'->0->'visits' from s25_resp where n = 'rl8')) x where x->>'key' = pg_temp.s25_k(2404))
                     and (select resp->'tabs'->0->'removed' = '[]'::jsonb from s25_resp where n = 'rl9')
                     and (select count(*) = 1 from public.audit_log where action = 'SHEET_REMOVED' and new_data->>'action' = 'released' and new_data->>'key' = pg_temp.s25_k(2404)),
  'RS5-B2: a No show visit with an invoice whose row is deleted stays No show, its row is not put back (no "restore"), and it is not looked at again');
-- (d) RS5-A1: a new row that adopts a visit: the newer edit wins for text, the status only moves forward, a freshly typed row brings a
-- Cancelled visit back; a visit in Treatment keeps the website's text and status; a row older than the website's change keeps the website's
insert into s25_resp select 'ab0', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(2405), '{"mr":"28405","name":"Echo Back","treatment":"Scaling"}')),
  pg_temp.s25_bkeys(3::smallint) || pg_temp.s25_k(2405)));
update public.visits set status = 'cancelled' where sheet_key = pg_temp.s25_k(2405);
insert into s25_resp select 'ab1', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('DHA', '[]', pg_temp.s25_bkeys(3::smallint, array[pg_temp.s25_k(2405)]))), true));
insert into s25_resp select 'ab2', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(2406),
  '{"mr":"28405","name":"Echo Back","treatment":"RCT","details":"came after all","status":{"t":"Waiting","v":"waiting"}}', true, null, pg_temp.s25_now_ms() + 1000)),
  pg_temp.s25_bkeys(3::smallint, array[pg_temp.s25_k(2405)]) || pg_temp.s25_k(2406)));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ab2')) = 'linked'
                     and (select v.status = 'waiting' and v.treatment_label = 'RCT' and v.details_text = 'came after all' from pg_temp.s25_vis(pg_temp.s25_k(2406)) v)
                     and pg_temp.s25_res((select resp from s25_resp where n = 'ab2'))->'kept_website' = '[]'::jsonb
                     and not exists (select 1 from private.aaj_released rl join public.visits x on x.id = rl.visit_id where x.sheet_key = pg_temp.s25_k(2406)),
  'RS5-A1: a cancelled patient (her row deleted) typed again when she turns up: the visit is adopted, Waiting again, with the treatment and details just typed, and no longer released');
-- the same with no Status typed in the new row (the website fills an empty Status): the patient is here, so the visit is Waiting again
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('28411', 'Echo Nostatus', '03190000411', 3);
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label) select id, 3, pg_temp.s25_today(), 'no_show', 'Scaling' from public.patients where mr_number = '28411';
insert into s25_resp select 'ab2b', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(2414),
  '{"mr":"28411","name":"Echo Nostatus","treatment":"Scaling"}', true, null, pg_temp.s25_now_ms() + 1000)), pg_temp.s25_bkeys(3::smallint) || pg_temp.s25_k(2414)));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ab2b')) = 'linked' and (select v.status = 'waiting' from pg_temp.s25_vis(pg_temp.s25_k(2414)) v),
  'RS5-A1: a No show patient typed again just now with the Status left empty is Waiting again (a new row starts as Waiting)');
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label) select id, 3, pg_temp.s25_today(), 'waiting', 'Consultation' from public.patients where mr_number = '28406';
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, started_at) select id, 3, pg_temp.s25_today(), 'in_treatment', 'Filling', now() from public.patients where mr_number = '28407';
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label) select id, 3, pg_temp.s25_today(), 'waiting', 'Consultation' from public.patients where mr_number = '28408';
update public.visits set token_no = 41 where patient_id = (select id from public.patients where mr_number = '28406') and visit_date = pg_temp.s25_today();
insert into s25_resp select 'ab3', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2407), '{"mr":"28406","name":"Adopt Forward","treatment":"RCT","token":{"t":"3","v":3},"status":{"t":"Completed","v":"completed"}}', true, null, pg_temp.s25_now_ms() + 1000),
  pg_temp.s25_row(pg_temp.s25_k(2408), '{"mr":"28407","name":"Adopt Busy","treatment":"Checkup","status":{"t":"Waiting","v":"waiting"}}', true, null, pg_temp.s25_now_ms() + 1000),
  pg_temp.s25_row(pg_temp.s25_k(2409), '{"mr":"28408","name":"Adopt Older","treatment":"Scaling","status":{"t":"Treatment","v":"in_treatment"}}', true, null, pg_temp.s25_now_ms() - 600000)),
  pg_temp.s25_bkeys(3::smallint) || array[pg_temp.s25_k(2407), pg_temp.s25_k(2408), pg_temp.s25_k(2409)]));
select pg_temp.check((select string_agg(pg_temp.s25_out(resp, g::int), ',' order by g) from s25_resp, generate_series(0, 2) g where n = 'ab3') = 'linked,linked,linked'
                     and (select v.status = 'completed' and v.treatment_label = 'RCT' and v.token_no = 41 from pg_temp.s25_vis(pg_temp.s25_k(2407)) v),
  'RS5-A1: "Completed / RCT" typed for a visit front desk added as "Waiting / Consultation": the status moves forward and the treatment just typed is saved; the website''s token stays (the sheet numbers per group)');
select pg_temp.check((select v.status = 'in_treatment' and v.treatment_label = 'Filling' from pg_temp.s25_vis(pg_temp.s25_k(2408)) v)
                     and pg_temp.s25_res((select resp from s25_resp where n = 'ab3'), 1)->'kept_website' @> '["status","treatment"]'::jsonb,
  'RS5-A1: a visit already in Treatment keeps the website''s status and text against a newer "Waiting / Checkup" (a stale install-day sheet), and says so');
select pg_temp.check((select v.status = 'waiting' and v.treatment_label = 'Consultation' from pg_temp.s25_vis(pg_temp.s25_k(2409)) v)
                     and pg_temp.s25_res((select resp from s25_resp where n = 'ab3'), 2)->'kept_website' @> '["status","treatment"]'::jsonb,
  'RS5-A1: a row last edited before the website''s change keeps the website''s status and treatment');
select pg_temp.check(private.aaj_adopt_status('completed', 'waiting', true) = 'keep' and private.aaj_adopt_status('waiting', 'completed', true) = 'apply'
                     and private.aaj_adopt_status('cancelled', 'waiting', true) = 'apply' and private.aaj_adopt_status('no_show', 'in_treatment', true) = 'apply'
                     and private.aaj_adopt_status('cancelled', 'waiting', false) = 'keep' and private.aaj_adopt_status('in_treatment', 'cancelled', true) = 'keep'
                     and private.aaj_adopt_status('scheduled', 'cancelled', true) = 'apply' and private.aaj_adopt_status('waiting', 'waiting', false) = 'same',
  'aaj_adopt_status: forward only, a Cancelled / No show visit comes back with a fresh row, nothing changes for an older row');
-- the same for a checkup a new row adopts (same name and phone): a Cancelled one whose row was deleted comes back with the row typed again;
-- a Completed one keeps the website's status and text
insert into public.checkups (checkup_date, branch_id, patient_name, phone, checkup_for, source, day_status, details) values
  (pg_temp.s25_today(), 3, 'Back Checkup', '03190000431', 'Checkup', 'website', 'waiting', null),
  (pg_temp.s25_today(), 3, 'Done Checkup', '03190000432', 'Checkup', 'website', 'completed', 'seen by Dr Ali');
update public.checkups set sheet_key = 'W-' || id where patient_name in ('Back Checkup', 'Done Checkup') and branch_id = 3;
update public.checkups set day_status = 'cancelled' where patient_name = 'Back Checkup' and branch_id = 3;
insert into s25_resp select 'ac1', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('DHA', '[]',
  pg_temp.s25_bkeys(3::smallint, array(select 'W-' || id from public.checkups where patient_name = 'Back Checkup' and branch_id = 3)))), true));
select pg_temp.check(exists (select 1 from private.aaj_released rl join public.checkups c on c.id = rl.checkup_id where c.patient_name = 'Back Checkup'), 'setup: the cancelled checkup whose row was deleted is released');
insert into s25_resp select 'ac2', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2420), '{"name":"Back Checkup","phone":"03190000431","treatment":"Checkup","status":{"t":"Waiting","v":"waiting"},"details":"came back"}', true, null, pg_temp.s25_now_ms() + 1000),
  pg_temp.s25_row(pg_temp.s25_k(2421), '{"name":"Done Checkup","phone":"03190000432","treatment":"Checkup","status":{"t":"Waiting","v":"waiting"},"details":"typed again"}', true, null, pg_temp.s25_now_ms() + 1000)),
  pg_temp.s25_bkeys(3::smallint, array(select 'W-' || id from public.checkups where patient_name in ('Back Checkup', 'Done Checkup') and branch_id = 3)) || array[pg_temp.s25_k(2420), pg_temp.s25_k(2421)]));
select pg_temp.check((select string_agg(pg_temp.s25_out(resp, g::int), ',' order by g) from s25_resp, generate_series(0, 1) g where n = 'ac2') = 'linked,linked'
                     and (select c.day_status = 'waiting' and c.details = 'came back' from pg_temp.s25_chk(pg_temp.s25_k(2420)) c)
                     and (select c.day_status = 'completed' and c.details = 'seen by Dr Ali' from pg_temp.s25_chk(pg_temp.s25_k(2421)) c)
                     and pg_temp.s25_res((select resp from s25_resp where n = 'ac2'), 1)->'kept_website' @> '["status","details"]'::jsonb,
  'RS5-A1: a cancelled checkup typed again comes back as Waiting with the row''s details; a Completed checkup keeps the website''s status and text');
-- (e) RS5-N1: an everyday spelling of the same person's first name with the same surname fits; another name with the same surname does not
select pg_temp.check((select bool_and(private.aaj_name_close(t, f)) from (values
    ('Umar Farooq', 'Umer Farooq'), ('Aisha Khan', 'Ayesha Khan'), ('Sanaa Ahmed', 'Sana Ahmed'), ('Aly Raza', 'Ali Raza'), ('Zenab Bibi', 'Zainab Bibi'),
    ('Iqra Shah', 'Ikra Shah'), ('Asmaa Noor', 'Asma Noor'), ('Saba Iqbal', 'Sabah Iqbal'), ('Amna Tariq', 'Aamna Tariq'), ('Nur Fatima', 'Noor Fatima'),
    ('Zara Ali', 'Zarah Ali'), ('Fahd Khan', 'Fahad Khan'), ('Heera Malik', 'Hira Malik'), ('Huma Saeed', 'Homa Saeed'), ('Uzma Bano', 'Uzmah Bano'),
    ('Yousuf Ali', 'Yusuf Ali'), ('Usman Ghani', 'Osman Ghani'), ('Hamza Riaz', 'Humza Riaz'), ('Mahwish Ali', 'Mehwish Ali'), ('Ayesha', 'Aisha Siddiqui'),
    ('Umar', 'Umer Hayat'), ('Rida Fatima', 'Ridaa Fatima'), ('Nida Khan', 'Nidaa Khan'), ('Owais Raza', 'Uwais Raza'), ('Hafsa Bibi', 'Hafza Bibi')) p(t, f)),
  'RS5-N1: 25 everyday spellings of the same person''s first name (the same surname, or the first name alone) fit the patient');
select pg_temp.check((select bool_and(not private.aaj_name_close(t, f)) from (values
    ('Sana Khan', 'Sara Khan'), ('Hira Malik', 'Hina Malik'), ('Amna Tariq', 'Asma Tariq'), ('Saba Iqbal', 'Sana Iqbal'), ('Ali Raza', 'Aliya Raza'),
    ('Asif Khan', 'Atif Khan'), ('Shahid Khan', 'Sadia Khan'), ('Umar Khan', 'Umer Farooq'), ('Qureshi', 'Zubaida Qureshi'), ('Khan', 'Sara Khan'),
    ('Qq Ayesha Bilal Fatima Sana', 'Ayesha Khan'), ('Sara Khan Noor', 'Sana Khan')) p(t, f)),
  'RS5-N1: another first name with the same surname (one letter apart too), a surname alone and a stuffed name still fit nobody');
-- 11 Oct 2026: of those 25, the ones written another everyday way fit WITHOUT DOUBT (a plain tick, the Month saved); four need a letter added,
-- swapped for another vowel or s/z (the rule that would take them would also make Umair of Umar, Umair of Umer, or Zara of Sara): refused,
-- "type the name as the website has it"
select pg_temp.check((select string_agg(t, ',' order by t) from (values
    ('Umar Farooq', 'Umer Farooq'), ('Aisha Khan', 'Ayesha Khan'), ('Sanaa Ahmed', 'Sana Ahmed'), ('Aly Raza', 'Ali Raza'), ('Zenab Bibi', 'Zainab Bibi'),
    ('Iqra Shah', 'Ikra Shah'), ('Asmaa Noor', 'Asma Noor'), ('Saba Iqbal', 'Sabah Iqbal'), ('Amna Tariq', 'Aamna Tariq'), ('Nur Fatima', 'Noor Fatima'),
    ('Zara Ali', 'Zarah Ali'), ('Fahd Khan', 'Fahad Khan'), ('Heera Malik', 'Hira Malik'), ('Huma Saeed', 'Homa Saeed'), ('Uzma Bano', 'Uzmah Bano'),
    ('Yousuf Ali', 'Yusuf Ali'), ('Usman Ghani', 'Osman Ghani'), ('Hamza Riaz', 'Humza Riaz'), ('Mahwish Ali', 'Mehwish Ali'), ('Ayesha', 'Aisha Siddiqui'),
    ('Umar', 'Umer Hayat'), ('Rida Fatima', 'Ridaa Fatima'), ('Nida Khan', 'Nidaa Khan'), ('Owais Raza', 'Uwais Raza'), ('Hafsa Bibi', 'Hafza Bibi')) p(t, f)
   where not private.aaj_name_fits(t, f)) = 'Fahd Khan,Hafsa Bibi,Hamza Riaz,Zenab Bibi',
  'RS5-N1 (11 Oct 2026): 21 of the 25 spellings fit without doubt; Fahd / Fahad, Hafsa / Hafza, Hamza / Humza and Zenab / Zainab are refused');
insert into s25_resp select 'nm1', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2410), '{"mr":"28409","name":"Umar Farooq","treatment":"Monthly","month":{"t":"3","v":3}}'),
  pg_temp.s25_row(pg_temp.s25_k(2411), '{"mr":"28410","name":"Sana Khan","treatment":"Filling"}')), pg_temp.s25_bkeys(3::smallint) || array[pg_temp.s25_k(2410), pg_temp.s25_k(2411)]));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'nm1'), 0) = 'created'
                     and pg_temp.s25_res((select resp from s25_resp where n = 'nm1'), 0)->>'level' = 'ok'
                     and (select v.braces_month = 3 and v.braces_case_id is not null from pg_temp.s25_vis(pg_temp.s25_k(2410)) v)
                     and exists (select 1 from public.braces_cases b join public.patients p on p.id = b.patient_id where p.mr_number = '28409'),
  'RS5-N1: "Umar Farooq" typed with the Mr# of "Umer Farooq" and no phone fits without doubt (11 Oct 2026): the visit with a plain tick, and its Month starts the braces case');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'nm1'), 1) = 'needs_patient'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'nm1'), 1) = 'Needs attention: the name in this row does not match Mr# 28410 on the website. Check the Mr#, or type the name as the website has it.'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'nm1'), 1) not like '%Sara%' and pg_temp.s25_vis(pg_temp.s25_k(2411)) is null,
  'RS5-N1: "Sana Khan" with the Mr# of "Sara Khan" is refused, and the answer says the Mr# may be right without naming the patient');
-- (f) a one-letter name is answered before any lookup: a Healthwire number nobody has and one the website has get the same answer, unaudited
create temp table s25_lk as select count(*) as n from public.audit_log where action = 'SHEET_LOOKUP';
insert into s25_resp select 'sn1', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2412), '{"mr":"49911","name":"x"}'), pg_temp.s25_row(pg_temp.s25_k(2413), '{"mr":"28410","name":"x"}')),
  pg_temp.s25_bkeys(3::smallint) || array[pg_temp.s25_k(2412), pg_temp.s25_k(2413)]));
select pg_temp.check((select string_agg(pg_temp.s25_out(resp, g::int) || ':' || pg_temp.s25_msg(resp, g::int), '|' order by g) from s25_resp, generate_series(0, 1) g where n = 'sn1')
                       = 'needs_patient:Patient name is too short.|needs_patient:Patient name is too short.'
                     and (select count(*) from public.audit_log where action = 'SHEET_LOOKUP') = (select n from s25_lk)
                     and not exists (select 1 from public.patients where mr_number = '49911'),
  'a one-letter name gets "too short" whatever the Mr#: nothing tells a free Healthwire number from a taken one');

-- =====================================================================
-- 25. Loop 2 of 11 Oct 2026: a doubtful row never moves a braces case on; a filled-in patient file stays; a Ctrl+Z that cannot be done now
-- =====================================================================
-- (abuse-privacy M1) brothers Umar Farooq (Mr# 28501, an active braces case) and Umair Farooq (28502) have neighbouring Healthwire numbers.
-- Umair's row typed with 28501 (a one-digit slip), Month 7, Completed; "Ayesha Rajpoot" typed with the Mr# of Ayesha Khan (an active case),
-- Monthly with no Month, Completed; "Bilal Raza" with the Mr# of Bilal Ahmed (an active case), Month 7, Waiting. Since 11 Oct 2026 all three
-- are refused (a name that fits only with doubt), so none of them is put on that patient's braces case, nor completed on that patient.
insert into public.patients (mr_number, full_name, phone, first_branch_id) values
  ('28501', 'Umar Farooq', null, 5), ('28502', 'Umair Farooq', null, 5), ('28503', 'Ayesha Khan', null, 5), ('28504', 'Bilal Ahmed', null, 5);
insert into public.braces_cases (patient_id, start_date, status) select id, pg_temp.s25_today() - 180, 'active' from public.patients where mr_number in ('28501', '28503', '28504');
create temp table s25_m1c as select p.mr_number, b.id, public.next_braces_month(b.id) as nxt from public.braces_cases b join public.patients p on p.id = b.patient_id
                              where p.mr_number in ('28501', '28503', '28504');
insert into s25_resp select 'wm1', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2501), '{"mr":"28501","name":"Umair Farooq","treatment":"Monthly","month":{"t":"7","v":7},"status":{"t":"Completed","v":"completed"}}'),
  pg_temp.s25_row(pg_temp.s25_k(2502), '{"mr":"28503","name":"Ayesha Rajpoot","treatment":"Monthly","status":{"t":"Completed","v":"completed"}}'),
  pg_temp.s25_row(pg_temp.s25_k(2503), '{"mr":"28504","name":"Bilal Raza","treatment":"Wire change","month":{"t":"7","v":7}}'))));
select pg_temp.check((select string_agg(pg_temp.s25_out(resp, g::int) || ':' || (pg_temp.s25_res(resp, g::int)->>'level'), ',' order by g) from s25_resp, generate_series(0, 2) g where n = 'wm1')
                       = 'needs_patient:error,needs_patient:error,needs_patient:error'
                     and (select bool_and(pg_temp.s25_msg(resp, g::int) like 'Needs attention: the name in this row does not match Mr# 2850_ on the website.%'
                                          and pg_temp.s25_msg(resp, g::int) not like '%Umar%' and pg_temp.s25_msg(resp, g::int) not like '%Khan%' and pg_temp.s25_msg(resp, g::int) not like '%Ahmed%')
                            from s25_resp, generate_series(0, 2) g where n = 'wm1'),
  'M1: a sound-alike brother, and the same first name with another surname, typed with the Mr# of a patient who has an active braces case: refused, the patient not named');
select pg_temp.check(not exists (select 1 from public.visits v where v.sheet_key in (pg_temp.s25_k(2501), pg_temp.s25_k(2502), pg_temp.s25_k(2503)))
                     and not exists (select 1 from public.visits v join public.patients p on p.id = v.patient_id where p.mr_number in ('28501', '28503', '28504'))
                     and (select bool_and(public.next_braces_month(c.id) = c.nxt) from s25_m1c c)
                     and not exists (select 1 from public.visits v join s25_m1c c on c.id = v.braces_case_id),
  'M1: no visit is made or completed on those patients and nothing is on their braces cases: each case''s next month is what it was');
insert into s25_resp select 'wm2', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2503), '{"mr":"28504","name":"Bilal Ahmed","legacy_name":"Bilal Ahmed","treatment":"Wire change","month":{"t":"7","v":7}}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'wm2')) = 'created' and pg_temp.s25_res((select resp from s25_resp where n = 'wm2'))->>'level' = 'ok'
                     and (pg_temp.s25_vis(pg_temp.s25_k(2503))).braces_month = 7
                     and (pg_temp.s25_vis(pg_temp.s25_k(2503))).braces_case_id = (select id from s25_m1c where mr_number = '28504'),
  'M1: once the name in the row is the patient''s, the row goes through and its Month goes onto that patient''s own active case');
-- (sheet-behaviour L2-residual) the linked row then typed over with another surname while its Month is changed: refused, every field kept
insert into s25_resp select 'wm3', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2503), '{"name":"Bilal Raza","legacy_name":"Bilal Raza","month":{"t":"8","v":8}}', false, '{"name":"Bilal Ahmed","month":"7"}'::jsonb))));
insert into s25_resp select 'wm3b', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2503), '{"name":"Bilal Raza","legacy_name":"Bilal Raza","month":{"t":"8","v":8},"status":{"t":"Completed","v":"completed"}}', false,
                  '{"name":"Bilal Ahmed","month":"7","status":"Waiting"}'::jsonb))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'wm3')) = 'error' and pg_temp.s25_out((select resp from s25_resp where n = 'wm3b')) = 'error'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'wm3b')) = pg_temp.s25_msg((select resp from s25_resp where n = 'wm3'))
                     and (select v.braces_month = 7 and v.status = 'waiting' and v.completed_at is null from pg_temp.s25_vis(pg_temp.s25_k(2503)) v),
  'M1: a row already on the case whose name is changed to another surname: refused on every edit (also Status Completed), the visit keeps month 7 and stays Waiting');
insert into s25_resp select 'wm4', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2503), '{"month":{"t":"8","v":8}}', false, '{"month":"7"}'::jsonb, pg_temp.s25_now_ms() - 1000))));
select pg_temp.check(pg_temp.s25_res((select resp from s25_resp where n = 'wm4'))->>'level' = 'ok' and (pg_temp.s25_vis(pg_temp.s25_k(2503))).braces_month = 8
                     and (pg_temp.s25_vis(pg_temp.s25_k(2503))).braces_case_id = (select id from s25_m1c where mr_number = '28504'),
  'M1: the name put right again (so the script sends only the Month the row still shows): month 8 is saved');

-- (sheet-behaviour RSX-1) a new Healthwire patient whose file front desk filled in while she waited (allergy, consent, date of birth): when her
-- row is deleted (or its Mr# corrected) the visit goes, but the file stays, and the sheet is told. A file nobody touched still goes.
update private.aaj_sync_config set value = '1000' where key = 'new_patients_per_branch_day';      -- (the sections above used up Islamabad's 30)
insert into s25_resp select 'xf1', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2510), '{"mr":"19501","name":"Zara Filled","phone":"03190001501","treatment":"Consultation"}'),
  pg_temp.s25_row(pg_temp.s25_k(2511), '{"mr":"19502","name":"Plain Untouched","phone":"03190001502","treatment":"Consultation"}')),
  pg_temp.s25_bkeys(5::smallint) || array[pg_temp.s25_k(2510), pg_temp.s25_k(2511)]));
select pg_temp.check((select string_agg(pg_temp.s25_res(resp, g::int)->>'patient_created', ',' order by g) from s25_resp, generate_series(0, 1) g where n = 'xf1') = '19501,19502',
  'RSX-1 setup: two new Healthwire patients made from the sheet');
update public.patients set medical_history = '{"allergy": "penicillin"}'::jsonb, treatment_consent_at = now(), date_of_birth = '1990-05-05' where mr_number = '19501';
insert into s25_resp select 'xf2', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('ISB', '[]', pg_temp.s25_bkeys(5::smallint, array[pg_temp.s25_k(2510)]))), true));
select pg_temp.check(not exists (select 1 from public.visits where sheet_key = pg_temp.s25_k(2510))
                     and (select medical_history->>'allergy' = 'penicillin' and date_of_birth = '1990-05-05' from public.patients where mr_number = '19501')
                     and (select x->>'action' = 'deleted'
                                 and x->>'message' = 'Row deleted in the sheet: the visit is removed from the website too. The patient file made from this row (Mr# 19501) is kept: details were saved on it on the website. Check it (if the Mr# was typed wrong, merge it into the right file). Put the row back to undo.'
                            from (select pg_temp.s25_rm((select resp from s25_resp where n = 'xf2'), pg_temp.s25_k(2510)) x) y)
                     and (select jsonb_typeof(new_data->'patient') = 'null' from public.audit_log where action = 'SHEET_REMOVED' and new_data->>'key' = pg_temp.s25_k(2510)),
  'RSX-1: the row of a patient whose new file front desk filled in is deleted: the visit goes, the file and what was saved on it stay, and the sheet is told to check it');
insert into s25_resp select 'xf3', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('ISB', '[]', pg_temp.s25_bkeys(5::smallint, array[pg_temp.s25_k(2511)]))), true));
select pg_temp.check(not exists (select 1 from public.patients where mr_number = '19502')
                     and (select x->>'message' like '%So is the patient file made from this row (Mr# 19502).%' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'xf3'), pg_temp.s25_k(2511)) x) y),
  'RSX-1: a file nobody changed since the sync made it still goes with its row');
update private.aaj_sync_config set value = '30' where key = 'new_patients_per_branch_day';

-- (sheet-behaviour RSG-2) Ctrl+Z of a deleted row whose patient was typed again in another row meanwhile: not put back (she is on the list in
-- that row), written down once, never done later behind the sheet's back, and the list is sent so the row reads "deleted on the website"
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('28510', 'Charlie Retype', '03190001510', 5);
insert into s25_resp select 'rz1', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(2520), '{"mr":"28510","name":"Charlie Retype","treatment":"Scaling"}')),
  pg_temp.s25_bkeys(5::smallint) || pg_temp.s25_k(2520)));
insert into s25_resp select 'rz2', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('ISB', '[]', pg_temp.s25_bkeys(5::smallint, array[pg_temp.s25_k(2520)]))), true));
insert into s25_resp select 'rz3', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(2521), '{"mr":"28510","name":"Charlie Retype","treatment":"RCT"}')),
  pg_temp.s25_bkeys(5::smallint) || pg_temp.s25_k(2521)));
select pg_temp.check((select x->>'action' = 'deleted' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'rz2'), pg_temp.s25_k(2520)) x) y)
                     and pg_temp.s25_out((select resp from s25_resp where n = 'rz3')) = 'created' and (pg_temp.s25_vis(pg_temp.s25_k(2521))).treatment_label = 'RCT',
  'RSG-2 setup: the row is deleted (the visit removed), and the patient is typed again in a new row');
insert into s25_resp select 'rz4', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(
  pg_temp.s25_tab('ISB', '[]', pg_temp.s25_bkeys(5::smallint) || pg_temp.s25_k(2520), md5(private.aaj_day_list(5::smallint, pg_temp.s25_today())::text))), false));
select pg_temp.check(not exists (select 1 from public.visits where sheet_key = pg_temp.s25_k(2520))
                     and (pg_temp.s25_vis(pg_temp.s25_k(2521))).id is not null
                     and (select resp->'tabs'->0->>'unchanged' = 'false' and jsonb_typeof(resp->'tabs'->0->'visits') = 'array' from s25_resp where n = 'rz4')
                     and (select count(*) = 1 and bool_and((new_data->>'skipped')::boolean) from public.audit_log
                           where action = 'SHEET_RESTORED' and new_data->>'audit' = (select a.id::text from public.audit_log a where a.action = 'SHEET_REMOVED' and a.new_data->>'key' = pg_temp.s25_k(2520))),
  'RSG-2: Ctrl+Z while the patient is on the list in another row: nothing is put back, it is written down, and the list is sent although it did not change (the row reads "deleted on the website", never a stale tick)');
insert into s25_resp select 'rz5', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(
  pg_temp.s25_tab('ISB', '[]', pg_temp.s25_bkeys(5::smallint, array[pg_temp.s25_k(2521)]) || pg_temp.s25_k(2520))), true));
insert into s25_resp select 'rz6', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('ISB', '[]', pg_temp.s25_bkeys(5::smallint) || pg_temp.s25_k(2520))), true));
select pg_temp.check((select x->>'action' = 'deleted' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'rz5'), pg_temp.s25_k(2521)) x) y)
                     and not exists (select 1 from public.visits v join public.patients p on p.id = v.patient_id where p.mr_number = '28510' and v.visit_date = pg_temp.s25_today())
                     and (select count(*) from public.audit_log where action = 'SHEET_RESTORED'
                           and new_data->>'audit' = (select a.id::text from public.audit_log a where a.action = 'SHEET_REMOVED' and a.new_data->>'key' = pg_temp.s25_k(2520))) = 1,
  'RSG-2: when staff then delete the row typed again, the old visit is not put back later under the row that said "deleted on the website"');
insert into s25_resp select 'rz7', public.aaj_undo_removal((select id from public.audit_log where action = 'SHEET_REMOVED' and new_data->>'key' = pg_temp.s25_k(2520)));
select pg_temp.check((select resp->>'ok' = 'true' from s25_resp where n = 'rz7')
                     and exists (select 1 from public.visits v join public.patients p on p.id = v.patient_id where p.mr_number = '28510' and v.visit_date = pg_temp.s25_today()
                                    and v.treatment_label = 'Scaling' and v.sheet_key is null),
  'RSG-2: Dr. Ali''s undo still puts that visit back (as a website row)');

-- =====================================================================
-- 26. 11 Oct 2026 (orchestrator decision, replaces "linked with a warning"): a row whose name fits its Mr# only with doubt is refused like
--     any other refusal: no visit made or adopted, no checkup touched, no phone filled, no braces case, nothing on the patient file.
--     (abuse-privacy M1, M2 and sheet-behaviour L2-residual of the loop-6 review)
-- =====================================================================
insert into public.patients (mr_number, full_name, phone, first_branch_id) values
  ('33001', 'Ayesha Khan', null, 2), ('33002', 'Ayesha Rajpoot', null, 2),
  ('33101', 'Ayesha Khan', '03001233101', 2), ('33102', 'Ayesha Rajpoot', '03001233102', 2),
  ('33201', 'Sana Khan', '03001230201', 2),
  ('33301', 'Ahmed Raza', null, 2), ('33302', 'Ahmad Hussain', null, 2);
-- (M1, a visit) Ayesha Khan is on today's list as Waiting / Consultation (front desk). Sheet staff type the other Ayesha with her Mr#, RCT,
-- Completed, after the website's last change (the newer edit would have won on an adoption)
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label)
  select id, 2, pg_temp.s25_today(), 'waiting', 'Consultation' from public.patients where mr_number = '33101';
create temp table s25_d1 as select id, updated_at from public.visits where patient_id = pg_temp.s25_pid('33101') and visit_date = pg_temp.s25_today();
insert into s25_cnt select 'd1', (select count(*) from public.patients), (select count(*) from public.visits), (select count(*) from public.checkups);
insert into s25_resp select 'd1', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2910), '{"mr":"33101","name":"Ayesha Rajpoot","phone":"03001233102","treatment":"RCT","status":{"t":"Completed","v":"completed"}}', true, null, pg_temp.s25_now_ms() + 60000))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'd1')) = 'needs_patient' and pg_temp.s25_res((select resp from s25_resp where n = 'd1'))->>'level' = 'error'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'd1')) = 'Needs attention: the name in this row does not match Mr# 33101 on the website. Check the Mr#, or type the name as the website has it.'
                     and (select resp->'tabs'->0->'results'->0 #>> '{}' not like '%Ayesha Khan%' and resp->'tabs'->0->'results'->0 #>> '{}' not like '%03001233101%' from s25_resp where n = 'd1'),
  'M1: "Ayesha Rajpoot" typed with the Mr# of Ayesha Khan is refused; the answer names nobody and carries neither her name nor her phone');
select pg_temp.check((select v.status = 'waiting' and v.treatment_label = 'Consultation' and v.sheet_key is null and v.completed_at is null
                             and v.protocol_override_by is null and v.dues_override_by is null and v.updated_at = d.updated_at
                        from public.visits v join s25_d1 d on d.id = v.id)
                     and pg_temp.s25_vis(pg_temp.s25_k(2910)) is null
                     and (select patients = (select count(*) from public.patients) and visits = (select count(*) from public.visits) from s25_cnt where n = 'd1')
                     and (select count(*) = 1 from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' = pg_temp.s25_k(2910) and new_data->>'outcome' = 'mr_name'),
  'M1: the real patient''s visit is untouched (not adopted, still Waiting / Consultation, not completed, no override); nothing is made; the refusal is audited like any other');
-- staff correct the Mr# to her own (the script sends the row under a new key): she gets her own visit, Ayesha Khan's stays as it was
insert into s25_resp select 'd1b', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('NN',
  jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(2911), '{"mr":"33102","name":"Ayesha Rajpoot","phone":"03001233102","treatment":"RCT","status":{"t":"Completed","v":"completed"}}', true, null, pg_temp.s25_now_ms() + 60000)),
  pg_temp.s25_bkeys(2::smallint) || pg_temp.s25_k(2911))), true));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'd1b')) = 'created'
                     and (select v.patient_id = pg_temp.s25_pid('33102') and v.status = 'completed' and v.treatment_label = 'RCT' from pg_temp.s25_vis(pg_temp.s25_k(2911)) v)
                     and (select v.status = 'waiting' and v.treatment_label = 'Consultation' and v.sheet_key is null from public.visits v join s25_d1 d on d.id = v.id)
                     and jsonb_array_length((select resp from s25_resp where n = 'd1b')->'tabs'->0->'removed') = 0,
  'M1: with the Mr# corrected the row goes through on the right patient; the real Ayesha Khan''s visit is still Waiting / Consultation and nothing is removed');
-- (M1, a registered checkup) a checkup registered today as Sana Khan; "Sana Qureshi" typed with her Mr# and another phone: refused, the
-- checkup keeps its name, phone and key (before, it was adopted with a plain tick and renamed to the other person)
insert into public.checkups (checkup_date, branch_id, patient_name, phone, checkup_for, source, day_status, patient_id)
  values (pg_temp.s25_today(), 2, 'Sana Khan', '03001230201', 'Checkup', 'website', 'waiting', pg_temp.s25_pid('33201'));
create temp table s25_d2 as select id, updated_at from public.checkups where patient_id = pg_temp.s25_pid('33201');
insert into s25_resp select 'd2', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2912), '{"mr":"33201","name":"Sana Qureshi","phone":"03117778888","treatment":"Scaling"}', true, null, pg_temp.s25_now_ms() + 60000))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'd2')) = 'needs_patient'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'd2')) = 'Needs attention: the name in this row does not match Mr# 33201 on the website. Check the Mr#, or type the name as the website has it.'
                     and (select c.patient_name = 'Sana Khan' and c.phone = '03001230201' and c.sheet_key is null and c.checkup_for = 'Checkup' and c.updated_at = d.updated_at
                            from public.checkups c join s25_d2 d on d.id = c.id)
                     and pg_temp.s25_chk(pg_temp.s25_k(2912)) is null and pg_temp.s25_vis(pg_temp.s25_k(2912)) is null,
  'M1: a registered checkup is not adopted by a row whose name fits only with doubt: name, phone and key unchanged, and the row is refused (no plain tick)');
-- the registered checkup's own row (from the website): its name changed to another surname is refused on every answer and nothing is saved
-- (not the name, not Completed); a name that fits her (the first name alone) is saved
insert into s25_resp select 'd2b', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(
  pg_temp.s25_row((select 'W-' || id from s25_d2), '{"name":"Sana Qureshi","legacy_name":"Sana Qureshi","status":{"t":"Completed","v":"completed"}}', false,
                  '{"name":"Sana Khan","status":"Waiting"}'::jsonb, pg_temp.s25_now_ms() + 60000))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'd2b')) = 'error'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'd2b')) = 'Needs attention: the name in this row does not match Mr# 33201 on the website. Check the Mr# or the name: nothing in this row is saved until they match.'
                     and (select c.patient_name = 'Sana Khan' and c.day_status = 'waiting' and c.phone = '03001230201' from public.checkups c join s25_d2 d on d.id = c.id),
  'a registered checkup''s row typed over with another surname: refused, the checkup keeps its name and is not completed');
insert into s25_resp select 'd2c', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(
  pg_temp.s25_row((select 'W-' || id from s25_d2), '{"name":"Sana","legacy_name":"Sana"}', false, '{"name":"Sana Khan"}'::jsonb, pg_temp.s25_now_ms() + 60000))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'd2c')) = 'updated'
                     and (select c.patient_name = 'Sana' from public.checkups c join s25_d2 d on d.id = c.id),
  'a name that fits her without doubt (her first name alone) is saved on the registered checkup as usual');
-- (M2, the phone) Ayesha Khan has no phone. The other Ayesha typed with her Mr# and her own phone: refused, Ayesha Khan's file gets no phone;
-- with the Mr# corrected, the right patient's empty phone is filled. A slip of the first name with another surname (Ahmad Hussain typed
-- with the Mr# of Ahmed Raza) fills nothing either
insert into s25_resp select 'd3', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2913), '{"mr":"33001","name":"Ayesha Rajpoot","phone":"0333-4440001","treatment":"Filling"}'),
  pg_temp.s25_row(pg_temp.s25_k(2914), '{"mr":"33301","name":"Ahmad Hussain","phone":"0344-5556666","treatment":"Scaling"}'))));
select pg_temp.check((select string_agg(pg_temp.s25_out(resp, g::int), ',' order by g) from s25_resp, generate_series(0, 1) g where n = 'd3') = 'needs_patient,needs_patient'
                     and (select phone is null from public.patients where mr_number = '33001') and (select phone is null from public.patients where mr_number = '33301')
                     and pg_temp.s25_vis(pg_temp.s25_k(2913)) is null and pg_temp.s25_vis(pg_temp.s25_k(2914)) is null,
  'M2: no phone is written into the file of the Mr#''s patient by a row whose name fits only with doubt (another surname, a slip with another surname)');
insert into s25_resp select 'd3b', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('NN',
  jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(2915), '{"mr":"33002","name":"Ayesha Rajpoot","phone":"0333-4440001","treatment":"Filling"}')),
  pg_temp.s25_bkeys(2::smallint) || pg_temp.s25_k(2915))), true));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'd3b')) = 'created'
                     and (select phone = '03334440001' from public.patients where mr_number = '33002') and (select phone is null from public.patients where mr_number = '33001')
                     and not exists (select 1 from public.audit_log where action = 'SHEET_REMOVED' and new_data->>'key' in (pg_temp.s25_k(2913), pg_temp.s25_k(2914))),
  'M2: the Mr# corrected, the right patient''s empty phone is filled; Ayesha Khan''s file still has none, and nothing needed undoing');
-- the refused row sent again every few minutes keeps its own answer and is one lookup; a later edit of it is still refused
insert into s25_resp select 'd3c', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2914), '{"mr":"33301","name":"Ahmad Hussain","phone":"0344-5556666","treatment":"Scaling","status":{"t":"Completed","v":"completed"}}'))));
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'd3c')) = pg_temp.s25_msg((select resp from s25_resp where n = 'd3'), 1)
                     and (select count(*) = 1 from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' = pg_temp.s25_k(2914))
                     and not exists (select 1 from public.visits v join public.patients p on p.id = v.patient_id where p.mr_number = '33301'),
  'a refused row sent again with a later edit (Completed) is refused again with the same answer, audited once, and makes nothing');

-- =====================================================================
-- 27. 11 Oct 2026, loop 2 of the fixes:
--     (abuse-privacy L2-residual) Muhammad, Syed, Hafiz, Baby ... are words of the name when both names have two words or more: "Muhammad
--     Usman" is not "Usman Tariq", and "Usman Tariq" is not a file named "Muhammad Usman". Before, the title was left out and the one word
--     left fitted every patient of that first name, with a plain tick.
--     (sheet-behaviour SB7-2) a row Set up stamped (no edit time) that says Completed completes the website's Waiting visit.
-- =====================================================================
select pg_temp.check((select bool_and(not private.aaj_name_fits(t, f)) from (values
    ('Muhammad Usman', 'Usman Tariq'), ('Hafiz Bilal', 'Bilal Ahmed'), ('Syed Ali', 'Ali Raza'), ('Syeda Fatima', 'Fatima Noor'), ('Baby Ayesha', 'Ayesha Khan'),
    ('Usman Tariq', 'Muhammad Usman'), ('M. Usman', 'Usman Tariq'), ('Usman Muhammad', 'Usman Tariq'), ('Haji Aslam', 'Aslam Pervaiz')) p(t, f)),
  'L2-residual: a Muhammad, Hafiz, Syed, Syeda, Haji or Baby with the first name of another patient (or a patient file named so) does not fit');
select pg_temp.check((select bool_and(private.aaj_name_fits(t, f)) from (values
    ('Usman', 'Usman Tariq'), ('M Usman', 'Muhammad Usman Tariq'), ('Usman Tariq', 'Muhammad Usman Tariq'), ('Md. Usman', 'Muhammad Usman'),
    ('Mohd Usman', 'Muhammad Usman'), ('Mohammed Usman', 'Muhammad Usman'), ('Mr Ali Raza', 'Ali Raza'), ('Sayed Ali Raza', 'Syed Ali Raza'),
    ('Syed Ali Raza', 'Ali Raza'), ('Muhammad Umer', 'Umer'), ('Usman', 'Muhammad Usman'), ('Dr. Sana Khan', 'Sana Khan')) p(t, f)),
  'L2-residual: the first name alone, a name inside the stored one, Mr and Dr, and every way of writing Muhammad or Syed still fit');
select pg_temp.check(private.aaj_name_fits('Ali Hassan Raza Khan Niazi', 'Ali Hassan Raza Khan Niazi') and private.aaj_name_fits('ali hassan raza khan  niazi.', 'Ali Hassan Raza Khan Niazi')
                     and not private.aaj_name_fits('Ali Hassan Raza Khan Niazi', 'Ali Hassan Raza Khan') and not private.aaj_name_fits('Qq Ayesha Bilal Fatima Sana', 'Ayesha Khan')
                     and not private.aaj_name_fits('بلال', 'بلال'),
  'a patient whose name has five words fits when it is typed as the website has it (only then: a stuffed name still fits nobody, an unreadable one neither)');
insert into public.patients (mr_number, full_name, phone, first_branch_id) values
  ('34001', 'Usman Tariq', null, 2), ('34002', 'Muhammad Usman', null, 2);
insert into s25_cnt select 'tw1', (select count(*) from public.patients), (select count(*) from public.visits), (select count(*) from public.checkups);
insert into s25_resp select 'tw1', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2950), '{"mr":"34001","name":"Muhammad Usman","legacy_name":"Muhammad Usman","phone":"03190003401","treatment":"RCT","status":{"t":"Completed","v":"completed"}}'),
  pg_temp.s25_row(pg_temp.s25_k(2951), '{"mr":"34002","name":"Usman Tariq","legacy_name":"Usman Tariq","treatment":"Scaling"}'))));
select pg_temp.check((select string_agg(pg_temp.s25_out(resp, g::int) || ':' || coalesce(pg_temp.s25_msg(resp, g::int), ''), '|' order by g) from s25_resp, generate_series(0, 1) g where n = 'tw1')
                       = 'needs_patient:Needs attention: the name in this row does not match Mr# 34001 on the website. Check the Mr#, or type the name as the website has it.'
                         || '|needs_patient:Needs attention: the name in this row does not match Mr# 34002 on the website. Check the Mr#, or type the name as the website has it.'
                     and pg_temp.s25_vis(pg_temp.s25_k(2950)) is null and pg_temp.s25_vis(pg_temp.s25_k(2951)) is null
                     and (select phone is null from public.patients where mr_number = '34001')
                     and (select patients = (select count(*) from public.patients) and visits = (select count(*) from public.visits) from s25_cnt where n = 'tw1'),
  'L2-residual: "Muhammad Usman" typed with the Mr# of Usman Tariq, and "Usman Tariq" with the Mr# of a file named "Muhammad Usman": refused, nothing made, no phone filled');
insert into s25_resp select 'tw2', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2952), '{"mr":"34001","name":"Usman Tariq","legacy_name":"Usman Tariq","treatment":"Scaling"}'))));
insert into s25_resp select 'tw3', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2952), '{"name":"Muhammad Usman","legacy_name":"Muhammad Usman","treatment":"RCT","status":{"t":"Completed","v":"completed"}}', false,
                  '{"name":"Usman Tariq","treatment":"Scaling","status":"Waiting"}'::jsonb, pg_temp.s25_now_ms() + 1000))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'tw2')) = 'created'
                     and pg_temp.s25_out((select resp from s25_resp where n = 'tw3')) = 'error'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'tw3')) = 'Needs attention: the name in this row does not match Mr# 34001 on the website. Check the Mr# or the name: nothing in this row is saved until they match.'
                     and (select v.status = 'waiting' and v.treatment_label = 'Scaling' and v.completed_at is null from pg_temp.s25_vis(pg_temp.s25_k(2952)) v),
  'L2-residual: Usman Tariq''s linked row typed over with "Muhammad Usman", RCT, Completed (the Mr# left as it was): refused, his visit stays Waiting / Scaling');
-- (SB7-2) install day: front desk added both patients as Waiting / Consultation; the sheet's rows (Set up stamped them, so no edit time)
-- say Completed. The status moves forward (owner decision 1); the website's text stays, and the sheet is told so.
select pg_temp.check(private.aaj_adopt_status('waiting', 'completed', null) = 'apply' and private.aaj_adopt_status('waiting', 'in_treatment', null) = 'apply'
                     and private.aaj_adopt_status('scheduled', 'waiting', null) = 'apply' and private.aaj_adopt_status('completed', 'waiting', null) = 'keep'
                     and private.aaj_adopt_status('cancelled', 'completed', null) = 'keep' and private.aaj_adopt_status('no_show', 'waiting', null) = 'keep'
                     and private.aaj_adopt_status('waiting', 'cancelled', null) = 'keep' and private.aaj_adopt_status('waiting', null, null) = 'keep'
                     and private.aaj_adopt_status('waiting', 'completed', false) = 'keep' and private.aaj_adopt_status('completed', 'completed', null) = 'same',
  'SB7-2: aaj_adopt_status for a row with no edit time: the status moves forward only; a Cancelled / No show stays and nothing is set Cancelled');
insert into public.patients (mr_number, full_name, phone, first_branch_id) values
  ('34011', 'Hamid Setup', '03190003411', 2), ('34012', 'Iqra Setup', '03190003412', 2);
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label)
  select id, 2, pg_temp.s25_today(), 'waiting', 'Consultation' from public.patients where mr_number in ('34011', '34012');
update public.visits set status = 'cancelled' where patient_id = pg_temp.s25_pid('34012') and visit_date = pg_temp.s25_today();
insert into s25_resp select 'sb72', pg_temp.s25_sync(pg_temp.s25_one('NN', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(2960), '{"mr":"34011","name":"Hamid Setup","legacy_name":"Hamid Setup","treatment":"RCT","status":{"t":"Completed","v":"completed"},"details":"done"}'),
  pg_temp.s25_row(pg_temp.s25_k(2961), '{"mr":"34012","name":"Iqra Setup","legacy_name":"Iqra Setup","treatment":"Scaling","status":{"t":"Completed","v":"completed"}}'))));
select pg_temp.check((select string_agg(pg_temp.s25_out(resp, g::int), ',' order by g) from s25_resp, generate_series(0, 1) g where n = 'sb72') = 'linked,linked'
                     and (select v.status = 'completed' and v.completed_at is not null and v.treatment_label = 'Consultation' and v.details_text = 'done'
                                 and (v.protocol_override_by is null or v.protocol_override_reason = 'Completed in the Google Sheet (owner rule, 9 Oct 2026)')
                            from pg_temp.s25_vis(pg_temp.s25_k(2960)) v)
                     and pg_temp.s25_res((select resp from s25_resp where n = 'sb72'), 0)->'kept_website' = '["treatment"]'::jsonb
                     and (select v.status = 'cancelled' from pg_temp.s25_vis(pg_temp.s25_k(2961)) v)
                     and pg_temp.s25_res((select resp from s25_resp where n = 'sb72'), 1)->'kept_website' @> '["status"]'::jsonb,
  'SB7-2: a Set up row (no edit time) that says Completed completes the website''s Waiting visit and keeps the website''s Treatment (said so); a Cancelled visit stays Cancelled');

-- (sheet-behaviour RS8-B1, 11 Oct 2026) a checkup or visit whose branch or day is changed on the website is never deleted by the sync. Its sheet
-- key goes with the change (private.aaj_release_sheet_claim): the new branch's tab gets it as an unclaimed website row, the old tab's row reads
-- "deleted" (an S- key) or "moved" (a W- key), and no removal pass takes it. Before, it kept its key, counted as "claimed" in the new tab where
-- no row had that key, and the new tab's removal pass deleted it as a row deleted in the sheet.
insert into public.patients (mr_number, full_name, phone, first_branch_id) values ('28050', 'Visit Mover', '03190003050', 1);
insert into public.checkups (checkup_date, branch_id, patient_name, phone, source) values (pg_temp.s25_today(), 1, 'Website Mover', '03190003012', 'website');
create temp table s25_b1w as select id, 'W-' || id::text as k from public.checkups where patient_name = 'Website Mover';
insert into s25_resp select 'b1a', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('GUL', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3010), '{"name":"Walkin Mover","phone":"03190003010","treatment":"Checkup"}'),
  pg_temp.s25_row(pg_temp.s25_k(3011), '{"mr":"28050","name":"Visit Mover","treatment":"Scaling"}')),
  pg_temp.s25_bkeys(1::smallint) || pg_temp.s25_k(3010) || pg_temp.s25_k(3011) || (select k from s25_b1w))), false));
select pg_temp.check((select string_agg(pg_temp.s25_out(resp, g::int), ',' order by g) from s25_resp, generate_series(0, 1) g where n = 'b1a') = 'created,created'
                     and (select branch_id = 1 from pg_temp.s25_chk(pg_temp.s25_k(3010))) and (select branch_id = 1 from pg_temp.s25_vis(pg_temp.s25_k(3011)))
                     and (select sheet_key = (select k from s25_b1w) from public.checkups where id = (select id from s25_b1w)),
  'RS8-B1 setup: a checkup and a visit made in the Gulshan tab, and a website checkup whose row is in that tab (claimed under its W- key)');
create temp table s25_b1ids as select (pg_temp.s25_chk(pg_temp.s25_k(3010))).id as ck, (pg_temp.s25_vis(pg_temp.s25_k(3011))).id as vid;
-- front desk corrects the Branch of both checkups on the Checkups page (signed in: the guards on the sheet key run first and see it unchanged)
grant select on s25_b1ids, s25_b1w to authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000025099', false);
set role authenticated;
update public.checkups set branch_id = 3 where id in ((select ck from s25_b1ids), (select id from s25_b1w));
reset role; select set_config('request.jwt.claim.sub', '', false);
-- and Dr. Ali moves the visit to DHA in the SQL editor
update public.visits set branch_id = 3 where id = (select vid from s25_b1ids);
select pg_temp.check((select count(*) = 2 and bool_and(branch_id = 3 and sheet_key is null) from public.checkups where id in ((select ck from s25_b1ids), (select id from s25_b1w)))
                     and (select branch_id = 3 and sheet_key is null from public.visits where id = (select vid from s25_b1ids)),
  'RS8-B1: a checkup front desk moves to another branch, and a visit moved there, let go of their sheet key (front desk is not refused for it)');
insert into s25_resp select 'b1b', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('DHA', '[]', pg_temp.s25_bkeys(3::smallint))), true));
select pg_temp.check(not exists (select 1 from public.audit_log where action = 'SHEET_REMOVED' and row_id in ((select ck::text from s25_b1ids), (select vid::text from s25_b1ids), (select id::text from s25_b1w)))
                     and (select count(*) = 2 from public.checkups where id in ((select ck from s25_b1ids), (select id from s25_b1w)))
                     and exists (select 1 from public.visits where id = (select vid from s25_b1ids)),
  'RS8-B1: the DHA tab''s removal pass (no row of theirs in that tab) deletes none of them');
select pg_temp.check((select count(*) = 3 and bool_and(x->>'key' = 'W-' || (x->>'id') and not (x->>'claimed')::boolean and not (x->>'removed')::boolean)
                        from jsonb_array_elements((select resp->'tabs'->0->'visits' from s25_resp where n = 'b1b')) x
                       where x->>'id' in ((select ck::text from s25_b1ids), (select vid::text from s25_b1ids), (select id::text from s25_b1w))),
  'RS8-B1: the DHA tab gets all three as unclaimed website rows, so the script adds them there ("Added from the website")');
insert into s25_resp select 'b1c', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('GUL', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3010), '{"details":"after the move"}', false, '{"details":""}'::jsonb, pg_temp.s25_now_ms() + 1000),
  pg_temp.s25_row(pg_temp.s25_k(3011), '{"details":"after the move"}', false, '{"details":""}'::jsonb, pg_temp.s25_now_ms() + 1000),
  pg_temp.s25_row((select k from s25_b1w), '{"details":"after the move"}', false, '{"details":""}'::jsonb, pg_temp.s25_now_ms() + 1000)),
  pg_temp.s25_bkeys(1::smallint) || pg_temp.s25_k(3010) || pg_temp.s25_k(3011) || (select k from s25_b1w))), true));
select pg_temp.check((select string_agg(pg_temp.s25_out(resp, g::int), ',' order by g) from s25_resp, generate_series(0, 2) g where n = 'b1c') = 'gone,gone,other_list'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'b1c'), 2) = 'This checkup was moved to another branch or day on the website. Delete this row.'
                     and (select count(*) = 0 from public.checkups where id in ((select ck from s25_b1ids), (select id from s25_b1w)) and coalesce(details, '') = 'after the move')
                     and (select coalesce(details_text, '') <> 'after the move' from public.visits where id = (select vid from s25_b1ids))
                     and not exists (select 1 from public.audit_log where action = 'SHEET_REMOVED' and row_id in ((select ck::text from s25_b1ids), (select vid::text from s25_b1ids), (select id::text from s25_b1w))),
  'RS8-B1: the old Gulshan rows are told "deleted on the website" (S- keys) or "moved to another branch or day" (the W- key), change nothing, and remove nothing');
insert into s25_resp select 'b1d', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('DHA', '[]',
  pg_temp.s25_bkeys(3::smallint) || ('W-' || (select ck::text from s25_b1ids)) || ('W-' || (select vid::text from s25_b1ids)) || (select k from s25_b1w))), true));
select pg_temp.check((select sheet_key = 'W-' || id::text from public.checkups where id = (select ck from s25_b1ids))
                     and (select sheet_key = 'W-' || id::text from public.visits where id = (select vid from s25_b1ids))
                     and (select sheet_key = (select k from s25_b1w) from public.checkups where id = (select id from s25_b1w))
                     and not exists (select 1 from public.audit_log where action = 'SHEET_REMOVED' and row_id in ((select ck::text from s25_b1ids), (select vid::text from s25_b1ids), (select id::text from s25_b1w))),
  'RS8-B1: once the DHA tab has their rows they are DHA''s (claimed under their W- keys), and still nothing was removed');
-- moved back: the W- checkup's old Gulshan row is its row again (the script links it again from the list); the sheet key goes once more
update public.checkups set branch_id = 1 where id = (select id from s25_b1w);
insert into s25_resp select 'b1e', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('GUL', '[]',
  pg_temp.s25_bkeys(1::smallint) || pg_temp.s25_k(3010) || pg_temp.s25_k(3011) || (select k from s25_b1w))), true));
select pg_temp.check((select branch_id = 1 and sheet_key = (select k from s25_b1w) from public.checkups where id = (select id from s25_b1w))
                     and exists (select 1 from jsonb_array_elements((select resp->'tabs'->0->'visits' from s25_resp where n = 'b1e')) x where x->>'key' = (select k from s25_b1w) and (x->>'claimed')::boolean),
  'RS8-B1: moved back to Gulshan, the W- checkup is claimed by its old row there again (the row is linked again), never removed');

-- (abuse-privacy minor, loop 8) a Ctrl+Z restore that failed (L3: its braces case had been deleted) does not stop Dr. Ali's undo once the cause is
-- fixed (only a restore that went through does): the sync itself does not try it again
insert into public.braces_cases (id, patient_id, start_date, status)
  select (a.old_data->>'braces_case_id')::uuid, (a.old_data->>'patient_id')::uuid, pg_temp.s25_today() - 150, 'debonded'
    from public.audit_log a where a.action = 'SHEET_REMOVED' and a.new_data->>'key' = pg_temp.s25_k(1750);
select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
create temp table s25_undo3 as select public.aaj_undo_removal((select a.id from public.audit_log a where a.action = 'SHEET_REMOVED' and a.new_data->>'key' = pg_temp.s25_k(1750))) r;
reset role; select set_config('request.jwt.claim.sub', '', false);
select pg_temp.check((select (r->>'ok')::boolean from s25_undo3)
                     and (select count(*) = 1 from public.visits v where v.id = (select (a.old_data->>'id')::uuid from public.audit_log a where a.action = 'SHEET_REMOVED' and a.new_data->>'key' = pg_temp.s25_k(1750))),
  'a removal whose Ctrl+Z restore failed can still be undone by Dr. Ali (aaj_undo_removal) once the cause is fixed');

-- (sheet-behaviour RW8-4, 11 Oct 2026) the nightly lines of the "Aj ki List checkups" tab imported with Admin -> Import -> 5. Checkup list: a
-- checkup the sync already put on the website (and front desk followed up) is skipped as already there, never a second record next to it;
-- a line that never reached the website is added as before
insert into s25_resp select 'rw84', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3020), '{"name":"Ck Synced Person","phone":"03111234567","treatment":"Checkup"}'))));
update public.checkups set follow_up = 'Interested', notes = 'call after Eid' where sheet_key = pg_temp.s25_k(3020);
create temp table s25_rw84 as select public.import_checkups(jsonb_build_array(
  jsonb_build_object('row', 2, 'name', 'Ck Synced Person', 'phone', '0311-1234567', 'branch', 'GUL', 'month', to_char(pg_temp.s25_today(), 'YYYY-MM-DD'),
                     'checkup_for', 'Checkup', 'follow_up', 'Not Contacted', 'source_tab', 'Aj ki List - Gulshan KHI'),
  jsonb_build_object('row', 3, 'name', 'Ck Never Synced', 'phone', '03111234568', 'branch', 'GUL', 'month', to_char(pg_temp.s25_today(), 'YYYY-MM-DD'),
                     'checkup_for', 'Checkup', 'follow_up', 'Not Contacted', 'source_tab', 'Aj ki List - Gulshan KHI'))) r;
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'rw84')) = 'created'
                     and (select (r->>'inserted')::int = 1 and (r->>'skipped_count')::int = 1
                                 and r->'skipped' = '[{"row": 2, "reason": "Already on the website (the Google Sheet sync put this checkup there)"}]'::jsonb from s25_rw84)
                     and (select count(*) = 1 and bool_and(source = 'google_sheet' and follow_up = 'Interested' and notes = 'call after Eid') from public.checkups where patient_name = 'Ck Synced Person')
                     and (select count(*) = 1 and bool_and(source = 'archive') from public.checkups where patient_name = 'Ck Never Synced'),
  'RW8-4: importing the nightly checkup lines skips a checkup the sync already put on the website (its follow-up and notes stay, no second record) and adds one that never reached it');
create temp table s25_rw84b as select public.import_checkups(jsonb_build_array(
  jsonb_build_object('row', 7, 'name', 'Ck Synced Person', 'phone', '03111234567', 'branch', 'GUL', 'month', to_char(pg_temp.s25_today(), 'YYYY-MM-DD'),
                     'checkup_for', 'Checkup', 'follow_up', 'Not Contacted', 'source_tab', 'Sample old list tab'))) r;
select pg_temp.check((select (r->>'inserted')::int = 1 from s25_rw84b)
                     and (select count(*) = 2 from public.checkups where patient_name = 'Ck Synced Person'),
  'RW8-4: a row of the owner''s old list (another Source Tab) is matched only with old-list rows, as before (20261009000260)');

-- =====================================================================
-- (sheet-behaviour RV-1, RV-2, RV-3, 11 Oct 2026) deletion and Ctrl+Z paths, in the Lahore tab (emptied first: its own list, its own count
-- of the day's removals)
-- =====================================================================
delete from public.invoices where visit_id in (select id from public.visits where branch_id = 4 and visit_date = pg_temp.s25_today());
delete from public.visits where branch_id = 4 and visit_date = pg_temp.s25_today();
delete from public.checkups where branch_id = 4 and checkup_date = pg_temp.s25_today();
delete from public.audit_log where action = 'SHEET_REMOVED' and new_data->>'branch' = 'LHR';
insert into public.patients (mr_number, full_name, phone, first_branch_id) values
  ('29101', 'Rv Alpha One', '03190091001', 4), ('29102', 'Rv Bravo Two', '03190091002', 4),
  ('29103', 'Rv Charlie Three', '03190091003', 4), ('29104', 'Rv Delta Four', '03190091004', 4);
insert into s25_resp select 'rv0', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3101), '{"mr":"29101","name":"Rv Alpha One","treatment":"Scaling"}'),
  pg_temp.s25_row(pg_temp.s25_k(3102), '{"mr":"29102","name":"Rv Bravo Two","treatment":"Scaling"}'),
  pg_temp.s25_row(pg_temp.s25_k(3103), '{"mr":"29103","name":"Rv Charlie Three","treatment":"Scaling"}'),
  pg_temp.s25_row(pg_temp.s25_k(3104), '{"mr":"29104","name":"Rv Delta Four","treatment":"Scaling"}'),
  pg_temp.s25_row(pg_temp.s25_k(3110), '{"name":"Ck Rv Done","phone":"03190091010","treatment":"Checkup","status":{"t":"Completed","v":"completed"},"doctors":{"t":"Dr Ali Rashid","v":["Dr Ali Rashid"]},"details":"needs braces, quoted 80k"}'),
  pg_temp.s25_row(pg_temp.s25_k(3111), '{"name":"Ck Rv Treat","phone":"03190091011","treatment":"Checkup","status":{"t":"Treatment","v":"in_treatment"}}'),
  pg_temp.s25_row(pg_temp.s25_k(3112), '{"name":"Ck Rv Wait","phone":"03190091012","treatment":"Checkup"}'),
  pg_temp.s25_row(pg_temp.s25_k(3113), '{"name":"Ck Rv Echo","phone":"03190091013","treatment":"Checkup"}'),
  pg_temp.s25_row(pg_temp.s25_k(3114), '{"name":"Ck Rv Nophone","treatment":"Checkup"}'))));
select pg_temp.check((select count(*) = 9 and bool_and(x->>'outcome' = 'created') from jsonb_array_elements((select resp->'tabs'->0->'results' from s25_resp where n = 'rv0')) x)
                     and (select c.day_status = 'completed' and c.doctors = 'Dr Ali Rashid' and c.details = 'needs braces, quoted 80k' from pg_temp.s25_chk(pg_temp.s25_k(3110)) c)
                     and (select c.day_status = 'in_treatment' from pg_temp.s25_chk(pg_temp.s25_k(3111)) c),
  'RV setup: the Lahore tab has 4 visits and 5 checkups made from the sheet (one checkup Completed with its doctor and details, one in Treatment)');

-- RV-2: deleting the row of a Completed or Treatment checkup never deletes the checkup (like a Completed visit); a Waiting one still goes
insert into s25_resp select 'rv2a', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', '[]', pg_temp.s25_bkeys(4::smallint, array[pg_temp.s25_k(3110)]))), true));
select pg_temp.check((select x->>'action' = 'restore' and x->>'message' = 'Not removed: this checkup is Completed on the website. To take a patient off, set Status to Cancelled.'
                        from (select pg_temp.s25_rm((select resp from s25_resp where n = 'rv2a'), pg_temp.s25_k(3110)) x) y)
                     and (select c.day_status = 'completed' and c.doctors = 'Dr Ali Rashid' and c.details = 'needs braces, quoted 80k' from pg_temp.s25_chk(pg_temp.s25_k(3110)) c)
                     and not exists (select 1 from public.audit_log where action = 'SHEET_REMOVED' and new_data->>'key' = pg_temp.s25_k(3110)),
  'RV-2: the deleted row of a Completed checkup keeps the checkup (doctor, details, the follow-up lead) and the row is put back with the reason');
insert into s25_resp select 'rv2b', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', '[]', pg_temp.s25_bkeys(4::smallint, array[pg_temp.s25_k(3111)]))), true));
select pg_temp.check((select x->>'action' = 'restore' and x->>'message' = 'Not removed: this checkup is Treatment on the website. To take a patient off, set Status to Cancelled.'
                        from (select pg_temp.s25_rm((select resp from s25_resp where n = 'rv2b'), pg_temp.s25_k(3111)) x) y)
                     and exists (select 1 from public.checkups where sheet_key = pg_temp.s25_k(3111) and day_status = 'in_treatment'),
  'RV-2: a checkup in Treatment is kept too');
insert into s25_resp select 'rv2c', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', '[]', pg_temp.s25_bkeys(4::smallint, array[pg_temp.s25_k(3112)]))), true));
select pg_temp.check((select x->>'action' = 'deleted' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'rv2c'), pg_temp.s25_k(3112)) x) y)
                     and not exists (select 1 from public.checkups where sheet_key = pg_temp.s25_k(3112)),
  'RV-2: a Waiting checkup with nothing on it is still removed with its row (owner rule: a wrong entry, or the person did not come)');

-- RV-1: a new row repeating a checkup whose row is on the sheet (a copy left by a Ctrl+Z after a held deletion, or the person typed twice)
-- is refused as a duplicate and names the other row's key; nothing is made. Once the other row is gone, the same row adopts the checkup.
insert into s25_resp select 'rv1a', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3120), '{"name":"Ck Rv Echo","phone":"0319-0091013","treatment":"Checkup"}'),
  pg_temp.s25_row(pg_temp.s25_k(3121), '{"name":"Ck Rv Nophone","treatment":"Checkup"}')),
  pg_temp.s25_bkeys(4::smallint) || pg_temp.s25_k(3120) || pg_temp.s25_k(3121))), false));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'rv1a'), 0) = 'duplicate'
                     and pg_temp.s25_res((select resp from s25_resp where n = 'rv1a'), 0)->>'duplicate_of' = pg_temp.s25_k(3113)
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'rv1a'), 0) like 'Already on this list in another row (the same checkup patient).%'
                     and (select count(*) from public.checkups where branch_id = 4 and patient_name = 'Ck Rv Echo') = 1
                     and not exists (select 1 from public.checkups where sheet_key = pg_temp.s25_k(3120)),
  'RV-1: a second row of a checkup patient whose row is on the sheet (the same name and phone, the phone written another way) is refused as a duplicate, no second checkup');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'rv1a'), 1) = 'created'
                     and (select count(*) from public.checkups where branch_id = 4 and patient_name = 'Ck Rv Nophone') = 2,
  'RV-1: two rows of one name with no phone are never guessed to be one person (two walk-ins can share a name; a pure copy is caught by the script)');
insert into s25_resp select 'rv1b', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3122), '{"name":"Ck Rv Echo","phone":"03190091099","treatment":"Checkup"}')),
  pg_temp.s25_bkeys(4::smallint) || pg_temp.s25_k(3122))), false));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'rv1b')) = 'created'
                     and (select count(*) from public.checkups where branch_id = 4 and patient_name = 'Ck Rv Echo') = 2,
  'RV-1: the same name on another phone is another person: a checkup of their own');
insert into s25_resp select 'rv1c', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3120), '{"name":"Ck Rv Echo","phone":"0319-0091013","treatment":"Checkup"}')),
  pg_temp.s25_bkeys(4::smallint, array[pg_temp.s25_k(3113)]) || pg_temp.s25_k(3120))), true));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'rv1c')) = 'linked'
                     and exists (select 1 from public.checkups where sheet_key = pg_temp.s25_k(3120) and patient_name = 'Ck Rv Echo' and phone = '03190091013')
                     and not exists (select 1 from public.audit_log where action = 'SHEET_REMOVED' and new_data->>'key' in (pg_temp.s25_k(3113), pg_temp.s25_k(3120)))
                     and (select count(*) from public.checkups where branch_id = 4 and patient_name = 'Ck Rv Echo') = 2,
  'RV-1: once the other row is deleted, the refused row takes over that checkup in the same call (nothing removed, nothing doubled)');

-- RV-3: a deleted row whose visit was kept and marked Cancelled (an invoice on it). The sync's own put-back (the key in the tab once again)
-- changes nothing; a Ctrl+Z (the key on two rows: "doubled") gives the visit its status and notes back, once
insert into public.invoices (visit_id, patient_id, branch_id) select id, patient_id, 4 from public.visits where sheet_key in (pg_temp.s25_k(3102), pg_temp.s25_k(3103));
update public.visits set notes = 'front desk note' where sheet_key = pg_temp.s25_k(3102);
insert into s25_resp select 'rv3a', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', '[]', pg_temp.s25_bkeys(4::smallint, array[pg_temp.s25_k(3102)]))), true));
select pg_temp.check((select x->>'action' = 'kept' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'rv3a'), pg_temp.s25_k(3102)) x) y)
                     and (select v.status = 'cancelled' and v.notes like 'front desk note · Row deleted in the Google Sheet (Gulberg Lhr) %: kept, marked Cancelled' from pg_temp.s25_vis(pg_temp.s25_k(3102)) v),
  'RV-3 setup: the deleted row of a visit with an invoice keeps the visit, marked Cancelled');
insert into s25_resp select 'rv3b', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', '[]', pg_temp.s25_bkeys(4::smallint))), true));
select pg_temp.check((pg_temp.s25_vis(pg_temp.s25_k(3102))).status = 'cancelled'
                     and not exists (select 1 from public.audit_log where action = 'SHEET_RESTORED' and new_data->>'key' = pg_temp.s25_k(3102)),
  'RV-3: the row the sync put back itself (its key in the tab once) does not undo the Cancelled');
insert into s25_resp select 'rv3c', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', '[]', pg_temp.s25_bkeys(4::smallint))
  || jsonb_build_object('doubled', jsonb_build_array(pg_temp.s25_k(3102)))), true));
select pg_temp.check((select v.status = 'waiting' and v.notes = 'front desk note' from pg_temp.s25_vis(pg_temp.s25_k(3102)) v)
                     and (select count(*) = 1 and bool_and(new_data->>'kind' = 'kept_cancelled' and new_data->>'by' = 'the sheet' and actor = '00000000-0000-0000-0000-0000000aa500')
                            from public.audit_log where action = 'SHEET_RESTORED' and new_data->>'key' = pg_temp.s25_k(3102))
                     and (select x->>'status' = 'Waiting' from jsonb_array_elements((select resp->'tabs'->0->'visits' from s25_resp where n = 'rv3c')) x where x->>'key' = pg_temp.s25_k(3102))
                     and (select count(*) from public.visits where sheet_key = pg_temp.s25_k(3102)) = 1,
  'RV-3: Ctrl+Z after the sync had put the row back (the key on two rows) gives the visit back its status (Waiting) and notes, audited, and the list says so');
update public.visits set status = 'in_treatment' where sheet_key = pg_temp.s25_k(3102);
insert into s25_resp select 'rv3d', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', '[]', pg_temp.s25_bkeys(4::smallint))
  || jsonb_build_object('doubled', jsonb_build_array(pg_temp.s25_k(3102)))), true));
select pg_temp.check((pg_temp.s25_vis(pg_temp.s25_k(3102))).status = 'in_treatment'
                     and (select count(*) from public.audit_log where action = 'SHEET_RESTORED' and new_data->>'key' = pg_temp.s25_k(3102)) = 1,
  'RV-3: it is done once: the key still doubled later changes nothing');
-- a visit changed on the website after it was kept (here: the removal moved a minute back in time) stays as front desk left it
insert into s25_resp select 'rv3e', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', '[]', pg_temp.s25_bkeys(4::smallint, array[pg_temp.s25_k(3103)]))), true));
update public.audit_log set at = at - interval '1 minute' where action = 'SHEET_REMOVED' and new_data->>'key' = pg_temp.s25_k(3103);
update public.visits set details_text = 'changed on the website' where sheet_key = pg_temp.s25_k(3103);
insert into s25_resp select 'rv3f', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', '[]', pg_temp.s25_bkeys(4::smallint))
  || jsonb_build_object('doubled', jsonb_build_array(pg_temp.s25_k(3103)))), true));
select pg_temp.check((select x->>'action' = 'kept' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'rv3e'), pg_temp.s25_k(3103)) x) y)
                     and (pg_temp.s25_vis(pg_temp.s25_k(3103))).status = 'cancelled'
                     and (select count(*) = 1 and bool_and((new_data->>'skipped')::boolean)
                            from public.audit_log where action = 'SHEET_RESTORED' and new_data->>'audit' = (select a.id::text from public.audit_log a where a.action = 'SHEET_REMOVED' and a.new_data->>'key' = pg_temp.s25_k(3103))),
  'RV-3: a kept visit that was changed on the website since is not touched by the Ctrl+Z (written down as skipped, not tried again)');
-- "doubled" counts only for a key of the tab's own rows (in present), and must be a list
insert into public.invoices (visit_id, patient_id, branch_id) select id, patient_id, 4 from public.visits where sheet_key = pg_temp.s25_k(3104);
insert into s25_resp select 'rv3g', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', '[]', pg_temp.s25_bkeys(4::smallint, array[pg_temp.s25_k(3104)]))), true));
insert into s25_resp select 'rv3h', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR', '[]', pg_temp.s25_bkeys(4::smallint, array[pg_temp.s25_k(3104)]))
  || jsonb_build_object('doubled', jsonb_build_array(pg_temp.s25_k(3104)))), false));
select pg_temp.check((select x->>'action' = 'kept' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'rv3g'), pg_temp.s25_k(3104)) x) y)
                     and (pg_temp.s25_vis(pg_temp.s25_k(3104))).status = 'cancelled'
                     and not exists (select 1 from public.audit_log where action = 'SHEET_RESTORED' and new_data->>'key' = pg_temp.s25_k(3104)),
  'RV-3: a "doubled" key that is not one of the tab''s rows (not in present) restores nothing');
select pg_temp.expect_error(format($$select pg_temp.s25_sync(%L::jsonb)$$, pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('LHR') || '{"doubled":"S-000000000c1e"}'::jsonb))),
  'BAD_PAYLOAD', 'RV-3: "doubled" must be a list of keys');

-- =====================================================================
-- (sheet-behaviour RV9-2, 11 Oct 2026) a record whose row the website itself let go ("rekey") goes when its key has left the sheet, whatever
-- its status: an Mr# of a patient the website has typed into a checkup row, a Month typed into a checkup row, the Mr# corrected on a row whose
-- patient file the sync made from it today. Before, a record in Treatment or Completed stayed and its row came back: a checkup stayed a lead
-- for the follow-up team, a file made from a slip stayed with a Completed visit. In the Islamabad tab (its own count of the day's removals;
-- every call lists the tab's other rows, so only the one row whose key left is a removal)
-- =====================================================================
delete from public.audit_log where action = 'SHEET_REMOVED' and new_data->>'branch' = 'ISB';
update private.aaj_sync_config set value = '1000' where key = 'new_patients_per_branch_day';      -- (the sections above used up Islamabad's 30)
insert into public.patients (mr_number, full_name, phone, first_branch_id) values
  ('29201', 'Lg Recall Sana', '03190092001', 5), ('29202', 'Lg Recall Tariq', '03190092002', 5), ('29204', 'Lg Brace Treat', '03190092004', 5);
insert into s25_resp select 'lg0', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3201), '{"name":"Lg Recall Sana","phone":"03190092001","treatment":"Checkup","status":{"t":"Completed","v":"completed"}}'),
  pg_temp.s25_row(pg_temp.s25_k(3202), '{"name":"Lg Recall Tariq","phone":"03190092002","treatment":"Checkup","status":{"t":"Treatment","v":"in_treatment"}}'),
  pg_temp.s25_row(pg_temp.s25_k(3203), '{"name":"Lg Brace Done","phone":"03190092003","treatment":"Checkup","status":{"t":"Completed","v":"completed"}}'),
  pg_temp.s25_row(pg_temp.s25_k(3204), '{"name":"Lg Brace Treat","phone":"03190092004","treatment":"Checkup","status":{"t":"Treatment","v":"in_treatment"}}'),
  pg_temp.s25_row(pg_temp.s25_k(3205), '{"mr":"19958","name":"Lg Kamran New","phone":"03190092005","treatment":"Consultation","status":{"t":"Completed","v":"completed"}}'),
  pg_temp.s25_row(pg_temp.s25_k(3206), '{"mr":"19968","name":"Lg Billed New","phone":"03190092006","treatment":"Consultation","status":{"t":"Completed","v":"completed"}}'),
  pg_temp.s25_row(pg_temp.s25_k(3207), '{"mr":"19978","name":"Lg Treated New","phone":"03190092007","treatment":"RCT","status":{"t":"Treatment","v":"in_treatment"}}'),
  pg_temp.s25_row(pg_temp.s25_k(3208), '{"name":"Lg Changed Later","phone":"03190092008","treatment":"Checkup","status":{"t":"Completed","v":"completed"}}'))));
select pg_temp.check((select count(*) = 8 and bool_and(x->>'outcome' = 'created') from jsonb_array_elements((select resp->'tabs'->0->'results' from s25_resp where n = 'lg0')) x)
                     and (pg_temp.s25_chk(pg_temp.s25_k(3201))).day_status = 'completed' and (pg_temp.s25_chk(pg_temp.s25_k(3202))).day_status = 'in_treatment'
                     and (pg_temp.s25_vis(pg_temp.s25_k(3205))).status = 'completed' and (pg_temp.s25_vis(pg_temp.s25_k(3207))).status = 'in_treatment'
                     and (select count(*) = 3 from public.patients where mr_number in ('19958', '19968', '19978') and legacy_source = 'aaj_sheet_sync'),
  'RV9-2 setup: the Islamabad tab has 5 checkups (Completed or Treatment) and 3 visits whose Healthwire Mr# made a new patient file (Completed or Treatment)');

-- an Mr# of a patient the website has (looked up in Healthwire) typed into a Completed checkup row: the row is let go, then sent as a new row
insert into s25_resp select 'lg1', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3201), '{"mr":"29201"}', false, '{"mr":""}', pg_temp.s25_now_ms() - 5000))));
insert into s25_resp select 'lg1b', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3211), '{"mr":"29201","name":"Lg Recall Sana","phone":"03190092001","treatment":"Checkup","status":{"t":"Completed","v":"completed"}}')),
  pg_temp.s25_bkeys(5::smallint, array[pg_temp.s25_k(3201)]) || pg_temp.s25_k(3211))), true));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'lg1')) = 'rekey'
                     and pg_temp.s25_out((select resp from s25_resp where n = 'lg1b')) = 'created'
                     and (select v.status = 'completed' and p.mr_number = '29201' from public.visits v join public.patients p on p.id = v.patient_id where v.sheet_key = pg_temp.s25_k(3211))
                     and not exists (select 1 from public.checkups where branch_id = 5 and patient_name = 'Lg Recall Sana')
                     and (select x->>'action' = 'deleted' and x->>'message' like 'An Mr# or a Month was typed in this row, so it was sent again as a visit: the checkup is removed from the website%'
                            from (select pg_temp.s25_rm((select resp from s25_resp where n = 'lg1b'), pg_temp.s25_k(3201)) x) y)
                     and (select (new_data->>'let_go')::boolean and old_data->>'day_status' = 'completed' from public.audit_log where action = 'SHEET_REMOVED' and new_data->>'key' = pg_temp.s25_k(3201)),
  'RV9-2: an Mr# typed into a Completed checkup row makes the patient''s visit, and the checkup goes (audited, undoable): no row comes back, no lead on the checkup list');
-- the same for a checkup in Treatment
insert into s25_resp select 'lg2', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3202), '{"mr":"29202"}', false, '{"mr":""}', pg_temp.s25_now_ms() - 5000))));
insert into s25_resp select 'lg2b', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3212), '{"mr":"29202","name":"Lg Recall Tariq","phone":"03190092002","treatment":"Checkup","status":{"t":"Treatment","v":"in_treatment"}}')),
  pg_temp.s25_bkeys(5::smallint, array[pg_temp.s25_k(3202)]) || pg_temp.s25_k(3212))), true));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'lg2')) = 'rekey' and pg_temp.s25_out((select resp from s25_resp where n = 'lg2b')) = 'created'
                     and not exists (select 1 from public.checkups where branch_id = 5 and patient_name = 'Lg Recall Tariq')
                     and (select x->>'action' = 'deleted' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'lg2b'), pg_temp.s25_k(3202)) x) y),
  'RV9-2: the same for a checkup in Treatment');

-- a Month typed into a Completed checkup row (no Mr#): the row needs the Mr# as a new row, and the checkup goes
insert into s25_resp select 'lg3', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3203), '{"month":{"t":"6","v":6},"treatment":"Wire change"}', false, '{"month":"","treatment":"Checkup"}'::jsonb, pg_temp.s25_now_ms() - 5000))));
insert into s25_resp select 'lg3b', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3213), '{"mr":"","name":"Lg Brace Done","phone":"03190092003","treatment":"Wire change","month":{"t":"6","v":6},"status":{"t":"Completed","v":"completed"}}')),
  pg_temp.s25_bkeys(5::smallint, array[pg_temp.s25_k(3203)]) || pg_temp.s25_k(3213))), true));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'lg3')) = 'rekey'
                     and (select r.checkup_for = 'Checkup' and r.day_status = 'completed' from public.audit_log a, jsonb_populate_record(null::public.checkups, a.old_data) r
                           where a.action = 'SHEET_REMOVED' and a.new_data->>'key' = pg_temp.s25_k(3203))
                     and pg_temp.s25_out((select resp from s25_resp where n = 'lg3b')) = 'needs_patient'
                     and not exists (select 1 from public.checkups where branch_id = 5 and patient_name = 'Lg Brace Done')
                     and (select x->>'action' = 'deleted' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'lg3b'), pg_temp.s25_k(3203)) x) y),
  'RV9-2: a Month typed into a Completed checkup row: nothing is applied to the checkup, the row asks for the Mr#, and the checkup goes (a braces patient is no checkup lead)');
-- a Month typed into a checkup row in Treatment, sent with the Mr#: the patient's visit with the month, and the checkup goes
insert into s25_resp select 'lg4', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3204), '{"mr":"29204","month":{"t":"6","v":6}}', false, '{"mr":"","month":""}'::jsonb, pg_temp.s25_now_ms() - 5000))));
insert into s25_resp select 'lg4b', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3214), '{"mr":"29204","name":"Lg Brace Treat","phone":"03190092004","treatment":"Wire change","month":{"t":"6","v":6}}')),
  pg_temp.s25_bkeys(5::smallint, array[pg_temp.s25_k(3204)]) || pg_temp.s25_k(3214))), true));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'lg4')) = 'rekey' and pg_temp.s25_out((select resp from s25_resp where n = 'lg4b')) = 'created'
                     and (pg_temp.s25_vis(pg_temp.s25_k(3214))).braces_month = 6
                     and not exists (select 1 from public.checkups where branch_id = 5 and patient_name = 'Lg Brace Treat')
                     and (select x->>'action' = 'deleted' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'lg4b'), pg_temp.s25_k(3204)) x) y),
  'RV9-2: a Month (and the Mr#) typed into a checkup row in Treatment: the patient''s visit with Month 6 is made and the checkup goes');

-- the Mr# corrected on a Completed row whose patient file the sync made from it (a slip): the right file gets the visit, the slip's file and
-- visit go
insert into s25_resp select 'lg5', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3205), '{"mr":"19953"}', false, '{"mr":"19958"}'::jsonb, pg_temp.s25_now_ms()))));
insert into s25_resp select 'lg5b', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3215), '{"mr":"19953","name":"Lg Kamran New","phone":"03190092005","treatment":"Consultation","status":{"t":"Completed","v":"completed"}}')),
  pg_temp.s25_bkeys(5::smallint, array[pg_temp.s25_k(3205)]) || pg_temp.s25_k(3215))), true));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'lg5')) = 'rekey'
                     and pg_temp.s25_out((select resp from s25_resp where n = 'lg5b')) = 'created' and pg_temp.s25_res((select resp from s25_resp where n = 'lg5b'))->>'patient_created' = '19953'
                     and (select v.status = 'completed' and p.mr_number = '19953' from public.visits v join public.patients p on p.id = v.patient_id where v.sheet_key = pg_temp.s25_k(3215))
                     and not exists (select 1 from public.patients where mr_number = '19958')
                     and not exists (select 1 from public.visits where sheet_key = pg_temp.s25_k(3205))
                     and (select x->>'action' = 'deleted' and x->>'message' = 'The Mr# in this row was corrected and the row was sent again: the visit under the old Mr# is removed from the website. So is the patient file made from this row (Mr# 19958). Dr. Ali can undo it.'
                            from (select pg_temp.s25_rm((select resp from s25_resp where n = 'lg5b'), pg_temp.s25_k(3205)) x) y),
  'RV9-2: the Mr# corrected on a Completed row whose file the sync made from a slip: one Completed visit, on the right file; the slip''s file and visit go and the log says so');
-- the same for a visit in Treatment
insert into s25_resp select 'lg6', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3207), '{"mr":"19976"}', false, '{"mr":"19978"}'::jsonb, pg_temp.s25_now_ms()))));
insert into s25_resp select 'lg6b', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3217), '{"mr":"19976","name":"Lg Treated New","phone":"03190092007","treatment":"RCT","status":{"t":"Treatment","v":"in_treatment"}}')),
  pg_temp.s25_bkeys(5::smallint, array[pg_temp.s25_k(3207)]) || pg_temp.s25_k(3217))), true));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'lg6')) = 'rekey' and pg_temp.s25_out((select resp from s25_resp where n = 'lg6b')) = 'created'
                     and not exists (select 1 from public.patients where mr_number = '19978') and exists (select 1 from public.patients where mr_number = '19976')
                     and (select x->>'action' = 'deleted' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'lg6b'), pg_temp.s25_k(3207)) x) y),
  'RV9-2: the same for a visit in Treatment');
-- with an invoice on the slip's visit the row is not let go: the Mr# is written back and the row says why (its records stay together)
insert into public.invoices (visit_id, patient_id, branch_id) select id, patient_id, 5 from public.visits where sheet_key = pg_temp.s25_k(3206);
insert into s25_resp select 'lg7', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3206), '{"mr":"19963"}', false, '{"mr":"19968"}'::jsonb, pg_temp.s25_now_ms()))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'lg7')) in ('updated', 'unchanged')
                     and pg_temp.s25_res((select resp from s25_resp where n = 'lg7'))->'kept_website' = '["mr"]'::jsonb
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'lg7')) = 'Mr# 19968 is put back: this visit has an attached record (invoices) on the website, so the row is not moved to Mr# 19963. If 19963 is the right Mr#, correct the patient file on the website.'
                     and not exists (select 1 from public.audit_log where action = 'SHEET_LETGO' and new_data->>'key' = pg_temp.s25_k(3206))
                     and (select p.mr_number = '19968' from public.visits v join public.patients p on p.id = v.patient_id where v.sheet_key = pg_temp.s25_k(3206)),
  'RV9-2: the slip corrected on a visit with an invoice: not let go (no second visit), the Mr# is written back and the row says to correct the file on the website');

-- a let-go checkup changed on the website after the website let its row go (here: the let-go moved a minute back) keeps the ordinary rules
insert into s25_resp select 'lg8', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(3208), '{"month":{"t":"3","v":3}}', false, '{"month":""}'::jsonb, pg_temp.s25_now_ms() - 5000))));
update public.audit_log set at = at - interval '1 minute' where action = 'SHEET_LETGO' and new_data->>'key' = pg_temp.s25_k(3208);
insert into s25_resp select 'lg8b', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('ISB', '[]', pg_temp.s25_bkeys(5::smallint, array[pg_temp.s25_k(3208)]))), true));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'lg8')) = 'rekey'
                     and (select x->>'action' = 'restore' and x->>'message' = 'Not removed: this checkup is Completed on the website. To take a patient off, set Status to Cancelled.'
                            from (select pg_temp.s25_rm((select resp from s25_resp where n = 'lg8b'), pg_temp.s25_k(3208)) x) y)
                     and exists (select 1 from public.checkups where sheet_key = pg_temp.s25_k(3208)),
  'RV9-2: a let-go record changed on the website since is kept like any Completed record (what front desk did since stands)');
select pg_temp.check(not exists (select 1 from public.audit_log where action = 'SHEET_LETGO' and new_data->>'key' in (pg_temp.s25_k(3211), pg_temp.s25_k(3215))),
  'RV9-2: only the record the website let go is written down, never the row''s new visit');

-- the removal of a let-go visit is undone like any other: its file made from the slip comes back with it
insert into s25_resp select 'lg9', public.aaj_undo_removal((select id from public.audit_log where action = 'SHEET_REMOVED' and new_data->>'key' = pg_temp.s25_k(3205)));
select pg_temp.check((select resp->>'ok' = 'true' from s25_resp where n = 'lg9')
                     and exists (select 1 from public.visits v join public.patients p on p.id = v.patient_id where p.mr_number = '19958' and v.status = 'completed' and v.sheet_key is null),
  'RV9-2: Dr. Ali''s undo puts the visit and the file made from the slip back (as a website row)');
update private.aaj_sync_config set value = '30' where key = 'new_patients_per_branch_day';

-- =====================================================================
-- (sheet-behaviour RS12-1, 11 Oct 2026) a busy day. The owner: "sometimes on a busy day, we have like 120 patients". 130 rows typed in one
-- tab all become visits (the old cap of 120 refused the last 10), and 40 of them deleted one at a time (no-shows, wrong entries) are all
-- removed: the day's removals may reach 35 in 100 of the rows the sheet has had today (the old 15 put the 16th row back, again and again).
-- In the DHA tab (emptied first: its own list and its own count of the day's removals)
-- =====================================================================
delete from public.invoices where visit_id in (select id from public.visits where branch_id = 3 and visit_date = pg_temp.s25_today());
delete from public.visits where branch_id = 3 and visit_date = pg_temp.s25_today();
delete from public.checkups where branch_id = 3 and checkup_date = pg_temp.s25_today();
delete from public.audit_log where action = 'SHEET_REMOVED' and new_data->>'branch' = 'DHA';
insert into public.patients (mr_number, full_name, phone, first_branch_id)
  select (31000 + g)::text, 'Busy Day ' || g, '0316' || lpad(g::text, 7, '0'), 3 from generate_series(1, 130) g;
create temp table s25_busy as select g, pg_temp.s25_k(4000 + g) as k from generate_series(1, 130) g;
create temp table s25_busy_gone (g int primary key);
-- the tab as the sheet sends it: every row still on it
create or replace function pg_temp.s25_busy_present() returns text[] language sql as $$
  select array(select k from s25_busy b where not exists (select 1 from s25_busy_gone x where x.g = b.g) order by g) $$;
grant execute on all functions in schema pg_temp to authenticated, anon;
do $$
declare b int;
begin
  for b in 0..5 loop       -- 25 rows a call, as the script sends them
    insert into s25_resp select 'busy' || b, pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('DHA',
      (select jsonb_agg(pg_temp.s25_row(k, jsonb_build_object('mr', (31000 + g)::text, 'name', 'Busy Day ' || g, 'status', jsonb_build_object('t', 'Scheduled', 'v', 'scheduled'))) order by g)
         from s25_busy where g > b * 25 and g <= b * 25 + 25),
      pg_temp.s25_busy_present())), false));
  end loop;
end $$;
select pg_temp.check((select count(*) from s25_resp, jsonb_array_elements(resp->'tabs'->0->'results') x where n like 'busy_' and x->>'outcome' = 'created') = 130
                     and (select count(*) from public.visits where branch_id = 3 and visit_date = pg_temp.s25_today()) = 130,
  'RS12-1: 130 rows typed in one tab on a busy day are all made (the cap is 250 visits a branch and day; before, rows 121 to 130 were refused)');
-- 46 rows deleted, one a minute: every one is removed (35 in 100 of the day's 130 rows is 46)
do $$
declare d int;
begin
  for d in 1..46 loop
    insert into s25_busy_gone values (d * 2);
    insert into s25_resp select 'busyrm' || d, pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('DHA', '[]', pg_temp.s25_busy_present())), true));
  end loop;
end $$;
select pg_temp.check((select count(*) from s25_resp, jsonb_array_elements(resp->'tabs'->0->'removed') x where n like 'busyrm%' and x->>'action' = 'deleted') = 46
                     and not exists (select 1 from s25_resp, jsonb_array_elements(resp->'tabs'->0->'removed') x where n like 'busyrm%' and x->>'action' <> 'deleted')
                     and (select count(*) from public.visits where branch_id = 3 and visit_date = pg_temp.s25_today()) = 84
                     and (select count(*) from public.audit_log where action = 'SHEET_REMOVED' and new_data->>'branch' = 'DHA' and new_data->>'action' = 'deleted') = 46,
  'RS12-1: on that busy day 46 rows deleted one at a time are all removed from the website and audited (before: from the 16th on every deleted row came back)');
-- the 47th is more than 35 in 100 of the day: held, its row comes back with the reason
insert into s25_busy_gone values (95);
insert into s25_resp select 'busyrm47', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('DHA', '[]', pg_temp.s25_busy_present())), true));
select pg_temp.check((select x->>'action' = 'restore' and x->>'message' like 'Needs attention: too many rows were deleted from this tab today%'
                        from (select pg_temp.s25_rm((select resp from s25_resp where n = 'busyrm47'), (select k from s25_busy where g = 95)) x) y)
                     and exists (select 1 from public.visits where sheet_key = (select k from s25_busy where g = 95)),
  'RS12-1: the 47th deletion of that day (more than 35 in 100 of its 130 rows) is held and its row put back, as before at the 16th of a small day');

update private.aaj_sync_config set value = '20' where key = 'calls_per_minute';
select setval('public.mr_number_seq', last_value, is_called) from s25_seq;
rollback;
