-- =====================================================================
-- Patient documents: signed consent forms, ID copies, reports — files that
-- belong on the patient's record but are not clinical photos or X-rays.
-- Stored in the private "patient-documents" bucket as <patient_id>/<file>.
-- =====================================================================
create table public.patient_documents (
  id            uuid primary key default gen_random_uuid(),
  patient_id    uuid not null references public.patients(id) on delete cascade,
  kind          text not null default 'other' check (kind in ('consent', 'id', 'report', 'other')),
  title         text not null,
  storage_path  text not null unique,
  added_on      date not null default current_date,
  notes         text,
  legacy_source text,
  uploaded_by   uuid,
  created_at    timestamptz not null default now()
);
create index patient_documents_patient_idx on public.patient_documents (patient_id, added_on desc);

alter table public.patient_documents enable row level security;
create policy "staff view patient documents" on public.patient_documents for select
  using (public.has_perm('patients.view') or patient_id = public.current_patient_id());
create policy "staff add patient documents" on public.patient_documents for insert
  with check (public.has_perm('patients.edit') or public.has_perm('photos.upload'));
create policy "admin removes patient documents" on public.patient_documents for delete
  using (public.is_admin());

insert into storage.buckets (id, name, public) values ('patient-documents', 'patient-documents', false)
  on conflict (id) do nothing;

create policy "staff read patient documents" on storage.objects for select
  using (bucket_id = 'patient-documents'
         and (public.has_perm('patients.view')
              or (storage.foldername(name))[1] = public.current_patient_id()::text));
create policy "staff upload patient documents" on storage.objects for insert
  with check (bucket_id = 'patient-documents' and (public.has_perm('patients.edit') or public.has_perm('photos.upload')));
create policy "admin removes patient documents files" on storage.objects for delete
  using (bucket_id = 'patient-documents' and public.is_admin());
