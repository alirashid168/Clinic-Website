-- =============================================================================
-- The Google Form's old answers are never on a day's list, also in "End the day" and the History of Aaj ki List.
--
-- An answer of the clinic's Google Form "Checkup Patient Form 2.0" imported on Admin -> Import (source 'google_form',
-- 20261011000300_checkup_form_2.sql) is on the Checkups page only: that day's Aaj ki List did not have it, so the list does not
-- show it either (listDayCheckups in web/js/data/supabase.js and dayListCheckups in web/js/lib/checkups.js leave it out).
-- 20261012000100_day_list_history.sql picks a day's checkups by branch and date alone. This file recreates the two functions that
-- do that with the same rule as the page:
--   - private.day_list_checkups: the checkup patients of one day's list, for private.day_list_rows (the copy that end_day saves and
--     day_list_copy shows) and private.day_list_live_counts (the counts of a day that was not ended);
--   - public.day_list_history: which days have a list (its cd part, the days with checkup patients).
-- Without it the imported answers (12 Aug to 11 Oct 2026) would add days and counts to the History, list the answers as that
-- day's Completed checkup patients, and an "End the day" on an earlier day would save a copy that does not match the page.
-- Everything else in the two functions is as in 20261012000100, and so are their rights (set again below).
--
-- Needs 20261011000300_checkup_form_2.sql and 20261012000100_day_list_history.sql first. Safe to run more than once.
-- =============================================================================

-- The checkup patients shown on a day's list: the exact-day rows of that branch (never the old list's month rows, never an answer
-- imported from the Google Form), except a person who has become a patient and has a visit on the same list (the visit row stands
-- for them). The same rule as dayListCheckups() in web/js/lib/checkups.js.
create or replace function private.day_list_checkups(p_branch smallint, p_date date)
returns setof public.checkups
language sql stable set search_path = public
as $$
  select c.*
    from public.checkups c
   where c.branch_id = p_branch and c.checkup_date = p_date and not c.date_is_month and c.source <> 'google_form'
     and not (c.patient_id is not null
              and exists (select 1 from public.visits v where v.branch_id = p_branch and v.visit_date = p_date and v.patient_id = c.patient_id))
$$;
revoke all on function private.day_list_checkups(smallint, date) from public, anon, authenticated;

-- One line per day and branch that has visits, checkup patients (as private.day_list_checkups picks them) or a saved copy, from
-- p_from to p_to (never after today), newest first, then in the branches' order. As in 20261012000100, with the Google Form's
-- answers left out of the days with checkup patients.
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
                    where c.branch_id = br.id and not c.date_is_month and c.source <> 'google_form'
                      and c.checkup_date >= v_from and c.checkup_date <= v_to)
      from br
    union all
    select cd.bid, (select max(c.checkup_date) from public.checkups c
                     where c.branch_id = cd.bid and not c.date_is_month and c.source <> 'google_form'
                       and c.checkup_date >= v_from and c.checkup_date < cd.day)
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
revoke all on function public.day_list_history(smallint, date, date, integer, integer) from public, anon;
grant execute on function public.day_list_history(smallint, date, date, integer, integer) to authenticated;

notify pgrst, 'reload schema';
