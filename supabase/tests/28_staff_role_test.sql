-- Changing a staff member's role (Admin -> Staff accounts -> Role) is a plain update of public.staff.role.
-- This locks in the database rules that feature relies on: who may make the change (admin, or a user manager for
-- someone else, never for their own account or an admin's), that nobody but admin can make an admin, that the new
-- role's permissions apply on that person's very next query while their personal access ticks stay, that an update
-- that is not allowed reaches no row (so the website says "not saved"), and that the change is audited.
-- No new migration is needed: the staff guard (20261005000600, with the id rule of 20261009000100) and the
-- "admin manages staff" policy already cover all of it.
\set ON_ERROR_STOP 1
\set admin '''00000000-0000-0000-0000-000000002800'''
\set fd    '''00000000-0000-0000-0000-000000002801'''
\set fd2   '''00000000-0000-0000-0000-000000002802'''
\set mgr   '''00000000-0000-0000-0000-000000002803'''
\set plain '''00000000-0000-0000-0000-000000002804'''
\set off   '''00000000-0000-0000-0000-000000002805'''

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
select set_config('test.admin', :admin, false), set_config('test.fd', :fd, false), set_config('test.fd2', :fd2, false),
       set_config('test.mgr', :mgr, false), set_config('test.plain', :plain, false), set_config('test.off', :off, false);
insert into auth.users (id, email) values
  (:admin, 'admin28@dralirashid.com'), (:fd, 'fd28@dralirashid.com'), (:fd2, 'fd28b@dralirashid.com'),
  (:mgr, 'mgr28@dralirashid.com'), (:plain, 'plain28@dralirashid.com'), (:off, 'off28@dralirashid.com');
insert into public.staff (id, full_name, email, role, restrict_to_branches, branch_ids) values
  (:admin, 'Admin', 'admin28@dralirashid.com', 'admin', false, '{}'),
  (:fd,    'Front Desk', 'fd28@dralirashid.com', 'front_desk', false, '{}'),
  (:fd2,   'Front Desk Two', 'fd28b@dralirashid.com', 'front_desk', false, '{}'),
  (:mgr,   'User Manager', 'mgr28@dralirashid.com', 'coordinator', false, '{}'),
  (:plain, 'Plain Front Desk', 'plain28@dralirashid.com', 'front_desk', false, '{}');
insert into public.staff (id, full_name, email, role, active, restrict_to_branches, branch_ids) values
  (:off,   'Switched Off', 'off28@dralirashid.com', 'front_desk', false, false, '{}');
-- The coordinator may manage staff accounts for this person only (a personal override, as "Personal access" sets it).
insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (:mgr, 'users.manage', true);
-- A personal tick on the first front desk account: it must survive a change of role.
insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (:fd, 'patients.create', false);
-- The two roles differ on these keys, whatever the clinic has ticked since: pin them so the test does not depend on that.
update public.role_permissions set allowed = (role = 'front_desk') where permission_key = 'patients.create' and role in ('front_desk', 'assistant');
update public.role_permissions set allowed = (role = 'assistant')  where permission_key = 'treatment.enter' and role in ('front_desk', 'assistant');

set role authenticated;
do $$
declare
  v_admin text := current_setting('test.admin');
  v_fd    text := current_setting('test.fd');
  v_fd2   text := current_setting('test.fd2');
  v_mgr   text := current_setting('test.mgr');
  v_plain text := current_setting('test.plain');
  v_off   text := current_setting('test.off');
  n int;
  r record;
  rl text;
begin
  -- 0. Before: a front desk account has the front desk permissions.
  perform pg_temp.act_as(v_fd2);
  perform pg_temp.check(public.has_perm('patients.create') and not public.has_perm('treatment.enter'), 'before: a front desk account may create patients and may not enter treatments');

  -- 1. The admin changes the role of the first account, front desk -> assistant. It takes effect on its very next query.
  perform pg_temp.act_as(v_admin);
  update public.staff set role = 'assistant' where id = v_fd::uuid;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'admin: changing a staff member''s role updates exactly that row');
  perform pg_temp.act_as(v_fd);
  perform pg_temp.check(public.current_staff_role() = 'assistant', 'the account is an assistant on its very next query');
  perform pg_temp.check(public.has_perm('treatment.enter'), 'assistant column: may enter treatments');
  perform pg_temp.check(public.has_perm('photos.upload') and not public.has_perm('billing.create') and not public.has_perm('users.manage'),
    'assistant column: photos yes, billing and user management no');
  -- ... and the personal tick (patients.create = no) stayed: the assistant default is also no, so look at an override that differs from it.
  perform pg_temp.act_as(v_admin);
  insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (v_fd::uuid, 'billing.view', true);
  perform pg_temp.act_as(v_fd);
  perform pg_temp.check(public.has_perm('billing.view') and not public.has_perm('patients.create'), 'personal access ticks (yes and no) apply on top of the assistant column');
  perform pg_temp.act_as(v_admin);
  update public.staff set role = 'front_desk' where id = v_fd::uuid;
  perform pg_temp.act_as(v_fd);
  perform pg_temp.check(public.has_perm('billing.view') and not public.has_perm('patients.create') and not public.has_perm('treatment.enter'),
    'back to front desk: the personal ticks stayed through both changes, the role part follows the role');
  perform pg_temp.check((select count(*) from public.staff_permission_overrides where staff_id = v_fd::uuid) = 2, 'the personal access rows were not touched by the role change');

  -- 2. Every working role can be chosen, one after the other.
  perform pg_temp.act_as(v_admin);
  foreach rl in array array['assistant', 'doctor', 'coordinator', 'accountant', 'front_desk'] loop
    update public.staff set role = rl::public.staff_role where id = v_fd::uuid;
    get diagnostics n = row_count;
    perform pg_temp.check(n = 1 and (select role from public.staff where id = v_fd::uuid) = rl::public.staff_role, 'admin: may set the role ' || rl);
  end loop;
  -- A role that does not exist is refused by the database itself.
  perform pg_temp.expect_error(format('update public.staff set role = ''nurse'' where id = %L', v_fd), 'invalid input value for enum', 'admin: an unknown role is refused');
  -- A switched-off account can be given another role too (the Role button is on those rows).
  update public.staff set role = 'assistant' where id = v_off::uuid;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1 and (select role = 'assistant' and not active from public.staff where id = v_off::uuid), 'admin: a switched-off account can change role and stays switched off');

  -- 3. A user manager (personal users.manage) may change someone else's role, and it applies at once.
  perform pg_temp.act_as(v_mgr);
  update public.staff set role = 'assistant' where id = v_fd2::uuid;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'user manager: may change another non-admin''s role');
  perform pg_temp.act_as(v_fd2);
  perform pg_temp.check(public.current_staff_role() = 'assistant' and public.has_perm('treatment.enter') and not public.has_perm('patients.create'),
    'the account the user manager changed has the assistant permissions straight away');
  perform pg_temp.act_as(v_mgr);
  update public.staff set role = 'doctor' where id = v_fd2::uuid;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1 and (select role from public.staff where id = v_fd2::uuid) = 'doctor', 'user manager: may choose any working role for someone else');
  update public.staff set role = 'front_desk' where id = v_fd2::uuid;

  -- 4. ... nobody but admin can make an admin ...
  perform pg_temp.expect_error(format('update public.staff set role = ''admin'' where id = %L', v_fd2),
    'Only admin can create or promote', 'user manager: cannot promote someone else to admin');
  perform pg_temp.expect_error(format('update public.staff set role = ''admin'' where id = %L', v_mgr),
    'Only admin can create or promote', 'user manager: cannot promote their own account to admin');
  perform pg_temp.check((select role from public.staff where id = v_fd2::uuid) = 'front_desk' and (select role from public.staff where id = v_mgr::uuid) = 'coordinator',
    'user manager: no account became an admin after the refused attempts');
  perform pg_temp.act_as(v_plain);
  update public.staff set role = 'admin' where id = v_plain::uuid;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0, 'a front desk account without users.manage: cannot make itself admin (no row reached)');
  update public.staff set role = 'admin' where id = v_fd2::uuid;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0, 'a front desk account without users.manage: cannot make anyone else admin (no row reached)');
  -- The admin can: it is the one account that can. (The website's dialog never offers Admin; this is the database's own rule.)
  perform pg_temp.act_as(v_admin);
  update public.staff set role = 'admin' where id = v_fd2::uuid;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1 and (select role from public.staff where id = v_fd2::uuid) = 'admin', 'admin: is the only one who can make an admin account');
  perform pg_temp.act_as(v_fd2);
  perform pg_temp.check(public.is_admin(), 'the new admin account is admin on its next query');
  perform pg_temp.act_as(v_admin);
  update public.staff set role = 'front_desk' where id = v_fd2::uuid;
  perform pg_temp.act_as(v_fd2);
  perform pg_temp.check(not public.is_admin() and public.has_perm('patients.create'), 'admin: may take admin away again');

  -- 5. ... a user manager cannot change their own role, nor an admin's.
  perform pg_temp.act_as(v_mgr);
  perform pg_temp.expect_error(format('update public.staff set role = ''front_desk'' where id = %L', v_mgr),
    'cannot change your own', 'user manager: cannot change their own role');
  perform pg_temp.expect_error(format('update public.staff set role = ''accountant'' where id = %L', v_mgr),
    'cannot change your own', 'user manager: cannot give themselves another role either');
  perform pg_temp.expect_error(format('update public.staff set role = ''front_desk'' where id = %L', v_admin),
    'Only admin can change an admin account', 'user manager: cannot demote an admin account');
  perform pg_temp.expect_error(format('update public.staff set role = ''doctor'' where id = %L', v_admin),
    'Only admin can change an admin account', 'user manager: cannot change an admin account to any other role');
  perform pg_temp.act_as(v_mgr);
  perform pg_temp.check((select role from public.staff where id = v_mgr::uuid) = 'coordinator' and (select role from public.staff where id = v_admin::uuid) = 'admin',
    'user manager: both rows are unchanged after the refused attempts');
  perform pg_temp.check(public.has_perm('users.manage'), 'user manager: still manages users (personal tick stayed)');

  -- 6. Without users.manage the update reaches no row at all (row-level security), so the website says "not saved".
  perform pg_temp.act_as(v_plain);
  update public.staff set role = 'assistant' where id = v_fd2::uuid;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0, 'a front desk account without users.manage: changes no one''s role');
  update public.staff set role = 'accountant' where id = v_plain::uuid;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0, 'a front desk account without users.manage: cannot change its own role either');
  perform pg_temp.act_as(v_admin);
  select * into r from public.staff where id = v_fd2::uuid;
  perform pg_temp.check(r.role = 'front_desk', 'the refused changes left the stored role as it was');
  select * into r from public.staff where id = v_plain::uuid;
  perform pg_temp.check(r.role = 'front_desk', 'the refused change left the account''s own role as it was');
end $$;
reset role;

-- 7. The change is in the audit log: who did it, and the role before and after.
do $$
declare r record;
begin
  select * into r from public.audit_log
   where table_name = 'staff' and action = 'UPDATE' and row_id = current_setting('test.fd') and actor = current_setting('test.admin')::uuid
     and new_data ->> 'role' = 'assistant'
   order by id limit 1;
  perform pg_temp.check(r.id is not null, 'audit log: the role change is recorded with the admin as actor');
  perform pg_temp.check(r.old_data ->> 'role' = 'front_desk' and r.new_data ->> 'role' = 'assistant', 'audit log: it keeps the old and the new role');
  select * into r from public.audit_log
   where table_name = 'staff' and action = 'UPDATE' and row_id = current_setting('test.fd2') and actor = current_setting('test.mgr')::uuid
     and new_data ->> 'role' = 'assistant'
   order by id limit 1;
  perform pg_temp.check(r.id is not null, 'audit log: a user manager''s role change is recorded with them as actor');
end $$;
rollback;
