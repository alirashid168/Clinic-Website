-- The Google Sheet keeps its rows (20261017000100_aaj_keep_rows.sql). Every case prints "ok - ..." or the file fails.
-- Owner, 17 Oct 2026: "please dont delete the aaj ki list google sheet entries daily, one of my assistant does it after recording the
-- treatments in healthwire" (sometimes the same evening, sometimes the next day). A call that says keep_rows (the new script) lets a deleted
-- row of a patient who is done (Completed, Treatment, Cancelled) go off the sheet: the website keeps the record exactly as it is and the row
-- does not come back. A call without it (the old script) gets the old answers. Conventions of 25_aaj_sync_test.sql: one transaction (now()
-- is fixed), the script's calls run as role anon. Made-up names and numbers only.
\set ON_ERROR_STOP 1
\set admin '''00000000-0000-0000-0000-000000040001'''

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'TEST FAILED: %', msg; end if;
  raise notice 'ok - %', msg;
end $$;
create or replace function pg_temp.s40_k(n int) returns text language sql as $$ select 'S-4' || lpad(to_hex(n), 11, '0') $$;
create or replace function pg_temp.s40_today() returns date language sql as $$ select (now() at time zone 'Asia/Karachi')::date $$;
create or replace function pg_temp.s40_bid() returns smallint language sql as $$ select id from public.branches where code = 'ISB' $$;
create or replace function pg_temp.s40_row(p_key text, p_set jsonb) returns jsonb language sql as $$
  select jsonb_build_object('key', p_key, 'new', true, 'set', p_set) $$;
-- one Islamabad tab: rows, the keys present, the removal pass or not, keep_rows or not (the old script sends no such key at all)
create or replace function pg_temp.s40_pl(p_rows jsonb, p_present text[], p_check boolean, p_keep boolean) returns jsonb language sql as $$
  select jsonb_build_object('date', (now() at time zone 'Asia/Karachi')::date, 'check_removed', p_check,
           'tabs', jsonb_build_array(jsonb_build_object('branch', 'ISB', 'tab', 'Islamabad', 'hash', null, 'present', to_jsonb(p_present), 'rows', p_rows)))
         || case when p_keep then jsonb_build_object('keep_rows', true) else '{}'::jsonb end $$;
create or replace function pg_temp.s40_sync(p jsonb) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  set local role anon;
  r := public.aaj_sync('sync-secret', p);
  reset role;
  return r;
end $$;
-- every key of today's Islamabad list except the given ones (the rows still on the sheet)
create or replace function pg_temp.s40_keys(excl text[] default '{}') returns text[] language sql as $$
  select coalesce(array(select k from (
           select sheet_key as k from public.visits where branch_id = pg_temp.s40_bid() and visit_date = pg_temp.s40_today()
           union all select sheet_key from public.checkups where branch_id = pg_temp.s40_bid() and checkup_date = pg_temp.s40_today()) x
          where k is not null and k <> all (excl) order by k), '{}') $$;
create or replace function pg_temp.s40_rm(p_resp jsonb, p_key text) returns jsonb language sql as $$
  select x from jsonb_array_elements(p_resp->'tabs'->0->'removed') x where x->>'key' = p_key $$;
create or replace function pg_temp.s40_item(p_resp jsonb, p_key text) returns jsonb language sql as $$
  select x from jsonb_array_elements(p_resp->'tabs'->0->'visits') x where x->>'key' = p_key $$;
create or replace function pg_temp.s40_vis(p_key text) returns public.visits language sql as $$ select v from public.visits v where v.sheet_key = p_key $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

begin;
-- the bodies are the ones the header of 20261017000100_aaj_keep_rows.sql names (its read-only check on the live database compares these)
select pg_temp.check((select string_agg(p.proname || '=' || md5(p.prosrc), ' ' order by p.proname) from pg_proc p
                       where (p.pronamespace = 'public'::regnamespace and p.proname = 'aaj_sync')
                          or (p.pronamespace = 'private'::regnamespace and p.proname in ('aaj_removals', 'aaj_day_list', 'aaj_sync_row', 'aaj_off_done')))
                     = 'aaj_day_list=e06e36c82cdb77bc6ff38fca7fc743fb aaj_off_done=95310b9b6af75e99742ed69e03224280 aaj_removals=042ac2530063f70660eec06617abfa3e'
                       || ' aaj_sync=b36b7678493aa134c9e733b73a3d8005 aaj_sync_row=78060381dae13746fbd739a2fa7b10e3',
  'the five function bodies have the md5 the migration header gives for the live check');
create extension if not exists pgcrypto;
insert into auth.users (id, email) values (:admin, 'ali40@dralirashid.com');
insert into public.staff (id, full_name, email, role) values (:admin, 'Dr. Ali Rashid', 'ali40@dralirashid.com', 'admin');
insert into private.sync_secrets (name, secret_hash) values ('aaj_sheet_sync', encode(digest('sync-secret', 'sha256'), 'hex'))
  on conflict (name) do update set secret_hash = excluded.secret_hash;
update private.aaj_sync_config set value = '100000' where key = 'calls_per_minute';
create temp table s40_resp (n text primary key, resp jsonb);
delete from public.visits where branch_id = pg_temp.s40_bid() and visit_date between pg_temp.s40_today() - 1 and pg_temp.s40_today();
delete from public.checkups where branch_id = pg_temp.s40_bid() and checkup_date between pg_temp.s40_today() - 1 and pg_temp.s40_today();
insert into public.patients (mr_number, full_name, phone, first_branch_id)
  select '4000' || lpad(g::text, 2, '0'), 'Keep Patient ' || lpad(g::text, 2, '0'), '031400000' || lpad(g::text, 2, '0'), pg_temp.s40_bid() from generate_series(1, 40) g;

-- the day's list: 16 rows of Islamabad, made from the sheet (status as typed: the sheet's Completed completes, owner rule)
--   1-4 Completed, 5 Treatment, 6-9 Waiting, 10 No show, 11 Scheduled, 12 Waiting (cancelled on the website below)
--   checkups: 13 Completed, 14 Treatment, 15 Waiting, 16 Waiting
insert into s40_resp select 'day', pg_temp.s40_sync(pg_temp.s40_pl(jsonb_build_array(
  pg_temp.s40_row(pg_temp.s40_k(1), '{"mr":"400001","name":"Keep Patient 01","treatment":"Scaling","status":{"t":"Completed","v":"completed"}}'),
  pg_temp.s40_row(pg_temp.s40_k(2), '{"mr":"400002","name":"Keep Patient 02","treatment":"Scaling","status":{"t":"Completed","v":"completed"}}'),
  pg_temp.s40_row(pg_temp.s40_k(3), '{"mr":"400003","name":"Keep Patient 03","treatment":"Scaling","status":{"t":"Completed","v":"completed"}}'),
  pg_temp.s40_row(pg_temp.s40_k(4), '{"mr":"400004","name":"Keep Patient 04","treatment":"Scaling","status":{"t":"Completed","v":"completed"}}'),
  pg_temp.s40_row(pg_temp.s40_k(5), '{"mr":"400005","name":"Keep Patient 05","treatment":"Filling","status":{"t":"Treatment","v":"in_treatment"}}'),
  pg_temp.s40_row(pg_temp.s40_k(6), '{"mr":"400006","name":"Keep Patient 06","treatment":"Scaling"}'),
  pg_temp.s40_row(pg_temp.s40_k(7), '{"mr":"400007","name":"Keep Patient 07","treatment":"Scaling"}'),
  pg_temp.s40_row(pg_temp.s40_k(8), '{"mr":"400008","name":"Keep Patient 08","treatment":"Scaling"}'),
  pg_temp.s40_row(pg_temp.s40_k(9), '{"mr":"400009","name":"Keep Patient 09","treatment":"Scaling"}'),
  pg_temp.s40_row(pg_temp.s40_k(10), '{"mr":"400010","name":"Keep Patient 10","treatment":"Scaling","status":{"t":"No show","v":"no_show"}}'),
  pg_temp.s40_row(pg_temp.s40_k(11), '{"mr":"400011","name":"Keep Patient 11","treatment":"Scaling","status":{"t":"Scheduled","v":"scheduled"}}'),
  pg_temp.s40_row(pg_temp.s40_k(12), '{"mr":"400012","name":"Keep Patient 12","treatment":"Scaling"}'),
  pg_temp.s40_row(pg_temp.s40_k(13), '{"name":"Keep Check M","phone":"03140000113","treatment":"Checkup","status":{"t":"Completed","v":"completed"},"details":"needs braces"}'),
  pg_temp.s40_row(pg_temp.s40_k(14), '{"name":"Keep Check N","phone":"03140000114","treatment":"Checkup","status":{"t":"Treatment","v":"in_treatment"}}'),
  pg_temp.s40_row(pg_temp.s40_k(15), '{"name":"Keep Check O","phone":"03140000115","treatment":"Checkup"}'),
  pg_temp.s40_row(pg_temp.s40_k(16), '{"name":"Keep Check P","phone":"03140000116","treatment":"Checkup"}')),
  array(select pg_temp.s40_k(g) from generate_series(1, 16) g), false, true));
select pg_temp.check((select count(*) = 16 and bool_and(x->>'outcome' = 'created') from jsonb_array_elements((select resp->'tabs'->0->'results' from s40_resp where n = 'day')) x)
                     and (select count(*) from public.visits where branch_id = pg_temp.s40_bid() and visit_date = pg_temp.s40_today()) = 12
                     and (select count(*) from public.checkups where branch_id = pg_temp.s40_bid() and checkup_date = pg_temp.s40_today()) = 4,
  'setup: 12 visits and 4 checkups of today made from the sheet (keep_rows changes nothing about rows that are sent)');
select pg_temp.check((select string_agg(status::text, ',' order by sheet_key) from public.visits where branch_id = pg_temp.s40_bid() and visit_date = pg_temp.s40_today())
                     = 'completed,completed,completed,completed,in_treatment,waiting,waiting,waiting,waiting,no_show,scheduled,waiting', 'setup: the statuses as typed');
create temp table s40_snap as select * from public.visits where branch_id = pg_temp.s40_bid() and visit_date = pg_temp.s40_today();
create temp table s40_csnap as select * from public.checkups where branch_id = pg_temp.s40_bid() and checkup_date = pg_temp.s40_today();
-- yesterday's rows are kept on the tab: records of yesterday with sheet keys that the script never sends in "present"
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, sheet_key)
  select id, pg_temp.s40_bid(), pg_temp.s40_today() - 1, 'completed', 'Scaling', pg_temp.s40_k(200 + right(mr_number, 2)::int)
    from public.patients where mr_number in ('400021', '400022');

-- =====================================================================
-- 1. The old script (no keep_rows) gets the old answers from this file's functions
-- =====================================================================
insert into s40_resp select 'old1', pg_temp.s40_sync(pg_temp.s40_pl('[]', pg_temp.s40_keys(array[pg_temp.s40_k(1)]), true, false));
select pg_temp.check((select x->>'action' = 'restore' and x->>'message' = 'Not removed: this visit is Completed on the website. To take a patient off, set Status to Cancelled.'
                        from (select pg_temp.s40_rm((select resp from s40_resp where n = 'old1'), pg_temp.s40_k(1)) x) y)
                     and not exists (select 1 from private.aaj_released rl join public.visits v on v.id = rl.visit_id where v.sheet_key = pg_temp.s40_k(1))
                     and not exists (select 1 from public.audit_log where action = 'SHEET_OFF'),
  'old script: a deleted Completed row comes back with "Not removed" as before (nothing released, no SHEET_OFF)');
insert into s40_resp select 'old2', pg_temp.s40_sync(pg_temp.s40_pl('[]', pg_temp.s40_keys(array[pg_temp.s40_k(1), pg_temp.s40_k(2), pg_temp.s40_k(6), pg_temp.s40_k(7)]), true, false));
select pg_temp.check((select count(*) = 4 and bool_and(x->>'action' = 'restore' and x->>'message' = 'Needs attention: 4 rows disappeared at once, so nothing was removed from the website. Delete wrong entries on the website, or delete fewer rows at a time.')
                        from jsonb_array_elements((select resp->'tabs'->0->'removed' from s40_resp where n = 'old2')) x),
  'old script: four rows at once (two Completed, two Waiting) all come back with the old "Needs attention", no extra words');
select pg_temp.check((select count(*) from public.visits v join s40_snap s on s.id = v.id where v.status = s.status and v.updated_at = s.updated_at) = 12,
  'old script: nothing changed on the website');

-- =====================================================================
-- 2. keep_rows: one row of a patient who is done, deleted the same evening
-- =====================================================================
insert into s40_resp select 'k1', pg_temp.s40_sync(pg_temp.s40_pl('[]', pg_temp.s40_keys(array[pg_temp.s40_k(1)]), true, true));
select pg_temp.check((select x->>'action' = 'released' and x->>'name' = 'Keep Patient 01' and x->>'message' = 'Taken off the sheet; kept on the website (Completed).'
                        from (select pg_temp.s40_rm((select resp from s40_resp where n = 'k1'), pg_temp.s40_k(1)) x) y)
                     and jsonb_array_length((select resp->'tabs'->0->'removed' from s40_resp where n = 'k1')) = 1,
  'keep_rows: a deleted Completed row is answered "Taken off the sheet; kept on the website (Completed)." (the script writes it to its log)');
select pg_temp.check((select to_jsonb(v) = to_jsonb(s) from public.visits v join s40_snap s on s.id = v.id where v.sheet_key = pg_temp.s40_k(1)),
  'keep_rows: the visit is kept exactly as it was (every column, updated_at too)');
select pg_temp.check((select rl.status = 'completed' and rl.sheet_key = pg_temp.s40_k(1) from private.aaj_released rl join public.visits v on v.id = rl.visit_id where v.sheet_key = pg_temp.s40_k(1))
                     and (select count(*) = 1 and bool_and(a.new_data->>'status' = 'completed' and a.new_data->>'kind' = 'visit' and a.new_data->>'tab' = 'Islamabad' and a.old_data is null)
                            from public.audit_log a where a.action = 'SHEET_OFF' and a.new_data->>'key' = pg_temp.s40_k(1))
                     and not exists (select 1 from public.audit_log where action = 'SHEET_REMOVED' and new_data->>'key' = pg_temp.s40_k(1)),
  'keep_rows: it is released as completed, with one small SHEET_OFF row in the audit log (never SHEET_REMOVED)');
select pg_temp.check((select (x->>'claimed')::boolean and not (x->>'removed')::boolean and x->>'status' = 'Completed' from (select pg_temp.s40_item((select resp from s40_resp where n = 'k1'), pg_temp.s40_k(1)) x) y),
  'keep_rows: the list sends it claimed and not "removed": the script (old or new) does not add its row back');
insert into s40_resp select 'k1b', pg_temp.s40_sync(pg_temp.s40_pl('[]', pg_temp.s40_keys(array[pg_temp.s40_k(1)]), true, true));
select pg_temp.check((select resp->'tabs'->0->'removed' = '[]'::jsonb from s40_resp where n = 'k1b')
                     and (select count(*) from public.audit_log where action = 'SHEET_OFF' and new_data->>'key' = pg_temp.s40_k(1)) = 1,
  'keep_rows: the next minutes say nothing more about it (once released it is no removal candidate)');
insert into s40_resp select 'k1c', pg_temp.s40_sync(pg_temp.s40_pl('[]', pg_temp.s40_keys(array[pg_temp.s40_k(1), pg_temp.s40_k(5)]), true, true));
select pg_temp.check((select x->>'action' = 'released' and x->>'message' = 'Taken off the sheet; kept on the website (Treatment).' from (select pg_temp.s40_rm((select resp from s40_resp where n = 'k1c'), pg_temp.s40_k(5)) x) y)
                     and (pg_temp.s40_vis(pg_temp.s40_k(5))).status = 'in_treatment',
  'keep_rows: a patient in Treatment is taken off the sheet the same way (kept in Treatment)');
-- the checkups: Completed and Treatment, one at a time
insert into s40_resp select 'k1d', pg_temp.s40_sync(pg_temp.s40_pl('[]', pg_temp.s40_keys(array[pg_temp.s40_k(1), pg_temp.s40_k(5), pg_temp.s40_k(13)]), true, true));
select pg_temp.check((select x->>'action' = 'released' and x->>'name' = 'Keep Check M' and x->>'message' = 'Taken off the sheet; kept on the website (Completed).' from (select pg_temp.s40_rm((select resp from s40_resp where n = 'k1d'), pg_temp.s40_k(13)) x) y)
                     and (select to_jsonb(c) = to_jsonb(s) from public.checkups c join s40_csnap s on s.id = c.id where c.sheet_key = pg_temp.s40_k(13))
                     and exists (select 1 from private.aaj_released rl join public.checkups c on c.id = rl.checkup_id where c.sheet_key = pg_temp.s40_k(13) and rl.status = 'completed')
                     and (select (x->>'claimed')::boolean and not (x->>'removed')::boolean from (select pg_temp.s40_item((select resp from s40_resp where n = 'k1d'), pg_temp.s40_k(13)) x) y),
  'keep_rows: a Completed checkup is taken off the sheet, kept exactly as it was (its details stay for the follow-up), not added back');

-- =====================================================================
-- 3. keep_rows: Ctrl+Z right after: the row comes back with its key and is linked again (nothing was removed, nothing to put back)
-- =====================================================================
insert into s40_resp select 'z1', pg_temp.s40_sync(pg_temp.s40_pl('[]', pg_temp.s40_keys(array[pg_temp.s40_k(5), pg_temp.s40_k(13)]), true, true));
select pg_temp.check(not exists (select 1 from private.aaj_released rl join public.visits v on v.id = rl.visit_id where v.sheet_key = pg_temp.s40_k(1))
                     and (select resp->'tabs'->0->'removed' = '[]'::jsonb from s40_resp where n = 'z1')
                     and (select not (x->>'removed')::boolean from (select pg_temp.s40_item((select resp from s40_resp where n = 'z1'), pg_temp.s40_k(1)) x) y)
                     and (select to_jsonb(v) = to_jsonb(s) from public.visits v join s40_snap s on s.id = v.id where v.sheet_key = pg_temp.s40_k(1)),
  'keep_rows + Ctrl+Z: the key is on the sheet again, the released mark goes and the visit is the row''s again, unchanged');
-- a released Treatment visit that front desk sets back to Waiting on the website works again: the list says "removed" so the script adds it back
update public.visits set status = 'waiting' where sheet_key = pg_temp.s40_k(5);
insert into s40_resp select 'z2', pg_temp.s40_sync(pg_temp.s40_pl('[]', pg_temp.s40_keys(array[pg_temp.s40_k(5), pg_temp.s40_k(13)]), true, true));
select pg_temp.check((select (x->>'removed')::boolean and x->>'status' = 'Waiting' from (select pg_temp.s40_item((select resp from s40_resp where n = 'z2'), pg_temp.s40_k(5)) x) y)
                     and (select resp->'tabs'->0->'removed' = '[]'::jsonb from s40_resp where n = 'z2')
                     and (pg_temp.s40_vis(pg_temp.s40_k(5))).status = 'waiting',
  'a patient taken off the sheet while done, set back to Waiting on the website: never removed as a deleted row, and the list marks it so its row comes back');
update public.visits set status = 'in_treatment' where sheet_key = pg_temp.s40_k(5);

-- =====================================================================
-- 4. keep_rows: a Cancelled patient's row deleted is named too (in any call that lists the rows, not only the removal pass)
-- =====================================================================
update public.visits set status = 'cancelled' where sheet_key = pg_temp.s40_k(12);
insert into s40_resp select 'c1', pg_temp.s40_sync(pg_temp.s40_pl('[]', pg_temp.s40_keys(array[pg_temp.s40_k(5), pg_temp.s40_k(13), pg_temp.s40_k(12)]), false, true));
select pg_temp.check((select x->>'action' = 'released' and x->>'name' = 'Keep Patient 12' and x->>'message' = 'Taken off the sheet; kept on the website (Cancelled).' from (select pg_temp.s40_rm((select resp from s40_resp where n = 'c1'), pg_temp.s40_k(12)) x) y)
                     and (pg_temp.s40_vis(pg_temp.s40_k(12))).status = 'cancelled'
                     and (select (x->>'removed')::boolean from (select pg_temp.s40_item((select resp from s40_resp where n = 'c1'), pg_temp.s40_k(12)) x) y),
  'keep_rows: a Cancelled row taken off the sheet is released and named, kept Cancelled (and "removed" in the list: back only once it works again)');
insert into s40_resp select 'c2', pg_temp.s40_sync(pg_temp.s40_pl('[]', pg_temp.s40_keys(array[pg_temp.s40_k(5), pg_temp.s40_k(13), pg_temp.s40_k(12)]), true, true));
select pg_temp.check((select resp->'tabs'->0->'removed' = '[]'::jsonb from s40_resp where n = 'c2'), 'and it is named once');
-- a Cancelled checkup the same (the old script is told nothing about it: as before)
update public.checkups set day_status = 'cancelled' where sheet_key = pg_temp.s40_k(16);
insert into s40_resp select 'c3', pg_temp.s40_sync(pg_temp.s40_pl('[]', pg_temp.s40_keys(array[pg_temp.s40_k(5), pg_temp.s40_k(13), pg_temp.s40_k(12), pg_temp.s40_k(16)]), false, false));
select pg_temp.check((select resp->'tabs'->0->'removed' = '[]'::jsonb from s40_resp where n = 'c3')
                     and exists (select 1 from private.aaj_released rl join public.checkups c on c.id = rl.checkup_id where c.sheet_key = pg_temp.s40_k(16) and rl.status = 'cancelled'),
  'old script: a Cancelled checkup whose row left the sheet is released silently, as before');
delete from private.aaj_released rl using public.checkups c where rl.checkup_id = c.id and c.sheet_key = pg_temp.s40_k(16);
insert into s40_resp select 'c4', pg_temp.s40_sync(pg_temp.s40_pl('[]', pg_temp.s40_keys(array[pg_temp.s40_k(5), pg_temp.s40_k(13), pg_temp.s40_k(12), pg_temp.s40_k(16)]), false, true));
select pg_temp.check((select x->>'action' = 'released' and x->>'name' = 'Keep Check P' and x->>'message' = 'Taken off the sheet; kept on the website (Cancelled).' from (select pg_temp.s40_rm((select resp from s40_resp where n = 'c4'), pg_temp.s40_k(16)) x) y),
  'keep_rows: a Cancelled checkup taken off the sheet is named too');
update public.checkups set day_status = 'waiting' where sheet_key = pg_temp.s40_k(16);
delete from private.aaj_released rl using public.checkups c where rl.checkup_id = c.id and c.sheet_key = pg_temp.s40_k(16);

-- =====================================================================
-- 5. keep_rows: many rows at once (the whole evening cleared in one go): the done ones stay off, the waiting ones come back
-- =====================================================================
-- rows 2, 3, 4 (Completed), 14 (checkup in Treatment), 6, 7 (Waiting), 10 (No show) and 15 (Waiting checkup) disappear at once
insert into s40_resp select 'm1', pg_temp.s40_sync(pg_temp.s40_pl('[]', pg_temp.s40_keys(array[pg_temp.s40_k(5), pg_temp.s40_k(13), pg_temp.s40_k(12),
  pg_temp.s40_k(2), pg_temp.s40_k(3), pg_temp.s40_k(4), pg_temp.s40_k(14), pg_temp.s40_k(6), pg_temp.s40_k(7), pg_temp.s40_k(10), pg_temp.s40_k(15)]), true, true));
select pg_temp.check((select count(*) = 4 and bool_and(x->>'action' = 'released' and x->>'message' like 'Taken off the sheet; kept on the website (%).')
                        from jsonb_array_elements((select resp->'tabs'->0->'removed' from s40_resp where n = 'm1')) x
                       where x->>'key' in (pg_temp.s40_k(2), pg_temp.s40_k(3), pg_temp.s40_k(4), pg_temp.s40_k(14))),
  'keep_rows, eight rows at once: the four of patients who are done are taken off the sheet');
select pg_temp.check((select count(*) = 4 and bool_and(x->>'action' = 'restore' and x->>'message' = 'Needs attention: 8 rows disappeared at once, so nothing was removed from the website. Delete wrong entries on the website, or delete fewer rows at a time. (The rows of patients who are done stay off the sheet.)')
                        from jsonb_array_elements((select resp->'tabs'->0->'removed' from s40_resp where n = 'm1')) x
                       where x->>'key' in (pg_temp.s40_k(6), pg_temp.s40_k(7), pg_temp.s40_k(10), pg_temp.s40_k(15))),
  'keep_rows, eight rows at once: the Waiting, No show and waiting checkup rows come back with "Needs attention" (most likely a mistake)');
select pg_temp.check((select count(*) from public.visits v join s40_snap s on s.id = v.id where v.status = s.status) = 11
                     and (select count(*) from public.checkups where branch_id = pg_temp.s40_bid() and checkup_date = pg_temp.s40_today()) = 4
                     and not exists (select 1 from public.audit_log where action = 'SHEET_REMOVED' and new_data->>'branch' = 'ISB'),
  'keep_rows, eight rows at once: nothing removed or changed on the website (only row 12, cancelled on the website above, differs)');
-- the whole tab cleared (select all, Delete): the done ones go off the sheet, the others come back
insert into s40_resp select 'm2', pg_temp.s40_sync(pg_temp.s40_pl('[]', '{}', true, true));
select pg_temp.check((select count(*) filter (where x->>'action' = 'released') = 1 and count(*) filter (where x->>'action' = 'restore') = 8
                             and bool_and(case when x->>'action' = 'released' then x->>'key' = pg_temp.s40_k(1)
                                               else x->>'message' = 'Needs attention: 9 rows disappeared at once, so nothing was removed from the website. Delete wrong entries on the website, or delete fewer rows at a time. (The rows of patients who are done stay off the sheet.)' end)
                        from jsonb_array_elements((select resp->'tabs'->0->'removed' from s40_resp where n = 'm2')) x)
                     and (select count(*) from public.visits where branch_id = pg_temp.s40_bid() and visit_date = pg_temp.s40_today()) = 12,
  'keep_rows, the whole tab cleared: the one done patient still on it (row 1, linked again by Ctrl+Z) goes off the sheet, the eight working rows come back, the ones already off are not named again, nothing removed');

-- =====================================================================
-- 6. keep_rows: one wrong Waiting row still goes (owner, 9 Oct 2026: "deleted patient means wrong entry, or patient didnt come")
-- =====================================================================
insert into s40_resp select 'w1', pg_temp.s40_sync(pg_temp.s40_pl('[]', pg_temp.s40_keys(array[pg_temp.s40_k(8)]), true, true));
select pg_temp.check((select x->>'action' = 'deleted' and x->>'message' like 'Row deleted in the sheet: the visit is removed from the website too.%' from (select pg_temp.s40_rm((select resp from s40_resp where n = 'w1'), pg_temp.s40_k(8)) x) y)
                     and pg_temp.s40_vis(pg_temp.s40_k(8)) is null
                     and (select count(*) = 1 from public.audit_log where action = 'SHEET_REMOVED' and new_data->>'key' = pg_temp.s40_k(8) and new_data->>'action' = 'deleted'),
  'keep_rows: one Waiting row deleted (a wrong entry) is removed from the website, audited as before');
-- Ctrl+Z of that deletion puts the visit back, as before
insert into s40_resp select 'w2', pg_temp.s40_sync(pg_temp.s40_pl('[]', pg_temp.s40_keys() || pg_temp.s40_k(8), true, true));
select pg_temp.check((pg_temp.s40_vis(pg_temp.s40_k(8))).status = 'waiting', 'keep_rows: Ctrl+Z of a removed Waiting row puts its visit back, as before');
-- a Scheduled row with something attached is kept and marked Cancelled, as before
insert into public.invoices (visit_id, patient_id, branch_id) select id, patient_id, branch_id from public.visits where sheet_key = pg_temp.s40_k(11);
insert into s40_resp select 'w3', pg_temp.s40_sync(pg_temp.s40_pl('[]', pg_temp.s40_keys(array[pg_temp.s40_k(11)]), true, true));
select pg_temp.check((select x->>'action' = 'kept' from (select pg_temp.s40_rm((select resp from s40_resp where n = 'w3'), pg_temp.s40_k(11)) x) y)
                     and (pg_temp.s40_vis(pg_temp.s40_k(11))).status = 'cancelled',
  'keep_rows: a Scheduled row with an invoice is kept and marked Cancelled, as before (not a patient who is done)');

-- =====================================================================
-- 7. keep_rows: the day's cap counts removals only; a record the website let go keeps its own rule; earlier days are never touched
-- =====================================================================
-- sixteen patients who are done, taken off one at a time, do not use up the day's removals (15 on a small day)
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, sheet_key)
  select p.id, pg_temp.s40_bid(), pg_temp.s40_today(), 'completed', 'Polish', pg_temp.s40_k(300 + g)
    from generate_series(1, 16) g join public.patients p on p.mr_number = '4000' || (22 + g);
select pg_temp.check((select count(*) from public.visits where sheet_key between pg_temp.s40_k(301) and pg_temp.s40_k(316) and status = 'completed') = 16, 'setup: 16 more Completed visits');
do $$
declare g int; r jsonb; v_keys text[];
begin
  v_keys := pg_temp.s40_keys(array[pg_temp.s40_k(11)]);
  for g in 1 .. 16 loop
    v_keys := array_remove(v_keys, pg_temp.s40_k(300 + g));
    r := pg_temp.s40_sync(pg_temp.s40_pl('[]', v_keys, true, true));
    if (select x->>'action' from jsonb_array_elements(r->'tabs'->0->'removed') x where x->>'key' = pg_temp.s40_k(300 + g)) is distinct from 'released' then
      raise exception 'TEST FAILED: Completed visit % was not taken off the sheet: %', g, r->'tabs'->0->'removed';
    end if;
  end loop;
  insert into s40_resp values ('cap0', to_jsonb(v_keys));
end $$;
insert into s40_resp select 'cap1', pg_temp.s40_sync(pg_temp.s40_pl('[]', array_remove(array(select jsonb_array_elements_text(resp) from s40_resp where n = 'cap0'), pg_temp.s40_k(9)), true, true));
select pg_temp.check((select x->>'action' = 'deleted' from (select pg_temp.s40_rm((select resp from s40_resp where n = 'cap1'), pg_temp.s40_k(9)) x) y),
  'keep_rows: after sixteen done patients taken off one at a time, a wrong Waiting row is still removed (taking off is not a removal: the day''s cap of 15 is untouched)');
-- a record the website let go itself (the Mr# corrected on a row whose file the sync made, RV9-2) goes as before, also when Completed
update public.visits set status = 'completed' where sheet_key = pg_temp.s40_k(7);
insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
  select 'visits', id::text, 'SHEET_LETGO', null, jsonb_build_object('tab', 'Islamabad', 'key', sheet_key, 'why', 'mr_slip'), private.aaj_sync_actor()
    from public.visits where sheet_key = pg_temp.s40_k(7);
insert into s40_resp select 'lg1', pg_temp.s40_sync(pg_temp.s40_pl('[]', array_remove(array_remove(array(select jsonb_array_elements_text(resp) from s40_resp where n = 'cap0'), pg_temp.s40_k(9)), pg_temp.s40_k(7)), true, true));
select pg_temp.check((select x->>'action' = 'deleted' and x->>'message' like 'The Mr# in this row was corrected and the row was sent again%' from (select pg_temp.s40_rm((select resp from s40_resp where n = 'lg1'), pg_temp.s40_k(7)) x) y)
                     and pg_temp.s40_vis(pg_temp.s40_k(7)) is null,
  'keep_rows: a Completed record the website let go itself (RV9-2) is still removed with its row, not taken off as a done patient');
select pg_temp.check((select count(*) from public.visits where branch_id = pg_temp.s40_bid() and visit_date = pg_temp.s40_today() - 1 and sheet_key in (pg_temp.s40_k(221), pg_temp.s40_k(222)) and status = 'completed') = 2
                     and not exists (select 1 from private.aaj_released rl join public.visits v on v.id = rl.visit_id where v.visit_date = pg_temp.s40_today() - 1)
                     and not exists (select 1 from public.audit_log where new_data->>'key' in (pg_temp.s40_k(221), pg_temp.s40_k(222))),
  'rows of an earlier day kept on the tab (never in "present") are never touched: not removed, not released, not audited');

-- =====================================================================
-- 8. The flag lasts one call; the list's hash does not change for rows that were never taken off
-- =====================================================================
insert into s40_resp select 'f1', pg_temp.s40_sync(pg_temp.s40_pl('[]', pg_temp.s40_keys(array[pg_temp.s40_k(1)]), true, false));
select pg_temp.check((select x->>'action' = 'restore' and x->>'message' like 'Not removed: this visit is Completed%' from (select pg_temp.s40_rm((select resp from s40_resp where n = 'f1'), pg_temp.s40_k(1)) x) y),
  'a call without keep_rows right after keep_rows calls (the same transaction) gets the old answer: the setting is set by every call');
select pg_temp.check((select private.aaj_canon_row(v) = (select x from jsonb_array_elements(private.aaj_day_list(pg_temp.s40_bid(), pg_temp.s40_today())) x where x->>'key' = pg_temp.s40_k(6))
                        from public.visits v where v.sheet_key = pg_temp.s40_k(6)),
  'a row that was never taken off the sheet is exactly the canon row of 20261009000300 in the list (its hash is unchanged)');
select pg_temp.check(not has_function_privilege('anon', 'private.aaj_removals(smallint, date, text, text[])', 'execute')
                     and not has_function_privilege('authenticated', 'private.aaj_day_list(smallint, date)', 'execute')
                     and has_function_privilege('anon', 'public.aaj_sync(text, jsonb)', 'execute')
                     and not has_function_privilege('authenticated', 'public.aaj_sync(text, jsonb)', 'execute'),
  'grants as before: only anon may call the door, the private helpers stay private');

-- =====================================================================
-- 9. keep_rows: the day's cap keeps the rows taken off the sheet in its base (RV10-9), and a done row leaving together with a wrong row
--    does not use it up (RV10-10). (Last, because it writes removals into the audit log that the cases above do not expect.)
-- =====================================================================
-- the sheet now: every record of today except the ones taken off it while done (301-316 and 401-420 below) and row 11 (kept Cancelled)
create or replace function pg_temp.s40_sheet(p_off text[] default '{}') returns text[] language sql as $$
  select pg_temp.s40_keys(array(select pg_temp.s40_k(g) from generate_series(301, 316) g) || array(select pg_temp.s40_k(g) from generate_series(401, 420) g)
                          || pg_temp.s40_k(11) || p_off) $$;
-- (the day's cap as private.aaj_removals counts it: records on the sheet today, removals today, records taken off while done)
create or replace function pg_temp.s40_counts(out v_total int, out v_done int, out v_off int) language sql as $$
  select (select count(*)::int from (
            select 1 from public.visits x where x.branch_id = pg_temp.s40_bid() and x.visit_date = pg_temp.s40_today() and x.sheet_key is not null and x.status <> 'cancelled'
               and not exists (select 1 from private.aaj_released rl where rl.visit_id = x.id)
            union all
            select 1 from public.checkups x where x.branch_id = pg_temp.s40_bid() and x.checkup_date = pg_temp.s40_today() and x.source <> 'archive' and not x.date_is_month
               and x.sheet_key is not null and coalesce(x.day_status, '') <> 'cancelled'
               and not exists (select 1 from private.aaj_released rl where rl.checkup_id = x.id)) y),
         (select count(*)::int from public.audit_log where action = 'SHEET_REMOVED' and new_data->>'branch' = 'ISB'
             and at >= (pg_temp.s40_today()::timestamp at time zone 'Asia/Karachi') and new_data->>'action' in ('deleted', 'kept_cancelled')),
         (select count(*)::int from (
            select 1 from private.aaj_released rl join public.visits x on x.id = rl.visit_id
             where x.branch_id = pg_temp.s40_bid() and x.visit_date = pg_temp.s40_today() and rl.status in ('completed', 'in_treatment')
            union all
            select 1 from private.aaj_released rl join public.checkups x on x.id = rl.checkup_id
             where x.branch_id = pg_temp.s40_bid() and x.checkup_date = pg_temp.s40_today() and rl.status in ('completed', 'in_treatment')) y) $$;
-- (made-up removals of today, written the way aaj_removals writes them: they only make the day's count of removals higher)
create or replace function pg_temp.s40_removals(p_n int) returns void language sql as $$
  insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
  select 'visits', gen_random_uuid()::text, 'SHEET_REMOVED', null,
         jsonb_build_object('tab', 'Islamabad', 'branch', 'ISB', 'date', pg_temp.s40_today(), 'key', 'S-none', 'action', 'deleted', 'kind', 'visit'), private.aaj_sync_actor()
    from generate_series(1, p_n) $$;
insert into public.patients (mr_number, full_name, phone, first_branch_id)
  select '4000' || lpad(g::text, 2, '0'), 'Keep Patient ' || lpad(g::text, 2, '0'), '031400000' || lpad(g::text, 2, '0'), pg_temp.s40_bid() from generate_series(41, 70) g;
-- twenty more patients who are done (taken off the sheet in one go below), six waiting patients who stay on it
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, sheet_key)
  select p.id, pg_temp.s40_bid(), pg_temp.s40_today(), 'completed', 'Polish', pg_temp.s40_k(400 + g)
    from generate_series(1, 20) g join public.patients p on p.mr_number = '4000' || (40 + g);
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, sheet_key)
  select p.id, pg_temp.s40_bid(), pg_temp.s40_today(), 'waiting', 'Scaling', pg_temp.s40_k(430 + g)
    from generate_series(1, 6) g join public.patients p on p.mr_number = '4000' || (60 + g);
insert into s40_resp select 'cb0', pg_temp.s40_sync(pg_temp.s40_pl('[]', pg_temp.s40_sheet(), true, true));
select pg_temp.check((select count(*) = 20 and bool_and(x->>'action' = 'released') from jsonb_array_elements((select resp->'tabs'->0->'removed' from s40_resp where n = 'cb0')) x
                        where x->>'key' = any (array(select pg_temp.s40_k(g) from generate_series(401, 420) g))),
  'setup: twenty more done patients taken off the sheet at once (the evening cleared in one go)');
-- the day's removals brought to 15, the least the cap ever is
select pg_temp.s40_removals(15 - (select v_done from pg_temp.s40_counts()));
select pg_temp.check((select v_done = 15 and v_off >= 30 and greatest(15, ceil(0.35 * (v_total + v_done + v_off))::int) > 16
                             and greatest(15, ceil(0.35 * (v_total + v_done))::int) = 15 from pg_temp.s40_counts()),
  'setup: 15 removals today; with the done rows taken off counted the cap is above 16, without them it is 15');
insert into s40_resp select 'cb1', pg_temp.s40_sync(pg_temp.s40_pl('[]', pg_temp.s40_sheet(array[pg_temp.s40_k(6)]), true, false));
select pg_temp.check((select x->>'action' = 'restore' and x->>'message' = 'Needs attention: too many rows were deleted from this tab today, so nothing was removed from the website. Delete wrong entries on the website.'
                        from (select pg_temp.s40_rm((select resp from s40_resp where n = 'cb1'), pg_temp.s40_k(6)) x) y)
                     and (pg_temp.s40_vis(pg_temp.s40_k(6))).id is not null,
  'old script: a 16th single deletion is held by the old cap (15), as before');
insert into s40_resp select 'cb2', pg_temp.s40_sync(pg_temp.s40_pl('[]', pg_temp.s40_sheet(array[pg_temp.s40_k(6)]), true, true));
select pg_temp.check((select x->>'action' = 'deleted' from (select pg_temp.s40_rm((select resp from s40_resp where n = 'cb2'), pg_temp.s40_k(6)) x) y)
                     and pg_temp.s40_vis(pg_temp.s40_k(6)) is null,
  'keep_rows: the done patients taken off the sheet today still count in the day''s cap (about a third of the day''s rows): the 16th wrong entry deleted alone is removed (RV10-9)');
-- one done row and one wrong Waiting row leave together, with the day's removals just below the cap: the done one does not use it up
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, sheet_key)
  select p.id, pg_temp.s40_bid(), pg_temp.s40_today(), 'completed', 'Polish', pg_temp.s40_k(440) from public.patients p where p.mr_number = '400067';
do $$
declare c record; d int; v_cap int;
begin
  select * into c from pg_temp.s40_counts();
  if 2 * 4 >= c.v_total then raise exception 'TEST FAILED: setup: the tab is too small (two rows would be a quarter of it)'; end if;
  d := c.v_done;
  loop
    v_cap := greatest(15, ceil(0.35 * (c.v_total + d + c.v_off))::int);
    exit when d + 2 > v_cap and d + 1 <= v_cap;
    d := d + 1;
    if d > c.v_done + 300 then raise exception 'TEST FAILED: setup: no number of removals fits'; end if;
  end loop;
  perform pg_temp.s40_removals(d - c.v_done);
end $$;
insert into s40_resp select 'cb3', pg_temp.s40_sync(pg_temp.s40_pl('[]', pg_temp.s40_sheet(array[pg_temp.s40_k(440), pg_temp.s40_k(8)]), true, true));
select pg_temp.check((select x->>'action' = 'released' and x->>'message' = 'Taken off the sheet; kept on the website (Completed).' from (select pg_temp.s40_rm((select resp from s40_resp where n = 'cb3'), pg_temp.s40_k(440)) x) y)
                     and (select x->>'action' = 'deleted' from (select pg_temp.s40_rm((select resp from s40_resp where n = 'cb3'), pg_temp.s40_k(8)) x) y)
                     and pg_temp.s40_vis(pg_temp.s40_k(8)) is null and (pg_temp.s40_vis(pg_temp.s40_k(440))).status = 'completed',
  'keep_rows: a done row and a wrong Waiting row deleted together one removal below the cap: the done one is taken off, the wrong one removed (the done row does not count toward the cap, RV10-10)');

-- =====================================================================
-- 10. keep_rows: a patient whose done row was taken off the sheet comes again the same day (REV2 R2B): a new row that is not done gets a
--     visit of its own and the done one stays as it is; a new row that says Completed is that visit's row back; the old script adopts as before
-- =====================================================================
insert into public.patients (mr_number, full_name, phone, first_branch_id)
  select '4000' || g, 'Keep Patient ' || g, '031400000' || g, pg_temp.s40_bid() from generate_series(71, 74) g;
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, sheet_key)
  select p.id, pg_temp.s40_bid(), pg_temp.s40_today(), 'completed', 'Consultation', pg_temp.s40_k(450 + g)
    from generate_series(1, 3) g join public.patients p on p.mr_number = '4000' || (70 + g);
-- patient 74: a checkup of today registered as them (its row had their Mr#), done
insert into public.checkups (checkup_date, branch_id, patient_name, phone, source, day_status, patient_id, sheet_key)
  select pg_temp.s40_today(), pg_temp.s40_bid(), p.full_name, p.phone, 'google_sheet', 'completed', p.id, pg_temp.s40_k(454) from public.patients p where p.mr_number = '400074';
insert into s40_resp select 'rb0', pg_temp.s40_sync(pg_temp.s40_pl('[]', pg_temp.s40_sheet(array[pg_temp.s40_k(440), pg_temp.s40_k(451), pg_temp.s40_k(452), pg_temp.s40_k(453), pg_temp.s40_k(454)]), true, true));
select pg_temp.check((select count(*) = 4 and bool_and(x->>'action' = 'released') from jsonb_array_elements((select resp->'tabs'->0->'removed' from s40_resp where n = 'rb0')) x
                        where x->>'key' = any (array[pg_temp.s40_k(451), pg_temp.s40_k(452), pg_temp.s40_k(453), pg_temp.s40_k(454)])),
  'setup: three done visits and a done registered checkup taken off the sheet (entered in Healthwire)');
create temp table s40_rb as select v.* from public.visits v where v.sheet_key in (pg_temp.s40_k(451), pg_temp.s40_k(452), pg_temp.s40_k(453));
-- patient 71 comes again for a filling: a new row, Waiting
insert into s40_resp select 'rb1', pg_temp.s40_sync(pg_temp.s40_pl(jsonb_build_array(
  pg_temp.s40_row(pg_temp.s40_k(461), '{"mr":"400071","name":"Keep Patient 71","treatment":"Filling","status":{"t":"Waiting","v":"waiting"}}')),
  pg_temp.s40_sheet(array[pg_temp.s40_k(440), pg_temp.s40_k(451), pg_temp.s40_k(452), pg_temp.s40_k(453), pg_temp.s40_k(454)]) || pg_temp.s40_k(461), false, true));
select pg_temp.check((select r->>'outcome' = 'created' and r->>'level' = 'ok'
                             and r->>'message' = 'Second visit of this patient today: the first (Consultation) is done and was taken off the sheet.'
                        from jsonb_array_elements((select resp->'tabs'->0->'results' from s40_resp where n = 'rb1')) r where r->>'key' = pg_temp.s40_k(461))
                     and (select v.status = 'waiting' and v.treatment_label = 'Filling' and v.id <> (select id from s40_rb where sheet_key = pg_temp.s40_k(451))
                            from public.visits v where v.sheet_key = pg_temp.s40_k(461))
                     and (select to_jsonb(v) = to_jsonb(s) from public.visits v join s40_rb s on s.id = v.id where s.sheet_key = pg_temp.s40_k(451))
                     and exists (select 1 from private.aaj_released rl join s40_rb s on s.id = rl.visit_id where s.sheet_key = pg_temp.s40_k(451)),
  'keep_rows: a new Waiting row of a patient whose done visit was taken off the sheet makes a second visit (a tick that says so); the first stays exactly as it was, off the sheet');
-- patient 72's cleared row comes back with Ctrl+Z after its hidden key was let go: it says Completed, so it is that visit's row
insert into s40_resp select 'rb2', pg_temp.s40_sync(pg_temp.s40_pl(jsonb_build_array(
  pg_temp.s40_row(pg_temp.s40_k(462), '{"mr":"400072","name":"Keep Patient 72","treatment":"Consultation","status":{"t":"Completed","v":"completed"}}')),
  pg_temp.s40_sheet(array[pg_temp.s40_k(440), pg_temp.s40_k(451), pg_temp.s40_k(452), pg_temp.s40_k(453), pg_temp.s40_k(454)]) || pg_temp.s40_k(461) || pg_temp.s40_k(462), false, true));
select pg_temp.check((select r->>'outcome' = 'linked' from jsonb_array_elements((select resp->'tabs'->0->'results' from s40_resp where n = 'rb2')) r where r->>'key' = pg_temp.s40_k(462))
                     and (select count(*) = 1 and bool_and(v.id = (select id from s40_rb where sheet_key = pg_temp.s40_k(452)) and v.status = 'completed')
                            from public.visits v join public.patients p on p.id = v.patient_id where p.mr_number = '400072' and v.visit_date = pg_temp.s40_today()),
  'keep_rows: a new row that says Completed is the done visit''s own row back (a Ctrl+Z): it is linked to it again, nothing is made twice');
-- the old script (no keep_rows) adopts the done visit as before
insert into s40_resp select 'rb3', pg_temp.s40_sync(pg_temp.s40_pl(jsonb_build_array(
  pg_temp.s40_row(pg_temp.s40_k(463), '{"mr":"400073","name":"Keep Patient 73","treatment":"Filling","status":{"t":"Waiting","v":"waiting"}}')),
  pg_temp.s40_sheet(array[pg_temp.s40_k(440), pg_temp.s40_k(451), pg_temp.s40_k(452), pg_temp.s40_k(453), pg_temp.s40_k(454)]) || pg_temp.s40_k(461) || pg_temp.s40_k(462) || pg_temp.s40_k(463), false, false));
select pg_temp.check((select r->>'outcome' = 'linked' from jsonb_array_elements((select resp->'tabs'->0->'results' from s40_resp where n = 'rb3')) r where r->>'key' = pg_temp.s40_k(463))
                     and (select count(*) = 1 from public.visits v join public.patients p on p.id = v.patient_id where p.mr_number = '400073' and v.visit_date = pg_temp.s40_today()),
  'old script: the same new row adopts the done visit, as before (one visit)');
-- patient 74 (a done registered checkup taken off the sheet) comes again for treatment with their Mr#: a visit, not the checkup
insert into s40_resp select 'rb4', pg_temp.s40_sync(pg_temp.s40_pl(jsonb_build_array(
  pg_temp.s40_row(pg_temp.s40_k(464), '{"mr":"400074","name":"Keep Patient 74","treatment":"Bracket repair"}')),
  pg_temp.s40_sheet(array[pg_temp.s40_k(440), pg_temp.s40_k(451), pg_temp.s40_k(452), pg_temp.s40_k(453), pg_temp.s40_k(454)]) || pg_temp.s40_k(461) || pg_temp.s40_k(462) || pg_temp.s40_k(463) || pg_temp.s40_k(464), false, true));
select pg_temp.check((select r->>'outcome' = 'created' from jsonb_array_elements((select resp->'tabs'->0->'results' from s40_resp where n = 'rb4')) r where r->>'key' = pg_temp.s40_k(464))
                     and (select v.status = 'waiting' and v.treatment_label = 'Bracket repair' from public.visits v where v.sheet_key = pg_temp.s40_k(464))
                     and (select c.day_status = 'completed' and c.sheet_key = pg_temp.s40_k(454) from public.checkups c where c.sheet_key = pg_temp.s40_k(454)),
  'keep_rows: a patient whose done checkup was taken off the sheet, typed again with their Mr# and no Status, gets a visit; the checkup stays as it is');

update private.aaj_sync_config set value = '20' where key = 'calls_per_minute';
rollback;
