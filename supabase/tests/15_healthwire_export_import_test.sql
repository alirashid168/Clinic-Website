-- Import from Healthwire export files: payments are recognised by invoice +
-- amount + minute, so the same file can be dropped twice without doubling
-- income, and a payment already imported the first way is not repeated.
\set ON_ERROR_STOP 1
begin;
select public.import_healthwire('patients', '[["9001","Export Test Patient",null,"03001234567",null,null,"female",null,null,1,"2026-08-02"]]');
select public.import_healthwire('invoices', '[["777001","9001",1,"2026-08-02",30000,0,5,[[1,"Braces Monthly Payment (×2)",1,30000]]]]');
select public.import_healthwire('payments', '[["777001","9001",1,10000,"Cash","2026-08-02 14:10",555001]]');
do $$
declare r jsonb; n int; s numeric;
begin
  -- the first-way payment plus two new ones; the 10,000 at 14:10 is the same one as above
  r := public.import_healthwire('payments_tx', '[["777001","9001",1,10000,"Cash","2026-08-02 14:10"],["777001","9001",1,5000,"Debit/Credit Card","2026-08-20 18:05"],["777001","9001",4,2500.5,"Online Payment","2026-08-31 12:00"]]');
  if (r->>'inserted')::int <> 2 then raise exception 'FAIL: expected 2 new payments, got %', r; end if;
  raise notice 'ok - export payments: already-imported payment skipped, new ones added';

  r := public.import_healthwire('payments_tx', '[["777001","9001",1,5000,"Debit/Credit Card","2026-08-20 18:05"],["777001","9001",4,2500.5,"Online Payment","2026-08-31 12:00"]]');
  if (r->>'inserted')::int <> 0 then raise exception 'FAIL: second drop of the same file added payments: %', r; end if;
  raise notice 'ok - dropping the same export twice adds nothing';

  select count(*), sum(amount) into n, s from public.payments y join public.invoices i on i.id = y.invoice_id where i.invoice_no = '777001';
  if n <> 3 or s <> 17500.5 then raise exception 'FAIL: expected 3 payments totalling 17500.5, got % / %', n, s; end if;
  if not exists (select 1 from public.payments where reference = 'hw-tx-777001-202608311200-2500.5' and branch_id = 4) then raise exception 'FAIL: export reference not as expected'; end if;
  raise notice 'ok - payment references, branches and totals from the export';

  r := public.import_healthwire('payments_tx', '[["777999","9001",1,100,"Cash","2026-08-02 14:10"]]');
  if (r->>'inserted')::int <> 0 or (r->>'missing')::int <> 1 then raise exception 'FAIL: payment for an unknown invoice should be reported missing: %', r; end if;
  raise notice 'ok - a payment whose invoice is not on the website is counted as missing';

  if (select notes from public.invoices where invoice_no = '777001') not like '%outside the exported period%' then raise exception 'FAIL: note code 5 missing'; end if;
  raise notice 'ok - invoice with payments outside the period carries its note';
end $$;
rollback;
