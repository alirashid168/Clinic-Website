-- =====================================================================
-- Healthwire import, round two: rows now come from Healthwire's own export
-- files (Transactions Report.xlsx, Patients.xlsx, Expenses Report.pdf) that
-- Dr. Ali drops on Admin → Import. Two additions to import_healthwire():
--
--   'payments_tx' : [ref, mr, branch, amount, healthwire_mode, "YYYY-MM-DD HH24:MI"]
--                   The export has no Healthwire payment id, so a payment is
--                   recognised by invoice + amount + minute. Rows already there
--                   (from either import) are skipped.
--   note code 5   : some payments for this invoice fall outside the exported
--                   period; the invoice is dated from its first payment in the file.
-- Everything else is unchanged (see 20261007000100).
-- =====================================================================
create or replace function public.import_healthwire(p_kind text, p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_admin uuid;
  v_ins int := 0; v_upd int := 0; v_items int := 0; v_missing int := 0;
  function_mode constant jsonb := '{"Cash":"cash","Debit/Credit Card":"card","Online Payment":"bank_transfer","Cheque":"cheque","Easy Paisa/Jazz Cash":"other","Foodpanda":"other","Wallet":"other"}';
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only Dr. Ali can import Healthwire data' using errcode = '42501';
  end if;
  select id into v_admin from public.staff where role = 'admin' order by created_at limit 1;

  if p_kind = 'patients' then
    create temp table hw_p on commit drop as
      select r->>0 mr, r->>1 name, r->>2 legacy, r->>3 phone, r->>4 phone2, nullif(r->>5, '') email, r->>6 gender,
             (r->>7)::date dob, r->>8 address, (r->>9)::smallint branch, (r->>10)::date created
        from jsonb_array_elements(p_rows) r;
    with upd as (
      update public.patients p set
        phone = coalesce(p.phone, hw.phone),
        phone_alt = coalesce(p.phone_alt, case when hw.phone is not null and p.phone is not null and p.phone <> hw.phone then hw.phone else hw.phone2 end),
        email = coalesce(p.email, hw.email),
        gender = coalesce(p.gender, hw.gender),
        date_of_birth = coalesce(p.date_of_birth, hw.dob),
        address = coalesce(p.address, hw.address),
        first_branch_id = coalesce(p.first_branch_id, hw.branch),
        legacy_source = coalesce(p.legacy_source, 'healthwire'),
        notes = case when p.notes = 'Phone missing on Aaj ki List, please add from Healthwire' and (p.phone is not null or hw.phone is not null) then null else p.notes end
      from hw_p hw where p.mr_number = hw.mr returning 1)
    select count(*) into v_upd from upd;
    with ins as (
      insert into public.patients (mr_number, full_name, phone, phone_alt, email, gender, date_of_birth, address, first_branch_id, legacy_source, legacy_name, created_at)
      select hw.mr, hw.name, hw.phone, hw.phone2, hw.email, hw.gender, hw.dob, hw.address, hw.branch, 'healthwire', coalesce(hw.legacy, hw.name), coalesce(hw.created::timestamptz, now())
        from hw_p hw where not exists (select 1 from public.patients p where p.mr_number = hw.mr) returning 1)
    select count(*) into v_ins from ins;

  elsif p_kind = 'invoices' then
    create temp table hw_i on commit drop as
      select r->>0 ref, r->>1 mr, (r->>2)::smallint branch, (r->>3)::date d, (r->>4)::numeric sub, (r->>5)::numeric disc,
             'Healthwire invoice #' || (r->>0) || case (r->>6)::int
               when 1 then ' · Healthwire login: North Nazimabad Clinic'
               when 2 then ' · Branch not recorded on Healthwire (entered by accounts); taken from patient name'
               when 3 then ' · Branch not recorded on Healthwire (entered by accounts); taken from other invoices'
               when 4 then ' · Branch not recorded on Healthwire (entered by accounts); assumed Gulshan'
               when 5 then ' · Some payments fall outside the exported period; dated from its first payment in the export'
               else '' end notes,
             r->7 items
        from jsonb_array_elements(p_rows) r;
    select count(*) into v_missing from hw_i hw where not exists (select 1 from public.patients p where p.mr_number = hw.mr);
    create temp table hw_ins on commit drop as
      with ins as (
        insert into public.invoices (invoice_no, patient_id, branch_id, issue_date, subtotal, discount_amount, status, notes, legacy_source, created_at)
        select hw.ref, p.id, hw.branch, hw.d, hw.sub, hw.disc, 'issued', hw.notes, 'healthwire', hw.d::timestamptz
          from hw_i hw join public.patients p on p.mr_number = hw.mr
         where not exists (select 1 from public.invoices i where i.invoice_no = hw.ref) returning id, invoice_no)
      select * from ins;
    select count(*) into v_ins from hw_ins;
    with it as (
      insert into public.invoice_items (invoice_id, treatment_id, description, quantity, unit_price)
      select ins.id, nullif(i->>0, '')::smallint, i->>1, coalesce((i->>2)::numeric, 1), (i->>3)::numeric
        from hw_i hw join hw_ins ins on ins.invoice_no = hw.ref
        cross join lateral jsonb_array_elements(hw.items) with ordinality as x(i, k)
       order by hw.ref, x.k returning 1)
    select count(*) into v_items from it;

  elsif p_kind = 'payments' then
    with hw as (
      select r->>0 ref, r->>1 mr, (r->>2)::smallint branch, (r->>3)::numeric amount,
             coalesce(function_mode->>(r->>4), 'other')::public.payment_method method,
             ((r->>5) || ':00+05')::timestamptz at, 'hw-pay-' || (r->>6) reference, 'Healthwire: ' || (r->>4) notes
        from jsonb_array_elements(p_rows) r),
    ins as (
      insert into public.payments (patient_id, invoice_id, branch_id, amount, method, received_at, reference, notes, legacy_source)
      select p.id, i.id, hw.branch, hw.amount, hw.method, hw.at, hw.reference, hw.notes, 'healthwire'
        from hw join public.patients p on p.mr_number = hw.mr join public.invoices i on i.invoice_no = hw.ref
       where not exists (select 1 from public.payments y where y.reference = hw.reference) returning 1)
    select count(*) into v_ins from ins;

  elsif p_kind = 'payments_tx' then
    with hw as (
      select r->>0 ref, r->>1 mr, (r->>2)::smallint branch, (r->>3)::numeric amount,
             coalesce(function_mode->>(r->>4), 'other')::public.payment_method method,
             ((r->>5) || ':00+05')::timestamptz at, 'Healthwire: ' || (r->>4) notes
        from jsonb_array_elements(p_rows) r),
    hw2 as (
      select hw.*, 'hw-tx-' || hw.ref || '-' || to_char(hw.at at time zone 'Asia/Karachi', 'YYYYMMDDHH24MI') || '-' || trim(trailing '.' from trim(trailing '0' from hw.amount::text)) reference
        from hw),
    ins as (
      insert into public.payments (patient_id, invoice_id, branch_id, amount, method, received_at, reference, notes, legacy_source)
      select p.id, i.id, hw.branch, hw.amount, hw.method, hw.at, hw.reference, hw.notes, 'healthwire'
        from hw2 hw join public.patients p on p.mr_number = hw.mr join public.invoices i on i.invoice_no = hw.ref
       where not exists (select 1 from public.payments y where y.reference = hw.reference)
         and not exists (select 1 from public.payments y where y.invoice_id = i.id and y.amount = hw.amount and y.received_at = hw.at)
       returning 1)
    select count(*) into v_ins from ins;
    select count(*) into v_missing from jsonb_array_elements(p_rows) r where not exists (select 1 from public.invoices i where i.invoice_no = r->>0);

  elsif p_kind = 'visits' then
    with hw as (
      select r->>0 mr, (r->>1)::date d, (r->>2)::smallint branch, nullif(r->>3, '')::smallint tid, r->>4 label, r->>5 details,
             'Healthwire invoice ' || (select string_agg('#' || x, ', ') from jsonb_array_elements_text(r->6) x) notes
        from jsonb_array_elements(p_rows) r),
    ins as (
      insert into public.visits (patient_id, branch_id, visit_date, status, treatment_id, treatment_label, details_text, notes, legacy_source, protocol_override_by, completed_at, created_at)
      select p.id, hw.branch, hw.d, 'completed', hw.tid, hw.label, hw.details, hw.notes, 'healthwire', v_admin, hw.d + time '20:00', hw.d::timestamptz
        from hw join public.patients p on p.mr_number = hw.mr
       where not exists (select 1 from public.visits v where v.patient_id = p.id and v.visit_date = hw.d) returning 1)
    select count(*) into v_ins from ins;

  elsif p_kind = 'categories' then
    with ins as (
      insert into public.expense_categories (name, sort_order)
      select x.n, 50 from jsonb_array_elements_text(p_rows) x(n)
       where not exists (select 1 from public.expense_categories c where c.name = x.n) returning 1)
    select count(*) into v_ins from ins;

  elsif p_kind = 'expenses' then
    with hw as (
      select (r->>0)::date d, (r->>1)::smallint branch, (r->>2)::smallint city, r->>3 cat, (r->>4)::numeric amount,
             coalesce(function_mode->>(r->>5), 'other')::public.payment_method method,
             (r->>6) || ' (Healthwire voucher #' || (r->>7) || ', ' || (r->>8) || ', by ' || (r->>9) || ')' notes,
             'hw-exp-' || (r->>7) ref, case when r->>10 is null then null else ((r->>10) || ':00+05')::timestamptz end created
        from jsonb_array_elements(p_rows) r),
    ins as (
      insert into public.expenses (expense_date, branch_id, city_id, category_id, amount, method, receipt_path, notes, legacy_source, created_at)
      select hw.d, hw.branch, hw.city, c.id, hw.amount, hw.method, hw.ref, hw.notes, 'healthwire', coalesce(hw.created, hw.d::timestamptz)
        from hw join public.expense_categories c on c.name = hw.cat
       where not exists (select 1 from public.expenses x where x.receipt_path = hw.ref) returning 1)
    select count(*) into v_ins from ins;
    select count(*) into v_missing from jsonb_array_elements(p_rows) r where not exists (select 1 from public.expense_categories c where c.name = r->>3);

  else
    raise exception 'Unknown kind %', p_kind;
  end if;

  return jsonb_build_object('kind', p_kind, 'given', jsonb_array_length(p_rows), 'inserted', v_ins, 'updated', v_upd, 'items', v_items, 'missing', v_missing);
end $$;

revoke all on function public.import_healthwire(text, jsonb) from public, anon;
grant execute on function public.import_healthwire(text, jsonb) to authenticated;
