-- =============================================================================
-- Retainer Record and Lab Work: the clinic's retainer sheet, and a sheet like it for lab work, on the website.
--
-- The owner (12 Oct 2026): "this is our retainer record sheet, please habe a look at this sheet, it should habe a layout
-- just like this, i want it on my website too ... if you could make one similar for lab works that would be great too".
-- The clinic's "Retainer Record" Google Sheet has one tab per city (Karachi from April 2025, Lahore from November 2025):
--   Karachi: Mr# | Patient name | Impression date | Model check by | Retainer made by | Retainer date | Status | retainer sheet | Payments
--   Lahore:  Contact | Patient name | Impression date | Model check by | Retainer made by | Retainer date | Status
-- Most people on it have no patient file on the website (about one Karachi row in seven has an Mr#), the Karachi rows have no
-- branch, and the dates were typed by hand (the website's reader, web/js/lib/retainers-import.js, turns them into real dates and
-- the sheet's wording into the lists' before they are sent here).
--
-- public.retainer_cases and public.lab_cases (core schema 20261005000100) had no rows on the live database (checked 15 Oct 2026), so
-- they are reshaped in place to fit the sheet instead of a second system beside them. The live website writes both until this file
-- runs, so a row that is there by then is converted (its old stage or status becomes the new one), never dropped.
--
-- What this file adds or changes
--   1. public.retainer_team and public.lab_team: the people (and labs) on the drop-downs, each with a colour from a fixed
--      palette whose text always meets contrast (white text only on the dark colours; web/js/lib/records.js has the same list).
--   2. retainer_cases reshaped: a patient file is optional (patient_name / contact for the rest, and the Mr# as typed on the
--      sheet when the row could not be linked), the city is required and the branch optional, impression and retainer dates
--      with the typed text kept when a date could not be read, Model check by and Retainer made by as team members, status /
--      retainer sheet / payment as text from editable lists, and where the row came from (website, or a sheet row). The old
--      stage enum did not map onto the sheet's statuses: each row's stage becomes the status that means the same, then it goes.
--   3. lab_cases reshaped the same way: patient file optional, teeth, shade, handled by, payment; status is text with the keys
--      sent / in_lab / received / fitted / remake / cancelled (the old 'returned' becomes 'remake'), so the "Lab and retainer
--      costs" report (status <> 'cancelled') keeps counting them. The Sent date may be left empty (as on the sheet).
--   4. The drop-down lists stored as data: app_settings 'retainer_statuses' and 'lab_work_types' (edited in Clinic setup).
--   5. Who sees and changes what: patients.view or the manage right, plus branch or city access (public.can_access_city).
--   6. Triggers: the city follows the branch, a linked row keeps the patient's name, the dates a status implies are filled in
--      (Delivered also sets the first retainer check a calendar month later, the rule of the old Coordinator -> Retainers list),
--      the columns only the system sets (source, source_row, source_name, created_by) cannot be written through the API, and a
--      row linked, unlinked or changed on the website is marked so (linked_by_hand, edited_on_site).
--   7. public.import_retainer_records(): Dr. Ali's ONE copy of a city's tab (owner, 12 Oct 2026: "the retainer sheet can be
--      copied, its complete"; after the copy the website is the Retainer Record). The whole tab comes in one call, and only while
--      that city has no copied rows; a second copy is refused in plain words. A dry run tells the Import page's preview what the
--      copy would do. A row with an Mr# is linked to that patient file only when its name fits the file too;
--      public.retainer_mr_check() tells the preview how many will be. The most active makers of the tab get the strongest colours
--      and, while nobody of that city is in it, the "Retainer Lab" banner. public.undo_retainer_copy() takes back the copied rows
--      nobody changed on the website (so a corrected copy can be made); public.retainer_copies() says which cities are copied.
--   7b. public.rename_record_option(): a status (or lab work type) written in new words keeps its rows (they take the new words).
--   7c. The "Lab and retainer costs" report counts a retainer only when it has a lab cost, by its retainer date; lab work without a
--       Sent date is counted by the day it came back, else was fitted, else was added.
--   8. Audit and updated_at for the two team tables (the two case tables already have both).
-- Safe to run more than once.
-- =============================================================================

create schema if not exists private;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. The teams
-- ---------------------------------------------------------------------------------------------------------------
-- Colour keys. Dark (white text): purple black navy red forest ocean plum brown.
-- Light (dark text): lavender grey green blue amber rose teal peach sky lime.
create table if not exists public.retainer_team (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 80),
  role        text not null default 'maker' check (role in ('model_check', 'maker', 'both')),
  colour      text not null default 'grey' check (colour in ('purple', 'black', 'navy', 'red', 'forest', 'ocean', 'plum', 'brown',
                'lavender', 'grey', 'green', 'blue', 'amber', 'rose', 'teal', 'peach', 'sky', 'lime')),
  city_id     smallint references public.cities(id),          -- null = works in every city
  featured    boolean not null default false,                  -- shown in the "Retainer Lab" banner
  active      boolean not null default true,
  sort_order  smallint not null default 50,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.retainer_team is
  'Retainer Record: who checks models and who makes retainers, each with a colour used on every chip, the banner and the filter.';
create unique index if not exists retainer_team_name_idx on public.retainer_team (lower(name));

create table if not exists public.lab_team (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 80),
  kind        text not null default 'person' check (kind in ('person', 'lab')),   -- a person who handles lab work, or a lab
  colour      text not null default 'grey' check (colour in ('purple', 'black', 'navy', 'red', 'forest', 'ocean', 'plum', 'brown',
                'lavender', 'grey', 'green', 'blue', 'amber', 'rose', 'teal', 'peach', 'sky', 'lime')),
  active      boolean not null default true,
  sort_order  smallint not null default 50,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.lab_team is 'Lab Work: the people who handle lab work and the labs it goes to (the drop-downs of the Lab Work page).';
create unique index if not exists lab_team_name_idx on public.lab_team (kind, lower(name));

-- A name is kept trimmed with single spaces, so "Sample  Maker " and "Sample Maker" are one person (the unique indexes above).
create or replace function private.record_team_name() returns trigger
language plpgsql set search_path = public
as $$
begin
  new.name := regexp_replace(btrim(new.name), '\s+', ' ', 'g');
  return new;
end $$;
revoke all on function private.record_team_name() from public, anon, authenticated;

drop trigger if exists retainer_team_name on public.retainer_team;
create trigger retainer_team_name before insert or update of name on public.retainer_team
  for each row execute function private.record_team_name();
drop trigger if exists lab_team_name on public.lab_team;
create trigger lab_team_name before insert or update of name on public.lab_team
  for each row execute function private.record_team_name();

-- ---------------------------------------------------------------------------------------------------------------
-- 2. retainer_cases: one row of the Retainer Record
-- ---------------------------------------------------------------------------------------------------------------
-- A patient file is optional; when it goes, the row stays (with its name) instead of disappearing with it.
alter table public.retainer_cases alter column patient_id drop not null;
alter table public.retainer_cases drop constraint if exists retainer_cases_patient_id_fkey;
alter table public.retainer_cases add constraint retainer_cases_patient_id_fkey
  foreign key (patient_id) references public.patients(id) on delete set null;
alter table public.retainer_cases alter column arch drop not null;

alter table public.retainer_cases
  add column if not exists patient_name    text,
  add column if not exists mr_text         text,          -- the Mr# as typed on the sheet ("082"); kept when the row is not linked to that file
  add column if not exists contact         text,
  add column if not exists city_id         smallint references public.cities(id),
  add column if not exists impression_text text,          -- the typed date, kept only when it could not be read
  add column if not exists retainer_date   date,
  add column if not exists retainer_text   text,
  add column if not exists model_check_by  uuid references public.retainer_team(id) on delete set null,
  add column if not exists made_by         uuid references public.retainer_team(id) on delete set null,
  add column if not exists status          text default 'Impression taken',
  add column if not exists retainer_sheet  text,          -- the sheet's "retainer sheet" column: Re-purchase needed / Sheet available
  add column if not exists payment         text,          -- Paid / Pending / Free
  add column if not exists source          text not null default 'website',
  add column if not exists source_row      integer,       -- the row on the Google Sheet tab the row was copied from
  add column if not exists source_name     text,          -- the patient's name on that sheet row when it was copied
  add column if not exists linked_by_hand  boolean not null default false,   -- the patient file was linked or unlinked on the website
  add column if not exists edited_on_site  boolean not null default false;   -- somebody changed the row on the website ("Undo the copy" keeps it)

comment on column public.retainer_cases.price is 'What the patient pays for the retainer (the "Amount" of the Retainer Record).';
comment on column public.retainer_cases.lab_cost is 'In-house cost of the retainer (Reports: lab and retainer costs).';

-- Rows from before this file. retainer_cases had no rows on the live database when checked (15 Oct 2026), but the live website writes
-- them until this file runs (Coordinator -> Retainers, and the patient file's "Braces are off, start the retainer case"), so any row
-- that is there is converted, never dropped: its stage becomes the status of the sheet's list that means the same, "ready" and a
-- delivered stage give the retainer date, the patient file, branch, dates, notes, prices and author stay, and it is a website row (one
-- linked to a patient file counts as linked by hand, as the website's own rows do). A stage the list has no exact words for (being
-- made, a follow-up check, needs replacement, closed) and the day making started go into the notes in a line of their own, so
-- nothing is lost. (Run again, the stage column is gone and nothing happens.)
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'retainer_cases' and column_name = 'stage') then
    execute $convert$
      update public.retainer_cases r set
        status = case r.stage::text
                   when 'impression' then 'Impression taken'
                   when 'fabrication' then 'Model poured'
                   when 'ready' then 'Retainer made'
                   when 'delivered' then 'Delivered to patient'
                   when 'follow_up' then 'Delivered to patient'
                   when 'replacement_needed' then 'Re-purchase needed'
                   when 'closed' then case when r.delivered_date is not null then 'Delivered to patient' else 'Cancelled' end
                   else 'Impression taken' end,
        retainer_date = coalesce(r.retainer_date, r.ready_date,
                                 case when r.stage::text in ('delivered', 'follow_up', 'closed') then r.delivered_date end),
        notes = case when r.stage::text in ('fabrication', 'follow_up', 'replacement_needed', 'closed') or r.fabricated_date is not null
                     then concat_ws(E'\n', nullif(btrim(r.notes), ''),
                            'On the old Retainers list: ' || case r.stage::text
                                when 'impression' then 'Impression / scan' when 'fabrication' then 'Being made' when 'ready' then 'Ready'
                                when 'delivered' then 'Delivered' when 'follow_up' then 'Follow-up check' when 'replacement_needed' then 'Needs replacement'
                                when 'closed' then 'Closed' else r.stage::text end
                            || coalesce('; making started ' || to_char(r.fabricated_date, 'FMDD Mon YYYY'), '') || '.')
                     else r.notes end,
        source = 'website',
        linked_by_hand = (r.patient_id is not null)
    $convert$;
  end if;
end $$;

-- The stage enum (impression / fabrication / ready / delivered / ...) is replaced by the sheet's own status list.
alter table public.retainer_cases drop column if exists stage;
alter table public.retainer_cases drop column if exists fabricated_date;
alter table public.retainer_cases drop column if exists ready_date;
drop type if exists public.retainer_stage;

-- Every row belongs to a city (the sheet's tabs). Rows from before this file get theirs from the branch or the patient file.
update public.retainer_cases r set city_id = b.city_id from public.branches b where r.city_id is null and b.id = r.branch_id;
update public.retainer_cases r set city_id = coalesce(p.city_id, b.city_id)
  from public.patients p left join public.branches b on b.id = p.first_branch_id
 where r.city_id is null and p.id = r.patient_id;
update public.retainer_cases set city_id = (select min(id) from public.cities) where city_id is null;
alter table public.retainer_cases alter column city_id set not null;
alter table public.retainer_cases alter column created_by set default auth.uid();
-- A row linked to a patient file carries the patient's name too (private.record_fill does it for every row written from now on), so it
-- keeps a name when that file is deleted; rows from before this file get theirs here.
update public.retainer_cases r set patient_name = left(p.full_name, 200)
  from public.patients p where p.id = r.patient_id and btrim(coalesce(r.patient_name, '')) = '';

alter table public.retainer_cases drop constraint if exists retainer_cases_who_check;
alter table public.retainer_cases add constraint retainer_cases_who_check
  check (patient_id is not null or length(btrim(coalesce(patient_name, ''))) > 0);
alter table public.retainer_cases drop constraint if exists retainer_cases_patient_name_check;
alter table public.retainer_cases add constraint retainer_cases_patient_name_check
  check ((patient_name is null or length(patient_name) <= 200) and (source_name is null or length(source_name) <= 200));
-- (rows copied by an earlier run of this file have their sheet name as their name)
update public.retainer_cases set source_name = patient_name where source = 'sheet_import' and source_name is null;
alter table public.retainer_cases drop constraint if exists retainer_cases_contact_check;
alter table public.retainer_cases add constraint retainer_cases_contact_check check (contact is null or length(contact) <= 60);
alter table public.retainer_cases drop constraint if exists retainer_cases_mr_text_check;
alter table public.retainer_cases add constraint retainer_cases_mr_text_check check (mr_text is null or length(btrim(mr_text)) between 1 and 20);
alter table public.retainer_cases drop constraint if exists retainer_cases_dates_text_check;
alter table public.retainer_cases add constraint retainer_cases_dates_text_check
  check ((impression_text is null or length(impression_text) <= 100) and (retainer_text is null or length(retainer_text) <= 100));
alter table public.retainer_cases drop constraint if exists retainer_cases_lists_check;
alter table public.retainer_cases add constraint retainer_cases_lists_check
  check ((status is null or length(btrim(status)) between 1 and 60) and (retainer_sheet is null or length(retainer_sheet) <= 60)
         and (payment is null or length(payment) <= 60));
-- (the notes were there before this file, with no limit, though the old pages never wrote them: a row from before is not checked, so
-- this file never fails on one; every row written from now on is. An amount below 0 typed on the old page goes into the notes as typed,
-- so the row fits the check on amounts and can still be changed.)
alter table public.retainer_cases drop constraint if exists retainer_cases_notes_check;
alter table public.retainer_cases add constraint retainer_cases_notes_check check (notes is null or length(notes) <= 2000) not valid;
update public.retainer_cases
   set notes = concat_ws(E'\n', nullif(btrim(notes), ''),
                 case when price < 0 then 'Amount on the old Retainers list: ' || price end,
                 case when lab_cost < 0 then 'Lab cost on the old Retainers list: ' || lab_cost end),
       price = case when price < 0 then null else price end, lab_cost = case when lab_cost < 0 then null else lab_cost end
 where price < 0 or lab_cost < 0;
alter table public.retainer_cases drop constraint if exists retainer_cases_money_check;
alter table public.retainer_cases add constraint retainer_cases_money_check check ((price is null or price >= 0) and (lab_cost is null or lab_cost >= 0));
alter table public.retainer_cases drop constraint if exists retainer_cases_source_check;
alter table public.retainer_cases add constraint retainer_cases_source_check
  check (source in ('website', 'sheet_import') and (source_row is null or source_row between 1 and 1000000)
         and (source <> 'sheet_import' or source_row is not null));

create unique index if not exists retainer_cases_sheet_row_idx on public.retainer_cases (city_id, source_row) where source = 'sheet_import';
create index if not exists retainer_cases_city_idx on public.retainer_cases (city_id, created_at);
create index if not exists retainer_cases_patient_idx on public.retainer_cases (patient_id) where patient_id is not null;
create index if not exists retainer_cases_made_by_idx on public.retainer_cases (made_by) where made_by is not null;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. lab_cases: one row of Lab Work
-- ---------------------------------------------------------------------------------------------------------------
alter table public.lab_cases alter column patient_id drop not null;
alter table public.lab_cases drop constraint if exists lab_cases_patient_id_fkey;
alter table public.lab_cases add constraint lab_cases_patient_id_fkey
  foreign key (patient_id) references public.patients(id) on delete set null;
alter table public.lab_cases alter column lab_name drop not null;
alter table public.lab_cases alter column work_type drop not null;
alter table public.lab_cases alter column sent_date drop not null;
alter table public.lab_cases alter column created_by set default auth.uid();

alter table public.lab_cases
  add column if not exists patient_name text,
  add column if not exists contact      text,
  add column if not exists teeth        text,     -- e.g. "UR6" or "11, 21"
  add column if not exists shade        text,     -- e.g. "A2"
  add column if not exists handled_by   text,     -- a name from the lab team list, or typed
  add column if not exists payment      text;     -- Paid / Pending / Free

-- The status enum becomes text with fixed keys (the website shows "Sent to lab", "In lab", ...).
do $$
begin
  if (select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'lab_cases' and column_name = 'status') = 'USER-DEFINED' then
    alter table public.lab_cases alter column status drop default;
    alter table public.lab_cases alter column status type text using (case status::text when 'returned' then 'remake' else status::text end);
  end if;
end $$;
alter table public.lab_cases alter column status set default 'sent';
drop type if exists public.lab_status;
-- Lab cases from before this file (the live Coordinator -> Lab work writes them until this file runs) keep everything: the status was
-- converted above, and a case linked to a patient file gets the patient's name, so it keeps one when that file is deleted. The old page
-- took a lab name and a work of any length: one longer than the new limits is cut to fit and its whole text kept in the notes, so the
-- row fits the checks below and can still be changed (a later change, a patient file deleted, would otherwise hit them).
update public.lab_cases l set patient_name = left(p.full_name, 200)
  from public.patients p where p.id = l.patient_id and btrim(coalesce(l.patient_name, '')) = '';
update public.lab_cases
   set notes = concat_ws(E'\n', nullif(btrim(notes), ''),
                 case when length(lab_name) > 120 then 'Lab: ' || lab_name end,
                 case when length(work_type) > 80 then 'Work: ' || work_type end,
                 case when cost < 0 then 'Cost on the old Lab work list: ' || cost end),
       lab_name = left(lab_name, 120), work_type = left(work_type, 80), cost = case when cost < 0 then null else cost end
 where length(lab_name) > 120 or length(work_type) > 80 or cost < 0;

alter table public.lab_cases drop constraint if exists lab_cases_status_check;
alter table public.lab_cases add constraint lab_cases_status_check check (status in ('sent', 'in_lab', 'received', 'fitted', 'remake', 'cancelled'));
alter table public.lab_cases drop constraint if exists lab_cases_who_check;
alter table public.lab_cases add constraint lab_cases_who_check
  check (patient_id is not null or length(btrim(coalesce(patient_name, ''))) > 0);
-- (the notes of a case from before this file had no limit, though the old page never wrote them: a row from before is not checked, so
-- this file never fails on one; every row written from now on is)
alter table public.lab_cases drop constraint if exists lab_cases_text_check;
alter table public.lab_cases add constraint lab_cases_text_check
  check ((patient_name is null or length(patient_name) <= 200) and (contact is null or length(contact) <= 60)
         and (lab_name is null or length(lab_name) <= 120) and (work_type is null or length(work_type) <= 80)
         and (teeth is null or length(teeth) <= 60) and (shade is null or length(shade) <= 40)
         and (handled_by is null or length(handled_by) <= 120) and (payment is null or length(payment) <= 60)
         and (notes is null or length(notes) <= 2000)) not valid;
alter table public.lab_cases drop constraint if exists lab_cases_cost_check;
alter table public.lab_cases add constraint lab_cases_cost_check check (cost is null or cost >= 0);

create index if not exists lab_cases_branch_idx on public.lab_cases (branch_id, created_at);
create index if not exists lab_cases_patient_idx on public.lab_cases (patient_id) where patient_id is not null;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. The lists of the drop-downs (Clinic setup edits them; a value not on the list is kept as written)
-- ---------------------------------------------------------------------------------------------------------------
-- "means" ties a status to what it does: made (fills the retainer date), delivered (fills the dates, the "Delivered!" moment),
-- cancelled (left out of the banner's counts).
insert into public.app_settings (key, value, description) values
  ('retainer_statuses', '[
     {"label": "Impression taken", "colour": "blue"},
     {"label": "Model checked", "colour": "lavender"},
     {"label": "Model poured", "colour": "peach"},
     {"label": "Retainer made", "colour": "teal", "means": "made"},
     {"label": "Delivered to patient", "colour": "green", "means": "delivered"},
     {"label": "Impression repeat", "colour": "amber"},
     {"label": "Re-purchase needed", "colour": "red"},
     {"label": "Cancelled", "colour": "grey", "means": "cancelled"}]'::jsonb,
   'Retainer Record: the Status drop-down, in order (label, colour, means). Edited in Clinic setup.'),
  ('lab_work_types', '[
     {"label": "Crown"}, {"label": "Bridge"}, {"label": "Veneer"}, {"label": "Denture"}, {"label": "Night guard"},
     {"label": "Implant crown"}, {"label": "Retainer"}, {"label": "Aligner"}, {"label": "Other"}]'::jsonb,
   'Lab Work: the Work drop-down, in order. Edited in Clinic setup.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Who sees and changes what
-- ---------------------------------------------------------------------------------------------------------------
-- City access: everyone not limited to branches, and a branch-limited account in the cities of its branches. Like
-- can_access_branch() it only answers about the caller.
create or replace function public.can_access_city(p_city smallint)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.staff s
     where s.id = auth.uid() and s.active
       and (s.role = 'admin' or not s.restrict_to_branches
            or exists (select 1 from public.branches b where b.city_id = p_city and b.id = any(s.branch_ids))))
$$;
revoke all on function public.can_access_city(smallint) from public, anon;
grant execute on function public.can_access_city(smallint) to authenticated;

alter table public.retainer_team enable row level security;
alter table public.lab_team enable row level security;

-- Everyone on the staff sees the names and colours (every chip needs them); Dr. Ali keeps the lists in Clinic setup.
drop policy if exists "staff read retainer team" on public.retainer_team;
create policy "staff read retainer team" on public.retainer_team for select using (public.is_staff());
drop policy if exists "admin manages retainer team" on public.retainer_team;
create policy "admin manages retainer team" on public.retainer_team for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "staff read lab team" on public.lab_team;
create policy "staff read lab team" on public.lab_team for select using (public.is_staff());
drop policy if exists "admin manages lab team" on public.lab_team;
create policy "admin manages lab team" on public.lab_team for all using (public.is_admin()) with check (public.is_admin());

-- The public (anon) has no business with any of the four tables (the policies would refuse it anyway).
revoke all on public.retainer_team, public.lab_team, public.retainer_cases, public.lab_cases from anon;
grant select, insert, update, delete on public.retainer_team, public.lab_team, public.retainer_cases, public.lab_cases to authenticated;

-- A retainer row with a branch is seen by those who may work at that branch; a row with only a city (the Karachi tab) by
-- those who may work in that city. A patient with a portal login still sees their own rows, as before.
drop policy if exists "view retainers" on public.retainer_cases;
drop policy if exists "manage retainers" on public.retainer_cases;
drop policy if exists "view retainer records" on public.retainer_cases;
create policy "view retainer records" on public.retainer_cases for select
  using (((public.has_perm('patients.view') or public.has_perm('retainers.manage'))
          and case when branch_id is not null then public.can_access_branch(branch_id) else public.can_access_city(city_id) end)
         or (patient_id is not null and patient_id = public.current_patient_id()));
drop policy if exists "add retainer records" on public.retainer_cases;
create policy "add retainer records" on public.retainer_cases for insert
  with check (public.has_perm('retainers.manage')
              and case when branch_id is not null then public.can_access_branch(branch_id) else public.can_access_city(city_id) end);
drop policy if exists "edit retainer records" on public.retainer_cases;
create policy "edit retainer records" on public.retainer_cases for update
  using (public.has_perm('retainers.manage')
         and case when branch_id is not null then public.can_access_branch(branch_id) else public.can_access_city(city_id) end)
  with check (public.has_perm('retainers.manage')
              and case when branch_id is not null then public.can_access_branch(branch_id) else public.can_access_city(city_id) end);
-- A row typed in by mistake may be removed by the team; a row copied from the sheet only by Dr. Ali (the copy is the sheet's
-- record, and it is made once).
drop policy if exists "remove retainer records" on public.retainer_cases;
create policy "remove retainer records" on public.retainer_cases for delete
  using (public.has_perm('retainers.manage')
         and case when branch_id is not null then public.can_access_branch(branch_id) else public.can_access_city(city_id) end
         and (source = 'website' or public.is_admin()));

drop policy if exists "view lab cases" on public.lab_cases;
drop policy if exists "manage lab cases" on public.lab_cases;
drop policy if exists "view lab work" on public.lab_cases;
create policy "view lab work" on public.lab_cases for select
  using ((public.has_perm('lab.manage') or public.has_perm('patients.view')) and public.can_access_branch(branch_id));
drop policy if exists "add lab work" on public.lab_cases;
create policy "add lab work" on public.lab_cases for insert
  with check (public.has_perm('lab.manage') and public.can_access_branch(branch_id));
drop policy if exists "edit lab work" on public.lab_cases;
create policy "edit lab work" on public.lab_cases for update
  using (public.has_perm('lab.manage') and public.can_access_branch(branch_id))
  with check (public.has_perm('lab.manage') and public.can_access_branch(branch_id));
drop policy if exists "remove lab work" on public.lab_cases;
create policy "remove lab work" on public.lab_cases for delete
  using (public.has_perm('lab.manage') and public.can_access_branch(branch_id));

-- ---------------------------------------------------------------------------------------------------------------
-- 6. Triggers
-- ---------------------------------------------------------------------------------------------------------------
-- The city always follows the branch (a Karachi branch cannot sit on the Lahore tab), and a row linked to a patient file
-- carries the patient's name too, so it keeps a name if that file is ever deleted (patient_id then becomes null).
-- SECURITY DEFINER for the name: the row must get it even when the writer may not open patient files.
create or replace function private.record_fill() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_table_name = 'retainer_cases' and new.branch_id is not null then
    new.city_id := coalesce((select b.city_id from public.branches b where b.id = new.branch_id), new.city_id);
  end if;
  if new.patient_id is not null and btrim(coalesce(new.patient_name, '')) = '' then
    new.patient_name := (select left(p.full_name, 200) from public.patients p where p.id = new.patient_id);
  end if;
  return new;
end $$;
revoke all on function private.record_fill() from public, anon, authenticated;
drop trigger if exists retainer_cases_fill on public.retainer_cases;
create trigger retainer_cases_fill before insert or update of branch_id, city_id, patient_id, patient_name on public.retainer_cases
  for each row execute function private.record_fill();
drop trigger if exists lab_cases_fill on public.lab_cases;
create trigger lab_cases_fill before insert or update of patient_id, patient_name on public.lab_cases
  for each row execute function private.record_fill();

-- The dates a status implies, when someone on the website sets it: a status that "means" made or delivered fills an empty
-- retainer date with today, delivered also fills the delivered date and, when the row has no check date yet, the first retainer
-- check one calendar month later (the rule of the old Coordinator -> Retainers list: 31 January gives 28 February). The check date
-- stays editable; the Retainer Record and the Coordinator page show it as overdue once its day has passed (web/js/lib/records.js
-- checkState). SECURITY INVOKER on purpose: current_user is 'authenticated' only for a person writing through the website; the
-- import (which runs as its function's owner) and the SQL editor never fill anything, so a sheet row keeps the dates the sheet had
-- (and no copied row has a check date, so none of them is overdue). Staff may read app_settings, where the list is.
create or replace function private.retainer_status_dates() returns trigger
language plpgsql set search_path = public
as $$
declare
  v_list jsonb;
  v_means text;
  v_today date := (now() at time zone 'Asia/Karachi')::date;
begin
  if current_user <> 'authenticated' then return new; end if;
  if new.status is null or (tg_op = 'UPDATE' and new.status is not distinct from old.status) then return new; end if;
  select value into v_list from public.app_settings where key = 'retainer_statuses';
  if jsonb_typeof(v_list) = 'array' then
    select e->>'means' into v_means from jsonb_array_elements(v_list) e where lower(btrim(e->>'label')) = lower(btrim(new.status)) limit 1;
  end if;
  if v_means in ('made', 'delivered') and new.retainer_date is null then
    new.retainer_date := v_today;
    new.retainer_text := null;
  end if;
  if v_means = 'delivered' and new.delivered_date is null then new.delivered_date := v_today; end if;
  if v_means = 'delivered' and new.next_check_date is null then new.next_check_date := (v_today + interval '1 month')::date; end if;
  return new;
end $$;
revoke all on function private.retainer_status_dates() from public, anon, authenticated;
drop trigger if exists retainer_cases_status_dates on public.retainer_cases;
create trigger retainer_cases_status_dates before insert or update of status on public.retainer_cases
  for each row execute function private.retainer_status_dates();

-- Lab work: Received and Fitted fill their own empty date (Fitted fills Received too: it cannot be fitted before it is back).
create or replace function private.lab_status_dates() returns trigger
language plpgsql set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Karachi')::date;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  if new.status in ('received', 'fitted') and new.received_date is null then new.received_date := v_today; end if;
  if new.status = 'fitted' and new.fitted_date is null then new.fitted_date := v_today; end if;
  return new;
end $$;
revoke all on function private.lab_status_dates() from public, anon, authenticated;
drop trigger if exists lab_cases_status_dates on public.lab_cases;
create trigger lab_cases_status_dates before insert or update of status on public.lab_cases
  for each row execute function private.lab_status_dates();

-- Columns only the system sets. The policies let the team change any column of a row they may see, and the API accepts every
-- column, so without this a signed-in colleague could pose as a sheet row (and so dodge "sheet rows are removed by Dr. Ali
-- only"), or write someone else's name as the author.
-- A row changed on the website (by anybody, Dr. Ali too) is marked: linked_by_hand when its patient file was linked or unlinked,
-- edited_on_site when anything on it changed (a status, a date, a payment, a note, a link ...). "Undo the copy" keeps such a row.
-- SECURITY INVOKER on purpose (same reasoning as private.guard_checkup_columns): current_user is 'authenticated' only for a
-- signed-in person writing through the API; the copy runs as the function's owner, and Dr. Ali may do everything else.
create or replace function private.guard_record_columns() returns trigger
language plpgsql set search_path = public
as $$
begin
  if current_user <> 'authenticated' or auth.uid() is null then return new; end if;
  if tg_table_name = 'retainer_cases' then
    new.linked_by_hand := case when tg_op = 'INSERT' then new.patient_id is not null
                               else old.linked_by_hand or new.patient_id is distinct from old.patient_id end;
    new.edited_on_site := case when tg_op = 'INSERT' then false
                               else old.edited_on_site
                                    or (to_jsonb(new) - 'updated_at' - 'linked_by_hand' - 'edited_on_site')
                                       is distinct from (to_jsonb(old) - 'updated_at' - 'linked_by_hand' - 'edited_on_site') end;
  end if;
  if public.is_admin() then return new; end if;
  if tg_table_name = 'retainer_cases' then
    if tg_op = 'INSERT' then
      if new.source <> 'website' or new.source_row is not null or new.source_name is not null then
        raise exception 'NOT_ALLOWED: where a retainer row came from is set by the system and cannot be written by hand.' using errcode = '42501';
      end if;
    elsif new.source is distinct from old.source or new.source_row is distinct from old.source_row or new.source_name is distinct from old.source_name then
      raise exception 'NOT_ALLOWED: where a retainer row came from is set by the system and cannot be changed by hand.' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
  elsif new.created_by is distinct from old.created_by then
    raise exception 'NOT_ALLOWED: who added a row is set by the system and cannot be changed by hand.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function private.guard_record_columns() from public, anon, authenticated;
drop trigger if exists retainer_cases_guard_columns on public.retainer_cases;
create trigger retainer_cases_guard_columns before insert or update on public.retainer_cases
  for each row execute function private.guard_record_columns();
drop trigger if exists lab_cases_guard_columns on public.lab_cases;
create trigger lab_cases_guard_columns before insert or update on public.lab_cases
  for each row execute function private.guard_record_columns();

-- ---------------------------------------------------------------------------------------------------------------
-- 7. The one copy of a Retainer Record tab (Admin -> Import -> "Retainer Record"). Admin only.
-- ---------------------------------------------------------------------------------------------------------------
-- One cell of an imported row, cleaned: trimmed, null when empty or only dashes (- U+2013 U+2014), cut to p_max.
create or replace function private.record_text(p text, p_max int) returns text
language sql immutable parallel safe
return case
  when p is null or p ~ '^[\s\-–—]*$' then null
  else left(regexp_replace(p, '^\s+|\s+$', '', 'g'), p_max)
end;
-- A team member's name as stored: trimmed, single spaces, at most 80 characters; a name typed all in small letters gets
-- capitals ("syed sample" -> "Syed Sample"), any other is kept as written.
create or replace function private.record_name(p text) returns text
language sql immutable parallel safe
return (select case when n = lower(n) then initcap(n) else n end
          from (select left(regexp_replace(btrim(p), '\s+', ' ', 'g'), 80) as n) x
         where p is not null and p !~ '^[\s\-–—]*$');
-- 'YYYY-MM-DD' as a date; anything else, a year outside 2000-2100 or a day that does not exist (2025-02-30) is null.
create or replace function private.record_date(p text) returns date
language plpgsql immutable
as $$
begin
  if p is null or p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or substr(p, 1, 4)::int not between 2000 and 2100 then return null; end if;
  return p::date;
exception when others then
  return null;
end $$;
revoke all on function private.record_text(text, int) from public, anon, authenticated;
revoke all on function private.record_name(text) from public, anon, authenticated;
revoke all on function private.record_date(text) from public, anon, authenticated;

-- The Mr# typed on the sheet, as the website writes Mr#s: digits only, leading zeros left out ("082" -> "82"); null when it is not
-- an Mr# at all ("123-4", letters). The website's reader has the same rule (mrKey in web/js/lib/records.js).
create or replace function private.retainer_mr_key(p text) returns text
language sql immutable parallel safe
return substring(btrim(coalesce(p, '')) from '^0*([1-9][0-9]{0,6})$');

-- The patient file a sheet row's Mr# stands for, and whether the row's name is that patient WITHOUT DOUBT (private.aaj_name_fits,
-- the rule the Aaj ki List sync uses for a typed Mr#: the same first name or an everyday spelling of it, and no other surname):
--   linked        the Mr# is on the website and the name fits: patient_id is that file
--   name_differs  the Mr# is on the website but the name does not fit (a slip in the Mr#, or another person): not linked
--   not_found     no patient file has that Mr#: not linked
--   not_an_mr     the cell is not an Mr# ("123-4"): not linked
-- An unlinked row keeps the Mr# as typed (mr_text), and someone can link it by hand from the row's "More" dialog.
create or replace function private.retainer_mr_match(p_mr text, p_name text, out outcome text, out patient_id uuid)
language plpgsql stable set search_path = public
as $$
declare
  v_key text := private.retainer_mr_key(p_mr);
  v_typed text := btrim(coalesce(p_mr, ''));
begin
  if v_key is null then outcome := 'not_an_mr'; return; end if;
  select p.id into patient_id
    from public.patients p
   where p.mr_number in (v_key, v_typed) and private.aaj_name_fits(p_name, p.full_name)
   order by (p.mr_number = v_typed) desc
   limit 1;
  if patient_id is not null then outcome := 'linked'; return; end if;
  outcome := case when exists (select 1 from public.patients p where p.mr_number in (v_key, v_typed)) then 'name_differs' else 'not_found' end;
end $$;

-- A name as compared with a row an undo kept: its letters, any capitals and spacing.
create or replace function private.retainer_name_key(p text) returns text
language sql immutable parallel safe set search_path = ''
return lower(regexp_replace(btrim(p), '\s+', ' ', 'g'));
-- (earlier drafts of this file imported a tab again and again, matching rows that moved on the sheet, and filled the banner from the
-- last 90 days; a tab is copied once now)
drop function if exists private.retainer_same_name(text, text);
drop function if exists private.retainer_busiest(smallint);

-- The most active makers of a city's tab: by the number of the city's rows they made (the whole tab, whatever the dates), at most three,
-- each with at least a fifth of the rows that have a maker, and only active members who make retainers and work in the city. (On the
-- clinic's tabs in October 2026 that is one maker in Karachi and two in Lahore: the people the owner named.) The copy gives them the
-- strongest colours and, while nobody of that city is in it, the "Retainer Lab" banner; the website's own fallback (topMakers in
-- web/js/lib/records.js) shows the same people when nobody is marked "In the banner".
create or replace function private.retainer_top_makers(p_city smallint) returns table (member_id uuid, rows_made int)
language sql stable set search_path = public
as $$
  with per as (
    select r.made_by as id, count(*)::int as n, sum(count(*)) over () as total
      from public.retainer_cases r
     where r.city_id = p_city and r.made_by is not null
     group by r.made_by
  ), ranked as (
    select per.id, per.n, per.total, row_number() over (order by per.n desc, m.name) as k
      from per join public.retainer_team m on m.id = per.id
     where m.active and (m.city_id is null or m.city_id = p_city) and m.role in ('maker', 'both')
  )
  select id, n from ranked where k <= 3 and n * 5 >= total order by k
$$;
revoke all on function private.retainer_mr_key(text) from public, anon, authenticated;
revoke all on function private.retainer_mr_match(text, text) from public, anon, authenticated;
revoke all on function private.retainer_name_key(text) from public, anon, authenticated;
revoke all on function private.retainer_top_makers(smallint) from public, anon, authenticated;

-- The Import page's preview (nothing is written): which rows of a tab will be linked to a patient file by their Mr#. Admin only.
-- p_rows: [{ "row": 17, "mr": "082", "name": "..." }], at most 3000 (a whole tab). -> { given, linked, name_differs, not_found, not_an_mr,
-- rows: [{ row, outcome }] } (one per row given, in order; outcome as private.retainer_mr_match says).
create or replace function public.retainer_mr_check(p_rows jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v jsonb;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'NOT_ALLOWED: only Dr. Ali can copy the Retainer Record.' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'BAD_ROWS: send the rows as a list.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 3000 then
    raise exception 'TOO_MANY_ROWS: send at most 3000 rows at a time.' using errcode = '22023';
  end if;
  with x as (
    select e.n, case when e.r->>'row' ~ '^[0-9]{1,7}$' then (e.r->>'row')::int end as row_no, m.outcome
      from jsonb_array_elements(p_rows) with ordinality as e(r, n)
      cross join lateral private.retainer_mr_match(private.record_text(e.r->>'mr', 20), private.record_text(e.r->>'name', 200)) m
  )
  select jsonb_build_object(
           'given', count(*),
           'linked', count(*) filter (where outcome = 'linked'),
           'name_differs', count(*) filter (where outcome = 'name_differs'),
           'not_found', count(*) filter (where outcome = 'not_found'),
           'not_an_mr', count(*) filter (where outcome = 'not_an_mr'),
           'rows', coalesce(jsonb_agg(jsonb_build_object('row', row_no, 'outcome', outcome) order by n), '[]'::jsonb))
    into v from x;
  return v;
end $$;
revoke all on function public.retainer_mr_check(jsonb) from public, anon;
grant execute on function public.retainer_mr_check(jsonb) to authenticated;

-- p_rows: the WHOLE tab, a JSON array of at most 3000 objects, one per sheet row, built by web/js/lib/retainers-import.js:
--   { "row": 17, "mr": "082" | null, "name": "...", "contact": "0300..." | null, "impression_date": "2025-04-08" | null,
--     "impression_text": "..." | null, "model_check": "..." | null, "made_by": "..." | null, "retainer_date": "..." | null,
--     "retainer_text": "..." | null, "status": "Delivered to patient" | null, "retainer_sheet": "..." | null, "payment": "..." | null,
--     "notes": "..." | null }
-- ("row" is the row number on the sheet tab; unknown keys are ignored). One bad cell never fails the copy: text is trimmed, empty and
-- dash-only cells are null, long text is cut to the column's limit, a date that is not a real YYYY-MM-DD is "no date" (its typed text
-- is kept), and a typed date text is kept only when there is no date.
-- ONE copy per city. The tab comes in this one call (the clinic's tabs had about 600 and 110 rows in October 2026, a few hundred kB),
-- so a copy is all in or not in at all, and it is taken only while the city has no copied rows (source 'sheet_import'); otherwise it
-- is refused (ALREADY_COPIED) with the day of the copy and its size. Two copies of one city at the same moment wait for each other (a
-- lock per city), so the second is refused too: a call sent again after a lost answer never adds a row twice.
-- After "Undo the copy" (public.undo_retainer_copy) a corrected copy may come: each row the undo kept (it was changed on the website)
-- leaves out ONE sheet row of its name (any capitals and spacing): one with its impression date first, then the one nearest its old row
-- number, since rows move up or down when a sheet is corrected. A date fixed on the website or on the sheet does not stop the pairing (the
-- dates are what a correction fixes most); the pair is then reported (kept_date_differs), as is a kept row that finds no sheet row of its
-- name (kept_other), to be checked by hand. Nothing else is matched: every other sheet row is a new row (so a patient's second line on the
-- sheet is copied too).
-- The Mr#: a row whose Mr# is a patient file on the website AND whose name fits that file (private.retainer_mr_match) is linked to it.
-- The Mr# as typed is kept either way.
-- Model check by and Retainer made by are matched to the team by name (any spacing, any capitals); a name that is not on the team is
-- added (city: this one). A member found in a new role becomes "both"; a member of another city now works in every city.
-- Colours: every maker of the tab whose colour nobody chose yet (new on the team, or still the light grey that means "not chosen")
-- gets one, the most active first: the top makers (private.retainer_top_makers) the strongest of the palette, the others the light
-- ones, each a colour no other active member has where the palette allows (first in this city, then anywhere). Light grey is never
-- given: it is the blank chip and "someone not on the team". A model checker who makes no retainers gets the deep purple. A colour
-- chosen in Clinic setup is never changed.
-- The banner: while no active member who works in this city is "In the banner", the top makers are put there. Dr. Ali's own choice
-- in Clinic setup is never changed.
-- p_dry_run: everything is worked out as for real and then undone, so nothing is kept (the Import page's preview).
-- Result: given / inserted / skipped (up to 100 as { row, item, reason }: the sheet row, or null, and the place in the tab) /
-- skipped_count / kept (sheet rows left out because an undo kept their row) / kept_other (up to 100 as { row, name, kept_name }: a kept
-- row that found no sheet row, by its old row number, the name on that sheet row now or null, and its own name from the sheet) /
-- kept_date_differs (up to 100 as { row, name, kept_date, sheet_date }: a kept row paired with a sheet row that has another impression
-- date, by the sheet row now and its name, the website's date (or null) and the sheet's) /
-- team_added (the names added) / team_colours ([{ name, colour, top }]: the colours this copy gave, the most active first) /
-- top_makers (names, the most active first) / team_featured (the names put in the banner) / mr_given (rows with an Mr#) / linked
-- (linked to the file of their Mr#) / not_linked / not_linked_why { name_differs, not_found, not_an_mr } / dry_run.
-- given = inserted + skipped_count;  mr_given = linked + not_linked.
drop function if exists public.import_retainer_records(smallint, jsonb, boolean, boolean, boolean);   -- (earlier drafts of this file
drop function if exists public.import_retainer_records(smallint, jsonb, boolean, boolean);            --  imported a tab again and again,
drop function if exists public.import_retainer_records(smallint, jsonb, boolean);                     --  in batches)
create or replace function public.import_retainer_records(p_city smallint, p_rows jsonb, p_dry_run boolean default false)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  -- (web/js/lib/records.js has the same two lists: STRONG_COLOURS and LIGHT_COLOURS)
  v_strong text[] := array['navy', 'forest', 'plum', 'ocean', 'brown', 'red', 'black'];
  v_light text[] := array['amber', 'rose', 'teal', 'sky', 'lime', 'peach', 'blue', 'green', 'lavender'];
  v_city text;
  v_copied date;
  n_copied int;
  n_given int;
  n_ins int := 0; n_linked int := 0; n_skip int := 0; n_kept int := 0; n_mr int := 0;
  v_top uuid[];
  v_pick text;
  mk record;
  kp record;
  v_skipped jsonb; v_kept_other jsonb; v_kept_dates jsonb; v_added jsonb; v_top_names jsonb; v_why jsonb;
  v_colours jsonb := '[]'::jsonb;
  v_featured jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'NOT_ALLOWED: only Dr. Ali can copy the Retainer Record.' using errcode = '42501';
  end if;
  select name into v_city from public.cities where id = p_city;
  if p_city is null or v_city is null then
    raise exception 'BAD_CITY: choose the city of this sheet tab.' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'BAD_ROWS: send the rows as a list.' using errcode = '22023';
  end if;
  n_given := jsonb_array_length(p_rows);
  if n_given > 3000 then
    raise exception 'TOO_MANY_ROWS: a tab of more than 3000 rows cannot be copied in one go.' using errcode = '22023';
  end if;
  -- One copy per city: a second copy of the same city waits here for the first, then finds its rows and is refused.
  perform pg_advisory_xact_lock(hashtext('public.import_retainer_records'), p_city);
  select (min(created_at) at time zone 'Asia/Karachi')::date, count(*) into v_copied, n_copied
    from public.retainer_cases where city_id = p_city and source = 'sheet_import';
  if n_copied > 0 then
    raise exception 'ALREADY_COPIED: % was already copied on % (% %). The website is now the Retainer Record: add or change retainers there.',
      v_city, to_char(v_copied, 'FMDD Mon YYYY'), to_char(n_copied, 'FM999,999,990'), case when n_copied = 1 then 'retainer' else 'retainers' end
      using errcode = '55000';
  end if;

  -- (a dry run does the work in this block and then undoes it: the DRY_RUN error at its end rolls the block back, the result stays)
  begin
    -- Fresh work tables for every call, gone at the end of the transaction (dropped first: a pooled connection may hold old ones).
    drop table if exists pg_temp.retainer_import;
    drop table if exists pg_temp.retainer_import_team;
    drop table if exists pg_temp.retainer_import_kept;
    create temp table retainer_import (
      rn int, row_no int, mr text, name text, contact text, imp date, imp_text text, ret date, ret_text text,
      model text, maker text, status text, sheet text, payment text, notes text, skip text,
      model_id uuid, maker_id uuid, kept boolean not null default false, mr_outcome text, mr_patient uuid) on commit drop;
    create temp table retainer_import_team (key text primary key, name text, as_model boolean, as_maker boolean, rows_made int,
      id uuid, added boolean not null default false) on commit drop;
    create temp table retainer_import_kept (id uuid primary key, row_no int, name text, imp date, rn int) on commit drop;

    insert into retainer_import (rn, row_no, mr, name, contact, imp, imp_text, ret, ret_text, model, maker, status, sheet, payment, notes)
    select e.n::int,
           case when e.r->>'row' ~ '^[0-9]{1,7}$' and (e.r->>'row')::int between 1 and 1000000 then (e.r->>'row')::int end,
           private.record_text(e.r->>'mr', 20),
           private.record_text(e.r->>'name', 200),
           private.record_text(e.r->>'contact', 60),
           private.record_date(e.r->>'impression_date'),
           private.record_text(e.r->>'impression_text', 100),
           private.record_date(e.r->>'retainer_date'),
           private.record_text(e.r->>'retainer_text', 100),
           private.record_name(e.r->>'model_check'),
           private.record_name(e.r->>'made_by'),
           private.record_text(e.r->>'status', 60),
           private.record_text(e.r->>'retainer_sheet', 60),
           private.record_text(e.r->>'payment', 60),
           private.record_text(e.r->>'notes', 2000)
      from jsonb_array_elements(p_rows) with ordinality as e(r, n);
    -- The typed text of a date is kept only when there is no date.
    update retainer_import set imp_text = null where imp is not null and imp_text is not null;
    update retainer_import set ret_text = null where ret is not null and ret_text is not null;

    update retainer_import set skip = 'No sheet row number' where row_no is null;
    update retainer_import set skip = 'No patient name' where skip is null and name is null;
    -- The same sheet row twice: the first wins.
    update retainer_import i set skip = 'The same sheet row is in the tab twice'
     where i.skip is null and exists (select 1 from retainer_import f where f.skip is null and f.row_no = i.row_no and f.rn < i.rn);

    -- The rows an undo kept (changed on the website; each remembers its sheet row and name): each takes at most one sheet row of its
    -- name, one with its impression date first, then the nearest to its old row number (a corrected sheet moves rows up or down), and
    -- that sheet row is left out. The date only chooses: a date fixed on either side still finds its own row. One to one: a second line
    -- of the same patient is copied. A kept row that finds none is reported below (both may then be on the website, to be checked by hand).
    insert into retainer_import_kept (id, row_no, name, imp)
    select r.id, r.source_row, r.source_name, r.impression_date
      from public.retainer_cases r
     where r.city_id = p_city and r.source = 'website' and r.source_row is not null and r.source_name is not null;
    for kp in
      select k.id, i.rn
        from retainer_import_kept k
        join retainer_import i on i.skip is null and private.retainer_name_key(i.name) = private.retainer_name_key(k.name)
       order by coalesce(k.imp = i.imp, false) desc, abs(i.row_no - k.row_no), k.row_no, i.rn
    loop
      if not exists (select 1 from retainer_import_kept where id = kp.id and rn is not null)
         and not exists (select 1 from retainer_import where rn = kp.rn and kept) then
        update retainer_import_kept set rn = kp.rn where id = kp.id;
        update retainer_import set kept = true where rn = kp.rn;
      end if;
    end loop;
    update retainer_import set skip = 'Kept from the earlier copy (changed on the website), so it is not copied again' where kept;

    -- The Mr#: the patient file it stands for, when the name fits that file too.
    update retainer_import i set (mr_outcome, mr_patient) = (select m.outcome, m.patient_id from private.retainer_mr_match(i.mr, i.name) m)
     where i.skip is null and i.mr is not null;

    -- The team: every name used, with the roles it is used in and how many rows it made.
    insert into retainer_import_team (key, name, as_model, as_maker, rows_made)
    select lower(x.nm), min(x.nm), bool_or(x.kind = 'model'), bool_or(x.kind = 'maker'), count(*) filter (where x.kind = 'maker')
      from (select model as nm, 'model' as kind from retainer_import where skip is null and model is not null
            union all
            select maker, 'maker' from retainer_import where skip is null and maker is not null) x
     group by lower(x.nm);
    update retainer_import_team t set id = m.id from public.retainer_team m where lower(m.name) = t.key;
    update public.retainer_team m set role = 'both'
      from retainer_import_team t
     where m.id = t.id and ((t.as_maker and m.role = 'model_check') or (t.as_model and m.role = 'maker'));
    update public.retainer_team m set city_id = null
      from retainer_import_team t
     where m.id = t.id and m.city_id is not null and m.city_id <> p_city;
    -- (a maker's colour is chosen below, once the rows are in; light grey until then)
    with ins as (
      insert into public.retainer_team (name, role, colour, city_id)
      select t.name,
             case when t.as_model and t.as_maker then 'both' when t.as_model then 'model_check' else 'maker' end,
             case when t.as_maker then 'grey' else 'purple' end,
             p_city
        from retainer_import_team t where t.id is null
       order by t.name
      on conflict ((lower(name))) do nothing
      returning id, lower(name) as key)
    update retainer_import_team t set id = ins.id, added = true from ins where ins.key = t.key;
    -- (a name another session added a moment ago)
    update retainer_import_team t set id = m.id from public.retainer_team m where t.id is null and lower(m.name) = t.key;
    update retainer_import i set model_id = t.id from retainer_import_team t where i.model is not null and t.key = lower(i.model);
    update retainer_import i set maker_id = t.id from retainer_import_team t where i.maker is not null and t.key = lower(i.maker);

    -- The rows, each with the name it has on the sheet.
    with ins as (
      insert into public.retainer_cases (city_id, patient_id, patient_name, mr_text, contact, impression_date, impression_text, retainer_date,
                                         retainer_text, model_check_by, made_by, status, retainer_sheet, payment, notes, source, source_row,
                                         source_name, created_by)
      select p_city, i.mr_patient, i.name, i.mr, i.contact, i.imp, i.imp_text, i.ret, i.ret_text,
             i.model_id, i.maker_id, i.status, i.sheet, i.payment, i.notes, 'sheet_import', i.row_no, i.name, auth.uid()
        from retainer_import i
       where i.skip is null
       order by i.rn
      returning patient_id)
    select count(*), count(*) filter (where patient_id is not null) into n_ins, n_linked from ins;

    -- The colours, the most active maker first (see above).
    select coalesce(array_agg(t.member_id order by t.rows_made desc, m.name), '{}') into v_top
      from private.retainer_top_makers(p_city) t join public.retainer_team m on m.id = t.member_id;
    for mk in
      select t.id, r.name, t.id = any(v_top) as top
        from retainer_import_team t join public.retainer_team r on r.id = t.id
       where t.as_maker and (t.added or r.colour = 'grey')
       order by coalesce(array_position(v_top, t.id), 99), t.rows_made desc, r.name
    loop
      select u.c into v_pick
        from unnest(case when mk.top then v_strong || v_light else v_light || v_strong end) with ordinality as u(c, o)
       order by exists (select 1 from public.retainer_team x where x.id <> mk.id and x.active and x.colour = u.c and (x.city_id is null or x.city_id = p_city)),
                exists (select 1 from public.retainer_team x where x.id <> mk.id and x.active and x.colour = u.c),
                u.o
       limit 1;
      update public.retainer_team set colour = v_pick where id = mk.id;
      v_colours := v_colours || jsonb_build_array(jsonb_build_object('name', mk.name, 'colour', v_pick, 'top', mk.top));
    end loop;

    -- The "Retainer Lab" banner, while nobody who works in this city is in it.
    select coalesce(jsonb_agg(m.name order by array_position(v_top, m.id)), '[]'::jsonb) into v_top_names
      from public.retainer_team m where m.id = any(v_top);
    if not exists (select 1 from public.retainer_team m where m.featured and m.active and (m.city_id is null or m.city_id = p_city)) then
      with feat as (
        update public.retainer_team m set featured = true where m.id = any(v_top) returning m.id, m.name)
      select coalesce(jsonb_agg(name order by array_position(v_top, id)), '[]'::jsonb) into v_featured from feat;
    end if;

    select count(*), count(*) filter (where kept) into n_skip, n_kept from retainer_import where skip is not null;
    select count(*) into n_mr from retainer_import where skip is null and mr is not null;
    select jsonb_build_object('name_differs', count(*) filter (where mr_outcome = 'name_differs'),
                              'not_found', count(*) filter (where mr_outcome = 'not_found'),
                              'not_an_mr', count(*) filter (where mr_outcome = 'not_an_mr')) into v_why
      from retainer_import where skip is null and mr is not null and mr_patient is null;
    select coalesce(jsonb_agg(jsonb_build_object('row', s.row_no, 'item', s.rn, 'reason', s.skip) order by s.rn), '[]'::jsonb) into v_skipped
      from (select * from retainer_import where skip is not null order by rn limit 100) s;
    select coalesce(jsonb_agg(jsonb_build_object('row', k.row_no, 'kept_name', k.name,
                              'name', (select i.name from retainer_import i where i.row_no = k.row_no and i.name is not null order by i.rn limit 1))
                              order by k.row_no, k.name), '[]'::jsonb) into v_kept_other
      from (select * from retainer_import_kept where rn is null order by row_no, name limit 100) k;
    select coalesce(jsonb_agg(jsonb_build_object('row', x.row_no, 'name', x.name, 'kept_date', x.kept_date, 'sheet_date', x.imp) order by x.row_no), '[]'::jsonb)
      into v_kept_dates
      from (select i.row_no, i.name, k.imp as kept_date, i.imp from retainer_import_kept k join retainer_import i on i.rn = k.rn
             where i.imp is not null and k.imp is distinct from i.imp order by i.row_no limit 100) x;
    select coalesce(jsonb_agg(t.name order by t.name), '[]'::jsonb) into v_added from retainer_import_team t where t.added;

    v_result := jsonb_build_object('given', n_given, 'inserted', n_ins, 'skipped', v_skipped, 'skipped_count', n_skip,
                                   'kept', n_kept, 'kept_other', v_kept_other, 'kept_date_differs', v_kept_dates,
                                   'team_added', v_added, 'team_colours', v_colours, 'top_makers', v_top_names, 'team_featured', v_featured,
                                   'mr_given', n_mr, 'linked', n_linked, 'not_linked', n_mr - n_linked, 'not_linked_why', v_why,
                                   'dry_run', coalesce(p_dry_run, false));
    if coalesce(p_dry_run, false) then
      raise exception 'DRY_RUN: nothing was kept.' using errcode = 'RTDRY';
    end if;
  exception when sqlstate 'RTDRY' then
    null;   -- the dry run's work is undone; its result is returned
  end;
  return v_result;
end $$;

revoke all on function public.import_retainer_records(smallint, jsonb, boolean) from public, anon;
grant execute on function public.import_retainer_records(smallint, jsonb, boolean) to authenticated;

-- "Undo the copy for <city>" (Admin -> Import, Dr. Ali only), so a corrected copy can be made: the city's copied rows that NOBODY changed
-- on the website go. A copied row somebody changed (edited, linked to a patient file, a payment set ...: edited_on_site or linked_by_hand)
-- stays, as one of the website's own rows from now on: it keeps where it came from (source_row, source_name), so a new copy leaves its
-- sheet row out (import_retainer_records). With p_dry_run nothing changes: it says what the undo would do (the page's question).
-- -> { city, removed, stayed, dry_run }. A city with no copy: NOT_COPIED. Every removed row is in the audit log.
create or replace function public.undo_retainer_copy(p_city smallint, p_dry_run boolean default false)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_city text;
  n_all int;
  n_stay int;
  n_gone int;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'NOT_ALLOWED: only Dr. Ali can undo a copy of the Retainer Record.' using errcode = '42501';
  end if;
  select name into v_city from public.cities where id = p_city;
  if p_city is null or v_city is null then
    raise exception 'BAD_CITY: choose the city of the copy.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('public.import_retainer_records'), p_city);   -- (never while a copy of the city is going in)
  select count(*), count(*) filter (where edited_on_site or linked_by_hand) into n_all, n_stay
    from public.retainer_cases where city_id = p_city and source = 'sheet_import';
  if n_all = 0 then
    raise exception 'NOT_COPIED: % has no copy of the sheet to undo.', v_city using errcode = '22023';
  end if;
  n_gone := n_all - n_stay;
  if not coalesce(p_dry_run, false) then
    delete from public.retainer_cases where city_id = p_city and source = 'sheet_import' and not edited_on_site and not linked_by_hand;
    get diagnostics n_gone = row_count;
    update public.retainer_cases set source = 'website' where city_id = p_city and source = 'sheet_import';
  end if;
  return jsonb_build_object('city', v_city, 'removed', n_gone, 'stayed', n_stay, 'dry_run', coalesce(p_dry_run, false));
end $$;
revoke all on function public.undo_retainer_copy(smallint, boolean) from public, anon;
grant execute on function public.undo_retainer_copy(smallint, boolean) to authenticated;

-- Which cities have a copy (the Import page shows each with its "Undo the copy" button). Dr. Ali only.
-- -> [{ city_id, city, copied_on, retainers, changed, kept }]: the day of the copy, its rows, how many of them were changed on the website
-- (an undo keeps those), and the rows an earlier undo kept (website rows that came from the sheet). A city with neither is not listed.
create or replace function public.retainer_copies()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v jsonb;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'NOT_ALLOWED: only Dr. Ali can see the copies of the Retainer Record.' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('city_id', c.id, 'city', c.name, 'copied_on', x.copied_on, 'retainers', x.retainers,
                                               'changed', x.changed, 'kept', x.kept) order by c.id), '[]'::jsonb)
    into v
    from (select r.city_id,
                 ((min(r.created_at) filter (where r.source = 'sheet_import')) at time zone 'Asia/Karachi')::date as copied_on,
                 count(*) filter (where r.source = 'sheet_import') as retainers,
                 count(*) filter (where r.source = 'sheet_import' and (r.edited_on_site or r.linked_by_hand)) as changed,
                 count(*) filter (where r.source = 'website') as kept
            from public.retainer_cases r
           where r.source = 'sheet_import' or (r.source = 'website' and r.source_row is not null)
           group by r.city_id) x
    join public.cities c on c.id = x.city_id;
  return v;
end $$;
revoke all on function public.retainer_copies() from public, anon;
grant execute on function public.retainer_copies() to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 7b. Clinic setup: new wording for a status or a lab work type keeps its rows
-- ---------------------------------------------------------------------------------------------------------------
-- The rows keep the words of the list (a status, a work type), and what a status "means" is looked up by those words. So when Dr. Ali
-- writes a status in other words ("Delivered to patient" -> "Delivered"), the item on the list AND every row that has the old words take
-- the new ones, in one go: no row drops off the list as "not on the list", and Delivered keeps counting in the banner. Words match
-- the way the website matches them: any capitals, spaces and punctuation ("Re-purchase needed" is "repurchase needed").
-- p_list: 'retainer_statuses' (retainer_cases.status) or 'lab_work_types' (lab_cases.work_type). -> how many rows now have the new words.
-- Admin only. Every changed row is in the audit log (who and when), like any other change.
create or replace function public.rename_record_option(p_list text, p_from text, p_to text)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_from text := regexp_replace(lower(coalesce(p_from, '')), '[^a-z0-9]+', '', 'g');
  v_to text := regexp_replace(btrim(coalesce(p_to, '')), '\s+', ' ', 'g');
  v_list jsonb;
  n int := 0;
begin
  if not public.is_admin() then
    raise exception 'NOT_ALLOWED: only Dr. Ali can change these lists.' using errcode = '42501';
  end if;
  if p_list is null or p_list not in ('retainer_statuses', 'lab_work_types') then
    raise exception 'BAD_LIST: only the retainer statuses and the lab work types can be renamed here.' using errcode = '22023';
  end if;
  if v_from = '' or regexp_replace(lower(v_to), '[^a-z0-9]+', '', 'g') = '' or length(v_to) > 60 then
    raise exception 'BAD_NAME: write the new words (at most 60 characters).' using errcode = '22023';
  end if;
  select value into v_list from public.app_settings where key = p_list for update;
  if jsonb_typeof(v_list) = 'array' then
    if exists (select 1 from jsonb_array_elements(v_list) e
                where regexp_replace(lower(coalesce(e->>'label', '')), '[^a-z0-9]+', '', 'g') = regexp_replace(lower(v_to), '[^a-z0-9]+', '', 'g')
                  and regexp_replace(lower(coalesce(e->>'label', '')), '[^a-z0-9]+', '', 'g') <> v_from) then
      raise exception 'ALREADY_ON_LIST: "%" is on the list already.', v_to using errcode = '23505';
    end if;
    update public.app_settings
       set value = (select jsonb_agg(case when regexp_replace(lower(coalesce(e->>'label', '')), '[^a-z0-9]+', '', 'g') = v_from
                                          then jsonb_set(e, '{label}', to_jsonb(v_to)) else e end order by o)
                      from jsonb_array_elements(v_list) with ordinality x(e, o)),
           updated_at = now()
     where key = p_list;
  end if;
  if p_list = 'retainer_statuses' then
    update public.retainer_cases set status = v_to
     where regexp_replace(lower(status), '[^a-z0-9]+', '', 'g') = v_from and status is distinct from v_to;
  else
    update public.lab_cases set work_type = v_to
     where regexp_replace(lower(work_type), '[^a-z0-9]+', '', 'g') = v_from and work_type is distinct from v_to;
  end if;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.rename_record_option(text, text, text) from public, anon;
grant execute on function public.rename_record_option(text, text, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 7c. Reports -> Accounts -> "Lab and retainer costs" on the reshaped tables
-- ---------------------------------------------------------------------------------------------------------------
-- public.clinic_report exactly as 20261007001500 left it, with one change in 'lab_costs': a retainer is counted only when it has a lab
-- cost (the hundreds of rows copied from the Retainer Record sheet have none and are no "cases" of a cost report), in the month of its
-- retainer date, else its impression date, else the day it was added on the website (before, a row without an impression date was filed
-- under the day it was added, so the whole import landed in one month). Lab work is still counted by its Sent date; a case without one
-- (the Sent date may now be left empty) by the day it came back, else was fitted, else was added, so its cost is never left out. (No
-- other branch of the website changes clinic_report; one that does later must start from this version.)
create or replace function public.clinic_report(p_kind text, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  r jsonb;
  t_from timestamptz := (p_from::timestamp at time zone 'Asia/Karachi');
  t_to   timestamptz := ((p_to + 1)::timestamp at time zone 'Asia/Karachi');
begin
  if not (public.is_admin() or public.has_perm('finance.view')) then
    raise exception 'Only accounts and Dr. Ali can see reports' using errcode = '42501';
  end if;

  if p_kind = 'pnl_trend' then
    -- Per month and branch: income (payments), expenses tagged to the branch, expenses with no branch (per city).
    select coalesce(jsonb_agg(x order by x->>'month', x->>'branch_id'), '[]') into r from (
      select jsonb_build_object('month', m, 'branch_id', b, 'city_id', c, 'income', sum(inc), 'expenses', sum(exp)) x
        from (
          select to_char(received_at at time zone 'Asia/Karachi', 'YYYY-MM') m, branch_id b, null::smallint c, amount inc, 0 exp
            from public.payments where received_at >= t_from and received_at < t_to
          union all
          select to_char(expense_date, 'YYYY-MM'), branch_id, case when branch_id is null then city_id end, 0, amount
            from public.expenses where expense_date between p_from and p_to) u
       group by m, b, c) s;

  elsif p_kind = 'payment_methods' then
    select coalesce(jsonb_agg(x order by x->>'month'), '[]') into r from (
      select jsonb_build_object('month', to_char(received_at at time zone 'Asia/Karachi', 'YYYY-MM'), 'method', method, 'amount', sum(amount), 'count', count(*)) x
        from public.payments where received_at >= t_from and received_at < t_to
       group by to_char(received_at at time zone 'Asia/Karachi', 'YYYY-MM'), method) s;

  elsif p_kind = 'referrals' then
    select coalesce(jsonb_agg(x order by (x->>'patients')::int desc), '[]') into r from (
      select jsonb_build_object('source', coalesce(nullif(referral_source, ''), 'Not recorded'), 'branch_id', first_branch_id, 'patients', count(*)) x
        from public.patients where (created_at at time zone 'Asia/Karachi')::date between p_from and p_to
       group by coalesce(nullif(referral_source, ''), 'Not recorded'), first_branch_id) s;

  elsif p_kind = 'braces' then
    -- Bondings and braces-off visits by month (works for imported history too), plus cases started on the website.
    select coalesce(jsonb_agg(x order by x->>'month'), '[]') into r from (
      select jsonb_build_object('month', m, 'branch_id', b, 'bondings', sum(bond), 'braces_off', sum(off), 'cases_started', sum(cs)) x
        from (
          select to_char(visit_date, 'YYYY-MM') m, branch_id b,
                 case when treatment_label ilike '%bonding%' then 1 else 0 end bond,
                 case when treatment_label ilike '%braces off%' or treatment_label ilike '%debond%' then 1 else 0 end off, 0 cs
            from public.visits where visit_date between p_from and p_to and status = 'completed'
          union all
          select to_char(start_date, 'YYYY-MM'), bonding_branch_id, 0, 0, 1 from public.braces_cases where start_date between p_from and p_to) u
       group by m, b
      having sum(bond) + sum(off) + sum(cs) > 0) s;

  elsif p_kind = 'dues_by_branch' then
    select coalesce(jsonb_agg(x order by (x->>'dues')::numeric desc), '[]') into r from (
      select jsonb_build_object('branch_id', p.first_branch_id, 'patients', count(*), 'dues', sum(b.dues)) x
        from public.patient_balances b join public.patients p on p.id = b.patient_id
       where b.dues > 0 group by p.first_branch_id) s;

  elsif p_kind = 'top_dues' then
    select coalesce(jsonb_agg(x), '[]') into r from (
      select jsonb_build_object('patient_id', p.id, 'mr_number', p.mr_number, 'full_name', p.full_name, 'phone', p.phone, 'branch_id', p.first_branch_id, 'dues', b.dues,
               'last_payment', (select max(received_at)::date from public.payments y where y.patient_id = p.id)) x
        from public.patient_balances b join public.patients p on p.id = b.patient_id
       where b.dues > 0 order by b.dues desc limit 100) s;

  elsif p_kind = 'photo_compliance' then
    select coalesce(jsonb_agg(x order by x->>'month', x->>'branch_id'), '[]') into r from (
      select jsonb_build_object('month', to_char(visit_date, 'YYYY-MM'), 'branch_id', branch_id, 'photo_months', count(*), 'uploaded', count(*) filter (where photos_uploaded)) x
        from public.visits where visit_date between p_from and p_to and photo_required and status = 'completed'
       group by to_char(visit_date, 'YYYY-MM'), branch_id) s;

  elsif p_kind = 'lab_costs' then
    select coalesce(jsonb_agg(x order by x->>'month', x->>'branch_id'), '[]') into r from (
      select jsonb_build_object('month', m, 'branch_id', b, 'cases', count(*), 'cost', sum(c)) x
        from (
          select to_char(d, 'YYYY-MM') m, branch_id b, coalesce(cost, 0) c
            from (select coalesce(sent_date, received_date, fitted_date, (created_at at time zone 'Asia/Karachi')::date) d, branch_id, cost
                    from public.lab_cases where status <> 'cancelled') lc
           where d between p_from and p_to
          union all
          select to_char(d, 'YYYY-MM'), branch_id, lab_cost
            from (select coalesce(retainer_date, impression_date, (created_at at time zone 'Asia/Karachi')::date) d, branch_id, lab_cost
                    from public.retainer_cases where lab_cost is not null) rc
           where d between p_from and p_to) u
       group by m, b) s;

  elsif p_kind = 'doctors' then
    -- Visits treated/checked, invoices made from those visits, and (for the 60/40 rule) what the
    -- doctor's own patients were invoiced in the period: patients marked "brought in by" that doctor.
    select coalesce(jsonb_agg(x order by (x->>'treated')::int desc), '[]') into r from (
      with work as (
        select c.id, c.display_name, c.doctor_group_id,
               count(*) filter (where vs.role = 'doctor') treated, count(*) filter (where vs.role = 'checker') checked, count(*) filter (where vs.role = 'assistant') assisted,
               count(distinct v.visit_date) filter (where vs.role = 'doctor') days,
               coalesce(sum(i.total) filter (where vs.role = 'doctor'), 0) billed
          from public.visit_staff vs
          join public.visits v on v.id = vs.visit_id and v.status = 'completed' and v.visit_date between p_from and p_to
          join public.clinicians c on c.id = vs.clinician_id
          left join public.invoices i on i.visit_id = v.id and i.status = 'issued'
         group by c.id, c.display_name, c.doctor_group_id),
      own as (
        select p.referred_by_clinician id, count(distinct p.id) referred_patients, coalesce(sum(i.total), 0) referred_billed,
               coalesce((select sum(y.amount) from public.payments y where y.patient_id in (select id from public.patients q where q.referred_by_clinician = p.referred_by_clinician)
                           and y.received_at >= t_from and y.received_at < t_to), 0) referred_paid
          from public.patients p
          left join public.invoices i on i.patient_id = p.id and i.status = 'issued' and i.issue_date between p_from and p_to
         where p.referred_by_clinician is not null
         group by p.referred_by_clinician)
      select jsonb_build_object('clinician_id', c.id, 'name', c.display_name, 'group', c.doctor_group_id,
               'treated', coalesce(w.treated, 0), 'checked', coalesce(w.checked, 0), 'assisted', coalesce(w.assisted, 0), 'days', coalesce(w.days, 0), 'billed', coalesce(w.billed, 0),
               'referred_patients', coalesce(o.referred_patients, 0), 'referred_billed', coalesce(o.referred_billed, 0), 'referred_paid', coalesce(o.referred_paid, 0)) x
        from public.clinicians c
        left join work w on w.id = c.id
        left join own o on o.id = c.id
       where c.is_doctor and (w.id is not null or o.id is not null)) s;

  elsif p_kind = 'treatments' then
    select coalesce(jsonb_agg(x order by (x->>'amount')::numeric desc), '[]') into r from (
      select jsonb_build_object('treatment', coalesce(t.name, it.description), 'count', sum(it.quantity), 'amount', sum(it.line_total)) x
        from public.invoice_items it join public.invoices i on i.id = it.invoice_id and i.status = 'issued' and i.issue_date between p_from and p_to
        left join public.treatments t on t.id = it.treatment_id
       group by coalesce(t.name, it.description) order by sum(it.line_total) desc limit 60) s;

  elsif p_kind = 'visits' then
    -- A new patient = their first completed visit ever falls in this month.
    select coalesce(jsonb_agg(x order by x->>'month', x->>'branch_id'), '[]') into r from (
      with first_visit as (select patient_id, min(visit_date) d from public.visits where status = 'completed' group by patient_id)
      select jsonb_build_object('month', to_char(v.visit_date, 'YYYY-MM'), 'branch_id', v.branch_id, 'visits', count(*) filter (where v.status = 'completed'),
               'patients', count(distinct v.patient_id) filter (where v.status = 'completed'), 'no_shows', count(*) filter (where v.status = 'no_show'),
               'new_patients', count(distinct v.patient_id) filter (where v.status = 'completed' and f.d = v.visit_date),
               'avg_wait_min', round(avg(extract(epoch from (v.started_at - v.checked_in_at)) / 60) filter (where v.started_at is not null and v.checked_in_at is not null and v.started_at > v.checked_in_at))) x
        from public.visits v left join first_visit f on f.patient_id = v.patient_id
       where v.visit_date between p_from and p_to
       group by to_char(v.visit_date, 'YYYY-MM'), v.branch_id) s;

  else
    raise exception 'Unknown report %', p_kind;
  end if;
  return r;
end $$;

revoke all on function public.clinic_report(text, date, date) from public, anon;
grant execute on function public.clinic_report(text, date, date) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 8. Audit and updated_at for the teams (retainer_cases and lab_cases have had both since 20261005000200)
-- ---------------------------------------------------------------------------------------------------------------
drop trigger if exists retainer_team_touch on public.retainer_team;
create trigger retainer_team_touch before update on public.retainer_team
  for each row execute function public.touch_updated_at();
drop trigger if exists lab_team_touch on public.lab_team;
create trigger lab_team_touch before update on public.lab_team
  for each row execute function public.touch_updated_at();
drop trigger if exists retainer_team_audit on public.retainer_team;
create trigger retainer_team_audit after insert or update or delete on public.retainer_team
  for each row execute function public.audit_row();
drop trigger if exists lab_team_audit on public.lab_team;
create trigger lab_team_audit after insert or update or delete on public.lab_team
  for each row execute function public.audit_row();

notify pgrst, 'reload schema';
