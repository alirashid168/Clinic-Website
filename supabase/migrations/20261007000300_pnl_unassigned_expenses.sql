-- =====================================================================
-- Branch income vs expenses: expenses recorded against a city only (no
-- branch) used to be left out, so the month's total looked far better than
-- it was. The view now also returns one row per city for those expenses
-- (branch_id null, city_id set) so the page can show the overall figure.
-- =====================================================================
create or replace view public.branch_monthly_pnl
with (security_invoker = true) as
with inc as (
  select branch_id, date_trunc('month', received_at at time zone 'Asia/Karachi')::date as month,
         sum(amount) as income
    from public.payments group by 1, 2
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
