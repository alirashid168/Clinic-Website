-- =====================================================================
-- Aaj ki List two-way sync: website <-> the "Aj ki List" Google Sheet.
--
-- Staff may type patients in EITHER place; both lists stay the same. An
-- Apps Script in the sheet calls public.aaj_sync(secret, payload) about once
-- a minute with what staff typed in the sheet; the answer carries the
-- website's list for the day, so the script can write the website's changes
-- into the sheet. Design: .omc/handoffs/aaj-sync-design.md (+ "Changes
-- during build").
--
-- Rules this file keeps:
--   * A row WITH an Mr# is a visit of a patient; a row WITHOUT an Mr# whose
--     Treatment says "checkup" is a CHECKUP patient (owner, 9 Oct 2026, and
--     his clarification of the same day): it goes to public.checkups
--     (20261009000250_checkups.sql) and never gets a patient file or an Mr#.
--     A row without an Mr# and any other Treatment is an existing patient
--     whose Mr# staff forgot: "Needs attention: add the Mr#" (looked up in
--     Healthwire by a person), never a checkup, never a new patient.
--   * An Mr# that is not on the website: 50000 and above is a typo (refused),
--     below 50000 is a Healthwire number (the patient is created with it and
--     flagged "check name and phone"), but only up to private.aaj_hw_limit():
--     the highest Healthwire number the website already has (private.aaj_hw_top:
--     patient files the sync or the history import made from typed sheet text
--     do not count) plus 100, plus 10 for every day since Healthwire registered
--     that patient (Healthwire numbers about 5 new patients a day, so the limit
--     keeps ahead of it between imports). A number above that has not been
--     given by Healthwire yet: it is refused as a probable typo ("looks like a
--     typo. Check the Mr#. If it is right, ask Dr. Ali to import the latest
--     Healthwire patients"), audited and counted like any refusal.
--     (Otherwise a slip such as 9988 for 9898 becomes a file that Healthwire's
--     own patient 9988 is later merged into by the Healthwire import, which
--     matches by Mr# only: abuse-privacy M-HW-SQUAT.) A RETIRED Mr# (one of the website's
--     10000-10012 that 20261009000400 moved to 50000-50012, or a number merged
--     away) typed with that patient's whole name (no other surname), or with
--     that patient's phone and first name, is refused with "This patient's
--     Mr# is now 50003"; with any other name ("Ali Raza" for "Ali Khanzada")
--     it is a Healthwire number like any other (Healthwire will give
--     10000-10012 to new people), never sent to the other patient's file.
--   * A patient file the sync made from a row today (a Healthwire Mr#) is
--     removed with the row's visit when the row is deleted or its Mr#
--     corrected, nothing else hangs on it and nobody has changed it since
--     (front desk often fills a new file while the patient waits: such a
--     file is kept and the log says so); so is a braces case the sync
--     started for that visit.
--   * A Month typed into a checkup row makes it a braces patient (owner,
--     13:20): never kept as a checkup, never on the nightly checkup list.
--   * A typed Mr# is checked, never searched: the name in the row must fit that patient WITHOUT DOUBT (private.aaj_name_fits: the
--     patient's first name, letter for letter or in an everyday spelling of it, and no other surname, a Muhammad, Syed or Hafiz counted as a
--     word of the name; a surname alone, a name nobody can read and a "name" of more than four words fit nothing, unless it is the patient
--     file's own name letter for letter). A row whose name fits only with doubt (the same first name with another
--     surname, a slip or another first name, a caste word in front, or only the patient's own phone) is REFUSED like a name that does not
--     fit (orchestrator decision, 11 Oct 2026): no visit, no checkup, no phone, no braces case, nothing on the patient file, with the same
--     answer, audited and counted the same way. A refusal never names another patient. At most 250 visits (twice a busy day) and 30 Healthwire patients per branch and day are made by the sync
--     (once the visit cap is full, every row that would make a visit gets the same answer, so a full day is no name check either), 20
--     calls a minute are accepted, and every refused lookup is audited (key, Mr#, typed name and phone, outcome) and capped: 200 a day,
--     and at most 5 in one call (the rest of that call waits). The same row sent again is one lookup; a new guess is a new one. Once the
--     day's 200 are used up, every new Mr# row that would make a visit or a patient gets one and the same answer whether or not its name
--     fits (and still counts for the call's five), like the visit cap: nothing is looked up for free and nothing is made unaudited. Only a
--     row whose patient is on today's list already (the sheet sees them anyway) and a refused row sent again (its own answer) go on.
--   * The same first name but another surname ("Ayesha Rajpoot" typed with the Mr# of "Ayesha Khan") is refused: "Needs attention: the
--     name in this row does not match Mr# N on the website", which never names the patient. An everyday spelling of the patient's first
--     name with the SAME rest of the name, or alone ("Umar Farooq" / "Umer Farooq", "Aisha Khan" / "Ayesha Khan", "Nur Fatima" / "Noor
--     Fatima", "Bilal Ahmad" / "Bilal Ahmed": aaj_name_spelling) fits without doubt. Two names that are two people are never one spelling:
--     "Sana Khan" is never "Sara Khan", "Umair" is never "Umar", "Hussain" never "Hassan", "Rizwana" never "Rizwan".
--   * A row already linked to a visit whose name is then typed over with a name that does not fit that visit's patient without doubt is
--     never re-pointed and never changes the visit: every answer while the name stands says "Needs attention" and nothing from the row is
--     saved; the row goes through again once the name (or the Mr#) is put right.
--   * A row already linked to a visit or checkup whose Mr# cell changes while its name stays (a slip of a finger: token 7 typed into the
--     Mr# cell) is sent under its own key: the visit or checkup is never moved, removed or made again for it, the website's Mr# goes back
--     into the cell and the rest of the row is saved. Only a patient file the sync made from that very row today lets the row go with the
--     corrected Mr# ("rekey"); an Mr# typed into an unregistered checkup row lets it go only for a patient the website has whose name fits
--     (it becomes their visit), never for a new patient file (sheet-behaviour RW8-1, 11 Oct 2026).
--   * A new row that meets a visit (or checkup) the website already has adopts it. A cell typed after the website's last change wins
--     (the newer edit), the status only moves forward (Scheduled, Waiting, Treatment, Completed), and a freshly typed row brings back a
--     Cancelled / No show visit (the patient came after all; Waiting when no Status was typed). A visit already in Treatment or Completed
--     keeps the website's text, and every adopted visit keeps the website's Month, Token and Group when it has them: a stale install-day
--     sheet never sets it back (sheet-behaviour RS5-A1).
--   * One merge per FIELD (month, treatment, token, status, group, details,
--     doctors): a field changed on one side only takes that side's value; a
--     field changed on both sides takes the later edit; doctor names added or
--     removed on either side are kept. What lost is written to audit_log.
--   * A row marked Completed in the sheet COMPLETES the visit: the website's
--     photo / checker / doctor-group rules and the dues hold are skipped
--     (owner rule), recorded as "Completed in the Google Sheet (owner rule,
--     9 Oct 2026)", with the Google Sheet sync as the actor in audit_log.
--     (update private.aaj_sync_config set value = 'hold' where key = 'rules'
--     switches that off: the website's rules then keep the status back.)
--   * A row DELETED in the sheet removes the visit / checkup from the website
--     (owner rule: "deleted patient means wrong entry, or patient didnt come"),
--     a Waiting, Scheduled or No show one alike, but never a visit with an
--     invoice, photo, x-ray, lab case, inventory move, rating or recorded
--     treatment (a Waiting / Scheduled one is kept, marked Cancelled, and the
--     row is put back with the reason; a No show one is kept as it is and its
--     row is not put back), never a visit or checkup in Treatment or Completed
--     (kept, row put back: a checkup too, sheet-behaviour RV-2), never more
--     than 3 rows or a quarter of a tab at
--     once, never more than 15 a day per branch, or 35 in 100 of the day's
--     rows on a busy day (RS12-1). Every removal is in audit_log
--     (SHEET_REMOVED, with the whole row) and is undone by putting the row back
--     in the sheet, or by select public.aaj_undo_removal(<audit_log id>). A
--     row put back whose visit cannot come back at that moment (the patient
--     was typed again in another row) is told so at once and is not put back
--     later behind the sheet's back. A visit kept and marked Cancelled gets
--     its status back when its row comes back with Ctrl+Z after the sync had
--     put it back (the key is then on two rows: "doubled") and nobody changed
--     it since (sheet-behaviour RV-3). A new checkup row with the same name
--     and phone as a checkup whose row is in the tab now is refused as a
--     duplicate, like a second visit of one patient, never made twice (RV-1).
--     A record whose row the website itself let go ("rekey": an Mr# of a
--     patient it has, or a Month, typed into an unregistered checkup row; the
--     Mr# corrected on a row whose patient file the sync made from it today)
--     goes when its key has left the sheet whatever its status (Treatment and
--     Completed too) while nothing real hangs on it: SHEET_LETGO in audit_log,
--     sheet-behaviour RV9-2.
--   * A visit / checkup whose row left the sheet while it was Cancelled (or a
--     No show kept for what hangs on it) is "released" (private.aaj_released,
--     "removed" in the list the sheet gets): never a removal, never put back in
--     the sheet while it stays Cancelled / No show, and put back as a website
--     row once it is set to work again on the website (sheet-behaviour RS5-D4).
--   * A doctor the website's group rule refuses on a row that is not Completed yet stays in the sheet's cell ("pending") and is added when the
--     row is marked Completed (owner rule). A new row for a person who already has a checkup that day whose row is not on the sheet (the
--     row lost its hidden key: cut and pasted, the helper columns deleted, a sort of the visible columns; or the person typed again) adopts
--     it, whatever its Treatment says: the same name and phone (phones compared as numbers), the only checkup of that name when neither has
--     a phone, or, with an Mr#, the checkup registered as that patient. A checkup's sheet_key is written by the sync only (and Dr. Ali / the
--     SQL editor).
--   * The "approved by" columns of an override (protocol_override_by, dues_override_by) hold the first admin's staff id, because they are
--     foreign keys to staff; the reason text and audit_log.actor say "Google Sheet sync".
--   * One bad row never blocks the others (each row is saved on its own).
--   * The secret is small on purpose: only today's lists (and yesterday's
--     until 03:00 for the last flush before the archive) of the five branch
--     tabs, no search, answers carry only what the sheet already shows,
--     every refused lookup is audited and capped, calls are rate limited.
--   * The OLD export's secret (aaj_sheet_export, public.aaj_export) may only
--     read today's or yesterday's list any more (section 13), so it cannot
--     read the history of the clinic either. Delete it once the old export
--     script is off (docs/AAJ-SYNC-SETUP.md section 10).
--   * A visit or checkup whose branch or day is changed on the website (front desk corrects the Branch on the Checkups page) loses its sheet
--     key (private.aaj_release_sheet_claim, sheet-behaviour RS8-B1): the new branch's tab gets it as an unclaimed website row ("Added from
--     the website"), the old tab's row reads "deleted on the website", and no tab's removal pass takes it for a deleted row.
--   * The history import (Admin -> Import, import_aaj_sheet) never makes a
--     patient file from a row without an Mr# or with an Mr# of 50000 or
--     more (owner rules 3 and 4): only a Healthwire number (1 to 49999), and
--     only up to private.aaj_hw_limit() (the sync's rule; above it the row
--     comes back with why).
--     It never guesses either: a row with an Mr# the website does not have
--     is never matched by phone or name to a patient with another Mr# (and
--     never made a patient when its exact name and phone, or a retired Mr#
--     with its patient's whole name, already belong to one: reported back with why), a
--     row whose Mr# belongs to a patient its name does not fit without doubt
--     (the sync's rule, private.aaj_name_fits) is not filed on that patient
--     but reported back with why, a row without an Mr# is matched
--     only by its phone and first name (never by a name alone, never when
--     the surnames differ: "Ali Raza" is not his brother "Ali Hamza" on the
--     family phone), and a row without an Mr# whose Treatment says checkup
--     is not a visit at all: it is skipped and counted (the checkup list has
--     its own import). A row without an Mr# filed by its phone and first
--     name only (not its whole name) never starts or joins a braces case:
--     its Month stays in the visit's notes.
--
-- Additive and re-runnable. It does not touch visit_before_write(),
-- guard_staff_row() or audit_row(), so the order with
-- 20261009000100 / 20261009000200 / 20261009000400 does not matter. It
-- replaces aaj_export() (same answer, today and yesterday only). It needs
-- 20261009000250_checkups.sql (the checkups table) first.
-- =====================================================================

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

do $$
begin
  if to_regclass('public.checkups') is null then
    raise exception 'Apply 20261009000250_checkups.sql before this file: the sheet sync writes checkup patients to public.checkups.';
  end if;
end $$;

create table if not exists private.sync_secrets (
  name        text primary key,
  secret_hash text not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 1. Columns, constraint, tables
-- ---------------------------------------------------------------------
alter table public.visits add column if not exists sheet_key text;     -- 'S-<12 hex>' (made in the sheet) or 'W-<visit id>' (made on the website)
alter table public.visits add column if not exists sheet_cells jsonb;  -- the sheet's own wording of month / token / group / doctors, and the tab
create unique index if not exists visits_sheet_key_idx on public.visits (sheet_key) where sheet_key is not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'visits_sheet_key_format' and conrelid = 'public.visits'::regclass) then
    alter table public.visits add constraint visits_sheet_key_format check (sheet_key is null or sheet_key ~
      '^(S-[0-9a-f]{12}|W-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
  end if;
end $$;

create table if not exists private.aaj_sync_state (      -- diagnostics for the owner (SQL only)
  branch_id     smallint primary key references public.branches(id),
  list_date     date,
  last_call_at  timestamptz,
  rows_present  int,
  last_problems int,
  last_error    text
);
alter table private.aaj_sync_state add column if not exists last_detail text;     -- the database's own error text, never sent to the sheet

create table if not exists private.aaj_sync_config (     -- 'rules': override (default, the owner's rule) | hold
  key   text primary key,
  value text not null
);
insert into private.aaj_sync_config (key, value) values ('rules', 'override') on conflict (key) do nothing;
insert into private.aaj_sync_config (key, value) values ('calls_per_minute', '20') on conflict (key) do nothing;     -- the door's rate limit (a busy minute is about 10 calls)
-- visits the sync may make for one branch and day: twice the owner's busy day ("sometimes on a busy day, we have like 120 patients", 11 Oct
-- 2026, RS12-1). The old default 120 is raised when this runs again; a value Dr. Ali set himself stays
insert into private.aaj_sync_config (key, value) values ('visits_per_branch_day', '250')
  on conflict (key) do update set value = excluded.value where private.aaj_sync_config.value = '120';
insert into private.aaj_sync_config (key, value) values ('new_patients_per_branch_day', '30') on conflict (key) do nothing;   -- Healthwire patients the sync may make for one branch and day (install day: 29 for all five tabs)

-- one row per call, to rate limit the door
create table if not exists private.aaj_sync_calls (at timestamptz not null default clock_timestamp());
create index if not exists aaj_sync_calls_at_idx on private.aaj_sync_calls (at);

-- Staff-only sheet text that does not belong on a row a patient can read through the portal (P.P, Healthwire, Reminder).
create table if not exists private.aaj_visit_text (
  visit_id   uuid primary key references public.visits(id) on delete cascade,
  pp         text,
  healthwire text,
  reminder   text
);

-- A visit or checkup whose row left the sheet while it was Cancelled (or a No show kept for what hangs on it): "released". It is never a
-- removal candidate (a deleted row of a cancelled patient must not delete her visit once she is set back to Waiting on the website), the
-- sheet does not get it back while it stays Cancelled / No show, and gets it back as a website row once it is set to work again. The mark
-- goes when its key shows up in the tab again. Written by the sync only.
create table if not exists private.aaj_released (
  visit_id   uuid unique references public.visits(id) on delete cascade,
  checkup_id uuid unique references public.checkups(id) on delete cascade,
  sheet_key  text not null,
  status     text,
  at         timestamptz not null default now(),
  check ((visit_id is null) <> (checkup_id is null))
);

-- the undo of a removal looks the sheet's key up in the audit log
create index if not exists audit_log_sheet_removed_key_idx on public.audit_log ((new_data->>'key')) where action = 'SHEET_REMOVED';
-- ... and whether it was put back already (or could not be)
create index if not exists audit_log_sheet_restored_idx on public.audit_log ((new_data->>'audit')) where action = 'SHEET_RESTORED';

-- ---------------------------------------------------------------------
-- 2. Small pure helpers (schema private: not reachable through the API)
-- ---------------------------------------------------------------------
create or replace function private.aaj_sync_actor() returns uuid
language sql immutable set search_path = ''
as $$ select '00000000-0000-0000-0000-0000000aa500'::uuid $$;

-- The five tabs of the sheet. The tab name in a payload is NOT trusted (it was copied into rows and the audit log).
create or replace function private.aaj_tab_name(p_code text) returns text
language sql immutable set search_path = ''
as $$ select case p_code when 'GUL' then 'Gulshan KHI' when 'NN' then 'North Nazimabad' when 'DHA' then 'DHA KHI'
                         when 'LHR' then 'Gulberg Lhr' when 'ISB' then 'Islamabad' end $$;

-- lower case, letters/digits only, single spaces
create or replace function private.aaj_norm_name(t text) returns text
language sql immutable set search_path = ''
as $$ select btrim(regexp_replace(regexp_replace(lower(coalesce(t, '')), '[^a-z0-9 ]', ' ', 'g'), ' +', ' ', 'g')) $$;

-- "M Umer" and "Muhammad Umer" both give umer
create or replace function private.aaj_given_name(t text) returns text
language plpgsql immutable set search_path = ''
as $$
declare toks text[] := string_to_array(private.aaj_norm_name(t), ' '); n int := coalesce(array_length(toks, 1), 0); i int;
begin
  if n = 0 then return ''; end if;
  for i in 1 .. n loop
    if not (toks[i] = any (array['m','mr','mrs','ms','miss','dr','md','muhammad','mohammad','muhammed','mohammed','mohd','syed','syeda','sayed','hafiz','haji','baby','master','kid'])) then
      return toks[i];
    end if;
  end loop;
  return toks[n];
end $$;

-- port of phoneOf (web/js/lib/healthwire.js): digits only, 3001234567 and 923001234567 become 03001234567, fewer than 7 digits is no number
-- Used by two indexes on patients: NEVER change the body of this function without rebuilding them.
create or replace function private.aaj_norm_phone(t text) returns text
language sql immutable set search_path = ''
as $$
  select case when d ~ '^3[0-9]{9}$' then '0' || d
              when d ~ '^92[0-9]{10}$' then '0' || substr(d, 3)
              when length(d) >= 7 then d
              else null end
    from (select regexp_replace(coalesce(t, ''), '[^0-9]', '', 'g') as d) x
$$;

-- port of normaliseDoctorKey (web/js/lib/legacy.js)
create or replace function private.aaj_doctor_key(t text) returns text
language sql immutable set search_path = ''
as $$ select btrim(regexp_replace(regexp_replace(regexp_replace(lower(coalesce(t, '')), '\mdr\.?\s*', '', 'g'), '[^a-z ]', '', 'g'), '\s+', ' ', 'g')) $$;

-- "Dr A, Dr. B and C" -> the sorted doctor keys of the people in it (splitPeople + normaliseDoctorKey): compares two doctor cells as sets
create or replace function private.aaj_people_key(t text) returns text
language sql immutable set search_path = ''
as $$
  select coalesce(string_agg(k, '|' order by k), '')
    from (select distinct private.aaj_doctor_key(p) as k from regexp_split_to_table(coalesce(t, ''), ',|/|&|\mand\M', 'i') p) x
   where k <> ''
$$;

create or replace function private.aaj_lev(a text, b text) returns int
language plpgsql immutable set search_path = ''
as $$
declare la int := length(a); lb int := length(b); prev int[]; cur int[]; i int; j int; cost int;
begin
  if la = 0 then return lb; end if;
  if lb = 0 then return la; end if;
  prev := array(select generate_series(0, lb));
  for i in 1 .. la loop
    cur := array[i];
    for j in 1 .. lb loop
      cost := case when substr(a, i, 1) = substr(b, j, 1) then 0 else 1 end;
      cur := cur || least(prev[j + 1] + 1, cur[j] + 1, prev[j] + cost);
    end loop;
    prev := cur;
  end loop;
  return prev[lb + 1];
end $$;

-- The words of a name without the titles: "Syed Muhammad Ali Raza" -> {ali, raza} (the same title list as aaj_given_name)
create or replace function private.aaj_name_words(t text) returns text[]
language sql immutable set search_path = ''
as $$
  select coalesce(array_agg(w order by o), '{}'::text[])
    from unnest(string_to_array(private.aaj_norm_name(t), ' ')) with ordinality x(w, o)
   where w <> '' and not (w = any (array['m','mr','mrs','ms','miss','dr','md','muhammad','mohammad','muhammed','mohammed','mohd','syed','syeda','sayed','hafiz','haji','baby','master','kid']))
$$;

-- Does a typed name fit the patient behind a Mr#? (a different person typed with another patient's Mr# must not be linked)
-- A name that cannot be read (empty, punctuation, Urdu script) on either side says nothing about who this is: it fits nothing. (Otherwise a
-- guessed Mr# plus an unreadable name would link any patient and hand back the name, phone and dues.) The only other proof is the typed phone
-- being the patient's own, which aaj_check_mr checks.
-- A typed "name" of more than four words (titles not counted) fits nothing either: a cell stuffed with common first names
-- ("Qq Ayesha Bilal Fatima Sana ...") would otherwise fit most patients of a guessed Mr#. The patient's first name found among the typed
-- words counts only for a two-word typed name ("Malik Asif" for "Asif Mehmood", "Farooq Umer" for "Umer Farooq").
-- The patient's FIRST name must be in the typed name (or a slip of it): a surname alone ("Qureshi" for "Zubaida Qureshi", "Khan") fits
-- nobody, or one common surname would fit a large part of the clinic behind a guessed Mr# (loop 4). The whole name with one word more in
-- front or behind (a caste or family word the patient file does not have: "Rana Asif Ali", "Ch Asif Ali Khan" for "Asif Ali (Khan)") fits.
-- An everyday spelling of the patient's first name fits when the rest of the name is the same, word for word ("Umar Farooq" for "Umer
-- Farooq", "Aisha Khan" for "Ayesha Khan", "Nur Fatima" for "Noor Fatima", "Heera Malik" for "Hira Malik"), or when the row has the first
-- name only ("Umar" for "Umer Hayat"): the two first names sound the same (aaj_name_sound), are at most two letters apart and differ in
-- length by one letter at most. That needs the patient's whole name (or the first name, which already fitted), so it is no way to find
-- the name behind a guessed Mr#; and it keeps two people apart whose names differ in a consonant ("Sana Khan" / "Sara Khan", "Hira" /
-- "Hina", "Amna" / "Asma"). (sheet-behaviour RS5-N1: 19 of 25 such spellings of the same person were refused.)
-- aaj_name_close says whether a name is near the patient's at all. Whether it fits WITHOUT DOUBT, so that the row may be linked, is
-- private.aaj_name_fits below: a name that is only close (a slip, another first name, another surname) is refused.
create or replace function private.aaj_name_sound(t text) returns text
language sql immutable set search_path = ''
as $$
  -- the first letter (a leading o and u, and e and i, count as one), then the consonants: no a, e, i, o, u, y or h, q as k, z as s and
  -- v as w, a doubled letter once. "umar" and "umer" -> umr, "aisha" and "ayesha" -> as, "nur" and "noor" -> nr, "fahd" and "fahad" -> fd
  select case when coalesce(t, '') = '' then ''
              else translate(left(t, 1), 'oe', 'ui')
                   || regexp_replace(translate(regexp_replace(substr(t, 2), '[aeiouyh]', '', 'g'), 'qzv', 'ksw'), '(.)\1+', '\1', 'g') end
$$;

create or replace function private.aaj_name_close(a text, b text) returns boolean
language plpgsql immutable set search_path = ''
as $$
declare ga text := private.aaj_given_name(a); gb text := private.aaj_given_name(b); wa text[] := private.aaj_name_words(a);
        wb text[] := private.aaj_name_words(b); m int;
begin
  if ga = '' or gb = '' then return false; end if;
  if cardinality(wa) > 4 then return false; end if;
  if ga = gb then return true; end if;
  if cardinality(wa) <= 2 and gb = any (wa) then return true; end if;
  if cardinality(wb) >= 2 and cardinality(wa) <= cardinality(wb) + 1 and wb <@ wa then return true; end if;
  if cardinality(wa) >= 1 and wa[1] = ga and cardinality(wb) >= 1 and wb[1] = gb
     and (cardinality(wa) = 1 or (cardinality(wa) = cardinality(wb) and wa[2:] = wb[2:]))
     and private.aaj_name_sound(ga) = private.aaj_name_sound(gb) and abs(length(ga) - length(gb)) <= 1 and private.aaj_lev(ga, gb) <= 2 then
    return true;
  end if;
  m := least(length(ga), length(gb));
  return private.aaj_lev(ga, gb) <= case when m >= 6 then 2 when m = 5 then 1 else 0 end;
end $$;

-- "Ayesha Rajpoot" typed with the Mr# of "Ayesha Khan" (the first names are the same, so aaj_name_close says yes): both names have two or
-- more words (titles not counted) and neither name's words are all in the other. Such a row is refused (aaj_name_fits).
create or replace function private.aaj_names_conflict(a text, b text) returns boolean
language plpgsql immutable set search_path = ''
as $$
declare wa text[] := private.aaj_name_words(a); wb text[] := private.aaj_name_words(b);
begin
  return cardinality(wa) >= 2 and cardinality(wb) >= 2 and not (wa <@ wb or wb <@ wa);
end $$;

-- One word of a name as it sounds when the everyday ways of writing an Urdu name in English letters are taken away: q as k, v as w;
-- "ye" after a vowel and a y that is not a consonant as i (Ayesha / Aisha, Aly / Ali, Sayma / Saima, Maryam / Mariam); ee as i, oo and ou
-- as u (Heera / Hira, Noor / Nur, Yousuf / Yusuf); a first e as i (Eman / Iman, Ehsan / Ihsan), any other e as a and o as u (Umer / Umar,
-- Mehwish / Mahwish, Ahmed / Ahmad, Osman / Usman, Owais / Uwais); a doubled letter once (Sanaa / Sana, Aamna / Amna); a last h after a
-- vowel dropped (Sabah / Saba). Nothing else: a, i and u stay apart and no letter is added or taken away, so two names that are two
-- people never become one ("Umar" / "Umair", "Hassan" / "Hussain", "Sana" / "Sania", "Kashif" / "Kashaf", "Rizwan" / "Rizwana",
-- "Sara" / "Zara", "Nadia" / "Nida", "Ehsan" / "Ahsan"). The same rule is in tests/aaj-sync-fake-server.mjs and web/js/data/demo.js.
create or replace function private.aaj_name_spelling(t text) returns text
language plpgsql immutable set search_path = ''
as $$
declare s text := translate(regexp_replace(lower(coalesce(t, '')), '[^a-z]', '', 'g'), 'qv', 'kw');
begin
  s := regexp_replace(s, '([aeiou])ye', '\1i', 'g');
  s := regexp_replace(s, '(.)y(?![aeiou])', '\1i', 'g');
  s := regexp_replace(s, '([^aeiou])y(?=[aeiou])', '\1i', 'g');
  s := replace(replace(replace(s, 'ee', 'i'), 'oo', 'u'), 'ou', 'u');
  s := regexp_replace(s, '^e', 'i');
  s := translate(s, 'oe', 'ua');
  s := regexp_replace(s, '(.)\1+', '\1', 'g');
  return regexp_replace(s, '([aiu])h$', '\1');
end $$;

-- Does a typed name fit the patient behind a Mr# WITHOUT DOUBT, so that the row may be linked to that patient? (orchestrator decision,
-- 11 Oct 2026: a row whose name fits only with doubt is refused like any other refusal.) The first names are the same (letter for letter,
-- or written another everyday way: aaj_name_spelling) and there is no other surname: every word of one name is in the other, compared
-- the same way ("Ayesha" for "Ayesha Khan", "Bilal Ahmad" for "Bilal Ahmed", "Asif Ali Khan" for "Asif Ali"). Not: another surname
-- ("Ayesha Rajpoot" for "Ayesha Khan"), another first name or a slip of it ("Umair Farooq" for "Umar Farooq", "Ayesh Khan"), a caste or
-- family word in front ("Rana Asif Ali" for "Asif Ali": "Ali Hassan Raza" for his father "Hassan Raza" looks the same), the words in
-- another order ("Ali Hassan" / "Hassan Ali" are two people), more than four words, or a name nobody can read.
-- Muhammad, Syed, Syeda, Hafiz, Haji, Baby, Master and Kid are words of the name in that last check (only Mr, Mrs, Ms, Miss and Dr are left
-- out; M, Md, Mohd and the other ways of writing Muhammad are one word, Sayed is Syed): when both names have two words or more, all the
-- words of one are in the other. Without it a two-word name with a title was one word ("Muhammad Usman" -> usman) and fitted every patient
-- whose first name it is: "Muhammad Usman" typed with the Mr# of "Usman Tariq", "Hafiz Bilal" with that of "Bilal Ahmed", "Syeda Fatima"
-- with that of "Fatima Noor", or "Usman Tariq" with the Mr# of a file named "Muhammad Usman" (abuse-privacy L2-residual, 11 Oct 2026).
-- "Usman" alone still fits "Usman Tariq", and "M Usman" and "Usman Tariq" still fit "Muhammad Usman Tariq".
-- The patient file's own name typed letter for letter (as compared: lower case, letters and digits) fits, also with more than four words
-- ("Ali Hassan Raza Khan Niazi" typed exactly as the website has it): it is no wider than the patient's own name.
create or replace function private.aaj_name_fits(a text, b text) returns boolean
language plpgsql immutable set search_path = ''
as $$
declare wa text[] := private.aaj_name_words(a); wb text[] := private.aaj_name_words(b); ka text[]; kb text[]; ra text[]; rb text[];
begin
  if cardinality(wa) > 0 and private.aaj_norm_name(a) = private.aaj_norm_name(b) then return true; end if;
  if cardinality(wa) = 0 or cardinality(wb) = 0 or cardinality(wa) > 4 then return false; end if;
  ka := array(select private.aaj_name_spelling(w) from unnest(wa) with ordinality x(w, o) order by o);
  kb := array(select private.aaj_name_spelling(w) from unnest(wb) with ordinality x(w, o) order by o);
  if ka[1] = '' or ka[1] <> kb[1] then return false; end if;
  if not (ka <@ kb or kb <@ ka) then return false; end if;
  ra := array(select private.aaj_name_spelling(case when w in ('m', 'md', 'mohd', 'mohammad', 'muhammed', 'mohammed') then 'muhammad' when w = 'sayed' then 'syed' else w end)
                from unnest(string_to_array(private.aaj_norm_name(a), ' ')) w where w <> '' and not (w = any (array['mr', 'mrs', 'ms', 'miss', 'dr'])));
  rb := array(select private.aaj_name_spelling(case when w in ('m', 'md', 'mohd', 'mohammad', 'muhammed', 'mohammed') then 'muhammad' when w = 'sayed' then 'syed' else w end)
                from unnest(string_to_array(private.aaj_norm_name(b), ' ')) w where w <> '' and not (w = any (array['mr', 'mrs', 'ms', 'miss', 'dr'])));
  return cardinality(ra) < 2 or cardinality(rb) < 2 or ra <@ rb or rb <@ ra;
end $$;

create or replace function private.aaj_top5(j jsonb) returns jsonb
language sql immutable set search_path = ''
as $$ select coalesce(jsonb_agg(e order by o), '[]'::jsonb) from jsonb_array_elements(coalesce(j, '[]'::jsonb)) with ordinality t(e, o) where o <= 5 $$;

create or replace function private.aaj_status_label(s public.visit_status) returns text
language sql immutable set search_path = ''
as $$ select case s when 'waiting' then 'Waiting' when 'in_treatment' then 'Treatment' when 'completed' then 'Completed'
                    when 'scheduled' then 'Scheduled' when 'cancelled' then 'Cancelled' when 'no_show' then 'No show' end $$;

-- checkups know five day statuses (no "scheduled"): the sheet's words map one to one, Scheduled becomes Waiting
create or replace function private.aaj_checkup_label(s text) returns text
language sql immutable set search_path = ''
as $$ select case s when 'waiting' then 'Waiting' when 'in_treatment' then 'Treatment' when 'completed' then 'Completed'
                    when 'cancelled' then 'Cancelled' when 'no_show' then 'No show' else '' end $$;

-- Does a Treatment text say "checkup"? (owner, 9 Oct 2026: "Checkup", "checkup / pain", "xray checkup"; "Check up", "check-up", "Checkups" and
-- typos such as "chek up" or "checup" count too.) The word must be checkup: "Wire check", "Braces check", "RCT check", "Check wire" and
-- "Cheek filler" are treatments of existing patients, not checkups. A row that is not read as a checkup is flagged for a person, while a wrong
-- "yes" would file an existing patient as a checkup. The script has the same pattern (aajIsCheckupText in apps-script/AajSync.js).
create or replace function private.aaj_is_checkup_text(t text) returns boolean
language sql immutable set search_path = ''
as $$ select coalesce(t, '') ~* '\mch[ea]{1,2}c?k?[- ]?ups?\M' $$;

-- Only today (Asia/Karachi), or yesterday until 03:00 (the last flush before the nightly archive).
create or replace function private.aaj_date_ok(p_date date, p_now timestamptz default now()) returns boolean
language sql stable set search_path = ''
as $$
  select p_date = (p_now at time zone 'Asia/Karachi')::date
      or (p_date = (p_now at time zone 'Asia/Karachi')::date - 1 and (p_now at time zone 'Asia/Karachi')::time < time '03:00')
$$;

-- who wins one field: 'same' | 'apply' (the sheet's text) | 'keep' (the website's value)
create or replace function private.aaj_decide(p_web text, p_base text, p_sheet text, p_has_base boolean, p_sheet_newer boolean) returns text
language sql immutable set search_path = ''
as $$
  select case
    when p_web = p_sheet then 'same'
    when p_has_base and p_web = coalesce(p_base, '') then 'apply'      -- the website did not change it since the sheet last saw it
    when not p_has_base and p_web = '' then 'apply'                    -- nothing on the website yet
    when p_sheet_newer then 'apply'                                    -- both changed: the later edit wins
    else 'keep' end
$$;

-- The status of a new row that meets a visit or checkup the website already has (adoption): 'same' | 'apply' | 'keep'. Statuses as the
-- database writes them. Only a row typed after the website's last change (p_newer) changes anything; the status then only moves forward
-- (scheduled, waiting, in_treatment, completed: a stale install-day "Waiting" never sets a Completed visit back), a Cancelled / No show one
-- is brought back (the patient came after all and was typed again), and a Waiting / Scheduled one may be set Cancelled / No show.
-- A status the sheet's word did not give (null) is 'apply': the row is told the word was not understood, nothing changes.
-- p_newer null: the row has no edit time (a row Set up stamped on install day that nobody has edited since, sent with edited_at null). It is
-- not newer than what front desk did on the website that morning, so a Cancelled / No show stays and nothing is set Cancelled, but the status
-- still moves forward: a sheet "Completed" completes the website's "Waiting" visit (owner decision 1, 9 Oct 2026). Before, such a row's
-- Completed was refused and the website's "Waiting" was written over it in the sheet (sheet-behaviour SB7-2, 11 Oct 2026).
create or replace function private.aaj_adopt_status(p_web text, p_sheet text, p_newer boolean) returns text
language sql immutable set search_path = ''
as $$
  select case
    when p_web is not distinct from p_sheet then 'same'
    when p_newer is not distinct from false then 'keep'
    when p_newer and p_sheet is null then 'apply'
    when p_newer and p_web in ('cancelled', 'no_show') then 'apply'
    when p_newer and p_sheet in ('cancelled', 'no_show') then case when p_web is null or p_web in ('scheduled', 'waiting') then 'apply' else 'keep' end
    when p_sheet is null or p_sheet in ('cancelled', 'no_show') or p_web in ('cancelled', 'no_show') then 'keep'
    when coalesce(array_position(array['scheduled', 'waiting', 'in_treatment', 'completed'], p_sheet), 0)
         > coalesce(array_position(array['scheduled', 'waiting', 'in_treatment', 'completed'], p_web), 0) then 'apply'
    else 'keep' end
$$;

create or replace function private.aaj_result(p_key text, p_outcome text, p_level text, p_message text, p_visit uuid default null,
                                              p_kept text[] default '{}', p_dup text default null, p_patient_created text default null) returns jsonb
language sql immutable set search_path = ''
as $$
  select jsonb_build_object('key', p_key, 'outcome', p_outcome, 'visit_id', p_visit, 'level', p_level,
                            'message', nullif(left(p_message, 600), ''), 'kept_website', to_jsonb(coalesce(p_kept, '{}'::text[])),
                            'duplicate_of', p_dup, 'patient_created', p_patient_created)
$$;

-- The database's own error text is not sent to the sheet (constraint and trigger names). Rule messages the website writes for staff are.
create or replace function private.aaj_err_text(p_state text, p_msg text) returns text
language sql immutable set search_path = ''
as $$
  select case
    when p_state = 'P0001' and p_msg ~ '^(PHOTO_REQUIRED|CHECK_REQUIRED|DUES_HOLD|GROUP_NOT_ALLOWED|CHECKER_NOT_ALLOWED)' then 'Not saved: ' || left(p_msg, 150)
    when p_state = '23505' then 'Not saved: this clashes with another entry on the website.'
    when p_state in ('23514', '22001', '22003', '22007', '22P02') then 'Not saved: a value is too long or not allowed.'
    when p_state = '23503' then 'Not saved: something this row refers to is missing on the website.'
    when p_state = '42501' then 'Not saved: the website did not allow this change.'
    else 'Not saved: the website could not save this row.' end
$$;

-- Matching phone numbers is done on the number itself, whatever the dashes and +92 in the stored value.
create index if not exists patients_phone_norm_idx on public.patients (private.aaj_norm_phone(phone));
create index if not exists patients_phone_alt_norm_idx on public.patients (private.aaj_norm_phone(phone_alt));

-- port of matchClinician (web/js/lib/legacy.js) over the active clinicians
create or replace function private.aaj_match_clinician(p_raw text) returns uuid
language plpgsql stable set search_path = public, extensions
as $$
declare v_key text := private.aaj_doctor_key(p_raw); v_id uuid; v_n int;
begin
  if v_key = '' then return null; end if;
  select c.id into v_id from public.clinicians c
   where c.active and (private.aaj_doctor_key(c.display_name) = v_key
         or exists (select 1 from unnest(c.aliases) a where private.aaj_doctor_key(a) = v_key))
   order by c.display_name limit 1;
  if v_id is not null then return v_id; end if;
  if position(' ' in v_key) = 0 then      -- one word ("Dr Zunash"): only when exactly one clinician starts with it
    select count(*), min(c.id::text)::uuid into v_n, v_id from public.clinicians c
     where c.active and split_part(private.aaj_doctor_key(c.display_name), ' ', 1) = v_key;
    if v_n = 1 then return v_id; end if;
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------
-- 3. Who is the patient
-- ---------------------------------------------------------------------
-- 3a. By phone and name only: used by the history import (Admin -> Import), never by the sync.
--     outcome: phone_name | phone_first | ambiguous | phone_others | phone_new | name_only
drop function if exists private.aaj_find_patient(text, text, text);
create or replace function private.aaj_find_patient(p_name text, p_phone text) returns jsonb
language plpgsql stable set search_path = public, extensions
as $$
declare
  v_nn text := private.aaj_norm_name(p_name);
  v_given text := private.aaj_given_name(p_name);
  v_ph text := private.aaj_norm_phone(p_phone);
  v_pm text := null; v_pm_pid uuid := null; v_pm_cands jsonb := '[]'; v_pm_count int := 0;
  n_ex int; n_fi int; n_all int; id_ex uuid; id_fi uuid; c_ex jsonb; c_fi jsonb; c_all jsonb;
begin
  if v_ph is not null then
    with c as (
      select p.id, p.mr_number, p.full_name, p.created_at,
             (v_nn <> '' and private.aaj_norm_name(p.full_name) = v_nn) as ex,
             (v_given <> '' and private.aaj_given_name(p.full_name) = v_given) as fi
        from public.patients p
       where private.aaj_norm_phone(p.phone) = v_ph or private.aaj_norm_phone(p.phone_alt) = v_ph)
    select count(*) filter (where ex), count(*) filter (where fi), count(*),
           (array_agg(id order by created_at, id) filter (where ex))[1], (array_agg(id order by created_at, id) filter (where fi))[1],
           coalesce(jsonb_agg(jsonb_build_object('mr', mr_number, 'name', full_name) order by created_at, id) filter (where ex), '[]'),
           coalesce(jsonb_agg(jsonb_build_object('mr', mr_number, 'name', full_name) order by created_at, id) filter (where fi), '[]'),
           coalesce(jsonb_agg(jsonb_build_object('mr', mr_number, 'name', full_name) order by created_at, id), '[]')
      into n_ex, n_fi, n_all, id_ex, id_fi, c_ex, c_fi, c_all from c;
    if n_ex = 1 then v_pm := 'phone_name'; v_pm_pid := id_ex; v_pm_cands := private.aaj_top5(c_ex); v_pm_count := 1;
    elsif n_ex >= 2 then v_pm := 'ambiguous'; v_pm_cands := private.aaj_top5(c_ex); v_pm_count := n_ex;
    elsif n_fi = 1 then v_pm := 'phone_first'; v_pm_pid := id_fi; v_pm_cands := private.aaj_top5(c_fi); v_pm_count := 1;
    elsif n_fi >= 2 then v_pm := 'ambiguous'; v_pm_cands := private.aaj_top5(c_fi); v_pm_count := n_fi;
    elsif n_all > 0 then v_pm := 'phone_others'; v_pm_cands := private.aaj_top5(c_all); v_pm_count := n_all;
    else v_pm := 'phone_new';
    end if;
    return jsonb_build_object('outcome', v_pm, 'patient_id', v_pm_pid, 'count', v_pm_count,
                              'name_differs', v_pm = 'phone_first', 'candidates', v_pm_cands);
  end if;

  return jsonb_build_object('outcome', 'name_only', 'patient_id', null, 'name_differs', false,
    'count', (select count(*) from public.patients where lower(full_name) = lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'))),
    'candidates', private.aaj_top5((select jsonb_agg(jsonb_build_object('mr', p.mr_number, 'name', p.full_name) order by p.created_at, p.id)
                                      from public.patients p where lower(p.full_name) = lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g')))));
end $$;

-- 3b. Was this patient already on this branch's lists lately? Then the sheet may be told who they are (it shows them anyway).
create or replace function private.aaj_seen_here(p_patient uuid, p_branch smallint, p_date date) returns boolean
language sql stable set search_path = public, extensions
as $$
  select exists (select 1 from public.visits v where v.patient_id = p_patient and v.branch_id = p_branch and v.visit_date between p_date - 180 and p_date)
      or exists (select 1 from public.patients p where p.id = p_patient and p.first_branch_id = p_branch)
$$;

-- 3c. A row with an Mr#. The sync never searches: it checks the number it was given.
--     outcome: mr (the patient: the name fits without doubt) | mr_name (the name does not fit, or fits only with doubt)
--              | mr_noname (the typed name cannot be read: nothing to check it by)
--              | mr_other (name and phone are filed under another Mr#)
--              | mr_moved (a retired Mr# of this very patient, see below: 'mr' is their Mr# now, 'how' renumbered | merged)
--              | mr_bad (not a number the website can take) | mr_typo (50000 and above: the website's own range)
--              | mr_ahead (below 50000, but above private.aaj_hw_limit(): not given by Healthwire yet, a typo)
--              | mr_new (a Healthwire number)
--     A retired Mr# is a number no patient holds any more because the website moved that patient to another one: the 11 website numbers
--     10000-10012 that 20261009000400 renumbered to 50000-50012 (the patient's notes say "Mr# was 10003 until ..."), and a number merged away
--     by merge_patients (the kept patient's notes say "Merged with Mr# 9500 (Name) on ..."). Healthwire is at 98xx and will give 10000-10012 to
--     NEW, different people within weeks (orchestrator decision, 10 Oct 2026): so a retired number is that patient only when the row's whole
--     name fits them without another surname (aaj_name_close and not aaj_names_conflict: "Ali Raza" is not "Ali Khanzada", "Hasan Raza" is not
--     "Hassan Ali"), or the row's phone is theirs and so is its first name (or the name cannot be read and nobody else is on that phone: the
--     same family rule as above). Then the row is refused and told the patient's Mr# now (never a second patient file under the old number).
--     Any other name is a Healthwire number like any other (mr_new): the refusal tells staff to file the row on the other patient, so a
--     loose fit would put a new Healthwire patient on an existing patient's file.
--     p_ignore: a patient the sync itself made today from a row that has left the sheet (aaj_sync_row: a Healthwire Mr# typed with a slip that
--     staff have just corrected). That file goes with its row's visit (aaj_removals), so it is no proof of who the row is (mr_other).
-- The highest Healthwire number (1 to 49999, digits only: "9801-1" and "0985" are not counted) the website has from Healthwire itself, from
-- front desk or from the SQL editor. Patient files the sync made from a typed row ('aaj_sheet_sync') or the history import made from the
-- Aaj ki List ('aaj_ki_list') do not count: they are typed text, no proof that Healthwire gave the number, and counting them would let each
-- new file raise the limit by another 100. 0 when there is none. A new Healthwire Mr# is taken only up to aaj_hw_limit() (M-HW-SQUAT).
create or replace function private.aaj_hw_top() returns int
language sql stable set search_path = public, extensions
as $$
  select coalesce(max(case when p.mr_number ~ '^[1-9][0-9]{0,4}$' then p.mr_number::int end), 0)
    from public.patients p
   where (case when p.mr_number ~ '^[1-9][0-9]{0,4}$' then p.mr_number::int end) <= 49999
     and p.legacy_source is distinct from 'aaj_sheet_sync' and p.legacy_source is distinct from 'aaj_ki_list'
$$;

-- The highest new Healthwire Mr# the sync (and the history import) takes: aaj_hw_top() plus 100, plus 10 for every day since that patient
-- was registered (the Healthwire import keeps Healthwire's own registration date as created_at; a file made in the SQL editor counts from the
-- day it was made), at most 180 days. Healthwire numbers about 5 new patients a day (9846 to 9869 between 6 and 11 Oct 2026), so the limit
-- keeps ahead of it between imports; before, it stood still at the highest number plus 100, and two or three weeks after each import every
-- new patient typed in the sheet was refused as a typo until Dr. Ali imported again (sheet-behaviour RW8-3, 11 Oct 2026). A slip far above
-- Healthwire's numbers (9988 for 9898 right after an import) is still refused. A file made under a number Healthwire later gives to somebody
-- else is not merged blindly by the Healthwire transfer (hw-transfer-design, Addendum 3: a sheet-made file whose name does not fit is a conflict).
create or replace function private.aaj_hw_limit() returns int
language sql stable set search_path = public, extensions
as $$
  select t.top + 100 + 10 * least(180, greatest(0, (now() at time zone 'Asia/Karachi')::date
           - coalesce((select min((p.created_at at time zone 'Asia/Karachi')::date) from public.patients p where p.mr_number = t.top::text),
                      (now() at time zone 'Asia/Karachi')::date)))
    from (select private.aaj_hw_top() as top) t
$$;

drop function if exists private.aaj_check_mr(smallint, date, text, text, text);
create or replace function private.aaj_check_mr(p_branch smallint, p_date date, p_mr text, p_name text, p_phone text, p_ignore uuid default null) returns jsonb
language plpgsql stable set search_path = public, extensions
as $$
declare
  v_nn text := private.aaj_norm_name(p_name);
  v_given text := private.aaj_given_name(p_name);
  v_ph text := private.aaj_norm_phone(p_phone);
  v_p public.patients; v_o public.patients; v_own boolean;
  v_was text; v_merged text;
begin
  select * into v_p from public.patients where mr_number = p_mr;
  if found then
    -- the typed phone is the patient's own phone (nobody else on that phone has the typed first name; with a name nobody can read, nobody
    -- else is on that phone at all). It no longer makes another name fit (11 Oct 2026): it only lets an unreadable name that is the patient
    -- file's own, letter for letter, through.
    v_own := v_ph is not null
             and (private.aaj_norm_phone(v_p.phone) = v_ph or private.aaj_norm_phone(v_p.phone_alt) = v_ph)
             and not exists (select 1 from public.patients o
                              where o.id <> v_p.id and (v_given = '' or private.aaj_given_name(o.full_name) = v_given)
                                and (private.aaj_norm_phone(o.phone) = v_ph or private.aaj_norm_phone(o.phone_alt) = v_ph));
    -- The name must fit WITHOUT DOUBT (aaj_name_fits). A name nobody can read fits only when it is the patient file's name letter for letter
    -- and the typed phone is the patient's own (an Urdu name kept in Urdu).
    if private.aaj_name_fits(p_name, v_p.full_name)
       or (v_given = '' and v_own and lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(v_p.full_name), '\s+', ' ', 'g'))) then
      return jsonb_build_object('outcome', 'mr', 'patient_id', v_p.id, 'mr', v_p.mr_number, 'name', v_p.full_name);
    end if;
    -- A name that fits only with doubt (aaj_name_close: the same first name with another surname, "Ayesha Rajpoot" / "Ayesha Khan"; a slip
    -- or another spelling of the first name that is another name, "Umair" / "Umar"; a caste word in front; or only the patient's own phone
    -- with another name) is refused exactly like a name that does not fit: the same outcome, so the same answer, audit and count. (A different
    -- answer would tell a first name or a phone behind an Mr#.) "doubt" is for Admin -> Import's reason only; the sync never sends it.
    return jsonb_build_object('outcome', case when v_given = '' then 'mr_noname' else 'mr_name' end, 'patient_id', null, 'mr', v_p.mr_number, 'name', v_p.full_name,
                              'seen', private.aaj_seen_here(v_p.id, p_branch, p_date),
                              'doubt', (v_given <> '' and private.aaj_name_close(p_name, v_p.full_name)) or coalesce(v_own, false));
  end if;
  -- the Mr# is not on the website: is this person filed under another number?
  if v_ph is not null and v_nn <> '' then
    select * into v_o from public.patients o
     where (private.aaj_norm_phone(o.phone) = v_ph or private.aaj_norm_phone(o.phone_alt) = v_ph) and private.aaj_norm_name(o.full_name) = v_nn
       and o.id is distinct from p_ignore
     order by o.created_at, o.id limit 1;
    if found then
      return jsonb_build_object('outcome', 'mr_other', 'patient_id', null, 'mr', v_o.mr_number, 'name', v_o.full_name,
                                'seen', private.aaj_seen_here(v_o.id, p_branch, p_date));
    end if;
  end if;
  -- a retired Mr# (renumbered or merged away) whose patient this row fits: refused with the patient's Mr# now. (strpos, not LIKE: the number
  -- is matched as written, with the words around it, so 1000 never matches "Mr# was 10003 until".)
  if p_mr ~ '^[0-9]{1,15}$' then
    v_was := 'Mr# was ' || p_mr || ' until ';
    v_merged := 'Merged with Mr# ' || p_mr || ' (';
    select o.* into v_o from public.patients o
     where (strpos(coalesce(o.notes, ''), v_was) > 0 or strpos(coalesce(o.notes, ''), v_merged) > 0)
       and ((private.aaj_name_close(p_name, o.full_name) and not private.aaj_names_conflict(p_name, o.full_name))
            or (v_ph is not null and (private.aaj_norm_phone(o.phone) = v_ph or private.aaj_norm_phone(o.phone_alt) = v_ph)
                and (v_given = '' or private.aaj_name_close(p_name, o.full_name))
                and not exists (select 1 from public.patients x
                                 where x.id <> o.id and (v_given = '' or private.aaj_given_name(x.full_name) = v_given)
                                   and (private.aaj_norm_phone(x.phone) = v_ph or private.aaj_norm_phone(x.phone_alt) = v_ph))))
     order by o.created_at, o.id limit 1;
    if found then
      return jsonb_build_object('outcome', 'mr_moved', 'patient_id', null, 'mr', v_o.mr_number, 'name', v_o.full_name,
                                'how', case when strpos(coalesce(v_o.notes, ''), v_was) > 0 then 'renumbered' else 'merged' end);
    end if;
  end if;
  if p_mr ~ '^[0-9]{1,15}$' and p_mr::bigint >= 50000 then
    return jsonb_build_object('outcome', 'mr_typo', 'patient_id', null);       -- the website's own numbers start at 50000
  end if;
  if p_mr !~ '^[1-9][0-9]{0,4}$' then
    return jsonb_build_object('outcome', 'mr_bad', 'patient_id', null);
  end if;
  -- above the highest Healthwire number the website has (plus what Healthwire numbered since, aaj_hw_limit): Healthwire has not given it yet.
  -- A file made under it would later take in Healthwire's own patient of that number (the Healthwire import matches by Mr# only) under this
  -- row's name and phone (abuse-privacy M-HW-SQUAT)
  if p_mr::int > private.aaj_hw_limit() then
    return jsonb_build_object('outcome', 'mr_ahead', 'patient_id', null);
  end if;
  return jsonb_build_object('outcome', 'mr_new', 'patient_id', null);           -- a Healthwire number
end $$;

-- A refused lookup (an Mr# the website could not place) is written to the audit log once per key, Mr#, typed name and phone, and outcome a
-- day, and counted: after 200 a day nothing more is answered. Returns false when the day's budget is used up. The same row sent again every
-- few minutes is one lookup. One row key reused with another Mr#, or with another name or phone for the same Mr# (guessing the name behind
-- a number), is a new lookup every time: audited, counted against the 200 and against the five of one call. "who" is an md5 of the typed
-- name and phone (as compared: lower case letters, the phone's digits), so the audit log does not keep the guesses themselves.
-- (aaj_sync_row asks aaj_lookups_used_up before it uses a lookup's answer: once the 200 are used up, a row that fits gets the same answer
-- as one that does not.)
create or replace function private.aaj_lookup_seen(p_key text, p_mr text, p_outcome text, p_name text, p_phone text) returns boolean
language sql stable set search_path = public, extensions
as $$
  select exists (select 1 from public.audit_log
                  where action = 'SHEET_LOOKUP' and at >= ((now() at time zone 'Asia/Karachi')::date)::timestamp at time zone 'Asia/Karachi'
                    and new_data->>'key' = p_key and new_data->>'outcome' = p_outcome and new_data->>'mr' = left(p_mr, 20)
                    and new_data->>'who' = md5(private.aaj_norm_name(p_name) || '|' || coalesce(private.aaj_norm_phone(p_phone), '')))
$$;

create or replace function private.aaj_lookups_used_up() returns boolean
language sql stable set search_path = public, extensions
as $$
  select (select count(*) from public.audit_log
           where action = 'SHEET_LOOKUP' and at >= ((now() at time zone 'Asia/Karachi')::date)::timestamp at time zone 'Asia/Karachi') >= 200
$$;

drop function if exists private.aaj_note_lookup(text, text, text, text);
create or replace function private.aaj_note_lookup(p_tab text, p_key text, p_mr text, p_outcome text, p_name text, p_phone text) returns boolean
language plpgsql volatile set search_path = public, extensions
as $$
declare
  v_who text := md5(private.aaj_norm_name(p_name) || '|' || coalesce(private.aaj_norm_phone(p_phone), ''));
begin
  if private.aaj_lookup_seen(p_key, p_mr, p_outcome, p_name, p_phone) then return true; end if;
  if private.aaj_lookups_used_up() then return false; end if;
  insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
  values ('patients', null, 'SHEET_LOOKUP', null, jsonb_build_object('tab', p_tab, 'key', p_key, 'mr', left(p_mr, 20), 'outcome', p_outcome, 'who', v_who),
          private.aaj_sync_actor());
  -- a new refused lookup counts for this call (aaj_sync_row stops looking after 5). A row refused earlier today and sent again does not, so
  -- rows that wait for a fix never hold back the good rows sent with them.
  perform set_config('aaj.refused', (coalesce(nullif(current_setting('aaj.refused', true), ''), '0')::int + 1)::text, true);
  return true;
end $$;

-- A branch's list gets only so many visits made by the sync in one day (a flood of guessed Mr# rows, a runaway sheet). The cap is a setting.
create or replace function private.aaj_visit_cap_hit(p_branch smallint, p_date date) returns boolean
language sql stable set search_path = public, extensions
as $$
  select (select count(*) from public.visits x where x.branch_id = p_branch and x.visit_date = p_date and x.created_by = private.aaj_sync_actor())
         >= coalesce((select value::int from private.aaj_sync_config where key = 'visits_per_branch_day'), 250)
$$;

-- ---------------------------------------------------------------------
-- 4. The website's list as the sheet sees it ("canon"): every field as one text
-- ---------------------------------------------------------------------
create or replace function private.aaj_canon_row(v public.visits) returns jsonb
language sql stable set search_path = public, extensions
as $$
  select jsonb_build_object(
    'key', coalesce(v.sheet_key, 'W-' || v.id::text),
    'id', v.id,
    'kind', 'visit',
    'mr', p.mr_number,
    'name', p.full_name,
    'phone', coalesce(nullif(p.phone, '0000000'), ''),
    'month', case when v.sheet_cells->'month' is not null and (v.sheet_cells->'month'->>'v') is not distinct from v.braces_month::text
                  then coalesce(v.sheet_cells->'month'->>'t', '')
                  else coalesce(v.braces_month::text || case when v.photo_required then ' Photo' else '' end, '') end,
    'treatment', coalesce(v.treatment_label, (select t.name from public.treatments t where t.id = v.treatment_id), ''),
    -- the sheet's own token text stays when it is not a number or the website did not take it (one token per branch and day here)
    'token', case when coalesce(v.sheet_cells->'token'->>'t', '') <> ''
                       and ((v.sheet_cells->'token'->>'v') is null or coalesce((v.sheet_cells->'token'->>'own')::boolean, false)
                            or (v.sheet_cells->'token'->>'v') is not distinct from v.token_no::text)
                  then v.sheet_cells->'token'->>'t' else coalesce(v.token_no::text, '') end,
    'status', coalesce(private.aaj_status_label(v.status), ''),
    'group', case when v.sheet_cells->'group' is not null and (v.sheet_cells->'group'->>'v') is not distinct from v.doctor_group_id::text
                  then coalesce(v.sheet_cells->'group'->>'t', '')
                  else coalesce('Group ' || v.doctor_group_id::text, '') end,
    -- "pending" = doctors the sheet names that the website's group rule would not take yet (the row is not Completed): they stay in the cell
    'doctors', case when v.sheet_cells->'doctors'->>'t' is not null
                         and array(select distinct x from unnest(coalesce(st.ids, '{}'::text[]) || coalesce(pd.ids, '{}'::text[])) x order by 1)
                             = array(select jsonb_array_elements_text(coalesce(v.sheet_cells->'doctors'->'ids', '[]'::jsonb)) order by 1)
                    then v.sheet_cells->'doctors'->>'t'
                    else coalesce(concat_ws(', ', st.names, pd.names,
                           (select string_agg(u, ', ') from jsonb_array_elements_text(coalesce(v.sheet_cells->'doctors'->'unmatched', '[]'::jsonb)) u)), '') end,
    'details', coalesce(v.details_text, ''),
    'pp', case when dues.d > 0 then to_char(dues.d, 'FM999,999,999') else '' end,
    -- released: its row left the sheet while it was Cancelled / No show (private.aaj_released). The sheet adds it back only once it works again.
    'removed', exists (select 1 from private.aaj_released rl where rl.visit_id = v.id),
    'claimed', v.sheet_key is not null,      -- the sheet has had a row for it: a claimed row missing from the sheet is added back only when the website says so
    'updated_at', v.updated_at)
    from public.patients p
    left join lateral (select array(select distinct vs.clinician_id::text from public.visit_staff vs
                                     where vs.visit_id = v.id and vs.role in ('doctor', 'assistant') order by 1) as ids,
                              (select string_agg(c.display_name, ', ' order by (vs.role = 'doctor') desc, c.display_name)
                                 from public.visit_staff vs join public.clinicians c on c.id = vs.clinician_id
                                where vs.visit_id = v.id and vs.role in ('doctor', 'assistant')) as names) st on true
    left join lateral (select array(select c.id::text from public.clinicians c
                                     where c.id::text in (select jsonb_array_elements_text(coalesce(v.sheet_cells->'doctors'->'pending', '[]'::jsonb)))
                                       and not exists (select 1 from public.visit_staff vs where vs.visit_id = v.id and vs.clinician_id = c.id and vs.role in ('doctor', 'assistant'))
                                     order by 1) as ids,
                              (select string_agg(c.display_name, ', ' order by c.is_doctor desc, c.display_name) from public.clinicians c
                                where c.id::text in (select jsonb_array_elements_text(coalesce(v.sheet_cells->'doctors'->'pending', '[]'::jsonb)))
                                  and not exists (select 1 from public.visit_staff vs where vs.visit_id = v.id and vs.clinician_id = c.id and vs.role in ('doctor', 'assistant'))) as names) pd on true
    left join lateral (select public.patient_dues(p.id) as d) dues on true
   where p.id = v.patient_id
$$;

create or replace function private.aaj_canon(p_visit uuid) returns jsonb
language sql stable set search_path = public, extensions
as $$ select private.aaj_canon_row(v) from public.visits v where v.id = p_visit $$;

-- A checkup patient as a row of the list: no month, group or P.P; the Mr# is filled in once the person is registered as a patient.
create or replace function private.aaj_checkup_canon_row(c public.checkups) returns jsonb
language sql stable set search_path = public, extensions
as $$
  select jsonb_build_object(
    'key', coalesce(c.sheet_key, 'W-' || c.id::text),
    'id', c.id,
    'kind', 'checkup',
    'mr', coalesce(p.mr_number, ''),
    'name', c.patient_name,
    'phone', coalesce(c.phone, ''),
    'month', '',
    'treatment', coalesce(c.checkup_for, ''),
    'token', coalesce(c.token, ''),
    'status', private.aaj_checkup_label(c.day_status),
    'group', '',
    'doctors', coalesce(c.doctors, ''),
    'details', coalesce(c.details, ''),
    'pp', '',
    'removed', exists (select 1 from private.aaj_released rl where rl.checkup_id = c.id),
    'claimed', c.sheet_key is not null,
    'updated_at', c.updated_at)
    from (select 1) one left join public.patients p on p.id = c.patient_id
$$;

create or replace function private.aaj_day_list(p_branch smallint, p_date date) returns jsonb
language sql stable set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(x.j order by x.g, x.tok nulls last, x.created_at, x.id), '[]'::jsonb)
    from (
      select private.aaj_canon_row(v) as j, 0 as g, v.token_no as tok, v.created_at, v.id::text as id
        from public.visits v where v.branch_id = p_branch and v.visit_date = p_date
      union all
      select private.aaj_checkup_canon_row(c), 1, null::int, c.created_at, c.id::text
        from public.checkups c
       where c.branch_id = p_branch and c.checkup_date = p_date and c.source <> 'archive' and not c.date_is_month
    ) x
$$;

-- The first table (other than the doctors' list) that points at this visit: an invoice, photo, x-ray, lab case, inventory move, rating ...
-- Found from the foreign keys, so a table added later is covered too. Null when nothing points at it.
create or replace function private.aaj_visit_attached(p_visit uuid) returns text
language plpgsql stable set search_path = public, extensions
as $$
declare r record; v_hit boolean;
begin
  for r in select c.conrelid::regclass::text as tbl, a.attname::text as col
             from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
            where c.contype = 'f' and c.confrelid = 'public.visits'::regclass and cardinality(c.conkey) = 1
              and c.conrelid <> 'public.visit_staff'::regclass and c.conrelid <> 'private.aaj_visit_text'::regclass
              and c.conrelid <> 'private.aaj_released'::regclass
            order by 1, 2 loop
    execute format('select exists (select 1 from %s where %I = $1)', r.tbl, r.col) into v_hit using p_visit;
    if v_hit then return regexp_replace(r.tbl, '^public\.', ''); end if;
  end loop;
  return null;
end $$;

-- The first table that points at this patient or braces case (p_table), other than the visit p_skip_visit and the braces case p_skip_case
-- that are being removed with it. Found from the foreign keys, like aaj_visit_attached. Null when nothing else points at it.
create or replace function private.aaj_refs(p_table regclass, p_id uuid, p_skip_visit uuid, p_skip_case uuid) returns text
language plpgsql stable set search_path = public, extensions
as $$
declare r record; v_hit boolean;
begin
  for r in select c.conrelid::regclass as tbl, c.conrelid::regclass::text as tname, a.attname::text as col
             from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
            where c.contype = 'f' and c.confrelid = p_table and cardinality(c.conkey) = 1
            order by 2, 3 loop
    if r.tbl = 'public.visits'::regclass then
      execute format('select exists (select 1 from %s where %I = $1 and id is distinct from $2)', r.tname, r.col) into v_hit using p_id, p_skip_visit;
    elsif r.tbl = 'public.braces_cases'::regclass then
      execute format('select exists (select 1 from %s where %I = $1 and id is distinct from $2)', r.tname, r.col) into v_hit using p_id, p_skip_case;
    else
      execute format('select exists (select 1 from %s where %I = $1)', r.tname, r.col) into v_hit using p_id;
    end if;
    if v_hit then return regexp_replace(r.tname, '^public\.', ''); end if;
  end loop;
  return null;
end $$;

-- The text of the override that a Completed row of the sheet leaves on the visit (owner rule, 9 Oct 2026).
create or replace function private.aaj_override_reason() returns text
language sql immutable set search_path = ''
as $$ select 'Completed in the Google Sheet (owner rule, 9 Oct 2026)'::text $$;

-- The website let a row go from its visit or checkup ("rekey": an Mr# typed into a checkup row for a patient it has, a Month typed into an
-- unregistered checkup row, the Mr# corrected on a row whose patient file the sync made from it today). The script sends the row again as a
-- new row, so the old record must go like a deleted row WHATEVER its status: written down here, read by aaj_removals. Before, a record in
-- Treatment or Completed stayed, its row came back, and a checkup went onto the nightly checkup list as a lead (sheet-behaviour RV9-2).
create or replace function private.aaj_note_let_go(p_table text, p_id uuid, p_key text, p_tab text, p_why text) returns void
language sql volatile set search_path = public, extensions
as $$
  insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
  values (p_table, p_id::text, 'SHEET_LETGO', null, jsonb_build_object('tab', p_tab, 'key', p_key, 'why', p_why), private.aaj_sync_actor())
$$;

-- Did the website let this record's row go today (aaj_note_let_go), with the record unchanged since? A change made on the website after it
-- (front desk, the Checkups page) leaves the record to the ordinary rules of a deleted row.
create or replace function private.aaj_let_go_seen(p_table text, p_id uuid, p_key text, p_updated timestamptz) returns boolean
language sql stable set search_path = public, extensions
as $$
  select exists (select 1 from public.audit_log a
                  where a.table_name = p_table and a.row_id = p_id::text and a.action = 'SHEET_LETGO' and a.new_data->>'key' = p_key
                    and p_updated <= a.at and a.at >= ((now() at time zone 'Asia/Karachi')::date)::timestamp at time zone 'Asia/Karachi')
$$;

-- ---------------------------------------------------------------------
-- 5. Undo of a removal: the whole row is in the audit log (SHEET_REMOVED)
-- ---------------------------------------------------------------------
create or replace function private.aaj_restore_removed(p_audit bigint, p_keep_key boolean) returns boolean
language plpgsql volatile set search_path = public, extensions
as $$
declare a public.audit_log; j jsonb; r record; v_tok int; v_key text; v_ok boolean;
begin
  select * into a from public.audit_log where id = p_audit and action = 'SHEET_REMOVED' and new_data->>'action' = 'deleted';
  if not found then return false; end if;
  -- put back already. (A Ctrl+Z that could not be done at the time, "skipped", or that failed with an error, "failed", does not stop Dr. Ali's
  -- undo: nothing was put back then, and the cause may be fixed since. The sync itself never tries either again: aaj_sync skips every removal
  -- that has a SHEET_RESTORED row.)
  if exists (select 1 from public.audit_log where action = 'SHEET_RESTORED' and new_data->>'audit' = p_audit::text
                and not coalesce((new_data->>'skipped')::boolean, false) and not coalesce((new_data->>'failed')::boolean, false)) then return false; end if;
  j := a.old_data;
  if j is null or jsonb_typeof(j) <> 'object' then return false; end if;
  v_key := j->>'sheet_key';
  -- the sheet's own key is kept only when the sheet puts the row back; a restore from the website comes back as a website row
  if not p_keep_key or v_key is null
     or exists (select 1 from public.visits where sheet_key = v_key) or exists (select 1 from public.checkups where sheet_key = v_key) then
    j := j || jsonb_build_object('sheet_key', null::text);
    if a.table_name = 'visits' then j := j || jsonb_build_object('sheet_cells', null::jsonb); end if;
  end if;
  j := j || jsonb_build_object('updated_at', now());
  if a.table_name = 'visits' then
    if exists (select 1 from public.visits where id = (j->>'id')::uuid) then return false; end if;
    if exists (select 1 from public.visits where patient_id = (j->>'patient_id')::uuid and branch_id = (j->>'branch_id')::smallint
                  and visit_date = (j->>'visit_date')::date and status <> 'cancelled') then
      return false;                                      -- that patient has another visit on the list now (checked first: nothing is put back half)
    end if;
    -- the patient file and the braces case the sync had made from this row and removed with it come back first (an Mr# taken since by
    -- another patient keeps the file out, and then nothing is put back)
    if jsonb_typeof(a.new_data->'patient') = 'object' and not exists (select 1 from public.patients where id = (a.new_data->'patient'->>'id')::uuid) then
      insert into public.patients select (jsonb_populate_record(null::public.patients, a.new_data->'patient')).* on conflict do nothing;
    end if;
    if not exists (select 1 from public.patients where id = (j->>'patient_id')::uuid) then return false; end if;
    if jsonb_typeof(a.new_data->'case') = 'object' and exists (select 1 from public.patients where id = (a.new_data->'case'->>'patient_id')::uuid)
       and not exists (select 1 from public.braces_cases where id = (a.new_data->'case'->>'id')::uuid) then
      insert into public.braces_cases select (jsonb_populate_record(null::public.braces_cases, a.new_data->'case')).* on conflict do nothing;
    end if;
    v_tok := (j->>'token_no')::int;
    if v_tok is not null and exists (select 1 from public.visits where branch_id = (j->>'branch_id')::smallint and visit_date = (j->>'visit_date')::date and token_no = v_tok) then
      j := j || jsonb_build_object('token_no', null::int);
    end if;
    insert into public.visits select (jsonb_populate_record(null::public.visits, j)).*;
    for r in select x->>'clinician_id' as cid, x->>'role' as role from jsonb_array_elements(coalesce(a.new_data->'staff', '[]'::jsonb)) x loop
      begin
        insert into public.visit_staff (visit_id, clinician_id, role) values ((j->>'id')::uuid, r.cid::uuid, r.role::public.visit_staff_role);
      exception when others then null;                   -- a rule or a clinician that is gone: the visit itself is back
      end;
    end loop;
    if jsonb_typeof(a.new_data->'text') = 'object' then
      insert into private.aaj_visit_text (visit_id, pp, healthwire, reminder)
      values ((j->>'id')::uuid, a.new_data->'text'->>'pp', a.new_data->'text'->>'healthwire', a.new_data->'text'->>'reminder') on conflict (visit_id) do nothing;
    end if;
  elsif a.table_name = 'checkups' then
    if exists (select 1 from public.checkups where id = (j->>'id')::uuid) then return false; end if;
    insert into public.checkups select (jsonb_populate_record(null::public.checkups, j)).*;
  else
    return false;
  end if;
  insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
  values (a.table_name, j->>'id', 'SHEET_RESTORED', null,
          jsonb_build_object('audit', p_audit, 'key', a.new_data->>'key', 'by', case when p_keep_key then 'the sheet' else 'a person' end),
          case when p_keep_key then private.aaj_sync_actor() else coalesce(auth.uid(), private.aaj_sync_actor()) end);
  return true;
end $$;

-- For Dr. Ali: put back a visit or checkup that a deleted sheet row removed.  select public.aaj_undo_removal(<id of the SHEET_REMOVED row in audit_log>);
create or replace function public.aaj_undo_removal(p_audit_id bigint) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions
as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only Dr. Ali can undo a removal made by the Google Sheet sync' using errcode = '42501';
  end if;
  if private.aaj_restore_removed(p_audit_id, false) then return jsonb_build_object('ok', true); end if;
  return jsonb_build_object('ok', false, 'message', 'Nothing was put back: it is not a deleted-row removal, it was put back already, or the patient has another visit on that list now.');
end $$;

-- Undo of a removal that KEPT the visit and marked it Cancelled (something hangs on it: action kept_cancelled). The sync puts such a row back
-- itself, so a Ctrl+Z of the deletion leaves the row twice in the tab (the script sends that key as "doubled"): the visit gets back the status
-- and notes it had (old_data), but only while it is still Cancelled, still on this list under that key and has not been changed since the
-- removal (updated_at not later than the audit row: the removal and its audit row have the same transaction time). Otherwise nothing changes:
-- what front desk did since stands. True when the status was put back (sheet-behaviour RV-3, 11 Oct 2026).
create or replace function private.aaj_restore_kept(p_audit bigint) returns boolean
language plpgsql volatile set search_path = public, extensions
as $$
declare a public.audit_log; v_id uuid;
begin
  select * into a from public.audit_log where id = p_audit and action = 'SHEET_REMOVED' and table_name = 'visits' and new_data->>'action' = 'kept_cancelled';
  if not found or jsonb_typeof(a.old_data) is distinct from 'object' or coalesce(a.old_data->>'status', '') not in ('scheduled', 'waiting') then return false; end if;
  if exists (select 1 from public.audit_log where action = 'SHEET_RESTORED' and new_data->>'audit' = p_audit::text) then return false; end if;
  update public.visits x set status = (a.old_data->>'status')::public.visit_status, notes = a.old_data->>'notes'
   where x.id = (a.old_data->>'id')::uuid and x.status = 'cancelled' and x.updated_at <= a.at and x.sheet_key = a.new_data->>'key'
     and x.branch_id = (a.old_data->>'branch_id')::smallint and x.visit_date = (a.old_data->>'visit_date')::date
  returning x.id into v_id;
  if v_id is null then return false; end if;
  delete from private.aaj_released where visit_id = v_id;
  insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
  values ('visits', v_id::text, 'SHEET_RESTORED', null,
          jsonb_build_object('audit', p_audit, 'key', a.new_data->>'key', 'by', 'the sheet', 'kind', 'kept_cancelled', 'status', a.old_data->>'status'),
          private.aaj_sync_actor());
  return true;
end $$;

-- ---------------------------------------------------------------------
-- 6. Rows that left the sheet (only the last call of a tick for today)
--    A row deleted in the sheet is a wrong entry or a patient who did not come: the visit / checkup is removed from the
--    website too, unless something real hangs on it. Many rows at once is a mistake in the sheet, not a clinic decision.
-- ---------------------------------------------------------------------
create or replace function private.aaj_removals(p_branch smallint, p_date date, p_tab text, p_present text[]) returns jsonb
language plpgsql volatile set search_path = public, extensions
as $$
declare
  v public.visits; c public.checkups; bc public.braces_cases; pp public.patients;
  v_out jsonb := '[]'::jsonb; v_pres text[] := coalesce(p_present, '{}');
  v_n int; v_total int; v_done int; v_cap int; v_hold boolean; v_code text; v_why text;
  v_day timestamptz := ((now() at time zone 'Asia/Karachi')::date)::timestamp at time zone 'Asia/Karachi';
  v_attached text; v_staff jsonb; v_text jsonb; v_msg text; v_casej jsonb; v_patj jsonb; v_patkept text; v_letgo boolean;
begin
  select code into v_code from public.branches where id = p_branch;
  -- a Cancelled record, and one released already (its row left the sheet while it was Cancelled / No show), is never a removal
  select count(*) into v_n from (
    select 1 from public.visits x where x.branch_id = p_branch and x.visit_date = p_date and x.sheet_key is not null and not (x.sheet_key = any (v_pres)) and x.status <> 'cancelled'
       and not exists (select 1 from private.aaj_released rl where rl.visit_id = x.id)
    union all
    select 1 from public.checkups x where x.branch_id = p_branch and x.checkup_date = p_date and x.source <> 'archive' and not x.date_is_month
       and x.sheet_key is not null and not (x.sheet_key = any (v_pres)) and coalesce(x.day_status, '') <> 'cancelled'
       and not exists (select 1 from private.aaj_released rl where rl.checkup_id = x.id)) y;
  if v_n = 0 then return v_out; end if;
  select count(*) into v_total from (
    select 1 from public.visits x where x.branch_id = p_branch and x.visit_date = p_date and x.sheet_key is not null and x.status <> 'cancelled'
       and not exists (select 1 from private.aaj_released rl where rl.visit_id = x.id)
    union all
    select 1 from public.checkups x where x.branch_id = p_branch and x.checkup_date = p_date and x.source <> 'archive' and not x.date_is_month
       and x.sheet_key is not null and coalesce(x.day_status, '') <> 'cancelled'
       and not exists (select 1 from private.aaj_released rl where rl.checkup_id = x.id)) y;
  select count(*) into v_done from public.audit_log
   where action = 'SHEET_REMOVED' and new_data->>'branch' = v_code and at >= v_day and new_data->>'action' in ('deleted', 'kept_cancelled');
  -- the day's removals: at least 15, and 35 in 100 of the rows the sheet has had today (the ones removed today included), so a busy day of 120
  -- patients may lose 42 wrong entries and no-shows (owner, 11 Oct 2026: "sometimes on a busy day, we have like 120 patients"; RS12-1)
  v_cap := greatest(15, ceil(0.35 * (v_total + v_done))::int);
  v_hold := v_n > 3 or (v_n >= 2 and (cardinality(v_pres) = 0 or v_n * 4 >= v_total)) or v_done + v_n > v_cap;
  if v_hold then
    v_why := case when v_done + v_n > v_cap and v_n <= 3 then 'Needs attention: too many rows were deleted from this tab today, so nothing was removed from the website. Delete wrong entries on the website.'
                  else format('Needs attention: %s rows disappeared at once, so nothing was removed from the website. Delete wrong entries on the website, or delete fewer rows at a time.', v_n) end;
  end if;

  for v in select x.* from public.visits x where x.branch_id = p_branch and x.visit_date = p_date and x.sheet_key is not null
              and not (x.sheet_key = any (v_pres)) and x.status <> 'cancelled'
              and not exists (select 1 from private.aaj_released rl where rl.visit_id = x.id) order by x.created_at, x.id loop
    if v_hold then
      v_out := v_out || jsonb_build_object('key', v.sheet_key, 'action', 'restore', 'message', v_why);
      continue;
    end if;
    v_attached := private.aaj_visit_attached(v.id);
    -- the website let this row go from the visit itself (the Mr# corrected on a row whose patient file the sync made from it today,
    -- aaj_sync_row): the row went on as a new row, so the visit goes whatever its status, while nothing real hangs on it (RV9-2)
    v_letgo := private.aaj_let_go_seen('visits', v.id, v.sheet_key, v.updated_at) and v_attached is null and not v.photos_uploaded and v.checked_by is null;
    -- owner, 9 Oct 2026: "deleted patient means wrong entry, or patient didnt come. so deleting the row should delete from the website aaj ki
    -- list too": a No show (the patient did not come) goes like a Waiting or Scheduled visit when nothing hangs on it (sheet-behaviour RS5-B2)
    if v_letgo or (v.status in ('scheduled', 'waiting', 'no_show') and v_attached is null and v.started_at is null and v.completed_at is null
       and not v.photos_uploaded and v.checked_by is null) then
      v_staff := coalesce((select jsonb_agg(jsonb_build_object('clinician_id', s.clinician_id, 'role', s.role)) from public.visit_staff s where s.visit_id = v.id), '[]'::jsonb);
      v_text := (select to_jsonb(t) - 'visit_id' from private.aaj_visit_text t where t.visit_id = v.id);
      -- What the sync made for this row today goes with the visit when nothing else uses it: the braces case its Month started, and the
      -- patient file of a Healthwire Mr# typed in it (a slip such as 9888 for 9878 would otherwise stay as a file nobody points at, holding
      -- a number Healthwire gives to somebody else within days). Both are kept in the same audit row, so the undo puts them back too.
      v_casej := null; v_patj := null; bc := null; v_patkept := null;
      select b.* into bc from public.braces_cases b
       where b.id = v.braces_case_id and b.created_by = private.aaj_sync_actor() and b.created_at >= v_day and b.notes like 'From the Google Sheet: month %';
      if bc.id is not null and private.aaj_refs('public.braces_cases', bc.id, v.id, null) is null then v_casej := to_jsonb(bc); end if;
      select p.* into pp from public.patients p
       where p.id = v.patient_id and p.legacy_source = 'aaj_sheet_sync' and p.created_by = private.aaj_sync_actor() and p.created_at >= v_day
         and p.portal_user_id is null;
      if pp.id is not null and private.aaj_refs('public.patients', pp.id, v.id, case when v_casej is not null then bc.id end) is null then
        -- front desk often fills a new patient's file while the patient waits (medical history, allergies, consent, date of birth, address): a
        -- file changed by anybody since the sync made it is kept, never deleted with the row (sheet-behaviour RSX-1, 11 Oct 2026)
        if pp.updated_at > pp.created_at
           or exists (select 1 from public.audit_log a where a.table_name = 'patients' and a.row_id = pp.id::text and a.action = 'UPDATE') then
          v_patkept := pp.mr_number;
        else
          v_patj := to_jsonb(pp);
        end if;
      end if;
      insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
      values ('visits', v.id::text, 'SHEET_REMOVED', to_jsonb(v),
              jsonb_build_object('tab', p_tab, 'branch', v_code, 'date', p_date, 'key', v.sheet_key, 'action', 'deleted', 'kind', 'visit', 'staff', v_staff, 'text', v_text,
                                 'case', v_casej, 'patient', v_patj, 'let_go', v_letgo),
              private.aaj_sync_actor());
      delete from public.visits where id = v.id;
      if v_casej is not null then delete from public.braces_cases where id = bc.id; end if;
      if v_patj is not null then delete from public.patients where id = pp.id; end if;
      v_out := v_out || jsonb_build_object('key', v.sheet_key, 'action', 'deleted', 'name', coalesce(v_patj->>'full_name', (select p.full_name from public.patients p where p.id = v.patient_id)),
        'message', case when v_letgo then 'The Mr# in this row was corrected and the row was sent again: the visit under the old Mr# is removed from the website.'
                        else 'Row deleted in the sheet: the visit is removed from the website too.' end
                   || case when v_patj is not null then format(' So is the patient file made from this row (Mr# %s).', v_patj->>'mr_number')
                           when v_casej is not null then ' So is the braces case its Month started.' else '' end
                   || case when v_patkept is not null then format(' The patient file made from this row (Mr# %s) is kept: details were saved on it on the website. Check it (if the Mr# was typed wrong, merge it into the right file).', v_patkept) else '' end
                   || case when v_letgo then ' Dr. Ali can undo it.' else ' Put the row back to undo.' end);
    elsif v.status in ('scheduled', 'waiting') then
      -- something real hangs on it (an invoice, a photo ...): keep it, mark it Cancelled, and say why
      v_msg := format('Kept on the website and marked Cancelled: %s.', case when v_attached is not null then 'it has an attached record (' || v_attached || ')' else 'treatment was recorded on it' end);
      insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
      values ('visits', v.id::text, 'SHEET_REMOVED', to_jsonb(v),
              jsonb_build_object('tab', p_tab, 'branch', v_code, 'date', p_date, 'key', v.sheet_key, 'action', 'kept_cancelled', 'kind', 'visit', 'why', v_attached),
              private.aaj_sync_actor());
      update public.visits set status = 'cancelled',
             notes = left(concat_ws(' · ', notes, 'Row deleted in the Google Sheet (' || p_tab || ') ' || to_char(now() at time zone 'Asia/Karachi', 'HH24:MI') || ': kept, marked Cancelled'), 2000)
       where id = v.id;
      v_out := v_out || jsonb_build_object('key', v.sheet_key, 'action', 'kept', 'name', (select p.full_name from public.patients p where p.id = v.patient_id), 'message', v_msg);
    elsif v.status = 'no_show' then
      -- the patient did not come, and something real hangs on the visit: it stays on the website as it is (No show) and its row is not put
      -- back (the owner deleted it). Released: never a removal again, and back in the sheet only if it is set to work again on the website.
      v_msg := format('Row deleted in the sheet: the visit stays on the website as No show (%s). Its row is not put back.',
                      case when v_attached is not null then 'it has an attached record (' || v_attached || ')' else 'treatment was recorded on it' end);
      insert into private.aaj_released (visit_id, sheet_key, status) values (v.id, v.sheet_key, 'no_show') on conflict do nothing;
      insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
      values ('visits', v.id::text, 'SHEET_REMOVED', to_jsonb(v),
              jsonb_build_object('tab', p_tab, 'branch', v_code, 'date', p_date, 'key', v.sheet_key, 'action', 'released', 'kind', 'visit', 'why', v_attached),
              private.aaj_sync_actor());
      v_out := v_out || jsonb_build_object('key', v.sheet_key, 'action', 'released', 'name', (select p.full_name from public.patients p where p.id = v.patient_id), 'message', v_msg);
    else
      v_out := v_out || jsonb_build_object('key', v.sheet_key, 'action', 'restore',
        'message', format('Not removed: this visit is %s on the website. To take a patient off, set Status to Cancelled.', private.aaj_status_label(v.status)));
    end if;
  end loop;

  for c in select x.* from public.checkups x where x.branch_id = p_branch and x.checkup_date = p_date and x.source <> 'archive' and not x.date_is_month
              and x.sheet_key is not null and not (x.sheet_key = any (v_pres)) and coalesce(x.day_status, '') <> 'cancelled'
              and not exists (select 1 from private.aaj_released rl where rl.checkup_id = x.id) order by x.created_at, x.id loop
    -- The website let this row go from the checkup itself (an Mr# of a patient it has, or a Month, typed into the row: aaj_sync_checkup_row):
    -- the person is a patient, not a checkup, and the row went on as a new row. The checkup goes whatever its status, so it is no lead on the
    -- nightly checkup list, when it is nobody's file and has no follow-up notes (sheet-behaviour RV9-2)
    v_letgo := private.aaj_let_go_seen('checkups', c.id, c.sheet_key, c.updated_at);
    if v_hold then
      v_out := v_out || jsonb_build_object('key', c.sheet_key, 'action', 'restore', 'message', v_why);
    -- owner, 9 Oct 2026: a deleted row is a wrong entry or a person who did not come. A checkup in Treatment or Completed is neither: its
    -- doctor, its details and the follow-up lead stay, like a Completed visit (sheet-behaviour RV-2, 11 Oct 2026)
    elsif c.patient_id is null and c.follow_up = 'Not Contacted' and c.notes is null
          and (coalesce(c.day_status, 'waiting') in ('waiting', 'no_show') or v_letgo) then
      insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
      values ('checkups', c.id::text, 'SHEET_REMOVED', to_jsonb(c),
              jsonb_build_object('tab', p_tab, 'branch', v_code, 'date', p_date, 'key', c.sheet_key, 'action', 'deleted', 'kind', 'checkup', 'let_go', v_letgo),
              private.aaj_sync_actor());
      delete from public.checkups where id = c.id;
      v_out := v_out || jsonb_build_object('key', c.sheet_key, 'action', 'deleted', 'name', c.patient_name,
        'message', case when v_letgo then 'An Mr# or a Month was typed in this row, so it was sent again as a visit: the checkup is removed from the website and this person is not on the checkup list. Dr. Ali can undo it.'
                        else 'Row deleted in the sheet: the checkup is removed from the website too. Put the row back to undo.' end);
    elsif c.day_status = 'no_show' then
      -- the person did not come and the checkup is already a patient or has follow-up notes: kept as it is, the row is not put back
      insert into private.aaj_released (checkup_id, sheet_key, status) values (c.id, c.sheet_key, 'no_show') on conflict do nothing;
      insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
      values ('checkups', c.id::text, 'SHEET_REMOVED', to_jsonb(c),
              jsonb_build_object('tab', p_tab, 'branch', v_code, 'date', p_date, 'key', c.sheet_key, 'action', 'released', 'kind', 'checkup'),
              private.aaj_sync_actor());
      v_out := v_out || jsonb_build_object('key', c.sheet_key, 'action', 'released', 'name', c.patient_name,
        'message', 'Row deleted in the sheet: the checkup stays on the website as No show (it is already a patient, or has follow-up notes). Its row is not put back.');
    elsif c.day_status in ('in_treatment', 'completed') then
      v_out := v_out || jsonb_build_object('key', c.sheet_key, 'action', 'restore',
        'message', format('Not removed: this checkup is %s on the website. To take a patient off, set Status to Cancelled.', private.aaj_checkup_label(c.day_status)));
    else
      v_out := v_out || jsonb_build_object('key', c.sheet_key, 'action', 'restore',
        'message', 'Not removed: this checkup is already a patient, or has follow-up notes on the website.');
    end if;
  end loop;
  return v_out;
end $$;

-- ---------------------------------------------------------------------
-- 7. Shape and size of one row (the same for visits and checkups)
-- ---------------------------------------------------------------------
create or replace function private.aaj_row_check(p_row jsonb) returns text
language plpgsql stable set search_path = public, extensions
as $$
declare
  v_key text := p_row->>'key';
  v_set jsonb := case when jsonb_typeof(p_row->'set') = 'object' then p_row->'set' else '{}'::jsonb end;
  v_base jsonb := case when jsonb_typeof(p_row->'base') = 'object' then p_row->'base' end;
  v_lim record; v_f text;
begin
  if v_key is null or v_key !~ '^(S-[0-9a-f]{12}|W-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' then
    return 'Bad row key.';
  end if;
  for v_lim in select * from (values ('mr', 20), ('name', 120), ('legacy_name', 120), ('phone', 40), ('treatment', 120), ('details', 500),
                                     ('pp', 120), ('healthwire', 120), ('reminder', 120)) t(f, m) loop
    if length(coalesce(v_set->>v_lim.f, '')) > v_lim.m then
      return format('Too long: %s (max %s letters).', v_lim.f, v_lim.m);
    end if;
  end loop;
  foreach v_f in array array['month', 'token', 'status', 'group', 'doctors'] loop
    if length(coalesce(v_set->v_f->>'t', '')) > 300 then
      return format('Too long: %s (max 300 letters).', v_f);
    end if;
  end loop;
  -- the numbers the script reads from Month, Token and Group ("v") are whole numbers or nothing. Anything else is refused here, before the
  -- row is looked at: a value that failed its cast later would roll the row back after the Mr# was checked, and the different answer
  -- (a fitting name -> "not allowed", a wrong one -> "belongs to another patient") would be a check of the name behind an Mr# with no trace.
  foreach v_f in array array['month', 'token', 'group'] loop
    if jsonb_typeof(v_set->v_f) = 'object' and nullif(v_set->v_f->>'v', '') is not null and (v_set->v_f->>'v') !~ '^[0-9]{1,9}$' then
      return 'Not saved: a value is too long or not allowed.';
    end if;
  end loop;
  if v_set ? 'doctors' then
    if jsonb_typeof(v_set->'doctors'->'v') is distinct from 'array' then return 'Bad doctors list.'; end if;
    if jsonb_array_length(v_set->'doctors'->'v') > 10 then return 'Too long: doctors (max 10 names).'; end if;
    if exists (select 1 from jsonb_array_elements_text(v_set->'doctors'->'v') d where length(d) > 60) then return 'Too long: a doctor name (max 60 letters).'; end if;
    if v_base is not null and v_base ? 'doctors' and (jsonb_typeof(v_base->'doctors') is distinct from 'array'
       or jsonb_array_length(v_base->'doctors') > 10 or exists (select 1 from jsonb_array_elements_text(v_base->'doctors') d where length(d) > 60)) then
      return 'Bad doctors list.';
    end if;
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------
-- 8. A checkup row (a row with no Mr#): public.checkups, never a patient file
--    p_cid null = a new checkup row of the sheet; otherwise the checkup the key belongs to, or (p_adopt) the checkup a new row of the sheet
--    is (aaj_checkup_twin, or the checkup registered as the patient of the row's Mr#): it is adopted, not made twice (like a visit of the
--    same patient), and keeps the website's state.
-- ---------------------------------------------------------------------
-- The checkup of today at this branch that a new row of the sheet is: its row lost the hidden key (cut and pasted, the helper columns deleted,
-- a sort of the visible columns), or the same person was typed again. The same name and the same phone, compared as numbers (the website's
-- Checkups page keeps a phone as typed: "0300-1117777"); with no phone in the row, the oldest checkup of that full name today that has no
-- phone either. Never a checkup whose row is on the sheet now (its key in p_present), so two walk-ins of one name with no phone whose rows
-- were given new keys by a sort each find their own checkup again, and a third one typed while the other two rows are on the sheet gets her
-- own. Before, two of that name were never adopted at all: every sort made each of them a new checkup, the old ones (Completed, Treatment)
-- came back as rows, and the next sort doubled them again (sheet-behaviour SB10-1, 11 Oct 2026). Null when there is none.
create or replace function private.aaj_checkup_twin(p_branch smallint, p_date date, p_key text, p_name text, p_phone text, p_present text[])
returns uuid
language plpgsql stable set search_path = public, extensions
as $$
declare v_ph text := private.aaj_norm_phone(p_phone); v_nn text := private.aaj_norm_name(p_name); v_id uuid;
begin
  if length(v_nn) < 2 then return null; end if;
  select x.id into v_id from public.checkups x
   where x.branch_id = p_branch and x.checkup_date = p_date and x.source <> 'archive' and not x.date_is_month
     and private.aaj_norm_name(x.patient_name) = v_nn
     and (case when v_ph is null then private.aaj_norm_phone(x.phone) is null else private.aaj_norm_phone(x.phone) = v_ph end)
     and coalesce(x.sheet_key, 'W-' || x.id::text) <> p_key and not (coalesce(x.sheet_key, 'W-' || x.id::text) = any (coalesce(p_present, '{}')))
   order by x.created_at, x.id limit 1;
  return v_id;
end $$;

-- The other side of aaj_checkup_twin: the checkup of today at this branch that a new row with no Mr# repeats while ITS row is on the sheet now
-- (its key is in p_present): the same name and the same phone (as numbers). Its key, or null. Such a row is a copy (a Ctrl+Z after the sync
-- had put back a held deletion leaves every row twice) or the person typed twice: it is refused as a duplicate, like a second visit of one
-- patient, never made into a second checkup that would also go twice onto the nightly checkup list (sheet-behaviour RV-1, 11 Oct 2026). Two
-- rows of one name with no phone are never guessed to be one person (two walk-ins can share a name); a pure copy of such a row (its hidden
-- key too) is caught by the script, which does not send it.
create or replace function private.aaj_checkup_dup(p_branch smallint, p_date date, p_key text, p_name text, p_phone text, p_present text[])
returns text
language sql stable set search_path = public, extensions
as $$
  select coalesce(x.sheet_key, 'W-' || x.id::text) from public.checkups x
   where length(private.aaj_norm_name(p_name)) >= 2 and private.aaj_norm_phone(p_phone) is not null
     and x.branch_id = p_branch and x.checkup_date = p_date and x.source <> 'archive' and not x.date_is_month
     and private.aaj_norm_phone(x.phone) = private.aaj_norm_phone(p_phone) and private.aaj_norm_name(x.patient_name) = private.aaj_norm_name(p_name)
     and coalesce(x.sheet_key, 'W-' || x.id::text) <> p_key and coalesce(x.sheet_key, 'W-' || x.id::text) = any (coalesce(p_present, '{}'))
   order by x.created_at, x.id limit 1
$$;

drop function if exists private.aaj_sync_checkup_row(smallint, text, date, jsonb, uuid);
drop function if exists private.aaj_sync_checkup_row(smallint, text, date, jsonb, uuid, text[]);
create or replace function private.aaj_sync_checkup_row(p_branch smallint, p_tab text, p_date date, p_row jsonb, p_cid uuid, p_adopt boolean default false)
returns jsonb
language plpgsql volatile set search_path = public, extensions
as $$
declare
  v_key text := p_row->>'key';
  v_set jsonb := case when jsonb_typeof(p_row->'set') = 'object' then p_row->'set' else '{}'::jsonb end;
  v_base jsonb := case when jsonb_typeof(p_row->'base') = 'object' then p_row->'base' end;
  v_edit numeric := case when (p_row->>'edited_at') ~ '^[0-9]{1,15}([.][0-9]+)?$' then (p_row->>'edited_at')::numeric end;
  v_now_ms numeric := extract(epoch from now()) * 1000;
  c public.checkups; n public.checkups; cn jsonb;
  v_newer boolean; v_f text; v_cf text; v_dec text; v_w text; v_b text; v_s text;
  v_kept text[] := '{}'; v_lost jsonb := '{}'::jsonb; v_msgs text[] := '{}'; v_level text := 'ok'; v_changed text[] := '{}';
  v_mr text; v_pat public.patients; v_sv text; v_outcome text; v_find jsonb; v_nm text; v_ph text;
  v_target uuid := p_cid; v_adopt boolean := p_cid is not null and coalesce(p_adopt, false);
begin
  v_edit := case when v_edit > v_now_ms + 300000 then v_now_ms else v_edit end;       -- a clock far in the future counts as now

  if v_target is null and length(btrim(coalesce(v_set->>'name', ''))) < 2 then       -- a new checkup
    return private.aaj_result(v_key, 'needs_patient', 'error', 'Patient name is too short.');
  end if;

  if v_target is null then
    if (select count(*) from public.checkups where source = 'google_sheet' and branch_id = p_branch
           and (created_at at time zone 'Asia/Karachi')::date = (now() at time zone 'Asia/Karachi')::date) >= 150 then
      return private.aaj_result(v_key, 'needs_patient', 'error', 'Too many new checkups from the sheet today. Add this one on the website.');
    end if;
    v_sv := coalesce(nullif(v_set->'status'->>'v', ''), 'waiting');
    if v_sv = 'scheduled' then v_sv := 'waiting'; v_msgs := array_append(v_msgs, 'A checkup cannot be Scheduled. Saved as Waiting.'::text); v_level := 'warn'; end if;
    if v_sv not in ('waiting', 'in_treatment', 'completed', 'cancelled', 'no_show') then v_sv := 'waiting'; end if;
    if v_set ? 'status' and nullif(v_set->'status'->>'v', '') is null then
      v_msgs := v_msgs || format('Status "%s" not understood. Use Waiting, Treatment, Completed, Cancelled or No show.', coalesce(v_set->'status'->>'t', '')); v_level := 'warn';
    end if;
    insert into public.checkups (checkup_date, branch_id, patient_name, phone, checkup_for, doctors, details, token, day_status, source, sheet_key)
    values (p_date, p_branch, btrim(v_set->>'name'), private.aaj_norm_phone(v_set->>'phone'),
            left(nullif(btrim(coalesce(v_set->>'treatment', '')), ''), 300), left(nullif(btrim(coalesce(v_set->'doctors'->>'t', '')), ''), 300),
            left(nullif(btrim(coalesce(v_set->>'details', '')), ''), 2000), left(nullif(btrim(coalesce(v_set->'token'->>'t', '')), ''), 40),
            v_sv, 'google_sheet', v_key)
    returning * into n;
    insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
    values ('checkups', n.id::text, 'SHEET_SYNC', null,
            jsonb_build_object('tab', p_tab, 'key', v_key, 'outcome', 'created', 'changed', jsonb_build_array('created')), private.aaj_sync_actor());
    return private.aaj_result(v_key, 'created', v_level, array_to_string(array_append(v_msgs, 'Checkup patient: no Mr#, no patient file.'::text), ' '), n.id,
                              case when coalesce(v_set->'status'->>'v', '') = 'scheduled' then array['status'] else '{}'::text[] end);
  end if;

  -- ---- an existing checkup ----
  select * into c from public.checkups where id = v_target for update;
  if not v_adopt and left(v_key, 2) = 'W-' and c.sheet_key is not null and c.sheet_key <> v_key then
    return private.aaj_result(v_key, 'superseded', 'error', 'This row was replaced by another row for the same visit.', c.id);
  end if;
  -- moved to another branch or day on the website (a W- key: the record is found by its id; an S- key lost its key with the move,
  -- aaj_release_sheet_claim, and is answered "gone"). The script keeps the row as "deleted on the website" (never sent again as a new row,
  -- which would make the checkup twice).
  if c.branch_id is distinct from p_branch or c.checkup_date is distinct from p_date then
    return private.aaj_result(v_key, 'other_list', 'error', 'This checkup was moved to another branch or day on the website. Delete this row.');
  end if;
  -- A Month typed into a checkup row: the person is a braces patient, never a checkup (owner, 9 Oct 2026, 13:20). Nothing is applied (the
  -- checkup keeps its state and is not put on the nightly checkup list as a braces patient's "lead") and the row is let go ("rekey"): the
  -- script sends it again as a new row, which needs the Mr# or makes the patient's visit. An unregistered checkup then goes like a deleted
  -- row whatever its status (aaj_note_let_go, sheet-behaviour RV9-2); a registered one is a patient's checkup and stays (its row comes back).
  if btrim(coalesce(v_set->'month'->>'t', '')) <> '' then
    if c.patient_id is null then
      perform private.aaj_note_let_go('checkups', c.id, v_key, p_tab, 'month');
      return private.aaj_result(v_key, 'rekey', 'warn', 'A row with a Month is a braces patient, never a checkup: this row is sent again as a visit.', c.id);
    end if;
    return private.aaj_result(v_key, 'rekey', 'warn',
      format('A row with a Month is a visit, not a checkup: this row is sent again as the visit of Mr# %s. The checkup stays as it is.',
             (select p.mr_number from public.patients p where p.id = c.patient_id)), c.id);
  end if;
  -- A checkup registered as a patient (its row shows that patient's Mr#) whose name is changed to one that does not fit that patient without
  -- doubt ("Sana Qureshi" typed over the checkup of Sana Khan, on her phone): nothing from the row is saved and every answer says so, like a
  -- linked visit row (11 Oct 2026). Before, the checkup took the other person's name, and the nightly checkup list with it.
  if c.patient_id is not null and v_set ? 'name' and private.aaj_norm_name(v_set->>'name') <> private.aaj_norm_name(c.patient_name) then
    select * into v_pat from public.patients where id = c.patient_id;
    if found and not private.aaj_name_fits(v_set->>'name', v_pat.full_name)
       and lower(regexp_replace(btrim(coalesce(v_set->>'name', '')), '\s+', ' ', 'g')) <> lower(regexp_replace(btrim(v_pat.full_name), '\s+', ' ', 'g')) then
      return private.aaj_result(v_key, 'error', 'error',
        format('Needs attention: the name in this row does not match Mr# %s on the website. Check the Mr# or the name: nothing in this row is saved until they match.', v_pat.mr_number), c.id);
    end if;
  end if;
  -- the person on a checkup row is the checkup's own: an Mr# on it must be the patient it was registered as. The sync never registers or
  -- links a checkup itself (the secret is not a way to tie people to patient files). The script sends an Mr# typed into a checkup row under
  -- the checkup's key while the row's name and phone are still that person (sheet-behaviour RW8-1, 11 Oct 2026):
  --   * not registered yet: a row WITH an Mr# is a patient's visit (owner rule) when the website has that patient and the name fits without
  --     doubt (an existing patient on recall whose Mr# staff looked up in Healthwire, sheet-behaviour RS5-E1). The row is let go ("rekey"):
  --     the script sends it again as a new row, which makes the patient's visit, and the checkup goes like a deleted row, whatever its
  --     status (aaj_note_let_go: a Completed checkup of an existing patient is no lead for the follow-up team, RV9-2). Anything else (a
  --     slip of a finger in the Mr# cell, an Mr# the website does not have) is refused and the checkup stays as it is: a checkup row never
  --     makes a new patient file (owner rule 6) and a slip never removes the checkup. Every such lookup, also one that fits (nothing is made
  --     for it here, so nothing else would leave a trace), is audited and counted like a new row's refused lookup (aaj_note_lookup): the five
  --     of one call, the 200 of a day. The answer is the same for every Mr# that does not fit.
  --   * registered: another Mr# is refused for the checkup; the registered Mr# goes back into the cell (like a visit row) and the rest of the
  --     row is saved.
  if v_set ? 'mr' then
    v_mr := nullif(btrim(v_set->>'mr'), '');
    if v_mr is not null and upper(v_mr) <> 'NEW' then
      if c.patient_id is null then
        v_nm := coalesce(v_set->>'name', c.patient_name); v_ph := coalesce(v_set->>'phone', c.phone);
        if v_mr !~ '^[A-Za-z0-9_-]+$' or v_mr !~ '[0-9]' then
          return private.aaj_result(v_key, 'error', 'error', format('"%s" is not a Mr#. Type the number only, or leave it empty for a checkup patient.', left(v_mr, 30)), c.id);
        end if;
        if coalesce(nullif(current_setting('aaj.refused', true), ''), '0')::int >= 5 then
          return private.aaj_result(v_key, 'error', 'error', 'Too many rows the website could not place at once. This row is tried again in a few minutes.', c.id);
        end if;
        v_find := private.aaj_check_mr(p_branch, p_date, v_mr, v_nm, v_ph);
        if not private.aaj_note_lookup(p_tab, v_key, v_mr, v_find->>'outcome', v_nm, v_ph) then
          return private.aaj_result(v_key, 'error', 'error', 'Too many rows the website could not place today. Add this patient on the website.', c.id);
        end if;
        if v_find->>'outcome' = 'mr' then
          perform private.aaj_note_let_go('checkups', c.id, v_key, p_tab, 'mr');      -- the checkup goes when the key has left the sheet (RV9-2)
          return private.aaj_result(v_key, 'rekey', 'warn', format('Mr# %s typed: this row is sent again as that patient''s visit.', v_mr), c.id);
        end if;
        return private.aaj_result(v_key, 'error', 'error',
          format('Needs attention: Mr# %s is not a patient on the website with this name, so this row stays a checkup. Clear the Mr# if this is a checkup patient (no Mr#), or check the number.', left(v_mr, 20)), c.id);
      end if;
      select * into v_pat from public.patients where id = c.patient_id;
      if v_pat.mr_number is distinct from v_mr then
        v_kept := array_append(v_kept, 'mr'::text); v_level := 'warn';
        v_msgs := array_append(v_msgs, format('Mr# %s is not this checkup''s patient, so Mr# %s is put back. If this row is another patient, delete it and type that patient in a new row.',
                                              left(v_mr, 20), v_pat.mr_number));
      end if;
    end if;
  end if;

  n := c;
  if c.sheet_key is null or v_adopt then n.sheet_key := v_key; end if;
  cn := private.aaj_checkup_canon_row(c);
  -- the later edit wins, also for a checkup a new row adopts (sheet-behaviour RS5-A1: a row typed again for a person whose checkup was
  -- Cancelled is not rewritten to Cancelled). An adopted checkup already in Treatment or Completed keeps the website's text; its status only
  -- moves forward (aaj_adopt_status).
  v_newer := coalesce(v_edit, 0) > extract(epoch from c.updated_at) * 1000
             and not (v_adopt and coalesce(c.day_status, '') in ('in_treatment', 'completed'));
  -- a row typed just now for a person whose checkup is Cancelled / No show, with no Status typed: the person is here, so Waiting again
  if v_adopt and c.day_status in ('cancelled', 'no_show') and not (v_set ? 'status') and coalesce(v_edit, 0) > extract(epoch from c.updated_at) * 1000 then
    v_set := v_set || jsonb_build_object('status', jsonb_build_object('t', 'Waiting', 'v', 'waiting'));
  end if;

  foreach v_f in array array['name', 'phone', 'treatment', 'token', 'status', 'doctors', 'details'] loop
    continue when not (v_set ? v_f);
    v_s := case when v_f in ('token', 'status', 'doctors') then coalesce(v_set->v_f->>'t', '') when v_f = 'phone' then coalesce(private.aaj_norm_phone(v_set->>'phone'), '')
                else btrim(coalesce(v_set->>v_f, '')) end;
    v_w := cn->>v_f;
    v_b := case when v_base is null then null
                when v_f = 'doctors' then array_to_string(array(select jsonb_array_elements_text(coalesce(v_base->'doctors', '[]'::jsonb))), ',')
                else coalesce(v_base->>v_f, '') end;
    if v_f = 'status' then v_w := lower(v_w); v_b := lower(v_b); v_s := lower(v_s);
    elsif v_f = 'doctors' then v_w := private.aaj_people_key(v_w); v_b := private.aaj_people_key(v_b); v_s := private.aaj_people_key(v_s);
    elsif v_f = 'phone' then      -- the number, not how it is written ("0300-1117777" as the Checkups page keeps it is 03001117777)
      v_w := coalesce(private.aaj_norm_phone(v_w), v_w); v_b := coalesce(private.aaj_norm_phone(v_b), v_b); end if;
    v_dec := case when v_f = 'status' and v_adopt and v_w is distinct from v_s
                  then private.aaj_adopt_status(c.day_status, nullif(v_set->'status'->>'v', ''), v_edit > extract(epoch from c.updated_at) * 1000)
                  else private.aaj_decide(v_w, v_b, v_s, v_base is not null, v_newer) end;
    if v_dec = 'keep' then
      v_kept := array_append(v_kept, v_f);
      v_lost := v_lost || jsonb_build_object(v_f, case when v_f in ('token', 'status', 'doctors') then v_set->v_f->>'t' when v_f = 'phone' then v_set->>'phone' else v_set->>v_f end);
    elsif v_dec = 'apply' then
      if v_f = 'name' then
        if length(btrim(coalesce(v_set->>'name', ''))) >= 2 then n.patient_name := btrim(v_set->>'name');
        else v_msgs := array_append(v_msgs, 'Patient name is too short. Name not changed on the website.'::text); v_level := 'warn'; end if;
      elsif v_f = 'phone' then n.phone := private.aaj_norm_phone(v_set->>'phone');
      elsif v_f = 'treatment' then n.checkup_for := left(nullif(btrim(coalesce(v_set->>'treatment', '')), ''), 300);
      elsif v_f = 'token' then n.token := left(nullif(btrim(coalesce(v_set->'token'->>'t', '')), ''), 40);
      elsif v_f = 'doctors' then n.doctors := left(nullif(btrim(coalesce(v_set->'doctors'->>'t', '')), ''), 300);
      elsif v_f = 'details' then n.details := left(nullif(btrim(coalesce(v_set->>'details', '')), ''), 2000);
      elsif v_f = 'status' then
        v_sv := nullif(v_set->'status'->>'v', '');
        if v_sv is null or v_sv not in ('scheduled', 'waiting', 'in_treatment', 'completed', 'cancelled', 'no_show') then
          v_msgs := v_msgs || format('Status "%s" not understood. Use Waiting, Treatment, Completed, Cancelled or No show.', coalesce(v_set->'status'->>'t', '')); v_level := 'warn';
        elsif v_sv = 'scheduled' then
          n.day_status := 'waiting'; v_msgs := array_append(v_msgs, 'A checkup cannot be Scheduled. Saved as Waiting.'::text); v_level := 'warn';
          v_kept := array_append(v_kept, 'status');
        else n.day_status := v_sv;
        end if;
      end if;
    end if;
  end loop;

  if (n.patient_name, n.phone, n.checkup_for, n.token, n.day_status, n.doctors, n.details, n.sheet_key)
     is distinct from (c.patient_name, c.phone, c.checkup_for, c.token, c.day_status, c.doctors, c.details, c.sheet_key) then
    update public.checkups set patient_name = n.patient_name, phone = n.phone, checkup_for = n.checkup_for, token = n.token,
           day_status = n.day_status, doctors = n.doctors, details = n.details, sheet_key = n.sheet_key
     where id = c.id;
    v_changed := array_remove(array[
      case when n.patient_name is distinct from c.patient_name then 'name' end, case when n.phone is distinct from c.phone then 'phone' end,
      case when n.checkup_for is distinct from c.checkup_for then 'treatment' end, case when n.token is distinct from c.token then 'token' end,
      case when n.day_status is distinct from c.day_status then 'status' end, case when n.doctors is distinct from c.doctors then 'doctors' end,
      case when n.details is distinct from c.details then 'details' end, case when n.sheet_key is distinct from c.sheet_key then 'linked' end], null);
  end if;
  v_outcome := case when v_adopt then 'linked' when cardinality(v_changed) > 0 then 'updated' else 'unchanged' end;
  if cardinality(v_changed) > 0 or v_lost <> '{}'::jsonb or v_adopt then
    insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
    values ('checkups', c.id::text, 'SHEET_SYNC', cn,
            jsonb_build_object('tab', p_tab, 'key', v_key, 'outcome', v_outcome, 'changed', to_jsonb(v_changed), 'kept_website', to_jsonb(v_kept), 'sheet_text_not_applied', v_lost),
            private.aaj_sync_actor());
  end if;
  return private.aaj_result(v_key, v_outcome, v_level, array_to_string(v_msgs, ' '), c.id, v_kept);
end $$;

-- ---------------------------------------------------------------------
-- 9. One row of the sheet. Called inside its own BEGIN ... EXCEPTION block by aaj_sync:
--    an exception here undoes this row only.
-- ---------------------------------------------------------------------
create or replace function private.aaj_sync_row(
  p_branch smallint, p_tab text, p_date date, p_row jsonb, p_present text[], p_admin uuid, p_rules text)
returns jsonb
language plpgsql volatile set search_path = public, extensions
as $$
declare
  v_key text := p_row->>'key';
  v_set jsonb := case when jsonb_typeof(p_row->'set') = 'object' then p_row->'set' else '{}'::jsonb end;
  v_base jsonb := case when jsonb_typeof(p_row->'base') = 'object' then p_row->'base' end;
  v_edit numeric := case when (p_row->>'edited_at') ~ '^[0-9]{1,15}([.][0-9]+)?$' then (p_row->>'edited_at')::numeric end;
  v_now_ms numeric := extract(epoch from now()) * 1000;
  v public.visits;            -- the visit as stored
  n public.visits;            -- the visit as it should be
  e public.visits;
  v_found boolean := false;
  v_create boolean := false;
  v_outcome text;
  c jsonb := null;
  v_newer boolean := false;
  v_f text; v_dec text; v_st text; v_err0 text;
  v_decs jsonb := '{}'::jsonb; v_same jsonb := '{}'::jsonb;
  v_kept text[] := '{}'; v_lost jsonb := '{}'::jsonb;
  v_msgs text[] := '{}'; v_level text := 'ok'; v_over text[] := '{}';
  v_changed text[] := '{}';
  v_pid uuid; v_pat public.patients; v_find jsonb; v_oc text; v_mr text; v_onlist boolean := false;
  v_pc text := null; v_dup text := null; v_ek text; v_cid uuid;
  v_mv int; v_mt text; v_case uuid; v_tv int; v_tt text; v_sv text; v_gv int;
  v_other text; v_ign uuid; v_slip_held text;
  v_try int := 0; v_con text; v_err text; v_dirty boolean; v_label text; v_old_token int; v_token_asked boolean := false;
  -- doctors
  v_dwant boolean := false; v_sheet_set text[] := '{}'; v_base_set text[] := '{}'; v_web_set text[]; v_res text[];
  v_ids text[]; v_unm text[] := '{}'; v_dt text; r record;
  v_padd boolean := false; v_pend text[] := '{}';
begin
  v_edit := case when v_edit > v_now_ms + 300000 then v_now_ms else v_edit end;       -- a clock far in the future counts as now

  -- ---- the row's shape ----
  v_err0 := private.aaj_row_check(p_row);
  if v_err0 is not null then return private.aaj_result(v_key, 'error', 'error', v_err0); end if;

  -- ---- which visit is this row ----
  if left(v_key, 2) = 'W-' then
    select * into v from public.visits where id = substr(v_key, 3)::uuid for update;
  else
    select * into v from public.visits where sheet_key = v_key for update;
  end if;
  v_found := found;
  if not v_found then            -- a checkup patient?
    if left(v_key, 2) = 'W-' then select id into v_cid from public.checkups where id = substr(v_key, 3)::uuid;
    else select id into v_cid from public.checkups where sheet_key = v_key; end if;
    if v_cid is not null then return private.aaj_sync_checkup_row(p_branch, p_tab, p_date, p_row, v_cid); end if;
  end if;
  if v_found and left(v_key, 2) = 'W-' and v.sheet_key is not null and v.sheet_key <> v_key then
    return private.aaj_result(v_key, 'superseded', 'error', 'This row was replaced by another row for the same visit.', v.id);
  end if;
  -- moved to another branch or day on the website (see aaj_sync_checkup_row): the row is kept as "deleted on the website" by the script
  if v_found and (v.branch_id <> p_branch or v.visit_date <> p_date) then
    return private.aaj_result(v_key, 'other_list', 'error', 'This visit was moved to another branch or day on the website. Delete this row.');
  end if;
  if not v_found and (left(v_key, 2) = 'W-' or not coalesce((p_row->>'new')::boolean, false)) then
    return private.aaj_result(v_key, 'gone', 'error', 'This visit was deleted on the website. Delete this row.');
  end if;

  v_outcome := case when v_found then 'updated' else 'created' end;

  -- ---- a new row: no Mr# and a Treatment that says checkup is a checkup patient; an Mr# must be a patient the website knows (or a Healthwire number) ----
  if not v_found then
    v_mr := nullif(btrim(v_set->>'mr'), '');
    if v_mr is null or upper(v_mr) = 'NEW' then
      -- a checkup of today whose row lost its hidden key (cut and pasted, the helper columns deleted, a sort of the visible columns), or the
      -- same person typed again: the row is that checkup, whatever its Treatment says (the website's Checkups page writes "Scaling",
      -- "Braces consultation" ...). Otherwise the checkup would be removed as a deleted row, or made twice. Never a row with a Month: a
      -- checkup has none, so the Month was typed because the person turned out to be a braces patient (sheet-behaviour M2, loop 7).
      if btrim(coalesce(v_set->'month'->>'t', '')) = '' then
        v_cid := private.aaj_checkup_twin(p_branch, p_date, v_key, v_set->>'name', v_set->>'phone', p_present);
        if v_cid is not null then return private.aaj_sync_checkup_row(p_branch, p_tab, p_date, p_row, v_cid, true); end if;
        -- that person's checkup is in another row of the tab now: a copy, or the person typed twice. Refused like a second visit of one
        -- patient (the script names the row), never a second checkup (sheet-behaviour RV-1). Deleting the other row lets this one adopt it.
        v_dup := private.aaj_checkup_dup(p_branch, p_date, v_key, v_set->>'name', v_set->>'phone', p_present);
        if v_dup is not null then
          return private.aaj_result(v_key, 'duplicate', 'error',
            'Already on this list in another row (the same checkup patient). Delete this row. If this is another person, correct the name or the phone.',
            null, '{}', v_dup);
        end if;
      end if;
      -- owner, 9 Oct 2026 (13:20): only a Treatment that says checkup makes a row without an Mr# a checkup. Any other treatment is an existing
      -- patient whose Mr# staff forgot: a person looks it up in Healthwire. Nothing is guessed, filed as a checkup or made into a patient.
      if not private.aaj_is_checkup_text(v_set->>'treatment') then
        return private.aaj_result(v_key, 'needs_patient', 'error',
          'Needs attention: add the Mr#. A row with no Mr# is a checkup only when its Treatment says checkup. Look the Mr# up in Healthwire.');
      end if;
      -- a braces month on the row ("6", "04 Photo") is a braces patient whose Mr# was forgotten, never a checkup
      if btrim(coalesce(v_set->'month'->>'t', '')) <> '' then
        return private.aaj_result(v_key, 'needs_patient', 'error',
          'Needs attention: add the Mr#. A row with a Month is a braces patient, never a checkup. Look the Mr# up in Healthwire.');
      end if;
      return private.aaj_sync_checkup_row(p_branch, p_tab, p_date, p_row, null);
    end if;
    if v_mr !~ '^[A-Za-z0-9_-]+$' or v_mr !~ '[0-9]' then
      return private.aaj_result(v_key, 'needs_patient', 'error', format('"%s" is not a Mr#. Type the number only, or leave it empty for a checkup patient.', left(v_mr, 30)));
    end if;
    -- a "name" of one letter is no name: answered before anything is looked up, whatever the Mr#. (A Healthwire number nobody has and one the
    -- website has would otherwise get different answers, one of them neither audited nor counted: a free check of which numbers are taken.)
    if length(btrim(coalesce(v_set->>'name', ''))) < 2 then
      return private.aaj_result(v_key, 'needs_patient', 'error', 'Patient name is too short.');
    end if;
    -- after 5 new refused lookups in one call the call's other new Mr# rows are not looked at: they wait for a later call (the script sends a
    -- refused row again after a few minutes). A real tab rarely has more than one or two wrong Mr# at a time, and a row refused earlier today
    -- that is sent again does not count, so the good rows always get through within a few calls.
    if coalesce(nullif(current_setting('aaj.refused', true), ''), '0')::int >= 5 then
      return private.aaj_result(v_key, 'needs_patient', 'error', 'Too many rows the website could not place at once. This row is tried again in a few minutes.');
    end if;
    v_find := private.aaj_check_mr(p_branch, p_date, v_mr, v_set->>'name', v_set->>'phone');
    -- the name and phone are filed under a patient the sync made today from a row that has left the sheet (a Healthwire Mr# typed with a slip,
    -- 9888 for 9878, that staff have just corrected: the script sends the corrected row under a new key). That file goes with its row's visit
    -- (aaj_removals), so the row is looked at without it: never "Use 9888", the slip itself (sheet-behaviour M3, loop 7).
    if v_find->>'outcome' = 'mr_other' then
      select o.id into v_ign from public.patients o
       where o.mr_number = v_find->>'mr' and o.legacy_source = 'aaj_sheet_sync' and o.created_by = private.aaj_sync_actor()
         and o.created_at >= ((now() at time zone 'Asia/Karachi')::date)::timestamp at time zone 'Asia/Karachi'
         and exists (select 1 from public.visits x where x.patient_id = o.id)
         and not exists (select 1 from public.visits x where x.patient_id = o.id
                            and (x.branch_id <> p_branch or x.visit_date <> p_date or x.sheet_key is null or x.sheet_key = any (coalesce(p_present, '{}'))));
      if v_ign is not null then v_find := private.aaj_check_mr(p_branch, p_date, v_mr, v_set->>'name', v_set->>'phone', v_ign); end if;
    end if;
    v_oc := v_find->>'outcome';
    -- the patient is on today's list already (a visit, or a checkup registered as them): the sheet sees them anyway
    v_onlist := v_oc = 'mr' and (exists (select 1 from public.visits x where x.patient_id = (v_find->>'patient_id')::uuid
                                                and x.branch_id = p_branch and x.visit_date = p_date)
                                 or exists (select 1 from public.checkups x where x.patient_id = (v_find->>'patient_id')::uuid and x.branch_id = p_branch
                                               and x.checkup_date = p_date and x.source <> 'archive' and not x.date_is_month));

    -- the day's visit cap is full: every row that would make a new visit gets the same answer, whatever the lookup found. (Otherwise a
    -- fitting name and a wrong one would get different answers with nothing made: a free check of the name behind an Mr#.) Only a row that
    -- meets a visit this list already has (the patient is on today's list, which the sheet sees anyway) goes on.
    if private.aaj_visit_cap_hit(p_branch, p_date) and not v_onlist then
      return private.aaj_result(v_key, 'needs_patient', 'error', 'Too many patients added from the sheet today. Add this one on the website.');
    end if;
    -- the day's 200 refused lookups are used up: the same, for every row that would make a visit or a patient. A row that fits would
    -- otherwise make a visit (and get the patient's phone and dues back) while a wrong guess got a refusal that is neither audited nor
    -- counted: a free check of the name behind an Mr#. The answer counts for this call's five. A refused row sent again (already in the
    -- audit log today) gets its own answer below: nothing new is learnt from it.
    if not v_onlist and private.aaj_lookups_used_up()
       and (v_oc in ('mr', 'mr_new') or not private.aaj_lookup_seen(v_key, v_mr, v_oc, v_set->>'name', v_set->>'phone')) then
      perform set_config('aaj.refused', (coalesce(nullif(current_setting('aaj.refused', true), ''), '0')::int + 1)::text, true);
      return private.aaj_result(v_key, 'needs_patient', 'error', 'Too many rows the website could not place today. Add this patient on the website.');
    end if;

    if v_oc = 'mr' then
      -- the name fits the patient without doubt (aaj_check_mr refuses a row that fits only with doubt)
      v_pid := (v_find->>'patient_id')::uuid;
      select * into v_pat from public.patients where id = v_pid;
    elsif v_oc = 'mr_new' then
      -- a Healthwire number the website has not seen yet: the patient is created with it, flagged for a check
      if length(btrim(coalesce(v_set->>'name', ''))) < 2 then
        return private.aaj_result(v_key, 'needs_patient', 'error', 'Patient name is too short.');
      end if;
      if (select count(*) from public.patients where legacy_source = 'aaj_sheet_sync' and first_branch_id = p_branch
             and (created_at at time zone 'Asia/Karachi')::date = (now() at time zone 'Asia/Karachi')::date)
         >= coalesce((select value::int from private.aaj_sync_config where key = 'new_patients_per_branch_day'), 30) then
        -- audited and counted like a refused lookup: otherwise a number nobody has would get this answer for free while a taken one gets the
        -- audited "does not match" (a free check of which numbers exist, abuse-privacy minor, loop 8)
        perform private.aaj_note_lookup(p_tab, v_key, v_mr, 'mr_cap', v_set->>'name', v_set->>'phone');
        return private.aaj_result(v_key, 'needs_patient', 'error', 'Too many new patients from the sheet today. Add this one on the website.');
      end if;
      insert into public.patients (mr_number, full_name, phone, first_branch_id, legacy_source, legacy_name, notes, created_by)
      values (v_mr, btrim(v_set->>'name'), private.aaj_norm_phone(v_set->>'phone'), p_branch, 'aaj_sheet_sync',
              case when lower(btrim(coalesce(v_set->>'legacy_name', ''))) <> lower(btrim(v_set->>'name')) then nullif(btrim(v_set->>'legacy_name'), '') end,
              'Added from the Google Sheet with Healthwire Mr# ' || v_mr || ' (' || p_tab || ', ' || to_char(p_date, 'DD Mon YYYY') || '). Check name and phone.',
              private.aaj_sync_actor())
      returning * into v_pat;
      v_pid := v_pat.id; v_pc := v_pat.mr_number; v_level := 'warn';
      v_msgs := v_msgs || format('New patient added with Healthwire Mr# %s. Check the name and phone on the website.', v_pc);
      -- within 20 of the limit: say so before new patients start being refused (sheet-behaviour RW8-3)
      if v_mr::int > private.aaj_hw_limit() - 20 then
        v_msgs := v_msgs || 'Healthwire numbers are close to the newest ones the website knows: ask Dr. Ali to import the latest Healthwire patients.'::text;
      end if;
      insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
      values ('patients', v_pid::text, 'SHEET_SYNC', null,
              jsonb_build_object('mr', v_pc, 'name', v_pat.full_name, 'phone', v_pat.phone, 'tab', p_tab, 'outcome', v_oc), private.aaj_sync_actor());
    else
      -- nothing is created or linked: no visit, no checkup, no phone, no braces case, nothing on the patient file (also for a name that fits
      -- only with doubt, which aaj_check_mr answers as mr_name / mr_noname). The refusal is audited, counted for this call and capped
      -- (aaj_note_lookup). It never names the patient of the typed Mr# (the secret is not a way to turn Mr# into names). The Mr# under which
      -- this very name and phone are filed is told only when that patient was seen at this branch: the row already carries their name and
      -- phone, and the name in the answer is the row's own.
      if not private.aaj_note_lookup(p_tab, v_key, v_mr, v_oc, v_set->>'name', v_set->>'phone') then      -- (not reached: the check above answers first)
        return private.aaj_result(v_key, 'needs_patient', 'error', 'Too many rows the website could not place today. Add this patient on the website.');
      end if;
      return private.aaj_result(v_key, 'needs_patient', 'error', case v_oc
        when 'mr_noname' then format('Needs attention: Mr# %s: the name in this row cannot be read. Type the patient''s name in English letters, as the website has it.', v_mr)
        -- the Mr# may be right and the name spelt another way: the answer says so, and never names the patient (sheet-behaviour RS5-N1)
        when 'mr_name' then format('Needs attention: the name in this row does not match Mr# %s on the website. Check the Mr#, or type the name as the website has it.', v_mr)
        when 'mr_other' then case when (v_find->>'seen')::boolean
                                  then format('Mr# %s is not on the website, but %s with this phone is Mr# %s. Use %s.', v_mr, left(btrim(coalesce(v_set->>'name', '')), 60), v_find->>'mr', v_find->>'mr')
                                  else format('Mr# %s is not on the website, and this name and phone are filed under another Mr#. Check the number.', v_mr) end
        -- a retired number of the patient this row fits (renumbered to 50000+, or merged): their Mr# now, never a second file under the old one
        when 'mr_moved' then format('Mr# %s is no longer used. This patient''s Mr# is now %s. Use %s.', v_mr, v_find->>'mr', v_find->>'mr')
        -- a Healthwire number above aaj_hw_limit(): Healthwire has not given it yet (abuse-privacy M-HW-SQUAT). Front desk cannot give a
        -- Healthwire number on the website (a new patient there gets 50000+), so the answer never says to add the patient there: that would give
        -- the patient a second number (sheet-behaviour RW8-3)
        when 'mr_ahead' then format('Mr# %s is not on the website and is higher than the newest Healthwire numbers it knows, so it looks like a typo. Check the Mr#. If it is right (a new Healthwire patient), ask Dr. Ali to import the latest Healthwire patients; this row is tried again every few minutes.', v_mr)
        else format('Mr# %s is not on the website. Check the number.', v_mr) end);
    end if;

    -- does this patient already have a visit on this list?
    select * into e from public.visits where patient_id = v_pid and branch_id = p_branch and visit_date = p_date
     order by (status <> 'cancelled') desc, created_at, id limit 1 for update;
    if found then
      v_ek := coalesce(e.sheet_key, 'W-' || e.id::text);
      if v_ek = any (coalesce(p_present, '{}')) and v_ek <> v_key then
        v_dup := v_ek;
        return private.aaj_result(v_key, 'duplicate', 'error',
          format('Already on this list in another row (Mr# %s). Put both treatments in one row and delete this one.', v_pat.mr_number),
          e.id, '{}', v_dup);
      end if;
      select * into v from public.visits where id = e.id;
      v_found := true; v_outcome := 'linked';
    elsif v_oc = 'mr' and btrim(coalesce(v_set->'month'->>'t', '')) = '' then
      -- no visit, but a checkup of today registered as this patient whose row is not on the sheet (the row lost its hidden key, and the
      -- website had written the Mr# into it): the row is that checkup. It is adopted, never turned into a visit. A row with a Month is
      -- never a checkup: it is the patient's visit (a registered checkup row the script let go because a Month was typed into it).
      select x.id into v_cid from public.checkups x
       where x.patient_id = v_pid and x.branch_id = p_branch and x.checkup_date = p_date and x.source <> 'archive' and not x.date_is_month
         and coalesce(x.sheet_key, 'W-' || x.id::text) <> v_key and not (coalesce(x.sheet_key, 'W-' || x.id::text) = any (coalesce(p_present, '{}')))
       order by x.created_at, x.id limit 1;
      if v_cid is not null then return private.aaj_sync_checkup_row(p_branch, p_tab, p_date, p_row, v_cid, true); end if;
    end if;
    -- (a new visit at the daily cap was refused above, before the lookup's answer was used)
  else
    v_pid := v.patient_id;
  end if;

  -- ---- a row already linked to a visit whose name is typed over with a name that does not fit that visit's patient without doubt ----
  -- (somebody else typed over the row, the Mr# left as it was): the visit is never re-pointed and nothing from the row is applied to it,
  -- not the Treatment, Status, Month or anything else. Every answer says so while the name stands (sheet-behaviour L2-residual: before,
  -- only the first answer warned and the next Status edit showed a plain tick on the other patient's visit); the script keeps sending the
  -- name until it is answered without an error. Once the name is put right (or the Mr#, which makes it a new row), the row goes through.
  -- The visit's patient is on today's list (the sheet sees them anyway); the answer still does not name them.
  if v_outcome = 'updated' and v_set ? 'name' then
    select * into v_pat from public.patients where id = v.patient_id;
    if not private.aaj_name_fits(v_set->>'name', v_pat.full_name)
       and lower(regexp_replace(btrim(coalesce(v_set->>'name', '')), '\s+', ' ', 'g')) <> lower(regexp_replace(btrim(v_pat.full_name), '\s+', ' ', 'g')) then
      return private.aaj_result(v_key, 'error', 'error',
        format('Needs attention: the name in this row does not match Mr# %s on the website. Check the Mr# or the name: nothing in this row is saved until they match.', v_pat.mr_number), v.id);
    end if;
  end if;

  -- ---- a row already linked to a visit whose Mr# cell now holds another number ----
  -- The script sends it under the visit's key only while the row's name and phone are still that person: a slip of a finger in the Mr# cell
  -- (token 7 typed into the Mr# cell, a digit too many). The visit is never moved to another patient, never removed for it, and nothing is
  -- made: the website's Mr# goes back into the cell (further below, like an emptied Mr# cell) and the rest of the row is saved as usual
  -- (sheet-behaviour RW8-1, 11 Oct 2026; before, the row became a new row and the removal pass deleted the visit with front desk's notes).
  -- One exception: a patient file the sync made from this very row today (a Healthwire Mr# typed with a slip, 9888 for 9878) is no proof of
  -- who the row is. When the new number looks like the correction of a slip (a Healthwire number, at most two digits away from the old one),
  -- the row is let go ("rekey"): the script sends it again as a new row with the corrected Mr#, and the file made from the slip goes with its
  -- visit (aaj_removals, sheet-behaviour M3, loop 7). Anything else (token 7 typed into the cell, a digit too many) is a slip on that file
  -- too and is written back like on any other visit; a really wrong number is corrected by typing the patient again in a new row.
  -- The visit made under the slip then goes like a deleted row whatever its status (aaj_note_let_go, sheet-behaviour RV9-2: before, a visit
  -- already Completed stayed with the file made from the slip, next to the right patient's Completed visit). So the row is let go only while
  -- nothing real hangs on that visit (an invoice, a photo, a checker); otherwise the Mr# is written back and the file is put right on the
  -- website, where its attached records go with it.
  if v_outcome = 'updated' and v_set ? 'mr' then
    v_mr := nullif(btrim(v_set->>'mr'), '');
    select * into v_pat from public.patients where id = v.patient_id;
    if v_mr is not null and v_mr ~ '^[1-9][0-9]{0,4}$' and v_mr::int < 50000 and v_mr is distinct from v_pat.mr_number
       and private.aaj_lev(v_mr, v_pat.mr_number) <= 2
       and v_pat.legacy_source = 'aaj_sheet_sync' and v_pat.created_by = private.aaj_sync_actor()
       and v_pat.created_at >= ((now() at time zone 'Asia/Karachi')::date)::timestamp at time zone 'Asia/Karachi'
       and not exists (select 1 from public.visits x where x.patient_id = v_pat.id and x.id <> v.id) then
      v_slip_held := coalesce(private.aaj_visit_attached(v.id), case when v.photos_uploaded then 'photos' when v.checked_by is not null then 'a checker' end);
      if v_slip_held is null then
        perform private.aaj_note_let_go('visits', v.id, v_key, p_tab, 'mr_slip');
        return private.aaj_result(v_key, 'rekey', 'warn', format('Mr# changed from %s to %s: this row is sent again with the new Mr#.', v_pat.mr_number, left(v_mr, 20)), v.id);
      end if;
    end if;
  end if;

  -- ---- the visit as it should be ----
  if v_found then
    n := v;
    n.sheet_key := case when v.sheet_key is null or v_outcome = 'linked' then v_key else v.sheet_key end;
    n.sheet_cells := coalesce(v.sheet_cells, '{}'::jsonb);
    c := private.aaj_canon(v.id);
    -- an ADOPTED visit (the sheet row met a visit the website already had): a cell typed after the website's last change wins, like on a
    -- linked row (sheet-behaviour RS5-A1: a patient whose cancelled row was deleted and who is typed again when she turns up is not left
    -- Cancelled, and "Completed / RCT" typed for a visit front desk added as "Waiting / Consultation" is not reverted). A visit already in
    -- Treatment or Completed keeps the website's text, and the status only moves forward (aaj_adopt_status): a stale install-day sheet
    -- never sets a Completed visit back to Waiting. A row with no edit time (Set up stamped it, nobody edited it since) keeps the website's
    -- text, but its Completed still completes a Waiting visit (aaj_adopt_status, sheet-behaviour SB7-2).
    v_newer := coalesce(v_edit, 0) > extract(epoch from v.updated_at) * 1000
               and not (v_outcome = 'linked' and v.status in ('in_treatment', 'completed'));
  else
    v_create := true;
    n.id := gen_random_uuid(); n.patient_id := v_pid; n.branch_id := p_branch; n.visit_date := p_date;
    n.status := 'waiting'; n.created_by := private.aaj_sync_actor(); n.sheet_key := v_key; n.sheet_cells := '{}'::jsonb;
  end if;
  n.sheet_cells := n.sheet_cells || jsonb_build_object('tab', p_tab);
  -- a row typed just now (after the website's last change) for a patient whose visit is Cancelled / No show, with no Status typed: the
  -- patient is here (a new row starts as Waiting), so the visit is brought back as Waiting (sheet-behaviour RS5-A1)
  if v_outcome = 'linked' and v.status in ('cancelled', 'no_show') and not (v_set ? 'status')
     and coalesce(v_edit, 0) > extract(epoch from v.updated_at) * 1000 then
    v_set := v_set || jsonb_build_object('status', jsonb_build_object('t', 'Waiting', 'v', 'waiting'));
  end if;

  -- who wins each field
  foreach v_f in array array['month', 'treatment', 'token', 'status', 'group', 'details'] loop
    if v_set ? v_f then
      v_st := case when v_f in ('month', 'token', 'status', 'group') then coalesce(v_set->v_f->>'t', '') else coalesce(v_set->>v_f, '') end;
      v_dec := case when v_create then 'apply'
                    when v_f = 'status' and v_outcome = 'linked' and lower(c->>v_f) is distinct from lower(v_st)
                      then private.aaj_adopt_status(v.status::text, nullif(v_set->'status'->>'v', ''), v_edit > extract(epoch from v.updated_at) * 1000)
                    when v_f = 'status' then private.aaj_decide(lower(c->>v_f), case when v_base is not null then lower(coalesce(v_base->>v_f, '')) end, lower(v_st), v_base is not null, v_newer)
                    -- an adopted visit keeps the website's Month, Token and Group unless it has none: the token is numbered per branch here and
                    -- per group in the sheet, and the braces month and doctor group belong to the website's rules
                    else private.aaj_decide(c->>v_f, case when v_base is not null then coalesce(v_base->>v_f, '') end, v_st, v_base is not null,
                                            v_newer and not (v_outcome = 'linked' and v_f in ('month', 'token', 'group'))) end;
      if v_dec = 'keep' then
        v_kept := array_append(v_kept, v_f); v_lost := v_lost || jsonb_build_object(v_f, v_st);
      elsif v_dec = 'same' then
        v_same := v_same || jsonb_build_object(v_f, true);
      else
        v_decs := v_decs || jsonb_build_object(v_f, true);
      end if;
    end if;
  end loop;

  -- (A row whose name fits its patient only with doubt never gets this far: a new one is refused by aaj_check_mr, a linked one whose name
  -- is typed over is answered above. So a Month here is always the Mr# patient's own.)

  -- month: the braces case behind it
  if v_decs ? 'month' then
    v_mv := nullif(v_set->'month'->>'v', '')::int; v_mt := coalesce(v_set->'month'->>'t', '');
    if v_mv between 1 and 60 then
      select id into v_case from public.braces_cases where patient_id = n.patient_id and status = 'active';
      if v_case is null and exists (select 1 from public.braces_cases where patient_id = n.patient_id) then
        v_msgs := v_msgs || format('Month %s: this patient''s braces case is closed on the website. Check it there.', v_mv); v_level := 'warn';
        v_mv := null;
      elsif v_case is null then
        begin
          insert into public.braces_cases (patient_id, start_date, bonding_branch_id, status, notes, created_by)
          values (n.patient_id, p_date - (v_mv - 1) * 30, p_branch, 'active',
                  'From the Google Sheet: month ' || v_mv || ' on ' || to_char(p_date, 'DD Mon YYYY') || ' (' || p_tab || '). Check the start date and kit.',
                  private.aaj_sync_actor())
          returning id into v_case;
        exception when unique_violation then
          select id into v_case from public.braces_cases where patient_id = n.patient_id and status = 'active';
        end;
      end if;
      if v_mv is not null then n.braces_case_id := v_case; n.braces_month := v_mv; end if;
    elsif v_mv is null and v_mt = '' then
      n.braces_month := null; n.braces_case_id := null;
    elsif v_mv is not null then
      v_msgs := v_msgs || format('Month %s is not a braces month (1 to 60).', v_mv); v_level := 'warn'; v_mv := null;
    end if;
    n.sheet_cells := n.sheet_cells || jsonb_build_object('month', jsonb_build_object('t', v_mt, 'v', v_mv));
  end if;

  if v_decs ? 'treatment' then
    n.treatment_label := nullif(btrim(v_set->>'treatment'), '');
    n.treatment_id := (select t.id from public.treatments t where t.active and lower(t.name) = lower(btrim(coalesce(v_set->>'treatment', ''))));
  end if;

  -- token: one per branch and day on the website; the sheet numbers per group and also writes kit text here
  if v_decs ? 'token' then
    v_tt := coalesce(v_set->'token'->>'t', ''); v_tv := nullif(v_set->'token'->>'v', '')::int;
    if v_tv between 1 and 999 then
      v_other := (select p.full_name from public.visits x join public.patients p on p.id = x.patient_id
                   where x.branch_id = p_branch and x.visit_date = p_date and x.token_no = v_tv and x.id is distinct from n.id limit 1);
      if v_other is not null then
        v_msgs := v_msgs || format('Token %s is already used by %s. Token not changed on the website.', v_tv, v_other); v_level := 'warn';
        n.sheet_cells := n.sheet_cells || jsonb_build_object('token', jsonb_build_object('t', v_tt, 'v', v_tv, 'own', true));
      else
        n.token_no := v_tv; v_token_asked := true;
        n.sheet_cells := n.sheet_cells || jsonb_build_object('token', jsonb_build_object('t', v_tt, 'v', v_tv));
      end if;
    elsif v_tt = '' then
      n.token_no := null;
      n.sheet_cells := n.sheet_cells - 'token';
    else
      n.sheet_cells := n.sheet_cells || jsonb_build_object('token', jsonb_build_object('t', v_tt, 'v', null));   -- "Kit 80k": text only
    end if;
  end if;

  if v_decs ? 'status' then
    v_sv := nullif(v_set->'status'->>'v', '');
    if v_sv is null or v_sv not in ('scheduled', 'waiting', 'in_treatment', 'completed', 'cancelled', 'no_show') then
      v_msgs := v_msgs || format('Status "%s" not understood. Use Waiting, Treatment, Completed, Scheduled, Cancelled or No show.', coalesce(v_set->'status'->>'t', ''));
      v_level := 'warn';
    else
      n.status := v_sv::public.visit_status;
    end if;
  end if;

  if v_decs ? 'group' then
    v_gv := nullif(v_set->'group'->>'v', '')::int;
    if v_gv is not null and not exists (select 1 from public.doctor_groups where id = v_gv) then v_gv := null; end if;
    n.doctor_group_id := v_gv;
    n.sheet_cells := n.sheet_cells || jsonb_build_object('group', jsonb_build_object('t', coalesce(v_set->'group'->>'t', ''), 'v', v_gv));
  end if;

  if v_decs ? 'details' then n.details_text := nullif(btrim(v_set->>'details'), ''); end if;

  -- fields where both sides already say the same: no column is touched, the sheet's own wording is remembered if nothing is stored yet
  foreach v_f in array array['month', 'token', 'group'] loop
    if v_same ? v_f and not (n.sheet_cells ? v_f) and coalesce(v_set->v_f->>'t', '') <> '' then
      n.sheet_cells := n.sheet_cells || jsonb_build_object(v_f, jsonb_build_object('t', v_set->v_f->>'t', 'v', nullif(v_set->v_f->>'v', '')::int));
    end if;
  end loop;

  -- a new "Monthly" visit with no month typed: the website picks the next month of the patient's active case (as addVisit does)
  if v_create and n.braces_case_id is null and coalesce(n.treatment_label, '') ~* 'monthly' and not (v_set ? 'month') then
    n.braces_case_id := (select id from public.braces_cases where patient_id = n.patient_id and status = 'active');
  end if;

  -- the patient on a row that is already linked is never changed; the website's Mr# goes back into the cell
  if v_found and v_outcome = 'updated' then
    if v_set ? 'mr' then
      v_mr := nullif(btrim(v_set->>'mr'), '');
      select * into v_pat from public.patients where id = n.patient_id;
      if v_mr is null or upper(v_mr) = 'NEW' then v_kept := array_append(v_kept, 'mr'::text);
      elsif v_mr <> v_pat.mr_number then
        -- (the row's name fits this visit's patient: a name that does not was answered above, before anything was decided)
        v_kept := array_append(v_kept, 'mr'::text); v_level := 'warn';
        if v_slip_held is not null then
          -- the correction of a slip on a file the sync made from this row today, held back because something hangs on the visit (above)
          v_msgs := v_msgs || format('Mr# %s is put back: this visit has an attached record (%s) on the website, so the row is not moved to Mr# %s. If %s is the right Mr#, correct the patient file on the website.',
                                     v_pat.mr_number, v_slip_held, left(v_mr, 20), left(v_mr, 20));
        else
          v_msgs := v_msgs || format('Mr# %s is not this visit''s patient, so Mr# %s is put back. If this row is another patient, delete it and type that patient in a new row.',
                                     left(v_mr, 20), v_pat.mr_number);
        end if;
      end if;
    end if;
    -- (a name that does not fit this visit's patient without doubt was answered above, before anything was decided)
    -- a phone changed in the sheet is not copied into the patient file (it is the patient's, not the visit's): say so instead of showing a
    -- green tick. Compared with the phone the sheet is shown only: comparing with the patient's second phone too, which the sheet never
    -- gets, would confirm a guessed second number with no trace (abuse-privacy minor, loop 6).
    if v_set ? 'phone' and private.aaj_norm_phone(v_set->>'phone') is not null then
      select * into v_pat from public.patients where id = n.patient_id;
      if nullif(v_pat.phone, '0000000') is not null and private.aaj_norm_phone(v_set->>'phone') is distinct from private.aaj_norm_phone(v_pat.phone) then
        v_msgs := v_msgs || 'The phone in this row is not the patient''s phone on the website. Change it in the patient file.'::text; v_level := 'warn';
      end if;
    end if;
  end if;

  -- doctors: both sides' additions and removals are kept
  if v_set ? 'doctors' then
    v_dwant := true;
    select coalesce(array_agg(el order by o), '{}') into v_sheet_set from (
      select distinct on (el) el, o from (
        select coalesce(private.aaj_match_clinician(d)::text, case when private.aaj_doctor_key(d) <> '' then 'raw:' || private.aaj_doctor_key(d) end) as el, o
          from jsonb_array_elements_text(v_set->'doctors'->'v') with ordinality t(d, o)) x
       where el is not null order by el, o) y;
    if v_base is not null and jsonb_typeof(v_base->'doctors') = 'array' then
      select coalesce(array_agg(distinct el), '{}') into v_base_set from (
        select coalesce(private.aaj_match_clinician(d)::text, case when private.aaj_doctor_key(d) <> '' then 'raw:' || private.aaj_doctor_key(d) end) as el
          from jsonb_array_elements_text(v_base->'doctors') d) x where el is not null;
    end if;
    v_web_set := array(select distinct clinician_id::text from public.visit_staff where visit_id = n.id and role in ('doctor', 'assistant'))
              || array(select 'raw:' || private.aaj_doctor_key(u) from jsonb_array_elements_text(coalesce(n.sheet_cells->'doctors'->'unmatched', '[]'::jsonb)) u)
              || array(select jsonb_array_elements_text(coalesce(n.sheet_cells->'doctors'->'pending', '[]'::jsonb)));       -- doctors waiting for Completed stay in the row
    if v_base is not null then
      v_res := array(select e1 from (select unnest(v_web_set) as e1 union select unnest(array(select unnest(v_sheet_set) except select unnest(v_base_set)))) u
                     except select unnest(array(select unnest(v_base_set) except select unnest(v_sheet_set))));
    else
      v_res := array(select unnest(v_web_set) union select unnest(v_sheet_set));
    end if;
    v_ids := array(select x from unnest(v_res) x where x not like 'raw:%' order by x);
    -- the names the sheet wrote for the people the website does not know
    v_unm := '{}';
    for r in select nm from (
               select distinct on (private.aaj_doctor_key(nm)) nm, o from (
                 select d as nm, o from jsonb_array_elements_text(v_set->'doctors'->'v') with ordinality t(d, o)
                 union all
                 select u, 1000 + o from jsonb_array_elements_text(coalesce(n.sheet_cells->'doctors'->'unmatched', '[]'::jsonb)) with ordinality t(u, o)) z
                where ('raw:' || private.aaj_doctor_key(nm)) = any (v_res)
                order by private.aaj_doctor_key(nm), o) q order by o loop
      v_unm := v_unm || r.nm;
    end loop;
    v_dt := case when (select coalesce(array_agg(x order by x), '{}') from unnest(v_res) x) = (select coalesce(array_agg(x order by x), '{}') from unnest(v_sheet_set) x)
                 then v_set->'doctors'->>'t' end;
    n.sheet_cells := n.sheet_cells || jsonb_build_object('doctors', jsonb_build_object('t', v_dt, 'ids', to_jsonb(v_ids), 'unmatched', to_jsonb(v_unm),
                                                          'pending', coalesce(n.sheet_cells->'doctors'->'pending', '[]'::jsonb)));
    if cardinality(v_unm) > 0 then
      v_msgs := v_msgs || format('Not on the website''s doctor list: %s. Add them in Clinic setup or fix the spelling.', array_to_string(v_unm, ', '));
      v_level := 'warn';
    end if;
  end if;

  -- ---- save it (rule stops are handled here, one row at a time) ----
  v_old_token := case when v_create then null else v.token_no end;
  v_dirty := v_create or (n.treatment_label, n.treatment_id, n.details_text, n.token_no, n.status, n.doctor_group_id, n.braces_case_id, n.braces_month,
                          n.sheet_key, n.sheet_cells, n.protocol_override_by, n.protocol_override_reason, n.dues_override_by, n.dues_override_reason, n.notes)
             is distinct from (v.treatment_label, v.treatment_id, v.details_text, v.token_no, v.status, v.doctor_group_id, v.braces_case_id, v.braces_month,
                               v.sheet_key, v.sheet_cells, v.protocol_override_by, v.protocol_override_reason, v.dues_override_by, v.dues_override_reason, v.notes);
  if v_dirty then
    loop
      v_try := v_try + 1;
      begin
        if v_create then
          insert into public.visits (id, patient_id, branch_id, visit_date, status, token_no, treatment_id, treatment_label, details_text,
                                     braces_case_id, braces_month, doctor_group_id, sheet_key, sheet_cells, created_by,
                                     protocol_override_by, protocol_override_reason, dues_override_by, dues_override_reason, notes)
          values (n.id, n.patient_id, n.branch_id, n.visit_date, n.status, n.token_no, n.treatment_id, n.treatment_label, n.details_text,
                  n.braces_case_id, n.braces_month, n.doctor_group_id, n.sheet_key, n.sheet_cells, n.created_by,
                  n.protocol_override_by, n.protocol_override_reason, n.dues_override_by, n.dues_override_reason, n.notes);
        else
          update public.visits set
            treatment_label = n.treatment_label, treatment_id = n.treatment_id, details_text = n.details_text,
            token_no = n.token_no, status = n.status, doctor_group_id = n.doctor_group_id,
            braces_case_id = n.braces_case_id, braces_month = n.braces_month, sheet_key = n.sheet_key, sheet_cells = n.sheet_cells,
            protocol_override_by = n.protocol_override_by, protocol_override_reason = n.protocol_override_reason,
            dues_override_by = n.dues_override_by, dues_override_reason = n.dues_override_reason, notes = n.notes
           where id = n.id;
        end if;
        exit;
      exception
        when unique_violation then
          get stacked diagnostics v_con = constraint_name;
          if v_con = 'visits_token_unique_idx' and v_try < 4 and v_token_asked then
            -- somebody took that token between the check and the write
            n.token_no := v_old_token; v_token_asked := false;
            n.sheet_cells := n.sheet_cells || jsonb_build_object('token', coalesce(n.sheet_cells->'token', '{}'::jsonb) || jsonb_build_object('own', true));
            v_msgs := array_append(v_msgs, 'That token was just taken on the website. Token not changed on the website.'::text); v_level := 'warn';
            continue;
          end if;
          raise;
        when others then
          v_err := sqlerrm;
          if sqlstate <> 'P0001' or v_try >= 4 or not (v_err like 'PHOTO\_REQUIRED%' or v_err like 'CHECK\_REQUIRED%' or v_err like 'DUES\_HOLD%') then raise; end if;
          v_label := private.aaj_status_label(n.status);
          if p_rules = 'hold' or n.status <> 'completed' then
            -- keep the website's rules (hold mode, or a row that is not Completed): the status stays one step back and the sheet is told
            v_msgs := v_msgs || case
              when v_err like 'PHOTO%' then format('Not saved as %s: this is a photo month and the photos are not uploaded on the website yet.', v_label)
              when v_err like 'CHECK%' then format('Not saved as %s: the checker has not checked this visit on the website yet.', v_label)
              else format('Not saved as %s: pending dues Rs %s.', v_label, to_char(public.patient_dues(n.patient_id), 'FM999,999,999')) end;
            v_level := 'warn'; v_kept := array_append(v_kept, 'status'::text);
            v_lost := v_lost || jsonb_build_object('status', coalesce(v_set->'status'->>'t', ''));
            n.status := case when v_create then (case when v_err like 'DUES%' then 'waiting' else 'in_treatment' end)::public.visit_status else v.status end;
          else
            -- the owner's rule (9 Oct 2026): a row marked Completed in the sheet completes the visit. The website's photo, checker and
            -- dues rules are skipped, and the record says exactly that. Skipping the photo or check step is the owner's normal path
            -- ("its fine to skip them"): the row stays a tick, so it does not count toward the tab heading's "need attention" (RS13-M1).
            -- Dues not held stay a warning: front desk may still collect them (the website holds dues only when Dr. Ali turns that on).
            if p_admin is null then raise; end if;
            if v_err like 'DUES%' then
              n.dues_override_by := p_admin; n.dues_override_reason := private.aaj_override_reason();
              v_msgs := v_msgs || format('Completed from the sheet. Pending dues Rs %s were not held (owner rule).', to_char(public.patient_dues(n.patient_id), 'FM999,999,999'));
              v_over := array_append(v_over, 'dues'::text);
              v_level := 'warn';
            else
              n.protocol_override_by := p_admin; n.protocol_override_reason := private.aaj_override_reason();
              v_msgs := v_msgs || format('Completed from the sheet (owner rule: the website''s %s step is not needed).', case when v_err like 'PHOTO%' then 'photo' else 'check' end);
              v_over := v_over || case when v_err like 'PHOTO%' then 'photo' else 'check' end;
            end if;
          end if;
          continue;
      end;
    end loop;
  end if;

  -- ---- the people on the visit ----
  -- A doctor the website's group rule refuses on a row that is not Completed yet stays in the row as the sheet's own text ("pending": the cell is
  -- not rewritten) and is added when the row is marked Completed (owner rule: Completed skips the doctor-group rule). In hold mode the
  -- website's rule always wins: the doctor is not added and the sheet is told to take the website's list.
  if p_rules <> 'hold' and p_admin is not null and not v_dwant and n.status = 'completed' and (v_set->'status'->>'v') = 'completed'
     and jsonb_array_length(coalesce(n.sheet_cells->'doctors'->'pending', '[]'::jsonb)) > 0 then
    v_ids := array(select jsonb_array_elements_text(n.sheet_cells->'doctors'->'pending'));
    v_padd := true;
  end if;
  if v_dwant or v_padd then
    v_pend := '{}';
    if v_dwant then
      delete from public.visit_staff where visit_id = n.id and role in ('doctor', 'assistant') and not (clinician_id::text = any (v_ids));
    end if;
    for r in select c2.id, c2.is_doctor, c2.display_name from public.clinicians c2
              where c2.id::text = any (v_ids)
                and not exists (select 1 from public.visit_staff vs where vs.visit_id = n.id and vs.clinician_id = c2.id and vs.role in ('doctor', 'assistant')) loop
      begin
        insert into public.visit_staff (visit_id, clinician_id, role) values (n.id, r.id, case when r.is_doctor then 'doctor' else 'assistant' end::public.visit_staff_role);
      exception when others then
        if sqlstate <> 'P0001' or sqlerrm not like 'GROUP\_NOT\_ALLOWED%' then raise; end if;
        if p_rules = 'hold' or p_admin is null then
          v_msgs := v_msgs || format('%s is not allowed for this month on the website. Not added.', r.display_name); v_level := 'warn'; v_kept := array_append(v_kept, 'doctors'::text);
          v_lost := v_lost || jsonb_build_object('doctors', coalesce(v_set->'doctors'->>'t', ''));
          update public.visits set sheet_cells = jsonb_set(jsonb_set(sheet_cells, '{doctors,t}', 'null'::jsonb),
                                    '{doctors,ids}', coalesce((select jsonb_agg(x) from jsonb_array_elements(sheet_cells->'doctors'->'ids') x where x <> to_jsonb(r.id::text)), '[]'::jsonb))
           where id = n.id;
        elsif n.status <> 'completed' then
          v_pend := array_append(v_pend, r.id::text);
          v_msgs := v_msgs || format('%s is outside this month''s doctor group. The name stays in the row; the website adds it when the visit is marked Completed (owner rule).', r.display_name); v_level := 'warn';
        else
          update public.visits set protocol_override_by = p_admin,
                 protocol_override_reason = coalesce(protocol_override_reason, private.aaj_override_reason())
           where id = n.id and protocol_override_by is null;
          insert into public.visit_staff (visit_id, clinician_id, role) values (n.id, r.id, case when r.is_doctor then 'doctor' else 'assistant' end::public.visit_staff_role);
          -- the owner's rule working, nothing for staff to do: a tick, not counted as "need attention" (RS13-M1)
          v_msgs := v_msgs || format('%s is outside this month''s doctor group. Saved because the visit is Completed in the sheet (owner rule).', r.display_name); v_over := array_append(v_over, 'group'::text);
        end if;
      end;
    end loop;
    update public.visits set sheet_cells = jsonb_set(sheet_cells, '{doctors,pending}', to_jsonb(v_pend))
     where id = n.id and sheet_cells->'doctors' is not null and coalesce(sheet_cells->'doctors'->'pending', '[]'::jsonb) is distinct from to_jsonb(v_pend);
  end if;

  -- ---- P.P, Healthwire and Reminder: staff-only text, kept apart from the visit row ----
  if v_set ? 'pp' or v_set ? 'healthwire' or v_set ? 'reminder' then
    insert into private.aaj_visit_text (visit_id, pp, healthwire, reminder)
    values (n.id, v_set->>'pp', v_set->>'healthwire', v_set->>'reminder')
    on conflict (visit_id) do update set
      pp = case when v_set ? 'pp' then excluded.pp else private.aaj_visit_text.pp end,
      healthwire = case when v_set ? 'healthwire' then excluded.healthwire else private.aaj_visit_text.healthwire end,
      reminder = case when v_set ? 'reminder' then excluded.reminder else private.aaj_visit_text.reminder end;
  end if;

  -- ---- the patient's empty phone is filled from the sheet, never changed: only by the row that made this visit just now (never by a row that
  --      only met a visit the website already had, nor by a later edit), and that row's name fits the patient without doubt (a row that fits
  --      only with doubt is refused before this: abuse-privacy M2), so a typed phone cannot be slipped into another person's file ----
  if v_create and v_pc is null and v_set ? 'phone' and private.aaj_norm_phone(v_set->>'phone') is not null then
    update public.patients set phone = private.aaj_norm_phone(v_set->>'phone') where id = n.patient_id and phone is null;
  end if;

  -- ---- what changed, for the audit log and the answer ----
  if v_create then
    v_changed := array['created'];
  else
    v_changed := array_remove(array[
      case when n.status is distinct from v.status then 'status' end,
      case when n.treatment_label is distinct from v.treatment_label then 'treatment' end,
      case when n.details_text is distinct from v.details_text then 'details' end,
      case when n.token_no is distinct from v.token_no then 'token' end,
      case when (n.braces_month, n.braces_case_id) is distinct from (v.braces_month, v.braces_case_id) then 'month' end,
      case when n.doctor_group_id is distinct from v.doctor_group_id then 'group' end,
      case when (v_dwant or v_padd) and private.aaj_canon(n.id)->>'doctors' is distinct from c->>'doctors' then 'doctors' end,
      case when n.sheet_key is distinct from v.sheet_key then 'linked' end,
      case when n.sheet_cells is distinct from v.sheet_cells then 'sheet_cells' end], null);
    if v_outcome = 'updated' and cardinality(v_changed) = 0 and not v_dirty then v_outcome := 'unchanged'; end if;
  end if;
  if v_create or cardinality(v_changed) > 0 or cardinality(v_over) > 0 or v_outcome = 'linked' or v_lost <> '{}'::jsonb then
    insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
    values ('visits', n.id::text, 'SHEET_SYNC', c,
            jsonb_build_object('tab', p_tab, 'key', v_key, 'outcome', v_outcome, 'changed', to_jsonb(v_changed), 'kept_website', to_jsonb(v_kept),
                               'sheet_text_not_applied', v_lost, 'overrides', to_jsonb(v_over), 'patient_created', v_pc),
            private.aaj_sync_actor());
  end if;

  return private.aaj_result(v_key, v_outcome, v_level, array_to_string(v_msgs, ' '), n.id, v_kept, null, v_pc);
end $$;

-- ---------------------------------------------------------------------
-- 10. The one door: public.aaj_sync(secret, payload)
-- ---------------------------------------------------------------------
create or replace function public.aaj_sync(p_secret text, p_payload jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare
  v_date date; v_today date := (now() at time zone 'Asia/Karachi')::date;
  v_admin uuid; v_rules text;
  v_check_removed boolean;
  v_tab jsonb; v_row jsonb; v_branch smallint; v_code text; v_tabname text; v_present text[]; v_has_present boolean; v_branches text[] := '{}';
  v_doubled text[];
  v_res jsonb; v_results jsonb; v_removed jsonb; v_list jsonb; v_hash text; v_nrows int; v_first_err text; v_detail text; v_problems int;
  v_tabs_out jsonb := '[]'::jsonb; v_tab_out jsonb; v_unchanged boolean; v_total_rows int := 0; r record; v_force_list boolean := false;
begin
  if p_secret is null or not exists (
       select 1 from private.sync_secrets where name = 'aaj_sheet_sync' and secret_hash = encode(digest(p_secret, 'sha256'), 'hex')) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if not pg_try_advisory_xact_lock(hashtext('aaj_sync')) then
    raise exception 'BUSY' using errcode = '55P03';
  end if;
  -- a rate limit on the door itself: a tick makes a handful of calls, even a first sync of 500 rows is 20
  delete from private.aaj_sync_calls where at < clock_timestamp() - interval '10 minutes';
  insert into private.aaj_sync_calls default values;
  if (select count(*) from private.aaj_sync_calls where at > clock_timestamp() - interval '1 minute')
       > coalesce((select value::int from private.aaj_sync_config where key = 'calls_per_minute'), 90) then
    raise exception 'RATE_LIMIT: too many calls in a minute' using errcode = '54000';
  end if;

  -- shape, date, limits
  if jsonb_typeof(p_payload) is distinct from 'object' or jsonb_typeof(p_payload->'tabs') is distinct from 'array' then
    raise exception 'BAD_PAYLOAD: tabs must be a list' using errcode = '22023';
  end if;
  if length(p_payload::text) > 300000 then raise exception 'PAYLOAD_TOO_LARGE: more than 300 KB' using errcode = '22023'; end if;
  begin
    if (p_payload->>'date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'not a date'; end if;      -- not 'today', 'yesterday', 'infinity' ...
    v_date := (p_payload->>'date')::date;
  exception when others then
    raise exception 'BAD_PAYLOAD: date is missing or not a date' using errcode = '22023';
  end;
  if v_date is null then raise exception 'BAD_PAYLOAD: date is missing or not a date' using errcode = '22023'; end if;
  if not private.aaj_date_ok(v_date) then raise exception 'DATE_NOT_ALLOWED' using errcode = '22023'; end if;
  v_check_removed := coalesce(p_payload->>'check_removed', 'false') = 'true';
  if jsonb_array_length(p_payload->'tabs') > 5 then raise exception 'PAYLOAD_TOO_LARGE: more than 5 tabs' using errcode = '22023'; end if;
  for v_tab in select value from jsonb_array_elements(p_payload->'tabs') loop
    if jsonb_typeof(v_tab) is distinct from 'object' or jsonb_typeof(v_tab->'branch') is distinct from 'string'
       or (v_tab ? 'rows' and jsonb_typeof(v_tab->'rows') not in ('array', 'null'))
       or (v_tab ? 'present' and jsonb_typeof(v_tab->'present') not in ('array', 'null'))
       or (v_tab ? 'doubled' and jsonb_typeof(v_tab->'doubled') not in ('array', 'null')) then
      raise exception 'BAD_PAYLOAD: every tab needs a branch, rows and present as lists' using errcode = '22023';
    end if;
    if (v_tab->>'branch') = any (v_branches) then raise exception 'PAYLOAD_TOO_LARGE: a branch appears twice' using errcode = '22023'; end if;
    v_branches := v_branches || (v_tab->>'branch');
    if jsonb_array_length(coalesce(nullif(v_tab->'present', 'null'::jsonb), '[]'::jsonb)) > 400
       or jsonb_array_length(coalesce(nullif(v_tab->'doubled', 'null'::jsonb), '[]'::jsonb)) > 400 then
      raise exception 'PAYLOAD_TOO_LARGE: more than 400 rows in a tab' using errcode = '22023';
    end if;
    v_total_rows := v_total_rows + jsonb_array_length(coalesce(nullif(v_tab->'rows', 'null'::jsonb), '[]'::jsonb));
  end loop;
  if v_total_rows > 25 then raise exception 'PAYLOAD_TOO_LARGE: more than 25 rows in one call' using errcode = '22023'; end if;
  foreach v_code in array v_branches loop
    -- only the five tabs of the sheet
    if private.aaj_tab_name(v_code) is null or not exists (select 1 from public.branches where code = v_code and active) then
      raise exception 'UNKNOWN_BRANCH: %', left(v_code, 20) using errcode = '22023';
    end if;
  end loop;

  select id into v_admin from public.staff where role = 'admin' and active order by created_at limit 1;
  v_rules := coalesce((select value from private.aaj_sync_config where key = 'rules'), 'override');
  perform set_config('aaj.refused', '0', true);      -- refused lookups in this call (aaj_sync_row stops looking after 5)

  for v_tab in select value from jsonb_array_elements(p_payload->'tabs') loop
    v_code := v_tab->>'branch'; v_tabname := private.aaj_tab_name(v_code);        -- never the tab name the caller sent
    select id into v_branch from public.branches where code = v_code;
    v_has_present := jsonb_typeof(v_tab->'present') = 'array';
    v_present := coalesce(array(select k from jsonb_array_elements_text(coalesce(nullif(v_tab->'present', 'null'::jsonb), '[]'::jsonb)) k where length(k) <= 60), '{}');
    -- keys the tab has on two rows that show the same Mr#, name and phone (the script leaves the lower one out of present and does not send it)
    v_doubled := coalesce(array(select k from jsonb_array_elements_text(coalesce(nullif(v_tab->'doubled', 'null'::jsonb), '[]'::jsonb)) k
                                 where length(k) <= 60 and k = any (v_present)), '{}');
    v_detail := null;

    -- a visit or checkup made on the website is claimed the first time its key shows up in the tab
    update public.visits set sheet_key = 'W-' || id::text
     where branch_id = v_branch and visit_date = v_date and sheet_key is null and ('W-' || id::text) = any (v_present);
    update public.checkups set sheet_key = 'W-' || id::text
     where branch_id = v_branch and checkup_date = v_date and sheet_key is null and ('W-' || id::text) = any (v_present);
    -- a deleted row that came back in the sheet (Ctrl+Z): the visit or checkup it removed is put back under its key, once.
    -- A restore that cannot be done never stops the call: something it pointed at is gone since (the braces case was deleted: "failed"), or
    -- it cannot be done now (the patient was typed again in another row and has a visit on this list again: "skipped"). It is written down
    -- (so it is not tried again at every call, nor done later behind the sheet's back when the other visit goes) and the row then reads
    -- "deleted on the website, delete this row": the list is sent in that call even though it did not change (the script still shows the
    -- row's old tick otherwise, loop 6; sheet-behaviour RSG-2, 11 Oct 2026).
    v_force_list := false;
    if v_has_present and cardinality(v_present) > 0 then
      for r in select a.id, a.table_name, a.row_id from public.audit_log a
                where a.action = 'SHEET_REMOVED' and a.new_data->>'action' = 'deleted' and a.new_data->>'key' = any (v_present)
                  and a.new_data->>'branch' = v_code and a.new_data->>'date' = v_date::text and a.at > now() - interval '3 days'
                  and not exists (select 1 from public.audit_log b where b.action = 'SHEET_RESTORED' and b.new_data->>'audit' = a.id::text)
                order by a.id loop
        begin
          if not private.aaj_restore_removed(r.id, true) then
            insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
            values (r.table_name, r.row_id, 'SHEET_RESTORED', null,
                    jsonb_build_object('audit', r.id, 'skipped', true, 'why', 'not put back: the patient has another visit on this list now, or the record it needs is gone'),
                    private.aaj_sync_actor());
            v_force_list := true;
          end if;
        exception when others then
          insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
          values (r.table_name, r.row_id, 'SHEET_RESTORED', null,
                  jsonb_build_object('audit', r.id, 'failed', true, 'error', left(sqlerrm, 200)), private.aaj_sync_actor());
          v_force_list := true;
        end;
      end loop;
      -- a deleted row whose visit was KEPT and marked Cancelled (something hangs on it), brought back with Ctrl+Z after the sync had put the
      -- row back itself: the key is on two rows now ("doubled"). The visit gets its status back unless it was changed since (aaj_restore_kept).
      -- Tried once: what could not be done is written down ("skipped") and the visit stays as front desk left it (sheet-behaviour RV-3).
      for r in select a.id, a.table_name, a.row_id from public.audit_log a
                where a.action = 'SHEET_REMOVED' and a.new_data->>'action' = 'kept_cancelled' and a.new_data->>'key' = any (v_doubled)
                  and a.new_data->>'branch' = v_code and a.new_data->>'date' = v_date::text and a.at > now() - interval '3 days'
                  and not exists (select 1 from public.audit_log b where b.action = 'SHEET_RESTORED' and b.new_data->>'audit' = a.id::text)
                order by a.id loop
        begin
          if not private.aaj_restore_kept(r.id) then
            insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
            values (r.table_name, r.row_id, 'SHEET_RESTORED', null,
                    jsonb_build_object('audit', r.id, 'skipped', true, 'why', 'status not put back: the visit was changed on the website since it was kept and marked Cancelled'),
                    private.aaj_sync_actor());
          end if;
        exception when others then
          insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
          values (r.table_name, r.row_id, 'SHEET_RESTORED', null,
                  jsonb_build_object('audit', r.id, 'failed', true, 'error', left(sqlerrm, 200)), private.aaj_sync_actor());
        end;
      end loop;
    end if;

    v_results := '[]'::jsonb; v_nrows := 0;
    for v_row in select value from jsonb_array_elements(coalesce(nullif(v_tab->'rows', 'null'::jsonb), '[]'::jsonb)) with ordinality t(value, o) order by o loop
      v_nrows := v_nrows + 1;
      begin
        v_res := private.aaj_sync_row(v_branch, v_tabname, v_date, v_row, v_present, v_admin, v_rules);
      exception when others then
        v_detail := coalesce(v_detail, left(sqlerrm, 300));
        v_res := private.aaj_result(left(coalesce(v_row->>'key', ''), 60), 'error', 'error', private.aaj_err_text(sqlstate, sqlerrm));
      end;
      v_results := v_results || v_res;
    end loop;

    -- released records (sheet-behaviour RS5-D4): a visit or checkup whose row is on the sheet again is not released any more; a claimed one
    -- that is Cancelled and whose row has left the sheet is released: never a removal (not even after it is set to work again on the
    -- website), and the sheet gets it back as a website row only once it works again. Done in every call that lists the tab's rows (a row
    -- that only moves keeps or regains its key, which takes the mark away again), before the removals, which release a kept No show.
    if v_has_present and v_date = v_today then
      -- (only this tab's own records: a key copied into another branch's tab does not take a mark away, abuse-privacy minor, loop 6)
      delete from private.aaj_released rl using public.visits x
       where rl.visit_id = x.id and x.sheet_key = any (v_present) and x.branch_id = v_branch and x.visit_date = v_date;
      delete from private.aaj_released rl using public.checkups x
       where rl.checkup_id = x.id and x.sheet_key = any (v_present) and x.branch_id = v_branch and x.checkup_date = v_date;
      insert into private.aaj_released (visit_id, sheet_key, status)
      select x.id, x.sheet_key, x.status::text from public.visits x
       where x.branch_id = v_branch and x.visit_date = v_date and x.sheet_key is not null and not (x.sheet_key = any (v_present)) and x.status = 'cancelled'
      on conflict do nothing;
      insert into private.aaj_released (checkup_id, sheet_key, status)
      select x.id, x.sheet_key, x.day_status from public.checkups x
       where x.branch_id = v_branch and x.checkup_date = v_date and x.source <> 'archive' and not x.date_is_month
         and x.sheet_key is not null and not (x.sheet_key = any (v_present)) and x.day_status = 'cancelled'
      on conflict do nothing;
    end if;

    v_removed := '[]'::jsonb;
    if v_check_removed and v_date = v_today and v_has_present then
      v_removed := private.aaj_removals(v_branch, v_date, v_tabname, v_present);
    end if;

    v_list := private.aaj_day_list(v_branch, v_date);
    v_hash := md5(v_list::text);
    v_unchanged := (v_nrows = 0 and (v_tab->>'hash') is not distinct from v_hash and jsonb_array_length(v_removed) = 0     -- rows to put back need the list
                    and not v_force_list);

    select count(*) filter (where x->>'level' = 'error'), (array_agg(x->>'message') filter (where x->>'level' = 'error'))[1]
      into v_problems, v_first_err from jsonb_array_elements(v_results) x;
    insert into private.aaj_sync_state (branch_id, list_date, last_call_at, rows_present, last_problems, last_error, last_detail)
    values (v_branch, v_date, now(), case when v_has_present then cardinality(v_present) end, v_problems, v_first_err, v_detail)
    on conflict (branch_id) do update set list_date = excluded.list_date, last_call_at = excluded.last_call_at,
      rows_present = coalesce(excluded.rows_present, private.aaj_sync_state.rows_present),
      last_problems = excluded.last_problems, last_error = excluded.last_error, last_detail = excluded.last_detail;

    v_tab_out := jsonb_build_object('branch', v_code, 'hash', v_hash, 'unchanged', v_unchanged, 'results', v_results, 'removed', v_removed);
    if not v_unchanged then v_tab_out := v_tab_out || jsonb_build_object('visits', v_list); end if;
    v_tabs_out := v_tabs_out || v_tab_out;
  end loop;

  return jsonb_build_object('ok', true, 'date', v_date, 'server_time', now(), 'tabs', v_tabs_out);
end $$;

-- ---------------------------------------------------------------------
-- 11. import_aaj_sheet: the same function as 20261007001600, except for who the patient is
--     (owner rules 3 and 4, and "not guess", 9 Oct 2026):
--       * a row with an Mr# is that patient when its name fits them without doubt (the sync's
--         check, private.aaj_check_mr); otherwise it comes back as unmatched ("Mr# belongs to
--         another patient", or for a name that fits only with doubt "the name only partly
--         matches Mr# N (...)"): no visit, no braces case. An Mr# the website does not have is never
--         matched by phone or name to a patient with another Mr# (it is made with "Add
--         patient records" when it is a Healthwire number, 1 to 49999 and at most the highest
--         Healthwire number the website has plus 100, otherwise it comes back as unmatched: an
--         Mr# of 50000 or more, or above that limit, is a typo). It is not made either, and
--         comes back as unmatched with the reason, when the sync refused it for who it is
--         (private.aaj_check_mr): its exact name and phone are filed under another Mr#
--         (mr_other: "this name and phone are Mr# N"), or it is a retired Mr# whose patient
--         its whole name fits (mr_moved: "Mr# was renumbered to 50003" / "Mr# was merged into N").
--         The other rows of that Mr# in the file are held back with it (one of them would
--         otherwise make the duplicate file);
--       * a row without an Mr# is matched only by its phone and first name, through
--         private.aaj_find_patient (a phone shared by a family never picks "the first
--         patient", two same-name patients on one phone are never guessed between), never by
--         a name alone, and never gets a patient file;
--       * a row without an Mr# whose Treatment says checkup is a checkup patient, not a visit:
--         it is skipped and counted in "checkups_skipped" (Admin -> Import -> 5. Checkup list).
-- ---------------------------------------------------------------------
create or replace function public.import_aaj_sheet(p_rows jsonb, p_create_patients boolean default false)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_admin uuid;
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  n_future int := 0; n_pat int := 0; n_vis int := 0; n_upd int := 0; n_staff int := 0; n_cases int := 0; n_tok int := 0;
  n_matched int := 0; n_unmatched int := 0; n_ck int := 0;
  v_unmatched jsonb;
  v_cases jsonb;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only Dr. Ali can import the Aaj ki List' using errcode = '42501';
  end if;
  select id into v_admin from public.staff where role = 'admin' order by created_at limit 1;

  -- Temp tables are kept for the session and emptied on every call, so the function can run many times (one batch each).
  create temp table if not exists aaj (
    rn bigint, d date, branch smallint, mr text, name text, legacy_name text, phone text, month smallint, treatment text, token int,
    status public.visit_status, grp smallint, doctors jsonb, assistants jsonb, unmatched jsonb, details text, reminder text, tab text,
    photo boolean, tid smallint, patient_id uuid, visit_id uuid, case_id uuid, dup boolean default false, amb boolean default false, fam boolean default false,
    clash boolean default false, differs boolean default false, chk jsonb, why text);
  alter table aaj add column if not exists amb boolean default false;
  alter table aaj add column if not exists fam boolean default false;
  alter table aaj add column if not exists clash boolean default false;
  alter table aaj add column if not exists differs boolean default false;
  alter table aaj add column if not exists chk jsonb;
  alter table aaj add column if not exists why text;
  truncate aaj;
  insert into aaj (rn, d, branch, mr, name, legacy_name, phone, month, treatment, token, status, grp, doctors, assistants, unmatched, details, reminder, tab, photo, tid)
    select row_number() over (), (r->>0)::date, (r->>1)::smallint, case when upper(btrim(r->>2)) = 'NEW' then null else nullif(btrim(r->>2), '') end, btrim(r->>3),
           nullif(r->>4, ''), nullif(r->>5, ''), nullif(r->>6, '')::smallint, nullif(btrim(r->>7), ''),
           nullif(r->>8, '')::int, coalesce(nullif(r->>9, ''), 'completed')::public.visit_status, nullif(r->>10, '')::smallint,
           coalesce(r->11, '[]'), coalesce(r->12, '[]'), coalesce(r->13, '[]'), nullif(r->>14, ''),
           nullif(r->>15, ''), coalesce(r->>16, 'sheet'), coalesce((r->>17)::boolean, false), nullif(r->>18, '')::smallint
      from jsonb_array_elements(p_rows) r
     where btrim(coalesce(r->>3, '')) <> '' and (r->>0)::date < v_today;
  -- Rows dated today or later belong to the live sheet.
  select count(*) into n_future from jsonb_array_elements(p_rows) r where btrim(coalesce(r->>3, '')) <> '' and (r->>0)::date >= v_today;
  -- A row without an Mr# whose Treatment says checkup is a checkup patient (owner, 9 Oct 2026): never a visit, never a patient file.
  with ck as (delete from aaj where mr is null and private.aaj_is_checkup_text(treatment) returning 1)
  select count(*) into n_ck from ck;

  -- 1. Who is the patient: the Mr#; a row without an Mr# by its phone and first name (never a guess between several people, never a name
  --    alone). A row whose Mr# the website does not have is not matched to anybody else: the Mr# says it is somebody else.
  --    The Mr# is checked the way the sync checks it (private.aaj_check_mr): the name in the row fits that patient without doubt. A row
  --    typed with another patient's Mr# (the sync refused it, and it was archived as it was) is never filed on that patient: it is reported
  --    back as "Mr# belongs to another patient". So is a row whose name fits only with doubt (the same first name with another surname, a
  --    slip or another first name, only the patient's phone), with that reason (orchestrator decision, 11 Oct 2026). (The name exactly as
  --    the patient file has it, letter for letter, is that patient too: an Urdu name the check cannot read.)
  update aaj a set patient_id = p.id from public.patients p
   where a.mr is not null and p.mr_number = a.mr and lower(regexp_replace(btrim(a.name), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(p.full_name), '\s+', ' ', 'g'));
  update aaj a set chk = private.aaj_check_mr(a.branch, a.d, a.mr, a.name, a.phone) where a.mr is not null and a.patient_id is null;
  update aaj a set patient_id = (a.chk->>'patient_id')::uuid where a.chk->>'outcome' = 'mr';
  update aaj a set clash = true where a.mr is not null and a.patient_id is null and exists (select 1 from public.patients p where p.mr_number = a.mr);
  update aaj a set why = 'the name only partly matches Mr# ' || a.mr || ' (' || coalesce(a.chk->>'name', '?') || '): another surname, another first name or only the phone. Check the Mr# or the name'
   where a.patient_id is null and a.why is null and coalesce((a.chk->>'doubt')::boolean, false);
  -- An Mr# the website does not have, refused by the sync for who it is: never a new patient file (step 2), reported back with why.
  --   mr_other: the row's exact name and phone are another Mr#'s patient (the second file would be the same person under a wrong number);
  --   mr_moved: a retired Mr# (renumbered to 50000+, or merged away) typed with a name that fits its patient.
  -- The other rows of that Mr# in the file are held back too: a sibling row without the phone would otherwise make that very file.
  update aaj a set why = case a.chk->>'outcome'
                           when 'mr_other' then 'this name and phone are Mr# ' || (a.chk->>'mr')
                           when 'mr_moved' then case a.chk->>'how' when 'merged' then 'Mr# was merged into ' else 'Mr# was renumbered to ' end || (a.chk->>'mr') end
   where a.patient_id is null and a.chk->>'outcome' in ('mr_other', 'mr_moved');
  -- an Mr# of 50000 or more that the website never gave is a typo (the website's own numbers start at 50000): reported back with that reason
  update aaj a set why = 'an Mr# of 50000 or more that the website never gave (a typo)'
   where a.patient_id is null and a.why is null and a.chk->>'outcome' = 'mr_typo';
  -- a Healthwire number above aaj_hw_limit() (the sync's rule, abuse-privacy M-HW-SQUAT): Healthwire has not given it yet, so it is a typo,
  -- or a patient of Healthwire's newer than its last import: never a new file here, reported back with why
  update aaj a set why = 'an Mr# above the newest Healthwire number the website takes (' || private.aaj_hw_limit() || '): probably a typo. Check the Mr#, or import the Healthwire patients first'
   where a.patient_id is null and a.why is null and a.chk->>'outcome' = 'mr_ahead';
  update aaj a set why = 'held back with the other row of this Mr# (' || (select min(o.why) from aaj o where o.mr = a.mr and o.why is not null) || ')'
   where a.why is null and a.patient_id is null and a.mr is not null and not a.clash
     and exists (select 1 from aaj o where o.mr = a.mr and o.why is not null);
  -- A row without an Mr# whose phone has exactly one patient of that first name (phone_first) is that patient only when the surnames do not
  -- conflict: "Ali Raza" is not his brother "Ali Hamza" on the family phone (the sync answers such a row "add the Mr#", abuse-privacy M2). It
  -- is then filed with the note to check the Mr# (differs), so its Month never starts or joins a braces case (step 4).
  update aaj a set
      patient_id = case when f.o = 'phone_name' or (f.o = 'phone_first' and not f.clash) then (f.r->>'patient_id')::uuid end,
      differs = case when f.o = 'phone_first' and not f.clash then coalesce((f.r->>'name_differs')::boolean, true) else a.differs end,
      why = case when f.o = 'phone_first' and f.clash then 'add the Mr# (another person with this first name is on this phone)' else a.why end,
      amb = (f.o = 'ambiguous'),
      fam = (f.o = 'phone_others')
    from (select x.rn, x.r, x.r->>'outcome' as o,
                 coalesce(private.aaj_names_conflict(x.name, (select p.full_name from public.patients p where p.id = (x.r->>'patient_id')::uuid)), false) as clash
            from (select b.rn, b.name, private.aaj_find_patient(b.name, b.phone) as r from aaj b where b.patient_id is null and b.mr is null and b.phone is not null) x) f
   where a.rn = f.rn;

  -- 2. Unknown patients: added only when asked, and only for a row with a Healthwire Mr# (1 to 49999) that the website does not have yet
  --    (the sync's own rule). A row without an Mr# (left after the checkups) is an existing patient whose Mr# was forgotten (owner rule 4,
  --    and his clarification of 9 Oct 2026): never a new patient file. An Mr# of 50000 or more that the website does not have is a typing
  --    mistake (the website's own numbers start at 50000; owner rule 3): never a new patient file either, and nor is a Healthwire number above
  --    the highest one the website has plus 100 (step 1 gave it a why, the sync's rule). Nor is an Mr# whose rows were
  --    refused for who they are (why: the same name and phone under another Mr#, a retired Mr# of the patient whose whole name it has). Those rows
  --    are reported back.
  if p_create_patients then
    with grp as (
      select mr k, min(rn) rn, min(d) first_d
        from aaj where patient_id is null and not amb and not clash and why is null and mr ~ '^[1-9][0-9]{0,4}$'
                   and (case when mr ~ '^[1-9][0-9]{0,4}$' then mr::int end) < 50000 group by 1),
    ins as (
      insert into public.patients (mr_number, full_name, phone, first_branch_id, legacy_source, legacy_name, notes, created_at)
      select a.mr, a.name, a.phone, a.branch, 'aaj_ki_list', coalesce(a.legacy_name, a.name),
             'Added from the Aaj ki List (' || a.tab || ', first seen ' || to_char(g.first_d, 'DD Mon YYYY') || ')', g.first_d::timestamptz
        from grp g join aaj a on a.rn = g.rn
       where not exists (select 1 from public.patients p where p.mr_number = a.mr)
      returning 1)
    select count(*) into n_pat from ins;
    -- the other rows of that Mr# are the patient just made when their name fits it (the same check as step 1); another name is reported back
    update aaj a set patient_id = p.id from public.patients p
     where a.patient_id is null and a.mr is not null and not a.clash and a.why is null and p.mr_number = a.mr
       and lower(regexp_replace(btrim(a.name), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(p.full_name), '\s+', ' ', 'g'));
    update aaj a set chk = f.r, patient_id = case when f.r->>'outcome' = 'mr' then (f.r->>'patient_id')::uuid end
      from (select b.rn, private.aaj_check_mr(b.branch, b.d, b.mr, b.name, b.phone) as r from aaj b
             where b.patient_id is null and b.mr is not null and not b.clash and b.why is null) f
     where a.rn = f.rn;
    update aaj a set clash = true where a.mr is not null and a.patient_id is null and exists (select 1 from public.patients p where p.mr_number = a.mr);
    update aaj a set why = 'the name only partly matches Mr# ' || a.mr || ' (' || coalesce(a.chk->>'name', '?') || '): another surname, another first name or only the phone. Check the Mr# or the name'
     where a.patient_id is null and a.why is null and coalesce((a.chk->>'doubt')::boolean, false);
    -- the same person on another day of the file without the Mr# (same phone, same full name) is the patient just made
    update aaj a set patient_id = (
        select p.id from public.patients p
         where private.aaj_norm_phone(p.phone) = private.aaj_norm_phone(a.phone) and private.aaj_norm_name(p.full_name) = private.aaj_norm_name(a.name)
         order by p.created_at desc limit 1)
     where a.patient_id is null and a.mr is null and not a.amb and a.phone is not null;
  end if;

  select count(distinct patient_id), count(*) filter (where patient_id is null) into n_matched, n_unmatched from aaj;
  -- (the dedupe below only marks rows; counts above are per sheet row)
  select coalesce(jsonb_agg(x), '[]') into v_unmatched from (
    select jsonb_build_object('name', name, 'mr', mr, 'phone', phone, 'rows', count(*), 'first', min(d), 'last', max(d), 'tab', min(tab),
                              'why', coalesce(min(why), case when bool_or(clash) then 'Mr# belongs to another patient' end)) x
      from aaj where patient_id is null group by name, mr, phone order by count(*) desc, name limit 300) s;

  -- 3. Two rows for the same patient on the same day become one visit.
  update aaj a set
    details = concat_ws(' · ', a.details, (select string_agg(concat_ws(' ', o.treatment, o.details), ' · ' order by o.rn) from aaj o where o.patient_id = a.patient_id and o.d = a.d and o.rn <> a.rn)),
    doctors = a.doctors || coalesce((select jsonb_agg(x) from aaj o, jsonb_array_elements(o.doctors) x where o.patient_id = a.patient_id and o.d = a.d and o.rn <> a.rn), '[]'),
    assistants = a.assistants || coalesce((select jsonb_agg(x) from aaj o, jsonb_array_elements(o.assistants) x where o.patient_id = a.patient_id and o.d = a.d and o.rn <> a.rn), '[]'),
    unmatched = a.unmatched || coalesce((select jsonb_agg(x) from aaj o, jsonb_array_elements(o.unmatched) x where o.patient_id = a.patient_id and o.d = a.d and o.rn <> a.rn), '[]'),
    month = coalesce(a.month, (select max(o.month) from aaj o where o.patient_id = a.patient_id and o.d = a.d)),
    token = coalesce(a.token, (select min(o.token) from aaj o where o.patient_id = a.patient_id and o.d = a.d)),
    -- a day with a row filed by its phone and first name only is a day to check: no braces case from its Month either (step 4)
    differs = a.differs or exists (select 1 from aaj o where o.patient_id = a.patient_id and o.d = a.d and o.rn <> a.rn and o.differs)
  where a.patient_id is not null
    and a.rn = (select min(o.rn) from aaj o where o.patient_id = a.patient_id and o.d = a.d)
    and exists (select 1 from aaj o where o.patient_id = a.patient_id and o.d = a.d and o.rn <> a.rn);
  update aaj a set dup = true where a.patient_id is not null and a.rn > (select min(o.rn) from aaj o where o.patient_id = a.patient_id and o.d = a.d);

  -- 4. Braces case for the month rows: the active one, else the case running on that date, else a new one from the history.
  --    Never for a row without an Mr# filed by its phone and first name only (differs: "Ali" on the phone of "Ali Hamza"): it may be
  --    another person of that family, so its Month stays in the visit's notes ("Month 5") (abuse-privacy M1). Put the Mr# in the file and
  --    import it again to file the Month. (A row WITH an Mr# whose name fits only with doubt is not filed at all: step 1.)
  update aaj a set case_id = (select b.id from public.braces_cases b where b.patient_id = a.patient_id and b.status = 'active' limit 1)
   where a.month is not null and a.patient_id is not null and not a.dup and not a.differs;
  update aaj a set case_id = (select b.id from public.braces_cases b where b.patient_id = a.patient_id and b.start_date <= a.d + 7 order by b.start_date desc limit 1)
   where a.month is not null and a.patient_id is not null and a.case_id is null and not a.differs;
  with hist as (
    select a.patient_id,
           min(a.d - ((a.month - 1) * interval '30 days'))::date start_d,
           (array_agg(a.branch order by a.month, a.d))[1] branch,
           min(a.d) first_d, max(a.d) last_d
      from aaj a where a.month is not null and a.patient_id is not null and a.case_id is null and not a.dup and not a.differs
     group by a.patient_id),
  ends as (
    select h.*, (select min(x.d) from (
                   select v.visit_date d from public.visits v where v.patient_id = h.patient_id and v.visit_date >= h.last_d and coalesce(v.treatment_label, '') ~* 'braces off|debond|retainer'
                   union all
                   select a.d from aaj a where a.patient_id = h.patient_id and a.d >= h.last_d and coalesce(a.treatment, '') ~* 'braces off|debond|retainer') x) debond_d
      from hist h),
  ins as (
    insert into public.braces_cases (patient_id, start_date, bonding_branch_id, status, debond_date, notes, created_by)
    select e.patient_id, e.start_d, e.branch,
           case when e.debond_d is not null then 'debonded' when e.last_d >= v_today - 75 then 'active' else 'discontinued' end::public.braces_case_status,
           e.debond_d,
           'From the Aaj ki List history: month rows from ' || to_char(e.first_d, 'DD Mon YYYY') || ' to ' || to_char(e.last_d, 'DD Mon YYYY')
             || case when e.debond_d is not null then '; braces off ' || to_char(e.debond_d, 'DD Mon YYYY')
                     when e.last_d >= v_today - 75 then '' else '; no entry since then — check whether treatment continues' end,
           v_admin
      from ends e
     where not exists (select 1 from public.braces_cases b where b.patient_id = e.patient_id and b.status = 'active')
    returning id, patient_id, status)
  select coalesce(sum(c), 0), coalesce(jsonb_object_agg(s, c), '{}') into n_cases, v_cases from (select status s, count(*) c from ins group by status) t;
  update aaj a set case_id = (select b.id from public.braces_cases b where b.patient_id = a.patient_id order by (b.status = 'active') desc, b.start_date desc limit 1)
   where a.month is not null and a.patient_id is not null and a.case_id is null and not a.differs;
  -- A case made from an earlier batch of old rows was marked "discontinued"; rows in this batch show treatment continues.
  update public.braces_cases b set status = 'active', notes = concat_ws(' · ', b.notes, 'Entries continue to ' || to_char(m.last_d, 'DD Mon YYYY'))
    from (select a.case_id, max(a.d) last_d from aaj a where a.case_id is not null and not a.dup and a.month is not null group by a.case_id) m
   where b.id = m.case_id and b.status = 'discontinued' and b.notes like 'From the Aaj ki List history%' and m.last_d >= v_today - 75
     and not exists (select 1 from public.braces_cases x where x.patient_id = b.patient_id and x.status = 'active');

  -- 5. The visit: complete the one already there for that day, otherwise add it.
  update aaj a set visit_id = (select v.id from public.visits v where v.patient_id = a.patient_id and v.visit_date = a.d order by (v.branch_id = a.branch) desc, v.created_at limit 1)
   where a.patient_id is not null and not a.dup;
  with upd as (
    update public.visits v set
      treatment_label = coalesce(v.treatment_label, a.treatment),
      treatment_id = coalesce(v.treatment_id, a.tid),
      details_text = coalesce(nullif(v.details_text, ''), a.details),
      braces_case_id = coalesce(v.braces_case_id, a.case_id),
      braces_month = coalesce(v.braces_month, case when coalesce(v.braces_case_id, a.case_id) is not null and not a.differs then a.month end),
      doctor_group_id = coalesce(v.doctor_group_id, a.grp),
      protocol_override_by = coalesce(v.protocol_override_by, v_admin),
      protocol_override_reason = coalesce(v.protocol_override_reason, 'Imported from the Aaj ki List'),
      notes = concat_ws(' · ', v.notes, 'Aaj ki List (' || a.tab || ')',
                case when a.month is not null and (coalesce(v.braces_case_id, a.case_id) is null or a.differs) then 'Month ' || a.month end,
                case when a.treatment is not null and v.treatment_label is not null and lower(v.treatment_label) <> lower(a.treatment) then 'Sheet: ' || a.treatment end,
                case when jsonb_array_length(a.unmatched) > 0 then 'Also: ' || (select string_agg(x, ', ') from jsonb_array_elements_text(a.unmatched) x) end,
                case when a.reminder is not null then 'Reminder: ' || a.reminder end,
                case when a.differs then 'Sheet name: ' || a.name || ' (check the Mr#)' end)
      from aaj a
     where v.id = a.visit_id and not a.dup and (v.notes is null or v.notes not like '%Aaj ki List (%')
    returning 1)
  select count(*) into n_upd from upd;
  with ins as (
    insert into public.visits (patient_id, branch_id, visit_date, status, treatment_id, treatment_label, braces_case_id, braces_month, doctor_group_id, details_text, notes,
                               legacy_source, protocol_override_by, protocol_override_reason, dues_override_by, dues_override_reason, completed_at, created_at, created_by)
    select a.patient_id, a.branch, a.d, a.status, a.tid, a.treatment, a.case_id, case when a.case_id is not null then a.month end, a.grp, a.details,
           concat_ws(' · ', 'Aaj ki List (' || a.tab || ')',
             case when a.month is not null and a.case_id is null then 'Month ' || a.month end,
             case when jsonb_array_length(a.unmatched) > 0 then 'Also: ' || (select string_agg(x, ', ') from jsonb_array_elements_text(a.unmatched) x) end,
             case when a.reminder is not null then 'Reminder: ' || a.reminder end,
             case when a.differs then 'Sheet name: ' || a.name || ' (check the Mr#)' end),
           'aaj_ki_list', v_admin, 'Imported from the Aaj ki List', v_admin, 'Imported from the Aaj ki List',
           case when a.status = 'completed' then a.d + time '20:00' end, a.d::timestamptz, v_admin
      from aaj a where a.patient_id is not null and a.visit_id is null and not a.dup
    returning 1)
  select count(*) into n_vis from ins;
  update aaj a set visit_id = (select v.id from public.visits v where v.patient_id = a.patient_id and v.visit_date = a.d order by (v.branch_id = a.branch) desc, v.created_at limit 1)
   where a.patient_id is not null and a.visit_id is null and not a.dup;

  -- 6. Token numbers (first row wins when a day repeats one) and the people on the visit.
  with upd as (
    update public.visits v set token_no = a.token from aaj a
     where v.id = a.visit_id and not a.dup and v.token_no is null and a.token is not null
       and a.rn = (select min(o.rn) from aaj o where o.branch = a.branch and o.d = a.d and o.token = a.token and not o.dup)
       and not exists (select 1 from public.visits x where x.branch_id = v.branch_id and x.visit_date = v.visit_date and x.token_no = a.token)
    returning 1)
  select count(*) into n_tok from upd;
  with ins as (
    insert into public.visit_staff (visit_id, clinician_id, role)
    select distinct a.visit_id, (x #>> '{}')::uuid, 'doctor'::public.visit_staff_role from aaj a, jsonb_array_elements(a.doctors) x
     where a.visit_id is not null and not a.dup and exists (select 1 from public.clinicians c where c.id = (x #>> '{}')::uuid)
    union
    select distinct a.visit_id, (x #>> '{}')::uuid, 'assistant'::public.visit_staff_role from aaj a, jsonb_array_elements(a.assistants) x
     where a.visit_id is not null and not a.dup and exists (select 1 from public.clinicians c where c.id = (x #>> '{}')::uuid)
    on conflict do nothing
    returning 1)
  select count(*) into n_staff from ins;

  return jsonb_build_object('given', jsonb_array_length(p_rows), 'future', n_future, 'patients_matched', n_matched, 'rows_unmatched', n_unmatched, 'checkups_skipped', n_ck,
    'patients_created', n_pat, 'visits_inserted', n_vis, 'visits_updated', n_upd, 'tokens', n_tok, 'staff_added', n_staff,
    'cases_created', n_cases, 'cases', v_cases, 'unmatched', v_unmatched);
end $$;


-- ---------------------------------------------------------------------
-- 11b. import_checkups (Admin -> Import -> 5. Checkup list): the same function as 20261009000260, with one more rule (RW8-4): a line of the
--      nightly "Aj ki List checkups" tab whose person, month and branch are already on the website as a checkup the sheet sync or the website
--      made is skipped as "already on the website". Without it, importing that tab (docs/AAJ-SYNC-SETUP.md section 9) doubled every checkup
--      the sync had already put on the website.
-- ---------------------------------------------------------------------
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

  -- (sheet-behaviour RW8-4, 11 Oct 2026) A line the sync added at night to the "Aj ki List checkups" tab of "Checkup karwaliya" (its Source
  -- Tab says "Aj ki List - <tab>") whose person, month and branch are already on the website as a checkup the sheet sync or the website made
  -- (source 'google_sheet' / 'website') is that checkup: skipped, never a second record next to the real one. Imported as a file, that tab
  -- would otherwise give every synced checkup a second, month-level "Not Contacted" record without its follow-up notes, and the follow-up
  -- team would call those people twice. Rows of the owner's old list (any other Source Tab) are matched only with old-list rows, as before:
  -- a person on the website alone for a month still gets their old-list row.
  update checkup_import i set skip = 'Already on the website (the Google Sheet sync put this checkup there)'
    from (select distinct private.checkup_key(c.phone, c.patient_name, c.checkup_date) as k, c.branch_id from public.checkups c where c.source <> 'archive') w
   where i.skip is null and i.existing_id is null and i.source_tab ilike 'Aj ki List - %' and w.k = i.k and w.branch_id is not distinct from i.branch;

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

-- ---------------------------------------------------------------------
-- 12. The sheet link (sheet_key, sheet_cells) is written by the sync only: not by a signed-in user, not by a browser slip.
--     (The sync runs as role anon with no user, so auth.uid() is null for it, for the SQL editor and for server jobs.)
-- ---------------------------------------------------------------------
create or replace function private.guard_visit_sheet_cols() returns trigger
language plpgsql set search_path = public, extensions
as $$
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    if new.sheet_key is not null or new.sheet_cells is not null then raise exception 'The Google Sheet link is written by the sync only'; end if;
  elsif (new.sheet_key, new.sheet_cells) is distinct from (old.sheet_key, old.sheet_cells) then
    raise exception 'The Google Sheet link is written by the sync only';
  end if;
  return new;
end $$;
drop trigger if exists visits_guard_sheet_cols on public.visits;
create trigger visits_guard_sheet_cols before insert or update of sheet_key, sheet_cells on public.visits
  for each row execute function private.guard_visit_sheet_cols();

-- The same for a checkup's sheet_key: 20261009000250_checkups.sql lets a front-desk account update every column of a checkup, and the key
-- is copied into the sheet by the script. A key the sync did not make would be free text in the hidden "Sync key" column (a formula, a row
-- that is made again every minute). So only the sync (no signed-in user), the SQL editor and Dr. Ali (admin) write it. (20261009000260 has a
-- guard of its own for the same columns; the two agree, and this one also holds when that file is not applied.)
create or replace function private.guard_checkup_sheet_key() returns trigger
language plpgsql set search_path = public, extensions
as $$
begin
  -- only a signed-in person writing through the API (current_user is 'authenticated') is held back; the sync, the SQL editor, functions that
  -- run as their owner, and Dr. Ali are not (the same rule as 20261009000260)
  if current_user <> 'authenticated' or auth.uid() is null or public.is_admin() then return new; end if;
  if tg_op = 'INSERT' then
    if new.sheet_key is not null then raise exception 'The Google Sheet link is written by the sync only'; end if;
  elsif new.sheet_key is distinct from old.sheet_key then
    raise exception 'The Google Sheet link is written by the sync only';
  end if;
  return new;
end $$;
drop trigger if exists checkups_guard_sheet_key on public.checkups;
create trigger checkups_guard_sheet_key before insert or update of sheet_key on public.checkups
  for each row execute function private.guard_checkup_sheet_key();

-- A visit or checkup moved to another branch or day on the website (front desk corrects the Branch of a checkup on the Checkups page, or Dr.
-- Ali moves a visit) leaves the tab that had its row: its sheet key goes (sheet-behaviour RS8-B1). Kept, the record counted as "claimed" in
-- the new branch's tab, where no row has that key: it was never added there, and that tab's removal pass deleted it as a row deleted in the
-- sheet. Without the key it reaches the new tab as a website row ("Added from the website"), the old tab's row reads "deleted on the
-- website" (or, for a W- key, "moved to another branch or day"), and no removal pass takes it. The triggers are named so that they run after
-- the guards above and checkups_guard_columns (20261009000260), which therefore see the key unchanged: the person who moves the record does
-- not write the key, the database lets it go.
create or replace function private.aaj_release_sheet_claim() returns trigger
language plpgsql set search_path = public, extensions
as $$
begin
  new.sheet_key := null;
  return new;
end $$;
revoke all on function private.aaj_release_sheet_claim() from public, anon, authenticated;
drop trigger if exists visits_sheet_release on public.visits;
create trigger visits_sheet_release before update on public.visits
  for each row when (old.sheet_key is not null and (old.branch_id is distinct from new.branch_id or old.visit_date is distinct from new.visit_date))
  execute function private.aaj_release_sheet_claim();
drop trigger if exists checkups_sheet_release on public.checkups;
create trigger checkups_sheet_release before update on public.checkups
  for each row when (old.sheet_key is not null and (old.branch_id is distinct from new.branch_id or old.checkup_date is distinct from new.checkup_date))
  execute function private.aaj_release_sheet_claim();

-- ---------------------------------------------------------------------
-- 13. The old export (public.aaj_export, 20261006000200): its secret sits in the old script inside the same sheet, so it gets no more
--     than the new door: today's list, or yesterday's (Karachi). The answer is unchanged. The old script asks for today (no date, or
--     today's date). Delete its secret once the old script is off: delete from private.sync_secrets where name = 'aaj_sheet_export';
-- ---------------------------------------------------------------------
create or replace function public.aaj_export(p_secret text, p_date date default null)
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare v_date date := coalesce(p_date, (now() at time zone 'Asia/Karachi')::date);
begin
  if p_secret is null or not exists (
       select 1 from private.sync_secrets where name = 'aaj_sheet_export' and secret_hash = encode(digest(p_secret, 'sha256'), 'hex')) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if v_date not between (now() at time zone 'Asia/Karachi')::date - 1 and (now() at time zone 'Asia/Karachi')::date then
    raise exception 'DATE_NOT_ALLOWED: the export gives today''s list or yesterday''s only' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'date', v_date,
    'generated_at', to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI'),
    'branches', coalesce((
      select jsonb_agg(jsonb_build_object('code', b.code, 'name', b.name, 'rows', coalesce(rows.list, '[]'::jsonb)) order by b.sort_order)
        from branches b
        left join lateral (
          select jsonb_agg(jsonb_build_object(
                   'mr', p.mr_number,
                   'name', p.full_name,
                   'month', coalesce(v.braces_month::text, (regexp_match(coalesce(v.notes, ''), 'Braces month (\d+)'))[1])
                            || case when v.photo_required or coalesce(v.notes, '') ~ 'photo month' then ' Photo' else '' end,
                   'treatment', coalesce(v.treatment_label, t.name),
                   'token', v.token_no,
                   'status', case v.status when 'waiting' then 'Waiting' when 'in_treatment' then 'Treatment' when 'completed' then 'Completed'
                                           when 'scheduled' then 'Scheduled' when 'cancelled' then 'Cancelled' when 'no_show' then 'No show' end,
                   'group', coalesce(g.name, (regexp_match(coalesce(v.notes, ''), '(Group [\d, ]+)'))[1]),
                   'doctors', (select string_agg(c.display_name, ', ' order by vs.role, c.display_name)
                                 from visit_staff vs join clinicians c on c.id = vs.clinician_id
                                where vs.visit_id = v.id and vs.role in ('doctor', 'assistant')),
                   'details', v.details_text,
                   'pp', nullif(public.patient_dues(p.id), 0),
                   'phone', nullif(p.phone, '0000000'),
                   'notes', v.notes)
                 order by (v.status = 'cancelled'), v.token_no nulls last, v.created_at) as list
            from visits v
            join patients p on p.id = v.patient_id
            left join treatments t on t.id = v.treatment_id
            left join doctor_groups g on g.id = v.doctor_group_id
           where v.branch_id = b.id and v.visit_date = v_date
        ) rows on true
       where b.active), '[]'::jsonb));
end $$;

revoke all on function public.aaj_export(text, date) from public;
grant execute on function public.aaj_export(text, date) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 14. Who may call what
-- ---------------------------------------------------------------------
-- Supabase gives EXECUTE on every new public function to anon and authenticated: take it away, then give anon
-- the one door. (aaj_norm_phone keeps its default EXECUTE: the two phone indexes call it whenever staff save a patient.)
revoke all on function public.aaj_sync(text, jsonb) from public, anon, authenticated;
grant execute on function public.aaj_sync(text, jsonb) to anon;

revoke all on function public.import_aaj_sheet(jsonb, boolean) from public, anon;
grant execute on function public.import_aaj_sheet(jsonb, boolean) to authenticated;

revoke all on function public.aaj_undo_removal(bigint) from public, anon;
grant execute on function public.aaj_undo_removal(bigint) to authenticated;

revoke all on function
  private.aaj_sync_actor(), private.aaj_tab_name(text), private.aaj_norm_name(text), private.aaj_given_name(text), private.aaj_doctor_key(text),
  private.aaj_people_key(text), private.aaj_lev(text, text), private.aaj_name_close(text, text), private.aaj_top5(jsonb),
  private.aaj_name_words(text), private.aaj_names_conflict(text, text), private.aaj_name_sound(text), private.aaj_adopt_status(text, text, boolean),
  private.aaj_name_spelling(text), private.aaj_name_fits(text, text),
  private.aaj_status_label(public.visit_status), private.aaj_checkup_label(text),
  private.aaj_date_ok(date, timestamptz), private.aaj_decide(text, text, text, boolean, boolean),
  private.aaj_result(text, text, text, text, uuid, text[], text, text), private.aaj_err_text(text, text),
  private.aaj_match_clinician(text), private.aaj_find_patient(text, text), private.aaj_seen_here(uuid, smallint, date),
  private.aaj_check_mr(smallint, date, text, text, text, uuid), private.aaj_hw_top(), private.aaj_hw_limit(), private.aaj_note_lookup(text, text, text, text, text, text),
  private.aaj_lookup_seen(text, text, text, text, text), private.aaj_lookups_used_up(),
  private.aaj_checkup_twin(smallint, date, text, text, text, text[]), private.aaj_checkup_dup(smallint, date, text, text, text, text[]),
  private.aaj_restore_kept(bigint),
  private.aaj_canon_row(public.visits), private.aaj_canon(uuid), private.aaj_checkup_canon_row(public.checkups), private.aaj_day_list(smallint, date),
  private.aaj_visit_attached(uuid), private.aaj_refs(regclass, uuid, uuid, uuid), private.aaj_override_reason(), private.aaj_restore_removed(bigint, boolean),
  private.aaj_note_let_go(text, uuid, text, text, text), private.aaj_let_go_seen(text, uuid, text, timestamptz),
  private.aaj_removals(smallint, date, text, text[]), private.aaj_row_check(jsonb),
  private.aaj_sync_checkup_row(smallint, text, date, jsonb, uuid, boolean), private.aaj_sync_row(smallint, text, date, jsonb, text[], uuid, text),
  private.aaj_is_checkup_text(text), private.aaj_visit_cap_hit(smallint, date),
  private.guard_visit_sheet_cols(), private.guard_checkup_sheet_key(), private.aaj_release_sheet_claim()
  from public, anon, authenticated;
