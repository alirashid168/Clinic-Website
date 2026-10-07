-- Installment plans, the drop-off setting and the reports function.
\set ON_ERROR_STOP 1
\set admin  '''00000000-0000-0000-0000-0000000000a7'''
\set coord  '''00000000-0000-0000-0000-0000000000d7'''
\set doctor '''00000000-0000-0000-0000-0000000000b7'''
\set pat    '''00000000-0000-0000-0000-0000000000e7'''

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
grant execute on all functions in schema pg_temp to authenticated, anon;

begin;
insert into auth.users (id, email) values (:admin, 'ali7@dralirashid.com'), (:coord, 'coord7@dralirashid.com'), (:doctor, 'doc7@dralirashid.com');
insert into public.staff (id, full_name, email, role) values
  (:admin, 'Dr. Ali Rashid', 'ali7@dralirashid.com', 'admin'),
  (:coord, 'Coordinator', 'coord7@dralirashid.com', 'coordinator'),
  (:doctor, 'Dr. Test', 'doc7@dralirashid.com', 'doctor');
insert into public.patients (id, mr_number, full_name, phone, first_branch_id) values (:pat, '77001', 'Plan Patient', '03001112233', 1);

-- ---------------------------------------------------------------- installment plan
select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
insert into public.payment_plans (id, patient_id, total_fee, starts_on, notes)
values ('00000000-0000-0000-0000-0000000000f7', :pat, 30000, current_date - 70, '70k kit');
insert into public.plan_installments (plan_id, due_date, amount, note) values
  ('00000000-0000-0000-0000-0000000000f7', current_date - 60, 10000, '1 of 3'),
  ('00000000-0000-0000-0000-0000000000f7', current_date - 30, 10000, '2 of 3'),
  ('00000000-0000-0000-0000-0000000000f7', current_date + 3,  10000, '3 of 3');
-- Rs 12,000 paid since the plan started: first installment paid, second overdue, third due soon.
insert into public.payments (patient_id, branch_id, amount, method, received_at) values (:pat, 1, 12000, 'cash', (current_date - 50)::timestamp at time zone 'Asia/Karachi');
-- A payment from before the plan does not count.
insert into public.payments (patient_id, branch_id, amount, method, received_at) values (:pat, 1, 50000, 'cash', (current_date - 100)::timestamp at time zone 'Asia/Karachi');
select pg_temp.check((select string_agg(status, ',' order by due_date) from public.installment_status where patient_id = :pat) = 'paid,overdue,due_soon',
  'installments are paid / overdue / due soon from payments since the start date, in order');
select pg_temp.check((select remaining from public.installment_status where patient_id = :pat and note = '2 of 3') = 8000,
  'the overdue installment shows Rs 8,000 still to pay');
reset role; select set_config('request.jwt.claim.sub', '', false);

-- The coordinator (billing.view) sees the list; a doctor does not.
select set_config('request.jwt.claim.sub', :coord, false);
set role authenticated;
select pg_temp.check((select count(*) from public.installment_status where status = 'overdue' and patient_id = :pat) = 1, 'coordinator sees the overdue installment');
reset role; select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.sub', :doctor, false);
set role authenticated;
select pg_temp.check((select count(*) from public.installment_status where patient_id = :pat) = 0, 'a doctor sees no installment plans (no billing.view)');
reset role; select set_config('request.jwt.claim.sub', '', false);

-- ---------------------------------------------------------------- drop-off days setting
insert into public.braces_cases (patient_id, start_date, created_by) values (:pat, current_date - 200, :admin);
insert into public.visits (patient_id, branch_id, visit_date, status, braces_case_id, braces_month, photos_uploaded, completed_at)
select :pat, 1, current_date - 30, 'completed', id, 1, true, now() from public.braces_cases where patient_id = :pat;
select set_config('request.jwt.claim.sub', :coord, false);
set role authenticated;
select pg_temp.check((select count(*) from public.braces_dropoffs where patient_id = :pat) = 0, 'seen 30 days ago: not a drop-off at the default 42 days');
reset role; select set_config('request.jwt.claim.sub', '', false);
update public.app_settings set value = '21' where key = 'dropoff_days';
select set_config('request.jwt.claim.sub', :coord, false);
set role authenticated;
select pg_temp.check((select count(*) from public.braces_dropoffs where patient_id = :pat) = 1, 'with the setting at 21 days the same patient is a drop-off');
reset role; select set_config('request.jwt.claim.sub', '', false);

-- ---------------------------------------------------------------- reports
select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
do $$
declare k text; r jsonb;
begin
  foreach k in array array['pnl_trend', 'payment_methods', 'referrals', 'braces', 'dues_by_branch', 'top_dues', 'photo_compliance', 'lab_costs', 'doctors', 'treatments', 'visits'] loop
    r := public.clinic_report(k, current_date - 400, current_date + 30);
    if jsonb_typeof(r) <> 'array' then raise exception 'TEST FAILED: report % did not return an array: %', k, r; end if;
  end loop;
  raise notice 'ok - every report kind runs and returns rows';
  r := public.clinic_report('pnl_trend', current_date - 400, current_date + 30);
  if (select sum((x->>'income')::numeric) from jsonb_array_elements(r) x) < 62000 then raise exception 'TEST FAILED: pnl_trend income missing: %', r; end if;
  raise notice 'ok - pnl_trend counts the payments';
  r := public.clinic_report('visits', current_date - 400, current_date + 30);
  if (select sum((x->>'new_patients')::int) from jsonb_array_elements(r) x) < 1 then raise exception 'TEST FAILED: visits report new patients: %', r; end if;
  raise notice 'ok - visits report counts the new patient';
end $$;
reset role; select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.sub', :doctor, false);
set role authenticated;
select pg_temp.expect_error($$select public.clinic_report('pnl_trend', current_date - 30, current_date)$$, 'Only accounts', 'a doctor cannot run finance reports');
reset role; select set_config('request.jwt.claim.sub', '', false);
rollback;

-- ---------------------------------------------------------------- stock moves keep the stock row
begin;
insert into auth.users (id, email) values (:admin, 'ali7@dralirashid.com');
insert into public.staff (id, full_name, email, role) values (:admin, 'Dr. Ali Rashid', 'ali7@dralirashid.com', 'admin');
select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
insert into public.inventory_items (name, category, unit) values ('Test wire', 'wires', 'pcs');
insert into public.inventory_moves (branch_id, item_id, change, reason) select 1, id, 10, 'received' from public.inventory_items where name = 'Test wire';
insert into public.inventory_moves (branch_id, item_id, change, reason) select 1, id, -3, 'used' from public.inventory_items where name = 'Test wire';
select pg_temp.check((select quantity from public.inventory_stock s join public.inventory_items i on i.id = s.item_id where i.name = 'Test wire' and s.branch_id = 1) = 7,
  'stock = received 10 - used 3 = 7, kept by the move trigger');
select pg_temp.check((select created_by from public.inventory_moves m join public.inventory_items i on i.id = m.item_id where i.name = 'Test wire' limit 1) = :admin::uuid,
  'the move records who made it');
reset role; select set_config('request.jwt.claim.sub', '', false);
rollback;
