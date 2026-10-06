-- =====================================================================
-- Backup copy of the website's Aaj ki List into the "Aj ki List" Google
-- Sheet. A Google Apps Script in the sheet calls public.aaj_export() every
-- minute and writes each branch's day into its own "Website - ..." tab.
--
-- Read-only: this function never changes any data.
-- Needs a secret; only its SHA-256 hash is stored (private.sync_secrets).
-- =====================================================================

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.sync_secrets (
  name        text primary key,
  secret_hash text not null,
  created_at  timestamptz not null default now()
);

create or replace function public.aaj_export(p_secret text, p_date date default null)
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare v_date date := coalesce(p_date, (now() at time zone 'Asia/Karachi')::date);
begin
  if p_secret is null or not exists (
       select 1 from private.sync_secrets where name = 'aaj_sheet_export' and secret_hash = encode(digest(p_secret, 'sha256'), 'hex')) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'date', v_date,
    'generated_at', to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM-DD HH24:MI'),
    'branches', coalesce((
      select jsonb_agg(jsonb_build_object('code', b.code, 'name', b.name, 'rows', coalesce(rows.list, '[]'::jsonb)) order by b.sort_order)
        from branches b
        left join lateral (
          select jsonb_agg(jsonb_build_object(
                   'mr', p.mr_number,
                   'name', p.full_name,
                   'month', coalesce(v.braces_month::text, (regexp_match(coalesce(v.notes, ''), 'Braces month (\d+)'))[1])
                            || case when v.photo_required or coalesce(v.notes, '') ~ 'photo month' then ' Photo' else '' end,
                   'treatment', coalesce(v.treatment_label, t.name),
                   'token', v.token_no,
                   'status', case v.status when 'waiting' then 'Waiting' when 'in_treatment' then 'Treatment' when 'completed' then 'Completed'
                                           when 'scheduled' then 'Scheduled' when 'cancelled' then 'Cancelled' when 'no_show' then 'No show' end,
                   'group', coalesce(g.name, (regexp_match(coalesce(v.notes, ''), '(Group [\d, ]+)'))[1]),
                   'doctors', (select string_agg(c.display_name, ', ' order by vs.role, c.display_name)
                                 from visit_staff vs join clinicians c on c.id = vs.clinician_id
                                where vs.visit_id = v.id and vs.role in ('doctor', 'assistant')),
                   'details', v.details_text,
                   'pp', nullif(public.patient_dues(p.id), 0),
                   'phone', nullif(p.phone, '0000000'),
                   'notes', v.notes)
                 order by (v.status = 'cancelled'), v.token_no nulls last, v.created_at) as list
            from visits v
            join patients p on p.id = v.patient_id
            left join treatments t on t.id = v.treatment_id
            left join doctor_groups g on g.id = v.doctor_group_id
           where v.branch_id = b.id and v.visit_date = v_date
        ) rows on true
       where b.active), '[]'::jsonb));
end $$;

revoke all on function public.aaj_export(text, date) from public;
grant execute on function public.aaj_export(text, date) to anon, authenticated;
