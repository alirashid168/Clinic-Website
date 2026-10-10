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
select pg_temp.check((select value = '120' from private.aaj_sync_config where key = 'visits_per_branch_day'), 'the sync may make at most 120 visits for one branch and day by default');
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

-- the website numbers its own patients from 10000 (50000 after the renumbering): move the sequence out of the way; put it back at the end
create temp table s25_seq as select last_value, is_called from public.mr_number_seq;
select setval('public.mr_number_seq', greatest(10100, (select last_value from public.mr_number_seq)), false);
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
                     and not has_function_privilege('anon', 'private.aaj_check_mr(smallint, date, text, text, text)', 'execute'),
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
  pg_temp.s25_row(pg_temp.s25_k(902), '{"mr":"9876","name":"Rollback Person","token":{"t":"abc","v":"abc"}}'),
  pg_temp.s25_row(pg_temp.s25_k(903), '{"mr":"25004","name":"Sana Ahmed","treatment":"Scaling"}')), array[pg_temp.s25_k(901), pg_temp.s25_k(903)]));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'iso'), 0) = 'error' and pg_temp.s25_msg((select resp from s25_resp where n = 'iso'), 0) = 'Bad row key.', 'a bad row key is that row''s error');
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'iso'), 1) = 'Too long: details (max 500 letters).', 'a too long field is that row''s error, in plain words');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'iso'), 3) = 'error' and pg_temp.s25_msg((select resp from s25_resp where n = 'iso'), 3) like 'Not saved: %', 'a row that raises an error is reported as not saved');
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'iso'), 3) = 'Not saved: a value is too long or not allowed.'
                     and (select last_detail like '%invalid input syntax%' from private.aaj_sync_state where branch_id = 1),
  'the database''s own error text goes to the owner''s diagnostics (aaj_sync_state.last_detail), not to the sheet');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'iso'), 2) = 'created' and pg_temp.s25_out((select resp from s25_resp where n = 'iso'), 4) = 'created'
                     and (select resp->>'ok' from s25_resp where n = 'iso') = 'true', 'one bad row never blocks the rows around it');
select pg_temp.check((select count(*) from public.patients where full_name = 'Rollback Person') = 0, 'the failed row''s new patient was rolled back with it');
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
insert into s25_resp select 'hw49', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(27), '{"mr":"49999","name":"Edge Below"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'hw49')) = 'created' and exists (select 1 from public.patients where mr_number = '49999'), 'Mr# 49999 is still a Healthwire number');

-- 50000 and above that nobody has: a typo, never a new patient (the website numbers its own patients from 50000)
insert into s25_cnt select 'typo', (select count(*) from public.patients), (select count(*) from public.visits), (select count(*) from public.checkups);
insert into s25_resp select 'typo', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(21), '{"mr":"50000","name":"Typo Person"}'),
  pg_temp.s25_row(pg_temp.s25_k(28), '{"mr":"123456","name":"Typo Too"}'),
  pg_temp.s25_row(pg_temp.s25_k(29), '{"mr":"0985","name":"Leading Zero"}'),
  pg_temp.s25_row(pg_temp.s25_k(31), '{"mr":"AB-12","name":"Letters Mr"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'typo'), 0) = 'needs_patient' and pg_temp.s25_msg((select resp from s25_resp where n = 'typo'), 0) = 'Mr# 50000 is not on the website. Check the number.'
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
  pg_temp.s25_row(pg_temp.s25_k(25), '{"mr":"25001","name":"Ayesh Khan"}'),
  pg_temp.s25_row(pg_temp.s25_k(26), '{"mr":"25003","name":"Ahmed Raza","phone":"0300-2223331"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'mx'), 0) = 'needs_patient' and pg_temp.s25_msg((select resp from s25_resp where n = 'mx'), 0) like '%Sana Ahmed with this phone is Mr# 25004. Use 25004.',
  'an absent Mr# whose name and phone belong to Mr# 25004 (a patient of this branch) asks to use 25004; no new patient');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'mx'), 1) = 'needs_patient' and pg_temp.s25_msg((select resp from s25_resp where n = 'mx'), 1) like 'Mr# 25004 is "Sana Ahmed" on the website, not "Ayesha"%',
  'a Mr# that exists but belongs to a different name is not linked (a new person typed with another patient''s Mr#)');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'mx'), 2) = 'needs_patient', 'the same Mr# typed for a second, different person is refused too');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'mx'), 3) = 'linked' and pg_temp.s25_res((select resp from s25_resp where n = 'mx'), 3)->>'level' = 'warn'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'mx'), 3) = 'Mr# 25001 is "Ayesha Khan" on the website. Check the Mr#.',
  'a spelling slip in the name (Ayesh / Ayesha) is linked but warned');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'mx'), 4) = 'linked' and (pg_temp.s25_vis(pg_temp.s25_k(26))).patient_id = :pu,
  'a name that does not fit the Mr# is still linked when the phone number is that patient''s own (nobody else on that phone has the typed first name)');
select pg_temp.check((select count(*) from public.visits v where v.sheet_key in (pg_temp.s25_k(22), pg_temp.s25_k(23), pg_temp.s25_k(24))) = 0, 'refused rows left no visits behind');

-- a daughter typed with her mother's Mr# on the family phone is NOT linked to the mother (the phone waiver stops for families)
insert into s25_resp select 'fam1', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(33), '{"mr":"25001","name":"Sadia Khan","phone":"03001112221"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'fam1')) = 'needs_patient' and pg_temp.s25_msg((select resp from s25_resp where n = 'fam1')) like 'Mr# 25001 is "Ayesha Khan" on the website, not "Sadia Khan"%'
                     and (select count(*) from public.visits v where v.sheet_key = pg_temp.s25_k(33)) = 0,
  'the daughter''s name with the mother''s Mr# on their shared phone is refused, not linked to the mother');
insert into s25_resp select 'fam2', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(34), '{"mr":"25002","name":"Sadia Khan","phone":"03001112221"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'fam2')) = 'created' and (pg_temp.s25_vis(pg_temp.s25_k(34))).patient_id = :pb, 'and with her own Mr# she is found');

-- the secret is not a search: another patient's name is not given away, a refused lookup is audited once a day and capped
insert into s25_resp select 'orc', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(35), '{"mr":"25003","name":"Zzz Unknown"}'),
  pg_temp.s25_row(pg_temp.s25_k(36), '{"mr":"25999","name":"Sana Ahmed","phone":"03003334441"}'))));
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'orc'), 0) = 'Mr# 25003 belongs to another patient. Check the Mr#.' and pg_temp.s25_msg((select resp from s25_resp where n = 'orc'), 0) not like '%Umer%',
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
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'orc3'), 0) = 'Too many rows the website could not place today. Fix them on the website.'
                     and (select count(*) from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' = pg_temp.s25_k(37)) = 0,
  'after 200 refused lookups in a day a new one is refused without looking, and not audited again');
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'orc3'), 1) = 'Mr# 25003 belongs to another patient. Check the Mr#.', 'a row already audited today still gets its own message');
delete from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' like 'S-ffffffff%';

-- =====================================================================
-- 6. A row with no Mr# is a CHECKUP patient: public.checkups, never a patient file, never an Mr#
-- =====================================================================
insert into s25_cnt select 'chk0', (select count(*) from public.patients), (select count(*) from public.visits), (select count(*) from public.checkups);
insert into s25_resp select 'ck1', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(30), jsonb_build_object('name', 'Ayesha', 'phone', '03001112221', 'treatment', 'Checkup',
     'token', jsonb_build_object('t', 'Kit 80k', 'v', null), 'status', jsonb_build_object('t', 'Waiting', 'v', 'waiting'),
     'doctors', jsonb_build_object('t', 'Dr Haniya, Dr Unknown Person', 'v', jsonb_build_array('Dr Haniya', 'Dr Unknown Person')),
     'details', 'scaling advised', 'month', jsonb_build_object('t', '5', 'v', 5), 'pp', '2000')),
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
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ck7'), 1) = 'error' and pg_temp.s25_msg((select resp from s25_resp where n = 'ck7'), 1) = 'The Mr# in this row is not this checkup''s. Clear the row and type the patient again.',
  'any other Mr# typed on a checkup row is refused: a checkup is never moved to a patient by the sync');

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
                     and pg_temp.s25_res((select resp from s25_resp where n = 'r1'), 1)->>'level' = 'warn'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'r1'), 1) = 'Completed from the sheet. The website''s photo step was skipped (owner rule).',
  'a Completed row on a photo month completes the visit; the override says "Completed in the Google Sheet (owner rule, 9 Oct 2026)" and the row says so');
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
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'r1c')) = 'Completed from the sheet. The website''s check step was skipped (owner rule).',
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
                     and pg_temp.s25_out((select resp from s25_resp where n = 'r2')) = 'updated' and pg_temp.s25_msg((select resp from s25_resp where n = 'r2')) = 'Completed from the sheet. The website''s check step was skipped (owner rule).',
  'a Waiting visit marked Completed in the sheet: the checker rule is skipped, recorded as the owner rule');
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
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'r2g')) like 'Dr. Samrah Khan is outside this month''s doctor group. Saved because the visit is Completed in the sheet (owner rule).',
  'a doctor outside the month''s group on a Completed row is added, recorded as the owner rule');

-- dues hold (block mode): a Completed row completes, and the dues are not held; a Treatment row is held back by the website's rule
insert into public.invoices (patient_id, branch_id) values (:pq, 3);
insert into public.invoice_items (invoice_id, description, unit_price) select id, 'Bonding', 5000 from public.invoices where patient_id = :pq;
update public.app_settings set value = '"block"' where key = 'dues_hold_mode';
insert into s25_resp select 'r3', pg_temp.s25_sync(pg_temp.s25_one('DHA', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(63),
  '{"mr":"25013","name":"Qasim Ali","status":{"t":"Completed","v":"completed"}}'))));
select pg_temp.check((select v.status = 'completed' and v.dues_override_by = pg_temp.s25_admin() and v.dues_override_reason = 'Completed in the Google Sheet (owner rule, 9 Oct 2026)' from pg_temp.s25_vis(pg_temp.s25_k(63)) v)
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'r3')) = 'Completed from the sheet. Pending dues Rs 5,000 were not held (owner rule).',
  'dues hold: a Completed row completes (not every patient owes money); the dues override is recorded as the owner rule');
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
                             and (c ? 'doctors') and (c ? 'details') and (c ? 'pp') and (c ? 'removed') and (c ? 'updated_at') and (select count(*) from jsonb_object_keys(c)) = 16
                        from (select private.aaj_canon((pg_temp.s25_vis(pg_temp.s25_k(90))).id) c) x),
  'canon of a visit has exactly the sixteen fields of the contract (nothing more about the patient than the sheet already shows)');

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

-- no more than 15 removals a day for a branch: after that rows are put back
insert into public.audit_log (table_name, row_id, action, new_data, actor)
  select 'visits', null, 'SHEET_REMOVED', jsonb_build_object('branch', 'NN', 'action', 'deleted', 'key', 'S-fffffffff' || lpad(to_hex(g), 3, '0')), '00000000-0000-0000-0000-0000000aa500' from generate_series(1, 10) g;
insert into s25_resp select 'rm10', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('NN', '[]', pg_temp.s25_nn_keys(array[pg_temp.s25_k(104)]))), true));
select pg_temp.check((select x->>'action' = 'restore' and x->>'message' like 'Needs attention: too many rows were deleted from this tab today%' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'rm10'), pg_temp.s25_k(104)) x) y)
                     and exists (select 1 from public.visits where sheet_key = pg_temp.s25_k(104) and status <> 'cancelled'), 'after 15 removals in a day for a branch the next one is held, not applied');
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
select pg_temp.check((select x->>'action' = 'restore' and x->>'message' like 'Not removed: this visit is No show on the website.%' from (select pg_temp.s25_rm((select resp from s25_resp where n = 'bt3'), pg_temp.s25_k(1106)) x) y)
                     and (pg_temp.s25_vis(pg_temp.s25_k(1106))).status = 'no_show', 'a No show visit is not deleted either: the row is put back with the way to take it off the list');
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
insert into s25_resp select 'ph', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(110), '{"mr":"25005","name":"Hina Baig","phone":"0300 999 8887"}'),
  pg_temp.s25_row(pg_temp.s25_k(111), '{"mr":"25004","name":"Sana Ahmed","phone":"03999999999"}'))));
select pg_temp.check((select phone from public.patients where id = :ph) = '03009998887', 'a patient with no phone gets the typed one (clean form)');
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
insert into public.patients (mr_number, full_name, first_branch_id, legacy_source)
  select 'cap-' || g, 'Capped Person ' || g, 5, 'aaj_sheet_sync' from generate_series(1, 60) g;
insert into s25_resp select 'cap', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(120), '{"mr":"9900","name":"One Too Many","phone":"03555555555"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'cap')) = 'needs_patient' and pg_temp.s25_msg((select resp from s25_resp where n = 'cap')) = 'Too many new patients from the sheet today. Add this one on the website.'
                     and (select count(*) from public.patients where full_name = 'One Too Many') = 0, 'after 60 sync-created patients for a branch today the next creation is refused');
insert into s25_resp select 'cap2', pg_temp.s25_sync(pg_temp.s25_one('GUL', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(121), '{"mr":"9901","name":"Other Branch Fine","phone":"03555555556"}'))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'cap2')) = 'created', 'the cap is per branch');

-- =====================================================================
-- 17. import_aaj_sheet shares the patient rule
-- =====================================================================
select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
create temp table s25_imp as select public.import_aaj_sheet(jsonb_build_array(
  jsonb_build_array((pg_temp.s25_today() - 30)::text, 3, null, 'Zainab Khan', null, '03001112221', null, 'Checkup', 1, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'DHA KHI', false, null),
  jsonb_build_array((pg_temp.s25_today() - 30)::text, 3, null, 'Ayesha', null, '03001112221', null, 'Checkup', 2, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'DHA KHI', false, null),
  jsonb_build_array((pg_temp.s25_today() - 30)::text, 3, null, 'Dina Rao', null, '03004445551', null, 'Checkup', 3, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'DHA KHI', false, null)), true) r;
reset role; select set_config('request.jwt.claim.sub', '', false);
select pg_temp.check((select (r->>'patients_created')::int = 1 and (r->>'rows_unmatched')::int = 1 and (r->'unmatched'->0->>'name') = 'Dina Rao' from s25_imp), 'history import: a third name on a shared phone is a new patient, two same-name patients on one phone are left unmatched');
select pg_temp.check((select count(*) = 1 from public.patients where full_name = 'Zainab Khan' and phone = '03001112221')
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

-- the Mr# and the name on a row that is already linked: the patient is never changed
insert into s25_resp select 'm1', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(201), '{"mr":"26003","name":"Mira Link","treatment":"Checkup"}'))));
insert into s25_resp select 'm2', pg_temp.s25_sync(pg_temp.s25_one('ISB', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(201), '{"mr":""}', false),
  pg_temp.s25_row(pg_temp.s25_k(201), '{"mr":"25001"}', false),
  pg_temp.s25_row(pg_temp.s25_k(201), '{"mr":"26003"}', false),
  pg_temp.s25_row(pg_temp.s25_k(201), '{"name":"Zeeshan"}', false),
  pg_temp.s25_row(pg_temp.s25_k(201), '{"mr":"NEW"}', false)), array[pg_temp.s25_k(201)]));
select pg_temp.check(pg_temp.s25_res((select resp from s25_resp where n = 'm2'), 0)->'kept_website' = '["mr"]'::jsonb, 'an emptied Mr# cell: the sheet is told to write the Mr# back');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'm2'), 1) = 'error' and pg_temp.s25_msg((select resp from s25_resp where n = 'm2'), 1) = 'The Mr# in this row is not this visit''s patient. Clear the row and type the patient again.',
  'another patient''s Mr# on a linked row is an error: a visit never moves to another patient');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'm2'), 2) = 'unchanged', 'the same Mr# again: nothing to do');
select pg_temp.check(pg_temp.s25_res((select resp from s25_resp where n = 'm2'), 3)->>'level' = 'warn' and pg_temp.s25_msg((select resp from s25_resp where n = 'm2'), 3) = 'Mr# 26003 is "Mira Link" on the website. Check the Mr#.'
                     and (select full_name from public.patients where mr_number = '26003') = 'Mira Link', 'a different name on a linked row only warns, the patient''s name is not touched');
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
select pg_temp.check((select string_agg(distinct a.action, ',' order by a.action) from public.audit_log a where a.actor = '00000000-0000-0000-0000-0000000aa500') = 'SHEET_LOOKUP,SHEET_REMOVED,SHEET_RESTORED,SHEET_SYNC',
  'the sync''s own audit rows are SHEET_SYNC, SHEET_REMOVED, SHEET_RESTORED and SHEET_LOOKUP');
select pg_temp.check((select count(*) = 0 from public.audit_log where actor = '00000000-0000-0000-0000-0000000aa500' and action not in ('SHEET_SYNC', 'SHEET_REMOVED', 'SHEET_RESTORED', 'SHEET_LOOKUP')), 'the sync writes no other kind of audit row under its own name');
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
select pg_temp.check(pg_temp.s25_msg((select resp from s25_resp where n = 'nn1'), 0) = 'Mr# 25003: the name in this row cannot be read. Type the patient''s name in English letters, or the phone number that is theirs.'
                     and pg_temp.s25_msg((select resp from s25_resp where n = 'nn1'), 3) = 'Mr# 26051 belongs to another patient. Check the Mr#.'
                     and (select bool_and(m not like '%Umer%' and m not like '%0300%' and m not like '%بلال%') from (select pg_temp.s25_msg(resp, g::int) m from s25_resp, generate_series(0, 3) g where n = 'nn1') x),
  'the refusal says what to do and gives away nothing about the patient (no name, no phone)');
select pg_temp.check((select patients = (select count(*) from public.patients) and visits = (select count(*) from public.visits) and checkups = (select count(*) from public.checkups) from s25_cnt where n = 'nn0')
                     and (select phone = '03002223331' and full_name = 'Muhammad Umer' from public.patients where mr_number = '25003'),
  'no visit, no patient, no checkup and no change to the patient file came out of them');
select pg_temp.check(not exists (select 1 from jsonb_array_elements((select resp->'tabs'->0->'visits' from s25_resp where n = 'nn1')) x where x->>'mr' in ('25003', '26051')),
  'and the answer''s list carries no data about those patients (their names, phones and dues stay out of it)');
select pg_temp.check((select count(*) = 4 from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'key' in (pg_temp.s25_k(1410), pg_temp.s25_k(1411), pg_temp.s25_k(1412), pg_temp.s25_k(1413)))
                     and (select count(*) = 3 from public.audit_log where action = 'SHEET_LOOKUP' and new_data->>'outcome' = 'mr_noname'),
  'each of those refused lookups is in the audit log (and counts against the day''s 200)');
-- the patient's own phone is the proof: the same unreadable name WITH the patient's phone is linked
insert into s25_resp select 'nn2', pg_temp.s25_sync(pg_temp.s25_one('LHR', jsonb_build_array(
  pg_temp.s25_row(pg_temp.s25_k(1414), jsonb_build_object('mr', '25003', 'name', 'بلال', 'phone', '0300 2223331')),
  pg_temp.s25_row(pg_temp.s25_k(1415), jsonb_build_object('mr', '26051', 'name', 'Bilal', 'phone', '0314-0000051')))));
select pg_temp.check((select string_agg(pg_temp.s25_out(resp, g::int), ',' order by g) from s25_resp, generate_series(0, 1) g where n = 'nn2') = 'created,created'
                     and (pg_temp.s25_vis(pg_temp.s25_k(1414))).patient_id = :pu and (pg_temp.s25_vis(pg_temp.s25_k(1415))).patient_id = pg_temp.s25_pid('26051'),
  'with the patient''s own phone number typed, the same rows are linked');

-- (c) the sync makes only so many visits for a branch and day, whoever sends them
select pg_temp.check((select value = '120' from private.aaj_sync_config where key = 'visits_per_branch_day'), 'the default cap is 120 visits a day for one branch (the busiest tab of the real sheet has about 50 rows)');
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
update private.aaj_sync_config set value = '120' where key = 'visits_per_branch_day';

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
select pg_temp.check((select details = 'website notes' from public.checkups where patient_name = 'Zara Check') and pg_temp.s25_res((select resp from s25_resp where n = 'ad1'), 0)->'kept_website' = '["details"]'::jsonb,
  'an adopted checkup keeps what the website says, even when the sheet row carries a newer edit stamp, and the row is told');
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ad1'), 1) = 'created' and pg_temp.s25_out((select resp from s25_resp where n = 'ad1'), 2) = 'created'
                     and (select count(*) = 2 from public.checkups where patient_name = 'Zara Other') and (select count(*) = 2 from public.checkups where patient_name = 'Zara NoPhone'),
  'another phone, or no phone at all, is never guessed to be the same person');
insert into s25_resp select 'ad2', pg_temp.s25_sync(pg_temp.s25_pl(jsonb_build_array(pg_temp.s25_tab('DHA',
  jsonb_build_array(pg_temp.s25_row(pg_temp.s25_k(1503), '{"name":"Zara Other","phone":"03130000051","treatment":"Checkup"}')),
  array[pg_temp.s25_k(1503), (select wk from s25_zara where n = 'Zara Other')]))));
select pg_temp.check(pg_temp.s25_out((select resp from s25_resp where n = 'ad2')) = 'created' and (select count(*) = 2 from public.checkups where phone = '03130000051'),
  'when the website checkup''s own row is in the sheet (its key is present) a second row is a second person');
delete from public.checkups where patient_name like 'Zara %';

-- (f) a phone changed in the sheet on a linked row does not reach the patient file: the row says so (no green tick)
select pg_temp.check((select phone = '03020000003' from public.patients where mr_number = '26003'), 'setup: the patient has a phone');
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
select setval('public.mr_number_seq', last_value, is_called) from s25_seq;
rollback;
