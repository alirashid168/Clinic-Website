-- =====================================================================
-- Duplicate patients (two Mr# for one person) and merging them.
-- patient_duplicates(): groups of patients sharing a phone number, for Dr. Ali
-- to look at. merge_patients(keep, remove): moves every visit, invoice,
-- payment, photo, document, plan, case, reminder, complaint, flag and rating
-- from the duplicate to the kept record, keeps the older Mr# as a note, then
-- removes the duplicate. Admin only; written to the audit log.
-- =====================================================================
create or replace function public.patient_duplicates()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare r jsonb;
begin
  if not public.is_admin() then raise exception 'Only Dr. Ali can review duplicates' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(g order by (g->>'members')::int desc, g->>'phone'), '[]') into r from (
    select jsonb_build_object('phone', p.phone, 'members', count(*),
             'patients', jsonb_agg(jsonb_build_object('id', p.id, 'mr_number', p.mr_number, 'full_name', p.full_name, 'created_at', p.created_at::date,
               'first_branch_id', p.first_branch_id, 'visits', (select count(*) from public.visits v where v.patient_id = p.id),
               'invoices', (select count(*) from public.invoices i where i.patient_id = p.id),
               'dues', coalesce((select b.dues from public.patient_balances b where b.patient_id = p.id), 0),
               'last_visit', (select max(v.visit_date) from public.visits v where v.patient_id = p.id)) order by p.created_at)) g
      from public.patients p
     where p.phone is not null and length(p.phone) >= 7
     group by p.phone
    having count(*) > 1) s;
  return r;
end $$;

create or replace function public.merge_patients(p_keep uuid, p_remove uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_keep public.patients; v_remove public.patients;
  n_visits int; n_inv int; n_pay int;
begin
  if not public.is_admin() then raise exception 'Only Dr. Ali can merge patients' using errcode = '42501'; end if;
  if p_keep = p_remove then raise exception 'Choose two different patients'; end if;
  select * into v_keep from public.patients where id = p_keep;
  select * into v_remove from public.patients where id = p_remove;
  if v_keep.id is null or v_remove.id is null then raise exception 'Patient not found'; end if;
  if v_remove.portal_user_id is not null and v_keep.portal_user_id is not null and v_remove.portal_user_id <> v_keep.portal_user_id then
    raise exception 'Both records have a patient-portal login; switch one off first';
  end if;

  -- Two visits on the same day: keep the kept record's row, fold the other one's notes in.
  update public.visits k set notes = concat_ws(' · ', k.notes, r.treatment_label, r.details_text, r.notes)
    from public.visits r where k.patient_id = p_keep and r.patient_id = p_remove and r.visit_date = k.visit_date and r.branch_id = k.branch_id;
  -- Things hanging off the duplicate's same-day visit move to the kept visit (doctors stay as recorded on the kept one).
  update public.photos ph set visit_id = k.id from public.visits r join public.visits k on k.patient_id = p_keep and k.visit_date = r.visit_date and k.branch_id = r.branch_id
   where ph.visit_id = r.id and r.patient_id = p_remove;
  update public.invoices i set visit_id = k.id from public.visits r join public.visits k on k.patient_id = p_keep and k.visit_date = r.visit_date and k.branch_id = r.branch_id
   where i.visit_id = r.id and r.patient_id = p_remove;
  update public.lab_cases l set visit_id = k.id from public.visits r join public.visits k on k.patient_id = p_keep and k.visit_date = r.visit_date and k.branch_id = r.branch_id
   where l.visit_id = r.id and r.patient_id = p_remove;
  update public.inventory_moves m set visit_id = k.id from public.visits r join public.visits k on k.patient_id = p_keep and k.visit_date = r.visit_date and k.branch_id = r.branch_id
   where m.visit_id = r.id and r.patient_id = p_remove;
  update public.visit_ratings vr set visit_id = k.id, patient_id = p_keep from public.visits r join public.visits k on k.patient_id = p_keep and k.visit_date = r.visit_date and k.branch_id = r.branch_id
   where vr.visit_id = r.id and r.patient_id = p_remove and not exists (select 1 from public.visit_ratings x where x.visit_id = k.id);
  delete from public.visits r where r.patient_id = p_remove
     and exists (select 1 from public.visits k where k.patient_id = p_keep and k.visit_date = r.visit_date and k.branch_id = r.branch_id);

  -- Only one active braces case may exist: the kept record's wins; the other is marked discontinued.
  if exists (select 1 from public.braces_cases where patient_id = p_keep and status = 'active')
     and exists (select 1 from public.braces_cases where patient_id = p_remove and status = 'active') then
    update public.braces_cases set status = 'discontinued', notes = concat_ws(' · ', notes, 'Merged into the other record''s case') where patient_id = p_remove and status = 'active';
  end if;
  -- One open flag per patient.
  if exists (select 1 from public.patient_flags where patient_id = p_keep and cleared_at is null)
     and exists (select 1 from public.patient_flags where patient_id = p_remove and cleared_at is null) then
    update public.patient_flags set cleared_at = now(), cleared_note = 'Merged: the other record already carries the flag' where patient_id = p_remove and cleared_at is null;
  end if;

  update public.visits set patient_id = p_keep where patient_id = p_remove;
  get diagnostics n_visits = row_count;
  update public.invoices set patient_id = p_keep where patient_id = p_remove;
  get diagnostics n_inv = row_count;
  update public.payments set patient_id = p_keep where patient_id = p_remove;
  get diagnostics n_pay = row_count;
  update public.braces_cases set patient_id = p_keep where patient_id = p_remove;
  update public.retainer_cases set patient_id = p_keep where patient_id = p_remove;
  update public.payment_plans set patient_id = p_keep where patient_id = p_remove;
  update public.photos set patient_id = p_keep where patient_id = p_remove;
  update public.xrays set patient_id = p_keep where patient_id = p_remove;
  update public.lab_cases set patient_id = p_keep where patient_id = p_remove;
  update public.reminders set patient_id = p_keep where patient_id = p_remove;
  update public.complaints set patient_id = p_keep where patient_id = p_remove;
  update public.patient_flags set patient_id = p_keep where patient_id = p_remove;
  update public.visit_ratings set patient_id = p_keep where patient_id = p_remove;
  update public.patient_documents set patient_id = p_keep where patient_id = p_remove;

  -- Fill gaps on the kept record from the duplicate; never overwrite.
  update public.patients set
    phone_alt = coalesce(phone_alt, case when v_remove.phone <> phone then v_remove.phone else v_remove.phone_alt end),
    email = coalesce(email, v_remove.email), gender = coalesce(gender, v_remove.gender), date_of_birth = coalesce(date_of_birth, v_remove.date_of_birth),
    address = coalesce(address, v_remove.address), first_branch_id = coalesce(first_branch_id, v_remove.first_branch_id),
    referral_source = coalesce(referral_source, v_remove.referral_source), referred_by_clinician = coalesce(referred_by_clinician, v_remove.referred_by_clinician),
    portal_user_id = coalesce(portal_user_id, v_remove.portal_user_id),
    photo_consent_public = photo_consent_public or v_remove.photo_consent_public,
    treatment_consent_at = coalesce(treatment_consent_at, v_remove.treatment_consent_at),
    medical_history = v_remove.medical_history || medical_history,
    notes = concat_ws(' · ', notes, v_remove.notes, 'Merged with Mr# ' || v_remove.mr_number || ' (' || v_remove.full_name || ') on ' || to_char(now() at time zone 'Asia/Karachi', 'DD Mon YYYY'))
  where id = p_keep;

  -- The duplicate's portal login must be released before the row goes.
  update public.patients set portal_user_id = null where id = p_remove;
  delete from public.patients where id = p_remove;

  insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
  values ('patients', p_keep::text, 'MERGE', to_jsonb(v_remove), jsonb_build_object('kept', p_keep, 'removed', p_remove, 'visits', n_visits, 'invoices', n_inv, 'payments', n_pay), auth.uid());
  return jsonb_build_object('kept', p_keep, 'removed_mr', v_remove.mr_number, 'visits', n_visits, 'invoices', n_inv, 'payments', n_pay);
end $$;

revoke all on function public.patient_duplicates() from public, anon;
revoke all on function public.merge_patients(uuid, uuid) from public, anon;
grant execute on function public.patient_duplicates() to authenticated;
grant execute on function public.merge_patients(uuid, uuid) to authenticated;
