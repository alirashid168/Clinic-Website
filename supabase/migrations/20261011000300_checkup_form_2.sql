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
-- The Google Sheet sync ("Aaj Sync", 20261009000300 and 20261011000100) is NOT changed and does not see the new columns:
-- private.aaj_checkup_canon_row builds the row it sends from named columns, private.aaj_sync_checkup_row inserts and
-- updates named columns only, and a removed row that is put back (jsonb_populate_record of the whole row) keeps its
-- answers. import_checkups (Admin -> Import) inserts named columns too, so imported rows have no answers.
-- supabase/tests/30_checkup_form_2_test.sql proves all of this.
--
-- The view public.checkup_list (20261009000260) is made again: a view keeps the columns its "c.*" had when it was
-- made, so without this the Checkups page would not see the answers. It is dropped and made again (CREATE OR REPLACE
-- cannot put new columns in the middle) with the same definition, rights and security_invoker; nothing depends on it.
--
-- Additive and safe to run more than once. Needs 20261009000250_checkups.sql and 20261009000260_checkups_functions.sql.
-- =============================================================================

do $$
begin
  if to_regclass('public.checkups') is null or to_regprocedure('private.checkup_phone(text)') is null then
    raise exception 'Apply 20261009000250_checkups.sql and 20261009000260_checkups_functions.sql before this file.';
  end if;
end $$;

alter table public.checkups add column if not exists ali_recommended    boolean;
alter table public.checkups add column if not exists pricing_understood text;
alter table public.checkups add column if not exists wants_treatment    boolean;
alter table public.checkups add column if not exists treatment_plan     text;

-- Named checks, dropped first so that running the file again leaves exactly one of each.
alter table public.checkups drop constraint if exists checkups_pricing_understood_check;
alter table public.checkups add constraint checkups_pricing_understood_check
  check (pricing_understood is null or pricing_understood in ('yes', 'no', 'needs_explanation'));
alter table public.checkups drop constraint if exists checkups_treatment_plan_check;
alter table public.checkups add constraint checkups_treatment_plan_check
  check (treatment_plan is null or length(treatment_plan) <= 500);

comment on column public.checkups.ali_recommended is 'Checkup Patient Form 2.0: "Did Dr. Ali recommend your treatment?" (null: not asked, e.g. the old list or the Google Sheet)';
comment on column public.checkups.pricing_understood is 'Checkup Patient Form 2.0: "Did you understand the pricing details?" yes / no / needs_explanation';
comment on column public.checkups.wants_treatment is 'Checkup Patient Form 2.0: "Would you like to start the treatment?"';
comment on column public.checkups.treatment_plan is 'Checkup Patient Form 2.0: "If yes then when? If no then why not?" (at most 500 characters)';

-- The "Wants to start" filter of the Checkups page.
create index if not exists checkups_wants_treatment_idx on public.checkups (wants_treatment) where wants_treatment is not null;

-- The list the Checkups page reads, with the new columns (same definition as 20261009000260).
drop view if exists public.checkup_list;
create view public.checkup_list with (security_invoker = true) as
  select c.*, private.checkup_phone(c.phone) as phone_key, p.mr_number
    from public.checkups c left join public.patients p on p.id = c.patient_id;
revoke all on public.checkup_list from public, anon, authenticated;
grant select on public.checkup_list to authenticated;

notify pgrst, 'reload schema';
