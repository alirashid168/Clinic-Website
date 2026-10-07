-- =====================================================================
-- Doctor dashboard (blueprint 26.2): one call that gives a doctor their own
-- numbers for a period — patients treated, visits checked, working days,
-- invoices from visits they treated, complaints linked to them, their own
-- patients ("brought in by") and what those paid, and the doctor share from
-- the percentage rule in Clinic setup. A doctor sees only their own summary;
-- Dr. Ali, the accountant and anyone allowed to see every doctor's log see all.
-- Complaints can be linked to a doctor from the Complaints inbox.
-- =====================================================================
create or replace function public.doctor_summary(p_clinician uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid;
  v_rule public.doctor_commission_rules;
  v_work jsonb; v_own jsonb; v_complaints jsonb; v_base numeric := 0; v_share numeric;
  t_from timestamptz := p_from::timestamp at time zone 'Asia/Karachi';
  t_to   timestamptz := (p_to + 1)::timestamp at time zone 'Asia/Karachi';
begin
  select id into v_me from public.clinicians where staff_id = auth.uid();
  if auth.uid() is not null and not public.is_admin() and not public.has_perm('doctor_log.view_all') and (v_me is null or v_me <> p_clinician) then
    raise exception 'You can only see your own summary' using errcode = '42501';
  end if;

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
                                               'patient_name', p.full_name, 'mr_number', p.mr_number) order by c.created_at desc), '[]')
    into v_complaints
    from public.complaints c join public.patients p on p.id = c.patient_id
   where c.clinician_id = p_clinician and c.created_at >= t_from and c.created_at < t_to;

  select * into v_rule from public.doctor_commission_rules r where r.active and r.clinician_id = p_clinician limit 1;
  if v_rule.id is null then select * into v_rule from public.doctor_commission_rules r where r.active and r.clinician_id is null limit 1; end if;
  if v_rule.id is not null then
    v_base := case v_rule.basis when 'treated' then (v_work->>'billed')::numeric when 'referred' then (v_own->>'referred_paid')::numeric
                                else (v_work->>'billed')::numeric + (v_own->>'referred_paid')::numeric end;
    v_share := round(v_base * v_rule.percent / 100, 2);
  end if;

  return v_work || v_own || jsonb_build_object('complaints', v_complaints,
    'rule', case when v_rule.id is null then null else jsonb_build_object('percent', v_rule.percent, 'basis', v_rule.basis, 'notes', v_rule.notes) end,
    'share', v_share);
end $$;

revoke all on function public.doctor_summary(uuid, date, date) from public, anon;
grant execute on function public.doctor_summary(uuid, date, date) to authenticated;
