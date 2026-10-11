-- The public forms on the homepage (20261011000200_public_forms.sql): "Join our team" and "Complaints & suggestions".
-- A visitor (role anon) may only upload a new CV under incoming/<uuid>.<ext> and call the two submit functions. This locks in:
-- every field is checked on the server, the honeypot drops a form without saying so, the rate limits hold and never tell
-- whether a phone or CNIC was used before, anon can read, change or delete nothing (tables and files), only jobs.view shows
-- applications (CNIC, phone, CV), the CV checks (wrong bucket, wrong path, reused file, wrong type or size, stale), the
-- staff status/notes history, cleanup of CVs never sent, and website feedback in the Complaints inbox.
-- Every name, phone, CNIC and file here is made up.
\set ON_ERROR_STOP 1
\set admin '''00000000-0000-0000-0000-000000002900'''
\set coord '''00000000-0000-0000-0000-000000002901'''
\set fd    '''00000000-0000-0000-0000-000000002902'''
\set pat   '''00000000-0000-0000-0000-000000002903'''

-- Supabase's storage tables have these; an older local stub may not (the migration does not depend on them).
select set_config('test.limits', (exists (select 1 from pg_attribute where attrelid = 'storage.buckets'::regclass and attname = 'allowed_mime_types' and not attisdropped))::text, false);
alter table storage.objects add column if not exists created_at timestamptz default now();
alter table storage.objects add column if not exists metadata jsonb;
create unique index if not exists bucketid_objname on storage.objects (bucket_id, name);

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
-- A CV path with a fixed made-up uuid: incoming/00000000-0000-4000-8000-0000000000NN.<ext>
create or replace function pg_temp.cv(n int, ext text default 'pdf') returns text language sql as $$
  select format('incoming/00000000-0000-4000-8000-%s.%s', lpad(n::text, 12, '0'), ext) $$;
-- An upload as the current role (Storage writes size and mimetype into metadata once the file has arrived).
create or replace function pg_temp.put_cv(n int, ext text default 'pdf', size bigint default 120000, mime text default 'application/pdf') returns void language sql as $$
  insert into storage.objects (bucket_id, name, metadata) values ('job-cvs', pg_temp.cv(n, ext), jsonb_build_object('size', size, 'mimetype', mime)) $$;
-- A complete, valid application (number n gives its own phone, CNIC and CV).
create or replace function pg_temp.job(n int, extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('full_name', 'Sample Applicant ' || n, 'phone', '0300 555' || lpad(n::text, 4, '0'), 'email', 'sample' || n || '@example.com',
    'position', 'dental_assistant', 'qualification', 'BDS', 'graduation_year', 2020, 'experience', 'Two years (sample)',
    'branch', (select id from public.branches where code = 'GUL'), 'cnic', '12345-' || lpad(n::text, 7, '0') || '-1',
    'cv_path', pg_temp.cv(n), 'message', 'A sample message.', 'consent', true, 'website', '') || extra $$;
create or replace function pg_temp.fb(extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('kind', 'suggestion', 'topic', 'cleanliness', 'branch', (select id from public.branches where code = 'NN'),
    'message', 'Please keep the waiting area cleaner (sample).', 'name', null, 'phone', null, 'mr', null, 'contact_me', false, 'website', '') || extra $$;
-- 'ok' or "<field> | <message>" (the field is the error's DETAIL), for the checks of one field at a time.
create or replace function pg_temp.try_job(p jsonb) returns text language plpgsql as $$
declare d text; m text;
begin
  perform public.submit_job_application(p);
  return 'ok';
exception when others then
  get stacked diagnostics d = pg_exception_detail, m = message_text;
  return coalesce(nullif(d, ''), '-') || ' | ' || m;
end $$;
create or replace function pg_temp.try_fb(p jsonb) returns text language plpgsql as $$
declare d text; m text;
begin
  perform public.submit_feedback(p);
  return 'ok';
exception when others then
  get stacked diagnostics d = pg_exception_detail, m = message_text;
  return coalesce(nullif(d, ''), '-') || ' | ' || m;
end $$;
-- Moves everything the forms made into the past (minutes), so the per-minute limits do not get in the way of the next checks.
create or replace function pg_temp.later(m int) returns void language sql as $$
  update storage.objects set created_at = created_at - make_interval(mins => m) where bucket_id = 'job-cvs';
  update public.job_applications set created_at = created_at - make_interval(mins => m);
  update public.complaints set created_at = created_at - make_interval(mins => m) where source = 'website' $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

begin;

select set_config('test.admin', :admin, false), set_config('test.coord', :coord, false), set_config('test.fd', :fd, false), set_config('test.pat', :pat, false);
insert into auth.users (id, email) values (:admin, 'admin29@dralirashid.com'), (:coord, 'coord29@dralirashid.com'), (:fd, 'fd29@dralirashid.com'), (:pat, 'patient29@example.com');
insert into public.staff (id, full_name, email, role, restrict_to_branches, branch_ids) values
  (:admin, 'Admin Twentynine', 'admin29@dralirashid.com', 'admin', false, '{}'),
  (:coord, 'Coordinator Twentynine', 'coord29@dralirashid.com', 'coordinator', false, '{}'),
  (:fd,    'Front Desk Twentynine', 'fd29@dralirashid.com', 'front_desk', false, '{}');
insert into public.patients (full_name, phone, portal_user_id) values ('Sample Patient Twentynine', '03005550299', :pat), ('Sample Other Patient', '03005550298', null);
insert into public.branches (code, name, city_id, active) values ('Z29', 'Closed sample branch', (select id from public.cities limit 1), false);
select set_config('test.other', (select id::text from public.patients where full_name = 'Sample Other Patient'), false);
select set_config('test.closed', (select id::text from public.branches where code = 'Z29'), false);
-- The coordinator column has the Complaints inbox (whatever the clinic has ticked since): pin it so the test does not depend on that.
update public.role_permissions set allowed = true where role = 'coordinator' and permission_key = 'complaints.view';
update public.role_permissions set allowed = false where role = 'front_desk' and permission_key = 'complaints.view';

-- 1. The permission and the bucket
do $$
begin
  perform pg_temp.check(exists (select 1 from public.permissions where key = 'jobs.view' and label like 'Job applications%'), 'jobs.view is a row of the access list');
  perform pg_temp.check((select bool_and(allowed = (role = 'admin')) from public.role_permissions where permission_key = 'jobs.view')
                        and (select count(*) from public.role_permissions where permission_key = 'jobs.view') = 6, 'jobs.view: admin only by default, one tick per role');
  perform pg_temp.check(exists (select 1 from storage.buckets where id = 'job-cvs' and not public), 'the bucket job-cvs exists and is private');
  if current_setting('test.limits')::boolean then
    perform pg_temp.check((select (to_jsonb(b) ->> 'file_size_limit')::bigint = 5242880
                                  and (to_jsonb(b) -> 'allowed_mime_types') @> '["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "image/jpeg", "image/png"]'::jsonb
                                  and jsonb_array_length(to_jsonb(b) -> 'allowed_mime_types') = 5
                             from storage.buckets b where id = 'job-cvs'), 'the bucket takes at most 5 MB and only PDF, Word, JPG and PNG');
  else
    raise notice 'skip - bucket limits: this stub has no file_size_limit / allowed_mime_types columns (Supabase has them)';
  end if;
end $$;

-- 2. A visitor sends a complete application
set role anon;
select pg_temp.act_as('');
do $$
declare r public.job_applications; answer jsonb;
begin
  perform pg_temp.put_cv(1);
  answer := public.submit_job_application(pg_temp.job(1, jsonb_build_object('phone', '+92 300 555 0001', 'cnic', '1234500000011',
    'full_name', '  Sample   Applicant One ', 'message', E'Line one\r\nLine two <script>alert(1)</script>\u0007 end ')));
  perform pg_temp.check(answer = '{"ok": true}'::jsonb, 'a valid application is answered {"ok": true} and nothing else (no id)');
end $$;
reset role;
do $$
declare r public.job_applications;
begin
  select * into r from public.job_applications where cv_path = pg_temp.cv(1);
  perform pg_temp.check(r.id is not null and r.status = 'new' and r.updated_by is null, 'the application is stored as New');
  perform pg_temp.check(r.phone = '03005550001' and r.cnic = '12345-0000001-1', 'phone and CNIC are stored in one form: 03005550001 and 12345-0000001-1');
  perform pg_temp.check(r.full_name = 'Sample Applicant One', 'the name is trimmed and its spaces collapsed');
  perform pg_temp.check(r.message = E'Line one\nLine two <script>alert(1)</script> end', 'the message is plain text: tags kept as typed, Windows line end and control character cleaned');
  perform pg_temp.check(r.cv_type = 'application/pdf' and r.cv_size = 120000 and r.branch_id = (select id from public.branches where code = 'GUL')
                        and r.position = 'dental_assistant' and r.graduation_year = 2020 and r.consent_at is not null, 'the CV type and size, branch, position, year and consent time are stored');
end $$;

-- 3. Every field is checked on the server
set role anon;
select pg_temp.act_as('');
do $$
declare a text;
begin
  perform pg_temp.put_cv(2);
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, '{"full_name": ""}')) like 'full_name | FORM_INVALID: Please enter your full name.%', 'no name is refused, on the name field');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, '{"full_name": "A"}')) like 'full_name | %', 'a one-letter name is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, '{"full_name": "12345"}')) like 'full_name | %', 'a name without letters is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, jsonb_build_object('full_name', repeat('a', 101)))) like 'full_name | %under 100%', 'a name over 100 characters is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, '{"phone": "12345"}')) like 'phone | FORM_INVALID: Please enter a Pakistani mobile number%', 'a short phone number is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, '{"phone": "021 34567890"}')) like 'phone | %', 'a landline number is refused (mobile numbers only)');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, '{"phone": null}')) like 'phone | %', 'no phone number is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, '{"email": "not an email"}')) like 'email | %', 'a wrong email address is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, '{"position": "surgeon"}')) like 'position | %', 'a job that is not on the list is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, '{"qualification": " "}')) like 'qualification | %', 'no qualification is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, jsonb_build_object('qualification', repeat('b', 101)))) like 'qualification | %', 'a qualification over 100 characters is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, '{"graduation_year": 1950}')) like 'graduation_year | %', 'a graduation year before 1960 is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, '{"graduation_year": "20x0"}')) like 'graduation_year | %', 'a graduation year that is not a year is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, jsonb_build_object('graduation_year', extract(year from now())::int + 7))) like 'graduation_year | %', 'a graduation year more than six years ahead is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, jsonb_build_object('experience', repeat('c', 301)))) like 'experience | %', 'experience over 300 characters is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, '{"branch": null}')) like 'branch | %', 'no branch is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, '{"branch": 999}')) like 'branch | %', 'a branch that does not exist is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, jsonb_build_object('branch', current_setting('test.closed')::int))) like 'branch | %', 'a switched-off branch is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, '{"cnic": "12345-123456-1"}')) like 'cnic | FORM_INVALID: A CNIC has 13 digits%', 'a CNIC of 12 digits is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, '{"cnic": "12345123456789"}')) like 'cnic | %', 'a CNIC of 14 digits is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, jsonb_build_object('message', repeat('d', 1001)))) like 'message | %', 'a message over 1,000 characters is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, '{"consent": false}')) like 'consent | %', 'without the consent tick the form is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, '{"consent": "yes"}')) like 'consent | %', 'the consent must be the tick itself (true), not some text');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2) - 'consent') like 'consent | %', 'a form without the consent field is refused');
  perform pg_temp.check(pg_temp.try_job('[1, 2]'::jsonb) like '- | FORM_INVALID: The form could not be read.%', 'something that is not a form is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(2, jsonb_build_object('experience', repeat('e', 21000)))) like '- | FORM_INVALID: The form could not be read.%', 'an oversized form is refused before anything else');
  perform pg_temp.check((select count(*) from storage.objects) = 0, 'anon sees no files at all, the two it uploaded included');
end $$;
reset role;
select pg_temp.check((select count(*) from public.job_applications) = 1, 'none of the refused forms was stored');

-- 4. The honeypot: a form with the hidden box filled is thanked and dropped, whatever else it holds
set role anon;
select pg_temp.act_as('');
select pg_temp.check(public.submit_job_application(pg_temp.job(2, '{"website": "http://spam.example"}')) = '{"ok": true}'::jsonb, 'honeypot: thanked like any other form');
select pg_temp.check(public.submit_job_application('{"website": "x", "full_name": ""}'::jsonb) = '{"ok": true}'::jsonb, 'honeypot: thanked even when every other field is wrong');
select pg_temp.check(public.submit_feedback('{"website": "x"}'::jsonb) = '{"ok": true}'::jsonb, 'honeypot: the feedback form is thanked the same way');
reset role;
select pg_temp.check((select count(*) from public.job_applications) = 1 and (select count(*) from public.complaints where source = 'website') = 0, 'honeypot: nothing was stored');

-- 5. The CV must be the visitor's own upload in job-cvs: right path, allowed type and size, recent, not used by another application
insert into storage.objects (bucket_id, name, metadata) values ('xrays', pg_temp.cv(3), '{"size": 1000, "mimetype": "application/pdf"}');
set role anon;
select pg_temp.act_as('');
do $$
begin
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(3)) like 'cv | FORM_CV: Your CV did not finish uploading.%', 'a CV path with no file in job-cvs is refused (the same name in another bucket does not count)');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(4, jsonb_build_object('cv_path', pg_temp.cv(1)))) like 'cv | FORM_CV: %', 'a CV already used by another application is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(4, '{"cv_path": "incoming/../../xrays/a.pdf"}')) like 'cv | FORM_CV: %', 'a path that climbs out of incoming/ is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(4, '{"cv_path": "other/00000000-0000-4000-8000-000000000004.pdf"}')) like 'cv | FORM_CV: %', 'a path outside incoming/ is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(4, '{"cv_path": "incoming/cv.pdf"}')) like 'cv | FORM_CV: %', 'a path that is not a random name is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(4, jsonb_build_object('cv_path', pg_temp.cv(4, 'exe')))) like 'cv | FORM_CV: %', 'a file ending that is not allowed is refused');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(4) - 'cv_path') like 'cv | FORM_CV: %', 'a form without a CV is refused');
  perform pg_temp.put_cv(4, 'pdf', 1000, 'text/html');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(4)) like 'cv | FORM_CV: Your CV must be a PDF%', 'a .pdf stored as text/html is refused');
  perform pg_temp.put_cv(5, 'png', 1000, 'application/pdf');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(5, jsonb_build_object('cv_path', pg_temp.cv(5, 'png')))) like 'cv | FORM_CV: Your CV must be a PDF%', 'a .png whose stored type is something else is refused');
end $$;
reset role;
select pg_temp.later(2);
set role anon;
select pg_temp.act_as('');
do $$
begin
  perform pg_temp.put_cv(6, 'pdf', 6000000, 'application/pdf');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(6)) like 'cv | FORM_CV: Your CV must be a file of at most 5 MB.%', 'a CV over 5 MB is refused');
  perform pg_temp.put_cv(7, 'pdf', 0, 'application/pdf');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(7)) like 'cv | FORM_CV: %', 'an empty file is refused');
  insert into storage.objects (bucket_id, name) values ('job-cvs', pg_temp.cv(8));
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(8)) like 'cv | FORM_CV: %', 'a file Storage has not finished (no size or type yet) is refused');
  perform pg_temp.put_cv(9, 'docx', 50000, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  perform pg_temp.put_cv(10, 'jpg', 50000, 'image/jpeg');
end $$;
reset role;
-- A file uploaded more than a day ago is not taken (and is cleanup material instead).
update storage.objects set created_at = now() - interval '25 hours' where bucket_id = 'job-cvs' and name = pg_temp.cv(9, 'docx');
set role anon;
select pg_temp.act_as('');
select pg_temp.check(pg_temp.try_job(pg_temp.job(9, jsonb_build_object('cv_path', pg_temp.cv(9, 'docx')))) like 'cv | FORM_CV: Please choose your CV again.%', 'a CV uploaded more than a day ago is refused');
select pg_temp.check(pg_temp.try_job(pg_temp.job(10, jsonb_build_object('cv_path', pg_temp.cv(10, 'jpg'), 'branch', 'any', 'email', null, 'graduation_year', null, 'experience', '', 'message', ''))) = 'ok',
  'a JPG CV with "Any branch" and every optional field empty is taken');
reset role;
select pg_temp.check((select branch_id is null and email is null and graduation_year is null and experience is null and message is null and cv_type = 'image/jpeg'
                        from public.job_applications where cv_path = pg_temp.cv(10, 'jpg')), '"Any branch" is stored as no branch, empty optional fields as nothing');

-- 6. Storage: anon may only add a new file, at a random name under incoming/, in job-cvs
select pg_temp.later(2);
set role anon;
select pg_temp.act_as('');
do $$
declare n int;
begin
  perform pg_temp.expect_error($q$insert into storage.objects (bucket_id, name) values ('xrays', 'incoming/00000000-0000-4000-8000-000000000011.pdf')$q$, 'row-level security', 'anon: no upload into another bucket');
  perform pg_temp.expect_error($q$insert into storage.objects (bucket_id, name) values ('job-cvs', 'cv.pdf')$q$, 'row-level security', 'anon: no upload outside incoming/');
  perform pg_temp.expect_error($q$insert into storage.objects (bucket_id, name) values ('job-cvs', 'incoming/sample.pdf')$q$, 'row-level security', 'anon: no upload under a chosen name');
  perform pg_temp.expect_error($q$insert into storage.objects (bucket_id, name) values ('job-cvs', 'incoming/00000000-0000-4000-8000-000000000011.html')$q$, 'row-level security', 'anon: no upload with another file ending');
  perform pg_temp.expect_error($q$insert into storage.objects (bucket_id, name) values ('job-cvs', 'incoming/x/00000000-0000-4000-8000-000000000011.pdf')$q$, 'row-level security', 'anon: no upload into a sub-folder');
  perform pg_temp.expect_error(format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'job-cvs', pg_temp.cv(1)), 'duplicate key', 'anon: a file that exists cannot be uploaded again (no overwrite)');
  perform pg_temp.check((select count(*) from storage.objects where bucket_id = 'job-cvs') = 0, 'anon: cannot list or read any CV');
  update storage.objects set metadata = '{"size": 1, "mimetype": "application/pdf"}' where bucket_id = 'job-cvs';
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0, 'anon: cannot change any file');
  delete from storage.objects where bucket_id = 'job-cvs';
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0, 'anon: cannot delete any file');
  perform pg_temp.expect_error('select count(*) from public.job_applications', 'permission denied', 'anon: cannot read job applications');
  perform pg_temp.expect_error('select count(*) from public.job_application_events', 'permission denied', 'anon: cannot read their history');
  perform pg_temp.expect_error('select count(*) from public.complaints', 'permission denied', 'anon: cannot read complaints');
  perform pg_temp.expect_error('select count(*) from public.complaint_messages', 'permission denied', 'anon: cannot read complaint replies');
  perform pg_temp.expect_error($q$insert into public.job_applications (full_name, phone, position, qualification, cnic, cv_path, cv_type, cv_size)
                                   values ('Sample', '03005550000', 'other', 'BDS', '12345-0000000-1', 'x', 'application/pdf', 1)$q$, 'permission denied', 'anon: cannot add an application around the function');
  perform pg_temp.expect_error($q$update public.job_applications set status = 'hired'$q$, 'permission denied', 'anon: cannot change an application');
  perform pg_temp.expect_error('delete from public.job_applications', 'permission denied', 'anon: cannot delete an application');
  perform pg_temp.expect_error($q$insert into public.complaints (subject, body, source, kind, topic) values ('x', 'y', 'website', 'complaint', 'other')$q$, 'permission denied', 'anon: cannot add a complaint around the function');
  perform pg_temp.expect_error($q$select public.update_job_application(gen_random_uuid(), 'hired')$q$, 'permission denied', 'anon: cannot call the staff status function');
  perform pg_temp.expect_error('select * from public.job_cv_orphans()', 'permission denied', 'anon: cannot list unsent CVs');
end $$;
reset role;

-- 7. Rate limits that hold, and never tell whether a phone or CNIC was used before
select pg_temp.later(2);
set role anon;
select pg_temp.act_as('');
do $$
declare before int;
begin
  -- Per phone: two a day; the third is thanked and not stored.
  perform pg_temp.put_cv(20); perform pg_temp.put_cv(21); perform pg_temp.put_cv(22);
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(20, '{"phone": "0300 5559999"}')) = 'ok', 'per phone: the first application of the day is taken');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(21, '{"phone": "+923005559999"}')) = 'ok', 'per phone: the second is taken (the phone written another way is the same phone)');
  perform pg_temp.check(public.submit_job_application(pg_temp.job(22, '{"phone": "03005559999"}')) = '{"ok": true}'::jsonb,
    'per phone: the third gets the very same answer as a stored one');
  -- The limit is looked at only after every other check: a phone over its limit with a CV that was never uploaded is still told about the CV,
  -- exactly like a phone never seen before, so no answer tells whether the phone was used.
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(26, jsonb_build_object('phone', '03005559999', 'cv_path', pg_temp.cv(999)))) like 'cv | FORM_CV: %',
    'per phone: over the limit, a form with a CV that was never uploaded still gets the CV answer (nothing about the phone)');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(26, jsonb_build_object('phone', '03005558888', 'cv_path', pg_temp.cv(999)))) like 'cv | FORM_CV: %',
    'per phone: the same answer for a phone never seen before');
end $$;
reset role;
select pg_temp.check((select count(*) from public.job_applications where phone = '03005559999') = 2, 'per phone: ... but only two are stored');
select pg_temp.later(2);
set role anon;
select pg_temp.act_as('');
do $$
begin
  perform pg_temp.put_cv(23); perform pg_temp.put_cv(24); perform pg_temp.put_cv(25);
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(23, '{"cnic": "54321-0000000-9"}')) = 'ok', 'per CNIC: the first application of the day is taken');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(24, '{"cnic": "5432100000009"}')) = 'ok', 'per CNIC: the second is taken (written without dashes it is the same CNIC)');
  perform pg_temp.check(public.submit_job_application(pg_temp.job(25, '{"cnic": "54321-0000000-9"}')) = '{"ok": true}'::jsonb, 'per CNIC: the third gets the same answer');
end $$;
reset role;
select pg_temp.check((select count(*) from public.job_applications where cnic = '54321-0000000-9') = 2, 'per CNIC: ... but only two are stored');

-- Whole website: 5 a minute. (Inside one transaction every row has the same time, so the rows made above are moved back first.)
select pg_temp.later(2);
set role anon;
select pg_temp.act_as('');
do $$
declare i int;
begin
  for i in 30..34 loop perform pg_temp.put_cv(i); end loop;
  perform pg_temp.expect_error(format('select pg_temp.put_cv(%s)', 35), 'row-level security', 'CV uploads: the sixth upload within a minute is refused by the storage policy');
  for i in 30..34 loop perform pg_temp.check(pg_temp.try_job(pg_temp.job(i)) = 'ok', 'whole website: application ' || (i - 29) || ' of 5 this minute is taken'); end loop;
end $$;
reset role;
insert into storage.objects (bucket_id, name, metadata) values ('job-cvs', pg_temp.cv(35), '{"size": 1000, "mimetype": "application/pdf"}');
set role anon;
select pg_temp.act_as('');
select pg_temp.check(pg_temp.try_job(pg_temp.job(35)) like '- | FORM_BUSY:%', 'whole website: the sixth application within a minute is told to try again later');
reset role;
-- 50 a day: fill the day up to 50 (made directly), a minute later the next is still refused; the next day it is taken.
select pg_temp.later(2);
insert into public.job_applications (full_name, phone, position, qualification, cnic, cv_path, cv_type, cv_size, created_at)
select 'Sample Filler ' || g, '0311' || lpad(g::text, 7, '0'), 'other', 'BDS', '99999-' || lpad(g::text, 7, '0') || '-1', 'filler/' || g, 'application/pdf', 1, now() - interval '3 hours'
  from generate_series(1, 50 - (select count(*)::int from public.job_applications where created_at > now() - interval '1 day')) g;
set role anon;
select pg_temp.act_as('');
select pg_temp.check(pg_temp.try_job(pg_temp.job(35)) like '- | FORM_BUSY:%', 'whole website: over 50 applications in a day the next one is told to try again later');
reset role;
select pg_temp.check((select count(*) from public.job_applications where cv_path = pg_temp.cv(35)) = 0, 'the refused application was not stored');
select pg_temp.later(24 * 60 + 5);
update storage.objects set created_at = now() - interval '10 minutes' where bucket_id = 'job-cvs' and name = pg_temp.cv(35);
set role anon;
select pg_temp.act_as('');
select pg_temp.check(pg_temp.try_job(pg_temp.job(35)) = 'ok', 'whole website: a day later applications are taken again');
reset role;
-- 60 CV uploads a day.
select pg_temp.later(2);
insert into storage.objects (bucket_id, name, metadata, created_at)
select 'job-cvs', pg_temp.cv(1000 + g), '{"size": 1000, "mimetype": "application/pdf"}', now() - interval '2 hours'
  from generate_series(1, 60 - (select count(*)::int from storage.objects where bucket_id = 'job-cvs' and created_at > now() - interval '1 day')) g;
set role anon;
select pg_temp.act_as('');
select pg_temp.expect_error('select pg_temp.put_cv(36)', 'row-level security', 'CV uploads: over 60 in a day the next upload is refused');
reset role;
delete from storage.objects where bucket_id = 'job-cvs' and name like 'incoming/00000000-0000-4000-8000-0000000010%';

-- 8. Staff: only jobs.view shows applications, their CNIC, phone and CV
select pg_temp.later(24 * 60 + 5);
set role authenticated;
do $$
declare n int; a uuid; r jsonb; e record;
begin
  -- The coordinator handles complaints but has no jobs.view.
  perform pg_temp.act_as(current_setting('test.coord'));
  perform pg_temp.check(public.has_perm('complaints.view') and not public.has_perm('jobs.view'), 'the coordinator: Complaints inbox yes, job applications no');
  perform pg_temp.check((select count(*) from public.job_applications) = 0 and (select count(*) from public.job_application_events) = 0, 'without jobs.view: no application and no history is visible');
  perform pg_temp.check((select count(*) from storage.objects where bucket_id = 'job-cvs') = 0, 'without jobs.view: no CV is visible (so no link can be signed)');
  perform pg_temp.expect_error(format('select public.update_job_application(%L, %L)', (select id from public.job_applications limit 1), 'hired'), 'NOT_ALLOWED', 'without jobs.view: the status cannot be changed');
  perform pg_temp.expect_error('select * from public.job_cv_orphans()', 'NOT_ALLOWED', 'without jobs.view: unsent CVs are not listed');
  delete from storage.objects where bucket_id = 'job-cvs';
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0, 'without jobs.view: no CV can be removed');
  perform pg_temp.expect_error($q$update public.job_applications set status = 'hired'$q$, 'permission denied', 'staff cannot change an application around the function');
  perform pg_temp.expect_error($q$insert into public.job_application_events (application_id, kind, body) values (gen_random_uuid(), 'note', 'x')$q$, 'permission denied', 'staff cannot write the history themselves');

  -- A personal tick gives it, and taking it away takes it away again.
  perform pg_temp.act_as(current_setting('test.admin'));
  insert into public.staff_permission_overrides (staff_id, permission_key, allowed) values (current_setting('test.coord')::uuid, 'jobs.view', true);
  perform pg_temp.act_as(current_setting('test.coord'));
  perform pg_temp.check((select count(*) from public.job_applications) > 0 and (select count(*) from storage.objects where bucket_id = 'job-cvs') > 0,
    'a personal jobs.view tick shows the applications and the CVs');
  perform pg_temp.act_as(current_setting('test.admin'));
  delete from public.staff_permission_overrides where staff_id = current_setting('test.coord')::uuid and permission_key = 'jobs.view';
  -- The role column can be ticked in the access list too.
  update public.role_permissions set allowed = true where role = 'coordinator' and permission_key = 'jobs.view';
  perform pg_temp.act_as(current_setting('test.coord'));
  perform pg_temp.check(public.has_perm('jobs.view') and (select count(*) from public.job_applications) > 0, 'jobs.view ticked for the coordinator column: the coordinator sees the applications');
  perform pg_temp.act_as(current_setting('test.admin'));
  update public.role_permissions set allowed = false where role = 'coordinator' and permission_key = 'jobs.view';
  perform pg_temp.act_as(current_setting('test.coord'));
  perform pg_temp.check((select count(*) from public.job_applications) = 0, 'and unticked again, nothing is visible');

  -- The admin sees everything and works on an application: status and notes, with who and when.
  perform pg_temp.act_as(current_setting('test.admin'));
  select id into a from public.job_applications where cv_path = pg_temp.cv(1);
  perform pg_temp.check((select phone = '03005550001' and cnic = '12345-0000001-1' from public.job_applications where id = a), 'the admin sees the phone and CNIC');
  r := public.update_job_application(a, 'interview', 'Called on Monday (sample note).');
  perform pg_temp.check(r ->> 'status' = 'interview' and (r ->> 'updated_by')::uuid = current_setting('test.admin')::uuid, 'the status changes to Interview, stamped with who changed it');
  perform pg_temp.check((select count(*) from public.job_application_events where application_id = a) = 2, 'a status change and a note are two lines of history');
  select * into e from public.job_application_events where application_id = a and kind = 'status';
  perform pg_temp.check(e.status = 'interview' and e.by_staff = current_setting('test.admin')::uuid and e.by_name = 'Admin Twentynine' and e.created_at is not null, 'the history line says the new status, who and when');
  select * into e from public.job_application_events where application_id = a and kind = 'note';
  perform pg_temp.check(e.body = 'Called on Monday (sample note).' and e.by_name = 'Admin Twentynine', 'the note is kept with its writer');
  r := public.update_job_application(a, 'interview', null);
  perform pg_temp.check((select count(*) from public.job_application_events where application_id = a) = 2, 'choosing the same status again adds no history line');
  perform public.update_job_application(a, null, '  Second note  ');
  perform pg_temp.check((select count(*) from public.job_application_events where application_id = a and kind = 'note') = 2
                        and exists (select 1 from public.job_application_events where application_id = a and body = 'Second note'), 'a note alone is added, trimmed');
  perform pg_temp.expect_error(format('select public.update_job_application(%L, %L)', a, 'promoted'), 'INVALID', 'an unknown status is refused');
  perform pg_temp.expect_error(format('select public.update_job_application(%L, null, %L)', a, repeat('n', 2001)), 'INVALID', 'a note over 2,000 characters is refused');
  perform pg_temp.expect_error(format('select public.update_job_application(%L, %L)', gen_random_uuid(), 'hired'), 'NOT_FOUND', 'an application that does not exist is reported');

  -- Cleanup of CVs never sent: listed after a day, removable; a CV in use or a fresh upload is not.
  perform pg_temp.check(exists (select 1 from public.job_cv_orphans() where path = pg_temp.cv(2)), 'a CV uploaded but never sent, older than a day, is listed for cleanup');
  perform pg_temp.check(not exists (select 1 from public.job_cv_orphans() where path = pg_temp.cv(1)), 'a CV that belongs to an application is not listed');
  perform pg_temp.check((select count(*) from storage.objects where bucket_id = 'job-cvs') > 0, 'the admin sees the CVs (a short-lived link can be signed)');
  delete from storage.objects where bucket_id = 'job-cvs' and name = pg_temp.cv(1);
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0, 'a CV that belongs to an application cannot be removed');
  delete from storage.objects where bucket_id = 'job-cvs' and name = pg_temp.cv(2);
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'a CV never sent can be removed');
end $$;
reset role;
insert into storage.objects (bucket_id, name, metadata) values ('job-cvs', pg_temp.cv(40), '{"size": 10, "mimetype": "application/pdf"}');
set role authenticated;
select pg_temp.act_as(current_setting('test.admin'));
select pg_temp.check(not exists (select 1 from public.job_cv_orphans() where path = pg_temp.cv(40)), 'an upload of the last day is not listed (its form may still be in progress)');
do $$
declare n int;
begin
  delete from storage.objects where bucket_id = 'job-cvs' and name = pg_temp.cv(40);
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0, 'and it cannot be removed yet');
end $$;
reset role;

-- 9. "Complaints & suggestions"
select pg_temp.later(24 * 60 + 5);
set role anon;
select pg_temp.act_as('');
do $$
begin
  perform pg_temp.check(public.submit_feedback(pg_temp.fb()) = '{"ok": true}'::jsonb, 'an anonymous suggestion is thanked {"ok": true}');
  perform pg_temp.check(pg_temp.try_fb(pg_temp.fb(jsonb_build_object('kind', 'complaint', 'topic', 'waiting_time', 'branch', 'none', 'name', '  Sample  Visitor ',
    'phone', '+92 301 5550123', 'mr', 'Mr# 50012', 'contact_me', true, 'message', E'Waited two hours <img src=x onerror=alert(1)>\r\nPlease fix.'))) = 'ok',
    'a complaint with contact details and "please contact me" is taken');
  perform pg_temp.check(pg_temp.try_fb(pg_temp.fb('{"kind": "praise"}')) like 'kind | FORM_INVALID: Please choose complaint, suggestion or appreciation.%', 'an unknown type is refused');
  perform pg_temp.check(pg_temp.try_fb(pg_temp.fb('{"kind": null}')) like 'kind | %', 'no type is refused');
  perform pg_temp.check(pg_temp.try_fb(pg_temp.fb('{"topic": "parking"}')) like 'topic | %', 'a topic that is not on the list is refused');
  perform pg_temp.check(pg_temp.try_fb(pg_temp.fb('{"branch": null}')) like 'branch | %', 'no branch choice is refused');
  perform pg_temp.check(pg_temp.try_fb(pg_temp.fb('{"branch": 999}')) like 'branch | %', 'a branch that does not exist is refused');
  perform pg_temp.check(pg_temp.try_fb(pg_temp.fb('{"message": "Too short"}')) like 'message | FORM_INVALID: Please write a little more%', 'a message under 10 characters is refused');
  perform pg_temp.check(pg_temp.try_fb(pg_temp.fb(jsonb_build_object('message', repeat('m', 2001)))) like 'message | %2,000%', 'a message over 2,000 characters is refused');
  perform pg_temp.check(pg_temp.try_fb(pg_temp.fb(jsonb_build_object('name', repeat('n', 101)))) like 'name | %', 'a name over 100 characters is refused');
  perform pg_temp.check(pg_temp.try_fb(pg_temp.fb('{"phone": "123"}')) like 'phone | %', 'a wrong phone number is refused');
  perform pg_temp.check(pg_temp.try_fb(pg_temp.fb('{"contact_me": true}')) like 'phone | FORM_INVALID: Please give your mobile number%', '"please contact me" without a phone number is refused');
  perform pg_temp.check(pg_temp.try_fb(pg_temp.fb('{"mr": "<b>1</b>"}')) like 'mr | %', 'an Mr# with other characters is refused');
  perform pg_temp.check(pg_temp.try_fb('"text"'::jsonb) like '- | FORM_INVALID: The form could not be read.%', 'something that is not a form is refused');
end $$;
reset role;
do $$
declare c public.complaints;
begin
  perform pg_temp.check((select count(*) from public.complaints where source = 'website') = 2, 'two website forms were stored, none of the refused ones');
  select * into c from public.complaints where source = 'website' and kind = 'suggestion';
  perform pg_temp.check(c.patient_id is null and c.subject = 'Suggestion: Clinic cleanliness' and c.topic = 'cleanliness' and c.status = 'new'
                        and c.branch_id = (select id from public.branches where code = 'NN') and c.contact_phone is null and not c.contact_me,
    'the anonymous suggestion: no patient, subject "Suggestion: Clinic cleanliness", the branch, no contact details, New');
  select * into c from public.complaints where source = 'website' and kind = 'complaint';
  perform pg_temp.check(c.subject = 'Complaint: Waiting time' and c.branch_id is null and c.contact_name = 'Sample Visitor' and c.contact_phone = '03015550123'
                        and c.contact_mr = '50012' and c.contact_me, 'the complaint: "Not about one branch", name trimmed, phone in one form, Mr# without "Mr#", contact me');
  perform pg_temp.check(c.body = E'Waited two hours <img src=x onerror=alert(1)>\nPlease fix.', 'the message is stored as plain text, exactly as typed (line end cleaned)');
end $$;
-- Per phone: five a day, then thanked and not stored; whole website: 10 a minute, 200 a day.
select pg_temp.later(2);
set role anon;
select pg_temp.act_as('');
do $$
declare i int;
begin
  for i in 1..4 loop perform pg_temp.check(pg_temp.try_fb(pg_temp.fb('{"phone": "0301 5550123"}')) = 'ok', 'per phone: feedback ' || (i + 1) || ' of 5 today is taken'); end loop;
  perform pg_temp.check(public.submit_feedback(pg_temp.fb('{"phone": "03015550123"}')) = '{"ok": true}'::jsonb, 'per phone: the sixth gets the same answer');
end $$;
reset role;
select pg_temp.check((select count(*) from public.complaints where contact_phone = '03015550123') = 5, 'per phone: ... but only five are stored');
select pg_temp.later(2);
set role anon;
select pg_temp.act_as('');
do $$
declare i int;
begin
  for i in 1..10 loop perform pg_temp.check(pg_temp.try_fb(pg_temp.fb()) = 'ok', 'whole website: feedback ' || i || ' of 10 this minute is taken'); end loop;
  perform pg_temp.check(pg_temp.try_fb(pg_temp.fb()) like '- | FORM_BUSY:%', 'whole website: the eleventh form within a minute is told to try again later');
end $$;
reset role;
select pg_temp.later(2);
insert into public.complaints (subject, body, source, kind, topic, created_at)
select 'Suggestion: Other', 'Sample filler', 'website', 'suggestion', 'other', now() - interval '3 hours'
  from generate_series(1, 200 - (select count(*)::int from public.complaints where source = 'website' and created_at > now() - interval '1 day')) g;
set role anon;
select pg_temp.act_as('');
select pg_temp.check(pg_temp.try_fb(pg_temp.fb()) like '- | FORM_BUSY:%', 'whole website: over 200 forms in a day the next one is told to try again later');
reset role;
delete from public.complaints where body = 'Sample filler';

-- 10. Website feedback in the Complaints inbox; a patient's own complaints are unchanged
set role authenticated;
do $$
declare n int; s jsonb;
begin
  perform pg_temp.act_as(current_setting('test.coord'));
  perform pg_temp.check((select count(*) from public.complaints where source = 'website' and contact_phone = '03015550123' and kind = 'complaint') >= 1,
    'the coordinator (Complaints inbox) sees website forms with their contact details');
  update public.complaints set status = 'in_progress' where source = 'website' and kind = 'complaint' and contact_mr = '50012';
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'the coordinator handles a website form like any complaint');
  insert into public.complaint_messages (complaint_id, author_staff, body, internal_note)
  select id, current_setting('test.coord')::uuid, 'Called back (sample).', true from public.complaints where contact_mr = '50012';
  perform pg_temp.check(found, 'and adds an internal note to it');
  perform pg_temp.act_as(current_setting('test.fd'));
  perform pg_temp.check((select count(*) from public.complaints where source = 'website') = 0, 'front desk without the Complaints inbox sees no website form');
  -- A patient sees only their own complaints, files them as before, and cannot pose as the website form.
  perform pg_temp.act_as(current_setting('test.pat'));
  perform pg_temp.check((select count(*) from public.complaints) = 0, 'a patient sees no website forms');
  insert into public.complaints (patient_id, subject, body) values (public.current_patient_id(), 'Wire poking (sample)', 'Since my last visit.');
  perform pg_temp.check((select count(*) from public.complaints) = 1 and (select source from public.complaints) = 'portal', 'a patient still files a complaint from the portal (source portal)');
  perform pg_temp.expect_error($q$insert into public.complaints (patient_id, subject, body, source, kind, topic) values (public.current_patient_id(), 'x', 'y', 'website', 'complaint', 'other')$q$,
    'row-level security', 'a patient cannot file a complaint as the website form');
  perform pg_temp.expect_error(format($q$insert into public.complaints (patient_id, subject, body) values (%L, 'x', 'y')$q$, current_setting('test.other')), 'row-level security', 'a patient cannot file a complaint for another patient');
  -- The doctor dashboard: a website form linked to a doctor counts, without the visitor's name.
  perform pg_temp.act_as(current_setting('test.admin'));
  update public.complaints set clinician_id = (select id from public.clinicians where display_name = 'Dr. Ali Rashid') where contact_mr = '50012';
  s := public.doctor_summary((select id from public.clinicians where display_name = 'Dr. Ali Rashid'), (now() - interval '3 days')::date, (now() + interval '1 day')::date);
  perform pg_temp.check(exists (select 1 from jsonb_array_elements(s -> 'complaints') x where x ->> 'source' = 'website' and x ->> 'patient_name' is null and x ->> 'subject' = 'Complaint: Waiting time'),
    'the doctor dashboard lists a linked website form, marked website, with no visitor name');
end $$;
reset role;
select pg_temp.expect_error($q$insert into public.complaints (subject, body, source) values ('x', 'y', 'portal')$q$, 'complaints_who_check', 'a portal complaint must belong to a patient');
select pg_temp.expect_error($q$insert into public.complaints (subject, body, source, kind) values ('x', 'y', 'website', 'complaint')$q$, 'complaints_who_check', 'a website form must have its topic');
select pg_temp.expect_error($q$insert into public.complaints (subject, body, source, kind, topic, contact_me) values ('x', 'y', 'website', 'complaint', 'other', true)$q$, 'complaints_contact_check', '"please contact me" needs a phone number');
rollback;
