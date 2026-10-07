-- =====================================================================
-- Aaj ki List history import. Dr. Ali downloads the Google Sheet as one
-- .xlsx (a tab per branch) and puts it on Admin → Import; the browser reads
-- every day's rows and sends them here in batches:
--
--   [date, branch_id, mr, name, legacy_name, phone, braces_month, treatment, token, status, group,
--    [doctor clinician ids], [assistant clinician ids], [names not on the list], details, reminder, tab, photo_marked, treatment_id]
--
-- For each row: the patient is found by Mr#, then phone, then an unambiguous
-- name (optionally created when p_create_patients and the row carries an Mr#
-- or a phone); a visit already on that day (from Healthwire) is completed
-- with the sheet's details, doctors, token and braces month, otherwise a
-- visit is added; patients with braces months but no braces case get one.
-- Rows dated today or later belong to the live sheet and are skipped.
-- Running the same file twice adds nothing. Admin only.
-- =====================================================================
create or replace function public.import_aaj_sheet(p_rows jsonb, p_create_patients boolean default false)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_admin uuid;
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  n_future int := 0; n_pat int := 0; n_vis int := 0; n_upd int := 0; n_staff int := 0; n_cases int := 0; n_tok int := 0;
  n_matched int := 0; n_unmatched int := 0;
  v_unmatched jsonb;
  v_cases jsonb;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only Dr. Ali can import the Aaj ki List' using errcode = '42501';
  end if;
  select id into v_admin from public.staff where role = 'admin' order by created_at limit 1;

  -- Temp tables are kept for the session and emptied on every call, so the function can run many times (one batch each).
  create temp table if not exists aaj (
    rn bigint, d date, branch smallint, mr text, name text, legacy_name text, phone text, month smallint, treatment text, token int,
    status public.visit_status, grp smallint, doctors jsonb, assistants jsonb, unmatched jsonb, details text, reminder text, tab text,
    photo boolean, tid smallint, patient_id uuid, visit_id uuid, case_id uuid, dup boolean default false);
  create temp table if not exists aaj_names (nm text, id uuid, c bigint);
  truncate aaj, aaj_names;
  insert into aaj (rn, d, branch, mr, name, legacy_name, phone, month, treatment, token, status, grp, doctors, assistants, unmatched, details, reminder, tab, photo, tid)
    select row_number() over (), (r->>0)::date, (r->>1)::smallint, nullif(btrim(r->>2), ''), btrim(r->>3),
           nullif(r->>4, ''), nullif(r->>5, ''), nullif(r->>6, '')::smallint, nullif(btrim(r->>7), ''),
           nullif(r->>8, '')::int, coalesce(nullif(r->>9, ''), 'completed')::public.visit_status, nullif(r->>10, '')::smallint,
           coalesce(r->11, '[]'), coalesce(r->12, '[]'), coalesce(r->13, '[]'), nullif(r->>14, ''),
           nullif(r->>15, ''), coalesce(r->>16, 'sheet'), coalesce((r->>17)::boolean, false), nullif(r->>18, '')::smallint
      from jsonb_array_elements(p_rows) r
     where btrim(coalesce(r->>3, '')) <> '' and (r->>0)::date < v_today;
  -- Rows dated today or later belong to the live sheet.
  select count(*) into n_future from jsonb_array_elements(p_rows) r where btrim(coalesce(r->>3, '')) <> '' and (r->>0)::date >= v_today;

  -- 1. Who is the patient: Mr#, then phone, then a name only one patient has.
  update aaj a set patient_id = p.id from public.patients p where a.mr is not null and p.mr_number = a.mr;
  update aaj a set patient_id = (
      select p.id from public.patients p where p.phone = a.phone or p.phone_alt = a.phone
       order by (lower(p.full_name) = lower(a.name)) desc, p.created_at limit 1)
   where a.patient_id is null and a.phone is not null;
  insert into aaj_names select lower(full_name), min(id::text)::uuid, count(*) from public.patients group by lower(full_name);
  update aaj a set patient_id = n.id from aaj_names n where a.patient_id is null and n.nm = lower(a.name) and n.c = 1;

  -- 2. Unknown patients: added only when asked and only when the row carries an Mr# or a phone.
  if p_create_patients then
    with grp as (
      select coalesce(mr, '~' || lower(name) || '|' || coalesce(phone, '')) k, min(rn) rn, min(d) first_d
        from aaj where patient_id is null and (mr is not null or phone is not null) group by 1),
    ins as (
      insert into public.patients (mr_number, full_name, phone, first_branch_id, legacy_source, legacy_name, notes, created_at)
      select a.mr, a.name, a.phone, a.branch, 'aaj_ki_list', coalesce(a.legacy_name, a.name),
             'Added from the Aaj ki List (' || a.tab || ', first seen ' || to_char(g.first_d, 'DD Mon YYYY') || ')', g.first_d::timestamptz
        from grp g join aaj a on a.rn = g.rn
       where a.mr is null or not exists (select 1 from public.patients p where p.mr_number = a.mr)
      returning 1)
    select count(*) into n_pat from ins;
    update aaj a set patient_id = p.id from public.patients p where a.patient_id is null and a.mr is not null and p.mr_number = a.mr;
    update aaj a set patient_id = (
        select p.id from public.patients p where p.phone = a.phone
         order by (lower(p.full_name) = lower(a.name)) desc, p.created_at limit 1)
     where a.patient_id is null and a.phone is not null;
  end if;

  select count(distinct patient_id), count(*) filter (where patient_id is null) into n_matched, n_unmatched from aaj;
  -- (the dedupe below only marks rows; counts above are per sheet row)
  select coalesce(jsonb_agg(x), '[]') into v_unmatched from (
    select jsonb_build_object('name', name, 'mr', mr, 'phone', phone, 'rows', count(*), 'first', min(d), 'last', max(d), 'tab', min(tab)) x
      from aaj where patient_id is null group by name, mr, phone order by count(*) desc, name limit 300) s;

  -- 3. Two rows for the same patient on the same day become one visit.
  update aaj a set
    details = concat_ws(' · ', a.details, (select string_agg(concat_ws(' ', o.treatment, o.details), ' · ' order by o.rn) from aaj o where o.patient_id = a.patient_id and o.d = a.d and o.rn <> a.rn)),
    doctors = a.doctors || coalesce((select jsonb_agg(x) from aaj o, jsonb_array_elements(o.doctors) x where o.patient_id = a.patient_id and o.d = a.d and o.rn <> a.rn), '[]'),
    assistants = a.assistants || coalesce((select jsonb_agg(x) from aaj o, jsonb_array_elements(o.assistants) x where o.patient_id = a.patient_id and o.d = a.d and o.rn <> a.rn), '[]'),
    unmatched = a.unmatched || coalesce((select jsonb_agg(x) from aaj o, jsonb_array_elements(o.unmatched) x where o.patient_id = a.patient_id and o.d = a.d and o.rn <> a.rn), '[]'),
    month = coalesce(a.month, (select max(o.month) from aaj o where o.patient_id = a.patient_id and o.d = a.d)),
    token = coalesce(a.token, (select min(o.token) from aaj o where o.patient_id = a.patient_id and o.d = a.d))
  where a.patient_id is not null
    and a.rn = (select min(o.rn) from aaj o where o.patient_id = a.patient_id and o.d = a.d)
    and exists (select 1 from aaj o where o.patient_id = a.patient_id and o.d = a.d and o.rn <> a.rn);
  update aaj a set dup = true where a.patient_id is not null and a.rn > (select min(o.rn) from aaj o where o.patient_id = a.patient_id and o.d = a.d);

  -- 4. Braces case for the month rows: the active one, else the case running on that date, else a new one from the history.
  update aaj a set case_id = (select b.id from public.braces_cases b where b.patient_id = a.patient_id and b.status = 'active' limit 1)
   where a.month is not null and a.patient_id is not null and not a.dup;
  update aaj a set case_id = (select b.id from public.braces_cases b where b.patient_id = a.patient_id and b.start_date <= a.d + 7 order by b.start_date desc limit 1)
   where a.month is not null and a.patient_id is not null and a.case_id is null;
  with hist as (
    select a.patient_id,
           min(a.d - ((a.month - 1) * interval '30 days'))::date start_d,
           (array_agg(a.branch order by a.month, a.d))[1] branch,
           min(a.d) first_d, max(a.d) last_d
      from aaj a where a.month is not null and a.patient_id is not null and a.case_id is null and not a.dup
     group by a.patient_id),
  ends as (
    select h.*, (select min(x.d) from (
                   select v.visit_date d from public.visits v where v.patient_id = h.patient_id and v.visit_date >= h.last_d and coalesce(v.treatment_label, '') ~* 'braces off|debond|retainer'
                   union all
                   select a.d from aaj a where a.patient_id = h.patient_id and a.d >= h.last_d and coalesce(a.treatment, '') ~* 'braces off|debond|retainer') x) debond_d
      from hist h),
  ins as (
    insert into public.braces_cases (patient_id, start_date, bonding_branch_id, status, debond_date, notes, created_by)
    select e.patient_id, e.start_d, e.branch,
           case when e.debond_d is not null then 'debonded' when e.last_d >= v_today - 75 then 'active' else 'discontinued' end::public.braces_case_status,
           e.debond_d,
           'From the Aaj ki List history: month rows from ' || to_char(e.first_d, 'DD Mon YYYY') || ' to ' || to_char(e.last_d, 'DD Mon YYYY')
             || case when e.debond_d is not null then '; braces off ' || to_char(e.debond_d, 'DD Mon YYYY')
                     when e.last_d >= v_today - 75 then '' else '; no entry since then — check whether treatment continues' end,
           v_admin
      from ends e
     where not exists (select 1 from public.braces_cases b where b.patient_id = e.patient_id and b.status = 'active')
    returning id, patient_id, status)
  select coalesce(sum(c), 0), coalesce(jsonb_object_agg(s, c), '{}') into n_cases, v_cases from (select status s, count(*) c from ins group by status) t;
  update aaj a set case_id = (select b.id from public.braces_cases b where b.patient_id = a.patient_id order by (b.status = 'active') desc, b.start_date desc limit 1)
   where a.month is not null and a.patient_id is not null and a.case_id is null;
  -- A case made from an earlier batch of old rows was marked "discontinued"; rows in this batch show treatment continues.
  update public.braces_cases b set status = 'active', notes = concat_ws(' · ', b.notes, 'Entries continue to ' || to_char(m.last_d, 'DD Mon YYYY'))
    from (select a.case_id, max(a.d) last_d from aaj a where a.case_id is not null and not a.dup and a.month is not null group by a.case_id) m
   where b.id = m.case_id and b.status = 'discontinued' and b.notes like 'From the Aaj ki List history%' and m.last_d >= v_today - 75
     and not exists (select 1 from public.braces_cases x where x.patient_id = b.patient_id and x.status = 'active');

  -- 5. The visit: complete the one already there for that day, otherwise add it.
  update aaj a set visit_id = (select v.id from public.visits v where v.patient_id = a.patient_id and v.visit_date = a.d order by (v.branch_id = a.branch) desc, v.created_at limit 1)
   where a.patient_id is not null and not a.dup;
  with upd as (
    update public.visits v set
      treatment_label = coalesce(v.treatment_label, a.treatment),
      treatment_id = coalesce(v.treatment_id, a.tid),
      details_text = coalesce(nullif(v.details_text, ''), a.details),
      braces_case_id = coalesce(v.braces_case_id, a.case_id),
      braces_month = coalesce(v.braces_month, case when coalesce(v.braces_case_id, a.case_id) is not null then a.month end),
      doctor_group_id = coalesce(v.doctor_group_id, a.grp),
      protocol_override_by = coalesce(v.protocol_override_by, v_admin),
      protocol_override_reason = coalesce(v.protocol_override_reason, 'Imported from the Aaj ki List'),
      notes = concat_ws(' · ', v.notes, 'Aaj ki List (' || a.tab || ')',
                case when a.month is not null and coalesce(v.braces_case_id, a.case_id) is null then 'Month ' || a.month end,
                case when a.treatment is not null and v.treatment_label is not null and lower(v.treatment_label) <> lower(a.treatment) then 'Sheet: ' || a.treatment end,
                case when jsonb_array_length(a.unmatched) > 0 then 'Also: ' || (select string_agg(x, ', ') from jsonb_array_elements_text(a.unmatched) x) end,
                case when a.reminder is not null then 'Reminder: ' || a.reminder end)
      from aaj a
     where v.id = a.visit_id and not a.dup and (v.notes is null or v.notes not like '%Aaj ki List (%')
    returning 1)
  select count(*) into n_upd from upd;
  with ins as (
    insert into public.visits (patient_id, branch_id, visit_date, status, treatment_id, treatment_label, braces_case_id, braces_month, doctor_group_id, details_text, notes,
                               legacy_source, protocol_override_by, protocol_override_reason, dues_override_by, dues_override_reason, completed_at, created_at, created_by)
    select a.patient_id, a.branch, a.d, a.status, a.tid, a.treatment, a.case_id, case when a.case_id is not null then a.month end, a.grp, a.details,
           concat_ws(' · ', 'Aaj ki List (' || a.tab || ')',
             case when a.month is not null and a.case_id is null then 'Month ' || a.month end,
             case when jsonb_array_length(a.unmatched) > 0 then 'Also: ' || (select string_agg(x, ', ') from jsonb_array_elements_text(a.unmatched) x) end,
             case when a.reminder is not null then 'Reminder: ' || a.reminder end),
           'aaj_ki_list', v_admin, 'Imported from the Aaj ki List', v_admin, 'Imported from the Aaj ki List',
           case when a.status = 'completed' then a.d + time '20:00' end, a.d::timestamptz, v_admin
      from aaj a where a.patient_id is not null and a.visit_id is null and not a.dup
    returning 1)
  select count(*) into n_vis from ins;
  update aaj a set visit_id = (select v.id from public.visits v where v.patient_id = a.patient_id and v.visit_date = a.d order by (v.branch_id = a.branch) desc, v.created_at limit 1)
   where a.patient_id is not null and a.visit_id is null and not a.dup;

  -- 6. Token numbers (first row wins when a day repeats one) and the people on the visit.
  with upd as (
    update public.visits v set token_no = a.token from aaj a
     where v.id = a.visit_id and not a.dup and v.token_no is null and a.token is not null
       and a.rn = (select min(o.rn) from aaj o where o.branch = a.branch and o.d = a.d and o.token = a.token and not o.dup)
       and not exists (select 1 from public.visits x where x.branch_id = v.branch_id and x.visit_date = v.visit_date and x.token_no = a.token)
    returning 1)
  select count(*) into n_tok from upd;
  with ins as (
    insert into public.visit_staff (visit_id, clinician_id, role)
    select distinct a.visit_id, (x #>> '{}')::uuid, 'doctor'::public.visit_staff_role from aaj a, jsonb_array_elements(a.doctors) x
     where a.visit_id is not null and not a.dup and exists (select 1 from public.clinicians c where c.id = (x #>> '{}')::uuid)
    union
    select distinct a.visit_id, (x #>> '{}')::uuid, 'assistant'::public.visit_staff_role from aaj a, jsonb_array_elements(a.assistants) x
     where a.visit_id is not null and not a.dup and exists (select 1 from public.clinicians c where c.id = (x #>> '{}')::uuid)
    on conflict do nothing
    returning 1)
  select count(*) into n_staff from ins;

  return jsonb_build_object('given', jsonb_array_length(p_rows), 'future', n_future, 'patients_matched', n_matched, 'rows_unmatched', n_unmatched,
    'patients_created', n_pat, 'visits_inserted', n_vis, 'visits_updated', n_upd, 'tokens', n_tok, 'staff_added', n_staff,
    'cases_created', n_cases, 'cases', v_cases, 'unmatched', v_unmatched);
end $$;

revoke all on function public.import_aaj_sheet(jsonb, boolean) from public, anon;
grant execute on function public.import_aaj_sheet(jsonb, boolean) to authenticated;
