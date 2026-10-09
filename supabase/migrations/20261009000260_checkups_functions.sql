-- =============================================================================
-- Checkup patients, part 2: the match key, the list view, the three functions and live updates.
-- Needs 20261009000250_checkups.sql (the table). Additive and safe to run more than once.
--
-- The clinic's way of working (Dr. Ali, 9 Oct 2026): "checkup patients dont habe mr numbers. they just get a date,
-- branch bisited, name, mobile number, treatment recorded, and a separate list where all the checkup patients are
-- listed, last night we made a list for checkup karwaliya patients, the new patients that got checkup done, go here
-- too." So a checkup has no Mr#; when the person starts treatment, ONE click gives them a patient file.
--
-- What this file adds
--   1. private.checkup_phone / private.checkup_key: one way to compare phone numbers and names, whatever way they were
--      typed ("0300-5550142", "+92 300 5550142", "  Sample   Person ").
--   2. A unique index over the old list's rows (source = 'archive'): the same person in the same month exists once, so
--      importing the same Excel file twice adds nothing.
--   3. public.checkup_list: the view the Checkups page reads (the table plus a search key for the phone and the Mr# of
--      the linked patient file). It uses the reader's own rights, so branch limits and "patients see nothing" hold.
--   4. public.register_checkup_as_patient(): the one-click "Create patient file" (next Mr# from the normal counter).
--   5. public.link_checkup_to_patient(): "Same person: link to Mr# N" when the person already has a patient file.
--   6. public.import_checkups(): Dr. Ali's import of the old checkup list in batches of at most 500 rows.
--   7. A guard on the columns only the system sets (source, sheet_key, patient_id, created_by, date_is_month), so a signed-in
--      colleague cannot use the API to get around "old-list rows are removed by Dr. Ali only", make a second patient file for
--      one checkup, or pose as the Google Sheet's or the old list's rows.
--   8. Live updates: checkups join the realtime publication, so the Aaj ki List shows a checkup that the Google Sheet
--      sync (or a colleague) added without a reload.
--
-- Why the two key functions are written with a SQL-standard body (RETURN ...) and keep their default EXECUTE right:
-- the unique index and the view call them as the signed-in staff role, which has no USAGE on schema private. A body
-- given with RETURN is parsed when the function is created, so nothing is looked up by name when it runs. Calling
-- private.checkup_phone() by name from the website is still refused (no USAGE on the schema), so private stays private.
-- =============================================================================

create schema if not exists private;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Keys
-- ---------------------------------------------------------------------------------------------------------------
-- A phone number as digits: 10 digits starting with 3 get the leading 0; 12 digits starting with 92 become 0 + the last
-- 10; any other number with 7 or more digits is kept as its digits; anything shorter is not a usable number (null).
-- Same rule as the Google Sheet sync's private.aaj_norm_phone, under this file's own name (260 must not need 300).
create or replace function private.checkup_phone(p text) returns text
language sql immutable parallel safe
return case
  when regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') ~ '^3[0-9]{9}$'   then '0' || regexp_replace(p, '[^0-9]', '', 'g')
  when regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') ~ '^92[0-9]{10}$' then '0' || substr(regexp_replace(p, '[^0-9]', '', 'g'), 3)
  when length(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g')) >= 7      then regexp_replace(p, '[^0-9]', '', 'g')
end;

-- "phone|name|YYYYMM": the normalised phone, the name in lower case with single spaces, the month of the date.
--   checkup_key('0300-5550142', '  Sample   Person ', '2024-12-01') = '03005550142|sample person|202412'
--   checkup_key(null, 'A B', null) = '|a b|'
create or replace function private.checkup_key(p_phone text, p_name text, p_date date) returns text
language sql immutable parallel safe
return coalesce(private.checkup_phone(p_phone), '') || '|'
    || lower(regexp_replace(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'), '^ | $', '', 'g')) || '|'
    || coalesce(((extract(year from p_date) * 100 + extract(month from p_date))::int)::text, '');

-- One cell of an imported row, cleaned: trimmed, null when empty or only dashes (- U+2013 U+2014), cut to p_max.
-- Only the import function (which runs as its owner) calls it, so nobody else may.
create or replace function private.checkup_text(p text, p_max int) returns text
language sql immutable parallel safe
return case
  when p is null or p ~ '^[\s\-\u2013\u2014]*$' then null
  else left(regexp_replace(p, '^\s+|\s+$', '', 'g'), p_max)
end;
revoke all on function private.checkup_text(text, int) from public, anon, authenticated;

grant execute on function private.checkup_phone(text) to authenticated, service_role;
grant execute on function private.checkup_key(text, text, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------------------------------------------------
-- The guarantee behind "importing the same file twice adds nothing". Rows added on the website or by the sheet sync
-- (source 'website' / 'google_sheet') are never held back by it: two checkups of one person in one month are normal.
create unique index if not exists checkups_archive_key_idx
  on public.checkups (private.checkup_key(phone, patient_name, checkup_date)) where source = 'archive';
create index if not exists checkups_patient_idx on public.checkups (patient_id) where patient_id is not null;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. The list the Checkups page reads
-- ---------------------------------------------------------------------------------------------------------------
-- security_invoker: the checkups policies apply to the reader (a branch-limited account sees its branches and the rows
-- with no branch), and mr_number is empty for a reader who may not see the patient file.
create or replace view public.checkup_list with (security_invoker = true) as
  select c.*, private.checkup_phone(c.phone) as phone_key, p.mr_number
    from public.checkups c left join public.patients p on p.id = c.patient_id;
revoke all on public.checkup_list from public, anon, authenticated;
grant select on public.checkup_list to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Register a checkup patient as a patient (gets the next Mr#)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.register_checkup_as_patient(p_checkup uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c public.checkups;
  v_name text;
  v_phone text;
  v_city smallint;
  v_branch text;
  v_branch_city smallint;
  v_when text;
  v_id uuid;
  v_mr text;
  v_old_mr text;
begin
  -- Registering also links the checkup to the new file and moves its follow-up status, which is editing the list: both rights are needed.
  if not (public.has_perm('patients.create') and public.has_perm('sheet.edit')) then
    raise exception 'NOT_ALLOWED: registering a patient needs "Register new patients" and "Add and edit Aaj ki List entries" in the access list.' using errcode = '42501';
  end if;

  -- The lock stops a double click (or two colleagues) from making two patient files for one checkup.
  select * into c from public.checkups where id = p_checkup for update;
  if c.id is null
     or not ((public.has_perm('sheet.view') or public.has_perm('patients.view'))
             and (c.branch_id is null or public.can_access_branch(c.branch_id))) then
    raise exception 'NOT_FOUND: this checkup is not on your list.' using errcode = 'P0002';
  end if;

  v_name := regexp_replace(btrim(c.patient_name), '\s+', ' ', 'g');
  if c.patient_id is not null then
    select mr_number into v_old_mr from public.patients where id = c.patient_id;
    raise exception 'ALREADY_REGISTERED: % already has a patient file (Mr# %).', v_name, coalesce(v_old_mr, '?') using errcode = '23505';
  end if;

  if length(v_name) < 2 then
    raise exception 'NAME_TOO_SHORT: write the full name on the checkup first.' using errcode = '23514';
  end if;

  v_phone := regexp_replace(coalesce(c.phone, ''), '[^0-9+]', '', 'g');
  if length(v_phone) < 7 then v_phone := null; end if;

  -- The city written on the checkup if it is one of ours, otherwise the branch's city.
  select ci.id into v_city from public.cities ci where lower(ci.name) = lower(btrim(coalesce(c.city, ''))) limit 1;
  select b.name, b.city_id into v_branch, v_branch_city from public.branches b where b.id = c.branch_id;
  v_city := coalesce(v_city, v_branch_city);

  v_when := case
    when c.checkup_date is null then 'date not recorded'
    when c.date_is_month then to_char(c.checkup_date, 'Mon YYYY')
    else to_char(c.checkup_date, 'DD Mon YYYY')
  end;

  -- mr_number stays empty: the insert trigger gives the next number of the normal counter (and sets created_by).
  insert into public.patients (full_name, phone, first_branch_id, city_id, notes)
  values (v_name, v_phone, c.branch_id, v_city,
          'From the checkup list: checkup ' || v_when || coalesce(' at ' || v_branch, '') || coalesce(', for ' || c.checkup_for, ''))
  returning id, mr_number into v_id, v_mr;

  update public.checkups
     set patient_id = v_id,
         follow_up = case when follow_up in ('Started', 'Completed') then follow_up else 'Started' end
   where id = c.id;

  return jsonb_build_object('patient_id', v_id, 'mr_number', v_mr, 'full_name', v_name);
end $$;

revoke all on function public.register_checkup_as_patient(uuid) from public, anon;
grant execute on function public.register_checkup_as_patient(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Link a checkup to a patient file that already exists
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.link_checkup_to_patient(p_checkup uuid, p_patient uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c public.checkups;
  p public.patients;
  v_old_mr text;
begin
  if not (public.has_perm('sheet.edit') and public.has_perm('patients.view')) then
    raise exception 'NOT_ALLOWED: linking a checkup to a patient file needs "Add and edit Aaj ki List entries" and "View patient profiles" in the access list.' using errcode = '42501';
  end if;

  select * into c from public.checkups where id = p_checkup for update;
  if c.id is null
     or not ((public.has_perm('sheet.view') or public.has_perm('patients.view'))
             and (c.branch_id is null or public.can_access_branch(c.branch_id))) then
    raise exception 'NOT_FOUND: this checkup is not on your list.' using errcode = 'P0002';
  end if;

  select * into p from public.patients where id = p_patient;
  if p.id is null then
    raise exception 'NOT_FOUND: that patient file does not exist.' using errcode = 'P0002';
  end if;

  if c.patient_id is not null and c.patient_id <> p.id then
    select mr_number into v_old_mr from public.patients where id = c.patient_id;
    raise exception 'ALREADY_REGISTERED: % already has a patient file (Mr# %).', regexp_replace(btrim(c.patient_name), '\s+', ' ', 'g'), coalesce(v_old_mr, '?') using errcode = '23505';
  end if;

  -- Linking to the file it is already linked to changes nothing (a second click is harmless).
  if c.patient_id is null then
    update public.checkups
       set patient_id = p.id,
           follow_up = case when follow_up in ('Started', 'Completed') then follow_up else 'Started' end
     where id = c.id;
  end if;

  return jsonb_build_object('patient_id', p.id, 'mr_number', p.mr_number, 'full_name', p.full_name);
end $$;

revoke all on function public.link_checkup_to_patient(uuid, uuid) from public, anon;
grant execute on function public.link_checkup_to_patient(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. Import of the old checkup list (Admin -> Import -> "Checkup list"). Admin only.
-- ---------------------------------------------------------------------------------------------------------------
-- p_rows is a JSON array of at most 500 objects, one per person, built by the website from the Excel file:
--   { "row": 17, "month": "2024-12-01" | null, "name": "...", "phone": "0300-5550142" | null, "city": "Karachi" | null,
--     "branch": "GUL" | "NN" | "DHA" | "LHR" | "ISB" | null, "doctors": "..." | null, "checkup_for": "..." | null,
--     "est_fee": 8000 | null, "follow_up": "Follow-up Sent", "notes": "..." | null, "source_tab": "..." | null }
-- (unknown keys are ignored). One bad cell never fails the batch: text is trimmed, dash-only and empty cells become null,
-- long text is cut to the column limit, a month that is not YYYY-MM-DD becomes "no month", a fee that is not a number
-- from 0 up becomes "no fee", an unknown branch code becomes "no branch".
-- A row is "the same" as one already on the website when phone, name and month give the same private.checkup_key (only
-- rows of the old list, source = 'archive', are looked at). For such a row:
--   fill (default): the file's status is taken only while the website still says 'Not Contacted', and the file's notes
--                   only while the website notes are empty - work done on the website is never undone.
--   overwrite:      the file's status wins, and the file's notes win when the file has any.
-- Result: given / inserted / updated (something changed) / unchanged (nothing to do) / kept (the website holds a
-- different status or note and kept it) / skipped (up to 100 listed as { row, reason }) and skipped_count (all of them).
-- given = inserted + updated + unchanged + kept + skipped_count.
create or replace function public.import_checkups(p_rows jsonb, p_overwrite boolean default false)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_over boolean := coalesce(p_overwrite, false);
  n_given int;
  n_skip int := 0; n_cand int := 0; n_ins int := 0; n_upd int := 0; n_kept int := 0; n_same int := 0;
  v_skipped jsonb;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'NOT_ALLOWED: only Dr. Ali can import the checkup list.' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'BAD_ROWS: send the rows as a list.' using errcode = '22023';
  end if;
  n_given := jsonb_array_length(p_rows);
  if n_given > 500 then
    raise exception 'TOO_MANY_ROWS: send at most 500 rows at a time.' using errcode = '22023';
  end if;

  -- A fresh work table for every call, gone at the end of the transaction. It is dropped first on purpose: a database connection is
  -- shared by many requests, so a table of this name left (or made) earlier by somebody else must never be the one used here.
  drop table if exists pg_temp.checkup_import;
  create temp table checkup_import (
    rn int, row_no int, name text, phone text, city text, branch smallint, month date, doctors text, checkup_for text,
    est_fee numeric(12,2), follow_up text, notes text, source_tab text, k text, skip text,
    existing_id uuid, e_follow text, e_notes text, new_follow text, new_notes text, changed boolean, kept boolean) on commit drop;

  insert into checkup_import (rn, row_no, name, phone, city, branch, month, doctors, checkup_for, est_fee, follow_up, notes, source_tab)
  select e.n::int,
         case when e.r->>'row' ~ '^[0-9]{1,9}$' then (e.r->>'row')::int else e.n::int end,
         private.checkup_text(e.r->>'name', 200),
         private.checkup_text(e.r->>'phone', 40),
         private.checkup_text(e.r->>'city', 80),
         (select b.id from public.branches b where upper(b.code) = upper(btrim(e.r->>'branch'))),
         case when e.r->>'month' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}$' and substr(e.r->>'month', 1, 4) <> '0000'
              then make_date(substr(e.r->>'month', 1, 4)::int, substr(e.r->>'month', 6, 2)::int, 1) end,
         private.checkup_text(e.r->>'doctors', 300),
         private.checkup_text(e.r->>'checkup_for', 300),
         case when jsonb_typeof(e.r->'est_fee') = 'number'
              then (case when round((e.r->>'est_fee')::numeric, 2) between 0 and 9999999999.99 then round((e.r->>'est_fee')::numeric, 2) end) end,
         coalesce(private.checkup_text(e.r->>'follow_up', 60), 'Not Contacted'),
         private.checkup_text(e.r->>'notes', 2000),
         private.checkup_text(e.r->>'source_tab', 120)
    from jsonb_array_elements(p_rows) with ordinality as e(r, n);

  update checkup_import set skip = 'No patient name' where name is null;
  update checkup_import set k = private.checkup_key(phone, name, month) where skip is null;
  -- The same person and month twice in one call: the first row wins.
  update checkup_import i set skip = 'Same person and month as row ' || f.row_no
    from checkup_import f
   where i.skip is null and f.skip is null and f.k = i.k and f.rn < i.rn
     and f.rn = (select min(x.rn) from checkup_import x where x.k = i.k and x.skip is null);

  -- Rows of the old list that are already on the website (an index lookup on the unique key).
  update checkup_import i set existing_id = c.id, e_follow = c.follow_up, e_notes = c.notes
    from public.checkups c
   where i.skip is null and c.source = 'archive' and private.checkup_key(c.phone, c.patient_name, c.checkup_date) = i.k;

  update checkup_import i set
    new_follow = case when v_over then i.follow_up when i.e_follow = 'Not Contacted' then i.follow_up else i.e_follow end,
    new_notes  = case when v_over or btrim(coalesce(i.e_notes, '')) = '' then coalesce(i.notes, i.e_notes) else i.e_notes end
   where i.existing_id is not null;
  update checkup_import i set
    changed = i.new_follow is distinct from i.e_follow or i.new_notes is distinct from i.e_notes
   where i.existing_id is not null;
  update checkup_import i set
    kept = not i.changed and (i.follow_up is distinct from i.e_follow or (i.notes is not null and i.notes is distinct from i.e_notes))
   where i.existing_id is not null;

  -- Matched rows: only the status and the notes can change, and only when they differ (updated_at moves by trigger).
  update public.checkups c set follow_up = i.new_follow, notes = i.new_notes
    from checkup_import i
   where c.id = i.existing_id and i.changed;
  get diagnostics n_upd = row_count;

  -- New rows. The unique index makes two imports at the same moment safe: the loser's rows are simply not inserted.
  select count(*) into n_cand from checkup_import where skip is null and existing_id is null;
  with ins as (
    insert into public.checkups (checkup_date, date_is_month, branch_id, patient_name, phone, city, doctors, checkup_for, est_fee,
                                 follow_up, notes, source, source_tab)
    select i.month, true, i.branch, i.name, i.phone, i.city, i.doctors, i.checkup_for, i.est_fee,
           i.follow_up, i.notes, 'archive', i.source_tab
      from checkup_import i
     where i.skip is null and i.existing_id is null
     order by i.rn
    on conflict (private.checkup_key(phone, patient_name, checkup_date)) where source = 'archive' do nothing
    returning 1)
  select count(*) into n_ins from ins;

  select count(*) filter (where kept), count(*) filter (where not changed and not kept)
    into n_kept, n_same from checkup_import where existing_id is not null;
  n_same := n_same + (n_cand - n_ins);   -- a row another import added a moment ago is "already there"

  select count(*) into n_skip from checkup_import where skip is not null;
  select coalesce(jsonb_agg(jsonb_build_object('row', s.row_no, 'reason', s.skip) order by s.rn), '[]'::jsonb) into v_skipped
    from (select * from checkup_import where skip is not null order by rn limit 100) s;

  return jsonb_build_object('given', n_given, 'inserted', n_ins, 'updated', n_upd, 'unchanged', n_same, 'kept', n_kept,
                            'skipped', v_skipped, 'skipped_count', n_skip);
end $$;

revoke all on function public.import_checkups(jsonb, boolean) from public, anon;
grant execute on function public.import_checkups(jsonb, boolean) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 7. Columns that only the system sets
-- ---------------------------------------------------------------------------------------------------------------
-- The "edit checkups" policy lets everyone who keeps the Aaj ki List change any column of a row they may see, and the API
-- accepts every column, not only the ones the website sends. Without this guard a signed-in colleague could change source
-- from 'archive' and then delete the row (which the delete policy keeps for Dr. Ali), clear or set patient_id (a second
-- patient file for one checkup, or a link to another branch's patient), write a sheet_key the Google Sheet sync needs, or
-- add rows that pose as the sheet's or the old list's.
-- The function is SECURITY INVOKER on purpose: current_user is 'authenticated' only for a signed-in person writing through
-- the API directly. Inside register / link / import (SECURITY DEFINER) it is the function's owner, for the Google Sheet sync
-- and the SQL editor it is another role, and Dr. Ali (admin) may do everything, so none of them is held back.
-- A new row from the API is always a website row made by the signed-in person; any other value is refused.
create or replace function private.guard_checkup_columns() returns trigger
language plpgsql set search_path = public
as $$
begin
  if current_user <> 'authenticated' or auth.uid() is null or public.is_admin() then return new; end if;
  if tg_op = 'INSERT' then
    if new.source <> 'website' or new.sheet_key is not null or new.patient_id is not null or new.date_is_month then
      raise exception 'NOT_ALLOWED: the source, the sheet link and the patient file link of a checkup are set by the system and cannot be written by hand.' using errcode = '42501';
    end if;
    new.created_by := auth.uid();
  elsif new.source is distinct from old.source or new.sheet_key is distinct from old.sheet_key or new.patient_id is distinct from old.patient_id
     or new.created_by is distinct from old.created_by or new.date_is_month is distinct from old.date_is_month then
    raise exception 'NOT_ALLOWED: the source, the sheet link and the patient file link of a checkup are set by the system and cannot be changed by hand.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function private.guard_checkup_columns() from public, anon, authenticated;

drop trigger if exists checkups_guard_columns on public.checkups;
create trigger checkups_guard_columns before insert or update on public.checkups
  for each row execute function private.guard_checkup_columns();

-- ---------------------------------------------------------------------------------------------------------------
-- 8. Live updates for the Aaj ki List (the Google Sheet sync writes its checkup rows into the same table)
-- ---------------------------------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.checkups;
    exception when duplicate_object then null;
    end;
  end if;
end $$;

notify pgrst, 'reload schema';
