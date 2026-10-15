-- Retainer Record and Lab Work (migration 20261012000200): the reshaped tables, the teams, who sees and changes what, the
-- triggers, and the one copy of a sheet tab. Every person below is made up ("Sample ..." names, phones 0300-555xxxx).
--   0. the migration runs a second time without harm;   0b. rows from before the file (every old stage and lab status) are converted;
--   1. the shape (nullable patient, city, text statuses, the lists);  2. the teams: names, colours, only Dr. Ali edits;
--   3. retainer rows: RLS by right, branch and city; the guard; the fill;   4. the dates a status implies (and the first retainer check);
--   5. removing rows;
--   6. import_retainer_records, the ONE copy of a tab: rules, cleaning, skips, team names, the Mr#, the dry run, a second copy refused
--      (nothing twice), 3000 rows in one call;   6b. rows changed on the website are marked;   6c. "Undo the copy" and a corrected copy;
--   7. lab work: RLS, statuses, dates;  8. a deleted patient file leaves its rows with their names;
--   9. the "Lab and retainer costs" report counts only retainers with a lab cost;  9b. new words for a status keep its rows;
--   10. the audit log;  10b. braces off: a doctor of one branch starts the retainer row of a patient of another branch;
--   11. the copy leaves no work table behind;
--   12. the most active makers of a tab get the strongest colours and the "Retainer Lab" banner (only when nobody of that city is in it).
\set ON_ERROR_STOP 1
\set admin  '''00000000-0000-0000-0000-000000003200'''
\set coord  '''00000000-0000-0000-0000-000000003201'''
\set fd     '''00000000-0000-0000-0000-000000003202'''
\set acct   '''00000000-0000-0000-0000-000000003203'''
\set noview '''00000000-0000-0000-0000-000000003204'''
\set lhr    '''00000000-0000-0000-0000-000000003205'''
\set doc    '''00000000-0000-0000-0000-000000003206'''
\set portal '''00000000-0000-0000-0000-000000003207'''

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
-- One sheet row the way the website sends it to import_retainer_records.
create or replace function pg_temp.retainer_wire(r int, name text, imp text, model text, maker text, status text default null,
                                        ret text default null, sheet text default null, payment text default null)
returns jsonb language sql as $$
  select jsonb_build_object('row', r, 'name', name, 'contact', null, 'impression_date', imp, 'model_check', model, 'made_by', maker,
    'retainer_date', ret, 'status', status, 'retainer_sheet', sheet, 'payment', payment) $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

-- 0. The migration again, in a transaction of its own: nothing fails and nothing changes shape.
begin;
\ir ../migrations/20261012000200_retainer_lab_records.sql
select pg_temp.check((select count(*) from pg_policies where schemaname = 'public' and tablename = 'retainer_cases') = 4
  and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'lab_cases') = 4, 'migration run twice: still four policies on each table');
rollback;

-- 0b. Rows from before this file. The live website writes retainer_cases and lab_cases until this file runs (Coordinator -> Retainers
-- and Lab work, the patient file's "Braces are off, start the retainer case"), so rows may be there when it runs. Here the two tables are
-- put back as the core schema made them (the old stage and status enums, a patient file on every row), with a row of every old stage and
-- every old lab status, and the file runs again: every row is converted (stage -> status, the patient file, branch, dates, notes, prices
-- and author kept, a website row), nothing is lost, nothing fails.
begin;
drop table public.retainer_cases cascade;
drop table public.lab_cases cascade;
create type public.retainer_stage as enum ('impression', 'fabrication', 'ready', 'delivered', 'follow_up', 'replacement_needed', 'closed');
create type public.lab_status as enum ('sent', 'received', 'fitted', 'returned', 'cancelled');
create table public.retainer_cases (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  braces_case_id uuid references public.braces_cases(id),
  branch_id smallint references public.branches(id),
  arch text not null check (arch in ('upper', 'lower', 'both')),
  retainer_type text,
  stage public.retainer_stage not null default 'impression',
  impression_date date, fabricated_date date, ready_date date, delivered_date date, next_check_date date,
  is_replacement boolean not null default false,
  repeat_reason text,
  lab_cost numeric(12,2), price numeric(12,2), notes text,
  created_by uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.lab_cases (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  visit_id uuid references public.visits(id),
  branch_id smallint not null references public.branches(id),
  lab_name text not null, work_type text not null,
  sent_date date not null default current_date, due_date date, received_date date, fitted_date date,
  status public.lab_status not null default 'sent',
  cost numeric(12,2), notes text, created_by uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create trigger retainer_touch before update on public.retainer_cases for each row execute function public.touch_updated_at();
create trigger lab_touch before update on public.lab_cases for each row execute function public.touch_updated_at();
create trigger retainer_cases_audit after insert or update or delete on public.retainer_cases for each row execute function public.audit_row();
create trigger lab_cases_audit after insert or update or delete on public.lab_cases for each row execute function public.audit_row();
alter table public.retainer_cases enable row level security;
alter table public.lab_cases enable row level security;
create policy "view retainers" on public.retainer_cases for select using (public.has_perm('patients.view') or patient_id = public.current_patient_id());
create policy "manage retainers" on public.retainer_cases for all using (public.has_perm('retainers.manage')) with check (public.has_perm('retainers.manage'));
create policy "view lab cases" on public.lab_cases for select using (public.has_perm('lab.manage') or public.has_perm('patients.view'));
create policy "manage lab cases" on public.lab_cases for all using (public.has_perm('lab.manage')) with check (public.has_perm('lab.manage'));
insert into public.patients (mr_number, full_name, phone, first_branch_id) values
  ('32901', 'Sample Old Karachi', '03005553291', (select id from public.branches where code = 'NN')),
  ('32902', 'Sample Old Lahore', '03005553292', (select id from public.branches where code = 'LHR'));
insert into public.retainer_cases (patient_id, branch_id, arch, stage, impression_date, fabricated_date, ready_date, delivered_date, next_check_date,
                                   is_replacement, repeat_reason, lab_cost, price, notes, created_by)
select p.id, (select id from public.branches where code = x.branch), x.arch, x.stage::public.retainer_stage, x.imp::date, x.fab::date, x.ready::date,
       x.delivered::date, x.next_check::date, x.repl, x.reason, x.lab_cost, x.price, x.notes, '00000000-0000-0000-0000-000000003201'::uuid
  from (values
    (1, '32901', 'NN',  'both',  'impression',         '2026-10-01', null,         null,         null,         null,         false, null,             null,  9000, 'Sample upper only'),
    (2, '32901', null,  'upper', 'fabrication',        '2026-09-20', '2026-09-25', null,         null,         null,         false, null,             null,  null, null),
    (3, '32901', 'GUL', 'lower', 'ready',              '2026-09-10', '2026-09-12', '2026-09-15', null,         null,         false, null,             1500,  null, null),
    (4, '32902', 'LHR', 'both',  'delivered',          '2026-08-01', null,         null,         '2026-08-20', null,         false, null,             null,  null, null),
    (5, '32901', 'NN',  'both',  'follow_up',          '2026-06-01', null,         '2026-06-25', '2026-07-01', '2026-10-30', false, null,             null,  null, 'Sample check fit'),
    (6, '32902', null,  'upper', 'replacement_needed', '2026-05-01', null,         null,         '2026-05-20', null,         true,  'Sample lost it', null,  null, null),
    (7, '32901', 'NN',  'both',  'closed',             '2026-04-01', null,         null,         '2026-05-01', null,         false, null,             null,  null, null),
    (8, '32901', 'NN',  'both',  'closed',             '2026-03-01', null,         null,         null,         null,         false, null,             null,  -500, null),
    (9, '32901', 'NN',  'both',  'impression',         '2026-10-02', null,         null,         null,         null,         false, null,             null,  null, repeat('Sample long note. ', 130)))
    as x(k, mr, branch, arch, stage, imp, fab, ready, delivered, next_check, repl, reason, lab_cost, price, notes)
  join public.patients p on p.mr_number = x.mr
 order by x.k;
insert into public.lab_cases (patient_id, branch_id, lab_name, work_type, sent_date, due_date, received_date, fitted_date, status, cost, notes, created_by)
select p.id, (select id from public.branches where code = x.branch), x.lab, x.work, x.sent::date, x.due::date, x.received::date, x.fitted::date,
       x.status::public.lab_status, x.cost, x.notes, '00000000-0000-0000-0000-000000003201'::uuid
  from (values
    (1, '32901', 'NN',  'In-house lab', 'Crown',   '2026-10-01', '2026-10-08', null,         null,         'sent',      5000, null),
    (2, '32901', 'GUL', 'In-house lab', 'Veneer',  '2026-09-20', '2026-09-27', '2026-09-26', null,         'received',  null, null),
    (3, '32902', 'LHR', 'In-house lab', 'Denture', '2026-09-01', '2026-09-10', '2026-09-09', '2026-09-12', 'fitted',    18000, 'Sample fitted well'),
    (4, '32901', 'NN',  'In-house lab', 'Crown',   '2026-08-01', '2026-08-08', '2026-08-07', null,         'returned',  5000, 'Sample shade too light'),
    (5, '32901', 'NN',  'In-house lab', 'Bridge',  '2026-07-01', null,         null,         null,         'cancelled', -100, null),
    (6, '32902', 'LHR', repeat('Sample Lab ', 13), 'Crown', '2026-06-01', null, null, null, 'sent', null, null))
    as x(k, mr, branch, lab, work, sent, due, received, fitted, status, cost, notes)
  join public.patients p on p.mr_number = x.mr
 order by x.k;
\ir ../migrations/20261012000200_retainer_lab_records.sql
do $$
declare
  v_khi smallint := (select id from public.cities where name = 'Karachi'); v_lahore smallint := (select id from public.cities where name = 'Lahore');
  v_old_k uuid := (select id from public.patients where mr_number = '32901'); v_old_l uuid := (select id from public.patients where mr_number = '32902');
  v_got text;
begin
  perform pg_temp.check((select count(*) from public.retainer_cases) = 9 and (select count(*) from public.lab_cases) = 6,
    'old rows: the file ran over 9 retainer rows and 6 lab cases from before it, and every one is still there');
  perform pg_temp.check(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'retainer_cases' and column_name in ('stage', 'fabricated_date', 'ready_date'))
    and not exists (select 1 from pg_type where typname in ('retainer_stage', 'lab_status') and typnamespace = 'public'::regnamespace),
    'old rows: the stage column and the two enums are gone after the rows were converted');
  select string_agg(format('%s|%s|%s', impression_date, status, coalesce(retainer_date::text, '-')), ';' order by impression_date) into v_got from public.retainer_cases;
  perform pg_temp.check(v_got = '2026-03-01|Cancelled|-;2026-04-01|Delivered to patient|2026-05-01;2026-05-01|Re-purchase needed|-;'
                             || '2026-06-01|Delivered to patient|2026-06-25;2026-08-01|Delivered to patient|2026-08-20;2026-09-10|Retainer made|2026-09-15;'
                             || '2026-09-20|Model poured|-;2026-10-01|Impression taken|-;2026-10-02|Impression taken|-',
    'old rows: each stage is the status that means the same (impression, being made = Model poured, ready = Retainer made, delivered and follow-up = '
    || 'Delivered, needs replacement = Re-purchase needed, closed = Delivered or Cancelled); ready or delivered gives the retainer date (' || v_got || ')');
  perform pg_temp.check(not exists (select 1 from public.retainer_cases where source <> 'website' or source_row is not null or patient_id is null or not linked_by_hand or edited_on_site
                                                                            or created_by <> '00000000-0000-0000-0000-000000003201'::uuid),
    'old rows: website rows, each still linked to its patient file (by hand, as the website''s own rows), with its author');
  perform pg_temp.check((select patient_name = 'Sample Old Karachi' and branch_id = (select id from public.branches where code = 'NN') and city_id = v_khi and arch = 'both'
                                and price = 9000 and notes = 'Sample upper only' from public.retainer_cases where impression_date = '2026-10-01')
    and (select city_id = v_lahore and branch_id is null and patient_id = v_old_l and is_replacement and repeat_reason = 'Sample lost it' and delivered_date = '2026-05-20'
                from public.retainer_cases where impression_date = '2026-05-01')
    and (select branch_id = (select id from public.branches where code = 'GUL') and city_id = v_khi and lab_cost = 1500 from public.retainer_cases where impression_date = '2026-09-10'),
    'old rows: the patient''s name, the branch (and its city), the arch, the prices, the replacement and its reason, the delivered date stay; a row with no branch gets the patient''s city');
  perform pg_temp.check((select notes = E'Sample check fit\nOn the old Retainers list: Follow-up check.' and next_check_date = '2026-10-30' and delivered_date = '2026-07-01'
                           from public.retainer_cases where impression_date = '2026-06-01')
    and (select notes = 'On the old Retainers list: Being made; making started 25 Sep 2026.' from public.retainer_cases where impression_date = '2026-09-20')
    and (select notes = 'On the old Retainers list: Ready; making started 12 Sep 2026.' from public.retainer_cases where impression_date = '2026-09-10')
    and (select notes = E'On the old Retainers list: Closed.
Amount on the old Retainers list: -500.00' and price is null from public.retainer_cases where impression_date = '2026-03-01')
    and (select notes = 'On the old Retainers list: Needs replacement.' from public.retainer_cases where impression_date = '2026-05-01')
    and (select notes is null from public.retainer_cases where impression_date = '2026-08-01'),
    'old rows: what the new list has no words for (being made and its date, a follow-up check, needs replacement, closed) and an amount below 0 are lines of the notes; the notes typed before stay above them');
  perform pg_temp.check((select length(notes) = 2340 from public.retainer_cases where impression_date = '2026-10-02'),
    'old rows: a note longer than the new limit is kept whole (the limit is for rows written from now on)');
  select string_agg(format('%s|%s|%s', work_type, status, patient_name), ';' order by sent_date) into v_got from public.lab_cases;
  perform pg_temp.check(v_got = 'Crown|sent|Sample Old Lahore;Bridge|cancelled|Sample Old Karachi;Crown|remake|Sample Old Karachi;Denture|fitted|Sample Old Lahore;'
                             || 'Veneer|received|Sample Old Karachi;Crown|sent|Sample Old Karachi',
    'old lab cases: each keeps its status ("returned" is "remake" now) and gets its patient''s name (' || v_got || ')');
  perform pg_temp.check((select received_date = '2026-09-09' and fitted_date = '2026-09-12' and cost = 18000 and notes = 'Sample fitted well' and lab_name = 'In-house lab'
                           and branch_id = (select id from public.branches where code = 'LHR') from public.lab_cases where work_type = 'Denture')
    and (select length(lab_name) = 120 and notes = 'Lab: ' || repeat('Sample Lab ', 13) from public.lab_cases where sent_date = '2026-06-01')
    and (select cost is null and notes = 'Cost on the old Lab work list: -100.00' from public.lab_cases where work_type = 'Bridge'),
    'old lab cases: the dates, cost, notes, lab and branch stay; a lab name longer than the new limit fits it and is kept whole in the notes, so is a cost below 0');
  -- The converted rows work like any other: a deleted patient file leaves them, with the name.
  delete from public.patients where id = v_old_l;
  perform pg_temp.check((select count(*) from public.retainer_cases where patient_id is null and patient_name = 'Sample Old Lahore') = 2
    and (select count(*) from public.lab_cases where patient_id is null and patient_name = 'Sample Old Lahore') = 2,
    'old rows: when their patient file is deleted, the converted rows stay with the name (the long lab name does not stop it)');
end $$;
rollback;

begin;
select set_config('test.admin', :admin, false), set_config('test.coord', :coord, false), set_config('test.fd', :fd, false),
       set_config('test.acct', :acct, false), set_config('test.noview', :noview, false), set_config('test.lhr', :lhr, false),
       set_config('test.doc', :doc, false), set_config('test.portal', :portal, false),
       set_config('test.khi', (select id::text from public.cities where name = 'Karachi'), false),
       set_config('test.lahore', (select id::text from public.cities where name = 'Lahore'), false),
       set_config('test.nn', (select id::text from public.branches where code = 'NN'), false),
       set_config('test.gul', (select id::text from public.branches where code = 'GUL'), false),
       set_config('test.lhrb', (select id::text from public.branches where code = 'LHR'), false),
       set_config('test.today', ((now() at time zone 'Asia/Karachi')::date)::text, false);
insert into auth.users (id, email) values
  (:admin, 'admin32@dralirashid.com'), (:coord, 'coord32@dralirashid.com'), (:fd, 'fd32@dralirashid.com'), (:acct, 'acct32@dralirashid.com'),
  (:noview, 'noview32@dralirashid.com'), (:lhr, 'lhr32@dralirashid.com'), (:doc, 'doc32@dralirashid.com'), (:portal, 'portal32@example.com');
insert into public.staff (id, full_name, email, role) values
  (:admin,  'Admin', 'admin32@dralirashid.com', 'admin'),
  (:coord,  'Coordinator', 'coord32@dralirashid.com', 'coordinator'),
  (:fd,     'Front Desk NN', 'fd32@dralirashid.com', 'front_desk'),
  (:acct,   'Accountant', 'acct32@dralirashid.com', 'accountant'),
  (:noview, 'Accountant without patient files', 'noview32@dralirashid.com', 'accountant'),
  (:lhr,    'Assistant Lahore', 'lhr32@dralirashid.com', 'assistant'),
  (:doc,    'Doctor', 'doc32@dralirashid.com', 'doctor');
update public.staff set restrict_to_branches = true, branch_ids = array[(select id from public.branches where code = 'NN')] where id = :fd;
update public.staff set restrict_to_branches = true, branch_ids = array[(select id from public.branches where code = 'LHR')] where id = :lhr;
insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (:noview, 'patients.view', false);
insert into public.patients (full_name, phone, portal_user_id) values ('Sample Portal Person', '03005553299', :portal);
insert into public.patients (mr_number, full_name, phone) values ('32001', 'Sample Linked Patient', '03005553201'), ('32002', 'Sample Leaving Patient', '03005553202');

-- 1. The shape
do $$
begin
  perform pg_temp.check((select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'retainer_cases' and column_name = 'patient_id') = 'YES'
    and (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'lab_cases' and column_name = 'patient_id') = 'YES',
    'shape: a patient file is optional on both tables');
  perform pg_temp.check((select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'retainer_cases' and column_name = 'city_id') = 'NO',
    'shape: every retainer row has a city');
  perform pg_temp.check(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'retainer_cases' and column_name in ('stage', 'fabricated_date', 'ready_date'))
    and not exists (select 1 from pg_type where typname in ('retainer_stage', 'lab_status') and typnamespace = 'public'::regnamespace),
    'shape: the old stage column and the two status enums are gone');
  perform pg_temp.check((select data_type from information_schema.columns where table_schema = 'public' and table_name = 'lab_cases' and column_name = 'status') = 'text'
    and (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'lab_cases' and column_name = 'status') like '%sent%',
    'shape: lab status is text, "sent" by default');
  perform pg_temp.check(jsonb_array_length(public.setting('retainer_statuses')) = 8
    and public.setting('retainer_statuses') @> '[{"label": "Delivered to patient", "means": "delivered"}]'
    and jsonb_array_length(public.setting('lab_work_types')) = 9, 'shape: the two drop-down lists are stored as settings');
  perform pg_temp.check((select string_agg(e->>'label', ' > ' order by o) from jsonb_array_elements(public.setting('retainer_statuses')) with ordinality x(e, o) where o between 2 and 4)
    = 'Model checked > Model poured > Retainer made', 'shape: "Model poured" (on the Karachi tab) sits between Model checked and Retainer made');
  perform pg_temp.check((select data_type from information_schema.columns where table_schema = 'public' and table_name = 'retainer_cases' and column_name = 'mr_text') = 'text',
    'shape: a retainer row keeps the Mr# typed on the sheet, as text');
  perform pg_temp.check(has_function_privilege('authenticated', 'public.import_retainer_records(smallint, jsonb, boolean)', 'execute')
    and not has_function_privilege('anon', 'public.import_retainer_records(smallint, jsonb, boolean)', 'execute')
    and (select count(*) from pg_proc where proname = 'import_retainer_records' and pronamespace = 'public'::regnamespace) = 1
    and has_function_privilege('authenticated', 'public.undo_retainer_copy(smallint, boolean)', 'execute')
    and not has_function_privilege('anon', 'public.undo_retainer_copy(smallint, boolean)', 'execute')
    and has_function_privilege('authenticated', 'public.retainer_copies()', 'execute')
    and not has_function_privilege('anon', 'public.retainer_copies()', 'execute')
    and has_function_privilege('authenticated', 'public.retainer_mr_check(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.retainer_mr_check(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.can_access_city(smallint)', 'execute')
    and has_function_privilege('authenticated', 'public.rename_record_option(text, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.rename_record_option(text, text, text)', 'execute'),
    'grants: the copy, its undo, the list of copies, the Mr# check, the city check and the renaming of a list item are for signed-in people only');
  perform pg_temp.check(not has_function_privilege('authenticated', 'private.record_text(text, int)', 'execute')
    and not has_function_privilege('authenticated', 'private.record_date(text)', 'execute')
    and not has_function_privilege('authenticated', 'private.record_name(text)', 'execute')
    and not has_function_privilege('authenticated', 'private.retainer_mr_match(text, text)', 'execute')
    and not has_function_privilege('authenticated', 'private.retainer_name_key(text)', 'execute')
    and not has_function_privilege('authenticated', 'private.retainer_top_makers(smallint)', 'execute'), 'grants: the copy''s helpers are not callable by staff');
  perform pg_temp.check(not exists (select 1 from pg_proc where proname in ('retainer_same_name', 'retainer_busiest') and pronamespace = 'private'::regnamespace),
    'the helpers of the old re-import (rows that moved on the sheet, the banner of the last 90 days) are gone');
  perform pg_temp.check((select is_nullable = 'NO' and column_default = 'false' from information_schema.columns where table_schema = 'public' and table_name = 'retainer_cases' and column_name = 'edited_on_site'),
    'shape: a retainer row says whether it was changed on the website');
  perform pg_temp.check(private.retainer_mr_key('082') = '82' and private.retainer_mr_key(' 6620 ') = '6620' and private.retainer_mr_key('123-4') is null
    and private.retainer_mr_key('000') is null and private.retainer_mr_key('abc') is null and private.retainer_mr_key(null) is null and private.retainer_mr_key('12345678') is null,
    'Mr#: digits only, leading zeros left out ("082" is Mr# 82); "123-4", letters or eight digits are no Mr#');
  perform pg_temp.check(private.record_date('2025-04-08') = '2025-04-08' and private.record_date('2025-02-30') is null and private.record_date('08/04/2025') is null
    and private.record_date('1890-01-01') is null and private.record_date(null) is null, 'cleaning: only a real YYYY-MM-DD between 2000 and 2100 is a date');
  perform pg_temp.check(private.record_name('  syed   sample ') = 'Syed Sample' and private.record_name('Dr. Sample Checker') = 'Dr. Sample Checker'
    and private.record_name('McSample') = 'McSample' and private.record_name(chr(8212)) is null and private.record_name('') is null,
    'cleaning: team names trimmed, all-small names get capitals, others kept as written, dashes are empty');
  perform pg_temp.check(private.record_text(' - ', 10) is null and private.record_text('  ab  ', 10) = 'ab' and private.record_text('abcdef', 3) = 'abc',
    'cleaning: cells trimmed, dash-only cells empty, cut to the limit');
  perform pg_temp.check(private.retainer_name_key(' Sample  asad ') = private.retainer_name_key('sample ASAD') and private.retainer_name_key('Sample Asad') <> private.retainer_name_key('Sample Asad Khan'),
    'a name kept by an undo is the same name in any capitals and spacing, nothing looser');
end $$;

-- 2. The teams
set role authenticated;
do $$
declare v_admin text := current_setting('test.admin'); v_coord text := current_setting('test.coord'); v_fd text := current_setting('test.fd');
begin
  perform pg_temp.act_as(v_admin);
  insert into public.retainer_team (name, role, colour, featured) values ('  Sample   Maker A ', 'maker', 'black', true), ('Sample Maker B', 'maker', 'lavender', true);
  insert into public.retainer_team (name, role, colour) values ('Dr. Sample Checker', 'model_check', 'purple');
  insert into public.lab_team (name, kind, colour) values ('Sample Lab Hand', 'person', 'teal'), ('Sample Dental Lab', 'lab', 'grey');
  perform pg_temp.check(exists (select 1 from public.retainer_team where name = 'Sample Maker A' and featured and active and city_id is null),
    'team: Dr. Ali adds a maker; the name is trimmed to single spaces; every city unless set');
  perform pg_temp.expect_error('insert into public.retainer_team (name) values (''sample maker a'')', 'retainer_team_name_idx', 'team: the same name in other capitals is refused');
  perform pg_temp.expect_error('insert into public.retainer_team (name, colour) values (''Sample Pink'', ''hotpink'')', 'retainer_team_colour_check', 'team: a colour outside the palette is refused');
  perform pg_temp.expect_error('insert into public.retainer_team (name, role) values (''Sample Odd'', ''boss'')', 'retainer_team_role_check', 'team: an unknown role is refused');
  perform pg_temp.expect_error('insert into public.lab_team (name, kind) values (''Sample Odd'', ''shop'')', 'lab_team_kind_check', 'lab team: a person or a lab, nothing else');

  perform pg_temp.act_as(v_coord);
  perform pg_temp.check((select count(*) from public.retainer_team) = 3 and (select count(*) from public.lab_team) = 2, 'team: the coordinator reads both teams');
  perform pg_temp.expect_error('insert into public.retainer_team (name) values (''Sample Coord Pick'')', 'row-level security', 'team: only Dr. Ali adds members');
  update public.retainer_team set colour = 'red' where name = 'Sample Maker A';
  perform pg_temp.check((select colour from public.retainer_team where name = 'Sample Maker A') = 'black', 'team: the coordinator''s colour change reaches no row');
  perform pg_temp.act_as(v_fd);
  perform pg_temp.check((select count(*) from public.retainer_team) = 3, 'team: the front desk reads the team too (every chip needs the names)');
end $$;
reset role;
set role anon;
select pg_temp.expect_error($$select count(*) from public.retainer_team$$, 'permission denied', 'anon: cannot read the retainer team');
select pg_temp.expect_error($$select count(*) from public.lab_team$$, 'permission denied', 'anon: cannot read the lab team');
select pg_temp.expect_error($$select public.import_retainer_records(1::smallint, '[]'::jsonb)$$, 'permission denied', 'anon: cannot run the copy');
select pg_temp.expect_error($$select public.undo_retainer_copy(1::smallint)$$, 'permission denied', 'anon: cannot undo a copy');
select pg_temp.expect_error($$select public.retainer_copies()$$, 'permission denied', 'anon: cannot list the copies');
reset role;

-- 3. Retainer rows: who sees and changes what
set role authenticated;
do $$
declare
  v_admin text := current_setting('test.admin'); v_coord text := current_setting('test.coord'); v_fd text := current_setting('test.fd');
  v_acct text := current_setting('test.acct'); v_noview text := current_setting('test.noview'); v_lhr text := current_setting('test.lhr');
  v_portal text := current_setting('test.portal');
  v_khi smallint := current_setting('test.khi')::smallint; v_lahore smallint := current_setting('test.lahore')::smallint;
  v_nn smallint := current_setting('test.nn')::smallint; v_gul smallint := current_setting('test.gul')::smallint; v_lhrb smallint := current_setting('test.lhrb')::smallint;
  v_maker uuid; v_id uuid; v_linked uuid; r record; n int;
begin
  select id into v_maker from public.retainer_team where name = 'Sample Maker A';
  select id into v_linked from public.patients where mr_number = '32001';
  perform pg_temp.act_as(v_coord);
  insert into public.retainer_cases (city_id, patient_name, contact, impression_date, made_by)
    values (v_khi, 'Sample Karachi One', '0300-5553210', '2026-10-01', v_maker) returning id into v_id;
  select * into r from public.retainer_cases where id = v_id;
  perform pg_temp.check(r.patient_id is null and r.status = 'Impression taken' and r.source = 'website' and r.source_row is null and r.created_by = v_coord::uuid and r.branch_id is null,
    'coordinator: adds a Karachi row with only a name (no patient file): status "Impression taken", source website, author set');
  perform pg_temp.expect_error(format('insert into public.retainer_cases (city_id) values (%s)', v_khi), 'retainer_cases_who_check', 'a row needs a name or a patient file');
  perform pg_temp.expect_error(format('insert into public.retainer_cases (city_id, patient_name, contact) values (%s, ''Sample Long'', %L)', v_khi, repeat('1', 61)),
    'retainer_cases_contact_check', 'a contact longer than 60 characters is refused');
  perform pg_temp.expect_state(format('insert into public.retainer_cases (city_id, patient_name, source, source_row) values (%s, ''Sample Pose'', ''sheet_import'', 5)', v_khi),
    '42501', 'NOT_ALLOWED', 'coordinator: cannot pose as a sheet row');
  insert into public.retainer_cases (city_id, patient_name, created_by) values (v_khi, 'Sample Author', v_admin::uuid) returning id into v_id;
  perform pg_temp.check((select created_by from public.retainer_cases where id = v_id) = v_coord::uuid, 'guard: an author written by hand on a new row is replaced by the signed-in person');
  perform pg_temp.expect_state(format('update public.retainer_cases set created_by = %L where id = %L', v_admin, v_id), '42501', 'NOT_ALLOWED', 'guard: the author cannot be changed');
  perform pg_temp.expect_state(format('update public.retainer_cases set source = ''sheet_import'', source_row = 9 where id = %L', v_id), '42501', 'NOT_ALLOWED', 'guard: a website row cannot become a sheet row');

  -- The branch decides the city; a linked patient file gives the row its name.
  insert into public.retainer_cases (city_id, branch_id, patient_name) values (v_lahore, v_gul, 'Sample Gulshan Row') returning id into v_id;
  perform pg_temp.check((select city_id from public.retainer_cases where id = v_id) = v_khi, 'fill: a Gulshan row given the Lahore city lands on Karachi (the city follows the branch)');
  insert into public.retainer_cases (city_id, branch_id, patient_id) values (v_khi, v_nn, v_linked) returning id into v_id;
  perform pg_temp.check((select patient_name from public.retainer_cases where id = v_id) = 'Sample Linked Patient', 'fill: a row linked to a patient file carries the patient''s name');
  insert into public.retainer_cases (city_id, patient_id) values (v_khi, (select id from public.patients where portal_user_id = v_portal::uuid));
  insert into public.retainer_cases (city_id, branch_id, patient_name) values (v_lahore, v_lhrb, 'Sample Lahore Coord');

  -- An assistant limited to the Lahore branch: works on the Lahore tab only.
  perform pg_temp.act_as(v_lhr);
  insert into public.retainer_cases (city_id, patient_name) values (v_lahore, 'Sample Lahore One');
  perform pg_temp.expect_error(format('insert into public.retainer_cases (city_id, patient_name) values (%s, ''Sample Lahore Try'')', v_khi), 'row-level security',
    'Lahore assistant: cannot add to the Karachi tab');
  select count(*) into n from public.retainer_cases where city_id = v_khi;
  perform pg_temp.check(n = 0, 'Lahore assistant: sees no Karachi row');
  select count(*) into n from public.retainer_cases where city_id = v_lahore;
  perform pg_temp.check(n = 2, 'Lahore assistant: sees both Lahore rows (with and without a branch)');

  -- A front desk limited to North Nazimabad, without "Manage retainer cases": reads its city, never writes.
  perform pg_temp.act_as(v_fd);
  perform pg_temp.check(exists (select 1 from public.retainer_cases where patient_name = 'Sample Karachi One')
    and exists (select 1 from public.retainer_cases where patient_name = 'Sample Linked Patient'), 'front desk NN: sees the Karachi rows without a branch and the NN rows');
  perform pg_temp.check(not exists (select 1 from public.retainer_cases where patient_name = 'Sample Gulshan Row'), 'front desk NN: does not see a Gulshan row');
  perform pg_temp.check(not exists (select 1 from public.retainer_cases where city_id = v_lahore), 'front desk NN: does not see the Lahore tab');
  perform pg_temp.expect_error(format('insert into public.retainer_cases (city_id, patient_name) values (%s, ''Sample Desk Try'')', v_khi), 'row-level security',
    'front desk: cannot add a retainer row');
  update public.retainer_cases set notes = 'desk note' where patient_name = 'Sample Karachi One';
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0, 'front desk: an edit reaches no row');

  perform pg_temp.act_as(v_acct);
  select count(*) into n from public.retainer_cases;
  perform pg_temp.check(n = 7, 'accountant (patient files, no branch limit): reads every row of every city');
  perform pg_temp.act_as(v_noview);
  select count(*) into n from public.retainer_cases;
  perform pg_temp.check(n = 0, 'without "View patient profiles" and without "Manage retainer cases": sees nothing');
  perform pg_temp.act_as(v_portal);
  select count(*) into n from public.retainer_cases;
  perform pg_temp.check(n = 1, 'patient login: sees only their own row');
  perform pg_temp.expect_state(format('select public.import_retainer_records(%s::smallint, ''[]''::jsonb)', v_khi), '42501', 'NOT_ALLOWED', 'patient login: cannot copy the sheet');
end $$;
reset role;
set role anon;
select pg_temp.expect_error($$select count(*) from public.retainer_cases$$, 'permission denied', 'anon: cannot read the retainer rows');
select pg_temp.expect_error($$select count(*) from public.lab_cases$$, 'permission denied', 'anon: cannot read the lab rows');
reset role;

-- 4. The dates a status implies (website changes only)
set role authenticated;
do $$
declare v_coord text := current_setting('test.coord'); v_today date := current_setting('test.today')::date; v_id uuid; r record;
begin
  perform pg_temp.act_as(v_coord);
  select id into v_id from public.retainer_cases where patient_name = 'Sample Karachi One';
  update public.retainer_cases set status = 'Retainer made' where id = v_id;
  select * into r from public.retainer_cases where id = v_id;
  perform pg_temp.check(r.retainer_date = v_today and r.delivered_date is null, 'status "Retainer made": the empty retainer date becomes today');
  perform pg_temp.check(r.next_check_date is null, 'status "Retainer made": no retainer check yet');
  update public.retainer_cases set retainer_date = '2026-09-20', status = 'Delivered to patient' where id = v_id;
  select * into r from public.retainer_cases where id = v_id;
  perform pg_temp.check(r.retainer_date = '2026-09-20' and r.delivered_date = v_today, 'status "Delivered to patient": the delivered date is today, a retainer date already there stays');
  -- The first retainer check: a calendar month after today (Karachi), the rule of the old Coordinator -> Retainers list (31 January gives
  -- 28 February, as web/js/ui/dom.js addMonthsISO gives it).
  perform pg_temp.check(r.next_check_date = (v_today + interval '1 month')::date, 'status "Delivered to patient": the first retainer check is a month later (' || coalesce(r.next_check_date::text, 'none') || ')');
  perform pg_temp.check(('2027-01-31'::date + interval '1 month')::date = '2027-02-28' and ('2028-01-31'::date + interval '1 month')::date = '2028-02-29',
    'a month after the 31st is the last day of a shorter month');
  update public.retainer_cases set status = 'delivered TO patient', delivered_date = null where id = v_id;
  perform pg_temp.check((select delivered_date from public.retainer_cases where id = v_id) = v_today, 'the status list is matched without regard to capitals');
  -- A check date set already (by hand, or the braces-off dialog's "First retainer check") stays; one cleared by hand stays cleared while the
  -- status does not change.
  update public.retainer_cases set status = 'Model checked', next_check_date = '2027-01-05' where id = v_id;
  update public.retainer_cases set status = 'Delivered to patient' where id = v_id;
  perform pg_temp.check((select next_check_date from public.retainer_cases where id = v_id) = '2027-01-05', 'Delivered again: a check date set already stays');
  update public.retainer_cases set next_check_date = null where id = v_id;
  perform pg_temp.check((select next_check_date from public.retainer_cases where id = v_id) is null, 'a check date cleared by hand stays cleared');
  update public.retainer_cases set status = 'Cancelled' where id = v_id;
  perform pg_temp.check((select next_check_date from public.retainer_cases where id = v_id) is null, 'Cancelled sets no check');
  update public.retainer_cases set status = 'Something new', retainer_date = null, delivered_date = null where id = v_id;
  select * into r from public.retainer_cases where id = v_id;
  perform pg_temp.check(r.retainer_date is null and r.delivered_date is null and r.status = 'Something new', 'a status not on the list is kept as written and fills nothing');
  perform pg_temp.expect_error(format('update public.retainer_cases set status = %L where id = %L', repeat('x', 61), v_id), 'retainer_cases_lists_check', 'a status longer than 60 characters is refused');
end $$;
reset role;

-- 5. Removing rows (the copied rows are tested after the copy)
set role authenticated;
do $$
declare v_coord text := current_setting('test.coord'); n int;
begin
  perform pg_temp.act_as(v_coord);
  delete from public.retainer_cases where patient_name = 'Sample Author';
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'coordinator: removes a row typed in by mistake');
end $$;
reset role;

-- 6. import_retainer_records: the ONE copy of a city's tab (rules, cleaning, skips, team names, the Mr#), the dry run, the refusal of a
-- second copy (a call sent again never adds a row twice), the marks of rows changed on the website, and "Undo the copy".
-- Made-up people; the Mr#s are checked to be free first.
select pg_temp.check(not exists (select 1 from public.patients where mr_number in ('73201', '73202', '73203')), 'Mr#: the made-up numbers are free');
insert into public.patients (mr_number, full_name, phone) values ('73201', 'Hamna Sampleton', '03005553701'), ('73202', 'Zoha Sampleton', '03005553702');
set role authenticated;
-- A work table of the same name left in this connection by somebody else is never the one the copy uses.
create temp table retainer_import (not_ours int);
do $$
declare
  v_admin text := current_setting('test.admin'); v_coord text := current_setting('test.coord');
  v_khi smallint := current_setting('test.khi')::smallint; v_lahore smallint := current_setting('test.lahore')::smallint;
  v_today date := current_setting('test.today')::date;
  v_tab jsonb; v_check jsonb; r jsonb; d jsonb; c record; n int;
begin
  perform pg_temp.act_as(v_coord);
  perform pg_temp.expect_state(format('select public.import_retainer_records(%s::smallint, ''[]''::jsonb)', v_khi), '42501', 'NOT_ALLOWED', 'coordinator: cannot copy the sheet');

  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect_state('select public.import_retainer_records(null, ''[]''::jsonb)', '22023', 'BAD_CITY', 'no city is refused');
  perform pg_temp.expect_state('select public.import_retainer_records(999::smallint, ''[]''::jsonb)', '22023', 'BAD_CITY', 'an unknown city is refused');
  perform pg_temp.expect_state(format('select public.import_retainer_records(%s::smallint, ''{"a":1}''::jsonb)', v_khi), '22023', 'BAD_ROWS', 'an object instead of a list is refused');
  perform pg_temp.expect_state(format($q$select public.import_retainer_records(%s::smallint, (select jsonb_agg(jsonb_build_object('row', g, 'name', 'Sample Over ' || g)) from generate_series(1, 3001) g))$q$, v_khi),
    '22023', 'TOO_MANY_ROWS', 'a tab of 3001 rows is refused (a whole tab comes in one call, up to 3000 rows)');
  perform pg_temp.check(not exists (select 1 from public.retainer_cases where patient_name like 'Sample Over%'), 'the refused call stored nothing');

  -- The Karachi tab: rows of every kind, and five with an Mr# in the first column.
  v_tab := jsonb_build_array(
    pg_temp.retainer_wire(2, 'Sample Sheet Alpha', '2025-04-08', 'dr. sample checker', 'Sample Maker A', 'Delivered to patient', '2025-04-20', null, 'Paid'),
    pg_temp.retainer_wire(3, '  Sample Sheet Bravo ', '2025-04-15', 'Sample Checker Two', 'sample   new maker', 'Retainer made', null, 'Re-purchase needed'),
    jsonb_set(pg_temp.retainer_wire(4, 'Sample Sheet Charlie', '2025-02-30', null, 'Sample New Maker', null), '{impression_text}', '"30-02-2025"'),
    jsonb_set(pg_temp.retainer_wire(5, 'Sample Sheet Delta', null, 'Sample Maker B', 'Sample Checker Two', chr(8212)), '{impression_text}', '"soon"'),
    jsonb_set(pg_temp.retainer_wire(6, 'Sample Sheet Echo', '2025-05-02', null, null, 'Impression repeat'), '{impression_text}', '"02-05-2025"'),
    pg_temp.retainer_wire(7, ' - ', '2025-05-03', null, null),
    pg_temp.retainer_wire(null, 'Sample No Row', '2025-05-04', null, null),
    pg_temp.retainer_wire(2, 'Sample Sheet Alpha Again', '2025-05-05', null, null),
    jsonb_set(pg_temp.retainer_wire(50, 'Hamna Sampleton', '2025-06-01', null, 'Sample Maker A', 'Delivered to patient'), '{mr}', '"073201"'),
    jsonb_set(pg_temp.retainer_wire(51, 'Minahil Sampleton', '2025-06-02', null, 'Sample Maker A'), '{mr}', '"73202"'),
    jsonb_set(pg_temp.retainer_wire(52, 'Rida Sampleton', '2025-06-03', null, 'Sample Maker A'), '{mr}', '"73203"'),
    jsonb_set(pg_temp.retainer_wire(53, 'Sameen Sampleton', '2025-06-04', null, 'Sample Maker A'), '{mr}', '"732-1"'),
    pg_temp.retainer_wire(54, 'Ifrah Sampleton', '2025-06-05', null, 'Sample Maker A'));
  v_check := (select jsonb_agg(jsonb_build_object('row', e->'row', 'mr', e->'mr', 'name', e->'name')) from jsonb_array_elements(v_tab) e where e ? 'mr');

  -- The preview's Mr# check (nothing is written).
  perform pg_temp.act_as(v_coord);
  perform pg_temp.expect_state(format('select public.retainer_mr_check(%L::jsonb)', v_check), '42501', 'NOT_ALLOWED', 'Mr# check: the coordinator cannot run the copy''s preview');
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect_state('select public.retainer_mr_check(''{"a":1}''::jsonb)', '22023', 'BAD_ROWS', 'Mr# check: an object instead of a list is refused');
  perform pg_temp.expect_state($q$select public.retainer_mr_check((select jsonb_agg(jsonb_build_object('row', g, 'mr', '1', 'name', 'x')) from generate_series(1, 3001) g))$q$,
    '22023', 'TOO_MANY_ROWS', 'Mr# check: 3001 rows are refused');
  r := public.retainer_mr_check(v_check);
  perform pg_temp.check((r->>'given')::int = 4 and (r->>'linked')::int = 1 and (r->>'name_differs')::int = 1 and (r->>'not_found')::int = 1 and (r->>'not_an_mr')::int = 1
    and r->'rows' = '[{"row": 50, "outcome": "linked"}, {"row": 51, "outcome": "name_differs"}, {"row": 52, "outcome": "not_found"}, {"row": 53, "outcome": "not_an_mr"}]'::jsonb,
    'Mr# check: "073201" with its name links, another name on 73202 does not, 73203 is on no file, "732-1" is no Mr# (' || r::text || ')');

  -- The dry run says exactly what the copy will do, and keeps nothing.
  d := public.import_retainer_records(v_khi, v_tab, true);
  perform pg_temp.check((d->>'dry_run')::boolean and (d->>'inserted')::int = 10
    and not exists (select 1 from public.retainer_cases where source = 'sheet_import')
    and not exists (select 1 from public.retainer_team where name in ('Sample Checker Two', 'Sample New Maker')),
    'dry run: 10 rows would be added; no row and no team name is kept (' || d::text || ')');
  r := public.import_retainer_records(v_khi, v_tab);
  perform pg_temp.check(r - 'dry_run' = d - 'dry_run' and not (r->>'dry_run')::boolean, 'copy: the dry run said exactly what the copy did');
  perform pg_temp.check((r->>'given')::int = 13 and (r->>'inserted')::int = 10 and (r->>'skipped_count')::int = 3 and (r->>'kept')::int = 0,
    'copy: 13 given, 10 added, 3 skipped (' || r::text || ')');
  perform pg_temp.check(r->'skipped' @> '[{"row": 7, "reason": "No patient name"}]' and r->'skipped' @> '[{"row": 2, "reason": "The same sheet row is in the tab twice"}]'
    and r->'skipped' @> '[{"reason": "No sheet row number"}]', 'copy: each skipped row says why');
  perform pg_temp.check(r->'team_added' = '["Sample Checker Two", "Sample New Maker"]'::jsonb, 'copy: the two names not on the team are added, each once (' || (r->'team_added')::text || ')');

  select * into c from public.retainer_cases where city_id = v_khi and source_row = 2;
  perform pg_temp.check(c.patient_name = 'Sample Sheet Alpha' and c.source = 'sheet_import' and c.source_name = 'Sample Sheet Alpha' and c.created_by = v_admin::uuid
    and c.impression_date = '2025-04-08' and c.retainer_date = '2025-04-20' and c.status = 'Delivered to patient' and c.payment = 'Paid' and c.patient_id is null and c.branch_id is null
    and c.model_check_by = (select id from public.retainer_team where name = 'Dr. Sample Checker') and c.made_by = (select id from public.retainer_team where name = 'Sample Maker A')
    and not c.edited_on_site and not c.linked_by_hand,
    'copy: a sheet row lands with its dates, status, payment and team members (matched by name whatever the capitals), unmarked');
  perform pg_temp.check(c.delivered_date is null and c.next_check_date is null, 'copy: a delivered sheet row gets no made-up delivered date and no retainer check (so it is never overdue)');
  select * into c from public.retainer_cases where city_id = v_khi and source_row = 3;
  perform pg_temp.check(c.patient_name = 'Sample Sheet Bravo' and c.retainer_date is null and c.retainer_sheet = 'Re-purchase needed', 'copy: names are trimmed; "Retainer made" from the sheet fills no date');
  select * into c from public.retainer_cases where city_id = v_khi and source_row = 4;
  perform pg_temp.check(c.impression_date is null and c.impression_text = '30-02-2025' and c.status is null, 'copy: a day that does not exist is no date, and the typed text is kept; a blank status stays blank');
  select * into c from public.retainer_cases where city_id = v_khi and source_row = 5;
  perform pg_temp.check(c.impression_date is null and c.impression_text = 'soon' and c.status is null, 'copy: an unreadable date keeps its text; a dash-only status is blank');
  select * into c from public.retainer_cases where city_id = v_khi and source_row = 6;
  perform pg_temp.check(c.impression_date = '2025-05-02' and c.impression_text is null, 'copy: the typed text is dropped when the date was read');

  perform pg_temp.check((select role from public.retainer_team where name = 'Sample Checker Two') = 'both', 'copy: a new name used to check models and to make retainers is "both"');
  perform pg_temp.check((select role from public.retainer_team where name = 'Sample New Maker') = 'maker' and (select city_id from public.retainer_team where name = 'Sample New Maker') = v_khi,
    'copy: a new maker belongs to the tab''s city');
  perform pg_temp.check((select role from public.retainer_team where name = 'Sample Maker B') = 'both', 'copy: a member found in a new role becomes "both"');
  -- The most active makers of the tab (the website row of section 3 counts too): Maker A (7 rows) and New Maker (2 of 10: a fifth). New Maker
  -- is new, so he gets the strongest colour nobody has; Checker Two (1 row) a light one; Maker A keeps the black chosen for him. Maker A and
  -- Maker B are in the banner already (every city), so the copy puts nobody else there.
  perform pg_temp.check(r->'top_makers' = '["Sample Maker A", "Sample New Maker"]'::jsonb
    and r->'team_colours' = '[{"name": "Sample New Maker", "colour": "navy", "top": true}, {"name": "Sample Checker Two", "colour": "amber", "top": false}]'::jsonb
    and r->'team_featured' = '[]'::jsonb and (select colour from public.retainer_team where name = 'Sample Maker A') = 'black'
    and (select colour from public.retainer_team where name = 'Sample New Maker') = 'navy' and not (select featured from public.retainer_team where name = 'Sample New Maker'),
    'copy: colours for the new makers, the most active the strongest; a chosen colour and the banner stay (' || (r->'team_colours')::text || ')');
  perform pg_temp.check(not exists (select 1 from public.retainer_team where role <> 'model_check' and colour = 'grey'), 'copy: no maker is given the light grey');

  -- The Mr# rows: one linked (its name fits the file), the others keep the Mr# as typed.
  perform pg_temp.check((r->>'mr_given')::int = 4 and (r->>'linked')::int = 1 and (r->>'not_linked')::int = 3
    and r->'not_linked_why' = '{"name_differs": 1, "not_found": 1, "not_an_mr": 1}'::jsonb, 'Mr#: 4 rows with an Mr#, 1 linked, 3 not, each with why');
  select * into c from public.retainer_cases where city_id = v_khi and source_row = 50;
  perform pg_temp.check(c.patient_id = (select id from public.patients where mr_number = '73201') and c.mr_text = '073201' and c.patient_name = 'Hamna Sampleton' and not c.linked_by_hand,
    'Mr#: the row is linked to Mr# 73201 (the leading 0 does not matter), keeps the Mr# as typed, and is not "linked by hand"');
  select * into c from public.retainer_cases where city_id = v_khi and source_row = 51;
  perform pg_temp.check(c.patient_id is null and c.mr_text = '73202' and c.patient_name = 'Minahil Sampleton',
    'Mr#: a name that does not fit the file of its Mr# is not linked (the typed Mr# is kept to look at)');
  perform pg_temp.check((select mr_text from public.retainer_cases where city_id = v_khi and source_row = 53) = '732-1'
    and (select mr_text from public.retainer_cases where city_id = v_khi and source_row = 54) is null, 'Mr#: a cell that is no Mr# is kept as typed; no Mr#, nothing');

  -- A second copy of Karachi is refused in plain words: the same tab sent again (an answer lost on the way), its dry run, or another file.
  select count(*) into n from public.retainer_cases where city_id = v_khi;
  perform pg_temp.expect_state(format('select public.import_retainer_records(%s::smallint, %L::jsonb)', v_khi, v_tab), '55000',
    format('ALREADY_COPIED: Karachi was already copied on %s (10 retainers). The website is now the Retainer Record: add or change retainers there.', to_char(v_today, 'FMDD Mon YYYY')),
    'a second copy of Karachi is refused, with the day and the size of the copy');
  perform pg_temp.expect_state(format('select public.import_retainer_records(%s::smallint, %L::jsonb, true)', v_khi, v_tab), '55000', 'ALREADY_COPIED: Karachi was already copied',
    'a dry run of a second copy is refused too (the preview says so)');
  perform pg_temp.expect_state(format('select public.import_retainer_records(%s::smallint, %L::jsonb)', v_khi, jsonb_build_array(pg_temp.retainer_wire(90, 'Sample Late Row', null, null, null))),
    '55000', 'ALREADY_COPIED', 'a copy with other rows is refused too');
  perform pg_temp.check((select count(*) from public.retainer_cases where city_id = v_khi) = n and (select count(*) from public.retainer_cases where source = 'sheet_import') = 10,
    'refused: nothing is added twice (still 10 copied rows)');

  -- The Lahore tab is its own copy, with its own row numbers; a Karachi maker who also works in Lahore works in every city from now on.
  r := public.import_retainer_records(v_lahore, jsonb_build_array(
    pg_temp.retainer_wire(2, 'Sample Lahore Sheet', '2025-11-20', null, 'Sample New Maker', 'Retainer made'),
    pg_temp.retainer_wire(3, 'Sample Lahore Sheet Two', null, null, 'Lahore Only Maker')));
  perform pg_temp.check((r->>'inserted')::int = 2 and r->'team_added' = '["Lahore Only Maker"]'::jsonb, 'Lahore tab: row 2 is a new row there (rows are numbered per tab)');
  perform pg_temp.check((select city_id from public.retainer_team where name = 'Sample New Maker') is null and (select city_id from public.retainer_team where name = 'Lahore Only Maker') = v_lahore,
    'Lahore tab: the Karachi maker now works in every city; a Lahore-only name belongs to Lahore');
  perform pg_temp.check(r->'team_colours' = '[{"name": "Lahore Only Maker", "colour": "forest", "top": true}]'::jsonb,
    'Lahore tab: its new top maker gets the next strongest colour (navy is taken) (' || (r->'team_colours')::text || ')');

  -- Removing copied rows: Dr. Ali only.
  perform pg_temp.act_as(v_coord);
  delete from public.retainer_cases where city_id = v_khi and source_row = 6;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0, 'coordinator: a copied row is not removed');
  perform pg_temp.act_as(v_admin);
  delete from public.retainer_cases where city_id = v_khi and source_row = 6;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'Dr. Ali: removes a copied row');
  perform pg_temp.check(exists (select 1 from pg_attribute att join pg_class rel on rel.oid = att.attrelid where rel.relname = 'retainer_import' and rel.relpersistence = 't' and att.attname = 'rn' and not att.attisdropped)
    and not exists (select 1 from pg_attribute att join pg_class rel on rel.oid = att.attrelid where rel.relname = 'retainer_import' and rel.relpersistence = 't' and att.attname = 'not_ours'),
    'copy: a table of that name left by somebody else was replaced by the copy''s own, never used as it was');
end $$;
reset role;

-- 6b. Rows changed on the website are marked (by anybody, Dr. Ali too): linked_by_hand for a patient file linked or unlinked, edited_on_site
-- for any change. The copy marks nothing, a save that changes nothing marks nothing, and nobody takes a mark off (or writes where a row came
-- from) through the API.
set role authenticated;
do $$
declare v_admin text := current_setting('test.admin'); v_coord text := current_setting('test.coord'); v_khi smallint := current_setting('test.khi')::smallint;
begin
  perform pg_temp.check(not exists (select 1 from public.retainer_cases where source = 'sheet_import' and (edited_on_site or linked_by_hand)), 'marks: no copied row is marked yet');
  perform pg_temp.act_as(v_coord);
  update public.retainer_cases set payment = 'Paid' where city_id = v_khi and source_row = 3;                                   -- a payment set
  update public.retainer_cases set patient_id = (select id from public.patients where mr_number = '32001') where city_id = v_khi and source_row = 51;   -- linked
  update public.retainer_cases set patient_id = null where city_id = v_khi and source_row = 50;                                  -- "Unlink"
  update public.retainer_cases set notes = notes, status = status where city_id = v_khi and source_row = 5;                     -- saved, nothing changed
  perform pg_temp.check((select edited_on_site and not linked_by_hand from public.retainer_cases where city_id = v_khi and source_row = 3)
    and (select edited_on_site and linked_by_hand from public.retainer_cases where city_id = v_khi and source_row = 51)
    and (select edited_on_site and linked_by_hand and patient_id is null from public.retainer_cases where city_id = v_khi and source_row = 50)
    and (select not edited_on_site and not linked_by_hand from public.retainer_cases where city_id = v_khi and source_row = 5),
    'marks: a payment set is a change; a link made or undone is a change and by hand; a save that changes nothing is no change');
  update public.retainer_cases set edited_on_site = false, linked_by_hand = false where city_id = v_khi and source_row in (3, 50, 51);
  perform pg_temp.check((select count(*) from public.retainer_cases where city_id = v_khi and source_row in (3, 50, 51) and edited_on_site) = 3
    and (select linked_by_hand from public.retainer_cases where city_id = v_khi and source_row = 51), 'marks: they cannot be taken off through the API');
  perform pg_temp.expect_state(format('update public.retainer_cases set source_name = ''Sample Other'' where city_id = %s and source_row = 2', v_khi), '42501', 'NOT_ALLOWED',
    'guard: the name a row was copied with cannot be changed by hand');
  perform pg_temp.expect_state(format('insert into public.retainer_cases (city_id, patient_name, source_name) values (%s, ''Sample Pose Two'', ''Sample Pose Two'')', v_khi), '42501', 'NOT_ALLOWED',
    'guard: nor written on a new row');
  perform pg_temp.act_as(v_admin);
  update public.retainer_cases set status = 'Delivered to patient' where city_id = v_khi and source_row = 4;
  perform pg_temp.check((select edited_on_site from public.retainer_cases where city_id = v_khi and source_row = 4), 'marks: a change by Dr. Ali is a change too');
end $$;
reset role;

-- 6c. "Undo the copy for <city>": the copied rows nobody changed go, the changed ones stay (as the website's own rows), and a corrected copy
-- can then be made; it leaves out the sheet rows of the rows that stayed and reports a stayed row it finds no sheet row of its name for.
set role authenticated;
do $$
declare
  v_admin text := current_setting('test.admin'); v_coord text := current_setting('test.coord');
  v_khi smallint := current_setting('test.khi')::smallint; v_lahore smallint := current_setting('test.lahore')::smallint;
  v_isb smallint := (select id from public.cities where name = 'Islamabad'); v_today date := current_setting('test.today')::date;
  r jsonb; d jsonb; v_fixed jsonb; v_before text; n int;
begin
  perform pg_temp.act_as(v_coord);
  perform pg_temp.expect_state(format('select public.undo_retainer_copy(%s::smallint)', v_khi), '42501', 'NOT_ALLOWED', 'undo: only Dr. Ali');
  perform pg_temp.expect_state('select public.retainer_copies()', '42501', 'NOT_ALLOWED', 'the list of copies: only Dr. Ali');
  perform pg_temp.act_as(v_admin);
  perform pg_temp.expect_state(format('select public.undo_retainer_copy(%s::smallint)', v_isb), '22023', 'NOT_COPIED: Islamabad has no copy of the sheet to undo.', 'undo: a city with no copy says so');
  r := public.retainer_copies();
  perform pg_temp.check(r @> jsonb_build_array(jsonb_build_object('city', 'Karachi', 'copied_on', v_today, 'retainers', 9, 'changed', 4, 'kept', 0))
    and r @> jsonb_build_array(jsonb_build_object('city', 'Lahore', 'retainers', 2, 'changed', 0)) and jsonb_array_length(r) = 2,
    'copies: Karachi copied today, 9 rows (one removed), 4 changed on the website; Lahore 2 rows (' || r::text || ')');
  select string_agg(format('%s|%s|%s|%s', source_row, patient_name, payment, status), ';' order by source_row) into v_before
    from public.retainer_cases where city_id = v_khi and source = 'sheet_import' and source_row in (3, 4, 50, 51);
  d := public.undo_retainer_copy(v_khi, true);
  perform pg_temp.check(d = '{"city": "Karachi", "removed": 5, "stayed": 4, "dry_run": true}'::jsonb and (select count(*) from public.retainer_cases where city_id = v_khi and source = 'sheet_import') = 9,
    'undo, the question first: 5 would go, 4 would stay, and nothing changed yet (' || d::text || ')');
  r := public.undo_retainer_copy(v_khi);
  perform pg_temp.check(r = '{"city": "Karachi", "removed": 5, "stayed": 4, "dry_run": false}'::jsonb, 'undo: 5 copied rows nobody changed are removed, 4 stay (' || r::text || ')');
  perform pg_temp.check(not exists (select 1 from public.retainer_cases where city_id = v_khi and source = 'sheet_import')
    and (select string_agg(format('%s|%s|%s|%s', source_row, patient_name, payment, status), ';' order by source_row) from public.retainer_cases
          where city_id = v_khi and source = 'website' and source_row in (3, 4, 50, 51) and source_name is not null) = v_before
    and exists (select 1 from public.retainer_cases where city_id = v_khi and patient_name = 'Sample Karachi One'),
    'undo: the 4 changed rows stay with their changes, as website rows that remember their sheet row; the website''s own rows are not touched');
  perform pg_temp.check((select count(*) from public.retainer_cases where city_id = v_lahore and source = 'sheet_import') = 2, 'undo: the Lahore copy is not touched');
  perform pg_temp.check(public.retainer_copies() @> jsonb_build_array(jsonb_build_object('city', 'Karachi', 'retainers', 0, 'kept', 4)), 'copies: Karachi has no copy now, and 4 rows that stayed');
  perform pg_temp.check(exists (select 1 from public.audit_log where table_name = 'retainer_cases' and action = 'DELETE' and old_data ->> 'source_name' = 'Sample Sheet Alpha'),
    'undo: every removed row is in the audit log');

  -- The corrected copy: row 3 (kept, the same name in other capitals) and row 51 (kept) are left out; row 4 was kept under another name, so
  -- the sheet's row 4 is copied and both are reported, as is row 50 (kept, no longer on the sheet); row 2 (removed by the undo) comes again.
  v_fixed := jsonb_build_array(
    pg_temp.retainer_wire(2, 'Sample Sheet Alpha', '2025-04-08', 'Dr. Sample Checker', 'Sample Maker A', 'Delivered to patient', '2025-04-20', null, 'Paid'),
    pg_temp.retainer_wire(3, ' sample sheet  BRAVO ', '2025-04-15', 'Sample Checker Two', 'Sample New Maker', 'Retainer made'),
    pg_temp.retainer_wire(4, 'Sample Sheet Charlie Fixed', '2025-02-28', null, 'Sample New Maker'),
    jsonb_set(pg_temp.retainer_wire(51, 'Minahil Sampleton', '2025-06-02', null, 'Sample Maker A'), '{mr}', '"73202"'));
  r := public.import_retainer_records(v_khi, v_fixed);
  perform pg_temp.check((r->>'inserted')::int = 2 and (r->>'kept')::int = 2 and (r->>'skipped_count')::int = 2
    and r->'kept_other' = '[{"row": 4, "name": "Sample Sheet Charlie Fixed", "kept_name": "Sample Sheet Charlie"}, {"row": 50, "name": null, "kept_name": "Hamna Sampleton"}]'::jsonb
    and r->'skipped' @> '[{"row": 3, "reason": "Kept from the earlier copy (changed on the website), so it is not copied again"}]',
    'corrected copy: 2 added, the 2 rows that stayed are not copied again, the rows that stayed and are not on the sheet by that name are reported (' || r::text || ')');
  perform pg_temp.check((select count(*) from public.retainer_cases where city_id = v_khi and source_row = 3) = 1
    and (select count(*) from public.retainer_cases where city_id = v_khi and source_row = 4) = 2
    and (select count(*) from public.retainer_cases where city_id = v_khi and source = 'sheet_import') = 2, 'corrected copy: nobody twice by mistake; both row 4s are there to check');
  perform pg_temp.expect_state(format('select public.import_retainer_records(%s::smallint, %L::jsonb)', v_khi, v_fixed), '55000',
    format('ALREADY_COPIED: Karachi was already copied on %s (2 retainers).', to_char(v_today, 'FMDD Mon YYYY')), 'corrected copy: and then a copy again is refused');

  -- A whole tab of 3000 rows in one call (more than either of the clinic's tabs).
  r := public.import_retainer_records(v_isb, (select jsonb_agg(pg_temp.retainer_wire(1 + g, 'Sample Bulk ' || g, to_char(date '2025-06-01' + (g % 400), 'YYYY-MM-DD'),
                                                       'Dr. Sample Checker', case g % 3 when 0 then 'Sample Maker A' when 1 then 'Sample Maker B' else 'Sample New Maker' end,
                                                       case when g % 2 = 0 then 'Delivered to patient' end)) from generate_series(1, 3000) g));
  perform pg_temp.check((r->>'inserted')::int = 3000 and (r->>'skipped_count')::int = 0, 'copy: a tab of 3000 rows goes in in one call');
  perform pg_temp.expect_state(format('select public.import_retainer_records(%s::smallint, ''[]''::jsonb)', v_isb), '55000', 'ALREADY_COPIED: Islamabad was already copied on',
    'and Islamabad is copied now');
end $$;
reset role;

-- 6d. A corrected sheet moves rows: after an undo, a row deleted above the rows that stayed shifts them up one. Each row that stayed still
-- leaves out its own sheet row (its name; one with its impression date first, then the nearest row), one sheet row each, so a patient
-- with two lines on the sheet keeps both and nobody is on the Retainer Record twice by mistake. A date fixed on the website (Slip: the
-- copy read a slipped year) or on the sheet (Dated) does not stop the pairing; both are reported to be checked.
set role authenticated;
do $$
declare
  v_admin text := current_setting('test.admin'); v_lahore smallint := current_setting('test.lahore')::smallint;
  v_tab jsonb := '[]'::jsonb; v_fixed jsonb := '[]'::jsonb; r jsonb; k int := 0; p text;
  v_names text[] := array['Sample Lhr A', 'Sample Lhr B', 'Sample Lhr C', 'Sample Lhr D', 'Sample Lhr E', 'Sample Lhr F', 'Sample Lhr G', 'Sample Lhr H',
                          'Sample Lhr Twin', 'Sample Lhr Twin', 'Sample Lhr Same', 'Sample Lhr Same', 'Sample Lhr Slip', 'Sample Lhr Dated'];
  v_imps text[] := array['2025-03-01', '2025-03-02', '2025-03-03', '2025-03-04', '2025-03-05', '2025-03-06', '2025-03-07', '2025-03-08',
                         '2025-05-01', '2025-09-01', null, null, '2028-12-15', '2025-03-09'];
  v_dates jsonb := '[{"row": 13, "name": "Sample Lhr Slip", "kept_date": "2025-12-15", "sheet_date": "2028-12-15"},
                     {"row": 14, "name": "Sample Lhr Dated", "kept_date": "2025-03-09", "sheet_date": "2025-03-10"}]';
begin
  perform pg_temp.act_as(v_admin);
  perform public.undo_retainer_copy(v_lahore);
  foreach p in array v_names loop
    k := k + 1;
    v_tab := v_tab || jsonb_build_array(pg_temp.retainer_wire(k + 1, p, v_imps[k], null, 'Lahore Only Maker'));
    -- the corrected sheet: row 4 (Sample Lhr C) deleted, every row below it one up; the date of Dated corrected; the date of the second
    -- Twin line cleared (it now sits, with no date, at the kept Twin row's old number: the line with the kept row's date still wins)
    if k <> 3 then
      v_fixed := v_fixed || jsonb_build_array(pg_temp.retainer_wire(case when k < 3 then k + 1 else k end, p,
                                                                    case when k = 14 then '2025-03-10' when k = 10 then null else v_imps[k] end, null, 'Lahore Only Maker'));
    end if;
  end loop;
  r := public.import_retainer_records(v_lahore, v_tab);
  perform pg_temp.check((r->>'inserted')::int = 14, 'moved rows: the Lahore tab of 14 rows is copied');
  update public.retainer_cases set status = 'Delivered to patient' where city_id = v_lahore and source = 'sheet_import' and source_row = 8;   -- G
  update public.retainer_cases set payment = 'Paid' where city_id = v_lahore and source = 'sheet_import' and source_row = 10;                -- Twin, first line
  update public.retainer_cases set notes = 'Upper only' where city_id = v_lahore and source = 'sheet_import' and source_row = 12;            -- Same, first line
  update public.retainer_cases set impression_date = '2025-12-15' where city_id = v_lahore and source = 'sheet_import' and source_row = 14;  -- Slip: the year fixed
  update public.retainer_cases set payment = 'Paid' where city_id = v_lahore and source = 'sheet_import' and source_row = 15;                -- Dated
  r := public.undo_retainer_copy(v_lahore);
  perform pg_temp.check(r = '{"city": "Lahore", "removed": 9, "stayed": 5, "dry_run": false}'::jsonb, 'moved rows: the undo keeps the 5 changed rows (' || r::text || ')');
  r := public.import_retainer_records(v_lahore, v_fixed, true);
  perform pg_temp.check((r->>'inserted')::int = 8 and (r->>'kept')::int = 5 and r->'kept_other' = '[]'::jsonb and r->'kept_date_differs' = v_dates,
    'moved rows, the preview: 8 added, the 5 rows that stayed each leave out one sheet row of their own, the 2 with another date on the sheet reported (' || r::text || ')');
  r := public.import_retainer_records(v_lahore, v_fixed);
  perform pg_temp.check((r->>'inserted')::int = 8 and (r->>'kept')::int = 5 and r->'kept_other' = '[]'::jsonb and r->'kept_date_differs' = v_dates
    and r->'skipped' @> '[{"row": 7, "reason": "Kept from the earlier copy (changed on the website), so it is not copied again"}, {"row": 9}, {"row": 12}, {"row": 13}, {"row": 14}]',
    'moved rows: G (now row 7), the Twin line of 1 May (now row 9), the nearest Same line (now row 12), Slip and Dated (rows 13, 14) are left out (' || r::text || ')');
  perform pg_temp.check((select string_agg(coalesce(impression_date::text, '-') || '|' || coalesce(payment, '-'), ';' order by impression_date) from public.retainer_cases
          where city_id = v_lahore and patient_name in ('Sample Lhr Slip', 'Sample Lhr Dated')) = '2025-03-09|Paid;2025-12-15|-',
    'a date fixed on either side: Slip and Dated are on the Retainer Record once each, with the website''s date and changes');
  perform pg_temp.check((select count(*) from public.retainer_cases where city_id = v_lahore and source_row is not null) = 13
    and (select count(*) from public.retainer_cases where city_id = v_lahore and patient_name = 'Sample Lhr G') = 1
    and (select count(*) from public.retainer_cases where city_id = v_lahore and patient_name = 'Sample Lhr C') = 0
    and (select string_agg(coalesce(impression_date::text, '-') || '|' || coalesce(payment, '-'), ';' order by impression_date) from public.retainer_cases
          where city_id = v_lahore and patient_name = 'Sample Lhr Twin') = '2025-05-01|Paid;-|-'
    and (select count(*) from public.retainer_cases where city_id = v_lahore and patient_name = 'Sample Lhr Same') = 2,
    'moved rows: 13 rows for the 13 sheet rows: G once, both Twin lines (the changed one kept), both Same lines');
end $$;
reset role;

-- 7. Lab work
set role authenticated;
do $$
declare
  v_coord text := current_setting('test.coord'); v_fd text := current_setting('test.fd'); v_lhr text := current_setting('test.lhr'); v_doc text := current_setting('test.doc');
  v_admin text := current_setting('test.admin');
  v_nn smallint := current_setting('test.nn')::smallint; v_gul smallint := current_setting('test.gul')::smallint; v_lhrb smallint := current_setting('test.lhrb')::smallint;
  v_today date := current_setting('test.today')::date; v_id uuid; r record; n int;
begin
  perform pg_temp.act_as(v_coord);
  insert into public.lab_cases (branch_id, patient_name, work_type, teeth, shade, lab_name, handled_by, due_date, cost, payment)
    values (v_nn, 'Sample Lab One', 'Crown', 'UR6', 'A2', 'Sample Dental Lab', 'Sample Lab Hand', v_today - 2, 5000, 'Pending') returning id into v_id;
  select * into r from public.lab_cases where id = v_id;
  perform pg_temp.check(r.status = 'sent' and r.sent_date = v_today and r.patient_id is null and r.created_by = v_coord::uuid,
    'lab: a case with only a name is "sent", sent today, author set');
  insert into public.lab_cases (branch_id, patient_name, work_type) values (v_gul, 'Sample Lab Gulshan', 'Veneer');
  perform pg_temp.expect_error(format('update public.lab_cases set status = ''returned'' where id = %L', v_id), 'lab_cases_status_check', 'lab: the old "returned" status is refused (it is "remake" now)');
  perform pg_temp.expect_error(format('insert into public.lab_cases (branch_id) values (%s)', v_nn), 'lab_cases_who_check', 'lab: a case needs a name or a patient file');
  update public.lab_cases set status = 'received' where id = v_id;
  perform pg_temp.check((select received_date from public.lab_cases where id = v_id) = v_today, 'lab: "Received" fills the received date');
  update public.lab_cases set status = 'fitted', received_date = '2026-10-01' where id = v_id;
  select * into r from public.lab_cases where id = v_id;
  perform pg_temp.check(r.fitted_date = v_today and r.received_date = '2026-10-01', 'lab: "Fitted" fills the fitted date and keeps a received date already there');
  insert into public.lab_cases (branch_id, patient_name, status) values (v_nn, 'Sample Lab Straight Fit', 'fitted') returning id into v_id;
  select * into r from public.lab_cases where id = v_id;
  perform pg_temp.check(r.received_date = v_today and r.fitted_date = v_today, 'lab: a case entered as fitted gets both dates');
  perform pg_temp.expect_state(format('update public.lab_cases set created_by = %L where id = %L', v_admin, v_id), '42501', 'NOT_ALLOWED', 'lab guard: the author cannot be changed');

  perform pg_temp.act_as(v_fd);
  perform pg_temp.check(exists (select 1 from public.lab_cases where patient_name = 'Sample Lab One') and not exists (select 1 from public.lab_cases where patient_name = 'Sample Lab Gulshan'),
    'front desk NN: reads the NN lab work, not Gulshan''s');
  perform pg_temp.expect_error(format('insert into public.lab_cases (branch_id, patient_name) values (%s, ''Sample Desk Lab'')', v_nn), 'row-level security', 'front desk: cannot add lab work');
  perform pg_temp.act_as(v_doc);
  perform pg_temp.check((select count(*) from public.lab_cases) = 3, 'doctor: reads the lab work (patient files)');
  perform pg_temp.expect_error(format('insert into public.lab_cases (branch_id, patient_name) values (%s, ''Sample Doc Lab'')', v_nn), 'row-level security', 'doctor (no "Lab work entries"): cannot add');
  perform pg_temp.act_as(v_lhr);
  insert into public.lab_cases (branch_id, patient_name) values (v_lhrb, 'Sample Lahore Lab');
  perform pg_temp.expect_error(format('insert into public.lab_cases (branch_id, patient_name) values (%s, ''Sample Lahore Try'')', v_nn), 'row-level security', 'Lahore assistant: cannot add NN lab work');
  perform pg_temp.check((select count(*) from public.lab_cases) = 1, 'Lahore assistant: sees only the Lahore lab work');
  perform pg_temp.act_as(v_coord);
  delete from public.lab_cases where patient_name = 'Sample Lab Straight Fit';
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'coordinator: removes a lab row');
end $$;
reset role;

-- 8. A patient file that is deleted leaves its rows, with the name.
set role authenticated;
do $$
declare v_admin text := current_setting('test.admin'); v_coord text := current_setting('test.coord'); v_khi smallint := current_setting('test.khi')::smallint;
  v_nn smallint := current_setting('test.nn')::smallint; v_pid uuid; v_r uuid; v_l uuid;
begin
  select id into v_pid from public.patients where mr_number = '32002';
  perform pg_temp.act_as(v_coord);
  insert into public.retainer_cases (city_id, patient_id) values (v_khi, v_pid) returning id into v_r;
  insert into public.lab_cases (branch_id, patient_id) values (v_nn, v_pid) returning id into v_l;
  perform pg_temp.act_as(v_admin);
  delete from public.patients where id = v_pid;
  perform pg_temp.check((select patient_id is null and patient_name = 'Sample Leaving Patient' from public.retainer_cases where id = v_r)
    and (select patient_id is null and patient_name = 'Sample Leaving Patient' from public.lab_cases where id = v_l),
    'a deleted patient file leaves its retainer and lab rows, with the name');
end $$;
reset role;

-- 9. The "Lab and retainer costs" report on the reshaped tables: lab work by its sent date; a retainer only when it has a lab cost, by its
-- retainer date (the hundreds of rows copied from the sheet have no cost, and are no "cases" piled up in the month of the import).
select set_config('test.lab_cases', (select count(*)::text from public.lab_cases where status <> 'cancelled'), false);
set role authenticated;
do $$
declare v_admin text := current_setting('test.admin'); v_coord text := current_setting('test.coord'); v_khi smallint := current_setting('test.khi')::smallint;
  v_nn smallint := current_setting('test.nn')::smallint; v_labs int := current_setting('test.lab_cases')::int; r jsonb;
begin
  perform pg_temp.act_as(v_admin);
  r := public.clinic_report('lab_costs', date '2024-01-01', date '2027-12-31');
  perform pg_temp.check(jsonb_typeof(r) = 'array' and (select sum((x->>'cost')::numeric) from jsonb_array_elements(r) x) = 5000
    and (select sum((x->>'cases')::int) from jsonb_array_elements(r) x) = v_labs,
    'report: the lab cost adds up, and the ' || (select count(*) from public.retainer_cases) || ' retainer rows without a lab cost are no cases (' || v_labs || ' lab cases)');
  perform pg_temp.act_as(v_coord);
  insert into public.retainer_cases (city_id, branch_id, patient_name, impression_date, retainer_date, lab_cost)
    values (v_khi, v_nn, 'Sample Costed Retainer', '2025-07-28', '2025-08-15', 2000);
  perform pg_temp.act_as(v_admin);
  r := public.clinic_report('lab_costs', date '2024-01-01', date '2027-12-31');
  perform pg_temp.check(r @> jsonb_build_array(jsonb_build_object('month', '2025-08', 'branch_id', v_nn, 'cases', 1, 'cost', 2000))
    and (select sum((x->>'cases')::int) from jsonb_array_elements(r) x) = v_labs + 1, 'report: a retainer with a lab cost is one case, in the month of its retainer date');
end $$;
reset role;

-- 9a. Lab work without a Sent date (the Lab work page lets it be left empty, or cleared) keeps its cost in the report: it is counted by the
-- day it came back, else was fitted, else was added.
set role authenticated;
do $$
declare v_admin text := current_setting('test.admin'); v_coord text := current_setting('test.coord'); v_nn smallint := current_setting('test.nn')::smallint;
  v_today date := current_setting('test.today')::date; r jsonb; v_cost numeric; v_cases int; n int;
begin
  perform pg_temp.act_as(v_admin);
  r := public.clinic_report('lab_costs', date '2000-01-01', date '2100-12-31');
  select sum((x->>'cost')::numeric), sum((x->>'cases')::int) into v_cost, v_cases from jsonb_array_elements(r) x;
  perform pg_temp.act_as(v_coord);
  insert into public.lab_cases (branch_id, patient_name, cost, sent_date) values (v_nn, 'Sample No Sent Lab', 7000, null);
  insert into public.lab_cases (branch_id, patient_name, cost, sent_date, received_date) values (v_nn, 'Sample Back Lab', 3000, null, '2025-03-10');
  update public.lab_cases set sent_date = null where patient_name = 'Sample Lab One' and cost = 5000;
  get diagnostics n = row_count;
  perform pg_temp.act_as(v_admin);
  r := public.clinic_report('lab_costs', date '2000-01-01', date '2100-12-31');
  perform pg_temp.check(n = 1 and (select sum((x->>'cost')::numeric) from jsonb_array_elements(r) x) = v_cost + 10000
    and (select sum((x->>'cases')::int) from jsonb_array_elements(r) x) = v_cases + 2,
    'report: lab work without a Sent date (added so, or cleared) keeps its cost and is one case each');
  r := public.clinic_report('lab_costs', date '2025-03-01', date '2025-03-31');
  perform pg_temp.check(r = jsonb_build_array(jsonb_build_object('month', '2025-03', 'branch_id', v_nn, 'cases', 1, 'cost', 3000)),
    'report: a case without a Sent date is counted in the month it came back');
  r := public.clinic_report('lab_costs', v_today, v_today);
  perform pg_temp.check((select sum((x->>'cost')::numeric) from jsonb_array_elements(r) x where x->>'branch_id' = v_nn::text) >= 7000,
    'report: a case without a Sent date that is not back yet is counted on the day it was added');
end $$;
reset role;

-- 9b. New words for a status (or a lab work type) keep its rows: the list item and every row with the old words take the new ones, so no
-- row drops off the list and "delivered" keeps counting.
set role authenticated;
do $$
declare v_admin text := current_setting('test.admin'); v_coord text := current_setting('test.coord'); n int; v_had int; v_id uuid;
begin
  perform pg_temp.act_as(v_coord);
  perform pg_temp.expect_state($q$select public.rename_record_option('retainer_statuses', 'Delivered to patient', 'Delivered')$q$, '42501', 'NOT_ALLOWED', 'rename: only Dr. Ali');
  perform pg_temp.act_as(v_admin);
  select count(*) into v_had from public.retainer_cases where lower(status) = 'delivered to patient';
  n := public.rename_record_option('retainer_statuses', 'delivered TO patient', '  Delivered ');
  perform pg_temp.check(v_had > 0 and n = v_had and not exists (select 1 from public.retainer_cases where lower(status) = 'delivered to patient')
    and (select count(*) from public.retainer_cases where status = 'Delivered') = v_had
    and (select value from public.app_settings where key = 'retainer_statuses') @> '[{"label": "Delivered", "means": "delivered"}]' and not (select value from public.app_settings where key = 'retainer_statuses') @> '[{"label": "Delivered to patient"}]',
    'rename: "Delivered to patient" is "Delivered" on the list (still meaning delivered) and on all its ' || v_had || ' rows');
  perform pg_temp.check((select string_agg(e->>'label', ' > ' order by o) from jsonb_array_elements((select value from public.app_settings where key = 'retainer_statuses')) with ordinality x(e, o) where o between 4 and 6)
    = 'Retainer made > Delivered > Impression repeat', 'rename: the status keeps its place on the list');
  perform pg_temp.expect_state($q$select public.rename_record_option('retainer_statuses', 'Delivered', 'model-checked')$q$, '23505', 'ALREADY_ON_LIST', 'rename: not to words already on the list');
  perform pg_temp.expect_state($q$select public.rename_record_option('retainer_statuses', 'Delivered', ' - ')$q$, '22023', 'BAD_NAME', 'rename: not to nothing');
  perform pg_temp.expect_state($q$select public.rename_record_option('app_name', 'a', 'b')$q$, '22023', 'BAD_LIST', 'rename: only these two lists');
  -- The new words work like the old ones on the website: Delivered fills the delivered date.
  perform pg_temp.act_as(v_coord);
  insert into public.retainer_cases (city_id, patient_name) values (current_setting('test.khi')::smallint, 'Sample Renamed Status') returning id into v_id;
  update public.retainer_cases set status = 'Delivered' where id = v_id;
  perform pg_temp.check((select delivered_date is not null and retainer_date is not null from public.retainer_cases where id = v_id), 'rename: the new words still mean delivered (the dates are filled)');
  perform pg_temp.act_as(v_admin);
  n := public.rename_record_option('lab_work_types', 'crown', 'Crown (PFM)');
  perform pg_temp.check(n >= 1 and not exists (select 1 from public.lab_cases where work_type = 'Crown') and (select value from public.app_settings where key = 'lab_work_types') @> '[{"label": "Crown (PFM)"}]',
    'rename: a lab work type keeps its rows too (' || n || ' changed)');
end $$;
reset role;

-- 10. The audit log
do $$
begin
  perform pg_temp.check(exists (select 1 from public.audit_log where table_name = 'retainer_team' and action = 'INSERT' and actor = current_setting('test.admin')::uuid and new_data ->> 'name' = 'Sample Maker A'),
    'audit log: a team member added by Dr. Ali is recorded');
  perform pg_temp.check(exists (select 1 from public.audit_log where table_name = 'retainer_cases' and action = 'UPDATE' and actor = current_setting('test.coord')::uuid
    and new_data ->> 'status' = 'Delivered to patient'), 'audit log: a status change on the website is recorded with who made it');
  perform pg_temp.check(exists (select 1 from public.audit_log where table_name = 'lab_team' and action = 'INSERT'), 'audit log: the lab team is recorded too');
end $$;

-- 10b. "Braces are off — start the retainer case?" (patients.js) for a doctor who works at North Nazimabad only, with a patient first
-- registered at Gulshan: a row at Gulshan is refused, so the dialog sends a branch the doctor works at, or no branch and the patient's
-- city (a row of the city's tab); both are allowed. Another city's tab stays refused.
reset role;
select pg_temp.act_as('');
update public.staff set restrict_to_branches = true, branch_ids = array[current_setting('test.nn')::smallint] where id = current_setting('test.doc')::uuid;
set role authenticated;
do $$
declare
  v_doc text := current_setting('test.doc'); v_khi smallint := current_setting('test.khi')::smallint; v_lahore smallint := current_setting('test.lahore')::smallint;
  v_nn smallint := current_setting('test.nn')::smallint; v_gul smallint := current_setting('test.gul')::smallint;
  v_pid uuid;
begin
  perform pg_temp.act_as(v_doc);
  select id into v_pid from public.patients where mr_number = '32001';
  perform pg_temp.check(v_pid is not null, 'doctor NN: opens the patient file');
  perform pg_temp.check(public.has_perm('retainers.manage'), 'doctor NN: has "Manage retainer cases"');
  perform pg_temp.expect_error(format('insert into public.retainer_cases (patient_id, branch_id, city_id, status) values (%L, %s, %s, ''Impression taken'')', v_pid, v_gul, v_khi),
    'row-level security', 'doctor NN: a retainer row at the patient''s first branch (Gulshan) is refused');
  insert into public.retainer_cases (patient_id, branch_id, city_id, status) values (v_pid, v_nn, v_khi, 'Impression taken');
  insert into public.retainer_cases (patient_id, branch_id, city_id, status) values (v_pid, null, v_khi, 'Impression taken');
  perform pg_temp.check((select count(*) from public.retainer_cases where patient_id = v_pid and created_by = v_doc::uuid) = 2,
    'doctor NN: the row at North Nazimabad and the row of the Karachi tab with no branch are both added');
  perform pg_temp.expect_error(format('insert into public.retainer_cases (patient_id, branch_id, city_id) values (%L, null, %s)', v_pid, v_lahore),
    'row-level security', 'doctor NN: the Lahore tab stays refused');
end $$;
reset role;
rollback;

-- 11. In its own transaction (as the SQL editor runs it, nobody signed in) the copy leaves no work table behind.
select pg_temp.act_as('');
select public.import_retainer_records((select id from public.cities where name = 'Islamabad'), '[]'::jsonb);
select pg_temp.check(not exists (select 1 from pg_class where relname in ('retainer_import', 'retainer_import_team', 'retainer_import_kept') and relpersistence = 't'),
  'copy: the work tables do not outlive the call');

-- 12. Colours and the banner. On a database with no retainer team yet (as on the live one), the copy of a tab gives its most active makers
-- (by how many of the tab's rows they made: at most three, each with at least a fifth) the strongest colours, each a different one, and
-- puts them in the "Retainer Lab" banner; the other makers get light colours, a model checker the deep purple, and nobody the light grey
-- (the blank chip and "someone not on the team"). A colour chosen in Clinic setup stays; a member still in light grey gets one; once
-- anybody of a city is in the banner, a copy puts nobody else there. (tests/records.test.ts runs the same Islamabad tab through topMakers.)
begin;
select pg_temp.act_as('');
do $$
declare
  v_isb smallint := (select id from public.cities where name = 'Islamabad');
  v_lahore smallint := (select id from public.cities where name = 'Lahore');
  v_khi smallint := (select id from public.cities where name = 'Karachi');
  r jsonb;
  w jsonb := '[]'::jsonb;
  k int := 0;
  p text;
  plan text[] := array['Sample Isb Maker One', 'Sample Isb Maker One', 'Sample Isb Maker One', 'Sample Isb Maker One', 'Sample Isb Maker One',
                       'Sample Isb Maker One', 'Sample Isb Maker One', 'Sample Isb Maker Two', 'Sample Isb Maker Two', 'Sample Isb Maker Two',
                       'Sample Isb Maker Three', 'Sample Isb Maker Four'];
begin
  perform pg_temp.check(not exists (select 1 from public.retainer_team), 'colours: no retainer team yet');
  foreach p in array plan loop
    k := k + 1;
    w := w || jsonb_build_array(pg_temp.retainer_wire(k + 1, 'Sample Isb Patient ' || k, to_char(date '2026-03-01' + k * 9, 'YYYY-MM-DD'), 'Sample Isb Checker', p, 'Delivered to patient'));
  end loop;
  r := public.import_retainer_records(v_isb, w);
  perform pg_temp.check((r->>'inserted')::int = 12 and r->'top_makers' = '["Sample Isb Maker One", "Sample Isb Maker Two"]'::jsonb
    and r->'team_featured' = '["Sample Isb Maker One", "Sample Isb Maker Two"]'::jsonb,
    'banner: the two makers with a fifth of the tab or more (7 and 3 of 12) are its most active and go in the banner; 1 of 12 is not enough (' || r::text || ')');
  perform pg_temp.check(r->'team_colours' = '[{"name": "Sample Isb Maker One", "colour": "navy", "top": true}, {"name": "Sample Isb Maker Two", "colour": "forest", "top": true},
                                               {"name": "Sample Isb Maker Four", "colour": "amber", "top": false}, {"name": "Sample Isb Maker Three", "colour": "rose", "top": false}]'::jsonb,
    'colours: the most active makers the strongest, different ones (navy, forest green), the others light ones (amber, rose) (' || (r->'team_colours')::text || ')');
  perform pg_temp.check((select colour from public.retainer_team where name = 'Sample Isb Checker') = 'purple' and not exists (select 1 from public.retainer_team where colour = 'grey')
    and (select count(*) from public.retainer_team where featured) = 2, 'colours: the model checker is deep purple, nobody is light grey, two people are in the banner');

  -- Lahore, with two members Dr. Ali set up before the copy: one with a colour he chose (lime, it stays), one still in light grey (it gets the
  -- strongest colour nobody has: navy and forest green are Islamabad's). A new maker with one row of eight gets a light colour nobody has.
  insert into public.retainer_team (name, role, colour, city_id) values ('Sample Lhr Chosen', 'maker', 'lime', v_lahore), ('Sample Lhr Grey', 'maker', 'grey', v_lahore);
  r := public.import_retainer_records(v_lahore, (select jsonb_agg(pg_temp.retainer_wire(1 + g, 'Sample Lhr Patient ' || g, null, null,
                                                  case when g <= 4 then 'Sample Lhr Chosen' when g <= 7 then 'Sample Lhr Grey' else 'Sample Lhr New' end)) from generate_series(1, 8) g));
  perform pg_temp.check(r->'top_makers' = '["Sample Lhr Chosen", "Sample Lhr Grey"]'::jsonb and r->'team_featured' = '["Sample Lhr Chosen", "Sample Lhr Grey"]'::jsonb
    and r->'team_colours' = '[{"name": "Sample Lhr Grey", "colour": "plum", "top": true}, {"name": "Sample Lhr New", "colour": "teal", "top": false}]'::jsonb
    and (select colour from public.retainer_team where name = 'Sample Lhr Chosen') = 'lime',
    'colours: a chosen colour stays; light grey is replaced by the strongest colour nobody has; a new maker gets a light colour nobody has (' || r::text || ')');

  -- Karachi, with somebody in the banner already (Dr. Ali's choice): the copy puts nobody else there, but its most active maker still gets a
  -- strong colour.
  insert into public.retainer_team (name, role, colour, city_id, featured) values ('Sample Khi Picked', 'maker', 'brown', v_khi, true);
  r := public.import_retainer_records(v_khi, (select jsonb_agg(pg_temp.retainer_wire(1 + g, 'Sample Khi Patient ' || g, null, null,
                                               case when g <= 3 then 'Sample Khi Top' else 'Sample Khi Picked' end)) from generate_series(1, 4) g));
  perform pg_temp.check(r->'team_featured' = '[]'::jsonb and not (select featured from public.retainer_team where name = 'Sample Khi Top')
    and r->'team_colours' = '[{"name": "Sample Khi Top", "colour": "ocean", "top": true}]'::jsonb,
    'banner: with somebody of the city in it already, a copy changes nobody; its top maker still gets a strong colour (' || r::text || ')');
  perform pg_temp.check((select count(*) from private.retainer_top_makers(v_isb)) = 2 and (select count(*) from private.retainer_top_makers(v_khi)) = 2,
    'the most active makers: the same people when asked again');
end $$;
rollback;
