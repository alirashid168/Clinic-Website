-- =============================================================================
-- Admin -> Staff accounts: a Delete button for accounts that are not used.
--
-- The owner's request (15 Oct 2026): "can i get a delete button for the accounts that dont get used?"
--
-- What Delete does (decided by the admin-users function, delete_staff in staff-delete-actions.ts, never by the page):
--   1. it switches the account off first, exactly like "Switch off", so nothing new is written under that login;
--   2. it asks public.staff_records() what the website has with that account's id on it;
--   3. nothing at all: the login is removed for good (the staff row goes with it: staff.id references auth.users on delete
--      cascade) and the email can be given to someone else. A doctor linked to the login stays in the doctors list for
--      visits; only the link goes. The audit log keeps the whole staff row (action DELETE_LOGIN);
--   4. records: the account cannot be removed (the records keep its name), so it stays switched off and is marked deleted
--      (staff.deleted_at). It leaves the list and every staff picker, its name stays on its old records, and it can be
--      brought back from "Deleted accounts" at the bottom of the page (still switched off).
--
-- What this file adds
--   1. staff.deleted_at / staff.deleted_by (as deactivated_at / deactivated_by), and the rule that a deleted account is always
--      switched off (staff_deleted_is_switched_off).
--   2. private.staff_record_columns(): every column that stores a staff (login) id, with the words the dialog uses for it.
--      supabase/tests/33_staff_delete_test.sql checks that every uuid column that has a foreign key to public.staff or
--      auth.users, or whose name looks like a staff reference, is either in this list or excluded there with a reason:
--      a NEW TABLE OR COLUMN THAT STORES A STAFF ID MUST BE ADDED HERE (create or replace this function in its migration).
--   3. public.staff_records(staff): what the website has with that id on it, counted per column ({ total, parts }). Only for
--      people who may manage staff accounts (users.manage).
--   4. The staff guard (a trigger): nobody but admin marks or unmarks an account as deleted by hand, not even their own; the
--      admin-users function (the service role) does it after its own checks.
--   5. public.staff_logins(): also gives deleted_at for each account (the HR login list says "Deleted"), and names the
--      sign-ins of a login removed for good from its DELETE_LOGIN audit row.
--   6. An index on audit_log (actor), so the count of an account's changes does not read the whole audit log.
--
-- Not counted (the reasons are in the test's exclusion list): staff.id itself, clinicians.staff_id (a doctor's login link,
-- unlinked by delete_staff), staff_permission_overrides.staff_id (personal access ticks, removed with the account),
-- patients.portal_user_id (a patient's login), login_events.user_id (signing in is not work), idempotency_keys.created_by
-- (a retry key; the invoice or plan it made is counted), audit_log.row_id (the row a change was about), and the columns that
-- name a doctor or a retainer team member (visits.checked_by, patients.referred_by_clinician, retainer_cases.made_by and
-- model_check_by), which are not logins.
--
-- HOW TO APPLY
--   Supabase dashboard -> SQL Editor -> New query -> paste this whole file -> Run. Then redeploy the admin-users function
--   (supabase functions deploy admin-users, all four files). Until both are done the Delete button says what is missing and
--   changes nothing. Safe to run more than once. With the Supabase CLI keep the file name: 20261015000200 sorts after
--   20261012000300_checkup_form_day_lists.sql (20261015000100 is used by another change).
--   The index on audit_log is built while the file runs: changes saved in those few seconds wait for it.
-- =============================================================================

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. The deleted mark
-- ---------------------------------------------------------------------------------------------------------------
alter table public.staff add column if not exists deleted_at timestamptz;
alter table public.staff add column if not exists deleted_by uuid;
comment on column public.staff.deleted_at is
  'Set by Delete on Admin -> Staff accounts for an account that has records: it stays switched off, leaves the list and the staff pickers, and keeps its name on its records. Cleared by Bring back.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'staff_deleted_is_switched_off' and conrelid = 'public.staff'::regclass) then
    alter table public.staff add constraint staff_deleted_is_switched_off check (deleted_at is null or not active);
  end if;
end $$;

create index if not exists audit_log_actor_idx on public.audit_log (actor) where actor is not null;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Every column that stores a staff id, and how the dialog names its rows (plural, and one row)
-- ---------------------------------------------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------------------------------------------
-- 3. What the website has with a staff id on it
-- ---------------------------------------------------------------------------------------------------------------
-- { "total": n, "parts": [{ "label": "visits", "one": "visit", "count": 12 }, ...] }: only the columns with rows, most first.
-- Each table is read once (one count per column of it). A table or column that is not there yet has no rows, so it is skipped.
create or replace function public.staff_records(p_staff uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  t record;
  v_sql text;
  v_counts bigint[];
  v_parts jsonb := '[]'::jsonb;
  v_total bigint := 0;
  i integer;
begin
  if not public.has_perm('users.manage') then
    raise exception 'Only Dr. Ali can see what a staff account has on the website' using errcode = '42501';
  end if;
  for t in
    select l.table_name, array_agg(l.column_name order by l.sort) as cols, array_agg(l.label order by l.sort) as labels,
           array_agg(l.one order by l.sort) as ones, array_agg(l.sort order by l.sort) as sorts
      from private.staff_record_columns() l
      join pg_attribute a on a.attrelid = to_regclass('public.' || quote_ident(l.table_name)) and a.attname = l.column_name
                         and a.attnum > 0 and not a.attisdropped
     group by l.table_name
  loop
    select 'select array[' || string_agg(format('count(*) filter (where %I = $1)', c), ', ' order by o) || ']::bigint[] from public.'
           || quote_ident(t.table_name) || ' where ' || string_agg(format('%I = $1', c), ' or ' order by o)
      into v_sql
      from unnest(t.cols) with ordinality as u(c, o);
    execute v_sql into v_counts using p_staff;
    for i in 1 .. array_length(t.cols, 1) loop
      if coalesce(v_counts[i], 0) > 0 then
        v_total := v_total + v_counts[i];
        v_parts := v_parts || jsonb_build_object('label', t.labels[i], 'one', t.ones[i], 'count', v_counts[i], 'sort', t.sorts[i]);
      end if;
    end loop;
  end loop;
  select coalesce(jsonb_agg(p - 'sort' order by (p ->> 'count')::bigint desc, (p ->> 'sort')::integer), '[]'::jsonb)
    into v_parts
    from jsonb_array_elements(v_parts) as p;
  return jsonb_build_object('total', v_total, 'parts', v_parts);
end $$;

revoke all on function public.staff_records(uuid) from public, anon;
grant execute on function public.staff_records(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. The staff guard: as in 20261009000100_staff_guard_id.sql, plus the deleted mark
-- ---------------------------------------------------------------------------------------------------------------
-- Deleting an account and bringing it back go through the admin-users function: it checks users.manage, switches the account
-- off and writes the audit log. A user manager editing the staff table directly must not mark or unmark anyone, themselves
-- included. (The function uses the service role, where auth.uid() is null, so it passes; the admin passes as before.)
create or replace function public.guard_staff_row() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.is_admin() then return new; end if;
  if new.role = 'admin' then raise exception 'Only admin can create or promote admin accounts'; end if;
  if tg_op = 'INSERT' and (new.deleted_at is not null or new.deleted_by is not null) then
    raise exception 'Staff accounts are deleted and brought back with the buttons on Admin -> Staff accounts only';
  end if;
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id then raise exception 'The account id cannot be changed'; end if;
    if old.role = 'admin' then raise exception 'Only admin can change an admin account'; end if;
    if (new.deleted_at, new.deleted_by) is distinct from (old.deleted_at, old.deleted_by) then
      raise exception 'Staff accounts are deleted and brought back with the buttons on Admin -> Staff accounts only';
    end if;
    if old.id = auth.uid() and (new.role, new.active, new.restrict_to_branches, new.branch_ids)
       is distinct from (old.role, old.active, old.restrict_to_branches, old.branch_ids) then
      raise exception 'You cannot change your own role, branches or active flag';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.guard_staff_row() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. The login log: as in 20261007001900_login_log.sql, plus deleted_at, and the name of a login removed for good
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.staff_logins(p_limit int default 200)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare v_staff jsonb; v_events jsonb;
begin
  if not public.is_admin() then raise exception 'Only Dr. Ali can see the login log' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'full_name', s.full_name, 'email', s.email, 'role', s.role, 'active', s.active,
                                               'deleted_at', s.deleted_at,
                                               'last_sign_in_at', u.last_sign_in_at, 'sign_ins_30d', (select count(*) from public.login_events e where e.user_id = s.id and e.at > now() - interval '30 days'))
                            order by u.last_sign_in_at desc nulls last), '[]')
    into v_staff
    from public.staff s left join auth.users u on u.id = s.id;
  -- A login removed for good has no staff row and no login any more: its sign-ins keep the name and role the audit log kept.
  select coalesce(jsonb_agg(x), '[]') into v_events from (
    select jsonb_build_object('at', e.at, 'kind', e.kind,
                              'name', coalesce(s.full_name, p.full_name, u.email, gone.old_data ->> 'full_name'),
                              'role', coalesce(s.role::text, gone.old_data ->> 'role'), 'user_agent', e.user_agent) x
      from public.login_events e
      left join public.staff s on s.id = e.user_id
      left join public.patients p on p.portal_user_id = e.user_id
      left join auth.users u on u.id = e.user_id
      left join lateral (select a.old_data from public.audit_log a
                          where s.id is null and p.id is null and u.id is null
                            and a.table_name = 'staff' and a.action = 'DELETE_LOGIN' and a.row_id = e.user_id::text
                          order by a.id desc limit 1) gone on true
     order by e.at desc limit greatest(1, least(p_limit, 1000))) t;
  return jsonb_build_object('staff', v_staff, 'events', v_events);
end $$;

revoke all on function public.staff_logins(int) from public, anon;
grant execute on function public.staff_logins(int) to authenticated;
