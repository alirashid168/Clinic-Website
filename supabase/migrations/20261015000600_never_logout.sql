-- =============================================================================
-- Staff stay signed in: no logout after a period of no activity.
--
-- The owner (Dr. Ali, 15 Oct 2026): "please remove force log out. the google sheet stays logged in for days and days. its so easy
-- and convenient".
--
-- session_timeout_minutes = 0 now means never: no "Are you still there?" warning and no logout for no activity. A login then stays
-- until the person presses Log out in the name menu (still there for a shared computer). 5 to 720 still logs staff out after that
-- many minutes, and Admin -> Settings can choose either ("Never" or "After N minutes").
--
-- UPDATE THE WEBSITE FIRST. An older copy of the website reads 0 as 30 minutes, so running this before the new website is live
-- would log staff out after 30 minutes instead of the 720 set for now.
--
-- Safe to run more than once.
-- HOW TO APPLY: Supabase dashboard -> SQL Editor -> paste this whole file -> Run.
-- =============================================================================

insert into public.app_settings (key, value, description)
values ('session_timeout_minutes', '0',
        'Staff are logged out after this many minutes of no activity (5 to 720). 0 = never: staff stay signed in until they press Log out.')
on conflict (key) do update
  set value = excluded.value, description = excluded.description, updated_at = now();
