-- =============================================================================
-- Checkup patients: people who came for a checkup and have no patient file (no Mr#).
--
-- The clinic's way of working (Dr. Ali, 9 Oct 2026): "checkup patients dont habe mr numbers. they just get a date,
-- branch bisited, name, mobile number, treatment recorded, and a separate list where all the checkup patients are
-- listed". So a row on the daily list without an Mr# is a checkup, never a new patient file. When a checkup patient
-- starts treatment they are registered as a patient (with an Mr#) and patient_id links the two.
--
-- One table holds both:
--   - the day's checkups (from the website's Aaj ki List or the Google Sheet "Aj ki List"): checkup_date is the day,
--     day_status says waiting / in treatment / completed, sheet_key links the row of the Google Sheet (two-way sync);
--   - the checkup list for follow-up calls (the old "Checkup karwaliya" sheet, 5,466 people from Oct 2024): follow_up
--     is the call status ('Follow-up Sent', 'Interested', ...). Rows imported from that list only know the month
--     (date_is_month = true, checkup_date = the 1st of that month).
--
-- Additive only: a new table, its policies and triggers. Safe to run more than once.
-- =============================================================================

create table if not exists public.checkups (
  id             uuid primary key default gen_random_uuid(),
  checkup_date   date,                                   -- the day of the checkup (archive rows: the 1st of the month)
  date_is_month  boolean not null default false,         -- true when only the month is known (imported archive)
  branch_id      smallint references public.branches(id),
  patient_name   text not null check (length(btrim(patient_name)) between 1 and 200),
  phone          text check (phone is null or length(phone) <= 40),
  city           text check (city is null or length(city) <= 80),
  doctors        text check (doctors is null or length(doctors) <= 300),      -- names as written, several allowed
  checkup_for    text check (checkup_for is null or length(checkup_for) <= 300), -- "Treatment / Checkup For"
  details        text check (details is null or length(details) <= 2000),     -- treatment details from the daily list
  token          text check (token is null or length(token) <= 40),           -- as written (the sheet may hold kit text)
  day_status     text check (day_status is null or day_status in ('waiting', 'in_treatment', 'completed', 'cancelled', 'no_show')),
  est_fee        numeric(12,2) check (est_fee is null or est_fee >= 0),
  follow_up      text not null default 'Not Contacted' check (length(follow_up) between 1 and 60),
  notes          text check (notes is null or length(notes) <= 2000),
  source         text not null default 'website' check (source in ('website', 'google_sheet', 'archive')),
  source_tab     text check (source_tab is null or length(source_tab) <= 120), -- archive: the old tab the row came from
  sheet_key      text unique check (sheet_key is null or length(sheet_key) <= 80), -- link to a Google Sheet row
  patient_id     uuid references public.patients(id) on delete set null,      -- set once registered as a patient
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.checkups is
  'Checkup patients without a patient file (no Mr#): the day''s checkups (daily list, two-way sheet sync via sheet_key) and the follow-up list (imported archive, follow_up status).';

create index if not exists checkups_day_branch_idx on public.checkups (checkup_date, branch_id);
create index if not exists checkups_phone_idx on public.checkups (phone);
create index if not exists checkups_name_idx on public.checkups (lower(patient_name));
create index if not exists checkups_follow_up_idx on public.checkups (follow_up);

alter table public.checkups enable row level security;

-- Same people who see and edit the daily list see and edit checkups; a branch-limited account sees its own branches
-- (archive rows without a branch are visible to everyone who may view patients).
drop policy if exists "view checkups" on public.checkups;
create policy "view checkups" on public.checkups for select
  using ((public.has_perm('sheet.view') or public.has_perm('patients.view'))
         and (branch_id is null or public.can_access_branch(branch_id)));
drop policy if exists "add checkups" on public.checkups;
create policy "add checkups" on public.checkups for insert
  with check (public.has_perm('sheet.edit') and (branch_id is null or public.can_access_branch(branch_id)));
drop policy if exists "edit checkups" on public.checkups;
create policy "edit checkups" on public.checkups for update
  using (public.has_perm('sheet.edit') and (branch_id is null or public.can_access_branch(branch_id)))
  with check (public.has_perm('sheet.edit') and (branch_id is null or public.can_access_branch(branch_id)));
-- A wrong entry on the day's list may be removed by the people who keep the list; archive rows only by admin.
drop policy if exists "remove checkups" on public.checkups;
create policy "remove checkups" on public.checkups for delete
  using (public.is_admin()
         or (public.has_perm('sheet.edit') and source <> 'archive' and (branch_id is null or public.can_access_branch(branch_id))));

revoke all on public.checkups from anon;
grant select, insert, update, delete on public.checkups to authenticated;

drop trigger if exists checkups_touch on public.checkups;
create trigger checkups_touch before update on public.checkups
  for each row execute function public.touch_updated_at();
drop trigger if exists checkups_audit on public.checkups;
create trigger checkups_audit after insert or update or delete on public.checkups
  for each row execute function public.audit_row();

notify pgrst, 'reload schema';
