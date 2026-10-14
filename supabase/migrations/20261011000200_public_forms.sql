-- =============================================================================
-- Public forms on the homepage: "Join our team" (a job application with a CV) and "Complaints & suggestions"
-- (website feedback that lands in the staff Complaints inbox).
--
-- The owner (11 Oct 2026): "on the homepage, you should keep 2 buttons, join our team, with name, number, degree, CNIC,
-- and CV attachment option to complete the form. plus a separate button for complaints/suggestions to make our clinic
-- better. this should have general drop down items like, treatment suggestion, doctor suggestion, clinic cleanliness
-- suggestion etc."
--
-- Visitors are not logged in (role anon). What they may do is all in this file, and it is only this:
--   - upload ONE new file into the private bucket job-cvs, at incoming/<random uuid>.<pdf|doc|docx|jpg|png>, up to 5 MB.
--     They can never read, list, overwrite or delete a file, their own included;
--   - call public.submit_job_application(jsonb) and public.submit_feedback(jsonb). Both check every field again here
--     (the website's checks are only a convenience), store the text as plain text, and keep to the rate limits below.
-- No table gives anon a row to read, change or delete.
--
-- What this file adds
--   1. The permission jobs.view ("Job applications (CNIC, phone and CV)"): admin only by default, editable in the
--      access list. Only it shows the applications, their CNIC, phone and CV.
--   2. Website feedback in public.complaints, so staff handle everything in the one Complaints inbox: patient_id may be
--      empty for a row with source 'website', and new columns hold the type, topic and contact details. A patient's own
--      complaints keep source 'portal' (the insert policy now says so). An admin may delete a website form (junk or spam);
--      a patient's complaint is never deleted.
--   3. public.job_applications and its history public.job_application_events (status changes and internal notes, with
--      who and when). Staff read them with jobs.view; nobody writes them directly (only the functions below).
--   4. The bucket job-cvs, its storage policies, and the trigger that holds the CV upload limits.
--   5. Form helpers (private.form_line / form_block / pk_mobile / pk_cnic / form_fail), the same rules as
--      web/js/lib/public-forms.js, and private.public_form_log, the log the rate limits count.
--   6. public.submit_job_application(jsonb) and public.submit_feedback(jsonb).
--   7. public.update_job_application(uuid, text, text): staff change the status or add a note.
--   8. public.job_cv_orphans(): CVs that no application uses (the visitor gave up, a check failed, or the form was
--      dropped over a per-phone or per-CNIC limit). The staff pages of someone with jobs.view (the Today page and the
--      Job applications page) remove those older than a day by themselves (storage delete policy below).
--   9. public.doctor_summary: a website complaint that staff link to a doctor counts on that doctor's dashboard too,
--      without the visitor's name or phone.
--
-- Rate limits. Each function takes an advisory lock first, so two forms sent at the same moment cannot both slip under
-- a limit:
--   job applications  5 a minute and 200 a day for the whole website (a hiring post can bring many in one day; each needs a
--                     CV uploaded within the day, so the CV limits below are the tighter ones);
--                     2 a day per phone number and per CNIC.
--   feedback         10 a minute and 200 a day for the whole website; 5 a day per phone number.
--   CV uploads        5 files a minute, 100 files and 200 MB a day, and at most 100 MB of CVs that no application uses
--                     (abandoned and retried uploads count too). The project's storage (1 GB on the Free plan) also holds the
--                     photos, X-rays, receipts and documents, so the CVs can never take it over. A trigger on storage.objects
--                     holds these limits for every write, Storage's own write of a signed upload included (section 4).
-- Over a whole-website limit the visitor is asked to try again in a few minutes (FORM_BUSY), or tomorrow once the day is
-- full (FORM_BUSY_DAY); that says nothing about any person. Over a per-phone or per-CNIC limit the form is thanked like
-- any other and NOT stored, so the answer never tells whether a phone or CNIC has been used before. Such a dropped form
-- leaves exactly the traces of a stored one: every form that passes its checks goes into private.public_form_log (with
-- its CV) before it is stored or dropped, the whole-website limits count that log, and a CV in it is used. So the CV of
-- a dropped form cannot be sent again and the form counts toward the limits, as for a stored form. A form whose hidden
-- honeypot field ("website") is filled in (bots fill every box) is thanked and dropped without any check. The answer is
-- always {"ok": true}, never an id.
--
-- Storage reads go through to_jsonb(o) (created_at, metadata.size, metadata.mimetype), so these functions do not depend
-- on the exact columns of Supabase's storage tables when they are created; the local test stub has fewer columns.
--
-- Additive and safe to run more than once.
-- =============================================================================

create schema if not exists private;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Permission
-- ---------------------------------------------------------------------------------------------------------------
insert into public.permissions (key, label, category, sort_order) values
  ('jobs.view', 'Job applications (CNIC, phone and CV)', 'Admin', 104)
on conflict (key) do nothing;
insert into public.role_permissions (role, permission_key, allowed)
select r.role, 'jobs.view', r.role = 'admin'
  from unnest(enum_range(null::public.staff_role)) as r(role)
on conflict (role, permission_key) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Website feedback in the Complaints inbox
-- ---------------------------------------------------------------------------------------------------------------
alter table public.complaints alter column patient_id drop not null;
alter table public.complaints
  add column if not exists source        text not null default 'portal',   -- 'portal' = a patient's account, 'website' = the public form
  add column if not exists kind          text,                             -- website: complaint / suggestion / appreciation
  add column if not exists topic         text,                             -- website: what it is about
  add column if not exists contact_name  text,                             -- website, optional
  add column if not exists contact_phone text,                             -- website, optional, 03XXXXXXXXX
  add column if not exists contact_mr    text,                             -- website, optional: the Mr# the visitor typed (not checked)
  add column if not exists contact_me    boolean not null default false;   -- website: "Please contact me about this"
alter table public.complaints drop constraint if exists complaints_source_check;
alter table public.complaints drop constraint if exists complaints_kind_check;
alter table public.complaints drop constraint if exists complaints_topic_check;
alter table public.complaints drop constraint if exists complaints_contact_check;
alter table public.complaints drop constraint if exists complaints_who_check;
alter table public.complaints
  add constraint complaints_source_check check (source in ('portal', 'website')),
  add constraint complaints_kind_check check (kind is null or kind in ('complaint', 'suggestion', 'appreciation')),
  add constraint complaints_topic_check check (topic is null or topic in ('treatment', 'doctor', 'front_desk', 'waiting_time',
    'appointments', 'cleanliness', 'fees', 'facilities', 'website', 'other')),
  add constraint complaints_contact_check check (
    (contact_name is null or char_length(contact_name) <= 100)
    and (contact_phone is null or contact_phone ~ '^03[0-9]{9}$')
    and (contact_mr is null or contact_mr ~ '^[0-9A-Za-z/-]{1,20}$')
    and (not contact_me or contact_phone is not null)),
  -- A patient's complaint belongs to the patient; a website form has its type and topic instead.
  add constraint complaints_who_check check (
    (source = 'portal' and patient_id is not null)
    or (source = 'website' and kind is not null and topic is not null));

create index if not exists complaints_website_idx on public.complaints (created_at) where source = 'website';
create index if not exists complaints_contact_phone_idx on public.complaints (contact_phone, created_at) where contact_phone is not null;

-- Patients still file only their own complaints, and only as 'portal'; a website form is only made by submit_feedback().
alter policy "patients file complaints" on public.complaints
  with check ((patient_id = public.current_patient_id() and source = 'portal') or public.has_perm('complaints.view'));
-- Anyone can send the website form, so junk can arrive: an admin may delete a website form (its notes go with it). A patient's
-- complaint is never deleted. (Before this file nobody could delete a complaint.)
drop policy if exists "admin removes website forms" on public.complaints;
create policy "admin removes website forms" on public.complaints for delete to authenticated
  using (source = 'website' and public.is_admin());
revoke all on public.complaints, public.complaint_messages from anon;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Job applications
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.job_applications (
  id              uuid primary key default gen_random_uuid(),
  full_name       text not null check (char_length(full_name) between 2 and 100),
  phone           text not null check (phone ~ '^03[0-9]{9}$'),
  email           text check (email is null or (char_length(email) <= 120 and email ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$')),
  position        text not null check (position in ('dentist', 'orthodontist', 'dental_hygienist', 'dental_assistant',
                                                    'clinic_coordinator', 'receptionist', 'social_media', 'other')),
  qualification   text not null check (char_length(qualification) between 2 and 100),
  graduation_year smallint check (graduation_year is null or graduation_year between 1960 and 2100),
  experience      text check (experience is null or char_length(experience) <= 300),
  branch_id       smallint references public.branches(id),               -- null = any branch
  cnic            text not null check (cnic ~ '^[0-9]{5}-[0-9]{7}-[0-9]$'),
  cv_path         text not null unique,                                  -- job-cvs/<cv_path>
  cv_type         text not null,
  cv_size         integer not null check (cv_size between 1 and 5242880),
  message         text check (message is null or char_length(message) <= 1000),
  consent_at      timestamptz not null default now(),                    -- the visitor ticked "may keep these details"
  status          text not null default 'new' check (status in ('new', 'contacted', 'interview', 'hired', 'rejected')),
  updated_by      uuid references public.staff(id),
  updated_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists job_applications_created_idx on public.job_applications (created_at desc);
create index if not exists job_applications_phone_idx on public.job_applications (phone, created_at);
create index if not exists job_applications_cnic_idx on public.job_applications (cnic, created_at);

-- What staff did with an application: a status change or an internal note, with who and when (the name as it was then).
create table if not exists public.job_application_events (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.job_applications(id) on delete cascade,
  kind           text not null check (kind in ('status', 'note')),
  status         text check (status is null or status in ('new', 'contacted', 'interview', 'hired', 'rejected')),
  body           text check (body is null or char_length(body) <= 2000),
  by_staff       uuid references public.staff(id),
  by_name        text,
  created_at     timestamptz not null default now(),
  check ((kind = 'status' and status is not null) or (kind = 'note' and body is not null))
);
create index if not exists job_application_events_app_idx on public.job_application_events (application_id, created_at);

alter table public.job_applications enable row level security;
alter table public.job_application_events enable row level security;
drop policy if exists "job staff read applications" on public.job_applications;
create policy "job staff read applications" on public.job_applications for select to authenticated
  using (public.has_perm('jobs.view'));
drop policy if exists "job staff read application history" on public.job_application_events;
create policy "job staff read application history" on public.job_application_events for select to authenticated
  using (public.has_perm('jobs.view'));
-- Read only, and only through the policies above; every change goes through the functions in this file.
revoke all on public.job_applications, public.job_application_events from anon, authenticated;
grant select on public.job_applications, public.job_application_events to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. The CV bucket
-- ---------------------------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public) values ('job-cvs', 'job-cvs', false)
  on conflict (id) do update set public = false;
-- The size limit and file types are checked by Storage itself as the file arrives (Supabase always has these columns).
do $$
begin
  if exists (select 1 from pg_attribute where attrelid = 'storage.buckets'::regclass and attname = 'allowed_mime_types' and not attisdropped)
     and exists (select 1 from pg_attribute where attrelid = 'storage.buckets'::regclass and attname = 'file_size_limit' and not attisdropped) then
    execute $q$update storage.buckets set file_size_limit = 5242880,
      allowed_mime_types = array['application/pdf', 'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png']
      where id = 'job-cvs'$q$;
  end if;
end $$;

-- The CV upload limits, for the whole website: 5 files a minute, 100 files and 200 MB a day, and at most 100 MB of CVs that no
-- application uses. Why an upload of p_size bytes would be refused now: 'day' (one of the day's limits, or the unused CVs; the
-- staff pages remove unused ones once a day old), 'minute', or null (allowed). A file has at least one byte, so p_size 0 asks
-- whether any upload is taken. It reads every file of the bucket, so it is a security definer function (the visitor may not
-- see the files it counts), and only the functions below call it.
create or replace function private.job_cv_upload_problem(p_size bigint default 0)
returns text
language sql stable security definer set search_path = public
as $$
  select case
           when count(*) filter (where x.at > now() - interval '1 day') >= 100
             or coalesce(sum(x.size) filter (where x.at > now() - interval '1 day'), 0) + greatest(coalesce(p_size, 0), 1) > 200 * 1048576
             or coalesce(sum(x.size) filter (where not x.sent), 0) + greatest(coalesce(p_size, 0), 1) > 100 * 1048576 then 'day'
           when count(*) filter (where x.at > now() - interval '1 minute') >= 5 then 'minute'
         end
    from (select (to_jsonb(o) ->> 'created_at')::timestamptz as at,
                 case when (to_jsonb(o) -> 'metadata' ->> 'size') ~ '^[0-9]{1,12}$' then (to_jsonb(o) -> 'metadata' ->> 'size')::bigint else 0 end as size,
                 exists (select 1 from public.job_applications a where a.cv_path = o.name) as sent
            from storage.objects o where o.bucket_id = 'job-cvs') x
$$;
revoke all on function private.job_cv_upload_problem(bigint) from public, anon, authenticated;

-- Storage asks job_cv_upload_allowed() as the visitor (the insert policy below), as a first check. After a refused upload the
-- website asks job_cv_upload_busy(), to say "try again tomorrow" rather than "in a few minutes"; it tells only how busy the
-- whole website is, nothing about any person or file.
create or replace function public.job_cv_upload_busy()
returns text
language sql stable security definer set search_path = public
as $$ select private.job_cv_upload_problem(0) $$;
create or replace function public.job_cv_upload_allowed()
returns boolean
language sql stable security definer set search_path = public
as $$ select public.job_cv_upload_busy() is null $$;
revoke all on function public.job_cv_upload_busy() from public;
revoke all on function public.job_cv_upload_allowed() from public;
grant execute on function public.job_cv_upload_busy() to anon, authenticated;
grant execute on function public.job_cv_upload_allowed() to anon, authenticated;

-- The limits are held by this trigger, not only by the insert policy: Storage checks a policy only as a probe that it rolls back,
-- and a signed upload (POST /storage/v1/object/upload/sign/..., then PUT ...?token=) writes the row afterwards as a superuser,
-- which no policy sees but every trigger does (the probe meets the trigger too). One upload at a time (the advisory lock), so
-- uploads sent at the same moment cannot all slip under a limit. A CV file, once there, is never changed: an overwrite (an
-- upsert, also with the x-upsert header) or a move is refused, so a file checked by submit_job_application stays that file.
-- Only these columns count as the file; Storage may still stamp others (owner, last access) as it likes.
create or replace function private.job_cvs_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_problem text;
  v_size bigint;
begin
  if tg_op = 'UPDATE' then
    if (old.bucket_id = 'job-cvs' or new.bucket_id = 'job-cvs')
       and jsonb_build_array(to_jsonb(old) -> 'bucket_id', to_jsonb(old) -> 'name', to_jsonb(old) -> 'metadata', to_jsonb(old) -> 'version', to_jsonb(old) -> 'archived_at')
           is distinct from
           jsonb_build_array(to_jsonb(new) -> 'bucket_id', to_jsonb(new) -> 'name', to_jsonb(new) -> 'metadata', to_jsonb(new) -> 'version', to_jsonb(new) -> 'archived_at') then
      raise exception 'JOB_CV_LOCKED: a CV file is never changed or replaced. Upload a new file instead.' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.bucket_id is distinct from 'job-cvs' then return new; end if;
  perform pg_advisory_xact_lock(hashtext('storage job-cvs uploads'));
  v_size := case when (to_jsonb(new) -> 'metadata' ->> 'size') ~ '^[0-9]{1,12}$' then (to_jsonb(new) -> 'metadata' ->> 'size')::bigint else 0 end;
  v_problem := private.job_cv_upload_problem(v_size);
  if v_problem is not null then
    raise exception 'JOB_CV_LIMIT: no more CV uploads are taken %.', case v_problem when 'day' then 'today' else 'this minute' end using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function private.job_cvs_guard() from public, anon, authenticated;
-- Supabase lets the postgres role add triggers on storage.objects (it has every privilege on it). Should a project ever refuse,
-- this stops here with a plain reason instead of leaving the uploads without their limits.
do $$
begin
  drop trigger if exists job_cvs_guard on storage.objects;
  create trigger job_cvs_guard before insert or update on storage.objects
    for each row execute function private.job_cvs_guard();
exception when insufficient_privilege then
  raise exception 'The CV upload limits need a trigger on storage.objects, and this database refused it (%). Ask Supabase support to allow it.', sqlerrm;
end $$;

-- A CV that no application uses and that is more than a day old (a form still being filled in keeps its file): never sent,
-- or sent with a form dropped over a per-phone or per-CNIC limit (it is in private.public_form_log, so it cannot be sent
-- again). It answers only staff with jobs.view (false for anyone else), so nobody can use it to ask about a file.
create or replace function public.job_cv_unsent(p_name text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.has_perm('jobs.view')
     and not exists (select 1 from public.job_applications a where a.cv_path = p_name)
     and coalesce((select (to_jsonb(o) ->> 'created_at')::timestamptz from storage.objects o
                    where o.bucket_id = 'job-cvs' and o.name = p_name), now()) < now() - interval '1 day'
$$;
revoke all on function public.job_cv_unsent(text) from public, anon;
grant execute on function public.job_cv_unsent(text) to authenticated;

-- Anyone may add a new file under incoming/ with a random name; nobody but staff with jobs.view may read one.
-- There is no update policy and the trigger above refuses any change, so a file can never be overwritten.
drop policy if exists "visitors upload a cv" on storage.objects;
create policy "visitors upload a cv" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'job-cvs'
              and name ~ '^incoming/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](pdf|doc|docx|jpg|png)$'
              and public.job_cv_upload_allowed());
drop policy if exists "job staff read cvs" on storage.objects;
create policy "job staff read cvs" on storage.objects for select to authenticated
  using (bucket_id = 'job-cvs' and public.has_perm('jobs.view'));
drop policy if exists "job staff remove unsent cvs" on storage.objects;
create policy "job staff remove unsent cvs" on storage.objects for delete to authenticated
  using (bucket_id = 'job-cvs' and public.has_perm('jobs.view') and public.job_cv_unsent(name));

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Form helpers (web/js/lib/public-forms.js has the same rules)
-- ---------------------------------------------------------------------------------------------------------------
-- One line: control characters and runs of spaces become one space, trimmed; '' when nothing is left.
create or replace function private.form_line(p text) returns text
language sql immutable parallel safe
return btrim(regexp_replace(regexp_replace(coalesce(p, ''), '[\x01-\x1f\x7f]', ' ', 'g'), '\s+', ' ', 'g'));

-- Several lines: Windows and old Mac line ends become one new line, other control characters go, trimmed.
create or replace function private.form_block(p text) returns text
language sql immutable parallel safe
return btrim(regexp_replace(replace(replace(coalesce(p, ''), E'\r\n', E'\n'), E'\r', E'\n'), '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]', '', 'g'), E' \n\t');

-- A Pakistani mobile number as 03XXXXXXXXX ("0300 1234567", "+92 300 1234567", "0092...", "300 1234567"), or null.
create or replace function private.pk_mobile(p text) returns text
language plpgsql immutable
as $$
declare d text := regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g');
begin
  if d like '0092%' then d := substr(d, 3); end if;
  if length(d) = 12 and d like '92%' then d := '0' || substr(d, 3); end if;
  if length(d) = 10 and d like '3%' then d := '0' || d; end if;
  return case when d ~ '^03[0-9]{9}$' then d end;
end $$;

-- A CNIC as 12345-1234567-1 (13 digits, with or without dashes), or null.
create or replace function private.pk_cnic(p text) returns text
language sql immutable parallel safe
return case when regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') ~ '^[0-9]{13}$'
  then regexp_replace(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), '^([0-9]{5})([0-9]{7})([0-9])$', '\1-\2-\3') end;

-- Stops a form with the visitor's own words; the field name goes in DETAIL so the website can mark that field.
create or replace function private.form_fail(p_field text, p_message text) returns void
language plpgsql
as $$
begin
  raise exception 'FORM_INVALID: %', p_message using errcode = '22023', detail = coalesce(p_field, '');
end $$;

revoke all on function private.form_line(text), private.form_block(text), private.pk_mobile(text), private.pk_cnic(text),
  private.form_fail(text, text) from public, anon, authenticated;

-- Every form that passed its checks, stored or dropped over a per-phone or per-CNIC limit, with its CV. The whole-website
-- limits count this log and a CV in it is used, so a dropped form leaves the same traces as a stored one. Only the two
-- functions below use it (no grants, and the schema is private). Each removes its own lines older than two days as forms
-- arrive: nothing needs them then (a CV more than a day old is refused anyway).
create table if not exists private.public_form_log (
  id         bigserial primary key,
  form       text not null check (form in ('job', 'feedback')),
  cv_path    text unique,                                                -- a job application's CV (job-cvs/<cv_path>)
  created_at timestamptz not null default now()
);
create index if not exists public_form_log_form_idx on private.public_form_log (form, created_at);
revoke all on private.public_form_log from public, anon, authenticated;
revoke all on sequence private.public_form_log_id_seq from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 6a. "Join our team"
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.submit_job_application(p_form jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_ok constant jsonb := jsonb_build_object('ok', true);
  v_name text; v_phone text; v_email text; v_position text; v_qual text; v_year_text text; v_year int; v_exp text;
  v_branch smallint; v_cnic text; v_cv text; v_message text;
  v_obj jsonb; v_size bigint; v_type text; v_at timestamptz; v_ext text;
begin
  if p_form is null or jsonb_typeof(p_form) <> 'object' or octet_length(p_form::text) > 20000 then
    perform private.form_fail(null, 'The form could not be read. Please fill it in again.');
  end if;
  -- The hidden box only bots fill in: thanked, not stored, not checked further.
  if private.form_line(p_form ->> 'website') <> '' then return v_ok; end if;

  v_name := private.form_line(p_form ->> 'full_name');
  if v_name = '' or char_length(v_name) < 2 or v_name !~ '[[:alpha:]]' then perform private.form_fail('full_name', 'Please enter your full name.'); end if;
  if char_length(v_name) > 100 then perform private.form_fail('full_name', 'Please keep your name under 100 characters.'); end if;

  v_phone := private.pk_mobile(p_form ->> 'phone');
  if v_phone is null then perform private.form_fail('phone', 'Please enter a Pakistani mobile number, for example 0300 1234567.'); end if;

  v_email := nullif(private.form_line(p_form ->> 'email'), '');
  if v_email is not null and (char_length(v_email) > 120 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$') then
    perform private.form_fail('email', 'Please check your email address, for example name@gmail.com, or leave it empty.');
  end if;

  v_position := p_form ->> 'position';
  if v_position is null or v_position not in ('dentist', 'orthodontist', 'dental_hygienist', 'dental_assistant',
                                              'clinic_coordinator', 'receptionist', 'social_media', 'other') then
    perform private.form_fail('position', 'Please choose the job you are applying for.');
  end if;

  v_qual := private.form_line(p_form ->> 'qualification');
  if char_length(v_qual) < 2 then perform private.form_fail('qualification', 'Please enter your degree or qualification, for example BDS.'); end if;
  if char_length(v_qual) > 100 then perform private.form_fail('qualification', 'Please keep this under 100 characters.'); end if;

  v_year_text := private.form_line(p_form ->> 'graduation_year');
  if v_year_text <> '' then
    if v_year_text ~ '^[0-9]{4}$' then v_year := v_year_text::int; end if;
    if v_year is null or v_year not between 1960 and extract(year from now())::int + 6 then
      perform private.form_fail('graduation_year', format('Please enter a year between 1960 and %s, or leave it empty.', extract(year from now())::int + 6));
    end if;
  end if;

  v_exp := nullif(private.form_line(p_form ->> 'experience'), '');
  if char_length(v_exp) > 300 then perform private.form_fail('experience', 'Please keep this under 300 characters.'); end if;

  if p_form ->> 'branch' = 'any' then
    v_branch := null;
  elsif coalesce(p_form ->> 'branch', '') ~ '^[1-9][0-9]{0,4}$'
        and exists (select 1 from public.branches b where b.id = (p_form ->> 'branch')::int and b.active) then
    v_branch := (p_form ->> 'branch')::smallint;
  else
    perform private.form_fail('branch', 'Please choose a branch, or "Any branch".');
  end if;

  v_cnic := private.pk_cnic(p_form ->> 'cnic');
  if v_cnic is null then perform private.form_fail('cnic', 'A CNIC has 13 digits, for example 12345-1234567-1.'); end if;

  v_message := nullif(private.form_block(p_form ->> 'message'), '');
  if char_length(v_message) > 1000 then perform private.form_fail('message', 'Please keep your message under 1,000 characters.'); end if;

  if (p_form -> 'consent') is distinct from 'true'::jsonb then
    perform private.form_fail('consent', 'Please tick this box, so the clinic may keep your details and contact you.');
  end if;

  v_cv := p_form ->> 'cv_path';
  if v_cv is null or v_cv !~ '^incoming/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](pdf|doc|docx|jpg|png)$' then
    raise exception 'FORM_CV: Please attach your CV again.' using errcode = '22023', detail = 'cv';
  end if;

  -- One form at a time from here, so the counts below hold. They count the log: stored and dropped forms alike.
  perform pg_advisory_xact_lock(hashtext('public.submit_job_application'));
  if (select count(*) from private.public_form_log where form = 'job' and created_at > now() - interval '1 day') >= 200 then
    raise exception 'FORM_BUSY_DAY: the clinic has received many job applications today. Please try again tomorrow.' using errcode = 'P0001';
  end if;
  if (select count(*) from private.public_form_log where form = 'job' and created_at > now() - interval '1 minute') >= 5 then
    raise exception 'FORM_BUSY: many job applications are arriving right now. Please try again later.' using errcode = 'P0001';
  end if;
  -- The CV: a file this form's visitor uploaded to job-cvs within the day, of an allowed type and size, not used by another form
  -- (stored or dropped: the log has both).
  select to_jsonb(o) into v_obj from storage.objects o where o.bucket_id = 'job-cvs' and o.name = v_cv;
  if v_obj is null then
    raise exception 'FORM_CV: Your CV did not finish uploading. Please choose it again.' using errcode = '22023', detail = 'cv';
  end if;
  v_ext := substring(v_cv from '[.]([a-z]+)$');
  v_type := v_obj -> 'metadata' ->> 'mimetype';
  v_size := case when (v_obj -> 'metadata' ->> 'size') ~ '^[0-9]{1,12}$' then (v_obj -> 'metadata' ->> 'size')::bigint end;
  v_at := (v_obj ->> 'created_at')::timestamptz;
  if v_size is null or v_size < 1 or v_size > 5242880 then
    raise exception 'FORM_CV: Your CV must be a file of at most 5 MB. Please choose it again.' using errcode = '22023', detail = 'cv';
  end if;
  if v_type is distinct from (case v_ext when 'pdf' then 'application/pdf' when 'doc' then 'application/msword'
       when 'docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
       when 'jpg' then 'image/jpeg' when 'png' then 'image/png' end) then
    raise exception 'FORM_CV: Your CV must be a PDF, Word (.doc or .docx), JPG or PNG file.' using errcode = '22023', detail = 'cv';
  end if;
  if v_at is null or v_at < now() - interval '1 day'
     or exists (select 1 from private.public_form_log l where l.cv_path = v_cv)
     or exists (select 1 from public.job_applications a where a.cv_path = v_cv) then
    raise exception 'FORM_CV: Please choose your CV again.' using errcode = '22023', detail = 'cv';
  end if;

  -- Logged before it is stored or dropped below: either way its CV is now used and it counts toward the limits above.
  delete from private.public_form_log where form = 'job' and created_at < now() - interval '2 days';
  insert into private.public_form_log (form, cv_path) values ('job', v_cv);

  -- The same phone or CNIC twice today already: thanked like any other form and not stored. This comes after every other check
  -- (the CV ones included) and after the log, so neither an answer nor anything a later form meets depends on whether the
  -- phone or CNIC was used before.
  if (select count(*) from public.job_applications where phone = v_phone and created_at > now() - interval '1 day') >= 2
     or (select count(*) from public.job_applications where cnic = v_cnic and created_at > now() - interval '1 day') >= 2 then
    return v_ok;
  end if;

  begin
    insert into public.job_applications (full_name, phone, email, position, qualification, graduation_year, experience,
                                         branch_id, cnic, cv_path, cv_type, cv_size, message, consent_at)
    values (v_name, v_phone, v_email, v_position, v_qual, v_year, v_exp, v_branch, v_cnic, v_cv, v_type, v_size, v_message, now());
  exception when unique_violation then
    raise exception 'FORM_CV: Please choose your CV again.' using errcode = '22023', detail = 'cv';
  end;
  return v_ok;
end $$;
revoke all on function public.submit_job_application(jsonb) from public;
grant execute on function public.submit_job_application(jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 6b. "Complaints & suggestions"
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.submit_feedback(p_form jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_ok constant jsonb := jsonb_build_object('ok', true);
  v_kind text; v_topic text; v_branch smallint; v_message text; v_name text; v_phone text; v_mr text; v_contact boolean;
begin
  if p_form is null or jsonb_typeof(p_form) <> 'object' or octet_length(p_form::text) > 20000 then
    perform private.form_fail(null, 'The form could not be read. Please fill it in again.');
  end if;
  if private.form_line(p_form ->> 'website') <> '' then return v_ok; end if;

  v_kind := p_form ->> 'kind';
  if v_kind is null or v_kind not in ('complaint', 'suggestion', 'appreciation') then
    perform private.form_fail('kind', 'Please choose complaint, suggestion or appreciation.');
  end if;
  v_topic := p_form ->> 'topic';
  if v_topic is null or v_topic not in ('treatment', 'doctor', 'front_desk', 'waiting_time', 'appointments', 'cleanliness',
                                        'fees', 'facilities', 'website', 'other') then
    perform private.form_fail('topic', 'Please choose what it is about.');
  end if;
  if p_form ->> 'branch' = 'none' then
    v_branch := null;
  elsif coalesce(p_form ->> 'branch', '') ~ '^[1-9][0-9]{0,4}$'
        and exists (select 1 from public.branches b where b.id = (p_form ->> 'branch')::int and b.active) then
    v_branch := (p_form ->> 'branch')::smallint;
  else
    perform private.form_fail('branch', 'Please choose a branch, or "Not about one branch".');
  end if;

  v_message := private.form_block(p_form ->> 'message');
  if char_length(v_message) < 10 then perform private.form_fail('message', 'Please write a little more (at least 10 characters).'); end if;
  if char_length(v_message) > 2000 then perform private.form_fail('message', 'Please keep your message under 2,000 characters.'); end if;

  v_name := nullif(private.form_line(p_form ->> 'name'), '');
  if char_length(v_name) > 100 then perform private.form_fail('name', 'Please keep your name under 100 characters.'); end if;
  v_contact := (p_form -> 'contact_me') = 'true'::jsonb;
  if nullif(private.form_line(p_form ->> 'phone'), '') is not null then
    v_phone := private.pk_mobile(p_form ->> 'phone');
    if v_phone is null then perform private.form_fail('phone', 'Please enter a Pakistani mobile number, for example 0300 1234567.'); end if;
  elsif v_contact then
    perform private.form_fail('phone', 'Please give your mobile number, so we can contact you about this.');
  end if;
  v_mr := nullif(regexp_replace(private.form_line(p_form ->> 'mr'), '^mr\s*#?\s*', '', 'i'), '');
  if v_mr is not null and v_mr !~ '^[0-9A-Za-z/-]{1,20}$' then
    perform private.form_fail('mr', 'Please check your Mr# (letters and numbers only), or leave it empty.');
  end if;

  -- One form at a time from here; the counts are of the log (stored and dropped forms alike), like the job form's.
  perform pg_advisory_xact_lock(hashtext('public.submit_feedback'));
  if (select count(*) from private.public_form_log where form = 'feedback' and created_at > now() - interval '1 day') >= 200 then
    raise exception 'FORM_BUSY_DAY: the clinic has received many messages today. Please try again tomorrow.' using errcode = 'P0001';
  end if;
  if (select count(*) from private.public_form_log where form = 'feedback' and created_at > now() - interval '1 minute') >= 10 then
    raise exception 'FORM_BUSY: many forms are arriving right now. Please try again later.' using errcode = 'P0001';
  end if;
  delete from private.public_form_log where form = 'feedback' and created_at < now() - interval '2 days';
  insert into private.public_form_log (form) values ('feedback');
  -- Five today from this phone already: thanked and not stored (logged above, so it counts toward the limits all the same).
  if v_phone is not null and (select count(*) from public.complaints
                               where source = 'website' and contact_phone = v_phone and created_at > now() - interval '1 day') >= 5 then
    return v_ok;
  end if;

  insert into public.complaints (patient_id, branch_id, subject, body, source, kind, topic, contact_name, contact_phone, contact_mr, contact_me)
  values (null, v_branch,
          (case v_kind when 'complaint' then 'Complaint' when 'suggestion' then 'Suggestion' else 'Appreciation' end) || ': ' ||
          case v_topic when 'treatment' then 'Treatment' when 'doctor' then 'Doctor' when 'front_desk' then 'Front desk & staff behaviour'
            when 'waiting_time' then 'Waiting time' when 'appointments' then 'Appointments & timings' when 'cleanliness' then 'Clinic cleanliness'
            when 'fees' then 'Fees & billing' when 'facilities' then 'Facilities (AC, seating, washroom, parking)'
            when 'website' then 'Website & online services' else 'Other' end,
          v_message, 'website', v_kind, v_topic, v_name, v_phone, v_mr, v_contact);
  return v_ok;
end $$;
revoke all on function public.submit_feedback(jsonb) from public;
grant execute on function public.submit_feedback(jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 7. Staff: status and notes
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.update_job_application(p_id uuid, p_status text default null, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  a public.job_applications;
  v_note text := nullif(private.form_block(p_note), '');
  v_by text;
begin
  if not public.has_perm('jobs.view') then
    raise exception 'NOT_ALLOWED: job applications need "Job applications (CNIC, phone and CV)" in the access list.' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('new', 'contacted', 'interview', 'hired', 'rejected') then
    raise exception 'INVALID: unknown status %', p_status using errcode = '22023';
  end if;
  if char_length(v_note) > 2000 then raise exception 'INVALID: a note can have at most 2,000 characters.' using errcode = '22023'; end if;
  select * into a from public.job_applications where id = p_id for update;
  if a.id is null then raise exception 'NOT_FOUND: this application does not exist.' using errcode = 'P0002'; end if;
  select full_name into v_by from public.staff where id = auth.uid();

  if p_status is not null and p_status <> a.status then
    update public.job_applications set status = p_status, updated_by = auth.uid(), updated_at = now() where id = p_id;
    insert into public.job_application_events (application_id, kind, status, by_staff, by_name) values (p_id, 'status', p_status, auth.uid(), v_by);
  end if;
  if v_note is not null then
    update public.job_applications set updated_by = auth.uid(), updated_at = now() where id = p_id;
    insert into public.job_application_events (application_id, kind, body, by_staff, by_name) values (p_id, 'note', v_note, auth.uid(), v_by);
  end if;
  return (select to_jsonb(x) from public.job_applications x where x.id = p_id);
end $$;
revoke all on function public.update_job_application(uuid, text, text) from public, anon;
grant execute on function public.update_job_application(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 8. CVs no application uses (older than a day; a dropped form's CV too): removed by the staff pages of someone with jobs.view
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.job_cv_orphans()
returns table (path text, uploaded_at timestamptz, size_bytes bigint)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.has_perm('jobs.view') then
    raise exception 'NOT_ALLOWED: job applications need "Job applications (CNIC, phone and CV)" in the access list.' using errcode = '42501';
  end if;
  return query
    select x.name, x.at, x.size
      from (select o.name, (to_jsonb(o) ->> 'created_at')::timestamptz as at,
                   case when (to_jsonb(o) -> 'metadata' ->> 'size') ~ '^[0-9]{1,12}$' then (to_jsonb(o) -> 'metadata' ->> 'size')::bigint end as size
              from storage.objects o where o.bucket_id = 'job-cvs') x
     where x.at < now() - interval '1 day'
       and not exists (select 1 from public.job_applications a where a.cv_path = x.name)
     order by x.at;
end $$;
revoke all on function public.job_cv_orphans() from public, anon;
grant execute on function public.job_cv_orphans() to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 9. Doctor dashboard: website complaints linked to a doctor count too (20261007001700, with a left join; a website
--    form shows as source 'website', never with the visitor's name or phone)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.doctor_summary(p_clinician uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid;
  v_rule public.doctor_commission_rules;
  v_work jsonb; v_own jsonb; v_complaints jsonb; v_base numeric := 0; v_share numeric;
  t_from timestamptz := p_from::timestamp at time zone 'Asia/Karachi';
  t_to   timestamptz := (p_to + 1)::timestamp at time zone 'Asia/Karachi';
begin
  select id into v_me from public.clinicians where staff_id = auth.uid();
  if auth.uid() is not null and not public.is_admin() and not public.has_perm('doctor_log.view_all') and (v_me is null or v_me <> p_clinician) then
    raise exception 'You can only see your own summary' using errcode = '42501';
  end if;

  select jsonb_build_object(
           'treated', count(*) filter (where vs.role = 'doctor'), 'checked', count(*) filter (where vs.role = 'checker'), 'assisted', count(*) filter (where vs.role = 'assistant'),
           'days', count(distinct v.visit_date), 'billed', coalesce(sum(i.total) filter (where vs.role = 'doctor'), 0),
           'branches', coalesce((select jsonb_agg(distinct v2.branch_id) from public.visit_staff vs2 join public.visits v2 on v2.id = vs2.visit_id
                                  where vs2.clinician_id = p_clinician and v2.status = 'completed' and v2.visit_date between p_from and p_to), '[]'))
    into v_work
    from public.visit_staff vs
    join public.visits v on v.id = vs.visit_id and v.status = 'completed' and v.visit_date between p_from and p_to
    left join public.invoices i on i.visit_id = v.id and i.status = 'issued'
   where vs.clinician_id = p_clinician;

  select jsonb_build_object(
           'referred_patients', count(distinct p.id),
           'referred_paid', coalesce((select sum(y.amount) from public.payments y
                                        where y.patient_id in (select q.id from public.patients q where q.referred_by_clinician = p_clinician)
                                          and y.received_at >= t_from and y.received_at < t_to), 0))
    into v_own
    from public.patients p where p.referred_by_clinician = p_clinician;

  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'subject', c.subject, 'status', c.status, 'created_at', c.created_at, 'branch_id', c.branch_id,
                                               'patient_name', p.full_name, 'mr_number', p.mr_number, 'source', c.source) order by c.created_at desc), '[]')
    into v_complaints
    from public.complaints c left join public.patients p on p.id = c.patient_id
   where c.clinician_id = p_clinician and c.created_at >= t_from and c.created_at < t_to;

  select * into v_rule from public.doctor_commission_rules r where r.active and r.clinician_id = p_clinician limit 1;
  if v_rule.id is null then select * into v_rule from public.doctor_commission_rules r where r.active and r.clinician_id is null limit 1; end if;
  if v_rule.id is not null then
    v_base := case v_rule.basis when 'treated' then (v_work->>'billed')::numeric when 'referred' then (v_own->>'referred_paid')::numeric
                                else (v_work->>'billed')::numeric + (v_own->>'referred_paid')::numeric end;
    v_share := round(v_base * v_rule.percent / 100, 2);
  end if;

  return v_work || v_own || jsonb_build_object('complaints', v_complaints,
    'rule', case when v_rule.id is null then null else jsonb_build_object('percent', v_rule.percent, 'basis', v_rule.basis, 'notes', v_rule.notes) end,
    'share', v_share);
end $$;

revoke all on function public.doctor_summary(uuid, date, date) from public, anon;
grant execute on function public.doctor_summary(uuid, date, date) to authenticated;

notify pgrst, 'reload schema';
