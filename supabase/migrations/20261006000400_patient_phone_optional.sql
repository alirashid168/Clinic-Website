-- A patient's phone number may be left empty. Patients copied from the
-- Aaj ki List without a number were given the stand-in 0000000; those are
-- cleared so only real numbers that staff typed in remain. A number that
-- is filled in must still have at least 7 characters.
alter table public.patients alter column phone drop not null;
alter table public.patients drop constraint if exists phone_not_blank;
alter table public.patients add constraint phone_not_blank check (phone is null or length(btrim(phone)) >= 7);
update public.patients set phone = null where phone = '0000000';
