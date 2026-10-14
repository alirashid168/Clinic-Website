-- =============================================================================
-- Checkup Patient Form 2.0 on the website: the answers of the clinic's Google Form go into public.checkups.
--
-- The owner (11 Oct 2026): "the checkup 2.0 form is good, and we are using that form now. i want you to put that form
-- once when employee login and they get option to put checkup entry ... once entered, these details go into the checkup
-- list we are making, with name, branch, number, treatment recommended etc". The form has nine questions. Five already
-- have a column: name (patient_name), branch (branch_id), mobile number (phone), "Who did your checkup?" (doctors) and
-- "What was your checkup for?" (checkup_for). This file adds a column for each of the other four:
--   ali_recommended     "Did Dr. Ali recommend your treatment?"            Yes / No
--   pricing_understood  "Did you understand the pricing details?"          'yes' / 'no' / 'needs_explanation'
--   wants_treatment     "Would you like to start the treatment?"           Yes / No
--   treatment_plan      "If yes then when? If no then why not?"            short text, at most 500 characters
-- All four are nullable: the 5,466 rows of the old list, the rows the Google Sheet sync makes and every checkup added
-- before this file have no answers, and the website only asks the questions for a new checkup.
--
-- The owner (12 Oct 2026): "yes please bring the old 470 entries too, and design the form submitted entries all in similar
-- way too." The answers given on the Google Form itself (Aug to Oct 2026, the "Form Responses 2" tab of "Checkup karwaliya")
-- are imported by Dr. Ali on Admin -> Import, through public.import_checkup_form() (section 3 below). An imported answer goes
--   - onto the checkup of that person at that branch on that day when the website or the Google Sheet already has one (the same phone
--     AND the same name: two children on a parent's phone are two checkups),
--   - else onto the old list's row of that person and month (private.checkup_key), which keeps its follow-up status,
--   - else into a new row: source 'google_form', source_tab 'Checkup Form 2.0', the day of the answer (date_is_month false).
-- form_submitted_at says when the answer was given on the Google Form (null: never imported from it).
--
-- The Google Sheet sync ("Aaj Sync", 20261009000300 and 20261011000100) is NOT changed and does not see the new columns:
-- private.aaj_checkup_canon_row builds the row it sends from named columns, private.aaj_sync_checkup_row inserts and
-- updates named columns only, and a removed row that is put back (jsonb_populate_record of the whole row) keeps its
-- answers. import_checkups (Admin -> Import) inserts named columns too, so imported rows have no answers. The sync only
-- keeps today's list (and yesterday's until 03:00 Karachi time, private.aaj_date_ok), and import_checkup_form never writes
-- a checkup of those days (an answer given today waits for the next day's import), so an imported answer is never pushed
-- into the sheet and never changes the list or its hash. supabase/tests/30_checkup_form_2_test.sql proves all of this.
--
-- The view public.checkup_list (20261009000260) is made again: a view keeps the columns its "c.*" had when it was
-- made, so without this the Checkups page would not see the answers. It is dropped and made again (CREATE OR REPLACE
-- cannot put new columns in the middle) with the same definition, rights and security_invoker; nothing depends on it.
--
-- Additive and safe to run more than once. Needs 20261009000250_checkups.sql, 20261009000260_checkups_functions.sql and (for the names
-- the import compares, private.aaj_norm_name and private.aaj_name_fits) 20261009000300_aaj_two_way_sync.sql.
-- =============================================================================

do $$
begin
  if to_regclass('public.checkups') is null or to_regprocedure('private.checkup_phone(text)') is null
     or to_regprocedure('private.checkup_key(text,text,date)') is null or to_regprocedure('private.checkup_text(text,integer)') is null then
    raise exception 'Apply 20261009000250_checkups.sql and 20261009000260_checkups_functions.sql before this file.';
  end if;
  if to_regprocedure('private.aaj_norm_name(text)') is null or to_regprocedure('private.aaj_name_fits(text,text)') is null then
    raise exception 'Apply 20261009000300_aaj_two_way_sync.sql before this file.';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. The answers
-- ---------------------------------------------------------------------------------------------------------------
alter table public.checkups add column if not exists ali_recommended    boolean;
alter table public.checkups add column if not exists pricing_understood text;
alter table public.checkups add column if not exists wants_treatment    boolean;
alter table public.checkups add column if not exists treatment_plan     text;
alter table public.checkups add column if not exists form_submitted_at  timestamptz;

-- Named checks, dropped first so that running the file again leaves exactly one of each.
alter table public.checkups drop constraint if exists checkups_pricing_understood_check;
alter table public.checkups add constraint checkups_pricing_understood_check
  check (pricing_understood is null or pricing_understood in ('yes', 'no', 'needs_explanation'));
alter table public.checkups drop constraint if exists checkups_treatment_plan_check;
alter table public.checkups add constraint checkups_treatment_plan_check
  check (treatment_plan is null or length(treatment_plan) <= 500);

-- source: 'google_form' joins the sources the check allows now (it is added to the list, so a source another file added stays).
do $$
declare v_def text; v_vals text[];
begin
  select pg_get_constraintdef(oid) into v_def from pg_constraint where conrelid = 'public.checkups'::regclass and conname = 'checkups_source_check';
  if v_def is null or position('''google_form''' in v_def) = 0 then
    v_vals := coalesce((select array_agg(distinct m[1]) from regexp_matches(coalesce(v_def, ''), '''([a-z_]+)''', 'g') m), '{website,google_sheet,archive}');
    alter table public.checkups drop constraint if exists checkups_source_check;
    -- written as "source in ('archive', ...)", so the check reads back with every value in quotes (what the test above looks for)
    execute format('alter table public.checkups add constraint checkups_source_check check (source in (%s))',
                   (select string_agg(quote_literal(v), ', ' order by v) from unnest(v_vals || '{google_form}'::text[]) v));
  end if;
end $$;

comment on column public.checkups.ali_recommended is 'Checkup Patient Form 2.0: "Did Dr. Ali recommend your treatment?" (null: not asked, e.g. the old list or the Google Sheet)';
comment on column public.checkups.pricing_understood is 'Checkup Patient Form 2.0: "Did you understand the pricing details?" yes / no / needs_explanation';
comment on column public.checkups.wants_treatment is 'Checkup Patient Form 2.0: "Would you like to start the treatment?"';
comment on column public.checkups.treatment_plan is 'Checkup Patient Form 2.0: "If yes then when? If no then why not?" (at most 500 characters)';
comment on column public.checkups.form_submitted_at is 'When the answers were given on the Google Form "Checkup Patient Form 2.0" (set by import_checkup_form only; null: never imported from it)';

-- The "Wants to start" filter of the Checkups page.
create index if not exists checkups_wants_treatment_idx on public.checkups (wants_treatment) where wants_treatment is not null;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. form_submitted_at is set by the import only
-- ---------------------------------------------------------------------------------------------------------------
-- Like the columns of private.guard_checkup_columns (20261009000260): a signed-in colleague writing through the API directly cannot mark a
-- checkup "from the Google Form". A trigger of its own, so that file's guard stays as it is.
create or replace function private.guard_checkup_form_column() returns trigger
language plpgsql set search_path = public
as $$
begin
  if current_user <> 'authenticated' or auth.uid() is null or public.is_admin() then return new; end if;
  if (tg_op = 'INSERT' and new.form_submitted_at is not null) or (tg_op = 'UPDATE' and new.form_submitted_at is distinct from old.form_submitted_at) then
    raise exception 'NOT_ALLOWED: when a checkup''s answers were given on the Google Form is set by the import only.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function private.guard_checkup_form_column() from public, anon, authenticated;
drop trigger if exists checkups_guard_form_column on public.checkups;
create trigger checkups_guard_form_column before insert or update of form_submitted_at on public.checkups
  for each row execute function private.guard_checkup_form_column();

-- ---------------------------------------------------------------------------------------------------------------
-- 3. The import of the Google Form's answers (Admin -> Import -> "6. Checkup Form 2.0 answers"). Admin only.
-- ---------------------------------------------------------------------------------------------------------------
-- Every answer imported, once: "the time it was given (Karachi) | the phone as digits | the name in lower case with single spaces".
-- Importing the file again finds every key here and changes nothing, also for an answer whose checkup was removed since (its key stays).
create table if not exists private.checkup_form_imports (
  form_key     text primary key check (length(form_key) <= 300),
  checkup_id   uuid references public.checkups(id) on delete set null,     -- the checkup the answer went to
  outcome      text not null check (outcome in ('inserted', 'filled_day', 'filled_month', 'same')),
  submitted_at timestamptz not null,
  imported_by  uuid default auth.uid(),
  imported_at  timestamptz not null default now()
);
revoke all on private.checkup_form_imports from public, anon, authenticated;
create index if not exists checkup_form_imports_checkup_idx on private.checkup_form_imports (checkup_id);

-- p_rows is a JSON array of at most 500 objects, one per answer, built by the website from the downloaded tab (web/js/lib/checkup-form.js):
--   { "row": 17, "submitted_at": "2026-08-12T19:25:03+05:00", "name": "...", "phone": "0300-5550142" | null,
--     "branch": "GUL" | "NN" | "DHA" | "LHR" | "ISB" | null, "doctors": "..." | null, "checkup_for": "..." | null,
--     "ali_recommended": true | false | null, "pricing_understood": "yes" | "no" | "needs_explanation" | null,
--     "wants_treatment": true | false | null, "treatment_plan": "..." | null, "follow_up": "Follow-up Sent" | null, "notes": "..." | null }
-- (unknown keys are ignored). One bad cell never fails the batch: text is trimmed and cut to the column limit, an answer that is not one
-- of the form's becomes "not answered", an unknown branch code becomes "no branch". A row without a name, without a readable time (it
-- must carry its offset), dated in the future, or given today (the Aaj ki List of today, and of yesterday until 03:00, is still kept in the
-- Google Sheet) is skipped with the reason; today's answers come in with the next day's import.
-- Where an answer goes, in this order:
--   1. already imported (its key)                                                  -> nothing changes ("already")
--   2. a checkup of that day at that branch from the website, the Google Sheet or an earlier answer: the same phone (as digits) and the
--      same name, or the same name letter for letter when one of the two has no phone; the same name letter for letter first, then the
--      oldest                                                                       -> its empty answers are filled in ("filled_day")
--      With a phone the names are compared as the Aaj ki List compares a typed name with a patient's (private.aaj_name_fits): the same
--      first name (titles such as Muhammad, M, Syed skipped; an everyday spelling is the same name: "Aisha" / "Ayesha", "Umer" / "Umar")
--      and no other name: "Ayesha" is "Ayesha Khan" and "Muhammad Usman Ali" is "Usman Ali", but "Ayesha Khan" is not "Ayesha Rajpoot".
--      A parent's phone is often given for two children who came together: "Sample Sister Aiza" and "Sample Brother Bilal" on one phone
--      are two checkups (the second answer is never put on the first one's row; in the owner's file 11 days have such a pair). A name
--      nobody can read (Urdu script) on either side is matched by the phone alone. An answer whose phone is on that day's list at that
--      branch only under another name is counted in other_name too (it becomes its own checkup in 3 or 4).
--   3. the old list's row of that person and month (private.checkup_key)          -> its empty answers are filled in ("filled_month")
--   4. otherwise                                                                    -> a new checkup ("inserted"): source 'google_form',
--      source_tab 'Checkup Form 2.0', the day of the answer, Completed (the form is filled in after the checkup, as on the website),
--      created_at = the time of the answer.
-- Filling in never overwrites: an answer, the doctor, the phone, the branch or "checkup for" the checkup already has stays (the sheet's
-- plain "Checkup" is no answer to "What was your checkup for?" and is replaced). The follow-up status from REMINDERS is taken only while
-- the checkup still says 'Not Contacted', and never for an old-list row (that row keeps its follow-up). The notes are added to the
-- checkup's own. A checkup that already holds everything the answer says is "same". form_submitted_at is set on the checkup that changed.
-- p_dry_run (the preview): everything is done and then undone, so the counts are exactly what the import would do.
-- Result: given / inserted / filled_day / filled_month / already / same / skipped (up to 100 listed as { row, reason }) / skipped_count
-- / other_name and dry_run. given = inserted + filled_day + filled_month + already + same + skipped_count (other_name is part of
-- inserted + filled_month: the answers that share a phone with another person on that day's list).
create or replace function public.import_checkup_form(p_rows jsonb, p_dry_run boolean default false)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  v_open date := ((now() at time zone 'Asia/Karachi') - interval '3 hours')::date;    -- the first day the sync may still be keeping
  n_given int; n_ins int := 0; n_day int := 0; n_month int := 0; n_already int := 0; n_same int := 0; n_skip int := 0; n_other int := 0;
  v_skipped jsonb := '[]'::jsonb;
  e record; c public.checkups;
  v_row int; v_name text; v_ts timestamptz; v_date date; v_why text; v_phone text; v_pk text; v_nk text; v_named boolean; v_key text; v_branch smallint;
  v_ali boolean; v_pricing text; v_wants boolean; v_plan text; v_doctors text; v_for text; v_follow text; v_notes text; v_kind text; v_id uuid;
  n_ali boolean; n_pricing text; n_wants boolean; n_plan text; n_doctors text; n_for text; n_phone text; n_branch smallint; n_follow text; n_notes text;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'NOT_ALLOWED: only Dr. Ali can import the answers of the checkup form.' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'BAD_ROWS: send the rows as a list.' using errcode = '22023';
  end if;
  n_given := jsonb_array_length(p_rows);
  if n_given > 500 then
    raise exception 'TOO_MANY_ROWS: send at most 500 rows at a time.' using errcode = '22023';
  end if;
  -- One import at a time: two at once could both find an answer new.
  perform pg_advisory_xact_lock(hashtext('import_checkup_form'));

  begin     -- a block of its own, so the preview can undo it all at the end (the counts are kept)
    for e in select x.r, x.n from jsonb_array_elements(p_rows) with ordinality as x(r, n) order by x.n loop
      v_row := case when e.r->>'row' ~ '^[0-9]{1,9}$' then (e.r->>'row')::int else e.n::int end;
      v_name := private.checkup_text(regexp_replace(coalesce(e.r->>'name', ''), '\s+', ' ', 'g'), 200);
      v_ts := null; v_date := null; v_why := null;
      -- A time of this century with its offset, and a day its month has: then the cast below cannot fail (no error handling per row).
      if coalesce(e.r->>'submitted_at', '') ~ '^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?(Z|[+-](0[0-9]|1[0-4]):?[0-5][0-9])$' then
        if substr(e.r->>'submitted_at', 9, 2)::int <= extract(day from make_date(substr(e.r->>'submitted_at', 1, 4)::int, substr(e.r->>'submitted_at', 6, 2)::int, 1)
                                                               + interval '1 month' - interval '1 day') then
          v_ts := (e.r->>'submitted_at')::timestamptz;
          v_date := (v_ts at time zone 'Asia/Karachi')::date;
        end if;
      end if;
      if v_name is null then v_why := 'No patient name';
      elsif v_ts is null then v_why := 'The date could not be read';
      elsif v_date > v_today then v_why := 'The date is in the future';
      elsif v_date >= v_open then v_why := 'Given today: today''s list is still kept in the Google Sheet. Import the file again tomorrow.';
      end if;
      if v_why is not null then
        n_skip := n_skip + 1;
        if n_skip <= 100 then v_skipped := v_skipped || jsonb_build_object('row', v_row, 'reason', v_why); end if;
        continue;
      end if;

      v_phone := private.checkup_text(e.r->>'phone', 40);
      v_pk := private.checkup_phone(v_phone);
      v_nk := lower(v_name);         -- trimmed, single spaces
      v_key := left(to_char(v_ts at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI:SS') || '|' || coalesce(v_pk, '') || '|' || v_nk, 300);
      if exists (select 1 from private.checkup_form_imports where form_key = v_key) then
        n_already := n_already + 1;
        continue;
      end if;

      v_branch := (select b.id from public.branches b where upper(b.code) = upper(btrim(coalesce(e.r->>'branch', ''))));
      v_ali := case when jsonb_typeof(e.r->'ali_recommended') = 'boolean' then (e.r->>'ali_recommended')::boolean end;
      v_wants := case when jsonb_typeof(e.r->'wants_treatment') = 'boolean' then (e.r->>'wants_treatment')::boolean end;
      v_pricing := case when e.r->>'pricing_understood' in ('yes', 'no', 'needs_explanation') then e.r->>'pricing_understood' end;
      v_plan := private.checkup_text(e.r->>'treatment_plan', 500);
      v_doctors := private.checkup_text(e.r->>'doctors', 300);
      v_for := private.checkup_text(e.r->>'checkup_for', 300);
      v_follow := private.checkup_text(e.r->>'follow_up', 60);
      v_notes := private.checkup_text(e.r->>'notes', 2000);

      -- 2. the checkup of that person on that day at that branch: the same phone and name (another name on the same phone is another
      --    person: a parent's phone for two children), or the same name without a phone; the same name letter for letter first, then the oldest
      v_kind := 'filled_day';
      v_named := private.aaj_norm_name(v_name) <> '';      -- false: a name nobody can read (Urdu script, only dots)
      select * into c from public.checkups x
       where x.checkup_date = v_date and not x.date_is_month and x.source <> 'archive' and x.branch_id is not distinct from v_branch
         and ((v_pk is not null and private.checkup_phone(x.phone) = v_pk
               and (not v_named or private.aaj_norm_name(x.patient_name) = '' or private.aaj_name_fits(v_name, x.patient_name)))
              or ((v_pk is null or private.checkup_phone(x.phone) is null) and lower(btrim(regexp_replace(x.patient_name, '\s+', ' ', 'g'))) = v_nk))
       order by lower(btrim(regexp_replace(x.patient_name, '\s+', ' ', 'g'))) = v_nk desc, x.created_at, x.id
       limit 1
       for update;
      -- (the phone is on that day's list under another name only: counted, so the preview can say why it becomes a checkup of its own)
      if c.id is null and v_pk is not null and exists (
           select 1 from public.checkups x
            where x.checkup_date = v_date and not x.date_is_month and x.source <> 'archive' and x.branch_id is not distinct from v_branch
              and private.checkup_phone(x.phone) = v_pk) then
        n_other := n_other + 1;
      end if;
      -- 3. the old list's row of that person and month (the unique index of 20261009000260)
      if c.id is null then
        v_kind := 'filled_month';
        select * into c from public.checkups x
         where x.source = 'archive' and private.checkup_key(x.phone, x.patient_name, x.checkup_date) = private.checkup_key(v_phone, v_name, v_date)
         for update;
      end if;

      if c.id is not null then
        n_ali := coalesce(c.ali_recommended, v_ali);
        n_pricing := coalesce(c.pricing_understood, v_pricing);
        n_wants := coalesce(c.wants_treatment, v_wants);
        n_plan := coalesce(c.treatment_plan, v_plan);
        n_doctors := coalesce(c.doctors, v_doctors);
        n_for := case when c.checkup_for is null or c.checkup_for ~* '^\s*check[\s-]*ups?\s*$' then coalesce(v_for, c.checkup_for) else c.checkup_for end;
        n_phone := coalesce(c.phone, v_phone);
        n_branch := coalesce(c.branch_id, v_branch);
        n_follow := case when v_kind = 'filled_day' and c.follow_up = 'Not Contacted' and v_follow is not null then v_follow else c.follow_up end;
        n_notes := case when v_notes is null or position(v_notes in coalesce(c.notes, '')) > 0 then c.notes
                        when btrim(coalesce(c.notes, '')) = '' then v_notes
                        else left(c.notes || '; ' || v_notes, 2000) end;
        if (n_ali, n_pricing, n_wants, n_plan, n_doctors, n_for, n_phone, n_branch, n_follow, n_notes)
           is distinct from (c.ali_recommended, c.pricing_understood, c.wants_treatment, c.treatment_plan, c.doctors, c.checkup_for, c.phone, c.branch_id, c.follow_up, c.notes) then
          update public.checkups
             set ali_recommended = n_ali, pricing_understood = n_pricing, wants_treatment = n_wants, treatment_plan = n_plan, doctors = n_doctors,
                 checkup_for = n_for, phone = n_phone, branch_id = n_branch, follow_up = n_follow, notes = n_notes,
                 form_submitted_at = coalesce(c.form_submitted_at, v_ts)
           where id = c.id;
          if v_kind = 'filled_day' then n_day := n_day + 1; else n_month := n_month + 1; end if;
        else
          v_kind := 'same';
          n_same := n_same + 1;
        end if;
        insert into private.checkup_form_imports (form_key, checkup_id, outcome, submitted_at) values (v_key, c.id, v_kind, v_ts);
      else
        -- 4. a new checkup, shown like one added with the form on the website
        insert into public.checkups (checkup_date, date_is_month, branch_id, patient_name, phone, doctors, checkup_for, day_status, follow_up, notes,
                                     source, source_tab, ali_recommended, pricing_understood, wants_treatment, treatment_plan, form_submitted_at, created_at)
        values (v_date, false, v_branch, v_name, v_phone, v_doctors, v_for, 'completed', coalesce(v_follow, 'Not Contacted'), v_notes,
                'google_form', 'Checkup Form 2.0', v_ali, v_pricing, v_wants, v_plan, v_ts, v_ts)
        returning id into v_id;
        n_ins := n_ins + 1;
        insert into private.checkup_form_imports (form_key, checkup_id, outcome, submitted_at) values (v_key, v_id, 'inserted', v_ts);
      end if;
    end loop;
    if coalesce(p_dry_run, false) then
      raise exception 'IMPORT_PREVIEW_UNDONE';
    end if;
  exception when raise_exception then
    if sqlerrm <> 'IMPORT_PREVIEW_UNDONE' then raise; end if;
  end;

  return jsonb_build_object('given', n_given, 'inserted', n_ins, 'filled_day', n_day, 'filled_month', n_month, 'already', n_already, 'same', n_same,
                            'skipped', v_skipped, 'skipped_count', n_skip, 'other_name', n_other, 'dry_run', coalesce(p_dry_run, false));
end $$;

revoke all on function public.import_checkup_form(jsonb, boolean) from public, anon;
grant execute on function public.import_checkup_form(jsonb, boolean) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. The list the Checkups page reads, with the new columns (same definition as 20261009000260).
-- ---------------------------------------------------------------------------------------------------------------
drop view if exists public.checkup_list;
create view public.checkup_list with (security_invoker = true) as
  select c.*, private.checkup_phone(c.phone) as phone_key, p.mr_number
    from public.checkups c left join public.patients p on p.id = c.patient_id;
revoke all on public.checkup_list from public, anon, authenticated;
grant select on public.checkup_list to authenticated;

notify pgrst, 'reload schema';
