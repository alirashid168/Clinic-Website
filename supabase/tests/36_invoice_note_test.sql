-- The invoice note (20261015000800_invoice_note.sql): save_invoice keeps the note the front desk writes on the bill, an empty
-- note is kept as none, and the note is one of the details a retry must repeat (another note with the same key is refused, like
-- another price). The rest of save_invoice is tested in 22_audit_fixes_test.sql.
\set ON_ERROR_STOP 1
\set fd     '''00000000-0000-0000-0000-000000003501'''
\set pat    '''00000000-0000-0000-0000-000000003511'''

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
create or replace function pg_temp.k(n int) returns uuid language sql immutable as $$
  select ('35353535-3535-4535-8535-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function pg_temp.hdr(patient uuid, note text) returns jsonb language sql immutable as $$
  select jsonb_build_object('patient_id', patient, 'branch_id', 1, 'visit_id', null, 'discount_amount', 0, 'discount_reason', null, 'notes', note) $$;
create or replace function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, false) $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

-- Run the migration again first: it must be safe to run twice, and 22_audit_fixes_test.sql runs 20261007002000_audit_fixes.sql a
-- second time, which puts back the save_invoice from before the note in a database that has every migration. (It commits, so it runs
-- before the transaction below.)
\ir ../migrations/20261015000800_invoice_note.sql

begin;
select set_config('test.pat', :pat, false);
insert into auth.users (id, email) values (:fd, 'fd35@dralirashid.com');
insert into public.staff (id, full_name, email, role, restrict_to_branches, branch_ids) values (:fd, 'Front Desk', 'fd35@dralirashid.com', 'front_desk', false, '{}');
insert into public.patients (id, mr_number, full_name, phone, first_branch_id) values (:pat, '35001', 'Note Patient', '03003500001', 1);

select pg_temp.act_as(:fd);
set role authenticated;
do $$
declare
  pat uuid := current_setting('test.pat')::uuid;
  lines jsonb := jsonb_build_array(jsonb_build_object('description', 'Braces kit', 'quantity', 1, 'unit_price', 50000));
  inv jsonb;
begin
  inv := public.save_invoice(pg_temp.k(1), pg_temp.hdr(pat, '  Second installment next month  '), lines);
  perform pg_temp.check(inv->>'notes' = 'Second installment next month', 'the note is saved on the invoice (spaces at the ends trimmed)');
  perform pg_temp.check((select notes from public.invoices where id = (inv->>'id')::uuid) = 'Second installment next month', 'and it is in the table');
  perform pg_temp.check(public.save_invoice(pg_temp.k(1), pg_temp.hdr(pat, '  Second installment next month  '), lines) = inv, 'the same key and note: the same invoice comes back');
  perform pg_temp.expect_error(format($f$select public.save_invoice(%L, %L, %L)$f$, pg_temp.k(1), pg_temp.hdr(pat, 'Another note'), lines),
    'IDEMPOTENCY_MISMATCH', 'the same key with another note is refused, like another price');
  perform pg_temp.check(public.save_invoice(pg_temp.k(2), pg_temp.hdr(pat, '   '), lines)->>'notes' is null, 'a note of spaces only is kept as no note');
  perform pg_temp.check(public.save_invoice(pg_temp.k(3), pg_temp.hdr(pat, null), lines)->>'notes' is null, 'no note: none');
  perform pg_temp.check(public.save_invoice(pg_temp.k(4), pg_temp.hdr(pat, null) - 'notes', lines)->>'status' = 'issued', 'a website without the note (older page) still saves');
end $$;
reset role;
rollback;
