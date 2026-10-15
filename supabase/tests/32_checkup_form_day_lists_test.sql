-- The Google Form's old answers and the day lists (20261012000300_checkup_form_day_lists.sql). Made-up people only.
-- An answer imported with import_checkup_form (source 'google_form') is on the Checkups page, never on a day's list:
--   1. the two functions have the rule, and keep their rights;
--   2. day_list_copy of that day leaves it out, and its counts are the Aaj ki List page's (checkup_list without google_form, as
--      listDayCheckups in web/js/data/supabase.js reads it); an answer that went onto a checkup already on that list leaves that
--      checkup on the list, once;
--   3. the History has no line for a day that has only imported answers, and counts the other days as the page does;
--   4. end_day saves a copy without it, with the page's counts.
\set ON_ERROR_STOP 1
\set admin '''00000000-0000-0000-0000-000000003200'''
\set fd    '''00000000-0000-0000-0000-000000003201'''

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'TEST FAILED: %', msg; end if;
  raise notice 'ok - %', msg;
end $$;
create or replace function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, false) $$;
-- One answer the way the website sends it (web/js/lib/checkup-form.js), at North Nazimabad.
create or replace function pg_temp.ans(r int, at text, name text, phone text) returns jsonb language sql as $$
  select jsonb_build_object('row', r, 'submitted_at', at, 'name', name, 'phone', phone, 'branch', 'NN', 'doctors', 'Dr. Sample (sample)',
    'checkup_for', 'Braces', 'ali_recommended', true, 'pricing_understood', 'yes', 'wants_treatment', true, 'treatment_plan', 'Next month',
    'follow_up', null, 'notes', null) $$;
-- The names of a list's rows, in order, joined with " | ".
create or replace function pg_temp.names(p_rows jsonb) returns text language sql as $$
  select string_agg(r->>'name', ' | ' order by o) from jsonb_array_elements(p_rows) with ordinality x(r, o) $$;
-- What the Aaj ki List page reads for a day's checkup patients (listDayCheckups), as the signed-in reader.
create or replace function pg_temp.page_count(p_branch smallint, p_date date) returns bigint language sql as $$
  select count(*) from public.checkup_list c
   where c.branch_id = p_branch and c.checkup_date = p_date and not c.date_is_month and c.source <> 'google_form' $$;
grant execute on all functions in schema pg_temp to authenticated, anon;
reset role;
select pg_temp.act_as('');

begin;
select set_config('test.admin', :admin, false), set_config('test.fd', :fd, false),
       set_config('test.nn', (select id::text from public.branches where code = 'NN'), false);
insert into auth.users (id, email) values (:admin, 'admin32@dralirashid.com'), (:fd, 'fd32@dralirashid.com');
insert into public.staff (id, full_name, email, role) values
  (:admin, 'Admin Thirtytwo', 'admin32@dralirashid.com', 'admin'),
  (:fd,    'Desk Thirtytwo', 'fd32@dralirashid.com', 'front_desk');
update public.staff set restrict_to_branches = true, branch_ids = array[current_setting('test.nn')::smallint] where id = :fd;

-- These two days hold only this file's people (an earlier file can leave visits on days counted back from today).
delete from public.visits where visit_date in (date '2026-09-21', date '2026-09-22');
delete from public.checkups where checkup_date in (date '2026-09-21', date '2026-09-22');

-- North Nazimabad on 21 Sep 2026: two checkup patients added on the website that day.
insert into public.checkups (checkup_date, branch_id, patient_name, phone, checkup_for, day_status, source, created_at) values
  ('2026-09-21', current_setting('test.nn')::smallint, 'Sample Website Person', '0300-5553201', 'Checkup', 'waiting', 'website', '2026-09-21 10:00+05'),
  ('2026-09-21', current_setting('test.nn')::smallint, 'Sample Answered Later', '0300-5553203', 'Checkup', 'waiting', 'website', '2026-09-21 10:05+05');

-- Dr. Ali imports three answers of the Google Form: a person who was not on that day's list (a new row, source google_form), the
-- answers of a person who was (they go onto that checkup), and a person of 22 Sep, a day with no list at all.
do $$
declare r jsonb;
begin
  perform pg_temp.act_as(current_setting('test.admin'));
  set local role authenticated;
  r := public.import_checkup_form(jsonb_build_array(
    pg_temp.ans(1, '2026-09-21T11:00:00+05:00', 'Sample Form Person', '0312-5553202'),
    pg_temp.ans(2, '2026-09-21T11:10:00+05:00', 'Sample Answered Later', '0300-5553203'),
    pg_temp.ans(3, '2026-09-22T12:00:00+05:00', 'Sample Form Only', '0312-5553204')), false);
  reset role;
  perform pg_temp.check((r->>'inserted')::int = 2 and (r->>'filled_day')::int = 1,
    'setup: two answers are new rows (source google_form), one went onto the checkup already on the list of 21 Sep');
  perform pg_temp.check((select count(*) from public.checkups where checkup_date in ('2026-09-21', '2026-09-22') and source = 'google_form') = 2
    and (select source from public.checkups where patient_name = 'Sample Answered Later') = 'website',
    'setup: the filled checkup stays a website checkup');
end $$;

-- 1. The rule is in both functions; their rights are as before (the private one for nobody, the History for signed-in staff only).
do $$
begin
  perform pg_temp.check(position('google_form' in pg_get_functiondef('private.day_list_checkups(smallint, date)'::regprocedure)) > 0,
    'private.day_list_checkups leaves out the Google Form''s answers');
  perform pg_temp.check(position('google_form' in pg_get_functiondef('public.day_list_history(smallint, date, date, integer, integer)'::regprocedure)) > 0,
    'public.day_list_history leaves them out of the days with checkup patients');
  perform pg_temp.check(not has_function_privilege('authenticated', 'private.day_list_checkups(smallint, date)', 'execute')
    and not has_function_privilege('anon', 'private.day_list_checkups(smallint, date)', 'execute'),
    'rights: private.day_list_checkups is for nobody but the functions that use it');
  perform pg_temp.check(has_function_privilege('authenticated', 'public.day_list_history(smallint, date, date, integer, integer)', 'execute')
    and not has_function_privilege('anon', 'public.day_list_history(smallint, date, date, integer, integer)', 'execute'),
    'rights: the History is for signed-in staff, not for anon');
end $$;

-- 2 and 3. The desk of North Nazimabad reads the day, the History and the page.
set role authenticated;
select pg_temp.act_as(:fd);
do $$
declare
  v_nn smallint := current_setting('test.nn')::smallint;
  j jsonb;
  r record;
begin
  perform pg_temp.check(pg_temp.page_count(v_nn, '2026-09-21') = 2, 'page: the Aaj ki List of 21 Sep has 2 checkup patients');
  j := public.day_list_copy(v_nn, '2026-09-21');
  perform pg_temp.check(pg_temp.names(j->'rows') = 'Sample Website Person | Sample Answered Later',
    'day_list_copy: the two checkups of that day''s list, without the imported answer (got ' || coalesce(pg_temp.names(j->'rows'), 'none') || ')');
  perform pg_temp.check((j->'counts'->>'total')::int = 2 and (j->'counts'->>'checkups')::int = 2 and (j->'counts'->>'checkups')::bigint = pg_temp.page_count(v_nn, '2026-09-21'),
    'day_list_copy: counts total 2, checkups 2, as the page');
  perform pg_temp.check((select count(*) from jsonb_array_elements(j->'rows') x(r) where x.r->>'name' = 'Sample Answered Later') = 1,
    'day_list_copy: the checkup that got its answers from the import is on the list once');
  j := public.day_list_copy(v_nn, '2026-09-22');
  perform pg_temp.check(jsonb_array_length(j->'rows') = 0 and (j->'counts'->>'total')::int = 0,
    'day_list_copy: 22 Sep (only an imported answer) is an empty list');

  perform pg_temp.check((select count(*) from public.day_list_history(v_nn, '2026-09-21', '2026-09-22')) = 1,
    'history: one line (21 Sep); 22 Sep, a day with only an imported answer, has none');
  select * into r from public.day_list_history(v_nn, '2026-09-21', '2026-09-22') x;
  perform pg_temp.check(r.list_date = '2026-09-21' and not r.ended and (r.counts->>'checkups')::int = 2 and (r.counts->>'total')::int = 2 and r.total_count = 1,
    'history: 21 Sep counts 2 checkup patients, as the page');
end $$;

-- 4. The desk ends 21 Sep: the copy and its counts are the page's.
do $$
declare
  v_nn smallint := current_setting('test.nn')::smallint;
  c jsonb;
  j jsonb;
begin
  c := public.end_day(v_nn, '2026-09-21');
  perform pg_temp.check((c->>'total')::int = 2 and (c->>'checkups')::int = 2 and (c->>'waiting')::int = 2 and (c->>'completed')::int = 0,
    'end_day: total 2, checkups 2 (both still waiting, as on the page), without the imported answer');
  j := public.day_list_copy(v_nn, '2026-09-21');
  perform pg_temp.check((j->>'ended')::boolean and pg_temp.names(j->'rows') = 'Sample Website Person | Sample Answered Later',
    'end_day: the saved copy has the two checkups of the list only');
  perform pg_temp.check((select (x.counts->>'checkups')::int from public.day_list_history(v_nn, '2026-09-21', '2026-09-21') x) = 2,
    'history: the ended day counts 2 checkup patients');
end $$;
reset role;

rollback;
