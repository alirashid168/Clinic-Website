-- =============================================================================
-- Arrange my menu: each staff member's own order of the top menu bar, saved so it follows them to any computer.
--
-- The owner's request (Dr. Ali, 12 Oct 2026): "employees should habe option to rearrange the tabs on the top in any
-- order they want, so they can keep most used things in the one click access."
--
-- The website's "Arrange my menu" (in the name menu at the top right, and in the phone menu) saves one row per staff
-- member in public.staff_menu_prefs:
--   arrangement  a JSON array of the menu's own keys, at most 60:
--                  'patients', 'reports?group=financial', 'menu:coordinator' (a whole drop-down)
--                      = on the top bar, in this order;
--                  '-billing' = taken off the top bar (it is then under More).
--                [] is the clinic's own menu (what "Reset to default" saves).
--   The website skips keys it does not know (a page that was removed) and keys of pages the person may not open: the
--   menu only ever shows what their permissions allow, so arranging it never gives access to anything. A page added to
--   the website later appears in its usual place.
--
-- Rules:
--   * each staff member reads and saves only their own row (row-level security); nobody else reads it, Dr. Ali
--     included (the admin needs nobody's menu order). A switched-off account cannot save.
--   * the check constraint keeps the row small: an array of at most 60 strings, each 1 to 80 characters of letters,
--     digits and : _ ? = & . / - (a '-' in front marks "taken off the top bar").
--   * public.save_my_menu(p_arrangement) saves the caller's own row (insert or update) in one call; that is what the
--     website uses.
--
-- Additive only: a new table, its policies, a trigger and one function. It needs nothing but public.staff and the
-- helpers of 20261005000200. Safe to run more than once.
--
-- HOW TO APPLY
--   Supabase dashboard -> SQL Editor -> New query -> paste this whole file -> Run.
--   With the Supabase CLI, keep the file name as it is (20261012000300 sorts after 20261011000100_aaj_sync_quiet_token.sql).
--   Until it is run the website still works: every menu is the clinic's default until someone arranges theirs, and
--   "Arrange my menu" then keeps that person's arrangement on that one computer only (the message after Save says so). Once
--   this file is run, their next login on that computer (or their next Save) puts it in this table.
-- =============================================================================

create table if not exists public.staff_menu_prefs (
  staff_id     uuid primary key references public.staff(id) on delete cascade,
  arrangement  jsonb not null default '[]'::jsonb,
  updated_at   timestamptz not null default now(),
  constraint staff_menu_prefs_arrangement_check check (
    case when jsonb_typeof(arrangement) = 'array'
      then jsonb_array_length(arrangement) <= 60
       and not jsonb_path_exists(arrangement, 'strict $[*] ? (@.type() != "string")')  -- strict: a nested list is not unwrapped
       and not jsonb_path_exists(arrangement, '$[*] ? (!(@ like_regex "^-?[A-Za-z0-9:_?=&./-]{1,80}$"))')
      else false end)
);

alter table public.staff_menu_prefs enable row level security;

drop policy if exists "own menu is read" on public.staff_menu_prefs;
create policy "own menu is read" on public.staff_menu_prefs for select
  using (staff_id = auth.uid() and public.is_staff());
drop policy if exists "own menu is saved" on public.staff_menu_prefs;
create policy "own menu is saved" on public.staff_menu_prefs for insert
  with check (staff_id = auth.uid() and public.is_staff());
drop policy if exists "own menu is changed" on public.staff_menu_prefs;
create policy "own menu is changed" on public.staff_menu_prefs for update
  using (staff_id = auth.uid() and public.is_staff())
  with check (staff_id = auth.uid() and public.is_staff());

-- No delete: "Reset to default" saves []. The row goes with the staff account (on delete cascade).
revoke all on public.staff_menu_prefs from public, anon, authenticated;
grant select, insert, update on public.staff_menu_prefs to authenticated;

drop trigger if exists staff_menu_prefs_touch on public.staff_menu_prefs;
create trigger staff_menu_prefs_touch before update on public.staff_menu_prefs
  for each row execute function public.touch_updated_at();

-- Saves the caller's own arrangement. Runs as the caller (security invoker), so the policies above and the check apply.
create or replace function public.save_my_menu(p_arrangement jsonb)
returns void
language plpgsql volatile security invoker set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_staff() then
    raise exception 'NOT_STAFF: only a staff login has a menu to arrange' using errcode = '42501';
  end if;
  insert into public.staff_menu_prefs (staff_id, arrangement)
  values (auth.uid(), coalesce(p_arrangement, '[]'::jsonb))
  on conflict (staff_id) do update set arrangement = excluded.arrangement;
end $$;

revoke all on function public.save_my_menu(jsonb) from public, anon;
grant execute on function public.save_my_menu(jsonb) to authenticated;
