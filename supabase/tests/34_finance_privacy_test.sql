-- Finance privacy (20261015000400_finance_privacy.sql): the clinic's money is for Dr. Ali and accounts. Made-up people only.
-- The grid is set as the clinic has it live (15 Oct 2026): "View invoices and payments", "Create invoices and take payments" and
-- "Give discounts" off for the front desk, "View invoices and payments" off for the coordinator.
--   0. the file runs again (earlier test files run older migrations again, which put back the old payments_summary, total_dues and
--      doctor_summary), and a second run leaves a choice made in the access list alone;
--   1. the permission "Today's payments, one by one (no totals)" and its defaults;
--   2. payments_today: the front desk gets today's payments of its own branch one by one (name, Mr#, amount, method, branch, who
--      took it), never another day or branch and never a total; the assistant, doctor and coordinator are refused; a choice for
--      one person in the access list (unticked for a desk, ticked for an assistant) is followed;
--   3. money totals (payments_summary, total_dues, clinic_report) refuse everyone but accounts and Dr. Ali; a patient's own login
--      still gets its own; the money tables and views give the others nothing;
--   4. doctor_summary: the counts for whoever may open it, the rupees only for accounts, Dr. Ali, or the doctor on their own
--      (not a shared doctors login with no doctor record of its own, not a coordinator with "See own doctor percentage");
--   5. the cash closing is a blind count for the front desk: no expected cash, no difference, no amounts in its list;
--   6. "Create invoices and take payments" without "View invoices and payments": one patient's own invoices and payments, a payment
--      can be taken, and still no list across patients;
--   7. dues_for: at most 500 patients a call for whoever does not see the totals;
--   8. grants.
\set ON_ERROR_STOP 1
\set admin  '''00000000-0000-0000-0000-000000003400'''
\set fd     '''00000000-0000-0000-0000-000000003401'''
\set fdall  '''00000000-0000-0000-0000-000000003402'''
\set asst   '''00000000-0000-0000-0000-000000003403'''
\set doc    '''00000000-0000-0000-0000-000000003404'''
\set coord  '''00000000-0000-0000-0000-000000003405'''
\set acct   '''00000000-0000-0000-0000-000000003406'''
\set portal '''00000000-0000-0000-0000-000000003407'''
\set taker  '''00000000-0000-0000-0000-000000003408'''
\set shared '''00000000-0000-0000-0000-000000003409'''
\set p1     '''00000000-0000-0000-0000-000000003411'''
\set p2     '''00000000-0000-0000-0000-000000003412'''
\set p3     '''00000000-0000-0000-0000-000000003413'''
\set p4     '''00000000-0000-0000-0000-000000003414'''
\set v1     '''00000000-0000-0000-0000-000000003421'''
\set v2     '''00000000-0000-0000-0000-000000003422'''

-- 0. Run the migration again first: 22_audit_fixes_test and 29_public_forms_test run older files again, which replace
-- payments_summary, total_dues and doctor_summary with the versions before this one. It says it is safe to run twice.
\ir ../migrations/20261015000400_finance_privacy.sql

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
  if st <> state or position(needle in m) = 0 then raise exception 'TEST FAILED: % (expected % "%", got % %)', msg, state, needle, st, m; end if;
  raise notice 'ok - % (blocked: % %)', msg, st, left(m, 60);
end $$;
create or replace function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, false) $$;
-- This file's patients (Mr# 34001-34004): other test files leave payments of today behind, so counts look at these only.
create or replace function pg_temp.mine(p_mr text) returns boolean language sql as $$ select p_mr between '34001' and '34004' $$;
grant execute on all functions in schema pg_temp to authenticated, anon;
reset role;
select pg_temp.act_as('');

begin;
select set_config('test.admin', :admin, false), set_config('test.fd', :fd, false), set_config('test.fdall', :fdall, false),
       set_config('test.asst', :asst, false), set_config('test.doc', :doc, false), set_config('test.coord', :coord, false),
       set_config('test.acct', :acct, false), set_config('test.portal', :portal, false), set_config('test.taker', :taker, false),
       set_config('test.shared', :shared, false),
       set_config('test.p1', :p1, false), set_config('test.p2', :p2, false), set_config('test.p3', :p3, false), set_config('test.p4', :p4, false),
       set_config('test.nn', (select id::text from public.branches where code = 'NN'), false),
       set_config('test.gul', (select id::text from public.branches where code = 'GUL'), false),
       set_config('test.dha', (select id::text from public.branches where code = 'DHA'), false),
       -- the start of today in Pakistan
       set_config('test.today0', (((now() at time zone 'Asia/Karachi')::date)::timestamp at time zone 'Asia/Karachi')::text, false);

-- 1. The permission, as the migration leaves it (before this file changes any of the grid).
do $$
begin
  perform pg_temp.check(exists (select 1 from public.permissions where key = 'payments.day_list' and label = 'Today''s payments, one by one (no totals)' and category = 'Billing'),
    'permission: "Today''s payments, one by one (no totals)" is in the access list under Billing');
  perform pg_temp.check((select string_agg(role::text || '=' || allowed, ',' order by role) from public.role_permissions where permission_key = 'payments.day_list')
    = 'front_desk=true,assistant=false,doctor=false,coordinator=false,accountant=true,admin=true',
    'permission: on for front desk, the accountant and admin; off for assistant, doctor and coordinator');
end $$;
-- A second run never overwrites a choice made in the access list (the migration has no transaction of its own, so it can run here).
update public.role_permissions set allowed = not allowed where permission_key = 'payments.day_list' and role in ('front_desk', 'assistant');
\ir ../migrations/20261015000400_finance_privacy.sql
select pg_temp.check((select string_agg(role::text || '=' || allowed, ',' order by role) from public.role_permissions
                       where permission_key = 'payments.day_list' and role in ('front_desk', 'assistant')) = 'front_desk=false,assistant=true',
  'permission: a second run leaves the access list''s choices alone (front desk unticked, assistant ticked stay so)');
update public.role_permissions set allowed = (role = 'front_desk') where permission_key = 'payments.day_list' and role in ('front_desk', 'assistant');
select pg_temp.check((select count(*) from public.permissions where key = 'payments.day_list') = 1
    and (select count(*) from public.role_permissions where permission_key = 'payments.day_list') = (select count(*) from unnest(enum_range(null::public.staff_role))),
  'permission: one row in the list and one per role after two runs');

-- The grid as the clinic has it live.
update public.role_permissions set allowed = false
 where (role::text, permission_key) in (('front_desk', 'billing.view'), ('front_desk', 'billing.create'), ('front_desk', 'discount.give'), ('coordinator', 'billing.view'));

insert into auth.users (id, email) values
  (:admin, 'admin34@dralirashid.com'), (:fd, 'fd34@dralirashid.com'), (:fdall, 'fdall34@dralirashid.com'), (:asst, 'asst34@dralirashid.com'),
  (:doc, 'doc34@dralirashid.com'), (:coord, 'coord34@dralirashid.com'), (:acct, 'acct34@dralirashid.com'), (:portal, 'portal34@example.com'),
  (:taker, 'taker34@dralirashid.com'), (:shared, 'doctors34@dralirashid.com');
insert into public.staff (id, full_name, email, role) values
  (:admin, 'Admin Thirtyfour', 'admin34@dralirashid.com', 'admin'),
  (:fd,    'Desk Thirtyfour', 'fd34@dralirashid.com', 'front_desk'),
  (:fdall, 'Desk Everywhere Thirtyfour', 'fdall34@dralirashid.com', 'front_desk'),
  (:asst,  'Assistant Thirtyfour', 'asst34@dralirashid.com', 'assistant'),
  (:doc,   'Dr. Sample Thirtyfour', 'doc34@dralirashid.com', 'doctor'),
  (:coord, 'Coordinator Thirtyfour', 'coord34@dralirashid.com', 'coordinator'),
  (:acct,  'Accountant Thirtyfour', 'acct34@dralirashid.com', 'accountant'),
  (:taker, 'Desk Who Takes Payments', 'taker34@dralirashid.com', 'front_desk'),
  (:shared, 'Doctors Login Thirtyfour', 'doctors34@dralirashid.com', 'doctor');
update public.staff set restrict_to_branches = true, branch_ids = array[current_setting('test.nn')::smallint] where id in (:fd, :taker);
-- Dr. Ali ticks "Create invoices and take payments" for one desk only (a personal choice in the access list).
insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (:taker, 'billing.create', true);
-- One doctors login for the clinic (no doctor record of its own: the doctor is picked per treatment), which may open every doctor's
-- log. It is a doctor, so "See own doctor percentage" is on for it.
insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (:shared, 'doctor_log.view_all', true);

insert into public.patients (id, mr_number, full_name, phone, first_branch_id, portal_user_id) values
  (:p1, '34001', 'Sample Payer One', '03005553401', current_setting('test.nn')::smallint, :portal),
  (:p2, '34002', 'Sample Payer Two', '03005553402', current_setting('test.nn')::smallint, null),
  (:p3, '34003', 'Sample Gulshan Payer', '03005553403', current_setting('test.gul')::smallint, null),
  (:p4, '34004', 'Sample DHA Payer', '03005553404', current_setting('test.dha')::smallint, null);
insert into public.clinicians (display_name, is_doctor, staff_id) values ('Dr. Sample Thirtyfour', true, :doc), ('Dr. Other Thirtyfour', true, null);

-- Money. Today at North Nazimabad: two payments and a refund; at Gulshan and DHA one each; yesterday at 23:59 one more at
-- North Nazimabad (not today's).
insert into public.payments (patient_id, branch_id, amount, method, received_at, received_by) values
  (:p1, current_setting('test.nn')::smallint,   3000, 'cash',          current_setting('test.today0')::timestamptz + interval '10 minutes', :acct),
  (:p2, current_setting('test.nn')::smallint,   1500, 'card',          current_setting('test.today0')::timestamptz + interval '20 minutes', :acct),
  (:p1, current_setting('test.nn')::smallint,   -500, 'cash',          current_setting('test.today0')::timestamptz + interval '30 minutes', :admin),
  (:p3, current_setting('test.gul')::smallint,  2000, 'cash',          current_setting('test.today0')::timestamptz + interval '15 minutes', :acct),
  (:p4, current_setting('test.dha')::smallint,  700,  'bank_transfer', current_setting('test.today0')::timestamptz + interval '5 minutes',  null),
  (:p2, current_setting('test.nn')::smallint,   9999, 'cash',          current_setting('test.today0')::timestamptz - interval '1 minute',   :acct);
insert into public.invoices (invoice_no, patient_id, branch_id, issue_date, subtotal, status) values
  ('T34-1', :p1, current_setting('test.nn')::smallint, '2026-09-20', 0, 'issued'),
  ('T34-2', :p2, current_setting('test.nn')::smallint, '2026-09-21', 2000, 'issued'),
  ('T34-3', :p3, current_setting('test.gul')::smallint, '2026-09-22', 4000, 'issued');
insert into public.invoice_items (invoice_id, description, quantity, unit_price)
select id, 'Sample braces kit', 1, 5000 from public.invoices where invoice_no = 'T34-1';
insert into public.discount_requests (invoice_id, requested_by, discount_amount, reason)
select id, :acct, 200, 'Sample request' from public.invoices where invoice_no = 'T34-2';
insert into public.payment_plans (id, patient_id, total_fee, starts_on) values ('00000000-0000-0000-0000-000000003431', :p1, 60000, '2026-09-01');
insert into public.plan_installments (plan_id, due_date, amount) values ('00000000-0000-0000-0000-000000003431', '2026-09-01', 20000), ('00000000-0000-0000-0000-000000003431', '2026-10-01', 20000);
insert into public.expenses (expense_date, branch_id, city_id, category_id, amount, paid_to)
values (current_date, current_setting('test.nn')::smallint, (select id from public.cities where name = 'Karachi'),
        (select id from public.expense_categories where name = 'Rent'), 1000, 'Sample landlord');

-- 2. Today's payments, one by one.
set role authenticated;
do $$
declare
  v_nn smallint := current_setting('test.nn')::smallint;
  who text;
begin
  perform pg_temp.act_as(current_setting('test.fd'));
  perform pg_temp.check((select string_agg(x.patient_name || ' ' || x.mr_number || ' ' || x.amount || ' ' || x.method || ' ' || coalesce(x.received_by_name, '-'), ' | '
                                           order by x.received_at desc)
                           from public.payments_today() x where pg_temp.mine(x.mr_number))
    = 'Sample Payer One 34001 -500.00 cash Admin Thirtyfour | Sample Payer Two 34002 1500.00 card Accountant Thirtyfour | Sample Payer One 34001 3000.00 cash Accountant Thirtyfour',
    'payments_today: the desk sees each of today''s payments at its branch, newest first, with the patient''s name and Mr#, the amount, the method and who took it (a refund too)');
  perform pg_temp.check((select bool_and(x.branch_id = v_nn) and bool_and((x.received_at at time zone 'Asia/Karachi')::date = (now() at time zone 'Asia/Karachi')::date)
                           from public.payments_today() x),
    'payments_today: only its own branch and only today (not Gulshan''s, not DHA''s, not yesterday''s 23:59 payment)');
  perform pg_temp.check(not exists (select 1 from public.payments_today() x where x.amount = 9999), 'payments_today: yesterday''s payment at 23:59 is not today''s');
  perform pg_temp.check((select count(*) from public.payments_today(v_nn) x where pg_temp.mine(x.mr_number)) = 3, 'payments_today: its own branch asked for by name gives the same three');
  perform pg_temp.expect_state(format('select * from public.payments_today(%s::smallint)', current_setting('test.gul')), '42501', 'only at the branches you work at',
    'payments_today: a desk of North Nazimabad cannot ask for Gulshan''s');
  perform pg_temp.check((select count(*) from public.payments) = 0 and (select count(*) from public.invoices) = 0,
    'the desk still reads no payment or invoice directly (no "View invoices and payments")');

  perform pg_temp.act_as(current_setting('test.fdall'));
  perform pg_temp.check((select string_agg(x.mr_number || '@' || b.code, ',' order by x.received_at desc) from public.payments_today() x join public.branches b on b.id = x.branch_id
                          where pg_temp.mine(x.mr_number)) = '34001@NN,34002@NN,34003@GUL,34001@NN,34004@DHA',
    'payments_today: a desk that works at every branch sees every branch''s payments of today');
  perform pg_temp.check((select count(*) from public.payments_today() x where x.received_by_name is null and x.mr_number = '34004') = 1,
    'payments_today: a payment with nobody recorded as taking it (an import) still shows, without a name');

  foreach who in array array['asst', 'doc', 'coord', 'portal'] loop
    perform pg_temp.act_as(current_setting('test.' || who));
    perform pg_temp.expect_state('select * from public.payments_today()', '42501', 'NOT_ALLOWED: today''s payments need',
      'payments_today: refused for the ' || case who when 'asst' then 'assistant' when 'doc' then 'doctor' when 'coord' then 'coordinator' else 'patient''s own login' end);
  end loop;
  perform pg_temp.act_as('');
  perform pg_temp.expect_state('select * from public.payments_today()', '42501', 'NOT_ALLOWED', 'payments_today: refused with nobody signed in');
  perform pg_temp.act_as(current_setting('test.acct'));
  perform pg_temp.check((select count(*) from public.payments_today() x where pg_temp.mine(x.mr_number)) = 5, 'payments_today: the accountant sees them (on by default)');
  perform pg_temp.act_as(current_setting('test.admin'));
  perform pg_temp.check((select count(*) from public.payments_today() x where pg_temp.mine(x.mr_number)) = 5, 'payments_today: Dr. Ali sees them');
end $$;
reset role;
select pg_temp.act_as('');
-- A choice for one person in the access list: unticked for this desk, ticked for the assistant.
insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (:fd, 'payments.day_list', false), (:asst, 'payments.day_list', true);
set role authenticated;
do $$
begin
  perform pg_temp.act_as(current_setting('test.fd'));
  perform pg_temp.expect_state('select * from public.payments_today()', '42501', 'NOT_ALLOWED: today''s payments need',
    'payments_today: refused for a desk it is unticked for (a choice for that person in the access list)');
  perform pg_temp.act_as(current_setting('test.asst'));
  perform pg_temp.check((select count(*) from public.payments_today() x where pg_temp.mine(x.mr_number)) = 5,
    'payments_today: an assistant it is ticked for gets the payments one by one');
  perform pg_temp.expect_state('select public.payments_summary(null, null)', '42501', 'NOT_ALLOWED: money totals', 'payments_today ticked: still no totals');
end $$;
reset role;
select pg_temp.act_as('');
delete from public.staff_permission_overrides where staff_id in (:fd, :asst);

do $$
begin
  perform pg_temp.check((select p.proretset and pg_get_function_result(p.oid)
                              = 'TABLE(id uuid, received_at timestamp with time zone, patient_id uuid, patient_name text, mr_number text, amount numeric, method text, branch_id smallint, received_by_name text)'
                           from pg_proc p where p.oid = 'public.payments_today(smallint)'::regprocedure),
    'payments_today: a list of single payments (no total, no sum, no count among its columns)');
end $$;

-- 3. Money totals: accounts and Dr. Ali only.
set role authenticated;
do $$
declare who text;
begin
  foreach who in array array['fd', 'asst', 'doc', 'coord'] loop
    perform pg_temp.act_as(current_setting('test.' || who));
    perform pg_temp.expect_state('select public.payments_summary(null, null)', '42501', 'NOT_ALLOWED: money totals are for Dr. Ali and accounts',
      'payments_summary: refused for the ' || who);
    perform pg_temp.expect_state('select public.total_dues()', '42501', 'NOT_ALLOWED: money totals', 'total_dues: refused for the ' || who);
    perform pg_temp.expect_state('select public.clinic_report(''pnl_trend'', current_date - 30, current_date)', '42501', 'Only accounts and Dr. Ali',
      'clinic_report (income): refused for the ' || who);
    perform pg_temp.expect_state('select public.clinic_report(''dues_by_branch'', current_date - 30, current_date)', '42501', 'Only accounts and Dr. Ali',
      'clinic_report (pending dues by branch): refused for the ' || who);
    -- the money tables and the views that add them up give them nothing
    perform pg_temp.check((select count(*) from public.payments) = 0 and (select count(*) from public.invoices) = 0 and (select count(*) from public.invoice_items) = 0
        and (select count(*) from public.expenses) = 0 and (select count(*) from public.cash_closings) = 0 and (select count(*) from public.discount_requests) = 0
        and (select count(*) from public.payment_plans) = 0 and (select count(*) from public.plan_installments) = 0,
      'tables: payments, invoices, invoice items, expenses, cash closings, discount requests and payment plans are empty for the ' || who);
    perform pg_temp.check((select count(*) from public.branch_daily_income) = 0 and (select count(*) from public.branch_monthly_pnl) = 0
        and (select count(*) from public.installment_status) = 0
        and (select coalesce(sum(abs(billed)) + sum(abs(paid)), 0) from public.patient_balances) = 0,
      'views: branch income, branch income vs expenses, installments and balances add up nothing for the ' || who);
  end loop;

  perform pg_temp.act_as(current_setting('test.acct'));
  perform pg_temp.check((public.payments_summary(current_date - 1, current_date + 1, current_setting('test.nn')::bigint, null)->'totals'->>'count')::int >= 3
      and public.total_dues() >= 4500 and jsonb_typeof(public.clinic_report('pnl_trend', current_date - 30, current_date)) = 'array',
    'the accountant gets the totals, the pending dues and the reports');
  perform pg_temp.check((select count(*) from public.branch_daily_income) > 0 and (select count(*) from public.expenses) >= 1,
    'the accountant reads the income per branch and the expenses');
  perform pg_temp.act_as(current_setting('test.admin'));
  perform pg_temp.check((public.payments_summary(null, null)->'totals'->>'count')::int >= 6 and public.total_dues() >= 4500, 'Dr. Ali gets the totals');
  -- A patient's own login is not staff: it still adds up only its own rows (the portal never asks, but it was so before).
  perform pg_temp.act_as(current_setting('test.portal'));
  perform pg_temp.check(public.payments_summary(null, null)->'totals' = '{"received": 3000, "cash": 3000, "card": 0, "bank": 0, "refunds": 500, "net": 2500, "count": 2}'::jsonb
      and public.total_dues() = 2500,
    'a patient''s own login totals only its own two payments and its own dues (5,000 billed, 2,500 paid)');
end $$;
reset role;
select pg_temp.act_as('');
select pg_temp.check((select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('payments_summary', 'total_dues') and not prosecdef) = 2,
  'payments_summary and total_dues stay SECURITY INVOKER: row-level security still decides which rows an allowed person adds up');

-- 4. The doctor dashboard (May 2001 holds only this file's visits).
insert into public.visits (id, patient_id, branch_id, visit_date, status, treatment_label, photos_uploaded, completed_at) values
  (:v1, :p1, current_setting('test.nn')::smallint, '2001-05-02', 'completed', 'Scaling', true, '2001-05-02 18:00+05'),
  (:v2, :p2, current_setting('test.nn')::smallint, '2001-05-03', 'completed', 'Filling', true, '2001-05-03 18:00+05');
insert into public.visit_staff (visit_id, clinician_id, role)
select v, (select id from public.clinicians where display_name = 'Dr. Sample Thirtyfour'), 'doctor' from unnest(array[:v1, :v2]::uuid[]) v;
insert into public.invoices (invoice_no, patient_id, branch_id, visit_id, issue_date, subtotal, status) values ('T34-V2', :p2, current_setting('test.nn')::smallint, :v2, '2001-05-03', 2000, 'issued');
update public.patients set referred_by_clinician = (select id from public.clinicians where display_name = 'Dr. Sample Thirtyfour') where id = :p3;
insert into public.payments (patient_id, branch_id, amount, method, received_at) values (:p3, current_setting('test.gul')::smallint, 3000, 'cash', '2001-05-04 12:00+05');
insert into public.complaints (patient_id, branch_id, clinician_id, subject, body, created_at)
values (:p2, current_setting('test.nn')::smallint, (select id from public.clinicians where display_name = 'Dr. Sample Thirtyfour'), 'Sample complaint 34', 'Made up.', '2001-05-05 10:00+05');
update public.doctor_commission_rules set active = false;
insert into public.doctor_commission_rules (clinician_id, basis, percent, notes) values (null, 'referred', 40, 'Sample rule');
select set_config('test.c1', (select id::text from public.clinicians where display_name = 'Dr. Sample Thirtyfour'), false),
       set_config('test.c2', (select id::text from public.clinicians where display_name = 'Dr. Other Thirtyfour'), false);

set role authenticated;
do $$
declare s jsonb;
begin
  -- The doctor on their own dashboard, with "See own doctor percentage" (on for doctors by default): everything.
  perform pg_temp.act_as(current_setting('test.doc'));
  s := public.doctor_summary(current_setting('test.c1')::uuid, '2001-05-01', '2001-05-31');
  perform pg_temp.check((s->>'treated')::int = 2 and (s->>'billed')::numeric = 2000 and (s->>'referred_paid')::numeric = 3000 and (s->>'share')::numeric = 1200
      and s->'rule'->>'basis' = 'referred' and jsonb_array_length(s->'complaints') = 1,
    'doctor_summary: the doctor''s own, with "See own doctor percentage": the counts, billed 2,000, own patients paid 3,000, share 1,200');
  perform pg_temp.expect_state(format('select public.doctor_summary(%L, %L, %L)', current_setting('test.c2'), '2001-05-01', '2001-05-31'), '42501', 'own summary',
    'doctor_summary: still not another doctor''s');
  -- The coordinator ("See every doctor's daily log", no finance): the counts and complaints, no rupees.
  perform pg_temp.act_as(current_setting('test.coord'));
  s := public.doctor_summary(current_setting('test.c1')::uuid, '2001-05-01', '2001-05-31');
  perform pg_temp.check((s->>'treated')::int = 2 and (s->>'days')::int = 2 and (s->>'referred_patients')::int = 1 and jsonb_array_length(s->'complaints') = 1,
    'doctor_summary: the coordinator gets the treatments, days, own-patient count and complaints');
  perform pg_temp.check(s->'billed' = 'null'::jsonb and s->'referred_paid' = 'null'::jsonb and s->'share' = 'null'::jsonb and s->'rule' = 'null'::jsonb,
    'doctor_summary: the coordinator gets no amount billed, paid or earned and no percentage');
  -- The shared doctors login (a doctor, so "See own doctor percentage" is on; "See every doctor's daily log" ticked for it; no doctor
  -- record of its own): the counts for every doctor, never the rupees.
  perform pg_temp.act_as(current_setting('test.shared'));
  s := public.doctor_summary(current_setting('test.c1')::uuid, '2001-05-01', '2001-05-31');
  perform pg_temp.check((s->>'treated')::int = 2 and jsonb_array_length(s->'complaints') = 1,
    'doctor_summary: the shared doctors login gets the treatments and complaints');
  perform pg_temp.check(s->'billed' = 'null'::jsonb and s->'referred_paid' = 'null'::jsonb and s->'share' = 'null'::jsonb and s->'rule' = 'null'::jsonb,
    'doctor_summary: the shared doctors login (no doctor record of its own) gets no amount billed, paid or earned and no percentage');
  s := public.doctor_summary(current_setting('test.c2')::uuid, '2001-05-01', '2001-05-31');
  perform pg_temp.check(s->'billed' = 'null'::jsonb and s->'referred_paid' = 'null'::jsonb and s->'share' = 'null'::jsonb and s->'rule' = 'null'::jsonb,
    'doctor_summary: nor for any other doctor');
  -- The accountant (finance.view) and Dr. Ali: everything, for any doctor.
  perform pg_temp.act_as(current_setting('test.acct'));
  perform pg_temp.check((public.doctor_summary(current_setting('test.c1')::uuid, '2001-05-01', '2001-05-31')->>'share')::numeric = 1200, 'doctor_summary: the accountant sees the share');
  perform pg_temp.act_as(current_setting('test.admin'));
  perform pg_temp.check((public.doctor_summary(current_setting('test.c1')::uuid, '2001-05-01', '2001-05-31')->>'billed')::numeric = 2000, 'doctor_summary: Dr. Ali sees the money');
  perform pg_temp.act_as(current_setting('test.asst'));
  perform pg_temp.expect_state(format('select public.doctor_summary(%L, %L, %L)', current_setting('test.c1'), '2001-05-01', '2001-05-31'), '42501', 'own summary',
    'doctor_summary: the assistant cannot open a doctor''s dashboard');
end $$;
reset role;
select pg_temp.act_as('');
-- "See own doctor percentage" switched off for this doctor: their own dashboard without the money.
insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (:doc, 'commission.view_own', false);
set role authenticated;
do $$
declare s jsonb;
begin
  perform pg_temp.act_as(current_setting('test.doc'));
  s := public.doctor_summary(current_setting('test.c1')::uuid, '2001-05-01', '2001-05-31');
  perform pg_temp.check((s->>'treated')::int = 2 and s->'billed' = 'null'::jsonb and s->'share' = 'null'::jsonb and s->'rule' = 'null'::jsonb,
    'doctor_summary: without "See own doctor percentage" the doctor''s own dashboard has the counts and no money');
end $$;
reset role;
select pg_temp.act_as('');
delete from public.staff_permission_overrides where staff_id = :doc;
-- "See own doctor percentage" ticked for the coordinator, who has no doctor record: still no rupees for any doctor.
insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (:coord, 'commission.view_own', true);
set role authenticated;
do $$
declare s jsonb;
begin
  perform pg_temp.act_as(current_setting('test.coord'));
  s := public.doctor_summary(current_setting('test.c1')::uuid, '2001-05-01', '2001-05-31');
  perform pg_temp.check((s->>'treated')::int = 2 and s->'billed' = 'null'::jsonb and s->'referred_paid' = 'null'::jsonb and s->'share' = 'null'::jsonb and s->'rule' = 'null'::jsonb,
    'doctor_summary: a coordinator with "See own doctor percentage" ticked (no doctor record of their own) still gets no money');
end $$;
reset role;
select pg_temp.act_as('');
delete from public.staff_permission_overrides where staff_id = :coord;

-- 5. The cash closing. On 10 Apr 2001 (no other test uses it) North Nazimabad took 4,000 in cash and 1,000 by card.
insert into public.payments (patient_id, branch_id, amount, method, received_at) values
  (:p2, current_setting('test.nn')::smallint, 4000, 'cash', '2001-04-10 12:00+05'), (:p2, current_setting('test.nn')::smallint, 1000, 'card', '2001-04-10 13:00+05');
set role authenticated;
do $$
declare
  c public.cash_closings;
  v_nn smallint := current_setting('test.nn')::smallint;
  who text;
begin
  perform pg_temp.act_as(current_setting('test.fd'));
  c := public.close_cash(v_nn, '2001-04-10', 3900, 'Counted twice');
  perform pg_temp.check(c.id is not null and c.branch_id = v_nn and c.counted_cash = 3900 and c.expected_cash is null and c.difference is null,
    'close_cash: the desk''s count is saved and it is told neither the expected cash nor the difference (a blind count)');
  perform pg_temp.check((select count(*) from public.cash_closings) = 0, 'cash_closings: the desk no longer reads the table (expected cash and difference) at all');
  perform pg_temp.check((select string_agg(x.closing_date || ' ' || x.closed_by_name || ' ' || x.checked, ',') from public.cash_closings_blind() x where x.closing_date = '2001-04-10')
      = '2001-04-10 Desk Thirtyfour false',
    'cash_closings_blind: the desk sees that the day is closed, by whom, and not yet checked by accounts');
  perform pg_temp.check((select bool_and(x.branch_id = v_nn) from public.cash_closings_blind() x), 'cash_closings_blind: only its own branch''s closings');
  perform pg_temp.expect_state(format('select public.close_cash(%s::smallint, %L, 0)', current_setting('test.gul'), '2001-04-10'), 'P0001', 'not allowed',
    'close_cash: still not at another branch');
  -- Accounts see the amounts and check it.
  perform pg_temp.act_as(current_setting('test.acct'));
  perform pg_temp.check((select expected_cash = 4000 and counted_cash = 3900 and difference = -100 from public.cash_closings where branch_id = v_nn and closing_date = '2001-04-10'),
    'cash_closings: the accountant sees expected 4,000 (cash only), counted 3,900 and the difference -100');
  update public.cash_closings set verified_by = auth.uid(), verified_at = now() where branch_id = v_nn and closing_date = '2001-04-10';
  perform pg_temp.act_as(current_setting('test.fd'));
  perform pg_temp.check((select x.checked from public.cash_closings_blind() x where x.closing_date = '2001-04-10'), 'cash_closings_blind: after accounts check it, the desk sees "checked"');
  -- Dr. Ali closing a branch is told the expected cash and the difference, as before.
  perform pg_temp.act_as(current_setting('test.admin'));
  c := public.close_cash(current_setting('test.gul')::smallint, '2001-04-10', 50);
  perform pg_temp.check(c.expected_cash = 0 and c.difference = 50, 'close_cash: Dr. Ali is told the expected cash and the difference');
  foreach who in array array['asst', 'doc', 'coord'] loop
    perform pg_temp.act_as(current_setting('test.' || who));
    perform pg_temp.expect_state('select * from public.cash_closings_blind()', '42501', 'NOT_ALLOWED: the cash closings need',
      'cash_closings_blind: refused for the ' || case who when 'asst' then 'assistant' when 'doc' then 'doctor' else 'coordinator' end);
  end loop;
end $$;
reset role;
select pg_temp.act_as('');
-- A desk with "View invoices and payments" ticked for them is told the amounts, as accounts are.
insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (:fdall, 'billing.view', true);
set role authenticated;
do $$
declare c public.cash_closings;
begin
  perform pg_temp.act_as(current_setting('test.fdall'));
  c := public.close_cash(current_setting('test.dha')::smallint, '2001-04-10', 0);
  perform pg_temp.check(c.expected_cash = 0 and c.difference = 0, 'close_cash: a desk with "View invoices and payments" is told the expected cash and the difference');
  perform pg_temp.check((select count(*) from public.cash_closings where closing_date = '2001-04-10') = 3, 'cash_closings: and reads the closings with their amounts');
end $$;
reset role;
select pg_temp.act_as('');
delete from public.staff_permission_overrides where staff_id = :fdall;
do $$
begin
  perform pg_temp.check((select pg_get_function_result(p.oid) from pg_proc p where p.oid = 'public.cash_closings_blind(integer)'::regprocedure)
      = 'TABLE(id uuid, branch_id smallint, closing_date date, closed_at timestamp with time zone, closed_by_name text, checked boolean)',
    'cash_closings_blind: no amount and no note among its columns');
end $$;

-- 6. A desk with "Create invoices and take payments" but not "View invoices and payments" (the taker, at North Nazimabad).
set role authenticated;
do $$
declare b jsonb;
begin
  perform pg_temp.act_as(current_setting('test.taker'));
  b := public.patient_billing(current_setting('test.p1')::uuid);
  perform pg_temp.check(jsonb_array_length(b->'invoices') = 1 and b->'invoices'->0->>'invoice_no' = 'T34-1' and (b->'invoices'->0->>'total')::numeric = 5000
      and b->'invoices'->0->'items'->0->>'description' = 'Sample braces kit',
    'patient_billing: the desk that takes payments sees that patient''s own invoice, with its lines');
  perform pg_temp.check((select string_agg((x->>'amount')::numeric::int::text, ',' order by x->>'received_at') from jsonb_array_elements(b->'payments') x) = '3000,-500',
    'patient_billing: and that patient''s own payments');
  b := public.patient_billing(current_setting('test.p3')::uuid);
  perform pg_temp.check(b = '{"invoices": [], "payments": []}'::jsonb, 'patient_billing: nothing from a branch the desk does not work at');
  -- Taking a payment: the row goes in (it is not asked back: reading it back needs "View invoices and payments").
  insert into public.payments (patient_id, branch_id, amount, method) values (current_setting('test.p2')::uuid, current_setting('test.nn')::smallint, 500, 'cash');
  perform pg_temp.check((select count(*) from jsonb_array_elements(public.patient_billing(current_setting('test.p2')::uuid)->'payments') x
                          where (x->>'amount')::numeric = 500) = 1,
    'taking a payment works: the desk''s payment is saved and shows in that patient''s payments');
  perform pg_temp.check((select x.received_by_name from public.payments_today() x where x.mr_number = '34002' and x.amount = 500) = 'Desk Who Takes Payments',
    'and in today''s payments, with who took it');
  perform pg_temp.expect_state(format('insert into public.payments (patient_id, branch_id, amount, method) values (%L, %s, 100, %L) returning id',
                                      current_setting('test.p2'), current_setting('test.nn'), 'cash'), '42501', 'row-level security',
    'a payment cannot be asked back (returning) without "View invoices and payments": the website sends it without asking');
  perform pg_temp.check((select count(*) from public.payments) = 0 and (select count(*) from public.invoices) = 0,
    'the desk that takes payments still reads no list of payments or invoices');
  -- Not done by this file: a new invoice is read back by save_invoice (it runs as the person), which needs billing.view too.
  perform pg_temp.expect_state(format('select public.save_invoice(null, %L::jsonb, %L::jsonb)',
      jsonb_build_object('patient_id', current_setting('test.p2'), 'branch_id', current_setting('test.nn')::int, 'visit_id', null, 'discount_amount', 0, 'discount_reason', null),
      '[{"description": "Sample", "quantity": 1, "unit_price": 1000}]'), '42501', 'row-level security',
    'still to do before the front desk makes invoices: save_invoice needs "View invoices and payments" to read back the invoice it made');
  perform pg_temp.expect_state('select public.payments_summary(null, null)', '42501', 'NOT_ALLOWED: money totals', 'and still no totals');
  perform pg_temp.act_as(current_setting('test.fd'));
  perform pg_temp.expect_state(format('select public.patient_billing(%L)', current_setting('test.p1')), '42501', 'NOT_ALLOWED: a patient''s invoices need',
    'patient_billing: refused for a desk that may not take payments');
  perform pg_temp.act_as(current_setting('test.asst'));
  perform pg_temp.expect_state(format('select public.patient_billing(%L)', current_setting('test.p1')), '42501', 'NOT_ALLOWED', 'patient_billing: refused for the assistant');
  perform pg_temp.act_as(current_setting('test.acct'));
  perform pg_temp.check(jsonb_array_length(public.patient_billing(current_setting('test.p1')::uuid)->'invoices') = 1, 'patient_billing: the accountant gets it too');
end $$;
reset role;
select pg_temp.act_as('');

-- 7. dues_for (each patient's dues, for the pending dues flag): at most 500 patients a call for whoever does not see the totals, so the
-- clinic's pending dues cannot be added up from one request.
set role authenticated;
do $$
declare
  ids uuid[] := array(select gen_random_uuid() from generate_series(1, 501));
  who text;
begin
  foreach who in array array['asst', 'fd', 'coord'] loop
    perform pg_temp.act_as(current_setting('test.' || who));
    perform pg_temp.expect_state(format('select * from public.dues_for(%L::uuid[])', ids), '42501', 'at most 500 patients',
      'dues_for: 501 patients in one call refused for the ' || who);
  end loop;
  perform pg_temp.act_as(current_setting('test.asst'));
  perform pg_temp.check((select d.dues from public.dues_for(ids[1:499] || array[current_setting('test.p1')::uuid]) d) = 2500,
    'dues_for: 500 in one call still answer the assistant (a patient''s own dues for the pending dues flag)');
  perform pg_temp.act_as(current_setting('test.acct'));
  perform pg_temp.check((select count(*) from public.dues_for(ids || array[current_setting('test.p1')::uuid])) = 1, 'dues_for: the accountant may ask for any number');
end $$;
reset role;
select pg_temp.act_as('');

-- 8. Grants
do $$
declare f text;
begin
  foreach f in array array['public.payments_today(smallint)', 'public.cash_closings_blind(integer)', 'public.patient_billing(uuid)',
                           'public.payments_summary(date, date, bigint, text)', 'public.total_dues()', 'public.doctor_summary(uuid, date, date)',
                           'public.close_cash(smallint, date, numeric, text)', 'public.dues_for(uuid[])'] loop
    perform pg_temp.check(not has_function_privilege('anon', f, 'execute') and has_function_privilege('authenticated', f, 'execute'),
      'grants: ' || f || ' is for signed-in users only');
  end loop;
  perform pg_temp.check((select bool_and(prosecdef and proconfig is not null) from pg_proc
                          where oid in ('public.payments_today(smallint)'::regprocedure, 'public.cash_closings_blind(integer)'::regprocedure,
                                        'public.patient_billing(uuid)'::regprocedure, 'public.close_cash(smallint, date, numeric, text)'::regprocedure)),
    'the new functions run as their owner with a fixed search_path, and check the permission themselves');
end $$;
rollback;
