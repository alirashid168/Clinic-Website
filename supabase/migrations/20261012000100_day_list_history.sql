-- =============================================================================
-- Aaj ki List: "End the day" and the History of Aaj ki List.
--
-- The owner's request (12 Oct 2026): "like we enter aaj ki list, there should be a button for us like "end the day" which makes
-- a copy of all done patients, and then resets the aaj ki list sheet in the website. so we know the new day has started. all the
-- list should be stored on the website with a history button like "History of Aaj ki list" and all those entries should sabe the
-- list with date - branch name - and then the actual list after clicking it"
--
-- What this file adds
--   1. public.day_list_closings: the saved copy of one branch's list for one day (its rows in list order and their counts).
--      Written by end_day() only, never directly. Staff with "View Aaj ki List" read the lines of their own branches; the copy
--      itself (snapshot) is read through day_list_copy(), which leaves out what the reader may not see (dues, phone numbers).
--   2. The permission 'sheet.end_day' ("End the day on the Aaj ki List"): on for every role that may edit the list today.
--   3. public.end_day(branch, day): builds the copy ON THE SERVER from that list's visits and checkup patients (nothing the
--      browser sends is stored), saves it, and writes audit_log. Ending a day again replaces the copy (times_updated counts up,
--      and the audit log keeps the copy it replaced). It changes nothing on the list: a patient still waiting stays waiting,
--      and the Google Sheet sync works on that day exactly as before. The "reset" is the website opening the next day's list.
--   4. public.day_list_history(...): one line per day and branch that has a list or a saved copy, newest first, with counts,
--      and with who ended it. Fast over years of lists: one index probe per day, and counts only for the lines of the page.
--   5. public.day_list_copy(branch, day): one day's list, read only: the saved copy when the day was ended, otherwise the list
--      as it is stored now, built by the same function as the copy (so both have the same columns and order).
--   6. An index on checkups (branch_id, checkup_date) for the day lists, and one on invoices (visit_id) for each row's
--      has_invoice. Visits already have visits_branch_date_idx (branch_id, visit_date) from 20261005000100_core_schema.sql.
--
-- Additive and safe to run more than once. Needs 20261009000250_checkups.sql (checkups) first. It does not touch any function
-- of the Google Sheet sync (20261009000300, 20261011000100).
-- =============================================================================

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

do $$
begin
  if to_regclass('public.checkups') is null then
    raise exception 'Apply 20261009000250_checkups.sql before this file: a day''s list includes its checkup patients.';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. The saved copies
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.day_list_closings (
  id             uuid primary key default gen_random_uuid(),
  branch_id      smallint not null references public.branches(id),
  list_date      date not null,
  closed_at      timestamptz not null default now(),          -- the last time the day was ended
  closed_by      uuid,                                         -- who ended it last (staff id = auth.uid())
  closed_by_name text,                                         -- their name at that moment: kept if the account is removed later
  snapshot       jsonb not null default '[]'::jsonb,           -- the rows in list order (private.day_list_rows)
  counts         jsonb not null default '{}'::jsonb,           -- private.day_list_counts of the rows
  times_updated  integer not null default 0,                   -- 0 = ended once; one more every time it is ended again
  constraint day_list_closings_one_per_day unique (branch_id, list_date),
  constraint day_list_closings_snapshot_array check (jsonb_typeof(snapshot) = 'array'),
  constraint day_list_closings_counts_object check (jsonb_typeof(counts) = 'object'),
  constraint day_list_closings_times_updated check (times_updated >= 0)
);

comment on table public.day_list_closings is
  'Aaj ki List "End the day": the saved copy of one branch''s list for one day. Written by public.end_day() only.';

create index if not exists day_list_closings_date_idx on public.day_list_closings (list_date);

alter table public.day_list_closings enable row level security;

-- Read: the people who see the Aaj ki List, at their own branches. There is no insert, update or delete policy and no such
-- right, so nobody (Dr. Ali included) changes a copy except through end_day().
drop policy if exists "view day list closings" on public.day_list_closings;
create policy "view day list closings" on public.day_list_closings for select
  using (public.has_perm('sheet.view') and public.can_access_branch(branch_id));

-- The copy itself (snapshot) holds the patients' dues and phone numbers: it is read through day_list_copy(), which leaves out
-- what the reader may not see. The other columns (the line in the History) may be read directly.
revoke all on public.day_list_closings from public, anon, authenticated;
grant select (id, branch_id, list_date, closed_at, closed_by, closed_by_name, counts, times_updated)
  on public.day_list_closings to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. The permission
-- ---------------------------------------------------------------------------------------------------------------
insert into public.permissions (key, label, category, sort_order) values
  ('sheet.end_day', 'End the day on the Aaj ki List', 'Daily list', 23)
on conflict (key) do nothing;

-- On by default for the roles that may add and edit Aaj ki List entries now (front desk, assistant, doctor and coordinator in the
-- seed; whatever Dr. Ali has ticked since), and for admin. Run again, it leaves a choice made in the access list alone.
insert into public.role_permissions (role, permission_key, allowed)
select r.role, 'sheet.end_day', r.role = 'admin' or coalesce(rp.allowed, false)
  from unnest(enum_range(null::public.staff_role)) as r(role)
  left join public.role_permissions rp on rp.role = r.role and rp.permission_key = 'sheet.edit'
on conflict (role, permission_key) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Indexes for the checkups of a day (the old list's month rows are left out, as the day list leaves them out) and for a
--    visit's invoice (has_invoice on every row; without it each row reads all the invoices, years of them after the import)
-- ---------------------------------------------------------------------------------------------------------------
create index if not exists checkups_branch_day_idx on public.checkups (branch_id, checkup_date) where not date_is_month;
create index if not exists invoices_visit_idx on public.invoices (visit_id) where visit_id is not null;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. One day's list, built on the server
-- ---------------------------------------------------------------------------------------------------------------
-- The checkup patients shown on a day's list: the exact-day rows of that branch (never the old list's month rows), except a
-- person who has become a patient and has a visit on the same list (the visit row stands for them). The same rule as
-- dayListCheckups() in web/js/lib/checkups.js.
create or replace function private.day_list_checkups(p_branch smallint, p_date date)
returns setof public.checkups
language sql stable set search_path = public
as $$
  select c.*
    from public.checkups c
   where c.branch_id = p_branch and c.checkup_date = p_date and not c.date_is_month
     and not (c.patient_id is not null
              and exists (select 1 from public.visits v where v.branch_id = p_branch and v.visit_date = p_date and v.patient_id = c.patient_id))
$$;

-- One branch's list for one day, as the Aaj ki List shows it: a jsonb array of rows in list order.
--
-- Rows: every visit of that branch on that day, then the checkup patients of private.day_list_checkups().
-- Order (the clinic's Google Sheet, owner 11 Oct 2026; the same rules as listOrder in web/js/views/staff/sheet.js):
--   1. by status: Waiting, In treatment, Scheduled, a checkup patient with no status yet, Completed, Cancelled, No show;
--   2. inside one status the patients (visits) before the checkup patients;
--   3. then by token: a visit's token number; a checkup's token when it is a whole number ("7"); any other text, or none, last;
--   4. then by when the row was added, and by its id (the uuid itself, not its text): the Aaj ki List asks for the same, so rows
--      added at the same moment with no token (every row of an imported day: Healthwire, the old Aaj ki List) have the same order
--      and numbers on both pages (listVisits and listDayCheckups in web/js/data/supabase.js order by created_at, then id).
-- Every row then gets its serial number n = 1, 2, 3 ... in that order, like the numbers down the side of the sheet.
-- A row: n, kind ('patient' or 'checkup'), id (of the visit or checkup), patient_id, mr (a checkup patient's only once they
-- have a patient file), name, month (braces month), treatment, token, status (null for a checkup with none), group ('Group 2'),
-- doctors (the names; "✓ " before the checker, " (assistant)" after an assistant), details, notes, dues (the patient's pending
-- dues at this moment: issued invoices minus payments, as public.dues_for; null for a checkup patient), has_invoice (an issued
-- invoice for this visit, or for this patient at this branch on this day), phone, created_at.
create or replace function private.day_list_rows(p_branch smallint, p_date date) returns jsonb
language sql stable set search_path = public
as $$
  with v as (
    select v.*, p.mr_number, p.full_name, nullif(p.phone, '0000000') as patient_phone
      from public.visits v join public.patients p on p.id = v.patient_id
     where v.branch_id = p_branch and v.visit_date = p_date
  ),
  money as (
    select x.patient_id,
           coalesce((select sum(i.total) from public.invoices i where i.patient_id = x.patient_id and i.status = 'issued'), 0)
         - coalesce((select sum(y.amount) from public.payments y where y.patient_id = x.patient_id), 0) as dues
      from (select distinct v.patient_id from v) x
  ),
  items as (
    select jsonb_build_object(
             'kind', 'patient', 'id', v.id, 'patient_id', v.patient_id, 'mr', v.mr_number, 'name', v.full_name,
             'month', v.braces_month, 'treatment', coalesce(v.treatment_label, t.name), 'token', v.token_no::text,
             'status', v.status::text, 'group', 'Group ' || v.doctor_group_id,
             'doctors', (select string_agg(case when vs.role = 'checker' then '✓ ' else '' end || c.display_name
                                           || case when vs.role = 'assistant' then ' (assistant)' else '' end,
                                           ', ' order by vs.role, c.display_name)
                           from public.visit_staff vs join public.clinicians c on c.id = vs.clinician_id
                          where vs.visit_id = v.id),
             'details', v.details_text, 'notes', v.notes, 'dues', m.dues,
             -- Two checks rather than one with an OR, so each uses its index (invoices_visit_idx, invoices_patient_idx).
             'has_invoice', exists (select 1 from public.invoices i where i.visit_id = v.id and i.status = 'issued')
                         or exists (select 1 from public.invoices i
                                     where i.patient_id = v.patient_id and i.branch_id = v.branch_id and i.issue_date = v.visit_date
                                       and i.status = 'issued'),
             'phone', v.patient_phone, 'created_at', v.created_at) as j,
           case v.status when 'waiting' then 0 when 'in_treatment' then 1 when 'scheduled' then 2 when 'completed' then 4
                         when 'cancelled' then 5 when 'no_show' then 6 else 3 end as status_rank,
           0 as kind_rank, v.token_no::numeric as token_rank, v.created_at, v.id
      from v
      left join public.treatments t on t.id = v.treatment_id
      left join money m on m.patient_id = v.patient_id
    union all
    select jsonb_build_object(
             'kind', 'checkup', 'id', c.id, 'patient_id', c.patient_id, 'mr', p.mr_number, 'name', c.patient_name,
             'month', null, 'treatment', c.checkup_for, 'token', c.token, 'status', c.day_status, 'group', null,
             'doctors', c.doctors, 'details', c.details, 'notes', c.notes, 'dues', null, 'has_invoice', false,
             'phone', c.phone, 'created_at', c.created_at),
           case c.day_status when 'waiting' then 0 when 'in_treatment' then 1 when 'completed' then 4
                             when 'cancelled' then 5 when 'no_show' then 6 else 3 end,
           1, case when c.token ~ '^\s*[0-9]+\s*$' then regexp_replace(c.token, '\s', '', 'g')::numeric end, c.created_at, c.id
      from private.day_list_checkups(p_branch, p_date) c
      left join public.patients p on p.id = c.patient_id
  )
  select coalesce(jsonb_agg(s.j || jsonb_build_object('n', s.rn) order by s.rn), '[]'::jsonb)
    from (select i.j, row_number() over (order by i.status_rank, i.kind_rank, i.token_rank nulls last, i.created_at, i.id) as rn
            from items i) s
$$;

-- The counts of a list (rows as private.day_list_rows gives them): every row, each status, the rows with no status yet (checkup
-- patients only) and the checkup patients among them.
create or replace function private.day_list_counts(p_rows jsonb) returns jsonb
language sql immutable set search_path = ''
as $$
  select jsonb_build_object(
    'total',        count(*),
    'completed',    count(*) filter (where r->>'status' = 'completed'),
    'waiting',      count(*) filter (where r->>'status' = 'waiting'),
    'in_treatment', count(*) filter (where r->>'status' = 'in_treatment'),
    'scheduled',    count(*) filter (where r->>'status' = 'scheduled'),
    'cancelled',    count(*) filter (where r->>'status' = 'cancelled'),
    'no_show',      count(*) filter (where r->>'status' = 'no_show'),
    'not_set',      count(*) filter (where r->>'status' is null),
    'checkups',     count(*) filter (where r->>'kind' = 'checkup'))
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
$$;

-- The counts of a day that was not ended, from what is stored now, without building the whole list (the History page needs
-- the counts of up to 200 days at once). Same rows as private.day_list_rows, counted by private.day_list_counts.
create or replace function private.day_list_live_counts(p_branch smallint, p_date date) returns jsonb
language sql stable set search_path = public
as $$
  select private.day_list_counts(coalesce(jsonb_agg(jsonb_build_object('kind', s.kind, 'status', s.status)), '[]'::jsonb))
    from (select 'patient' as kind, v.status::text as status from public.visits v where v.branch_id = p_branch and v.visit_date = p_date
          union all
          select 'checkup', c.day_status from private.day_list_checkups(p_branch, p_date) c) s
$$;

revoke all on function private.day_list_checkups(smallint, date) from public, anon, authenticated;
revoke all on function private.day_list_rows(smallint, date) from public, anon, authenticated;
revoke all on function private.day_list_counts(jsonb) from public, anon, authenticated;
revoke all on function private.day_list_live_counts(smallint, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. End the day
-- ---------------------------------------------------------------------------------------------------------------
-- Saves the copy of one branch's list for one day (today or earlier, in Pakistan time, and not before 1 Jan 2024) and returns its
-- counts, with branch_id, list_date, closed_at, closed_by_name and times_updated. Needs "End the day on the Aaj ki List" and that branch.
create or replace function public.end_day(p_branch smallint, p_date date)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  v_rows jsonb;
  v_counts jsonb;
  v_old public.day_list_closings;
  v_new public.day_list_closings;
begin
  if v_uid is null or not public.has_perm('sheet.end_day') then
    raise exception 'NOT_ALLOWED: ending the day needs "End the day on the Aaj ki List" in the access list.' using errcode = '42501';
  end if;
  if p_branch is null or p_date is null or not exists (select 1 from public.branches b where b.id = p_branch) then
    raise exception 'BAD_REQUEST: choose one branch and a day to end.' using errcode = '22023';
  end if;
  if not public.can_access_branch(p_branch) then
    raise exception 'NOT_ALLOWED: you can end the day only at the branches you work at.' using errcode = '42501';
  end if;
  if p_date > v_today then
    raise exception 'FUTURE_DAY: % has not come yet, so it cannot be ended.', coalesce(to_char(p_date, 'FMDD Mon YYYY'), 'That day')
      using errcode = '22023'; -- ('That day' for 'infinity', which has no date to write)
  end if;
  -- Nor a day before 2024 (or '-infinity'): a mistyped year (0026 for 2026) would otherwise save a copy of an empty list far back
  -- in the History. The Aaj ki List's date box starts at the same day (FIRST_DAY in web/js/lib/day-list.js).
  if p_date < date '2024-01-01' then
    raise exception 'TOO_FAR_BACK: That date is too far back.' using errcode = '22023';
  end if;

  -- One at a time per list: two people ending the same day at the same moment both count, and each audit row has the copy it replaced.
  perform pg_advisory_xact_lock(hashtext('end_day:' || p_branch || ':' || p_date));
  v_rows := private.day_list_rows(p_branch, p_date);
  v_counts := private.day_list_counts(v_rows);
  select * into v_old from public.day_list_closings d where d.branch_id = p_branch and d.list_date = p_date;

  insert into public.day_list_closings as d (branch_id, list_date, closed_at, closed_by, closed_by_name, snapshot, counts, times_updated)
  values (p_branch, p_date, now(), v_uid, (select s.full_name from public.staff s where s.id = v_uid), v_rows, v_counts, 0)
  on conflict (branch_id, list_date) do update
    set closed_at = excluded.closed_at, closed_by = excluded.closed_by, closed_by_name = excluded.closed_by_name,
        snapshot = excluded.snapshot, counts = excluded.counts, times_updated = d.times_updated + 1
  returning * into v_new;

  insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
  values ('day_list_closings', v_new.id::text, 'END_DAY',
          case when v_old.id is not null then jsonb_build_object('closed_at', v_old.closed_at, 'closed_by', v_old.closed_by,
            'counts', v_old.counts, 'times_updated', v_old.times_updated, 'snapshot', v_old.snapshot) end,
          jsonb_build_object('branch_id', p_branch, 'list_date', p_date, 'counts', v_counts, 'times_updated', v_new.times_updated),
          v_uid);

  return v_counts || jsonb_build_object('branch_id', p_branch, 'list_date', p_date, 'closed_at', v_new.closed_at,
                                        'closed_by_name', v_new.closed_by_name, 'times_updated', v_new.times_updated);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. The History of Aaj ki List
-- ---------------------------------------------------------------------------------------------------------------
-- One line per day and branch that has visits, checkup patients or a saved copy, from p_from to p_to (never after today),
-- newest first, then in the branches' order. p_branch null = every branch the reader works at. counts come from the saved copy
-- when the day was ended, otherwise from what is stored now. total_count = the lines of all pages together.
-- Fast over years: the days of a branch are found one index probe per day (the newest day before the last one found), on
-- visits_branch_date_idx and checkups_branch_day_idx, and counted only for the lines of the page asked for.
create or replace function public.day_list_history(p_branch smallint default null, p_from date default null, p_to date default null,
                                                   p_limit integer default 60, p_offset integer default 0)
returns table (list_date date, branch_id smallint, branch_name text, ended boolean, closed_at timestamptz, closed_by_name text,
               times_updated integer, counts jsonb, total_count bigint)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  v_to date := least(coalesce(p_to, v_today), v_today);
  v_from date := coalesce(p_from, '-infinity'::date);
  v_limit integer := least(greatest(coalesce(p_limit, 60), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if auth.uid() is null or not public.has_perm('sheet.view') then
    raise exception 'NOT_ALLOWED: the History of Aaj ki List needs "View Aaj ki List / queue" in the access list.' using errcode = '42501';
  end if;
  if p_branch is not null and not public.can_access_branch(p_branch) then
    raise exception 'NOT_ALLOWED: you can see the lists of the branches you work at only.' using errcode = '42501';
  end if;

  return query
  with recursive br as (
    select b.id, b.name, b.sort_order
      from public.branches b
     where (p_branch is null or b.id = p_branch) and public.can_access_branch(b.id)
  ),
  vd (bid, day) as (
    select br.id, (select max(v.visit_date) from public.visits v where v.branch_id = br.id and v.visit_date >= v_from and v.visit_date <= v_to)
      from br
    union all
    select vd.bid, (select max(v.visit_date) from public.visits v where v.branch_id = vd.bid and v.visit_date >= v_from and v.visit_date < vd.day)
      from vd where vd.day is not null
  ),
  cd (bid, day) as (
    select br.id, (select max(c.checkup_date) from public.checkups c
                    where c.branch_id = br.id and not c.date_is_month and c.checkup_date >= v_from and c.checkup_date <= v_to)
      from br
    union all
    select cd.bid, (select max(c.checkup_date) from public.checkups c
                     where c.branch_id = cd.bid and not c.date_is_month and c.checkup_date >= v_from and c.checkup_date < cd.day)
      from cd where cd.day is not null
  ),
  days (bid, day) as (
    select vd.bid, vd.day from vd where vd.day is not null
    union
    select cd.bid, cd.day from cd where cd.day is not null
    union
    select d.branch_id, d.list_date from public.day_list_closings d join br on br.id = d.branch_id
     where d.list_date >= v_from and d.list_date <= v_to
  ),
  page as (
    select k.bid, k.day, br.name, br.sort_order, count(*) over () as total
      from days k join br on br.id = k.bid
     order by k.day desc, br.sort_order, k.bid
     limit v_limit offset v_offset
  )
  select p.day, p.bid, p.name, d.id is not null, d.closed_at, d.closed_by_name, d.times_updated,
         coalesce(d.counts, private.day_list_live_counts(p.bid, p.day)), p.total
    from page p
    left join public.day_list_closings d on d.branch_id = p.bid and d.list_date = p.day
   order by p.day desc, p.sort_order, p.bid;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 7. One day's list, read only
-- ---------------------------------------------------------------------------------------------------------------
-- { branch_id, branch_name, list_date, ended, closed_at, closed_by_name, times_updated, counts, rows }: the saved copy when the
-- day was ended, otherwise the list as stored now (private.day_list_rows, the same columns and order). A reader without
-- "See $$ pending dues flag" gets the rows without dues, and one without "View patient profiles" without the patients' phones.
create or replace function public.day_list_copy(p_branch smallint, p_date date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  d public.day_list_closings;
  v_rows jsonb;
  v_dues boolean := public.has_perm('dues.view');
  v_phones boolean := public.has_perm('patients.view');
begin
  if auth.uid() is null or not public.has_perm('sheet.view') then
    raise exception 'NOT_ALLOWED: the History of Aaj ki List needs "View Aaj ki List / queue" in the access list.' using errcode = '42501';
  end if;
  if p_branch is null or p_date is null or not exists (select 1 from public.branches b where b.id = p_branch) then
    raise exception 'BAD_REQUEST: choose one branch and a day.' using errcode = '22023';
  end if;
  if not public.can_access_branch(p_branch) then
    raise exception 'NOT_ALLOWED: you can see the lists of the branches you work at only.' using errcode = '42501';
  end if;

  select * into d from public.day_list_closings c where c.branch_id = p_branch and c.list_date = p_date;
  v_rows := case when d.id is not null then d.snapshot else private.day_list_rows(p_branch, p_date) end;
  if not (v_dues and v_phones) then
    v_rows := (select coalesce(jsonb_agg(case when v_phones or r->>'kind' <> 'patient' then r else r - 'phone' end
                                         - case when v_dues then '' else 'dues' end order by o), '[]'::jsonb)
                 from jsonb_array_elements(v_rows) with ordinality x(r, o));
  end if;
  return jsonb_build_object('branch_id', p_branch, 'branch_name', (select b.name from public.branches b where b.id = p_branch),
    'list_date', p_date, 'ended', d.id is not null, 'closed_at', d.closed_at, 'closed_by_name', d.closed_by_name,
    'times_updated', d.times_updated, 'counts', coalesce(d.counts, private.day_list_counts(v_rows)), 'rows', v_rows);
end $$;

revoke all on function public.end_day(smallint, date) from public, anon;
revoke all on function public.day_list_history(smallint, date, date, integer, integer) from public, anon;
revoke all on function public.day_list_copy(smallint, date) from public, anon;
grant execute on function public.end_day(smallint, date) to authenticated;
grant execute on function public.day_list_history(smallint, date, date, integer, integer) to authenticated;
grant execute on function public.day_list_copy(smallint, date) to authenticated;

-- Tell the API about the new table and functions straight away.
notify pgrst, 'reload schema';
