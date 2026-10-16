-- =============================================================================
-- The front desk uploads pictures and X-rays; the clinic coordinator sees each patient's installments due (never a total).
--
-- The owner (Dr. Ali, 16 Oct 2026), answering two questions ("Should the front desk also be able to upload pictures and X-rays?
-- Right now they can only upload consent forms." and "Should the coordinator see each patient's installments due? It would show
-- per patient only, with no clinic totals."): "front desk can upload pictures and x rays and consent forms, so can the assistants.
-- yes pending dues should only be seen for per patient and not totals".
-- His money rule stays as it was (15 Oct 2026): "make sure no one can see the overall finances of the clinic except me and
-- accounts". Totals stay with finance.view and billing.view (Dr. Ali and the accountant), 20261015000400_finance_privacy.sql.
--
-- 1. The role grid: the front desk gets photos.upload ("Upload clinic photos and X-rays"), on purpose (the owner asked). On the
--    patient profile that is "Upload picture" and "Upload X-ray" (the page shows each button by the grid), and "Upload photos" in the
--    Aaj ki List row dialog. In the database photos.upload means: add photo rows ("staff upload photos") and change them ("staff edit
--    photos", see 2), add X-ray rows ("upload xrays"), store files in the clinic-photos and xrays buckets, and add or delete documents
--    (the front desk could already, with patients.edit). Consent forms need nothing new. X-rays need nothing new either: the front desk
--    has "View X-rays" (xrays.view), so it reads back the X-ray row and file it saves.
-- 2. Seeing the pictures it uploads, and nobody else's. A picture goes in as a raw photo (staff only). Raw photos are read with "View raw
--    clinic photos folder" (photos.view_raw): every raw photo row of every patient and every file of the clinic-photos bucket, the raw
--    inbox folders included. The front desk is NOT given that. Instead, anyone with photos.upload reads the photo rows they uploaded
--    themselves ("uploaders see their photos") and those photos' files ("uploaders read their clinic photos"): a clinic-photos file
--    Storage recorded as theirs (objects.owner / owner_id: Storage writes the uploader's login there itself, so the picture can be read
--    back between storing it and saving its row), or the file of one of their own photo rows and its small copy, the small copy found
--    from the photo's own path (thumbs/<name>.jpg beside it: public.photo_thumb_path, the same as the website's thumbPathFor), never
--    from what the row says. Without this the front desk's upload would fail (the website saves the row and reads it back in one
--    request) and the picture would not show on the profile. Assistants, doctors, the coordinator and Dr. Ali keep photos.view_raw and
--    see every photo, as before. Nobody deletes pictures or X-rays (no one could before either); documents keep their Delete
--    (20261015001000).
--    So that nobody who sees only their own photos (the front desk) can point a photo row at somebody else's file to read it
--    (private.photo_guard, for everyone but Dr. Ali and server jobs such as an import or merging patients):
--      - uploaded_by is always the person saving the photo, and never changes afterwards;
--      - without photos.view_raw a new row must be a photo as the website saves it: <patient>/<raw|edited>/<file>, in that patient's
--        own folder and of its own kind, its small copy (if any) at the path made from that, no other photo of the same name in that
--        folder, and no file Storage recorded as someone else's;
--      - without photos.view_raw nobody changes a photo's file, small copy, patient or kind afterwards, and "staff edit photos" lets
--        them change only the photos they uploaded themselves (until now photos.upload changed every photo of every patient);
--      - only Dr. Ali changes "may be shown on the website" (public_ok) after a photo is saved. The uploader ticks it when uploading an
--        edited photo of a patient who gave consent, as before; no screen changes it later.
-- 3. Assistants upload all three already (photos.upload, photos.view_raw, xrays.view, and documents with photos.upload since
--    20261007000400): nothing changes for them; 38_desk_uploads_dues_test.sql checks it.
-- 4. Installment plans by branch. The coordinator's "Installments due" (Coordinator -> Reminders) reads public.installment_status, which
--    shows only the plans the person may read. Until now that was billing.view ("view plans") or billing.create ("manage plans": every
--    plan of every branch), so for the coordinator (billing.edit, neither of those) the list was always empty, and every front desk login
--    read the plans of every branch's patients. Now the staff who bill at a branch ("Create invoices and take payments", billing.create:
--    the front desk) or correct its bills ("Edit or void invoices", billing.edit: the coordinator) read the payment plans and
--    installments of that branch's patients: registered there (patients.first_branch_id), or with an invoice or a payment there
--    (public.biller_sees_plans_of, yes or no), the same branches whose invoices and payments they read already ("billers view ...",
--    20261015000500; "editors view ...", 20261015000900). Whoever made a plan reads it too, so a plan the front desk saves for a patient
--    of another branch comes back from the save. billing.create still makes, changes and removes plans (only the ones it reads); the
--    coordinator only reads them. Dr. Ali and accounts (billing.view) read every plan, and a patient their own, as before.
--    So that a patient's branch cannot be moved to read their plan: only Dr. Ali, or staff who work at both branches, changes the branch
--    a patient was registered at; only Dr. Ali moves an invoice or a payment to another patient (merging patients does it); and who
--    made a plan is always the person saving it. No screen did any of these.
-- 5. "Paid" on each installment is the patient's payments since the plan started, at every branch (public.plan_paid, for whoever reads
--    the plan through billing.view, the branch rule of 4 or as the patient), so a patient who pays at another branch is not shown as
--    behind. Until now it counted only the payments the reader could see. It is one patient's plan, never a sum across patients. A plan
--    read only because the person made it keeps counting the payments that person sees.
-- 6. No new total: no function, view or report adds up plans or installments across patients for anyone, and payments_summary(),
--    total_dues(), the branch income views and doctor_summary()'s rupees still refuse the coordinator and the front desk
--    (20261015000400). What they read is rows, one patient at a time, like the invoices and payments they already read at their branches.
--
-- Additive and safe to run more than once (one grid cell set, policies dropped if they exist and made again, functions and the
-- installment_status view replaced with the same columns, triggers dropped and made again).
-- HOW TO APPLY: Supabase dashboard -> SQL Editor -> paste this whole file -> Run. It needs 20261007002000_audit_fixes.sql
-- (photos.thumb_path) and 20261007001000_installment_plans.sql (payment_plans.starts_on) first; live has both. The website already
-- shows the buttons and the list by the grid, so the order of putting the new website live and running this file does not matter:
-- run it, then reload the staff tabs (Ctrl+F5).
-- =============================================================================
begin;

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'photos' and column_name = 'thumb_path') then
    raise exception 'Apply 20261007002000_audit_fixes.sql before this file: a picture''s small copy (photos.thumb_path) must be readable by whoever uploaded it.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'payment_plans' and column_name = 'starts_on') then
    raise exception 'Apply 20261007001000_installment_plans.sql before this file: "paid" counts the payments since a plan''s start date (payment_plans.starts_on).';
  end if;
end $$;

-- 1. The front desk uploads clinic photos and X-rays.
insert into public.role_permissions (role, permission_key, allowed)
values ('front_desk', 'photos.upload', true)
on conflict (role, permission_key) do update set allowed = true where public.role_permissions.allowed is distinct from true;

-- 2. Where a photo's small copy is: "<patient>/<raw|edited>/<file>.png" -> "<patient>/<raw|edited>/thumbs/<file>.jpg", the same as the
-- website's thumbPathFor (web/js/data/supabase.js). Plain text work, no pattern matching.
create or replace function public.photo_thumb_path(p_path text)
returns text
language sql immutable set search_path = public
as $$
  select case when p_path is null then null else
    left(p_path, length(p_path) - length(split_part(reverse(p_path), '/', 1))) || 'thumbs/'
    || reverse(substr(split_part(reverse(p_path), '/', 1), position('.' in split_part(reverse(p_path), '/', 1)) + 1)) || '.jpg' end
$$;
revoke all on function public.photo_thumb_path(text) from public, anon;
grant execute on function public.photo_thumb_path(text) to authenticated;

-- Who saved a photo, where its file is, and whether it may go on the website (see 2 above). Dr. Ali and server jobs are not checked.
create schema if not exists private;
create or replace function private.photo_guard() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_thumb text;
begin
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.uploaded_by := auth.uid();
    -- (Whoever may not upload at all is refused by "staff upload photos", after this.)
    if public.has_perm('photos.upload') and not public.has_perm('photos.view_raw') then
      v_thumb := public.photo_thumb_path(new.storage_path);
      if new.patient_id is null
         or split_part(new.storage_path, '/', 1) <> new.patient_id::text
         or split_part(new.storage_path, '/', 2) <> new.kind::text
         or split_part(new.storage_path, '/', 3) = ''
         or split_part(new.storage_path, '/', 4) <> ''
         or (new.thumb_path is not null and new.thumb_path <> v_thumb) then
        raise exception 'NOT_ALLOWED: a photo is saved in its patient''s own folder (<patient>/raw or edited/<file>), with its small copy beside it in thumbs/.'
          using errcode = '42501';
      end if;
      -- (A row with the very same file is left to the unique storage_path: "duplicate key" is how the website knows a retried
      -- upload was saved the first time.)
      if exists (select 1 from public.photos o
                  where o.storage_path <> new.storage_path and (o.thumb_path = v_thumb or public.photo_thumb_path(o.storage_path) = v_thumb))
         or exists (select 1 from storage.objects so
                     where so.bucket_id = 'clinic-photos' and so.name in (new.storage_path, v_thumb)
                       and coalesce(so.owner::text, to_jsonb(so) ->> 'owner_id') <> auth.uid()::text) then
        raise exception 'NOT_ALLOWED: a photo of that name is already saved for this patient. Upload the picture again (it gets a new name).'
          using errcode = '42501';
      end if;
    end if;
  else
    new.uploaded_by := old.uploaded_by;
    if new.public_ok is distinct from old.public_ok then
      raise exception 'NOT_ALLOWED: only Dr. Ali changes whether a saved photo may be shown on the website.' using errcode = '42501';
    end if;
    if not public.has_perm('photos.view_raw')
       and (new.storage_path, new.thumb_path, new.patient_id, new.kind) is distinct from (old.storage_path, old.thumb_path, old.patient_id, old.kind) then
      raise exception 'NOT_ALLOWED: a saved photo keeps its file, patient and kind.' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.photo_guard() from public, anon, authenticated;

drop trigger if exists photos_guard on public.photos;
create trigger photos_guard before insert or update on public.photos
  for each row execute function private.photo_guard();

-- Anyone who uploads photos reads the photo rows they uploaded (raw ones included).
drop policy if exists "uploaders see their photos" on public.photos;
create policy "uploaders see their photos" on public.photos for select to authenticated
  using (uploaded_by = auth.uid() and public.has_perm('photos.upload'));

-- ... and changes only those, unless they see every raw photo (assistants, doctors, the coordinator, as before).
alter policy "staff edit photos" on public.photos
  using (public.has_perm('photos.upload') and (public.has_perm('photos.view_raw') or uploaded_by = auth.uid()))
  with check (public.has_perm('photos.upload') and (public.has_perm('photos.view_raw') or uploaded_by = auth.uid()));

-- ... and those photos' files: a clinic-photos file Storage recorded as theirs (owner, and owner_id where Storage has that column), or
-- the file of one of their photo rows in the patient's own folder and its small copy made from that path. (The raw inbox folders,
-- inbox/<branch>/<date>/, are no patient's folder.)
drop policy if exists "uploaders read their clinic photos" on storage.objects;
do $$
begin
  execute format($p$
    create policy "uploaders read their clinic photos" on storage.objects for select to authenticated
      using (bucket_id = 'clinic-photos' and public.has_perm('photos.upload')
             and (objects.owner = auth.uid() %s
                  or exists (select 1 from public.photos ph
                              where ph.uploaded_by = auth.uid() and ph.patient_id is not null
                                and (storage.foldername(objects.name))[1] = ph.patient_id::text
                                and objects.name in (ph.storage_path, public.photo_thumb_path(ph.storage_path)))))$p$,
    case when exists (select 1 from information_schema.columns where table_schema = 'storage' and table_name = 'objects' and column_name = 'owner_id')
         then 'or objects.owner_id = auth.uid()::text' else '' end);
end $$;

-- 4. The branch a patient was registered at: Dr. Ali, or staff who work at both the old and the new branch.
create or replace function private.guard_patient_branch() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_admin()
     and new.first_branch_id is distinct from old.first_branch_id
     and not (public.can_access_branch(old.first_branch_id) and public.can_access_branch(new.first_branch_id)) then
    raise exception 'NOT_ALLOWED: only Dr. Ali, or staff who work at both branches, change the branch a patient was registered at.'
      using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function private.guard_patient_branch() from public, anon, authenticated;
drop trigger if exists patients_guard_branch on public.patients;
create trigger patients_guard_branch before update of first_branch_id on public.patients
  for each row execute function private.guard_patient_branch();

-- An invoice or a payment stays with its patient (Dr. Ali moves them, merging patients does).
create or replace function private.guard_money_patient() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_admin() and new.patient_id is distinct from old.patient_id then
    raise exception 'NOT_ALLOWED: only Dr. Ali moves % to another patient.', case tg_table_name when 'invoices' then 'an invoice' else 'a payment' end
      using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function private.guard_money_patient() from public, anon, authenticated;
drop trigger if exists invoices_guard_patient on public.invoices;
create trigger invoices_guard_patient before update of patient_id on public.invoices
  for each row execute function private.guard_money_patient();
drop trigger if exists payments_guard_patient on public.payments;
create trigger payments_guard_patient before update of patient_id on public.payments
  for each row execute function private.guard_money_patient();

-- Who made a plan: always the person saving it (Dr. Ali and server jobs may set it), and it never changes after.
create or replace function private.plan_created_by() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
    else
      new.created_by := old.created_by;
    end if;
  end if;
  return new;
end $$;
revoke all on function private.plan_created_by() from public, anon, authenticated;
drop trigger if exists payment_plans_created_by on public.payment_plans;
create trigger payment_plans_created_by before insert or update on public.payment_plans
  for each row execute function private.plan_created_by();

-- Whether a patient is one of the branches the person bills at (billing.create) or corrects bills at (billing.edit): registered there,
-- or with an invoice or a payment there. Yes or no; false for anyone with neither. Security definer: it looks at the patient's branch,
-- invoices and payments whatever the caller may read, and answers nothing else.
create or replace function public.biller_sees_plans_of(p_patient uuid)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
begin
  if p_patient is null or auth.uid() is null or not (public.has_perm('billing.create') or public.has_perm('billing.edit')) then
    return false;
  end if;
  return exists (select 1 from public.patients p where p.id = p_patient and public.can_access_branch(p.first_branch_id))
      or exists (select 1 from public.invoices i where i.patient_id = p_patient and public.can_access_branch(i.branch_id))
      or exists (select 1 from public.payments y where y.patient_id = p_patient and public.can_access_branch(y.branch_id));
end $$;
revoke all on function public.biller_sees_plans_of(uuid) from public, anon;
grant execute on function public.biller_sees_plans_of(uuid) to authenticated;

-- Payment plans: "view plans" (billing.view, or the patient) stays. "manage plans" (billing.create, every plan) becomes these.
drop policy if exists "manage plans" on public.payment_plans;
drop policy if exists "branch billers view plans" on public.payment_plans;
create policy "branch billers view plans" on public.payment_plans for select to authenticated
  using (public.biller_sees_plans_of(patient_id) or (created_by = auth.uid() and public.has_perm('billing.create')));
drop policy if exists "billers add plans" on public.payment_plans;
create policy "billers add plans" on public.payment_plans for insert to authenticated
  with check (public.has_perm('billing.create'));
drop policy if exists "billers change plans" on public.payment_plans;
create policy "billers change plans" on public.payment_plans for update to authenticated
  using (public.has_perm('billing.create') and (public.has_perm('billing.view') or created_by = auth.uid() or public.biller_sees_plans_of(patient_id)))
  with check (public.has_perm('billing.create') and (public.has_perm('billing.view') or created_by = auth.uid() or public.biller_sees_plans_of(patient_id)));
drop policy if exists "billers remove plans" on public.payment_plans;
create policy "billers remove plans" on public.payment_plans for delete to authenticated
  using (public.has_perm('billing.create') and (public.has_perm('billing.view') or created_by = auth.uid() or public.biller_sees_plans_of(patient_id)));

-- Installments go with their plan: "view installments" (billing.view, or the patient) stays; "manage installments" (billing.create,
-- every installment) becomes these. (The plan read in each rule is itself limited to the plans the person reads.)
drop policy if exists "manage installments" on public.plan_installments;
drop policy if exists "branch billers view installments" on public.plan_installments;
create policy "branch billers view installments" on public.plan_installments for select to authenticated
  using (exists (select 1 from public.payment_plans p
                  where p.id = plan_installments.plan_id
                    and (public.biller_sees_plans_of(p.patient_id) or (p.created_by = auth.uid() and public.has_perm('billing.create')))));
drop policy if exists "billers add installments" on public.plan_installments;
create policy "billers add installments" on public.plan_installments for insert to authenticated
  with check (public.has_perm('billing.create') and exists (select 1 from public.payment_plans p where p.id = plan_installments.plan_id));
drop policy if exists "billers change installments" on public.plan_installments;
create policy "billers change installments" on public.plan_installments for update to authenticated
  using (public.has_perm('billing.create') and exists (select 1 from public.payment_plans p where p.id = plan_installments.plan_id))
  with check (public.has_perm('billing.create') and exists (select 1 from public.payment_plans p where p.id = plan_installments.plan_id));
drop policy if exists "billers remove installments" on public.plan_installments;
create policy "billers remove installments" on public.plan_installments for delete to authenticated
  using (public.has_perm('billing.create') and exists (select 1 from public.payment_plans p where p.id = plan_installments.plan_id));

-- 5. What one patient has paid since their plan started, at every branch: for Dr. Ali and accounts (billing.view), the patient, and the
-- staff of the patient's branches (biller_sees_plans_of). Anyone else gets nothing (null). One plan, one patient: never a sum across them.
create or replace function public.plan_paid(p_plan uuid)
returns numeric
language plpgsql stable security definer set search_path = public
as $$
declare
  v_patient uuid;
  v_starts date;
begin
  select pl.patient_id, pl.starts_on into v_patient, v_starts from public.payment_plans pl where pl.id = p_plan;
  if v_patient is null or auth.uid() is null
     or not (public.has_perm('billing.view') or coalesce(v_patient = public.current_patient_id(), false) or public.biller_sees_plans_of(v_patient)) then
    return null;
  end if;
  return (select coalesce(sum(y.amount), 0) from public.payments y
           where y.patient_id = v_patient and (y.received_at at time zone 'Asia/Karachi')::date >= v_starts);
end $$;
revoke all on function public.plan_paid(uuid) from public, anon;
grant execute on function public.plan_paid(uuid) to authenticated;

-- installment_status as 20261007001000_installment_plans.sql made it (the same columns), with "paid" from plan_paid where the person
-- may have it, else from the payments they read.
create or replace view public.installment_status
with (security_invoker = true) as
with inst as (
  select i.id, i.plan_id, p.patient_id, p.braces_case_id, p.starts_on, p.total_fee, i.due_date, i.amount, i.note,
         sum(i.amount) over (partition by i.plan_id order by i.due_date, i.id) as cum_due
    from public.plan_installments i
    join public.payment_plans p on p.id = i.plan_id),
paid as (
  select pl.id as plan_id, coalesce(public.plan_paid(pl.id), coalesce(sum(pay.amount), 0)) as paid
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

commit;

-- Tell the API about the new functions straight away.
notify pgrst, 'reload schema';
