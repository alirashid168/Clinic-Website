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
--    photos"), add X-ray rows ("upload xrays"), store files in the clinic-photos and xrays buckets, and add or delete documents (the
--    front desk could already, with patients.edit). Consent forms need nothing new. X-rays need nothing new either: the front desk has
--    "View X-rays" (xrays.view), so it reads back the X-ray row and file it saves.
-- 2. Seeing the pictures it uploads. A picture goes in as a raw photo (staff only). Raw photos are read with "View raw clinic photos
--    folder" (photos.view_raw): every raw photo row of every patient and every file of the clinic-photos bucket, the raw inbox folders
--    included. The front desk is NOT given that. Instead, anyone with photos.upload reads the photo rows they uploaded themselves
--    ("uploaders see their photos") and those photos' files and small copies ("uploaders read their clinic photos": a file under the
--    patient's own folder that is the storage_path or thumb_path of such a row). Without this the front desk's upload would fail (the
--    website saves the row and reads it back in one request) and the picture would not show on the profile. Assistants, doctors, the
--    coordinator and Dr. Ali keep photos.view_raw and see every photo, as before. A photo's uploaded_by is now always the person who
--    saved it (private.photo_uploaded_by, for everyone but Dr. Ali and server jobs), so nobody can claim someone else's photo to read
--    it. Nobody deletes pictures or X-rays (no one could before either); documents keep their Delete (20261015001000).
-- 3. Assistants upload all three already (photos.upload, photos.view_raw, xrays.view, and documents with photos.upload since
--    20261007000400): nothing changes for them; 38_desk_uploads_dues_test.sql checks it.
-- 4. The coordinator's "Installments due" (Coordinator -> Reminders) reads public.installment_status, which shows only the plans the
--    person may read. Until now that was billing.view or billing.create (the "view plans" and "manage plans" policies), so for the
--    coordinator (billing.edit, neither of those) the list was always empty. Now "Edit or void invoices" (billing.edit) also reads the
--    payment plans and installments of the patients of the branches the person works at: the patient was registered at one of them
--    (patients.first_branch_id), or has an invoice or a payment at one of them, the same branches whose invoices and payments
--    billing.edit reads already ("editors view ..." policies, 20261015000900). public.editor_sees_plans_of(patient) says it, yes or no.
--    Each row of installment_status is one installment of one patient's plan (due date, amount, how far that patient is behind); the
--    website lists them and adds nothing up. "Paid" counts that patient's payments the person may read (for billing.edit: at their
--    branches), as for everyone who reads the view.
-- 5. No new total: no function, view or report adds up plans or installments for anyone, and payments_summary(), total_dues(), the
--    branch income views and doctor_summary()'s rupees still refuse the coordinator and the front desk (20261015000400). What the
--    coordinator reads is rows, one patient at a time, like the invoices and payments she already reads at her branches.
--
-- What this file does not change (found while making it, for Dr. Ali to decide)
--   - "manage plans" and "manage installments" (20261005000300) are FOR ALL policies, so billing.create (the front desk) reads every
--     payment plan and installment of every branch, not only its own. Creating a plan from the front desk works because of that. The
--     front desk's "Installments due" therefore lists the whole clinic's (per patient, no totals), with "paid" counted from the
--     payments of its own branches only.
--
-- Additive and safe to run more than once (one grid cell set, policies dropped if they exist and made again, functions replaced).
-- HOW TO APPLY: Supabase dashboard -> SQL Editor -> paste this whole file -> Run. It needs 20261007002000_audit_fixes.sql
-- (photos.thumb_path) first; live has it. The website already shows the buttons and the list by the grid, so the order of putting the
-- new website live and running this file does not matter: run it, then reload the staff tabs (Ctrl+F5).
-- =============================================================================
begin;

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'photos' and column_name = 'thumb_path') then
    raise exception 'Apply 20261007002000_audit_fixes.sql before this file: a picture''s small copy (photos.thumb_path) must be readable by whoever uploaded it.';
  end if;
end $$;

-- 1. The front desk uploads clinic photos and X-rays.
insert into public.role_permissions (role, permission_key, allowed)
values ('front_desk', 'photos.upload', true)
on conflict (role, permission_key) do update set allowed = true where public.role_permissions.allowed is distinct from true;

-- 2. Who saved a photo: always the person saving it (Dr. Ali and server jobs may set it, an import for one), and it never changes after.
create schema if not exists private;
create or replace function private.photo_uploaded_by() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if tg_op = 'INSERT' then
      new.uploaded_by := auth.uid();
    else
      new.uploaded_by := old.uploaded_by;
    end if;
  end if;
  return new;
end $$;
revoke all on function private.photo_uploaded_by() from public, anon, authenticated;

drop trigger if exists photos_uploaded_by on public.photos;
create trigger photos_uploaded_by before insert or update of uploaded_by on public.photos
  for each row execute function private.photo_uploaded_by();

-- Anyone who uploads photos reads the photo rows they uploaded (raw ones included).
drop policy if exists "uploaders see their photos" on public.photos;
create policy "uploaders see their photos" on public.photos for select to authenticated
  using (uploaded_by = auth.uid() and public.has_perm('photos.upload'));

-- ... and those photos' files and small copies: a file in the patient's own folder that one of their rows names. (The raw inbox
-- folders, inbox/<branch>/<date>/, are no patient's folder, so a row naming one of those files opens nothing.) Also a file Storage
-- recorded as theirs (objects.owner, which Storage fills in with the uploader's login), so the picture and its small copy can be read
-- back in the moment between storing them and saving the row.
drop policy if exists "uploaders read their clinic photos" on storage.objects;
create policy "uploaders read their clinic photos" on storage.objects for select to authenticated
  using (bucket_id = 'clinic-photos' and public.has_perm('photos.upload')
         and (objects.owner = auth.uid()
              or exists (select 1 from public.photos ph
                          where ph.uploaded_by = auth.uid() and ph.patient_id is not null
                            and (storage.foldername(objects.name))[1] = ph.patient_id::text
                            and objects.name in (ph.storage_path, ph.thumb_path))));

-- 4. billing.edit reads the payment plans and installments of the patients of its branches (rows only, one patient at a time).
-- Yes or no; false for anyone without billing.edit. Security definer: it looks at the patient's branch, invoices and payments
-- whatever the caller may read, and answers nothing else.
create or replace function public.editor_sees_plans_of(p_patient uuid)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
begin
  if p_patient is null or auth.uid() is null or not public.has_perm('billing.edit') then
    return false;
  end if;
  return exists (select 1 from public.patients p where p.id = p_patient and public.can_access_branch(p.first_branch_id))
      or exists (select 1 from public.invoices i where i.patient_id = p_patient and public.can_access_branch(i.branch_id))
      or exists (select 1 from public.payments y where y.patient_id = p_patient and public.can_access_branch(y.branch_id));
end $$;
revoke all on function public.editor_sees_plans_of(uuid) from public, anon;
grant execute on function public.editor_sees_plans_of(uuid) to authenticated;

drop policy if exists "editors view plans" on public.payment_plans;
create policy "editors view plans" on public.payment_plans for select to authenticated
  using (public.editor_sees_plans_of(patient_id));

drop policy if exists "editors view installments" on public.plan_installments;
create policy "editors view installments" on public.plan_installments for select to authenticated
  using (exists (select 1 from public.payment_plans p
                  where p.id = plan_installments.plan_id and public.editor_sees_plans_of(p.patient_id)));

commit;

-- Tell the API about the new function straight away.
notify pgrst, 'reload schema';
