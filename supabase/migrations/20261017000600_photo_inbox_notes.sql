-- =============================================================================
-- The Photo inbox: a note box for each upload, and old photos (already edited) filed by the note.
--
-- The owner (Dr. Ali, 17 Oct 2026, verbatim): "in the photos upload section, give a small text box for the staff to enter details about
-- the patient so that it gets easier finding and putting patients together quickly. i think that would help a lot. and also make uploads
-- bulk uploads like 30-50 pictures at once. and small text box optional to put in details. acha one more thing, we have about 2000 photos
-- of already edited patients. here is where the text box will come in handy. we upload 50 patients at a time. and tell in the text box
-- details about the patient. so you can find them and put those photos in their patient profile". The old photos are scattered "on mobile
-- phone, on laptop, everywhere" (no folder or file names to go by), and he chose that the note HELPS THE MATCHING: the Mr#s and names in
-- the note come first on "Which patient?", and a note with a single Mr# files the photos straight away.
--
-- 1. Every upload (one choice of photos on the Photo inbox) is a batch: photo_inbox_batches (id = the photos' upload_batch, the city folder,
--    the kind 'day' (today's photos, matched by time as before) or 'old' (old photos, already edited), the note (optional, at most 500
--    characters), who, when). public.photo_inbox_start_batch() records it before the photos are registered; photo_inbox_add_items() reads
--    the kind from it. The note is shown with the photos on "Which patient?" and on Filed.
-- 2. The note is read the same way here (private.photo_inbox_note_mrs, _note_month, _note_words) and in the website (web/js/lib/photo-intake.js
--    noteMrs, noteMonth, noteWords): an Mr# is a number of 3 to 6 digits or an old one like 347-1; phone numbers, dates (17-10-2026) and
--    years (1900-2099: no Mr# of the clinic is in that range) are not; "Month 6", "M6" or "6th month" is the braces month; the other words
--    are names (titles such as Mr, Muhammad, Syed and words such as photos, front, edited left out; "Aisha" is "Ayesha").
-- 3. Today's photos: when the note of the photos' upload names exactly ONE Mr#, that patient has a visit that day in that city (waiting, in
--    treatment or completed) and the upload is one visit (its photos with a camera time lie within 2 hours), a set of those photos is filed
--    to that visit by itself even when the time alone would wait (rule "note_mr", in filed_rule). Checked again here in photo_inbox_apply:
--    the set's photos are all of that one upload, nobody changed the set, Claude did not flag it, the visit is that patient's of that city
--    and day (and of the branch chosen), not cancelled, no-show or only scheduled. A name alone never files anything. Every other rule of
--    the automatic filing by time is unchanged.
-- 4. Old photos: any past day (the photo's own date when it has one, else the upload day); never matched by time (their clock is not
--    trusted: clock_ok false) and never sent to Claude (ai_status 'skipped', a new value): the website stores, next to the original (kept
--    as the staff-only raw photo, as always), an "as it is" copy at edited/<sha>.jpg (upright, at most 2048 px, JPEG, no colour, crop or
--    level change) and registers both at once (edit_status 'done'). An upload whose note names exactly one Mr# that exactly one patient
--    has is filed to that patient by itself (rule "old_note_mr"): no visit, the occasion from the note ("Month 6", else "Old photo", and
--    the braces month on the photo rows), the patient's first branch, the photo's own date. Anything else waits on "Which patient?" with
--    the patients the note names (by Mr#, then names) as one-tap choices, or the search.
-- 5. photo_inbox_sets.kind ('day' / 'old', worked out with the set's photos); file_set and move_set file an old set to a patient without a
--    visit, with its note's occasion. photo_inbox_overview also lists the days of photos uploaded in the last 30 days (an old photo of 2024
--    filed today is on Filed). photo_inbox_day answers the day's batches (kind, note, the Mr#s read, the patients they name).
-- 6. Nothing else changes: the permissions (photos.intake + photos.view_raw + the city), the storage rules, the 24-hour window, the editing.
--
-- Additive and safe to run more than once (table, column and policy made if missing or dropped and made again, the ai_status check widened,
-- functions replaced). No backslash anywhere in this file.
-- HOW TO APPLY: Supabase dashboard -> SQL Editor -> paste this whole file -> Run. It needs 20261017000200_photo_intake.sql (live has it).
-- No Edge Function changes (photo-ai sends only photos whose ai_status is 'pending'). Then put the website live and reload the staff tabs.
-- THE WEBSITE WITHOUT IT: today's photos without a note upload as before; the note box and old photos say they need this update.
-- TO UNDO: drop public.photo_inbox_start_batch, private.photo_inbox_note_mrs/_note_month/_note_words/_month_of/_set_occasion/_old_target,
-- the table photo_inbox_batches and the column photo_inbox_sets.kind (after setting old items' ai_status to 'pending'), restore the
-- ai_status check, and run the functions photo_inbox_add_items, _overview, _day, _apply, _file_set, _move_set, private.photo_inbox_refresh_set
-- and _file_rows from 20261017000200_photo_intake.sql again.
-- =============================================================================
begin;

do $$
begin
  if to_regprocedure('public.photo_inbox_apply(smallint, date, jsonb)') is null then
    raise exception 'Apply 20261017000200_photo_intake.sql before this file: the note box is part of the Photo inbox.';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. The uploads (batches) and their notes; the old photos' marks
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.photo_inbox_batches (
  id uuid primary key,                            -- = photo_inbox_items.upload_batch
  city_id smallint not null references public.cities(id),
  kind text not null default 'day' check (kind in ('day', 'old')),
  note text check (note is null or length(note) between 1 and 500),
  created_by uuid not null,
  created_at timestamptz not null default now()
);
-- Old photos: the patients a name in the note fits (any city, at most 20, the most name words first, this city's first), found once when the
-- upload starts (it reads every patient's name: about half a second), so the day's list stays quick.
alter table public.photo_inbox_batches add column if not exists name_patient_ids uuid[] not null default '{}';
create index if not exists photo_inbox_items_batch_idx on public.photo_inbox_items (upload_batch) where upload_batch is not null;
alter table public.photo_inbox_batches enable row level security;
drop policy if exists "photo inbox staff read" on public.photo_inbox_batches;
create policy "photo inbox staff read" on public.photo_inbox_batches for select to authenticated
  using (public.has_perm('photos.intake') and public.has_perm('photos.view_raw') and public.can_access_city(city_id));
revoke insert, update, delete, truncate on public.photo_inbox_batches from anon, authenticated;
revoke all on public.photo_inbox_batches from anon;

-- An old photo is not sent to Claude: ai_status 'skipped'.
alter table public.photo_inbox_items drop constraint if exists photo_inbox_items_ai_status_check;
alter table public.photo_inbox_items add constraint photo_inbox_items_ai_status_check
  check (ai_status in ('pending', 'done', 'refused', 'failed', 'skipped'));

-- A set of old photos (worked out with its photos by private.photo_inbox_refresh_set).
alter table public.photo_inbox_sets add column if not exists kind text not null default 'day';
alter table public.photo_inbox_sets drop constraint if exists photo_inbox_sets_kind_check;
alter table public.photo_inbox_sets add constraint photo_inbox_sets_kind_check check (kind in ('day', 'old'));

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Reading a note (the website's lib/photo-intake.js reads it the same way)
-- ---------------------------------------------------------------------------------------------------------------
-- The Mr#s in a note, as written ('50013', '9815', '025', '347-1'): phone numbers and dates (17-10-2026, 2026/10/17) taken out first; the
-- old kind (digits, a dash, 1-3 digits), then numbers of 3 to 6 digits that are not part of a longer number; 1900-2099 are years.
create or replace function private.photo_inbox_note_mrs(p_note text)
returns text[] language sql immutable set search_path = public as $$
  with t0 as (select regexp_replace(regexp_replace(lower(coalesce(p_note, '')),
                       '([+]?92[ -]?|0)3[0-9]{2}[ -]?[0-9]{7}', ' ', 'g'),
                       '[0-9]{1,4}[-/.][0-9]{1,2}[-/.][0-9]{1,4}', ' ', 'g') as t),
       dash as (select m[1] as k from t0, regexp_matches(t0.t, '(?<![0-9])([0-9]{1,6}-[0-9]{1,3})(?![0-9])', 'g') as m),
       t1 as (select regexp_replace(t0.t, '(?<![0-9])[0-9]{1,6}-[0-9]{1,3}(?![0-9])', ' ', 'g') as t from t0),
       plain as (select m[1] as k from t1, regexp_matches(t1.t, '(?<![0-9])([0-9]{3,6})(?![0-9])', 'g') as m
                  where m[1] !~ '^(19|20)[0-9]{2}$')
  select coalesce(array_agg(distinct k order by k), '{}'::text[]) from (select k from dash union select k from plain) u
$$;
revoke all on function private.photo_inbox_note_mrs(text) from public, anon, authenticated;

-- The braces month a note names: "Month 6", "month: 6", "M6", "m 12", "6th month" (1 to 60), else null.
create or replace function private.photo_inbox_note_month(p_note text)
returns smallint language sql immutable set search_path = public as $$
  select case when n between 1 and 60 then n::smallint end
    from (select coalesce(substring(lower(coalesce(p_note, '')) from '(?<![a-z])(?:month|mon|m)[ #.:-]*([0-9]{1,2})(?![0-9])'),
                          substring(lower(coalesce(p_note, '')) from '(?<![0-9])([0-9]{1,2})(?:st|nd|rd|th)? *month'))::int as n) x
$$;
revoke all on function private.photo_inbox_note_month(text) from public, anon, authenticated;

-- The name words of a note, as their everyday spelling (private.aaj_name_spelling: "Aisha" = "Ayesha"): letters only, 2 or more, without
-- titles and the words a note has around a name.
create or replace function private.photo_inbox_note_words(p_note text)
returns text[] language sql immutable set search_path = public as $$
  select coalesce(array_agg(distinct s order by s), '{}'::text[])
    from (select private.aaj_name_spelling(w) as s
            from unnest(string_to_array(private.aaj_norm_name(p_note), ' ')) as w
           where w ~ '^[a-z]{2,}$'
             and not (w = any (array['m', 'mr', 'mrs', 'ms', 'miss', 'dr', 'md', 'muhammad', 'mohammad', 'muhammed', 'mohammed', 'mohd', 'syed',
               'syeda', 'sayed', 'hafiz', 'haji', 'baby', 'master', 'kid', 'mrno', 'no', 'number', 'month', 'months', 'mon', 'old', 'new', 'photo',
               'photos', 'pic', 'pics', 'picture', 'pictures', 'image', 'images', 'edited', 'edit', 'patient', 'patients', 'the', 'and', 'of', 'for',
               'with', 'before', 'after', 'braces', 'front', 'side', 'left', 'right', 'upper', 'lower', 'face', 'smile', 'profile', 'xray', 'opg',
               'visit', 'date', 'from', 'to', 'in', 'on', 'at', 'is', 'was', 'an', 'this', 'these', 'his', 'her', 'done', 'case', 'follow', 'up',
               'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'january', 'february', 'march',
               'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'karachi', 'lahore', 'islamabad', 'branch']))) x
   where s <> ''
$$;
revoke all on function private.photo_inbox_note_words(text) from public, anon, authenticated;

-- 'Month 6' -> 6 (the braces month of an occasion without a visit), else null.
create or replace function private.photo_inbox_month_of(p_occasion text)
returns smallint language sql immutable set search_path = public as $$
  select case when coalesce(p_occasion, '') ~ '^Month [0-9]{1,2}$' then substring(p_occasion from 7)::smallint end
$$;
revoke all on function private.photo_inbox_month_of(text) from public, anon, authenticated;

-- The occasion of a set of old photos: the braces month its note names ("Month 6"), else "Old photo".
create or replace function private.photo_inbox_set_occasion(p_set uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select 'Month ' || private.photo_inbox_note_month(min(b.note))
                     from public.photo_inbox_items i join public.photo_inbox_batches b on b.id = i.upload_batch
                    where i.set_id = p_set
                   having count(distinct b.id) = 1 and private.photo_inbox_note_month(min(b.note)) is not null), 'Old photo')
$$;
revoke all on function private.photo_inbox_set_occasion(uuid) from public, anon, authenticated;

-- Where a set of old photos is filed: the patient (chosen, or the patient of a visit given), no visit, the patient's first branch, the
-- occasion of the note.
create or replace function private.photo_inbox_old_target(p_set uuid, p_visit uuid, p_patient uuid,
  out o_visit uuid, out o_patient uuid, out o_branch smallint, out o_occasion text)
language plpgsql stable security definer set search_path = public as $$
begin
  o_patient := coalesce((select vv.patient_id from public.visits vv where vv.id = p_visit), p_patient);
  if o_patient is null then
    raise exception 'PHOTO_BAD_INPUT: choose the patient.';
  end if;
  select pt.first_branch_id into o_branch from public.patients pt where pt.id = o_patient;
  if not found then
    raise exception 'PHOTO_BAD_INPUT: no such patient.';
  end if;
  o_visit := null;
  o_occasion := private.photo_inbox_set_occasion(p_set);
end $$;
revoke all on function private.photo_inbox_old_target(uuid, uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. An upload starts: its city folder, kind and note (the same upload again, e.g. after a lost connection, answers the stored one)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.photo_inbox_start_batch(p_batch uuid, p_city smallint, p_kind text, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  b public.photo_inbox_batches;
  v_note text := nullif(btrim(regexp_replace(coalesce(p_note, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), '');
  v_words text[] := private.photo_inbox_note_words(v_note);
begin
  perform private.photo_inbox_require(p_city);
  if p_batch is null or coalesce(p_kind, '') not in ('day', 'old') then
    raise exception 'PHOTO_BAD_INPUT: an upload needs its id and its kind (today''s photos or old photos).';
  end if;
  if length(v_note) > 500 then
    raise exception 'PHOTO_BAD_INPUT: the note is longer than 500 characters.';
  end if;
  insert into public.photo_inbox_batches (id, city_id, kind, note, created_by, name_patient_ids)
  select p_batch, p_city, p_kind, v_note, auth.uid(),
         case when p_kind = 'old' and cardinality(v_words) > 0 then coalesce((
           select array_agg(q.id order by q.hits desc, q.here desc, q.mr_number)
             from (select p.id, p.mr_number, coalesce(pb.city_id = p_city, false) as here,
                          (select count(*) from unnest(private.aaj_name_words(p.full_name)) w
                            where private.aaj_name_spelling(w) = any (v_words)) as hits
                     from public.patients p left join public.branches pb on pb.id = p.first_branch_id
                    where private.aaj_name_spelling((private.aaj_name_words(p.full_name))[1]) = any (v_words)
                    order by 4 desc, 3 desc, p.mr_number
                    limit 20) q), '{}'::uuid[]) else '{}'::uuid[] end
   where not exists (select 1 from public.photo_inbox_batches where id = p_batch)
  on conflict (id) do nothing;
  select * into b from public.photo_inbox_batches where id = p_batch;
  if b.city_id <> p_city or b.kind <> p_kind or b.created_by <> auth.uid() then
    raise exception 'PHOTO_BAD_INPUT: that upload was started in another way. Choose the photos again.';
  end if;
  return jsonb_build_object('batch_id', b.id, 'kind', b.kind, 'note', b.note);
end $$;
revoke all on function public.photo_inbox_start_batch(uuid, smallint, text, text) from public, anon;
grant execute on function public.photo_inbox_start_batch(uuid, smallint, text, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. The functions of 20261017000200 that change (full bodies; the changes are marked "(notes)")
-- ---------------------------------------------------------------------------------------------------------------
-- A set's camera times, count, camera and branch hint, and its photos numbered 1..n in photo order. The set row is written only when
-- something changed (each write is an audit row). Answers whether it changed.
create or replace function private.photo_inbox_refresh_set(p_set uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  update public.photo_inbox_items i set position = r.pos
    from (select id, row_number() over (order by taken_at nulls last, file_seq nulls last, file_name, sha256) as pos
            from public.photo_inbox_items where set_id = p_set) r
   where i.id = r.id and i.position is distinct from r.pos;
  -- (notes) and its kind: 'old' when every photo is of an upload of old photos
  update public.photo_inbox_sets s set
      first_at = a.first_at, last_at = a.last_at, photo_count = a.n, time_ok = a.time_ok, camera = a.camera, branch_hint = a.hint, kind = a.kind
    from (select min(it.taken_at) filter (where it.time_source = 'exif') as first_at,
                 max(it.taken_at) filter (where it.time_source = 'exif') as last_at,
                 count(*)::int as n,
                 coalesce(count(*) > 0 and bool_and(it.time_source = 'exif' and it.clock_ok), false) as time_ok,
                 case when count(distinct it.camera) = 1 then min(it.camera) when count(*) = 0 then null else 'mixed' end as camera,
                 case when count(distinct coalesce(it.branch_hint, 0)) = 1 then min(it.branch_hint) else null end as hint,
                 case when count(*) > 0 and bool_and(coalesce(bt.kind, 'day') = 'old') then 'old' else 'day' end as kind
            from public.photo_inbox_items it left join public.photo_inbox_batches bt on bt.id = it.upload_batch
           where it.set_id = p_set) a
   where s.id = p_set
     and (s.first_at, s.last_at, s.photo_count, s.time_ok, s.camera, s.branch_hint, s.kind)
         is distinct from (a.first_at, a.last_at, a.n, a.time_ok, a.camera, a.hint, a.kind);
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke all on function private.photo_inbox_refresh_set(uuid) from public, anon, authenticated;

-- The patient's photo rows of a filed set: for each photo without one, the raw photo; and the edited copy once it is edited (or its new
-- file, when it was edited again). An edited copy made after the filing gets its own check window from now (staff see Claude's edit
-- before the patient does, however late the editing ran). A photo the profile's Delete removed has left the set (see the trigger
-- below), so nothing comes back by itself. A filed set without a patient (the patient's record was removed) makes no rows: it is shown
-- under "Check these". Returns how many rows it made or changed.
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
  v_release timestamptz;
  n integer := 0;
begin
  select * into s from public.photo_inbox_sets where id = p_set;
  if s.id is null or s.status <> 'filed' or s.patient_id is null then
    return 0;
  end if;
  select * into v from public.visits where id = s.visit_id;
  -- (notes) a set filed without a visit (old photos) takes its braces month from its occasion ("Month 6")
  v.braces_month := coalesce(v.braces_month, private.photo_inbox_month_of(s.occasion));
  v_release := greatest(coalesce(s.release_after, now()), now() + private.photo_inbox_hold());
  perform private.photo_inbox_writing(true);
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
              v_release, s.hidden or coalesce(s.ai_flag = 'mixed_people', false))
      returning id into v_edited;
      update public.photo_inbox_items set edited_photo_id = v_edited where id = it.id;
      n := n + 1;
    elsif it.edit_status = 'done' and it.edited_path is not null then
      -- edited again: the row points at the new file and the window starts again
      update public.photos set storage_path = it.edited_path, thumb_path = it.edited_thumb_path, view_key = v_key,
          view_label = private.photo_inbox_label(s.occasion, v_key, it.position), release_after = v_release
       where id = it.edited_photo_id and storage_path is distinct from it.edited_path;
      if found then n := n + 1; end if;
    end if;
  end loop;
  perform private.photo_inbox_writing(false);
  return n;
end $$;
revoke all on function private.photo_inbox_file_rows(uuid) from public, anon, authenticated;

-- Registers uploaded photos (at most 50 at once): each must be stored at exactly the path made from its city, day, hash and type, with
-- the size given. A photo uploaded before answers 'duplicate' with where it already is (nothing changes). New photos are in no set
-- until the next matching. Answers [{ sha256, item_id, state, city_id, photo_day }].
-- (notes) A photo of an upload of old photos (photo_inbox_batches.kind 'old', started by the same person in the same city folder): any past
-- day (the day of its camera or file-saved time when it has one, else the upload day), its time never trusted for matching (clock_ok false),
-- not sent to Claude (ai_status 'skipped'); with "edited" its as-it-is copy is stored at edited/<sha>.jpg (checked here) and the photo is
-- registered edited (edit_status 'done'); without, the edit worker makes that copy later (no Claude either).
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
                                          uploaded_by, upload_batch, ai_status, edited_path, edited_thumb_path, edit_status, edit_basic, edit_version)
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
            case when v_edited is not null then (case when (x ->> 'edit_version') ~ '^[0-9]{1,2}$' then (x ->> 'edit_version')::smallint else 1 end) end)
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
-- (notes) Also the days of photos uploaded in the last 30 days (old photos keep their own, older, day).
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
                                          'flagged', d.flagged, 'unedited', d.unedited) order by d.photo_day desc)
        from (select i.photo_day, count(*) as items,
                     (select count(*) from public.photo_inbox_sets s where s.city_id = p_city and s.photo_day = i.photo_day and s.status = 'waiting') as waiting,
                     (select count(*) from public.photo_inbox_sets s where s.city_id = p_city and s.photo_day = i.photo_day and s.status = 'filed') as filed,
                     (select count(*) from public.photo_inbox_sets s where s.city_id = p_city and s.photo_day = i.photo_day and s.status = 'set_aside') as set_aside,
                     (select count(*) from public.photo_inbox_sets s where s.city_id = p_city and s.photo_day = i.photo_day and s.status = 'filed' and (s.ai_flag is not null or s.patient_id is null)) as flagged,
                     count(*) filter (where i.edit_status not in ('done', 'skipped')) as unedited,
                     bool_or(i.set_id is null) as unset,
                     max(i.uploaded_at) >= now() - interval '30 days' as recent
                from public.photo_inbox_items i where i.city_id = p_city group by i.photo_day) d
       where d.photo_day >= v_today - 30 or d.waiting > 0 or d.flagged > 0 or d.set_aside > 0 or d.unset or d.recent), '[]'::jsonb),
    'ai', (select jsonb_build_object('pending', count(*) filter (where ai_status = 'pending'), 'done', count(*) filter (where ai_status = 'done'),
                                     'refused', count(*) filter (where ai_status = 'refused'), 'failed', count(*) filter (where ai_status = 'failed'),
                                     'needs_safari', count(*) filter (where edit_status = 'needs_safari'),
                                     'unedited', count(*) filter (where edit_status in ('pending', 'failed')))
             from public.photo_inbox_items where city_id = p_city),
    'waiting_days', coalesce((
      select jsonb_agg(x.d order by x.d) from (
        select distinct s.photo_day as d from public.photo_inbox_sets s where s.city_id = p_city and s.status = 'waiting'
        union select distinct i.photo_day from public.photo_inbox_items i where i.city_id = p_city and i.set_id is null) x), '[]'::jsonb),
    'check_days', coalesce((select jsonb_agg(distinct s.photo_day order by s.photo_day) from public.photo_inbox_sets s
                             where s.city_id = p_city and s.status = 'filed' and (s.ai_flag is not null or s.patient_id is null)), '[]'::jsonb));
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
               'edit_status', i.edit_status, 'edit_basic', i.edit_basic, 'raw_photo_id', i.raw_photo_id, 'edited_photo_id', i.edited_photo_id)
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
       where bt.id in (select i.upload_batch from public.photo_inbox_items i where i.city_id = p_city and i.photo_day = p_day and i.upload_batch is not null)), '[]'::jsonb));
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
               or (v_gl <= v_fa and v_fa - v_gl <= interval '180 seconds'));
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
        -- (notes) filed by the note: the set's one upload, its note, the one Mr# and its one patient
        select count(distinct coalesce(i.upload_batch::text, '-')), min(i.upload_batch::text)::uuid into v_nb, v_batch
          from public.photo_inbox_items i where i.set_id = v_set;
        select * into bt from public.photo_inbox_batches where id = v_batch;
        v_keys := private.photo_inbox_note_mrs(bt.note);
        select count(*), min(p.id::text)::uuid into v_npat, v_pat from public.patients p where p.mr_number = any (v_keys);
        v_why := case
          when s.manual or s.ai_flag is not null then 'the photos are not clear enough'
          when v_nb <> 1 or bt.id is null or bt.note is null then 'the photos are not of one upload with a note'
          when bt.kind <> case v_rule when 'note_mr' then 'day' else 'old' end then 'the upload is not of that kind'
          when cardinality(v_keys) <> 1 then 'the note does not name exactly one Mr#'
          when v_npat <> 1 then 'no single patient has the Mr# of the note'
          when nullif(g -> 'auto' ->> 'patient_id', '')::uuid is distinct from v_pat then 'the patient is not the one the note names'
          when v_rule = 'note_mr' and (v.id is null or v.patient_id <> v_pat or v.visit_date <> p_day or v_city is distinct from p_city
                                       or v.status not in ('waiting', 'in_treatment', 'completed')) then 'the note''s patient has no visit that day in this city'
          when v_rule = 'note_mr' and s.branch_hint is not null and v.branch_id <> s.branch_hint then 'the visit is at another branch'
          when v_rule = 'note_mr' and (select max(i.taken_at) - min(i.taken_at) from public.photo_inbox_items i
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

-- One tap on "Which patient?": files a waiting set to a visit of the day (or to a patient found with "Search all patients").
-- (notes) A set of old photos goes to the patient (no visit), with the occasion of its note ("Month 6", else "Old photo").
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
  if s.kind = 'old' then
    select * into t from private.photo_inbox_old_target(p_set, p_visit, p_patient);
  else
    select * into t from private.photo_inbox_target(s.city_id, s.photo_day, s.time_ok, p_visit, p_patient);
  end if;
  return private.photo_inbox_file(p_set, t.o_visit, t.o_patient, t.o_branch, t.o_occasion, 'confirmed', null);
end $$;
revoke all on function public.photo_inbox_file_set(uuid, uuid, uuid, integer) from public, anon;
grant execute on function public.photo_inbox_file_set(uuid, uuid, uuid, integer) to authenticated;

-- "Move to another patient": a filed set's photo rows go to another visit or patient (the window starts again). A set left without a
-- patient (the patient's record was removed) gets its rows made for the new patient.
-- (notes) A set of old photos moves to the other patient without a visit, keeping its note's occasion and braces month.
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
  if s.kind = 'old' then
    select * into t from private.photo_inbox_old_target(p_set, p_visit, p_patient);
  else
    select * into t from private.photo_inbox_target(s.city_id, s.photo_day, s.time_ok, p_visit, p_patient);
  end if;
  select * into v from public.visits where id = t.o_visit;
  perform private.photo_inbox_writing(true);
  update public.photos ph set patient_id = t.o_patient, visit_id = t.o_visit, branch_id = coalesce(t.o_branch, s.branch_hint),
      braces_month = coalesce(v.braces_month, private.photo_inbox_month_of(t.o_occasion)), occasion = t.o_occasion,
      view_label = private.photo_inbox_label(t.o_occasion, ph.view_key, i.position),
      taken_on = private.photo_inbox_taken_on(i, v.visit_date),
      release_after = case when ph.kind = 'edited' then v_release else ph.release_after end
    from public.photo_inbox_items i
   where ph.intake_set_id = p_set and i.id = ph.intake_item_id;
  get diagnostics n = row_count;
  perform private.photo_inbox_writing(false);
  if s.visit_id is distinct from t.o_visit then
    perform private.photo_inbox_untick(s.visit_id);
  end if;
  update public.photo_inbox_sets set patient_id = t.o_patient, visit_id = t.o_visit, branch_id = coalesce(t.o_branch, branch_hint),
      occasion = t.o_occasion, release_after = v_release, filed_by = auth.uid(), filed_at = now(), version = version + 1
   where id = p_set;
  n := n + private.photo_inbox_file_rows(p_set);
  insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
  values ('photo_inbox_sets', p_set::text, 'PHOTO_MOVED', jsonb_build_object('patient_id', s.patient_id, 'visit_id', s.visit_id),
          jsonb_build_object('patient_id', t.o_patient, 'visit_id', t.o_visit, 'photos', n), auth.uid());
  return jsonb_build_object('moved_photos', n);
end $$;
revoke all on function public.photo_inbox_move_set(uuid, uuid, uuid) from public, anon;
grant execute on function public.photo_inbox_move_set(uuid, uuid, uuid) to authenticated;

commit;

-- Tell the API about the new function straight away.
notify pgrst, 'reload schema';
