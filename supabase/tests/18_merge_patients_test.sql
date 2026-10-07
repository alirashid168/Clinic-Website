-- Duplicate patients: finding them by phone and merging two records into one.
\set ON_ERROR_STOP 1
\set admin  '''00000000-0000-0000-0000-0000000000a8'''
\set fd     '''00000000-0000-0000-0000-0000000000f8'''
\set keep   '''00000000-0000-0000-0000-0000000000e8'''
\set dupe   '''00000000-0000-0000-0000-0000000000e9'''

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
insert into auth.users (id, email) values (:admin, 'ali8@dralirashid.com'), (:fd, 'fd8@dralirashid.com');
insert into public.staff (id, full_name, email, role) values (:admin, 'Dr. Ali Rashid', 'ali8@dralirashid.com', 'admin'), (:fd, 'Front desk', 'fd8@dralirashid.com', 'front_desk');
insert into public.patients (id, mr_number, full_name, phone, first_branch_id, created_at) values
  (:keep, '88001', 'Sana Ahmed', '03009998877', 1, '2022-01-01'),
  (:dupe, '88002', 'Sana Ahmad', '03009998877', 2, '2024-01-01');
update public.patients set email = 'sana@example.com', gender = 'female' where id = :dupe;
-- Kept record: two visits, one invoice of 10,000 and a 4,000 payment. Duplicate: a visit on a shared day, one on its own day, an invoice of 6,000 and a 6,000 payment.
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, legacy_source, completed_at) values
  (:keep, 1, '2024-03-01', 'completed', 'Checkup', 'healthwire', now()), (:keep, 1, '2024-04-01', 'completed', 'Scaling', 'healthwire', now()),
  (:dupe, 1, '2024-04-01', 'completed', 'Filling', 'healthwire', now()), (:dupe, 1, '2024-05-01', 'completed', 'Checkup', 'healthwire', now());
insert into public.invoices (invoice_no, patient_id, branch_id, issue_date, subtotal, status, legacy_source) values ('T-88001', :keep, 1, '2024-03-01', 10000, 'issued', 'healthwire'), ('T-88002', :dupe, 1, '2024-05-01', 6000, 'issued', 'healthwire');
insert into public.payments (patient_id, branch_id, amount, method, received_at, legacy_source) values (:keep, 1, 4000, 'cash', '2024-03-01', 'healthwire'), (:dupe, 1, 6000, 'cash', '2024-05-01', 'healthwire');

-- Front desk cannot see the duplicate list or merge.
select set_config('request.jwt.claim.sub', :fd, false);
set role authenticated;
select pg_temp.expect_error($$select public.patient_duplicates()$$, 'Only Dr. Ali', 'front desk cannot list duplicates');
select pg_temp.expect_error(format($$select public.merge_patients(%L, %L)$$, :keep, :dupe), 'Only Dr. Ali', 'front desk cannot merge');
reset role; select set_config('request.jwt.claim.sub', '', false);

select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
select pg_temp.check((select count(*) from jsonb_array_elements(public.patient_duplicates()) g where g->>'phone' = '03009998877' and (g->>'members')::int = 2) = 1,
  'the two records sharing a phone show up as one duplicate group');
do $$
declare r jsonb;
begin
  r := public.merge_patients('00000000-0000-0000-0000-0000000000e8', '00000000-0000-0000-0000-0000000000e9');
  if (r->>'removed_mr') <> '88002' then raise exception 'TEST FAILED: merge result %', r; end if;
  raise notice 'ok - merge runs and reports the removed Mr#';
end $$;
select pg_temp.check((select count(*) from public.patients where id = :dupe) = 0, 'the duplicate record is gone');
select pg_temp.check((select count(*) from public.visits where patient_id = :keep) = 3, 'visits: 2 + 2 with one shared day = 3 on the kept record');
select pg_temp.check((select notes from public.visits where patient_id = :keep and visit_date = '2024-04-01') like '%Filling%', 'the shared-day visit kept the other treatment in its notes');
select pg_temp.check((select count(*) from public.invoices where patient_id = :keep) = 2 and (select count(*) from public.payments where patient_id = :keep) = 2, 'both invoices and both payments now belong to the kept record');
select pg_temp.check((select dues from public.patient_balances where patient_id = :keep) = 6000, 'dues after the merge = 16,000 billed - 10,000 paid');
select pg_temp.check((select email = 'sana@example.com' and gender = 'female' and first_branch_id = 1 from public.patients where id = :keep), 'gaps filled from the duplicate, existing values kept');
select pg_temp.check((select notes like '%Merged with Mr# 88002%' from public.patients where id = :keep), 'the old Mr# is kept in the notes');
select pg_temp.check((select count(*) from public.audit_log where action = 'MERGE' and row_id = :keep::text) = 1, 'the merge is in the audit log');
select pg_temp.check((select count(*) from jsonb_array_elements(public.patient_duplicates()) g where g->>'phone' = '03009998877') = 0, 'the group no longer appears as a duplicate');
reset role; select set_config('request.jwt.claim.sub', '', false);
rollback;
