-- The public forms on the homepage (20261011000200_public_forms.sql): "Join our team" and "Complaints & suggestions".
-- A visitor (role anon) may only upload a new CV under incoming/<uuid>.<ext> and call the two submit functions. This locks in:
-- every field is checked on the server, the honeypot drops a form without saying so, the rate limits hold and never tell
-- whether a phone or CNIC was used before (a dropped form uses up its CV and counts toward the whole-website limits, like a
-- stored one: its CV is no unused CV for the upload limits and its name is never uploaded to again, also once its file is
-- removed; a full day has its own answer), anon can read, change or delete nothing (tables and files), only jobs.view shows
-- applications (CNIC, phone, CV), the CV checks (wrong bucket, wrong path, reused file, wrong type or size, stale), the CV
-- upload limits (files a minute and a day, bytes a day, unused CVs) held by the trigger for Storage's own superuser write too,
-- no overwrite of a CV, the staff status/notes history, cleanup of CVs never sent, and website feedback in the Complaints inbox
-- (which only an admin may delete; a patient's complaint never; only a complaint linked to a doctor counts on their dashboard).
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
    'cv_path', pg_temp.cv(n), 'message', 'A sample message.', 'consent', true, 'pf_trap', '') || extra $$;
create or replace function pg_temp.fb(extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('kind', 'suggestion', 'topic', 'cleanliness', 'branch', (select id from public.branches where code = 'NN'),
    'message', 'Please keep the waiting area cleaner (sample).', 'name', null, 'phone', null, 'mr', null, 'contact_me', false, 'pf_trap', '') || extra $$;
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
  update public.complaints set created_at = created_at - make_interval(mins => m) where source = 'website';
  update private.public_form_log set created_at = created_at - make_interval(mins => m) $$;
-- The bytes of the CVs in job-cvs: uploaded within the last day (p_day), or never sent with a form (stored or dropped: the
-- application or the log has it); the CV limits count both.
create or replace function pg_temp.cv_bytes(p_day boolean) returns bigint language sql as $$
  select coalesce(sum((o.metadata ->> 'size')::bigint), 0)::bigint from storage.objects o
   where o.bucket_id = 'job-cvs' and (o.metadata ->> 'size') ~ '^[0-9]{1,12}$'
     and case when p_day then o.created_at > now() - interval '1 day'
              else not exists (select 1 from public.job_applications a where a.cv_path = o.name)
                   and not exists (select 1 from private.public_form_log l where l.cv_path = o.name) end $$;
-- private.job_cv_files, which the CV upload limits count, has exactly the files of job-cvs, with their size and upload time.
create or replace function pg_temp.cv_lines_match() returns boolean language sql as $$
  select not exists (
    select 1
      from (select o.name, case when (o.metadata ->> 'size') ~ '^[0-9]{1,12}$' then (o.metadata ->> 'size')::bigint else 0 end as size, o.created_at
              from storage.objects o where o.bucket_id = 'job-cvs') o
      full join private.job_cv_files f on f.name = o.name
     where o.name is null or f.name is null or f.size <> o.size or f.created_at <> o.created_at) $$;
-- The CV upload limits as they were first written: counted over every file of the bucket. private.job_cv_upload_problem must
-- give the very same answer while it counts only the last day's lines and the unsent ones of private.job_cv_files.
create or replace function pg_temp.bucket_problem(p_size bigint default 0) returns text language sql as $$
  select case
           when count(*) filter (where x.at > now() - interval '1 day') >= 100
             or coalesce(sum(x.size) filter (where x.at > now() - interval '1 day'), 0) + greatest(coalesce(p_size, 0), 1) > 200 * 1048576
             or coalesce(sum(x.size) filter (where not x.sent), 0) + greatest(coalesce(p_size, 0), 1) > 100 * 1048576 then 'day'
           when count(*) filter (where x.at > now() - interval '1 minute') >= 5 then 'minute'
         end
    from (select o.created_at as at,
                 case when (o.metadata ->> 'size') ~ '^[0-9]{1,12}$' then (o.metadata ->> 'size')::bigint else 0 end as size,
                 exists (select 1 from public.job_applications a where a.cv_path = o.name)
                   or exists (select 1 from private.public_form_log l where l.cv_path = o.name) as sent
            from storage.objects o where o.bucket_id = 'job-cvs') x $$;
-- Both of the above, for one moment of the test (run as the database owner: the visitor can see neither).
create or replace function pg_temp.cv_limits_hold(msg text) returns void language plpgsql as $$
begin
  perform pg_temp.check(pg_temp.cv_lines_match(), 'job_cv_files: ' || msg || ': one line per file of job-cvs, with its size and upload time');
  perform pg_temp.check(private.job_cv_upload_problem(0) is not distinct from pg_temp.bucket_problem(0)
                        and private.job_cv_upload_problem(1000) is not distinct from pg_temp.bucket_problem(1000)
                        and private.job_cv_upload_problem(5242880) is not distinct from pg_temp.bucket_problem(5242880),
    'job_cv_files: ' || msg || ': the upload limits answer as a count over the whole bucket would (' || coalesce(pg_temp.bucket_problem(0), 'null') || ')');
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

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
  perform pg_temp.check((select sent from private.job_cv_files where name = pg_temp.cv(1)), 'job_cv_files: the CV of the stored form is marked sent');
  perform pg_temp.cv_limits_hold('after an upload and a stored form');
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
select pg_temp.check(public.submit_job_application(pg_temp.job(2, '{"pf_trap": "http://spam.example"}')) = '{"ok": true}'::jsonb, 'honeypot: thanked like any other form');
select pg_temp.check(public.submit_job_application('{"pf_trap": "x", "full_name": ""}'::jsonb) = '{"ok": true}'::jsonb, 'honeypot: thanked even when every other field is wrong');
select pg_temp.check(public.submit_feedback('{"pf_trap": "x"}'::jsonb) = '{"ok": true}'::jsonb, 'honeypot: the feedback form is thanked the same way');
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
select pg_temp.cv_limits_hold('a file whose upload time changed');
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
  perform pg_temp.expect_error(format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'job-cvs', pg_temp.cv(2)), 'duplicate key', 'anon: a file that exists cannot be uploaded again (no overwrite)');
  perform pg_temp.expect_error(format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'job-cvs', pg_temp.cv(1)), 'JOB_CV_USED', 'anon: nor the name of a CV sent with a form');
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
  perform pg_temp.expect_error('select count(*) from private.public_form_log', 'permission denied', 'anon: cannot read the log the rate limits count');
  perform pg_temp.expect_error($q$insert into private.public_form_log (form, cv_path) values ('job', 'incoming/x.pdf')$q$, 'permission denied', 'anon: cannot write to it either');
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
  -- A dropped form leaves the traces of a stored one: its CV is used up. Sending that CV again gets the same answer as sending
  -- the CV of a stored form, so re-using a CV cannot tell whether the phone was over its limit.
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(27, jsonb_build_object('cv_path', pg_temp.cv(22)))) like 'cv | FORM_CV: Please choose your CV again.%',
    'per phone: the CV of the dropped third form cannot be sent again with another phone and CNIC');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(27, jsonb_build_object('cv_path', pg_temp.cv(21)))) like 'cv | FORM_CV: Please choose your CV again.%',
    'per phone: ... the very same answer as for the CV of a stored form');
end $$;
reset role;
select pg_temp.check((select count(*) from public.job_applications where phone = '03005559999') = 2, 'per phone: ... but only two are stored');
select pg_temp.check((select count(*) from private.public_form_log where form = 'job' and cv_path in (pg_temp.cv(20), pg_temp.cv(21), pg_temp.cv(22))) = 3,
  'per phone: all three are in the log the limits count, the dropped one with its CV');
select pg_temp.later(2);
set role anon;
select pg_temp.act_as('');
do $$
begin
  perform pg_temp.put_cv(23); perform pg_temp.put_cv(24); perform pg_temp.put_cv(25);
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(23, '{"cnic": "54321-0000000-9"}')) = 'ok', 'per CNIC: the first application of the day is taken');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(24, '{"cnic": "5432100000009"}')) = 'ok', 'per CNIC: the second is taken (written without dashes it is the same CNIC)');
  perform pg_temp.check(public.submit_job_application(pg_temp.job(25, '{"cnic": "54321-0000000-9"}')) = '{"ok": true}'::jsonb, 'per CNIC: the third gets the same answer');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(28, jsonb_build_object('cv_path', pg_temp.cv(25)))) like 'cv | FORM_CV: Please choose your CV again.%',
    'per CNIC: the CV of the dropped third form cannot be sent again, as for a stored one');
end $$;
reset role;
select pg_temp.check((select count(*) from public.job_applications where cnic = '54321-0000000-9') = 2, 'per CNIC: ... but only two are stored');
-- A dropped form leaves the upload limits as a stored one does: its CV is used, not one of the "unused CVs" (100 MB at most).
-- Otherwise, with the unused CVs right at their limit, job_cv_upload_busy() would answer differently after a form whose phone is
-- over its limit than after a stored form, and so tell a visitor whether that phone was used before. The made-up files that
-- fill the limit stand for earlier uploads, so they are put in with the trigger switched off.
select pg_temp.later(2);
set role anon;
select pg_temp.act_as('');
select pg_temp.put_cv(50, 'pdf', 1000);
select pg_temp.put_cv(51, 'pdf', 1000);
reset role;
alter table storage.objects disable trigger job_cvs_guard;
insert into storage.objects (bucket_id, name, metadata, created_at)
values ('job-cvs', pg_temp.cv(100103), jsonb_build_object('size', 100 * 1048576 - pg_temp.cv_bytes(false), 'mimetype', 'application/pdf'), now() - interval '30 hours');
alter table storage.objects enable trigger job_cvs_guard;
select pg_temp.cv_limits_hold('a file put in with job_cvs_guard switched off');
set role anon;
select pg_temp.act_as('');
do $$
begin
  perform pg_temp.check(public.job_cv_upload_busy() = 'day', 'stored or dropped: with exactly 100 MB of unused CVs, uploads wait for tomorrow');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(50)) = 'ok', 'stored or dropped: a form with a phone and CNIC never seen before is taken');
  perform pg_temp.check(public.job_cv_upload_busy() is null, 'stored or dropped: ... its CV is used now, so uploads are taken again');
end $$;
reset role;
alter table storage.objects disable trigger job_cvs_guard;
insert into storage.objects (bucket_id, name, metadata, created_at) values ('job-cvs', pg_temp.cv(100104), '{"size": 1000, "mimetype": "application/pdf"}', now() - interval '30 hours');
alter table storage.objects enable trigger job_cvs_guard;
set role anon;
select pg_temp.act_as('');
do $$
begin
  perform pg_temp.check(public.job_cv_upload_busy() = 'day', 'stored or dropped: exactly 100 MB of unused CVs again');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(51, '{"phone": "03005559999"}')) = 'ok', 'stored or dropped: a form whose phone already has two applications today is thanked');
  perform pg_temp.check(public.job_cv_upload_busy() is null, 'stored or dropped: ... and its CV is used just the same: uploads are taken again, the very answer as after the stored form');
end $$;
reset role;
select pg_temp.check((select count(*) from public.job_applications where cv_path = pg_temp.cv(50)) = 1 and (select count(*) from public.job_applications where cv_path = pg_temp.cv(51)) = 0,
  'stored or dropped: (the first form was stored, the second dropped)');
select pg_temp.check((select bool_and(sent) and count(*) = 2 from private.job_cv_files where name in (pg_temp.cv(50), pg_temp.cv(51))),
  'job_cv_files: the CVs of the stored and the dropped form are both marked sent');
select pg_temp.cv_limits_hold('after a stored and a dropped form');
delete from storage.objects where bucket_id = 'job-cvs' and name in (pg_temp.cv(100103), pg_temp.cv(100104));
select pg_temp.cv_limits_hold('after files were removed');

-- Whole website: 5 a minute, counted from the log, so a form dropped over its phone limit counts like a stored one.
-- (Inside one transaction every row has the same time, so the rows made above are moved back first.)
select pg_temp.later(2);
set role anon;
select pg_temp.act_as('');
do $$
declare i int;
begin
  perform pg_temp.check(public.job_cv_upload_busy() is null, 'CV uploads: the website may ask whether uploads are refused now (no: null)');
  for i in 30..34 loop perform pg_temp.put_cv(i); end loop;
  perform pg_temp.check(public.job_cv_upload_busy() = 'minute', 'CV uploads: after five this minute it answers "minute" (how busy the website is, nothing about a file)');
  perform pg_temp.check(not public.job_cv_upload_allowed(), 'CV uploads: the storage policy''s first check says no as well');
  perform pg_temp.expect_error(format('select pg_temp.put_cv(%s)', 35), 'JOB_CV_LIMIT: no more CV uploads are taken this minute', 'CV uploads: the sixth upload within a minute is refused');
  for i in 30..32 loop perform pg_temp.check(pg_temp.try_job(pg_temp.job(i)) = 'ok', 'whole website: application ' || (i - 29) || ' of 5 this minute is taken'); end loop;
  -- 03005559999 already has two applications today: these two are thanked and dropped, and count all the same.
  for i in 33..34 loop
    perform pg_temp.check(pg_temp.try_job(pg_temp.job(i, '{"phone": "03005559999"}')) = 'ok', 'whole website: application ' || (i - 29) || ' of 5 this minute is thanked (dropped: its phone is over the limit)');
  end loop;
end $$;
reset role;
select pg_temp.check((select count(*) from public.job_applications where cv_path in (pg_temp.cv(33), pg_temp.cv(34))) = 0, 'the two over the phone limit were not stored');
-- A signed upload: Storage checks the policy as the visitor in a probe it rolls back, then writes the row as a superuser, which no
-- policy sees. The trigger on storage.objects holds the limit for that write too (here as service_role, which skips every policy).
set role service_role;
select pg_temp.expect_error(format($q$insert into storage.objects (bucket_id, name, metadata) values ('job-cvs', %L, '{"size": 1000, "mimetype": "application/pdf"}')$q$, pg_temp.cv(35)),
  'JOB_CV_LIMIT', 'CV uploads: Storage''s own write of a signed upload (no policy) is refused all the same within the minute');
reset role;
set role anon;
select pg_temp.act_as('');
select pg_temp.check(pg_temp.try_job(pg_temp.job(35)) like '- | FORM_BUSY:%', 'whole website: the sixth application within a minute is told to try again later (the two dropped ones counted)');
reset role;
-- 200 a day (a hiring post can bring many): fill the day's log up to 199 (made directly), one more form dropped over its phone
-- limit makes 200, and the next is told to try again tomorrow (FORM_BUSY_DAY, its own words); the next day it is taken.
select pg_temp.later(2);
insert into private.public_form_log (form, created_at)
select 'job', now() - interval '3 hours'
  from generate_series(1, 199 - (select count(*)::int from private.public_form_log where form = 'job' and created_at > now() - interval '1 day')) g;
insert into storage.objects (bucket_id, name, metadata) values ('job-cvs', pg_temp.cv(35), '{"size": 1000, "mimetype": "application/pdf"}'),
                                                       ('job-cvs', pg_temp.cv(37), '{"size": 1000, "mimetype": "application/pdf"}');
set role anon;
select pg_temp.act_as('');
select pg_temp.check(pg_temp.try_job(pg_temp.job(37, '{"phone": "03005559999"}')) = 'ok', 'whole website: the 200th application of the day is thanked (dropped: its phone is over the limit)');
select pg_temp.check(pg_temp.try_job(pg_temp.job(35)) like '- | FORM_BUSY_DAY:%try again tomorrow%', 'whole website: after 200 applications in a day the next one is told to try again tomorrow (the dropped one counted)');
reset role;
select pg_temp.check((select count(*) from public.job_applications where cv_path in (pg_temp.cv(35), pg_temp.cv(37))) = 0, 'neither was stored');
select pg_temp.later(24 * 60 + 5);
update storage.objects set created_at = now() - interval '10 minutes' where bucket_id = 'job-cvs' and name = pg_temp.cv(35);
insert into private.public_form_log (form, cv_path, created_at) values ('job', 'incoming/old-sample.pdf', now() - interval '3 days');
select pg_temp.cv_limits_hold('a day later');
set role anon;
select pg_temp.act_as('');
select pg_temp.check(pg_temp.try_job(pg_temp.job(35)) = 'ok', 'whole website: a day later applications are taken again');
reset role;
select pg_temp.check(exists (select 1 from private.public_form_log where form = 'job' and cv_path = 'incoming/old-sample.pdf'),
  'a job line of the log stays, however old: its CV name stays used for good (a feedback line goes, see below)');
-- The day's CV limits: 100 files, 200 MB, and at most 100 MB of CVs no application uses. The made-up files that fill a limit stand for
-- earlier uploads, so they are put in with the trigger switched off (only this test does that).
-- 100 files a day.
select pg_temp.later(2);
alter table storage.objects disable trigger job_cvs_guard;
insert into storage.objects (bucket_id, name, metadata, created_at)
select 'job-cvs', pg_temp.cv(100000 + g), '{"size": 1000, "mimetype": "application/pdf"}', now() - interval '2 hours'
  from generate_series(1, 100 - (select count(*)::int from storage.objects where bucket_id = 'job-cvs' and created_at > now() - interval '1 day')) g;
alter table storage.objects enable trigger job_cvs_guard;
select pg_temp.cv_limits_hold('100 files today');
set role anon;
select pg_temp.act_as('');
select pg_temp.check(public.job_cv_upload_busy() = 'day', 'CV uploads: with 100 files today it answers "day", so the website says to try again tomorrow');
select pg_temp.expect_error('select pg_temp.put_cv(36)', 'JOB_CV_LIMIT: no more CV uploads are taken today', 'CV uploads: after 100 files in a day the next upload is refused');
reset role;
set role service_role;
select pg_temp.expect_error(format($q$insert into storage.objects (bucket_id, name, metadata) values ('job-cvs', %L, '{"size": 1000, "mimetype": "application/pdf"}')$q$, pg_temp.cv(36)),
  'JOB_CV_LIMIT', 'CV uploads: ... Storage''s own write of a signed upload too');
insert into storage.objects (bucket_id, name, metadata) values ('xrays', 'sample/xray-29.png', '{"size": 4000000, "mimetype": "image/png"}');
select pg_temp.check(exists (select 1 from storage.objects where bucket_id = 'xrays' and name = 'sample/xray-29.png'),
  'CV uploads: a full day of CVs does not touch the clinic''s own uploads (another bucket)');
reset role;
delete from storage.objects where bucket_id = 'job-cvs' and name between pg_temp.cv(100001) and pg_temp.cv(100100);
-- 200 MB a day: one made-up file, used by an application (so it is not an unused CV), stands for the day's CVs.
alter table storage.objects disable trigger job_cvs_guard;
insert into storage.objects (bucket_id, name, metadata, created_at)
values ('job-cvs', pg_temp.cv(100101), jsonb_build_object('size', 200 * 1048576 - pg_temp.cv_bytes(true) - 120000, 'mimetype', 'application/pdf'), now() - interval '2 hours');
alter table storage.objects enable trigger job_cvs_guard;
insert into public.job_applications (full_name, phone, position, qualification, cnic, cv_path, cv_type, cv_size)
values ('Sample Filler', '03005550777', 'other', 'BDS', '12345-0000777-1', pg_temp.cv(100101), 'application/pdf', 1);
-- (Put in by hand, so its line of job_cv_files is not marked sent: the limits still see the CV as used.)
select pg_temp.cv_limits_hold('200 MB today, one CV used by an application put in by hand');
set role anon;
select pg_temp.act_as('');
select pg_temp.check(public.job_cv_upload_busy() is null, 'CV uploads: 120 KB under 200 MB today, uploads are still taken');
select pg_temp.put_cv(36);
select pg_temp.check(public.job_cv_upload_busy() = 'day', 'CV uploads: with 200 MB today it answers "day"');
select pg_temp.expect_error($q$select pg_temp.put_cv(38, 'pdf', 1)$q$, 'JOB_CV_LIMIT: no more CV uploads are taken today', 'CV uploads: after 200 MB in a day not one more byte is taken');
reset role;
delete from public.job_applications where cv_path = pg_temp.cv(100101);
delete from storage.objects where bucket_id = 'job-cvs' and name in (pg_temp.cv(100101), pg_temp.cv(36));
-- 100 MB of CVs no application uses, whenever they were uploaded (the staff pages remove those older than a day).
alter table storage.objects disable trigger job_cvs_guard;
insert into storage.objects (bucket_id, name, metadata, created_at)
values ('job-cvs', pg_temp.cv(100102), jsonb_build_object('size', 100 * 1048576 - pg_temp.cv_bytes(false) - 120000, 'mimetype', 'application/pdf'), now() - interval '30 hours');
alter table storage.objects enable trigger job_cvs_guard;
select pg_temp.cv_limits_hold('120 KB under 100 MB of unused CVs');
set role anon;
select pg_temp.act_as('');
select pg_temp.check(public.job_cv_upload_busy() is null, 'CV uploads: 120 KB under 100 MB of unused CVs, uploads are still taken');
select pg_temp.put_cv(36);
select pg_temp.check(public.job_cv_upload_busy() = 'day', 'CV uploads: with 100 MB of CVs no application uses it answers "day"');
select pg_temp.expect_error($q$select pg_temp.put_cv(38, 'pdf', 1)$q$, 'JOB_CV_LIMIT', 'CV uploads: abandoned uploads cannot fill the storage: after 100 MB of unused CVs nothing more is taken');
reset role;
delete from storage.objects where bucket_id = 'job-cvs' and name in (pg_temp.cv(100102), pg_temp.cv(36));
-- A CV file, once there, is never changed: not by an update, an upsert (x-upsert) or a move, also not by Storage's own superuser write.
set role service_role;
do $$
declare n int;
begin
  perform pg_temp.check(public.job_cv_upload_busy() is null, 'no limit is reached for the checks below');
  perform pg_temp.expect_error(format($q$update storage.objects set metadata = '{"size": 99, "mimetype": "image/png"}' where bucket_id = 'job-cvs' and name = %L$q$, pg_temp.cv(1)),
    'JOB_CV_LOCKED', 'no overwrite: the stored size and type of a CV cannot be changed');
  perform pg_temp.expect_error(format($q$insert into storage.objects (bucket_id, name, metadata) values ('job-cvs', %L, '{"size": 99, "mimetype": "image/png"}')
                                         on conflict (bucket_id, name) do update set metadata = excluded.metadata$q$, pg_temp.cv(2)),
    'JOB_CV_LOCKED', 'no overwrite: an upsert (a signed upload with x-upsert: true) over a CV is refused');
  perform pg_temp.expect_error(format($q$insert into storage.objects (bucket_id, name, metadata) values ('job-cvs', %L, '{"size": 99, "mimetype": "image/png"}')
                                         on conflict (bucket_id, name) do update set metadata = excluded.metadata$q$, pg_temp.cv(1)),
    'JOB_CV_USED', 'no overwrite: ... and over a CV sent with a form, before anything else');
  perform pg_temp.expect_error(format($q$update storage.objects set name = %L where bucket_id = 'job-cvs' and name = %L$q$, pg_temp.cv(43), pg_temp.cv(1)),
    'JOB_CV_LOCKED', 'no overwrite: a CV cannot be moved to another name');
  perform pg_temp.expect_error(format($q$update storage.objects set bucket_id = 'xrays' where bucket_id = 'job-cvs' and name = %L$q$, pg_temp.cv(1)),
    'JOB_CV_LOCKED', 'no overwrite: ... or into another bucket');
  update storage.objects set owner = null where bucket_id = 'job-cvs' and name = pg_temp.cv(1);
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'Storage may still stamp what is not the file itself (here the owner)');
  update storage.objects set metadata = '{"size": 4000001, "mimetype": "image/png"}' where bucket_id = 'xrays' and name = 'sample/xray-29.png';
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'files of other buckets are not held by this rule');
end $$;
reset role;
select pg_temp.check((select metadata = '{"size": 120000, "mimetype": "application/pdf"}'::jsonb from storage.objects where bucket_id = 'job-cvs' and name = pg_temp.cv(1)),
  'the CV is unchanged after all of that');

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
  perform pg_temp.expect_error('select count(*) from private.public_form_log', 'permission denied', 'staff cannot read the log the rate limits count');

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
  perform pg_temp.check(exists (select 1 from public.job_cv_orphans() where path = pg_temp.cv(22)), 'the CV of a form dropped over its phone limit is listed too (no application uses it)');
  perform pg_temp.check((select count(*) from storage.objects where bucket_id = 'job-cvs') > 0, 'the admin sees the CVs (a short-lived link can be signed)');
  delete from storage.objects where bucket_id = 'job-cvs' and name = pg_temp.cv(1);
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0, 'a CV that belongs to an application cannot be removed');
  delete from storage.objects where bucket_id = 'job-cvs' and name = pg_temp.cv(2);
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'a CV never sent can be removed');
  delete from storage.objects where bucket_id = 'job-cvs' and name = pg_temp.cv(22);
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'and so can the CV of a dropped form');
end $$;
reset role;
select pg_temp.cv_limits_hold('after the staff pages removed CVs');
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
-- A day later the staff pages have removed the dropped form's CV (22) and kept the stored form's (21): one answer for both all the
-- same, so neither an upload to the name nor sending the form again tells whether the phone was over its limit.
set role anon;
select pg_temp.act_as('');
do $$
begin
  perform pg_temp.expect_error(format($q$insert into storage.objects (bucket_id, name, metadata) values ('job-cvs', %L, '{"size": 1000, "mimetype": "application/pdf"}')$q$, pg_temp.cv(22)),
    'JOB_CV_USED: this file was already sent with a form.', 'stored or dropped: an upload to the name of the dropped form''s removed CV is refused ...');
  perform pg_temp.expect_error(format($q$insert into storage.objects (bucket_id, name, metadata) values ('job-cvs', %L, '{"size": 1000, "mimetype": "application/pdf"}')$q$, pg_temp.cv(21)),
    'JOB_CV_USED: this file was already sent with a form.', 'stored or dropped: ... with the very answer for the name of a stored form''s CV');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(29, jsonb_build_object('cv_path', pg_temp.cv(22)))) = 'cv | FORM_CV: Please choose your CV again.',
    'stored or dropped: sending the dropped form''s removed CV again ...');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(29, jsonb_build_object('cv_path', pg_temp.cv(21)))) = 'cv | FORM_CV: Please choose your CV again.',
    'stored or dropped: ... gets the very answer as a stored form''s CV');
end $$;
reset role;
select pg_temp.check(not exists (select 1 from storage.objects where bucket_id = 'job-cvs' and name = pg_temp.cv(22))
                     and exists (select 1 from storage.objects where bucket_id = 'job-cvs' and name = pg_temp.cv(21)),
  'stored or dropped: (the dropped form''s CV file was gone and stays gone; the stored form''s is there)');

-- 9. "Complaints & suggestions"
select pg_temp.later(24 * 60 + 5);
insert into private.public_form_log (form, created_at) values ('feedback', now() - interval '3 days');
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
select pg_temp.check(not exists (select 1 from private.public_form_log where form = 'feedback' and created_at < now() - interval '2 days')
                     and exists (select 1 from private.public_form_log where form = 'job' and created_at < now() - interval '2 days'),
  'a feedback line of the log older than two days is removed by the next form (nothing needs it then); job lines stay');
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
-- Per phone: five a day, then thanked and not stored; whole website: 10 a minute, 200 a day, counted from the log, so a form
-- dropped over its phone limit counts like a stored one.
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
  for i in 1..9 loop perform pg_temp.check(pg_temp.try_fb(pg_temp.fb()) = 'ok', 'whole website: feedback ' || i || ' of 10 this minute is taken'); end loop;
  perform pg_temp.check(pg_temp.try_fb(pg_temp.fb('{"phone": "03015550123"}')) = 'ok', 'whole website: feedback 10 of 10 this minute is thanked (dropped: its phone is over the limit)');
  perform pg_temp.check(pg_temp.try_fb(pg_temp.fb()) like '- | FORM_BUSY:%', 'whole website: the eleventh form within a minute is told to try again later (the dropped one counted)');
end $$;
reset role;
select pg_temp.check((select count(*) from public.complaints where contact_phone = '03015550123') = 5, 'the dropped one was not stored');
-- 200 a day: fill the day's log up to 200 (made directly); the next is told to try again tomorrow (FORM_BUSY_DAY).
select pg_temp.later(2);
insert into private.public_form_log (form, created_at)
select 'feedback', now() - interval '3 hours'
  from generate_series(1, 200 - (select count(*)::int from private.public_form_log where form = 'feedback' and created_at > now() - interval '1 day')) g;
set role anon;
select pg_temp.act_as('');
select pg_temp.check(pg_temp.try_fb(pg_temp.fb()) like '- | FORM_BUSY_DAY:%try again tomorrow%', 'whole website: after 200 forms in a day the next one is told to try again tomorrow');
reset role;
select pg_temp.check((select count(*) from public.complaints where source = 'website') = 15, 'only the forms that were taken are stored (2 + 4 + 9), none refused or dropped');
-- A thank-you about a doctor, for the doctor dashboard below (put in directly: the day's 200 forms are in).
insert into public.complaints (branch_id, subject, body, source, kind, topic)
values ((select id from public.branches where code = 'GUL'), 'Appreciation: Doctor', 'Thank you for the very gentle treatment (sample).', 'website', 'appreciation', 'doctor');

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
  -- Only a complaint is about the doctor's work: a thank-you or a suggestion linked to the doctor is not listed or counted.
  update public.complaints set clinician_id = (select id from public.clinicians where display_name = 'Dr. Ali Rashid')
   where source = 'website' and kind in ('appreciation', 'suggestion');
  perform pg_temp.check(found, '(a thank-you and suggestions are linked to the doctor)');
  perform pg_temp.check(jsonb_array_length(public.doctor_summary((select id from public.clinicians where display_name = 'Dr. Ali Rashid'), (now() - interval '3 days')::date,
                          (now() + interval '1 day')::date) -> 'complaints') = jsonb_array_length(s -> 'complaints'),
    'a thank-you or a suggestion linked to a doctor does not count as a complaint about their work');

  -- Junk from the website can be deleted, by an admin only; a patient's complaint never.
  perform pg_temp.act_as(current_setting('test.coord'));
  delete from public.complaints where contact_mr = '50012';
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0, 'the coordinator handles website forms but cannot delete one');
  perform pg_temp.act_as(current_setting('test.pat'));
  delete from public.complaints;
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0, 'a patient cannot delete a complaint, their own included');
  perform pg_temp.act_as(current_setting('test.admin'));
  delete from public.complaints where source = 'portal';
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0 and exists (select 1 from public.complaints where source = 'portal'), 'not even an admin can delete a patient''s complaint');
  delete from public.complaints where contact_mr = '50012';
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'an admin deletes a website form (junk or spam)');
  perform pg_temp.check(not exists (select 1 from public.complaint_messages where body = 'Called back (sample).'), 'its internal notes go with it');
  perform pg_temp.check((select count(*) from public.complaints where source = 'website') = 15, 'the other website forms stay');
end $$;
reset role;
select pg_temp.expect_error($q$insert into public.complaints (subject, body, source) values ('x', 'y', 'portal')$q$, 'complaints_who_check', 'a portal complaint must belong to a patient');
select pg_temp.expect_error($q$insert into public.complaints (subject, body, source, kind) values ('x', 'y', 'website', 'complaint')$q$, 'complaints_who_check', 'a website form must have its topic');
select pg_temp.expect_error($q$insert into public.complaints (subject, body, source, kind, topic, contact_me) values ('x', 'y', 'website', 'complaint', 'other', true)$q$, 'complaints_contact_check', '"please contact me" needs a phone number');

-- 11. A field left out is empty, never an error; invisible characters are removed; an email address is one plain address;
--     "Other" is not a degree; the CV upload limits stay right without reading the bucket
select pg_temp.later(24 * 60 + 5);
-- The cleaning both forms use: zero-width characters, direction marks, overrides and isolates and the byte order mark go.
select pg_temp.check(private.form_line(E'Sample\u200B Na\u200Dme\u200F ') = 'Sample Name', 'form_line: zero-width characters and direction marks are removed');
select pg_temp.check(private.form_line(E'\u202Etxet\u202C and \u2066more\u2069\uFEFF') = 'txet and more', 'form_line: a right-to-left override, an isolate and the byte order mark are removed');
select pg_temp.check(private.form_line(E'\u200B\u200C\u200D\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\uFEFF') = '',
  'form_line: every one of U+200B-U+200F, U+202A-U+202E, U+2066-U+2069 and U+FEFF, and nothing is left');
select pg_temp.check(private.form_block(E'Line one\u202E\r\nLine\u200B two\u2067') = E'Line one\nLine two', 'form_block: the same, and the line end is kept');
select pg_temp.check(private.form_line(E'Ali \u0639\u0644\u06CC \u2014 caf\u00E9') = E'Ali \u0639\u0644\u06CC \u2014 caf\u00E9', 'other text is kept as typed (Urdu letters, a dash, an accent)');
set role anon;
select pg_temp.act_as('');
do $$
declare bad text;
begin
  perform pg_temp.put_cv(60);
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(60, jsonb_build_object('full_name', E'\u200B\u202E\u200B'))) like 'full_name | %', 'a name of invisible characters only is no name');
  -- The staff page makes a mailto: link of the address: nothing in it may add a subject, copies or text.
  foreach bad in array array['sample?cc=boss@example.com', 'sample@example.com?subject=hi', 'sam&ple@example.com', 'sample=1@example.com',
                             'sam%40ple@example.com', 'sample#x@example.com', 'sam ple@example.com'] loop
    perform pg_temp.check(pg_temp.try_job(pg_temp.job(60, jsonb_build_object('email', bad))) like 'email | FORM_INVALID: Please check your email address%', 'email: "' || bad || '" is refused');
  end loop;
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(60, '{"qualification": "Other"}')) like 'qualification | FORM_INVALID: Please type your degree or qualification%', '"Other" is not a degree: the form asks for the degree itself');
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(60, '{"qualification": " others "}')) like 'qualification | %', '... "others" either, however written');
  -- Every optional field left out of the form: taken, nothing stored for them.
  perform pg_temp.check(pg_temp.try_job(pg_temp.job(60, jsonb_build_object('full_name', E'Sample\u202E Sixty\u200B', 'qualification', 'BSc Nursing'))
                                         - 'email' - 'graduation_year' - 'experience' - 'message' - 'pf_trap') = 'ok',
    'a job form without email, year, experience, message or the hidden box is taken');
  -- "Please contact me" left out, null, or anything but the tick itself is not ticked (it used to stop the form with an error).
  perform pg_temp.check(pg_temp.try_fb(pg_temp.fb('{"message": "Every optional field left out (sample)."}') - 'name' - 'phone' - 'mr' - 'contact_me' - 'pf_trap') = 'ok',
    'a feedback form without name, phone, Mr#, "contact me" or the hidden box is taken');
  perform pg_temp.check(pg_temp.try_fb(pg_temp.fb('{"message": "No contact_me but a phone (sample).", "phone": "0301 5550160"}') - 'contact_me') = 'ok',
    'a feedback form with a phone but no "contact me" field is taken');
  perform pg_temp.check(pg_temp.try_fb(pg_temp.fb('{"message": "contact_me written as text (sample).", "contact_me": "true"}')) = 'ok', '"contact me" as the text "true" is not a tick');
  perform pg_temp.check(pg_temp.try_fb(pg_temp.fb('{"message": "contact_me given as null (sample).", "contact_me": null}')) = 'ok', '"contact me" as null is not a tick');
  perform pg_temp.check(pg_temp.try_fb(pg_temp.fb('{"message": "contact_me given as 1 (sample).", "contact_me": 1}')) = 'ok', '"contact me" as 1 is not a tick');
  perform pg_temp.check(pg_temp.try_fb(pg_temp.fb(jsonb_build_object('message', E'Shown \u202Ebackwards\u202C here (sample).', 'name', E'\u2067Sample Invisible\u2069'))) = 'ok',
    'a message and name with direction overrides are taken');
  -- The hidden box has a name no browser fills in by itself; a box called "website" (the old name, which autofill may fill) drops nothing.
  perform pg_temp.check(pg_temp.try_fb(pg_temp.fb('{"message": "An autofilled website box (sample).", "website": "https://example.com"}')) = 'ok', 'a filled "website" field no longer drops a form');
end $$;
reset role;
select pg_temp.check((select full_name = 'Sample Sixty' and qualification = 'BSc Nursing' and email is null and graduation_year is null and experience is null and message is null
                        from public.job_applications where cv_path = pg_temp.cv(60)), 'stored: the name without its invisible characters, the optional fields empty');
select pg_temp.check((select count(*) = 7 and bool_and(not contact_me) from public.complaints where source = 'website' and created_at = now()),
  'stored: all seven feedback forms, "Please contact me" not ticked in any of them');
select pg_temp.check((select contact_phone = '03015550160' from public.complaints where body = 'No contact_me but a phone (sample).'), '... the one with a phone keeps it');
select pg_temp.check((select body = 'Shown backwards here (sample).' and contact_name = 'Sample Invisible' from public.complaints where body like 'Shown%'),
  'stored: the message and name without the direction overrides');
-- The table itself holds the email and degree rules.
select pg_temp.expect_error($q$insert into public.job_applications (full_name, phone, email, position, qualification, cnic, cv_path, cv_type, cv_size)
                               values ('Sample', '03005550000', 'a?b=c@example.com', 'other', 'BDS', '12345-0000000-1', 'incoming/z.pdf', 'application/pdf', 1)$q$,
  'job_applications_email_check', 'the table refuses an email with ? or = in it');
select pg_temp.expect_error($q$insert into public.job_applications (full_name, phone, position, qualification, cnic, cv_path, cv_type, cv_size)
                               values ('Sample', '03005550000', 'other', 'Other', '12345-0000000-1', 'incoming/z.pdf', 'application/pdf', 1)$q$,
  'job_applications_qualification_check', 'the table never stores "Other" as a degree');
-- The question a visitor may ask (job_cv_upload_busy) never reads the bucket: it counts the last day's lines and the unsent ones of
-- private.job_cv_files. A pile of old CVs that forms sent (a year of hiring) changes neither its answer nor what it reads.
select pg_temp.check((select prosrc from pg_proc where oid = 'private.job_cv_upload_problem(bigint)'::regprocedure) !~ 'storage[.]objects'
                     and (select prosrc from pg_proc where oid = 'public.job_cv_upload_busy()'::regprocedure) !~ 'storage[.]objects',
  'job_cv_upload_busy and the limits it asks read private.job_cv_files, not storage.objects');
select pg_temp.check(exists (select 1 from pg_indexes where schemaname = 'private' and tablename = 'job_cv_files' and indexdef like '%(created_at)%')
                     and exists (select 1 from pg_indexes where schemaname = 'private' and tablename = 'job_cv_files' and indexdef like '%WHERE (NOT sent)%'),
  'job_cv_files has an index for the last day''s uploads and one for the unsent CVs');
select pg_temp.cv_limits_hold('before a year of old CVs');
select set_config('test.busy_before', coalesce(public.job_cv_upload_busy(), 'null'), false);
select set_config('test.unsent_before', (select count(*)::text from private.job_cv_files where not sent), false);
insert into private.public_form_log (form, cv_path, created_at)
select 'job', pg_temp.cv(200000 + g), now() - make_interval(days => 2 + g % 360) from generate_series(1, 400) g;
alter table storage.objects disable trigger job_cvs_guard;
insert into storage.objects (bucket_id, name, metadata, created_at)
select 'job-cvs', pg_temp.cv(200000 + g), '{"size": 250000, "mimetype": "application/pdf"}', now() - make_interval(days => 2 + g % 360) from generate_series(1, 400) g;
alter table storage.objects enable trigger job_cvs_guard;
select pg_temp.check(coalesce(public.job_cv_upload_busy(), 'null') = current_setting('test.busy_before'), '400 old sent CVs (100 MB) do not change the answer');
select pg_temp.check((select count(*)::text from private.job_cv_files where not sent) = current_setting('test.unsent_before')
                     and (select count(*) from private.job_cv_files where created_at > now() - interval '1 day') < 20,
  '... they are no unsent CVs, and outside the last day (so neither index brings them up)');
select pg_temp.cv_limits_hold('with a year of old CVs');
-- An upload of a name in use, refused by Storage's unique index, leaves no line behind.
select pg_temp.expect_error(format($q$insert into storage.objects (bucket_id, name, metadata) values ('job-cvs', %L, '{"size": 1000, "mimetype": "application/pdf"}')$q$, pg_temp.cv(60)),
  'JOB_CV_USED', 'a CV name in use cannot be uploaded again');
select pg_temp.put_cv(61);
select pg_temp.expect_error($q$select pg_temp.put_cv(61)$q$, 'duplicate key', 'an upload to the name of a file that is there is refused');
select pg_temp.cv_limits_hold('after refused uploads');
rollback;
