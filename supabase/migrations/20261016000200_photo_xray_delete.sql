-- =============================================================================
-- Delete for pictures and X-rays on the patient profile: assistants, the clinic coordinator and Dr. Ali.
--
-- The owner (Dr. Ali, 16 Oct 2026), asked "pictures and X-rays have no Delete button; only consent forms do. Should the front desk and
-- assistants be able to delete a wrong picture or X-ray, or should that stay with you?": "they can delete assistant and coordinator".
-- So: assistants and the coordinator (and Dr. Ali) delete a patient's picture or X-ray. The front desk uploads them (20261016000100) but
-- does not delete them; doctors and accounts were not named, so they do not either. Each can be changed in the access list.
--
-- 1. The role grid: a new row "Delete clinic photos and X-rays" (photos.delete, under Photos): ticked for the assistant, the coordinator
--    and admin; not for the front desk, the doctor or the accountant. Every role gets its cell, like the other rows.
-- 2. Deleting one picture or one X-ray: public.delete_patient_photo() and public.delete_patient_xray(), the same way documents are deleted
--    (20261015001000_patient_documents_delete.sql). The page removes the files first, through Storage, then calls the function, which
--    removes the row; a failure in between leaves the row on the record to delete again, never a file nobody can find. (SQL cannot
--    remove Storage files: Supabase refuses a direct delete from storage.objects, and the file itself would stay behind anyway.)
--    The function refuses anyone without photos.delete, and anyone who does not see that picture or X-ray. Who sees what stays as it is:
--    patients, their pictures and X-rays are seen at every branch (patients.view, photos.view_raw and xrays.view are not limited by
--    branch; a patient's record is shared by the branches), so whoever may delete deletes what they see on the profile: an edited picture
--    with patients.view, a raw one with "View raw clinic photos folder" (or the raw pictures they uploaded themselves), an X-ray with
--    "View X-rays". Answers { deleted, edited_copies, visit_unticked } for a picture, { deleted } for an X-ray; deleted is false when the
--    row was already gone (another tab).
--    Nobody deletes these rows any other way: there is no DELETE policy on photos or xrays (there never was), so a direct delete through
--    the API reaches no row, for anyone, and the function's rules always apply.
-- 3. The files. Whoever has photos.delete removes, through Storage:
--      - in clinic-photos: the file of a photo row they see, and its small copy (thumb_path, only where it is the path made from the
--        photo's own path, public.photo_thumb_path, so a row cannot be pointed at some other file to remove it);
--      - in xrays: the file of an X-ray row they see;
--      - in public-cases (the website's "Our results" gallery): the copy Dr. Ali published of an edited photo they see (the website names
--        it <date taken>_<label>_<first 8 characters of the photo id>.<ext>, publishPhoto in web/js/data/supabase.js), so a picture that
--        was put on the website comes off it when it is deleted. Until now only Dr. Ali removed gallery files; he still removes any.
--    Nobody else removes a file in these buckets (Dr. Ali's own policies stay).
-- 4. What a deleted picture takes with it:
--      - an edited picture is what the patient sees on their page (the portal shows their edited pictures), and one marked "may be shown
--        on the website" (public_ok) may be in the gallery: it disappears from both (the page says so before it is deleted);
--      - a raw picture that edited pictures were made from (photos.edited_from): the edited pictures stay (they are pictures of their own,
--        and may be what the patient sees); they simply no longer point at the deleted one (edited_from is emptied, in the audit log);
--      - the visit it was uploaded for (photos.visit_id): when it was that visit's last picture, the visit's "photos uploaded" tick
--        (visits.photos_uploaded) is taken off again, so a photo month whose only picture was a wrong one asks for photos again. A visit
--        already completed stays completed.
--    Nothing else points at a picture or an X-ray (no other foreign key; the X-ray store has none at all).
-- 5. The audit log records every picture and X-ray added, changed or deleted, with the whole row (file path included): photos and
--    xrays had no audit trigger.
--
-- Additive and safe to run more than once (the grid row added only where it is missing, so a choice made in the access list is never
-- overwritten; policies, triggers and functions dropped if they exist and made again; three indexes made if missing). No backslash
-- anywhere in this file.
-- HOW TO APPLY: Supabase dashboard -> SQL Editor -> paste this whole file -> Run. It needs 20261016000100_desk_uploads_coordinator_dues.sql
-- (public.photo_thumb_path) first; live has it. Then put the new website live and reload the staff tabs (Ctrl+F5). The website shows
-- Delete by the grid; before this file is run, Delete says the database update is missing and removes nothing.
-- =============================================================================
begin;

do $$
begin
  if to_regprocedure('public.photo_thumb_path(text)') is null then
    raise exception 'Apply 20261016000100_desk_uploads_coordinator_dues.sql before this file: the small copy of a picture is found with public.photo_thumb_path.';
  end if;
end $$;

-- 1. The role grid: assistants, the coordinator and Dr. Ali delete pictures and X-rays (on conflict do nothing: a cell that is there
-- already, a choice made in the access list, is never changed).
insert into public.permissions (key, label, category, sort_order) values
  ('photos.delete', 'Delete clinic photos and X-rays', 'Photos', 53)
on conflict (key) do nothing;
insert into public.role_permissions (role, permission_key, allowed)
select r.role, 'photos.delete', r.role in ('assistant', 'coordinator', 'admin')
  from unnest(enum_range(null::public.staff_role)) as r(role)
on conflict (role, permission_key) do nothing;

-- 5. The audit log: who added, changed or deleted which picture or X-ray (the whole row).
drop trigger if exists photos_audit on public.photos;
create trigger photos_audit after insert or update or delete on public.photos
  for each row execute function public.audit_row();
drop trigger if exists xrays_audit on public.xrays;
create trigger xrays_audit after insert or update or delete on public.xrays
  for each row execute function public.audit_row();

-- Indexes for the lookups below (a file's photo by its small copy; the edited pictures made from a photo; a visit's pictures).
create index if not exists photos_thumb_path_idx on public.photos (thumb_path) where thumb_path is not null;
create index if not exists photos_edited_from_idx on public.photos (edited_from) where edited_from is not null;
create index if not exists photos_visit_id_idx on public.photos (visit_id) where visit_id is not null;

-- Which photo a gallery file was published from: "<date taken>_<label>_<first 8 characters of the photo id>.<ext>" at the top of
-- public-cases, as publishPhoto names it. Null when the name is not shaped like that, or no edited photo the person sees has that date and
-- id. Plain text work, no pattern with a backslash. Security invoker: it reads only the photos the person may read.
create or replace function public.website_copy_photo(p_name text)
returns uuid
language plpgsql stable set search_path = public
as $$
declare
  v_base text;
  v_id8 text;
  v_id uuid;
begin
  if p_name is null or position('/' in p_name) > 0 or position('.' in p_name) = 0 or length(p_name) < 21 then
    return null;
  end if;
  v_base := reverse(substr(reverse(p_name), position('.' in reverse(p_name)) + 1));   -- the name without its extension
  v_id8 := right(v_base, 8);
  if v_id8 !~ '^[0-9a-f]{8}$' or substr(v_base, length(v_base) - 8, 1) <> '_' then
    return null;
  end if;
  select ph.id into v_id from public.photos ph
   where ph.id between (v_id8 || '-0000-0000-0000-000000000000')::uuid and (v_id8 || '-ffff-ffff-ffff-ffffffffffff')::uuid
     and ph.kind = 'edited' and left(p_name, 11) = to_char(ph.taken_on, 'YYYY-MM-DD') || '_'
   order by ph.id
   limit 1;
  return v_id;
end $$;
revoke all on function public.website_copy_photo(text) from public, anon;
grant execute on function public.website_copy_photo(text) to authenticated;

-- 3. The files. (The rows looked at here are only the ones the person sees: the photos and xrays row policies apply inside.)
-- A photo's file, or its small copy when the row names it at the path made from the photo's own path.
drop policy if exists "photo deleters remove clinic photos" on storage.objects;
create policy "photo deleters remove clinic photos" on storage.objects for delete to authenticated
  using (bucket_id = 'clinic-photos' and public.has_perm('photos.delete')
         and (exists (select 1 from public.photos ph where ph.storage_path = objects.name)
              or exists (select 1 from public.photos ph
                          where ph.thumb_path = objects.name and ph.thumb_path = public.photo_thumb_path(ph.storage_path))));

drop policy if exists "photo deleters remove xray files" on storage.objects;
create policy "photo deleters remove xray files" on storage.objects for delete to authenticated
  using (bucket_id = 'xrays' and public.has_perm('photos.delete')
         and exists (select 1 from public.xrays x where x.storage_path = objects.name));

drop policy if exists "photo deleters remove website copies" on storage.objects;
create policy "photo deleters remove website copies" on storage.objects for delete to authenticated
  using (bucket_id = 'public-cases' and public.has_perm('photos.delete')
         and exists (select 1 from public.photos ph where ph.id = public.website_copy_photo(objects.name)));

-- 2. Delete one picture (the page has removed its files first). Edited pictures made from it stay and no longer point at it; its visit's
-- "photos uploaded" tick comes off when it was the visit's last picture.
create or replace function public.delete_patient_photo(p_photo uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_photo public.photos;
  v_copies int := 0;
  v_unticked boolean := false;
begin
  if not public.has_perm('photos.delete') then
    raise exception 'NOT_ALLOWED: you may not delete pictures from a patient''s record. Ask Dr. Ali to tick "Delete clinic photos and X-rays" in the access list.'
      using errcode = '42501';
  end if;
  select * into v_photo from public.photos where id = p_photo for update;
  if v_photo.id is null then
    return jsonb_build_object('deleted', false, 'edited_copies', 0, 'visit_unticked', false);
  end if;
  -- The pictures the person sees (the "staff view photos" and "uploaders see their photos" policies).
  if not ((v_photo.kind = 'edited' and public.has_perm('patients.view'))
          or public.has_perm('photos.view_raw')
          or (v_photo.uploaded_by = auth.uid() and public.has_perm('photos.upload'))) then
    raise exception 'NOT_ALLOWED: you may not delete this picture: it is a raw picture, and raw pictures need "View raw clinic photos folder" in the access list.'
      using errcode = '42501';
  end if;
  update public.photos set edited_from = null where edited_from = v_photo.id;
  get diagnostics v_copies = row_count;
  delete from public.photos where id = v_photo.id;
  if v_photo.visit_id is not null and not exists (select 1 from public.photos where visit_id = v_photo.visit_id) then
    update public.visits set photos_uploaded = false where id = v_photo.visit_id and photos_uploaded;
    v_unticked := found;
  end if;
  return jsonb_build_object('deleted', true, 'edited_copies', v_copies, 'visit_unticked', v_unticked);
end $$;
revoke all on function public.delete_patient_photo(uuid) from public, anon;
grant execute on function public.delete_patient_photo(uuid) to authenticated;

-- Delete one X-ray (the page has removed its file first).
create or replace function public.delete_patient_xray(p_xray uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_xray public.xrays;
begin
  if not public.has_perm('photos.delete') then
    raise exception 'NOT_ALLOWED: you may not delete X-rays from a patient''s record. Ask Dr. Ali to tick "Delete clinic photos and X-rays" in the access list.'
      using errcode = '42501';
  end if;
  select * into v_xray from public.xrays where id = p_xray for update;
  if v_xray.id is null then
    return jsonb_build_object('deleted', false);
  end if;
  if not public.has_perm('xrays.view') then
    raise exception 'NOT_ALLOWED: you may not delete this X-ray: X-rays need "View X-rays" in the access list.' using errcode = '42501';
  end if;
  delete from public.xrays where id = v_xray.id;
  return jsonb_build_object('deleted', true);
end $$;
revoke all on function public.delete_patient_xray(uuid) from public, anon;
grant execute on function public.delete_patient_xray(uuid) to authenticated;

commit;

-- Tell the API about the new functions straight away.
notify pgrst, 'reload schema';
