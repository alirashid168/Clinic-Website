-- =============================================================================
-- Finance privacy: the clinic's money is for Dr. Ali and accounts.
--
-- The owner's request (Dr. Ali, 15 Oct 2026): "please make sure no one can see the overall finances of the clinic except
-- me and accounts. no assistant can see the income, only front desk can see the daily payments with each payment along
-- with patient name. but not the full amount"
--
-- The rule, for every place that shows money:
--   a. a sum or total across patients, a day, a branch or the clinic: only with "View all financial reports" (finance.view)
--      or "View invoices and payments" (billing.view), which only accounts and Dr. Ali have;
--   b. a list of payments across patients: billing.view, or (today only, never a total) the new
--      "Today's payments, one by one (no totals)";
--   c. one patient's own invoices, payments and dues: as before (billing.view, "See $$ pending dues flag"), and the front desk's
--      "Create invoices and take payments" (billing.create): the owner, 15 Oct 2026, "yes the front desk takes the payment". The
--      front desk makes invoices, takes payments and prints the bill; 20261015000500_front_desk_billing.sql lets billing.create read
--      back the invoices, invoice lines and payments of its branches ("billers view ..." policies). This file leaves those policies
--      and that tick alone; it keeps every total away from them (a, above).
--
-- What this file adds or changes
--   1. The permission 'payments.day_list' ("Today's payments, one by one (no totals)", under Billing): on for front desk,
--      accountant and admin, off for the others. Run again, it leaves a choice made in the access list alone.
--   2. public.payments_today(branch): today's payments (the Pakistan day), one row each: the time, the patient's name and
--      Mr#, the amount, how it was paid, the branch and who took it. Only the branches the person works at. Never a total.
--   3. payments_summary() and total_dues(): a staff member without finance.view or billing.view is refused (42501) instead
--      of being answered with zeros. A patient's own login still gets only their own rows, as before.
--   4. doctor_summary(): the rupees (billed, own patients paid, the percentage rule, the share) only with finance.view, or on
--      a doctor's own summary with "See own doctor percentage". Anyone else allowed to open it (the coordinator, a shared
--      doctors login with "See every doctor's daily log" and no doctor record of its own) gets the counts and the complaints,
--      with the money left out (null).
--   5. The daily cash closing is a blind count for someone who may close the cash but not see the money (cash.close without
--      cash.verify, billing.view or finance.view): close_cash() answers them without the expected cash and the difference,
--      they no longer read cash_closings directly (its "view closings" policy), and public.cash_closings_blind() lists the
--      closings of their branches (when, who closed, checked by accounts or not) without any amount.
--   6. branch_daily_income and branch_monthly_pnl (the income of a branch per day and per month): empty for whoever has neither
--      finance.view nor billing.view. Both add up the payments a person may read, and since 20261015000500 the front desk reads
--      its branches' payments one by one (to bill and print), which these views would otherwise add up for it.
--   7. dues_for(patients): at most 500 patients a call for someone without finance.view or billing.view (the website asks
--      for 100 at a time). It only slows down adding up everybody's dues; see "What this file does not stop" below.
--
-- Additive where it can be: one policy is replaced (cash_closings "view closings": drop policy if exists + create), five
-- functions are replaced with the same arguments and answers (payments_summary, total_dues, doctor_summary, close_cash,
-- dues_for: the changes are only the refusals and the money left out), two views are replaced with the same columns (the rows
-- only for who sees the totals), and two functions are new. It needs 20261007002000 (payments_summary, total_dues) and
-- 20261011000200 (doctor_summary) first. It runs the same before or after 20261015000500_front_desk_billing.sql (live has that
-- one already): nothing here touches the "billers view ..." policies, and its role_permissions insert never overwrites a row
-- that is there (the front desk's "Create invoices and take payments" stays as it is). Safe to run more than once.
--
-- What this file does not stop (for Dr. Ali to decide)
--   - Every role has "See $$ pending dues flag" and may look up patients, so anyone signed in can ask dues_for for every
--     patient (500 at a time: a clinic of 10,000 patients is 20 requests) and add up the clinic's pending dues. Stopping
--     that needs dues_for limited to the patients a person is working with (today's lists, a search), a larger change.
--   - Since 20261015000500 the front desk reads its branches' invoices and payments row by row (to bill, take payments and
--     print). The website never adds them up for it and the database refuses it every total, but the rows themselves (any
--     day) could be added up outside the website by someone with a front desk login and a programming tool. Stopping that
--     needs those policies limited to the patients being billed (today's lists, a search), a larger change.
--
-- HOW TO APPLY (in this order)
--   1. Put the website live first (the new pages work with the database as it is now: the front desk's cash closing and its
--      "Closed" or "Not closed" on Today keep working, it bills and takes payments as before; "Payments today" says the database
--      update is needed).
--      Do steps 1 and 2 back to back. Until both are live the front desk sees money totals: since 20261015000500 it reads its
--      branch's payments, so the old website's Cash closing page adds them up into "Cash payments recorded today", and the
--      old payments_summary(), total_dues() and branch income views answer it if it asks the database directly.
--   2. Supabase dashboard -> SQL Editor -> New query -> paste this whole file -> Run.
--      With the Supabase CLI, keep the file name as it is (20261015000400 sorts after 20261015000100_staff_menu_prefs.sql; on live
--      it runs after 20261015000500_front_desk_billing.sql, which was applied first, and that is fine).
--   3. Reload the website on every staff computer (Ctrl+Shift+R). A page left open from before step 1 would tell the front
--      desk "It matches" after a cash count without checking, and a page opened between steps 1 and 2 keeps saying the
--      database update is needed until it is reloaded.
-- =============================================================================

do $$
begin
  if to_regprocedure('public.payments_summary(date, date, bigint, text)') is null or to_regprocedure('public.total_dues()') is null then
    raise exception 'Apply 20261007002000_audit_fixes.sql before this file: it replaces payments_summary() and total_dues().';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'complaints' and column_name = 'kind') then
    raise exception 'Apply 20261011000200_public_forms.sql before this file: the doctor_summary() it replaces counts complaints by their kind.';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. The permission
-- ---------------------------------------------------------------------------------------------------------------
insert into public.permissions (key, label, category, sort_order) values
  ('payments.day_list', 'Today''s payments, one by one (no totals)', 'Billing', 68)
on conflict (key) do nothing;

-- On for front desk (the owner's request), the accountant and admin; off for assistant, doctor and coordinator.
-- on conflict do nothing: a row that is there already (a choice made in the access list) is never overwritten.
insert into public.role_permissions (role, permission_key, allowed)
select r.role, 'payments.day_list', r.role in ('front_desk', 'accountant', 'admin')
  from unnest(enum_range(null::public.staff_role)) as r(role)
on conflict (role, permission_key) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Today's payments, one by one (never a total)
-- ---------------------------------------------------------------------------------------------------------------
-- Rows only: no sum, no count of rupees, no other day. p_branch: one branch (it must be one the person works at), or null for
-- all of theirs. Refunds are rows with a negative amount, like the payments table.
create or replace function public.payments_today(p_branch smallint default null)
returns table (id uuid, received_at timestamptz, patient_id uuid, patient_name text, mr_number text, amount numeric,
               method text, branch_id smallint, received_by_name text)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_day date := (now() at time zone 'Asia/Karachi')::date;
begin
  if auth.uid() is null or not public.has_perm('payments.day_list') then
    raise exception 'NOT_ALLOWED: today''s payments need "Today''s payments, one by one (no totals)" in the access list.'
      using errcode = '42501';
  end if;
  if p_branch is not null and not public.can_access_branch(p_branch) then
    raise exception 'NOT_ALLOWED: you can see the payments only at the branches you work at.' using errcode = '42501';
  end if;
  return query
    select y.id, y.received_at, y.patient_id, pt.full_name, pt.mr_number, y.amount, y.method::text, y.branch_id, s.full_name
      from public.payments y
      join public.patients pt on pt.id = y.patient_id
      left join public.staff s on s.id = y.received_by
     where y.received_at >= (v_day::timestamp at time zone 'Asia/Karachi')
       and y.received_at < ((v_day + 1)::timestamp at time zone 'Asia/Karachi')
       and public.can_access_branch(y.branch_id)
       and (p_branch is null or y.branch_id = p_branch)
     order by y.received_at desc, y.id;
end $$;

revoke all on function public.payments_today(smallint) from public, anon;
grant execute on function public.payments_today(smallint) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Totals refuse instead of answering zeros
-- ---------------------------------------------------------------------------------------------------------------
-- payments_summary as 20261007002000 left it (SECURITY INVOKER: row-level security still decides which rows are added up),
-- with the refusal first. Only signed-in staff are refused: a patient's own login adds up its own payments, as before, and a
-- server job with nobody signed in is not staff.
create or replace function public.payments_summary(p_from date, p_to date, p_branch bigint default null, p_method text default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  if public.is_staff() and not (public.has_perm('finance.view') or public.has_perm('billing.view')) then
    raise exception 'NOT_ALLOWED: money totals are for Dr. Ali and accounts ("View all financial reports" or "View invoices and payments" in the access list).'
      using errcode = '42501';
  end if;
  return (
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
  ));
end $$;

-- total_dues as 20261007002000 left it, with the same refusal.
create or replace function public.total_dues()
returns numeric
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  if public.is_staff() and not (public.has_perm('finance.view') or public.has_perm('billing.view')) then
    raise exception 'NOT_ALLOWED: money totals are for Dr. Ali and accounts ("View all financial reports" or "View invoices and payments" in the access list).'
      using errcode = '42501';
  end if;
  return (select coalesce(sum(b.dues), 0) from public.patient_balances b where b.dues > 0);
end $$;

revoke all on function public.payments_summary(date, date, bigint, text) from public, anon;
revoke all on function public.total_dues() from public, anon;
grant execute on function public.payments_summary(date, date, bigint, text) to authenticated;
grant execute on function public.total_dues() to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. The doctor dashboard: the counts for whoever may open it, the rupees only for accounts or the doctor themself
-- ---------------------------------------------------------------------------------------------------------------
-- doctor_summary as 20261011000200 left it; at the end, the money (billed, referred_paid, rule, share) is null unless the
-- reader has finance.view, or reads their own summary and has "See own doctor percentage" (commission.view_own).
create or replace function public.doctor_summary(p_clinician uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid;
  v_rule public.doctor_commission_rules;
  v_work jsonb; v_own jsonb; v_complaints jsonb; v_base numeric := 0; v_share numeric;
  v_money boolean;
  t_from timestamptz := p_from::timestamp at time zone 'Asia/Karachi';
  t_to   timestamptz := (p_to + 1)::timestamp at time zone 'Asia/Karachi';
begin
  select id into v_me from public.clinicians where staff_id = auth.uid();
  if auth.uid() is not null and not public.is_admin() and not public.has_perm('doctor_log.view_all') and (v_me is null or v_me <> p_clinician) then
    raise exception 'You can only see your own summary' using errcode = '42501';
  end if;
  -- coalesce and "v_me is not null": a login with no doctor record of its own (a shared doctors login) has v_me null, and
  -- "null = p_clinician" is null, not false; "if not null" would skip the branch below and hand over the money.
  v_money := coalesce(auth.uid() is null or public.has_perm('finance.view')
                      or (v_me is not null and v_me = p_clinician and public.has_perm('commission.view_own')), false);

  select jsonb_build_object(
           'treated', count(*) filter (where vs.role = 'doctor'), 'checked', count(*) filter (where vs.role = 'checker'), 'assisted', count(*) filter (where vs.role = 'assistant'),
           'days', count(distinct v.visit_date), 'billed', coalesce(sum(i.total) filter (where vs.role = 'doctor'), 0),
           'branches', coalesce((select jsonb_agg(distinct v2.branch_id) from public.visit_staff vs2 join public.visits v2 on v2.id = vs2.visit_id
                                  where vs2.clinician_id = p_clinician and v2.status = 'completed' and v2.visit_date between p_from and p_to), '[]'))
    into v_work
    from public.visit_staff vs
    join public.visits v on v.id = vs.visit_id and v.status = 'completed' and v.visit_date between p_from and p_to
    left join public.invoices i on i.visit_id = v.id and i.status = 'issued'
   where vs.clinician_id = p_clinician;

  select jsonb_build_object(
           'referred_patients', count(distinct p.id),
           'referred_paid', coalesce((select sum(y.amount) from public.payments y
                                        where y.patient_id in (select q.id from public.patients q where q.referred_by_clinician = p_clinician)
                                          and y.received_at >= t_from and y.received_at < t_to), 0))
    into v_own
    from public.patients p where p.referred_by_clinician = p_clinician;

  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'subject', c.subject, 'status', c.status, 'created_at', c.created_at, 'branch_id', c.branch_id,
                                               'patient_name', p.full_name, 'mr_number', p.mr_number, 'source', c.source) order by c.created_at desc), '[]')
    into v_complaints
    from public.complaints c left join public.patients p on p.id = c.patient_id
   where c.clinician_id = p_clinician and c.created_at >= t_from and c.created_at < t_to and coalesce(c.kind, 'complaint') = 'complaint';

  select * into v_rule from public.doctor_commission_rules r where r.active and r.clinician_id = p_clinician limit 1;
  if v_rule.id is null then select * into v_rule from public.doctor_commission_rules r where r.active and r.clinician_id is null limit 1; end if;
  if v_rule.id is not null then
    v_base := case v_rule.basis when 'treated' then (v_work->>'billed')::numeric when 'referred' then (v_own->>'referred_paid')::numeric
                                else (v_work->>'billed')::numeric + (v_own->>'referred_paid')::numeric end;
    v_share := round(v_base * v_rule.percent / 100, 2);
  end if;

  if not coalesce(v_money, false) then
    -- The counts and the complaints only: no amount billed, paid or earned, and no percentage.
    return v_work || v_own || jsonb_build_object('billed', null, 'referred_paid', null, 'complaints', v_complaints, 'rule', null, 'share', null);
  end if;
  return v_work || v_own || jsonb_build_object('complaints', v_complaints,
    'rule', case when v_rule.id is null then null else jsonb_build_object('percent', v_rule.percent, 'basis', v_rule.basis, 'notes', v_rule.notes) end,
    'share', v_share);
end $$;

revoke all on function public.doctor_summary(uuid, date, date) from public, anon;
grant execute on function public.doctor_summary(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. The cash closing: a blind count for whoever may close the cash but not see the money
-- ---------------------------------------------------------------------------------------------------------------
-- Who sees the cash amounts (expected, counted, difference): finance.view at every branch; cash.verify or billing.view at the
-- branches they work at. The person who only closes the cash (cash.close) no longer reads the table: cash_closings_blind().
drop policy if exists "view closings" on public.cash_closings;
create policy "view closings" on public.cash_closings for select
  using (public.has_perm('finance.view')
         or ((public.has_perm('cash.verify') or public.has_perm('billing.view')) and public.can_access_branch(branch_id)));

-- close_cash as 20261005000200 left it; a blind closer is answered without the expected cash and the difference.
create or replace function public.close_cash(p_branch smallint, p_date date, p_counted numeric, p_notes text default null)
returns public.cash_closings
language plpgsql security definer set search_path = public
as $$
declare v_row public.cash_closings;
begin
  if not public.has_perm('cash.close') or not public.can_access_branch(p_branch) then
    raise exception 'You are not allowed to close cash for this branch';
  end if;
  insert into public.cash_closings (branch_id, closing_date, expected_cash, counted_cash, closed_by, notes)
  values (p_branch, p_date, public.expected_cash(p_branch, p_date), p_counted, auth.uid(), p_notes)
  returning * into v_row;
  if not (public.has_perm('finance.view') or public.has_perm('cash.verify') or public.has_perm('billing.view')) then
    v_row.expected_cash := null;
    v_row.difference := null;
  end if;
  return v_row;
end $$;

revoke all on function public.close_cash(smallint, date, numeric, text) from public, anon;
grant execute on function public.close_cash(smallint, date, numeric, text) to authenticated;

-- The closings of the branches the person works at, newest first, without any amount and without the notes (a note may say
-- how much was short): the day, the branch, when and by whom it was closed, and whether accounts have checked it.
create or replace function public.cash_closings_blind(p_limit integer default 200)
returns table (id uuid, branch_id smallint, closing_date date, closed_at timestamptz, closed_by_name text, checked boolean)
language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is null or not (public.has_perm('cash.close') or public.has_perm('cash.verify')
                                or public.has_perm('billing.view') or public.has_perm('finance.view')) then
    raise exception 'NOT_ALLOWED: the cash closings need "Daily cash closing" in the access list.' using errcode = '42501';
  end if;
  return query
    select c.id, c.branch_id, c.closing_date, c.closed_at, s.full_name, (c.verified_at is not null or c.verified_by is not null)
      from public.cash_closings c
      left join public.staff s on s.id = c.closed_by
     where public.can_access_branch(c.branch_id)
     order by c.closing_date desc, c.closed_at desc, c.id
     limit greatest(1, least(coalesce(p_limit, 200), 500));
end $$;

revoke all on function public.cash_closings_blind(integer) from public, anon;
grant execute on function public.cash_closings_blind(integer) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. The income of a branch per day and per month: only for who sees the totals
-- ---------------------------------------------------------------------------------------------------------------
-- As 20261005000200 and 20261007000300 left them (SECURITY INVOKER: row-level security still decides which payments are added up),
-- with the payments taken in only for finance.view or billing.view. The front desk reads its branches' payments one by one since
-- 20261015000500 (to bill, take payments and print), and these views would add them up into its branch's income for it. Expenses
-- are read with finance.view only ("view expenses"), so they need no check of their own. (select ...): asked once per query.
create or replace view public.branch_daily_income
with (security_invoker = true) as
select branch_id,
       (received_at at time zone 'Asia/Karachi')::date as day,
       sum(amount) filter (where amount > 0) as received,
       -sum(amount) filter (where amount < 0) as refunded,
       sum(amount) as net
  from public.payments
 where (select public.has_perm('finance.view') or public.has_perm('billing.view'))
 group by 1, 2;

create or replace view public.branch_monthly_pnl
with (security_invoker = true) as
with inc as (
  select branch_id, date_trunc('month', received_at at time zone 'Asia/Karachi')::date as month,
         sum(amount) as income
    from public.payments
   where (select public.has_perm('finance.view') or public.has_perm('billing.view'))
   group by 1, 2
), expb as (
  select branch_id, date_trunc('month', expense_date)::date as month, sum(amount) as expenses
    from public.expenses where branch_id is not null group by 1, 2
), expc as (
  select city_id, date_trunc('month', expense_date)::date as month, sum(amount) as expenses
    from public.expenses where branch_id is null group by 1, 2
)
select coalesce(inc.branch_id, expb.branch_id) as branch_id,
       coalesce(inc.month, expb.month) as month,
       coalesce(inc.income, 0) as income,
       coalesce(expb.expenses, 0) as expenses,
       coalesce(inc.income, 0) - coalesce(expb.expenses, 0) as profit,
       null::smallint as city_id
  from inc full join expb on inc.branch_id = expb.branch_id and inc.month = expb.month
union all
select null::smallint, expc.month, 0::numeric, expc.expenses, -expc.expenses, expc.city_id
  from expc;

-- ---------------------------------------------------------------------------------------------------------------
-- 7. Dues for the screens, at most 500 patients a call for whoever does not see the totals
-- ---------------------------------------------------------------------------------------------------------------
-- dues_for as 20261005000600 left it (each patient's dues, for the pending dues flag), with the cap first. The website asks
-- for 100 patients at a time (a day's list, the Today page, a search of 51). Accounts and Dr. Ali may ask for any number.
create or replace function public.dues_for(p_patients uuid[])
returns table (patient_id uuid, dues numeric)
language plpgsql stable security definer set search_path = public
as $$
begin
  if coalesce(cardinality(p_patients), 0) > 500 and not (public.has_perm('finance.view') or public.has_perm('billing.view')) then
    raise exception 'NOT_ALLOWED: at most 500 patients'' dues at a time.' using errcode = '42501';
  end if;
  return query
    select p.id,
           coalesce((select sum(i.total) from public.invoices i where i.patient_id = p.id and i.status = 'issued'), 0)
         - coalesce((select sum(y.amount) from public.payments y where y.patient_id = p.id), 0)
      from public.patients p
     where p.id = any(p_patients)
       and (public.has_perm('dues.view') or p.id = public.current_patient_id());
end $$;

revoke all on function public.dues_for(uuid[]) from public, anon;
grant execute on function public.dues_for(uuid[]) to authenticated;

notify pgrst, 'reload schema';
