-- =====================================================================
-- Compact text front-end for public.import_healthwire(): one row per line,
-- fields separated by '|', empty field = null. Used to carry the Healthwire
-- data over with the least typing. Admin only (same check as the jsonb one).
--
--   patients : mr|name|legacy name|phone|phone 2|email|f/m/o|dob|address|branch|registered
--   invoices : first line = item dictionary "name^treatment_id;name^treatment_id;..."
--              then ref|mr|branch|date|subtotal|discount|note code|items  (items: idx^qty^unit;idx^qty^unit)
--   payments : ref|branch|amount|mode letter|YYYY-MM-DD HH24:MI|healthwire payment id   (C cash, D card, O online, Q cheque, E easypaisa, F foodpanda, W wallet)
--   visits   : mr|date|branch|refs (comma separated) — treatment, label and details come from the imported invoice items
--   expenses : date|branch|city|category|amount|mode letter|description|voucher|healthwire category|entered by|YYYY-MM-DD HH24:MI
-- =====================================================================
create or replace function public.import_healthwire_text(p_kind text, p_text text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_rows jsonb := '[]'::jsonb;
  v_dict jsonb := '{}'::jsonb;   -- idx -> [name, treatment_id]
  v_lines text[];
  v_line text;
  f text[];
  mode constant jsonb := '{"C":"Cash","D":"Debit/Credit Card","O":"Online Payment","Q":"Cheque","E":"Easy Paisa/Jazz Cash","F":"Foodpanda","W":"Wallet"}';
  gender constant jsonb := '{"f":"female","m":"male","o":"other"}';
  i int := 0;
  it text; parts text[]; items jsonb;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only Dr. Ali can import Healthwire data' using errcode = '42501';
  end if;
  v_lines := string_to_array(p_text, E'\n');

  if p_kind = 'invoices' then
    -- first line: item dictionary
    foreach it in array string_to_array(v_lines[1], ';') loop
      parts := string_to_array(it, '^');
      v_dict := v_dict || jsonb_build_object(i::text, jsonb_build_array(parts[1], nullif(parts[2], '')));
      i := i + 1;
    end loop;
    v_lines := v_lines[2:];
  end if;

  foreach v_line in array v_lines loop
    continue when v_line = '';
    f := string_to_array(v_line, '|');
    if p_kind = 'patients' then
      v_rows := v_rows || jsonb_build_array(jsonb_build_array(f[1], f[2], nullif(f[3], ''), nullif(f[4], ''), nullif(f[5], ''), nullif(f[6], ''),
                 gender->>f[7], nullif(f[8], ''), nullif(f[9], ''), nullif(f[10], '')::int, nullif(f[11], '')));
    elsif p_kind = 'invoices' then
      items := '[]'::jsonb;
      foreach it in array string_to_array(f[8], ';') loop
        parts := string_to_array(it, '^');
        items := items || jsonb_build_array(jsonb_build_array(v_dict->parts[1]->1, v_dict->parts[1]->>0, parts[2]::numeric, parts[3]::numeric));
      end loop;
      v_rows := v_rows || jsonb_build_array(jsonb_build_array(f[1], f[2], f[3]::int, f[4], f[5]::numeric, f[6]::numeric, f[7]::int, items));
    elsif p_kind = 'payments' then
      v_rows := v_rows || jsonb_build_array(jsonb_build_array(f[1], (select p.mr_number from public.invoices inv join public.patients p on p.id = inv.patient_id where inv.invoice_no = f[1]),
                 f[2]::int, f[3]::numeric, mode->>f[4], f[5], f[6]::bigint));
    elsif p_kind = 'visits' then
      v_rows := v_rows || jsonb_build_array((
        with refs as (select x.r, x.k from unnest(string_to_array(f[4], ',')) with ordinality as x(r, k)),
        li as (select ii.description, ii.treatment_id, t.name tname, refs.k, ii.id
                 from refs join public.invoices inv on inv.invoice_no = refs.r
                 join public.invoice_items ii on ii.invoice_id = inv.id
                 left join public.treatments t on t.id = ii.treatment_id)
        select jsonb_build_array(f[1], f[2], f[3]::int,
          (select treatment_id from li where treatment_id is not null order by k limit 1),
          left((select string_agg(distinct coalesce(tname, description), ' / ') from li), 120),
          left((select string_agg(d, ' · ' order by k) from (select k, string_agg(description, ', ') d from li group by k) x), 400),
          (select jsonb_agg(r order by k) from refs))));
    elsif p_kind = 'expenses' then
      v_rows := v_rows || jsonb_build_array(jsonb_build_array(f[1], nullif(f[2], '')::int, f[3]::int, f[4], f[5]::numeric, mode->>f[6], f[7], f[8]::bigint, f[9], f[10], nullif(f[11], '')));
    else
      raise exception 'Unknown kind %', p_kind;
    end if;
  end loop;

  return public.import_healthwire(p_kind, v_rows);
end $$;

revoke all on function public.import_healthwire_text(text, text) from public, anon;
grant execute on function public.import_healthwire_text(text, text) to authenticated;
