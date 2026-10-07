-- =====================================================================
-- Login log (security plan, Appendix A). Every sign-in is recorded:
--   login_events  one row per sign-in, written by the signed-in account itself
--                 (only its own id can be written), read by Dr. Ali;
--   staff_logins() Dr. Ali's view: each staff account with its last sign-in
--                 (taken from the auth system itself, so it cannot be faked)
--                 and the recent sign-in events with device and browser.
-- =====================================================================
create table if not exists public.login_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  kind       text not null default 'staff' check (kind in ('staff', 'patient')),
  at         timestamptz not null default now(),
  user_agent text
);
create index if not exists login_events_at_idx on public.login_events (at desc);
create index if not exists login_events_user_idx on public.login_events (user_id, at desc);
alter table public.login_events enable row level security;

create policy "own sign-in is recorded" on public.login_events for insert
  with check (user_id = auth.uid());
create policy "admin reads sign-ins" on public.login_events for select
  using (public.is_admin());
grant insert, select on public.login_events to authenticated;

create or replace function public.staff_logins(p_limit int default 200)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare v_staff jsonb; v_events jsonb;
begin
  if not public.is_admin() then raise exception 'Only Dr. Ali can see the login log' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'full_name', s.full_name, 'email', s.email, 'role', s.role, 'active', s.active,
                                               'last_sign_in_at', u.last_sign_in_at, 'sign_ins_30d', (select count(*) from public.login_events e where e.user_id = s.id and e.at > now() - interval '30 days'))
                            order by u.last_sign_in_at desc nulls last), '[]')
    into v_staff
    from public.staff s left join auth.users u on u.id = s.id;
  select coalesce(jsonb_agg(x), '[]') into v_events from (
    select jsonb_build_object('at', e.at, 'kind', e.kind, 'name', coalesce(s.full_name, p.full_name, u.email), 'role', s.role, 'user_agent', e.user_agent) x
      from public.login_events e
      left join public.staff s on s.id = e.user_id
      left join public.patients p on p.portal_user_id = e.user_id
      left join auth.users u on u.id = e.user_id
     order by e.at desc limit greatest(1, least(p_limit, 1000))) t;
  return jsonb_build_object('staff', v_staff, 'events', v_events);
end $$;

revoke all on function public.staff_logins(int) from public, anon;
grant execute on function public.staff_logins(int) to authenticated;
