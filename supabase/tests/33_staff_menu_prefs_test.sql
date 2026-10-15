-- Arrange my menu (20261015000100_staff_menu_prefs.sql): each staff member reads and saves only their own menu order,
-- nobody else reads it (the admin included), a switched-off account, a patient login and anonymous visitors cannot save,
-- and the saved JSON stays small (an array of at most 60 strings of menu keys, each 1 to 80 characters).
\set ON_ERROR_STOP 1
\set admin  '''00000000-0000-0000-0000-000000003300'''
\set fd     '''00000000-0000-0000-0000-000000003301'''
\set fd2    '''00000000-0000-0000-0000-000000003302'''
\set off    '''00000000-0000-0000-0000-000000003303'''
\set pat    '''00000000-0000-0000-0000-000000003304'''

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
insert into auth.users (id, email) values
  (:admin, 'admin33@dralirashid.com'), (:fd, 'fd33@dralirashid.com'), (:fd2, 'fd33b@dralirashid.com'),
  (:off, 'off33@dralirashid.com'), (:pat, 'samplepatient-33@dralirashid.com');
insert into public.staff (id, full_name, email, role) values
  (:admin, 'Admin', 'admin33@dralirashid.com', 'admin'),
  (:fd, 'Front Desk', 'fd33@dralirashid.com', 'front_desk'),
  (:fd2, 'Front Desk Two', 'fd33b@dralirashid.com', 'front_desk');
insert into public.staff (id, full_name, email, role, active) values (:off, 'Switched Off', 'off33@dralirashid.com', 'front_desk', false);

-- 1. A staff member saves their own arrangement and reads it back; saving again replaces it (one row per person).
set role authenticated;
select pg_temp.act_as(:fd);
select public.save_my_menu('["patients", "reports?group=financial", "menu:coordinator", "-billing"]');
select pg_temp.check((select arrangement from public.staff_menu_prefs) = '["patients", "reports?group=financial", "menu:coordinator", "-billing"]'::jsonb,
  'a front desk account saves its own menu order and reads it back');
select public.save_my_menu('["today", "-menu:sheet"]');
select pg_temp.check((select count(*) from public.staff_menu_prefs) = 1 and (select arrangement->>0 from public.staff_menu_prefs) = 'today',
  'saving again replaces the order (still one row)');
select public.save_my_menu('[]');
select pg_temp.check((select arrangement from public.staff_menu_prefs where staff_id = :fd) = '[]'::jsonb, '"Reset to default" saves an empty list');
select public.save_my_menu('["patients"]');

-- 2. Nobody else reads or changes it.
select pg_temp.act_as(:fd2);
select pg_temp.check((select count(*) from public.staff_menu_prefs) = 0, 'another staff member does not see it');
select pg_temp.expect_error(format($$insert into public.staff_menu_prefs (staff_id, arrangement) values (%L, '["stock"]')$$, :fd), 'row-level security',
  'another staff member cannot write a row for them');
update public.staff_menu_prefs set arrangement = '["stock"]' where staff_id = :fd;
select pg_temp.expect_error($$delete from public.staff_menu_prefs$$, 'permission denied', 'rows cannot be deleted through the API (Reset saves [])');
select public.save_my_menu('["checkups", "today"]');
select pg_temp.check((select count(*) from public.staff_menu_prefs) = 1 and (select staff_id from public.staff_menu_prefs) = :fd2::uuid,
  'save_my_menu always saves the caller''s own row');
select pg_temp.act_as(:admin);
select pg_temp.check((select count(*) from public.staff_menu_prefs) = 0, 'the admin does not read anybody''s menu order either');
update public.staff_menu_prefs set arrangement = '["stock"]';
select pg_temp.act_as(:fd);
select pg_temp.check((select arrangement from public.staff_menu_prefs) = '["patients"]'::jsonb, 'the updates by others reached no row: the order is unchanged');
select pg_temp.expect_error(format($$update public.staff_menu_prefs set staff_id = %L$$, :fd2), 'row-level security', 'a row cannot be moved to another person');

-- 3. A switched-off account, a patient login and an anonymous visitor cannot save (or read).
select pg_temp.act_as(:off);
select pg_temp.expect_error($$select public.save_my_menu('["today"]')$$, 'NOT_STAFF', 'a switched-off account cannot save a menu order');
select pg_temp.expect_error(format($$insert into public.staff_menu_prefs (staff_id) values (%L)$$, :off), 'row-level security', 'nor write its row directly');
select pg_temp.act_as(:pat);
select pg_temp.expect_error($$select public.save_my_menu('["today"]')$$, 'NOT_STAFF', 'a patient login has no staff menu to save');
select pg_temp.check((select count(*) from public.staff_menu_prefs) = 0, 'a patient login reads nothing');
reset role;
select pg_temp.act_as('');
set role anon;
select pg_temp.expect_error($$select arrangement from public.staff_menu_prefs$$, 'permission denied', 'anonymous visitors cannot read the table');
select pg_temp.expect_error($$select public.save_my_menu('["today"]')$$, 'permission denied', 'nor call save_my_menu');
reset role;

-- 4. Size limits (the check constraint): an array of at most 60 strings, each 1 to 80 characters of the allowed ones.
set role authenticated;
select pg_temp.act_as(:fd);
select public.save_my_menu((select jsonb_agg('page' || g) from generate_series(1, 60) g));
select pg_temp.check((select jsonb_array_length(arrangement) from public.staff_menu_prefs) = 60, '60 keys are accepted');
select public.save_my_menu(jsonb_build_array(repeat('a', 80), '-' || repeat('b', 80), 'admin?tab=import', 'coordinator?tab=lab&x=1', 'a.b/c_d:e'));
select pg_temp.check((select jsonb_array_length(arrangement) from public.staff_menu_prefs) = 5, 'an 80-character key, a taken-off key and keys with ? = & . / _ : are accepted');
select pg_temp.expect_error($$select public.save_my_menu((select jsonb_agg('page' || g) from generate_series(1, 61) g))$$, 'staff_menu_prefs_arrangement_check', '61 keys are refused');
select pg_temp.expect_error(format($$select public.save_my_menu(jsonb_build_array(%L))$$, repeat('a', 81)), 'staff_menu_prefs_arrangement_check', 'an 81-character key is refused');
select pg_temp.expect_error($$select public.save_my_menu('[""]')$$, 'staff_menu_prefs_arrangement_check', 'an empty key is refused');
select pg_temp.expect_error($$select public.save_my_menu('["today", 7]')$$, 'staff_menu_prefs_arrangement_check', 'a number in the list is refused');
select pg_temp.expect_error($$select public.save_my_menu('["today", ["nested"]]')$$, 'staff_menu_prefs_arrangement_check', 'a nested list is refused');
select pg_temp.expect_error($$select public.save_my_menu('["<script>"]')$$, 'staff_menu_prefs_arrangement_check', 'a key with < > is refused');
select pg_temp.expect_error($$select public.save_my_menu('["two words"]')$$, 'staff_menu_prefs_arrangement_check', 'a key with a space is refused');
select pg_temp.expect_error($$select public.save_my_menu('{"top": ["today"]}')$$, 'staff_menu_prefs_arrangement_check', 'an object instead of a list is refused');
select pg_temp.expect_error($$select public.save_my_menu('"today"')$$, 'staff_menu_prefs_arrangement_check', 'a single string instead of a list is refused');
select pg_temp.expect_error($$update public.staff_menu_prefs set arrangement = 'null'::jsonb$$, 'staff_menu_prefs_arrangement_check', 'a JSON null is refused');
select public.save_my_menu(null);
select pg_temp.check((select arrangement from public.staff_menu_prefs) = '[]'::jsonb, 'save_my_menu(null) saves the default ([])');
reset role;
select pg_temp.act_as('');

-- 5. The row goes with the staff account.
delete from public.staff where id = :fd2;
select pg_temp.check(not exists (select 1 from public.staff_menu_prefs where staff_id = :fd2::uuid), 'deleting a staff account removes their menu order');
rollback;
