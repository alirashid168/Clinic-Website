-- Tests for the Google Sheet backup export (public.aaj_export).
-- Since 20261009000300 it gives today's or yesterday's list only (Karachi): its secret sits in the old script inside the sheet.
\set ON_ERROR_STOP 1
begin;
create extension if not exists pgcrypto;
insert into private.sync_secrets (name, secret_hash) values ('aaj_sheet_export', encode(digest('export-secret', 'sha256'), 'hex'))
  on conflict (name) do update set secret_hash = excluded.secret_hash;

insert into patients (mr_number, full_name, phone, first_branch_id, legacy_source)
values ('7101', 'Export Test One', '03001112233', (select id from branches where code = 'DHA'), 'test'),
       ('7102', 'Export Test Two', '0000000', (select id from branches where code = 'DHA'), 'test');
insert into visits (patient_id, branch_id, visit_date, token_no, status, treatment_label, details_text, notes, legacy_source)
values ((select id from patients where mr_number = '7101'), (select id from branches where code = 'DHA'), (now() at time zone 'Asia/Karachi')::date, 903, 'in_treatment', 'Monthly', 'Pc', 'Braces month 9 (photo month); Group 3', 'test'),
       ((select id from patients where mr_number = '7102'), (select id from branches where code = 'DHA'), (now() at time zone 'Asia/Karachi')::date, null, 'waiting', 'Checkup', null, null, 'test');
insert into visit_staff (visit_id, clinician_id, role)
select v.id, c.id, 'doctor' from visits v, clinicians c
 where v.visit_date = (now() at time zone 'Asia/Karachi')::date and v.token_no = 903 and v.legacy_source = 'test'
   and c.display_name = (select display_name from clinicians order by display_name limit 1);

do $$
declare res jsonb; dha jsonb; one jsonb; two jsonb; d date := (now() at time zone 'Asia/Karachi')::date; n int;
begin
  begin
    perform public.aaj_export('wrong', d);
    raise exception 'FAIL: wrong secret accepted';
  exception when insufficient_privilege then raise notice 'ok - wrong secret is refused';
  end;

  res := public.aaj_export('export-secret', d);
  if res ->> 'date' <> d::text then raise exception 'FAIL date: %', res ->> 'date'; end if;
  if jsonb_array_length(res -> 'branches') <> (select count(*) from branches where active) then raise exception 'FAIL: every branch should be listed'; end if;
  raise notice 'ok - every branch is listed for the day';
  if (public.aaj_export('export-secret') ->> 'date') <> d::text then raise exception 'FAIL: no date should mean today'; end if;
  raise notice 'ok - no date means today (Karachi)';

  select b into dha from jsonb_array_elements(res -> 'branches') b where b ->> 'code' = 'DHA';
  select r into one from jsonb_array_elements(dha -> 'rows') r where r ->> 'mr' = '7101';
  select r into two from jsonb_array_elements(dha -> 'rows') r where r ->> 'mr' = '7102';
  if one is null or two is null then raise exception 'FAIL DHA rows: %', dha; end if;
  if one ->> 'status' <> 'Treatment' or one ->> 'month' <> '9 Photo' or one ->> 'group' <> 'Group 3'
     or one ->> 'token' <> '903' or one ->> 'doctors' is null or one ->> 'phone' <> '03001112233' then
    raise exception 'FAIL row one: %', one; end if;
  raise notice 'ok - status, braces month, photo month, group, token, doctor and phone come through';
  if two ->> 'phone' is not null or two ->> 'status' <> 'Waiting' then raise exception 'FAIL row two: %', two; end if;
  raise notice 'ok - placeholder phone 0000000 is left blank in the sheet';

  if (select count(*) from visits where visit_date = d and legacy_source = 'test') <> 2 then raise exception 'FAIL: export changed data'; end if;
  raise notice 'ok - the export only reads';

  -- the old secret is not a way into the clinic's history (or its future appointments)
  perform public.aaj_export('export-secret', d - 1);
  raise notice 'ok - yesterday''s list is still given (the old script''s last copy after midnight)';
  foreach d in array array[(now() at time zone 'Asia/Karachi')::date - 2, (now() at time zone 'Asia/Karachi')::date - 400, (now() at time zone 'Asia/Karachi')::date + 1] loop
    begin
      perform public.aaj_export('export-secret', d);
      raise exception 'FAIL: the export gave the list of %', d;
    exception when invalid_parameter_value then
      if sqlerrm not like 'DATE_NOT_ALLOWED%' then raise; end if;
    end;
  end loop;
  raise notice 'ok - any other day (two days ago, last year, tomorrow) is refused: DATE_NOT_ALLOWED';
end $$;

set local role anon;
do $$ begin
  begin perform public.aaj_export(null); raise exception 'FAIL: anon without secret';
  exception when insufficient_privilege then raise notice 'ok - website visitors cannot read the list without the secret'; end;
end $$;
reset role;
rollback;
