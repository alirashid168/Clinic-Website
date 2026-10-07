-- Installment plans: payments taken from the plan's start date are applied
-- to its installments in order. One view tells staff (and the patient) where
-- each installment stands, and the coordinator who is behind.
alter table public.payment_plans add column if not exists starts_on date not null default current_date;

create or replace view public.installment_status
with (security_invoker = true) as
with inst as (
  select i.id, i.plan_id, p.patient_id, p.braces_case_id, p.starts_on, p.total_fee, i.due_date, i.amount, i.note,
         sum(i.amount) over (partition by i.plan_id order by i.due_date, i.id) as cum_due
    from public.plan_installments i
    join public.payment_plans p on p.id = i.plan_id),
paid as (
  select pl.id as plan_id, coalesce(sum(pay.amount), 0) as paid
    from public.payment_plans pl
    left join public.payments pay on pay.patient_id = pl.patient_id
     and (pay.received_at at time zone 'Asia/Karachi')::date >= pl.starts_on
   group by pl.id)
select inst.*, paid.paid,
       case when paid.paid >= inst.cum_due then 'paid'
            when inst.due_date < current_date then 'overdue'
            when inst.due_date <= current_date + 7 then 'due_soon'
            else 'upcoming' end as status,
       greatest(inst.cum_due - paid.paid, 0) as remaining
  from inst join paid on paid.plan_id = inst.plan_id;
