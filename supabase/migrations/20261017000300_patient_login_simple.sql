-- =============================================================================
-- Patient logins made simple, patients who register themselves, and "Please upload my photos".
--
-- The owner (Dr. Ali, 17 Oct 2026, verbatim): "give button for assistant, admin, coordinator and front desk to create patient user
-- login. the patient's login should direct him/her to their profile on our website, containing the invoice, photos, consent form etc.
-- the patient user creation should be simple, and we keep the password, the patient can change it themselves later." His choices: the
-- password is the patient's phone number as on file (staff can set it back to that any time), no forced change at the first login, the
-- patient types only their Mr# as the login name.
-- Then: "i also want patients to register themselves at our website using their name, mr # and mobile number. if they match our patient
-- profile. it creates their id and awaits confirmation by our staff. the staff get a button for new user approvals for the patients who
-- registered themselves." His choices: the patient chooses their own password; until staff approve, the patient sees only a waiting
-- screen; the same four roles approve or reject from a "New registrations" list.
-- And: "once the patient logs in, they should have a button 'please upload my photos' so that if patient has no photos in their gallery,
-- the staff can upload their photos. when patient marks 'please upload my photos' button, a list should come in a new list where multiple
-- patients if they have asked to upload pictures comes here, and staff knows who has asked for their photos to be uploaded."
--
-- 1. The grid: assistants get "Create patient logins" (portal.invite, relabelled: it was "Invite patients to the patient portal"), so the
--    four roles the owner named have it (front desk, assistant, coordinator, admin). The same key covers approving registrations.
-- 2. The login itself needs nothing new in the database: the login name is the Mr# ("mr-50013" at the clinic's domain, made by the
--    admin-users function; the login page makes the address from a typed Mr# by itself, so there is no lookup and nothing to leak), the
--    password is set by the function, and the patient reads their own record, invoices, photos and documents through the rules that
--    already exist (current_patient_id()). Patients could already read their own documents and files ("staff view patient documents",
--    "staff read patient documents"): nothing is widened.
-- 3. Patients who register themselves: public.patient_registrations keeps each request (the patient matched, the login made, what was
--    typed, pending / approved / rejected, who decided and when). The matching and the login are done by the admin-users function
--    (self_register: Mr# AND mobile number must match the patient's file, and the name must fit; it answers the same words whether or not
--    anything matched, and caps the tries); the database side here is:
--      - current_patient_id() answers NOTHING for a login whose registration is pending (or rejected), so every patient rule (record,
--        visits, invoices, photos, documents, messages, files) gives them no access until staff approve;
--      - my_portal_status(): 'pending' / 'approved' / null for the login itself, so the website can show the waiting screen;
--      - pending_registrations(), approve_registration(), reject_registration(): the "New registrations" list and its two buttons, for
--        "Create patient logins" holders, every decision in the audit log. After a rejection the function unlinks the patient and removes
--        the login (the patient row's link is guarded: only the service role or Dr. Ali may change it, 20261005000600).
--    Every self_register call is written to the audit log (SELF_REGISTER, with the outcome and the typed Mr#, never the phone or the
--    password); the function counts those rows for its caps, the way the Aaj ki List lookups are capped (SHEET_LOOKUP).
-- 4. "Please upload my photos": public.photo_requests. A patient opens one request at a time (and can cancel it); staff who use the Photo
--    inbox or upload photos see the open requests (photo_requests_open: patient, Mr#, branch, last visit, when asked) and mark them done;
--    a photo saved for that patient (a profile upload or a Photo inbox filing) marks the request done by itself (a trigger on photos).
--
-- Additive and safe to run more than once.
-- HOW TO APPLY: Supabase dashboard -> SQL Editor -> paste this whole file -> Run. Then redeploy the admin-users function.
-- =============================================================================

-- 1. The grid and the label.
insert into public.role_permissions (role, permission_key, allowed)
values ('assistant', 'portal.invite', true)
on conflict (role, permission_key) do update set allowed = true where public.role_permissions.allowed is distinct from true;

update public.permissions
   set label = 'Create patient logins',
       description = 'Create a patient''s login (login name = Mr#, password = the mobile number on file), set it back, and approve patients who registered themselves.'
 where key = 'portal.invite' and (label is distinct from 'Create patient logins' or description is null);

-- 3. Patients who register themselves.
create table if not exists public.patient_registrations (
  id           uuid primary key default gen_random_uuid(),
  patient_id   uuid not null references public.patients(id) on delete cascade,
  user_id      uuid not null,                 -- the login the function made for this request
  typed_name   text not null,                 -- what the patient typed, for the staff who check the match
  typed_phone  text not null,                 -- digits only
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at   timestamptz not null default now(),
  decided_by   uuid,
  decided_at   timestamptz,
  reason       text
);
create unique index if not exists patient_registrations_one_pending on public.patient_registrations (patient_id) where status = 'pending';
create index if not exists patient_registrations_user_idx on public.patient_registrations (user_id);
alter table public.patient_registrations enable row level security;
-- Only the people who create patient logins read the requests. Nobody writes them through the API: the function (service role) adds
-- a request, and approve_registration / reject_registration below decide it.
drop policy if exists "login makers view registrations" on public.patient_registrations;
create policy "login makers view registrations" on public.patient_registrations for select
  using (public.has_perm('portal.invite'));
drop trigger if exists patient_registrations_audit on public.patient_registrations;
create trigger patient_registrations_audit after insert or update or delete on public.patient_registrations
  for each row execute function public.audit_row();

-- A pending (or rejected) registration is nobody yet: the one function every patient rule asks answers nothing for that login. A login
-- the clinic made has no registration row; a patient who registers again later gets a new login and a new pending row.
create or replace function public.current_patient_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select p.id from public.patients p
   where p.portal_user_id = auth.uid()
     and not exists (select 1 from public.patient_registrations r where r.user_id = p.portal_user_id and r.status <> 'approved')
$$;

-- The login's own standing: 'pending' (registered, waiting for the clinic), 'approved' (a patient record answers to this login), or
-- null (no patient record: not linked). Nothing else comes out, no name and no record.
create or replace function public.my_portal_status()
returns text
language sql stable security definer set search_path = public
as $$
  select case
    when exists (select 1 from public.patient_registrations r where r.user_id = auth.uid() and r.status = 'pending') then 'pending'
    when public.current_patient_id() is not null then 'approved'
    else null end
$$;
revoke all on function public.my_portal_status() from public, anon;
grant execute on function public.my_portal_status() to authenticated;

-- The "New registrations" list: each request with what was typed beside the patient it matched.
create or replace function public.pending_registrations()
returns table (id uuid, patient_id uuid, typed_name text, typed_phone text, created_at timestamptz,
               full_name text, mr_number text, phone text, first_branch_id smallint)
language sql stable security definer set search_path = public
as $$
  select r.id, r.patient_id, r.typed_name, r.typed_phone, r.created_at, p.full_name, p.mr_number, p.phone, p.first_branch_id
    from public.patient_registrations r join public.patients p on p.id = r.patient_id
   where r.status = 'pending' and public.has_perm('portal.invite')
   order by r.created_at
$$;
revoke all on function public.pending_registrations() from public, anon;
grant execute on function public.pending_registrations() to authenticated;

create or replace function public.approve_registration(p_patient uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_reg public.patient_registrations;
begin
  if not public.has_perm('portal.invite') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.patient_registrations set status = 'approved', decided_by = auth.uid(), decided_at = now()
   where patient_id = p_patient and status = 'pending'
  returning * into v_reg;
  if v_reg.id is null then raise exception 'This registration was already decided. Reload the list.'; end if;
  insert into public.audit_log (table_name, row_id, action, new_data, actor)
  values ('patients', p_patient::text, 'REGISTRATION_APPROVED', jsonb_build_object('registration', v_reg.id, 'typed_name', v_reg.typed_name), auth.uid());
end $$;
revoke all on function public.approve_registration(uuid) from public, anon;
grant execute on function public.approve_registration(uuid) to authenticated;

-- Rejecting marks the row and answers the login's id; the admin-users function then unlinks the patient (the link is guarded against
-- changes by staff, 20261005000600) and removes the login (SQL cannot). From the mark on, the login is nobody (current_patient_id).
create or replace function public.reject_registration(p_patient uuid, p_reason text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_reg public.patient_registrations;
begin
  if not public.has_perm('portal.invite') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.patient_registrations set status = 'rejected', decided_by = auth.uid(), decided_at = now(), reason = nullif(left(trim(coalesce(p_reason, '')), 300), '')
   where patient_id = p_patient and status = 'pending'
  returning * into v_reg;
  if v_reg.id is null then raise exception 'This registration was already decided. Reload the list.'; end if;
  insert into public.audit_log (table_name, row_id, action, new_data, actor)
  values ('patients', p_patient::text, 'REGISTRATION_REJECTED', jsonb_build_object('registration', v_reg.id, 'typed_name', v_reg.typed_name, 'reason', v_reg.reason), auth.uid());
  return v_reg.user_id;
end $$;
revoke all on function public.reject_registration(uuid, text) from public, anon;
grant execute on function public.reject_registration(uuid, text) to authenticated;

-- 4. "Please upload my photos".
create table if not exists public.photo_requests (
  id            uuid primary key default gen_random_uuid(),
  patient_id    uuid not null references public.patients(id) on delete cascade,
  requested_at  timestamptz not null default now(),
  note          text,
  status        text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  done_by       uuid,
  done_at       timestamptz
);
create unique index if not exists photo_requests_one_open on public.photo_requests (patient_id) where status = 'open';
alter table public.photo_requests enable row level security;
-- The patient: their own requests; one is opened with nothing but the patient id (status open), and an open one may be cancelled.
drop policy if exists "patient views own photo requests" on public.photo_requests;
create policy "patient views own photo requests" on public.photo_requests for select
  using (patient_id = public.current_patient_id());
drop policy if exists "patient asks for photos" on public.photo_requests;
create policy "patient asks for photos" on public.photo_requests for insert
  with check (patient_id = public.current_patient_id() and status = 'open' and done_by is null and done_at is null);
drop policy if exists "patient cancels own photo request" on public.photo_requests;
create policy "patient cancels own photo request" on public.photo_requests for update
  using (patient_id = public.current_patient_id() and status = 'open')
  with check (patient_id = public.current_patient_id() and status = 'cancelled');
-- Staff who use the Photo inbox or upload photos see every request and mark them done (photo_request_done below).
drop policy if exists "photo staff view photo requests" on public.photo_requests;
create policy "photo staff view photo requests" on public.photo_requests for select
  using (public.has_perm('photos.intake') or public.has_perm('photos.upload'));
drop trigger if exists photo_requests_audit on public.photo_requests;
create trigger photo_requests_audit after insert or update or delete on public.photo_requests
  for each row execute function public.audit_row();

-- The list for staff: who asked, when, and where they are seen (branch, last visit), oldest request first.
create or replace function public.photo_requests_open()
returns table (id uuid, patient_id uuid, requested_at timestamptz, note text, full_name text, mr_number text, first_branch_id smallint, last_visit date)
language sql stable security definer set search_path = public
as $$
  select q.id, q.patient_id, q.requested_at, q.note, p.full_name, p.mr_number, p.first_branch_id,
         (select max(v.visit_date) from public.visits v where v.patient_id = p.id and v.status = 'completed')
    from public.photo_requests q join public.patients p on p.id = q.patient_id
   where q.status = 'open' and (public.has_perm('photos.intake') or public.has_perm('photos.upload'))
   order by q.requested_at
$$;
revoke all on function public.photo_requests_open() from public, anon;
grant execute on function public.photo_requests_open() to authenticated;

create or replace function public.photo_request_done(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not (public.has_perm('photos.intake') or public.has_perm('photos.upload')) then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.photo_requests set status = 'done', done_by = auth.uid(), done_at = now() where id = p_id and status = 'open';
  if not found then raise exception 'This request was already closed. Reload the list.'; end if;
end $$;
revoke all on function public.photo_request_done(uuid) from public, anon;
grant execute on function public.photo_request_done(uuid) to authenticated;

-- A photo saved for the patient (a profile upload, a Photo inbox filing) closes their open request by itself.
create schema if not exists private;
create or replace function private.photo_closes_request() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.patient_id is not null then
    update public.photo_requests set status = 'done', done_by = coalesce(new.uploaded_by, auth.uid()), done_at = now()
     where patient_id = new.patient_id and status = 'open';
  end if;
  return new;
end $$;
drop trigger if exists photos_close_request on public.photos;
create trigger photos_close_request after insert or update of patient_id on public.photos
  for each row execute function private.photo_closes_request();


-- 5. Admin -> Staff accounts -> Delete (20261015000200): a staff account that decided a registration or marked a photo request done has
-- records with its name on them, so it is kept (switched off), never removed for good. The same list as before, plus those two columns.
-- (patient_registrations.user_id is the PATIENT's login, not a staff member's: 33_staff_delete_test.sql leaves it out with that reason.)
create or replace function private.staff_record_columns()
returns table (table_name text, column_name text, label text, one text, sort integer)
language sql immutable set search_path = public
as $$
  select t, c, l, o, s::integer from (values
    ('visits',                 'created_by',           'visits',                       'visit',                       10),
    ('visits',                 'updated_by',           'visits last changed',          'visit last changed',          11),
    ('visits',                 'dues_override_by',     'dues holds overridden',        'dues hold overridden',        12),
    ('visits',                 'protocol_override_by', 'braces rule overrides',        'braces rule override',        13),
    ('payments',               'received_by',          'payments',                     'payment',                     20),
    ('invoices',               'created_by',           'invoices',                     'invoice',                     21),
    ('invoices',               'discount_approved_by', 'discounts approved',           'discount approved',           22),
    ('discount_requests',      'requested_by',         'discount requests',            'discount request',            23),
    ('discount_requests',      'decided_by',           'discount requests decided',    'discount request decided',    24),
    ('payment_plans',          'created_by',           'installment plans',            'installment plan',            25),
    ('expenses',               'created_by',           'expenses',                     'expense',                     26),
    ('cash_closings',          'closed_by',            'cash closings',                'cash closing',                27),
    ('cash_closings',          'verified_by',          'cash closings verified',       'cash closing verified',       28),
    ('patients',               'created_by',           'patients registered',          'patient registered',          30),
    ('braces_cases',           'created_by',           'braces cases',                 'braces case',                 31),
    ('checkups',               'created_by',           'checkup patients',             'checkup patient',             32),
    ('day_list_closings',      'closed_by',            'days ended',                   'day ended',                   33),
    ('retainer_cases',         'created_by',           'retainer records',             'retainer record',             34),
    ('lab_cases',              'created_by',           'lab work cases',               'lab work case',               35),
    ('inventory_moves',        'created_by',           'stock entries',                'stock entry',                 36),
    ('photos',                 'uploaded_by',          'photos',                       'photo',                       40),
    ('xrays',                  'uploaded_by',          'X-rays',                       'X-ray',                       41),
    ('patient_documents',      'uploaded_by',          'documents',                    'document',                    42),
    ('patient_flags',          'raised_by',            'patient flags raised',         'patient flag raised',         43),
    ('patient_flags',          'cleared_by',           'patient flags cleared',        'patient flag cleared',        44),
    ('photo_inbox_items',      'uploaded_by',          'Photo inbox photos uploaded',  'Photo inbox photo uploaded',  45),
    ('photo_inbox_sets',       'filed_by',             'Photo inbox sets filed',       'Photo inbox set filed',       46),
    ('photo_ai_calls',         'called_by',            'Claude photo editing calls',   'Claude photo editing call',   47),
    ('patient_registrations',  'decided_by',           'registrations decided',        'registration decided',        48),
    ('photo_requests',         'done_by',              'photo requests marked done',   'photo request marked done',   49),
    ('reminders',              'created_by',           'reminders made',               'reminder made',               50),
    ('reminders',              'assigned_to',          'reminders assigned',           'reminder assigned',           51),
    ('complaints',             'resolved_by',          'complaints resolved',          'complaint resolved',          52),
    ('complaint_messages',     'author_staff',         'complaint replies',            'complaint reply',             53),
    ('visit_ratings',          'followed_up_by',       'rating follow-ups',            'rating follow-up',            54),
    ('job_applications',       'updated_by',           'job applications updated',     'job application updated',     55),
    ('job_application_events', 'by_staff',             'job application notes',        'job application note',        56),
    ('staff',                  'deactivated_by',       'staff accounts switched off',  'staff account switched off',  60),
    ('staff',                  'deleted_by',           'staff accounts deleted',       'staff account deleted',       61),
    ('audit_log',              'actor',                'changes in the audit log',     'change in the audit log',     90)
  ) as x(t, c, l, o, s)
$$;
revoke all on function private.staff_record_columns() from public, anon, authenticated;

select (select allowed from public.role_permissions where role = 'assistant' and permission_key = 'portal.invite') as assistant_creates_logins,
       (select label from public.permissions where key = 'portal.invite') as permission_label,
       (select count(*) from public.patient_registrations where status = 'pending') as registrations_waiting,
       (select count(*) from public.photo_requests where status = 'open') as photo_requests_open;
