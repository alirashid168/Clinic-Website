-- =====================================================================
-- Reports for Accounts → Reports (finance.view). One function, one kind per
-- report, rows as JSON so the website can draw tables and download CSVs.
-- Dates are inclusive; months are Asia/Karachi calendar months.
-- =====================================================================
create or replace function public.clinic_report(p_kind text, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  r jsonb;
  t_from timestamptz := (p_from::timestamp at time zone 'Asia/Karachi');
  t_to   timestamptz := ((p_to + 1)::timestamp at time zone 'Asia/Karachi');
begin
  if not (public.is_admin() or public.has_perm('finance.view')) then
    raise exception 'Only accounts and Dr. Ali can see reports' using errcode = '42501';
  end if;

  if p_kind = 'pnl_trend' then
    -- Per month and branch: income (payments), expenses tagged to the branch, expenses with no branch (per city).
    select coalesce(jsonb_agg(x order by x->>'month', x->>'branch_id'), '[]') into r from (
      select jsonb_build_object('month', m, 'branch_id', b, 'city_id', c, 'income', sum(inc), 'expenses', sum(exp)) x
        from (
          select to_char(received_at at time zone 'Asia/Karachi', 'YYYY-MM') m, branch_id b, null::smallint c, amount inc, 0 exp
            from public.payments where received_at >= t_from and received_at < t_to
          union all
          select to_char(expense_date, 'YYYY-MM'), branch_id, case when branch_id is null then city_id end, 0, amount
            from public.expenses where expense_date between p_from and p_to) u
       group by m, b, c) s;

  elsif p_kind = 'payment_methods' then
    select coalesce(jsonb_agg(x order by x->>'month'), '[]') into r from (
      select jsonb_build_object('month', to_char(received_at at time zone 'Asia/Karachi', 'YYYY-MM'), 'method', method, 'amount', sum(amount), 'count', count(*)) x
        from public.payments where received_at >= t_from and received_at < t_to
       group by to_char(received_at at time zone 'Asia/Karachi', 'YYYY-MM'), method) s;

  elsif p_kind = 'referrals' then
    select coalesce(jsonb_agg(x order by (x->>'patients')::int desc), '[]') into r from (
      select jsonb_build_object('source', coalesce(nullif(referral_source, ''), 'Not recorded'), 'branch_id', first_branch_id, 'patients', count(*)) x
        from public.patients where (created_at at time zone 'Asia/Karachi')::date between p_from and p_to
       group by coalesce(nullif(referral_source, ''), 'Not recorded'), first_branch_id) s;

  elsif p_kind = 'braces' then
    -- Bondings and braces-off visits by month (works for imported history too), plus cases started on the website.
    select coalesce(jsonb_agg(x order by x->>'month'), '[]') into r from (
      select jsonb_build_object('month', m, 'branch_id', b, 'bondings', sum(bond), 'braces_off', sum(off), 'cases_started', sum(cs)) x
        from (
          select to_char(visit_date, 'YYYY-MM') m, branch_id b,
                 case when treatment_label ilike '%bonding%' then 1 else 0 end bond,
                 case when treatment_label ilike '%braces off%' or treatment_label ilike '%debond%' then 1 else 0 end off, 0 cs
            from public.visits where visit_date between p_from and p_to and status = 'completed'
          union all
          select to_char(start_date, 'YYYY-MM'), bonding_branch_id, 0, 0, 1 from public.braces_cases where start_date between p_from and p_to) u
       group by m, b
      having sum(bond) + sum(off) + sum(cs) > 0) s;

  elsif p_kind = 'dues_by_branch' then
    select coalesce(jsonb_agg(x order by (x->>'dues')::numeric desc), '[]') into r from (
      select jsonb_build_object('branch_id', p.first_branch_id, 'patients', count(*), 'dues', sum(b.dues)) x
        from public.patient_balances b join public.patients p on p.id = b.patient_id
       where b.dues > 0 group by p.first_branch_id) s;

  elsif p_kind = 'top_dues' then
    select coalesce(jsonb_agg(x), '[]') into r from (
      select jsonb_build_object('patient_id', p.id, 'mr_number', p.mr_number, 'full_name', p.full_name, 'phone', p.phone, 'branch_id', p.first_branch_id, 'dues', b.dues,
               'last_payment', (select max(received_at)::date from public.payments y where y.patient_id = p.id)) x
        from public.patient_balances b join public.patients p on p.id = b.patient_id
       where b.dues > 0 order by b.dues desc limit 100) s;

  elsif p_kind = 'photo_compliance' then
    select coalesce(jsonb_agg(x order by x->>'month', x->>'branch_id'), '[]') into r from (
      select jsonb_build_object('month', to_char(visit_date, 'YYYY-MM'), 'branch_id', branch_id, 'photo_months', count(*), 'uploaded', count(*) filter (where photos_uploaded)) x
        from public.visits where visit_date between p_from and p_to and photo_required and status = 'completed'
       group by to_char(visit_date, 'YYYY-MM'), branch_id) s;

  elsif p_kind = 'lab_costs' then
    select coalesce(jsonb_agg(x order by x->>'month', x->>'branch_id'), '[]') into r from (
      select jsonb_build_object('month', m, 'branch_id', b, 'cases', count(*), 'cost', sum(c)) x
        from (
          select to_char(sent_date, 'YYYY-MM') m, branch_id b, coalesce(cost, 0) c from public.lab_cases where sent_date between p_from and p_to and status <> 'cancelled'
          union all
          select to_char(coalesce(impression_date, created_at::date), 'YYYY-MM'), branch_id, coalesce(lab_cost, 0) from public.retainer_cases
           where coalesce(impression_date, created_at::date) between p_from and p_to) u
       group by m, b) s;

  elsif p_kind = 'doctors' then
    select coalesce(jsonb_agg(x order by (x->>'treated')::int desc), '[]') into r from (
      select jsonb_build_object('clinician_id', c.id, 'name', c.display_name, 'group', c.doctor_group_id,
               'treated', count(*) filter (where vs.role = 'doctor'), 'checked', count(*) filter (where vs.role = 'checker'), 'assisted', count(*) filter (where vs.role = 'assistant'),
               'days', count(distinct v.visit_date) filter (where vs.role = 'doctor'),
               'billed', coalesce(sum(i.total) filter (where vs.role = 'doctor'), 0)) x
        from public.visit_staff vs
        join public.visits v on v.id = vs.visit_id and v.status = 'completed' and v.visit_date between p_from and p_to
        join public.clinicians c on c.id = vs.clinician_id
        left join public.invoices i on i.visit_id = v.id and i.status = 'issued'
       group by c.id, c.display_name, c.doctor_group_id) s;

  elsif p_kind = 'treatments' then
    select coalesce(jsonb_agg(x order by (x->>'amount')::numeric desc), '[]') into r from (
      select jsonb_build_object('treatment', coalesce(t.name, it.description), 'count', sum(it.quantity), 'amount', sum(it.line_total)) x
        from public.invoice_items it join public.invoices i on i.id = it.invoice_id and i.status = 'issued' and i.issue_date between p_from and p_to
        left join public.treatments t on t.id = it.treatment_id
       group by coalesce(t.name, it.description) order by sum(it.line_total) desc limit 60) s;

  elsif p_kind = 'visits' then
    -- A new patient = their first completed visit ever falls in this month.
    select coalesce(jsonb_agg(x order by x->>'month', x->>'branch_id'), '[]') into r from (
      with first_visit as (select patient_id, min(visit_date) d from public.visits where status = 'completed' group by patient_id)
      select jsonb_build_object('month', to_char(v.visit_date, 'YYYY-MM'), 'branch_id', v.branch_id, 'visits', count(*) filter (where v.status = 'completed'),
               'patients', count(distinct v.patient_id) filter (where v.status = 'completed'), 'no_shows', count(*) filter (where v.status = 'no_show'),
               'new_patients', count(distinct v.patient_id) filter (where v.status = 'completed' and f.d = v.visit_date)) x
        from public.visits v left join first_visit f on f.patient_id = v.patient_id
       where v.visit_date between p_from and p_to
       group by to_char(v.visit_date, 'YYYY-MM'), v.branch_id) s;

  else
    raise exception 'Unknown report %', p_kind;
  end if;
  return r;
end $$;

revoke all on function public.clinic_report(text, date, date) from public, anon;
grant execute on function public.clinic_report(text, date, date) to authenticated;
