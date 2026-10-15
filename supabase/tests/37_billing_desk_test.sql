-- The billing desk (20261015000900_billing_desk.sql): a discount and "Performed by" per invoice line (save_invoice keeps them, the
-- invoice's discount includes the lines' discounts), the price list (treatments.price_list), edit_invoice (lines, discounts and note of
-- an issued invoice, with the discount limits and their approval), editing a payment (method, amount, time, note), the coordinator's
-- billing.edit, and billing.edit reading the invoices, lines and payments of its branches. Every edit is in the audit log.
\set ON_ERROR_STOP 1
\set admin  '''00000000-0000-0000-0000-000000003700'''
\set fd     '''00000000-0000-0000-0000-000000003701'''
\set acc    '''00000000-0000-0000-0000-000000003702'''
\set coord  '''00000000-0000-0000-0000-000000003703'''
\set doced  '''00000000-0000-0000-0000-000000003704'''
\set pat1   '''00000000-0000-0000-0000-000000003711'''
\set pat2   '''00000000-0000-0000-0000-000000003712'''

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
create or replace function pg_temp.k37(n int) returns uuid language sql immutable as $$
  select ('37373737-3737-4737-8737-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function pg_temp.hdr37(patient uuid, branch int, discount numeric default 0, why text default null) returns jsonb language sql immutable as $$
  select jsonb_build_object('patient_id', patient, 'branch_id', branch, 'visit_id', null, 'discount_amount', discount, 'discount_reason', why, 'notes', null) $$;
-- A line as the invoice form sends it: what, how many, the rate, the line's discount in rupees, the price-list item and who did it.
create or replace function pg_temp.ln37(descr text, qty numeric, price numeric, p_off numeric default 0, p_treat int default null, p_doc uuid default null) returns jsonb language sql immutable as $$
  select jsonb_build_object('description', descr, 'quantity', qty, 'unit_price', price, 'discount_amount', p_off, 'treatment_id', p_treat, 'clinician_id', p_doc) $$;
create or replace function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, false) $$;
create or replace function pg_temp.audits(t text, row_id text, act text) returns bigint language sql as $$
  select count(*) from public.audit_log where table_name = t and (row_id is null or audit_log.row_id = row_id) and action = act $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

-- Run the migration again first: it must be safe to run twice (it commits, so it runs before the transaction below). It also puts back
-- its save_invoice after 36_invoice_note_test.sql ran 20261015000800 again.
\ir ../migrations/20261015000900_billing_desk.sql

begin;
-- The columns, the grid and the policies.
select pg_temp.check((select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'invoice_items'
                       and column_name in ('discount_amount', 'clinician_id')) = 2, 'invoice_items has discount_amount and clinician_id');
select pg_temp.check((select column_default from information_schema.columns where table_schema = 'public' and table_name = 'treatments' and column_name = 'price_list') = 'false',
  'treatments.price_list is there, false unless set');
select pg_temp.check(not exists (select 1 from public.treatments where price_list), 'no price list in the repository: every seeded treatment is a visit type');
select pg_temp.check((select string_agg(role::text || '=' || allowed::text, ',' order by role::text) from public.role_permissions where permission_key = 'billing.edit')
                      = 'accountant=true,admin=true,assistant=false,coordinator=true,doctor=false,front_desk=false',
  'billing.edit: the coordinator now, with the accountant and Dr. Ali; front desk, assistant and doctor still no');
select pg_temp.check((select count(*) from pg_policies where schemaname = 'public' and policyname in ('editors view invoices', 'editors view invoice items', 'editors view payments')) = 3,
  'the three "editors view" policies are there (once each, after running the migration twice)');

select set_config('test.pat1', :pat1, false), set_config('test.pat2', :pat2, false), set_config('test.fd', :fd, false), set_config('test.acc', :acc, false),
       set_config('test.coord', :coord, false), set_config('test.doced', :doced, false), set_config('test.admin', :admin, false);
insert into auth.users (id, email) values (:admin, 'admin37@dralirashid.com'), (:fd, 'fd37@dralirashid.com'), (:acc, 'acc37@dralirashid.com'),
  (:coord, 'coord37@dralirashid.com'), (:doced, 'doced37@dralirashid.com');
insert into public.staff (id, full_name, email, role, restrict_to_branches, branch_ids) values
  (:admin, 'Admin 37', 'admin37@dralirashid.com', 'admin', false, '{}'),
  (:fd,    'Front Desk 37', 'fd37@dralirashid.com', 'front_desk', false, '{}'),
  (:acc,   'Accountant 37', 'acc37@dralirashid.com', 'accountant', false, '{}'),
  (:coord, 'Coordinator 37', 'coord37@dralirashid.com', 'coordinator', false, '{}'),
  -- a doctor who was given "Edit or void invoices" for one branch only: neither billing.view nor billing.create, so whatever they read
  -- of the money comes from the "editors view" policies
  (:doced, 'Doctor Editor 37', 'doced37@dralirashid.com', 'doctor', true, '{1}');
insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (:doced, 'billing.edit', true);
insert into public.patients (id, mr_number, full_name, phone, first_branch_id) values
  (:pat1, '37001', 'Billing Desk One', '03003700001', 1), (:pat2, '37002', 'Billing Desk Two', '03003700002', 2);
insert into public.treatments (name, category, default_price, price_list, sort_order) values ('Braces Kit (Sample T37)', 'braces', 50000, true, 1);
select set_config('test.kit', (select id::text from public.treatments where name = 'Braces Kit (Sample T37)'), false);
select set_config('test.doc', (select id::text from public.clinicians where is_doctor order by display_name limit 1), false);
select pg_temp.check((select price_list from public.treatments where name = 'Braces Kit (Sample T37)')
                     and not (select price_list from public.treatments where name = 'Monthly'), 'a price-list item and a visit type side by side');
-- The price list is for staff: a visitor of the website (or a patient) reads the visit types, not the price list.
select pg_temp.act_as('');
set role anon;
select pg_temp.check(exists (select 1 from public.treatments where name = 'Monthly') and not exists (select 1 from public.treatments where price_list),
  'not signed in: the visit types, no price-list item');
reset role;
select pg_temp.act_as(:fd);
set role authenticated;
select pg_temp.check(exists (select 1 from public.treatments where name = 'Braces Kit (Sample T37)'), 'staff read the price list');
reset role;

select pg_temp.act_as(:fd);
set role authenticated;
do $$
declare
  pat1 uuid := current_setting('test.pat1')::uuid;
  kit int := current_setting('test.kit')::int;
  doc uuid := current_setting('test.doc')::uuid;
  inv jsonb;
  it jsonb;
begin
  -- Two lines: the kit with Rs 2,000 off it, done by a doctor, and two brackets; then Rs 500 off the total. The invoice's discount is
  -- the whole Rs 2,500 (the form adds the lines' discounts to the total's), so the total, the limits and reports read one column.
  inv := public.save_invoice(pg_temp.k37(1), pg_temp.hdr37(pat1, 1, 2500, 'Sibling offer'),
    jsonb_build_array(pg_temp.ln37('Braces Kit (Sample T37)', 1, 50000, 2000, kit, doc), pg_temp.ln37('Bracket', 2, 1000)));
  perform pg_temp.check((inv->>'subtotal')::numeric = 52000 and (inv->>'discount_amount')::numeric = 2500 and (inv->>'total')::numeric = 49500,
    'two lines with a line discount and a total discount: sub-total 52,000, discount 2,500, grand total 49,500');
  perform pg_temp.check(inv->>'status' = 'issued', 'Rs 2,500 (4.8%) is within the front desk''s limit (10%, Rs 5,000): issued');
  perform pg_temp.check(public.save_invoice(pg_temp.k37(1), pg_temp.hdr37(pat1, 1, 2500, 'Sibling offer'),
    jsonb_build_array(pg_temp.ln37('Braces Kit (Sample T37)', 1, 50000, 2000, kit, doc), pg_temp.ln37('Bracket', 2, 1000)))->>'id' = inv->>'id',
    'the same key again: the same invoice');
  select x into it from jsonb_array_elements(inv->'items') x where x->>'description' = 'Braces Kit (Sample T37)';
  perform pg_temp.check((it->>'discount_amount')::numeric = 2000 and (it->>'treatment_id')::int = kit and (it->>'clinician_id')::uuid = doc,
    'the kit''s line keeps its discount, its price-list item and who did it');
  select x into it from jsonb_array_elements(inv->'items') x where x->>'description' = 'Bracket';
  perform pg_temp.check((it->>'discount_amount')::numeric = 0 and it->>'clinician_id' is null and (it->>'line_total')::numeric = 2000,
    'the other line: no discount, nobody recorded, its amount 2 x 1,000');
  perform pg_temp.check((select count(*) from public.invoice_items where invoice_id = (inv->>'id')::uuid) = 2, 'one invoice, two lines (the retry added nothing)');
  perform set_config('test.inv1', inv->>'id', false);

  perform pg_temp.expect_error(format($f$select public.save_invoice(%L, %L, %L)$f$, pg_temp.k37(2), pg_temp.hdr37(pat1, 1, 1000, 'x'),
    jsonb_build_array(pg_temp.ln37('Kit', 1, 50000, 2000))), 'more than the invoice''s discount', 'lines'' discounts above the invoice''s discount are refused');
  perform pg_temp.expect_error(format($f$select public.save_invoice(%L, %L, %L)$f$, pg_temp.k37(3), pg_temp.hdr37(pat1, 1, 3000, 'x'),
    jsonb_build_array(pg_temp.ln37('Bracket', 1, 1000, 3000))), 'invoice_items_discount_check', 'a line''s discount above that line''s amount is refused');
  perform pg_temp.check((public.save_invoice(pg_temp.k37(4), pg_temp.hdr37(pat1, 1),
    jsonb_build_array(jsonb_build_object('description', 'Checkup', 'quantity', 1, 'unit_price', 1500)))->>'total')::numeric = 1500,
    'an older page (no line discount, item or doctor) still saves');
end $$;

-- A payment of Rs 10,000 cash on it (front desk takes payments).
insert into public.payments (patient_id, branch_id, amount, method, invoice_id) values (:pat1, 1, 10000, 'cash', current_setting('test.inv1')::uuid);
select set_config('test.pay1', (select id::text from public.payments where invoice_id = current_setting('test.inv1')::uuid), false);
-- The front desk cannot edit: no edit_invoice, and a payment update changes nothing.
select pg_temp.expect_error(format($f$select public.edit_invoice(%L, %L, %L)$f$, current_setting('test.inv1'), pg_temp.hdr37(current_setting('test.pat1')::uuid, 1),
  jsonb_build_array(pg_temp.ln37('Bracket', 1, 1000))), 'NOT_ALLOWED', 'front desk: no edit_invoice (billing.edit only)');
update public.payments set method = 'card' where id = current_setting('test.pay1')::uuid;
select pg_temp.check((select method::text from public.payments where id = current_setting('test.pay1')::uuid) = 'cash', 'front desk: a payment update changes nothing');

-- The accountant: the payment was card, not cash; and the time and note are corrected. Who took it cannot be changed.
reset role;
select set_config('test.audit_pay_before', pg_temp.audits('payments', current_setting('test.pay1'), 'UPDATE')::text, false);
select pg_temp.act_as(:acc);
set role authenticated;
update public.payments set method = 'card', notes = 'Card, not cash' where id = current_setting('test.pay1')::uuid;
select pg_temp.check((select method::text || '/' || notes from public.payments where id = current_setting('test.pay1')::uuid) = 'card/Card, not cash',
  'accountant: the payment is now card, with a note');
update public.payments set received_at = received_at - interval '1 hour' where id = current_setting('test.pay1')::uuid;
select pg_temp.check((select count(*) from public.payments where id = current_setting('test.pay1')::uuid and received_at < now() - interval '59 minutes') = 1,
  'accountant: the time can be corrected (billing.edit)');
select pg_temp.expect_error(format($f$update public.payments set received_by = %L where id = %L$f$, current_setting('test.coord'), current_setting('test.pay1')),
  'cannot be changed', 'nobody but Dr. Ali changes who took a payment');
reset role;
select pg_temp.check(pg_temp.audits('payments', current_setting('test.pay1'), 'UPDATE') = current_setting('test.audit_pay_before')::bigint + 2,
  'both changes are in the audit log');
select pg_temp.check(exists (select 1 from public.audit_log where table_name = 'payments' and row_id = current_setting('test.pay1') and action = 'UPDATE'
                              and old_data ->> 'method' = 'cash' and new_data ->> 'method' = 'card' and actor = current_setting('test.acc')::uuid),
  'the audit log has cash -> card, and who changed it');

-- The coordinator (billing.edit since this migration): edits a payment and an invoice; a refund is not theirs to make.
select pg_temp.act_as(:coord);
set role authenticated;
select pg_temp.check(public.has_perm('billing.edit') and not public.has_perm('billing.refund') and not public.has_perm('discount.approve'),
  'the coordinator has billing.edit (not refunds, not discount approval)');
update public.payments set method = 'bank_transfer' where id = current_setting('test.pay1')::uuid;
select pg_temp.check((select method::text from public.payments where id = current_setting('test.pay1')::uuid) = 'bank_transfer', 'coordinator: card -> online');
select pg_temp.expect_error(format($f$update public.payments set amount = -10000 where id = %L$f$, current_setting('test.pay1')),
  'Give refunds', 'coordinator: cannot turn a payment into a refund (billing.refund)');
do $$
declare
  inv uuid := current_setting('test.inv1')::uuid;
  pat1 uuid := current_setting('test.pat1')::uuid;
  kit int := current_setting('test.kit')::int;
  doc uuid := current_setting('test.doc')::uuid;
  out jsonb;
  before_items bigint;
  before_inv bigint;
begin
  -- Only the note: the lines are left as they are (no line is deleted and added again).
  before_items := (select count(*) from public.audit_log where table_name = 'invoice_items');
  out := public.edit_invoice(inv, pg_temp.hdr37(pat1, 1, 2500, 'Sibling offer') || jsonb_build_object('notes', 'Second payment next month'),
    jsonb_build_array(pg_temp.ln37('Bracket', 2, 1000), pg_temp.ln37('Braces Kit (Sample T37)', 1, 50000, 2000, kit, doc)));
  perform pg_temp.check(out->>'notes' = 'Second payment next month' and (out->>'total')::numeric = 49500 and out->>'status' = 'issued',
    'coordinator: the note changes, the totals and the status stay');
  perform pg_temp.check((select count(*) from public.audit_log where table_name = 'invoice_items') = before_items, 'the same lines (in another order) are not rewritten');
  -- A line changed: three brackets, not two (a bigger sub-total, the same discount: a smaller share, so no approval is asked).
  out := public.edit_invoice(inv, pg_temp.hdr37(pat1, 1, 2500, 'Sibling offer') || jsonb_build_object('notes', 'Second payment next month'),
    jsonb_build_array(pg_temp.ln37('Braces Kit (Sample T37)', 1, 50000, 2000, kit, doc), pg_temp.ln37('Bracket', 3, 1000)));
  perform pg_temp.check((out->>'subtotal')::numeric = 53000 and (out->>'discount_amount')::numeric = 2500 and (out->>'total')::numeric = 50500 and out->>'status' = 'issued',
    'coordinator: three brackets: sub-total 53,000, the discount as it was, grand total 50,500, still issued');
  perform pg_temp.check((select count(*) from public.invoice_items where invoice_id = inv) = 2
                        and (select discount_amount from public.invoice_items where invoice_id = inv and description = 'Braces Kit (Sample T37)') = 2000,
    'two lines, the kit keeping its discount');
  -- The same edit again (a slow line): nothing changes.
  before_items := (select count(*) from public.audit_log where table_name = 'invoice_items');
  before_inv := (select count(*) from public.audit_log where table_name = 'invoices' and row_id = inv::text);
  out := public.edit_invoice(inv, pg_temp.hdr37(pat1, 1, 2500, 'Sibling offer') || jsonb_build_object('notes', 'Second payment next month'),
    jsonb_build_array(pg_temp.ln37('Braces Kit (Sample T37)', 1, 50000, 2000, kit, doc), pg_temp.ln37('Bracket', 3, 1000)));
  perform pg_temp.check((select count(*) from public.audit_log where table_name = 'invoice_items') = before_items
                        and (select count(*) from public.audit_log where table_name = 'invoices' and row_id = inv::text) = before_inv,
    'the same edit sent twice changes nothing the second time');
  perform pg_temp.expect_error(format($f$select public.edit_invoice(%L, %L, %L)$f$, inv, pg_temp.hdr37(pat1, 1, 0), jsonb_build_array(pg_temp.ln37('Kit', 1, 50000, 2000))),
    'more than the invoice''s discount', 'edit: lines'' discounts above the invoice''s discount are refused');
  -- A bigger discount: the coordinator has no limit set, so it goes to the accountant or Dr. Ali for approval, with a request.
  out := public.edit_invoice(inv, pg_temp.hdr37(pat1, 1, 5000, 'Sibling offer'),
    jsonb_build_array(pg_temp.ln37('Braces Kit (Sample T37)', 1, 50000, 2000, kit, doc), pg_temp.ln37('Bracket', 3, 1000)));
  perform pg_temp.check(out->>'status' = 'pending_approval' and (out->>'discount_amount')::numeric = 5000, 'coordinator: a bigger discount waits for approval');
  perform pg_temp.check(exists (select 1 from public.discount_requests where invoice_id = inv and status = 'pending' and discount_amount = 5000), 'and the approval request is raised');
  perform pg_temp.expect_error(format($f$select public.edit_invoice(%L, %L, %L)$f$, inv, pg_temp.hdr37(pat1, 1, 2500, 'x'), jsonb_build_array(pg_temp.ln37('Bracket', 1, 1000))),
    'waiting for approval', 'an invoice waiting for approval is not changed until the discount is decided');
end $$;

-- The accountant approves the discount; afterwards the coordinator may lower it but not raise it.
reset role;
select pg_temp.act_as(:acc);
set role authenticated;
select public.decide_discount((select id from public.discount_requests where invoice_id = current_setting('test.inv1')::uuid and status = 'pending'), true);
select pg_temp.act_as(:coord);
select pg_temp.expect_error(format($f$select public.edit_invoice(%L, %L, %L)$f$, current_setting('test.inv1'), pg_temp.hdr37(current_setting('test.pat1')::uuid, 1, 6000, 'more'),
  jsonb_build_array(pg_temp.ln37('Braces Kit (Sample T37)', 1, 50000), pg_temp.ln37('Bracket', 1, 1000))), 'was approved', 'an approved discount cannot be made bigger without an approver');
select pg_temp.check((public.edit_invoice(current_setting('test.inv1')::uuid, pg_temp.hdr37(current_setting('test.pat1')::uuid, 1, 1000, 'Sibling offer'),
  jsonb_build_array(pg_temp.ln37('Braces Kit (Sample T37)', 1, 50000), pg_temp.ln37('Bracket', 1, 1000))))->>'status' = 'issued',
  'a smaller discount needs no approval: still issued');
-- A line taken off with the same discount is a bigger share of a smaller sub-total (Rs 1,000 of 50,000 against 1,000 of 51,000): over
-- the coordinator's limit (none set), it waits for approval again.
select pg_temp.check((public.edit_invoice(current_setting('test.inv1')::uuid, pg_temp.hdr37(current_setting('test.pat1')::uuid, 1, 1000, 'Sibling offer'),
  jsonb_build_array(pg_temp.ln37('Braces Kit (Sample T37)', 1, 50000))))->>'status' = 'pending_approval',
  'the same discount on a smaller sub-total waits for approval');

-- The doctor given billing.edit for branch 1 only: reads and edits there (the "editors view" policies), nothing at branch 2.
reset role;
select pg_temp.act_as(:fd);
set role authenticated;
select set_config('test.inv2', public.save_invoice(pg_temp.k37(5), pg_temp.hdr37(current_setting('test.pat2')::uuid, 2), jsonb_build_array(pg_temp.ln37('Checkup', 1, 1500)))->>'id', false);
insert into public.payments (patient_id, branch_id, amount, method, invoice_id) values (current_setting('test.pat2')::uuid, 2, 1500, 'cash', current_setting('test.inv2')::uuid);
select pg_temp.act_as(:doced);
select pg_temp.check(not public.has_perm('billing.view') and not public.has_perm('billing.create') and public.has_perm('billing.edit'), 'the doctor editor has billing.edit only');
select pg_temp.check(exists (select 1 from public.invoices where id = current_setting('test.inv1')::uuid)
                     and exists (select 1 from public.invoice_items where invoice_id = current_setting('test.inv1')::uuid)
                     and exists (select 1 from public.payments where id = current_setting('test.pay1')::uuid),
  'billing.edit reads the invoice, its lines and its payment at their branch');
select pg_temp.check(not exists (select 1 from public.invoices where id = current_setting('test.inv2')::uuid)
                     and not exists (select 1 from public.payments where invoice_id = current_setting('test.inv2')::uuid),
  'and nothing at a branch they do not work at');
select pg_temp.expect_error(format($f$select public.edit_invoice(%L, %L, %L)$f$, current_setting('test.inv2'), pg_temp.hdr37(current_setting('test.pat2')::uuid, 2),
  jsonb_build_array(pg_temp.ln37('Checkup', 1, 1000))), 'not found', 'edit_invoice at another branch: not there for them');
update public.payments set method = 'card' where invoice_id = current_setting('test.inv2')::uuid;
reset role;
select pg_temp.check((select method::text from public.payments where invoice_id = current_setting('test.inv2')::uuid) = 'cash', 'a payment at another branch: not changed');

-- A rejected discount takes the lines' discounts off with the invoice's, and it is not an approved discount: the coordinator then
-- changes the invoice's note without being refused, and putting the rejected discount back asks for approval again.
select pg_temp.act_as(:fd);
set role authenticated;
select set_config('test.inv3', public.save_invoice(pg_temp.k37(6), pg_temp.hdr37(current_setting('test.pat1')::uuid, 1, 20000, 'Family'),
  jsonb_build_array(pg_temp.ln37('Braces Kit (Sample T37)', 1, 50000, 20000, current_setting('test.kit')::int)))->>'id', false);
select pg_temp.check((select status::text from public.invoices where id = current_setting('test.inv3')::uuid) = 'pending_approval',
  'a line discount over the front desk''s limit waits for approval');
select pg_temp.act_as(:acc);
select public.decide_discount((select id from public.discount_requests where invoice_id = current_setting('test.inv3')::uuid and status = 'pending'), false);
select pg_temp.check((select status = 'issued' and discount_amount = 0 and total = 50000 from public.invoices where id = current_setting('test.inv3')::uuid),
  'rejected: no discount, the whole Rs 50,000 is the total');
select pg_temp.check((select sum(discount_amount) from public.invoice_items where invoice_id = current_setting('test.inv3')::uuid) = 0,
  'rejected: the line''s discount is taken off too (Edit would otherwise show it and save it again)');
select pg_temp.check(not public.invoice_discount_approved(current_setting('test.inv3')::uuid)
                     and (select discount_approved_by from public.invoices where id = current_setting('test.inv3')::uuid) is not null,
  'a rejected discount is not an approved one (although discount_approved_by is filled in)');
select pg_temp.act_as(:coord);
select pg_temp.check((public.edit_invoice(current_setting('test.inv3')::uuid, pg_temp.hdr37(current_setting('test.pat1')::uuid, 1) || jsonb_build_object('notes', 'Kit fitted'),
  jsonb_build_array(pg_temp.ln37('Braces Kit (Sample T37)', 1, 50000, 0, current_setting('test.kit')::int))))->>'notes' = 'Kit fitted',
  'after the rejection the coordinator changes the note (no "was approved" refusal)');
select pg_temp.check((public.edit_invoice(current_setting('test.inv3')::uuid, pg_temp.hdr37(current_setting('test.pat1')::uuid, 1, 20000, 'Family'),
  jsonb_build_array(pg_temp.ln37('Braces Kit (Sample T37)', 1, 50000, 20000, current_setting('test.kit')::int))))->>'status' = 'pending_approval',
  'the rejected discount put back waits for approval again');

-- A refund: its method or note is corrected by billing.edit; its amount only with "Give refunds".
reset role;
select pg_temp.act_as(:admin);
set role authenticated;
insert into public.payments (patient_id, branch_id, amount, method, invoice_id) values (current_setting('test.pat1')::uuid, 1, -2000, 'cash', null);
select set_config('test.refund', (select id::text from public.payments where patient_id = current_setting('test.pat1')::uuid and amount = -2000), false);
select pg_temp.act_as(:coord);
update public.payments set method = 'card', notes = 'Given back on the card' where id = current_setting('test.refund')::uuid;
select pg_temp.check((select method::text from public.payments where id = current_setting('test.refund')::uuid) = 'card', 'coordinator: a refund entered as cash is card now');
select pg_temp.expect_error(format($f$update public.payments set amount = -1000 where id = %L$f$, current_setting('test.refund')),
  'Give refunds', 'coordinator: a refund''s amount is for "Give refunds"');
select pg_temp.expect_error(format($f$update public.payments set amount = 2000 where id = %L$f$, current_setting('test.refund')),
  'Give refunds', 'coordinator: nor is turning a refund into a payment');

-- Whether a day's cash is closed: yes or no for billing.edit at their branches, nobody else.
reset role;
select pg_temp.act_as('');
insert into public.cash_closings (branch_id, closing_date, expected_cash, counted_cash, closed_by) values (1, date '2026-01-02', 5000, 5000, :fd);
select pg_temp.act_as(:coord);
set role authenticated;
select pg_temp.check(public.cash_day_closed(1::smallint, date '2026-01-02') and not public.cash_day_closed(1::smallint, date '2026-01-03'),
  'cash_day_closed: yes for a closed day, no for a day not closed');
select pg_temp.act_as(:fd);
select pg_temp.expect_error($q$select public.cash_day_closed(1::smallint, date '2026-01-02')$q$, 'NOT_ALLOWED', 'cash_day_closed: not for the front desk (no billing.edit)');
select pg_temp.act_as(:doced);
select pg_temp.expect_error($q$select public.cash_day_closed(2::smallint, date '2026-01-02')$q$, 'NOT_ALLOWED', 'cash_day_closed: not at a branch they do not work at');
reset role;

-- Void invoices stay as they are.
select pg_temp.act_as(:acc);
set role authenticated;
update public.invoices set status = 'void', void_reason = 'Test 37' where id = current_setting('test.inv2')::uuid;
select pg_temp.expect_error(format($f$select public.edit_invoice(%L, %L, %L)$f$, current_setting('test.inv2'), pg_temp.hdr37(current_setting('test.pat2')::uuid, 2),
  jsonb_build_array(pg_temp.ln37('Checkup', 1, 1000))), 'void', 'a void invoice is not changed');
reset role;
select pg_temp.check(pg_temp.audits('invoice_items', null, 'DELETE') > 0 and exists (select 1 from public.audit_log where table_name = 'invoices'
                      and row_id = current_setting('test.inv1') and action = 'UPDATE' and actor = current_setting('test.coord')::uuid),
  'the coordinator''s invoice edits are in the audit log');
rollback;
