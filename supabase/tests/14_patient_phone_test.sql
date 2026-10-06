-- A patient may have no phone number; a filled-in number must be real.
\set ON_ERROR_STOP 1
begin;
insert into patients (mr_number, full_name, phone, legacy_source) values ('7201', 'No Phone Patient', null, 'test');
do $$ begin
  if (select phone from patients where mr_number = '7201') is not null then raise exception 'FAIL: empty phone should stay empty'; end if;
  raise notice 'ok - a patient can be saved without a phone number';
  begin
    insert into patients (mr_number, full_name, phone, legacy_source) values ('7202', 'Short Phone', '123', 'test');
    raise exception 'FAIL: a 3-digit phone was accepted';
  exception when check_violation then raise notice 'ok - a too-short number is still refused';
  end;
  if exists (select 1 from public.find_possible_duplicates('Someone Else', '')) then raise exception 'FAIL: empty phones matched as duplicates'; end if;
  raise notice 'ok - patients without numbers are not flagged as duplicates of each other';
end $$;
rollback;
