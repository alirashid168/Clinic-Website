-- Voiding an invoice needs a real reason: NULL, an empty text and blank text are all refused
-- (invoice_before_write(), 20261007002000_audit_fixes.sql section 7).
\set ON_ERROR_STOP 1
\set admin  '''00000000-0000-0000-0000-000000002200'''
\set pat    '''00000000-0000-0000-0000-000000002201'''

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
insert into auth.users (id, email) values (:admin, 'ali22@dralirashid.com');
insert into public.staff (id, full_name, email, role) values (:admin, 'Dr. Ali Rashid', 'ali22@dralirashid.com', 'admin');
insert into public.patients (id, mr_number, full_name, phone, first_branch_id) values (:pat, '22001', 'Void Test', '03002200100', 1);
insert into public.invoices (invoice_no, patient_id, branch_id, issue_date, subtotal, status)
values ('T-22001', :pat, 1, '2026-10-01', 5000, 'issued');

select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;

select pg_temp.expect_error($$update public.invoices set status = 'void', void_reason = null where invoice_no = 'T-22001'$$,
  'reason is required', 'a void with no reason (NULL) is refused');
select pg_temp.expect_error($$update public.invoices set status = 'void', void_reason = '' where invoice_no = 'T-22001'$$,
  'reason is required', 'a void with an empty reason is refused');
select pg_temp.expect_error($$update public.invoices set status = 'void', void_reason = '   ' where invoice_no = 'T-22001'$$,
  'reason is required', 'a void with a reason of only spaces is refused');
select pg_temp.expect_error(format($$update public.invoices set status = 'void', void_reason = %L where invoice_no = 'T-22001'$$, E' \t\r\n '),
  'reason is required', 'a void with a reason of only tabs and line breaks is refused');
select pg_temp.expect_error($$insert into public.invoices (invoice_no, patient_id, branch_id, subtotal, status, void_reason)
  values ('T-22002', '00000000-0000-0000-0000-000000002201', 1, 1000, 'void', '')$$,
  'reason is required', 'an invoice cannot be created already void with an empty reason');
select pg_temp.check((select status from public.invoices where invoice_no = 'T-22001') = 'issued',
  'the refused voids left the invoice issued');

update public.invoices set status = 'void', void_reason = 'Wrong patient' where invoice_no = 'T-22001';
select pg_temp.check((select status = 'void' and void_reason = 'Wrong patient' from public.invoices where invoice_no = 'T-22001'),
  'a void with a reason goes through and keeps the reason');
reset role; select set_config('request.jwt.claim.sub', '', false);
rollback;
