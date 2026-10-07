-- Doctor dashboard: a doctor's own numbers (treated, checked, billed, own patients paid, complaints, share); only their own unless allowed.
\set ON_ERROR_STOP 1
\set admin  '''00000000-0000-0000-0000-000000002000'''
\set doc    '''00000000-0000-0000-0000-000000002001'''
\set doc2   '''00000000-0000-0000-0000-000000002002'''
\set pt     '''00000000-0000-0000-0000-000000002011'''
\set pt2    '''00000000-0000-0000-0000-000000002012'''
\set v1     '''00000000-0000-0000-0000-000000002021'''
\set v2     '''00000000-0000-0000-0000-000000002022'''
\set v3     '''00000000-0000-0000-0000-000000002023'''

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
insert into auth.users (id, email) values (:admin, 'ali20@dralirashid.com'), (:doc, 'komal20@dralirashid.com'), (:doc2, 'samrah20@dralirashid.com');
insert into public.staff (id, full_name, email, role) values (:admin, 'Dr. Ali Rashid', 'ali20@dralirashid.com', 'admin'),
  (:doc, 'Dr. Komal Rubab', 'komal20@dralirashid.com', 'doctor'), (:doc2, 'Dr. Samrah Khan', 'samrah20@dralirashid.com', 'doctor');
update public.clinicians set staff_id = :doc where display_name = 'Dr. Komal Rubab';
update public.clinicians set staff_id = :doc2 where display_name = 'Dr. Samrah Khan';
insert into public.patients (id, mr_number, full_name, phone, first_branch_id, referred_by_clinician) values
  (:pt, '66001', 'Own Patient', '03001111111', 1, (select id from public.clinicians where display_name = 'Dr. Komal Rubab')),
  (:pt2, '66002', 'Walk In', '03002222222', 1, null);
insert into public.visits (id, patient_id, branch_id, visit_date, status, treatment_label, photos_uploaded, completed_at) values
  (:v1, :pt, 1, '2026-09-02', 'completed', 'Scaling', true, '2026-09-02 18:00+05'),
  (:v2, :pt2, 1, '2026-09-03', 'completed', 'Filling', true, '2026-09-03 18:00+05'),
  (:v3, :pt2, 1, '2026-09-04', 'completed', 'Checkup', true, '2026-09-04 18:00+05');
insert into public.visit_staff (visit_id, clinician_id, role) values
  (:v1, (select id from public.clinicians where display_name = 'Dr. Komal Rubab'), 'doctor'),
  (:v2, (select id from public.clinicians where display_name = 'Dr. Komal Rubab'), 'doctor'),
  (:v3, (select id from public.clinicians where display_name = 'Dr. Komal Rubab'), 'checker'),
  (:v3, (select id from public.clinicians where display_name = 'Dr. Samrah Khan'), 'doctor');
insert into public.invoices (invoice_no, patient_id, branch_id, visit_id, issue_date, subtotal, status) values ('T-66001', :pt2, 1, :v2, '2026-09-03', 5000, 'issued');
insert into public.payments (patient_id, branch_id, amount, method, received_at) values (:pt, 1, 3000, 'cash', '2026-09-02 17:00+05'), (:pt2, 1, 5000, 'cash', '2026-09-03 17:00+05');
insert into public.complaints (patient_id, branch_id, clinician_id, subject, body, created_at) values
  (:pt2, 1, (select id from public.clinicians where display_name = 'Dr. Komal Rubab'), 'Filling fell out', 'The filling came out after two days.', '2026-09-10 10:00+05');
update public.doctor_commission_rules set active = false;
insert into public.doctor_commission_rules (clinician_id, basis, percent, notes) values (null, 'referred', 40, '60/40: 40% to the doctor on patients they bring in');

-- The doctor sees their own summary.
select set_config('request.jwt.claim.sub', :doc, false);
set role authenticated;
create temp table ds as select public.doctor_summary((select id from public.clinicians where display_name = 'Dr. Komal Rubab'), '2026-09-01', '2026-09-30') r;
select pg_temp.check((select (r->>'treated')::int = 2 and (r->>'checked')::int = 1 and (r->>'days')::int = 3 from ds), 'treated 2, checked 1, 3 working days');
select pg_temp.check((select (r->>'billed')::numeric = 5000 from ds), 'invoices made from treated visits: 5,000');
select pg_temp.check((select (r->>'referred_patients')::int = 1 and (r->>'referred_paid')::numeric = 3000 from ds), 'own patients: 1, paid 3,000 in the period');
select pg_temp.check((select (r->>'share')::numeric = 1200 and r->'rule'->>'basis' = 'referred' from ds), 'doctor share = 40% of what own patients paid = 1,200');
select pg_temp.check((select jsonb_array_length(r->'complaints') = 1 and r->'complaints'->0->>'subject' = 'Filling fell out' from ds), 'the complaint linked to the doctor is listed');
-- Not another doctor's.
select pg_temp.expect_error($$select public.doctor_summary((select id from public.clinicians where display_name = 'Dr. Samrah Khan'), '2026-09-01', '2026-09-30')$$,
  'own summary', 'a doctor cannot see another doctor''s summary');
reset role; select set_config('request.jwt.claim.sub', '', false);

-- Dr. Ali sees anyone's.
select set_config('request.jwt.claim.sub', :admin, false);
set role authenticated;
select pg_temp.check((select (public.doctor_summary((select id from public.clinicians where display_name = 'Dr. Samrah Khan'), '2026-09-01', '2026-09-30')->>'treated')::int) = 1, 'Dr. Ali sees every doctor''s summary');
reset role; select set_config('request.jwt.claim.sub', '', false);
rollback;
