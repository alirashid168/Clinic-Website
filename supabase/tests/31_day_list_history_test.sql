-- Aaj ki List "End the day" and the History of Aaj ki List (20261012000100_day_list_history.sql). Made-up people only.
--   1. the permission and its defaults;                    2. who may end a day, at which branch, and never a day still to come;
--   3. the copy is built on the server, in list order, with the checkup patients, dues, invoice and doctors;
--   4. ending a day changes nothing on the list (the Google Sheet sync sees the same day);
--   5. ending it again updates the copy (times_updated, who, the audit log keeps the copy it replaced);
--   6. the History: days with and without a copy, counts, filters, paging, never a day still to come, many days;
--   7. one day's list read only (day_list_copy), with dues and phones only for those who may see them;
--   8. RLS and grants: no direct writes for anyone, a branch-limited desk sees its own branch only.
\set ON_ERROR_STOP 1
\set admin   '''00000000-0000-0000-0000-000000003100'''
\set fd      '''00000000-0000-0000-0000-000000003101'''
\set coord   '''00000000-0000-0000-0000-000000003102'''
\set acct    '''00000000-0000-0000-0000-000000003103'''
\set nodues  '''00000000-0000-0000-0000-000000003104'''
\set nophone '''00000000-0000-0000-0000-000000003105'''
\set noend   '''00000000-0000-0000-0000-000000003106'''

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'TEST FAILED: %', msg; end if;
  raise notice 'ok - %', msg;
end $$;
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
create or replace function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, false) $$;
-- The names of a list's rows, in order, joined with " | ".
create or replace function pg_temp.names(p_rows jsonb) returns text language sql as $$
  select string_agg(r->>'name', ' | ' order by o) from jsonb_array_elements(p_rows) with ordinality x(r, o) $$;
grant execute on all functions in schema pg_temp to authenticated, anon;
reset role;
select pg_temp.act_as('');

begin;
select set_config('test.admin', :admin, false), set_config('test.fd', :fd, false), set_config('test.coord', :coord, false),
       set_config('test.acct', :acct, false), set_config('test.nodues', :nodues, false), set_config('test.nophone', :nophone, false),
       set_config('test.noend', :noend, false),
       set_config('test.nn', (select id::text from public.branches where code = 'NN'), false),
       set_config('test.gul', (select id::text from public.branches where code = 'GUL'), false),
       set_config('test.dha', (select id::text from public.branches where code = 'DHA'), false);
insert into auth.users (id, email) values
  (:admin, 'admin31@dralirashid.com'), (:fd, 'fd31@dralirashid.com'), (:coord, 'coord31@dralirashid.com'), (:acct, 'acct31@dralirashid.com'),
  (:nodues, 'nodues31@dralirashid.com'), (:nophone, 'nophone31@dralirashid.com'), (:noend, 'noend31@dralirashid.com');
insert into public.staff (id, full_name, email, role) values
  (:admin,   'Admin Thirtyone', 'admin31@dralirashid.com', 'admin'),
  (:fd,      'Desk Thirtyone', 'fd31@dralirashid.com', 'front_desk'),
  (:coord,   'Coordinator Thirtyone', 'coord31@dralirashid.com', 'coordinator'),
  (:acct,    'Accountant Thirtyone', 'acct31@dralirashid.com', 'accountant'),
  (:nodues,  'Assistant without dues', 'nodues31@dralirashid.com', 'assistant'),
  (:nophone, 'Coordinator without patient files', 'nophone31@dralirashid.com', 'coordinator'),
  (:noend,   'Coordinator who may not end the day', 'noend31@dralirashid.com', 'coordinator');
update public.staff set restrict_to_branches = true, branch_ids = array[current_setting('test.nn')::smallint] where id = :fd;
insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values
  (:nodues, 'dues.view', false), (:nophone, 'patients.view', false), (:noend, 'sheet.end_day', false);

-- The made-up list of North Nazimabad on Monday 14 Sep 2026 (and a little of Gulshan the same day, and of North Nazimabad the day after).
insert into public.patients (mr_number, full_name, phone) values
  ('31001', 'Sample Done One', '03005553101'), ('31002', 'Sample Waiting Three', '03005553102'), ('31003', 'Sample Waiting Two', '03005553103'),
  ('31004', 'Sample In Chair', '03005553104'), ('31005', 'Sample Booked', '03005553105'), ('31006', 'Sample Cancelled', '03005553106'),
  ('31007', 'Sample No Show', '03005553107'), ('31008', 'Sample Done Seven', '0000000'), ('31009', 'Sample Gulshan', '03005553109');
insert into public.clinicians (display_name, is_doctor) values
  ('Dr. Sample Thirtyone', true), ('Assistant Sample Thirtyone', false), ('Dr. Checker Thirtyone', true);

insert into public.visits (patient_id, branch_id, visit_date, status, token_no, treatment_label, details_text, notes, doctor_group_id, created_at)
select p.id, current_setting('test.nn')::smallint, date '2026-09-14', x.status::public.visit_status, x.token, x.treatment, x.details, x.notes, x.grp,
       timestamptz '2026-09-14 09:00+05' + x.minute * interval '1 minute'
  from (values
    ('31001', 'completed',    1,    'Scaling',  'Full mouth scaling', 'Paid part', 2,    1),
    ('31002', 'waiting',      3,    'Checkup',  null, null, null, 2),
    ('31003', 'waiting',      2,    'Filling',  null, null, null, 3),
    ('31004', 'in_treatment', 4,    'RCT',      'Second sitting', null, null, 4),
    ('31005', 'scheduled',    null, 'Crown',    null, null, null, 5),
    ('31006', 'cancelled',    5,    'Checkup',  null, null, null, 6),
    ('31007', 'no_show',      6,    'Checkup',  null, null, null, 7),
    ('31008', 'completed',    7,    'Followup', null, null, null, 8)
  ) as x(mr, status, token, treatment, details, notes, grp, minute)
  join public.patients p on p.mr_number = x.mr;
insert into public.visits (patient_id, branch_id, visit_date, status, token_no, treatment_label)
select id, current_setting('test.gul')::smallint, date '2026-09-14', 'completed', 1, 'Checkup' from public.patients where mr_number = '31009';
insert into public.visit_staff (visit_id, clinician_id, role)
select v.id, c.id, x.role::public.visit_staff_role
  from public.visits v join public.patients p on p.id = v.patient_id and p.mr_number = '31001'
  cross join (values ('Dr. Sample Thirtyone', 'doctor'), ('Assistant Sample Thirtyone', 'assistant'), ('Dr. Checker Thirtyone', 'checker')) x(name, role)
  join public.clinicians c on c.display_name = x.name;
-- Money: Done One owes 3,000 of a 5,000 invoice made that day at that branch; In Chair owes 1,000 of an invoice from another day and branch.
insert into public.invoices (patient_id, branch_id, issue_date, subtotal, status)
select id, current_setting('test.nn')::smallint, date '2026-09-14', 5000, 'issued' from public.patients where mr_number = '31001';
insert into public.payments (patient_id, branch_id, amount, method)
select id, current_setting('test.nn')::smallint, 2000, 'cash' from public.patients where mr_number = '31001';
insert into public.invoices (patient_id, branch_id, issue_date, subtotal, status)
select id, current_setting('test.gul')::smallint, date '2026-09-01', 1000, 'issued' from public.patients where mr_number = '31004';
-- Checkup patients of that day (no Mr#), and three that must not be on North Nazimabad's list: one who has become a patient with a
-- visit on that list, an old-list month row, and one at Gulshan.
insert into public.checkups (checkup_date, branch_id, patient_name, phone, checkup_for, token, day_status, source, created_at) values
  ('2026-09-14', current_setting('test.nn')::smallint, 'Checkup Waiting One',  '0300-5553111', 'Checkup', '1',     'waiting',   'website', '2026-09-14 10:01+05'),
  ('2026-09-14', current_setting('test.nn')::smallint, 'Checkup Not Set',      '0300-5553112', 'Checkup', null,    null,        'website', '2026-09-14 10:02+05'),
  ('2026-09-14', current_setting('test.nn')::smallint, 'Checkup Done Kit',     '0300-5553113', 'Scaling', 'kit A', 'completed', 'google_sheet', '2026-09-14 10:03+05'),
  ('2026-09-14', current_setting('test.nn')::smallint, 'Checkup Waiting Nine', '0300-5553114', 'Checkup', ' 9 ',   'waiting',   'website', '2026-09-14 10:04+05'),
  ('2026-09-14', current_setting('test.gul')::smallint, 'Checkup Gulshan',     '0300-5553115', 'Checkup', null,    'waiting',   'website', '2026-09-14 10:05+05');
insert into public.checkups (checkup_date, branch_id, patient_name, phone, checkup_for, day_status, source, patient_id)
select '2026-09-14', current_setting('test.nn')::smallint, 'Checkup Now Patient', '03005553102', 'Checkup', 'completed', 'website', id
  from public.patients where mr_number = '31002';
insert into public.checkups (checkup_date, date_is_month, branch_id, patient_name, phone, checkup_for, source)
values ('2026-09-14', true, current_setting('test.nn')::smallint, 'Checkup Old Month Row', '0300-5553116', 'Checkup', 'archive');
-- North Nazimabad on 15 Sep: only one checkup patient. And a booking for tomorrow, a day that has not come yet.
insert into public.checkups (checkup_date, branch_id, patient_name, phone, checkup_for, day_status, source)
values ('2026-09-15', current_setting('test.nn')::smallint, 'Checkup Next Day', '0300-5553117', 'Checkup', 'completed', 'website');
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label)
select id, current_setting('test.nn')::smallint, (now() at time zone 'Asia/Karachi')::date + 1, 'scheduled', 'Checkup' from public.patients where mr_number = '31005';

-- 1. The permission: in the grid under "Daily list", on for the roles that may edit the list, and for admin.
do $$
begin
  perform pg_temp.check(exists (select 1 from public.permissions where key = 'sheet.end_day' and label = 'End the day on the Aaj ki List' and category = 'Daily list'),
    'permission: "End the day on the Aaj ki List" is in the access list under Daily list');
  perform pg_temp.check((select string_agg(role::text || '=' || allowed, ',' order by role) from public.role_permissions where permission_key = 'sheet.end_day')
    = 'front_desk=true,assistant=true,doctor=true,coordinator=true,accountant=false,admin=true',
    'permission: on by default for front desk, assistant, doctor and coordinator (the roles with sheet.edit) and admin; off for the accountant');
  perform pg_temp.check((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'end_day') = 1
    and (select pg_get_function_identity_arguments(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'end_day')
        = 'p_branch smallint, p_date date',
    'end_day takes only the branch and the day: nothing the browser sends is stored');
  perform pg_temp.check(to_regclass('public.checkups_branch_day_idx') is not null and to_regclass('public.visits_branch_date_idx') is not null,
    'indexes: checkups (branch_id, checkup_date) and visits (branch_id, visit_date) are there for the day lists');
end $$;

-- 2. Who may end a day, where, and when.
set role authenticated;
select pg_temp.act_as('');
select pg_temp.expect_state($$select public.end_day(1::smallint, date '2026-09-14')$$, '42501', 'NOT_ALLOWED', 'end_day: nobody signed in is refused');
select pg_temp.act_as(:acct);
select pg_temp.expect_state(format('select public.end_day(%s::smallint, date %L)', current_setting('test.nn'), '2026-09-14'), '42501', 'NOT_ALLOWED: ending the day needs',
  'end_day: an accountant (no "End the day" by default) is refused');
select pg_temp.act_as(:noend);
select pg_temp.expect_state(format('select public.end_day(%s::smallint, date %L)', current_setting('test.nn'), '2026-09-14'), '42501', 'NOT_ALLOWED',
  'end_day: a coordinator whose "End the day" is switched off in the access list is refused');
select pg_temp.act_as(:fd);
select pg_temp.expect_state(format('select public.end_day(%s::smallint, date %L)', current_setting('test.gul'), '2026-09-14'), '42501', 'only at the branches you work at',
  'end_day: a desk limited to North Nazimabad cannot end Gulshan''s day');
select pg_temp.expect_state(format('select public.end_day(%s::smallint, %L::date)', current_setting('test.nn'), (now() at time zone 'Asia/Karachi')::date + 1), '22023', 'FUTURE_DAY',
  'end_day: a day that has not come yet is refused');
select pg_temp.expect_state('select public.end_day(999::smallint, date ''2026-09-14'')', '22023', 'BAD_REQUEST', 'end_day: an unknown branch is refused');
select pg_temp.expect_state('select public.end_day(null::smallint, date ''2026-09-14'')', '22023', 'BAD_REQUEST', 'end_day: no branch is refused');
reset role;

-- 3 and 4. The desk ends North Nazimabad's day: the copy is built on the server in the Aaj ki List's order; the list itself is unchanged.
create temp table t31_before as
  select (select string_agg(md5(v::text), ',' order by v.id) from public.visits v) as visits,
         (select string_agg(md5(c::text), ',' order by c.id) from public.checkups c) as checkups,
         private.aaj_day_list(current_setting('test.nn')::smallint, date '2026-09-14') as sync_day,
         (select count(*) from public.audit_log where table_name in ('visits', 'checkups', 'visit_staff')) as audits;
set role authenticated;
select pg_temp.act_as(:fd);
create temp table t31_end1 as select public.end_day(current_setting('test.nn')::smallint, date '2026-09-14') as r;
reset role;
do $$
declare
  v_nn smallint := current_setting('test.nn')::smallint;
  r jsonb := (select t.r from t31_end1 t);
  d public.day_list_closings;
  s jsonb;
  done jsonb; kit jsonb; inchair jsonb; seven jsonb;
begin
  select * into d from public.day_list_closings where branch_id = v_nn and list_date = '2026-09-14';
  s := d.snapshot;
  perform pg_temp.check(d.id is not null and d.times_updated = 0 and d.closed_by = current_setting('test.fd')::uuid and d.closed_by_name = 'Desk Thirtyone',
    'end_day: the copy is saved once, with who ended the day (times_updated 0)');
  perform pg_temp.check(pg_temp.names(s) = 'Sample Waiting Two | Sample Waiting Three | Checkup Waiting One | Checkup Waiting Nine | Sample In Chair | Sample Booked | '
    || 'Checkup Not Set | Sample Done One | Sample Done Seven | Checkup Done Kit | Sample Cancelled | Sample No Show',
    'copy: in the Aaj ki List order (Waiting, In treatment, Scheduled, no status, Completed, Cancelled, No show; patients before checkups; by token)');
  perform pg_temp.check((select bool_and((r2->>'n')::int = o) from jsonb_array_elements(s) with ordinality x(r2, o)), 'copy: every row has its serial number 1..n');
  perform pg_temp.check(pg_temp.names(s) not like '%Now Patient%' and pg_temp.names(s) not like '%Old Month Row%' and pg_temp.names(s) not like '%Gulshan%',
    'copy: without the checkup of a person with a visit on the list, the old list''s month row and the other branch''s rows');
  done := (select x from jsonb_array_elements(s) x where x->>'name' = 'Sample Done One');
  perform pg_temp.check(done->>'kind' = 'patient' and done->>'mr' = '31001' and (done->>'dues')::numeric = 3000 and (done->>'has_invoice')::boolean
    and done->>'status' = 'completed' and done->>'token' = '1' and done->>'group' = 'Group 2' and done->>'treatment' = 'Scaling'
    and done->>'details' = 'Full mouth scaling' and done->>'notes' = 'Paid part' and done->>'phone' = '03005553101',
    'copy: a patient row has the Mr#, status, token, group, treatment, details, notes, phone, dues at that moment (3,000) and "has invoice"');
  perform pg_temp.check(done->>'doctors' = 'Dr. Sample Thirtyone, Assistant Sample Thirtyone (assistant), ✓ Dr. Checker Thirtyone',
    'copy: the doctors by name, the assistant marked, the checker with a tick');
  inchair := (select x from jsonb_array_elements(s) x where x->>'name' = 'Sample In Chair');
  perform pg_temp.check((inchair->>'dues')::numeric = 1000 and not (inchair->>'has_invoice')::boolean,
    'copy: dues come from every invoice, "has invoice" only from one for this visit or this day at this branch');
  seven := (select x from jsonb_array_elements(s) x where x->>'name' = 'Sample Done Seven');
  perform pg_temp.check(seven->>'phone' is null and (seven->>'dues')::numeric = 0, 'copy: the placeholder phone 0000000 is left out; no dues is 0');
  kit := (select x from jsonb_array_elements(s) x where x->>'name' = 'Checkup Done Kit');
  perform pg_temp.check(kit->>'kind' = 'checkup' and kit->>'mr' is null and kit->>'token' = 'kit A' and kit->>'dues' is null and kit->>'phone' = '0300-5553113'
    and kit->>'treatment' = 'Scaling' and not (kit->>'has_invoice')::boolean,
    'copy: a checkup row has no Mr# and no dues, and keeps its token text and phone');
  perform pg_temp.check((select x->>'status' from jsonb_array_elements(s) x where x->>'name' = 'Checkup Not Set') is null, 'copy: a checkup with no status has none');
  perform pg_temp.check(d.counts = '{"total": 12, "completed": 3, "waiting": 4, "in_treatment": 1, "scheduled": 1, "cancelled": 1, "no_show": 1, "not_set": 1, "checkups": 4}'::jsonb,
    'copy: the counts (12 rows: 3 completed, 4 waiting, 1 in treatment, 1 scheduled, 1 cancelled, 1 no show, 1 not set; 4 checkups)');
  perform pg_temp.check(r->>'total' = '12' and r->>'completed' = '3' and r->>'times_updated' = '0' and r->>'closed_by_name' = 'Desk Thirtyone' and r->>'list_date' = '2026-09-14',
    'end_day: answers with the counts, the day and who ended it');
  -- 4. Nothing on the list was changed, and the Google Sheet sync sees exactly the same day.
  perform pg_temp.check((select b.visits = (select string_agg(md5(v::text), ',' order by v.id) from public.visits v)
                            and b.checkups = (select string_agg(md5(c::text), ',' order by c.id) from public.checkups c) from t31_before b),
    'end_day changes no visit and no checkup');
  perform pg_temp.check((select b.sync_day = private.aaj_day_list(v_nn, date '2026-09-14') from t31_before b),
    'the Google Sheet sync''s list of that day is the same after ending it');
  perform pg_temp.check((select b.audits = (select count(*) from public.audit_log where table_name in ('visits', 'checkups', 'visit_staff')) from t31_before b),
    'end_day writes no audit row of a visit or checkup (nothing changed)');
  perform pg_temp.check((select count(*) from public.audit_log where table_name = 'day_list_closings' and action = 'END_DAY' and row_id = d.id::text
                           and actor = current_setting('test.fd')::uuid and old_data is null and new_data->>'list_date' = '2026-09-14') = 1,
    'audit log: the first end of the day is recorded with who did it');
  perform pg_temp.check(not exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname in ('end_day', 'day_list_rows', 'day_list_checkups')),
    'no trigger runs any of this: the sync and the list work as before');
end $$;

-- 5. The list changes after the day was ended (a waiting patient is finished); the coordinator ends the day again.
update public.visits set status = 'completed' where patient_id = (select id from public.patients where mr_number = '31003') and visit_date = '2026-09-14';
set role authenticated;
select pg_temp.act_as(:coord);
create temp table t31_end2 as select public.end_day(current_setting('test.nn')::smallint, date '2026-09-14') as r;
reset role;
do $$
declare
  v_nn smallint := current_setting('test.nn')::smallint;
  d public.day_list_closings;
  a public.audit_log;
begin
  select * into d from public.day_list_closings where branch_id = v_nn and list_date = '2026-09-14';
  perform pg_temp.check(d.times_updated = 1 and d.closed_by = current_setting('test.coord')::uuid and d.closed_by_name = 'Coordinator Thirtyone'
    and (select count(*) from public.day_list_closings where branch_id = v_nn and list_date = '2026-09-14') = 1,
    'ending again: still one copy, times_updated 1, with who ended it last');
  perform pg_temp.check(d.counts->>'completed' = '4' and d.counts->>'waiting' = '3' and (select t.r->>'times_updated' from t31_end2 t) = '1',
    'ending again: the copy is the list as it is now (4 completed, 3 waiting)');
  perform pg_temp.check(pg_temp.names(d.snapshot) like '%Sample In Chair | Sample Booked | Checkup Not Set | Sample Done One | Sample Waiting Two | Sample Done Seven%',
    'ending again: the finished patient moved among the completed ones, by token');
  select * into a from public.audit_log where table_name = 'day_list_closings' and action = 'END_DAY' and row_id = d.id::text order by id desc limit 1;
  perform pg_temp.check(a.actor = current_setting('test.coord')::uuid and a.old_data->>'times_updated' = '0' and jsonb_array_length(a.old_data->'snapshot') = 12
    and a.old_data->'counts'->>'completed' = '3' and a.new_data->>'times_updated' = '1',
    'audit log: ending again keeps the copy it replaced (nothing is lost)');
end $$;

-- Gulshan's day is ended by the admin (for the branch tests below); North Nazimabad's list changes once more (the copy stays).
set role authenticated;
select pg_temp.act_as(:admin);
select public.end_day(current_setting('test.gul')::smallint, date '2026-09-14');
reset role;
create temp table t31_snap as select snapshot from public.day_list_closings where branch_id = current_setting('test.nn')::smallint and list_date = '2026-09-14';
grant select on t31_snap to authenticated;
update public.visits set status = 'completed' where patient_id = (select id from public.patients where mr_number = '31002') and visit_date = '2026-09-14';
select pg_temp.check((private.day_list_live_counts(current_setting('test.nn')::smallint, '2026-09-14'))->>'completed' = '5',
  'the stored list of 14 Sep has 5 completed now (one more than the copy)');

-- 6. The History.
set role authenticated;
select pg_temp.act_as(:coord);
do $$
declare
  v_nn smallint := current_setting('test.nn')::smallint; v_gul smallint := current_setting('test.gul')::smallint;
  h text; n bigint; r record;
begin
  select string_agg(x.list_date || ' ' || x.branch_name || ' ' || x.ended || ' ' || (x.counts->>'total') || '/' || (x.counts->>'completed'), '; ' order by x.o),
         max(x.total_count)
    into h, n
    from public.day_list_history(null, '2026-09-14', '2026-09-15')
         with ordinality x(list_date, branch_id, branch_name, ended, closed_at, closed_by_name, times_updated, counts, total_count, o);
  perform pg_temp.check(h = '2026-09-15 North Nazimabad false 1/1; 2026-09-14 Gulshan (RJ Mall) true 2/1; 2026-09-14 North Nazimabad true 12/4' and n = 3,
    'history: one line per day and branch, newest first, then the branches in their usual order; a day with only a checkup patient is listed too');
  select * into r from public.day_list_history(null, '2026-09-14', '2026-09-15') x limit 1;
  perform pg_temp.check(r.list_date = '2026-09-15' and not r.ended and r.closed_at is null and r.closed_by_name is null and r.times_updated is null
    and r.counts = '{"total": 1, "completed": 1, "waiting": 0, "in_treatment": 0, "scheduled": 0, "cancelled": 0, "no_show": 0, "not_set": 0, "checkups": 1}'::jsonb
    and r.branch_name = 'North Nazimabad',
    'history: a day that was not ended says so, with the counts of what is stored now');
  select * into r from public.day_list_history(v_nn, '2026-09-14', '2026-09-14') x;
  perform pg_temp.check(r.ended and r.closed_by_name = 'Coordinator Thirtyone' and r.times_updated = 1 and r.closed_at is not null and r.counts->>'completed' = '4',
    'history: an ended day shows the saved copy''s counts (4 completed), not the list as changed since (5), and who ended it');
  -- Filters and paging.
  perform pg_temp.check((select count(*) from public.day_list_history(v_nn, '2026-09-14', '2026-09-15')) = 2, 'history: the branch filter');
  perform pg_temp.check((select count(*) from public.day_list_history(null, '2026-09-15', '2026-09-15')) = 1, 'history: the date filter (one day)');
  perform pg_temp.check((select string_agg(x.list_date || '/' || x.branch_id || '/' || x.total_count, ',') from public.day_list_history(null, '2026-09-14', '2026-09-15', 1, 1) x)
    = format('2026-09-14/%s/3', v_gul), 'history: paging (one line a page, the second page), with the number of all lines');
  perform pg_temp.check((select count(*) from public.day_list_history(null, '2026-09-14', '2026-09-15', 60, 3)) = 0, 'history: a page after the last one is empty');
  perform pg_temp.check((select count(*) from public.day_list_history(null, '2026-09-14', '2026-09-15', 0, 0)) = 1
    and (select count(*) from public.day_list_history(null, '2026-09-14', '2026-09-15', -5, -5)) = 1, 'history: a page of 0 or less is one line, a negative offset is the start');
  -- Never a day that has not come yet (the booking for tomorrow), even when asked for.
  perform pg_temp.check(not exists (select 1 from public.day_list_history(v_nn, '2026-09-14', (now() at time zone 'Asia/Karachi')::date + 30) x
                                     where x.list_date > (now() at time zone 'Asia/Karachi')::date),
    'history: a day still to come is never listed (a booking for tomorrow is not a list yet)');
  -- With no dates: everything up to today, newest first.
  perform pg_temp.check((select bool_and(x.list_date <= (now() at time zone 'Asia/Karachi')::date) from public.day_list_history() x)
    and exists (select 1 from public.day_list_history(v_nn) x where x.list_date = '2026-09-14' and x.ended), 'history: no dates = every day up to today');
end $$;
reset role;

-- Many days: a year of lists at DHA (one visit a day). The History pages through them without counting them all.
insert into public.visits (patient_id, branch_id, visit_date, status, token_no, treatment_label)
select (select id from public.patients where mr_number = '31009'), current_setting('test.dha')::smallint, d::date, 'completed', 1, 'Checkup'
  from generate_series(date '2025-01-01', date '2025-12-31', interval '1 day') d;
set role authenticated;
select pg_temp.act_as(:coord);
do $$
declare v_dha smallint := current_setting('test.dha')::smallint;
begin
  perform pg_temp.check((select max(x.total_count) from public.day_list_history(v_dha, '2025-01-01', '2025-12-31') x) = 365
    and (select count(*) from public.day_list_history(v_dha, '2025-01-01', '2025-12-31')) = 60
    and (select min(x.list_date) || '..' || max(x.list_date) from public.day_list_history(v_dha, '2025-01-01', '2025-12-31') x) = '2025-11-02..2025-12-31',
    'history: a year of days at one branch: 365 lines, 60 a page, the newest first');
  perform pg_temp.check((select string_agg(x.list_date::text, ',') from public.day_list_history(v_dha, '2025-01-01', '2025-12-31', 60, 360) x)
    = '2025-01-05,2025-01-04,2025-01-03,2025-01-02,2025-01-01', 'history: the last page has the oldest days');
end $$;
reset role;

-- 7. One day's list, read only.
set role authenticated;
do $$
declare
  v_nn smallint := current_setting('test.nn')::smallint;
  c jsonb;
begin
  perform pg_temp.act_as(current_setting('test.coord'));
  c := public.day_list_copy(v_nn, '2026-09-14');
  perform pg_temp.check((c->>'ended')::boolean and c->>'closed_by_name' = 'Coordinator Thirtyone' and c->>'branch_name' = 'North Nazimabad'
    and jsonb_array_length(c->'rows') = 12 and c->'counts'->>'completed' = '4'
    and (select (x->>'dues')::numeric from jsonb_array_elements(c->'rows') x where x->>'name' = 'Sample Done One') = 3000,
    'copy for reading: an ended day gives the saved copy (as it was when ended), with dues for a coordinator');
  perform pg_temp.check((select x->>'status' from jsonb_array_elements(c->'rows') x where x->>'name' = 'Sample Waiting Three') = 'waiting',
    'copy for reading: a change made after the day was ended is not in the copy');
  c := public.day_list_copy(v_nn, '2026-09-15');
  perform pg_temp.check(not (c->>'ended')::boolean and c->>'closed_at' is null and pg_temp.names(c->'rows') = 'Checkup Next Day' and c->'counts'->>'total' = '1',
    'copy for reading: a day that was not ended gives the list as it is stored now');
  perform pg_temp.check(public.day_list_copy(v_nn, '2026-09-14')->'rows' = (select snapshot from t31_snap), 'copy for reading: exactly the saved rows');

  perform pg_temp.act_as(current_setting('test.nodues'));
  c := public.day_list_copy(v_nn, '2026-09-14');
  perform pg_temp.check(not exists (select 1 from jsonb_array_elements(c->'rows') x where x ? 'dues') and jsonb_array_length(c->'rows') = 12
    and (select x->>'phone' from jsonb_array_elements(c->'rows') x where x->>'name' = 'Sample Done One') = '03005553101',
    'copy for reading: without "See pending dues" the rows come without dues');
  perform pg_temp.act_as(current_setting('test.nophone'));
  c := public.day_list_copy(v_nn, '2026-09-14');
  perform pg_temp.check(not exists (select 1 from jsonb_array_elements(c->'rows') x where x->>'kind' = 'patient' and x ? 'phone')
    and (select x->>'phone' from jsonb_array_elements(c->'rows') x where x->>'name' = 'Checkup Done Kit') = '0300-5553113'
    and (select (x->>'dues')::numeric from jsonb_array_elements(c->'rows') x where x->>'name' = 'Sample Done One') = 3000,
    'copy for reading: without "View patient profiles" the patients'' phones are left out (checkup phones stay, as on the Checkups page)');

  perform pg_temp.act_as(current_setting('test.fd'));
  perform pg_temp.check(jsonb_array_length(public.day_list_copy(v_nn, '2026-09-14')->'rows') = 12, 'copy for reading: the desk reads its own branch''s day');
  perform pg_temp.expect_state(format('select public.day_list_copy(%s::smallint, date %L)', current_setting('test.gul'), '2026-09-14'), '42501', 'NOT_ALLOWED',
    'copy for reading: a desk limited to North Nazimabad cannot read Gulshan''s day');
  perform pg_temp.act_as('');
  perform pg_temp.expect_state(format('select public.day_list_copy(%s::smallint, date %L)', v_nn, '2026-09-14'), '42501', 'NOT_ALLOWED', 'copy for reading: nobody signed in is refused');
  perform pg_temp.expect_state('select count(*) from public.day_list_history()', '42501', 'NOT_ALLOWED', 'history: nobody signed in is refused');
end $$;
reset role;

-- 8. RLS and grants.
set role authenticated;
do $$
declare v_nn smallint := current_setting('test.nn')::smallint; v_gul smallint := current_setting('test.gul')::smallint;
begin
  -- A desk limited to North Nazimabad sees only its branch: in the History, and in the table.
  perform pg_temp.act_as(current_setting('test.fd'));
  perform pg_temp.check((select array_agg(distinct x.branch_id) from public.day_list_history(null, '2026-09-14', '2026-09-15') x) = array[v_nn],
    'history: a desk limited to North Nazimabad sees only North Nazimabad''s lines');
  perform pg_temp.expect_state(format('select count(*) from public.day_list_history(%s::smallint)', v_gul), '42501', 'NOT_ALLOWED',
    'history: and cannot ask for Gulshan''s');
  perform pg_temp.check((select count(*) from public.day_list_closings where list_date = '2026-09-14') = 1
    and (select branch_id from public.day_list_closings where list_date = '2026-09-14') = v_nn,
    'table: the desk reads North Nazimabad''s line only (Gulshan''s copy is hidden by RLS)');
  perform pg_temp.check((select closed_by_name || '/' || times_updated || '/' || (counts->>'total') from public.day_list_closings where branch_id = v_nn and list_date = '2026-09-14')
    = 'Coordinator Thirtyone/1/12', 'table: the line''s columns can be read directly');
  perform pg_temp.expect_state('select snapshot from public.day_list_closings', '42501', 'permission denied', 'table: the copy itself is not read directly (only through day_list_copy)');
  perform pg_temp.expect_state('select * from public.day_list_closings', '42501', 'permission denied', 'table: neither with select *');
  -- Nobody writes a copy by hand, Dr. Ali included.
  perform pg_temp.act_as(current_setting('test.admin'));
  perform pg_temp.expect_state(format('insert into public.day_list_closings (branch_id, list_date) values (%s, %L)', v_nn, '2026-09-13'), '42501', 'permission denied',
    'table: admin cannot insert a copy directly');
  perform pg_temp.expect_state('update public.day_list_closings set times_updated = 9', '42501', 'permission denied', 'table: admin cannot change a copy directly');
  perform pg_temp.expect_state('delete from public.day_list_closings', '42501', 'permission denied', 'table: admin cannot delete a copy directly');
  perform pg_temp.act_as(current_setting('test.fd'));
  perform pg_temp.expect_state('update public.day_list_closings set closed_by_name = ''x''', '42501', 'permission denied', 'table: the desk cannot change a copy directly');
  -- The accountant reads (sheet.view) but cannot end.
  perform pg_temp.act_as(current_setting('test.acct'));
  perform pg_temp.check((select count(*) from public.day_list_history(null, '2026-09-14', '2026-09-15')) = 3, 'history: the accountant (View Aaj ki List) reads the History');
end $$;
reset role;

do $$
begin
  perform pg_temp.check(not has_function_privilege('anon', 'public.end_day(smallint, date)', 'execute')
    and not has_function_privilege('anon', 'public.day_list_history(smallint, date, date, integer, integer)', 'execute')
    and not has_function_privilege('anon', 'public.day_list_copy(smallint, date)', 'execute')
    and has_function_privilege('authenticated', 'public.end_day(smallint, date)', 'execute')
    and has_function_privilege('authenticated', 'public.day_list_history(smallint, date, date, integer, integer)', 'execute')
    and has_function_privilege('authenticated', 'public.day_list_copy(smallint, date)', 'execute'),
    'grants: the three functions are for signed-in staff only');
  perform pg_temp.check(not has_table_privilege('anon', 'public.day_list_closings', 'select')
    and not has_table_privilege('authenticated', 'public.day_list_closings', 'insert') and not has_table_privilege('authenticated', 'public.day_list_closings', 'update')
    and not has_table_privilege('authenticated', 'public.day_list_closings', 'delete')
    and has_column_privilege('authenticated', 'public.day_list_closings', 'counts', 'select')
    and not has_column_privilege('authenticated', 'public.day_list_closings', 'snapshot', 'select'),
    'grants: the public has no access; staff may read the line''s columns but not the copy, and write nothing');
  perform pg_temp.check(not has_function_privilege('authenticated', 'private.day_list_rows(smallint, date)', 'execute')
    and not has_function_privilege('authenticated', 'private.day_list_live_counts(smallint, date)', 'execute'),
    'grants: the builders in schema private are not callable by staff');
end $$;
rollback;
