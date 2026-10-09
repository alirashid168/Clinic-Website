-- New Mr# from 50000 and front desk portal logins (20261009000400_mr_50000_front_desk_portal.sql).
-- This test runs THE MIGRATION FILE ITSELF (\ir) on patients set up like the live ones, and proves:
--   * the 11 patients the website numbered 10000-10012 (gaps at 10004 and 10010) move to 50000-50012, gaps kept,
--     each with exactly one audit row (old and new Mr#) and a note saying what the old Mr# was (an earlier note is kept);
--     the other patients are left alone;
--   * a Healthwire-style 10001 created AFTER the cut-off (10 Oct 2026, Pakistan time) is never touched, and the cut-off
--     moment itself is on the "left alone" side; a number the counter has not given out yet is never touched either;
--   * a second run is safe because of the COUNTER, not the creation date: once it is at 50000 or more, Healthwire numbers
--     that look old (imported with an old date, an old Aaj ki List row, a Mr# the admin edited) are not moved;
--   * when a new number is already taken, or a patient to renumber has a portal login, the renumbering refuses and
--     changes nothing;
--   * patients that are Healthwire's own (legacy source healthwire, or Healthwire invoices, payments or visits on them) are never
--     moved, even when they sit below the counter and were made before the cut-off (scenario 9);
--   * the last result row of the file can say how many patients this run moved and which (the session settings it is built
--     from are checked: 11 and the list on the first run, 0 and nothing on the second);
--   * the next registered patient gets 50013, and sync_mr_sequence() can never put the counter below 50000 nor move it
--     backwards: a number given out is not given out again after its patient was merged away or deleted (scenarios 4 and 10);
--   * signed-in and anonymous users cannot touch the counter, and the front desk can still register patients;
--   * the front desk has portal.invite and no other grid cell changed;
--   * running the file a second time changes nothing at all (not even an audit row).
-- NOT done here, and why:
--   (1) that the whole FILE stops without a trace when a step is refused. The refusals are checked on the renumbering
--       function (scenarios 3 and 7), because a SQL test cannot carry on after a script has stopped. The file is one
--       begin ... commit with the renumbering as its first data step, and it was also checked by running the file with a number
--       taken and rolling back (Mr#s, counter, grid and audit count all as before).
--   (2) the table lock at the start of the file: it needs two sessions at once. tests/mr-50000-migration.test.mjs checks
--       that the file takes the lock before anything else.
-- The file ends with COMMIT, so this test cannot sit inside a transaction of its own: it works in autocommit and
-- removes everything it made at the end (patients, staff, audit rows, the counter and the grid cell are put back).
-- Earlier test files (10, 11) leave their patients behind, some with a Mr# of five digits (the new 50000, 50001 of
-- test 10): those are parked under another Mr# for the length of this test and given their number back at the end.
\set ON_ERROR_STOP 1

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
  raise notice 'ok - % (blocked: %)', msg, left(sqlerrm, 90);
end $$;
-- The next Mr# the counter will hand out.
create or replace function pg_temp.next_mr() returns bigint language sql as $$
  select case when is_called then last_value + 1 else last_value end from public.mr_number_seq $$;
-- Register a patient the way the website does (no Mr#) and give back the Mr# the database chose.
create or replace function pg_temp.register(p_name text) returns text language plpgsql as $$
declare v text;
begin
  insert into public.patients (full_name, phone, first_branch_id) values (p_name, '03002600999', 1) returning mr_number into v;
  return v;
end $$;
-- A fingerprint of every patient (number, notes, updated_at): equal before and after means nothing was touched.
create or replace function pg_temp.patients_md5() returns text language sql as $$
  select md5(string_agg(id::text || ':' || mr_number || ':' || updated_at::text || ':' || coalesce(notes, ''), ',' order by id)) from public.patients $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

-- What to put back at the end.
create temp table t26_start as
  select coalesce((select max(id) from public.audit_log), 0) as audit_id,
         (select last_value from public.mr_number_seq) as last_value,
         (select is_called from public.mr_number_seq) as is_called;
create temp table t26_parked as select id, mr_number from public.patients where mr_number ~ '^[0-9]{5,15}$';
update public.patients p set mr_number = 'parked-' || k.mr_number from t26_parked k where k.id = p.id;
select pg_temp.check(not exists (select 1 from public.patients where mr_number ~ '^[0-9]{5,15}$'),
  'start: no patient holds a Mr# of five digits or more (leftovers of earlier tests are parked)');

-- =====================================================================
-- Scenario 1: the live database. The 11 website-numbered patients (the Aaj ki List import of 6 Oct), a Healthwire patient
-- and an odd legacy number; the counter at 10012; the front desk not yet allowed to make portal logins.
-- =====================================================================
create temp table t26_live as
  select gen_random_uuid() as id, n::text as old_mr, (n + 40000)::text as new_mr
    from unnest(array[10000, 10001, 10002, 10003, 10005, 10006, 10007, 10008, 10009, 10011, 10012]) as n;
insert into public.patients (id, mr_number, full_name, phone, first_branch_id, legacy_source, legacy_name, created_at, notes)
select id, old_mr, 'Mr26 Website ' || old_mr, '03002600' || right(old_mr, 3), 1, 'aaj_ki_list', 'Mr26 Website ' || old_mr, '2026-10-06 11:00+05',
       case old_mr when '10003' then 'Wants evening slots' end from t26_live;
insert into public.patients (mr_number, full_name, phone, first_branch_id, legacy_source, created_at) values
  ('9846',  'Mr26 Healthwire 9846', '03002600846', 1, 'healthwire',  '2026-10-05 10:00+05'),
  ('2600-1', 'Mr26 Odd Legacy',      '03002600347', 1, 'aaj_ki_list', '2026-10-05 10:00+05');
select setval('public.mr_number_seq', 10012, true);
update public.role_permissions set allowed = false where role = 'front_desk' and permission_key = 'portal.invite';
create temp table t26_grid_before as select * from public.role_permissions;
create temp table t26_hw_before as select id, mr_number, updated_at from public.patients where mr_number in ('9846', '2600-1');

select pg_temp.check((select count(*) from public.patients where mr_number ~ '^10[0-9]{3}$') = 11 and pg_temp.next_mr() = 10013,
  'before: 11 patients hold 10000-10012 (gaps 10004, 10010) and the next number would be 10013');

\ir ../migrations/20261009000400_mr_50000_front_desk_portal.sql

select pg_temp.check((select count(*) from t26_live l join public.patients p on p.id = l.id and p.mr_number = l.new_mr) = 11,
  'the 11 patients moved by +40000: 10000-10012 became 50000-50012');
-- What the last result row of the file shows (the SQL Editor shows only that row, not the notices): how many, and which.
select pg_temp.check(current_setting('mr_50000.moved_count') = '11',
  'the result row says 11 patients were renumbered by this run');
select pg_temp.check(current_setting('mr_50000.moved') = '10000 -> 50000, 10001 -> 50001, 10002 -> 50002, 10003 -> 50003, 10005 -> 50005, 10006 -> 50006, 10007 -> 50007, 10008 -> 50008, 10009 -> 50009, 10011 -> 50011, 10012 -> 50012',
  'the result row lists every old and new number, so the front desk can be given the list');
select pg_temp.check((select string_agg(mr_number, ',' order by mr_number) from public.patients where full_name like 'Mr26 Website %')
                      = '50000,50001,50002,50003,50005,50006,50007,50008,50009,50011,50012',
  'the numbers are exactly 50000-50003, 50005-50009, 50011, 50012: the gaps at 50004 and 50010 stay');
select pg_temp.check(not exists (select 1 from public.patients where mr_number ~ '^10[0-9]{3}$'),
  'nobody holds a number in 10000-10999 any more');
select pg_temp.check((select count(*) from t26_hw_before b join public.patients p using (id) where p.mr_number = b.mr_number and p.updated_at = b.updated_at) = 2,
  'a Healthwire number (9846) and an odd legacy number (2600-1) are untouched');
select pg_temp.check((select count(*) from t26_live l join public.audit_log a on a.table_name = 'patients' and a.row_id = l.id::text and a.action = 'UPDATE'
                       and a.old_data ->> 'mr_number' = l.old_mr and a.new_data ->> 'mr_number' = l.new_mr) = 11,
  'audit: one UPDATE row per renumbered patient, holding the old and the new Mr#');
select pg_temp.check((select count(*) from t26_live l join public.audit_log a on a.table_name = 'patients' and a.row_id = l.id::text) = 22,
  'audit: nothing is doubled up (each patient has its INSERT and its one UPDATE, no other rows)');
-- The old number is kept where staff can see it: the note on the patient (a printed invoice or a paper may still carry it).
select pg_temp.check((select count(*) from t26_live l join public.patients p on p.id = l.id
                       where l.old_mr <> '10003' and p.notes like 'Mr# was ' || l.old_mr || ' until __ ___ 20__ (the website now numbers from 50000)') = 10,
  'each moved patient has a note with the old Mr# and the date (the 10 that had no note before)');
select pg_temp.check((select notes from public.patients where mr_number = '50003') like 'Wants evening slots ' || chr(183) || ' Mr# was 10003 until __ ___ 20__ (the website now numbers from 50000)',
  'a note the patient already had is kept, and the old Mr# is added after it');
select pg_temp.check(pg_temp.next_mr() = 50013, 'the counter moved: the next number is 50013');
select pg_temp.check(pg_temp.register('Mr26 Next Patient') = '50013', 'the next registered patient gets Mr# 50013');
select pg_temp.check(pg_temp.register('Mr26 After That') = '50014', 'and the one after gets 50014');

-- The grid: the front desk gained portal.invite, no other cell changed.
select pg_temp.check((select allowed from public.role_permissions where role = 'front_desk' and permission_key = 'portal.invite'),
  'the front desk is allowed portal.invite');
select pg_temp.check((select count(*) from public.role_permissions) = (select count(*) from t26_grid_before)
                     and (select count(*) from public.role_permissions r join t26_grid_before b using (role, permission_key) where r.allowed is distinct from b.allowed) = 1,
  'the role grid has the same rows and exactly one cell changed');
-- The database was built with this migration already applied, so "before" cannot be compared; the audit log remembers every change
-- ever made to the grid instead: the only cell that was ever changed is the front desk's portal.invite, and no cell was ever removed.
select pg_temp.check(not exists (select 1 from public.audit_log where table_name = 'role_permissions' and action = 'UPDATE'
                                  and (new_data ->> 'role', new_data ->> 'permission_key') is distinct from ('front_desk', 'portal.invite'))
                     and not exists (select 1 from public.audit_log where table_name = 'role_permissions' and action = 'DELETE'),
  'the audit log shows no other grid cell was ever changed or removed: only the front desk''s portal.invite');
select pg_temp.check((select string_agg(role::text || '=' || allowed::text, ',' order by role::text) from public.role_permissions where permission_key = 'portal.invite')
                      = 'accountant=false,admin=true,assistant=false,coordinator=true,doctor=false,front_desk=true',
  'portal.invite: front desk, coordinator and admin yes; assistant, doctor and accountant still no');

-- The same thing as the website's permission check sees it (has_perm is what the admin-users function asks).
create temp table t26_staff as select r as role, gen_random_uuid() as id, 'role26-' || r::text || '@dralirashid.com' as email from unnest(enum_range(null::public.staff_role)) as r;
insert into auth.users (id, email) select id, email from t26_staff;
insert into public.staff (id, full_name, email, role) select id, 'Role 26 ' || role, email, role from t26_staff;
create or replace function pg_temp.can_invite(p_staff uuid) returns boolean language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_staff::text, false);
  return public.has_perm('portal.invite');
end $$;
select pg_temp.check((select string_agg(role::text || '=' || pg_temp.can_invite(id)::text, ',' order by role::text) from t26_staff)
                      = 'accountant=false,admin=true,assistant=false,coordinator=true,doctor=false,front_desk=true',
  'has_perm(portal.invite) for each role: front desk, coordinator and admin only');
select set_config('request.jwt.claim.sub', '', false);

-- sync_mr_sequence: same signature, still not callable from the website, default minimum 50000.
select pg_temp.check(pg_get_function_arguments('public.sync_mr_sequence(bigint)'::regprocedure) = 'p_minimum bigint DEFAULT 50000',
  'sync_mr_sequence keeps its signature and its default minimum is 50000');
set role authenticated;
select pg_temp.expect_error('select public.sync_mr_sequence()', 'permission denied', 'a signed-in website user cannot call sync_mr_sequence');
reset role;
set role anon;
select pg_temp.expect_error('select public.sync_mr_sequence()', 'permission denied', 'an anonymous visitor cannot call sync_mr_sequence');
reset role;

-- Running the file again changes nothing: no row, no audit row, same next number, same grid.
create temp table t26_after_first as
  select (select max(id) from public.audit_log) as audit_id, pg_temp.next_mr() as next_mr, pg_temp.patients_md5() as patients_md5,
         (select md5(string_agg(role::text || ':' || permission_key || ':' || allowed::text, ',' order by role, permission_key)) from public.role_permissions) as grid_md5;
\ir ../migrations/20261009000400_mr_50000_front_desk_portal.sql
select pg_temp.check((select audit_id from t26_after_first) = (select max(id) from public.audit_log), 'second run: not a single audit row was written');
select pg_temp.check((select patients_md5 from t26_after_first) = pg_temp.patients_md5(),
  'second run: no patient changed (numbers, notes and updated_at the same)');
select pg_temp.check((select next_mr from t26_after_first) = pg_temp.next_mr() and pg_temp.next_mr() = 50015, 'second run: the next number is the same (50015)');
select pg_temp.check((select grid_md5 from t26_after_first) = (select md5(string_agg(role::text || ':' || permission_key || ':' || allowed::text, ',' order by role, permission_key)) from public.role_permissions),
  'second run: the role grid is the same');
select pg_temp.check(current_setting('mr_50000.moved_count') = '0' and current_setting('mr_50000.moved') = '',
  'second run: the result row says nobody was moved by this run (the first run''s list is not repeated)');
select pg_temp.check(pg_temp.mr_50000_renumber() = 0, 'second run: the renumbering finds nothing left to move');

-- =====================================================================
-- Scenario 2: Healthwire has reached 10001 and registered a patient AFTER the cut-off; the cut-off moment itself;
-- the edges of the range (10999 moves, 11000 and 9999 do not).
-- =====================================================================
delete from public.patients where full_name like 'Mr26 %';
insert into public.patients (mr_number, full_name, phone, first_branch_id, legacy_source, created_at) values
  ('10000', 'Mr26 Website 10000',     '03002610000', 1, 'aaj_ki_list', '2026-10-06 11:00+05'),
  ('10002', 'Mr26 Website 10002',     '03002610002', 1, 'aaj_ki_list', '2026-10-06 11:00+05'),
  ('10004', 'Mr26 Last Second',       '03002610004', 1, null,          '2026-10-09 23:59:59+05'),
  ('10005', 'Mr26 Cut-off Moment',    '03002610005', 1, null,          '2026-10-10 00:00:00+05'),
  ('10001', 'Mr26 Healthwire 10001',  '03002610001', 1, 'healthwire',  '2026-10-12 10:00+05'),
  ('10999', 'Mr26 Top Of Range',      '03002610999', 1, 'aaj_ki_list', '2026-10-06 11:00+05'),
  ('11000', 'Mr26 Outside Above',     '03002611000', 1, 'aaj_ki_list', '2026-10-06 11:00+05'),
  ('9999',  'Mr26 Outside Below',     '03002609999', 1, 'healthwire',  '2026-10-06 11:00+05');
create temp table t26_hw2_before as select id, mr_number, updated_at from public.patients where mr_number in ('10001', '10005');
select setval('public.mr_number_seq', 11999, true);   -- above every number in this scenario, so only the date and the 10xxx range keep patients out
\ir ../migrations/20261009000400_mr_50000_front_desk_portal.sql
select pg_temp.check((select string_agg(full_name || '=' || mr_number, ',' order by mr_number) from public.patients where full_name like 'Mr26 %')
                      = 'Mr26 Healthwire 10001=10001,Mr26 Cut-off Moment=10005,Mr26 Outside Above=11000,Mr26 Website 10000=50000,Mr26 Website 10002=50002,Mr26 Last Second=50004,Mr26 Top Of Range=50999,Mr26 Outside Below=9999',
  'the Healthwire patient created after the cut-off keeps 10001; the website ones, the last second before the cut-off and 10999 move; 11000 and 9999 stay');
select pg_temp.check((select count(*) from t26_hw2_before b join public.patients p using (id) where p.mr_number = b.mr_number and p.updated_at = b.updated_at) = 2,
  'the Healthwire 10001 and the patient created exactly at the cut-off are not even touched (updated_at the same)');
select pg_temp.check(pg_temp.register('Mr26 Next After Healthwire') = '51000', 'the next registered patient gets 51000 (after the highest, 50999), not 10002');

-- =====================================================================
-- Scenario 3: a new number is already taken. The renumbering refuses and changes nothing, not even the patients
-- that could have moved. (In the file this is its first data step: the transaction stops, so the counter and the
-- grid are not touched either.)
-- =====================================================================
delete from public.patients where full_name like 'Mr26 %';
insert into public.patients (mr_number, full_name, phone, first_branch_id, legacy_source, created_at) values
  ('10001', 'Mr26 Can Move',       '03002630001', 1, 'aaj_ki_list', '2026-10-06 11:00+05'),
  ('10003', 'Mr26 Would Collide',  '03002630003', 1, 'aaj_ki_list', '2026-10-06 11:00+05'),
  ('50003', 'Mr26 Already There',  '03002630503', 1, null,          '2026-10-08 09:00+05');
select setval('public.mr_number_seq', 10003, true);
update public.role_permissions set allowed = false where role = 'front_desk' and permission_key = 'portal.invite';
create temp table t26_refuse_before as
  select (select max(id) from public.audit_log) as audit_id, pg_temp.next_mr() as next_mr, pg_temp.patients_md5() as patients_md5;
select pg_temp.expect_error('select pg_temp.mr_50000_renumber()', 'already belong to other patients', 'a taken new number makes the renumbering refuse');
select pg_temp.expect_error('select pg_temp.mr_50000_renumber()', '50003', 'and the message names the taken number');
select pg_temp.check((select patients_md5 from t26_refuse_before) = pg_temp.patients_md5()
                     and (select audit_id from t26_refuse_before) = (select max(id) from public.audit_log),
  'refused: no patient changed (the one that could have moved is still 10001) and no audit row was written');
select pg_temp.check((select next_mr from t26_refuse_before) = pg_temp.next_mr()
                     and not (select allowed from public.role_permissions where role = 'front_desk' and permission_key = 'portal.invite'),
  'refused: the counter and the front desk permission are as they were');

-- =====================================================================
-- Scenario 4: sync_mr_sequence can never put the counter back into Healthwire's range.
-- =====================================================================
delete from public.patients where full_name like 'Mr26 %';
insert into public.patients (mr_number, full_name, phone, first_branch_id, legacy_source, created_at) values
  ('9846',  'Mr26 Healthwire 9846',   '03002640846', 1, 'healthwire',  '2026-10-05 10:00+05'),
  ('10050', 'Mr26 Healthwire 10050',  '03002640050', 1, 'healthwire',  '2026-10-12 10:00+05'),
  ('49999', 'Mr26 Just Under',        '03002649999', 1, 'healthwire',  '2026-10-12 10:00+05'),
  ('2600-1', 'Mr26 Odd Legacy',        '03002640347', 1, 'aaj_ki_list', '2026-10-05 10:00+05'),
  ('99999999999999999999', 'Mr26 Twenty Digits', '03002649990', 1, null, '2026-10-12 10:00+05');
select pg_temp.check(public.sync_mr_sequence() = 50000 and pg_temp.next_mr() = 50000,
  'only Healthwire-range numbers exist (up to 49999): sync_mr_sequence() gives 50000');
-- (each from a counter that stands in Healthwire's range, as on the live database: from 50000 the "never backwards" rule would hide a missing floor)
create or replace function pg_temp.sync_from(p_counter bigint, p_minimum bigint) returns bigint language plpgsql as $$
begin
  perform setval('public.mr_number_seq', p_counter, true);
  return public.sync_mr_sequence(p_minimum);
end $$;
select pg_temp.check(pg_temp.sync_from(12000, 0) = 50000 and pg_temp.sync_from(12000, 100) = 50000 and pg_temp.sync_from(12000, 9841) = 50000 and pg_temp.next_mr() = 50000,
  'a lower minimum (0, 100, the old default 9841) cannot pull it below 50000');
select pg_temp.check(public.sync_mr_sequence(60000) = 60000 and pg_temp.next_mr() = 60000, 'a minimum above 50000 is honoured');
select pg_temp.check(public.sync_mr_sequence() = 60000 and public.sync_mr_sequence(50003) = 60000 and public.sync_mr_sequence(0) = 60000 and pg_temp.next_mr() = 60000,
  'calling it again with no argument (or a lower minimum) does not move the counter back: it never goes backwards');
select setval('public.mr_number_seq', 12000, true);   -- a counter still in Healthwire's range, as on the live database before this change
select pg_temp.check(public.sync_mr_sequence() = 50000 and pg_temp.next_mr() = 50000, 'a counter still in Healthwire''s range (12001) is brought up to 50000');
select pg_temp.check(pg_temp.register('Mr26 First Website Patient') = '50000', 'a patient registered now gets 50000');
insert into public.patients (mr_number, full_name, phone, first_branch_id, created_at) values
  ('50007', 'Mr26 Website 50007', '03002650007', 1, '2026-10-20 10:00+05');
select pg_temp.check(public.sync_mr_sequence() = 50008, 'with 50007 present the next number is 50008 (Healthwire numbers and 49999 are ignored)');
select pg_temp.check(public.sync_mr_sequence(50003) = 50008 and public.sync_mr_sequence(70000) = 70000, 'the higher of the highest + 1 and the minimum wins');

-- =====================================================================
-- Scenario 5: a later run must never renumber Healthwire patients, however old their creation date looks. The counter is the
-- guard: once it is at 50000 or more the renumbering does nothing. Three ways an old-looking 10xxx number comes to exist
-- after the first run: an import with Healthwire's own (earlier) registration date, an old row of the Aaj ki List that carries
-- the number, and a Mr# the admin typed on an older patient.
-- =====================================================================
delete from public.patients where full_name like 'Mr26 %';
insert into public.patients (mr_number, full_name, phone, first_branch_id, legacy_source, created_at) values
  ('50012', 'Mr26 Website 50012',          '03002650012', 1, 'aaj_ki_list', '2026-10-06 11:00+05'),
  ('10004', 'Mr26 Healthwire Dated 9 Oct',  '03002650004', 1, 'healthwire',  '2026-10-09 10:00+05'),
  ('10010', 'Mr26 Old Sheet Row',          '03002650010', 1, 'aaj_ki_list', '2026-10-08 10:00+05'),
  ('10001', 'Mr26 Admin Edited',           '03002650001', 1, null,          '2026-10-01 10:00+05');
update public.patients set mr_number = '10020' where full_name = 'Mr26 Admin Edited';   -- the admin types the number Healthwire has just given
select setval('public.mr_number_seq', 50013, false);                                    -- where the live counter stands after the first run
update public.role_permissions set allowed = true where role = 'front_desk' and permission_key = 'portal.invite';   -- and the grid
create temp table t26_rerun_before as
  select (select max(id) from public.audit_log) as audit_id, pg_temp.next_mr() as next_mr, pg_temp.patients_md5() as patients_md5;
\ir ../migrations/20261009000400_mr_50000_front_desk_portal.sql
select pg_temp.check((select string_agg(mr_number, ',' order by mr_number) from public.patients where full_name like 'Mr26 %') = '10004,10010,10020,50012',
  'a later run leaves 10004 (Healthwire date), 10010 (old sheet row) and 10020 (admin edit) where they are');
select pg_temp.check((select patients_md5 from t26_rerun_before) = pg_temp.patients_md5() and (select audit_id from t26_rerun_before) = (select max(id) from public.audit_log),
  'a later run changed no patient and wrote no audit row');
select pg_temp.check((select next_mr from t26_rerun_before) = pg_temp.next_mr() and pg_temp.next_mr() = 50013,
  'a later run keeps the counter where it was (50013)');
-- The edge: a counter that stands exactly on 50000 (set by sync_mr_sequence, nothing numbered yet) already counts as moved.
delete from public.patients where full_name = 'Mr26 Website 50012';
select setval('public.mr_number_seq', 50000, false);
\ir ../migrations/20261009000400_mr_50000_front_desk_portal.sql
select pg_temp.check((select string_agg(mr_number, ',' order by mr_number) from public.patients where full_name like 'Mr26 %') = '10004,10010,10020' and pg_temp.next_mr() = 50000,
  'a counter standing exactly on 50000 counts as moved too: nothing is renumbered, the counter stays');

-- =====================================================================
-- Scenario 6: only numbers the website's counter has already given out can have come from the website. A pre-cut-off 10500 and
-- 10006 are above the counter (10005), so they came from somewhere else (Healthwire, a typed number): left alone.
-- =====================================================================
delete from public.patients where full_name like 'Mr26 %';
insert into public.patients (mr_number, full_name, phone, first_branch_id, legacy_source, created_at) values
  ('10003', 'Mr26 Given Out',         '03002660003', 1, 'aaj_ki_list', '2026-10-06 11:00+05'),
  ('10005', 'Mr26 Last Given Out',    '03002660005', 1, 'aaj_ki_list', '2026-10-06 11:00+05'),
  ('10006', 'Mr26 Next To Be Given',  '03002660006', 1, 'aaj_ki_list', '2026-10-06 11:00+05'),
  ('10500', 'Mr26 Never Given Out',   '03002660500', 1, 'aaj_ki_list', '2026-10-06 11:00+05');
select setval('public.mr_number_seq', 10005, true);
\ir ../migrations/20261009000400_mr_50000_front_desk_portal.sql
select pg_temp.check((select string_agg(full_name || '=' || mr_number, ',' order by mr_number) from public.patients where full_name like 'Mr26 %')
                      = 'Mr26 Next To Be Given=10006,Mr26 Never Given Out=10500,Mr26 Given Out=50003,Mr26 Last Given Out=50005',
  'numbers up to the counter (10003, 10005) move; 10006 (not given out yet) and 10500 (never given out) stay');

-- =====================================================================
-- Scenario 7: a patient to renumber already has a portal login (its username holds the old Mr#). The renumbering refuses and
-- changes nothing; once the login is gone it goes through. Logins of patients who are NOT renumbered do not matter.
-- =====================================================================
delete from public.patients where full_name like 'Mr26 %';
create temp table t26_logins as select gen_random_uuid() as id, n from unnest(array['target', 'healthwire', 'after']) as n;
insert into auth.users (id, email) select id, 'login26-' || n || '@example.com' from t26_logins;
insert into public.patients (mr_number, full_name, phone, first_branch_id, legacy_source, created_at, portal_user_id) values
  ('10001', 'Mr26 Plain Website',      '03002670001', 1, 'aaj_ki_list', '2026-10-06 11:00+05', null),
  ('10005', 'Mr26 Has Login',          '03002670005', 1, 'aaj_ki_list', '2026-10-06 11:00+05', (select id from t26_logins where n = 'target')),
  ('9846',  'Mr26 Healthwire Login',   '03002670846', 1, 'healthwire',  '2026-10-05 10:00+05', (select id from t26_logins where n = 'healthwire')),
  ('10002', 'Mr26 Healthwire After',   '03002670002', 1, 'healthwire',  '2026-10-12 10:00+05', (select id from t26_logins where n = 'after'));
select setval('public.mr_number_seq', 10005, true);
create temp table t26_login_before as
  select (select max(id) from public.audit_log) as audit_id, pg_temp.next_mr() as next_mr, pg_temp.patients_md5() as patients_md5;
select pg_temp.expect_error('select pg_temp.mr_50000_renumber()', 'already have a portal login', 'a patient to renumber with a portal login makes the renumbering refuse');
select pg_temp.expect_error('select pg_temp.mr_50000_renumber()', '10005', 'and the message names that patient''s number');
select pg_temp.check((select patients_md5 from t26_login_before) = pg_temp.patients_md5() and (select audit_id from t26_login_before) = (select max(id) from public.audit_log)
                     and (select next_mr from t26_login_before) = pg_temp.next_mr(),
  'refused: no patient changed (not even the one without a login), no audit row, the counter as it was');
update public.patients set portal_user_id = null where full_name = 'Mr26 Has Login';
select pg_temp.check(pg_temp.mr_50000_renumber() = 2, 'without the login the renumbering goes through: 10001 and 10005 move');
select pg_temp.check((select string_agg(full_name || '=' || mr_number, ',' order by mr_number) from public.patients where full_name like 'Mr26 %')
                      = 'Mr26 Healthwire After=10002,Mr26 Plain Website=50001,Mr26 Has Login=50005,Mr26 Healthwire Login=9846',
  'the Healthwire patients with logins (9846, and 10002 after the cut-off) were never in the way and were not moved');

-- =====================================================================
-- Scenario 8: the counter belongs to the database. Signed-in users and visitors cannot read or set it, and the front desk
-- can still register a patient (the registration trigger runs with its owner's rights).
-- =====================================================================
delete from public.patients where full_name like 'Mr26 %';
select public.sync_mr_sequence() as ignore_this;
select id as fd26 from t26_staff where role = 'front_desk' \gset
select set_config('request.jwt.claim.sub', :'fd26', false);
set role authenticated;
select pg_temp.expect_error($$select setval('public.mr_number_seq', 10000)$$, 'permission denied', 'a signed-in user cannot set the Mr# counter');
select pg_temp.expect_error($$select nextval('public.mr_number_seq')$$, 'permission denied', 'a signed-in user cannot draw from the Mr# counter');
select pg_temp.check(pg_temp.register('Mr26 Registered By Front Desk') = '50000', 'the front desk registers a patient and still gets the next Mr# (50000)');
reset role; select set_config('request.jwt.claim.sub', '', false);
set role anon;
select pg_temp.expect_error($$select setval('public.mr_number_seq', 10000)$$, 'permission denied', 'an anonymous visitor cannot set the Mr# counter');
select pg_temp.expect_error($$select nextval('public.mr_number_seq')$$, 'permission denied', 'an anonymous visitor cannot draw from the Mr# counter');
reset role;
select pg_temp.check(pg_temp.next_mr() = 50001, 'and the counter is untouched by all of that (50001)');

-- =====================================================================
-- Scenario 9: patients that are Healthwire's own are never renumbered, even when they were made before the cut-off and sit below
-- the counter (Healthwire reached 10004 and its import ran before this file did). Healthwire's import makes patients with legacy
-- source 'healthwire' and hangs its invoices, payments and visits on the patient with that Mr#, so one of those on a patient with an
-- Aaj ki List source (the import merged Healthwire's 10006 into the website's 10006) makes the patient Healthwire's too.
-- An invoice or visit that came from the Aaj ki List does not: that patient is the website's and moves.
-- =====================================================================
delete from public.patients where full_name like 'Mr26 %';
insert into public.patients (mr_number, full_name, phone, first_branch_id, legacy_source, created_at) values
  ('10000', 'Mr26 Plain Website',       '03002690000', 1, 'aaj_ki_list', '2026-10-06 11:00+05'),
  ('10004', 'Mr26 Healthwire Import',   '03002690004', 1, 'healthwire',  '2026-10-09 10:00+05'),
  ('10006', 'Mr26 With Hw Invoice',     '03002690006', 1, 'aaj_ki_list', '2026-10-06 11:00+05'),
  ('10007', 'Mr26 With Hw Payment',     '03002690007', 1, 'aaj_ki_list', '2026-10-06 11:00+05'),
  ('10008', 'Mr26 With Hw Visit',       '03002690008', 1, 'aaj_ki_list', '2026-10-06 11:00+05'),
  ('10009', 'Mr26 With Own Records',    '03002690009', 1, 'aaj_ki_list', '2026-10-06 11:00+05');
insert into public.invoices (invoice_no, patient_id, branch_id, issue_date, subtotal, status, legacy_source) values
  ('MR26-HW-1',  (select id from public.patients where full_name = 'Mr26 With Hw Invoice'), 1, '2026-10-05', 1000, 'issued', 'healthwire'),
  ('MR26-AAJ-1', (select id from public.patients where full_name = 'Mr26 With Own Records'), 1, '2026-10-05', 1000, 'issued', 'aaj_ki_list');
insert into public.payments (patient_id, branch_id, amount, received_at, reference, legacy_source) values
  ((select id from public.patients where full_name = 'Mr26 With Hw Payment'), 1, 500, '2026-10-05 12:00+05', 'mr26-hw-pay', 'healthwire'),
  ((select id from public.patients where full_name = 'Mr26 With Own Records'), 1, 500, '2026-10-05 12:00+05', 'mr26-aaj-pay', 'aaj_ki_list');
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, legacy_source) values
  ((select id from public.patients where full_name = 'Mr26 With Hw Visit'),    1, '2026-10-05', 'completed', 'Checkup', 'healthwire'),
  ((select id from public.patients where full_name = 'Mr26 With Own Records'), 1, '2026-10-05', 'completed', 'Checkup', 'aaj_ki_list');
select setval('public.mr_number_seq', 10012, true);
\ir ../migrations/20261009000400_mr_50000_front_desk_portal.sql
select pg_temp.check((select string_agg(full_name || '=' || mr_number, ',' order by mr_number) from public.patients where full_name like 'Mr26 %')
                      = 'Mr26 Healthwire Import=10004,Mr26 With Hw Invoice=10006,Mr26 With Hw Payment=10007,Mr26 With Hw Visit=10008,Mr26 Plain Website=50000,Mr26 With Own Records=50009',
  'Healthwire''s own patients (its import; its invoice, payment or visit on the patient) keep their numbers; a website patient with Aaj ki List records moves');
select pg_temp.check(current_setting('mr_50000.moved_count') = '2' and current_setting('mr_50000.moved') = '10000 -> 50000, 10009 -> 50009'
                     and (select count(*) from public.patients where mr_number ~ '^10[0-9]{3}$') = 4,
  'the result row says 2 moved and 4 still hold 10000-10999 (they are for a person to look at: Healthwire''s own, correct as they are)');
delete from public.payments where patient_id in (select id from public.patients where full_name like 'Mr26 %');
delete from public.invoices where patient_id in (select id from public.patients where full_name like 'Mr26 %');
delete from public.visits   where patient_id in (select id from public.patients where full_name like 'Mr26 %');

-- =====================================================================
-- Scenario 10: a number that was given out is not given out again. The newest website patients are merged away (merge_patients
-- deletes the removed record) or deleted, and someone runs sync_mr_sequence() after an import, as the README says to: the counter
-- stays where it was, so the next patient does not get a number that "Merged with Mr# 50002" in an old note points at.
-- =====================================================================
delete from public.patients where full_name like 'Mr26 %';
select setval('public.mr_number_seq', 50000, false);
select pg_temp.check(pg_temp.register('Mr26 Kept A') = '50000' and pg_temp.register('Mr26 Kept B') = '50001'
                     and pg_temp.register('Mr26 Gone C') = '50002' and pg_temp.register('Mr26 Gone D') = '50003' and pg_temp.next_mr() = 50004,
  'four website patients registered: 50000-50003, the next number is 50004');
delete from public.patients where full_name in ('Mr26 Gone C', 'Mr26 Gone D');
select pg_temp.check(public.sync_mr_sequence() = 50004 and pg_temp.next_mr() = 50004,
  'the two newest are gone and sync_mr_sequence() runs: the counter stays at 50004, it does not go back to 50002');
select pg_temp.check(pg_temp.register('Mr26 After Merge') = '50004', 'the next patient gets 50004, not the number of a patient that was merged away');

-- =====================================================================
-- Put everything back.
-- =====================================================================
delete from public.patients where full_name like 'Mr26 %';
update public.patients p set mr_number = k.mr_number from t26_parked k where k.id = p.id;
delete from public.staff where id in (select id from t26_staff);
delete from auth.users where id in (select id from t26_staff union select id from t26_logins);
update public.role_permissions set allowed = true where role = 'front_desk' and permission_key = 'portal.invite';
select setval('public.mr_number_seq', last_value, is_called) from t26_start;
delete from public.audit_log where id > (select audit_id from t26_start);
select pg_temp.check(not exists (select 1 from public.patients where full_name like 'Mr26 %') and not exists (select 1 from public.staff where email like 'role26-%')
                     and not exists (select 1 from auth.users where email like 'login26-%') and not exists (select 1 from public.patients where mr_number like 'parked-%'),
  'cleaned up: the test patients, staff and logins are gone and the parked patients have their numbers back');
