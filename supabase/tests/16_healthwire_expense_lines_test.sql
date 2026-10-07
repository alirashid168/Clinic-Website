-- A Healthwire salary voucher holds one line per staff member under one
-- voucher number: every line must come in, and a second run adds nothing.
\set ON_ERROR_STOP 1
begin;
select public.import_healthwire('categories', '["Salaries"]');
do $$
declare r jsonb; n int; s numeric;
begin
  r := public.import_healthwire('expenses', '[
    ["2025-08-30", null, 1, "Salaries", 68000, "Cash", "Staff A Lhr", 105162, "Salary Staff", "Sadia Azam", "2025-08-30 12:00"],
    ["2025-08-30", null, 1, "Salaries", 140000, "Cash", "Staff B", 105162, "Salary Staff", "Sadia Azam", "2025-08-30 12:00"],
    ["2025-08-30", null, 1, "Salaries", 140000, "Cash", "Staff C", 105162, "Salary Staff", "Sadia Azam", "2025-08-30 12:00"],
    ["2025-08-30", null, 1, "Salaries", 140000, "Cash", "Staff C", 105162, "Salary Staff", "Sadia Azam", "2025-08-30 12:00"]]');
  if (r->>'inserted')::int <> 4 then raise exception 'FAIL: expected all 4 salary lines (Healthwire counts an identical repeated line twice), got %', r; end if;
  raise notice 'ok - several lines under one voucher are all imported, an identical repeated line included';

  r := public.import_healthwire('expenses', '[
    ["2025-08-30", null, 1, "Salaries", 68000, "Cash", "Staff A Lhr", 105162, "Salary Staff", "Sadia Azam", "2025-08-30 12:00"],
    ["2025-08-30", null, 1, "Salaries", 140000, "Cash", "Staff B", 105162, "Salary Staff", "Sadia Azam", "2025-08-30 12:00"],
    ["2025-08-30", null, 1, "Salaries", 140000, "Cash", "Staff C", 105162, "Salary Staff", "Sadia Azam", "2025-08-30 12:00"],
    ["2025-08-30", null, 1, "Salaries", 140000, "Cash", "Staff C", 105162, "Salary Staff", "Sadia Azam", "2025-08-30 12:00"]]');
  if (r->>'inserted')::int <> 0 then raise exception 'FAIL: second run of the same file added lines: %', r; end if;
  raise notice 'ok - dropping the same expenses file twice adds nothing';

  -- a line written by the earlier import under the old key is recognised by voucher, date and amount
  insert into public.expenses (expense_date, city_id, category_id, amount, method, receipt_path, notes, legacy_source)
  select '2025-08-30', 1, c.id, 72000, 'cash', 'hw-exp-105162', 'Staff D (Healthwire voucher #105162, Salary Staff, by Sadia Azam)', 'healthwire' from public.expense_categories c where c.name = 'Salaries';
  r := public.import_healthwire('expenses', '[["2025-08-30", null, 1, "Salaries", 72000, "Cash", "Staff  D", 105162, "Salary Staff", "Sadia Azam", "2025-08-30 12:00"],
    ["2025-08-30", null, 1, "Salaries", 72000, "Cash", "Staff E", 105162, "Salary Staff", "Sadia Azam", "2025-08-30 12:00"]]');
  if (r->>'inserted')::int <> 1 then raise exception 'FAIL: expected only Staff E added (Staff D is there under the old key, spacing aside): %', r; end if;
  raise notice 'ok - a line imported with the old key is recognised by its text; a different staff member with the same salary is not';

  select count(*), sum(amount) into n, s from public.expenses where receipt_path like 'hw-exp-105162%';
  if n <> 6 or s <> 632000 then raise exception 'FAIL: expected 6 lines totalling 632000, got % / %', n, s; end if;
  raise notice 'ok - voucher total is the sum of its lines';
end $$;
rollback;
