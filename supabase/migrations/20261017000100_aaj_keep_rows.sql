-- =============================================================================
-- Aaj ki List sync: the Google Sheet keeps its rows; a deleted row of a patient who is done only goes off the sheet.
--
-- The owner's request (Dr. Ali, 17 Oct 2026, verbatim): "oh yes one thing, please dont delete the aaj ki list google sheet entries
-- daily, one of my assistant does it after recording the treatments in healthwire". Asked when she clears the sheet, he answered
-- "It varies": sometimes the same evening after the last patient, sometimes the next day. Both must be safe.
--
-- WHAT CHANGES (only for a call that says "keep_rows": true; the new apps-script/AajSync.js says it in every call)
--   The new script no longer clears the five branch tabs at night: it copies each day's rows to the archive once and leaves them on the
--   tab ("kept" rows of an earlier day, never sent again). The assistant then deletes the rows of the day after entering them in
--   Healthwire, the same evening or the next day. Deleting a kept row changes nothing here (it is not a row of today's list). For a
--   row of TODAY that leaves the sheet (private.aaj_removals):
--     * a visit or checkup of a patient who is DONE (Completed or Treatment) only goes off the sheet: it is kept here exactly as it is,
--       marked released (private.aaj_released, status completed / in_treatment), and the sheet does not get its row back while it stays
--       done (private.aaj_day_list sends it with "removed": false, so the script, old or new, leaves the claimed record off the sheet;
--       set back to Waiting or Scheduled on the website it is "removed": true and comes back as a website row, like a Cancelled one).
--       The answer is "released": "Taken off the sheet; kept on the website (Completed)." (the script writes it to its log), and a small
--       SHEET_OFF row goes to audit_log. This holds for one row and for many rows at once, also a whole tab cleared. Before, the row came
--       back with "Not removed: this visit is Completed on the website ..." and a deletion of 4 rows or more brought every row back.
--     * a Cancelled one was already released silently in every call (it stays as it is, its row does not come back); the answer now also
--       names it ("Taken off the sheet; kept on the website (Cancelled).") so the sheet's log says so.
--     * Waiting, Scheduled and No show keep today's meaning (owner, 9 Oct 2026: "deleted patient means wrong entry, or patient didnt
--       come. so deleting the row should delete from the website aaj ki list too"): one row deleted is removed when nothing hangs on it,
--       with the same caps, audit and Ctrl+Z as before. In a deletion of many rows at once (4 or more rows, or a quarter of the tab, 2 or
--       more; the rows of done patients count, since waiting patients deleted in a big selection are most likely a mistake) they are
--       not removed: they come back with "Needs attention: N rows disappeared at once ..." as before, plus "(The rows of patients who are
--       done stay off the sheet.)" when some were. The day's cap counts removals only (taking a done patient off the sheet is not a
--       removal), and its base keeps the records taken off the sheet earlier that day: they are still rows the sheet had today, so the
--       cap stays about a third of the day's rows after the assistant has cleared the evening's done rows (before, it fell back to 15).
--       Before deleting a row of today the assistant checks that it says Completed (docs/AAJ-SYNC-SETUP.md, section 5): a row still
--       Waiting is a wrong entry by the owner's rule.
--     * A record the website itself let go (SHEET_LETGO, an Mr# or a Month typed into the row, RV9-2) keeps its own rule.
--     * Ctrl+Z right after a deletion: the row comes back with its key, aaj_sync takes the released mark away (as before) and the row is
--       linked again; nothing was removed for a done patient, so nothing needs to be put back.
--     * A done patient's row that another patient was TYPED OVER (not deleted) cannot be told apart here from a deleted one. The new
--       script knows it typed-over rows and puts that patient back at the bottom of the tab itself ("Put back: another patient was typed
--       over this row"), as before this file. Until that row is written (a minute later; it keeps the key across minutes, also when the
--       website is busy) it asks for no removal pass, so the record is never released here; its key is on the sheet again in the next call.
--     * A patient whose done row was taken off the sheet and who comes AGAIN the same day (a second treatment) is typed in a new row:
--       that row, when it is not done (Waiting, Scheduled or no Status), gets a visit of its own and says "Second visit of this patient
--       today: the first (...) is done and was taken off the sheet." (a tick); the done visit stays exactly as it is, off the sheet
--       (private.aaj_sync_row, private.aaj_off_done). Before, the new row adopted the done visit: the morning's Status and Treatment were
--       written over the row and the second treatment was never recorded. A new row that says Completed or Treatment is the done visit's
--       own row back (a Ctrl+Z of cleared cells whose hidden key was let go) and is linked to it again, as before.
--   A call WITHOUT "keep_rows" (the old script, still pasted in the sheet) gets exactly the old answers.
--
-- WHAT THIS FILE REPLACES (four CREATE OR REPLACE and one new small function, no table, column or grant changes)
--   * public.aaj_sync: the body of 20261009000300_aaj_two_way_sync.sql (checked identical to the live database on 17 Oct 2026) with
--     three narrow changes, all inside it: it reads "keep_rows" and sets the transaction setting aaj.keep_rows for aaj_removals; the
--     Cancelled records it releases in a keep_rows call are named in "removed"; nothing else. 213 lines.
--   * private.aaj_removals: the same body with the done records taken off the sheet first, and the day's cap counting the records taken
--     off earlier that day (keep_rows only). 212 lines.
--   * private.aaj_day_list: the same list, with "removed" for a record taken off the sheet while done (see above). 20 lines.
--   * private.aaj_sync_row: the body of 20261011000100_aaj_sync_quiet_token.sql (checked identical to the live database on 17 Oct 2026)
--     with the one change for a patient who comes again (see above, keep_rows only), and written without a backslash (the same tests in
--     other words: section 4). The large one: 673 lines, almost all of them unchanged.
--   * private.aaj_off_done (new): is a visit or checkup done and taken off the sheet while done? 10 lines.
--   Replaced functions keep their grants; the revokes and the one grant of 20261009000300 are repeated at the end anyway.
--   No backslash anywhere in this file (the live apply tool decodes backslash escapes).
--
-- BOTH ORDERS ARE SAFE (the script is pasted into the sheet by hand, so for a while one side is new and the other old)
--   * this file first, old script still running: the old script sends no "keep_rows", so every answer is the old one (its nightly clear
--     goes on; a deleted Completed row still comes back).
--   * new script first, this file not applied yet: the old aaj_sync ignores "keep_rows"; the rows stay on the tab at night (the script
--     does that) and a deleted Completed row still comes back with "Not removed", as now. Nothing is lost either way.
--   Suggested order: apply this file, check it with the read-only queries below, then paste the new script (docs/AAJ-SYNC-SETUP.md,
--   section 14 "Updating the script"). Set up does not need to be run again.
--
-- CHECKING IT ON THE LIVE DATABASE (read-only; never run supabase/tests/40_aaj_keep_rows_test.sql there)
--   Test 40 is for the local SQL suite only (psql, .omc/golive/gates.sh): it cannot run in the SQL Editor (it uses psql's set lines), and run
--   with psql against the live database it would replace the sync secret's hash, delete Islamabad's visits and checkups of today and
--   yesterday, and hold the sync's lock until its rollback (every sheet call answered BUSY meanwhile). On the live database run only:
--     select p.proname, md5(p.prosrc) from pg_proc p
--      where (p.pronamespace = 'public'::regnamespace and p.proname = 'aaj_sync')
--         or (p.pronamespace = 'private'::regnamespace and p.proname in ('aaj_removals', 'aaj_day_list', 'aaj_sync_row', 'aaj_off_done')) order by 1;
--   and compare: before this file, aaj_sync_row 804b68081788e59bbb938e6588d646a4 and no aaj_off_done; after it, aaj_day_list
--   e06e36c82cdb77bc6ff38fca7fc743fb, aaj_off_done 95310b9b6af75e99742ed69e03224280, aaj_removals 042ac2530063f70660eec06617abfa3e,
--   aaj_sync b36b7678493aa134c9e733b73a3d8005, aaj_sync_row 78060381dae13746fbd739a2fa7b10e3 (the md5 of each body below, checked by
--   supabase/tests/40_aaj_keep_rows_test.sql in the local suite; any edit of a body changes it), and
--     select b.code, jsonb_array_length(private.aaj_day_list(b.id, (now() at time zone 'Asia/Karachi')::date)) from public.branches b
--      where b.code in ('GUL', 'NN', 'DHA', 'LHR', 'ISB') order by 1;
--   before and after applying: every branch keeps the same number of rows on today's list.
--
-- HOW TO APPLY
--   Supabase dashboard -> SQL Editor -> New query -> paste this whole file -> Run. It is safe to run more than once. With the Supabase CLI,
--   keep the file name as it is: 20261017000100 sorts after the last migration (20261016000200_photo_xray_delete.sql).
--   It needs 20261009000300_aaj_two_way_sync.sql (and 20261011000100_aaj_sync_quiet_token.sql, which this file does not touch).
-- =============================================================================

-- ---------------------------------------------------------------------
-- 1. The door: public.aaj_sync reads "keep_rows" and names the Cancelled records it releases (keep_rows only)
-- ---------------------------------------------------------------------
create or replace function public.aaj_sync(p_secret text, p_payload jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare
  v_date date; v_today date := (now() at time zone 'Asia/Karachi')::date;
  v_admin uuid; v_rules text;
  v_check_removed boolean;
  v_tab jsonb; v_row jsonb; v_branch smallint; v_code text; v_tabname text; v_present text[]; v_has_present boolean; v_branches text[] := '{}';
  v_doubled text[];
  v_res jsonb; v_results jsonb; v_removed jsonb; v_list jsonb; v_hash text; v_nrows int; v_first_err text; v_detail text; v_problems int;
  v_tabs_out jsonb := '[]'::jsonb; v_tab_out jsonb; v_unchanged boolean; v_total_rows int := 0; r record; v_force_list boolean := false;
  v_keep boolean; v_off jsonb;                     -- keep_rows (20261017000100): the call's flag; the Cancelled records it releases
begin
  if p_secret is null or not exists (
       select 1 from private.sync_secrets where name = 'aaj_sheet_sync' and secret_hash = encode(digest(p_secret, 'sha256'), 'hex')) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if not pg_try_advisory_xact_lock(hashtext('aaj_sync')) then
    raise exception 'BUSY' using errcode = '55P03';
  end if;
  -- a rate limit on the door itself: a tick makes a handful of calls, even a first sync of 500 rows is 20
  delete from private.aaj_sync_calls where at < clock_timestamp() - interval '10 minutes';
  insert into private.aaj_sync_calls default values;
  if (select count(*) from private.aaj_sync_calls where at > clock_timestamp() - interval '1 minute')
       > coalesce((select value::int from private.aaj_sync_config where key = 'calls_per_minute'), 90) then
    raise exception 'RATE_LIMIT: too many calls in a minute' using errcode = '54000';
  end if;

  -- shape, date, limits
  if jsonb_typeof(p_payload) is distinct from 'object' or jsonb_typeof(p_payload->'tabs') is distinct from 'array' then
    raise exception 'BAD_PAYLOAD: tabs must be a list' using errcode = '22023';
  end if;
  if length(p_payload::text) > 300000 then raise exception 'PAYLOAD_TOO_LARGE: more than 300 KB' using errcode = '22023'; end if;
  begin
    if (p_payload->>'date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'not a date'; end if;      -- not 'today', 'yesterday', 'infinity' ...
    v_date := (p_payload->>'date')::date;
  exception when others then
    raise exception 'BAD_PAYLOAD: date is missing or not a date' using errcode = '22023';
  end;
  if v_date is null then raise exception 'BAD_PAYLOAD: date is missing or not a date' using errcode = '22023'; end if;
  if not private.aaj_date_ok(v_date) then raise exception 'DATE_NOT_ALLOWED' using errcode = '22023'; end if;
  v_check_removed := coalesce(p_payload->>'check_removed', 'false') = 'true';
  -- keep_rows (20261017000100_aaj_keep_rows.sql): the script keeps rows on the tab (no nightly clear), so a row of a patient who is done
  -- (Completed, Treatment, Cancelled) that leaves the sheet only goes off it. private.aaj_removals reads the setting, for this call only.
  v_keep := coalesce(p_payload->>'keep_rows', 'false') = 'true';
  perform set_config('aaj.keep_rows', case when v_keep then 'on' else 'off' end, true);
  if jsonb_array_length(p_payload->'tabs') > 5 then raise exception 'PAYLOAD_TOO_LARGE: more than 5 tabs' using errcode = '22023'; end if;
  for v_tab in select value from jsonb_array_elements(p_payload->'tabs') loop
    if jsonb_typeof(v_tab) is distinct from 'object' or jsonb_typeof(v_tab->'branch') is distinct from 'string'
       or (v_tab ? 'rows' and jsonb_typeof(v_tab->'rows') not in ('array', 'null'))
       or (v_tab ? 'present' and jsonb_typeof(v_tab->'present') not in ('array', 'null'))
       or (v_tab ? 'doubled' and jsonb_typeof(v_tab->'doubled') not in ('array', 'null')) then
      raise exception 'BAD_PAYLOAD: every tab needs a branch, rows and present as lists' using errcode = '22023';
    end if;
    if (v_tab->>'branch') = any (v_branches) then raise exception 'PAYLOAD_TOO_LARGE: a branch appears twice' using errcode = '22023'; end if;
    v_branches := v_branches || (v_tab->>'branch');
    if jsonb_array_length(coalesce(nullif(v_tab->'present', 'null'::jsonb), '[]'::jsonb)) > 400
       or jsonb_array_length(coalesce(nullif(v_tab->'doubled', 'null'::jsonb), '[]'::jsonb)) > 400 then
      raise exception 'PAYLOAD_TOO_LARGE: more than 400 rows in a tab' using errcode = '22023';
    end if;
    v_total_rows := v_total_rows + jsonb_array_length(coalesce(nullif(v_tab->'rows', 'null'::jsonb), '[]'::jsonb));
  end loop;
  if v_total_rows > 25 then raise exception 'PAYLOAD_TOO_LARGE: more than 25 rows in one call' using errcode = '22023'; end if;
  foreach v_code in array v_branches loop
    -- only the five tabs of the sheet
    if private.aaj_tab_name(v_code) is null or not exists (select 1 from public.branches where code = v_code and active) then
      raise exception 'UNKNOWN_BRANCH: %', left(v_code, 20) using errcode = '22023';
    end if;
  end loop;

  select id into v_admin from public.staff where role = 'admin' and active order by created_at limit 1;
  v_rules := coalesce((select value from private.aaj_sync_config where key = 'rules'), 'override');
  perform set_config('aaj.refused', '0', true);      -- refused lookups in this call (aaj_sync_row stops looking after 5)

  for v_tab in select value from jsonb_array_elements(p_payload->'tabs') loop
    v_code := v_tab->>'branch'; v_tabname := private.aaj_tab_name(v_code);        -- never the tab name the caller sent
    select id into v_branch from public.branches where code = v_code;
    v_has_present := jsonb_typeof(v_tab->'present') = 'array';
    v_present := coalesce(array(select k from jsonb_array_elements_text(coalesce(nullif(v_tab->'present', 'null'::jsonb), '[]'::jsonb)) k where length(k) <= 60), '{}');
    -- keys the tab has on two rows that show the same Mr#, name and phone (the script leaves the lower one out of present and does not send it)
    v_doubled := coalesce(array(select k from jsonb_array_elements_text(coalesce(nullif(v_tab->'doubled', 'null'::jsonb), '[]'::jsonb)) k
                                 where length(k) <= 60 and k = any (v_present)), '{}');
    v_detail := null;

    -- a visit or checkup made on the website is claimed the first time its key shows up in the tab
    update public.visits set sheet_key = 'W-' || id::text
     where branch_id = v_branch and visit_date = v_date and sheet_key is null and ('W-' || id::text) = any (v_present);
    update public.checkups set sheet_key = 'W-' || id::text
     where branch_id = v_branch and checkup_date = v_date and sheet_key is null and ('W-' || id::text) = any (v_present);
    -- a deleted row that came back in the sheet (Ctrl+Z): the visit or checkup it removed is put back under its key, once.
    -- A restore that cannot be done never stops the call: something it pointed at is gone since (the braces case was deleted: "failed"), or
    -- it cannot be done now (the patient was typed again in another row and has a visit on this list again: "skipped"). It is written down
    -- (so it is not tried again at every call, nor done later behind the sheet's back when the other visit goes) and the row then reads
    -- "deleted on the website, delete this row": the list is sent in that call even though it did not change (the script still shows the
    -- row's old tick otherwise, loop 6; sheet-behaviour RSG-2, 11 Oct 2026).
    v_force_list := false;
    if v_has_present and cardinality(v_present) > 0 then
      for r in select a.id, a.table_name, a.row_id from public.audit_log a
                where a.action = 'SHEET_REMOVED' and a.new_data->>'action' = 'deleted' and a.new_data->>'key' = any (v_present)
                  and a.new_data->>'branch' = v_code and a.new_data->>'date' = v_date::text and a.at > now() - interval '3 days'
                  and not exists (select 1 from public.audit_log b where b.action = 'SHEET_RESTORED' and b.new_data->>'audit' = a.id::text)
                order by a.id loop
        begin
          if not private.aaj_restore_removed(r.id, true) then
            insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
            values (r.table_name, r.row_id, 'SHEET_RESTORED', null,
                    jsonb_build_object('audit', r.id, 'skipped', true, 'why', 'not put back: the patient has another visit on this list now, or the record it needs is gone'),
                    private.aaj_sync_actor());
            v_force_list := true;
          end if;
        exception when others then
          insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
          values (r.table_name, r.row_id, 'SHEET_RESTORED', null,
                  jsonb_build_object('audit', r.id, 'failed', true, 'error', left(sqlerrm, 200)), private.aaj_sync_actor());
          v_force_list := true;
        end;
      end loop;
      -- a deleted row whose visit was KEPT and marked Cancelled (something hangs on it), brought back with Ctrl+Z after the sync had put the
      -- row back itself: the key is on two rows now ("doubled"). The visit gets its status back unless it was changed since (aaj_restore_kept).
      -- Tried once: what could not be done is written down ("skipped") and the visit stays as front desk left it (sheet-behaviour RV-3).
      for r in select a.id, a.table_name, a.row_id from public.audit_log a
                where a.action = 'SHEET_REMOVED' and a.new_data->>'action' = 'kept_cancelled' and a.new_data->>'key' = any (v_doubled)
                  and a.new_data->>'branch' = v_code and a.new_data->>'date' = v_date::text and a.at > now() - interval '3 days'
                  and not exists (select 1 from public.audit_log b where b.action = 'SHEET_RESTORED' and b.new_data->>'audit' = a.id::text)
                order by a.id loop
        begin
          if not private.aaj_restore_kept(r.id) then
            insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
            values (r.table_name, r.row_id, 'SHEET_RESTORED', null,
                    jsonb_build_object('audit', r.id, 'skipped', true, 'why', 'status not put back: the visit was changed on the website since it was kept and marked Cancelled'),
                    private.aaj_sync_actor());
          end if;
        exception when others then
          insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
          values (r.table_name, r.row_id, 'SHEET_RESTORED', null,
                  jsonb_build_object('audit', r.id, 'failed', true, 'error', left(sqlerrm, 200)), private.aaj_sync_actor());
        end;
      end loop;
    end if;

    v_results := '[]'::jsonb; v_nrows := 0;
    for v_row in select value from jsonb_array_elements(coalesce(nullif(v_tab->'rows', 'null'::jsonb), '[]'::jsonb)) with ordinality t(value, o) order by o loop
      v_nrows := v_nrows + 1;
      begin
        v_res := private.aaj_sync_row(v_branch, v_tabname, v_date, v_row, v_present, v_admin, v_rules);
      exception when others then
        v_detail := coalesce(v_detail, left(sqlerrm, 300));
        v_res := private.aaj_result(left(coalesce(v_row->>'key', ''), 60), 'error', 'error', private.aaj_err_text(sqlstate, sqlerrm));
      end;
      v_results := v_results || v_res;
    end loop;

    -- released records (sheet-behaviour RS5-D4): a visit or checkup whose row is on the sheet again is not released any more; a claimed one
    -- that is Cancelled and whose row has left the sheet is released: never a removal (not even after it is set to work again on the
    -- website), and the sheet gets it back as a website row only once it works again. Done in every call that lists the tab's rows (a row
    -- that only moves keeps or regains its key, which takes the mark away again), before the removals, which release a kept No show.
    v_off := '[]'::jsonb;
    if v_has_present and v_date = v_today then
      -- (only this tab's own records: a key copied into another branch's tab does not take a mark away, abuse-privacy minor, loop 6)
      delete from private.aaj_released rl using public.visits x
       where rl.visit_id = x.id and x.sheet_key = any (v_present) and x.branch_id = v_branch and x.visit_date = v_date;
      delete from private.aaj_released rl using public.checkups x
       where rl.checkup_id = x.id and x.sheet_key = any (v_present) and x.branch_id = v_branch and x.checkup_date = v_date;
      -- (the ones released in this call are named, for a keep_rows call only: "Taken off the sheet; kept on the website (Cancelled).")
      with ins as (
        insert into private.aaj_released (visit_id, sheet_key, status)
        select x.id, x.sheet_key, x.status::text from public.visits x
         where x.branch_id = v_branch and x.visit_date = v_date and x.sheet_key is not null and not (x.sheet_key = any (v_present)) and x.status = 'cancelled'
        on conflict do nothing
        returning visit_id, sheet_key)
      select coalesce(jsonb_agg(jsonb_build_object('key', ins.sheet_key, 'action', 'released', 'name', p.full_name,
                                                   'message', 'Taken off the sheet; kept on the website (Cancelled).') order by ins.sheet_key), '[]'::jsonb)
        into v_off
        from ins join public.visits x on x.id = ins.visit_id join public.patients p on p.id = x.patient_id;
      with ins as (
        insert into private.aaj_released (checkup_id, sheet_key, status)
        select x.id, x.sheet_key, x.day_status from public.checkups x
         where x.branch_id = v_branch and x.checkup_date = v_date and x.source <> 'archive' and not x.date_is_month
           and x.sheet_key is not null and not (x.sheet_key = any (v_present)) and x.day_status = 'cancelled'
        on conflict do nothing
        returning checkup_id, sheet_key)
      select v_off || coalesce(jsonb_agg(jsonb_build_object('key', ins.sheet_key, 'action', 'released', 'name', x.patient_name,
                                                             'message', 'Taken off the sheet; kept on the website (Cancelled).') order by ins.sheet_key), '[]'::jsonb)
        into v_off
        from ins join public.checkups x on x.id = ins.checkup_id;
    end if;

    v_removed := '[]'::jsonb;
    if v_check_removed and v_date = v_today and v_has_present then
      v_removed := private.aaj_removals(v_branch, v_date, v_tabname, v_present);
    end if;
    if v_keep then v_removed := v_off || v_removed; end if;        -- (the script writes every "released" line to its log)

    v_list := private.aaj_day_list(v_branch, v_date);
    v_hash := md5(v_list::text);
    v_unchanged := (v_nrows = 0 and (v_tab->>'hash') is not distinct from v_hash and jsonb_array_length(v_removed) = 0     -- rows to put back need the list
                    and not v_force_list);

    select count(*) filter (where x->>'level' = 'error'), (array_agg(x->>'message') filter (where x->>'level' = 'error'))[1]
      into v_problems, v_first_err from jsonb_array_elements(v_results) x;
    insert into private.aaj_sync_state (branch_id, list_date, last_call_at, rows_present, last_problems, last_error, last_detail)
    values (v_branch, v_date, now(), case when v_has_present then cardinality(v_present) end, v_problems, v_first_err, v_detail)
    on conflict (branch_id) do update set list_date = excluded.list_date, last_call_at = excluded.last_call_at,
      rows_present = coalesce(excluded.rows_present, private.aaj_sync_state.rows_present),
      last_problems = excluded.last_problems, last_error = excluded.last_error, last_detail = excluded.last_detail;

    v_tab_out := jsonb_build_object('branch', v_code, 'hash', v_hash, 'unchanged', v_unchanged, 'results', v_results, 'removed', v_removed);
    if not v_unchanged then v_tab_out := v_tab_out || jsonb_build_object('visits', v_list); end if;
    v_tabs_out := v_tabs_out || v_tab_out;
  end loop;

  return jsonb_build_object('ok', true, 'date', v_date, 'server_time', now(), 'tabs', v_tabs_out);
end $$;

-- ---------------------------------------------------------------------
-- 2. Rows that left the sheet: a patient who is done only goes off it (keep_rows only)
-- ---------------------------------------------------------------------
create or replace function private.aaj_removals(p_branch smallint, p_date date, p_tab text, p_present text[]) returns jsonb
language plpgsql volatile set search_path = public, extensions
as $$
declare
  v public.visits; c public.checkups; bc public.braces_cases; pp public.patients;
  v_out jsonb := '[]'::jsonb; v_pres text[] := coalesce(p_present, '{}');
  v_n int; v_total int; v_done int; v_cap int; v_hold boolean; v_code text; v_why text;
  v_day timestamptz := ((now() at time zone 'Asia/Karachi')::date)::timestamp at time zone 'Asia/Karachi';
  v_attached text; v_staff jsonb; v_text jsonb; v_msg text; v_casej jsonb; v_patj jsonb; v_patkept text; v_letgo boolean;
  -- keep_rows (20261017000100, set by public.aaj_sync for a call of the script that keeps rows on the tab): the records of patients who are
  -- done (Completed, Treatment) whose rows left the sheet, taken off it before anything else
  v_keep boolean := coalesce(current_setting('aaj.keep_rows', true), '') = 'on';
  v_offv uuid[] := '{}'; v_offc uuid[] := '{}'; v_off int := 0;
  v_offdone int := 0;                              -- the day's records of this tab already taken off the sheet while done (still the day's rows)
begin
  select code into v_code from public.branches where id = p_branch;
  -- a Cancelled record, and one released already (its row left the sheet while it was Cancelled / No show), is never a removal
  select count(*) into v_n from (
    select 1 from public.visits x where x.branch_id = p_branch and x.visit_date = p_date and x.sheet_key is not null and not (x.sheet_key = any (v_pres)) and x.status <> 'cancelled'
       and not exists (select 1 from private.aaj_released rl where rl.visit_id = x.id)
    union all
    select 1 from public.checkups x where x.branch_id = p_branch and x.checkup_date = p_date and x.source <> 'archive' and not x.date_is_month
       and x.sheet_key is not null and not (x.sheet_key = any (v_pres)) and coalesce(x.day_status, '') <> 'cancelled'
       and not exists (select 1 from private.aaj_released rl where rl.checkup_id = x.id)) y;
  if v_n = 0 then return v_out; end if;
  select count(*) into v_total from (
    select 1 from public.visits x where x.branch_id = p_branch and x.visit_date = p_date and x.sheet_key is not null and x.status <> 'cancelled'
       and not exists (select 1 from private.aaj_released rl where rl.visit_id = x.id)
    union all
    select 1 from public.checkups x where x.branch_id = p_branch and x.checkup_date = p_date and x.source <> 'archive' and not x.date_is_month
       and x.sheet_key is not null and coalesce(x.day_status, '') <> 'cancelled'
       and not exists (select 1 from private.aaj_released rl where rl.checkup_id = x.id)) y;
  select count(*) into v_done from public.audit_log
   where action = 'SHEET_REMOVED' and new_data->>'branch' = v_code and at >= v_day and new_data->>'action' in ('deleted', 'kept_cancelled');
  -- the day's removals: at least 15, and 35 in 100 of the rows the sheet has had today (the ones removed today included, and in a keep_rows
  -- call the ones taken off the sheet while done, v_offdone below), so a busy day of 120
  -- patients may lose 42 wrong entries and no-shows (owner, 11 Oct 2026: "sometimes on a busy day, we have like 120 patients"; RS12-1)
  -- keep_rows: a visit or checkup of a patient who is done (Completed, Treatment) whose row left the sheet only goes off the sheet: kept
  -- here exactly as it is, released, its row not put back while it stays done (aaj_day_list), one row or a whole tab alike (owner, 17 Oct
  -- 2026: the assistant deletes the rows after entering the treatments in Healthwire). Not a record the website let go itself (RV9-2).
  if v_keep then
    select coalesce(array_agg(x.id), '{}') into v_offv from public.visits x
     where x.branch_id = p_branch and x.visit_date = p_date and x.sheet_key is not null and not (x.sheet_key = any (v_pres))
       and x.status in ('completed', 'in_treatment')
       and not exists (select 1 from private.aaj_released rl where rl.visit_id = x.id)
       and not private.aaj_let_go_seen('visits', x.id, x.sheet_key, x.updated_at);
    select coalesce(array_agg(x.id), '{}') into v_offc from public.checkups x
     where x.branch_id = p_branch and x.checkup_date = p_date and x.source <> 'archive' and not x.date_is_month
       and x.sheet_key is not null and not (x.sheet_key = any (v_pres)) and x.day_status in ('in_treatment', 'completed')
       and not exists (select 1 from private.aaj_released rl where rl.checkup_id = x.id)
       and not private.aaj_let_go_seen('checkups', x.id, x.sheet_key, x.updated_at);
    v_off := cardinality(v_offv) + cardinality(v_offc);
    -- the records taken off the sheet earlier today while done are released, so v_total leaves them out; they are still rows the sheet had
    -- today, so they count for the day's cap (the guide: about a third of the day's rows). Without it the cap fell back to 15 in the evening,
    -- once the assistant had cleared the done rows, and a single no-show deleted after that came back (RV10-9).
    select count(*) into v_offdone from (
      select 1 from private.aaj_released rl join public.visits x on x.id = rl.visit_id
       where x.branch_id = p_branch and x.visit_date = p_date and rl.status in ('completed', 'in_treatment')
      union all
      select 1 from private.aaj_released rl join public.checkups x on x.id = rl.checkup_id
       where x.branch_id = p_branch and x.checkup_date = p_date and rl.status in ('completed', 'in_treatment')) y;
  end if;
  v_cap := greatest(15, ceil(0.35 * (v_total + v_done + v_offdone))::int);
  -- "at once" counts every row that left the sheet, the done ones too (waiting patients deleted in a big selection are most likely a
  -- mistake); the day's cap counts the rows that would be removed (v_off is 0 without keep_rows: the rule of 20261009000300)
  v_hold := v_n > 3 or (v_n >= 2 and (cardinality(v_pres) = 0 or v_n * 4 >= v_total)) or v_done + (v_n - v_off) > v_cap;
  if v_hold then
    v_why := case when v_done + (v_n - v_off) > v_cap and v_n <= 3 then 'Needs attention: too many rows were deleted from this tab today, so nothing was removed from the website. Delete wrong entries on the website.'
                  else format('Needs attention: %s rows disappeared at once, so nothing was removed from the website. Delete wrong entries on the website, or delete fewer rows at a time.', v_n) end
             || case when v_off > 0 then ' (The rows of patients who are done stay off the sheet.)' else '' end;
  end if;

  for v in select x.* from public.visits x where x.branch_id = p_branch and x.visit_date = p_date and x.sheet_key is not null
              and not (x.sheet_key = any (v_pres)) and x.status <> 'cancelled'
              and not exists (select 1 from private.aaj_released rl where rl.visit_id = x.id) order by x.created_at, x.id loop
    if v.id = any (v_offv) then
      insert into private.aaj_released (visit_id, sheet_key, status) values (v.id, v.sheet_key, v.status::text) on conflict do nothing;
      insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
      values ('visits', v.id::text, 'SHEET_OFF', null,
              jsonb_build_object('tab', p_tab, 'branch', v_code, 'date', p_date, 'key', v.sheet_key, 'kind', 'visit', 'status', v.status::text),
              private.aaj_sync_actor());
      v_out := v_out || jsonb_build_object('key', v.sheet_key, 'action', 'released', 'name', (select p.full_name from public.patients p where p.id = v.patient_id),
        'message', format('Taken off the sheet; kept on the website (%s).', private.aaj_status_label(v.status)));
      continue;
    end if;
    if v_hold then
      v_out := v_out || jsonb_build_object('key', v.sheet_key, 'action', 'restore', 'message', v_why);
      continue;
    end if;
    v_attached := private.aaj_visit_attached(v.id);
    -- the website let this row go from the visit itself (the Mr# corrected on a row whose patient file the sync made from it today,
    -- aaj_sync_row): the row went on as a new row, so the visit goes whatever its status, while nothing real hangs on it (RV9-2)
    v_letgo := private.aaj_let_go_seen('visits', v.id, v.sheet_key, v.updated_at) and v_attached is null and not v.photos_uploaded and v.checked_by is null;
    -- owner, 9 Oct 2026: "deleted patient means wrong entry, or patient didnt come. so deleting the row should delete from the website aaj ki
    -- list too": a No show (the patient did not come) goes like a Waiting or Scheduled visit when nothing hangs on it (sheet-behaviour RS5-B2)
    if v_letgo or (v.status in ('scheduled', 'waiting', 'no_show') and v_attached is null and v.started_at is null and v.completed_at is null
       and not v.photos_uploaded and v.checked_by is null) then
      v_staff := coalesce((select jsonb_agg(jsonb_build_object('clinician_id', s.clinician_id, 'role', s.role)) from public.visit_staff s where s.visit_id = v.id), '[]'::jsonb);
      v_text := (select to_jsonb(t) - 'visit_id' from private.aaj_visit_text t where t.visit_id = v.id);
      -- What the sync made for this row today goes with the visit when nothing else uses it: the braces case its Month started, and the
      -- patient file of a Healthwire Mr# typed in it (a slip such as 9888 for 9878 would otherwise stay as a file nobody points at, holding
      -- a number Healthwire gives to somebody else within days). Both are kept in the same audit row, so the undo puts them back too.
      v_casej := null; v_patj := null; bc := null; v_patkept := null;
      select b.* into bc from public.braces_cases b
       where b.id = v.braces_case_id and b.created_by = private.aaj_sync_actor() and b.created_at >= v_day and b.notes like 'From the Google Sheet: month %';
      if bc.id is not null and private.aaj_refs('public.braces_cases', bc.id, v.id, null) is null then v_casej := to_jsonb(bc); end if;
      select p.* into pp from public.patients p
       where p.id = v.patient_id and p.legacy_source = 'aaj_sheet_sync' and p.created_by = private.aaj_sync_actor() and p.created_at >= v_day
         and p.portal_user_id is null;
      if pp.id is not null and private.aaj_refs('public.patients', pp.id, v.id, case when v_casej is not null then bc.id end) is null then
        -- front desk often fills a new patient's file while the patient waits (medical history, allergies, consent, date of birth, address): a
        -- file changed by anybody since the sync made it is kept, never deleted with the row (sheet-behaviour RSX-1, 11 Oct 2026)
        if pp.updated_at > pp.created_at
           or exists (select 1 from public.audit_log a where a.table_name = 'patients' and a.row_id = pp.id::text and a.action = 'UPDATE') then
          v_patkept := pp.mr_number;
        else
          v_patj := to_jsonb(pp);
        end if;
      end if;
      insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
      values ('visits', v.id::text, 'SHEET_REMOVED', to_jsonb(v),
              jsonb_build_object('tab', p_tab, 'branch', v_code, 'date', p_date, 'key', v.sheet_key, 'action', 'deleted', 'kind', 'visit', 'staff', v_staff, 'text', v_text,
                                 'case', v_casej, 'patient', v_patj, 'let_go', v_letgo),
              private.aaj_sync_actor());
      delete from public.visits where id = v.id;
      if v_casej is not null then delete from public.braces_cases where id = bc.id; end if;
      if v_patj is not null then delete from public.patients where id = pp.id; end if;
      v_out := v_out || jsonb_build_object('key', v.sheet_key, 'action', 'deleted', 'name', coalesce(v_patj->>'full_name', (select p.full_name from public.patients p where p.id = v.patient_id)),
        'message', case when v_letgo then 'The Mr# in this row was corrected and the row was sent again: the visit under the old Mr# is removed from the website.'
                        else 'Row deleted in the sheet: the visit is removed from the website too.' end
                   || case when v_patj is not null then format(' So is the patient file made from this row (Mr# %s).', v_patj->>'mr_number')
                           when v_casej is not null then ' So is the braces case its Month started.' else '' end
                   || case when v_patkept is not null then format(' The patient file made from this row (Mr# %s) is kept: details were saved on it on the website. Check it (if the Mr# was typed wrong, merge it into the right file).', v_patkept) else '' end
                   || case when v_letgo then ' Dr. Ali can undo it.' else ' Put the row back to undo.' end);
    elsif v.status in ('scheduled', 'waiting') then
      -- something real hangs on it (an invoice, a photo ...): keep it, mark it Cancelled, and say why
      v_msg := format('Kept on the website and marked Cancelled: %s.', case when v_attached is not null then 'it has an attached record (' || v_attached || ')' else 'treatment was recorded on it' end);
      insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
      values ('visits', v.id::text, 'SHEET_REMOVED', to_jsonb(v),
              jsonb_build_object('tab', p_tab, 'branch', v_code, 'date', p_date, 'key', v.sheet_key, 'action', 'kept_cancelled', 'kind', 'visit', 'why', v_attached),
              private.aaj_sync_actor());
      update public.visits set status = 'cancelled',
             notes = left(concat_ws(' · ', notes, 'Row deleted in the Google Sheet (' || p_tab || ') ' || to_char(now() at time zone 'Asia/Karachi', 'HH24:MI') || ': kept, marked Cancelled'), 2000)
       where id = v.id;
      v_out := v_out || jsonb_build_object('key', v.sheet_key, 'action', 'kept', 'name', (select p.full_name from public.patients p where p.id = v.patient_id), 'message', v_msg);
    elsif v.status = 'no_show' then
      -- the patient did not come, and something real hangs on the visit: it stays on the website as it is (No show) and its row is not put
      -- back (the owner deleted it). Released: never a removal again, and back in the sheet only if it is set to work again on the website.
      v_msg := format('Row deleted in the sheet: the visit stays on the website as No show (%s). Its row is not put back.',
                      case when v_attached is not null then 'it has an attached record (' || v_attached || ')' else 'treatment was recorded on it' end);
      insert into private.aaj_released (visit_id, sheet_key, status) values (v.id, v.sheet_key, 'no_show') on conflict do nothing;
      insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
      values ('visits', v.id::text, 'SHEET_REMOVED', to_jsonb(v),
              jsonb_build_object('tab', p_tab, 'branch', v_code, 'date', p_date, 'key', v.sheet_key, 'action', 'released', 'kind', 'visit', 'why', v_attached),
              private.aaj_sync_actor());
      v_out := v_out || jsonb_build_object('key', v.sheet_key, 'action', 'released', 'name', (select p.full_name from public.patients p where p.id = v.patient_id), 'message', v_msg);
    else
      v_out := v_out || jsonb_build_object('key', v.sheet_key, 'action', 'restore',
        'message', format('Not removed: this visit is %s on the website. To take a patient off, set Status to Cancelled.', private.aaj_status_label(v.status)));
    end if;
  end loop;

  for c in select x.* from public.checkups x where x.branch_id = p_branch and x.checkup_date = p_date and x.source <> 'archive' and not x.date_is_month
              and x.sheet_key is not null and not (x.sheet_key = any (v_pres)) and coalesce(x.day_status, '') <> 'cancelled'
              and not exists (select 1 from private.aaj_released rl where rl.checkup_id = x.id) order by x.created_at, x.id loop
    if c.id = any (v_offc) then
      insert into private.aaj_released (checkup_id, sheet_key, status) values (c.id, c.sheet_key, c.day_status) on conflict do nothing;
      insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
      values ('checkups', c.id::text, 'SHEET_OFF', null,
              jsonb_build_object('tab', p_tab, 'branch', v_code, 'date', p_date, 'key', c.sheet_key, 'kind', 'checkup', 'status', c.day_status),
              private.aaj_sync_actor());
      v_out := v_out || jsonb_build_object('key', c.sheet_key, 'action', 'released', 'name', c.patient_name,
        'message', format('Taken off the sheet; kept on the website (%s).', private.aaj_checkup_label(c.day_status)));
      continue;
    end if;
    -- The website let this row go from the checkup itself (an Mr# of a patient it has, or a Month, typed into the row: aaj_sync_checkup_row):
    -- the person is a patient, not a checkup, and the row went on as a new row. The checkup goes whatever its status, so it is no lead on the
    -- nightly checkup list, when it is nobody's file and has no follow-up notes (sheet-behaviour RV9-2)
    v_letgo := private.aaj_let_go_seen('checkups', c.id, c.sheet_key, c.updated_at);
    if v_hold then
      v_out := v_out || jsonb_build_object('key', c.sheet_key, 'action', 'restore', 'message', v_why);
    -- owner, 9 Oct 2026: a deleted row is a wrong entry or a person who did not come. A checkup in Treatment or Completed is neither: its
    -- doctor, its details and the follow-up lead stay, like a Completed visit (sheet-behaviour RV-2, 11 Oct 2026)
    elsif c.patient_id is null and c.follow_up = 'Not Contacted' and c.notes is null
          and (coalesce(c.day_status, 'waiting') in ('waiting', 'no_show') or v_letgo) then
      insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
      values ('checkups', c.id::text, 'SHEET_REMOVED', to_jsonb(c),
              jsonb_build_object('tab', p_tab, 'branch', v_code, 'date', p_date, 'key', c.sheet_key, 'action', 'deleted', 'kind', 'checkup', 'let_go', v_letgo),
              private.aaj_sync_actor());
      delete from public.checkups where id = c.id;
      v_out := v_out || jsonb_build_object('key', c.sheet_key, 'action', 'deleted', 'name', c.patient_name,
        'message', case when v_letgo then 'An Mr# or a Month was typed in this row, so it was sent again as a visit: the checkup is removed from the website and this person is not on the checkup list. Dr. Ali can undo it.'
                        else 'Row deleted in the sheet: the checkup is removed from the website too. Put the row back to undo.' end);
    elsif c.day_status = 'no_show' then
      -- the person did not come and the checkup is already a patient or has follow-up notes: kept as it is, the row is not put back
      insert into private.aaj_released (checkup_id, sheet_key, status) values (c.id, c.sheet_key, 'no_show') on conflict do nothing;
      insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
      values ('checkups', c.id::text, 'SHEET_REMOVED', to_jsonb(c),
              jsonb_build_object('tab', p_tab, 'branch', v_code, 'date', p_date, 'key', c.sheet_key, 'action', 'released', 'kind', 'checkup'),
              private.aaj_sync_actor());
      v_out := v_out || jsonb_build_object('key', c.sheet_key, 'action', 'released', 'name', c.patient_name,
        'message', 'Row deleted in the sheet: the checkup stays on the website as No show (it is already a patient, or has follow-up notes). Its row is not put back.');
    elsif c.day_status in ('in_treatment', 'completed') then
      v_out := v_out || jsonb_build_object('key', c.sheet_key, 'action', 'restore',
        'message', format('Not removed: this checkup is %s on the website. To take a patient off, set Status to Cancelled.', private.aaj_checkup_label(c.day_status)));
    else
      v_out := v_out || jsonb_build_object('key', c.sheet_key, 'action', 'restore',
        'message', 'Not removed: this checkup is already a patient, or has follow-up notes on the website.');
    end if;
  end loop;
  return v_out;
end $$;

-- ---------------------------------------------------------------------
-- 3. The list the sheet gets: a record taken off the sheet while done is not added back while it stays done
-- ---------------------------------------------------------------------
-- The canon rows as before. A record released as done (completed / in_treatment, by aaj_removals above) is "removed" only once it works
-- again (a visit Waiting or Scheduled, a checkup Waiting): until then the script, old or new, sees a claimed record that is not removed
-- and leaves it off the sheet; once it works again it is added back as a website row, like a Cancelled record set back to work (RS5-D4).
-- Every other row is exactly the row of 20261009000300 (so the list's hash does not change for it).
create or replace function private.aaj_day_list(p_branch smallint, p_date date) returns jsonb
language sql stable set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(x.j order by x.g, x.tok nulls last, x.created_at, x.id), '[]'::jsonb)
    from (
      select private.aaj_canon_row(v)
             || case when rl.status in ('completed', 'in_treatment') then jsonb_build_object('removed', v.status in ('waiting', 'scheduled'))
                     else '{}'::jsonb end as j,
             0 as g, v.token_no as tok, v.created_at, v.id::text as id
        from public.visits v left join private.aaj_released rl on rl.visit_id = v.id
       where v.branch_id = p_branch and v.visit_date = p_date
      union all
      select private.aaj_checkup_canon_row(c)
             || case when rl.status in ('completed', 'in_treatment') then jsonb_build_object('removed', coalesce(c.day_status, 'waiting') = 'waiting')
                     else '{}'::jsonb end,
             1, null::int, c.created_at, c.id::text
        from public.checkups c left join private.aaj_released rl on rl.checkup_id = c.id
       where c.branch_id = p_branch and c.checkup_date = p_date and c.source <> 'archive' and not c.date_is_month
    ) x
$$;

-- ---------------------------------------------------------------------
-- 4. A patient who comes again the same day after their done row was taken off the sheet gets a visit of their own (keep_rows only)
-- ---------------------------------------------------------------------
-- Is this visit (or checkup) done (Completed, Treatment) and taken off the sheet while done (private.aaj_released, aaj_removals above)?
create or replace function private.aaj_off_done(p_visit uuid, p_checkup uuid) returns boolean
language sql stable set search_path = public, extensions
as $$
  select case when p_visit is not null then
           exists (select 1 from private.aaj_released rl join public.visits x on x.id = rl.visit_id
                    where rl.visit_id = p_visit and rl.status in ('completed', 'in_treatment') and x.status in ('completed', 'in_treatment'))
         else
           exists (select 1 from private.aaj_released rl join public.checkups x on x.id = rl.checkup_id
                    where rl.checkup_id = p_checkup and rl.status in ('completed', 'in_treatment') and x.day_status in ('completed', 'in_treatment')) end
$$;

-- private.aaj_sync_row: the body of 20261011000100_aaj_sync_quiet_token.sql (checked identical to the live database on 17 Oct 2026, md5 of
-- the body 804b68081788e59bbb938e6588d646a4) with one change, for a call that says keep_rows: a new row that is not done (Waiting,
-- Scheduled or no Status) never adopts a visit of its patient that is done and was taken off the sheet, nor a checkup registered as them
-- that is (v_keepnew, aaj_off_done): it makes a visit of its own, which says "Second visit of this patient today: the first (...) is done
-- and was taken off the sheet." (information: the row is a tick). Owner, 17 Oct 2026: the assistant deletes the rows after entering them
-- in Healthwire; a patient who then comes again for another treatment is typed in a new row, and before this change that row took the
-- morning's done visit (its Status and Treatment were written over the new row) and the second treatment was never recorded. A row
-- without an Mr# (a checkup) keeps adopting its checkup: a checkup patient typed again the same day is the same lead.
-- Besides, the body is written without a backslash (the live apply tool decodes them): the two whitespace patterns use [[:space:]] instead
-- of the backslash-s class, and the three error-code tests compare the code's first letters instead of a LIKE with escaped underscores. The
-- same tests. 673 lines.
create or replace function private.aaj_sync_row(
  p_branch smallint, p_tab text, p_date date, p_row jsonb, p_present text[], p_admin uuid, p_rules text)
returns jsonb
language plpgsql volatile set search_path = public, extensions
as $$
declare
  v_key text := p_row->>'key';
  v_set jsonb := case when jsonb_typeof(p_row->'set') = 'object' then p_row->'set' else '{}'::jsonb end;
  v_base jsonb := case when jsonb_typeof(p_row->'base') = 'object' then p_row->'base' end;
  v_edit numeric := case when (p_row->>'edited_at') ~ '^[0-9]{1,15}([.][0-9]+)?$' then (p_row->>'edited_at')::numeric end;
  v_now_ms numeric := extract(epoch from now()) * 1000;
  v public.visits;            -- the visit as stored
  n public.visits;            -- the visit as it should be
  e public.visits;
  v_found boolean := false;
  v_create boolean := false;
  v_outcome text;
  c jsonb := null;
  v_newer boolean := false;
  v_f text; v_dec text; v_st text; v_err0 text;
  v_decs jsonb := '{}'::jsonb; v_same jsonb := '{}'::jsonb;
  v_kept text[] := '{}'; v_lost jsonb := '{}'::jsonb;
  v_msgs text[] := '{}'; v_level text := 'ok'; v_over text[] := '{}';
  v_changed text[] := '{}';
  v_pid uuid; v_pat public.patients; v_find jsonb; v_oc text; v_mr text; v_onlist boolean := false;
  v_pc text := null; v_dup text := null; v_ek text; v_cid uuid;
  v_mv int; v_mt text; v_case uuid; v_tv int; v_tt text; v_sv text; v_gv int;
  v_ign uuid; v_slip_held text;
  v_try int := 0; v_con text; v_err text; v_dirty boolean; v_label text; v_old_token int; v_token_asked boolean := false;
  -- doctors
  v_dwant boolean := false; v_sheet_set text[] := '{}'; v_base_set text[] := '{}'; v_web_set text[]; v_res text[];
  v_ids text[]; v_unm text[] := '{}'; v_dt text; r record;
  v_padd boolean := false; v_pend text[] := '{}';
  -- keep_rows (20261017000100): a new row that is not done, of a patient whose visit of today is done and was taken off the sheet
  v_keepnew boolean := false; v_off_t text;
begin
  v_edit := case when v_edit > v_now_ms + 300000 then v_now_ms else v_edit end;       -- a clock far in the future counts as now

  -- ---- the row's shape ----
  v_err0 := private.aaj_row_check(p_row);
  if v_err0 is not null then return private.aaj_result(v_key, 'error', 'error', v_err0); end if;

  -- ---- which visit is this row ----
  if left(v_key, 2) = 'W-' then
    select * into v from public.visits where id = substr(v_key, 3)::uuid for update;
  else
    select * into v from public.visits where sheet_key = v_key for update;
  end if;
  v_found := found;
  if not v_found then            -- a checkup patient?
    if left(v_key, 2) = 'W-' then select id into v_cid from public.checkups where id = substr(v_key, 3)::uuid;
    else select id into v_cid from public.checkups where sheet_key = v_key; end if;
    if v_cid is not null then return private.aaj_sync_checkup_row(p_branch, p_tab, p_date, p_row, v_cid); end if;
  end if;
  if v_found and left(v_key, 2) = 'W-' and v.sheet_key is not null and v.sheet_key <> v_key then
    return private.aaj_result(v_key, 'superseded', 'error', 'This row was replaced by another row for the same visit.', v.id);
  end if;
  -- moved to another branch or day on the website (see aaj_sync_checkup_row): the row is kept as "deleted on the website" by the script
  if v_found and (v.branch_id <> p_branch or v.visit_date <> p_date) then
    return private.aaj_result(v_key, 'other_list', 'error', 'This visit was moved to another branch or day on the website. Delete this row.');
  end if;
  if not v_found and (left(v_key, 2) = 'W-' or not coalesce((p_row->>'new')::boolean, false)) then
    return private.aaj_result(v_key, 'gone', 'error', 'This visit was deleted on the website. Delete this row.');
  end if;

  v_outcome := case when v_found then 'updated' else 'created' end;

  -- ---- a new row: no Mr# and a Treatment that says checkup is a checkup patient; an Mr# must be a patient the website knows (or a Healthwire number) ----
  if not v_found then
    v_mr := nullif(btrim(v_set->>'mr'), '');
    if v_mr is null or upper(v_mr) = 'NEW' then
      -- a checkup of today whose row lost its hidden key (cut and pasted, the helper columns deleted, a sort of the visible columns), or the
      -- same person typed again: the row is that checkup, whatever its Treatment says (the website's Checkups page writes "Scaling",
      -- "Braces consultation" ...). Otherwise the checkup would be removed as a deleted row, or made twice. Never a row with a Month: a
      -- checkup has none, so the Month was typed because the person turned out to be a braces patient (sheet-behaviour M2, loop 7).
      if btrim(coalesce(v_set->'month'->>'t', '')) = '' then
        v_cid := private.aaj_checkup_twin(p_branch, p_date, v_key, v_set->>'name', v_set->>'phone', p_present);
        if v_cid is not null then return private.aaj_sync_checkup_row(p_branch, p_tab, p_date, p_row, v_cid, true); end if;
        -- that person's checkup is in another row of the tab now: a copy, or the person typed twice. Refused like a second visit of one
        -- patient (the script names the row), never a second checkup (sheet-behaviour RV-1). Deleting the other row lets this one adopt it.
        v_dup := private.aaj_checkup_dup(p_branch, p_date, v_key, v_set->>'name', v_set->>'phone', p_present);
        if v_dup is not null then
          return private.aaj_result(v_key, 'duplicate', 'error',
            'Already on this list in another row (the same checkup patient). Delete this row. If this is another person, correct the name or the phone.',
            null, '{}', v_dup);
        end if;
      end if;
      -- owner, 9 Oct 2026 (13:20): only a Treatment that says checkup makes a row without an Mr# a checkup. Any other treatment is an existing
      -- patient whose Mr# staff forgot: a person looks it up in Healthwire. Nothing is guessed, filed as a checkup or made into a patient.
      if not private.aaj_is_checkup_text(v_set->>'treatment') then
        return private.aaj_result(v_key, 'needs_patient', 'error',
          'Needs attention: add the Mr#. A row with no Mr# is a checkup only when its Treatment says checkup. Look the Mr# up in Healthwire.');
      end if;
      -- a braces month on the row ("6", "04 Photo") is a braces patient whose Mr# was forgotten, never a checkup
      if btrim(coalesce(v_set->'month'->>'t', '')) <> '' then
        return private.aaj_result(v_key, 'needs_patient', 'error',
          'Needs attention: add the Mr#. A row with a Month is a braces patient, never a checkup. Look the Mr# up in Healthwire.');
      end if;
      return private.aaj_sync_checkup_row(p_branch, p_tab, p_date, p_row, null);
    end if;
    if v_mr !~ '^[A-Za-z0-9_-]+$' or v_mr !~ '[0-9]' then
      return private.aaj_result(v_key, 'needs_patient', 'error', format('"%s" is not a Mr#. Type the number only, or leave it empty for a checkup patient.', left(v_mr, 30)));
    end if;
    -- a "name" of one letter is no name: answered before anything is looked up, whatever the Mr#. (A Healthwire number nobody has and one the
    -- website has would otherwise get different answers, one of them neither audited nor counted: a free check of which numbers are taken.)
    if length(btrim(coalesce(v_set->>'name', ''))) < 2 then
      return private.aaj_result(v_key, 'needs_patient', 'error', 'Patient name is too short.');
    end if;
    -- after 5 new refused lookups in one call the call's other new Mr# rows are not looked at: they wait for a later call (the script sends a
    -- refused row again after a few minutes). A real tab rarely has more than one or two wrong Mr# at a time, and a row refused earlier today
    -- that is sent again does not count, so the good rows always get through within a few calls.
    if coalesce(nullif(current_setting('aaj.refused', true), ''), '0')::int >= 5 then
      return private.aaj_result(v_key, 'needs_patient', 'error', 'Too many rows the website could not place at once. This row is tried again in a few minutes.');
    end if;
    v_find := private.aaj_check_mr(p_branch, p_date, v_mr, v_set->>'name', v_set->>'phone');
    -- the name and phone are filed under a patient the sync made today from a row that has left the sheet (a Healthwire Mr# typed with a slip,
    -- 9888 for 9878, that staff have just corrected: the script sends the corrected row under a new key). That file goes with its row's visit
    -- (aaj_removals), so the row is looked at without it: never "Use 9888", the slip itself (sheet-behaviour M3, loop 7).
    if v_find->>'outcome' = 'mr_other' then
      select o.id into v_ign from public.patients o
       where o.mr_number = v_find->>'mr' and o.legacy_source = 'aaj_sheet_sync' and o.created_by = private.aaj_sync_actor()
         and o.created_at >= ((now() at time zone 'Asia/Karachi')::date)::timestamp at time zone 'Asia/Karachi'
         and exists (select 1 from public.visits x where x.patient_id = o.id)
         and not exists (select 1 from public.visits x where x.patient_id = o.id
                            and (x.branch_id <> p_branch or x.visit_date <> p_date or x.sheet_key is null or x.sheet_key = any (coalesce(p_present, '{}'))));
      if v_ign is not null then v_find := private.aaj_check_mr(p_branch, p_date, v_mr, v_set->>'name', v_set->>'phone', v_ign); end if;
    end if;
    v_oc := v_find->>'outcome';
    -- keep_rows (20261017000100_aaj_keep_rows.sql): a new row that is not done (Waiting, Scheduled or no Status) of a patient whose visit of
    -- today is done (Completed, Treatment) and was taken off the sheet (private.aaj_released, aaj_off_done) is that patient come again for
    -- another treatment: it gets a visit of its own (the day's cap applies), and the done visit stays as it is, off the sheet. Before, the
    -- new row adopted the done visit and was overwritten with its Status and Treatment, and the second treatment was never recorded
    -- (sheet-behaviour REV2 R2B). A new row that says Completed or Treatment is that visit's own row back (a Ctrl+Z of cleared cells whose
    -- hidden key was let go) and adopts it as before. Only in a call of the script that keeps rows (the old script never takes a done row off).
    v_keepnew := coalesce(current_setting('aaj.keep_rows', true), '') = 'on'
                 and coalesce(nullif(v_set->'status'->>'v', ''), 'waiting') in ('waiting', 'scheduled');
    -- the patient is on today's list already (a visit, or a checkup registered as them): the sheet sees them anyway
    v_onlist := v_oc = 'mr' and (exists (select 1 from public.visits x where x.patient_id = (v_find->>'patient_id')::uuid
                                                and x.branch_id = p_branch and x.visit_date = p_date
                                                and not (v_keepnew and private.aaj_off_done(x.id, null)))
                                 or exists (select 1 from public.checkups x where x.patient_id = (v_find->>'patient_id')::uuid and x.branch_id = p_branch
                                               and x.checkup_date = p_date and x.source <> 'archive' and not x.date_is_month
                                               and not (v_keepnew and private.aaj_off_done(null, x.id))));

    -- the day's visit cap is full: every row that would make a new visit gets the same answer, whatever the lookup found. (Otherwise a
    -- fitting name and a wrong one would get different answers with nothing made: a free check of the name behind an Mr#.) Only a row that
    -- meets a visit this list already has (the patient is on today's list, which the sheet sees anyway) goes on.
    if private.aaj_visit_cap_hit(p_branch, p_date) and not v_onlist then
      return private.aaj_result(v_key, 'needs_patient', 'error', 'Too many patients added from the sheet today. Add this one on the website.');
    end if;
    -- the day's 200 refused lookups are used up: the same, for every row that would make a visit or a patient. A row that fits would
    -- otherwise make a visit (and get the patient's phone and dues back) while a wrong guess got a refusal that is neither audited nor
    -- counted: a free check of the name behind an Mr#. The answer counts for this call's five. A refused row sent again (already in the
    -- audit log today) gets its own answer below: nothing new is learnt from it.
    if not v_onlist and private.aaj_lookups_used_up()
       and (v_oc in ('mr', 'mr_new') or not private.aaj_lookup_seen(v_key, v_mr, v_oc, v_set->>'name', v_set->>'phone')) then
      perform set_config('aaj.refused', (coalesce(nullif(current_setting('aaj.refused', true), ''), '0')::int + 1)::text, true);
      return private.aaj_result(v_key, 'needs_patient', 'error', 'Too many rows the website could not place today. Add this patient on the website.');
    end if;

    if v_oc = 'mr' then
      -- the name fits the patient without doubt (aaj_check_mr refuses a row that fits only with doubt)
      v_pid := (v_find->>'patient_id')::uuid;
      select * into v_pat from public.patients where id = v_pid;
    elsif v_oc = 'mr_new' then
      -- a Healthwire number the website has not seen yet: the patient is created with it, flagged for a check
      if length(btrim(coalesce(v_set->>'name', ''))) < 2 then
        return private.aaj_result(v_key, 'needs_patient', 'error', 'Patient name is too short.');
      end if;
      if (select count(*) from public.patients where legacy_source = 'aaj_sheet_sync' and first_branch_id = p_branch
             and (created_at at time zone 'Asia/Karachi')::date = (now() at time zone 'Asia/Karachi')::date)
         >= coalesce((select value::int from private.aaj_sync_config where key = 'new_patients_per_branch_day'), 30) then
        -- audited and counted like a refused lookup: otherwise a number nobody has would get this answer for free while a taken one gets the
        -- audited "does not match" (a free check of which numbers exist, abuse-privacy minor, loop 8)
        perform private.aaj_note_lookup(p_tab, v_key, v_mr, 'mr_cap', v_set->>'name', v_set->>'phone');
        return private.aaj_result(v_key, 'needs_patient', 'error', 'Too many new patients from the sheet today. Add this one on the website.');
      end if;
      insert into public.patients (mr_number, full_name, phone, first_branch_id, legacy_source, legacy_name, notes, created_by)
      values (v_mr, btrim(v_set->>'name'), private.aaj_norm_phone(v_set->>'phone'), p_branch, 'aaj_sheet_sync',
              case when lower(btrim(coalesce(v_set->>'legacy_name', ''))) <> lower(btrim(v_set->>'name')) then nullif(btrim(v_set->>'legacy_name'), '') end,
              'Added from the Google Sheet with Healthwire Mr# ' || v_mr || ' (' || p_tab || ', ' || to_char(p_date, 'DD Mon YYYY') || '). Check name and phone.',
              private.aaj_sync_actor())
      returning * into v_pat;
      v_pid := v_pat.id; v_pc := v_pat.mr_number; v_level := 'warn';
      v_msgs := v_msgs || format('New patient added with Healthwire Mr# %s. Check the name and phone on the website.', v_pc);
      -- within 20 of the limit: say so before new patients start being refused (sheet-behaviour RW8-3)
      if v_mr::int > private.aaj_hw_limit() - 20 then
        v_msgs := v_msgs || 'Healthwire numbers are close to the newest ones the website knows: ask Dr. Ali to import the latest Healthwire patients.'::text;
      end if;
      insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
      values ('patients', v_pid::text, 'SHEET_SYNC', null,
              jsonb_build_object('mr', v_pc, 'name', v_pat.full_name, 'phone', v_pat.phone, 'tab', p_tab, 'outcome', v_oc), private.aaj_sync_actor());
    else
      -- nothing is created or linked: no visit, no checkup, no phone, no braces case, nothing on the patient file (also for a name that fits
      -- only with doubt, which aaj_check_mr answers as mr_name / mr_noname). The refusal is audited, counted for this call and capped
      -- (aaj_note_lookup). It never names the patient of the typed Mr# (the secret is not a way to turn Mr# into names). The Mr# under which
      -- this very name and phone are filed is told only when that patient was seen at this branch: the row already carries their name and
      -- phone, and the name in the answer is the row's own.
      if not private.aaj_note_lookup(p_tab, v_key, v_mr, v_oc, v_set->>'name', v_set->>'phone') then      -- (not reached: the check above answers first)
        return private.aaj_result(v_key, 'needs_patient', 'error', 'Too many rows the website could not place today. Add this patient on the website.');
      end if;
      return private.aaj_result(v_key, 'needs_patient', 'error', case v_oc
        when 'mr_noname' then format('Needs attention: Mr# %s: the name in this row cannot be read. Type the patient''s name in English letters, as the website has it.', v_mr)
        -- the Mr# may be right and the name spelt another way: the answer says so, and never names the patient (sheet-behaviour RS5-N1)
        when 'mr_name' then format('Needs attention: the name in this row does not match Mr# %s on the website. Check the Mr#, or type the name as the website has it.', v_mr)
        when 'mr_other' then case when (v_find->>'seen')::boolean
                                  then format('Mr# %s is not on the website, but %s with this phone is Mr# %s. Use %s.', v_mr, left(btrim(coalesce(v_set->>'name', '')), 60), v_find->>'mr', v_find->>'mr')
                                  else format('Mr# %s is not on the website, and this name and phone are filed under another Mr#. Check the number.', v_mr) end
        -- a retired number of the patient this row fits (renumbered to 50000+, or merged): their Mr# now, never a second file under the old one
        when 'mr_moved' then format('Mr# %s is no longer used. This patient''s Mr# is now %s. Use %s.', v_mr, v_find->>'mr', v_find->>'mr')
        -- a Healthwire number above aaj_hw_limit(): Healthwire has not given it yet (abuse-privacy M-HW-SQUAT). Front desk cannot give a
        -- Healthwire number on the website (a new patient there gets 50000+), so the answer never says to add the patient there: that would give
        -- the patient a second number (sheet-behaviour RW8-3)
        when 'mr_ahead' then format('Mr# %s is not on the website and is higher than the newest Healthwire numbers it knows, so it looks like a typo. Check the Mr#. If it is right (a new Healthwire patient), ask Dr. Ali to import the latest Healthwire patients; this row is tried again every few minutes.', v_mr)
        else format('Mr# %s is not on the website. Check the number.', v_mr) end);
    end if;

    -- does this patient already have a visit on this list?
    select * into e from public.visits where patient_id = v_pid and branch_id = p_branch and visit_date = p_date
       and not (v_keepnew and private.aaj_off_done(visits.id, null))           -- (keep_rows: see v_keepnew above)
     order by (status <> 'cancelled') desc, created_at, id limit 1 for update;
    if found then
      v_ek := coalesce(e.sheet_key, 'W-' || e.id::text);
      if v_ek = any (coalesce(p_present, '{}')) and v_ek <> v_key then
        v_dup := v_ek;
        return private.aaj_result(v_key, 'duplicate', 'error',
          format('Already on this list in another row (Mr# %s). Put both treatments in one row and delete this one.', v_pat.mr_number),
          e.id, '{}', v_dup);
      end if;
      select * into v from public.visits where id = e.id;
      v_found := true; v_outcome := 'linked';
    elsif v_oc = 'mr' and btrim(coalesce(v_set->'month'->>'t', '')) = '' then
      -- no visit, but a checkup of today registered as this patient whose row is not on the sheet (the row lost its hidden key, and the
      -- website had written the Mr# into it): the row is that checkup. It is adopted, never turned into a visit. A row with a Month is
      -- never a checkup: it is the patient's visit (a registered checkup row the script let go because a Month was typed into it).
      select x.id into v_cid from public.checkups x
       where x.patient_id = v_pid and x.branch_id = p_branch and x.checkup_date = p_date and x.source <> 'archive' and not x.date_is_month
         and coalesce(x.sheet_key, 'W-' || x.id::text) <> v_key and not (coalesce(x.sheet_key, 'W-' || x.id::text) = any (coalesce(p_present, '{}')))
         and not (v_keepnew and private.aaj_off_done(null, x.id))
       order by x.created_at, x.id limit 1;
      if v_cid is not null then return private.aaj_sync_checkup_row(p_branch, p_tab, p_date, p_row, v_cid, true); end if;
    end if;
    -- (a new visit at the daily cap was refused above, before the lookup's answer was used)
  else
    v_pid := v.patient_id;
  end if;

  -- ---- a row already linked to a visit whose name is typed over with a name that does not fit that visit's patient without doubt ----
  -- (somebody else typed over the row, the Mr# left as it was): the visit is never re-pointed and nothing from the row is applied to it,
  -- not the Treatment, Status, Month or anything else. Every answer says so while the name stands (sheet-behaviour L2-residual: before,
  -- only the first answer warned and the next Status edit showed a plain tick on the other patient's visit); the script keeps sending the
  -- name until it is answered without an error. Once the name is put right (or the Mr#, which makes it a new row), the row goes through.
  -- The visit's patient is on today's list (the sheet sees them anyway); the answer still does not name them.
  if v_outcome = 'updated' and v_set ? 'name' then
    select * into v_pat from public.patients where id = v.patient_id;
    if not private.aaj_name_fits(v_set->>'name', v_pat.full_name)
       and lower(regexp_replace(btrim(coalesce(v_set->>'name', '')), '[[:space:]]+', ' ', 'g')) <> lower(regexp_replace(btrim(v_pat.full_name), '[[:space:]]+', ' ', 'g')) then
      return private.aaj_result(v_key, 'error', 'error',
        format('Needs attention: the name in this row does not match Mr# %s on the website. Check the Mr# or the name: nothing in this row is saved until they match.', v_pat.mr_number), v.id);
    end if;
  end if;

  -- ---- a row already linked to a visit whose Mr# cell now holds another number ----
  -- The script sends it under the visit's key only while the row's name and phone are still that person: a slip of a finger in the Mr# cell
  -- (token 7 typed into the Mr# cell, a digit too many). The visit is never moved to another patient, never removed for it, and nothing is
  -- made: the website's Mr# goes back into the cell (further below, like an emptied Mr# cell) and the rest of the row is saved as usual
  -- (sheet-behaviour RW8-1, 11 Oct 2026; before, the row became a new row and the removal pass deleted the visit with front desk's notes).
  -- One exception: a patient file the sync made from this very row today (a Healthwire Mr# typed with a slip, 9888 for 9878) is no proof of
  -- who the row is. When the new number looks like the correction of a slip (a Healthwire number, at most two digits away from the old one),
  -- the row is let go ("rekey"): the script sends it again as a new row with the corrected Mr#, and the file made from the slip goes with its
  -- visit (aaj_removals, sheet-behaviour M3, loop 7). Anything else (token 7 typed into the cell, a digit too many) is a slip on that file
  -- too and is written back like on any other visit; a really wrong number is corrected by typing the patient again in a new row.
  -- The visit made under the slip then goes like a deleted row whatever its status (aaj_note_let_go, sheet-behaviour RV9-2: before, a visit
  -- already Completed stayed with the file made from the slip, next to the right patient's Completed visit). So the row is let go only while
  -- nothing real hangs on that visit (an invoice, a photo, a checker); otherwise the Mr# is written back and the file is put right on the
  -- website, where its attached records go with it.
  if v_outcome = 'updated' and v_set ? 'mr' then
    v_mr := nullif(btrim(v_set->>'mr'), '');
    select * into v_pat from public.patients where id = v.patient_id;
    if v_mr is not null and v_mr ~ '^[1-9][0-9]{0,4}$' and v_mr::int < 50000 and v_mr is distinct from v_pat.mr_number
       and private.aaj_lev(v_mr, v_pat.mr_number) <= 2
       and v_pat.legacy_source = 'aaj_sheet_sync' and v_pat.created_by = private.aaj_sync_actor()
       and v_pat.created_at >= ((now() at time zone 'Asia/Karachi')::date)::timestamp at time zone 'Asia/Karachi'
       and not exists (select 1 from public.visits x where x.patient_id = v_pat.id and x.id <> v.id) then
      v_slip_held := coalesce(private.aaj_visit_attached(v.id), case when v.photos_uploaded then 'photos' when v.checked_by is not null then 'a checker' end);
      if v_slip_held is null then
        perform private.aaj_note_let_go('visits', v.id, v_key, p_tab, 'mr_slip');
        return private.aaj_result(v_key, 'rekey', 'warn', format('Mr# changed from %s to %s: this row is sent again with the new Mr#.', v_pat.mr_number, left(v_mr, 20)), v.id);
      end if;
    end if;
  end if;

  -- ---- the visit as it should be ----
  if v_found then
    n := v;
    n.sheet_key := case when v.sheet_key is null or v_outcome = 'linked' then v_key else v.sheet_key end;
    n.sheet_cells := coalesce(v.sheet_cells, '{}'::jsonb);
    c := private.aaj_canon(v.id);
    -- an ADOPTED visit (the sheet row met a visit the website already had): a cell typed after the website's last change wins, like on a
    -- linked row (sheet-behaviour RS5-A1: a patient whose cancelled row was deleted and who is typed again when she turns up is not left
    -- Cancelled, and "Completed / RCT" typed for a visit front desk added as "Waiting / Consultation" is not reverted). A visit already in
    -- Treatment or Completed keeps the website's text, and the status only moves forward (aaj_adopt_status): a stale install-day sheet
    -- never sets a Completed visit back to Waiting. A row with no edit time (Set up stamped it, nobody edited it since) keeps the website's
    -- text, but its Completed still completes a Waiting visit (aaj_adopt_status, sheet-behaviour SB7-2).
    v_newer := coalesce(v_edit, 0) > extract(epoch from v.updated_at) * 1000
               and not (v_outcome = 'linked' and v.status in ('in_treatment', 'completed'));
  else
    v_create := true;
    n.id := gen_random_uuid(); n.patient_id := v_pid; n.branch_id := p_branch; n.visit_date := p_date;
    n.status := 'waiting'; n.created_by := private.aaj_sync_actor(); n.sheet_key := v_key; n.sheet_cells := '{}'::jsonb;
    if v_keepnew then
      select coalesce(nullif(btrim(x.treatment_label), ''), 'a visit') into v_off_t from public.visits x
       where x.patient_id = v_pid and x.branch_id = p_branch and x.visit_date = p_date and private.aaj_off_done(x.id, null)
       order by x.created_at desc, x.id desc limit 1;
      if v_off_t is not null then
        v_msgs := v_msgs || format('Second visit of this patient today: the first (%s) is done and was taken off the sheet.', left(v_off_t, 60));
      end if;
    end if;
  end if;
  n.sheet_cells := n.sheet_cells || jsonb_build_object('tab', p_tab);
  -- a row typed just now (after the website's last change) for a patient whose visit is Cancelled / No show, with no Status typed: the
  -- patient is here (a new row starts as Waiting), so the visit is brought back as Waiting (sheet-behaviour RS5-A1)
  if v_outcome = 'linked' and v.status in ('cancelled', 'no_show') and not (v_set ? 'status')
     and coalesce(v_edit, 0) > extract(epoch from v.updated_at) * 1000 then
    v_set := v_set || jsonb_build_object('status', jsonb_build_object('t', 'Waiting', 'v', 'waiting'));
  end if;

  -- who wins each field
  foreach v_f in array array['month', 'treatment', 'token', 'status', 'group', 'details'] loop
    if v_set ? v_f then
      v_st := case when v_f in ('month', 'token', 'status', 'group') then coalesce(v_set->v_f->>'t', '') else coalesce(v_set->>v_f, '') end;
      v_dec := case when v_create then 'apply'
                    when v_f = 'status' and v_outcome = 'linked' and lower(c->>v_f) is distinct from lower(v_st)
                      then private.aaj_adopt_status(v.status::text, nullif(v_set->'status'->>'v', ''), v_edit > extract(epoch from v.updated_at) * 1000)
                    when v_f = 'status' then private.aaj_decide(lower(c->>v_f), case when v_base is not null then lower(coalesce(v_base->>v_f, '')) end, lower(v_st), v_base is not null, v_newer)
                    -- an adopted visit keeps the website's Month, Token and Group unless it has none: the token is numbered per branch here and
                    -- per group in the sheet, and the braces month and doctor group belong to the website's rules
                    else private.aaj_decide(c->>v_f, case when v_base is not null then coalesce(v_base->>v_f, '') end, v_st, v_base is not null,
                                            v_newer and not (v_outcome = 'linked' and v_f in ('month', 'token', 'group'))) end;
      if v_dec = 'keep' then
        v_kept := array_append(v_kept, v_f); v_lost := v_lost || jsonb_build_object(v_f, v_st);
      elsif v_dec = 'same' then
        v_same := v_same || jsonb_build_object(v_f, true);
      else
        v_decs := v_decs || jsonb_build_object(v_f, true);
      end if;
    end if;
  end loop;

  -- (A row whose name fits its patient only with doubt never gets this far: a new one is refused by aaj_check_mr, a linked one whose name
  -- is typed over is answered above. So a Month here is always the Mr# patient's own.)

  -- month: the braces case behind it
  if v_decs ? 'month' then
    v_mv := nullif(v_set->'month'->>'v', '')::int; v_mt := coalesce(v_set->'month'->>'t', '');
    if v_mv between 1 and 60 then
      select id into v_case from public.braces_cases where patient_id = n.patient_id and status = 'active';
      if v_case is null and exists (select 1 from public.braces_cases where patient_id = n.patient_id) then
        v_msgs := v_msgs || format('Month %s: this patient''s braces case is closed on the website. Check it there.', v_mv); v_level := 'warn';
        v_mv := null;
      elsif v_case is null then
        begin
          insert into public.braces_cases (patient_id, start_date, bonding_branch_id, status, notes, created_by)
          values (n.patient_id, p_date - (v_mv - 1) * 30, p_branch, 'active',
                  'From the Google Sheet: month ' || v_mv || ' on ' || to_char(p_date, 'DD Mon YYYY') || ' (' || p_tab || '). Check the start date and kit.',
                  private.aaj_sync_actor())
          returning id into v_case;
        exception when unique_violation then
          select id into v_case from public.braces_cases where patient_id = n.patient_id and status = 'active';
        end;
      end if;
      if v_mv is not null then n.braces_case_id := v_case; n.braces_month := v_mv; end if;
    elsif v_mv is null and v_mt = '' then
      n.braces_month := null; n.braces_case_id := null;
    elsif v_mv is not null then
      v_msgs := v_msgs || format('Month %s is not a braces month (1 to 60).', v_mv); v_level := 'warn'; v_mv := null;
    end if;
    n.sheet_cells := n.sheet_cells || jsonb_build_object('month', jsonb_build_object('t', v_mt, 'v', v_mv));
  end if;

  if v_decs ? 'treatment' then
    n.treatment_label := nullif(btrim(v_set->>'treatment'), '');
    n.treatment_id := (select t.id from public.treatments t where t.active and lower(t.name) = lower(btrim(coalesce(v_set->>'treatment', ''))));
  end if;

  -- token: one per branch and day on the website; the sheet numbers per treatment category and also writes kit text here.
  -- Owner's rule (11 Oct 2026): tokens are numbered per treatment category (checkup, monthly, surgery and the rest, and Dr. Ali's own),
  -- so a number another visit of this branch and day already holds is normal: no message and no warning, the row gets a plain tick.
  -- The website keeps its own token (one per branch and day); the sheet keeps its typed one ("own": the cell is never rewritten).
  if v_decs ? 'token' then
    v_tt := coalesce(v_set->'token'->>'t', ''); v_tv := nullif(v_set->'token'->>'v', '')::int;
    if v_tv between 1 and 999 then
      if exists (select 1 from public.visits x
                  where x.branch_id = p_branch and x.visit_date = p_date and x.token_no = v_tv and x.id is distinct from n.id) then
        n.sheet_cells := n.sheet_cells || jsonb_build_object('token', jsonb_build_object('t', v_tt, 'v', v_tv, 'own', true));
      else
        n.token_no := v_tv; v_token_asked := true;
        n.sheet_cells := n.sheet_cells || jsonb_build_object('token', jsonb_build_object('t', v_tt, 'v', v_tv));
      end if;
    elsif v_tt = '' then
      n.token_no := null;
      n.sheet_cells := n.sheet_cells - 'token';
    else
      n.sheet_cells := n.sheet_cells || jsonb_build_object('token', jsonb_build_object('t', v_tt, 'v', null));   -- "Kit 80k": text only
    end if;
  end if;

  if v_decs ? 'status' then
    v_sv := nullif(v_set->'status'->>'v', '');
    if v_sv is null or v_sv not in ('scheduled', 'waiting', 'in_treatment', 'completed', 'cancelled', 'no_show') then
      v_msgs := v_msgs || format('Status "%s" not understood. Use Waiting, Treatment, Completed, Scheduled, Cancelled or No show.', coalesce(v_set->'status'->>'t', ''));
      v_level := 'warn';
    else
      n.status := v_sv::public.visit_status;
    end if;
  end if;

  if v_decs ? 'group' then
    v_gv := nullif(v_set->'group'->>'v', '')::int;
    if v_gv is not null and not exists (select 1 from public.doctor_groups where id = v_gv) then v_gv := null; end if;
    n.doctor_group_id := v_gv;
    n.sheet_cells := n.sheet_cells || jsonb_build_object('group', jsonb_build_object('t', coalesce(v_set->'group'->>'t', ''), 'v', v_gv));
  end if;

  if v_decs ? 'details' then n.details_text := nullif(btrim(v_set->>'details'), ''); end if;

  -- fields where both sides already say the same: no column is touched, the sheet's own wording is remembered if nothing is stored yet
  foreach v_f in array array['month', 'token', 'group'] loop
    if v_same ? v_f and not (n.sheet_cells ? v_f) and coalesce(v_set->v_f->>'t', '') <> '' then
      n.sheet_cells := n.sheet_cells || jsonb_build_object(v_f, jsonb_build_object('t', v_set->v_f->>'t', 'v', nullif(v_set->v_f->>'v', '')::int));
    end if;
  end loop;

  -- a new "Monthly" visit with no month typed: the website picks the next month of the patient's active case (as addVisit does)
  if v_create and n.braces_case_id is null and coalesce(n.treatment_label, '') ~* 'monthly' and not (v_set ? 'month') then
    n.braces_case_id := (select id from public.braces_cases where patient_id = n.patient_id and status = 'active');
  end if;

  -- the patient on a row that is already linked is never changed; the website's Mr# goes back into the cell
  if v_found and v_outcome = 'updated' then
    if v_set ? 'mr' then
      v_mr := nullif(btrim(v_set->>'mr'), '');
      select * into v_pat from public.patients where id = n.patient_id;
      if v_mr is null or upper(v_mr) = 'NEW' then v_kept := array_append(v_kept, 'mr'::text);
      elsif v_mr <> v_pat.mr_number then
        -- (the row's name fits this visit's patient: a name that does not was answered above, before anything was decided)
        v_kept := array_append(v_kept, 'mr'::text); v_level := 'warn';
        if v_slip_held is not null then
          -- the correction of a slip on a file the sync made from this row today, held back because something hangs on the visit (above)
          v_msgs := v_msgs || format('Mr# %s is put back: this visit has an attached record (%s) on the website, so the row is not moved to Mr# %s. If %s is the right Mr#, correct the patient file on the website.',
                                     v_pat.mr_number, v_slip_held, left(v_mr, 20), left(v_mr, 20));
        else
          v_msgs := v_msgs || format('Mr# %s is not this visit''s patient, so Mr# %s is put back. If this row is another patient, delete it and type that patient in a new row.',
                                     left(v_mr, 20), v_pat.mr_number);
        end if;
      end if;
    end if;
    -- (a name that does not fit this visit's patient without doubt was answered above, before anything was decided)
    -- a phone changed in the sheet is not copied into the patient file (it is the patient's, not the visit's): say so instead of showing a
    -- green tick. Compared with the phone the sheet is shown only: comparing with the patient's second phone too, which the sheet never
    -- gets, would confirm a guessed second number with no trace (abuse-privacy minor, loop 6).
    if v_set ? 'phone' and private.aaj_norm_phone(v_set->>'phone') is not null then
      select * into v_pat from public.patients where id = n.patient_id;
      if nullif(v_pat.phone, '0000000') is not null and private.aaj_norm_phone(v_set->>'phone') is distinct from private.aaj_norm_phone(v_pat.phone) then
        v_msgs := v_msgs || 'The phone in this row is not the patient''s phone on the website. Change it in the patient file.'::text; v_level := 'warn';
      end if;
    end if;
  end if;

  -- doctors: both sides' additions and removals are kept
  if v_set ? 'doctors' then
    v_dwant := true;
    select coalesce(array_agg(el order by o), '{}') into v_sheet_set from (
      select distinct on (el) el, o from (
        select coalesce(private.aaj_match_clinician(d)::text, case when private.aaj_doctor_key(d) <> '' then 'raw:' || private.aaj_doctor_key(d) end) as el, o
          from jsonb_array_elements_text(v_set->'doctors'->'v') with ordinality t(d, o)) x
       where el is not null order by el, o) y;
    if v_base is not null and jsonb_typeof(v_base->'doctors') = 'array' then
      select coalesce(array_agg(distinct el), '{}') into v_base_set from (
        select coalesce(private.aaj_match_clinician(d)::text, case when private.aaj_doctor_key(d) <> '' then 'raw:' || private.aaj_doctor_key(d) end) as el
          from jsonb_array_elements_text(v_base->'doctors') d) x where el is not null;
    end if;
    v_web_set := array(select distinct clinician_id::text from public.visit_staff where visit_id = n.id and role in ('doctor', 'assistant'))
              || array(select 'raw:' || private.aaj_doctor_key(u) from jsonb_array_elements_text(coalesce(n.sheet_cells->'doctors'->'unmatched', '[]'::jsonb)) u)
              || array(select jsonb_array_elements_text(coalesce(n.sheet_cells->'doctors'->'pending', '[]'::jsonb)));       -- doctors waiting for Completed stay in the row
    if v_base is not null then
      v_res := array(select e1 from (select unnest(v_web_set) as e1 union select unnest(array(select unnest(v_sheet_set) except select unnest(v_base_set)))) u
                     except select unnest(array(select unnest(v_base_set) except select unnest(v_sheet_set))));
    else
      v_res := array(select unnest(v_web_set) union select unnest(v_sheet_set));
    end if;
    v_ids := array(select x from unnest(v_res) x where x not like 'raw:%' order by x);
    -- the names the sheet wrote for the people the website does not know
    v_unm := '{}';
    for r in select nm from (
               select distinct on (private.aaj_doctor_key(nm)) nm, o from (
                 select d as nm, o from jsonb_array_elements_text(v_set->'doctors'->'v') with ordinality t(d, o)
                 union all
                 select u, 1000 + o from jsonb_array_elements_text(coalesce(n.sheet_cells->'doctors'->'unmatched', '[]'::jsonb)) with ordinality t(u, o)) z
                where ('raw:' || private.aaj_doctor_key(nm)) = any (v_res)
                order by private.aaj_doctor_key(nm), o) q order by o loop
      v_unm := v_unm || r.nm;
    end loop;
    v_dt := case when (select coalesce(array_agg(x order by x), '{}') from unnest(v_res) x) = (select coalesce(array_agg(x order by x), '{}') from unnest(v_sheet_set) x)
                 then v_set->'doctors'->>'t' end;
    n.sheet_cells := n.sheet_cells || jsonb_build_object('doctors', jsonb_build_object('t', v_dt, 'ids', to_jsonb(v_ids), 'unmatched', to_jsonb(v_unm),
                                                          'pending', coalesce(n.sheet_cells->'doctors'->'pending', '[]'::jsonb)));
    if cardinality(v_unm) > 0 then
      v_msgs := v_msgs || format('Not on the website''s doctor list: %s. Add them in Clinic setup or fix the spelling.', array_to_string(v_unm, ', '));
      v_level := 'warn';
    end if;
  end if;

  -- ---- save it (rule stops are handled here, one row at a time) ----
  v_old_token := case when v_create then null else v.token_no end;
  v_dirty := v_create or (n.treatment_label, n.treatment_id, n.details_text, n.token_no, n.status, n.doctor_group_id, n.braces_case_id, n.braces_month,
                          n.sheet_key, n.sheet_cells, n.protocol_override_by, n.protocol_override_reason, n.dues_override_by, n.dues_override_reason, n.notes)
             is distinct from (v.treatment_label, v.treatment_id, v.details_text, v.token_no, v.status, v.doctor_group_id, v.braces_case_id, v.braces_month,
                               v.sheet_key, v.sheet_cells, v.protocol_override_by, v.protocol_override_reason, v.dues_override_by, v.dues_override_reason, v.notes);
  if v_dirty then
    loop
      v_try := v_try + 1;
      begin
        if v_create then
          insert into public.visits (id, patient_id, branch_id, visit_date, status, token_no, treatment_id, treatment_label, details_text,
                                     braces_case_id, braces_month, doctor_group_id, sheet_key, sheet_cells, created_by,
                                     protocol_override_by, protocol_override_reason, dues_override_by, dues_override_reason, notes)
          values (n.id, n.patient_id, n.branch_id, n.visit_date, n.status, n.token_no, n.treatment_id, n.treatment_label, n.details_text,
                  n.braces_case_id, n.braces_month, n.doctor_group_id, n.sheet_key, n.sheet_cells, n.created_by,
                  n.protocol_override_by, n.protocol_override_reason, n.dues_override_by, n.dues_override_reason, n.notes);
        else
          update public.visits set
            treatment_label = n.treatment_label, treatment_id = n.treatment_id, details_text = n.details_text,
            token_no = n.token_no, status = n.status, doctor_group_id = n.doctor_group_id,
            braces_case_id = n.braces_case_id, braces_month = n.braces_month, sheet_key = n.sheet_key, sheet_cells = n.sheet_cells,
            protocol_override_by = n.protocol_override_by, protocol_override_reason = n.protocol_override_reason,
            dues_override_by = n.dues_override_by, dues_override_reason = n.dues_override_reason, notes = n.notes
           where id = n.id;
        end if;
        exit;
      exception
        when unique_violation then
          get stacked diagnostics v_con = constraint_name;
          if v_con = 'visits_token_unique_idx' and v_try < 4 and v_token_asked then
            -- somebody took that token between the check and the write: normal too (owner's rule, 11 Oct 2026, see the token above), so no
            -- message and no warning. The website keeps its own token, the sheet its typed one ("own").
            n.token_no := v_old_token; v_token_asked := false;
            n.sheet_cells := n.sheet_cells || jsonb_build_object('token', coalesce(n.sheet_cells->'token', '{}'::jsonb) || jsonb_build_object('own', true));
            continue;
          end if;
          raise;
        when others then
          v_err := sqlerrm;
          if sqlstate <> 'P0001' or v_try >= 4 or not (left(v_err, 14) = 'PHOTO_REQUIRED' or left(v_err, 14) = 'CHECK_REQUIRED' or left(v_err, 9) = 'DUES_HOLD') then raise; end if;
          v_label := private.aaj_status_label(n.status);
          if p_rules = 'hold' or n.status <> 'completed' then
            -- keep the website's rules (hold mode, or a row that is not Completed): the status stays one step back and the sheet is told
            v_msgs := v_msgs || case
              when v_err like 'PHOTO%' then format('Not saved as %s: this is a photo month and the photos are not uploaded on the website yet.', v_label)
              when v_err like 'CHECK%' then format('Not saved as %s: the checker has not checked this visit on the website yet.', v_label)
              else format('Not saved as %s: pending dues Rs %s.', v_label, to_char(public.patient_dues(n.patient_id), 'FM999,999,999')) end;
            v_level := 'warn'; v_kept := array_append(v_kept, 'status'::text);
            v_lost := v_lost || jsonb_build_object('status', coalesce(v_set->'status'->>'t', ''));
            n.status := case when v_create then (case when v_err like 'DUES%' then 'waiting' else 'in_treatment' end)::public.visit_status else v.status end;
          else
            -- the owner's rule (9 Oct 2026): a row marked Completed in the sheet completes the visit. The website's photo, checker and
            -- dues rules are skipped, and the record says exactly that. Skipping the photo or check step is the owner's normal path
            -- ("its fine to skip them"): the row stays a tick, so it does not count toward the tab heading's "need attention" (RS13-M1).
            -- Dues not held stay a warning: front desk may still collect them (the website holds dues only when Dr. Ali turns that on).
            if p_admin is null then raise; end if;
            if v_err like 'DUES%' then
              n.dues_override_by := p_admin; n.dues_override_reason := private.aaj_override_reason();
              v_msgs := v_msgs || format('Completed from the sheet. Pending dues Rs %s were not held (owner rule).', to_char(public.patient_dues(n.patient_id), 'FM999,999,999'));
              v_over := array_append(v_over, 'dues'::text);
              v_level := 'warn';
            else
              n.protocol_override_by := p_admin; n.protocol_override_reason := private.aaj_override_reason();
              v_msgs := v_msgs || format('Completed from the sheet (owner rule: the website''s %s step is not needed).', case when v_err like 'PHOTO%' then 'photo' else 'check' end);
              v_over := v_over || case when v_err like 'PHOTO%' then 'photo' else 'check' end;
            end if;
          end if;
          continue;
      end;
    end loop;
  end if;

  -- ---- the people on the visit ----
  -- A doctor the website's group rule refuses on a row that is not Completed yet stays in the row as the sheet's own text ("pending": the cell is
  -- not rewritten) and is added when the row is marked Completed (owner rule: Completed skips the doctor-group rule). In hold mode the
  -- website's rule always wins: the doctor is not added and the sheet is told to take the website's list.
  if p_rules <> 'hold' and p_admin is not null and not v_dwant and n.status = 'completed' and (v_set->'status'->>'v') = 'completed'
     and jsonb_array_length(coalesce(n.sheet_cells->'doctors'->'pending', '[]'::jsonb)) > 0 then
    v_ids := array(select jsonb_array_elements_text(n.sheet_cells->'doctors'->'pending'));
    v_padd := true;
  end if;
  if v_dwant or v_padd then
    v_pend := '{}';
    if v_dwant then
      delete from public.visit_staff where visit_id = n.id and role in ('doctor', 'assistant') and not (clinician_id::text = any (v_ids));
    end if;
    for r in select c2.id, c2.is_doctor, c2.display_name from public.clinicians c2
              where c2.id::text = any (v_ids)
                and not exists (select 1 from public.visit_staff vs where vs.visit_id = n.id and vs.clinician_id = c2.id and vs.role in ('doctor', 'assistant')) loop
      begin
        insert into public.visit_staff (visit_id, clinician_id, role) values (n.id, r.id, case when r.is_doctor then 'doctor' else 'assistant' end::public.visit_staff_role);
      exception when others then
        if sqlstate <> 'P0001' or left(sqlerrm, 17) <> 'GROUP_NOT_ALLOWED' then raise; end if;
        if p_rules = 'hold' or p_admin is null then
          v_msgs := v_msgs || format('%s is not allowed for this month on the website. Not added.', r.display_name); v_level := 'warn'; v_kept := array_append(v_kept, 'doctors'::text);
          v_lost := v_lost || jsonb_build_object('doctors', coalesce(v_set->'doctors'->>'t', ''));
          update public.visits set sheet_cells = jsonb_set(jsonb_set(sheet_cells, '{doctors,t}', 'null'::jsonb),
                                    '{doctors,ids}', coalesce((select jsonb_agg(x) from jsonb_array_elements(sheet_cells->'doctors'->'ids') x where x <> to_jsonb(r.id::text)), '[]'::jsonb))
           where id = n.id;
        elsif n.status <> 'completed' then
          v_pend := array_append(v_pend, r.id::text);
          v_msgs := v_msgs || format('%s is outside this month''s doctor group. The name stays in the row; the website adds it when the visit is marked Completed (owner rule).', r.display_name); v_level := 'warn';
        else
          update public.visits set protocol_override_by = p_admin,
                 protocol_override_reason = coalesce(protocol_override_reason, private.aaj_override_reason())
           where id = n.id and protocol_override_by is null;
          insert into public.visit_staff (visit_id, clinician_id, role) values (n.id, r.id, case when r.is_doctor then 'doctor' else 'assistant' end::public.visit_staff_role);
          -- the owner's rule working, nothing for staff to do: a tick, not counted as "need attention" (RS13-M1)
          v_msgs := v_msgs || format('%s is outside this month''s doctor group. Saved because the visit is Completed in the sheet (owner rule).', r.display_name); v_over := array_append(v_over, 'group'::text);
        end if;
      end;
    end loop;
    update public.visits set sheet_cells = jsonb_set(sheet_cells, '{doctors,pending}', to_jsonb(v_pend))
     where id = n.id and sheet_cells->'doctors' is not null and coalesce(sheet_cells->'doctors'->'pending', '[]'::jsonb) is distinct from to_jsonb(v_pend);
  end if;

  -- ---- P.P, Healthwire and Reminder: staff-only text, kept apart from the visit row ----
  if v_set ? 'pp' or v_set ? 'healthwire' or v_set ? 'reminder' then
    insert into private.aaj_visit_text (visit_id, pp, healthwire, reminder)
    values (n.id, v_set->>'pp', v_set->>'healthwire', v_set->>'reminder')
    on conflict (visit_id) do update set
      pp = case when v_set ? 'pp' then excluded.pp else private.aaj_visit_text.pp end,
      healthwire = case when v_set ? 'healthwire' then excluded.healthwire else private.aaj_visit_text.healthwire end,
      reminder = case when v_set ? 'reminder' then excluded.reminder else private.aaj_visit_text.reminder end;
  end if;

  -- ---- the patient's empty phone is filled from the sheet, never changed: only by the row that made this visit just now (never by a row that
  --      only met a visit the website already had, nor by a later edit), and that row's name fits the patient without doubt (a row that fits
  --      only with doubt is refused before this: abuse-privacy M2), so a typed phone cannot be slipped into another person's file ----
  if v_create and v_pc is null and v_set ? 'phone' and private.aaj_norm_phone(v_set->>'phone') is not null then
    update public.patients set phone = private.aaj_norm_phone(v_set->>'phone') where id = n.patient_id and phone is null;
  end if;

  -- ---- what changed, for the audit log and the answer ----
  if v_create then
    v_changed := array['created'];
  else
    v_changed := array_remove(array[
      case when n.status is distinct from v.status then 'status' end,
      case when n.treatment_label is distinct from v.treatment_label then 'treatment' end,
      case when n.details_text is distinct from v.details_text then 'details' end,
      case when n.token_no is distinct from v.token_no then 'token' end,
      case when (n.braces_month, n.braces_case_id) is distinct from (v.braces_month, v.braces_case_id) then 'month' end,
      case when n.doctor_group_id is distinct from v.doctor_group_id then 'group' end,
      case when (v_dwant or v_padd) and private.aaj_canon(n.id)->>'doctors' is distinct from c->>'doctors' then 'doctors' end,
      case when n.sheet_key is distinct from v.sheet_key then 'linked' end,
      case when n.sheet_cells is distinct from v.sheet_cells then 'sheet_cells' end], null);
    if v_outcome = 'updated' and cardinality(v_changed) = 0 and not v_dirty then v_outcome := 'unchanged'; end if;
  end if;
  if v_create or cardinality(v_changed) > 0 or cardinality(v_over) > 0 or v_outcome = 'linked' or v_lost <> '{}'::jsonb then
    insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
    values ('visits', n.id::text, 'SHEET_SYNC', c,
            jsonb_build_object('tab', p_tab, 'key', v_key, 'outcome', v_outcome, 'changed', to_jsonb(v_changed), 'kept_website', to_jsonb(v_kept),
                               'sheet_text_not_applied', v_lost, 'overrides', to_jsonb(v_over), 'patient_created', v_pc),
            private.aaj_sync_actor());
  end if;

  return private.aaj_result(v_key, v_outcome, v_level, array_to_string(v_msgs, ' '), n.id, v_kept, null, v_pc);
end $$;

-- ---------------------------------------------------------------------
-- 5. Who may call what (as in 20261009000300: a replaced function keeps its grants; repeated so this file stands on its own)
-- ---------------------------------------------------------------------
revoke all on function public.aaj_sync(text, jsonb) from public, anon, authenticated;
grant execute on function public.aaj_sync(text, jsonb) to anon;
revoke all on function private.aaj_removals(smallint, date, text, text[]), private.aaj_day_list(smallint, date),
  private.aaj_sync_row(smallint, text, date, jsonb, text[], uuid, text), private.aaj_off_done(uuid, uuid) from public, anon, authenticated;
