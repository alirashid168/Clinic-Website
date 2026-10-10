-- =============================================================================
-- New Mr# from 50000, and the front desk can make patient portal logins.
-- (Owner's decisions, 9 Oct 2026.)
--
-- WHY MR# 50000
--   Healthwire, the old clinic software, still registers new patients and its numbers are now in the
--   9800s: they reach 10000 within days, where the website's own numbers started. Two patients could
--   then share one Mr#. The website now gives its numbers from 50000 up; Healthwire keeps counting
--   freely from where it is. The patients the website numbered 10000-10012 on 6 Oct 2026 (the Aaj ki
--   List import: none has a portal login, no invoice or receipt stores the number, they all read it
--   from the patient) are given 50000-50012. Gaps are kept (10004 and 10010 were never used, so
--   50004 and 50010 stay unused).
--
-- WHAT THIS FILE DOES (one transaction: if any step stops, nothing is changed)
--   0. It locks the patients table against writing (reading carries on) for the few moments it runs,
--      so a patient registered at this very second cannot be given 10013 while the counter is moved.
--      If the lock cannot be had within 15 seconds the file stops and nothing has changed: run it again.
--   1. Only while the website's counter is still below 50000 (that is what makes a second run safe, see
--      below): a patient whose Mr# is 10000-10999, that the counter has already given out, and who was
--      created before 10 Oct 2026 (Pakistan time), gets Mr# + 40000. Patients that are Healthwire's own
--      are never moved: the ones Healthwire's import made (legacy source "healthwire") and the ones that
--      have Healthwire invoices, payments or visits. A note on the patient says what the old Mr# was (the
--      audit log has it too: Admin -> Audit log; staff cannot search by the old number, only Dr. Ali can look
--      it up there, so keep the list that the last result row prints, see below). It stops, changing
--      nothing, when:
--        - one of the new numbers already belongs to someone, or
--        - one of the patients has a portal login (the login's username holds the old Mr#, and this file
--          cannot rename logins): tell Dr. Ali, rename or remove that login, then run the file again.
--   2. public.sync_mr_sequence() is replaced: it looks only at numbers from 50000 up and its
--      default minimum is 50000, so running it (the docs say to, after an import) can never put the
--      counter back into Healthwire's range. It also never moves the counter back past a number that has
--      been given out: if the newest website patients are merged or deleted, their numbers are not handed
--      out again to someone else. Its signature and who may call it are unchanged.
--      ANY LATER MIGRATION THAT REDEFINES sync_mr_sequence() MUST KEEP THIS BODY (numbers from 50000 up, default
--      and floor 50000, never backwards). The photo-intake branch (20261009000200_photo_intake.sql) has its own
--      copy with default 9841 and every number counted: rebase it onto this body before it is applied, or
--      a later CREATE OR REPLACE quietly brings Healthwire's range back.
--   3. The counter is moved with that function: the next website number is the larger of 50000 and
--      (the highest number from 50000 up) + 1, which is 50013 on the day this is applied. Nobody signed in
--      to the website (or not signed in) can set the counter directly any more; the registration trigger
--      and sync_mr_sequence() still can.
--   4. The front desk gets portal.invite ("Invite patients to the patient portal"), so it can
--      create and reset patient portal logins. No other role changes; personal overrides stay.
--
-- HOW TO APPLY
--   First redeploy the admin-users function (supabase functions deploy admin-users, all three files): the front
--   desk's new right goes through it, and the older function lacks the checks on invitations by email.
--   Then: Supabase dashboard -> SQL Editor -> New query -> paste this whole file -> Run.
--   It is safe to run more than once. Once the counter is at 50000 or more, step 1 does nothing at all,
--   whatever the patients look like: a Healthwire patient numbered 10004 and imported with an old date
--   (a Healthwire registration date, or an old row of the Aaj ki List), or a Mr# the admin edited
--   to 10020 on an older patient, is never touched. (The creation date alone could not promise that: it
--   says when the patient was made, not who gave the number.) Steps 2 to 4 give the same result again.
--   With the Supabase CLI, keep the file name as it is: 20261009000400 sorts after the last migration
--   (20261009000100_staff_guard_id.sql).
--   The last thing it shows is one row (the SQL Editor shows only that, not the notices):
--     patients_renumbered_now  how many patients THIS run moved: 11 on the day it is applied (0 on a second run)
--     old_to_new               the list "10000 -> 50000, 10001 -> 50001, ..." of this run: copy it for the front desk
--     left_alone_10000_10999   patients still holding 10000-10999: 0 on the day it is applied
--     next_mr_number           50013 on the day it is applied
--     front_desk_can_make_portal_logins   true
--   Apply it before 10 Oct 2026 if you can: a patient the website numbers 10013 or more on or after
--   that day looks like a Healthwire patient to step 1 and is left alone, and left_alone_10000_10999
--   would not be 0. If it is not 0, look at who those patients are: ones from Healthwire are correct
--   as they are; ones the website numbered (no Healthwire source) get their 50000+ number from
--   Dr. Ali, by hand (only the admin can change a Mr#, in the patient's edit screen).
--
-- UNTIL IT IS APPLIED the database keeps handing out 10013, 10014 ... and refuses portal logins
--   from the front desk, whatever the website screens show.
--
-- TO UNDO
--   The old Mr# of each patient is in the audit log (table patients, action UPDATE: old_data and
--   new_data both hold mr_number) and in the patient's notes. The front desk's permission can be
--   switched off again in Admin -> Access list, or:
--     update public.role_permissions set allowed = false where role = 'front_desk' and permission_key = 'portal.invite';
--   The previous sync_mr_sequence() is in 20261005000200_rules_and_functions.sql.
-- =============================================================================

begin;

-- 0. No registration can slip in between the renumbering and the new counter. A registration that has already
--    started is waited for first, so the statements below see it.
set local lock_timeout = '15s';
lock table public.patients in share row exclusive mode;

-- -----------------------------------------------------------------------------
-- 1. Renumber the patients the website numbered before this change.
--    10003 -> 50003 (the same as adding 40000). A temporary function, gone when this session ends:
--    it only exists so the test can run the check on its own.
-- -----------------------------------------------------------------------------
create or replace function pg_temp.mr_50000_renumber() returns integer
language plpgsql as $$
declare
  v_next   bigint;   -- the number the website's counter gives next
  v_ids    uuid[];   -- the patients to renumber
  v_logins text;
  v_taken  text;
  v_moved  integer;
  v_list   text;
begin
  -- What this run did, for the result row at the end of the file (nothing yet; a session setting, so it outlives the commit).
  perform set_config('mr_50000.moved_count', '0', false);
  perform set_config('mr_50000.moved', '', false);

  select case when is_called then last_value + 1 else last_value end into v_next from public.mr_number_seq;
  if v_next >= 50000 then
    raise notice 'The website already numbers from 50000: no patient renumbered.';
    return 0;
  end if;

  -- Numbers 10000-10999 that the counter has given out (below its next number), on patients created before 10 Oct 2026,
  -- that are not Healthwire's own: Healthwire's import made them (legacy source healthwire), or Healthwire invoices, payments
  -- or visits already hang on them (an import can merge Healthwire's 10004 into a website patient with that number).
  -- Moving such a patient would split it from Healthwire's next export, so it stays, and the result row counts it as left alone.
  -- (case: the number is only read as a number once it is known to be five digits; '347-1' and the like are never looked at.)
  select coalesce(array_agg(id), '{}') into v_ids
    from public.patients p
   where mr_number ~ '^10[0-9]{3}$'
     and created_at < timestamptz '2026-10-10 00:00+05'
     and (case when mr_number ~ '^10[0-9]{3}$' then mr_number::bigint end) < v_next
     and legacy_source is distinct from 'healthwire'
     and not exists (select 1 from public.invoices x where x.patient_id = p.id and x.legacy_source = 'healthwire')
     and not exists (select 1 from public.payments x where x.patient_id = p.id and x.legacy_source = 'healthwire')
     and not exists (select 1 from public.visits   x where x.patient_id = p.id and x.legacy_source = 'healthwire');

  select string_agg(mr_number, ', ' order by mr_number) into v_logins
    from public.patients where id = any (v_ids) and portal_user_id is not null;
  if v_logins is not null then
    raise exception 'Mr# change refused: the patients with Mr# % already have a portal login, and its username holds the old Mr#. Nothing was changed.', v_logins;
  end if;

  select string_agg(t.mr_number, ', ' order by t.mr_number) into v_taken
    from public.patients s
    join public.patients t on t.mr_number = '50' || substr(s.mr_number, 3)
   where s.id = any (v_ids);
  if v_taken is not null then
    raise exception 'Mr# change refused: the new numbers % already belong to other patients. Nothing was changed.', v_taken;
  end if;

  -- (RETURNING gives the new number; the old one is the same with 10 in front: 50003 was 10003.)
  with moved as (
    update public.patients
       set mr_number = '50' || substr(mr_number, 3),
           notes = concat_ws(' ' || chr(183) || ' ', nullif(notes, ''),
                     'Mr# was ' || mr_number || ' until ' || to_char(now() at time zone 'Asia/Karachi', 'DD Mon YYYY') || ' (the website now numbers from 50000)')
     where id = any (v_ids)
    returning mr_number)
  select count(*), string_agg('10' || substr(mr_number, 3) || ' -> ' || mr_number, ', ' order by mr_number)
    into v_moved, v_list from moved;

  perform set_config('mr_50000.moved_count', v_moved::text, false);
  perform set_config('mr_50000.moved', coalesce(v_list, ''), false);
  raise notice 'Mr# moved to 50000+: % patient(s): %', v_moved, v_list;
  return v_moved;
end $$;

select pg_temp.mr_50000_renumber() as patients_renumbered;

-- -----------------------------------------------------------------------------
-- 2. The counter can never go back into Healthwire's range, and never back past a number already given out.
--    Odd legacy values like '347-1' (and anything under 50000) are ignored when looking for the highest number.
--    A number given out stays given out: if the newest website patients are merged away or deleted, the next
--    patient does not get their number again (a note "Merged with Mr# 50003" would then point at a stranger).
-- -----------------------------------------------------------------------------
create or replace function public.sync_mr_sequence(p_minimum bigint default 50000)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
  v_next  bigint;
  v_given bigint;   -- the number the counter would give next, as it stands now
begin
  select greatest(coalesce(max(n), 0) + 1, p_minimum, 50000)
    into v_next
    from (select case when mr_number ~ '^[0-9]{1,15}$' then mr_number::bigint end as n
            from public.patients) numbers
   where n >= 50000;
  select case when is_called then last_value + 1 else last_value end into v_given from public.mr_number_seq;
  v_next := greatest(v_next, v_given);
  perform setval('public.mr_number_seq', v_next, false);
  return v_next;
end $$;

revoke execute on function public.sync_mr_sequence(bigint) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Move the counter: the next website number is the highest from 50000 up, plus one (at least 50000).
--    And close it to the website's users: they never need it (registering a patient runs assign_mr_number with
--    its owner's rights), and anyone who could set it could put it back into Healthwire's range.
-- -----------------------------------------------------------------------------
select public.sync_mr_sequence() as next_mr_number;

revoke all on sequence public.mr_number_seq from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Front desk may create and reset patient portal logins (coordinator and admin already can).
-- -----------------------------------------------------------------------------
insert into public.role_permissions (role, permission_key, allowed)
values ('front_desk', 'portal.invite', true)
on conflict (role, permission_key) do update set allowed = true
  where not public.role_permissions.allowed;   -- already allowed: no change, so no audit row either

-- Tell the API about the changed function straight away.
notify pgrst, 'reload schema';

commit;

-- What the database says now (the dashboard shows the last result).
select coalesce(nullif(current_setting('mr_50000.moved_count', true), ''), '0')::integer as patients_renumbered_now,
       coalesce(nullif(current_setting('mr_50000.moved', true), ''), '(nobody moved by this run)') as old_to_new,
       (select count(*) from public.patients where mr_number ~ '^10[0-9]{3}$') as left_alone_10000_10999,
       (select case when is_called then last_value + 1 else last_value end from public.mr_number_seq) as next_mr_number,
       (select allowed from public.role_permissions where role = 'front_desk' and permission_key = 'portal.invite') as front_desk_can_make_portal_logins;
