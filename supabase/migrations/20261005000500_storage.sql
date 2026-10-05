-- =====================================================================
-- File storage (photos, X-rays, receipts). All private except the
-- public before/after gallery, which only holds consented, edited photos.
-- Paths: <bucket>/<patient_id>/<date>_<label>.<ext>
-- Raw daily uploads: clinic-photos/inbox/<branch_code>/<date>/<file>
-- =====================================================================

insert into storage.buckets (id, name, public) values
  ('clinic-photos', 'clinic-photos', false),
  ('xrays',         'xrays',         false),
  ('receipts',      'receipts',      false),
  ('public-cases',  'public-cases',  true)
on conflict (id) do nothing;

-- Staff with photo permissions work with clinic photos and X-rays.
create policy "staff read clinic photos" on storage.objects for select
  using (bucket_id = 'clinic-photos'
         and (public.has_perm('photos.view_raw')
              or ((storage.foldername(name))[1] <> 'inbox' and public.has_perm('patients.view'))));
create policy "staff upload clinic photos" on storage.objects for insert
  with check (bucket_id = 'clinic-photos' and public.has_perm('photos.upload'));

-- Patients can read their own edited photos (folder = their patient id, file under /edited/).
create policy "patients read own edited photos" on storage.objects for select
  using (bucket_id = 'clinic-photos'
         and (storage.foldername(name))[1] = public.current_patient_id()::text
         and (storage.foldername(name))[2] = 'edited');

create policy "staff read xrays" on storage.objects for select
  using (bucket_id = 'xrays' and public.has_perm('xrays.view'));
create policy "patients read own xrays" on storage.objects for select
  using (bucket_id = 'xrays' and (storage.foldername(name))[1] = public.current_patient_id()::text);
create policy "staff upload xrays" on storage.objects for insert
  with check (bucket_id = 'xrays' and public.has_perm('photos.upload'));

create policy "accounts read receipts" on storage.objects for select
  using (bucket_id = 'receipts' and public.has_perm('finance.view'));
create policy "accounts upload receipts" on storage.objects for insert
  with check (bucket_id = 'receipts' and public.has_perm('expenses.manage'));

-- Public gallery: only admin publishes (after checking patient consent).
create policy "admin publishes cases" on storage.objects for insert
  with check (bucket_id = 'public-cases' and public.is_admin());
create policy "admin removes cases" on storage.objects for delete
  using (bucket_id = 'public-cases' and public.is_admin());
