-- Login log: an account records only its own sign-in; Dr. Ali sees last sign-ins and events.
\set ON_ERROR_STOP 1
\set admin  '''00000000-0000-0000-0000-000000002100'''
\set fd     '''00000000-0000-0000-0000-000000002101'''

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'TEST FAILED: %', msg; end if;
  raise notice 'ok - %', msg;
end $$;
create or replace function pg_temp.expect_error(sql text, needle text, msg text) returns void language plpgsql as $$
begin
  execute sql;
  raise exception 'TEST FAILED (no error): %', msg;
exception when others then
  if sqlerrm like 'TEST FAILED%' then raise; end if;
  if position(needle in sqlerrm) = 0 then raise exception 'TEST FAILED: % (unexpected error: %)', msg, sqlerrm; end if;
  raise notice 'ok - % (blocked: %)', msg, left(sqlerrm, 70);
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

begin;
insert into auth.users (id, email, last_sign_in_at) values (:admin, 'ali21@dralirashid.com', '2026-10-07 08:00+05'), (:fd, 'fd21@dralirashid.com', '2026-10-06 12:00+05');
insert into public.staff (id, full_name, email, role) values (:admin, 'Dr. Ali Rashid', 'ali21@dralirashid.com', 'admin'), (:fd, 'Front desk', 'fd21@dralirashid.com', 'front_desk');

select set_config('request.jwt.claim.sub', :fd, false);
set role authenticated;
insert into public.login_events (user_id, user_agent) values (:fd, 'Chrome on Windows');
select pg_temp.check(true, 'a front desk login records its own sign-in');
select pg_temp.expect_error(format($$insert into public.login_events (user_id) values (%L)$$, :admin), 'row-level security', 'it cannot record a sign-in for someone else');
select pg_temp.check((select count(*) from public.login_events) = 0, 'front desk cannot read the login log');
select pg_temp.expect_error($$select public.staff_logins()$$, 'Only Dr. Ali', 'front desk cannot call the login summary');
reset role; select set_config('request.jwt.claim.sub', '', false);

select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
select pg_temp.check((select (r->'events'->0->>'name') = 'Front desk' and (r->'events'->0->>'user_agent') = 'Chrome on Windows' from (select public.staff_logins() r) t), 'Dr. Ali sees who signed in and from what');
select pg_temp.check((select count(*) from (select jsonb_array_elements(public.staff_logins()->'staff') s) t where s->>'full_name' = 'Front desk' and (s->>'last_sign_in_at') is not null and (s->>'sign_ins_30d')::int = 1) = 1, 'last sign-in comes from the auth system, count from the log');
reset role; select set_config('request.jwt.claim.sub', '', false);
rollback;
