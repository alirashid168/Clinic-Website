-- Tests for the Google Sheet backup export (public.aaj_export).
\set ON_ERROR_STOP 1
begin;
create extension if not exists pgcrypto;
insert into private.sync_secrets (name, secret_hash) values ('aaj_sheet_export', encode(digest('export-secret', 'sha256'), 'hex'))
  on conflict (name) do update set secret_hash = excluded.secret_hash;

insert into patients (mr_number, full_name, phone, first_branch_id, legacy_source)
values ('7101', 'Export Test One', '03001112233', (select id from branches where code = 'DHA'), 'test'),
       ('7102', 'Export Test Two', '0000000', (select id from branches where code = 'DHA'), 'test');
insert into visits (patient_id, branch_id, visit_date, token_no, status, treatment_label, details_text, notes, legacy_source)
values ((select id from patients where mr_number = '7101'), (select id from branches where code = 'DHA'), '2030-01-07', 3, 'in_treatment', 'Monthly', 'Pc', 'Braces month 9 (photo month); Group 3', 'test'),
       ((select id from patients where mr_number = '7102'), (select id from branches where code = 'DHA'), '2030-01-07', null, 'waiting', 'Checkup', null, null, 'test');
insert into visit_staff (visit_id, clinician_id, role)
select v.id, c.id, 'doctor' from visits v, clinicians c
 where v.visit_date = '2030-01-07' and v.token_no = 3 and c.display_name = (select display_name from clinicians order by display_name limit 1);

do $$
declare res jsonb; dha jsonb; one jsonb; two jsonb;
begin
  begin
    perform public.aaj_export('wrong', '2030-01-07');
    raise exception 'FAIL: wrong secret accepted';
  exception when insufficient_privilege then raise notice 'ok - wrong secret is refused';
  end;

  res := public.aaj_export('export-secret', '2030-01-07');
  if res ->> 'date' <> '2030-01-07' then raise exception 'FAIL date: %', res ->> 'date'; end if;
  if jsonb_array_length(res -> 'branches') <> (select count(*) from branches where active) then raise exception 'FAIL: every branch should be listed'; end if;
  raise notice 'ok - every branch is listed for the day';

  select b into dha from jsonb_array_elements(res -> 'branches') b where b ->> 'code' = 'DHA';
  if jsonb_array_length(dha -> 'rows') <> 2 then raise exception 'FAIL DHA rows: %', dha; end if;
  one := dha -> 'rows' -> 0; two := dha -> 'rows' -> 1;
  if one ->> 'mr' <> '7101' or one ->> 'status' <> 'Treatment' or one ->> 'month' <> '9 Photo' or one ->> 'group' <> 'Group 3'
     or one ->> 'token' <> '3' or one ->> 'doctors' is null or one ->> 'phone' <> '03001112233' then
    raise exception 'FAIL row one: %', one; end if;
  raise notice 'ok - status, braces month, photo month, group, token, doctor and phone come through';
  if two ->> 'phone' is not null or two ->> 'status' <> 'Waiting' then raise exception 'FAIL row two: %', two; end if;
  raise notice 'ok - placeholder phone 0000000 is left blank in the sheet';

  if (select count(*) from visits where visit_date = '2030-01-07') <> 2 then raise exception 'FAIL: export changed data'; end if;
  raise notice 'ok - the export only reads';
end $$;

set local role anon;
do $$ begin
  begin perform public.aaj_export(null); raise exception 'FAIL: anon without secret';
  exception when insufficient_privilege then raise notice 'ok - website visitors cannot read the list without the secret'; end;
end $$;
reset role;
rollback;
