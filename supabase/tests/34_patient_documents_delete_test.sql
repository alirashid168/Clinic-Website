-- Upload picture / X-ray / consent form and Delete for documents (20261015001000_patient_documents_delete.sql). Made-up people only.
--   1. a consent form ticks "Consent signed" (patients.treatment_consent_at) when it is not ticked, for an assistant too (who may not
--      edit the patient), at the form's date (noon in Pakistan) or now; a tick that is there keeps its date; other kinds tick nothing;
--   2. who may delete a document (row and file): whoever may add one (patients.edit or photos.upload); an accountant, a switched-off
--      account, a patient login and anonymous visitors cannot, through the function or the API;
--   3. the audit log has the document added and deleted, with who did it and the whole row;
--   4. deleting the last consent form unticks "Consent signed" only when asked, never while another consent form is left;
--      a document already gone answers deleted = false;
--   5. X-rays go to the existing X-ray store: photos.upload adds them (row and file), xrays.view sees them, the front desk does not add.
\set ON_ERROR_STOP 1
\set admin  '''00000000-0000-0000-0000-000000003400'''
\set fd     '''00000000-0000-0000-0000-000000003401'''
\set asst   '''00000000-0000-0000-0000-000000003402'''
\set acct   '''00000000-0000-0000-0000-000000003403'''
\set off    '''00000000-0000-0000-0000-000000003404'''
\set pat    '''00000000-0000-0000-0000-000000003405'''

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
create or replace function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, false) $$;
grant execute on all functions in schema pg_temp to authenticated, anon;
reset role;
select pg_temp.act_as('');

begin;
insert into auth.users (id, email) values
  (:admin, 'admin34@dralirashid.com'), (:fd, 'fd34@dralirashid.com'), (:asst, 'asst34@dralirashid.com'),
  (:acct, 'acct34@dralirashid.com'), (:off, 'off34@dralirashid.com'), (:pat, 'samplepatient-34@dralirashid.com');
insert into public.staff (id, full_name, email, role) values
  (:admin, 'Admin Thirtyfour', 'admin34@dralirashid.com', 'admin'),
  (:fd, 'Front Desk Thirtyfour', 'fd34@dralirashid.com', 'front_desk'),
  (:asst, 'Assistant Thirtyfour', 'asst34@dralirashid.com', 'assistant'),
  (:acct, 'Accountant Thirtyfour', 'acct34@dralirashid.com', 'accountant');
insert into public.staff (id, full_name, email, role, active) values (:off, 'Switched Off Thirtyfour', 'off34@dralirashid.com', 'assistant', false);
insert into public.patients (mr_number, full_name, phone) values ('34001', 'Sample Thirtyfour', '03005553401'), ('34002', 'Sample Thirtyfour Two', '03005553402');
insert into public.patients (mr_number, full_name, phone, portal_user_id) values ('34003', 'Sample Thirtyfour Portal', '03005553403', :pat);
select id as p1 from public.patients where mr_number = '34001' \gset
select id as p2 from public.patients where mr_number = '34002' \gset
select id as p3 from public.patients where mr_number = '34003' \gset

-- 1. A consent form ticks "Consent signed".
set role authenticated;
select pg_temp.act_as(:asst);
insert into public.patient_documents (patient_id, kind, title, storage_path, added_on)
values (:'p1', 'report', 'Lab report', :'p1' || '/report34.pdf', current_date);
reset role;
select pg_temp.check((select treatment_consent_at is null from public.patients where id = :'p1'), 'a report ticks nothing');
set role authenticated;
select pg_temp.act_as(:asst);
insert into public.patient_documents (patient_id, kind, title, storage_path, added_on)
values (:'p1', 'consent', 'Consent and information form', :'p1' || '/consent34-a.jpg', current_date);
reset role;
select pg_temp.check((select treatment_consent_at between now() - interval '1 day' and now() from public.patients where id = :'p1'),
  'an assistant (who may not edit the patient) uploads a consent form: "Consent signed" is ticked, today');
update public.patients set treatment_consent_at = '2026-03-01 10:00+05' where id = :'p1';
set role authenticated;
select pg_temp.act_as(:fd);
insert into public.patient_documents (patient_id, kind, title, storage_path, added_on)
values (:'p1', 'consent', 'Consent and information form (2 of 2)', :'p1' || '/consent34-b.jpg', current_date);
insert into public.patient_documents (patient_id, kind, title, storage_path, added_on)
values (:'p2', 'consent', 'Consent and information form', :'p2' || '/consent34-c.pdf', '2026-01-10');
reset role;
select pg_temp.check((select treatment_consent_at = '2026-03-01 10:00+05' from public.patients where id = :'p1'), 'a tick that is there keeps its date');
select pg_temp.check((select treatment_consent_at = '2026-01-10 12:00+05' from public.patients where id = :'p2'), 'a form dated earlier ticks it at that date (noon in Pakistan)');

-- 2. Who may delete. The files of the documents, as Storage keeps them.
insert into storage.objects (bucket_id, name) values
  ('patient-documents', :'p1' || '/report34.pdf'), ('patient-documents', :'p1' || '/consent34-a.jpg'),
  ('patient-documents', :'p1' || '/consent34-b.jpg'), ('patient-documents', :'p2' || '/consent34-c.pdf');
select id as rep from public.patient_documents where storage_path = :'p1' || '/report34.pdf' \gset
select id as ca from public.patient_documents where storage_path = :'p1' || '/consent34-a.jpg' \gset
select id as cb from public.patient_documents where storage_path = :'p1' || '/consent34-b.jpg' \gset
select id as cc from public.patient_documents where storage_path = :'p2' || '/consent34-c.pdf' \gset

set role authenticated;
select pg_temp.act_as(:acct);
select pg_temp.expect_error(format('select public.delete_patient_document(%L)', :'rep'), 'NOT_ALLOWED', 'an accountant cannot delete a document through the function');
delete from public.patient_documents where id = :'rep';
delete from storage.objects where bucket_id = 'patient-documents';
select pg_temp.act_as(:off);
select pg_temp.expect_error(format('select public.delete_patient_document(%L)', :'rep'), 'NOT_ALLOWED', 'a switched-off account cannot either');
delete from public.patient_documents where id = :'rep';
delete from storage.objects where bucket_id = 'patient-documents';
select pg_temp.act_as(:pat);
select pg_temp.expect_error(format('select public.delete_patient_document(%L)', :'rep'), 'NOT_ALLOWED', 'nor a patient login');
delete from public.patient_documents;
delete from storage.objects where bucket_id = 'patient-documents';
reset role;
select pg_temp.act_as('');
set role anon;
select pg_temp.expect_error(format('select public.delete_patient_document(%L)', :'rep'), 'permission denied', 'nor an anonymous visitor');
reset role;
select pg_temp.check((select count(*) from public.patient_documents where patient_id in (:'p1', :'p2')) = 4
                     and (select count(*) from storage.objects where bucket_id = 'patient-documents' and split_part(name, '/', 1) in (:'p1', :'p2')) = 4,
  'their direct deletes through the API reached no row and no file');

-- The front desk (patients.edit) deletes the report: the file through Storage, then the row.
set role authenticated;
select pg_temp.act_as(:fd);
delete from storage.objects where bucket_id = 'patient-documents' and name = :'p1' || '/report34.pdf';
select pg_temp.check((select public.delete_patient_document(:'rep') = '{"deleted": true, "consent_cleared": false, "consent_forms_left": 2}'::jsonb),
  'the front desk deletes a report (the answer counts the consent forms left)');
reset role;
select pg_temp.check(not exists (select 1 from public.patient_documents where id = :'rep')
                     and not exists (select 1 from storage.objects where name = :'p1' || '/report34.pdf'), 'the row and the file are gone');

-- 3. The audit log: added and deleted, by whom, with the whole row.
select pg_temp.check((select count(*) from public.audit_log where table_name = 'patient_documents' and row_id = :'rep'
                       and action = 'INSERT' and actor = :asst::uuid and new_data ->> 'title' = 'Lab report') = 1,
  'the audit log has the document added, by the assistant');
select pg_temp.check((select count(*) from public.audit_log where table_name = 'patient_documents' and row_id = :'rep'
                       and action = 'DELETE' and actor = :fd::uuid and old_data ->> 'storage_path' = :'p1' || '/report34.pdf'
                       and old_data ->> 'title' = 'Lab report' and new_data is null) = 1,
  'and the delete, by the front desk, with the whole row (file path and title)');

-- 4. Consent forms: another one left, nothing is unticked even when asked; the last one unticks only when asked.
set role authenticated;
select pg_temp.act_as(:asst);
delete from storage.objects where bucket_id = 'patient-documents' and name = :'p1' || '/consent34-a.jpg';
select pg_temp.check((select public.delete_patient_document(:'ca', true) = '{"deleted": true, "consent_cleared": false, "consent_forms_left": 1}'::jsonb),
  'an assistant (photos.upload) deletes a consent form; another is left, so "Consent signed" stays although untick was asked');
select pg_temp.check((select (public.delete_patient_document(:'ca', true)) ->> 'deleted') = 'false', 'a document already gone answers deleted = false');
reset role;
select pg_temp.check((select treatment_consent_at is not null from public.patients where id = :'p1'), 'still ticked');
select pg_temp.check(not exists (select 1 from storage.objects where name = :'p1' || '/consent34-a.jpg'), 'the assistant removed its file through Storage');
set role authenticated;
select pg_temp.act_as(:asst);
select pg_temp.check((select public.delete_patient_document(:'cb', true) = '{"deleted": true, "consent_cleared": true, "consent_forms_left": 0}'::jsonb),
  'the last consent form, untick asked: "Consent signed" is unticked');
select pg_temp.act_as(:fd);
select pg_temp.check((select public.delete_patient_document(:'cc') = '{"deleted": true, "consent_cleared": false, "consent_forms_left": 0}'::jsonb),
  'the last consent form, untick not asked: it stays ticked');
reset role;
select pg_temp.check((select treatment_consent_at is null from public.patients where id = :'p1')
                     and (select treatment_consent_at = '2026-01-10 12:00+05' from public.patients where id = :'p2'), 'the ticks are as asked');
select pg_temp.check((select count(*) from public.audit_log where table_name = 'patients' and row_id = :'p1' and action = 'UPDATE'
                       and actor = :asst::uuid and old_data ->> 'treatment_consent_at' is not null and new_data ->> 'treatment_consent_at' is null) = 1,
  'the untick is in the audit log, by the assistant');

-- 5. X-rays: the existing X-ray store (table and bucket).
set role authenticated;
select pg_temp.act_as(:asst);
insert into storage.objects (bucket_id, name) values ('xrays', :'p1' || '/2026-10-15_OPG_34000001.png');
insert into public.xrays (patient_id, kind, storage_path, uploaded_by) values (:'p1', 'OPG', :'p1' || '/2026-10-15_OPG_34000001.png', auth.uid());
select pg_temp.check((select count(*) from public.xrays where patient_id = :'p1') = 1, 'an assistant (photos.upload) adds an X-ray, file and row, and sees it');
select pg_temp.act_as(:fd);
select pg_temp.check((select count(*) from public.xrays where patient_id = :'p1') = 1, 'the front desk sees it (xrays.view)');
select pg_temp.expect_error(format($$insert into public.xrays (patient_id, storage_path) values (%L, 'x34.png')$$, :'p1'), 'row-level security', 'but does not add X-rays');
select pg_temp.expect_error($$insert into storage.objects (bucket_id, name) values ('xrays', 'x34.png')$$, 'row-level security', 'nor X-ray files');
select pg_temp.act_as(:acct);
select pg_temp.check((select count(*) from public.xrays where patient_id = :'p1') = 0, 'an accountant does not see X-rays');
reset role;
select pg_temp.act_as('');
rollback;
