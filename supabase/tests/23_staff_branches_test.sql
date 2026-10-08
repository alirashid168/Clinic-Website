-- Changing the branches a staff member works at (Admin -> Staff accounts -> Branches) is a plain update of public.staff
-- (branch_ids, restrict_to_branches, home_branch_id). This locks in the database rules that feature relies on:
-- who may make the change (admin, or a user manager for someone else, never for their own or an admin's row),
-- that it takes effect on the very next query, that it is audited, that an empty list with the limit switched on
-- locks the account out (the "locked out" state the dialog warns about), and that going back to "all branches" works.
-- Also: a user manager cannot dodge the "not your own branches" rule by moving their row to another login id
-- (20261009000100_staff_guard_id.sql).
\set ON_ERROR_STOP 1
\set admin '''00000000-0000-0000-0000-000000002400'''
\set fd    '''00000000-0000-0000-0000-000000002401'''
\set fd2   '''00000000-0000-0000-0000-000000002402'''
\set mgr   '''00000000-0000-0000-0000-000000002403'''
\set spare '''00000000-0000-0000-0000-000000002404'''

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
-- Who the next statements run as (the role stays as it is).
create or replace function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, false) $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

begin;
select set_config('test.admin', :admin, false), set_config('test.fd', :fd, false),
       set_config('test.fd2', :fd2, false), set_config('test.mgr', :mgr, false), set_config('test.spare', :spare, false);
insert into auth.users (id, email) values
  (:admin, 'admin24@dralirashid.com'), (:fd, 'fd24@dralirashid.com'), (:fd2, 'fd24b@dralirashid.com'), (:mgr, 'mgr24@dralirashid.com'),
  (:spare, 'spare24@dralirashid.com');   -- a login with no staff row: the id a dodge would move to
insert into public.staff (id, full_name, email, role, restrict_to_branches, branch_ids) values
  (:admin, 'Admin', 'admin24@dralirashid.com', 'admin', false, '{}'),
  (:fd,    'Front Desk', 'fd24@dralirashid.com', 'front_desk', false, '{}'),
  (:fd2,   'Front Desk Two', 'fd24b@dralirashid.com', 'front_desk', false, '{}'),
  (:mgr,   'User Manager', 'mgr24@dralirashid.com', 'coordinator', false, '{}');
-- The coordinator may manage staff accounts for this person only (a personal override, as "Personal access" sets it).
insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (:mgr, 'users.manage', true);

set role authenticated;
do $$
declare
  v_admin text := current_setting('test.admin');
  v_fd    text := current_setting('test.fd');
  v_fd2   text := current_setting('test.fd2');
  v_mgr   text := current_setting('test.mgr');
  v_spare text := current_setting('test.spare');
  n int;
  r record;
begin
  -- 1. The admin limits a front desk account to North Nazimabad and DHA, with North Nazimabad as the home branch.
  perform pg_temp.act_as(v_admin);
  update public.staff set branch_ids = '{2,3}', restrict_to_branches = true, home_branch_id = 2 where id = v_fd::uuid;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'admin: changing a staff member''s branches updates exactly that row');
  select * into r from public.staff where id = v_fd::uuid;
  perform pg_temp.check(r.restrict_to_branches and r.branch_ids = '{2,3}' and r.home_branch_id = 2, 'admin: the limit, the branch list and the home branch are stored');

  -- 2. It takes effect on that person's very next query, with no new login.
  perform pg_temp.act_as(v_fd);
  perform pg_temp.check(public.can_access_branch(2::smallint) and public.can_access_branch(3::smallint), 'limited account: its own branches are open');
  perform pg_temp.check(not public.can_access_branch(1::smallint) and not public.can_access_branch(4::smallint) and not public.can_access_branch(5::smallint),
    'limited account: every other branch is closed at once');

  -- 3. A user manager (personal users.manage) may change someone else's branches.
  perform pg_temp.act_as(v_mgr);
  update public.staff set branch_ids = '{1}', restrict_to_branches = true, home_branch_id = 1 where id = v_fd2::uuid;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'user manager: may change another non-admin''s branches');

  -- 4. ... but not their own, and not an admin's.
  perform pg_temp.expect_error(format('update public.staff set branch_ids = ''{1}'', restrict_to_branches = true where id = %L', v_mgr),
    'cannot change your own', 'user manager: cannot change their own branches');
  perform pg_temp.expect_error(format('update public.staff set branch_ids = ''{1}'', restrict_to_branches = true where id = %L', v_admin),
    'Only admin', 'user manager: cannot change an admin account');
  -- Demoting the admin passes the "create or promote" check (the new role is not admin), so only the
  -- "change an admin account" rule can refuse it.
  perform pg_temp.expect_error(format('update public.staff set role = ''front_desk'' where id = %L', v_admin),
    'Only admin can change an admin account', 'user manager: cannot demote an admin account');
  perform pg_temp.act_as(v_mgr);
  select * into r from public.staff where id = v_mgr::uuid;
  perform pg_temp.check(not r.restrict_to_branches and r.branch_ids = '{}', 'user manager: their own row is unchanged after the refused attempt');
  -- ... and cannot dodge that by moving a row to another login id first (the guard used to look at the new id only).
  perform pg_temp.expect_error(format('update public.staff set id = %L where id = %L', v_spare, v_fd2),
    'id cannot be changed', 'user manager: cannot move another person''s row to a different login id either');
  perform pg_temp.expect_error(format('update public.staff set id = %L where id = %L', v_spare, v_mgr),
    'id cannot be changed', 'user manager: cannot move their own row to another login id');
  perform pg_temp.check((select count(*) from public.staff where id in (v_mgr::uuid, v_fd2::uuid)) = 2
    and not exists (select 1 from public.staff where id = v_spare::uuid), 'user manager: no staff row changed id after the refused attempts');

  -- 5. Without users.manage the update reaches no row at all (row-level security), so the website says "not saved".
  perform pg_temp.act_as(v_fd);
  update public.staff set branch_ids = '{}', restrict_to_branches = false where id = v_fd2::uuid;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0, 'a front desk account without users.manage: changes no row');
  update public.staff set branch_ids = '{}', restrict_to_branches = false where id = v_fd::uuid;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0, 'a front desk account without users.manage: cannot lift its own limit either');
  perform pg_temp.act_as(v_admin);
  select * into r from public.staff where id = v_fd2::uuid;
  perform pg_temp.check(r.restrict_to_branches and r.branch_ids = '{1}', 'the refused changes left the stored branches as they were');

  -- 6. Locked out: the limit on with no branch listed (what a mistyped SQL fix leaves behind) opens no branch at all.
  update public.staff set branch_ids = '{}', restrict_to_branches = true where id = v_fd2::uuid;
  perform pg_temp.act_as(v_fd2);
  perform pg_temp.check(not public.can_access_branch(1::smallint) and not public.can_access_branch(2::smallint) and not public.can_access_branch(3::smallint)
    and not public.can_access_branch(4::smallint) and not public.can_access_branch(5::smallint), 'locked out: a limit with an empty list opens no branch (fails closed)');
  -- ... and the admin repairs it by choosing branches, or by lifting the limit.
  perform pg_temp.act_as(v_admin);
  update public.staff set branch_ids = '{5}', restrict_to_branches = true, home_branch_id = 5 where id = v_fd2::uuid;
  perform pg_temp.act_as(v_fd2);
  perform pg_temp.check(public.can_access_branch(5::smallint) and not public.can_access_branch(1::smallint), 'locked out: choosing a branch repairs the account');
  perform pg_temp.act_as(v_admin);
  update public.staff set branch_ids = '{}', restrict_to_branches = false where id = v_fd2::uuid;
  perform pg_temp.act_as(v_fd2);
  perform pg_temp.check(public.can_access_branch(1::smallint) and public.can_access_branch(4::smallint), 'locked out: lifting the limit gives every branch back');

  -- 7. Back to every branch for the first account too.
  perform pg_temp.act_as(v_admin);
  update public.staff set branch_ids = '{}', restrict_to_branches = false, home_branch_id = null where id = v_fd::uuid;
  perform pg_temp.act_as(v_fd);
  perform pg_temp.check(public.can_access_branch(1::smallint) and public.can_access_branch(5::smallint), 'back to all branches: every branch is open again');
end $$;
reset role;

-- 8. The change is in the audit log: who did it, and the before and after.
do $$
declare r record;
begin
  select * into r from public.audit_log
   where table_name = 'staff' and action = 'UPDATE' and row_id = current_setting('test.fd') and actor = current_setting('test.admin')::uuid
   order by id limit 1;
  perform pg_temp.check(r.id is not null, 'audit log: the branch change is recorded with the admin as actor');
  perform pg_temp.check(r.old_data ->> 'restrict_to_branches' = 'false' and r.new_data ->> 'restrict_to_branches' = 'true'
    and r.new_data -> 'branch_ids' = '[2,3]'::jsonb, 'audit log: it keeps the old and the new branch limit');
end $$;

-- 9. A branch that is switched off later stays in the list: the website keeps it when other branches are saved,
--    and the database still counts it (the account is not locked out of it behind anyone's back).
select pg_temp.act_as('');   -- nobody signed in, as in the SQL editor: the staff guard lets these fixture changes through
update public.branches set active = false where id = 5;
update public.staff set branch_ids = '{4,5}', restrict_to_branches = true where id = :fd;
select pg_temp.act_as(:fd);
set role authenticated;
select pg_temp.check(public.can_access_branch(5::smallint) and public.can_access_branch(4::smallint) and not public.can_access_branch(1::smallint),
  'a switched-off branch stays in the account''s list');
reset role;
rollback;
