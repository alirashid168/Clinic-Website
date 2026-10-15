-- =============================================================================
-- The invoice note: a line the front desk writes on the patient's bill ("Invoice note" on Healthwire's Create Invoice).
--
-- The owner (Dr. Ali, 15 Oct 2026, at the North Nazimabad front desk): the invoice form on the Aaj ki List, like Healthwire's,
-- with an invoice note, a payment taken in the same dialog and the printed bill for the patient.
--
-- invoices.notes has been there since the first schema; save_invoice (20261007002000_audit_fixes.sql) did not write it. This is
-- the same function with notes in the insert, nothing else changed: the idempotency key, the hash of the details (the note is part
-- of them, so a retry with another note is refused like one with another price), the discount rules and row-level security all
-- stay as they were. Until this runs the website still saves invoices; only the note is not kept.
--
-- Additive and safe to run more than once, also after 20261015000900_billing_desk.sql: that file writes save_invoice again with the
-- note and each line's discount, price-list item and doctor, and once it is in this file changes nothing (it says so and stops), so
-- pasting this file a second time never takes those back. Order on live: this file, then 20261015000900_billing_desk.sql.
-- HOW TO APPLY: Supabase dashboard -> SQL Editor -> paste this whole file -> Run.
-- =============================================================================
begin;

do $guard$
begin
  -- 20261015000900_billing_desk.sql is in already (its save_invoice writes each line's doctor, clinician_id): leave it alone.
  if position('clinician_id' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.save_invoice(uuid, jsonb, jsonb)')), '')) > 0 then
    raise notice 'save_invoice is already the billing desk''s (20261015000900_billing_desk.sql), which keeps the note too: nothing to change.';
    return;
  end if;
  execute $create$
create or replace function public.save_invoice(p_idempotency_key uuid, p_invoice jsonb, p_items jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_head public.invoices%rowtype;
  v_inv  public.invoices%rowtype;
  v_subtotal numeric;
  v_prev text;
  v_prev_hash text;
  v_hash text;
  v_rows integer;
  v_out  jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'An invoice needs at least one line.';
  end if;

  -- jsonb text is normalised (key order, spacing), so the same details always give the same hash.
  v_hash := md5(jsonb_build_object('invoice', p_invoice, 'items', p_items)::text);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (key, kind, request_hash) values (p_idempotency_key, 'invoice', v_hash)
      on conflict (key) do nothing;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      -- Saved already (an earlier attempt whose answer never arrived): return that invoice,
      -- unless this retry carries different details (then the earlier invoice is NOT what was asked for).
      select k.result_id, k.request_hash into v_prev, v_prev_hash from public.idempotency_keys k
        where k.key = p_idempotency_key and k.kind = 'invoice';
      if v_prev is null then
        raise exception 'This invoice was already saved. Refresh the page to see it.';
      end if;
      select to_jsonb(inv) || jsonb_build_object('items', coalesce(
               (select jsonb_agg(to_jsonb(it)) from public.invoice_items it where it.invoice_id = inv.id), '[]'::jsonb))
        into v_out
        from public.invoices inv where inv.id::text = v_prev;
      if v_out is null then
        raise exception 'This invoice was already saved. Refresh the page to see it.';
      end if;
      if v_prev_hash is not null and v_prev_hash <> v_hash then
        raise exception 'IDEMPOTENCY_MISMATCH: an earlier attempt already saved invoice % with different details. Refresh the patient record and check it (void it if it is wrong) before saving again.', v_out->>'invoice_no';
      end if;
      return v_out;
    end if;
  end if;

  v_head := jsonb_populate_record(null::public.invoices, p_invoice);
  select coalesce(sum(coalesce(i.quantity, 1) * coalesce(i.unit_price, 0)), 0) into v_subtotal
    from jsonb_populate_recordset(null::public.invoice_items, p_items) i;

  insert into public.invoices (patient_id, branch_id, visit_id, subtotal, discount_amount, discount_reason, notes, status)
  values (v_head.patient_id, v_head.branch_id, v_head.visit_id, v_subtotal,
          coalesce(v_head.discount_amount, 0), v_head.discount_reason, nullif(btrim(v_head.notes), ''), 'draft')
  returning * into v_inv;

  insert into public.invoice_items (invoice_id, description, quantity, unit_price)
  select v_inv.id, i.description, coalesce(i.quantity, 1), i.unit_price
    from jsonb_populate_recordset(null::public.invoice_items, p_items) i;

  if v_inv.status::text = 'draft' then
    update public.invoices set status = 'issued' where id = v_inv.id;
  end if;

  if p_idempotency_key is not null then
    update public.idempotency_keys set result_id = v_inv.id::text where key = p_idempotency_key;
  end if;

  select to_jsonb(inv) || jsonb_build_object('items', coalesce(
           (select jsonb_agg(to_jsonb(it)) from public.invoice_items it where it.invoice_id = inv.id), '[]'::jsonb))
    into v_out
    from public.invoices inv where inv.id = v_inv.id;
  return v_out;
end;
$$
$create$;
  execute 'revoke all on function public.save_invoice(uuid, jsonb, jsonb) from public, anon';
  execute 'grant execute on function public.save_invoice(uuid, jsonb, jsonb) to authenticated';
end
$guard$;

commit;

-- Tell the API about the changed function straight away.
notify pgrst, 'reload schema';
