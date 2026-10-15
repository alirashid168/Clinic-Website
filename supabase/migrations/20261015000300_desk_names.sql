-- =============================================================================
-- Shared logins: the person at the desk types their name, and the clinic's records say who it was.
--
-- The owner (Dr. Ali, 15 Oct 2026) is moving to shared logins: one front desk login and one assistants login per branch
-- (Gulshan, North Nazimabad, DHA, Lahore Gulberg, Islamabad) and one doctors login; he, the coordinators and accounts keep
-- their own. His words: "instead of name picker, just give a popup saying please enter your name. because sometimes
-- islamabad branch has a different front desk person at different visits, so they can just put in their names."
--
-- What this file adds:
--   1. public.staff.shared_login (default no): "several people use this login". Set on Admin -> Staff accounts by Dr. Ali
--      or anyone with "Manage users and permissions". Never on an admin account (check constraint), and nobody but the
--      admin changes it on their own account (a trigger): taking it off your own login would skip the name popup.
--   2. public.desk_names: every name typed into the popup (the login, the name, when). A shared login adds rows for itself
--      only, and only while it is shared and switched on; it reads its own rows; Dr. Ali and user managers read them all
--      ("Names used" on Staff accounts). Nobody changes or deletes a row; they go with the staff account (on delete cascade).
--   3. public.audit_log.desk_name: the name of the person at the desk when a change was made. The website sends the name
--      with every database request in the x-desk-name header, percent-encoded (encodeURIComponent) so that Urdu names
--      arrive intact (a header may only carry plain ASCII). private.request_desk_name() reads it from
--      current_setting('request.headers'), only when the person signed in is a shared login, and only when it decodes to
--      a clean name of 2 to 60 characters. Anything else (no header, broken JSON, bad percent-encoding, not UTF-8, too long,
--      control characters) gives null, never an error: audit_row() runs on almost every table.
--      public.audit_row() stores it (otherwise unchanged), and a trigger on audit_log fills it in for the audit rows the
--      clinic's own functions write themselves (End the day, ...), when they are written for the person signed in.
--   4. The History of Aaj ki List: a day ended from a shared login is "ended by Front desk Islamabad (Ayesha)". A trigger
--      on day_list_closings adds the name to closed_by_name when end_day() saves the copy; end_day() itself is unchanged.
--
-- Additive only: two columns, a table, its policies and grants, four small functions and three triggers; audit_row() is
-- replaced with the same body plus the new column. It needs nothing but the earlier migrations. Safe to run more than once.
-- New column that refers to a staff account: public.desk_names.staff_id (on delete cascade).
--
-- HOW TO APPLY (in this order)
--   1. Put the new website live.
--   2. On every staff computer, the desk computers above all, reload each open tab of the website (Ctrl+F5), or close it
--      and open it again. Staff are not logged out any more (20261015000700_never_logout.sql), so a tab opened before the
--      new website went live keeps the older copy until it is reloaded. That copy never asks for a name and sends none, so
--      changes made from it under a shared login would have no name in the audit log or on End the day.
--   3. Supabase dashboard -> SQL Editor -> New query -> paste this whole file -> Run.
--      With the Supabase CLI, keep the file name as it is (20261015000300 sorts after 20261015000100_staff_menu_prefs.sql).
--   4. Then tick "Shared login" on each shared account (Admin -> Staff accounts).
--   Until it is run the website works as before: no login is shared, so nobody is asked for a name, and Staff accounts
--   does not offer "Shared login" yet.
-- =============================================================================

-- ---------------------------------------------------------------------------------------------------------------
-- 1. staff.shared_login
-- ---------------------------------------------------------------------------------------------------------------
alter table public.staff add column if not exists shared_login boolean not null default false;
comment on column public.staff.shared_login is
  'Several people use this login (a branch''s front desk or assistants, the doctors). The website asks for the person''s name after each sign-in (public.desk_names).';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'staff_shared_login_not_admin' and conrelid = 'public.staff'::regclass) then
    alter table public.staff add constraint staff_shared_login_not_admin check (not shared_login or role <> 'admin');
  end if;
end $$;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- The staff guard (guard_staff_row) already stops a non-admin from changing their own role, branches or active flag; this
-- does the same for shared_login, in a trigger of its own so that guard stays as it is.
create or replace function private.guard_staff_shared_login() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.is_admin() then return new; end if;
  if old.id = auth.uid() and new.shared_login is distinct from old.shared_login then
    raise exception 'You cannot change whether your own login is shared' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function private.guard_staff_shared_login() from public, anon, authenticated;

drop trigger if exists staff_guard_shared_login on public.staff;
create trigger staff_guard_shared_login before update on public.staff
  for each row execute function private.guard_staff_shared_login();

-- ---------------------------------------------------------------------------------------------------------------
-- 2. public.desk_names
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.desk_names (
  id          bigint generated always as identity primary key,
  staff_id    uuid not null references public.staff(id) on delete cascade,  -- the shared login
  name        text not null,                                                -- as typed (trimmed), any language
  entered_at  timestamptz not null default now(),                           -- always the server's time
  constraint desk_names_name_check check (char_length(name) between 2 and 60 and name = btrim(name) and name !~ '[[:cntrl:]]')
);
comment on table public.desk_names is
  'Each name typed into the "Please enter your name" popup of a shared login. Read on Admin -> Staff accounts -> Names used.';
create index if not exists desk_names_staff_at_idx on public.desk_names (staff_id, entered_at desc);

alter table public.desk_names enable row level security;

drop policy if exists "shared login adds its own names" on public.desk_names;
create policy "shared login adds its own names" on public.desk_names for insert
  with check (staff_id = auth.uid()
              and exists (select 1 from public.staff s where s.id = auth.uid() and s.shared_login and s.active));
drop policy if exists "own names and user managers read" on public.desk_names;
create policy "own names and user managers read" on public.desk_names for select
  using (staff_id = auth.uid() or public.has_perm('users.manage'));

-- No update or delete for anyone. entered_at is not in the insert grant, so it is always now().
revoke all on public.desk_names from public, anon, authenticated;
grant select on public.desk_names to authenticated;
grant insert (staff_id, name) on public.desk_names to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. audit_log.desk_name
-- ---------------------------------------------------------------------------------------------------------------
alter table public.audit_log add column if not exists desk_name text;
comment on column public.audit_log.desk_name is
  'The name the person at the desk typed in when the change was made from a shared login (the x-desk-name header); null otherwise.';

-- The name in the x-desk-name header of the request being served, or null. Only for a shared login, and never an error.
-- The header is percent-encoded UTF-8 (encodeURIComponent): only A-Z a-z 0-9 - _ . ! ~ * ' ( ) and %XX are accepted.
create or replace function private.request_desk_name()
returns text
language plpgsql stable security definer set search_path = public
as $$
declare
  v_headers text := current_setting('request.headers', true);
  v_raw text;
  v_hex text := '';
  v_name text;
  m text[];
begin
  -- Most requests carry no such header (every personal login): answered without going further.
  if v_headers is null or position('x-desk-name' in v_headers) = 0 then return null; end if;
  begin
    if auth.uid() is null or not exists (select 1 from public.staff s where s.id = auth.uid() and s.shared_login) then return null; end if;
    v_raw := v_headers::json ->> 'x-desk-name';
    if v_raw is null or length(v_raw) > 800 or v_raw !~ '^([A-Za-z0-9_.!~*''()-]|%[0-9A-Fa-f]{2})+$' then return null; end if;
    for m in select regexp_matches(v_raw, '%([0-9A-Fa-f]{2})|([^%])', 'g') loop
      v_hex := v_hex || coalesce(m[1], encode(convert_to(m[2], 'UTF8'), 'hex'));
    end loop;
    v_name := btrim(regexp_replace(convert_from(decode(v_hex, 'hex'), 'UTF8'), '\s+', ' ', 'g'));
    if v_name ~ '[[:cntrl:]]' or char_length(v_name) not between 2 and 60 then return null; end if;
    return v_name;
  exception when others then
    return null; -- broken JSON, bytes that are not UTF-8 (or a zero byte), anything else: no name, and the change goes ahead
  end;
end $$;
revoke all on function private.request_desk_name() from public, anon, authenticated;

-- Same as 20261005000200_rules_and_functions.sql, plus desk_name.
create or replace function public.audit_row()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor, desk_name)
  values (tg_table_name,
          coalesce(to_jsonb(new) ->> 'id', to_jsonb(old) ->> 'id'),
          tg_op,
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end,
          auth.uid(),
          private.request_desk_name());
  return coalesce(new, old);
end $$;

-- The audit rows the clinic's functions write themselves (End the day, merges, ...) get the name too, when the row is about
-- the person signed in. Rows written by the admin-users Edge Function or the Google Sheet sync have nobody signed in: no name.
create or replace function private.audit_log_desk_name() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.desk_name is null and new.actor is not null and new.actor = auth.uid() then
    new.desk_name := private.request_desk_name();
  end if;
  return new;
end $$;
revoke all on function private.audit_log_desk_name() from public, anon, authenticated;

drop trigger if exists audit_log_desk_name on public.audit_log;
create trigger audit_log_desk_name before insert on public.audit_log
  for each row execute function private.audit_log_desk_name();

-- ---------------------------------------------------------------------------------------------------------------
-- 4. "Ended by" on the History of Aaj ki List
-- ---------------------------------------------------------------------------------------------------------------
-- end_day() (20261012000100) saves the login's name in closed_by_name. For a shared login the name typed at the desk is added
-- in brackets: "Front desk Islamabad (Ayesha)". Only when the copy is saved again by the person signed in (a new closed_at), and
-- only once: ending the same day again (the insert's ON CONFLICT update) does not add it twice.
create or replace function private.day_closing_desk_name() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_desk text;
  v_login text;
begin
  if new.closed_by is null or new.closed_by is distinct from auth.uid() then return new; end if;
  if tg_op = 'UPDATE' and new.closed_at is not distinct from old.closed_at then return new; end if;
  v_desk := private.request_desk_name();
  if v_desk is null then return new; end if;
  select s.full_name into v_login from public.staff s where s.id = new.closed_by;
  if new.closed_by_name is not distinct from v_login then
    new.closed_by_name := v_login || ' (' || v_desk || ')';
  end if;
  return new;
end $$;
revoke all on function private.day_closing_desk_name() from public, anon, authenticated;

drop trigger if exists day_list_closings_desk_name on public.day_list_closings;
create trigger day_list_closings_desk_name before insert or update on public.day_list_closings
  for each row execute function private.day_closing_desk_name();
