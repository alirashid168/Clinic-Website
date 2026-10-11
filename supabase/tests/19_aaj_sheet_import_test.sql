-- Aaj ki List history import: matching patients, completing Healthwire visits, braces cases from the history, tokens, people.
-- "Add patient records" (p_create_patients) makes a patient file only for a Healthwire Mr# (1 to 49999) the website does not have: never for a
-- row without an Mr# and never for an Mr# of 50000 or more (the website's own range: a typo). Owner rules 3 and 4, 9 Oct 2026.
-- Nothing is guessed (owner, 9 Oct 2026, 13:20): an Mr# the website does not have is never matched by phone or name to another patient, a row
-- without an Mr# is matched only by its phone and first name (never by a name alone), and a row without an Mr# whose Treatment says checkup
-- is a checkup patient: skipped, counted, never a visit (loop 4). A row whose Mr# belongs to a patient its name does not fit without doubt (her
-- phone is no proof any more, 11 Oct 2026) is never filed on her: it is reported back (loop 5). An Mr# the website does not have is never made a second file for a patient
-- it has (the same name and phone under another Mr#, or a retired Mr# whose patient the name fits): reported back with why (loop 6).
-- A Healthwire Mr# is made only up to the highest Healthwire number the website has plus 100 (the sync's rule, abuse-privacy M-HW-SQUAT): the
-- setup below has a Healthwire patient 12000, so the numbers this file makes (up to 10905) are within it; the last case tests the limit.
\set ON_ERROR_STOP 1
\set admin  '''00000000-0000-0000-0000-0000000000a9'''
\set fd     '''00000000-0000-0000-0000-0000000000f9'''
\set p1     '''00000000-0000-0000-0000-0000000000d1'''
\set p2     '''00000000-0000-0000-0000-0000000000d2'''
\set p3     '''00000000-0000-0000-0000-0000000000d3'''
\set p4     '''00000000-0000-0000-0000-0000000000d4'''
\set p5     '''00000000-0000-0000-0000-0000000000d5'''

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
-- The rows the browser would send, built from today's date so the "still active" rule is exercised.
create or replace function pg_temp.sheet_rows() returns jsonb language sql as $$
  with c as (select (select id from public.clinicians where display_name = 'Dr. Komal Rubab') komal,
                    (select id from public.clinicians where display_name = 'Hira Anis') hira,
                    (now() at time zone 'Asia/Karachi')::date today)
  select jsonb_build_array(
    jsonb_build_array((today - 40)::text, 2, '77001', 'Ayan Khan', null, '03001234567', 4, 'Monthly', 12, 'completed', 1, jsonb_build_array(komal), jsonb_build_array(hira), jsonb_build_array('Dr Unknown'), 'U L 016 PC', null, 'North Nazimabad', true, 1),
    jsonb_build_array('2024-03-05', 2, null, 'Ayan Khan', 'Ayan Khan N.N', '03001234567', 1, 'Bonding', 3, 'completed', null, jsonb_build_array(komal), '[]'::jsonb, '[]'::jsonb, 'Bonding', null, 'North Nazimabad', true, 4),
    jsonb_build_array((today - 10)::text, 2, null, 'Zara Ali', null, '03003330003', null, 'Scaling', 5, 'completed', null, '[]'::jsonb, jsonb_build_array(hira), '[]'::jsonb, null, 'Called', 'North Nazimabad', false, 16),
    jsonb_build_array((today - 10)::text, 2, null, 'Zara Ali', null, '03003330003', null, 'X-Ray / OPG', null, 'completed', null, jsonb_build_array(komal), '[]'::jsonb, '[]'::jsonb, 'OPG', null, 'North Nazimabad', false, 20),
    jsonb_build_array((today - 10)::text, 2, '77002', 'Hina Baig', null, '03007654321', null, 'Checkup', 5, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 14),
    jsonb_build_array((today - 10)::text, 2, '7709', 'Common Name', null, null, null, 'Checkup', 6, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 14),
    jsonb_build_array((today - 10)::text, 2, null, 'Nobody Known', null, null, null, 'Checkup', 7, 'no_show', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 14),
    jsonb_build_array((today - 10)::text, 2, '77088', 'Typo Number', null, '03009990088', null, 'Scaling', 8, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 16),
    jsonb_build_array((today - 10)::text, 2, null, 'Phone Only', null, '03009990077', null, 'Checkup', 9, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 14),
    jsonb_build_array(today::text, 2, '77001', 'Ayan Khan', null, '03001234567', 5, 'Monthly', 1, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 1),
    -- no Mr#, no phone, a name only one patient has (Hina Baig): never matched by the name alone
    jsonb_build_array((today - 10)::text, 2, null, 'Hina Baig', null, null, null, 'Filling', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, null),
    -- no Mr#, a phone nobody has, a name only one patient has (Ayan Khan): not matched either (the phone says it is not his)
    jsonb_build_array((today - 12)::text, 2, null, 'Ayan Khan', null, '03110000000', null, 'Filling and crown prep', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, null),
    -- a Healthwire Mr# the website does not have, typed with the name of an existing patient: made with that Mr#, never put on Zara Ali's file
    jsonb_build_array((today - 12)::text, 2, '7851', 'Zara Ali', null, '03007770001', null, 'Scaling', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 16),
    -- an Mr# of 50000 or more that the website never gave, typed with Hina Baig's own name and phone: a typo, never put on her file
    jsonb_build_array((today - 12)::text, 2, '77089', 'Hina Baig', null, '03007654321', null, 'Filling', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, null))
  from c $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

begin;
insert into auth.users (id, email) values (:admin, 'ali9@dralirashid.com'), (:fd, 'fd9@dralirashid.com');
insert into public.staff (id, full_name, email, role) values (:admin, 'Dr. Ali Rashid', 'ali9@dralirashid.com', 'admin'), (:fd, 'Front desk', 'fd9@dralirashid.com', 'front_desk');
insert into public.patients (id, mr_number, full_name, phone, first_branch_id, created_at) values
  (:p1, '77001', 'Ayan Khan', '03001234567', 2, '2024-03-01'),
  (:p2, '77002', 'Hina Baig', '03007654321', 2, '2024-05-01'),
  (:p3, '77003', 'Zara Ali', '03003330003', 2, '2024-06-01'),
  (:p4, '77004', 'Common Name', null, 1, '2024-06-01'),
  (:p5, '77005', 'Common Name', null, 1, '2024-07-01');
-- the highest Healthwire number the website has (from the Healthwire import): new Healthwire numbers up to 12100 may be made
insert into public.patients (mr_number, full_name, phone, first_branch_id, legacy_source) values ('12000', 'Sample Healthwire Top', '03199912000', 2, 'healthwire');
-- A Healthwire visit for Ayan on bonding day: label only, no doctors, no details.
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label, legacy_source, completed_at) values
  (:p1, 2, '2024-03-05', 'completed', 'Bonding', 'healthwire', '2024-03-05 20:00+05');

-- Front desk cannot run it.
select set_config('request.jwt.claim.sub', :fd, false);
set role authenticated;
select pg_temp.expect_error($$select public.import_aaj_sheet('[]'::jsonb)$$, 'Only Dr. Ali', 'front desk cannot import the sheet');
reset role; select set_config('request.jwt.claim.sub', '', false);

select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
create temp table res as select public.import_aaj_sheet(pg_temp.sheet_rows(), true) r;
select pg_temp.check((select (r->>'future')::int from res) = 1, 'the row dated today is left to the live sheet');
select pg_temp.check((select (r->>'patients_created')::int from res) = 2, 'two patients created (the Healthwire Mr# 7709 and 7851); no row without an Mr# and no Mr# of 50000 or more is made a patient');
select pg_temp.check((select (r->>'checkups_skipped')::int from res) = 2, 'the two rows without an Mr# whose Treatment says checkup are checkup patients: skipped and counted, not visits');
select pg_temp.check((select (r->>'rows_unmatched')::int from res) = 4
                     and (select string_agg(coalesce(u->>'mr', '-') || ' ' || (u->>'name'), ',' order by u->>'name', coalesce(u->>'mr', '-')) from res, jsonb_array_elements(r->'unmatched') u)
                         = '- Ayan Khan,- Hina Baig,77089 Hina Baig,77088 Typo Number',
  'the rows nobody can be sure of are reported back: no Mr# and no fitting phone (a name alone is not enough), and the typo Mr# (also the one typed with an existing patient''s name and phone)');
select pg_temp.check((select u->>'why' = 'an Mr# of 50000 or more that the website never gave (a typo)' from res, jsonb_array_elements(r->'unmatched') u where u->>'mr' = '77088'),
  'the typo Mr# says why it was not filed');
select pg_temp.check((select (r->>'visits_inserted')::int from res) = 5, 'five visits added (Ayan month 4, Zara, Hina, Common Name, the new Healthwire patient 7851)');
select pg_temp.check((select (r->>'visits_updated')::int from res) = 1, 'the Healthwire bonding visit was completed from the sheet');
select pg_temp.check((select (r->>'cases_created')::int from res) = 1 and (select r->'cases'->>'active' from res) = '1', 'a braces case was created from the month rows and is active');
reset role; select set_config('request.jwt.claim.sub', '', false);

select pg_temp.check((select mr_number = '7709' and legacy_source = 'aaj_ki_list' from public.patients where full_name = 'Common Name' and first_branch_id = 2), 'the created patient keeps the Mr# from the sheet');
select pg_temp.check((select count(*) from public.patients where full_name = 'Nobody Known') = 0, 'no patient is created from a name alone');
select pg_temp.check((select count(*) from public.patients where full_name = 'Phone Only' or phone = '03009990077') = 0,
  'no patient is created from a row without an Mr#, even with a phone (a checkup patient, or a patient whose Mr# was forgotten)');
select pg_temp.check((select count(*) from public.patients where full_name = 'Typo Number' or mr_number in ('77088', '77089')) = 0,
  'no patient is created for an Mr# of 50000 or more that the website does not have (a typo: the website''s own numbers start at 50000)');
select pg_temp.check((select count(*) from public.patients where mr_number = '7851' and full_name = 'Zara Ali' and phone = '03007770001') = 1
                     and (select count(*) from public.visits v join public.patients p on p.id = v.patient_id where p.mr_number = '7851') = 1,
  'a Healthwire Mr# the website does not have is made with that Mr# and gets its visit, although another patient has the same name');
select pg_temp.check((select count(*) from public.visits where patient_id = :p2) = 1,
  'Hina Baig has only her own Mr# row: neither the name-only row nor the typo Mr# typed with her phone was put on her file');
select pg_temp.check(not exists (select 1 from public.visits where patient_id = :p1 and visit_date = (now() at time zone 'Asia/Karachi')::date - 12),
  'the row with Ayan Khan''s name and a phone that is not his is not put on his file');
select pg_temp.check((select count(*) from public.visits v where v.legacy_source = 'aaj_ki_list' and v.treatment_label = 'Checkup' and v.visit_date = (now() at time zone 'Asia/Karachi')::date - 10) = 2,
  'no checkup row became a visit (the two Checkup visits are the rows that carry an Mr#: Hina Baig 77002 and Common Name 7709)');
select pg_temp.check((select start_date = '2024-03-05' and status = 'active' from public.braces_cases where patient_id = :p1), 'the case starts on the month-1 row');
select pg_temp.check((select details_text = 'Bonding' and token_no = 3 and braces_month = 1 and braces_case_id is not null and notes like 'Aaj ki List (North Nazimabad)%'
                        from public.visits where patient_id = :p1 and visit_date = '2024-03-05'), 'the Healthwire visit got details, token, month and case from the sheet');
select pg_temp.check((select count(*) from public.visit_staff s join public.visits v on v.id = s.visit_id where v.patient_id = :p1 and v.visit_date = '2024-03-05' and s.role = 'doctor') = 1, 'the doctor was added to the Healthwire visit');
select pg_temp.check((select braces_month = 4 and token_no = 12 and doctor_group_id = 1 and notes like '%Also: Dr Unknown%' and status = 'completed' and legacy_source = 'aaj_ki_list'
                        from public.visits where patient_id = :p1 and visit_date = (now() at time zone 'Asia/Karachi')::date - 40), 'the new month-4 visit carries month, token, group and the unknown name');
select pg_temp.check((select count(*) filter (where role = 'doctor') = 1 and count(*) filter (where role = 'assistant') = 1
                        from public.visit_staff s join public.visits v on v.id = s.visit_id where v.patient_id = :p1 and v.visit_date = (now() at time zone 'Asia/Karachi')::date - 40), 'doctor and assistant on the new visit');
select pg_temp.check((select count(*) from public.visits where patient_id = :p3) = 1, 'two sheet rows on one day make one visit for Zara');
select pg_temp.check((select details_text like '%OPG%' and token_no = 5 from public.visits where patient_id = :p3), 'the second row folded into the first (details and token)');
select pg_temp.check((select count(*) from public.visit_staff s join public.visits v on v.id = s.visit_id where v.patient_id = :p3) = 2, 'people from both rows are on the one visit');
select pg_temp.check((select token_no is null from public.visits where patient_id = :p2), 'a token already used that day is not given twice');
select pg_temp.check((select notes like '%Reminder: Called%' from public.visits where patient_id = :p3), 'reminder status kept in the notes');

-- Running the same file again changes nothing.
select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
create temp table res2 as select public.import_aaj_sheet(pg_temp.sheet_rows(), true) r;
select pg_temp.check((select (r->>'visits_inserted')::int + (r->>'visits_updated')::int + (r->>'patients_created')::int + (r->>'cases_created')::int + (r->>'staff_added')::int from res2) = 0,
  'a second run adds nothing');

-- A patient whose old rows arrive in one batch and recent rows in the next: the case made from the old batch is reopened.
create temp table res3 as select public.import_aaj_sheet(jsonb_build_array(
  jsonb_build_array('2024-01-10', 2, '77002', 'Hina Baig', null, null, 1, 'Bonding', 2, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Bonding', null, 'North Nazimabad', true, 4),
  jsonb_build_array('2024-02-12', 2, '77002', 'Hina Baig', null, null, 2, 'Monthly', 2, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'U L 012', null, 'North Nazimabad', false, 1)), false) r;
select pg_temp.check((select status = 'discontinued' from public.braces_cases where patient_id = :p2), 'old rows alone make a discontinued case (no entry for 75+ days)');
create temp table res4 as select public.import_aaj_sheet(jsonb_build_array(
  jsonb_build_array(((now() at time zone 'Asia/Karachi')::date - 20)::text, 2, '77002', 'Hina Baig', null, null, 3, 'Monthly', 2, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'U L 014', null, 'North Nazimabad', false, 1)), false) r;
select pg_temp.check((select status = 'active' and notes like '%Entries continue to%' from public.braces_cases where patient_id = :p2), 'a later batch with recent rows reopens the case');
select pg_temp.check((select count(*) from public.visits where patient_id = :p2 and braces_month is not null) = 3 and (select (r->>'cases_created')::int from res4) = 0, 'the recent row joined the same case; no second case');

-- Loop 5 (R5-2): an archived row typed with ANOTHER patient's Mr# (the sync refused it, nobody fixed it before midnight) is not filed on the
-- patient of that Mr#: no visit and no braces case for her, and it comes back as unmatched with the reason. The sync's own check is used: the
-- name fits without doubt. A name that fits only with doubt (the same first name with another surname, or another name typed with the
-- patient's own phone) is not filed on that patient either: it comes back with why (orchestrator decision, 11 Oct 2026).
create temp table res5 as select public.import_aaj_sheet(jsonb_build_array(
  jsonb_build_array(((now() at time zone 'Asia/Karachi')::date - 15)::text, 2, '77003', 'Bilal Ahmed', null, '03001239999', 6, 'Monthly', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'U L 014', null, 'North Nazimabad', false, 1),
  jsonb_build_array(((now() at time zone 'Asia/Karachi')::date - 15)::text, 2, '77002', 'Hina Rajpoot', null, null, null, 'Filling', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, null),
  jsonb_build_array(((now() at time zone 'Asia/Karachi')::date - 16)::text, 2, '77003', 'Zee', null, '03003330003', null, 'Scaling', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 16)), true) r;
select pg_temp.check((select (r->>'rows_unmatched')::int = 3 and (r->>'patients_created')::int = 0 and (r->>'cases_created')::int = 0 from res5)
                     and (select u->>'name' = 'Bilal Ahmed' and u->>'mr' = '77003' and u->>'why' = 'Mr# belongs to another patient' from res5, jsonb_array_elements(r->'unmatched') u where u->>'name' = 'Bilal Ahmed'),
  'a row typed with another patient''s Mr# is reported back as "Mr# belongs to another patient": no patient file, no braces case');
select pg_temp.check(not exists (select 1 from public.visits where patient_id = :p3 and visit_date = (now() at time zone 'Asia/Karachi')::date - 15)
                     and not exists (select 1 from public.braces_cases where patient_id = :p3),
  'nothing of that row is put on the file of the patient whose Mr# it carries (no visit with the other person''s treatment, no case from its Month)');
select pg_temp.check(not exists (select 1 from public.visits where patient_id = :p2 and visit_date = (now() at time zone 'Asia/Karachi')::date - 15)
                     and (select u->>'why' = 'the name only partly matches Mr# 77002 (Hina Baig): another surname, another first name or only the phone. Check the Mr# or the name'
                            from res5, jsonb_array_elements(r->'unmatched') u where u->>'name' = 'Hina Rajpoot'),
  'the same first name with another surname (Hina Rajpoot for Hina Baig) is not filed on the patient: it comes back with why, naming the Mr#''s patient for Dr. Ali');
select pg_temp.check(not exists (select 1 from public.visits where patient_id = :p3 and visit_date = (now() at time zone 'Asia/Karachi')::date - 16)
                     and (select u->>'why' like 'the name only partly matches Mr# 77003 (Zara Ali):%' from res5, jsonb_array_elements(r->'unmatched') u where u->>'name' = 'Zee'),
  'a name that does not fit, typed with the patient''s own phone, is not filed on that patient any more (the sync refuses it too): it comes back with why');

-- Loop 6 (abuse-privacy M1, M2 / sheet-behaviour M2): an Mr# the website does not have is never made a patient file when the sync refused it
-- for who it is, even with "Add patient records": its exact name and phone are filed under another Mr# (mr_other), or it is a retired Mr#
-- (the website's 10000-10012 moved to 50000+ by 20261009000400, or a number merged away) and the name fits that patient (mr_moved). Those
-- rows come back as unmatched with the reason, and so do the other rows of that Mr# in the file. A retired number typed with ANOTHER name is
-- a Healthwire number like any other (Healthwire will give 10000-10012 to new people): made as usual.
reset role; select set_config('request.jwt.claim.sub', '', false);
insert into public.patients (mr_number, full_name, phone, first_branch_id, notes) values
  ('77010', 'Ikram Sample', '03120000010', 2, null),
  ('50903', 'Renum Sample', null, 2, 'Mr# was 10903 until 09 Oct 2026 (the website now numbers from 50000)'),
  ('50904', 'Renum Other', null, 2, 'Mr# was 10904 until 09 Oct 2026 (the website now numbers from 50000)'),
  ('77020', 'Merge Keeper', '03120000020', 2, 'First visit 2024 · Merged with Mr# 9605 (Merge Keeper) on 08 Oct 2026'),
  ('77021', 'Merge Other', null, 2, 'Merged with Mr# 9606 (Merge Other) on 08 Oct 2026'),
  ('50905', 'Asif Khanzada', null, 2, 'Mr# was 10905 until 09 Oct 2026 (the website now numbers from 50000)');
select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
create temp table res6 as
  with c as (select (now() at time zone 'Asia/Karachi')::date today)
  select public.import_aaj_sheet(jsonb_build_array(
    jsonb_build_array((today - 18)::text, 2, '11012', 'Ikram Sample', null, '03120000010', null, 'Scaling', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 16),
    jsonb_build_array((today - 17)::text, 2, '11012', 'Ikram Sample', null, null, null, 'Filling', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, null),
    jsonb_build_array((today - 18)::text, 2, '10903', 'Renum Sample', null, null, 4, 'Monthly', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 1),
    jsonb_build_array((today - 18)::text, 2, '10904', 'Kashif Newhw', null, null, null, 'Scaling', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 16),
    jsonb_build_array((today - 18)::text, 2, '9605', 'Merge Keeper', null, null, null, 'Scaling', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 16),
    jsonb_build_array((today - 18)::text, 2, '9606', 'Tariq Different', null, null, null, 'Scaling', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 16),
    jsonb_build_array((today - 18)::text, 2, '10905', 'Asif Raza', null, null, null, 'Scaling', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 16)), true) r
  from c;
select pg_temp.check((select (r->>'patients_created')::int = 3 and (r->>'rows_unmatched')::int = 4 and (r->>'cases_created')::int = 0 from res6),
  'only the three Healthwire numbers typed for new people are made; four rows come back unmatched; no braces case');
select pg_temp.check((select count(*) from public.patients where mr_number in ('11012', '10903', '9605')) = 0,
  'no second patient file: not for a name and phone already filed under another Mr#, not under a renumbered or merged-away number of that patient');
select pg_temp.check((select string_agg(coalesce(u->>'mr', '-') || ' ' || (u->>'name') || ' ' || coalesce(u->>'phone', '-') || ': ' || coalesce(u->>'why', '?'), ' | ' order by u->>'mr', u->>'phone')
                        from res6, jsonb_array_elements(r->'unmatched') u)
                       = '10903 Renum Sample -: Mr# was renumbered to 50903'
                         || ' | 11012 Ikram Sample 03120000010: this name and phone are Mr# 77010'
                         || ' | 11012 Ikram Sample -: held back with the other row of this Mr# (this name and phone are Mr# 77010)'
                         || ' | 9605 Merge Keeper -: Mr# was merged into 77020',
  'each of them is reported with why: the Mr# the name and phone are filed under, the Mr# the patient has now');
select pg_temp.check(not exists (select 1 from public.visits v join public.patients p on p.id = v.patient_id
                                  where p.mr_number in ('77010', '50903', '77020') and v.visit_date >= (now() at time zone 'Asia/Karachi')::date - 18)
                     and not exists (select 1 from public.braces_cases b join public.patients p on p.id = b.patient_id where p.mr_number = '50903'),
  'and nothing of those rows is filed anywhere: the owner corrects the Mr# in the file and imports it again');
select pg_temp.check((select count(*) from public.patients p join public.visits v on v.patient_id = p.id
                       where (p.mr_number = '10904' and p.full_name = 'Kashif Newhw') or (p.mr_number = '9606' and p.full_name = 'Tariq Different')) = 2,
  'a renumbered or merged-away number typed with another person''s name is a Healthwire number: the patient is made with it and gets the visit');
select pg_temp.check((select count(*) from public.patients p join public.visits v on v.patient_id = p.id where p.mr_number = '10905' and p.full_name = 'Asif Raza') = 1
                     and not exists (select 1 from public.visits v join public.patients p on p.id = v.patient_id where p.mr_number = '50905'),
  'loop 7: the same first name with another surname (Asif Raza for the old number of Asif Khanzada) is another person too: a new Healthwire file, nothing on Asif Khanzada''s');

-- Loop 8 (abuse-privacy M1), as decided on 11 Oct 2026: a row with an Mr# whose name fits that patient only with doubt (another surname, or
-- another name typed with the patient's own phone) is not filed on the patient at all (no visit, no braces case, a visit already there is not
-- touched): it comes back with why, like the sync, which refuses such a row.
-- (abuse-privacy M2): a row without an Mr# is filed on the one patient of that first name on its phone only when the surnames do not conflict
-- ("Ali Raza" is not his brother "Ali Hamza" on the family phone): otherwise it comes back with why; a first name alone is filed with the note.
reset role; select set_config('request.jwt.claim.sub', '', false);
insert into public.patients (mr_number, full_name, phone, first_branch_id) values
  ('77031', 'Ayesha Khan', '03160000031', 2), ('77032', 'Fatima Noor', '03160000032', 2), ('77033', 'Ali Hamza', '03160000002', 2), ('77034', 'Held Visit', '03160000034', 2);
insert into public.visits (patient_id, branch_id, visit_date, status, treatment_label)
  select id, 2, (now() at time zone 'Asia/Karachi')::date - 21, 'waiting', 'Monthly' from public.patients where mr_number = '77034';
select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
create temp table res7 as
  with c as (select (now() at time zone 'Asia/Karachi')::date today)
  select public.import_aaj_sheet(jsonb_build_array(
    jsonb_build_array((today - 20)::text, 2, '77031', 'Ayesha Rajpoot', null, null, 5, 'Monthly', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 1),
    jsonb_build_array((today - 20)::text, 2, '77032', 'Zoya Noor', null, '03160000032', 2, 'Monthly', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 1),
    jsonb_build_array((today - 21)::text, 2, '77034', 'Held Rajpoot', null, null, 3, 'Monthly', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 1),
    jsonb_build_array((today - 20)::text, 2, null, 'Ali Raza', null, '03160000002', 6, 'Monthly', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 1),
    jsonb_build_array((today - 19)::text, 2, null, 'Ali Raza', null, '03160000002', null, 'Filling', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, null),
    jsonb_build_array((today - 18)::text, 2, null, 'Ali', null, '03160000002', 4, 'Monthly', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 1),
    jsonb_build_array((today - 18)::text, 2, 'NEW', 'New Checkup Person', null, '03160000099', null, 'Checkup', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, null)), true) r
  from c;
select pg_temp.check((select (r->>'cases_created')::int = 0 and (r->>'patients_created')::int = 0 and (r->>'checkups_skipped')::int = 1 from res7)
                     and not exists (select 1 from public.braces_cases b join public.patients p on p.id = b.patient_id where p.mr_number in ('77031', '77032', '77033', '77034')),
  'M1: no braces case for a row whose name fits only with doubt (another surname, the patient''s phone only) or a first name only on a phone; a "NEW" checkup row is skipped as a checkup');
select pg_temp.check(not exists (select 1 from public.visits v join public.patients p on p.id = v.patient_id
                                  where p.mr_number in ('77031', '77032') and v.visit_date = (now() at time zone 'Asia/Karachi')::date - 20)
                     and (select string_agg((u->>'mr') || ' ' || (u->>'name') || ': ' || (u->>'why'), ' | ' order by u->>'mr')
                            from res7, jsonb_array_elements(r->'unmatched') u where u->>'mr' in ('77031', '77032', '77034'))
                         = '77031 Ayesha Rajpoot: the name only partly matches Mr# 77031 (Ayesha Khan): another surname, another first name or only the phone. Check the Mr# or the name'
                           || ' | 77032 Zoya Noor: the name only partly matches Mr# 77032 (Fatima Noor): another surname, another first name or only the phone. Check the Mr# or the name'
                           || ' | 77034 Held Rajpoot: the name only partly matches Mr# 77034 (Held Visit): another surname, another first name or only the phone. Check the Mr# or the name',
  'M1: another surname, and a daughter typed with her mother''s Mr# on the family phone: no visit on that patient, each comes back with why');
select pg_temp.check((select v.braces_month is null and v.braces_case_id is null and v.notes is null and v.status = 'waiting' and v.treatment_label = 'Monthly'
                        from public.visits v join public.patients p on p.id = v.patient_id where p.mr_number = '77034' and v.visit_date = (now() at time zone 'Asia/Karachi')::date - 21),
  'M1: a visit already on the website for that day is not touched by a row whose name fits only with doubt (no notes, no month, not completed)');
select pg_temp.check((select count(*) from public.visits v join public.patients p on p.id = v.patient_id where p.mr_number = '77033' and v.visit_date in ((now() at time zone 'Asia/Karachi')::date - 20, (now() at time zone 'Asia/Karachi')::date - 19)) = 0
                     and (select u->>'why' = 'add the Mr# (another person with this first name is on this phone)' and (u->>'rows')::int = 2
                            from res7, jsonb_array_elements(r->'unmatched') u where u->>'name' = 'Ali Raza'),
  'M2: "Ali Raza" without an Mr# on the phone of his brother "Ali Hamza" is not filed on him (with or without a Month): it comes back with why');
select pg_temp.check((select v.braces_month is null and v.notes like '%Month 4%' and v.notes like '%Sheet name: Ali (check the Mr#)%'
                        from public.visits v join public.patients p on p.id = v.patient_id where p.mr_number = '77033' and v.visit_date = (now() at time zone 'Asia/Karachi')::date - 18),
  'M2: the first name alone on that phone is filed on the one patient of that first name, with the note to check it and its Month in the notes only');
-- the same reason without "Add patient records" (11 Oct 2026): a row whose name fits its Mr# only with doubt is never filed on that patient
create temp table res8 as select public.import_aaj_sheet(jsonb_build_array(
  jsonb_build_array(((now() at time zone 'Asia/Karachi')::date - 22)::text, 2, '77031', 'Ayesha Rajpoot', null, null, null, 'Scaling', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 16),
  jsonb_build_array(((now() at time zone 'Asia/Karachi')::date - 22)::text, 2, '77031', 'Aisha Khan', null, null, null, 'Filling', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 16)), false) r;
select pg_temp.check((select (r->>'rows_unmatched')::int = 1 and (r->'unmatched'->0->>'name') = 'Ayesha Rajpoot'
                             and (r->'unmatched'->0->>'why') = 'the name only partly matches Mr# 77031 (Ayesha Khan): another surname, another first name or only the phone. Check the Mr# or the name'
                        from res8)
                     and (select count(*) = 1 and bool_and(v.treatment_label = 'Filling') from public.visits v join public.patients p on p.id = v.patient_id
                           where p.mr_number = '77031' and v.visit_date = (now() at time zone 'Asia/Karachi')::date - 22),
  'without "Add patient records" too: "Ayesha Rajpoot" comes back with the reason and files nothing; "Aisha Khan" (an everyday spelling of Ayesha Khan) is filed on her');

-- (abuse-privacy M-HW-SQUAT, 11 Oct 2026) "Add patient records" makes a Healthwire Mr# only up to the highest Healthwire number the website has
-- plus 100 (12000 + 100 here). Above it Healthwire has not given the number yet (a typo such as 12988 for 12098, or a patient newer than the
-- last Healthwire import): no file, reported back with why. Files the import itself made (10904, 10905 above) and files the sync made from a
-- typed row do not raise the limit.
reset role; select set_config('request.jwt.claim.sub', '', false);
insert into public.patients (mr_number, full_name, phone, first_branch_id, legacy_source) values ('12300', 'Sample Sync Made', null, 2, 'aaj_sheet_sync');
select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
create temp table res9 as select public.import_aaj_sheet(jsonb_build_array(
  jsonb_build_array(((now() at time zone 'Asia/Karachi')::date - 23)::text, 2, '12100', 'Sample Edge Hw', null, null, null, 'Scaling', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 16),
  jsonb_build_array(((now() at time zone 'Asia/Karachi')::date - 23)::text, 2, '12101', 'Sample Ahead Hw', null, null, null, 'Scaling', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 16),
  jsonb_build_array(((now() at time zone 'Asia/Karachi')::date - 22)::text, 2, '12101', 'Sample Ahead Hw', null, null, null, 'Filling', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 16),
  jsonb_build_array(((now() at time zone 'Asia/Karachi')::date - 23)::text, 2, '12350', 'Sample Past Sync', null, null, null, 'Scaling', null, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 16)), true) r;
select pg_temp.check((select (r->>'patients_created')::int = 1 and (r->>'rows_unmatched')::int = 3 from res9)
                     and (select count(*) from public.patients where mr_number = '12100' and full_name = 'Sample Edge Hw') = 1
                     and (select count(*) from public.patients where mr_number in ('12101', '12350')) = 0,
  'M-HW-SQUAT: "Add patient records" makes Healthwire Mr# 12100 (the highest Healthwire number 12000 plus 100), never 12101, nor 12350 (a file the sync made, 12300, does not raise the limit)');
select pg_temp.check((select count(*) = 2 and bool_and(u->>'why' = 'an Mr# above the newest Healthwire number the website takes (12100): probably a typo. Check the Mr#, or import the Healthwire patients first')
                        from res9, jsonb_array_elements(r->'unmatched') u where u->>'mr' in ('12101', '12350'))
                     and (select (u->>'rows')::int = 2 from res9, jsonb_array_elements(r->'unmatched') u where u->>'mr' = '12101'),
  'M-HW-SQUAT: each such row comes back with why (both days of 12101), and nothing of it is filed');
reset role; select set_config('request.jwt.claim.sub', '', false);
rollback;
