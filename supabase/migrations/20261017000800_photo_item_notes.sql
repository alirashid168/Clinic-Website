-- =============================================================================
-- The Photo inbox: a small picture and a text box with each photo of an upload.
--
-- The owner (Dr. Ali, 17 Oct 2026, verbatim, about the upload list of the Photo inbox): "i want picutres in thumbnail here and text box
-- with each photo, so we can put the details of it with the picture".
--
-- The pictures are made in the browser (web/js/views/staff/photo-inbox.js); this file is the text box with each photo (its note):
-- 1. photo_inbox_items.note (optional, at most 500 characters, null when empty): staff only, like every column of the inbox tables (their
--    read policy needs "Use the Photo inbox" and "View raw clinic photos folder"; a patient login reads none of it). It is never copied
--    to public.photos (the patient's rows), so it never reaches the patient portal.
--    - typed before the photo is registered, it comes with the photo: photo_inbox_add_items() takes an optional 'note' per photo (and
--      answers each photo's note);
--    - typed later (while the upload runs, or after), public.photo_inbox_item_note(p_item, p_note) saves it: "Use the Photo inbox" +
--      "View raw clinic photos folder" and the photo's city folder (private.photo_inbox_require, the city by public.photo_inbox_city_ok),
--      security definer, an audit row (PHOTO_NOTE, the note before and after). Allowed on any photo, waiting, filed or set aside: once a
--      set is filed a note change is only shown (it never moves the photos);
--    - photo_inbox_day() answers each photo's note, and 'note_patients': the patients the photos' notes name (by Mr#; for old photos
--      also the patients whose first name is in a photo's note, found once when the note is saved: photo_inbox_items.name_patient_ids).
-- 2. The matching reads a set's notes as ITS PHOTOS' OWN NOTES + ITS UPLOAD'S NOTE, read the same way as before
--    (private.photo_inbox_note_mrs / _note_words / _note_month; web/js/lib/photo-intake.js noteMrs / noteWords / noteMonth):
--    - their Mr#s and names come first on "Which patient?" (as the upload's note does now);
--    - the page never puts photos whose own notes name different single Mr#s into one set (it splits there), and a photo whose note
--      names an Mr# never joins a filed set of another patient (checked again here);
--    - filed by the note by itself (rule note_mr for today's photos, old_note_mr for old photos) only when, over the whole set, the
--      photos' notes plus the upload's note name exactly ONE Mr#, exactly one patient has it, and every other check of 20261017000600
--      still passes (one upload of that kind, nobody changed the set, Claude did not flag it; note_mr: that patient's visit of this city
--      and day, of the branch chosen, not cancelled, no-show or only scheduled). The "one visit" rule (the upload's photos with a camera
--      time within 2 hours) is for an Mr# that only the upload's note names: a photo's own note is about that photo. Two different
--      Mr#s wait on "Which patient?" with both offered. A name alone never files anything;
--    - filed by time: never when the photos' own notes name another patient (or two) than the one the time fits;
--    - old photos: the braces month of the set's notes ("Month 6" in the upload's note or in the photos' notes, when they agree).
-- 3. Nothing else changes: 20261017000500 (every city folder for every "Use the Photo inbox" holder) and 20261017000600 (the upload's
--    note box, old photos) stay as they are; the functions changed here are made again in full (marked "(photo notes)"), every city
--    check still by public.photo_inbox_city_ok().
--
-- Additive and safe to run more than once (columns and checks made if missing or dropped and made again, functions replaced). No
-- backslash anywhere in this file.
-- HOW TO APPLY: Supabase dashboard -> SQL Editor -> paste this whole file -> Run. It needs 20261017000600_photo_inbox_notes.sql (live has
-- it). No Edge Function changes (photo-ai reads only the photos' ids, sets and Claude status). Then put the website live and reload the
-- staff tabs.
-- THE WEBSITE WITHOUT IT: the pictures in the upload list work; a note typed with a photo says it needs this update.
-- TO UNDO: drop public.photo_inbox_item_note, private.photo_inbox_clean_note / _name_patients / _item_names / _item_note_mrs, the columns
-- photo_inbox_items.note and name_patient_ids, and run photo_inbox_add_items, _day, _apply and private.photo_inbox_set_occasion from
-- 20261017000600_photo_inbox_notes.sql again.
-- =============================================================================
begin;

do $$
begin
  if to_regprocedure('public.photo_inbox_start_batch(uuid, smallint, text, text)') is null then
    raise exception 'Apply 20261017000600_photo_inbox_notes.sql before this file: the photo notes build on the upload''s note box.';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. The note with each photo
-- ---------------------------------------------------------------------------------------------------------------
alter table public.photo_inbox_items add column if not exists note text;
alter table public.photo_inbox_items drop constraint if exists photo_inbox_items_note_check;
alter table public.photo_inbox_items add constraint photo_inbox_items_note_check check (note is null or length(note) between 1 and 500);
-- Old photos: the patients a name in the photo's note fits (like photo_inbox_batches.name_patient_ids), found once when the note is saved.
alter table public.photo_inbox_items add column if not exists name_patient_ids uuid[] not null default '{}';

-- A note as it is stored: spaces and line breaks tidied, null when empty (as photo_inbox_start_batch stores the upload's note).
create or replace function private.photo_inbox_clean_note(p_note text)
returns text language sql immutable set search_path = public as $$
  select nullif(btrim(regexp_replace(coalesce(p_note, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), '')
$$;
revoke all on function private.photo_inbox_clean_note(text) from public, anon, authenticated;

-- The patients whose first name (or more) is among a note's name words: any city, the most name words first, this city's first, at
-- most 20 (the same search as photo_inbox_start_batch makes for an upload's note).
create or replace function private.photo_inbox_name_patients(p_words text[], p_city smallint)
returns uuid[] language sql stable security definer set search_path = public as $$
  select case when cardinality(coalesce(p_words, '{}'::text[])) = 0 then '{}'::uuid[] else coalesce((
    select array_agg(q.id order by q.hits desc, q.here desc, q.mr_number)
      from (select p.id, p.mr_number, coalesce(pb.city_id = p_city, false) as here,
                   (select count(*) from unnest(private.aaj_name_words(p.full_name)) w
                     where private.aaj_name_spelling(w) = any (p_words)) as hits
              from public.patients p left join public.branches pb on pb.id = p.first_branch_id
             where private.aaj_name_spelling((private.aaj_name_words(p.full_name))[1]) = any (p_words)
             order by 4 desc, 3 desc, p.mr_number
             limit 20) q), '{}'::uuid[]) end
$$;
revoke all on function private.photo_inbox_name_patients(text[], smallint) from public, anon, authenticated;

-- The name patients of a photo's note: only for old photos (today's photos are matched against the day's list in the page), and only
-- when the note has a name word that the upload's note does not have (those patients are found with the upload already).
create or replace function private.photo_inbox_item_names(p_batch uuid, p_city smallint, p_note text)
returns uuid[] language plpgsql stable security definer set search_path = public as $$
declare
  bt public.photo_inbox_batches;
  v_words text[] := private.photo_inbox_note_words(p_note);
begin
  if p_note is null or cardinality(v_words) = 0 then
    return '{}'::uuid[];
  end if;
  select * into bt from public.photo_inbox_batches where id = p_batch;
  if bt.id is null or bt.kind <> 'old' or v_words <@ private.photo_inbox_note_words(bt.note) then
    return '{}'::uuid[];
  end if;
  return private.photo_inbox_name_patients(v_words, p_city);
end $$;
revoke all on function private.photo_inbox_item_names(uuid, smallint, text) from public, anon, authenticated;

-- The Mr#s the photos of a set name in their own notes (each read like an upload's note), sorted, each once.
create or replace function private.photo_inbox_item_note_mrs(p_set uuid)
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct k order by k), '{}'::text[])
    from public.photo_inbox_items i cross join lateral unnest(private.photo_inbox_note_mrs(i.note)) as k
   where i.set_id = p_set and i.note is not null
$$;
revoke all on function private.photo_inbox_item_note_mrs(uuid) from public, anon, authenticated;

-- Saves the note of one photo (typed after the photo was registered). Any photo of a city folder the person may use: waiting, filed or
-- set aside (after the filing the note is only shown). An audit row keeps the note before and after. Answers { item_id, note, changed }.
create or replace function public.photo_inbox_item_note(p_item uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  it public.photo_inbox_items;
  v_note text := private.photo_inbox_clean_note(p_note);
begin
  perform private.photo_inbox_require(null);
  select * into it from public.photo_inbox_items where id = p_item for update;
  if it.id is null then
    raise exception 'PHOTO_BAD_INPUT: that photo is not in the Photo inbox.';
  end if;
  perform private.photo_inbox_require(it.city_id);
  if length(v_note) > 500 then
    raise exception 'PHOTO_BAD_INPUT: the note is longer than 500 characters.';
  end if;
  if it.note is not distinct from v_note then
    return jsonb_build_object('item_id', it.id, 'note', it.note, 'changed', false);
  end if;
  update public.photo_inbox_items set note = v_note, name_patient_ids = private.photo_inbox_item_names(it.upload_batch, it.city_id, v_note)
   where id = it.id;
  insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
  values ('photo_inbox_items', it.id::text, 'PHOTO_NOTE', jsonb_build_object('note', it.note, 'set_id', it.set_id),
          jsonb_build_object('note', v_note, 'set_id', it.set_id), auth.uid());
  return jsonb_build_object('item_id', it.id, 'note', v_note, 'changed', true);
end $$;
revoke all on function public.photo_inbox_item_note(uuid, text) from public, anon;
grant execute on function public.photo_inbox_item_note(uuid, text) to authenticated;

-- The occasion of a set of old photos: the braces month its notes name (the upload's note, when the set is of one upload, and its photos'
-- own notes; "Month 6" when they name one month), else "Old photo".
create or replace function private.photo_inbox_set_occasion(p_set uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select 'Month ' || min(x.m)
                     from (select private.photo_inbox_note_month(b.note) as m
                             from public.photo_inbox_batches b
                            where b.id in (select i.upload_batch from public.photo_inbox_items i where i.set_id = p_set)
                              and (select count(distinct i.upload_batch) from public.photo_inbox_items i where i.set_id = p_set) = 1
                           union all
                           select private.photo_inbox_note_month(i.note) from public.photo_inbox_items i
                            where i.set_id = p_set and i.note is not null) x
                    where x.m is not null
                   having count(distinct x.m) = 1), 'Old photo')
$$;
revoke all on function private.photo_inbox_set_occasion(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. The functions of 20261017000600 that change (full bodies; the changes are marked "(photo notes)")
-- ---------------------------------------------------------------------------------------------------------------
-- Registers uploaded photos (at most 50 at once): each must be stored at exactly the path made from its city, day, hash and type, with
-- the size given. A photo uploaded before answers 'duplicate' with where it already is (nothing changes). New photos are in no set
-- until the next matching. Answers [{ sha256, item_id, state, city_id, photo_day }].
-- (notes) A photo of an upload of old photos (photo_inbox_batches.kind 'old', started by the same person in the same city folder): any past
-- day (the day of its camera or file-saved time when it has one, else the upload day), its time never trusted for matching (clock_ok false),
-- not sent to Claude (ai_status 'skipped'); with "edited" its as-it-is copy is stored at edited/<sha>.jpg (checked here) and the photo is
-- registered edited (edit_status 'done'); without, the edit worker makes that copy later (no Claude either).
-- (photo notes) Each photo may bring its own note ('note', at most 500 characters, tidied like the upload's note; for old photos the
-- patients a name in it fits are found once, here). Every answer has the photo's note ('note'): a photo uploaded before keeps its own.
create or replace function public.photo_inbox_add_items(p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  x jsonb;
  v_out jsonb := '[]'::jsonb;
  v_city smallint;
  v_sha text;
  v_ext text;
  v_mime text;
  v_day date;
  v_taken timestamptz;
  v_source text;
  v_clock boolean;
  v_hint smallint;
  v_path text;
  v_thumb text;
  v_meta jsonb;
  v_size bigint;
  v_existing public.photo_inbox_items;
  v_id uuid;
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  v_batch uuid;
  v_kind text;
  bt public.photo_inbox_batches;
  v_own date;
  v_edited text;
  v_edited_thumb text;
  v_note text;
begin
  perform private.photo_inbox_require(null);
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 50 then
    raise exception 'PHOTO_BAD_INPUT: send at most 50 photos at once.';
  end if;
  for x in select * from jsonb_array_elements(p_items) loop
    v_city := nullif(x ->> 'city_id', '')::smallint;
    perform private.photo_inbox_require(v_city);
    v_sha := lower(coalesce(x ->> 'sha256', ''));
    if v_sha !~ '^[0-9a-f]{64}$' then
      raise exception 'PHOTO_BAD_INPUT: a photo''s fingerprint is not right.';
    end if;
    select * into v_existing from public.photo_inbox_items where sha256 = v_sha;
    if v_existing.id is not null then
      v_out := v_out || jsonb_build_array(jsonb_build_object('sha256', v_sha, 'item_id', v_existing.id, 'state', 'duplicate',
                                                             'city_id', v_existing.city_id, 'photo_day', v_existing.photo_day, 'note', v_existing.note));
      continue;
    end if;
    v_ext := lower(coalesce(x ->> 'ext', ''));
    v_mime := lower(coalesce(x ->> 'mime_type', ''));
    if v_ext not in ('jpg', 'jpeg', 'png', 'heic', 'heif', 'webp') or v_mime not in ('image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp') then
      raise exception 'PHOTO_BAD_INPUT: only JPEG, PNG, HEIC and WebP photos go into the Photo inbox.';
    end if;
    v_hint := nullif(x ->> 'branch_hint', '')::smallint;
    if v_hint is not null and not exists (select 1 from public.branches where id = v_hint and city_id = v_city) then
      raise exception 'PHOTO_BAD_INPUT: that branch is not in this city.';
    end if;
    v_source := coalesce(x ->> 'time_source', 'none');
    if v_source not in ('exif', 'exif_modified', 'file_date', 'none') then
      raise exception 'PHOTO_BAD_INPUT: unknown time source.';
    end if;
    v_taken := nullif(x ->> 'taken_at', '')::timestamptz;
    v_clock := coalesce((x ->> 'clock_ok')::boolean, false) and v_taken is not null;
    v_day := (x ->> 'photo_day')::date;
    -- (notes) the upload this photo is part of: today's photos (also without a recorded upload), or old photos
    v_batch := case when (x ->> 'upload_batch') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (x ->> 'upload_batch')::uuid end;
    v_kind := 'day';
    if v_batch is not null then
      select * into bt from public.photo_inbox_batches where id = v_batch;
      if bt.id is not null then
        if bt.city_id <> v_city or bt.created_by <> auth.uid() then
          raise exception 'PHOTO_BAD_INPUT: these photos belong to another upload. Choose them again.';
        end if;
        v_kind := bt.kind;
      end if;
    end if;
    if v_kind = 'old' then
      -- an old photo: the day of its own time (camera, or the time an app saved it) when that is a real past day, else the upload day
      v_clock := false;
      v_own := case when v_source in ('exif', 'exif_modified') and v_taken is not null then (v_taken at time zone 'Asia/Karachi')::date end;
      if v_own is not null and v_own between date '1990-01-01' and v_today + 1 then
        if v_day is distinct from v_own then
          raise exception 'PHOTO_BAD_INPUT: an old photo''s day is the day its own time says.';
        end if;
      elsif v_day is null or v_day < v_today - 1 or v_day > v_today + 1 then
        raise exception 'PHOTO_BAD_INPUT: an old photo without its own date goes to the day it is uploaded.';
      end if;
    else
      if v_day is null or v_day < v_today - 8 or v_day > v_today + 1 then
        raise exception 'PHOTO_BAD_INPUT: a photo''s day must be within the last week.';
      end if;
      if v_source = 'exif' and v_clock and v_day <> (v_taken at time zone 'Asia/Karachi')::date then
        raise exception 'PHOTO_BAD_INPUT: a photo''s day is not the day its camera time says.';
      end if;
    end if;
    v_path := 'inbox/' || private.photo_inbox_city_slug(v_city) || '/' || to_char(v_day, 'YYYY-MM-DD') || '/' || v_sha || '.' || v_ext;
    v_size := nullif(x ->> 'byte_size', '')::bigint;
    if v_size is null or v_size <= 0 then
      raise exception 'PHOTO_BAD_INPUT: a photo''s size is missing.';
    end if;
    select o.metadata into v_meta from storage.objects o where o.bucket_id = 'clinic-photos' and o.name = v_path;
    if not found or (v_meta ? 'size' and (v_meta ->> 'size')::bigint <> v_size) then
      raise exception 'PHOTO_FILE_MISSING: the photo did not finish uploading. Choose it again.';
    end if;
    v_thumb := null;
    if coalesce((x ->> 'thumb')::boolean, false)
       and exists (select 1 from storage.objects o where o.bucket_id = 'clinic-photos' and o.name = public.photo_thumb_path(v_path)) then
      v_thumb := public.photo_thumb_path(v_path);
    end if;
    -- (notes) an old photo's as-it-is copy, stored next to it at edited/<sha>.jpg
    -- (photo notes) the photo's own note
    v_note := private.photo_inbox_clean_note(x ->> 'note');
    if length(v_note) > 500 then
      raise exception 'PHOTO_BAD_INPUT: a photo''s note is longer than 500 characters.';
    end if;
    v_edited := null;
    v_edited_thumb := null;
    if v_kind = 'old' and coalesce((x ->> 'edited')::boolean, false) then
      v_edited := private.photo_inbox_dir(v_path) || 'edited/' || v_sha || '.jpg';
      if not exists (select 1 from storage.objects o where o.bucket_id = 'clinic-photos' and o.name = v_edited) then
        raise exception 'PHOTO_FILE_MISSING: the copy of an old photo did not finish uploading. Choose it again.';
      end if;
      if exists (select 1 from storage.objects o where o.bucket_id = 'clinic-photos' and o.name = public.photo_thumb_path(v_edited)) then
        v_edited_thumb := public.photo_thumb_path(v_edited);
      end if;
    end if;
    insert into public.photo_inbox_items (sha256, city_id, photo_day, storage_path, thumb_path, file_name, mime_type, byte_size, width, height,
                                          taken_at, time_source, clock_ok, camera, orientation, file_seq_prefix, file_seq, branch_hint,
                                          uploaded_by, upload_batch, ai_status, edited_path, edited_thumb_path, edit_status, edit_basic, edit_version,
                                          note, name_patient_ids)
    values (v_sha, v_city, v_day, v_path, v_thumb, left(coalesce(nullif(btrim(x ->> 'file_name'), ''), 'photo'), 200), v_mime, v_size,
            case when (x ->> 'width') ~ '^[0-9]{1,6}$' and (x ->> 'width')::int > 0 then (x ->> 'width')::int end,
            case when (x ->> 'height') ~ '^[0-9]{1,6}$' and (x ->> 'height')::int > 0 then (x ->> 'height')::int end,
            v_taken, v_source, v_clock, left(coalesce(nullif(btrim(x ->> 'camera'), ''), 'unknown'), 120),
            case when (x ->> 'orientation') ~ '^[1-8]$' then (x ->> 'orientation')::smallint end,
            left(nullif(x ->> 'file_seq_prefix', ''), 40),
            case when (x ->> 'file_seq') ~ '^[0-9]{1,9}$' then (x ->> 'file_seq')::int end,
            v_hint, auth.uid(), v_batch,
            case when v_kind = 'old' then 'skipped' else 'pending' end, v_edited, v_edited_thumb,
            case when v_edited is not null then 'done' else 'pending' end, false,
            case when v_edited is not null then (case when (x ->> 'edit_version') ~ '^[0-9]{1,2}$' then (x ->> 'edit_version')::smallint else 1 end) end,
            v_note, case when v_kind = 'old' then private.photo_inbox_item_names(v_batch, v_city, v_note) else '{}'::uuid[] end)
    on conflict (sha256) do nothing
    returning id into v_id;
    if v_id is null then
      select * into v_existing from public.photo_inbox_items where sha256 = v_sha;
      v_out := v_out || jsonb_build_array(jsonb_build_object('sha256', v_sha, 'item_id', v_existing.id, 'state', 'duplicate',
                                                             'city_id', v_existing.city_id, 'photo_day', v_existing.photo_day, 'note', v_existing.note));
    else
      v_out := v_out || jsonb_build_array(jsonb_build_object('sha256', v_sha, 'item_id', v_id, 'state', 'added', 'city_id', v_city, 'photo_day', v_day,
                                                             'note', v_note));
    end if;
  end loop;
  return v_out;
end $$;
revoke all on function public.photo_inbox_add_items(jsonb) from public, anon;
grant execute on function public.photo_inbox_add_items(jsonb) to authenticated;

-- (photo notes) Each photo's note ('note'), and 'note_patients': the patients the day's photo notes name by Mr# (any city), and for old
-- photos the patients a name in a photo's note fits (photo_inbox_items.name_patient_ids).
-- Everything the matching and the screens need for a city and day: the city's branches, every visit of those branches that day (all
-- statuses, with the patient's name and Mr#, its times, photo month and photos), the day's photos and sets. (Security definer: an assistant
-- who works at one branch sees the whole city's day list here, because the photos of a city may belong to any of its branches.)
create or replace function public.photo_inbox_day(p_city smallint, p_day date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform private.photo_inbox_require(p_city);
  return jsonb_build_object(
    'city', (select jsonb_build_object('id', c.id, 'name', c.name, 'slug', private.photo_inbox_city_slug(c.id)) from public.cities c where c.id = p_city),
    'day', p_day,
    'hold_hours', extract(epoch from private.photo_inbox_hold()) / 3600,
    'branches', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'code', b.code, 'name', b.name) order by b.sort_order, b.id)
                            from public.branches b where b.city_id = p_city), '[]'::jsonb),
    'visits', coalesce((
      select jsonb_agg(jsonb_build_object(
               'visit_id', v.id, 'patient_id', v.patient_id, 'full_name', pt.full_name, 'mr_number', pt.mr_number, 'branch_id', v.branch_id,
               'visit_date', v.visit_date, 'token_no', v.token_no, 'status', v.status, 'created_at', v.created_at,
               'checked_in_at', v.checked_in_at, 'started_at', v.started_at, 'completed_at', v.completed_at,
               'legacy', v.legacy_source is not null, 'photo_required', v.photo_required, 'braces_month', v.braces_month,
               'treatment_label', v.treatment_label, 'photos_uploaded', v.photos_uploaded,
               'photo_count', (select count(*) from public.photos ph where ph.visit_id = v.id),
               'filed_set_ids', coalesce((select jsonb_agg(s.id) from public.photo_inbox_sets s where s.visit_id = v.id and s.status = 'filed'), '[]'::jsonb))
             order by coalesce(v.started_at, v.checked_in_at, v.created_at), v.id)
        from public.visits v join public.branches b on b.id = v.branch_id join public.patients pt on pt.id = v.patient_id
       where b.city_id = p_city and v.visit_date = p_day), '[]'::jsonb),
    'sets', coalesce((
      select jsonb_agg(jsonb_build_object(
               'set_id', s.id, 'status', s.status, 'manual', s.manual, 'first_at', s.first_at, 'last_at', s.last_at, 'photo_count', s.photo_count,
               'time_ok', s.time_ok, 'camera', s.camera, 'branch_hint', s.branch_hint, 'candidates', s.candidates, 'wait_reason', s.wait_reason,
               'patient_id', s.patient_id, 'visit_id', s.visit_id, 'branch_id', s.branch_id, 'occasion', s.occasion, 'filed_how', s.filed_how,
               'filed_rule', s.filed_rule, 'filed_by_name', (select st.full_name from public.staff st where st.id = s.filed_by), 'filed_at', s.filed_at,
               -- (an edited copy made after the filing has a later window: the latest one is shown)
               'release_after', greatest(s.release_after, (select max(ph.release_after) from public.photos ph where ph.intake_set_id = s.id and ph.kind = 'edited')),
               'hidden', s.hidden, 'ai_flag', s.ai_flag, 'set_aside_reason', s.set_aside_reason,
               'version', s.version, 'kind', s.kind, 'full_name', pt.full_name, 'mr_number', pt.mr_number)
             order by s.first_at nulls last, s.created_at, s.id)
        from public.photo_inbox_sets s left join public.patients pt on pt.id = s.patient_id
       where s.city_id = p_city and s.photo_day = p_day), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'item_id', i.id, 'set_id', i.set_id, 'position', i.position, 'sha256', i.sha256, 'storage_path', i.storage_path,
               'thumb_path', i.thumb_path, 'edited_path', i.edited_path, 'edited_thumb_path', i.edited_thumb_path, 'file_name', i.file_name,
               'mime_type', i.mime_type, 'width', i.width, 'height', i.height, 'taken_at', i.taken_at, 'time_source', i.time_source,
               'clock_ok', i.clock_ok, 'camera', i.camera, 'file_seq_prefix', i.file_seq_prefix, 'file_seq', i.file_seq,
               'branch_hint', i.branch_hint, 'uploaded_by', i.uploaded_by, 'uploaded_at', i.uploaded_at, 'upload_batch', i.upload_batch,
               'edit_round', i.edit_round, 'ai_status', i.ai_status,
               'ai_kind', i.ai_result ->> 'kind', 'ai_view', i.ai_result ->> 'view', 'ai_issues', coalesce(i.ai_result -> 'issues', '[]'::jsonb),
               'edit_status', i.edit_status, 'edit_basic', i.edit_basic, 'raw_photo_id', i.raw_photo_id, 'edited_photo_id', i.edited_photo_id,
               'note', i.note)
             order by i.taken_at nulls last, i.file_seq nulls last, i.file_name, i.sha256)
        from public.photo_inbox_items i where i.city_id = p_city and i.photo_day = p_day), '[]'::jsonb),
    -- (notes) the uploads of the day's photos: kind, note, the Mr#s it names and their patients (any city); for old photos also the
    -- patients whose first name (or more) is in the note (found once, when the upload started: photo_inbox_batches.name_patient_ids)
    'batches', coalesce((
      select jsonb_agg(jsonb_build_object(
               'batch_id', bt.id, 'kind', bt.kind, 'note', bt.note, 'created_at', bt.created_at,
               'created_by_name', (select st.full_name from public.staff st where st.id = bt.created_by),
               'mrs', to_jsonb(nw.mrs),
               'mr_patients', coalesce((select jsonb_agg(jsonb_build_object('patient_id', p.id, 'full_name', p.full_name, 'mr_number', p.mr_number,
                                                                 'branch_id', p.first_branch_id, 'city_id', pb.city_id) order by p.mr_number)
                                          from public.patients p left join public.branches pb on pb.id = p.first_branch_id
                                         where p.mr_number = any (nw.mrs)), '[]'::jsonb),
               'name_patients', coalesce((
                 select jsonb_agg(jsonb_build_object('patient_id', p.id, 'full_name', p.full_name, 'mr_number', p.mr_number, 'branch_id', p.first_branch_id,
                                                     'city_id', pb.city_id,
                                                     'hits', (select count(*) from unnest(private.aaj_name_words(p.full_name)) w where private.aaj_name_spelling(w) = any (nw.words)))
                                  order by x.o)
                   from unnest(bt.name_patient_ids) with ordinality as x(pid, o)
                   join public.patients p on p.id = x.pid left join public.branches pb on pb.id = p.first_branch_id), '[]'::jsonb))
             order by bt.created_at, bt.id)
        from public.photo_inbox_batches bt
        cross join lateral (select private.photo_inbox_note_mrs(bt.note) as mrs, private.photo_inbox_note_words(bt.note) as words) nw
       where bt.id in (select i.upload_batch from public.photo_inbox_items i where i.city_id = p_city and i.photo_day = p_day and i.upload_batch is not null)), '[]'::jsonb),
    -- (photo notes) the patients the photos' own notes name: by Mr# (any city), and for old photos by name (found when the note was saved)
    'note_patients', coalesce((
      select jsonb_agg(jsonb_build_object('patient_id', p.id, 'full_name', p.full_name, 'mr_number', p.mr_number, 'branch_id', p.first_branch_id,
                                          'city_id', pb.city_id) order by p.mr_number, p.id)
        from public.patients p left join public.branches pb on pb.id = p.first_branch_id
       where p.id in (select p2.id from public.patients p2
                       where p2.mr_number = any (array(select k from public.photo_inbox_items i cross join lateral unnest(private.photo_inbox_note_mrs(i.note)) as k
                                                        where i.city_id = p_city and i.photo_day = p_day and i.note is not null))
                      union
                      select unnest(i.name_patient_ids) from public.photo_inbox_items i
                       where i.city_id = p_city and i.photo_day = p_day and cardinality(i.name_patient_ids) > 0)), '[]'::jsonb));
end $$;
revoke all on function public.photo_inbox_day(smallint, date) from public, anon;
grant execute on function public.photo_inbox_day(smallint, date) to authenticated;

-- Applies the website's matching plan for a city and day (frozen shape: .omc/handoffs/photo-intake-time-spec.md 7.9), under the lock of
-- that city and day:
--   1. the photos the plan regrouped must be exactly the regroupable ones now (no set, or a waiting set nobody changed), each once:
--      else PHOTO_STALE_PLAN (the page reloads the day and plans again);
--   2. each group: joins a filed set (the rest of its sitting) only when that is checked again here (same camera, branch chosen and
--      uploader as the set's photos, every photo with a right camera time, inside the set's time or within 3 minutes of it, at most 15
--      minutes and 20 photos in all; the joined photos get their own check window and PHOTO_JOINED in the audit log), else it reuses the
--      set of its earliest photo or gets a new one; every set that gained or lost photos is worked out again;
--   3. "auto" is filed only when the rules hold again here, from the list's own times: a photo month of that city and day, in treatment
--      or completed, not imported, with no photos yet; the photos within 10 minutes before to 2 hours after the start or check-in the
--      page went by (one of the two); no other patient with a photo occasion who may have been in the chair then (also one who already
--      has photos); without a chosen branch, nobody of another branch in the chair then; one set per visit. Else it waits (SERVER_CHECK);
--      (notes) "auto" with rule_kind 'note_mr' (today's photos) or 'old_note_mr' (old photos) is filed by the note instead of the time,
--      checked again here: every photo of the set is of one upload of that kind with a note; the note names exactly one Mr# and exactly
--      one patient has it, the patient the page sent; nobody changed the set and Claude did not flag it. note_mr also: that patient's
--      visit of this city and day (of the branch chosen), waiting, in treatment or completed, and the upload's photos with a camera time
--      lie within 2 hours (one visit, not a whole day's upload). old_note_mr: filed to the patient with no visit, the note's occasion.
--      A name alone never files; the rule sentence is written here, with its rule code;
--   4. sets a person changed get fresh candidates (their photos are not touched); 5. regroupable sets left empty are removed.
-- (photo notes) A set's notes are its photos' own notes + its upload's note: note_mr / old_note_mr need exactly one Mr# over all of them
-- (the 2-hour "one visit" rule only for an Mr# that no photo's own note names); a group never joins a filed set of another patient than
-- its photos' notes name; "auto" by time is refused when the photos' own notes name another patient (or two).
-- A set is written (and its version and the audit log move) only when its photos, candidates or reason change, so the page's matching
-- every few minutes leaves an unchanged day alone.
-- Answers { sets: [{ set_id, item_ids, status }], filed, joined, waiting, server_refused: [{ set_id, why }] }.
create or replace function public.photo_inbox_apply(p_city smallint, p_day date, p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c_matcher constant integer := 1;
  v_current uuid[];
  v_plan_ids uuid[];
  v_group_ids uuid[];
  g jsonb;
  k integer;
  n integer;
  v_items uuid[];
  v_join uuid;
  v_set uuid;
  v_old uuid;
  v_one uuid;
  v_reused uuid[] := '{}';
  v_targets uuid[] := '{}';
  v_joins boolean[] := '{}';
  v_moved integer[] := '{}';
  v_touched uuid[];
  v_changed uuid[] := '{}';
  v_auto_visits uuid[] := '{}';
  s public.photo_inbox_sets;
  v public.visits;
  v_city smallint;
  v_anchor timestamptz;
  v_anchor_in timestamptz;
  v_why text;
  v_reason text;
  v_cands jsonb;
  v_ok boolean;
  v_multi boolean;
  v_fa timestamptz;
  v_fl timestamptz;
  v_ga timestamptz;
  v_gl timestamptz;
  v_out jsonb := '[]'::jsonb;
  v_refused jsonb := '[]'::jsonb;
  v_filed integer := 0;
  v_joined integer := 0;
  v_waiting integer := 0;
  f jsonb;
  v_rule text;
  v_nb integer;
  v_batch uuid;
  bt public.photo_inbox_batches;
  v_keys text[];
  v_npat integer;
  v_pat uuid;
  v_old_t record;
  v_item_keys text[];
begin
  perform private.photo_inbox_require(p_city);
  if p_day is null or jsonb_typeof(p_plan) <> 'object' or jsonb_typeof(p_plan -> 'groups') <> 'array' then
    raise exception 'PHOTO_BAD_INPUT: the matching plan is not readable.';
  end if;
  perform private.photo_inbox_lock(p_city, p_day);

  -- 1. the same photos, each once
  select coalesce(array_agg(i.id order by i.id), '{}') into v_current
    from public.photo_inbox_items i left join public.photo_inbox_sets s0 on s0.id = i.set_id
   where i.city_id = p_city and i.photo_day = p_day and (i.set_id is null or (s0.status = 'waiting' and not s0.manual));
  select coalesce(array_agg(distinct x::uuid order by x::uuid), '{}') into v_plan_ids from jsonb_array_elements_text(coalesce(p_plan -> 'regroup_item_ids', '[]'::jsonb)) x;
  select coalesce(array_agg(x::uuid order by x::uuid), '{}') into v_group_ids
    from jsonb_array_elements(p_plan -> 'groups') gg, jsonb_array_elements_text(coalesce(gg -> 'item_ids', '[]'::jsonb)) x;
  if v_current <> v_plan_ids or v_group_ids <> v_current then
    raise exception 'PHOTO_STALE_PLAN: the photos changed while matching; it is tried again.';
  end if;
  -- (the sets these photos are in now: they may lose photos)
  select coalesce(array_agg(distinct i.set_id), '{}') into v_touched from public.photo_inbox_items i where i.id = any (v_current) and i.set_id is not null;

  -- 2. where each group goes
  for g in select * from jsonb_array_elements(p_plan -> 'groups') loop
    select array_agg(x::uuid order by o) into v_items from jsonb_array_elements_text(g -> 'item_ids') with ordinality as t(x, o);
    if coalesce(array_length(v_items, 1), 0) = 0 then
      v_targets := v_targets || null::uuid;
      v_joins := v_joins || false;
      v_moved := v_moved || 0;
      continue;
    end if;
    v_join := nullif(g ->> 'join_set_id', '')::uuid;
    v_ok := false;
    if v_join is not null then
      select * into s from public.photo_inbox_sets where id = v_join for update;
      -- (notes) never a set of old photos
      if s.id is not null and s.status = 'filed' and not s.manual and s.city_id = p_city and s.photo_day = p_day and s.kind = 'day' then
        select min(taken_at), max(taken_at) into v_fa, v_fl from public.photo_inbox_items where set_id = v_join and time_source = 'exif';
        select min(taken_at), max(taken_at) into v_ga, v_gl from public.photo_inbox_items where id = any (v_items);
        v_ok := v_fa is not null and v_ga is not null
          and not exists (select 1 from public.photo_inbox_items where id = any (v_items) and not (time_source = 'exif' and clock_ok and taken_at is not null))
          and not exists (select 1 from public.photo_inbox_items gi, public.photo_inbox_items fi
                           where gi.id = any (v_items) and fi.set_id = v_join
                             and (gi.camera, coalesce(gi.branch_hint, 0), gi.uploaded_by) is distinct from (fi.camera, coalesce(fi.branch_hint, 0), fi.uploaded_by))
          and (select count(*) from public.photo_inbox_items where set_id = v_join) + array_length(v_items, 1) <= 20
          and greatest(v_fl, v_gl) - least(v_fa, v_ga) <= interval '900 seconds'
          and ((v_ga >= v_fa and v_gl <= v_fl)
               or (v_ga >= v_fl and v_ga - v_fl <= interval '180 seconds')
               or (v_gl <= v_fa and v_fa - v_gl <= interval '180 seconds'))
          -- (photo notes) never when a photo's own note names another patient than the set's
          and not exists (select 1 from public.photo_inbox_items gi
                           where gi.id = any (v_items) and cardinality(private.photo_inbox_note_mrs(gi.note)) > 0
                             and not (private.photo_inbox_note_mrs(gi.note) <@ array[(select pt.mr_number::text from public.patients pt where pt.id = s.patient_id)]));
      end if;
    end if;
    if v_ok then
      v_set := v_join;
    else
      select i.set_id into v_old from public.photo_inbox_items i where i.id = v_items[1];
      if v_old is not null and not (v_old = any (v_reused))
         and exists (select 1 from public.photo_inbox_sets where id = v_old and status = 'waiting' and not manual) then
        v_set := v_old;
      else
        insert into public.photo_inbox_sets (city_id, photo_day) values (p_city, p_day) returning id into v_set;
      end if;
      v_reused := v_reused || v_set;
    end if;
    update public.photo_inbox_items set set_id = v_set where id = any (v_items) and set_id is distinct from v_set;
    get diagnostics n = row_count;
    v_targets := v_targets || v_set;
    v_joins := v_joins || v_ok;
    v_moved := v_moved || n;
  end loop;

  -- every set that gained or lost photos: its times, count, camera, branch chosen and numbering again
  for v_one in select distinct t from unnest(v_touched || v_targets) t where t is not null loop
    if private.photo_inbox_refresh_set(v_one) then
      v_changed := v_changed || v_one;
    end if;
  end loop;

  -- 3. each group's set: joined, filed by itself (checked again here), or waiting with the plan's candidates and reason
  select count(*) > 1 into v_multi from public.branches where city_id = p_city;
  k := 0;
  for g in select * from jsonb_array_elements(p_plan -> 'groups') loop
    k := k + 1;
    v_set := v_targets[k];
    if v_set is null then continue; end if;
    select array_agg(x::uuid order by o) into v_items from jsonb_array_elements_text(g -> 'item_ids') with ordinality as t(x, o);
    if v_joins[k] then
      perform private.photo_inbox_file_rows(v_set);
      update public.photo_inbox_sets set version = version + 1 where id = v_set;
      insert into public.audit_log (table_name, row_id, action, new_data, actor)
      values ('photo_inbox_sets', v_set::text, 'PHOTO_JOINED',
              jsonb_build_object('item_ids', to_jsonb(v_items), 'patient_id', (select patient_id from public.photo_inbox_sets where id = v_set),
                                 'visit_id', (select visit_id from public.photo_inbox_sets where id = v_set)), auth.uid());
      v_joined := v_joined + 1;
      v_out := v_out || jsonb_build_array(jsonb_build_object('set_id', v_set, 'item_ids', to_jsonb(v_items), 'status', 'filed'));
      continue;
    end if;
    v_cands := case when jsonb_typeof(g -> 'candidates') = 'array' then g -> 'candidates' else '[]'::jsonb end;
    v_reason := left(nullif(g ->> 'wait_reason', ''), 40);

    if jsonb_typeof(g -> 'auto') = 'object' and coalesce((p_plan ->> 'matcher_version')::int, 0) >= c_matcher then
      select * into s from public.photo_inbox_sets where id = v_set;
      select * into v from public.visits where id = nullif(g -> 'auto' ->> 'visit_id', '')::uuid;
      select b.city_id into v_city from public.branches b where b.id = v.branch_id;
      v_rule := coalesce(nullif(g -> 'auto' ->> 'rule_kind', ''), 'time');
      if v_rule = 'time' then
      -- The time the page went by: the start, or the check-in when the starts were marked in one go (it must be one of the two).
      v_anchor_in := case when coalesce(g -> 'auto' ->> 'anchor_at', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then (g -> 'auto' ->> 'anchor_at')::timestamptz end;
      v_anchor := case
        when v_anchor_in is not null and v.checked_in_at is not null and abs(extract(epoch from (v_anchor_in - v.checked_in_at))) <= 1 then v.checked_in_at
        when v_anchor_in is not null and v.started_at is not null and abs(extract(epoch from (v_anchor_in - v.started_at))) <= 1 then v.started_at
        else coalesce(v.started_at, v.checked_in_at) end;
      v_item_keys := private.photo_inbox_item_note_mrs(v_set);
      v_why := case
        when v.id is null then 'no such visit'
        when not s.time_ok or s.manual or s.ai_flag is not null or s.photo_count > 20 then 'the photos are not clear enough'
        -- (photo notes) the photos' own notes name another patient (or two) than the one the time fits
        when cardinality(v_item_keys) > 0
             and not (v_item_keys <@ array[(select pt.mr_number::text from public.patients pt where pt.id = v.patient_id)]) then 'the photos'' own notes name another patient'
        when v.visit_date <> p_day or v_city is distinct from p_city then 'the visit is not of this city and day'
        when s.branch_hint is not null and v.branch_id <> s.branch_hint then 'the visit is at another branch'
        when v.legacy_source is not null or v.status not in ('in_treatment', 'completed') then 'the visit is not in treatment or completed'
        when not v.photo_required then 'not a photo month'
        when v.photos_uploaded or exists (select 1 from public.photos ph where ph.visit_id = v.id)
             or exists (select 1 from public.photo_inbox_sets x where x.visit_id = v.id and x.status = 'filed') then 'the visit has photos already'
        when v_anchor is null or s.first_at < v_anchor - interval '10 minutes' or s.first_at > v_anchor + interval '120 minutes' then 'the photos do not fit the visit''s times'
        when exists (select 1 from public.visits u join public.branches ub on ub.id = u.branch_id
                      where ub.city_id = p_city and u.visit_date = p_day and u.patient_id <> v.patient_id
                        and u.status in ('waiting', 'in_treatment', 'completed')
                        and (s.branch_hint is null or u.branch_id = s.branch_hint)
                        and (u.photo_required or coalesce(u.treatment_label, '') ~* '(bond|braces off|debond|record|smile|veneer|aligner|consult)')
                        and private.photo_inbox_was_there(u, s.first_at, s.last_at, false)) then 'another photo patient may have been in the chair then'
        when s.branch_hint is null and v_multi
             and exists (select 1 from public.visits u join public.branches ub on ub.id = u.branch_id
                          where ub.city_id = p_city and u.visit_date = p_day and u.patient_id <> v.patient_id and u.branch_id <> v.branch_id
                            and u.status in ('waiting', 'in_treatment', 'completed')
                            and private.photo_inbox_was_there(u, s.first_at, s.last_at, true)) then 'no branch was chosen and another branch had a patient in the chair then'
        when v.id = any (v_auto_visits) then 'two sets for one visit'
        else null end;
      elsif v_rule in ('note_mr', 'old_note_mr') then
        -- (notes) filed by the note: the set's one upload, its notes, the one Mr# and its one patient
        -- (photo notes) the notes are the photos' own notes + the upload's note
        select count(distinct coalesce(i.upload_batch::text, '-')), min(i.upload_batch::text)::uuid into v_nb, v_batch
          from public.photo_inbox_items i where i.set_id = v_set;
        bt := null;
        select * into bt from public.photo_inbox_batches where id = v_batch;
        v_item_keys := private.photo_inbox_item_note_mrs(v_set);
        select coalesce(array_agg(distinct u.mr order by u.mr), '{}'::text[]) into v_keys
          from unnest(private.photo_inbox_note_mrs(bt.note) || v_item_keys) as u(mr);
        select count(*), min(p.id::text)::uuid into v_npat, v_pat from public.patients p where p.mr_number = any (v_keys);
        v_why := case
          when s.manual or s.ai_flag is not null then 'the photos are not clear enough'
          when v_nb <> 1 or (bt.note is null and not exists (select 1 from public.photo_inbox_items i where i.set_id = v_set and i.note is not null))
            then 'the photos are not of one upload with a note'
          when coalesce(bt.kind, 'day') <> case v_rule when 'note_mr' then 'day' else 'old' end then 'the upload is not of that kind'
          when cardinality(v_keys) <> 1 then 'the note does not name exactly one Mr#'
          when v_npat <> 1 then 'no single patient has the Mr# of the note'
          when nullif(g -> 'auto' ->> 'patient_id', '')::uuid is distinct from v_pat then 'the patient is not the one the note names'
          when v_rule = 'note_mr' and (v.id is null or v.patient_id <> v_pat or v.visit_date <> p_day or v_city is distinct from p_city
                                       or v.status not in ('waiting', 'in_treatment', 'completed')) then 'the note''s patient has no visit that day in this city'
          when v_rule = 'note_mr' and s.branch_hint is not null and v.branch_id <> s.branch_hint then 'the visit is at another branch'
          when v_rule = 'note_mr' and not (v_keys[1] = any (v_item_keys))
               and (select max(i.taken_at) - min(i.taken_at) from public.photo_inbox_items i
                     where i.upload_batch = v_batch and i.photo_day = p_day and i.time_source = 'exif') > interval '2 hours'
            then 'the upload is more than one visit'
          when v_rule = 'old_note_mr' and s.kind <> 'old' then 'the photos are not old photos'
          else null end;
      else
        v_why := 'unknown rule';
      end if;
      if v_why is null and v_rule = 'note_mr' then
        perform private.photo_inbox_file(v_set, v.id, v.patient_id, v.branch_id, private.photo_inbox_occasion(v), 'auto',
          'Automatic (note_mr): the note with these photos names Mr# ' || v_keys[1] || ', on the '
          || coalesce((select b.code from public.branches b where b.id = v.branch_id), '') || ' list that day');
      elsif v_why is null and v_rule = 'old_note_mr' then
        select * into v_old_t from private.photo_inbox_old_target(v_set, null, v_pat);
        perform private.photo_inbox_file(v_set, null, v_old_t.o_patient, v_old_t.o_branch, v_old_t.o_occasion, 'auto',
          'Automatic (old_note_mr): old photos; the note with them names Mr# ' || v_keys[1]);
      elsif v_why is null then
        perform private.photo_inbox_file(v_set, v.id, v.patient_id, v.branch_id, private.photo_inbox_occasion(v), 'auto', g -> 'auto' ->> 'rule');
      end if;
      if v_why is null then
        update public.photo_inbox_sets set candidates = v_cands, matched_at = now() where id = v_set;
        v_auto_visits := v_auto_visits || v.id;
        v_filed := v_filed + 1;
        v_out := v_out || jsonb_build_array(jsonb_build_object('set_id', v_set, 'item_ids', to_jsonb(v_items), 'status', 'filed'));
        continue;
      end if;
      v_reason := 'SERVER_CHECK';
      v_refused := v_refused || jsonb_build_array(jsonb_build_object('set_id', v_set, 'why', v_why));
    end if;
    update public.photo_inbox_sets set status = 'waiting', candidates = v_cands, wait_reason = v_reason, matched_at = now(), version = version + 1
     where id = v_set
       and (v_set = any (v_changed) or v_moved[k] > 0 or status <> 'waiting' or candidates is distinct from v_cands or wait_reason is distinct from v_reason);
    v_waiting := v_waiting + 1;
    v_out := v_out || jsonb_build_array(jsonb_build_object('set_id', v_set, 'item_ids', to_jsonb(v_items), 'status', 'waiting'));
  end loop;

  -- 4. sets a person changed: fresh candidates only (written only when they changed)
  for f in select * from jsonb_array_elements(coalesce(p_plan -> 'fixed_updates', '[]'::jsonb)) loop
    update public.photo_inbox_sets set
        candidates = case when jsonb_typeof(f -> 'candidates') = 'array' then f -> 'candidates' else candidates end,
        wait_reason = coalesce(left(nullif(f ->> 'wait_reason', ''), 40), wait_reason), matched_at = now(), version = version + 1
     where id = nullif(f ->> 'set_id', '')::uuid and city_id = p_city and photo_day = p_day and status = 'waiting' and manual
       and ((jsonb_typeof(f -> 'candidates') = 'array' and candidates is distinct from f -> 'candidates')
            or wait_reason is distinct from coalesce(left(nullif(f ->> 'wait_reason', ''), 40), wait_reason));
  end loop;

  -- 5. regroupable sets left without photos
  delete from public.photo_inbox_sets s1
   where s1.city_id = p_city and s1.photo_day = p_day and s1.status = 'waiting' and not s1.manual
     and not exists (select 1 from public.photo_inbox_items i where i.set_id = s1.id);

  return jsonb_build_object('sets', v_out, 'filed', v_filed, 'joined', v_joined, 'waiting', v_waiting, 'server_refused', v_refused);
end $$;
revoke all on function public.photo_inbox_apply(smallint, date, jsonb) from public, anon;
grant execute on function public.photo_inbox_apply(smallint, date, jsonb) to authenticated;

commit;

-- Tell the API about the new function straight away.
notify pgrst, 'reload schema';
