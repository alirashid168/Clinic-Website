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
--     flagged "check name and phone").
--   * A typed Mr# is checked, never searched: the name in the row must fit that patient (a name nobody can read fits nothing) or the typed phone
--     must be the patient's own. At most 120 visits per branch and day are made by the sync, 20 calls a minute are accepted, and every refused
--     lookup is audited and capped.
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
--     (owner rule), but never a visit with an invoice, photo, x-ray, lab case,
--     inventory move, rating or recorded treatment (that one is kept, marked
--     Cancelled, and the row is put back with the reason), never more than 3
--     rows or a quarter of a tab at once, never more than 15 a day per
--     branch. Every removal is in audit_log (SHEET_REMOVED, with the whole
--     row) and is undone by putting the row back in the sheet, or by
--     select public.aaj_undo_removal(<audit_log id>).
--   * A doctor the website's group rule refuses on a row that is not Completed yet stays in the sheet's cell ("pending") and is added when the
--     row is marked Completed (owner rule). A new checkup row for a person who already has a checkup that day (same name and phone, row not
--     on the sheet) adopts it. A checkup's sheet_key is written by the sync only (and Dr. Ali / the SQL editor).
--   * The "approved by" columns of an override (protocol_override_by, dues_override_by) hold the first admin's staff id, because they are
--     foreign keys to staff; the reason text and audit_log.actor say "Google Sheet sync".
--   * One bad row never blocks the others (each row is saved on its own).
--   * The secret is small on purpose: only today's lists (and yesterday's
--     until 03:00 for the last flush before the archive) of the five branch
--     tabs, no search, answers carry only what the sheet already shows,
--     every refused lookup is audited and capped, calls are rate limited.
--
-- Additive and re-runnable. It does not touch visit_before_write(),
-- guard_staff_row(), audit_row() or aaj_export(), so the order with
-- 20261009000100 / 20261009000200 does not matter. It needs
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
insert into private.aaj_sync_config (key, value) values ('visits_per_branch_day', '120') on conflict (key) do nothing;   -- visits the sync may make for one branch and day (the busiest tab has about 50 rows)

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

-- the undo of a removal looks the sheet's key up in the audit log
create index if not exists audit_log_sheet_removed_key_idx on public.audit_log ((new_data->>'key')) where action = 'SHEET_REMOVED';

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

-- Does a typed name fit the patient behind a Mr#? (a different person typed with another patient's Mr# must not be linked)
-- A name that cannot be read (empty, punctuation, Urdu script) on either side says nothing about who this is: it fits nothing. (Otherwise a
-- guessed Mr# plus an unreadable name would link any patient and hand back the name, phone and dues.) The only other proof is the typed phone
-- being the patient's own, which aaj_check_mr checks.
create or replace function private.aaj_name_close(a text, b text) returns boolean
language plpgsql immutable set search_path = ''
as $$
declare ga text := private.aaj_given_name(a); gb text := private.aaj_given_name(b); m int;
begin
  if ga = '' or gb = '' then return false; end if;
  if ga = gb then return true; end if;
  if ga = any (string_to_array(private.aaj_norm_name(b), ' ')) or gb = any (string_to_array(private.aaj_norm_name(a), ' ')) then return true; end if;
  m := least(length(ga), length(gb));
  return private.aaj_lev(ga, gb) <= case when m >= 6 then 2 when m = 5 then 1 else 0 end;
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

-- Does a Treatment text say "checkup"? (owner, 9 Oct 2026: "Checkup", "checkup / pain", "xray checkup"; a typo such as "chek up" counts too, because
-- a row that is not read as a checkup is flagged for a person, while a wrong "yes" would file an existing patient as a checkup.)
create or replace function private.aaj_is_checkup_text(t text) returns boolean
language sql immutable set search_path = ''
as $$ select coalesce(t, '') ~* 'ch[ea]{1,2}c?k' $$;

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
--     outcome: mr (the patient) | mr_name (the Mr# is another person) | mr_noname (the typed name cannot be read: nothing to check it by)
--              | mr_other (name and phone are filed under another Mr#)
--              | mr_bad (not a number the website can take) | mr_typo (50000 and above: the website's own range) | mr_new (a Healthwire number)
create or replace function private.aaj_check_mr(p_branch smallint, p_date date, p_mr text, p_name text, p_phone text) returns jsonb
language plpgsql stable set search_path = public, extensions
as $$
declare
  v_nn text := private.aaj_norm_name(p_name);
  v_given text := private.aaj_given_name(p_name);
  v_ph text := private.aaj_norm_phone(p_phone);
  v_p public.patients; v_o public.patients; v_own boolean;
begin
  select * into v_p from public.patients where mr_number = p_mr;
  if found then
    -- the typed phone is the patient's own phone: that counts as a fit, unless somebody else on that phone has the typed first name
    -- (a daughter typed with her mother's Mr# on the family phone)
    v_own := v_ph is not null
             and (private.aaj_norm_phone(v_p.phone) = v_ph or private.aaj_norm_phone(v_p.phone_alt) = v_ph)
             and not exists (select 1 from public.patients o
                              where o.id <> v_p.id and v_given <> '' and private.aaj_given_name(o.full_name) = v_given
                                and (private.aaj_norm_phone(o.phone) = v_ph or private.aaj_norm_phone(o.phone_alt) = v_ph));
    -- the name must fit (a name nobody can read fits nothing), or the typed phone must be the patient's own
    if private.aaj_name_close(p_name, v_p.full_name) or v_own then
      return jsonb_build_object('outcome', 'mr', 'patient_id', v_p.id, 'mr', v_p.mr_number, 'name', v_p.full_name,
                                'name_differs', v_given <> '' and private.aaj_given_name(v_p.full_name) <> v_given);
    end if;
    return jsonb_build_object('outcome', case when v_given = '' then 'mr_noname' else 'mr_name' end, 'patient_id', null, 'mr', v_p.mr_number, 'name', v_p.full_name,
                              'seen', private.aaj_seen_here(v_p.id, p_branch, p_date));
  end if;
  -- the Mr# is not on the website: is this person filed under another number?
  if v_ph is not null and v_nn <> '' then
    select * into v_o from public.patients o
     where (private.aaj_norm_phone(o.phone) = v_ph or private.aaj_norm_phone(o.phone_alt) = v_ph) and private.aaj_norm_name(o.full_name) = v_nn
     order by o.created_at, o.id limit 1;
    if found then
      return jsonb_build_object('outcome', 'mr_other', 'patient_id', null, 'mr', v_o.mr_number, 'name', v_o.full_name,
                                'seen', private.aaj_seen_here(v_o.id, p_branch, p_date));
    end if;
  end if;
  if p_mr ~ '^[0-9]{1,15}$' and p_mr::bigint >= 50000 then
    return jsonb_build_object('outcome', 'mr_typo', 'patient_id', null);       -- the website's own numbers start at 50000
  end if;
  if p_mr !~ '^[1-9][0-9]{0,4}$' then
    return jsonb_build_object('outcome', 'mr_bad', 'patient_id', null);
  end if;
  return jsonb_build_object('outcome', 'mr_new', 'patient_id', null);           -- 1 to 49999: a Healthwire number
end $$;

-- A refused lookup (an Mr# the website could not place) is written to the audit log once per key and day, and counted:
-- after 200 a day nothing more is looked at. Returns false when the day's budget is used up.
create or replace function private.aaj_note_lookup(p_tab text, p_key text, p_mr text, p_outcome text) returns boolean
language plpgsql volatile set search_path = public, extensions
as $$
declare v_day timestamptz := ((now() at time zone 'Asia/Karachi')::date)::timestamp at time zone 'Asia/Karachi';
begin
  if exists (select 1 from public.audit_log where action = 'SHEET_LOOKUP' and at >= v_day and new_data->>'key' = p_key and new_data->>'outcome' = p_outcome) then
    return true;
  end if;
  if (select count(*) from public.audit_log where action = 'SHEET_LOOKUP' and at >= v_day) >= 200 then return false; end if;
  insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
  values ('patients', null, 'SHEET_LOOKUP', null, jsonb_build_object('tab', p_tab, 'key', p_key, 'mr', left(p_mr, 20), 'outcome', p_outcome), private.aaj_sync_actor());
  return true;
end $$;

-- A branch's list gets only so many visits made by the sync in one day (a flood of guessed Mr# rows, a runaway sheet). The cap is a setting.
create or replace function private.aaj_visit_cap_hit(p_branch smallint, p_date date) returns boolean
language sql stable set search_path = public, extensions
as $$
  select (select count(*) from public.visits x where x.branch_id = p_branch and x.visit_date = p_date and x.created_by = private.aaj_sync_actor())
         >= coalesce((select value::int from private.aaj_sync_config where key = 'visits_per_branch_day'), 120)
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
    'removed', false,
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
    'removed', false,
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
            order by 1, 2 loop
    execute format('select exists (select 1 from %s where %I = $1)', r.tbl, r.col) into v_hit using p_visit;
    if v_hit then return regexp_replace(r.tbl, '^public\.', ''); end if;
  end loop;
  return null;
end $$;

-- The text of the override that a Completed row of the sheet leaves on the visit (owner rule, 9 Oct 2026).
create or replace function private.aaj_override_reason() returns text
language sql immutable set search_path = ''
as $$ select 'Completed in the Google Sheet (owner rule, 9 Oct 2026)'::text $$;

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
  if exists (select 1 from public.audit_log where action = 'SHEET_RESTORED' and new_data->>'audit' = p_audit::text) then return false; end if;
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
    if not exists (select 1 from public.patients where id = (j->>'patient_id')::uuid) then return false; end if;
    if exists (select 1 from public.visits where patient_id = (j->>'patient_id')::uuid and branch_id = (j->>'branch_id')::smallint
                  and visit_date = (j->>'visit_date')::date and status <> 'cancelled') then
      return false;                                      -- that patient has another visit on the list now
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

-- ---------------------------------------------------------------------
-- 6. Rows that left the sheet (only the last call of a tick for today)
--    A row deleted in the sheet is a wrong entry or a patient who did not come: the visit / checkup is removed from the
--    website too, unless something real hangs on it. Many rows at once is a mistake in the sheet, not a clinic decision.
-- ---------------------------------------------------------------------
create or replace function private.aaj_removals(p_branch smallint, p_date date, p_tab text, p_present text[]) returns jsonb
language plpgsql volatile set search_path = public, extensions
as $$
declare
  v public.visits; c public.checkups;
  v_out jsonb := '[]'::jsonb; v_pres text[] := coalesce(p_present, '{}');
  v_n int; v_total int; v_done int; v_hold boolean; v_code text; v_why text;
  v_day timestamptz := ((now() at time zone 'Asia/Karachi')::date)::timestamp at time zone 'Asia/Karachi';
  v_attached text; v_staff jsonb; v_text jsonb; v_msg text;
begin
  select code into v_code from public.branches where id = p_branch;
  select count(*) into v_n from (
    select 1 from public.visits x where x.branch_id = p_branch and x.visit_date = p_date and x.sheet_key is not null and not (x.sheet_key = any (v_pres)) and x.status <> 'cancelled'
    union all
    select 1 from public.checkups x where x.branch_id = p_branch and x.checkup_date = p_date and x.source <> 'archive' and not x.date_is_month
       and x.sheet_key is not null and not (x.sheet_key = any (v_pres)) and coalesce(x.day_status, '') <> 'cancelled') y;
  if v_n = 0 then return v_out; end if;
  select count(*) into v_total from (
    select 1 from public.visits x where x.branch_id = p_branch and x.visit_date = p_date and x.sheet_key is not null and x.status <> 'cancelled'
    union all
    select 1 from public.checkups x where x.branch_id = p_branch and x.checkup_date = p_date and x.source <> 'archive' and not x.date_is_month
       and x.sheet_key is not null and coalesce(x.day_status, '') <> 'cancelled') y;
  select count(*) into v_done from public.audit_log
   where action = 'SHEET_REMOVED' and new_data->>'branch' = v_code and at >= v_day and new_data->>'action' in ('deleted', 'kept_cancelled');
  v_hold := v_n > 3 or (v_n >= 2 and (cardinality(v_pres) = 0 or v_n * 4 >= v_total)) or v_done + v_n > 15;
  if v_hold then
    v_why := case when v_done + v_n > 15 and v_n <= 3 then 'Needs attention: too many rows were deleted from this tab today, so nothing was removed from the website. Delete wrong entries on the website.'
                  else format('Needs attention: %s rows disappeared at once, so nothing was removed from the website. Delete wrong entries on the website, or delete fewer rows at a time.', v_n) end;
  end if;

  for v in select x.* from public.visits x where x.branch_id = p_branch and x.visit_date = p_date and x.sheet_key is not null
              and not (x.sheet_key = any (v_pres)) and x.status <> 'cancelled' order by x.created_at, x.id loop
    if v_hold then
      v_out := v_out || jsonb_build_object('key', v.sheet_key, 'action', 'restore', 'message', v_why);
      continue;
    end if;
    v_attached := private.aaj_visit_attached(v.id);
    if v.status in ('scheduled', 'waiting') and v_attached is null and v.started_at is null and v.completed_at is null
       and not v.photos_uploaded and v.checked_by is null then
      v_staff := coalesce((select jsonb_agg(jsonb_build_object('clinician_id', s.clinician_id, 'role', s.role)) from public.visit_staff s where s.visit_id = v.id), '[]'::jsonb);
      v_text := (select to_jsonb(t) - 'visit_id' from private.aaj_visit_text t where t.visit_id = v.id);
      insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
      values ('visits', v.id::text, 'SHEET_REMOVED', to_jsonb(v),
              jsonb_build_object('tab', p_tab, 'branch', v_code, 'date', p_date, 'key', v.sheet_key, 'action', 'deleted', 'kind', 'visit', 'staff', v_staff, 'text', v_text),
              private.aaj_sync_actor());
      delete from public.visits where id = v.id;
      v_out := v_out || jsonb_build_object('key', v.sheet_key, 'action', 'deleted', 'name', (select p.full_name from public.patients p where p.id = v.patient_id),
        'message', 'Row deleted in the sheet: the visit is removed from the website too. Put the row back to undo.');
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
    else
      v_out := v_out || jsonb_build_object('key', v.sheet_key, 'action', 'restore',
        'message', format('Not removed: this visit is %s on the website. To take a patient off, set Status to Cancelled.', private.aaj_status_label(v.status)));
    end if;
  end loop;

  for c in select x.* from public.checkups x where x.branch_id = p_branch and x.checkup_date = p_date and x.source <> 'archive' and not x.date_is_month
              and x.sheet_key is not null and not (x.sheet_key = any (v_pres)) and coalesce(x.day_status, '') <> 'cancelled' order by x.created_at, x.id loop
    if v_hold then
      v_out := v_out || jsonb_build_object('key', c.sheet_key, 'action', 'restore', 'message', v_why);
    elsif c.patient_id is null and c.follow_up = 'Not Contacted' and c.notes is null then
      insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
      values ('checkups', c.id::text, 'SHEET_REMOVED', to_jsonb(c),
              jsonb_build_object('tab', p_tab, 'branch', v_code, 'date', p_date, 'key', c.sheet_key, 'action', 'deleted', 'kind', 'checkup'),
              private.aaj_sync_actor());
      delete from public.checkups where id = c.id;
      v_out := v_out || jsonb_build_object('key', c.sheet_key, 'action', 'deleted', 'name', c.patient_name,
        'message', 'Row deleted in the sheet: the checkup is removed from the website too. Put the row back to undo.');
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
--    p_cid null = a new row of the sheet; otherwise the checkup the key belongs to.
--    A new row for a person who already has a checkup today at this branch (same name, same phone, and that checkup's row is not on the
--    sheet right now) is that checkup: it is adopted, not made twice (like a visit of the same patient).
-- ---------------------------------------------------------------------
drop function if exists private.aaj_sync_checkup_row(smallint, text, date, jsonb, uuid);
create or replace function private.aaj_sync_checkup_row(p_branch smallint, p_tab text, p_date date, p_row jsonb, p_cid uuid, p_present text[] default '{}')
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
  v_mr text; v_pat public.patients; v_sv text; v_outcome text;
  v_target uuid := p_cid; v_adopt boolean := false;
begin
  v_edit := case when v_edit > v_now_ms + 300000 then v_now_ms else v_edit end;       -- a clock far in the future counts as now

  if v_target is null then
    -- ---- a new checkup ----
    if length(btrim(coalesce(v_set->>'name', ''))) < 2 then
      return private.aaj_result(v_key, 'needs_patient', 'error', 'Patient name is too short.');
    end if;
    -- the same person on the website's list, or typed twice: that checkup is this row's (never guessed without a phone number)
    if private.aaj_norm_phone(v_set->>'phone') is not null then
      select * into c from public.checkups x
       where x.branch_id = p_branch and x.checkup_date = p_date and x.source <> 'archive' and not x.date_is_month
         and x.phone = private.aaj_norm_phone(v_set->>'phone') and private.aaj_norm_name(x.patient_name) = private.aaj_norm_name(v_set->>'name')
         and coalesce(x.sheet_key, 'W-' || x.id::text) <> v_key and not (coalesce(x.sheet_key, 'W-' || x.id::text) = any (coalesce(p_present, '{}')))
       order by x.created_at, x.id limit 1 for update;
      if found then v_target := c.id; v_adopt := true; end if;
    end if;
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
  if c.branch_id is distinct from p_branch or c.checkup_date is distinct from p_date then
    return private.aaj_result(v_key, 'other_list', 'error', 'This row belongs to another branch or day.');
  end if;
  n := c;
  if c.sheet_key is null or v_adopt then n.sheet_key := v_key; end if;
  cn := private.aaj_checkup_canon_row(c);
  v_newer := not v_adopt and coalesce(v_edit, 0) > extract(epoch from c.updated_at) * 1000;      -- an adopted checkup keeps the website's state

  foreach v_f in array array['name', 'phone', 'treatment', 'token', 'status', 'doctors', 'details'] loop
    continue when not (v_set ? v_f);
    v_s := case when v_f in ('token', 'status', 'doctors') then coalesce(v_set->v_f->>'t', '') when v_f = 'phone' then coalesce(private.aaj_norm_phone(v_set->>'phone'), '')
                else btrim(coalesce(v_set->>v_f, '')) end;
    v_w := cn->>v_f;
    v_b := case when v_base is null then null
                when v_f = 'doctors' then array_to_string(array(select jsonb_array_elements_text(coalesce(v_base->'doctors', '[]'::jsonb))), ',')
                else coalesce(v_base->>v_f, '') end;
    if v_f = 'status' then v_w := lower(v_w); v_b := lower(v_b); v_s := lower(v_s);
    elsif v_f = 'doctors' then v_w := private.aaj_people_key(v_w); v_b := private.aaj_people_key(v_b); v_s := private.aaj_people_key(v_s); end if;
    v_dec := private.aaj_decide(v_w, v_b, v_s, v_base is not null, v_newer);
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

  -- the person on a checkup row is the checkup's own: an Mr# on it must be the patient it was registered as
  if v_set ? 'mr' then
    v_mr := nullif(btrim(v_set->>'mr'), '');
    if v_mr is not null and upper(v_mr) <> 'NEW' then
      select * into v_pat from public.patients where id = c.patient_id;
      if not found or v_pat.mr_number <> v_mr then
        return private.aaj_result(v_key, 'error', 'error', 'The Mr# in this row is not this checkup''s. Clear the row and type the patient again.', c.id);
      end if;
    end if;
  end if;

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
  v_pid uuid; v_pat public.patients; v_find jsonb; v_oc text; v_mr text;
  v_pc text := null; v_dup text := null; v_ek text; v_cid uuid;
  v_mv int; v_mt text; v_case uuid; v_tv int; v_tt text; v_sv text; v_gv int;
  v_other text;
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
    if v_cid is not null then return private.aaj_sync_checkup_row(p_branch, p_tab, p_date, p_row, v_cid, p_present); end if;
  end if;
  if v_found and left(v_key, 2) = 'W-' and v.sheet_key is not null and v.sheet_key <> v_key then
    return private.aaj_result(v_key, 'superseded', 'error', 'This row was replaced by another row for the same visit.', v.id);
  end if;
  if v_found and (v.branch_id <> p_branch or v.visit_date <> p_date) then
    return private.aaj_result(v_key, 'other_list', 'error', 'This row belongs to another branch or day.');
  end if;
  if not v_found and (left(v_key, 2) = 'W-' or not coalesce((p_row->>'new')::boolean, false)) then
    return private.aaj_result(v_key, 'gone', 'error', 'This visit was deleted on the website. Delete this row.');
  end if;

  v_outcome := case when v_found then 'updated' else 'created' end;

  -- ---- a new row: no Mr# and a Treatment that says checkup is a checkup patient; an Mr# must be a patient the website knows (or a Healthwire number) ----
  if not v_found then
    v_mr := nullif(btrim(v_set->>'mr'), '');
    if v_mr is null or upper(v_mr) = 'NEW' then
      -- owner, 9 Oct 2026 (13:20): only a Treatment that says checkup makes a row without an Mr# a checkup. Any other treatment is an existing
      -- patient whose Mr# staff forgot: a person looks it up in Healthwire. Nothing is guessed, filed as a checkup or made into a patient.
      if not private.aaj_is_checkup_text(v_set->>'treatment') then
        return private.aaj_result(v_key, 'needs_patient', 'error',
          'Needs attention: add the Mr#. A row with no Mr# is a checkup only when its Treatment says checkup. Look the Mr# up in Healthwire.');
      end if;
      return private.aaj_sync_checkup_row(p_branch, p_tab, p_date, p_row, null, p_present);
    end if;
    if v_mr !~ '^[A-Za-z0-9_-]+$' or v_mr !~ '[0-9]' then
      return private.aaj_result(v_key, 'needs_patient', 'error', format('"%s" is not a Mr#. Type the number only, or leave it empty for a checkup patient.', left(v_mr, 30)));
    end if;
    v_find := private.aaj_check_mr(p_branch, p_date, v_mr, v_set->>'name', v_set->>'phone');
    v_oc := v_find->>'outcome';

    if v_oc = 'mr' then
      v_pid := (v_find->>'patient_id')::uuid;
      select * into v_pat from public.patients where id = v_pid;
      if (v_find->>'name_differs')::boolean then
        v_msgs := v_msgs || format('Mr# %s is "%s" on the website. Check the Mr#.', v_pat.mr_number, v_pat.full_name); v_level := 'warn';
      end if;
    elsif v_oc = 'mr_new' then
      -- a Healthwire number the website has not seen yet: the patient is created with it, flagged for a check
      if length(btrim(coalesce(v_set->>'name', ''))) < 2 then
        return private.aaj_result(v_key, 'needs_patient', 'error', 'Patient name is too short.');
      end if;
      if private.aaj_visit_cap_hit(p_branch, p_date) then
        return private.aaj_result(v_key, 'needs_patient', 'error', 'Too many patients added from the sheet today. Add this one on the website.');
      end if;
      if (select count(*) from public.patients where legacy_source = 'aaj_sheet_sync' and first_branch_id = p_branch
             and (created_at at time zone 'Asia/Karachi')::date = (now() at time zone 'Asia/Karachi')::date) >= 60 then
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
      insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
      values ('patients', v_pid::text, 'SHEET_SYNC', null,
              jsonb_build_object('mr', v_pc, 'name', v_pat.full_name, 'phone', v_pat.phone, 'tab', p_tab, 'outcome', v_oc), private.aaj_sync_actor());
    else
      -- nothing is created or linked. The refusal is audited and capped; another patient is named only when this branch already knows them.
      if not private.aaj_note_lookup(p_tab, v_key, v_mr, v_oc) then
        return private.aaj_result(v_key, 'needs_patient', 'error', 'Too many rows the website could not place today. Fix them on the website.');
      end if;
      return private.aaj_result(v_key, 'needs_patient', 'error', case v_oc
        when 'mr_noname' then format('Mr# %s: the name in this row cannot be read. Type the patient''s name in English letters, or the phone number that is theirs.', v_mr)
        when 'mr_name' then case when (v_find->>'seen')::boolean
                                 then format('Mr# %s is "%s" on the website, not "%s". Check the Mr#.', v_mr, v_find->>'name', left(btrim(coalesce(v_set->>'name', '')), 60))
                                 else format('Mr# %s belongs to another patient. Check the Mr#.', v_mr) end
        when 'mr_other' then case when (v_find->>'seen')::boolean
                                  then format('Mr# %s is not on the website, but %s with this phone is Mr# %s. Use %s.', v_mr, v_find->>'name', v_find->>'mr', v_find->>'mr')
                                  else format('Mr# %s is not on the website, and this name and phone are filed under another Mr#. Check the number.', v_mr) end
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
    elsif private.aaj_visit_cap_hit(p_branch, p_date) then
      -- a new visit for an existing patient: only so many a day for one branch (the sheet's secret is not a way to fill the list)
      return private.aaj_result(v_key, 'needs_patient', 'error', 'Too many patients added from the sheet today. Add this one on the website.');
    end if;
  else
    v_pid := v.patient_id;
  end if;

  -- ---- the visit as it should be ----
  if v_found then
    n := v;
    n.sheet_key := case when v.sheet_key is null or v_outcome = 'linked' then v_key else v.sheet_key end;
    n.sheet_cells := coalesce(v.sheet_cells, '{}'::jsonb);
    c := private.aaj_canon(v.id);
    -- an ADOPTED visit (the sheet row met a visit the website already had) keeps the website's state: the sheet row has no
    -- history with it, and a stale sheet must not set a Completed visit back to Waiting
    v_newer := v_outcome <> 'linked' and coalesce(v_edit, 0) > extract(epoch from v.updated_at) * 1000;
  else
    v_create := true;
    n.id := gen_random_uuid(); n.patient_id := v_pid; n.branch_id := p_branch; n.visit_date := p_date;
    n.status := 'waiting'; n.created_by := private.aaj_sync_actor(); n.sheet_key := v_key; n.sheet_cells := '{}'::jsonb;
  end if;
  n.sheet_cells := n.sheet_cells || jsonb_build_object('tab', p_tab);

  -- who wins each field
  foreach v_f in array array['month', 'treatment', 'token', 'status', 'group', 'details'] loop
    if v_set ? v_f then
      v_st := case when v_f in ('month', 'token', 'status', 'group') then coalesce(v_set->v_f->>'t', '') else coalesce(v_set->>v_f, '') end;
      v_dec := case when v_create then 'apply'
                    when v_f = 'status' then private.aaj_decide(lower(c->>v_f), case when v_base is not null then lower(coalesce(v_base->>v_f, '')) end, lower(v_st), v_base is not null, v_newer)
                    else private.aaj_decide(c->>v_f, case when v_base is not null then coalesce(v_base->>v_f, '') end, v_st, v_base is not null, v_newer) end;
      if v_dec = 'keep' then
        v_kept := array_append(v_kept, v_f); v_lost := v_lost || jsonb_build_object(v_f, v_st);
      elsif v_dec = 'same' then
        v_same := v_same || jsonb_build_object(v_f, true);
      else
        v_decs := v_decs || jsonb_build_object(v_f, true);
      end if;
    end if;
  end loop;

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

  -- the patient on a row that is already linked is never changed; say so
  if v_found and v_outcome = 'updated' then
    if v_set ? 'mr' then
      v_mr := nullif(btrim(v_set->>'mr'), '');
      select * into v_pat from public.patients where id = n.patient_id;
      if v_mr is null or upper(v_mr) = 'NEW' then v_kept := array_append(v_kept, 'mr'::text);
      elsif v_mr <> v_pat.mr_number then
        return private.aaj_result(v_key, 'error', 'error', 'The Mr# in this row is not this visit''s patient. Clear the row and type the patient again.', v.id);
      end if;
    end if;
    if v_set ? 'name' then
      select * into v_pat from public.patients where id = n.patient_id;
      if private.aaj_given_name(v_set->>'name') <> '' and private.aaj_given_name(v_set->>'name') <> private.aaj_given_name(v_pat.full_name) then
        v_msgs := v_msgs || format('Mr# %s is "%s" on the website. Check the Mr#.', v_pat.mr_number, v_pat.full_name); v_level := 'warn';
      end if;
    end if;
    -- a phone changed in the sheet is not copied into the patient file (it is the patient's, not the visit's): say so instead of showing a green tick
    if v_set ? 'phone' and private.aaj_norm_phone(v_set->>'phone') is not null then
      select * into v_pat from public.patients where id = n.patient_id;
      if nullif(v_pat.phone, '0000000') is not null and private.aaj_norm_phone(v_set->>'phone') is distinct from private.aaj_norm_phone(v_pat.phone)
         and private.aaj_norm_phone(v_set->>'phone') is distinct from private.aaj_norm_phone(v_pat.phone_alt) then
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
            -- dues rules are skipped, and the record says exactly that.
            if p_admin is null then raise; end if;
            if v_err like 'DUES%' then
              n.dues_override_by := p_admin; n.dues_override_reason := private.aaj_override_reason();
              v_msgs := v_msgs || format('Completed from the sheet. Pending dues Rs %s were not held (owner rule).', to_char(public.patient_dues(n.patient_id), 'FM999,999,999'));
              v_over := array_append(v_over, 'dues'::text);
            else
              n.protocol_override_by := p_admin; n.protocol_override_reason := private.aaj_override_reason();
              v_msgs := v_msgs || format('Completed from the sheet. The website''s %s step was skipped (owner rule).', case when v_err like 'PHOTO%' then 'photo' else 'check' end);
              v_over := v_over || case when v_err like 'PHOTO%' then 'photo' else 'check' end;
            end if;
            v_level := 'warn';
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
          v_msgs := v_msgs || format('%s is outside this month''s doctor group. Saved because the visit is Completed in the sheet (owner rule).', r.display_name); v_level := 'warn'; v_over := array_append(v_over, 'group'::text);
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

  -- ---- the patient's empty phone is filled from the sheet, never changed ----
  if v_pc is null and v_set ? 'phone' and private.aaj_norm_phone(v_set->>'phone') is not null then
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
  v_res jsonb; v_results jsonb; v_removed jsonb; v_list jsonb; v_hash text; v_nrows int; v_first_err text; v_detail text; v_problems int;
  v_tabs_out jsonb := '[]'::jsonb; v_tab_out jsonb; v_unchanged boolean; v_total_rows int := 0; r record;
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
       or (v_tab ? 'present' and jsonb_typeof(v_tab->'present') not in ('array', 'null')) then
      raise exception 'BAD_PAYLOAD: every tab needs a branch, rows and present as lists' using errcode = '22023';
    end if;
    if (v_tab->>'branch') = any (v_branches) then raise exception 'PAYLOAD_TOO_LARGE: a branch appears twice' using errcode = '22023'; end if;
    v_branches := v_branches || (v_tab->>'branch');
    if jsonb_array_length(coalesce(nullif(v_tab->'present', 'null'::jsonb), '[]'::jsonb)) > 400 then
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

  for v_tab in select value from jsonb_array_elements(p_payload->'tabs') loop
    v_code := v_tab->>'branch'; v_tabname := private.aaj_tab_name(v_code);        -- never the tab name the caller sent
    select id into v_branch from public.branches where code = v_code;
    v_has_present := jsonb_typeof(v_tab->'present') = 'array';
    v_present := coalesce(array(select k from jsonb_array_elements_text(coalesce(nullif(v_tab->'present', 'null'::jsonb), '[]'::jsonb)) k where length(k) <= 60), '{}');
    v_detail := null;

    -- a visit or checkup made on the website is claimed the first time its key shows up in the tab
    update public.visits set sheet_key = 'W-' || id::text
     where branch_id = v_branch and visit_date = v_date and sheet_key is null and ('W-' || id::text) = any (v_present);
    update public.checkups set sheet_key = 'W-' || id::text
     where branch_id = v_branch and checkup_date = v_date and sheet_key is null and ('W-' || id::text) = any (v_present);
    -- a deleted row that came back in the sheet (Ctrl+Z): the visit or checkup it removed is put back under its key
    if v_has_present and cardinality(v_present) > 0 then
      for r in select a.id from public.audit_log a
                where a.action = 'SHEET_REMOVED' and a.new_data->>'action' = 'deleted' and a.new_data->>'key' = any (v_present)
                  and a.new_data->>'branch' = v_code and a.new_data->>'date' = v_date::text and a.at > now() - interval '3 days'
                order by a.id loop
        perform private.aaj_restore_removed(r.id, true);
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

    v_removed := '[]'::jsonb;
    if v_check_removed and v_date = v_today and v_has_present then
      v_removed := private.aaj_removals(v_branch, v_date, v_tabname, v_present);
    end if;

    v_list := private.aaj_day_list(v_branch, v_date);
    v_hash := md5(v_list::text);
    v_unchanged := (v_nrows = 0 and (v_tab->>'hash') is not distinct from v_hash and jsonb_array_length(v_removed) = 0);     -- rows to put back need the list

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
-- 11. import_aaj_sheet: the same function as 20261007001600, except that patients are
--     found through private.aaj_find_patient (a phone shared by a family never picks "the
--     first patient", two same-name patients on one phone are never guessed between) and
--     a new family member on a known phone is a new patient.
-- ---------------------------------------------------------------------
create or replace function public.import_aaj_sheet(p_rows jsonb, p_create_patients boolean default false)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_admin uuid;
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  n_future int := 0; n_pat int := 0; n_vis int := 0; n_upd int := 0; n_staff int := 0; n_cases int := 0; n_tok int := 0;
  n_matched int := 0; n_unmatched int := 0;
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
    photo boolean, tid smallint, patient_id uuid, visit_id uuid, case_id uuid, dup boolean default false, amb boolean default false, fam boolean default false);
  alter table aaj add column if not exists amb boolean default false;
  alter table aaj add column if not exists fam boolean default false;
  create temp table if not exists aaj_names (nm text, id uuid, c bigint);
  truncate aaj, aaj_names;
  insert into aaj (rn, d, branch, mr, name, legacy_name, phone, month, treatment, token, status, grp, doctors, assistants, unmatched, details, reminder, tab, photo, tid)
    select row_number() over (), (r->>0)::date, (r->>1)::smallint, nullif(btrim(r->>2), ''), btrim(r->>3),
           nullif(r->>4, ''), nullif(r->>5, ''), nullif(r->>6, '')::smallint, nullif(btrim(r->>7), ''),
           nullif(r->>8, '')::int, coalesce(nullif(r->>9, ''), 'completed')::public.visit_status, nullif(r->>10, '')::smallint,
           coalesce(r->11, '[]'), coalesce(r->12, '[]'), coalesce(r->13, '[]'), nullif(r->>14, ''),
           nullif(r->>15, ''), coalesce(r->>16, 'sheet'), coalesce((r->>17)::boolean, false), nullif(r->>18, '')::smallint
      from jsonb_array_elements(p_rows) r
     where btrim(coalesce(r->>3, '')) <> '' and (r->>0)::date < v_today;
  -- Rows dated today or later belong to the live sheet.
  select count(*) into n_future from jsonb_array_elements(p_rows) r where btrim(coalesce(r->>3, '')) <> '' and (r->>0)::date >= v_today;

  -- 1. Who is the patient: Mr#, then phone (never a guess between several people), then a name only one patient has.
  update aaj a set patient_id = p.id from public.patients p where a.mr is not null and p.mr_number = a.mr;
  update aaj a set
      patient_id = case when f.o in ('phone_name', 'phone_first') then (f.r->>'patient_id')::uuid end,
      amb = (f.o = 'ambiguous'),
      fam = (f.o = 'phone_others')
    from (select x.rn, x.r, x.r->>'outcome' as o
            from (select b.rn, private.aaj_find_patient(b.name, b.phone) as r from aaj b where b.patient_id is null and b.phone is not null) x) f
   where a.rn = f.rn;
  insert into aaj_names select lower(full_name), min(id::text)::uuid, count(*) from public.patients group by lower(full_name);
  update aaj a set patient_id = n.id from aaj_names n where a.patient_id is null and not a.amb and not a.fam and n.nm = lower(a.name) and n.c = 1;

  -- 2. Unknown patients: added only when asked and only when the row carries an Mr# or a phone.
  if p_create_patients then
    with grp as (
      select coalesce(mr, '~' || lower(name) || '|' || coalesce(phone, '')) k, min(rn) rn, min(d) first_d
        from aaj where patient_id is null and not amb and (mr is not null or phone is not null) group by 1),
    ins as (
      insert into public.patients (mr_number, full_name, phone, first_branch_id, legacy_source, legacy_name, notes, created_at)
      select a.mr, a.name, a.phone, a.branch, 'aaj_ki_list', coalesce(a.legacy_name, a.name),
             'Added from the Aaj ki List (' || a.tab || ', first seen ' || to_char(g.first_d, 'DD Mon YYYY') || ')', g.first_d::timestamptz
        from grp g join aaj a on a.rn = g.rn
       where a.mr is null or not exists (select 1 from public.patients p where p.mr_number = a.mr)
      returning 1)
    select count(*) into n_pat from ins;
    update aaj a set patient_id = p.id from public.patients p where a.patient_id is null and a.mr is not null and p.mr_number = a.mr;
    update aaj a set patient_id = (
        select p.id from public.patients p
         where private.aaj_norm_phone(p.phone) = private.aaj_norm_phone(a.phone) and private.aaj_norm_name(p.full_name) = private.aaj_norm_name(a.name)
         order by p.created_at desc limit 1)
     where a.patient_id is null and not a.amb and a.phone is not null;
  end if;

  select count(distinct patient_id), count(*) filter (where patient_id is null) into n_matched, n_unmatched from aaj;
  -- (the dedupe below only marks rows; counts above are per sheet row)
  select coalesce(jsonb_agg(x), '[]') into v_unmatched from (
    select jsonb_build_object('name', name, 'mr', mr, 'phone', phone, 'rows', count(*), 'first', min(d), 'last', max(d), 'tab', min(tab)) x
      from aaj where patient_id is null group by name, mr, phone order by count(*) desc, name limit 300) s;

  -- 3. Two rows for the same patient on the same day become one visit.
  update aaj a set
    details = concat_ws(' · ', a.details, (select string_agg(concat_ws(' ', o.treatment, o.details), ' · ' order by o.rn) from aaj o where o.patient_id = a.patient_id and o.d = a.d and o.rn <> a.rn)),
    doctors = a.doctors || coalesce((select jsonb_agg(x) from aaj o, jsonb_array_elements(o.doctors) x where o.patient_id = a.patient_id and o.d = a.d and o.rn <> a.rn), '[]'),
    assistants = a.assistants || coalesce((select jsonb_agg(x) from aaj o, jsonb_array_elements(o.assistants) x where o.patient_id = a.patient_id and o.d = a.d and o.rn <> a.rn), '[]'),
    unmatched = a.unmatched || coalesce((select jsonb_agg(x) from aaj o, jsonb_array_elements(o.unmatched) x where o.patient_id = a.patient_id and o.d = a.d and o.rn <> a.rn), '[]'),
    month = coalesce(a.month, (select max(o.month) from aaj o where o.patient_id = a.patient_id and o.d = a.d)),
    token = coalesce(a.token, (select min(o.token) from aaj o where o.patient_id = a.patient_id and o.d = a.d))
  where a.patient_id is not null
    and a.rn = (select min(o.rn) from aaj o where o.patient_id = a.patient_id and o.d = a.d)
    and exists (select 1 from aaj o where o.patient_id = a.patient_id and o.d = a.d and o.rn <> a.rn);
  update aaj a set dup = true where a.patient_id is not null and a.rn > (select min(o.rn) from aaj o where o.patient_id = a.patient_id and o.d = a.d);

  -- 4. Braces case for the month rows: the active one, else the case running on that date, else a new one from the history.
  update aaj a set case_id = (select b.id from public.braces_cases b where b.patient_id = a.patient_id and b.status = 'active' limit 1)
   where a.month is not null and a.patient_id is not null and not a.dup;
  update aaj a set case_id = (select b.id from public.braces_cases b where b.patient_id = a.patient_id and b.start_date <= a.d + 7 order by b.start_date desc limit 1)
   where a.month is not null and a.patient_id is not null and a.case_id is null;
  with hist as (
    select a.patient_id,
           min(a.d - ((a.month - 1) * interval '30 days'))::date start_d,
           (array_agg(a.branch order by a.month, a.d))[1] branch,
           min(a.d) first_d, max(a.d) last_d
      from aaj a where a.month is not null and a.patient_id is not null and a.case_id is null and not a.dup
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
   where a.month is not null and a.patient_id is not null and a.case_id is null;
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
      braces_month = coalesce(v.braces_month, case when coalesce(v.braces_case_id, a.case_id) is not null then a.month end),
      doctor_group_id = coalesce(v.doctor_group_id, a.grp),
      protocol_override_by = coalesce(v.protocol_override_by, v_admin),
      protocol_override_reason = coalesce(v.protocol_override_reason, 'Imported from the Aaj ki List'),
      notes = concat_ws(' · ', v.notes, 'Aaj ki List (' || a.tab || ')',
                case when a.month is not null and coalesce(v.braces_case_id, a.case_id) is null then 'Month ' || a.month end,
                case when a.treatment is not null and v.treatment_label is not null and lower(v.treatment_label) <> lower(a.treatment) then 'Sheet: ' || a.treatment end,
                case when jsonb_array_length(a.unmatched) > 0 then 'Also: ' || (select string_agg(x, ', ') from jsonb_array_elements_text(a.unmatched) x) end,
                case when a.reminder is not null then 'Reminder: ' || a.reminder end)
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
             case when a.reminder is not null then 'Reminder: ' || a.reminder end),
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

  return jsonb_build_object('given', jsonb_array_length(p_rows), 'future', n_future, 'patients_matched', n_matched, 'rows_unmatched', n_unmatched,
    'patients_created', n_pat, 'visits_inserted', n_vis, 'visits_updated', n_upd, 'tokens', n_tok, 'staff_added', n_staff,
    'cases_created', n_cases, 'cases', v_cases, 'unmatched', v_unmatched);
end $$;


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

-- ---------------------------------------------------------------------
-- 13. Who may call what
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
  private.aaj_status_label(public.visit_status), private.aaj_checkup_label(text),
  private.aaj_date_ok(date, timestamptz), private.aaj_decide(text, text, text, boolean, boolean),
  private.aaj_result(text, text, text, text, uuid, text[], text, text), private.aaj_err_text(text, text),
  private.aaj_match_clinician(text), private.aaj_find_patient(text, text), private.aaj_seen_here(uuid, smallint, date),
  private.aaj_check_mr(smallint, date, text, text, text), private.aaj_note_lookup(text, text, text, text),
  private.aaj_canon_row(public.visits), private.aaj_canon(uuid), private.aaj_checkup_canon_row(public.checkups), private.aaj_day_list(smallint, date),
  private.aaj_visit_attached(uuid), private.aaj_override_reason(), private.aaj_restore_removed(bigint, boolean),
  private.aaj_removals(smallint, date, text, text[]), private.aaj_row_check(jsonb),
  private.aaj_sync_checkup_row(smallint, text, date, jsonb, uuid, text[]), private.aaj_sync_row(smallint, text, date, jsonb, text[], uuid, text),
  private.aaj_is_checkup_text(text), private.aaj_visit_cap_hit(smallint, date),
  private.guard_visit_sheet_cols(), private.guard_checkup_sheet_key()
  from public, anon, authenticated;
