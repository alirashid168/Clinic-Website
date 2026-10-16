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
-- 2. Who deletes what. Whoever has photos.delete deletes a picture or an X-ray they see on the profile. Who sees what stays as it is:
--    patients, their pictures and X-rays are seen at every branch (patients.view, photos.view_raw and xrays.view are not limited by
--    branch; a patient's record is shared by the branches), so: an edited picture with patients.view, a raw one with "View raw clinic
--    photos folder" (or the raw pictures they uploaded themselves), an X-ray with "View X-rays".
--    Nobody deletes these rows any other way: there is no DELETE policy on photos or xrays (there never was), so a direct delete through
--    the API reaches no row, for anyone.
-- 3. Three steps, so that the audit log knows who took a picture away before anything is gone (SQL cannot remove Storage files: Supabase
--    refuses a direct delete from storage.objects, and the file itself would stay behind, so the page removes them through Storage):
--      a. public.begin_photo_delete() / begin_xray_delete(): the database works out the files that go with the picture or X-ray and writes
--         them in the audit log (action DELETE_FILES: who, when, the whole row, the files). The page never chooses the files itself.
--      b. The page removes those files through Storage. A file in clinic-photos, xrays or public-cases can be removed only by someone with
--         photos.delete who asked for that very file in the last 15 minutes (public.photo_file_removable). So no file goes without its
--         line in the audit log, and nobody removes a file by naming it.
--      c. public.delete_patient_photo() / delete_patient_xray() remove the row, only once its files are gone (FILES_LEFT otherwise: a
--         file Storage did not remove keeps the row on the record, and Delete can be pressed again). The row's delete is in the audit
--         log too, with the whole row.
--    The files of a picture: its own file, only where it is a picture's file in its patient's own folder (<patient>/<raw|edited>/<file>;
--    or the folder of a patient merged into this one, whose record is gone), its small copy at the path made from that
--    (public.photo_thumb_path, whether the row names it or not, so a small copy whose name was lost goes too) and the small copy the row
--    names when it is beside it in thumbs/; never a file that another picture's row names or whose small copy it is. So a row pointed
--    at someone else's picture, a raw inbox file (inbox/<branch>/<date>/) or another patient's file takes nothing with it.
--    For an edited picture also its copy in the website's "Our results" gallery (public-cases), named by publishPhoto in
--    web/js/data/supabase.js "<date taken>_<label>_<first 8 characters of the photo id>.<ext>", and only a copy put there after the
--    picture was saved (a picture's saved time, photos.created_at, is now always the moment it was saved: private.photo_guard), so a
--    picture saved with a made-up id cannot take another picture's gallery copy. Until now only Dr. Ali removed gallery files; he still
--    removes any.
--    The file of an X-ray: its own file, in its patient's own folder (<patient>/<file>, or that of a patient merged into this one).
-- 4. What a deleted picture takes with it:
--      - an edited picture is what the patient sees on their page (the portal shows their edited pictures), and one marked "may be shown
--        on the website" (public_ok) may be in the gallery: it disappears from both (the page says so before it is deleted);
--      - a raw picture that edited pictures were made from (photos.edited_from): the edited pictures stay (they are pictures of their own,
--        and may be what the patient sees); they simply no longer point at the deleted one (edited_from is emptied, in the audit log);
--      - the visit it was uploaded for (photos.visit_id): when it was that visit's last picture, the visit's "photos uploaded" tick
--        (visits.photos_uploaded) is taken off again. The answer says whether that visit now asks for photos (a photo month not yet
--        completed asks for them again before it is completed); a completed visit stays completed.
--    Nothing else points at a picture or an X-ray (no other foreign key; the X-ray store has none at all).
-- 5. The audit log records every picture and X-ray added, changed or deleted, with the whole row (file path included): photos and
--    xrays had no audit trigger.
--
-- Additive and safe to run more than once (the grid row added only where it is missing, so a choice made in the access list is never
-- overwritten; policies, triggers and functions dropped if they exist and made again; indexes made if missing). private.photo_guard
-- (20261016000100) is made again with the same rules plus one: created_at is the moment a picture is saved, and never changes.
-- No backslash anywhere in this file.
-- HOW TO APPLY: Supabase dashboard -> SQL Editor -> paste this whole file -> Run. It needs 20261016000100_desk_uploads_coordinator_dues.sql
-- (public.photo_thumb_path, private.photo_guard) first; live has it. Then put the new website live and reload the staff tabs (Ctrl+F5).
-- The website shows Delete by the grid; before this file is run, Delete says the database update is missing and removes nothing.
-- =============================================================================
begin;

do $$
begin
  if to_regprocedure('public.photo_thumb_path(text)') is null or to_regprocedure('private.photo_guard()') is null then
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

-- Indexes for the lookups below (a file named by another picture, as its small copy or as the small copy made from its path; the edited
-- pictures made from a photo; a visit's pictures; the files a person asked to remove).
create index if not exists photos_thumb_path_idx on public.photos (thumb_path) where thumb_path is not null;
create index if not exists photos_thumb_of_path_idx on public.photos (public.photo_thumb_path(storage_path));
create index if not exists photos_edited_from_idx on public.photos (edited_from) where edited_from is not null;
create index if not exists photos_visit_id_idx on public.photos (visit_id) where visit_id is not null;
create index if not exists audit_log_delete_files_idx on public.audit_log (actor, at) where action = 'DELETE_FILES';

-- 3. A picture's saved time is the moment it is saved (for everyone but Dr. Ali and server jobs), and never changes: the gallery copy of
-- an edited picture is matched only to a picture saved before the copy was made. Otherwise the same as 20261016000100.
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
    new.created_at := now();
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
    new.created_at := old.created_at;
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

-- A file's folder (the part before the first "/") is the patient's own: the patient's id, or the id of a patient whose record is gone
-- (merged into this one: merging moves the rows, not the files). Anything else (the raw inbox, another patient's folder) is not.
create or replace function private.media_folder_ok(p_folder text, p_patient uuid)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
begin
  if p_patient is null or p_folder is null then
    return false;
  end if;
  if p_folder = p_patient::text then
    return true;
  end if;
  if p_folder !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return not exists (select 1 from public.patients pt where pt.id = p_folder::uuid);
end $$;
revoke all on function private.media_folder_ok(text, uuid) from public, anon, authenticated;

-- The pictures a person with photos.delete may delete: the ones they see ("staff view photos", "uploaders see their photos").
create or replace function private.deleter_sees_photo(p public.photos)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((p.kind = 'edited' and public.has_perm('patients.view'))
                  or public.has_perm('photos.view_raw')
                  or (p.uploaded_by = auth.uid() and public.has_perm('photos.upload')), false)
$$;
revoke all on function private.deleter_sees_photo(public.photos) from public, anon, authenticated;

-- The files that go with a picture (see 3 above), as [{bucket, name}]: its own file and small copies in clinic-photos, and for an edited
-- picture its copies in the public-cases gallery. Never a file another picture's row names (its file, its small copy, or the small copy
-- made from its path).
create or replace function private.photo_files(p public.photos)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_folder text := split_part(p.storage_path, '/', 1);
  v_names text[] := '{}';
  v_name text;
  v_out jsonb := '[]'::jsonb;
begin
  if split_part(p.storage_path, '/', 2) = p.kind::text and split_part(p.storage_path, '/', 3) <> '' and split_part(p.storage_path, '/', 4) = ''
     and private.media_folder_ok(v_folder, p.patient_id) then
    v_names := array[p.storage_path, public.photo_thumb_path(p.storage_path)];
    if p.thumb_path is not null and split_part(p.thumb_path, '/', 1) = v_folder and split_part(p.thumb_path, '/', 2) = p.kind::text
       and split_part(p.thumb_path, '/', 3) = 'thumbs' and split_part(p.thumb_path, '/', 4) <> '' and split_part(p.thumb_path, '/', 5) = '' then
      v_names := v_names || p.thumb_path;
    end if;
    foreach v_name in array v_names loop
      if not v_out @> jsonb_build_array(jsonb_build_object('bucket', 'clinic-photos', 'name', v_name))
         and not exists (select 1 from public.photos o
                          where o.id <> p.id
                            and (o.storage_path = v_name or o.thumb_path = v_name or public.photo_thumb_path(o.storage_path) = v_name)) then
        v_out := v_out || jsonb_build_array(jsonb_build_object('bucket', 'clinic-photos', 'name', v_name));
      end if;
    end loop;
  end if;
  if p.kind = 'edited' then
    v_out := v_out || coalesce((
      select jsonb_agg(jsonb_build_object('bucket', 'public-cases', 'name', o.name) order by o.name)
        from storage.objects o
       where o.bucket_id = 'public-cases'
         and position('/' in o.name) = 0
         and split_part(o.name, '.', 2) <> '' and split_part(o.name, '.', 3) = ''
         and length(split_part(o.name, '.', 1)) >= 21
         and left(o.name, 11) = to_char(p.taken_on, 'YYYY-MM-DD') || '_'
         and right(split_part(o.name, '.', 1), 9) = '_' || left(p.id::text, 8)
         and o.created_at >= p.created_at), '[]'::jsonb);
  end if;
  return v_out;
end $$;
revoke all on function private.photo_files(public.photos) from public, anon, authenticated;

-- The file of an X-ray: its own, in its patient's own folder (<patient>/<file>). storage_path is unique, so no other X-ray names it.
create or replace function private.xray_files(x public.xrays)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  if split_part(x.storage_path, '/', 2) <> '' and split_part(x.storage_path, '/', 3) = ''
     and private.media_folder_ok(split_part(x.storage_path, '/', 1), x.patient_id) then
    return jsonb_build_array(jsonb_build_object('bucket', 'xrays', 'name', x.storage_path));
  end if;
  return '[]'::jsonb;
end $$;
revoke all on function private.xray_files(public.xrays) from public, anon, authenticated;

-- 3b. Whether the signed-in person may remove this file: photos.delete, and they asked for this very file (begin_photo_delete or
-- begin_xray_delete, in the audit log) in the last 15 minutes. Security definer: it reads the audit log, which they may not.
create or replace function public.photo_file_removable(p_bucket text, p_name text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select auth.uid() is not null and public.has_perm('photos.delete')
     and exists (select 1 from public.audit_log a
                  where a.action = 'DELETE_FILES' and a.actor = auth.uid() and a.at > now() - interval '15 minutes'
                    and a.table_name in ('photos', 'xrays')
                    and a.new_data -> 'files' @> jsonb_build_array(jsonb_build_object('bucket', p_bucket, 'name', p_name)))
$$;
revoke all on function public.photo_file_removable(text, text) from public, anon;
grant execute on function public.photo_file_removable(text, text) to authenticated;

drop policy if exists "photo deleters remove the files they asked for" on storage.objects;
create policy "photo deleters remove the files they asked for" on storage.objects for delete to authenticated
  using (bucket_id in ('clinic-photos', 'xrays', 'public-cases') and public.photo_file_removable(bucket_id, name));

-- 3a. Before a picture's files go: the files, in the audit log with the whole row and who asked. Answers { found, files }.
create or replace function public.begin_photo_delete(p_photo uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_photo public.photos;
  v_files jsonb;
begin
  if not public.has_perm('photos.delete') then
    raise exception 'NOT_ALLOWED: you may not delete pictures from a patient''s record. Ask Dr. Ali to tick "Delete clinic photos and X-rays" in the access list.'
      using errcode = '42501';
  end if;
  select * into v_photo from public.photos where id = p_photo;
  if v_photo.id is null then
    return jsonb_build_object('found', false, 'files', '[]'::jsonb);
  end if;
  if not private.deleter_sees_photo(v_photo) then
    raise exception 'NOT_ALLOWED: you may not delete this picture: it is a raw picture, and raw pictures need "View raw clinic photos folder" in the access list.'
      using errcode = '42501';
  end if;
  v_files := private.photo_files(v_photo);
  if jsonb_array_length(v_files) > 0 then
    insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
    values ('photos', v_photo.id::text, 'DELETE_FILES', to_jsonb(v_photo), jsonb_build_object('files', v_files), auth.uid());
  end if;
  return jsonb_build_object('found', true, 'files', v_files);
end $$;
revoke all on function public.begin_photo_delete(uuid) from public, anon;
grant execute on function public.begin_photo_delete(uuid) to authenticated;

-- 3c. Delete one picture, once its files are gone. Edited pictures made from it stay and no longer point at it; its visit's "photos
-- uploaded" tick comes off when it was the visit's last picture. Answers { deleted, edited_copies, visit_unticked, visit_asks_photos }.
create or replace function public.delete_patient_photo(p_photo uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_photo public.photos;
  v_copies int := 0;
  v_unticked boolean := false;
  v_asks boolean := false;
begin
  if not public.has_perm('photos.delete') then
    raise exception 'NOT_ALLOWED: you may not delete pictures from a patient''s record. Ask Dr. Ali to tick "Delete clinic photos and X-rays" in the access list.'
      using errcode = '42501';
  end if;
  select * into v_photo from public.photos where id = p_photo for update;
  if v_photo.id is null then
    return jsonb_build_object('deleted', false, 'edited_copies', 0, 'visit_unticked', false, 'visit_asks_photos', false);
  end if;
  if not private.deleter_sees_photo(v_photo) then
    raise exception 'NOT_ALLOWED: you may not delete this picture: it is a raw picture, and raw pictures need "View raw clinic photos folder" in the access list.'
      using errcode = '42501';
  end if;
  if exists (select 1 from jsonb_array_elements(private.photo_files(v_photo)) f
               join storage.objects o on o.bucket_id = f ->> 'bucket' and o.name = f ->> 'name') then
    raise exception 'FILES_LEFT: the picture''s file is still stored, so the picture was not deleted. Press Delete again.';
  end if;
  update public.photos set edited_from = null where edited_from = v_photo.id;
  get diagnostics v_copies = row_count;
  delete from public.photos where id = v_photo.id;
  if v_photo.visit_id is not null and not exists (select 1 from public.photos where visit_id = v_photo.visit_id) then
    update public.visits set photos_uploaded = false where id = v_photo.visit_id and photos_uploaded;
    v_unticked := found;
    if v_unticked then
      select coalesce(v.photo_required and v.status not in ('completed', 'cancelled', 'no_show'), false) into v_asks
        from public.visits v where v.id = v_photo.visit_id;
    end if;
  end if;
  return jsonb_build_object('deleted', true, 'edited_copies', v_copies, 'visit_unticked', v_unticked, 'visit_asks_photos', coalesce(v_asks, false));
end $$;
revoke all on function public.delete_patient_photo(uuid) from public, anon;
grant execute on function public.delete_patient_photo(uuid) to authenticated;

-- 3a for an X-ray: its file, in the audit log with the whole row and who asked. Answers { found, files }.
create or replace function public.begin_xray_delete(p_xray uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_xray public.xrays;
  v_files jsonb;
begin
  if not public.has_perm('photos.delete') then
    raise exception 'NOT_ALLOWED: you may not delete X-rays from a patient''s record. Ask Dr. Ali to tick "Delete clinic photos and X-rays" in the access list.'
      using errcode = '42501';
  end if;
  select * into v_xray from public.xrays where id = p_xray;
  if v_xray.id is null then
    return jsonb_build_object('found', false, 'files', '[]'::jsonb);
  end if;
  if not public.has_perm('xrays.view') then
    raise exception 'NOT_ALLOWED: you may not delete this X-ray: X-rays need "View X-rays" in the access list.' using errcode = '42501';
  end if;
  v_files := private.xray_files(v_xray);
  if jsonb_array_length(v_files) > 0 then
    insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
    values ('xrays', v_xray.id::text, 'DELETE_FILES', to_jsonb(v_xray), jsonb_build_object('files', v_files), auth.uid());
  end if;
  return jsonb_build_object('found', true, 'files', v_files);
end $$;
revoke all on function public.begin_xray_delete(uuid) from public, anon;
grant execute on function public.begin_xray_delete(uuid) to authenticated;

-- 3c for an X-ray: the row, once its file is gone. Answers { deleted }.
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
  if exists (select 1 from jsonb_array_elements(private.xray_files(v_xray)) f
               join storage.objects o on o.bucket_id = f ->> 'bucket' and o.name = f ->> 'name') then
    raise exception 'FILES_LEFT: the X-ray''s file is still stored, so the X-ray was not deleted. Press Delete again.';
  end if;
  delete from public.xrays where id = v_xray.id;
  return jsonb_build_object('deleted', true);
end $$;
revoke all on function public.delete_patient_xray(uuid) from public, anon;
grant execute on function public.delete_patient_xray(uuid) to authenticated;

commit;

-- Tell the API about the new functions straight away.
notify pgrst, 'reload schema';
