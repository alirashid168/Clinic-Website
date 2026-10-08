-- The audit migration (20261007002000_audit_fixes.sql): report totals (payments_summary, opd_summary, total_dues),
-- the one-call invoice and plan saves with their idempotency keys, row-level security inside all of them, and the
-- statements the website falls back to while those functions are not installed, photos.thumb_path and who can read a
-- thumbnail in storage, and running the migration a second time.
-- (Voiding needs a reason: 22_void_reason_test.sql.)
\set ON_ERROR_STOP 1
\set admin  '''00000000-0000-0000-0000-000000002300'''
\set fd     '''00000000-0000-0000-0000-000000002301'''
\set fd1    '''00000000-0000-0000-0000-000000002302'''
\set acc    '''00000000-0000-0000-0000-000000002303'''
\set doc    '''00000000-0000-0000-0000-000000002304'''
\set portal1 '''00000000-0000-0000-0000-000000002305'''
\set portal2 '''00000000-0000-0000-0000-000000002306'''
\set pat1   '''00000000-0000-0000-0000-000000002311'''
\set pat2   '''00000000-0000-0000-0000-000000002312'''
\set invA   '''00000000-0000-0000-0000-000000002321'''
\set invB   '''00000000-0000-0000-0000-000000002322'''
\set invC   '''00000000-0000-0000-0000-000000002323'''
\set invD   '''00000000-0000-0000-0000-000000002324'''
\set planA  '''00000000-0000-0000-0000-000000002331'''

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
-- Test inputs: an idempotency key, an invoice header, an invoice line, a plan header, an installment.
create or replace function pg_temp.k(n int) returns uuid language sql immutable as $$
  select ('11111111-1111-4111-8111-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function pg_temp.hdr(patient uuid, branch int, discount numeric default 0, why text default null) returns jsonb language sql immutable as $$
  select jsonb_build_object('patient_id', patient, 'branch_id', branch, 'visit_id', null, 'discount_amount', discount, 'discount_reason', why) $$;
create or replace function pg_temp.ln(descr text, qty numeric, price numeric) returns jsonb language sql immutable as $$
  select jsonb_build_object('description', descr, 'quantity', qty, 'unit_price', price) $$;
create or replace function pg_temp.plan(patient uuid, fee numeric, starts text default '2026-10-07') returns jsonb language sql immutable as $$
  select jsonb_build_object('patient_id', patient, 'braces_case_id', null, 'total_fee', fee, 'starts_on', starts, 'notes', '70k kit') $$;
create or replace function pg_temp.inst(due text, amount numeric, note text default null) returns jsonb language sql immutable as $$
  select jsonb_build_object('due_date', due, 'amount', amount, 'note', note) $$;
-- Who the next statements run as (the role stays as it is).
create or replace function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, false) $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

begin;
select set_config('test.pat1', :pat1, false), set_config('test.pat2', :pat2, false), set_config('test.fd', :fd, false),
       set_config('test.fd1', :fd1, false), set_config('test.doc', :doc, false), set_config('test.admin', :admin, false);
-- Dues owed before this test adds any (earlier tests may leave patients behind).
select set_config('test.dues_before', public.total_dues()::text, false);
insert into auth.users (id, email) values
  (:admin, 'admin23@dralirashid.com'), (:fd, 'fd23@dralirashid.com'), (:fd1, 'fd23b@dralirashid.com'),
  (:acc, 'acc23@dralirashid.com'), (:doc, 'doc23@dralirashid.com'),
  (:portal1, 'portal23a@dralirashid.com'), (:portal2, 'portal23b@dralirashid.com');   -- patient-portal logins: no staff row
insert into public.staff (id, full_name, email, role, restrict_to_branches, branch_ids) values
  (:admin, 'Admin', 'admin23@dralirashid.com', 'admin', false, '{}'),
  (:fd,    'Front Desk', 'fd23@dralirashid.com', 'front_desk', false, '{}'),
  (:fd1,   'Front Desk Gulshan', 'fd23b@dralirashid.com', 'front_desk', true, '{1}'),
  (:acc,   'Accountant', 'acc23@dralirashid.com', 'accountant', false, '{}'),
  (:doc,   'Doctor', 'doc23@dralirashid.com', 'doctor', false, '{}');
insert into public.patients (id, mr_number, full_name, phone, first_branch_id) values
  (:pat1, '23001', 'Audit Patient One', '03002300001', 1), (:pat2, '23002', 'Audit Patient Two', '03002300002', 2);
-- Linking a portal login to a patient is for the admin only (a trigger refuses anyone else), so link them as the admin.
select pg_temp.act_as(:admin);
update public.patients set portal_user_id = :portal1 where id = :pat1;
update public.patients set portal_user_id = :portal2 where id = :pat2;
select pg_temp.act_as('');
-- Everything below is dated March 2001 and every query names that month, so rows other tests leave in the database cannot count.
-- Payments: cash / card / bank mix, a refund, two branches, and rows either side of Karachi midnight (UTC+5).
insert into public.payments (patient_id, branch_id, amount, method, received_at) values
  (:pat1, 1, 5000,  'cash',          '2001-03-05 18:59:59+00'),   -- 23:59:59 on 5 March in Karachi
  (:pat1, 1, 2500,  'card',          '2001-03-05 19:00:00+00'),   -- 00:00:00 on 6 March
  (:pat1, 1, 7000,  'bank_transfer', '2001-03-06 08:00:00+00'),
  (:pat1, 1, -1000, 'cash',          '2001-03-06 09:00:00+00'),   -- a refund
  (:pat2, 2, 4000,  'cheque',        '2001-03-06 10:00:00+00'),
  (:pat2, 2, 1500,  'cash',          '2001-03-07 10:00:00+00'),
  (:pat2, 2, 300,   'other',         '2001-03-07 11:00:00+00');
-- Visits: waits (check-in to start) of 20, 55 and 10 minutes, a no-show, a cancellation, a visit with no times,
-- and one whose start is BEFORE its check-in (edited or back-filled times): that one has no wait.
insert into public.visits (patient_id, branch_id, visit_date, status, checked_in_at, started_at) values
  (:pat1, 1, '2001-03-06', 'completed', '2001-03-06 05:00:00+00', '2001-03-06 05:20:00+00'),
  (:pat1, 1, '2001-03-06', 'completed', '2001-03-06 06:00:00+00', '2001-03-06 06:55:00+00'),
  (:pat2, 2, '2001-03-06', 'completed', '2001-03-06 05:00:00+00', '2001-03-06 05:10:00+00'),
  (:pat2, 2, '2001-03-07', 'no_show',   null, null),
  (:pat1, 1, '2001-03-07', 'cancelled', null, null),
  (:pat1, 1, '2001-03-07', 'completed', null, null),
  (:pat1, 1, '2001-03-06', 'completed', '2001-03-06 07:00:00+00', '2001-03-06 06:30:00+00');
-- Dues: pat1 billed 20,000 (issued) and paid 13,500 net, so owes 6,500; pat2 billed 3,000 and paid 5,800 (an advance, no dues).
insert into public.invoices (invoice_no, patient_id, branch_id, status) values ('T23-1', :pat1, 1, 'issued'), ('T23-2', :pat2, 2, 'issued');
insert into public.invoice_items (invoice_id, description, quantity, unit_price)
  select id, 'Treatment', 1, case when invoice_no = 'T23-1' then 20000 else 3000 end from public.invoices where invoice_no in ('T23-1', 'T23-2');

-- ================================================================= payments_summary
select pg_temp.act_as(:admin);
set role authenticated;
do $$
declare r jsonb; d jsonb;
begin
  r := public.payments_summary('2001-03-01', '2001-03-31', null, null);
  perform pg_temp.check(r->'totals' = '{"received": 20300, "cash": 6500, "card": 2500, "bank": 11300, "refunds": 1000, "net": 19300, "count": 7}'::jsonb,
    'payments_summary: totals are the hand-counted numbers (bank = every method but cash and card)');
  perform pg_temp.check((select array_agg(k order by k collate "C") from jsonb_object_keys(r) k) = array['byDay', 'byMethod', 'totals'], 'payments_summary: top-level keys');
  perform pg_temp.check((select array_agg(k order by k collate "C") from jsonb_object_keys(r->'totals') k) = array['bank', 'card', 'cash', 'count', 'net', 'received', 'refunds'], 'payments_summary: totals keys');
  perform pg_temp.check((select array_agg(k order by k collate "C") from jsonb_object_keys(r->'byDay'->0) k) = array['bank', 'branch_id', 'card', 'cash', 'count', 'day', 'net', 'received', 'refunds'], 'payments_summary: byDay keys');
  perform pg_temp.check((select array_agg(k order by k collate "C") from jsonb_object_keys(r->'byMethod'->0) k) = array['amount', 'count', 'method', 'refunds'], 'payments_summary: byMethod keys');
  perform pg_temp.check(jsonb_array_length(r->'byDay') = 4 and r->'byDay'->0->>'day' = '2001-03-07', 'payments_summary: four day/branch rows, newest day first');
  d := (select x from jsonb_array_elements(r->'byDay') x where x->>'day' = '2001-03-05');
  perform pg_temp.check((d->>'cash')::numeric = 5000 and (d->>'count')::int = 1, 'Karachi midnight: 23:59:59 counts on 5 March');
  d := (select x from jsonb_array_elements(r->'byDay') x where x->>'day' = '2001-03-06' and (x->>'branch_id')::int = 1);
  perform pg_temp.check((d->>'card')::numeric = 2500 and (d->>'bank')::numeric = 7000 and (d->>'refunds')::numeric = 1000 and (d->>'net')::numeric = 8500 and (d->>'count')::int = 3,
    'Karachi midnight: 00:00:00 counts on 6 March, with that day''s bank payment and refund');
  d := (select x from jsonb_array_elements(r->'byMethod') x where x->>'method' = 'cash');
  perform pg_temp.check(r->'byMethod'->0->>'method' = 'bank_transfer' and jsonb_array_length(r->'byMethod') = 5
    and (d->>'amount')::numeric = 6500 and (d->>'refunds')::numeric = 1000 and (d->>'count')::int = 3, 'payments_summary: byMethod, biggest first, refunds kept apart');

  r := public.payments_summary('2001-03-06', '2001-03-06', 1, null);
  perform pg_temp.check(r->'totals' = '{"received": 9500, "cash": 0, "card": 2500, "bank": 7000, "refunds": 1000, "net": 8500, "count": 3}'::jsonb, 'payments_summary: date range and branch filter (6 March, branch 1)');
  r := public.payments_summary('2001-03-01', '2001-03-31', null, 'cash');
  perform pg_temp.check(r->'totals' = '{"received": 6500, "cash": 6500, "card": 0, "bank": 0, "refunds": 1000, "net": 5500, "count": 3}'::jsonb, 'payments_summary: method filter');
  r := public.payments_summary('2030-01-01', '2030-01-02', null, null);
  perform pg_temp.check(r = '{"totals": {"received": 0, "cash": 0, "card": 0, "bank": 0, "refunds": 0, "net": 0, "count": 0}, "byDay": [], "byMethod": []}'::jsonb,
    'payments_summary: an empty period gives zeros and empty lists, not null');
end $$;

-- ================================================================= opd_summary
do $$
declare r jsonb; d jsonb;
begin
  r := public.opd_summary('2001-03-01', '2001-03-31', null);
  perform pg_temp.check(r->'totals' = '{"visits": 7, "completed": 5, "no_shows": 1, "cancelled": 1, "waited": 3, "wait_min_total": 85, "avg_wait_min": 28, "patients": 2}'::jsonb,
    'opd_summary: totals are the hand-counted numbers; the visit that started before it checked in has no wait (3 waits, 85 min, not 4 and 55)');
  perform pg_temp.check((select array_agg(k order by k collate "C") from jsonb_object_keys(r) k) = array['byDay', 'totals', 'waitByBranch'], 'opd_summary: top-level keys');
  perform pg_temp.check((select array_agg(k order by k collate "C") from jsonb_object_keys(r->'byDay'->0) k)
    = array['avg_wait_min', 'branch_id', 'cancelled', 'completed', 'day', 'no_shows', 'visits', 'wait_min_total', 'waited'], 'opd_summary: byDay keys');
  perform pg_temp.check((select array_agg(k order by k collate "C") from jsonb_object_keys(r->'waitByBranch'->0) k) = array['avg_wait_min', 'branch_id', 'long', 'wait_min_total', 'waited'], 'opd_summary: waitByBranch keys');
  d := (select x from jsonb_array_elements(r->'byDay') x where x->>'day' = '2001-03-06' and (x->>'branch_id')::int = 1);
  perform pg_temp.check((d->>'visits')::int = 3 and (d->>'waited')::int = 2 and (d->>'wait_min_total')::numeric = 75 and (d->>'avg_wait_min')::numeric = 38,
    'opd_summary: 6 March branch 1 has 3 visits and 2 waits (20 and 55 min, average 38); the negative one is not counted');
  d := (select x from jsonb_array_elements(r->'byDay') x where x->>'day' = '2001-03-07' and (x->>'branch_id')::int = 1);
  perform pg_temp.check((d->>'visits')::int = 2 and (d->>'waited')::int = 0 and jsonb_typeof(d->'avg_wait_min') = 'null', 'opd_summary: a day with no waits has a null average, not 0');
  perform pg_temp.check(r->'byDay'->0->>'day' = '2001-03-07' and jsonb_array_length(r->'byDay') = 4, 'opd_summary: four day/branch rows, newest day first');
  perform pg_temp.check(jsonb_array_length(r->'waitByBranch') = 2 and r->'waitByBranch'->0 = '{"branch_id": 1, "waited": 2, "wait_min_total": 75, "avg_wait_min": 38, "long": 1}'::jsonb
    and r->'waitByBranch'->1 = '{"branch_id": 2, "waited": 1, "wait_min_total": 10, "avg_wait_min": 10, "long": 0}'::jsonb, 'opd_summary: waitByBranch, with the over-45-minute count');
  r := public.opd_summary('2001-03-06', '2001-03-07', 1);
  perform pg_temp.check((r->'totals'->>'visits')::int = 5 and (r->'totals'->>'waited')::int = 2 and (r->'totals'->>'patients')::int = 1, 'opd_summary: date range and branch filter');
  r := public.opd_summary('2030-01-01', '2030-01-02', null);
  perform pg_temp.check(r = '{"totals": {"visits": 0, "completed": 0, "no_shows": 0, "cancelled": 0, "waited": 0, "wait_min_total": 0, "avg_wait_min": null, "patients": 0}, "byDay": [], "waitByBranch": []}'::jsonb,
    'opd_summary: an empty period gives zeros, a null average and empty lists');
end $$;

-- ================================================================= total_dues
select pg_temp.check(public.total_dues() = current_setting('test.dues_before')::numeric + 6500, 'total_dues: adds the one new patient who owes (6,500); the other patient''s advance does not offset it');
select pg_temp.check(public.total_dues() = (select coalesce(sum(dues), 0) from public.patient_balances where dues > 0), 'total_dues equals the sum of positive balances');

-- ================================================================= row-level security still applies inside them (SECURITY INVOKER)
select pg_temp.act_as(:doc);
select pg_temp.check((public.payments_summary('2001-03-01', '2001-03-31', null, null)->'totals'->>'count')::int = 0, 'a doctor (no billing.view) gets zero payment totals: row-level security hides the rows');
select pg_temp.check(public.total_dues() = 0, 'a doctor sees no dues');
select pg_temp.act_as(:fd1);
select pg_temp.check(public.payments_summary('2001-03-01', '2001-03-31', null, null)->'totals' = '{"received": 14500, "cash": 5000, "card": 2500, "bank": 7000, "refunds": 1000, "net": 13500, "count": 4}'::jsonb,
  'front desk limited to branch 1 totals only branch 1 payments');
select pg_temp.check((public.opd_summary('2001-03-01', '2001-03-31', null)->'totals'->>'visits')::int = 5, 'front desk limited to branch 1 counts only branch 1 visits');
select pg_temp.check(public.total_dues() = (select coalesce(sum(dues), 0) from public.patient_balances where dues > 0), 'total_dues for that user equals what they see in patient_balances');
select pg_temp.act_as(:acc);
select pg_temp.check((public.payments_summary('2001-03-01', '2001-03-31', null, null)->'totals'->>'count')::int = 7 and public.total_dues() = current_setting('test.dues_before')::numeric + 6500, 'the accountant sees everything');
-- A patient-portal login is not staff: the "own rows" policies (current_patient_id()) are all that lets it see anything.
select pg_temp.act_as(:portal1);   -- Audit Patient One: 4 of the 7 payments, 5 of the 7 visits, owes 6,500
select pg_temp.check(public.payments_summary('2001-03-01', '2001-03-31', null, null)->'totals' = '{"received": 14500, "cash": 5000, "card": 2500, "bank": 7000, "refunds": 1000, "net": 13500, "count": 4}'::jsonb,
  'a patient-portal user totals only their own payments (4 of the 7), not the clinic''s');
select pg_temp.check(public.opd_summary('2001-03-01', '2001-03-31', null)->'totals' = '{"visits": 5, "completed": 4, "no_shows": 0, "cancelled": 1, "waited": 2, "wait_min_total": 75, "avg_wait_min": 38, "patients": 1}'::jsonb,
  'and counts only their own visits (5 of the 7, one patient)');
select pg_temp.check(public.total_dues() = 6500, 'and total_dues is their own balance (6,500), not what the other patients owe');
select pg_temp.act_as(:portal2);   -- Audit Patient Two: 3 payments, 2 visits, paid more than billed
select pg_temp.check(public.payments_summary('2001-03-01', '2001-03-31', null, null)->'totals' = '{"received": 5800, "cash": 1500, "card": 0, "bank": 4300, "refunds": 0, "net": 5800, "count": 3}'::jsonb,
  'another patient-portal user totals their own 3 payments, not the first patient''s');
select pg_temp.check(public.opd_summary('2001-03-01', '2001-03-31', null)->'totals' = '{"visits": 2, "completed": 1, "no_shows": 1, "cancelled": 0, "waited": 1, "wait_min_total": 10, "avg_wait_min": 10, "patients": 1}'::jsonb,
  'and their own 2 visits');
select pg_temp.check(public.total_dues() = 0, 'and a patient who has paid ahead owes nothing, so their total is 0');
reset role;

set role anon;
select pg_temp.expect_error($$select public.payments_summary(null, null)$$, 'permission denied', 'anon cannot call payments_summary');
select pg_temp.expect_error($$select public.opd_summary(null, null)$$, 'permission denied', 'anon cannot call opd_summary');
select pg_temp.expect_error($$select public.total_dues()$$, 'permission denied', 'anon cannot call total_dues');
select pg_temp.expect_error($$select public.save_invoice(null, '{}', '[]')$$, 'permission denied', 'anon cannot call save_invoice');
select pg_temp.expect_error($$select public.save_installment_plan(null, '{}', '[]')$$, 'permission denied', 'anon cannot call save_installment_plan');
select pg_temp.expect_error($$select * from public.idempotency_keys$$, 'permission denied', 'anon has no access to idempotency_keys');
reset role;

-- ================================================================= save_invoice
select pg_temp.act_as(:fd);
set role authenticated;
do $$
declare
  pat uuid := current_setting('test.pat1')::uuid;
  hdr jsonb := pg_temp.hdr(current_setting('test.pat1')::uuid, 1);
  lines jsonb := jsonb_build_array(pg_temp.ln('Scaling', 1, 3000), pg_temp.ln('Polish', 2, 500));
  inv1 jsonb; row_json jsonb; again jsonb; second jsonb; fixed jsonb; n bigint;
begin
  inv1 := public.save_invoice(pg_temp.k(1), hdr, lines);
  perform pg_temp.check(inv1->>'invoice_no' ~ '^INV-[0-9]{4}-[0-9]{6}$', 'save_invoice returns the invoice with its number');
  perform pg_temp.check(inv1->>'status' = 'issued' and (inv1->>'subtotal')::numeric = 4000 and (inv1->>'total')::numeric = 4000, 'issued, with the subtotal added up from the lines (4,000)');
  perform pg_temp.check(jsonb_array_length(inv1->'items') = 2
    and not exists (select 1 from jsonb_array_elements(inv1->'items') it where it->>'invoice_id' <> inv1->>'id' or not (it ? 'line_total')),
    'the lines come back under "items", like select(*, items:invoice_items(*))');
  select to_jsonb(i) into row_json from public.invoices i where i.id = (inv1->>'id')::uuid;
  perform pg_temp.check((inv1 - 'items') = row_json, 'the invoice part is exactly the table row, the same shape the old client read had');
  perform pg_temp.check((inv1->>'created_by')::uuid = current_setting('test.fd')::uuid, 'created_by is the caller (the trigger stamps it)');

  again := public.save_invoice(pg_temp.k(1), hdr, lines);
  perform pg_temp.check(again = inv1, 'same key, same details: the very same invoice comes back');
  perform pg_temp.check((select count(*) from public.invoices where created_by = current_setting('test.fd')::uuid) = 1, 'and only one invoice exists for that key');
  perform pg_temp.expect_error(format($f$select public.save_invoice(%L, %L, %L)$f$, pg_temp.k(1), hdr, jsonb_build_array(pg_temp.ln('Scaling', 1, 300))),
    'IDEMPOTENCY_MISMATCH', 'same key, different price: refused, not silently answered with the old invoice');
  perform pg_temp.expect_error(format($f$select public.save_invoice(%L, %L, %L)$f$, pg_temp.k(1), hdr, jsonb_build_array(pg_temp.ln('Scaling', 1, 300))),
    inv1->>'invoice_no', 'the message names the invoice that was already saved');
  perform pg_temp.expect_error(format($f$select public.save_invoice(%L, %L, %L)$f$, pg_temp.k(1), pg_temp.hdr(pat, 1, 100), lines),
    'IDEMPOTENCY_MISMATCH', 'same key, different discount: refused');
  perform pg_temp.expect_error(format($f$select public.save_invoice(%L, %L, %L)$f$, pg_temp.k(1), pg_temp.hdr(pat, 2), lines),
    'IDEMPOTENCY_MISMATCH', 'same key, different branch: refused');
  perform pg_temp.expect_error(format($f$select public.save_invoice(%L, %L, %L)$f$, pg_temp.k(1), hdr, jsonb_build_array(pg_temp.ln('Polish', 2, 500), pg_temp.ln('Scaling', 1, 3000))),
    'IDEMPOTENCY_MISMATCH', 'same key, lines in another order: refused (counted as different details)');
  perform pg_temp.check((select count(*) from public.invoices where created_by = current_setting('test.fd')::uuid) = 1, 'a refused retry created nothing');

  second := public.save_invoice(pg_temp.k(2), hdr, lines);
  perform pg_temp.check(second->>'id' <> inv1->>'id', 'a different key makes a different invoice');
  perform pg_temp.check(public.save_invoice(null, hdr, lines)->>'status' = 'issued', 'no key: still saves (just without the retry protection)');
  perform pg_temp.check((select count(*) from public.idempotency_keys) = 2, 'two keys stored, none for the keyless save');

  -- A save that fails leaves nothing behind, and its key is free for the corrected retry.
  select count(*) into n from public.invoices;
  perform pg_temp.expect_error(format($f$select public.save_invoice(%L, %L, %L)$f$, pg_temp.k(10), hdr, jsonb_build_array(pg_temp.ln('Bad', 1, -5))),
    'violates check constraint', 'a line the table refuses fails the whole save');
  perform pg_temp.check((select count(*) from public.invoices) = n, 'no half-saved invoice is left');
  perform pg_temp.check((select count(*) from public.idempotency_keys where key = pg_temp.k(10)) = 0, 'the key rolled back with it');
  fixed := public.save_invoice(pg_temp.k(10), hdr, jsonb_build_array(pg_temp.ln('Good', 1, 500)));
  perform pg_temp.check(fixed->>'status' = 'issued' and (fixed->>'subtotal')::numeric = 500, 'the corrected retry with the same key creates the right invoice');
  perform pg_temp.expect_error(format($f$select public.save_invoice(%L, %L, %L)$f$, pg_temp.k(11), hdr, '[]'::jsonb), 'at least one line', 'no lines: refused');
  perform pg_temp.expect_error(format($f$select public.save_invoice(%L, %L, %L)$f$, pg_temp.k(11), hdr, null::jsonb), 'at least one line', 'null lines: refused');

  -- The discount rules still decide, as before: front desk may give up to 10% / Rs 5,000.
  inv1 := public.save_invoice(pg_temp.k(20), pg_temp.hdr(pat, 1, 4000, 'family'), jsonb_build_array(pg_temp.ln('Braces', 1, 10000)));
  perform pg_temp.check(inv1->>'status' = 'pending_approval' and (inv1->>'subtotal')::numeric = 10000 and (inv1->>'discount_amount')::numeric = 4000,
    'a discount over the cap waits for approval and is not issued');
  perform pg_temp.check((select count(*) from public.discount_requests where invoice_id = (inv1->>'id')::uuid and status = 'pending') = 1, 'and one discount request was raised');
  perform pg_temp.check(jsonb_array_length(inv1->'items') = 1, 'with its lines saved');
  second := public.save_invoice(pg_temp.k(21), pg_temp.hdr(pat, 1, 500, 'regular'), jsonb_build_array(pg_temp.ln('Filling', 1, 10000)));
  perform pg_temp.check(second->>'status' = 'issued' and (second->>'total')::numeric = 9500, 'a discount inside the cap is issued with the total reduced');
  perform pg_temp.check(public.save_invoice(pg_temp.k(20), pg_temp.hdr(pat, 1, 4000, 'family'), jsonb_build_array(pg_temp.ln('Braces', 1, 10000))) = inv1,
    'a retry of the pending invoice returns it unchanged');
  perform pg_temp.check((select count(*) from public.discount_requests where invoice_id = (inv1->>'id')::uuid) = 1, 'and raises no second request');

  -- Row-level security decides who can save at all.
  perform pg_temp.act_as(current_setting('test.doc'));
  perform pg_temp.expect_error(format($f$select public.save_invoice(%L, %L, %L)$f$, pg_temp.k(30), hdr, lines), 'row-level security', 'a doctor (no billing.create) cannot save an invoice');
  perform pg_temp.act_as(current_setting('test.fd1'));
  perform pg_temp.expect_error(format($f$select public.save_invoice(%L, %L, %L)$f$, pg_temp.k(31), pg_temp.hdr(pat, 2), lines), 'row-level security', 'front desk limited to branch 1 cannot save a branch 2 invoice');
  perform pg_temp.check((select count(*) from public.idempotency_keys) = 0, 'refused saves leave no key behind; a user sees only their own keys (none for this desk yet)');
  perform pg_temp.check(public.save_invoice(pg_temp.k(32), hdr, lines)->>'status' = 'issued', 'front desk limited to branch 1 can save at branch 1');
  perform pg_temp.check((select array_agg(key) from public.idempotency_keys) = array[pg_temp.k(32)], 'and then sees just that key');
  perform pg_temp.act_as(current_setting('test.fd'));
  perform pg_temp.check((select count(*) from public.idempotency_keys where key = pg_temp.k(32)) = 0, 'another user cannot see it');
  perform pg_temp.expect_error(format($f$select public.save_invoice(%L, %L, %L)$f$, pg_temp.k(32), hdr, lines), 'already saved', 'a key used by another user is not answered with their invoice');
end $$;

-- ================================================================= save_installment_plan
do $$
declare
  pat uuid := current_setting('test.pat1')::uuid;
  plan jsonb := pg_temp.plan(current_setting('test.pat1')::uuid, 30000);
  rows3 jsonb := jsonb_build_array(pg_temp.inst('2026-11-07', 10000, '1 of 3'), pg_temp.inst('2026-12-07', 10000, '2 of 3'), pg_temp.inst('2027-01-07', 10000, '3 of 3'));
  p1 jsonb; row_json jsonb; fixed jsonb; keyless jsonb; inv_id text; n bigint;
begin
  perform pg_temp.act_as(current_setting('test.fd'));
  p1 := public.save_installment_plan(pg_temp.k(50), plan, rows3);
  perform pg_temp.check((p1->>'total_fee')::numeric = 30000 and p1->>'starts_on' = '2026-10-07' and (p1->>'created_by')::uuid = current_setting('test.fd')::uuid,
    'save_installment_plan returns the plan (total, start date, created_by = the caller)');
  select to_jsonb(p) into row_json from public.payment_plans p where p.id = (p1->>'id')::uuid;
  perform pg_temp.check(p1 = row_json, 'the result is exactly the table row');
  perform pg_temp.check((select count(*) from public.plan_installments where plan_id = (p1->>'id')::uuid) = 3, 'three installments saved with it');
  perform pg_temp.check(public.save_installment_plan(pg_temp.k(50), plan, rows3) = p1, 'same key, same details: the same plan comes back');
  perform pg_temp.check((select count(*) from public.payment_plans where patient_id = pat) = 1, 'and there is still one plan');
  perform pg_temp.expect_error(format($f$select public.save_installment_plan(%L, %L, %L)$f$, pg_temp.k(50), pg_temp.plan(pat, 20000), rows3),
    'IDEMPOTENCY_MISMATCH', 'same key, different total: refused');
  perform pg_temp.expect_error(format($f$select public.save_installment_plan(%L, %L, %L)$f$, pg_temp.k(50), plan, rows3 - 2),
    'IDEMPOTENCY_MISMATCH', 'same key, fewer installments: refused');
  perform pg_temp.check((select count(*) from public.plan_installments where plan_id = (p1->>'id')::uuid) = 3, 'a refused retry added nothing');

  -- A key belongs to the kind of save that first used it: an invoice's key is not a plan's key, nor a plan's an invoice's.
  -- k(1) was used for an invoice above and k(50) for the plan just now.
  select count(*) into n from public.invoices;
  perform pg_temp.expect_error(format($f$select public.save_installment_plan(%L, %L, %L)$f$, pg_temp.k(1), plan, rows3),
    'This plan was already saved', 'a key an invoice was saved with cannot be used for a plan');
  perform pg_temp.expect_error(format($f$select public.save_invoice(%L, %L, %L)$f$, pg_temp.k(50), pg_temp.hdr(pat, 1), jsonb_build_array(pg_temp.ln('Scaling', 1, 3000))),
    'This invoice was already saved', 'and a key a plan was saved with cannot be used for an invoice');
  perform pg_temp.check((select count(*) from public.invoices) = n and (select count(*) from public.payment_plans where patient_id = pat) = 1, 'neither refusal created anything');
  -- Random ids never collide across tables, so the answer above does not depend on the kind check. This does: a key stored for the OTHER kind
  -- that points at a record that really exists (request_hash empty, like a key saved before that column was added) must still not be answered with it.
  select id::text into inv_id from public.invoices where created_by = current_setting('test.fd')::uuid order by invoice_no limit 1;
  insert into public.idempotency_keys (key, kind, result_id) values (pg_temp.k(54), 'invoice', p1->>'id'), (pg_temp.k(55), 'plan', inv_id);
  perform pg_temp.expect_error(format($f$select public.save_installment_plan(%L, %L, %L)$f$, pg_temp.k(54), plan, rows3),
    'This plan was already saved', 'a plan save is not answered with the plan an invoice-kind key points at');
  perform pg_temp.expect_error(format($f$select public.save_invoice(%L, %L, %L)$f$, pg_temp.k(55), pg_temp.hdr(pat, 1), jsonb_build_array(pg_temp.ln('Scaling', 1, 3000))),
    'This invoice was already saved', 'an invoice save is not answered with the invoice a plan-kind key points at');

  perform pg_temp.expect_error(format($f$select public.save_installment_plan(%L, %L, %L)$f$, pg_temp.k(51), plan,
    jsonb_build_array(pg_temp.inst('2026-11-07', 10000), pg_temp.inst('2026-12-07', 0))), 'violates check constraint', 'an installment the table refuses (amount 0) fails the whole plan');
  perform pg_temp.check((select count(*) from public.payment_plans where patient_id = pat) = 1, 'no plan row is left without its installments');
  perform pg_temp.check((select count(*) from public.idempotency_keys where key = pg_temp.k(51)) = 0, 'the key rolled back');
  fixed := public.save_installment_plan(pg_temp.k(51), plan, rows3 - 2);
  perform pg_temp.check(fixed->>'id' <> p1->>'id' and (select count(*) from public.plan_installments where plan_id = (fixed->>'id')::uuid) = 2, 'the corrected retry with the same key makes the right plan');
  perform pg_temp.expect_error(format($f$select public.save_installment_plan(%L, %L, %L)$f$, pg_temp.k(52), plan, '[]'::jsonb), 'at least one installment', 'no installments: refused');
  keyless := public.save_installment_plan(null, pg_temp.plan(pat, 30000, null), rows3);
  perform pg_temp.check(keyless->>'starts_on' is not null, 'no key and no start date: today (Karachi) is used');
  perform pg_temp.act_as(current_setting('test.doc'));
  perform pg_temp.expect_error(format($f$select public.save_installment_plan(%L, %L, %L)$f$, pg_temp.k(53), plan, rows3), 'row-level security', 'a doctor cannot save a plan');
end $$;
reset role;

-- ================================================================= what the website falls back to while the functions are missing (as front desk, under row-level security)
select pg_temp.act_as(:fd);
set role authenticated;

-- Safe order for an edited retry of a draft: clear the discount, replace the lines, set the discount, then issue.
insert into public.invoices (id, patient_id, branch_id, subtotal, discount_amount, status) values (:invA, :pat1, 1, 1000, 0, 'draft');
insert into public.invoice_items (invoice_id, description, quantity, unit_price) values (:invA, 'A', 1, 1000);
update public.invoices set branch_id = 2, visit_id = null, discount_amount = 0, discount_reason = null where id = :invA;
delete from public.invoice_items where invoice_id = :invA;
insert into public.invoice_items (invoice_id, description, quantity, unit_price) values (:invA, 'B', 2, 1500);
update public.invoices set discount_amount = 100, discount_reason = 'edited' where id = :invA;
select pg_temp.check((select (branch_id, discount_amount, discount_reason, subtotal, status::text) = (2, 100, 'edited', 3000, 'draft') from public.invoices where id = :invA),
  'edited retry of a draft: header rewritten, lines replaced, subtotal recomputed, still a draft');
update public.invoices set status = 'issued' where id = :invA;
select pg_temp.check((select status = 'issued' and total = 2900 from public.invoices where id = :invA), 'then issued with the edited total');
with d as (delete from public.invoices where id = :invA returning id) select pg_temp.check((select count(*) from d) = 0, 'nobody can delete an invoice, so an orphan draft has to be reused by the retry');
with d as (delete from public.invoice_items where invoice_id = :invA returning id) select pg_temp.check((select count(*) from d) = 0, 'front desk cannot delete the lines of an issued invoice');
with u as (update public.invoices set discount_amount = 0 where id = :invA returning id) select pg_temp.check((select count(*) from u) = 0, 'nor edit its header');

-- Why the order matters: an invoice with no lines counts as 100% off, so setting the discount before emptying the lines needs approval.
insert into public.invoices (id, patient_id, branch_id, subtotal, discount_amount, status) values (:invB, :pat1, 1, 1000, 0, 'draft');
insert into public.invoice_items (invoice_id, description, quantity, unit_price) values (:invB, 'A', 1, 1000);
update public.invoices set discount_amount = 100 where id = :invB;
delete from public.invoice_items where invoice_id = :invB;
select pg_temp.check((select status::text from public.invoices where id = :invB) = 'pending_approval', 'discount first, then empty the lines: wrongly needs approval (so the website clears the discount first)');

-- An edited retry whose new discount is over the cap waits for approval like a first save, with one request for the new amount.
insert into public.invoices (id, patient_id, branch_id, subtotal, discount_amount, status) values (:invC, :pat1, 1, 1000, 0, 'draft');
insert into public.invoice_items (invoice_id, description, quantity, unit_price) values (:invC, 'A', 1, 1000);
update public.invoices set discount_amount = 0 where id = :invC;
delete from public.invoice_items where invoice_id = :invC;
insert into public.invoice_items (invoice_id, description, quantity, unit_price) values (:invC, 'B', 1, 10000);
update public.invoices set discount_amount = 4000, discount_reason = 'family' where id = :invC;
select pg_temp.check((select status::text from public.invoices where id = :invC) = 'pending_approval', 'an edited retry over the cap waits for approval');
select pg_temp.check((select count(*) from public.discount_requests where invoice_id = :invC and status = 'pending' and discount_amount = 4000) = 1, 'with exactly one request, for the new amount');

-- A first save over the cap: the header goes in as pending_approval at once. If the connection drops before the lines, the retry
-- must be able to add them to that same invoice (and must not be able to issue it).
insert into public.invoices (id, patient_id, branch_id, subtotal, discount_amount, discount_reason, status) values (:invD, :pat1, 1, 4000, 2000, 'big', 'draft');
select pg_temp.check((select status::text from public.invoices where id = :invD) = 'pending_approval', 'a header over the cap is pending approval from the moment it is inserted');
select pg_temp.check((select count(*) from public.discount_requests where invoice_id = :invD and status = 'pending' and discount_amount = 2000) = 1, 'and its request carries the discount asked for');
insert into public.invoice_items (invoice_id, description, quantity, unit_price) values (:invD, 'Scaling', 1, 3000), (:invD, 'X-ray', 2, 500);
select pg_temp.check((select (count(*), sum(line_total)) = (2, 4000) from public.invoice_items where invoice_id = :invD), 'front desk can add the lines to their own pending invoice afterwards');
select pg_temp.check((select (subtotal, status::text) = (4000, 'pending_approval') from public.invoices where id = :invD), 'which keeps it pending, with the same subtotal');
select pg_temp.expect_error(format($f$update public.invoices set status = 'issued' where id = %L$f$, :invD), 'waiting for discount approval', 'front desk cannot issue it; only an approver can');
select pg_temp.check((select count(*) from public.discount_requests where invoice_id = :invD) = 1, 'and no second request was raised along the way');

-- The same for an installment plan: edited retry rewrites the plan and its installments so they add up.
insert into public.payment_plans (id, patient_id, total_fee, starts_on) values (:planA, :pat2, 70000, '2026-10-07');
update public.payment_plans set total_fee = 60000, starts_on = '2026-10-08', notes = 'edited' where id = :planA;
delete from public.plan_installments where plan_id = :planA;
insert into public.plan_installments (plan_id, due_date, amount) values (:planA, '2026-11-08', 30000), (:planA, '2026-12-08', 30000);
select pg_temp.check((select (p.total_fee, p.notes, (select sum(amount) from public.plan_installments where plan_id = p.id)) = (60000, 'edited', 60000) from public.payment_plans p where p.id = :planA),
  'plan: an edited retry rewrites the plan and its installments so they add up');
reset role;

-- ================================================================= how the new functions are set up
select pg_temp.check((select count(*) from pg_proc where pronamespace = 'public'::regnamespace
    and proname in ('save_invoice', 'save_installment_plan', 'payments_summary', 'opd_summary', 'total_dues') and not prosecdef) = 5,
  'all five new functions are SECURITY INVOKER (row-level security decides, as for the requests the website already made)');
select pg_temp.check((select prosecdef from pg_proc where pronamespace = 'public'::regnamespace and proname = 'invoice_before_write'), 'invoice_before_write is still SECURITY DEFINER');
select pg_temp.check(not has_function_privilege('anon', 'public.invoice_before_write()', 'execute') and not has_function_privilege('authenticated', 'public.invoice_before_write()', 'execute'),
  'and nobody can call it directly (the grants of 20261005000700 survive the migration)');
select pg_temp.check(not has_function_privilege('anon', 'public.save_invoice(uuid, jsonb, jsonb)', 'execute') and has_function_privilege('authenticated', 'public.save_invoice(uuid, jsonb, jsonb)', 'execute'),
  'only signed-in users may call save_invoice');
select pg_temp.check((select relrowsecurity from pg_class where oid = 'public.idempotency_keys'::regclass), 'idempotency_keys has row-level security on');

-- ================================================================= photos.thumb_path (the small copy of a photo) and who can read it
select pg_temp.check((select data_type = 'text' and is_nullable = 'YES' from information_schema.columns
    where table_schema = 'public' and table_name = 'photos' and column_name = 'thumb_path'),
  'photos.thumb_path exists and is nullable text (photos uploaded before keep NULL and show the original)');
select pg_temp.check(col_description('public.photos'::regclass, (select attnum from pg_attribute where attrelid = 'public.photos'::regclass and attname = 'thumb_path')) like '%thumbs%',
  'photos.thumb_path has a comment saying what it holds');
-- A copy is stored at <patient>/<raw|edited>/thumbs/<file>.jpg. The storage policies read only the first two folders, so it
-- must be readable by exactly the people who can read its photo, with no new policy.
insert into storage.objects (bucket_id, name) values
  ('clinic-photos', :pat1 || '/edited/2001-04-01_Front_aa.jpg'), ('clinic-photos', :pat1 || '/edited/thumbs/2001-04-01_Front_aa.jpg'),
  ('clinic-photos', :pat1 || '/raw/2001-04-01_Front_bb.jpg'),    ('clinic-photos', :pat1 || '/raw/thumbs/2001-04-01_Front_bb.jpg'),
  ('clinic-photos', :pat2 || '/edited/2001-04-01_Front_cc.jpg'), ('clinic-photos', :pat2 || '/edited/thumbs/2001-04-01_Front_cc.jpg');
select pg_temp.act_as(:portal1);
set role authenticated;
select pg_temp.check((select count(*) from storage.objects where name like '%2001-04-01%') = 2
    and (select count(*) from storage.objects where name = (current_setting('test.pat1') || '/edited/thumbs/2001-04-01_Front_aa.jpg')) = 1,
  'a patient reads their own edited photo and its thumbnail, and nothing else: not their raw ones, not another patient''s');
reset role;
select pg_temp.act_as(:fd);
set role authenticated;
select pg_temp.check((select count(*) from storage.objects where name like '%/edited/%2001-04-01%') = 4
    and (select count(*) from storage.objects where name like '%/raw/%2001-04-01%') = 0,
  'staff who may see patient profiles but not raw photos read every edited photo and thumbnail, and no raw photo or raw thumbnail');
select pg_temp.expect_error(format($f$insert into storage.objects (bucket_id, name) values ('clinic-photos', %L)$f$, current_setting('test.pat1') || '/edited/thumbs/2001-04-01_Front_dd.jpg'),
  'row-level security', 'and without photos.upload they cannot store a thumbnail either');
reset role;
select pg_temp.act_as(:doc);
set role authenticated;
select pg_temp.check((select count(*) from storage.objects where name like '%2001-04-01%') = 6, 'staff with raw-photo access read all six files, raw thumbnails included');
insert into storage.objects (bucket_id, name) values ('clinic-photos', current_setting('test.pat1') || '/raw/thumbs/2001-04-01_Front_ee.jpg');
insert into public.photos (patient_id, kind, storage_path, thumb_path)
  values (:pat1, 'raw', current_setting('test.pat1') || '/raw/2001-04-01_Front_ee.png', current_setting('test.pat1') || '/raw/thumbs/2001-04-01_Front_ee.jpg');
select pg_temp.check((select thumb_path from public.photos where storage_path like '%2001-04-01_Front_ee.png') like '%/raw/thumbs/2001-04-01_Front_ee.jpg',
  'a doctor (photos.upload) stores the thumbnail and saves the photo row with its thumb_path');
insert into public.photos (patient_id, kind, storage_path) values (:pat1, 'raw', current_setting('test.pat1') || '/raw/2001-04-01_Front_ff.jpg');
select pg_temp.check((select thumb_path is null from public.photos where storage_path like '%2001-04-01_Front_ff.jpg'),
  'and a photo saved without a copy (an old photo, or a file the browser could not shrink) simply has no thumb_path');
reset role;
rollback;

-- ================================================================= running the migration a second time
-- (create or replace / if not exists / drop policy if exists: it says it is safe to run again.)
-- The migration commits, so it cannot run inside the transaction above (that one is rolled back, fixtures and all). Run it again
-- first, then seed a small fixture and check the functions against hand-counted numbers: on an empty database they would answer
-- 0 and 0 whatever the second run had done to them.
\ir ../migrations/20261007002000_audit_fixes.sql
begin;
-- Dues owed before this block adds any (earlier tests may leave patients behind).
select set_config('test.dues_before', public.total_dues()::text, false);
insert into auth.users (id, email) values (:admin, 'admin23@dralirashid.com');
insert into public.staff (id, full_name, email, role, restrict_to_branches, branch_ids) values
  (:admin, 'Admin', 'admin23@dralirashid.com', 'admin', false, '{}');
insert into public.patients (id, mr_number, full_name, phone, first_branch_id) values
  (:pat1, '23001', 'Audit Patient One', '03002300001', 1), (:pat2, '23002', 'Audit Patient Two', '03002300002', 2);
-- Dated February 2001 (no other test uses it) and every query names that month. Payments: cash / card / bank, a refund,
-- and rows either side of Karachi midnight (UTC+5).
insert into public.payments (patient_id, branch_id, amount, method, received_at) values
  (:pat1, 1, 3000, 'cash',          '2001-02-05 18:59:59+00'),   -- 23:59:59 on 5 February in Karachi
  (:pat1, 1, 2000, 'card',          '2001-02-05 19:00:00+00'),   -- 00:00:00 on 6 February
  (:pat1, 1, 4500, 'bank_transfer', '2001-02-06 08:00:00+00'),
  (:pat1, 1, -500, 'cash',          '2001-02-06 09:00:00+00'),   -- a refund
  (:pat2, 2, 800,  'cash',          '2001-03-15 10:00:00+00');   -- an advance from a patient who owes nothing: in March, so in no February total
-- Visits: waits of 20 and 50 minutes, a no-show, and one that started before it checked in (no wait).
insert into public.visits (patient_id, branch_id, visit_date, status, checked_in_at, started_at) values
  (:pat1, 1, '2001-02-06', 'completed', '2001-02-06 05:00:00+00', '2001-02-06 05:20:00+00'),
  (:pat1, 1, '2001-02-06', 'completed', '2001-02-06 06:00:00+00', '2001-02-06 06:50:00+00'),
  (:pat1, 1, '2001-02-07', 'no_show',   null, null),
  (:pat1, 1, '2001-02-06', 'completed', '2001-02-06 07:00:00+00', '2001-02-06 06:30:00+00');
-- Patient One billed 12,000 and paid 9,000 net, so owes 3,000; patient two paid ahead and owes nothing.
insert into public.invoices (invoice_no, patient_id, branch_id, status) values ('T23-3', :pat1, 1, 'issued');
insert into public.invoice_items (invoice_id, description, quantity, unit_price)
  select id, 'Treatment', 1, 12000 from public.invoices where invoice_no = 'T23-3';
select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
do $$
begin
  if (select array_agg(column_name::text order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'idempotency_keys')
     is distinct from array['key', 'kind', 'result_id', 'request_hash', 'created_by', 'created_at'] then
    raise exception 'TEST FAILED: after a second run idempotency_keys has different columns';
  end if;
  raise notice 'ok - second run: idempotency_keys has the same columns';
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'idempotency_keys') <> 1 then
    raise exception 'TEST FAILED: after a second run idempotency_keys does not have exactly one policy';
  end if;
  raise notice 'ok - second run: still one policy on idempotency_keys';
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
        and proname in ('save_invoice', 'save_installment_plan', 'payments_summary', 'opd_summary', 'total_dues')) <> 5 then
    raise exception 'TEST FAILED: after a second run there is not exactly one of each new function';
  end if;
  raise notice 'ok - second run: still one of each of the five functions';
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'photos' and column_name = 'thumb_path' and data_type = 'text') <> 1 then
    raise exception 'TEST FAILED: after a second run photos does not have exactly one text column thumb_path';
  end if;
  raise notice 'ok - second run: photos.thumb_path is still there, once';
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
        and proname in ('save_invoice', 'save_installment_plan', 'payments_summary', 'opd_summary', 'total_dues') and not prosecdef) <> 5 then
    raise exception 'TEST FAILED: after a second run the five new functions are not all SECURITY INVOKER';
  end if;
  raise notice 'ok - second run: the five functions are still SECURITY INVOKER';
  perform pg_temp.check(public.payments_summary('2001-02-01', '2001-02-28', null, null)->'totals'
      = '{"received": 9500, "cash": 3000, "card": 2000, "bank": 4500, "refunds": 500, "net": 9000, "count": 4}'::jsonb,
    'second run: payments_summary still adds up the fixture (4 payments, one refund)');
  perform pg_temp.check((select jsonb_array_length(r->'byDay') = 2 and r->'byDay'->0->>'day' = '2001-02-06' and (r->'byDay'->0->>'net')::numeric = 6000
        and (r->'byDay'->1->>'cash')::numeric = 3000 and jsonb_array_length(r->'byMethod') = 3
      from (select public.payments_summary('2001-02-01', '2001-02-28', null, null) r) x),
    'second run: and still splits them by Karachi day (23:59:59 on the 5th, 00:00:00 on the 6th) and by method');
  perform pg_temp.check(public.opd_summary('2001-02-01', '2001-02-28', null)
      = '{"totals": {"visits": 4, "completed": 3, "no_shows": 1, "cancelled": 0, "waited": 2, "wait_min_total": 70, "avg_wait_min": 35, "patients": 1},
          "byDay": [{"day": "2001-02-07", "branch_id": 1, "visits": 1, "completed": 0, "no_shows": 1, "cancelled": 0, "waited": 0, "wait_min_total": 0, "avg_wait_min": null},
                    {"day": "2001-02-06", "branch_id": 1, "visits": 3, "completed": 3, "no_shows": 0, "cancelled": 0, "waited": 2, "wait_min_total": 70, "avg_wait_min": 35}],
          "waitByBranch": [{"branch_id": 1, "waited": 2, "wait_min_total": 70, "avg_wait_min": 35, "long": 1}]}'::jsonb,
    'second run: opd_summary still gives the hand-counted visits and waits (the visit that started before it checked in has no wait)');
  perform pg_temp.check(public.total_dues() = current_setting('test.dues_before')::numeric + 3000, 'second run: total_dues still adds the one patient who owes (3,000), and the other patient''s advance does not offset it');
end $$;
reset role;
rollback;
