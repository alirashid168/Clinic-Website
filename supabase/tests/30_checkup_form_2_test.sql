-- Checkup Patient Form 2.0 (20261011000300_checkup_form_2.sql): the four answer columns of public.checkups.
-- Everything below uses made-up people (phones 0300-555xxxx / 0312xxxxxxx).
--   1. the columns, their checks, the view checkup_list and its rights;
--   2. RLS: a branch-limited desk adds and changes a checkup with answers at its own branch only; the accountant reads but
--      cannot change; a patient login and the public see nothing;
--   3. the Google Sheet sync is unchanged: the row it sends (aaj_checkup_canon_row / aaj_day_list) is the same with or without
--      answers, a sheet edit keeps the answers, a row the sheet makes has none, a removed row comes back with its answers, and a
--      Completed checkup (the website saves the form as Completed, also on a checkup the sheet made) stays when its row is deleted;
--   4. import_checkups and register_checkup_as_patient leave the answers alone.
\set ON_ERROR_STOP 1
\set admin  '''00000000-0000-0000-0000-000000003000'''
\set fd     '''00000000-0000-0000-0000-000000003001'''
\set acct   '''00000000-0000-0000-0000-000000003002'''
\set portal '''00000000-0000-0000-0000-000000003003'''

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
-- the sheet's script calls the sync as anon with the secret (as in 25_aaj_sync_test.sql)
create or replace function pg_temp.f30_today() returns date language sql as $$ select (now() at time zone 'Asia/Karachi')::date $$;
create or replace function pg_temp.f30_sync(p_tab jsonb, p_check boolean default false) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  set local role anon;
  r := public.aaj_sync('sync-secret-30', jsonb_build_object('date', (now() at time zone 'Asia/Karachi')::date, 'check_removed', p_check, 'tabs', jsonb_build_array(p_tab)));
  reset role;
  return r;
end $$;
create or replace function pg_temp.f30_tab(p_rows jsonb, p_present text[]) returns jsonb language sql as $$
  select jsonb_build_object('branch', 'NN', 'tab', 'North Nazimabad', 'hash', null, 'present', to_jsonb(p_present), 'rows', p_rows) $$;
create or replace function pg_temp.f30_form() returns public.checkups language sql as $$
  select c from public.checkups c where c.patient_name = 'Sample Form Two' $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

begin;
create extension if not exists pgcrypto;
select set_config('test.admin', :admin, false), set_config('test.fd', :fd, false), set_config('test.acct', :acct, false), set_config('test.portal', :portal, false),
       set_config('test.nn', (select id::text from public.branches where code = 'NN'), false),
       set_config('test.gul', (select id::text from public.branches where code = 'GUL'), false);
insert into auth.users (id, email) values
  (:admin, 'admin30@dralirashid.com'), (:fd, 'fd30@dralirashid.com'), (:acct, 'acct30@dralirashid.com'), (:portal, 'portal30@example.com');
insert into public.staff (id, full_name, email, role) values
  (:admin, 'Admin', 'admin30@dralirashid.com', 'admin'),
  (:fd,    'Front Desk NN', 'fd30@dralirashid.com', 'front_desk'),
  (:acct,  'Accountant', 'acct30@dralirashid.com', 'accountant');
update public.staff set restrict_to_branches = true, branch_ids = array[(select id from public.branches where code = 'NN')] where id = :fd;
insert into public.patients (full_name, phone, portal_user_id) values ('Portal Person (sample)', '03005550998', :portal);
insert into private.sync_secrets (name, secret_hash) values ('aaj_sheet_sync', encode(digest('sync-secret-30', 'sha256'), 'hex'))
  on conflict (name) do update set secret_hash = excluded.secret_hash;
-- an empty Northern list for today, so the day's list holds only this file's rows
delete from public.visits where branch_id = (select id from public.branches where code = 'NN') and visit_date = pg_temp.f30_today();
delete from public.checkups where branch_id = (select id from public.branches where code = 'NN') and checkup_date = pg_temp.f30_today();

-- 1. The columns, the checks and the view.
do $$
begin
  perform pg_temp.check((select array_agg(column_name || ':' || data_type || ':' || is_nullable order by column_name) from information_schema.columns
                          where table_schema = 'public' and table_name = 'checkups' and column_name in ('ali_recommended', 'pricing_understood', 'wants_treatment', 'treatment_plan'))
    = array['ali_recommended:boolean:YES', 'pricing_understood:text:YES', 'treatment_plan:text:YES', 'wants_treatment:boolean:YES'],
    'checkups: the four answer columns exist, all nullable (old rows, sheet rows and imports have no answers)');
  perform pg_temp.check((select count(*) from pg_constraint where conrelid = 'public.checkups'::regclass
                          and conname in ('checkups_pricing_understood_check', 'checkups_treatment_plan_check')) = 2, 'checkups: the two named checks exist once each');
  perform pg_temp.check((select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'checkup_list'
                          and column_name in ('ali_recommended', 'pricing_understood', 'wants_treatment', 'treatment_plan', 'phone_key', 'mr_number')) = 6,
    'checkup_list: the view the Checkups page reads has the answers, the phone key and the Mr#');
  perform pg_temp.check((select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'checkup_list')
                        = (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'checkups') + 2,
    'checkup_list: every column of the table, plus phone_key and mr_number');
  perform pg_temp.check((select 'security_invoker=true' = any (reloptions) from pg_class where oid = 'public.checkup_list'::regclass),
    'checkup_list: still security_invoker (the reader''s own branch limits apply)');
  perform pg_temp.check(has_table_privilege('authenticated', 'public.checkup_list', 'select') and not has_table_privilege('authenticated', 'public.checkup_list', 'insert')
    and not has_table_privilege('authenticated', 'public.checkup_list', 'update') and not has_table_privilege('anon', 'public.checkup_list', 'select'),
    'checkup_list: signed-in staff may only read it, the public not at all (same rights as before)');
  perform pg_temp.check(exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'checkups_wants_treatment_idx'), 'the "Wants to start" filter has its index');
end $$;

do $$
declare v_nn smallint := current_setting('test.nn')::smallint;
begin
  perform pg_temp.act_as(current_setting('test.admin'));
  perform pg_temp.expect_error(format('insert into public.checkups (checkup_date, branch_id, patient_name, pricing_understood) values (current_date, %s, ''Sample Bad Price'', ''maybe'')', v_nn),
    'checkups_pricing_understood_check', 'pricing_understood: only yes / no / needs_explanation');
  perform pg_temp.expect_error(format('insert into public.checkups (checkup_date, branch_id, patient_name, pricing_understood) values (current_date, %s, ''Sample Bad Price'', ''Yes'')', v_nn),
    'checkups_pricing_understood_check', 'pricing_understood: the stored value, not the words on the screen');
  perform pg_temp.expect_error(format('insert into public.checkups (checkup_date, branch_id, patient_name, treatment_plan) values (current_date, %s, ''Sample Long Plan'', repeat(''x'', 501))', v_nn),
    'checkups_treatment_plan_check', 'treatment_plan: at most 500 characters');
  insert into public.checkups (checkup_date, branch_id, patient_name, treatment_plan, pricing_understood) values (current_date - 3, v_nn, 'Sample Max Plan', repeat(chr(128512), 500), 'needs_explanation');
  perform pg_temp.check((select length(treatment_plan) = 500 and pricing_understood = 'needs_explanation' from public.checkups where patient_name = 'Sample Max Plan'),
    'treatment_plan: 500 characters fit (counted as characters, an emoji is one)');
  delete from public.checkups where patient_name = 'Sample Max Plan';
end $$;

-- 2. Who may add, change and read the answers.
set role authenticated;
do $$
declare
  v_nn smallint := current_setting('test.nn')::smallint; v_gul smallint := current_setting('test.gul')::smallint;
  c record; n int; v_id uuid;
begin
  perform pg_temp.act_as(current_setting('test.fd'));
  insert into public.checkups (checkup_date, branch_id, patient_name, phone, city, doctors, checkup_for, day_status, follow_up,
                               ali_recommended, pricing_understood, wants_treatment, treatment_plan)
    values (pg_temp.f30_today(), v_nn, 'Sample Form Two', '0300-555 3001', 'Karachi', 'Dr. Sample (sample)', 'Braces', 'waiting', 'Not Contacted',
            true, 'needs_explanation', true, 'Next month, after the exams');
  select * into c from public.checkup_list where patient_name = 'Sample Form Two';
  perform pg_temp.check(c.ali_recommended and c.pricing_understood = 'needs_explanation' and c.wants_treatment and c.treatment_plan = 'Next month, after the exams'
    and c.source = 'website' and c.created_by = current_setting('test.fd')::uuid and c.phone_key = '03005553001' and c.mr_number is null,
    'front desk: adds a checkup with all nine answers at their branch; checkup_list shows the answers');
  update public.checkups set wants_treatment = false, treatment_plan = 'Wants to compare prices first', pricing_understood = 'no', ali_recommended = false where id = c.id;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1 and (select not wants_treatment and not ali_recommended and pricing_understood = 'no' and treatment_plan = 'Wants to compare prices first'
                                     from public.checkups where id = c.id), 'front desk: may change the answers (they are not columns only the system sets)');
  update public.checkups set wants_treatment = true, treatment_plan = 'Next month, after the exams', pricing_understood = 'needs_explanation', ali_recommended = true where id = c.id;
  perform pg_temp.expect_error(format('insert into public.checkups (checkup_date, branch_id, patient_name, wants_treatment, treatment_plan) values (current_date, %s, ''Sample Other Branch'', true, ''soon'')', v_gul),
    'row-level security', 'front desk: cannot add a checkup with answers at another branch');

  perform pg_temp.act_as(current_setting('test.acct'));
  select * into c from public.checkup_list where patient_name = 'Sample Form Two';
  perform pg_temp.check(c.wants_treatment and c.treatment_plan = 'Next month, after the exams', 'accountant: may read the answers');
  update public.checkups set wants_treatment = false where id = c.id;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0 and (select wants_treatment from public.checkups where id = c.id), 'accountant (no "add and edit Aaj ki List entries"): changing an answer reaches no row');

  perform pg_temp.act_as(current_setting('test.portal'));
  select count(*) into n from public.checkup_list where treatment_plan is not null;
  perform pg_temp.check(n = 0, 'patient login: sees no answers');
end $$;
reset role;
set role anon;
select pg_temp.expect_error($$select treatment_plan from public.checkup_list$$, 'permission denied', 'anon: cannot read the answers');
reset role;

-- 3. The Google Sheet sync does not see the answers.
do $$
declare c public.checkups; c0 public.checkups; j jsonb; d jsonb;
begin
  c := pg_temp.f30_form();
  c0 := c;
  c0.ali_recommended := null; c0.pricing_understood := null; c0.wants_treatment := null; c0.treatment_plan := null;
  j := private.aaj_checkup_canon_row(c);
  perform pg_temp.check(j = private.aaj_checkup_canon_row(c0), 'sync: the row the sheet gets for a checkup is the same with or without the answers');
  perform pg_temp.check((select array_agg(k order by k) from jsonb_object_keys(j) k)
    = array['claimed', 'details', 'doctors', 'group', 'id', 'key', 'kind', 'month', 'mr', 'name', 'phone', 'pp', 'removed', 'status', 'token', 'treatment', 'updated_at'],
    'sync: the checkup row has exactly its 17 keys, no answer among them');
  perform pg_temp.check(position('after the exams' in j::text) = 0 and position('needs_explanation' in j::text) = 0, 'sync: no answer text is in the row');
  perform pg_temp.check(j->>'treatment' = 'Braces' and j->>'doctors' = 'Dr. Sample (sample)' and j->>'name' = 'Sample Form Two' and j->>'phone' = '0300-555 3001',
    'sync: "Who did your checkup?" and "What was your checkup for?" reach the sheet as Doctor and Treatment, as before');
  select x into d from jsonb_array_elements(private.aaj_day_list(current_setting('test.nn')::smallint, pg_temp.f30_today())) x where x->>'id' = c.id::text;
  perform pg_temp.check(d = j, 'sync: the day''s list carries the same row');
end $$;

create temp table f30_resp (n text primary key, resp jsonb);
-- the website's checkup is claimed by its W- key, then a sheet edit reaches it through that key
insert into f30_resp select 'claim', pg_temp.f30_sync(pg_temp.f30_tab('[]', array['W-' || (pg_temp.f30_form()).id]));
select pg_temp.check((select sheet_key = 'W-' || id from pg_temp.f30_form())
                     and (select x = private.aaj_checkup_canon_row(pg_temp.f30_form()) from f30_resp, jsonb_array_elements(resp->'tabs'->0->'visits') x
                           where n = 'claim' and x->>'key' = 'W-' || (pg_temp.f30_form()).id),
  'sync: the checkup with answers is claimed by its W- key, and the list the script gets holds the plain row (no answers)');
insert into f30_resp select 'edit', pg_temp.f30_sync(pg_temp.f30_tab(jsonb_build_array(jsonb_build_object(
  'key', 'W-' || (pg_temp.f30_form()).id, 'new', false, 'set', jsonb_build_object('treatment', 'Braces consult', 'details', 'Upper and lower'),
  'base', jsonb_build_object('treatment', 'Braces', 'details', ''), 'edited_at', floor(extract(epoch from now()) * 1000)::numeric + 5000)),
  array['W-' || (pg_temp.f30_form()).id]));
select pg_temp.check((select resp->'tabs'->0->'results'->0->>'outcome' = 'updated' from f30_resp where n = 'edit')
                     and (select checkup_for = 'Braces consult' and details = 'Upper and lower' and ali_recommended and pricing_understood = 'needs_explanation'
                             and wants_treatment and treatment_plan = 'Next month, after the exams' from pg_temp.f30_form()),
  'sync: a sheet edit of the treatment and details is saved, and the four answers stay as they were');
select pg_temp.check(exists (select 1 from public.audit_log where table_name = 'checkups' and action = 'SHEET_SYNC' and row_id = (pg_temp.f30_form()).id::text)
                     and not exists (select 1 from public.audit_log where table_name = 'checkups' and action = 'SHEET_SYNC' and row_id = (pg_temp.f30_form()).id::text
                                       and (coalesce(new_data::text, '') like '%after the exams%' or coalesce(old_data::text, '') like '%after the exams%')),
  'sync: its audit rows hold the sheet row (no answers in them)');

-- a checkup the sheet makes (a row with no Mr# whose Treatment says checkup) has no answers
insert into f30_resp select 'new', pg_temp.f30_sync(pg_temp.f30_tab(jsonb_build_array(jsonb_build_object(
  'key', 'S-00000000f301', 'new', true, 'set', jsonb_build_object('name', 'Sample Sheet Person', 'phone', '03120003001', 'treatment', 'Checkup'))),
  array['W-' || (pg_temp.f30_form()).id, 'S-00000000f301']));
select pg_temp.check((select resp->'tabs'->0->'results'->0->>'outcome' = 'created' from f30_resp where n = 'new')
                     and (select source = 'google_sheet' and ali_recommended is null and pricing_understood is null and wants_treatment is null and treatment_plan is null
                            from public.checkups where sheet_key = 'S-00000000f301'),
  'sync: a checkup made from the sheet has no answers (the sheet does not ask the nine questions)');

-- the row deleted in the sheet: the checkup (Waiting, no follow-up work) is removed as before, with its answers in the audit row;
-- the row put back brings the checkup back with its answers
insert into f30_resp select 'rm', pg_temp.f30_sync(pg_temp.f30_tab('[]', array['S-00000000f301']), true);
select pg_temp.check((select x->>'action' = 'deleted' from f30_resp, jsonb_array_elements(resp->'tabs'->0->'removed') x where n = 'rm')
                     and (select count(*) = 0 from public.checkups where patient_name = 'Sample Form Two')
                     and (select old_data->>'treatment_plan' = 'Next month, after the exams' and (old_data->>'wants_treatment')::boolean from public.audit_log
                           where table_name = 'checkups' and action = 'SHEET_REMOVED' and old_data->>'patient_name' = 'Sample Form Two'),
  'sync: a deleted row removes the checkup as before (the removal rules do not look at the answers); the audit row keeps them');
insert into f30_resp select 'back', pg_temp.f30_sync(pg_temp.f30_tab('[]', array['S-00000000f301', 'W-' || (select row_id from public.audit_log
  where table_name = 'checkups' and action = 'SHEET_REMOVED' and old_data->>'patient_name' = 'Sample Form Two')]));
select pg_temp.check((select ali_recommended and pricing_understood = 'needs_explanation' and wants_treatment and treatment_plan = 'Next month, after the exams'
                        and checkup_for = 'Braces consult' from pg_temp.f30_form()),
  'sync: the row put back in the sheet brings the checkup back with its four answers');

-- The website saves a checkup from the form as Completed (the answers are given after the checkup), and the form saved on a checkup the
-- sheet made (the person typed in on arrival, then interviewed) makes that one Completed too. A row deleted in the sheet then keeps the
-- checkup and its answers (the removal rules are unchanged: they keep a Completed checkup).
create temp table f30_canon as select private.aaj_checkup_canon_row(c) as j from public.checkups c where c.sheet_key = 'S-00000000f301';
set role authenticated;
do $$
declare n int;
begin
  perform pg_temp.act_as(current_setting('test.fd'));
  update public.checkups set day_status = 'completed' where id = (pg_temp.f30_form()).id;
  update public.checkups set doctors = 'Dr. Sample (sample)', checkup_for = 'Braces', ali_recommended = false, pricing_understood = 'yes',
         wants_treatment = false, treatment_plan = 'Will ask the family first', day_status = 'completed'
   where sheet_key = 'S-00000000f301';
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1 and (select source = 'google_sheet' and patient_name = 'Sample Sheet Person' and phone = '03120003001' and not wants_treatment
                                     and treatment_plan = 'Will ask the family first' from public.checkups where sheet_key = 'S-00000000f301'),
    'front desk: the form''s answers go on the checkup the sheet made (its name, phone, source and sheet key stay)');
end $$;
reset role;
select pg_temp.check((select array_agg(k order by k) from f30_canon o, public.checkups c, jsonb_object_keys(o.j) k
                       where c.sheet_key = 'S-00000000f301' and k <> 'updated_at' and o.j->k is distinct from private.aaj_checkup_canon_row(c)->k) = array['doctors', 'status', 'treatment']
                     and (select private.aaj_checkup_canon_row(c)->>'status' from public.checkups c where c.sheet_key = 'S-00000000f301') = (select private.aaj_checkup_label('completed'))
                     and (select position('family first' in private.aaj_checkup_canon_row(c)::text) = 0 from public.checkups c where c.sheet_key = 'S-00000000f301'),
  'sync: the sheet gets the doctor, the treatment and the status Completed of that checkup, nothing of the four answers');
insert into f30_resp select 'keep1', pg_temp.f30_sync(pg_temp.f30_tab('[]', array['S-00000000f301']), true);
select pg_temp.check((select x->>'action' = 'restore' and x->>'message' like 'Not removed: this checkup is Completed on the website.%'
                        from f30_resp, jsonb_array_elements(resp->'tabs'->0->'removed') x where n = 'keep1' and x->>'key' = 'W-' || (pg_temp.f30_form()).id)
                     and (select day_status = 'completed' and ali_recommended and pricing_understood = 'needs_explanation' and wants_treatment
                            and treatment_plan = 'Next month, after the exams' from pg_temp.f30_form()),
  'sync: the row of a Completed checkup from the form deleted in the sheet: the checkup stays, answers and all, and the row is put back');
insert into f30_resp select 'keep2', pg_temp.f30_sync(pg_temp.f30_tab('[]', array['W-' || (pg_temp.f30_form()).id]), true);
select pg_temp.check((select x->>'action' = 'restore' and x->>'message' like 'Not removed: this checkup is Completed on the website.%'
                        from f30_resp, jsonb_array_elements(resp->'tabs'->0->'removed') x where n = 'keep2' and x->>'key' = 'S-00000000f301')
                     and (select not wants_treatment and treatment_plan = 'Will ask the family first' from public.checkups where sheet_key = 'S-00000000f301'),
  'sync: the same for the sheet''s checkup that got the form''s answers');

-- 4. The import of the old list and "Register as patient" leave the answers alone.
do $$
declare r jsonb; v_pid uuid;
begin
  perform pg_temp.act_as(current_setting('test.admin'));
  r := public.import_checkups(jsonb_build_array(jsonb_build_object('row', 5, 'month', '2025-03-01', 'name', 'Sample Imported Thirty', 'phone', '0300-5553002', 'branch', 'NN',
         'checkup_for', 'Scaling', 'follow_up', 'Interested', 'wants_treatment', true, 'treatment_plan', 'typed into the file', 'ali_recommended', true)));
  perform pg_temp.check((r->>'inserted')::int = 1 and (select ali_recommended is null and pricing_understood is null and wants_treatment is null and treatment_plan is null
                                                         from public.checkups where patient_name = 'Sample Imported Thirty'),
    'import_checkups: an imported old-list row has no answers (unknown keys of the file are ignored)');
  perform pg_temp.act_as(current_setting('test.fd'));
  set local role authenticated;
  v_pid := (public.register_checkup_as_patient((pg_temp.f30_form()).id)->>'patient_id')::uuid;
  reset role;
  perform pg_temp.check((select patient_id = v_pid and follow_up = 'Started' and ali_recommended and wants_treatment and treatment_plan = 'Next month, after the exams'
                           from pg_temp.f30_form()), 'register_checkup_as_patient: the checkup keeps its answers once the person has a patient file');
end $$;
rollback;
