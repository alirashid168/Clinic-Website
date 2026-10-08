-- =============================================================================
-- 2026-10-07 audit fixes: report totals in SQL, one-call invoice and
-- installment-plan saves, and idempotency keys for retried saves.
--
-- HOW TO APPLY
--   Supabase dashboard -> SQL Editor -> New query -> paste this whole file -> Run.
--   It is safe to run more than once (create or replace / if not exists).
--   With the Supabase CLI, keep the file name as it is: 20261007002000 sorts after the
--   last migration (20261007001900_login_log.sql), so `supabase db push` applies it in order.
--   (Pasting it in the SQL editor first and running `db push` later is fine: it can run twice.)
--
-- THE WEBSITE WORKS WITHOUT IT
--   js/data/supabase.js calls these functions and, while they are missing
--   (PostgREST answers PGRST202 / 404), falls back to the old behaviour: totals
--   added up in the browser from paged rows, and saves made in several steps.
--   Applying this file makes totals exact for any date range and makes invoice
--   and plan saves all-or-nothing and safe to retry.
--
-- SECURITY
--   Every function is SECURITY INVOKER: it runs as the signed-in person, so the
--   existing row-level security policies decide what it can read and write,
--   exactly as for the requests the website already makes. A total only adds up
--   rows that person could already download. Only signed-in users may call them.
--
-- RETRIES
--   A save carries a key made by the browser when the form opened. The same key
--   with the same details returns the record the first attempt created, so a
--   lost answer never produces a second invoice or plan. The same key with
--   DIFFERENT details raises IDEMPOTENCY_MISMATCH: the first attempt did commit,
--   and saving the edited form on top of it would bill the patient twice. If the
--   first attempt failed, nothing was saved (one transaction), the key is free,
--   and the edited retry creates the right record.
--
-- WHY THE TOTALS ARE NOT clinic_report()
--   clinic_report() answers by month, for finance.view only, with its own
--   definer rights. These totals are by day and branch (cash / card / bank,
--   refunds, waits), for anyone whose own row-level security shows the rows.
--
-- WHAT IT ASSUMES ABOUT THE SCHEMA (all seen in the website's own queries)
--   payments(id, patient_id, branch_id, amount, method, received_at timestamptz)
--   visits(id, visit_date date, branch_id, status, checked_in_at, started_at, patient_id)
--   patient_balances(patient_id, dues)                         -- existing view
--   invoices(id, patient_id, branch_id, visit_id, subtotal, discount_amount,
--            discount_reason, status)  -- status 'draft' -> 'issued'; existing
--            triggers still decide 'pending_approval' as before
--   invoice_items(invoice_id, description, quantity, unit_price)
--   payment_plans(id, patient_id, braces_case_id, total_fee, starts_on, notes, created_by)
--   plan_installments(plan_id, due_date, amount, note)
--   Column types are taken from the tables themselves (jsonb_populate_record),
--   and method/status are compared as text, so enum or text columns both work.
--
-- TO UNDO
--   drop function if exists public.payments_summary(date, date, bigint, text);
--   drop function if exists public.opd_summary(date, date, bigint);
--   drop function if exists public.total_dues();
--   drop function if exists public.save_invoice(uuid, jsonb, jsonb);
--   drop function if exists public.save_installment_plan(uuid, jsonb, jsonb);
--   drop table if exists public.idempotency_keys;
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Idempotency keys: one row per save the website made with a client-generated
--    key (crypto.randomUUID()). A retried save with the same key returns the
--    record the first attempt created instead of creating a second one.
-- -----------------------------------------------------------------------------
create table if not exists public.idempotency_keys (
  key         uuid primary key,
  kind        text not null,                       -- 'invoice' | 'plan'
  result_id   text,                                -- id of the record that save created
  request_hash text,                               -- md5 of the details that save was made with
  created_by  uuid not null default auth.uid(),
  created_at  timestamptz not null default now()
);
alter table public.idempotency_keys add column if not exists request_hash text;

alter table public.idempotency_keys enable row level security;

drop policy if exists idempotency_keys_own on public.idempotency_keys;
create policy idempotency_keys_own on public.idempotency_keys
  for all to authenticated
  using (created_by = auth.uid())
  with check (created_by = auth.uid());

revoke all on public.idempotency_keys from anon;
grant select, insert, update on public.idempotency_keys to authenticated;

-- -----------------------------------------------------------------------------
-- 2. save_invoice(key, invoice, items): invoice + lines + issue in ONE
--    transaction. Same steps as the website did before (draft, lines, then
--    'issued' if the insert left it a draft), so the existing triggers and
--    discount-approval rules behave exactly as they did.
--    Returns the invoice as JSON with its lines under "items".
-- -----------------------------------------------------------------------------
create or replace function public.save_invoice(p_idempotency_key uuid, p_invoice jsonb, p_items jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_head public.invoices%rowtype;
  v_inv  public.invoices%rowtype;
  v_subtotal numeric;
  v_prev text;
  v_prev_hash text;
  v_hash text;
  v_rows integer;
  v_out  jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'An invoice needs at least one line.';
  end if;

  -- jsonb text is normalised (key order, spacing), so the same details always give the same hash.
  v_hash := md5(jsonb_build_object('invoice', p_invoice, 'items', p_items)::text);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (key, kind, request_hash) values (p_idempotency_key, 'invoice', v_hash)
      on conflict (key) do nothing;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      -- Saved already (an earlier attempt whose answer never arrived): return that invoice,
      -- unless this retry carries different details (then the earlier invoice is NOT what was asked for).
      select k.result_id, k.request_hash into v_prev, v_prev_hash from public.idempotency_keys k
        where k.key = p_idempotency_key and k.kind = 'invoice';
      if v_prev is null then
        raise exception 'This invoice was already saved. Refresh the page to see it.';
      end if;
      select to_jsonb(inv) || jsonb_build_object('items', coalesce(
               (select jsonb_agg(to_jsonb(it)) from public.invoice_items it where it.invoice_id = inv.id), '[]'::jsonb))
        into v_out
        from public.invoices inv where inv.id::text = v_prev;
      if v_out is null then
        raise exception 'This invoice was already saved. Refresh the page to see it.';
      end if;
      if v_prev_hash is not null and v_prev_hash <> v_hash then
        raise exception 'IDEMPOTENCY_MISMATCH: an earlier attempt already saved invoice % with different details. Refresh the patient record and check it (void it if it is wrong) before saving again.', v_out->>'invoice_no';
      end if;
      return v_out;
    end if;
  end if;

  v_head := jsonb_populate_record(null::public.invoices, p_invoice);
  select coalesce(sum(coalesce(i.quantity, 1) * coalesce(i.unit_price, 0)), 0) into v_subtotal
    from jsonb_populate_recordset(null::public.invoice_items, p_items) i;

  insert into public.invoices (patient_id, branch_id, visit_id, subtotal, discount_amount, discount_reason, status)
  values (v_head.patient_id, v_head.branch_id, v_head.visit_id, v_subtotal,
          coalesce(v_head.discount_amount, 0), v_head.discount_reason, 'draft')
  returning * into v_inv;

  insert into public.invoice_items (invoice_id, description, quantity, unit_price)
  select v_inv.id, i.description, coalesce(i.quantity, 1), i.unit_price
    from jsonb_populate_recordset(null::public.invoice_items, p_items) i;

  if v_inv.status::text = 'draft' then
    update public.invoices set status = 'issued' where id = v_inv.id;
  end if;

  if p_idempotency_key is not null then
    update public.idempotency_keys set result_id = v_inv.id::text where key = p_idempotency_key;
  end if;

  select to_jsonb(inv) || jsonb_build_object('items', coalesce(
           (select jsonb_agg(to_jsonb(it)) from public.invoice_items it where it.invoice_id = inv.id), '[]'::jsonb))
    into v_out
    from public.invoices inv where inv.id = v_inv.id;
  return v_out;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. save_installment_plan(key, plan, installments): plan + installments in ONE
--    transaction. Returns the plan row as JSON (same as before).
-- -----------------------------------------------------------------------------
create or replace function public.save_installment_plan(p_idempotency_key uuid, p_plan jsonb, p_installments jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_head public.payment_plans%rowtype;
  v_plan public.payment_plans%rowtype;
  v_prev text;
  v_prev_hash text;
  v_hash text;
  v_rows integer;
  v_out  jsonb;
begin
  if p_installments is null or jsonb_typeof(p_installments) <> 'array' or jsonb_array_length(p_installments) = 0 then
    raise exception 'Add at least one installment to the plan.';
  end if;

  v_hash := md5(jsonb_build_object('plan', p_plan, 'installments', p_installments)::text);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (key, kind, request_hash) values (p_idempotency_key, 'plan', v_hash)
      on conflict (key) do nothing;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      select k.result_id, k.request_hash into v_prev, v_prev_hash from public.idempotency_keys k
        where k.key = p_idempotency_key and k.kind = 'plan';
      if v_prev is null then
        raise exception 'This plan was already saved. Refresh the page to see it.';
      end if;
      select to_jsonb(pp) into v_out from public.payment_plans pp where pp.id::text = v_prev;
      if v_out is null then
        raise exception 'This plan was already saved. Refresh the page to see it.';
      end if;
      if v_prev_hash is not null and v_prev_hash <> v_hash then
        raise exception 'IDEMPOTENCY_MISMATCH: an earlier attempt already saved this payment plan with different details. Refresh the patient record and check it (delete the plan if it is wrong) before saving again.';
      end if;
      return v_out;
    end if;
  end if;

  v_head := jsonb_populate_record(null::public.payment_plans, p_plan);

  insert into public.payment_plans (patient_id, braces_case_id, total_fee, starts_on, notes, created_by)
  values (v_head.patient_id, v_head.braces_case_id, v_head.total_fee,
          coalesce(v_head.starts_on, (now() at time zone 'Asia/Karachi')::date), v_head.notes, auth.uid())
  returning * into v_plan;

  insert into public.plan_installments (plan_id, due_date, amount, note)
  select v_plan.id, i.due_date, i.amount, i.note
    from jsonb_populate_recordset(null::public.plan_installments, p_installments) i;

  if p_idempotency_key is not null then
    update public.idempotency_keys set result_id = v_plan.id::text where key = p_idempotency_key;
  end if;

  return to_jsonb(v_plan);
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. payments_summary(from, to, branch, method): payment totals for a period,
--    by Karachi day. Returns
--    { totals: {received, cash, card, bank, refunds, net, count},
--      byDay:  [{day, branch_id, received, cash, card, bank, refunds, net, count}],
--      byMethod: [{method, amount, refunds, count}] }
--    "bank" is every method other than cash and card. A single JSON value, so
--    the API's max-rows limit never cuts it short.
-- -----------------------------------------------------------------------------
create or replace function public.payments_summary(p_from date, p_to date, p_branch bigint default null, p_method text default null)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with p as (
    select (pay.received_at at time zone 'Asia/Karachi')::date as day,
           pay.branch_id,
           coalesce(pay.method::text, 'other') as method,
           coalesce(pay.amount, 0)::numeric as amount
      from public.payments pay
     where (p_from is null or pay.received_at >= (p_from::timestamp at time zone 'Asia/Karachi'))
       and (p_to is null or pay.received_at < ((p_to + 1)::timestamp at time zone 'Asia/Karachi'))
       and (p_branch is null or pay.branch_id = p_branch)
       and (p_method is null or pay.method::text = p_method)
  )
  select jsonb_build_object(
    'totals', (
      select jsonb_build_object(
        'received', coalesce(sum(amount) filter (where amount > 0), 0),
        'cash',     coalesce(sum(amount) filter (where amount > 0 and method = 'cash'), 0),
        'card',     coalesce(sum(amount) filter (where amount > 0 and method = 'card'), 0),
        'bank',     coalesce(sum(amount) filter (where amount > 0 and method not in ('cash', 'card')), 0),
        'refunds',  coalesce(sum(-amount) filter (where amount < 0), 0),
        'net',      coalesce(sum(amount), 0),
        'count',    count(*))
        from p),
    'byDay', coalesce((
      select jsonb_agg(d order by d.day desc, d.branch_id)
        from (select day, branch_id,
                     coalesce(sum(amount) filter (where amount > 0), 0) as received,
                     coalesce(sum(amount) filter (where amount > 0 and method = 'cash'), 0) as cash,
                     coalesce(sum(amount) filter (where amount > 0 and method = 'card'), 0) as card,
                     coalesce(sum(amount) filter (where amount > 0 and method not in ('cash', 'card')), 0) as bank,
                     coalesce(sum(-amount) filter (where amount < 0), 0) as refunds,
                     coalesce(sum(amount), 0) as net,
                     count(*) as count
                from p group by day, branch_id) d), '[]'::jsonb),
    'byMethod', coalesce((
      select jsonb_agg(m order by m.amount desc)
        from (select method,
                     coalesce(sum(amount) filter (where amount > 0), 0) as amount,
                     coalesce(sum(-amount) filter (where amount < 0), 0) as refunds,
                     count(*) as count
                from p group by method) m), '[]'::jsonb)
  );
$$;

-- -----------------------------------------------------------------------------
-- 5. opd_summary(from, to, branch): Aaj ki List counts for a period. Returns
--    { totals: {visits, completed, no_shows, cancelled, waited, wait_min_total, avg_wait_min, patients},
--      byDay:  [{day, branch_id, visits, completed, no_shows, cancelled, waited, wait_min_total, avg_wait_min}],
--      waitByBranch: [{branch_id, waited, wait_min_total, avg_wait_min, long}] }
--    Waits are check-in to treatment start in minutes; "long" = over 45 minutes.
-- -----------------------------------------------------------------------------
create or replace function public.opd_summary(p_from date, p_to date, p_branch bigint default null)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with v as (
    select vi.visit_date as day,
           vi.branch_id,
           vi.status::text as status,
           vi.patient_id,
           case when vi.checked_in_at is not null and vi.started_at is not null
                then extract(epoch from (vi.started_at - vi.checked_in_at)) / 60.0 end as wait
      from public.visits vi
     where (p_from is null or vi.visit_date >= p_from)
       and (p_to is null or vi.visit_date <= p_to)
       and (p_branch is null or vi.branch_id = p_branch)
  )
  select jsonb_build_object(
    'totals', (
      select jsonb_build_object(
        'visits',         count(*),
        'completed',      count(*) filter (where status = 'completed'),
        'no_shows',       count(*) filter (where status = 'no_show'),
        'cancelled',      count(*) filter (where status = 'cancelled'),
        'waited',         count(wait),
        'wait_min_total', coalesce(sum(wait), 0),
        'avg_wait_min',   round(avg(wait)),
        'patients',       count(distinct patient_id))
        from v),
    'byDay', coalesce((
      select jsonb_agg(d order by d.day desc, d.branch_id)
        from (select day, branch_id,
                     count(*) as visits,
                     count(*) filter (where status = 'completed') as completed,
                     count(*) filter (where status = 'no_show') as no_shows,
                     count(*) filter (where status = 'cancelled') as cancelled,
                     count(wait) as waited,
                     coalesce(sum(wait), 0) as wait_min_total,
                     round(avg(wait)) as avg_wait_min
                from v group by day, branch_id) d), '[]'::jsonb),
    'waitByBranch', coalesce((
      select jsonb_agg(w order by w.waited desc)
        from (select branch_id,
                     count(*) as waited,
                     sum(wait) as wait_min_total,
                     round(avg(wait)) as avg_wait_min,
                     count(*) filter (where wait > 45) as long
                from v where wait is not null group by branch_id) w), '[]'::jsonb)
  );
$$;

-- -----------------------------------------------------------------------------
-- 6. total_dues(): all pending dues (the dashboard's "Total pending dues").
-- -----------------------------------------------------------------------------
create or replace function public.total_dues()
returns numeric
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(sum(b.dues), 0) from public.patient_balances b where b.dues > 0;
$$;

-- -----------------------------------------------------------------------------
-- Only signed-in users may call these (row-level security still applies inside).
-- -----------------------------------------------------------------------------
revoke all on function public.save_invoice(uuid, jsonb, jsonb) from public, anon;
revoke all on function public.save_installment_plan(uuid, jsonb, jsonb) from public, anon;
revoke all on function public.payments_summary(date, date, bigint, text) from public, anon;
revoke all on function public.opd_summary(date, date, bigint) from public, anon;
revoke all on function public.total_dues() from public, anon;

grant execute on function public.save_invoice(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.save_installment_plan(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.payments_summary(date, date, bigint, text) to authenticated;
grant execute on function public.opd_summary(date, date, bigint) to authenticated;
grant execute on function public.total_dues() to authenticated;

commit;

-- Tell the API about the new functions straight away.
notify pgrst, 'reload schema';
