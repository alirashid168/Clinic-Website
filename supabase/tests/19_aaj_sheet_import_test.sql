-- Aaj ki List history import: matching patients, completing Healthwire visits, braces cases from the history, tokens, people.
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
    jsonb_build_array((today - 10)::text, 2, null, 'Zara Ali', null, null, null, 'Scaling', 5, 'completed', null, '[]'::jsonb, jsonb_build_array(hira), '[]'::jsonb, null, 'Called', 'North Nazimabad', false, 16),
    jsonb_build_array((today - 10)::text, 2, null, 'Zara Ali', null, null, null, 'X-Ray / OPG', null, 'completed', null, jsonb_build_array(komal), '[]'::jsonb, '[]'::jsonb, 'OPG', null, 'North Nazimabad', false, 20),
    jsonb_build_array((today - 10)::text, 2, '77002', 'Hina Baig', null, '03007654321', null, 'Checkup', 5, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 14),
    jsonb_build_array((today - 10)::text, 2, '77009', 'Common Name', null, null, null, 'Checkup', 6, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 14),
    jsonb_build_array((today - 10)::text, 2, null, 'Nobody Known', null, null, null, 'Checkup', 7, 'no_show', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 14),
    jsonb_build_array(today::text, 2, '77001', 'Ayan Khan', null, '03001234567', 5, 'Monthly', 1, 'completed', null, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, null, 'North Nazimabad', false, 1))
  from c $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

begin;
insert into auth.users (id, email) values (:admin, 'ali9@dralirashid.com'), (:fd, 'fd9@dralirashid.com');
insert into public.staff (id, full_name, email, role) values (:admin, 'Dr. Ali Rashid', 'ali9@dralirashid.com', 'admin'), (:fd, 'Front desk', 'fd9@dralirashid.com', 'front_desk');
insert into public.patients (id, mr_number, full_name, phone, first_branch_id, created_at) values
  (:p1, '77001', 'Ayan Khan', '03001234567', 2, '2024-03-01'),
  (:p2, '77002', 'Hina Baig', '03007654321', 2, '2024-05-01'),
  (:p3, '77003', 'Zara Ali', null, 2, '2024-06-01'),
  (:p4, '77004', 'Common Name', null, 1, '2024-06-01'),
  (:p5, '77005', 'Common Name', null, 1, '2024-07-01');
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
select pg_temp.check((select (r->>'patients_created')::int from res) = 1, 'one patient created (has an Mr#); the name-only row is not');
select pg_temp.check((select (r->>'rows_unmatched')::int from res) = 1 and (select r->'unmatched'->0->>'name' from res) = 'Nobody Known', 'the name-only unknown row is reported back');
select pg_temp.check((select (r->>'visits_inserted')::int from res) = 4, 'four visits added (Ayan month 4, Zara, Hina, Common Name)');
select pg_temp.check((select (r->>'visits_updated')::int from res) = 1, 'the Healthwire bonding visit was completed from the sheet');
select pg_temp.check((select (r->>'cases_created')::int from res) = 1 and (select r->'cases'->>'active' from res) = '1', 'a braces case was created from the month rows and is active');
reset role; select set_config('request.jwt.claim.sub', '', false);

select pg_temp.check((select mr_number = '77009' and legacy_source = 'aaj_ki_list' from public.patients where full_name = 'Common Name' and first_branch_id = 2), 'the created patient keeps the Mr# from the sheet');
select pg_temp.check((select count(*) from public.patients where full_name = 'Nobody Known') = 0, 'no patient is created from a name alone');
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
reset role; select set_config('request.jwt.claim.sub', '', false);
rollback;
