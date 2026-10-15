-- Shared logins and the name typed at the desk (20261015000300_desk_names.sql). Made-up people only.
--   1. staff.shared_login: off by default, never on an admin account, and nobody but the admin changes it on their own account;
--   2. desk_names: a shared login adds rows for itself only, while it is shared and switched on; it reads its own rows, others read
--      nothing, user managers and the admin read them all; nobody changes or deletes a row, nor picks its time; the name's limits;
--   3. audit_row() stores the name of the x-desk-name header for a shared login, ignores it for a personal login, and never fails
--      on a missing or broken header (the change is saved, without a name);
--   4. the audit rows end_day() writes itself carry the name, and the History's "ended by" reads "Login (Name)", once;
--   5. the rows go with the staff account.
\set ON_ERROR_STOP 1
\set admin   '''00000000-0000-0000-0000-000000003400'''
\set shared  '''00000000-0000-0000-0000-000000003401'''
\set fd      '''00000000-0000-0000-0000-000000003402'''
\set mgr     '''00000000-0000-0000-0000-000000003403'''
\set off     '''00000000-0000-0000-0000-000000003404'''

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
-- Who the next statements run as (the role stays as it is), and the request headers PostgREST would pass on.
create or replace function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, false) $$;
create or replace function pg_temp.headers(value text) returns void language sql as $$
  select set_config('request.headers', coalesce(value, ''), false) $$;
-- Changes one audited row (an app setting) as the person set with act_as, and answers the desk_name of the audit row it wrote.
-- Runs as the table's owner, so only audit_row() decides what is stored, not the permissions of the person.
create or replace function pg_temp.audited_desk_name() returns text language plpgsql as $$
declare v_before bigint := (select coalesce(max(id), 0) from public.audit_log);
begin
  update public.app_settings set value = to_jsonb(clock_timestamp()::text) where key = 'test_desk_names';
  perform pg_temp.check((select count(*) from public.audit_log where id > v_before and table_name = 'app_settings') = 1, 'the change is saved and audited');
  return (select desk_name from public.audit_log where id > v_before and table_name = 'app_settings');
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon;
reset role;
select pg_temp.act_as('');
select pg_temp.headers(null);

begin;
insert into auth.users (id, email) values
  (:admin, 'admin34@dralirashid.com'), (:shared, 'isb.desk34@dralirashid.com'), (:fd, 'fd34@dralirashid.com'),
  (:mgr, 'mgr34@dralirashid.com'), (:off, 'off34@dralirashid.com');
insert into public.staff (id, full_name, email, role) values
  (:admin,  'Admin Thirtyfour', 'admin34@dralirashid.com', 'admin'),
  (:shared, 'Front desk Sample Branch', 'isb.desk34@dralirashid.com', 'front_desk'),
  (:fd,     'Personal Desk Thirtyfour', 'fd34@dralirashid.com', 'front_desk'),
  (:mgr,    'User Manager Thirtyfour', 'mgr34@dralirashid.com', 'coordinator'),
  (:off,    'Switched Off Shared Desk', 'off34@dralirashid.com', 'front_desk');
insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (:mgr, 'users.manage', true);
insert into public.app_settings (key, value) values ('test_desk_names', '"start"');

-- 1. staff.shared_login
select pg_temp.check((select bool_and(not shared_login) from public.staff where id in (:admin, :shared, :fd, :mgr, :off)),
  'a staff account is not a shared login unless it is marked so');
select pg_temp.check((select is_nullable = 'NO' and column_default = 'false' from information_schema.columns
                       where table_schema = 'public' and table_name = 'staff' and column_name = 'shared_login'), 'shared_login is never null, default false');
set role authenticated;
select pg_temp.act_as(:admin);
update public.staff set shared_login = true where id in (:shared, :off);
select pg_temp.check((select count(*) from public.staff where id in (:shared, :off) and shared_login) = 2, 'the admin marks two accounts as shared logins');
update public.staff set active = false where id = :off;
select pg_temp.expect_error(format($$update public.staff set shared_login = true where id = %L$$, :admin), 'staff_shared_login_not_admin',
  'an admin account can never be a shared login, not even by the admin');
select pg_temp.act_as(:mgr);
update public.staff set shared_login = true where id = :fd;
select pg_temp.check((select shared_login from public.staff where id = :fd), 'a user manager marks another account as shared');
update public.staff set shared_login = false where id = :fd;
select pg_temp.check(not (select shared_login from public.staff where id = :fd), '... and takes it off again');
select pg_temp.expect_error(format($$update public.staff set shared_login = true where id = %L$$, :mgr), 'You cannot change whether your own login is shared',
  'a user manager cannot mark their own login as shared');
reset role;
select pg_temp.act_as('');
update public.staff set shared_login = true where id = :mgr;
select pg_temp.act_as(:mgr);
set role authenticated;
select pg_temp.expect_error(format($$update public.staff set shared_login = false where id = %L$$, :mgr), 'You cannot change whether your own login is shared',
  'nor take it off their own shared login (that would skip the name popup)');
select pg_temp.check((select shared_login from public.staff where id = :mgr), 'their own login stays shared');
update public.staff set full_name = 'User Manager 34' where id = :mgr;
select pg_temp.check((select full_name from public.staff where id = :mgr) = 'User Manager 34', 'other changes to their own row still go through');
select pg_temp.expect_error(format($$update public.staff set shared_login = true where id = %L$$, :admin), 'admin',
  'a user manager cannot touch the admin account');
select pg_temp.act_as(:shared);
update public.staff set shared_login = false where id = :shared;
select pg_temp.check((select shared_login from public.staff where id = :shared), 'a front desk login without users.manage changes nothing (row-level security)');
select pg_temp.act_as(:admin);
update public.staff set shared_login = false where id = :mgr;
select pg_temp.check(not (select shared_login from public.staff where id = :mgr), 'the admin takes it off the user manager''s account');
reset role;

-- 2. desk_names: who adds and who reads
set role authenticated;
select pg_temp.act_as(:shared);
insert into public.desk_names (staff_id, name) values (:shared, 'Sample Sadia');
insert into public.desk_names (staff_id, name) values (:shared, convert_from(decode('d8b9d8a7d8a6d8b4db8120d986d985d988d986db81', 'hex'), 'UTF8'));
select pg_temp.check((select count(*) from public.desk_names) = 2, 'a shared login adds its names (an Urdu one too) and reads them back');
select pg_temp.check((select bool_and(entered_at = now()) from public.desk_names), 'entered_at is the server''s time');
select pg_temp.expect_error(format($$insert into public.desk_names (staff_id, name) values (%L, 'Sample Other')$$, :fd), 'row-level security',
  'a shared login cannot add a name for another account');
select pg_temp.expect_error(format($$insert into public.desk_names (staff_id, name, entered_at) values (%L, 'Sample Late', now() - interval '3 days')$$, :shared),
  'permission denied', 'nor choose the time of an entry');
select pg_temp.expect_error($$update public.desk_names set name = 'Sample Changed'$$, 'permission denied', 'an entry cannot be changed');
select pg_temp.expect_error($$delete from public.desk_names$$, 'permission denied', 'nor deleted');
select pg_temp.expect_error(format($$insert into public.desk_names (staff_id, name) values (%L, 'A')$$, :shared), 'desk_names_name_check', 'a one-letter name is refused');
select pg_temp.expect_error(format($$insert into public.desk_names (staff_id, name) values (%L, %L)$$, :shared, repeat('a', 61)), 'desk_names_name_check', 'a 61-character name is refused');
insert into public.desk_names (staff_id, name) values (:shared, repeat('b', 60));
select pg_temp.expect_error(format($$insert into public.desk_names (staff_id, name) values (%L, ' Sample Space')$$, :shared), 'desk_names_name_check', 'a name with spaces around it is refused (the website trims it)');
select pg_temp.expect_error(format($$insert into public.desk_names (staff_id, name) values (%L, E'Sample\nNewline')$$, :shared), 'desk_names_name_check', 'a name with a line break is refused');
select pg_temp.act_as(:fd);
select pg_temp.expect_error(format($$insert into public.desk_names (staff_id, name) values (%L, 'Sample Personal')$$, :fd), 'row-level security',
  'a personal (not shared) login cannot add names');
select pg_temp.check((select count(*) from public.desk_names) = 0, 'and does not read the shared login''s names');
select pg_temp.act_as(:off);
select pg_temp.expect_error(format($$insert into public.desk_names (staff_id, name) values (%L, 'Sample Off')$$, :off), 'row-level security',
  'a switched-off shared login cannot add names');
select pg_temp.act_as(:mgr);
select pg_temp.check((select count(*) from public.desk_names where staff_id = :shared) = 3, 'a user manager reads every shared login''s names');
select pg_temp.act_as(:admin);
select pg_temp.check((select count(*) from public.desk_names where staff_id = :shared) = 3, 'so does the admin');
select pg_temp.expect_error(format($$insert into public.desk_names (staff_id, name) values (%L, 'Sample Admin')$$, :shared), 'row-level security',
  'nobody adds names for a shared login but that login itself (the admin neither)');
reset role;
select pg_temp.act_as('');
set role anon;
select pg_temp.expect_error($$select name from public.desk_names$$, 'permission denied', 'anonymous visitors cannot read the names');
reset role;

-- 3. audit_row() and the x-desk-name header (run as the table owner: audit_row() alone decides; auth.uid() is the person set below)
select pg_temp.act_as(:shared);
select pg_temp.headers('{"accept": "*/*", "x-desk-name": "Sample%20Sadia"}');
select pg_temp.check(pg_temp.audited_desk_name() = 'Sample Sadia', 'a change from a shared login carries the name of its x-desk-name header');
select pg_temp.check((select actor from public.audit_log order by id desc limit 1) = :shared::uuid, '... with the login as the actor, as before');
-- The same through the API's own role: the front desk registers a patient.
set role authenticated;
insert into public.patients (full_name, phone) values ('Sample Desk Patient', '03005553401');
reset role;
select pg_temp.check((select a.desk_name from public.audit_log a join public.patients p on a.table_name = 'patients' and a.row_id = p.id::text and a.action = 'INSERT'
                       where p.full_name = 'Sample Desk Patient') = 'Sample Sadia', 'a patient registered from the shared login is put down to the name at the desk');
select pg_temp.headers('{"x-desk-name": "%D8%B9%D8%A7%D8%A6%D8%B4%DB%81%20%D9%86%D9%85%D9%88%D9%86%DB%81"}');
select pg_temp.check(pg_temp.audited_desk_name() = convert_from(decode('d8b9d8a7d8a6d8b4db8120d986d985d988d986db81', 'hex'), 'UTF8'),
  'an Urdu name arrives intact (percent-encoded UTF-8)');
select pg_temp.headers('{"x-desk-name": "%20%20Sample%20%20%20Hina%09"}');
select pg_temp.check(pg_temp.audited_desk_name() = 'Sample Hina', 'spaces around and inside the name are tidied');
select pg_temp.headers(format('{"x-desk-name": "%s"}', repeat('c', 60)));
select pg_temp.check(pg_temp.audited_desk_name() = repeat('c', 60), 'a 60-character name is kept');
select pg_temp.headers('{"x-desk-name": "Al(i)_A.!~*''-"}');
select pg_temp.check(pg_temp.audited_desk_name() = 'Al(i)_A.!~*''-', 'the characters encodeURIComponent leaves as they are are taken as they are');
-- Never an error, never a wrong name: each of these saves the change without a name.
select pg_temp.headers(null);
select pg_temp.check(pg_temp.audited_desk_name() is null, 'no request headers at all: no name');
select pg_temp.headers('{"accept": "*/*"}');
select pg_temp.check(pg_temp.audited_desk_name() is null, 'no x-desk-name header: no name');
select pg_temp.headers('{"x-desk-name": "Sample');
select pg_temp.check(pg_temp.audited_desk_name() is null, 'broken JSON in request.headers: no name');
select pg_temp.headers('x-desk-name: Sample Sadia');
select pg_temp.check(pg_temp.audited_desk_name() is null, 'request.headers that is not JSON at all: no name');
select pg_temp.headers('{"x-desk-name": "Sample%ZZSadia"}');
select pg_temp.check(pg_temp.audited_desk_name() is null, 'bad percent-encoding: no name');
select pg_temp.headers('{"x-desk-name": "Sample%2"}');
select pg_temp.check(pg_temp.audited_desk_name() is null, 'a cut-off percent sign: no name');
select pg_temp.headers('{"x-desk-name": "Sample%C3%28"}');
select pg_temp.check(pg_temp.audited_desk_name() is null, 'bytes that are not UTF-8: no name');
select pg_temp.headers('{"x-desk-name": "Sample%00Sadia"}');
select pg_temp.check(pg_temp.audited_desk_name() is null, 'a zero byte: no name');
select pg_temp.headers('{"x-desk-name": "Sample%07Sadia"}');
select pg_temp.check(pg_temp.audited_desk_name() is null, 'a control character: no name');
select pg_temp.headers(format('{"x-desk-name": "%s"}', repeat('d', 61)));
select pg_temp.check(pg_temp.audited_desk_name() is null, 'a 61-character name: no name');
select pg_temp.headers(format('{"x-desk-name": "%s"}', repeat('%41', 300)));
select pg_temp.check(pg_temp.audited_desk_name() is null, 'an over-long header: no name');
select pg_temp.headers('{"x-desk-name": "S"}');
select pg_temp.check(pg_temp.audited_desk_name() is null, 'a one-letter name: no name');
select pg_temp.headers('{"x-desk-name": "%20%20"}');
select pg_temp.check(pg_temp.audited_desk_name() is null, 'only spaces: no name');
select pg_temp.headers('{"x-desk-name": ""}');
select pg_temp.check(pg_temp.audited_desk_name() is null, 'an empty header: no name');
select pg_temp.headers('{"x-desk-name": "Sample Sadia"}');
select pg_temp.check(pg_temp.audited_desk_name() is null, 'a header that was not percent-encoded (a raw space): no name');
select pg_temp.headers(format('{"x-desk-name": "%s"}', convert_from(decode('d8b9d8a7d8a6d8b4db81', 'hex'), 'UTF8')));
select pg_temp.check(pg_temp.audited_desk_name() is null, 'raw (not encoded) Urdu: no name');
select pg_temp.headers('{"x-desk-name": ["Sample", "Sadia"]}');
select pg_temp.check(pg_temp.audited_desk_name() is null, 'a list instead of text: no name');
-- Only a shared login's header counts.
select pg_temp.act_as(:fd);
select pg_temp.headers('{"x-desk-name": "Sample%20Sadia"}');
select pg_temp.check(pg_temp.audited_desk_name() is null, 'a personal login''s change never takes a name from the header');
select pg_temp.act_as('');
select pg_temp.check(pg_temp.audited_desk_name() is null, 'nobody signed in (the Google Sheet sync, a server job): no name');
select pg_temp.act_as(:shared);
select pg_temp.headers('{"x-desk-name": "Sample%20Sadia"}');
-- An audit row written by a function for somebody else (the actor is not the person signed in) is not given their name.
insert into public.audit_log (table_name, row_id, action, actor) values ('visits', 'x', 'SHEET_REMOVED', '00000000-0000-0000-0000-0000000aa500');
select pg_temp.check((select desk_name from public.audit_log order by id desc limit 1) is null, 'an audit row about someone else gets no name');
insert into public.audit_log (table_name, row_id, action, actor) values ('day_list_closings', 'x', 'END_DAY', :shared);
select pg_temp.check((select desk_name from public.audit_log order by id desc limit 1) = 'Sample Sadia', 'an audit row a function writes for the person signed in gets the name');
insert into public.audit_log (table_name, row_id, action, actor, desk_name) values ('day_list_closings', 'x', 'END_DAY', :shared, 'Sample Given');
select pg_temp.check((select desk_name from public.audit_log order by id desc limit 1) = 'Sample Given', 'a name already given is kept');
-- The admin-users Edge Function writes its audit rows with the service role (nobody signed in, no access to schema private).
select pg_temp.act_as('');
set role service_role;
insert into public.audit_log (table_name, row_id, action, actor) values ('staff', 'x', 'CREATE_LOGIN', :admin);
reset role;
select pg_temp.check((select action = 'CREATE_LOGIN' and desk_name is null from public.audit_log order by id desc limit 1),
  'an audit row written with the service role is saved as before, without a name');
select pg_temp.act_as(:shared);

-- 4. End the day from a shared login: its own audit row and the History's "ended by"
set role authenticated;
select public.end_day((select id from public.branches where code = 'ISB'), date '2025-03-03');
select pg_temp.check((select closed_by_name from public.day_list_closings where list_date = '2025-03-03' and branch_id = (select id from public.branches where code = 'ISB'))
  = 'Front desk Sample Branch (Sample Sadia)', 'a day ended from a shared login is ended by "Login (Name)"');
select pg_temp.headers('{"x-desk-name": "Sample%20Mehak"}');
select public.end_day((select id from public.branches where code = 'ISB'), date '2025-03-03');
reset role;
select pg_temp.check((select closed_by_name from public.day_list_closings where list_date = '2025-03-03' and branch_id = (select id from public.branches where code = 'ISB'))
  = 'Front desk Sample Branch (Sample Mehak)', 'ending it again after a shift change names the new person, once');
select pg_temp.check((select string_agg(coalesce(desk_name, '-'), ',' order by id) from public.audit_log where action = 'END_DAY' and actor = :shared::uuid
                        and new_data->>'list_date' = '2025-03-03') = 'Sample Sadia,Sample Mehak', 'each End the day in the audit log carries the name');
select pg_temp.act_as(:fd);
set role authenticated;
select public.end_day((select id from public.branches where code = 'ISB'), date '2025-03-04');
reset role;
select pg_temp.check((select closed_by_name from public.day_list_closings where list_date = '2025-03-04' and branch_id = (select id from public.branches where code = 'ISB'))
  = 'Personal Desk Thirtyfour', 'a personal login''s day keeps the plain name, header or not');
select pg_temp.headers(null);
select pg_temp.act_as(:shared);
set role authenticated;
select public.end_day((select id from public.branches where code = 'ISB'), date '2025-03-05');
reset role;
select pg_temp.check((select closed_by_name from public.day_list_closings where list_date = '2025-03-05' and branch_id = (select id from public.branches where code = 'ISB'))
  = 'Front desk Sample Branch', 'a shared login without a name in the request: the plain login name');

-- 5. The names go with the staff account.
select pg_temp.act_as('');
delete from public.day_list_closings where list_date between '2025-03-03' and '2025-03-05';
delete from public.staff where id = :shared;
select pg_temp.check(not exists (select 1 from public.desk_names where staff_id = :shared::uuid), 'deleting a staff account removes its names');
rollback;
