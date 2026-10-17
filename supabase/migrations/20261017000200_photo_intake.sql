-- =============================================================================
-- The Photo inbox: the day's photos uploaded at once into a city folder, matched to the patients by time, filed into their files,
-- edited with Claude, and kept in the Photo library.
--
-- The owner (Dr. Ali, 17 Oct 2026, verbatim): "claude i habe one bery big problem, its related to patients pictures and its editing. i
-- want a syatem so smooth and easy, that eben if we take 100 pictures in a day. no assistant remembers the patients name, neither their
-- mr number, i just want to upload all those pictures in one place,and you see the pictures, and see the time they are taken, and match
-- them with the patient time at the clinic from the website, and then edit and upload it in the patient's file, and also in another place
-- where we will keep all our patients edited photos. the new photos you make should hane proper name and mr number along with the month
-- of picture. i want this to be bery streamlined, automatic. just take picture and upload, the rest you take care. naming and finding etc"
-- His answers: the upload place is a Photo inbox page on the website; when unsure, "One-tap confirm" (the photos wait on a "Which
-- patient?" screen with the likely patients; nothing ever lands in the wrong file); the editing is Claude Opus 5.5; the central collection
-- is a Photo library page. Then: "the photo upload page should habe 3 folders, karachi, lahore islamabad. so we can put photos from where
-- the patient is. the upload photos option should be abailale for assistants, admin, and coordinator." And: "the photos will all be
-- uploaded at once after all the patients are completed, not one by one in betwee. they'll be taking photos all day, and just upload all
-- of them at once at the end of the day". His standing photo rules (9 Oct): the raw original is always kept (staff only); the edited copy
-- goes to the patient's file and portal; standard clinical edits; never guess a patient.
--
-- 1. The role grid: a new row "Use the Photo inbox" (photos.intake, under Photos), ticked for the assistant, the coordinator and admin;
--    not the front desk, the doctor or the accountant. Every role gets its cell. "Upload clinic photos and X-rays" (photos.upload) is not
--    changed: the front desk keeps Upload picture / Upload X-ray on the patient profile. Every Photo inbox function also needs "View raw
--    clinic photos folder" (the inbox shows originals) and a branch in that city (public.can_access_city). Moving a filed set to another
--    patient, undoing a filing and taking a photo out use "Delete clinic photos and X-rays" (photos.delete).
-- 2. Files never move. An original is stored once, byte for byte as uploaded, at clinic-photos/inbox/<city>/<day>/<sha256>.<ext> (the
--    day is the photo's own capture day in Karachi; the same photo uploaded twice is one photo); its small copy at .../thumbs/<sha256>.jpg;
--    the edited copy at .../edited/<sha256>.jpg and its small copy at .../edited/thumbs/<sha256>.jpg. A patient's photo rows only point
--    at these files, so moving a set or undoing a filing changes rows, never files, and the original is kept forever by construction.
--    The website stores the files (Storage); the functions below check each path is exactly the one made from the photo's hash, city
--    and day, and that the file is there.
-- 3. New tables (read through the functions; nobody writes them directly):
--      photo_inbox_items: one row per uploaded photo (hash, city, capture day and time, camera, file counter, branch hint, set,
--        Claude's answer, the edit state, the patient's photo rows made from it);
--      photo_inbox_sets: one patient's sitting (waiting / filed / set aside), its likely patients from the last matching, why it waits,
--        the patient and visit it was filed to, how (automatic, with the rule, or confirmed by whom), when the patient may see the edited
--        copies, hidden, Claude's flag (mixed people, not clinical);
--      photo_ai_calls: every Claude call with its tokens and cost (read by Dr. Ali and accounts only: their money rule).
-- 4. Matching runs in the website (web/js/lib/photo-intake.js: the whole day at once, keeping time order) and sends a plan;
--    public.photo_inbox_apply() applies it under a lock for that city and day and checks again, from the raw columns, every rule of an
--    automatic filing (a photo-month visit of that city and day, in treatment or completed, with a start or check-in time the photos fit,
--    no photos yet, one set per visit). Anything else waits on "Which patient?", where one tap files it (photo_inbox_file_set).
-- 5. Filing makes the patient's photo rows: the raw photo (staff only) and, once edited, the edited copy (edited_from the raw one) with
--    the visit, branch, day, braces month, the occasion ("Month 6", or the treatment) and the label ("Month 6 · Front"). The visit's
--    "photos uploaded" tick comes from the existing trigger (now also when a photo is moved to a visit). Every filing, move and undo is in
--    the audit log (PHOTO_FILED, PHOTO_MOVED, PHOTO_UNFILED, PHOTO_TAKEN_OUT, and every photo row and set change by audit_row).
-- 6. The patient sees an edited Photo inbox photo in the portal only 24 hours after it was filed (app setting photo_inbox_hold_hours,
--    0-168), and never while it is hidden or Claude thinks the set shows more than one patient (photos.held_back); staff can hide, move
--    or undo in that time. Enforced in the photos rules ("staff view photos") and in a new storage rule for inbox files.
-- 7. Storage rules: the Photo inbox folder takes uploads only from "Use the Photo inbox" holders, into a city they may use (the profile
--    uploads of photos.upload go to the patient's own folder, as before, and no longer into inbox/); a filed edited copy is read by
--    everyone who opens patient profiles (the profile and the library); the patient reads their visible edited copies.
-- 8. Unchanged on purpose: private.photo_guard (inbox functions need photos.view_raw, and for such callers the guard only fixes who saved
--    a photo and when), private.photo_files (for a row pointing into inbox/ it names no file, so the profile's Delete removes the row and
--    keeps the original in the inbox), the profile uploads.
--
-- Additive and safe to run more than once (tables and columns made if missing, policies and triggers dropped if they exist and made
-- again, functions replaced, the grid cells and the setting added only where missing, so a choice made in the access list is never
-- overwritten). No backslash anywhere in this file.
-- HOW TO APPLY: Supabase dashboard -> SQL Editor -> paste this whole file -> Run. It needs 20261016000200_photo_xray_delete.sql
-- (public.begin_photo_delete, photos.delete) first; live has it. Then deploy the Edge Function photo-ai (index.ts and core.ts), then put
-- the website live and reload the staff tabs (Ctrl+F5). Claude editing starts once Dr. Ali adds ANTHROPIC_API_KEY (docs/PHOTO-INTAKE.md).
-- THE WEBSITE WITHOUT IT: the Photo inbox says it needs the database update of 17 Oct and does nothing; nothing else changes.
-- TO UNDO: drop the functions photo_inbox_*, photo_library, photo_ai_costs, photo_object_visible_to_patient, photo_inbox_city_folder_ok
-- and private.photo_inbox_*; the storage policies "photo inbox uploads", "staff read filed intake edits", "patients read visible intake
-- photos"; the tables photo_inbox_items, photo_ai_calls, photo_inbox_sets; the photos columns intake_item_id, intake_set_id, view_key,
-- occasion, release_after, held_back; restore "staff view photos" (20261005000300), "staff upload clinic photos" (20261005000500) and the
-- trigger photos_mark_visit (after insert only, 20261005000200).
-- =============================================================================
begin;

do $$
begin
  if to_regprocedure('public.begin_photo_delete(uuid)') is null then
    raise exception 'Apply 20261016000200_photo_xray_delete.sql before this file: moving or undoing a filing uses "Delete clinic photos and X-rays".';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. The role grid
-- ---------------------------------------------------------------------------------------------------------------
insert into public.permissions (key, label, category, sort_order, description) values
  ('photos.intake', 'Use the Photo inbox', 'Photos', 54,
   'Upload the day''s photos into the city folders, choose the patient on "Which patient?", hide or show filed photos. Needs "View raw clinic photos folder" too.')
on conflict (key) do nothing;
insert into public.role_permissions (role, permission_key, allowed)
select r.role, 'photos.intake', r.role in ('assistant', 'coordinator', 'admin')
  from unnest(enum_range(null::public.staff_role)) as r(role)
on conflict (role, permission_key) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. The tables
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.photo_inbox_sets (
  id uuid primary key default gen_random_uuid(),
  city_id smallint not null references public.cities(id),
  photo_day date not null,
  status text not null default 'waiting' check (status in ('waiting', 'filed', 'set_aside')),
  manual boolean not null default false,          -- a person split, put back or undid it: never regrouped, never filed by itself
  first_at timestamptz, last_at timestamptz,      -- camera times of its photos (null when none has one)
  photo_count integer not null default 0,
  time_ok boolean not null default false,         -- every photo has a camera time with a right clock
  camera text,
  branch_hint smallint references public.branches(id),
  candidates jsonb not null default '[]'::jsonb,  -- the likely patients of the last matching
  wait_reason text,
  matched_at timestamptz,
  patient_id uuid references public.patients(id) on delete set null,
  visit_id uuid references public.visits(id) on delete set null,
  branch_id smallint references public.branches(id),
  occasion text,                                  -- 'Month 6', or the treatment; fixed when filed
  filed_how text check (filed_how in ('auto', 'confirmed')),
  filed_rule text,
  filed_by uuid,
  filed_at timestamptz,
  release_after timestamptz,                      -- when the patient may see the edited copies
  hidden boolean not null default false,
  ai_flag text check (ai_flag in ('mixed_people', 'not_clinical')),
  set_aside_reason text check (set_aside_reason in ('not_patient', 'taken_out')),
  version integer not null default 0,             -- +1 on every change: a tap on an old screen is refused (PHOTO_STALE)
  created_at timestamptz not null default now()
);

create table if not exists public.photo_ai_calls (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  called_by uuid,
  set_id uuid references public.photo_inbox_sets(id) on delete set null,
  item_ids uuid[] not null default '{}',
  photo_count integer not null default 0,
  model text not null,
  served_model text,
  fallback_used boolean not null default false,
  status text not null check (status in ('ok', 'refused', 'truncated', 'invalid', 'error')),
  stop_reason text,
  error_code text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_creation_input_tokens integer not null default 0,
  cache_read_input_tokens integer not null default 0,
  cost_usd numeric(10, 5) not null default 0,
  one_sitting text,
  duration_ms integer,
  request_id text
);

create table if not exists public.photo_inbox_items (
  id uuid primary key default gen_random_uuid(),
  sha256 text not null unique check (sha256 ~ '^[0-9a-f]{64}$'),
  city_id smallint not null references public.cities(id),
  photo_day date not null,
  storage_path text not null unique,
  thumb_path text,
  edited_path text unique,
  edited_thumb_path text,
  file_name text not null check (length(file_name) between 1 and 200),
  mime_type text not null,
  byte_size bigint not null check (byte_size > 0),
  width integer,
  height integer,
  taken_at timestamptz,
  time_source text not null check (time_source in ('exif', 'exif_modified', 'file_date', 'none')),
  clock_ok boolean not null default false,
  camera text not null default 'unknown',
  orientation smallint,
  file_seq_prefix text,
  file_seq integer,
  branch_hint smallint references public.branches(id),
  uploaded_by uuid not null,
  uploaded_at timestamptz not null default now(),
  upload_batch uuid,
  set_id uuid references public.photo_inbox_sets(id) on delete set null,
  position smallint,
  raw_photo_id uuid references public.photos(id) on delete set null,
  edited_photo_id uuid references public.photos(id) on delete set null,
  ai_status text not null default 'pending' check (ai_status in ('pending', 'done', 'refused', 'failed')),
  ai_result jsonb,
  ai_attempts smallint not null default 0,
  ai_call_id bigint references public.photo_ai_calls(id) on delete set null,
  edit_status text not null default 'pending' check (edit_status in ('pending', 'done', 'failed', 'needs_safari', 'skipped')),
  edit_basic boolean not null default false,
  edit_version smallint,
  edit_attempts smallint not null default 0,
  edit_lease_until timestamptz,
  edit_lease_by uuid
);

create index if not exists photo_inbox_items_city_day_idx on public.photo_inbox_items (city_id, photo_day);
create index if not exists photo_inbox_items_set_idx on public.photo_inbox_items (set_id);
create index if not exists photo_inbox_items_edit_idx on public.photo_inbox_items (edit_status, ai_status) where edit_status <> 'done';
create index if not exists photo_inbox_sets_city_day_idx on public.photo_inbox_sets (city_id, photo_day, status);
create index if not exists photo_inbox_sets_waiting_idx on public.photo_inbox_sets (status) where status = 'waiting';
create index if not exists photo_inbox_sets_visit_idx on public.photo_inbox_sets (visit_id) where visit_id is not null;
create index if not exists photo_ai_calls_created_idx on public.photo_ai_calls (created_at);

alter table public.photo_inbox_sets enable row level security;
alter table public.photo_inbox_items enable row level security;
alter table public.photo_ai_calls enable row level security;
drop policy if exists "photo inbox staff read" on public.photo_inbox_sets;
create policy "photo inbox staff read" on public.photo_inbox_sets for select to authenticated
  using (public.has_perm('photos.intake') and public.has_perm('photos.view_raw') and public.can_access_city(city_id));
drop policy if exists "photo inbox staff read" on public.photo_inbox_items;
create policy "photo inbox staff read" on public.photo_inbox_items for select to authenticated
  using (public.has_perm('photos.intake') and public.has_perm('photos.view_raw') and public.can_access_city(city_id));
drop policy if exists "ai costs read" on public.photo_ai_calls;
create policy "ai costs read" on public.photo_ai_calls for select to authenticated
  using (public.is_admin() or public.has_perm('finance.view'));
revoke insert, update, delete, truncate on public.photo_inbox_sets, public.photo_inbox_items, public.photo_ai_calls from anon, authenticated;
revoke all on public.photo_inbox_sets, public.photo_inbox_items, public.photo_ai_calls from anon;

drop trigger if exists photo_inbox_sets_audit on public.photo_inbox_sets;
create trigger photo_inbox_sets_audit after insert or update or delete on public.photo_inbox_sets
  for each row execute function public.audit_row();

-- ---------------------------------------------------------------------------------------------------------------
-- 5. The patient's photo rows: where they came from, the view, the occasion, the 24-hour window
-- ---------------------------------------------------------------------------------------------------------------
alter table public.photos add column if not exists intake_item_id uuid references public.photo_inbox_items(id) on delete set null;
alter table public.photos add column if not exists intake_set_id uuid references public.photo_inbox_sets(id) on delete set null;
alter table public.photos add column if not exists view_key text;
alter table public.photos add column if not exists occasion text;
alter table public.photos add column if not exists release_after timestamptz;
alter table public.photos add column if not exists held_back boolean not null default false;
create unique index if not exists photos_intake_raw_idx on public.photos (intake_item_id) where kind = 'raw' and intake_item_id is not null;
create unique index if not exists photos_intake_edited_idx on public.photos (intake_item_id) where kind = 'edited' and intake_item_id is not null;
create index if not exists photos_intake_set_idx on public.photos (intake_set_id) where intake_set_id is not null;

-- 6. A patient sees their edited photos, but a Photo inbox photo only once its check window is over and while it is not held back.
-- (Rows saved before this file have no window and are not held back: nothing changes for them.)
alter policy "staff view photos" on public.photos
  using ((kind = 'edited' and public.has_perm('patients.view'))
         or public.has_perm('photos.view_raw')
         or (patient_id = public.current_patient_id() and kind = 'edited' and not held_back
             and (release_after is null or release_after <= now())));

-- 5. A photo moved to a visit ticks that visit's "photos uploaded" too (the function is unchanged: it reads the new row). Moving a set
-- updates the rows' visit; inside this trigger the visit's guard lets the tick through (as on upload).
drop trigger if exists photos_mark_visit on public.photos;
create trigger photos_mark_visit after insert or update of visit_id on public.photos
  for each row when (new.visit_id is not null) execute function public.photo_marks_visit();

-- The setting of the window (hours, 0-168).
insert into public.app_settings (key, value, description) values
  ('photo_inbox_hold_hours', '24'::jsonb, 'Photo inbox: hours after filing before the patient sees the edited photos in the portal (0 = at once).')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- Helpers (private: nobody calls them directly)
-- ---------------------------------------------------------------------------------------------------------------
create schema if not exists private;

-- The city's folder name: karachi, lahore, islamabad (the website's citySlug is the same).
create or replace function private.photo_inbox_city_slug(p_city smallint)
returns text language sql stable security definer set search_path = public as $$
  select btrim(lower(regexp_replace(c.name, '[^A-Za-z0-9]+', '-', 'g')), '-') from public.cities c where c.id = p_city
$$;
revoke all on function private.photo_inbox_city_slug(smallint) from public, anon, authenticated;

-- Who may use the Photo inbox (for that city, when one is named).
create or replace function private.photo_inbox_require(p_city smallint)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.has_perm('photos.intake') or not public.has_perm('photos.view_raw')
     or (p_city is not null and (not exists (select 1 from public.cities c where c.id = p_city) or not public.can_access_city(p_city))) then
    raise exception 'NOT_ALLOWED: the Photo inbox needs "Use the Photo inbox" and "View raw clinic photos folder" in the access list, and a branch in this city.'
      using errcode = '42501';
  end if;
end $$;
revoke all on function private.photo_inbox_require(smallint) from public, anon, authenticated;

create or replace function private.photo_inbox_lock(p_city smallint, p_day date)
returns void language sql volatile security definer set search_path = public as $$
  select pg_advisory_xact_lock(hashtext('photo_inbox:' || p_city::text || ':' || p_day::text))
$$;
revoke all on function private.photo_inbox_lock(smallint, date) from public, anon, authenticated;

-- The patient's check window, as an interval (setting photo_inbox_hold_hours, 24 when missing or not a number, kept within 0-168).
create or replace function private.photo_inbox_hold()
returns interval language sql stable security definer set search_path = public as $$
  select least(168, greatest(0, case when coalesce(public.setting('photo_inbox_hold_hours') #>> '{}', '') ~ '^[0-9]+([.][0-9]+)?$'
                                     then (public.setting('photo_inbox_hold_hours') #>> '{}')::numeric else 24 end)) * interval '1 hour'
$$;
revoke all on function private.photo_inbox_hold() from public, anon, authenticated;

create or replace function private.photo_inbox_view_name(p_key text)
returns text language sql immutable set search_path = public as $$
  select case p_key
    when 'intra_front' then 'Front' when 'intra_right' then 'Right side' when 'intra_left' then 'Left side'
    when 'intra_upper' then 'Upper arch' when 'intra_lower' then 'Lower arch' when 'intra_overjet' then 'Overjet'
    when 'intra_closeup' then 'Close-up' when 'face_front' then 'Face front' when 'face_smile' then 'Face smile'
    when 'face_profile_right' then 'Profile right' when 'face_profile_left' then 'Profile left' when 'face_oblique' then 'Face three-quarter'
    when 'xray' then 'X-ray' when 'document' then 'Document' when 'other' then 'Other' end
$$;
revoke all on function private.photo_inbox_view_name(text) from public, anon, authenticated;

-- "Month 6 · Front", "Scaling · Upper arch", "Month 6 · Photo 3" (before Claude names the view), "Front".
create or replace function private.photo_inbox_label(p_occasion text, p_view_key text, p_position integer)
returns text language sql immutable set search_path = public as $$
  select concat_ws(' ' || chr(183) || ' ', p_occasion, coalesce(private.photo_inbox_view_name(p_view_key), 'Photo ' || coalesce(p_position, 1)))
$$;
revoke all on function private.photo_inbox_label(text, text, integer) from public, anon, authenticated;

create or replace function private.photo_inbox_occasion(v public.visits)
returns text language sql immutable set search_path = public as $$
  select case when v.id is null then null
              when v.braces_month is not null then 'Month ' || v.braces_month
              else nullif(left(btrim(coalesce(v.treatment_label, '')), 40), '') end
$$;
revoke all on function private.photo_inbox_occasion(public.visits) from public, anon, authenticated;

-- The folder of a stored file, with its trailing slash: 'inbox/karachi/2026-10-17/'.
create or replace function private.photo_inbox_dir(p_path text)
returns text language sql immutable set search_path = public as $$
  select left(p_path, length(p_path) - length(split_part(reverse(p_path), '/', 1)))
$$;
revoke all on function private.photo_inbox_dir(text) from public, anon, authenticated;

-- A photo's capture day when its time can be trusted (a camera time with a right clock), else the fallback.
create or replace function private.photo_inbox_taken_on(i public.photo_inbox_items, p_fallback date)
returns date language sql stable set search_path = public as $$
  select case when i.time_source = 'exif' and i.clock_ok and i.taken_at is not null then (i.taken_at at time zone 'Asia/Karachi')::date
              else coalesce(p_fallback, i.photo_day) end
$$;
revoke all on function private.photo_inbox_taken_on(public.photo_inbox_items, date) from public, anon, authenticated;

-- A set's camera times, count, camera and branch hint, and its photos numbered 1..n in photo order.
create or replace function private.photo_inbox_refresh_set(p_set uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.photo_inbox_items i set position = r.pos
    from (select id, row_number() over (order by taken_at nulls last, file_seq nulls last, file_name, sha256) as pos
            from public.photo_inbox_items where set_id = p_set) r
   where i.id = r.id and i.position is distinct from r.pos;
  update public.photo_inbox_sets s set
      first_at = a.first_at, last_at = a.last_at, photo_count = a.n, time_ok = a.time_ok, camera = a.camera, branch_hint = a.hint
    from (select min(taken_at) filter (where time_source = 'exif') as first_at,
                 max(taken_at) filter (where time_source = 'exif') as last_at,
                 count(*)::int as n,
                 coalesce(count(*) > 0 and bool_and(time_source = 'exif' and clock_ok), false) as time_ok,
                 case when count(distinct camera) = 1 then min(camera) when count(*) = 0 then null else 'mixed' end as camera,
                 case when count(distinct coalesce(branch_hint, 0)) = 1 then min(branch_hint) else null end as hint
            from public.photo_inbox_items where set_id = p_set) a
   where s.id = p_set;
end $$;
revoke all on function private.photo_inbox_refresh_set(uuid) from public, anon, authenticated;

-- The patient's photo rows of a filed set: for each photo without one, the raw photo; and the edited copy once it is edited.
-- Returns how many rows it made.
create or replace function private.photo_inbox_file_rows(p_set uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  s public.photo_inbox_sets;
  v public.visits;
  it public.photo_inbox_items;
  v_raw uuid;
  v_edited uuid;
  v_key text;
  v_taken date;
  n integer := 0;
begin
  select * into s from public.photo_inbox_sets where id = p_set;
  if s.id is null or s.status <> 'filed' or s.patient_id is null then
    return 0;
  end if;
  select * into v from public.visits where id = s.visit_id;
  for it in select * from public.photo_inbox_items where set_id = p_set order by position, sha256 loop
    v_key := case when it.ai_status = 'done' and private.photo_inbox_view_name(it.ai_result ->> 'view') is not null then it.ai_result ->> 'view' end;
    v_taken := private.photo_inbox_taken_on(it, v.visit_date);
    v_raw := it.raw_photo_id;
    if v_raw is null then
      insert into public.photos (patient_id, visit_id, branch_id, taken_on, kind, view_label, view_key, braces_month, occasion,
                                 storage_path, thumb_path, edited_from, public_ok, uploaded_by, intake_item_id, intake_set_id)
      values (s.patient_id, s.visit_id, s.branch_id, v_taken, 'raw', private.photo_inbox_label(s.occasion, v_key, it.position), v_key,
              v.braces_month, s.occasion, it.storage_path, it.thumb_path, null, false, auth.uid(), it.id, s.id)
      returning id into v_raw;
      update public.photo_inbox_items set raw_photo_id = v_raw where id = it.id;
      n := n + 1;
    end if;
    if it.edit_status = 'done' and it.edited_path is not null and it.edited_photo_id is null then
      insert into public.photos (patient_id, visit_id, branch_id, taken_on, kind, view_label, view_key, braces_month, occasion,
                                 storage_path, thumb_path, edited_from, public_ok, uploaded_by, intake_item_id, intake_set_id,
                                 release_after, held_back)
      values (s.patient_id, s.visit_id, s.branch_id, v_taken, 'edited', private.photo_inbox_label(s.occasion, v_key, it.position), v_key,
              v.braces_month, s.occasion, it.edited_path, it.edited_thumb_path, v_raw, false, auth.uid(), it.id, s.id,
              s.release_after, s.hidden or coalesce(s.ai_flag = 'mixed_people', false))
      returning id into v_edited;
      update public.photo_inbox_items set edited_photo_id = v_edited where id = it.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke all on function private.photo_inbox_file_rows(uuid) from public, anon, authenticated;

-- The visit (and patient) a set may be filed to: a visit of a branch of the set's city, not cancelled or no-show, on the photos' day (any
-- day within 14 days when the photos have no camera time); or a patient chosen with "Search all patients" (then their visit that day in
-- that city when there is exactly one, else none).
create or replace function private.photo_inbox_target(p_city smallint, p_day date, p_time_ok boolean, p_visit uuid, p_patient uuid,
  out o_visit uuid, out o_patient uuid, out o_branch smallint, out o_occasion text)
language plpgsql stable security definer set search_path = public as $$
declare
  v public.visits;
  v_city smallint;
begin
  if p_visit is not null then
    select vv.* into v from public.visits vv where vv.id = p_visit;
    select b.city_id into v_city from public.branches b where b.id = v.branch_id;
    if v.id is null or v_city is distinct from p_city or v.status in ('cancelled', 'no_show')
       or (p_time_ok and v.visit_date <> p_day) or (not p_time_ok and abs(v.visit_date - p_day) > 14) then
      raise exception 'PHOTO_VISIT_INVALID: that visit is not on this city''s list for that day.';
    end if;
  elsif p_patient is not null then
    if not exists (select 1 from public.patients where id = p_patient) then
      raise exception 'PHOTO_BAD_INPUT: no such patient.';
    end if;
    if (select count(*) from public.visits vv join public.branches b on b.id = vv.branch_id
         where vv.patient_id = p_patient and vv.visit_date = p_day and b.city_id = p_city and vv.status not in ('cancelled', 'no_show')) = 1 then
      select vv.* into v from public.visits vv join public.branches b on b.id = vv.branch_id
       where vv.patient_id = p_patient and vv.visit_date = p_day and b.city_id = p_city and vv.status not in ('cancelled', 'no_show');
    end if;
  else
    raise exception 'PHOTO_BAD_INPUT: choose the patient.';
  end if;
  o_visit := v.id;
  o_patient := coalesce(v.patient_id, p_patient);
  o_branch := v.branch_id;
  o_occasion := private.photo_inbox_occasion(v);
end $$;
revoke all on function private.photo_inbox_target(smallint, date, boolean, uuid, uuid) from public, anon, authenticated;

-- Files a set (one tap, or automatically) and writes PHOTO_FILED in the audit log. Returns { filed, photos, visit_ticked }.
create or replace function private.photo_inbox_file(p_set uuid, p_visit uuid, p_patient uuid, p_branch smallint, p_occasion text,
  p_how text, p_rule text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  n integer;
  v_ticked boolean := false;
begin
  update public.photo_inbox_sets set
      status = 'filed', patient_id = p_patient, visit_id = p_visit, branch_id = coalesce(p_branch, branch_hint), occasion = p_occasion,
      filed_how = p_how, filed_rule = case when p_how = 'auto' then left(p_rule, 200) end, filed_by = auth.uid(), filed_at = now(),
      release_after = now() + private.photo_inbox_hold(), wait_reason = null, set_aside_reason = null, version = version + 1
   where id = p_set;
  n := private.photo_inbox_file_rows(p_set);
  if p_visit is not null then
    select photos_uploaded into v_ticked from public.visits where id = p_visit;
  end if;
  insert into public.audit_log (table_name, row_id, action, new_data, actor)
  values ('photo_inbox_sets', p_set::text, 'PHOTO_FILED',
          jsonb_build_object('patient_id', p_patient, 'visit_id', p_visit, 'how', p_how, 'rule', p_rule, 'photos', n), auth.uid());
  return jsonb_build_object('filed', true, 'photos', n, 'visit_ticked', coalesce(v_ticked, false));
end $$;
revoke all on function private.photo_inbox_file(uuid, uuid, uuid, smallint, text, text, text) from public, anon, authenticated;

-- A visit that lost its last photo loses its "photos uploaded" tick (as the profile's Delete does). Returns whether it did.
create or replace function private.photo_inbox_untick(p_visit uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_visit is null or exists (select 1 from public.photos where visit_id = p_visit) then
    return false;
  end if;
  update public.visits set photos_uploaded = false where id = p_visit and photos_uploaded;
  return found;
end $$;
revoke all on function private.photo_inbox_untick(uuid) from public, anon, authenticated;

-- A set of the caller's cities, locked for the change (the city and day first, then the row). Raises when it is not there.
create or replace function private.photo_inbox_set_for_change(p_set uuid)
returns public.photo_inbox_sets language plpgsql security definer set search_path = public as $$
declare
  s public.photo_inbox_sets;
begin
  select * into s from public.photo_inbox_sets where id = p_set;
  if s.id is null then
    perform private.photo_inbox_require(null);
    raise exception 'PHOTO_SET_STATE: these photos are not there any more. The list is reloaded.';
  end if;
  perform private.photo_inbox_require(s.city_id);
  perform private.photo_inbox_lock(s.city_id, s.photo_day);
  select * into s from public.photo_inbox_sets where id = p_set for update;
  return s;
end $$;
revoke all on function private.photo_inbox_set_for_change(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 7. Storage rules
-- ---------------------------------------------------------------------------------------------------------------
-- Whether a file name is in the inbox folder of a city the caller may use (inbox/<city>/<day>/...).
create or replace function public.photo_inbox_city_folder_ok(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and split_part(p_name, '/', 1) = 'inbox' and split_part(p_name, '/', 4) <> ''
     and split_part(p_name, '/', 3) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     and exists (select 1 from public.cities c
                  where split_part(p_name, '/', 2) = btrim(lower(regexp_replace(c.name, '[^A-Za-z0-9]+', '-', 'g')), '-')
                    and public.can_access_city(c.id))
$$;
revoke all on function public.photo_inbox_city_folder_ok(text) from public, anon;
grant execute on function public.photo_inbox_city_folder_ok(text) to authenticated;

-- Whether the signed-in patient may read this file: an edited copy of theirs, past its window and not held back.
create or replace function public.photo_object_visible_to_patient(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.photos ph
                  where ph.patient_id = public.current_patient_id() and ph.kind = 'edited' and not ph.held_back
                    and (ph.release_after is null or ph.release_after <= now())
                    and (ph.storage_path = p_name or ph.thumb_path = p_name))
$$;
revoke all on function public.photo_object_visible_to_patient(text) from public, anon;
grant execute on function public.photo_object_visible_to_patient(text) to authenticated;

-- Profile uploads (photos.upload) go to the patient's own folder, never into the Photo inbox ...
alter policy "staff upload clinic photos" on storage.objects
  with check (bucket_id = 'clinic-photos' and public.has_perm('photos.upload') and coalesce((storage.foldername(name))[1], '') <> 'inbox');
-- ... which takes uploads from "Use the Photo inbox" holders, into a city they may use.
drop policy if exists "photo inbox uploads" on storage.objects;
create policy "photo inbox uploads" on storage.objects for insert to authenticated
  with check (bucket_id = 'clinic-photos' and (storage.foldername(name))[1] = 'inbox' and public.has_perm('photos.intake')
              and public.photo_inbox_city_folder_ok(name));
-- A filed edited copy (and its small copy) is read by whoever opens patient profiles: the subquery runs under the reader's own photo
-- rules, so only edited copies that are a patient's photo. Originals and raw small copies in inbox/ stay with "View raw clinic photos folder".
drop policy if exists "staff read filed intake edits" on storage.objects;
create policy "staff read filed intake edits" on storage.objects for select to authenticated
  using (bucket_id = 'clinic-photos' and (storage.foldername(name))[1] = 'inbox' and (storage.foldername(name))[4] = 'edited'
         and public.has_perm('patients.view')
         and exists (select 1 from public.photos ph where ph.kind = 'edited' and (ph.storage_path = objects.name or ph.thumb_path = objects.name)));
drop policy if exists "patients read visible intake photos" on storage.objects;
create policy "patients read visible intake photos" on storage.objects for select to authenticated
  using (bucket_id = 'clinic-photos' and (storage.foldername(name))[1] = 'inbox' and public.photo_object_visible_to_patient(name));

-- ---------------------------------------------------------------------------------------------------------------
-- 4. The Photo inbox functions (each checks who is asking; errors start with a code word the website turns into a sentence)
-- ---------------------------------------------------------------------------------------------------------------

-- The city folders the caller may use, with their branches: [{ id, name, slug, branches: [{ id, code, name }] }]. Empty for anyone else.
create or replace function public.photo_inbox_cities()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'slug', private.photo_inbox_city_slug(c.id),
           'branches', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'code', b.code, 'name', b.name) order by b.sort_order, b.id), '[]'::jsonb)
                          from public.branches b where b.city_id = c.id and b.active)) order by c.id), '[]'::jsonb)
    from public.cities c
   where auth.uid() is not null and public.has_perm('photos.intake') and public.has_perm('photos.view_raw') and public.can_access_city(c.id)
     and exists (select 1 from public.branches b where b.city_id = c.id and b.active)
$$;
revoke all on function public.photo_inbox_cities() from public, anon;
grant execute on function public.photo_inbox_cities() to authenticated;

-- Which of these photos (by SHA-256) are uploaded already, and where: [{ sha256, item_id, city_id, city_name, photo_day, set_status }].
create or replace function public.photo_inbox_known(p_hashes text[])
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform private.photo_inbox_require(null);
  if coalesce(array_length(p_hashes, 1), 0) > 500 then
    raise exception 'PHOTO_BAD_INPUT: at most 500 photos are looked up at once.';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('sha256', i.sha256, 'item_id', i.id, 'city_id', i.city_id, 'city_name', c.name,
                                                       'photo_day', i.photo_day, 'set_status', s.status) order by i.sha256)
                     from public.photo_inbox_items i join public.cities c on c.id = i.city_id
                     left join public.photo_inbox_sets s on s.id = i.set_id
                    where i.sha256 = any (select lower(h) from unnest(p_hashes) as h)), '[]'::jsonb);
end $$;
revoke all on function public.photo_inbox_known(text[]) from public, anon;
grant execute on function public.photo_inbox_known(text[]) to authenticated;

-- Registers uploaded photos (at most 50 at once): each must be stored at exactly the path made from its city, day, hash and type, with
-- the size given. A photo uploaded before answers 'duplicate' with where it already is (nothing changes). New photos are in no set
-- until the next matching. Answers [{ sha256, item_id, state, city_id, photo_day }].
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
                                                             'city_id', v_existing.city_id, 'photo_day', v_existing.photo_day));
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
    if v_day is null or v_day < v_today - 8 or v_day > v_today + 1 then
      raise exception 'PHOTO_BAD_INPUT: a photo''s day must be within the last week.';
    end if;
    if v_source = 'exif' and v_clock and v_day <> (v_taken at time zone 'Asia/Karachi')::date then
      raise exception 'PHOTO_BAD_INPUT: a photo''s day is not the day its camera time says.';
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
    insert into public.photo_inbox_items (sha256, city_id, photo_day, storage_path, thumb_path, file_name, mime_type, byte_size, width, height,
                                          taken_at, time_source, clock_ok, camera, orientation, file_seq_prefix, file_seq, branch_hint,
                                          uploaded_by, upload_batch)
    values (v_sha, v_city, v_day, v_path, v_thumb, left(coalesce(nullif(btrim(x ->> 'file_name'), ''), 'photo'), 200), v_mime, v_size,
            case when (x ->> 'width') ~ '^[0-9]{1,6}$' and (x ->> 'width')::int > 0 then (x ->> 'width')::int end,
            case when (x ->> 'height') ~ '^[0-9]{1,6}$' and (x ->> 'height')::int > 0 then (x ->> 'height')::int end,
            v_taken, v_source, v_clock, left(coalesce(nullif(btrim(x ->> 'camera'), ''), 'unknown'), 120),
            case when (x ->> 'orientation') ~ '^[1-8]$' then (x ->> 'orientation')::smallint end,
            left(nullif(x ->> 'file_seq_prefix', ''), 40),
            case when (x ->> 'file_seq') ~ '^[0-9]{1,9}$' then (x ->> 'file_seq')::int end,
            v_hint, auth.uid(),
            case when (x ->> 'upload_batch') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (x ->> 'upload_batch')::uuid end)
    on conflict (sha256) do nothing
    returning id into v_id;
    if v_id is null then
      select * into v_existing from public.photo_inbox_items where sha256 = v_sha;
      v_out := v_out || jsonb_build_array(jsonb_build_object('sha256', v_sha, 'item_id', v_existing.id, 'state', 'duplicate',
                                                             'city_id', v_existing.city_id, 'photo_day', v_existing.photo_day));
    else
      v_out := v_out || jsonb_build_array(jsonb_build_object('sha256', v_sha, 'item_id', v_id, 'state', 'added', 'city_id', v_city, 'photo_day', v_day));
    end if;
  end loop;
  return v_out;
end $$;
revoke all on function public.photo_inbox_add_items(jsonb) from public, anon;
grant execute on function public.photo_inbox_add_items(jsonb) to authenticated;

-- The city folder at a glance: the days of the last 30 with photos (and any older day still waiting), Claude's progress, the window.
create or replace function public.photo_inbox_overview(p_city smallint)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Karachi')::date;
begin
  perform private.photo_inbox_require(p_city);
  return jsonb_build_object(
    'city', (select jsonb_build_object('id', c.id, 'name', c.name, 'slug', private.photo_inbox_city_slug(c.id)) from public.cities c where c.id = p_city),
    'hold_hours', extract(epoch from private.photo_inbox_hold()) / 3600,
    'days', coalesce((
      select jsonb_agg(jsonb_build_object('day', d.photo_day, 'items', d.items, 'waiting', d.waiting, 'filed', d.filed, 'set_aside', d.set_aside,
                                          'unedited', d.unedited) order by d.photo_day desc)
        from (select i.photo_day, count(*) as items,
                     (select count(*) from public.photo_inbox_sets s where s.city_id = p_city and s.photo_day = i.photo_day and s.status = 'waiting') as waiting,
                     (select count(*) from public.photo_inbox_sets s where s.city_id = p_city and s.photo_day = i.photo_day and s.status = 'filed') as filed,
                     (select count(*) from public.photo_inbox_sets s where s.city_id = p_city and s.photo_day = i.photo_day and s.status = 'set_aside') as set_aside,
                     count(*) filter (where i.edit_status not in ('done', 'skipped')) as unedited,
                     bool_or(i.set_id is null) as unset
                from public.photo_inbox_items i where i.city_id = p_city group by i.photo_day) d
       where d.photo_day >= v_today - 30 or d.waiting > 0 or d.unset), '[]'::jsonb),
    'ai', (select jsonb_build_object('pending', count(*) filter (where ai_status = 'pending'), 'done', count(*) filter (where ai_status = 'done'),
                                     'refused', count(*) filter (where ai_status = 'refused'), 'failed', count(*) filter (where ai_status = 'failed'),
                                     'needs_safari', count(*) filter (where edit_status = 'needs_safari'),
                                     'unedited', count(*) filter (where edit_status in ('pending', 'failed')))
             from public.photo_inbox_items where city_id = p_city),
    'waiting_days', coalesce((
      select jsonb_agg(x.d order by x.d) from (
        select distinct s.photo_day as d from public.photo_inbox_sets s where s.city_id = p_city and s.status = 'waiting'
        union select distinct i.photo_day from public.photo_inbox_items i where i.city_id = p_city and i.set_id is null) x), '[]'::jsonb));
end $$;
revoke all on function public.photo_inbox_overview(smallint) from public, anon;
grant execute on function public.photo_inbox_overview(smallint) to authenticated;

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
               'release_after', s.release_after, 'hidden', s.hidden, 'ai_flag', s.ai_flag, 'set_aside_reason', s.set_aside_reason,
               'version', s.version, 'full_name', pt.full_name, 'mr_number', pt.mr_number)
             order by s.first_at nulls last, s.created_at, s.id)
        from public.photo_inbox_sets s left join public.patients pt on pt.id = s.patient_id
       where s.city_id = p_city and s.photo_day = p_day), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'item_id', i.id, 'set_id', i.set_id, 'position', i.position, 'sha256', i.sha256, 'storage_path', i.storage_path,
               'thumb_path', i.thumb_path, 'edited_path', i.edited_path, 'edited_thumb_path', i.edited_thumb_path, 'file_name', i.file_name,
               'mime_type', i.mime_type, 'width', i.width, 'height', i.height, 'taken_at', i.taken_at, 'time_source', i.time_source,
               'clock_ok', i.clock_ok, 'camera', i.camera, 'file_seq_prefix', i.file_seq_prefix, 'file_seq', i.file_seq,
               'branch_hint', i.branch_hint, 'uploaded_by', i.uploaded_by, 'uploaded_at', i.uploaded_at, 'ai_status', i.ai_status,
               'ai_kind', i.ai_result ->> 'kind', 'ai_view', i.ai_result ->> 'view', 'ai_issues', coalesce(i.ai_result -> 'issues', '[]'::jsonb),
               'edit_status', i.edit_status, 'edit_basic', i.edit_basic, 'raw_photo_id', i.raw_photo_id, 'edited_photo_id', i.edited_photo_id)
             order by i.taken_at nulls last, i.file_seq nulls last, i.file_name, i.sha256)
        from public.photo_inbox_items i where i.city_id = p_city and i.photo_day = p_day), '[]'::jsonb));
end $$;
revoke all on function public.photo_inbox_day(smallint, date) from public, anon;
grant execute on function public.photo_inbox_day(smallint, date) to authenticated;

-- Applies the website's matching plan for a city and day (frozen shape: .omc/handoffs/photo-intake-time-spec.md 7.9), under the lock of
-- that city and day:
--   1. the photos the plan regrouped must be exactly the regroupable ones now (no set, or a waiting set nobody changed), each once:
--      else PHOTO_STALE_PLAN (the page reloads the day and plans again);
--   2. each group: joins a filed set (the rest of its sitting) when that is right, else reuses the set of its earliest photo or gets a
--      new one; candidates and the reason come from the plan;
--   3. "auto" is filed only when the rules hold again here, from the raw columns (see the inline checks); else it waits (SERVER_CHECK);
--   4. sets a person changed get fresh candidates (their photos are not touched); 5. regroupable sets left empty are removed.
-- Answers { sets: [{ set_id, item_ids, status }], filed, joined, waiting, server_refused: [{ set_id, why }] }.
create or replace function public.photo_inbox_apply(p_city smallint, p_day date, p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c_matcher constant integer := 1;
  v_current uuid[];
  v_plan_ids uuid[];
  v_group_ids uuid[];
  g jsonb;
  v_items uuid[];
  v_join uuid;
  v_set uuid;
  v_old uuid;
  v_reused uuid[] := '{}';
  v_auto_visits uuid[] := '{}';
  s public.photo_inbox_sets;
  v public.visits;
  v_city smallint;
  v_anchor timestamptz;
  v_why text;
  v_out jsonb := '[]'::jsonb;
  v_refused jsonb := '[]'::jsonb;
  v_filed integer := 0;
  v_joined integer := 0;
  v_waiting integer := 0;
  f jsonb;
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

  -- 2. the groups
  for g in select * from jsonb_array_elements(p_plan -> 'groups') loop
    select array_agg(x::uuid order by o) into v_items from jsonb_array_elements_text(g -> 'item_ids') with ordinality as t(x, o);
    if coalesce(array_length(v_items, 1), 0) = 0 then continue; end if;
    v_join := nullif(g ->> 'join_set_id', '')::uuid;
    if v_join is not null then
      select * into s from public.photo_inbox_sets where id = v_join for update;
      if s.id is not null and s.status = 'filed' and not s.manual and s.city_id = p_city and s.photo_day = p_day
         and not exists (select 1 from public.photo_inbox_items where id = any (v_items) and not (time_source = 'exif' and clock_ok)) then
        update public.photo_inbox_items set set_id = v_join where id = any (v_items);
        perform private.photo_inbox_refresh_set(v_join);
        perform private.photo_inbox_file_rows(v_join);
        update public.photo_inbox_sets set version = version + 1 where id = v_join;
        v_joined := v_joined + 1;
        v_out := v_out || jsonb_build_array(jsonb_build_object('set_id', v_join, 'item_ids', to_jsonb(v_items), 'status', 'filed'));
        continue;
      end if;
    end if;
    select i.set_id into v_old from public.photo_inbox_items i where i.id = v_items[1];
    v_set := null;
    if v_old is not null and not (v_old = any (v_reused))
       and exists (select 1 from public.photo_inbox_sets where id = v_old and status = 'waiting' and not manual) then
      v_set := v_old;
    else
      insert into public.photo_inbox_sets (city_id, photo_day) values (p_city, p_day) returning id into v_set;
    end if;
    v_reused := v_reused || v_set;
    update public.photo_inbox_items set set_id = v_set where id = any (v_items);
    perform private.photo_inbox_refresh_set(v_set);
    update public.photo_inbox_sets set status = 'waiting',
        candidates = case when jsonb_typeof(g -> 'candidates') = 'array' then g -> 'candidates' else '[]'::jsonb end,
        wait_reason = left(nullif(g ->> 'wait_reason', ''), 40), matched_at = now(), version = version + 1
     where id = v_set;

    -- 3. automatic filing, checked again from the raw columns
    if jsonb_typeof(g -> 'auto') = 'object' and coalesce((p_plan ->> 'matcher_version')::int, 0) >= c_matcher then
      select * into s from public.photo_inbox_sets where id = v_set;
      select * into v from public.visits where id = nullif(g -> 'auto' ->> 'visit_id', '')::uuid;
      select b.city_id into v_city from public.branches b where b.id = v.branch_id;
      v_anchor := coalesce(v.started_at, v.checked_in_at);
      v_why := case
        when v.id is null then 'no such visit'
        when not s.time_ok or s.manual or s.ai_flag is not null or s.photo_count > 20 then 'the photos are not clear enough'
        when v.visit_date <> p_day or v_city is distinct from p_city then 'the visit is not of this city and day'
        when s.branch_hint is not null and v.branch_id <> s.branch_hint then 'the visit is at another branch'
        when v.legacy_source is not null or v.status not in ('in_treatment', 'completed') then 'the visit is not in treatment or completed'
        when not v.photo_required then 'not a photo month'
        when v.photos_uploaded or exists (select 1 from public.photos ph where ph.visit_id = v.id)
             or exists (select 1 from public.photo_inbox_sets x where x.visit_id = v.id and x.status = 'filed') then 'the visit has photos already'
        when v_anchor is null or s.first_at < v_anchor - interval '10 minutes' or s.first_at > v_anchor + interval '120 minutes' then 'the photos do not fit the visit''s times'
        when v.id = any (v_auto_visits) then 'two sets for one visit'
        else null end;
      if v_why is null then
        perform private.photo_inbox_file(v_set, v.id, v.patient_id, v.branch_id, private.photo_inbox_occasion(v), 'auto', g -> 'auto' ->> 'rule');
        v_auto_visits := v_auto_visits || v.id;
        v_filed := v_filed + 1;
        v_out := v_out || jsonb_build_array(jsonb_build_object('set_id', v_set, 'item_ids', to_jsonb(v_items), 'status', 'filed'));
        continue;
      end if;
      update public.photo_inbox_sets set wait_reason = 'SERVER_CHECK' where id = v_set;
      v_refused := v_refused || jsonb_build_array(jsonb_build_object('set_id', v_set, 'why', v_why));
    end if;
    v_waiting := v_waiting + 1;
    v_out := v_out || jsonb_build_array(jsonb_build_object('set_id', v_set, 'item_ids', to_jsonb(v_items), 'status', 'waiting'));
  end loop;

  -- 4. sets a person changed: fresh candidates only
  for f in select * from jsonb_array_elements(coalesce(p_plan -> 'fixed_updates', '[]'::jsonb)) loop
    update public.photo_inbox_sets set
        candidates = case when jsonb_typeof(f -> 'candidates') = 'array' then f -> 'candidates' else candidates end,
        wait_reason = coalesce(left(nullif(f ->> 'wait_reason', ''), 40), wait_reason), matched_at = now(), version = version + 1
     where id = nullif(f ->> 'set_id', '')::uuid and city_id = p_city and photo_day = p_day and status = 'waiting' and manual;
  end loop;

  -- 5. regroupable sets left without photos
  delete from public.photo_inbox_sets s1
   where s1.city_id = p_city and s1.photo_day = p_day and s1.status = 'waiting' and not s1.manual
     and not exists (select 1 from public.photo_inbox_items i where i.set_id = s1.id);

  return jsonb_build_object('sets', v_out, 'filed', v_filed, 'joined', v_joined, 'waiting', v_waiting, 'server_refused', v_refused);
end $$;
revoke all on function public.photo_inbox_apply(smallint, date, jsonb) from public, anon;
grant execute on function public.photo_inbox_apply(smallint, date, jsonb) to authenticated;

-- One tap on "Which patient?": files a waiting set to a visit of the day (or to a patient found with "Search all patients").
create or replace function public.photo_inbox_file_set(p_set uuid, p_visit uuid, p_patient uuid, p_version integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.photo_inbox_sets;
  t record;
begin
  s := private.photo_inbox_set_for_change(p_set);
  if s.status <> 'waiting' then
    raise exception 'PHOTO_SET_STATE: these photos were already filed or set aside. The list is reloaded.';
  end if;
  if s.version is distinct from p_version then
    raise exception 'PHOTO_STALE: someone changed these photos a moment ago. The list is reloaded.';
  end if;
  select * into t from private.photo_inbox_target(s.city_id, s.photo_day, s.time_ok, p_visit, p_patient);
  return private.photo_inbox_file(p_set, t.o_visit, t.o_patient, t.o_branch, t.o_occasion, 'confirmed', null);
end $$;
revoke all on function public.photo_inbox_file_set(uuid, uuid, uuid, integer) from public, anon;
grant execute on function public.photo_inbox_file_set(uuid, uuid, uuid, integer) to authenticated;

-- "Not a patient photo": the set is put aside (its files are kept).
create or replace function public.photo_inbox_set_aside(p_set uuid, p_version integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.photo_inbox_sets;
begin
  s := private.photo_inbox_set_for_change(p_set);
  if s.status <> 'waiting' then
    raise exception 'PHOTO_SET_STATE: these photos were already filed or set aside. The list is reloaded.';
  end if;
  if s.version is distinct from p_version then
    raise exception 'PHOTO_STALE: someone changed these photos a moment ago. The list is reloaded.';
  end if;
  update public.photo_inbox_sets set status = 'set_aside', set_aside_reason = 'not_patient', manual = true, wait_reason = null, version = version + 1
   where id = p_set;
  return jsonb_build_object('set_aside', true);
end $$;
revoke all on function public.photo_inbox_set_aside(uuid, integer) from public, anon;
grant execute on function public.photo_inbox_set_aside(uuid, integer) to authenticated;

-- "Put back": a set aside goes back to "Which patient?".
create or replace function public.photo_inbox_put_back(p_set uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.photo_inbox_sets;
begin
  s := private.photo_inbox_set_for_change(p_set);
  if s.status <> 'set_aside' then
    raise exception 'PHOTO_SET_STATE: these photos are not set aside. The list is reloaded.';
  end if;
  update public.photo_inbox_sets set status = 'waiting', set_aside_reason = null, manual = true, wait_reason = 'MANUAL', version = version + 1
   where id = p_set;
  return jsonb_build_object('waiting', true);
end $$;
revoke all on function public.photo_inbox_put_back(uuid) from public, anon;
grant execute on function public.photo_inbox_put_back(uuid) to authenticated;

-- "Split this set": the chosen photo and every later one become a set of their own (both then wait for a person's choice).
create or replace function public.photo_inbox_split_set(p_set uuid, p_first_item uuid, p_version integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.photo_inbox_sets;
  v_pos smallint;
  v_new uuid;
begin
  s := private.photo_inbox_set_for_change(p_set);
  if s.status <> 'waiting' then
    raise exception 'PHOTO_SET_STATE: only photos waiting on "Which patient?" are split. The list is reloaded.';
  end if;
  if s.version is distinct from p_version then
    raise exception 'PHOTO_STALE: someone changed these photos a moment ago. The list is reloaded.';
  end if;
  select position into v_pos from public.photo_inbox_items where id = p_first_item and set_id = p_set;
  if v_pos is null or v_pos <= 1 then
    raise exception 'PHOTO_BAD_INPUT: choose the first photo of the next patient (not the first photo of the set).';
  end if;
  insert into public.photo_inbox_sets (city_id, photo_day, manual, wait_reason, status) values (s.city_id, s.photo_day, true, 'MANUAL', 'waiting')
  returning id into v_new;
  update public.photo_inbox_items set set_id = v_new where set_id = p_set and position >= v_pos;
  perform private.photo_inbox_refresh_set(p_set);
  perform private.photo_inbox_refresh_set(v_new);
  update public.photo_inbox_sets set manual = true, wait_reason = 'MANUAL', candidates = '[]'::jsonb, version = version + 1 where id in (p_set, v_new);
  return jsonb_build_object('set_a', p_set, 'set_b', v_new);
end $$;
revoke all on function public.photo_inbox_split_set(uuid, uuid, integer) from public, anon;
grant execute on function public.photo_inbox_split_set(uuid, uuid, integer) to authenticated;

-- "Move to another city folder": a waiting set goes to another city (its files keep their names).
create or replace function public.photo_inbox_move_city(p_set uuid, p_city smallint, p_version integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.photo_inbox_sets;
begin
  s := private.photo_inbox_set_for_change(p_set);
  perform private.photo_inbox_require(p_city);
  if s.status <> 'waiting' then
    raise exception 'PHOTO_SET_STATE: only photos waiting on "Which patient?" are moved to another city. The list is reloaded.';
  end if;
  if s.version is distinct from p_version then
    raise exception 'PHOTO_STALE: someone changed these photos a moment ago. The list is reloaded.';
  end if;
  if p_city = s.city_id then
    return jsonb_build_object('set_id', p_set);
  end if;
  perform private.photo_inbox_lock(p_city, s.photo_day);
  update public.photo_inbox_items set city_id = p_city, branch_hint = null where set_id = p_set;
  update public.photo_inbox_sets set city_id = p_city, branch_hint = null, manual = true, wait_reason = 'MANUAL', candidates = '[]'::jsonb,
      version = version + 1 where id = p_set;
  return jsonb_build_object('set_id', p_set);
end $$;
revoke all on function public.photo_inbox_move_city(uuid, smallint, integer) from public, anon;
grant execute on function public.photo_inbox_move_city(uuid, smallint, integer) to authenticated;

-- The caller may move or undo filings ("Delete clinic photos and X-rays").
create or replace function private.photo_inbox_require_delete()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_perm('photos.delete') then
    raise exception 'NOT_ALLOWED: moving or undoing a filing needs "Delete clinic photos and X-rays" in the access list.' using errcode = '42501';
  end if;
end $$;
revoke all on function private.photo_inbox_require_delete() from public, anon, authenticated;

-- "Undo filing": the set's photo rows leave the patient's file (the photos are kept) and the set waits on "Which patient?" again.
create or replace function public.photo_inbox_unfile_set(p_set uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.photo_inbox_sets;
  n integer := 0;
  m integer := 0;
  v_unticked boolean;
begin
  s := private.photo_inbox_set_for_change(p_set);
  perform private.photo_inbox_require_delete();
  if s.status <> 'filed' then
    raise exception 'PHOTO_SET_STATE: these photos are not filed. The list is reloaded.';
  end if;
  delete from public.photos where intake_set_id = p_set and kind = 'edited';
  get diagnostics n = row_count;
  delete from public.photos where intake_set_id = p_set;
  get diagnostics m = row_count;
  update public.photo_inbox_items set raw_photo_id = null, edited_photo_id = null where set_id = p_set;
  v_unticked := private.photo_inbox_untick(s.visit_id);
  update public.photo_inbox_sets set status = 'waiting', manual = true, wait_reason = 'UNDONE', patient_id = null, visit_id = null, branch_id = null,
      occasion = null, filed_how = null, filed_rule = null, filed_by = null, filed_at = null, release_after = null, hidden = false,
      version = version + 1
   where id = p_set;
  insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
  values ('photo_inbox_sets', p_set::text, 'PHOTO_UNFILED', jsonb_build_object('patient_id', s.patient_id, 'visit_id', s.visit_id, 'how', s.filed_how),
          jsonb_build_object('removed_photos', n + m), auth.uid());
  return jsonb_build_object('removed_photos', n + m, 'visit_unticked', v_unticked);
end $$;
revoke all on function public.photo_inbox_unfile_set(uuid) from public, anon;
grant execute on function public.photo_inbox_unfile_set(uuid) to authenticated;

-- "Move to another patient": a filed set's photo rows go to another visit or patient (the window starts again).
create or replace function public.photo_inbox_move_set(p_set uuid, p_visit uuid, p_patient uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.photo_inbox_sets;
  t record;
  v public.visits;
  n integer;
  v_release timestamptz := now() + private.photo_inbox_hold();
begin
  s := private.photo_inbox_set_for_change(p_set);
  perform private.photo_inbox_require_delete();
  if s.status <> 'filed' then
    raise exception 'PHOTO_SET_STATE: these photos are not filed. The list is reloaded.';
  end if;
  select * into t from private.photo_inbox_target(s.city_id, s.photo_day, s.time_ok, p_visit, p_patient);
  select * into v from public.visits where id = t.o_visit;
  update public.photos ph set patient_id = t.o_patient, visit_id = t.o_visit, branch_id = coalesce(t.o_branch, s.branch_hint),
      braces_month = v.braces_month, occasion = t.o_occasion,
      view_label = private.photo_inbox_label(t.o_occasion, ph.view_key, i.position),
      taken_on = private.photo_inbox_taken_on(i, v.visit_date),
      release_after = case when ph.kind = 'edited' then v_release else ph.release_after end
    from public.photo_inbox_items i
   where ph.intake_set_id = p_set and i.id = ph.intake_item_id;
  get diagnostics n = row_count;
  if s.visit_id is distinct from t.o_visit then
    perform private.photo_inbox_untick(s.visit_id);
  end if;
  update public.photo_inbox_sets set patient_id = t.o_patient, visit_id = t.o_visit, branch_id = coalesce(t.o_branch, branch_hint),
      occasion = t.o_occasion, release_after = v_release, filed_by = auth.uid(), filed_at = now(), version = version + 1
   where id = p_set;
  insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
  values ('photo_inbox_sets', p_set::text, 'PHOTO_MOVED', jsonb_build_object('patient_id', s.patient_id, 'visit_id', s.visit_id),
          jsonb_build_object('patient_id', t.o_patient, 'visit_id', t.o_visit, 'photos', n), auth.uid());
  return jsonb_build_object('moved_photos', n);
end $$;
revoke all on function public.photo_inbox_move_set(uuid, uuid, uuid) from public, anon;
grant execute on function public.photo_inbox_move_set(uuid, uuid, uuid) to authenticated;

-- "Take out": one photo of a filed set leaves the patient's file and is set aside on its own (kept).
create or replace function public.photo_inbox_take_out(p_item uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  it public.photo_inbox_items;
  s public.photo_inbox_sets;
  v_new uuid;
begin
  select * into it from public.photo_inbox_items where id = p_item;
  if it.id is null or it.set_id is null then
    perform private.photo_inbox_require(null);
    raise exception 'PHOTO_SET_STATE: that photo is not in a filed set. The list is reloaded.';
  end if;
  s := private.photo_inbox_set_for_change(it.set_id);
  perform private.photo_inbox_require_delete();
  if s.status <> 'filed' then
    raise exception 'PHOTO_SET_STATE: that photo is not in a filed set. The list is reloaded.';
  end if;
  delete from public.photos where intake_item_id = p_item and kind = 'edited';
  delete from public.photos where intake_item_id = p_item;
  insert into public.photo_inbox_sets (city_id, photo_day, status, set_aside_reason, manual) values (s.city_id, s.photo_day, 'set_aside', 'taken_out', true)
  returning id into v_new;
  update public.photo_inbox_items set set_id = v_new, raw_photo_id = null, edited_photo_id = null where id = p_item;
  perform private.photo_inbox_refresh_set(s.id);
  perform private.photo_inbox_refresh_set(v_new);
  perform private.photo_inbox_untick(s.visit_id);
  update public.photo_inbox_sets set version = version + 1 where id = s.id;
  insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
  values ('photo_inbox_sets', s.id::text, 'PHOTO_TAKEN_OUT', jsonb_build_object('patient_id', s.patient_id, 'visit_id', s.visit_id),
          jsonb_build_object('item_id', p_item, 'set_id', v_new), auth.uid());
  return jsonb_build_object('set_id', v_new);
end $$;
revoke all on function public.photo_inbox_take_out(uuid) from public, anon;
grant execute on function public.photo_inbox_take_out(uuid) to authenticated;

-- "Hide from patient" / "Show to patient".
create or replace function public.photo_inbox_hide_set(p_set uuid, p_hidden boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.photo_inbox_sets;
  n integer;
begin
  s := private.photo_inbox_set_for_change(p_set);
  if s.status <> 'filed' then
    raise exception 'PHOTO_SET_STATE: these photos are not filed. The list is reloaded.';
  end if;
  update public.photo_inbox_sets set hidden = coalesce(p_hidden, false), version = version + 1 where id = p_set;
  update public.photos set held_back = coalesce(p_hidden, false) or coalesce(s.ai_flag = 'mixed_people', false)
   where intake_set_id = p_set and kind = 'edited';
  get diagnostics n = row_count;
  return jsonb_build_object('photos', n);
end $$;
revoke all on function public.photo_inbox_hide_set(uuid, boolean) from public, anon;
grant execute on function public.photo_inbox_hide_set(uuid, boolean) to authenticated;

-- "It's fine": Claude's flag on a set is cleared (the edited copies follow "hidden" again).
create or replace function public.photo_inbox_resolve_flag(p_set uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.photo_inbox_sets;
begin
  s := private.photo_inbox_set_for_change(p_set);
  update public.photo_inbox_sets set ai_flag = null, version = version + 1 where id = p_set;
  update public.photos set held_back = s.hidden where intake_set_id = p_set and kind = 'edited';
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.photo_inbox_resolve_flag(uuid) from public, anon;
grant execute on function public.photo_inbox_resolve_flag(uuid) to authenticated;

-- The badge: sets waiting on "Which patient?" and filed sets Claude flagged, in the caller's cities. Zeros for anyone else (no error).
create or replace function public.photo_inbox_counts()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.has_perm('photos.intake') or not public.has_perm('photos.view_raw') then
    return jsonb_build_object('waiting', 0, 'check', 0);
  end if;
  return (select jsonb_build_object('waiting', count(*) filter (where s.status = 'waiting'),
                                    'check', count(*) filter (where s.status = 'filed' and s.ai_flag is not null))
            from public.photo_inbox_sets s
           where (s.status = 'waiting' or (s.status = 'filed' and s.ai_flag is not null)) and public.can_access_city(s.city_id));
end $$;
revoke all on function public.photo_inbox_counts() from public, anon;
grant execute on function public.photo_inbox_counts() to authenticated;

-- The edit worker takes photos of ONE set to analyse and edit (filed sets first, then the oldest day), for 10 minutes; two open pages
-- share the work this way. HEIC that only Safari can decode goes only to a page that can (p_can_heic).
create or replace function public.photo_inbox_claim_edits(p_limit integer default 10, p_can_heic boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_set uuid;
  v_out jsonb;
begin
  perform private.photo_inbox_require(null);
  select i.set_id into v_set
    from public.photo_inbox_items i join public.photo_inbox_sets s on s.id = i.set_id
   where s.status <> 'set_aside' and public.can_access_city(i.city_id)
     and (i.edit_status = 'pending' or (i.edit_status = 'failed' and i.edit_attempts < 3) or (coalesce(p_can_heic, false) and i.edit_status = 'needs_safari'))
     and (i.edit_lease_until is null or i.edit_lease_until < now() or i.edit_lease_by = auth.uid())
   order by (s.status = 'filed') desc, s.photo_day, s.first_at nulls last, s.id
   limit 1;
  if v_set is null then
    return '[]'::jsonb;
  end if;
  with picked as (
    select i.id from public.photo_inbox_items i
     where i.set_id = v_set
       and (i.edit_status = 'pending' or (i.edit_status = 'failed' and i.edit_attempts < 3) or (coalesce(p_can_heic, false) and i.edit_status = 'needs_safari'))
       and (i.edit_lease_until is null or i.edit_lease_until < now() or i.edit_lease_by = auth.uid())
     order by i.position nulls last, i.sha256
     limit least(greatest(coalesce(p_limit, 10), 1), 10)
     for update skip locked)
  update public.photo_inbox_items i set edit_lease_until = now() + interval '10 minutes', edit_lease_by = auth.uid()
    from picked where i.id = picked.id;
  select coalesce(jsonb_agg(jsonb_build_object('item_id', i.id, 'set_id', i.set_id, 'set_status', s.status,
           'city_slug', private.photo_inbox_city_slug(i.city_id), 'photo_day', i.photo_day, 'sha256', i.sha256, 'storage_path', i.storage_path,
           'mime_type', i.mime_type, 'orientation', i.orientation, 'width', i.width, 'height', i.height, 'position', i.position,
           'ai_status', i.ai_status, 'ai_result', i.ai_result, 'edit_status', i.edit_status) order by i.position nulls last, i.sha256), '[]'::jsonb)
    into v_out
    from public.photo_inbox_items i join public.photo_inbox_sets s on s.id = i.set_id
   where i.set_id = v_set and i.edit_lease_by = auth.uid() and i.edit_lease_until > now()
     and (i.edit_status = 'pending' or (i.edit_status = 'failed' and i.edit_attempts < 3) or (coalesce(p_can_heic, false) and i.edit_status = 'needs_safari'));
  return v_out;
end $$;
revoke all on function public.photo_inbox_claim_edits(integer, boolean) from public, anon;
grant execute on function public.photo_inbox_claim_edits(integer, boolean) to authenticated;

-- The edited copy of a photo is stored: the item records it, and when its set is filed the patient gets the edited photo row.
create or replace function public.photo_inbox_save_edit(p_item uuid, p_edited_path text, p_edited_thumb_path text, p_edit_version integer, p_basic boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  it public.photo_inbox_items;
  s public.photo_inbox_sets;
  v_path text;
  v_thumb text;
  v_key text;
  v_edited uuid;
begin
  select * into it from public.photo_inbox_items where id = p_item;
  if it.id is null then
    perform private.photo_inbox_require(null);
    raise exception 'PHOTO_SET_STATE: that photo is not there any more.';
  end if;
  perform private.photo_inbox_require(it.city_id);
  select * into it from public.photo_inbox_items where id = p_item for update;
  if it.edit_lease_by is not null and it.edit_lease_by <> auth.uid() and it.edit_lease_until > now() then
    raise exception 'PHOTO_SET_STATE: another page is editing this photo.';
  end if;
  v_path := private.photo_inbox_dir(it.storage_path) || 'edited/' || it.sha256 || '.jpg';
  if p_edited_path is distinct from v_path or (p_edited_thumb_path is not null and p_edited_thumb_path <> public.photo_thumb_path(v_path)) then
    raise exception 'PHOTO_BAD_INPUT: the edited copy is not where it belongs.';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'clinic-photos' and o.name = v_path) then
    raise exception 'PHOTO_FILE_MISSING: the edited photo did not finish uploading.';
  end if;
  v_thumb := case when p_edited_thumb_path is not null
                   and exists (select 1 from storage.objects o where o.bucket_id = 'clinic-photos' and o.name = p_edited_thumb_path)
                  then p_edited_thumb_path end;
  update public.photo_inbox_items set edited_path = v_path, edited_thumb_path = v_thumb, edit_status = 'done', edit_basic = coalesce(p_basic, false),
      edit_version = p_edit_version, edit_lease_until = null, edit_lease_by = null
   where id = p_item;
  select * into it from public.photo_inbox_items where id = p_item;
  select * into s from public.photo_inbox_sets where id = it.set_id;
  v_edited := it.edited_photo_id;
  if s.status = 'filed' and it.raw_photo_id is not null then
    v_key := case when it.ai_status = 'done' and private.photo_inbox_view_name(it.ai_result ->> 'view') is not null then it.ai_result ->> 'view' end;
    update public.photos set view_key = v_key, view_label = private.photo_inbox_label(s.occasion, v_key, it.position)
     where id = it.raw_photo_id and view_key is distinct from v_key;
    if v_edited is null then
      perform private.photo_inbox_file_rows(s.id);
      select edited_photo_id into v_edited from public.photo_inbox_items where id = p_item;
    end if;
  end if;
  return jsonb_build_object('edited_photo_id', v_edited);
end $$;
revoke all on function public.photo_inbox_save_edit(uuid, text, text, integer, boolean) from public, anon;
grant execute on function public.photo_inbox_save_edit(uuid, text, text, integer, boolean) to authenticated;

-- A photo the page could not edit: HEIC this browser cannot decode waits for Safari; anything else is tried again (3 times at most).
create or replace function public.photo_inbox_edit_failed(p_item uuid, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  it public.photo_inbox_items;
  v_status text;
begin
  select * into it from public.photo_inbox_items where id = p_item;
  if it.id is null then
    perform private.photo_inbox_require(null);
    raise exception 'PHOTO_SET_STATE: that photo is not there any more.';
  end if;
  perform private.photo_inbox_require(it.city_id);
  if p_code not in ('HEIC_DECODE', 'DECODE', 'UPLOAD', 'OTHER') then
    raise exception 'PHOTO_BAD_INPUT: unknown problem code.';
  end if;
  v_status := case when p_code = 'HEIC_DECODE' then 'needs_safari' else 'failed' end;
  update public.photo_inbox_items set edit_status = v_status, edit_attempts = edit_attempts + 1, edit_lease_until = null, edit_lease_by = null
   where id = p_item and edit_status <> 'done';
  return jsonb_build_object('edit_status', (select edit_status from public.photo_inbox_items where id = p_item));
end $$;
revoke all on function public.photo_inbox_edit_failed(uuid, text) from public, anon;
grant execute on function public.photo_inbox_edit_failed(uuid, text) to authenticated;

-- The photo-ai Edge Function's check of its caller.
create or replace function public.photo_inbox_ai_allowed()
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and public.has_perm('photos.intake') and public.has_perm('photos.view_raw')
$$;
revoke all on function public.photo_inbox_ai_allowed() from public, anon;
grant execute on function public.photo_inbox_ai_allowed() to authenticated;

-- What Claude said and what it cost (the Edge Function, with the service role only). Results for photos that are not in the call's set
-- are ignored. A photo Claude finds not clinical is not edited and its set is flagged; a set Claude finds shows more than one patient is
-- flagged and its edited copies are held back from the patient.
create or replace function public.photo_inbox_ai_record(p_call jsonb, p_results jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
  v_set uuid := nullif(p_call ->> 'set_id', '')::uuid;
  v_status text := coalesce(p_call ->> 'status', 'error');
  v_ids uuid[];
  r jsonb;
  v_item uuid;
begin
  if v_status not in ('ok', 'refused', 'truncated', 'invalid', 'error') then v_status := 'error'; end if;
  select coalesce(array_agg(x::uuid), '{}') into v_ids from jsonb_array_elements_text(coalesce(p_call -> 'item_ids', '[]'::jsonb)) x;
  insert into public.photo_ai_calls (called_by, set_id, item_ids, photo_count, model, served_model, fallback_used, status, stop_reason, error_code,
                                     input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cost_usd, one_sitting,
                                     duration_ms, request_id)
  values (nullif(p_call ->> 'called_by', '')::uuid, case when exists (select 1 from public.photo_inbox_sets where id = v_set) then v_set end,
          v_ids, coalesce((p_call ->> 'photo_count')::int, coalesce(array_length(v_ids, 1), 0)), coalesce(p_call ->> 'model', 'claude-opus-5-5'),
          p_call ->> 'served_model', coalesce((p_call ->> 'fallback_used')::boolean, false), v_status, p_call ->> 'stop_reason', p_call ->> 'error_code',
          coalesce((p_call ->> 'input_tokens')::int, 0), coalesce((p_call ->> 'output_tokens')::int, 0),
          coalesce((p_call ->> 'cache_creation_input_tokens')::int, 0), coalesce((p_call ->> 'cache_read_input_tokens')::int, 0),
          coalesce((p_call ->> 'cost_usd')::numeric, 0), p_call ->> 'one_sitting', (p_call ->> 'duration_ms')::int, p_call ->> 'request_id')
  returning id into v_id;
  if v_set is null then
    return jsonb_build_object('call_id', v_id);
  end if;
  if v_status = 'ok' then
    for r in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
      v_item := nullif(r ->> 'item_id', '')::uuid;
      update public.photo_inbox_items set ai_status = 'done', ai_result = r -> 'result', ai_call_id = v_id, ai_attempts = ai_attempts + 1,
          edit_status = case when r -> 'result' ->> 'kind' = 'not_clinical' and edit_status <> 'done' then 'skipped' else edit_status end
       where id = v_item and set_id = v_set;
      if found and r -> 'result' ->> 'kind' = 'not_clinical' then
        update public.photo_inbox_sets set ai_flag = coalesce(ai_flag, 'not_clinical'), version = version + 1 where id = v_set;
      end if;
    end loop;
    if p_call ->> 'one_sitting' = 'no' then
      update public.photo_inbox_sets set ai_flag = 'mixed_people', version = version + 1 where id = v_set;
      update public.photos set held_back = true where intake_set_id = v_set and kind = 'edited';
    end if;
  elsif v_status = 'refused' then
    update public.photo_inbox_items set ai_status = 'refused', ai_call_id = v_id, ai_attempts = ai_attempts + 1
     where id = any (v_ids) and set_id = v_set and ai_status = 'pending';
  else
    update public.photo_inbox_items set ai_attempts = ai_attempts + 1, ai_call_id = v_id,
        ai_status = case when ai_attempts + 1 >= 3 then 'failed' else ai_status end
     where id = any (v_ids) and set_id = v_set and ai_status = 'pending';
  end if;
  return jsonb_build_object('call_id', v_id);
end $$;
revoke all on function public.photo_inbox_ai_record(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.photo_inbox_ai_record(jsonb, jsonb) to service_role;

-- The Photo library: photos with their patient (security invoker: the photo and patient rules decide what comes back, so edited photos
-- for whoever opens patient profiles and originals only with "View raw clinic photos folder"). Search by Mr# (from the start) or name
-- (anywhere in it); filters by city, branch, braces month, view, dates. Answers { total, rows }.
create or replace function public.photo_library(p_query text default null, p_city smallint default null, p_branch smallint default null,
  p_month smallint default null, p_view text default null, p_from date default null, p_to date default null, p_kind text default 'edited',
  p_patient uuid default null, p_limit integer default 120, p_offset integer default 0)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare
  v_q text := nullif(btrim(coalesce(p_query, '')), '');
  v_kind text := case when p_kind = 'raw' then 'raw' else 'edited' end;
  v_limit integer := least(greatest(coalesce(p_limit, 120), 1), 300);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
  v_rows jsonb;
begin
  with hits as (
    select ph.*, pt.mr_number, pt.full_name
      from public.photos ph
      join public.patients pt on pt.id = ph.patient_id
      left join public.branches b on b.id = ph.branch_id
     where ph.kind::text = v_kind
       and (p_patient is null or ph.patient_id = p_patient)
       and (p_city is null or b.city_id = p_city)
       and (p_branch is null or ph.branch_id = p_branch)
       and (p_month is null or ph.braces_month = p_month)
       and (p_view is null or ph.view_key = p_view)
       and (p_from is null or ph.taken_on >= p_from)
       and (p_to is null or ph.taken_on <= p_to)
       and (v_q is null
            or (case when strpos(v_q, '%') = 0 and strpos(v_q, '_') = 0 then upper(pt.mr_number) like upper(v_q) || '%' else upper(pt.mr_number) = upper(v_q) end)
            or position(lower(v_q) in lower(pt.full_name)) > 0))
  select (select count(*) from hits),
         coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'patient_id', h.patient_id, 'mr_number', h.mr_number, 'full_name', h.full_name,
                     'kind', h.kind, 'taken_on', h.taken_on, 'braces_month', h.braces_month, 'occasion', h.occasion, 'view_key', h.view_key,
                     'view_label', h.view_label, 'storage_path', h.storage_path, 'thumb_path', h.thumb_path, 'branch_id', h.branch_id,
                     'visit_id', h.visit_id, 'intake_item_id', h.intake_item_id, 'edited_from', h.edited_from, 'created_at', h.created_at)
                     order by h.taken_on desc, h.created_at desc, h.id)
                     from (select * from hits order by taken_on desc, created_at desc, id limit v_limit offset v_offset) h), '[]'::jsonb)
    into v_total, v_rows;
  return jsonb_build_object('total', v_total, 'rows', v_rows);
end $$;
revoke all on function public.photo_library(text, smallint, smallint, smallint, text, date, date, text, uuid, integer, integer) from public, anon;
grant execute on function public.photo_library(text, smallint, smallint, smallint, text, date, date, text, uuid, integer, integer) to authenticated;

-- What Claude editing cost, by Karachi month (Dr. Ali and accounts only: their money rule).
create or replace function public.photo_ai_costs(p_months integer default 12)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.is_admin() or public.has_perm('finance.view')) then
    raise exception 'NOT_ALLOWED: the cost of Claude editing is for Dr. Ali and accounts.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('month', m.month, 'calls', m.calls, 'photos', m.photos, 'refused', m.refused, 'input_tokens', m.input_tokens,
                                        'output_tokens', m.output_tokens, 'cache_read_tokens', m.cache_read_tokens, 'cost_usd', m.cost_usd) order by m.month desc)
      from (select to_char(created_at at time zone 'Asia/Karachi', 'YYYY-MM') as month, count(*) as calls,
                   coalesce(sum(photo_count) filter (where status = 'ok'), 0) as photos, count(*) filter (where status = 'refused') as refused,
                   coalesce(sum(input_tokens), 0) as input_tokens, coalesce(sum(output_tokens), 0) as output_tokens,
                   coalesce(sum(cache_read_input_tokens), 0) as cache_read_tokens, coalesce(sum(cost_usd), 0) as cost_usd
              from public.photo_ai_calls
             where created_at >= (date_trunc('month', now() at time zone 'Asia/Karachi') - make_interval(months => greatest(coalesce(p_months, 12), 1) - 1))
                                 at time zone 'Asia/Karachi'
             group by 1) m), '[]'::jsonb);
end $$;
revoke all on function public.photo_ai_costs(integer) from public, anon;
grant execute on function public.photo_ai_costs(integer) to authenticated;

commit;

-- Tell the API about the new functions straight away.
notify pgrst, 'reload schema';
