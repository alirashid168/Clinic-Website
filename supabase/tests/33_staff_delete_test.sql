-- Delete on Admin -> Staff accounts (20261015000200_staff_delete.sql). Made-up people only.
--   1. staff_records(): what the website has with a staff id on it, per column, most first but the audit log always last (records
--      the person saved as themselves write audit rows too); 0 for an account nobody used (signing in, a doctor link and personal
--      access ticks are not records); when it last logged in, or null; only for users.manage (42501 for anyone else);
--   2. COVERAGE: every uuid column of a table in public or private that has a foreign key to public.staff or auth.users, that
--      fills itself with auth.uid(), or whose name looks like a staff reference, is counted by staff_records() or listed below with
--      the reason it is not. A new table that stores a staff id fails here until it is added to private.staff_record_columns() (or
--      to the exclusions, with a reason). A foreign key to public.staff that is not counted must go with the account (on delete
--      cascade): any other kind would stop the login being removed, or take the name off records;
--   3. an unused account's login can be removed (what delete_staff does: unlink the doctor, audit, delete the login): the staff
--      row and its ticks go with it, the doctor stays; a used account's login cannot (its records keep its name);
--   4. the deleted mark: always switched off; only the admin-users function (service role) or the admin sets or clears it, never
--      a user manager, not even on their own account; the database refuses switching a deleted account back on; a user manager
--      cannot remove a staff row by hand either (that would skip the count);
--   5. staff_logins(): deleted_at for each account, and the sign-ins of a removed login keep its name from the audit log.
\set ON_ERROR_STOP 1
\set admin  '''00000000-0000-0000-0000-000000003300'''
\set mgr    '''00000000-0000-0000-0000-000000003301'''
\set plain  '''00000000-0000-0000-0000-000000003302'''
\set busy   '''00000000-0000-0000-0000-000000003303'''
\set unused '''00000000-0000-0000-0000-000000003304'''
\set gone   '''00000000-0000-0000-0000-000000003305'''
\set writer '''00000000-0000-0000-0000-000000003306'''

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
  if (state is not null and st <> state) or position(needle in m) = 0 then raise exception 'TEST FAILED: % (expected % "%", got % %)', msg, state, needle, st, m; end if;
  raise notice 'ok - % (blocked: % %)', msg, st, left(m, 60);
end $$;
create or replace function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, false) $$;
-- The parts of a staff_records() answer as "label=count" in their order, joined with ", ".
create or replace function pg_temp.parts(p jsonb) returns text language sql as $$
  select coalesce(string_agg((x->>'label') || '=' || (x->>'count'), ', ' order by o), '') from jsonb_array_elements(p->'parts') with ordinality t(x, o) $$;
grant execute on all functions in schema pg_temp to authenticated, anon;
reset role;
select pg_temp.act_as('');

begin;
select set_config('test.admin', :admin, false), set_config('test.mgr', :mgr, false), set_config('test.plain', :plain, false),
       set_config('test.busy', :busy, false), set_config('test.unused', :unused, false), set_config('test.gone', :gone, false),
       set_config('test.writer', :writer, false),
       set_config('test.nn', (select id::text from public.branches where code = 'NN'), false);
insert into auth.users (id, email, last_sign_in_at) values
  (:admin, 'admin33@dralirashid.com', now()), (:mgr, 'mgr33@dralirashid.com', now()), (:plain, 'plain33@dralirashid.com', now()),
  (:busy, 'busy33@dralirashid.com', now()), (:unused, 'unused33@dralirashid.com', now()), (:gone, 'gone33@dralirashid.com', null),
  (:writer, 'writer33@dralirashid.com', now());
insert into public.staff (id, full_name, email, role) values
  (:admin,  'Admin Thirtythree', 'admin33@dralirashid.com', 'admin'),
  (:mgr,    'User Manager Thirtythree', 'mgr33@dralirashid.com', 'coordinator'),
  (:plain,  'Desk Thirtythree', 'plain33@dralirashid.com', 'front_desk'),
  (:busy,   'Busy Desk Thirtythree', 'busy33@dralirashid.com', 'front_desk'),
  (:unused, 'Dr. Unused Thirtythree', 'unused33@dralirashid.com', 'doctor'),
  (:gone,   'Never Used Thirtythree', 'gone33@dralirashid.com', 'front_desk'),
  (:writer, 'Writer Desk Thirtythree', 'writer33@dralirashid.com', 'front_desk');
-- The coordinator may manage staff accounts (a personal tick, as "Personal access" sets it); the desk may not.
insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (:mgr, 'users.manage', true), (:plain, 'users.manage', false);
-- Things that are NOT records: a doctor linked to the unused login, a personal tick, and sign-ins.
insert into public.clinicians (display_name, is_doctor, staff_id) values ('Dr. Unused Thirtythree', true, :unused);
insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (:unused, 'billing.view', true);
insert into public.login_events (user_id, user_agent) values (:unused, 'Chrome on Windows'), (:gone, 'Safari on iPhone');

-- The busy desk's records (written as the service role would: the stamps keep the ids given).
insert into public.patients (mr_number, full_name, phone, created_by) values ('33001', 'Sample Thirtythree', '03005553301', :busy);
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, created_by)
select p.id, current_setting('test.nn')::smallint, d, 'completed', 'Checkup', :busy
  from public.patients p, (values (date '2026-09-20'), (date '2026-09-21')) v(d) where p.mr_number = '33001';
insert into public.payments (patient_id, branch_id, amount, method, received_by)
select id, current_setting('test.nn')::smallint, 1000, 'cash', :busy from public.patients where mr_number = '33001';
insert into public.reminders (patient_id, kind, due_date, assigned_to)
select id, 'followup', date '2026-09-25', :busy from public.patients where mr_number = '33001';
insert into public.audit_log (table_name, row_id, action, actor) values ('patients', 'sample', 'UPDATE', :busy);

-- The writer desk saves its records as itself, signed in, the way the website does: every one of them also writes an audit row
-- with the desk as the actor (the audit trigger), so the audit log has more of its rows than any other part.
set role authenticated;
select pg_temp.act_as(:writer);
insert into public.patients (mr_number, full_name, phone) values ('33002', 'Sample Thirtythree Two', '03005553302');
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label)
select p.id, current_setting('test.nn')::smallint, d, 'scheduled', 'Checkup'
  from public.patients p, (values (date '2026-09-22'), (date '2026-09-23')) v(d) where p.mr_number = '33002';
reset role;
select pg_temp.act_as('');

-- =====================================================================
-- 1. staff_records()
-- =====================================================================
set role authenticated;
do $$
declare r jsonb;
begin
  perform pg_temp.act_as(current_setting('test.admin'));
  r := public.staff_records(current_setting('test.busy')::uuid);
  perform pg_temp.check((r->>'total')::int = 6, 'the busy desk: 6 records in all (got ' || r::text || ')');
  perform pg_temp.check(pg_temp.parts(r) = 'visits=2, payments=1, patients registered=1, reminders assigned=1, changes in the audit log=1',
    'counted per column, most first, then in the list''s order: ' || pg_temp.parts(r));
  perform pg_temp.check((select bool_and(x ? 'one' and x ? 'label' and (x->>'count')::int > 0) from jsonb_array_elements(r->'parts') x)
    and r->'parts'->1->>'one' = 'payment' and r->'parts'->0->>'label' = 'visits', 'each part has the plural, the word for one, and a count above 0');
  r := public.staff_records(current_setting('test.writer')::uuid);
  perform pg_temp.check(pg_temp.parts(r) ~ '^visits=2, patients registered=1, changes in the audit log=[3-9]$' and (r->>'total')::int >= 6,
    'records saved by the person themselves: the audit log has the most rows but comes last (' || pg_temp.parts(r) || ')');
  r := public.staff_records(current_setting('test.unused')::uuid);
  perform pg_temp.check((r->>'total')::int = 0 and r->'parts' = '[]'::jsonb and r->>'last_sign_in_at' is not null,
    'the unused doctor: total 0 and no parts (a doctor link, a personal tick and a sign-in are not records); it did log in (' || r::text || ')');
  r := public.staff_records(current_setting('test.gone')::uuid);
  perform pg_temp.check((r->>'total')::int = 0 and r ? 'last_sign_in_at' and r->>'last_sign_in_at' is null, 'an account that was never used: total 0, never logged in');
  perform pg_temp.check((public.staff_records('00000000-0000-0000-0000-0000000033ff')->>'total')::int = 0, 'an id nobody has: total 0');

  perform pg_temp.act_as(current_setting('test.mgr'));
  perform pg_temp.check((public.staff_records(current_setting('test.busy')::uuid)->>'total')::int = 6, 'a user manager (users.manage) may ask too');

  perform pg_temp.act_as(current_setting('test.plain'));
  perform pg_temp.expect_state(format('select public.staff_records(%L)', current_setting('test.busy')), '42501', 'Only Dr. Ali',
    'a desk without users.manage is refused with 42501');
  perform pg_temp.act_as('');
  perform pg_temp.expect_state(format('select public.staff_records(%L)', current_setting('test.busy')), '42501', 'Only Dr. Ali',
    'nobody signed in: refused with 42501');
end $$;
reset role;
select pg_temp.act_as('');
select pg_temp.check(not has_function_privilege('anon', 'public.staff_records(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.staff_records(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.staff_record_columns()', 'execute'),
  'grants: staff_records for signed-in people (it checks users.manage itself), never the public; the column list is not callable');

-- =====================================================================
-- 2. COVERAGE: no column that stores a staff id escapes the count
-- =====================================================================
create temp table staff_ref_excluded (table_name text, column_name text, reason text, schema_name text not null default 'public') on commit drop;
insert into staff_ref_excluded (table_name, column_name, reason) values
  ('staff',                      'id',                    'the account itself: its id is the login id'),
  ('clinicians',                 'staff_id',              'a doctor''s login link, not a record: delete_staff unlinks it and the doctor stays for visits'),
  ('staff_permission_overrides', 'staff_id',              'personal access ticks of the account: removed with it (on delete cascade)'),
  ('staff_menu_prefs',           'staff_id',              'the account''s own menu order (Arrange my menu): removed with it (on delete cascade)'),
  ('desk_names',                 'staff_id',              'names typed at a shared login''s desk: removed with the account (on delete cascade)'),
  ('patients',                   'portal_user_id',        'a patient''s own portal login, never a staff account'),
  ('login_events',               'user_id',               'signing in is not work: an account that only logged in is unused; staff_logins() names a removed login from its audit row'),
  ('idempotency_keys',           'created_by',            'a retry key of one save: the invoice or plan that save made is counted through its own created_by'),
  ('visits',                     'checked_by',            'a doctor (public.clinicians), not a login'),
  ('patients',                   'referred_by_clinician', 'a doctor (public.clinicians), not a login'),
  ('retainer_cases',             'made_by',               'a retainer team member (public.retainer_team), not a login'),
  ('retainer_cases',             'model_check_by',        'a retainer team member (public.retainer_team), not a login'),
  ('photo_inbox_items',          'edit_lease_by',         'a 10-minute claim of a Photo inbox edit, cleared when it is saved: the photo is counted through its uploaded_by');
insert into staff_ref_excluded (schema_name, table_name, column_name, reason) values
  ('private', 'checkup_form_imports', 'imported_by', 'who ran a Google Form import: Dr. Ali only (admin), and an admin account is never deleted');

do $$
declare v_missing text; v_bad text; n int;
begin
  -- Every uuid column of a table in public or private with a foreign key to a login, a default of auth.uid() (whoever is signed
  -- in), or a name that looks like one.
  create temp table staff_ref_candidates on commit drop as
  select ns.nspname::text as schema_name, c.relname::text as table_name, a.attname::text as column_name
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace ns on ns.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where ns.nspname in ('public', 'private') and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped and a.atttypid = 'uuid'::regtype
     and (exists (select 1 from pg_constraint k
                   where k.contype = 'f' and k.conrelid = c.oid and a.attnum = any (k.conkey)
                     and k.confrelid in ('public.staff'::regclass, 'auth.users'::regclass))
          or pg_get_expr(d.adbin, d.adrelid) ~ 'auth[.]uid[(][)]'
          or a.attname ~ '(_by$|_by_|^by_|staff|^actor|assigned|^author|^owner|user_id$|_user$|^user$|approv|verif|review)');
  select count(*) into n from staff_ref_candidates;
  perform pg_temp.check(n >= 40, 'coverage: ' || n || ' uuid columns look like a staff reference');

  perform pg_temp.check(exists (select 1 from staff_ref_candidates where schema_name = 'private'), 'coverage: the private schema is looked at too');
  select string_agg(case when x.schema_name = 'public' then '' else x.schema_name || '.' end || x.table_name || '.' || x.column_name, ', '
                    order by x.schema_name desc, x.table_name, x.column_name) into v_missing
    from staff_ref_candidates x
   where not exists (select 1 from private.staff_record_columns() l where x.schema_name = 'public' and l.table_name = x.table_name and l.column_name = x.column_name)
     and not exists (select 1 from staff_ref_excluded e where e.schema_name = x.schema_name and e.table_name = x.table_name and e.column_name = x.column_name);
  perform pg_temp.check(v_missing is null,
    'coverage: every staff-like uuid column is counted by staff_records() or excluded with a reason (missing: ' || coalesce(v_missing, 'none') || ')');

  -- The list and the exclusions name real uuid columns, and never the same one.
  select string_agg(l.table_name || '.' || l.column_name, ', ') into v_bad
    from private.staff_record_columns() l
   where not exists (select 1 from staff_ref_candidates x where x.schema_name = 'public' and x.table_name = l.table_name and x.column_name = l.column_name);
  perform pg_temp.check(v_bad is null, 'coverage: every counted column exists and is a staff-like uuid column (stale: ' || coalesce(v_bad, 'none') || ')');
  select string_agg(e.schema_name || '.' || e.table_name || '.' || e.column_name, ', ') into v_bad
    from staff_ref_excluded e
   where not exists (select 1 from staff_ref_candidates x where x.schema_name = e.schema_name and x.table_name = e.table_name and x.column_name = e.column_name)
      or exists (select 1 from private.staff_record_columns() l where e.schema_name = 'public' and l.table_name = e.table_name and l.column_name = e.column_name)
      or coalesce(length(e.reason), 0) < 10;
  perform pg_temp.check(v_bad is null, 'coverage: every exclusion exists, has a reason and is not counted as well (bad: ' || coalesce(v_bad, 'none') || ')');
  -- Every foreign key to public.staff is counted, or excluded above and removed with the account (on delete cascade: the account's
  -- own settings, such as its ticks and its menu order). The one other is the doctor's login link, which delete_staff takes off
  -- before it removes the login. Any other kind would stop the login being removed (no action) or take the name off records (set null).
  select string_agg(x.schema_name || '.' || x.table_name || '.' || x.column_name, ', ') into v_bad
    from staff_ref_candidates x
    join pg_class c on c.relname = x.table_name and c.relnamespace = x.schema_name::regnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = x.column_name
    join pg_constraint k on k.contype = 'f' and k.conrelid = c.oid and a.attnum = any (k.conkey) and k.confrelid = 'public.staff'::regclass
   where (x.schema_name, x.table_name, x.column_name) <> ('public', 'clinicians', 'staff_id')
     and not exists (select 1 from private.staff_record_columns() l where x.schema_name = 'public' and l.table_name = x.table_name and l.column_name = x.column_name)
     and not (k.confdeltype = 'c'
              and exists (select 1 from staff_ref_excluded e where e.schema_name = x.schema_name and e.table_name = x.table_name and e.column_name = x.column_name));
  perform pg_temp.check(v_bad is null,
    'coverage: every foreign key to public.staff is counted, or excluded and removed with the account, or is the doctor link (not: ' || coalesce(v_bad, 'none') || ')');
  -- Labels are plain words for the dialog: a plural and the word for one, all different.
  perform pg_temp.check((select count(*) = count(distinct label) and bool_and(length(one) > 1 and one <> label) from private.staff_record_columns()),
    'every counted column has its own words in the dialog (plural and one)');
end $$;

-- =====================================================================
-- 3. Removing an unused login for good; a used one cannot be removed
-- =====================================================================
-- What delete_staff does as the service role (auth.uid() is null): switch off, unlink the doctor, audit with the whole row, delete the login.
do $$
declare v_row jsonb; v_left int;
begin
  update public.staff set active = false, deactivated_at = now(), deactivated_by = current_setting('test.admin')::uuid where id = current_setting('test.unused')::uuid;
  update public.clinicians set staff_id = null where staff_id = current_setting('test.unused')::uuid;
  select to_jsonb(s) into v_row from public.staff s where id = current_setting('test.unused')::uuid;
  insert into public.audit_log (table_name, row_id, action, old_data, actor)
  values ('staff', current_setting('test.unused'), 'DELETE_LOGIN', v_row, current_setting('test.admin')::uuid);
  delete from auth.users where id = current_setting('test.unused')::uuid;
  perform pg_temp.check(not exists (select 1 from public.staff where id = current_setting('test.unused')::uuid), 'unused: removing the login removes the staff row (no foreign key stops it)');
  perform pg_temp.check(not exists (select 1 from public.staff_permission_overrides where staff_id = current_setting('test.unused')::uuid), 'unused: its personal access ticks went with it');
  perform pg_temp.check((select staff_id is null and is_doctor from public.clinicians where display_name = 'Dr. Unused Thirtythree'), 'unused: the doctor stays in the doctors list, without the login');
  perform pg_temp.check(exists (select 1 from public.audit_log where action = 'DELETE_LOGIN' and row_id = current_setting('test.unused')
      and old_data->>'full_name' = 'Dr. Unused Thirtythree' and old_data->>'email' = 'unused33@dralirashid.com'), 'unused: the audit log keeps the whole staff row');
  -- The busy desk's login cannot be removed: its reminder points at it (a foreign key), and its other records would lose the name.
  perform pg_temp.expect_state(format('delete from auth.users where id = %L', current_setting('test.busy')), '23503', 'foreign key',
    'busy: its login cannot be removed while records point at it');
  select count(*) into v_left from public.staff where id = current_setting('test.busy')::uuid;
  perform pg_temp.check(v_left = 1, 'busy: the staff row is still there');
end $$;

-- =====================================================================
-- 4. The deleted mark
-- =====================================================================
do $$
begin
  -- As the service role (delete_staff): a deleted account is always switched off.
  perform pg_temp.expect_state(format('update public.staff set deleted_at = now() where id = %L', current_setting('test.busy')), '23514', 'staff_deleted_is_switched_off',
    'an account that is switched on cannot be marked deleted');
  update public.staff set active = false, deactivated_at = now(), deactivated_by = current_setting('test.admin')::uuid where id = current_setting('test.busy')::uuid;
  update public.staff set deleted_at = now(), deleted_by = current_setting('test.admin')::uuid where id = current_setting('test.busy')::uuid;
  perform pg_temp.check((select deleted_at is not null and deleted_by = current_setting('test.admin')::uuid and not active from public.staff where id = current_setting('test.busy')::uuid),
    'the service role marks a switched-off account deleted (as delete_staff does)');
  perform pg_temp.expect_state(format('update public.staff set active = true where id = %L', current_setting('test.busy')), '23514', 'staff_deleted_is_switched_off',
    'a deleted account cannot be switched back on (Bring back first)');
end $$;

set role authenticated;
do $$
declare n int;
begin
  -- A user manager can reach staff rows (users.manage), but never the deleted mark: not on others, not on themselves.
  perform pg_temp.act_as(current_setting('test.mgr'));
  perform pg_temp.expect_state(format('update public.staff set deleted_at = null, deleted_by = null where id = %L', current_setting('test.busy')), null, 'deleted and brought back',
    'user manager: cannot clear the deleted mark by hand');
  perform pg_temp.expect_state(format('update public.staff set active = false, deleted_at = now() where id = %L', current_setting('test.plain')), null, 'deleted and brought back',
    'user manager: cannot mark another account deleted by hand');
  perform pg_temp.expect_state(format('update public.staff set deleted_by = %L where id = %L', current_setting('test.mgr'), current_setting('test.gone')), null, 'deleted and brought back',
    'user manager: cannot write deleted_by either');
  perform pg_temp.expect_state(format('update public.staff set deleted_at = now() where id = %L', current_setting('test.mgr')), null, 'deleted and brought back',
    'user manager: cannot mark their own account deleted');
  perform pg_temp.expect_state($i$insert into public.staff (id, full_name, email, role, active, deleted_at) values ('00000000-0000-0000-0000-0000000033aa', 'Sneaky', 'sneaky33@dralirashid.com', 'front_desk', false, now())$i$,
    null, 'deleted and brought back', 'user manager: cannot make a new row that is already deleted');
  perform pg_temp.check((select deleted_at is not null from public.staff where id = current_setting('test.busy')::uuid)
    and (select deleted_at is null from public.staff where id = current_setting('test.plain')::uuid), 'user manager: the refused changes left the marks as they were');
  -- Nor remove a staff row by hand: that would skip the count, and the records would lose the name (or the row could be put back
  -- switched on, without the mark). Only delete_staff (the service role) or the admin removes an account.
  perform pg_temp.expect_state(format('delete from public.staff where id = %L', current_setting('test.busy')), null, 'Only admin',
    'user manager: cannot remove a deleted account''s row by hand');
  perform pg_temp.expect_state(format('delete from public.staff where id = %L', current_setting('test.plain')), null, 'Only admin',
    'user manager: cannot remove any staff row by hand, not even one without records');
  perform pg_temp.check((select count(*) from public.staff where id in (current_setting('test.busy')::uuid, current_setting('test.plain')::uuid)) = 2,
    'user manager: both rows are still there');
  -- Other edits of a deleted account still work for them (the mark is the only thing guarded).
  update public.staff set phone = '03005553399' where id = current_setting('test.busy')::uuid;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'user manager: may still edit other fields of a deleted account');

  -- A desk without users.manage reaches no staff row at all.
  perform pg_temp.act_as(current_setting('test.plain'));
  update public.staff set deleted_at = now() where id = current_setting('test.plain')::uuid;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0, 'a desk without users.manage: cannot mark even its own account (no row reached)');

  -- The admin may (as with every other staff field); Bring back clears the mark and the account stays switched off.
  perform pg_temp.act_as(current_setting('test.admin'));
  update public.staff set deleted_at = null, deleted_by = null where id = current_setting('test.busy')::uuid;
  perform pg_temp.check((select deleted_at is null and deleted_by is null and not active from public.staff where id = current_setting('test.busy')::uuid),
    'admin: the mark can be cleared; the account stays switched off');
end $$;
reset role;
select pg_temp.act_as('');

-- =====================================================================
-- 5. The login log
-- =====================================================================
update public.staff set active = false, deleted_at = now(), deleted_by = :admin where id = :busy;
-- The account that was never used is removed for good too: its DELETE_LOGIN audit row first, then the login.
insert into public.audit_log (table_name, row_id, action, old_data, actor)
values ('staff', :gone, 'DELETE_LOGIN', jsonb_build_object('full_name', 'Never Used Thirtythree', 'role', 'front_desk'), :admin);
delete from auth.users where id = :gone;
set role authenticated;
select pg_temp.act_as(:admin);
select pg_temp.check((select count(*) from jsonb_array_elements(public.staff_logins()->'staff') s
                       where s->>'full_name' = 'Busy Desk Thirtythree' and s->>'deleted_at' is not null and s->>'active' = 'false') = 1,
  'staff_logins: a deleted account is listed with its deleted_at');
select pg_temp.check((select count(*) from jsonb_array_elements(public.staff_logins()->'staff') s where s ? 'deleted_at') =
                     (select jsonb_array_length(public.staff_logins()->'staff')), 'staff_logins: every account has deleted_at');
select pg_temp.check((select count(*) from jsonb_array_elements(public.staff_logins()->'events') e
                       where e->>'name' = 'Never Used Thirtythree' and e->>'role' = 'front_desk' and e->>'user_agent' = 'Safari on iPhone') = 1,
  'staff_logins: the sign-in of a login removed for good keeps its name and role from the audit log');
select pg_temp.check((select count(*) from jsonb_array_elements(public.staff_logins()->'events') e
                       where e->>'name' = 'Dr. Unused Thirtythree' and e->>'role' = 'doctor') = 1,
  'staff_logins: and so does the unused doctor removed in part 3');
reset role;
select pg_temp.act_as('');
rollback;
