-- =============================================================================
-- Patient profile: "Upload picture", "Upload X-ray", "Upload consent form", and Delete for documents.
--
-- The owner (Dr. Ali, 15 Oct 2026): "there should be a upload picture and upload x ray button on all patient profile and consent
-- form upload button with add or delete option too".
--
-- 1. Delete for documents: whoever may add a document (patients.edit or photos.upload: front desk, assistants, doctors, the
--    coordinator and admin) may now delete one, the row and its file (until now admin only). The page removes the file first,
--    then calls public.delete_patient_document(), which removes the row and, when the person asks, unticks "Consent signed" once
--    no consent form is left on the record. Anyone else is refused, by the policies and by the function.
-- 2. The audit log records every document added, changed or deleted (patient_documents had no audit trigger).
-- 3. A consent form saved on the record ticks "Consent signed" (patients.treatment_consent_at) when it is not ticked yet. The
--    database does it, because an assistant may add a consent form but may not edit the patient's details. The time is the
--    form's date (noon in Pakistan), or now when that is earlier.
-- X-rays need nothing new: the page saves them in the existing xrays table and private "xrays" bucket (adding one needs
-- photos.upload, seeing them xrays.view), as the first migrations set up.
--
-- Additive and safe to run more than once.
-- HOW TO APPLY: Supabase dashboard -> SQL Editor -> paste this whole file -> Run.
-- =============================================================================

-- 1. Who may delete a document: the people who may add one (the admin's own policies stay).
drop policy if exists "staff remove patient documents" on public.patient_documents;
create policy "staff remove patient documents" on public.patient_documents for delete
  using (public.has_perm('patients.edit') or public.has_perm('photos.upload'));

drop policy if exists "staff remove patient documents files" on storage.objects;
create policy "staff remove patient documents files" on storage.objects for delete
  using (bucket_id = 'patient-documents' and (public.has_perm('patients.edit') or public.has_perm('photos.upload')));

-- 2. The audit log: who added, changed or deleted which document (the whole row, file path included).
drop trigger if exists patient_documents_audit on public.patient_documents;
create trigger patient_documents_audit after insert or update or delete on public.patient_documents
  for each row execute function public.audit_row();

-- 3. A consent form ticks "Consent signed" when it is not ticked yet (an existing tick and its date stay as they are).
create schema if not exists private;
create or replace function private.document_marks_consent() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  update public.patients
     set treatment_consent_at = least(now(), (new.added_on + time '12:00') at time zone 'Asia/Karachi')
   where id = new.patient_id and treatment_consent_at is null;
  return null;
end $$;
revoke all on function private.document_marks_consent() from public, anon, authenticated;

drop trigger if exists patient_documents_mark_consent on public.patient_documents;
create trigger patient_documents_mark_consent after insert on public.patient_documents
  for each row when (new.kind = 'consent') execute function private.document_marks_consent();

-- 4. Delete a document's row (the page has removed its file first, so a failure in between leaves the row on the record to delete
--    again, never a file nobody can find), and with p_clear_consent untick "Consent signed" when no consent form is left.
--    Answers { deleted, consent_cleared, consent_forms_left }; deleted is false when the row was already gone (another tab).
create or replace function public.delete_patient_document(p_document uuid, p_clear_consent boolean default false)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_doc public.patient_documents;
  v_left int := 0;
  v_cleared boolean := false;
begin
  if not (public.has_perm('patients.edit') or public.has_perm('photos.upload')) then
    raise exception 'NOT_ALLOWED: you may not delete documents from a patient''s record. Ask Dr. Ali to tick it in the access list.'
      using errcode = '42501';
  end if;
  delete from public.patient_documents where id = p_document returning * into v_doc;
  if v_doc.id is null then
    return jsonb_build_object('deleted', false, 'consent_cleared', false, 'consent_forms_left', null);
  end if;
  select count(*) into v_left from public.patient_documents where patient_id = v_doc.patient_id and kind = 'consent';
  if p_clear_consent and v_doc.kind = 'consent' and v_left = 0 then
    update public.patients set treatment_consent_at = null where id = v_doc.patient_id and treatment_consent_at is not null;
    v_cleared := found;
  end if;
  return jsonb_build_object('deleted', true, 'consent_cleared', v_cleared, 'consent_forms_left', v_left);
end $$;
revoke all on function public.delete_patient_document(uuid, boolean) from public, anon;
grant execute on function public.delete_patient_document(uuid, boolean) to authenticated;
