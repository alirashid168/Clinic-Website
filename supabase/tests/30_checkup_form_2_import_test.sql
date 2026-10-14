-- The import of the Google Form's old answers (20261011000300_checkup_form_2.sql, section 3: public.import_checkup_form).
-- Everything below uses made-up people (phones 0300-555xxxx / 0312xxxxxxx) and made-up answers.
--   1. the schema: the source 'google_form', form_submitted_at, the table of imported answers, the function's rights;
--   2. who may import (admin only) and who may set form_submitted_at (the import only);
--   3. where an answer goes: the day's checkup (website or Google Sheet; by phone and name, or by name when one side has no phone; the oldest),
--      the old list's row of that month (its follow-up stays), or a new row shown like a website entry; skips; cleaning; the preview
--      undoes everything and counts the same; the same file again changes nothing, also after a removal; two people on one phone on
--      one day are two checkups (3b); a second answer of one person that says otherwise is a checkup of its own, and what the form says
--      that a checkup keeps its own text for is in its notes (3c);
--   4. the Google Sheet sync does not see any of it: today's list and its hash stay the same, an answer of today waits, and no imported
--      row is on a list the sync keeps.
\set ON_ERROR_STOP 1
\set admin  '''00000000-0000-0000-0000-000000003100'''
\set fd     '''00000000-0000-0000-0000-000000003101'''
\set acct   '''00000000-0000-0000-0000-000000003102'''

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
-- One answer the way the website sends it (web/js/lib/checkup-form.js).
create or replace function pg_temp.ans(r int, at text, name text, phone text, branch text, extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('row', r, 'submitted_at', at, 'name', name, 'phone', phone, 'branch', branch, 'doctors', 'Dr. Sample (sample)',
    'checkup_for', 'Braces', 'ali_recommended', true, 'pricing_understood', 'yes', 'wants_treatment', true, 'treatment_plan', 'Next month',
    'follow_up', null, 'notes', null) || extra $$;
-- The import as the signed-in admin (through the API's role).
create or replace function pg_temp.imp(p_rows jsonb, p_dry boolean default false) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform pg_temp.act_as(current_setting('test.admin'));
  set local role authenticated;
  r := public.import_checkup_form(p_rows, p_dry);
  reset role;
  return r;
end $$;
create or replace function pg_temp.today() returns date language sql as $$ select (now() at time zone 'Asia/Karachi')::date $$;
-- the sheet's script calls the sync as anon with the secret (as in 25_aaj_sync_test.sql)
create or replace function pg_temp.f31_sync(p_tab jsonb) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  set local role anon;
  r := public.aaj_sync('sync-secret-31', jsonb_build_object('date', (now() at time zone 'Asia/Karachi')::date, 'check_removed', false, 'tabs', jsonb_build_array(p_tab)));
  reset role;
  return r;
end $$;
create or replace function pg_temp.one(p_name text) returns public.checkups language sql as $$
  select c from public.checkups c where c.patient_name = p_name order by c.created_at limit 1 $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

begin;
create extension if not exists pgcrypto;
select set_config('test.admin', :admin, false), set_config('test.fd', :fd, false), set_config('test.acct', :acct, false),
       set_config('test.nn', (select id::text from public.branches where code = 'NN'), false),
       set_config('test.gul', (select id::text from public.branches where code = 'GUL'), false),
       set_config('test.lhr', (select id::text from public.branches where code = 'LHR'), false);
insert into auth.users (id, email) values (:admin, 'admin31@dralirashid.com'), (:fd, 'fd31@dralirashid.com'), (:acct, 'acct31@dralirashid.com');
insert into public.staff (id, full_name, email, role) values
  (:admin, 'Admin', 'admin31@dralirashid.com', 'admin'),
  (:fd,    'Front Desk NN', 'fd31@dralirashid.com', 'front_desk'),
  (:acct,  'Accountant', 'acct31@dralirashid.com', 'accountant');
update public.staff set restrict_to_branches = true, branch_ids = array[(select id from public.branches where code = 'NN')] where id = :fd;
insert into private.sync_secrets (name, secret_hash) values ('aaj_sheet_sync', encode(digest('sync-secret-31', 'sha256'), 'hex'))
  on conflict (name) do update set secret_hash = excluded.secret_hash;

-- 1. The schema.
do $$
declare v_def text;
begin
  select pg_get_constraintdef(oid) into v_def from pg_constraint where conrelid = 'public.checkups'::regclass and conname = 'checkups_source_check';
  perform pg_temp.check(v_def like '%''website''%' and v_def like '%''google_sheet''%' and v_def like '%''archive''%' and v_def like '%''google_form''%'
    and (select count(*) from pg_constraint where conrelid = 'public.checkups'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ '\msource\M') = 1,
    'checkups.source: google_form joins website, google_sheet and archive, in one check');
  perform pg_temp.check((select data_type || ':' || is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'checkups' and column_name = 'form_submitted_at')
    = 'timestamp with time zone:YES', 'checkups.form_submitted_at: when the answers were given on the Google Form (nullable)');
  perform pg_temp.check(exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'checkup_list' and column_name = 'form_submitted_at'),
    'checkup_list shows it');
  perform pg_temp.check(to_regclass('private.checkup_form_imports') is not null and not has_table_privilege('authenticated', 'private.checkup_form_imports', 'select')
    and not has_table_privilege('anon', 'private.checkup_form_imports', 'select'), 'the table of imported answers is private');
  perform pg_temp.check((select prosecdef from pg_proc where oid = 'public.import_checkup_form(jsonb,boolean)'::regprocedure)
    and has_function_privilege('authenticated', 'public.import_checkup_form(jsonb,boolean)', 'execute')
    and not has_function_privilege('anon', 'public.import_checkup_form(jsonb,boolean)', 'execute'),
    'import_checkup_form: security definer, signed-in people may call it (it checks for admin itself), the public may not');
  perform pg_temp.check(not has_function_privilege('authenticated', 'private.checkup_form_agrees(public.checkups,boolean,text,boolean,text)', 'execute'),
    'its helper private.checkup_form_agrees is not callable through the API');
end $$;

-- 2. Who may import, and who may set form_submitted_at.
set role authenticated;
do $$
declare v_nn smallint := current_setting('test.nn')::smallint; n int;
begin
  perform pg_temp.act_as(current_setting('test.fd'));
  perform pg_temp.expect_error($q$select public.import_checkup_form('[]'::jsonb)$q$, 'NOT_ALLOWED: only Dr. Ali can import the answers of the checkup form.', 'front desk: cannot import');
  perform pg_temp.act_as(current_setting('test.acct'));
  perform pg_temp.expect_error($q$select public.import_checkup_form('[]'::jsonb, true)$q$, 'NOT_ALLOWED', 'accountant: cannot import, not even the preview');
  perform pg_temp.act_as(current_setting('test.fd'));
  perform pg_temp.expect_error(format($q$insert into public.checkups (checkup_date, branch_id, patient_name, source) values ('2026-08-01', %s, 'Sample Posing', 'google_form')$q$, v_nn),
    'NOT_ALLOWED', 'front desk: cannot add a row that poses as one from the Google Form');
  perform pg_temp.expect_error(format($q$insert into public.checkups (checkup_date, branch_id, patient_name, form_submitted_at) values ('2026-08-01', %s, 'Sample Posing', now())$q$, v_nn),
    'NOT_ALLOWED: when a checkup''s answers were given on the Google Form is set by the import only.', 'front desk: cannot mark a new checkup "answers from the Google Form"');
  insert into public.checkups (checkup_date, branch_id, patient_name, phone) values ('2026-08-02', v_nn, 'Sample Guard Row', '0300-5553199');
  perform pg_temp.expect_error($q$update public.checkups set form_submitted_at = now() where patient_name = 'Sample Guard Row'$q$, 'NOT_ALLOWED', 'front desk: cannot set it on a checkup either');
  update public.checkups set notes = 'still fine' where patient_name = 'Sample Guard Row';
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'front desk: everything else of the checkup is edited as before');
  perform pg_temp.act_as(current_setting('test.admin'));
  update public.checkups set form_submitted_at = now() where patient_name = 'Sample Guard Row';
  update public.checkups set form_submitted_at = null where patient_name = 'Sample Guard Row';
  perform pg_temp.check(true, 'admin: may set and clear it (the SQL editor and Dr. Ali are never held back)');
  delete from public.checkups where patient_name = 'Sample Guard Row';
end $$;
reset role;
set role anon;
select pg_temp.expect_error($q$select public.import_checkup_form('[]'::jsonb)$q$, 'permission denied', 'anon: cannot call the import');
reset role;
select pg_temp.expect_error($q$select pg_temp.imp('{"row": 1}'::jsonb)$q$, 'BAD_ROWS', 'the rows must be a list');
select pg_temp.expect_error($q$select pg_temp.imp((select jsonb_agg(pg_temp.ans(g, '2026-08-21T10:00:00+05:00', 'Sample Over ' || g, null, 'NN')) from generate_series(1, 501) g))$q$,
  'TOO_MANY_ROWS', 'at most 500 rows a call');
select pg_temp.check((select r->'skipped' = (select jsonb_agg(jsonb_build_object('row', g, 'reason', 'The date could not be read') order by g) from generate_series(1, 6) g)
                        and (r->>'skipped_count')::int = 6
                        from (select pg_temp.imp(jsonb_build_array(
                          pg_temp.ans(1, '2026-02-30T10:00:00+05:00', 'Sample Feb', null, 'NN'), pg_temp.ans(2, '2026-08-21T24:00:00+05:00', 'Sample Midnight', null, 'NN'),
                          pg_temp.ans(3, '1999-08-21T10:00:00+05:00', 'Sample Old', null, 'NN'), pg_temp.ans(4, '0000-01-01T10:00:00+05:00', 'Sample Zero', null, 'NN'),
                          jsonb_build_object('row', 5, 'name', 'Sample No Time'), pg_temp.ans(6, '2026-08-21 10:00:00+05:00', 'Sample Space', null, 'NN')), true) as r) x),
  'a time that is not a real one (30 Feb, 24:00, last century, no time at all, a space for the T) is "could not be read", never a failed batch');

-- 3. Where an answer goes.
-- On the website already: a website checkup of 21 Aug at North Nazimabad (no answers; the plain "Checkup" as its treatment), a checkup the
-- Google Sheet made on 22 Aug, two of 23 Aug (no phone; and the same name again later that day), one of 25 Aug holding every answer, and the
-- old list's row of August for another person.
do $$
declare v_nn smallint := current_setting('test.nn')::smallint; r jsonb;
begin
  insert into public.checkups (checkup_date, branch_id, patient_name, phone, checkup_for, day_status, created_at) values
    ('2026-08-21', v_nn, 'Sample Import Day', '0300-555 3101', 'Checkup', 'completed', '2026-08-21 10:00+05'),
    ('2026-08-23', v_nn, 'Sample  Import Nophone', null, null, 'waiting', '2026-08-23 09:00+05'),
    ('2026-08-23', v_nn, 'Sample Import Nophone', null, 'Scaling', 'waiting', '2026-08-23 17:00+05');
  insert into public.checkups (checkup_date, branch_id, patient_name, phone, checkup_for, day_status, source, sheet_key, follow_up, notes, created_at) values
    ('2026-08-22', v_nn, 'Sample Import Sheet', '03120003102', 'checkup', 'completed', 'google_sheet', 'S-00000000f311', 'Interested', 'from the sheet', '2026-08-22 10:00+05');
  insert into public.checkups (checkup_date, branch_id, patient_name, phone, doctors, checkup_for, ali_recommended, pricing_understood, wants_treatment, treatment_plan, day_status, created_at) values
    ('2026-08-25', v_nn, 'Sample Import Full', '0300-5553105', 'Dr. Other (sample)', 'Implant', false, 'no', false, 'Will think', 'completed', '2026-08-25 10:00+05');
  perform pg_temp.act_as(current_setting('test.admin'));
  r := public.import_checkups(jsonb_build_array(jsonb_build_object('row', 5, 'month', '2026-08-01', 'name', 'Sample Import Archive', 'phone', '0300-5553103', 'branch', 'NN',
         'doctors', 'Dr. Sample (sample)', 'checkup_for', 'Scaling', 'follow_up', 'Interested', 'notes', 'called once', 'source_tab', 'AUGUST 26')));
  perform pg_temp.check((r->>'inserted')::int = 1, 'setup: the old list''s row of August');
end $$;

create temp table f31_rows as select jsonb_build_array(
  pg_temp.ans(2, '2026-08-21T19:25:03+05:00', 'Sample Import Day', '+92 300 5553101', 'NN', '{"follow_up": "Follow-up Sent", "notes": "Reminder: done twice"}'),
  pg_temp.ans(3, '2026-08-22T12:00:00+05:00', 'Sample Import Sheet', '0312-0003102', 'NN', '{"follow_up": "No Response", "checkup_for": "Root canal"}'),
  pg_temp.ans(4, '2026-08-20T11:00:00+05:00', 'sample import archive', '03005553103', 'GUL', '{"follow_up": "No Response", "notes": "Reminder: not on whatsapp", "doctors": null}'),
  pg_temp.ans(5, '2026-08-23T12:00:00+05:00', 'Sample Import Nophone', '0300-5553104', 'NN', '{"ali_recommended": false, "pricing_understood": "needs_explanation"}'),
  pg_temp.ans(6, '2026-08-21T13:00:00+05:00', 'Sample Import Day', '0300-5553101', 'GUL'),
  pg_temp.ans(7, '2026-08-24T09:00:00+05:00', 'Sample Import Twice', '0300-5553106', 'LHR', '{"pricing_understood": null}'),
  pg_temp.ans(8, '2026-08-24T09:05:00+05:00', 'Sample Import Twice', '0300-5553106', 'LHR', '{"pricing_understood": "no"}'),
  pg_temp.ans(9, '2026-08-25T15:00:00+05:00', 'Sample Import Full', '0300-5553105', 'NN'),
  pg_temp.ans(17, '2026-08-25T15:30:00+05:00', 'Sample Import Full', '0300-5553105', 'NN', '{"doctors": "Dr. Other (sample)", "checkup_for": "Implant", "ali_recommended": false,
    "pricing_understood": "no", "wants_treatment": false, "treatment_plan": "will think"}'),
  pg_temp.ans(10, '2026-08-26T10:00:00+05:00', '   ', '0300-5553107', 'NN'),
  pg_temp.ans(11, 'soon', 'Sample Import Bad Date', null, 'NN'),
  pg_temp.ans(12, '2026-08-26T10:00:00', 'Sample Import No Offset', null, 'NN'),
  pg_temp.ans(13, to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM-DD') || 'T00:00:01+05:00', 'Sample Import Today', '0300-5553108', 'NN'),
  pg_temp.ans(14, to_char(pg_temp.today() + 2, 'YYYY-MM-DD') || 'T10:00:00+05:00', 'Sample Import Future', '0300-5553109', 'NN'),
  pg_temp.ans(15, '2026-08-27T08:00:00+05:00', 'Sample Import Odd', repeat('p', 60), 'XXX', jsonb_build_object('ali_recommended', 'Yes', 'pricing_understood', 'Yes',
    'wants_treatment', 1, 'treatment_plan', repeat('q', 600), 'follow_up', '', 'notes', repeat('n', 2500), 'doctors', repeat('d', 400))),
  pg_temp.ans(16, '2026-08-28T08:00:00Z', 'Sample Import Utc', '0300-5553110', 'nn')
) as rows;

create temp table f31_before as select (select count(*) from public.checkups) as n_checkups, (select count(*) from private.checkup_form_imports) as n_keys,
  (select count(*) from public.audit_log) as n_audit, (select md5(string_agg(to_jsonb(c)::text, '' order by c.id)) from public.checkups c) as sig;
create temp table f31_res (n text primary key, r jsonb);
insert into f31_res select 'preview', pg_temp.imp(rows, true) from f31_rows;
select pg_temp.check((select (select count(*) from public.checkups) = b.n_checkups and (select count(*) from private.checkup_form_imports) = b.n_keys
                             and (select count(*) from public.audit_log) = b.n_audit
                             and (select md5(string_agg(to_jsonb(c)::text, '' order by c.id)) from public.checkups c) = b.sig from f31_before b)
                     and (select (r->>'dry_run')::boolean from f31_res where n = 'preview'),
  'the preview (p_dry_run) changes nothing at all: no checkup, no key, no audit row');
insert into f31_res select 'import', pg_temp.imp(rows) from f31_rows;
select pg_temp.check((select p.r - 'dry_run' = i.r - 'dry_run' from f31_res p, f31_res i where p.n = 'preview' and i.n = 'import'),
  'the preview counts exactly what the import then does');
-- new: rows 6 (another branch), 7, 9 (the website's checkup of that day holds other answers), 15 and 16; onto that day's checkup: 2, 3, 5
-- and 8 (8 fills in what 7 left empty); onto the old list's row: 4; nothing new: 17 (the website's checkup holds these very answers);
-- skipped: 10 to 14
select pg_temp.check((select array[(r->>'given')::int, (r->>'inserted')::int, (r->>'filled_day')::int, (r->>'filled_month')::int, (r->>'already')::int, (r->>'same')::int, (r->>'skipped_count')::int,
                              (r->>'other_answers')::int, (r->>'other_name')::int]
                        from f31_res where n = 'import') = array[16, 5, 4, 1, 0, 1, 5, 1, 0],
  'the counts: 5 new (1 of them a second answer that says otherwise), 4 onto the day''s checkup, 1 onto the old list''s row, 1 with nothing new, 5 skipped (given = the sum)');
select pg_temp.check((select r->'skipped' from f31_res where n = 'import') = jsonb_build_array(
    jsonb_build_object('row', 10, 'reason', 'No patient name'), jsonb_build_object('row', 11, 'reason', 'The date could not be read'),
    jsonb_build_object('row', 12, 'reason', 'The date could not be read'),
    jsonb_build_object('row', 13, 'reason', 'Given today: today''s list is still kept in the Google Sheet. Import the file again tomorrow.'),
    jsonb_build_object('row', 14, 'reason', 'The date is in the future')),
  'skipped with the reason: no name, no readable time (it must carry its offset), given today, in the future');

do $$
declare c public.checkups; n int;
begin
  c := pg_temp.one('Sample Import Day');
  perform pg_temp.check(c.source = 'website' and c.phone = '0300-555 3101' and c.checkup_for = 'Braces' and c.doctors = 'Dr. Sample (sample)' and c.ali_recommended
    and c.pricing_understood = 'yes' and c.wants_treatment and c.treatment_plan = 'Next month' and c.follow_up = 'Follow-up Sent' and c.notes = 'Reminder: done twice'
    and c.form_submitted_at = '2026-08-21T19:25:03+05:00'::timestamptz and c.day_status = 'completed',
    'the website''s checkup of that day: the answers, the doctor, "checkup for" in place of the plain "Checkup", the follow-up (it said Not Contacted), the reminder and when; its name, phone and source stay');
  select * into c from public.checkups where sheet_key = 'S-00000000f311';
  perform pg_temp.check(c.source = 'google_sheet' and c.checkup_for = 'Root canal' and c.follow_up = 'Interested' and c.notes = 'from the sheet' and c.ali_recommended
    and c.form_submitted_at is not null, 'the Google Sheet''s checkup of that day: the answers; its follow-up status (not Not Contacted) and notes stay; its sheet key stays');
  c := pg_temp.one('Sample Import Archive');
  perform pg_temp.check(c.source = 'archive' and c.date_is_month and c.checkup_date = '2026-08-01' and c.branch_id = current_setting('test.nn')::smallint
    and c.doctors = 'Dr. Sample (sample)' and c.checkup_for = 'Scaling' and c.follow_up = 'Interested'
    and c.notes = 'called once; Reminder: not on whatsapp; On the Google Form: "What was your checkup for?" Braces; On the Google Form: "Which branch did you visit?" Gulshan (RJ Mall)'
    and c.ali_recommended and c.pricing_understood = 'yes' and c.wants_treatment and c.treatment_plan = 'Next month' and c.form_submitted_at = '2026-08-20T11:00:00+05:00'::timestamptz,
    'the old list''s row of that person and month (private.checkup_key): the answers and the reminder; it keeps its follow-up status, branch, doctor, treatment and month, and what the form said about those is in its notes');
  select * into c from public.checkups where patient_name = 'Sample  Import Nophone';
  perform pg_temp.check(c.phone = '0300-5553104' and not c.ali_recommended and c.pricing_understood = 'needs_explanation',
    'no phone on the website''s row: matched by name (spaces and case aside), the oldest of the two; the phone is filled in');
  select * into c from public.checkups where patient_name = 'Sample Import Nophone';
  perform pg_temp.check(c.phone is null and c.ali_recommended is null and c.form_submitted_at is null, '... the later one of that name is left alone');
  select * into c from public.checkups where patient_name = 'Sample Import Day' and source = 'google_form';
  perform pg_temp.check(c.checkup_date = '2026-08-21' and not c.date_is_month and c.branch_id = current_setting('test.gul')::smallint and c.source_tab = 'Checkup Form 2.0'
    and c.day_status = 'completed' and c.follow_up = 'Not Contacted' and c.created_at = '2026-08-21T13:00:00+05:00'::timestamptz and c.form_submitted_at = c.created_at
    and c.sheet_key is null and c.patient_id is null and c.created_by = current_setting('test.admin')::uuid and c.ali_recommended and c.treatment_plan = 'Next month',
    'the same phone at another branch is another checkup: a new row from the Google Form, shown like one added with the form (the day, Completed, the time of the answer)');
  select count(*) into n from public.checkups where patient_name = 'Sample Import Twice';
  c := pg_temp.one('Sample Import Twice');
  perform pg_temp.check(n = 1 and c.source = 'google_form' and c.pricing_understood = 'no' and c.wants_treatment,
    'two answers of one person on one day: one checkup; the later answer fills in only what the first left empty');
  c := pg_temp.one('Sample Import Full');
  perform pg_temp.check(c.source = 'website' and c.form_submitted_at is null and c.doctors = 'Dr. Other (sample)' and c.pricing_understood = 'no' and not c.wants_treatment
    and c.treatment_plan = 'Will think' and c.notes is null,
    'a checkup holding other answers already: nothing is overwritten, and the same answers again (row 17, "will think" in lower case) change nothing');
  select * into c from public.checkups where patient_name = 'Sample Import Full' and source = 'google_form';
  perform pg_temp.check(c.checkup_date = '2026-08-25' and c.ali_recommended and c.pricing_understood = 'yes' and c.wants_treatment and c.treatment_plan = 'Next month'
    and c.doctors = 'Dr. Sample (sample)' and c.checkup_for = 'Braces' and (select count(*) from public.checkups where patient_name = 'Sample Import Full') = 2,
    '... the answer that says otherwise (row 9) is a checkup of its own that day, with every one of its answers');
  c := pg_temp.one('Sample Import Odd');
  perform pg_temp.check(length(c.phone) = 40 and c.branch_id is null and c.ali_recommended is null and c.pricing_understood is null and c.wants_treatment is null
    and length(c.treatment_plan) = 500 and length(c.notes) = 2000 and length(c.doctors) = 300 and c.follow_up = 'Not Contacted',
    'odd cells are cleaned (cut to the column limits, answers that are not the form''s become empty, an unknown branch none), never a failed batch');
  c := pg_temp.one('Sample Import Utc');
  perform pg_temp.check(c.checkup_date = '2026-08-28' and c.created_at = '2026-08-28T13:00:00+05:00'::timestamptz and c.branch_id = current_setting('test.nn')::smallint,
    'a time in UTC is the Karachi day; a branch code in lower case is the branch');
  perform pg_temp.check((select array_agg(outcome order by submitted_at) from private.checkup_form_imports)
    = array['filled_month', 'inserted', 'filled_day', 'filled_day', 'filled_day', 'inserted', 'filled_day', 'inserted', 'same', 'inserted', 'inserted'],
    'every answer imported is kept once in private.checkup_form_imports with where it went');
  perform pg_temp.check((select form_key from private.checkup_form_imports where submitted_at = '2026-08-21T19:25:03+05:00') = '2026-08-21 19:25:03|03005553101|sample import day',
    'the key: the time in Karachi, the phone as digits, the name in lower case');
end $$;

-- the same file again changes nothing (also the preview says so), and an imported row removed since is not brought back
create temp table f31_after as select (select md5(string_agg(to_jsonb(c)::text, '' order by c.id)) from public.checkups c) as sig, (select count(*) from public.audit_log) as n_audit;
insert into f31_res select 'again', pg_temp.imp(rows) from f31_rows;
select pg_temp.check((select array[(r->>'inserted')::int, (r->>'filled_day')::int, (r->>'filled_month')::int, (r->>'already')::int, (r->>'same')::int, (r->>'skipped_count')::int]
                        from f31_res where n = 'again') = array[0, 0, 0, 11, 0, 5]
                     and (select (select md5(string_agg(to_jsonb(c)::text, '' order by c.id)) from public.checkups c) = a.sig and (select count(*) from public.audit_log) = a.n_audit from f31_after a),
  'the same file again: every answer "already imported", not one checkup or audit row changes');
-- the North Nazimabad desk removes a row from the Google Form at its branch (through the API; the key table is private, the database
-- clears the link itself)
set role authenticated;
do $$
declare n int;
begin
  perform pg_temp.act_as(current_setting('test.fd'));
  delete from public.checkups where patient_name = 'Sample Import Utc' and source = 'google_form';
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'front desk: may remove a row from the Google Form at its branch, like a website row');
end $$;
reset role;
insert into f31_res select 'after_delete', pg_temp.imp(rows) from f31_rows;
select pg_temp.check((select (r->>'already')::int = 11 and (r->>'inserted')::int = 0 from f31_res where n = 'after_delete')
                     and not exists (select 1 from public.checkups where patient_name = 'Sample Import Utc')
                     and (select checkup_id is null and outcome = 'inserted' from private.checkup_form_imports where form_key like '2026-08-28 13:00:00|%'),
  'a row from the Google Form removed since is not brought back by the next import (its key stays, without the checkup)');

-- 3b. One phone, two people (a parent's phone for two children who came together): never one checkup.
-- (a) nothing on the website yet: the two answers of 14 Aug at Gulshan are two new checkups, each with its own answers
insert into f31_res select 'siblings_new_preview', pg_temp.imp(jsonb_build_array(
  pg_temp.ans(40, '2026-08-14T11:00:00+05:00', 'Sample Sister Aiza', '0300-5553130', 'GUL', '{"checkup_for": "Braces", "wants_treatment": true, "treatment_plan": "Next month"}'),
  pg_temp.ans(41, '2026-08-14T11:04:00+05:00', 'Sample Brother Bilal', '0300-5553130', 'GUL',
    '{"checkup_for": "Root canal", "wants_treatment": false, "treatment_plan": "Too costly now", "ali_recommended": false}')), true);
insert into f31_res select 'siblings_new', pg_temp.imp(jsonb_build_array(
  pg_temp.ans(40, '2026-08-14T11:00:00+05:00', 'Sample Sister Aiza', '0300-5553130', 'GUL', '{"checkup_for": "Braces", "wants_treatment": true, "treatment_plan": "Next month"}'),
  pg_temp.ans(41, '2026-08-14T11:04:00+05:00', 'Sample Brother Bilal', '0300-5553130', 'GUL',
    '{"checkup_for": "Root canal", "wants_treatment": false, "treatment_plan": "Too costly now", "ali_recommended": false}')));
select pg_temp.check((select (r->>'inserted')::int = 2 and (r->>'same')::int = 0 and (r->>'filled_day')::int = 0 and (r->>'other_name')::int = 1 from f31_res where n = 'siblings_new')
                     and (select p.r - 'dry_run' = i.r - 'dry_run' from f31_res p, f31_res i where p.n = 'siblings_new_preview' and i.n = 'siblings_new'),
  'two people on one phone, same day and branch: two new checkups (the preview says so too, with 1 "same phone, another name")');
select pg_temp.check((select array_agg(concat_ws('|', patient_name, checkup_for, wants_treatment, treatment_plan, ali_recommended) order by created_at)
                        from public.checkups where phone = '0300-5553130')
                     = array['Sample Sister Aiza|Braces|t|Next month|t', 'Sample Brother Bilal|Root canal|f|Too costly now|f'],
  '... each with their own name and answers (the brother is not "already on the website")');
-- (b) both on the Google Sheet's list of 3 Sep at Lahore (the sister first); the brother's answer comes first in the file
do $$
declare v_lhr smallint := current_setting('test.lhr')::smallint;
begin
  insert into public.checkups (checkup_date, branch_id, patient_name, phone, checkup_for, day_status, source, sheet_key, created_at) values
    ('2026-09-03', v_lhr, 'Sample Sister Hira', '03120003131', 'Checkup', 'completed', 'google_sheet', 'S-00000000f331', '2026-09-03 10:00+05'),
    ('2026-09-03', v_lhr, 'Sample Brother Hamza', '03120003131', 'Checkup', 'completed', 'google_sheet', 'S-00000000f332', '2026-09-03 10:05+05'),
    -- the same person written another way on the sheet: an everyday spelling of the first name, Muhammad in front
    ('2026-09-04', v_lhr, 'Ayesha Sampleton', '03120003133', 'Checkup', 'completed', 'google_sheet', 'S-00000000f333', '2026-09-04 10:00+05'),
    ('2026-09-04', v_lhr, 'Usman Sampleton', '03120003134', 'Checkup', 'completed', 'google_sheet', 'S-00000000f334', '2026-09-04 10:00+05'),
    -- a mother and her son on one phone, the son's row older; the mother's answer must find her own row
    ('2026-09-05', v_lhr, 'Sample Son Faraz', '03120003135', 'Checkup', 'completed', 'google_sheet', 'S-00000000f335', '2026-09-05 09:00+05'),
    ('2026-09-05', v_lhr, 'Sample Mother Rubina', '03120003135', 'Checkup', 'completed', 'google_sheet', 'S-00000000f336', '2026-09-05 09:30+05');
end $$;
insert into f31_res select 'siblings_sheet', pg_temp.imp(jsonb_build_array(
  pg_temp.ans(50, '2026-09-03T12:00:00+05:00', 'Sample Brother Hamza', '0312-0003131', 'LHR', '{"checkup_for": "Extraction", "wants_treatment": false, "treatment_plan": "Later"}'),
  pg_temp.ans(51, '2026-09-03T12:03:00+05:00', 'Sample Sister Hira', '0312-0003131', 'LHR', '{"checkup_for": "Braces", "wants_treatment": true, "treatment_plan": "This week"}'),
  pg_temp.ans(52, '2026-09-04T12:00:00+05:00', 'Aisha Sampleton', '0312-0003133', 'LHR', '{"checkup_for": "Implant"}'),
  pg_temp.ans(53, '2026-09-04T12:00:00+05:00', 'Muhammad Usman Sampleton', '0312-0003134', 'LHR', '{"checkup_for": "Crown / bridge"}'),
  pg_temp.ans(54, '2026-09-05T12:00:00+05:00', 'Sample Mother Rubina', '0312-0003135', 'LHR', '{"checkup_for": "Smile makeover", "treatment_plan": "Only came with her son", "wants_treatment": false}')));
select pg_temp.check((select (r->>'filled_day')::int = 5 and (r->>'inserted')::int = 0 and (r->>'same')::int = 0 and (r->>'other_name')::int = 0 from f31_res where n = 'siblings_sheet'),
  'the sheet''s list holds both people of one phone: each answer goes onto its own person''s row (5 onto the day''s checkup, none new)');
select pg_temp.check((select array_agg(concat_ws('|', patient_name, checkup_for, wants_treatment, treatment_plan) order by created_at, patient_name)
                        from public.checkups where phone in ('03120003131', '03120003135'))
                     = array['Sample Sister Hira|Braces|t|This week', 'Sample Brother Hamza|Extraction|f|Later',
                             'Sample Son Faraz|Checkup', 'Sample Mother Rubina|Smile makeover|f|Only came with her son'],
  '... the brother''s answers on the brother, the sister''s on the sister, the mother''s on the mother (not on the older row of her son, which keeps none)');
select pg_temp.check((select bool_and(form_submitted_at is not null) from public.checkups where sheet_key in ('S-00000000f333', 'S-00000000f334'))
                     and (select checkup_for from public.checkups where sheet_key = 'S-00000000f333') = 'Implant'
                     and (select checkup_for from public.checkups where sheet_key = 'S-00000000f334') = 'Crown / bridge',
  'the same person written another way ("Aisha" for "Ayesha", "Muhammad Usman" for "Usman") is still the same checkup');

-- 3c. A second answer never disappears, and what the checkup keeps its own text for is in its notes (review 5, 15 Oct 2026).
-- (A) the old list has Sample Repeat Person for August ("Check up"); the file has two answers on one phone: 5 Aug says No, 20 Aug says Yes.
-- (C) on one day at one branch: 12:00 says No, then a corrected 12:05 says Yes.
-- (D) the Google Sheet's rows of 10 Sep say "Chek up" (the plain word, as the sync spells it too) and "checkup / pain" (more than the word).
do $$
declare v_nn smallint := current_setting('test.nn')::smallint; r jsonb;
begin
  perform pg_temp.act_as(current_setting('test.admin'));
  r := public.import_checkups(jsonb_build_array(jsonb_build_object('row', 6, 'month', '2026-08-01', 'name', 'Sample Repeat Person', 'phone', '0300-5553112', 'branch', 'NN',
         'checkup_for', 'Check up', 'follow_up', 'Not Contacted', 'source_tab', 'AUGUST 26')));
  perform pg_temp.check((r->>'inserted')::int = 1, 'setup: the old list''s row of August for Sample Repeat Person');
  insert into public.checkups (checkup_date, branch_id, patient_name, phone, doctors, checkup_for, day_status, source, sheet_key, created_at) values
    ('2026-09-10', v_nn, 'Sample Typo One', '03120003141', null, 'Chek up', 'completed', 'google_sheet', 'S-00000000f341', '2026-09-10 10:00+05'),
    ('2026-09-10', v_nn, 'Sample Typo Two', '03120003142', 'Dr Hina S', 'checkup / pain', 'completed', 'google_sheet', 'S-00000000f342', '2026-09-10 10:01+05');
end $$;
insert into f31_res select 'second', pg_temp.imp(jsonb_build_array(
  pg_temp.ans(60, '2026-08-05T12:00:00+05:00', 'Sample Repeat Person', '0300-5553112', 'NN', '{"wants_treatment": false, "treatment_plan": "Too costly", "checkup_for": "Braces"}'),
  pg_temp.ans(61, '2026-08-20T12:00:00+05:00', 'Sample Repeat Person', '0300-5553112', 'NN',
    '{"wants_treatment": true, "treatment_plan": "Start on 1 Sep", "checkup_for": "Root canal", "pricing_understood": "needs_explanation"}'),
  pg_temp.ans(62, '2026-08-29T12:00:00+05:00', 'Sample Changed Mind', '0300-5553113', 'NN', '{"wants_treatment": false, "treatment_plan": "Too costly"}'),
  pg_temp.ans(63, '2026-08-29T12:05:00+05:00', 'Sample Changed Mind', '0300-5553113', 'NN', '{"wants_treatment": true, "treatment_plan": "Start next week"}'),
  pg_temp.ans(64, '2026-09-10T12:00:00+05:00', 'Sample Typo One', '0312-0003141', 'NN', '{"checkup_for": "Root canal"}'),
  pg_temp.ans(65, '2026-09-10T12:00:00+05:00', 'Sample Typo Two', '0312-0003142', 'NN', '{"checkup_for": "Extraction"}')));
select pg_temp.check((select array[(r->>'inserted')::int, (r->>'filled_day')::int, (r->>'filled_month')::int, (r->>'same')::int, (r->>'other_answers')::int, (r->>'other_name')::int]
                        from f31_res where n = 'second') = array[3, 2, 1, 0, 2, 0],
  'counts: 1 onto the old list''s row and 2 onto the sheet''s rows; 3 new, 2 of them a second answer that says otherwise; none "same"');
select pg_temp.check((select array_agg(concat_ws('|', source, checkup_date, checkup_for, wants_treatment, treatment_plan, pricing_understood) order by checkup_date)
                        from public.checkups where phone = '0300-5553112')
                     = array['archive|2026-08-01|Braces|f|Too costly|yes', 'google_form|2026-08-20|Root canal|t|Start on 1 Sep|needs_explanation'],
  '(A) the old list''s row takes the 5 Aug answer ("Check up" is no answer and is replaced); the 20 Aug answer is a checkup of its own, every answer kept');
select pg_temp.check((select array_agg(concat_ws('|', source, wants_treatment, treatment_plan) order by created_at) from public.checkups where phone = '0300-5553113')
                     = array['google_form|f|Too costly', 'google_form|t|Start next week'],
  '(C) the same day, 12:00 No then 12:05 Yes: two checkups, the corrected answer is not dropped');
select pg_temp.check((select checkup_for = 'Root canal' and notes is null from public.checkups where sheet_key = 'S-00000000f341')
                     and (select checkup_for = 'checkup / pain' and doctors = 'Dr Hina S'
                             and notes = 'On the Google Form: "Who did your checkup?" Dr. Sample (sample); On the Google Form: "What was your checkup for?" Extraction'
                            from public.checkups where sheet_key = 'S-00000000f342'),
  '(D) "Chek up" is replaced by the answer; "checkup / pain" and the sheet''s doctor stay, and what the form said is in the notes');
insert into f31_res select 'second_again', pg_temp.imp(jsonb_build_array(
  pg_temp.ans(66, '2026-08-29T12:10:00+05:00', 'Sample Changed Mind', '0300-5553113', 'NN', '{"wants_treatment": true, "treatment_plan": "start next week"}'),
  pg_temp.ans(67, '2026-09-10T12:30:00+05:00', 'Sample Typo Two', '0312-0003142', 'NN', '{"checkup_for": "Extraction"}')));
select pg_temp.check((select (r->>'same')::int = 2 and (r->>'inserted')::int = 0 and (r->>'filled_day')::int = 0 from f31_res where n = 'second_again'),
  '"same" only when the checkup holds every answer already, or has it in its notes: the form sent a third time with the 12:05 answers, and Typo Two again');

-- 4. The Google Sheet sync does not see the import.
-- Today's North Nazimabad list: a checkup from the website and one from the sheet. The list's hash before an import with an answer of
-- today for the website's person and answers of earlier days must be the hash after it.
do $$
declare v_nn smallint := current_setting('test.nn')::smallint;
begin
  delete from public.visits where branch_id = v_nn and visit_date = pg_temp.today();
  delete from public.checkups where branch_id = v_nn and checkup_date = pg_temp.today();
  insert into public.checkups (checkup_date, branch_id, patient_name, phone, checkup_for, day_status) values (pg_temp.today(), v_nn, 'Sample Sync Today', '0300-5553120', 'Checkup', 'waiting');
  insert into public.checkups (checkup_date, branch_id, patient_name, phone, checkup_for, day_status, source, sheet_key)
    values (pg_temp.today(), v_nn, 'Sample Sync Sheet', '03120003121', 'checkup', 'waiting', 'google_sheet', 'S-00000000f312');
end $$;
create temp table f31_sync (n text primary key, resp jsonb);
insert into f31_sync select 'before', pg_temp.f31_sync(jsonb_build_object('branch', 'NN', 'hash', null, 'present', jsonb_build_array('S-00000000f312', 'W-' || (pg_temp.one('Sample Sync Today')).id), 'rows', '[]'::jsonb));
create temp table f31_today as select c.id, c.updated_at, private.aaj_day_list(c.branch_id, c.checkup_date) as list from public.checkups c
  where c.patient_name in ('Sample Sync Today', 'Sample Sync Sheet');
insert into f31_res select 'sync', pg_temp.imp(jsonb_build_array(
  pg_temp.ans(30, to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM-DD') || 'T00:00:01+05:00', 'Sample Sync Today', '0300-5553120', 'NN', '{"follow_up": "Follow-up Sent"}'),
  pg_temp.ans(31, to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM-DD') || 'T00:00:02+05:00', 'Sample Sync Sheet', '03120003121', 'NN'),
  pg_temp.ans(32, '2026-08-29T10:00:00+05:00', 'Sample Sync Old', '0300-5553122', 'NN'),
  pg_temp.ans(33, '2026-08-22T18:00:00+05:00', 'Sample Import Sheet', '03120003102', 'NN', '{"notes": "Reminder: start"}')));
select pg_temp.check((select (r->>'inserted')::int = 1 and (r->>'filled_day')::int = 1 and (r->>'skipped_count')::int = 2 from f31_res where n = 'sync'),
  'sync: the two answers of today wait for tomorrow''s import; the old ones are imported');
select pg_temp.check((select bool_and(c.updated_at = t.updated_at and c.ali_recommended is null and c.form_submitted_at is null) from f31_today t join public.checkups c on c.id = t.id)
                     and (select bool_and(private.aaj_day_list(current_setting('test.nn')::smallint, pg_temp.today()) = t.list) from f31_today t),
  'sync: today''s checkups (website and sheet) are not touched, and the list the sheet gets is exactly the list before');
insert into f31_sync select 'after', pg_temp.f31_sync(jsonb_build_object('branch', 'NN', 'hash', (select resp->'tabs'->0->>'hash' from f31_sync where n = 'before'),
  'present', jsonb_build_array('S-00000000f312', 'W-' || (pg_temp.one('Sample Sync Today')).id), 'rows', '[]'::jsonb));
select pg_temp.check((select (resp->'tabs'->0->>'unchanged')::boolean and not (resp->'tabs'->0 ? 'visits')
                             and resp->'tabs'->0->>'hash' = (select resp->'tabs'->0->>'hash' from f31_sync where n = 'before') from f31_sync where n = 'after'),
  'sync: the next call of the sheet''s script gets "unchanged" with the same hash (nothing is pushed into today''s tab)');
select pg_temp.check(not exists (select 1 from public.checkups c where c.source = 'google_form' and private.aaj_date_ok(c.checkup_date))
                     and not exists (select 1 from public.checkups c where c.form_submitted_at is not null and private.aaj_date_ok(c.checkup_date)),
  'sync: no checkup from the Google Form, and no checkup that got its answers, is on a day the sync still keeps (today, or yesterday until 03:00)');
select pg_temp.expect_error($q$select public.aaj_sync('sync-secret-31', '{"date": "2026-08-29", "tabs": []}'::jsonb)$q$, 'DATE_NOT_ALLOWED',
  'sync: a day of the old answers is a day the sync refuses, so its rows are never sent to the sheet');
rollback;
