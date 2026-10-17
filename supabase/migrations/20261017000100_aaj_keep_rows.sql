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
--       over this row"), as before this file. That minute it asks for no removal pass, so the record is never released here; its key is
--       on the sheet again in the next call.
--   A call WITHOUT "keep_rows" (the old script, still pasted in the sheet) gets exactly the old answers.
--
-- WHAT THIS FILE REPLACES (three CREATE OR REPLACE, no table, column or grant changes)
--   * public.aaj_sync: the body of 20261009000300_aaj_two_way_sync.sql (checked identical to the live database on 17 Oct 2026) with
--     three narrow changes, all inside it: it reads "keep_rows" and sets the transaction setting aaj.keep_rows for aaj_removals; the
--     Cancelled records it releases in a keep_rows call are named in "removed"; nothing else. 213 lines.
--   * private.aaj_removals: the same body with the done records taken off the sheet first, and the day's cap counting the records taken
--     off earlier that day (keep_rows only). 212 lines.
--   * private.aaj_day_list: the same list, with "removed" for a record taken off the sheet while done (see above). 20 lines.
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
--         or (p.pronamespace = 'private'::regnamespace and p.proname in ('aaj_removals', 'aaj_day_list')) order by 1;
--   and compare: after this file, aaj_day_list e06e36c82cdb77bc6ff38fca7fc743fb, aaj_removals 042ac2530063f70660eec06617abfa3e,
--   aaj_sync b36b7678493aa134c9e733b73a3d8005 (the md5 of each body below, checked in the local suite; any edit of a body changes it), and
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
-- 4. Who may call what (as in 20261009000300: a replaced function keeps its grants; repeated so this file stands on its own)
-- ---------------------------------------------------------------------
revoke all on function public.aaj_sync(text, jsonb) from public, anon, authenticated;
grant execute on function public.aaj_sync(text, jsonb) to anon;
revoke all on function private.aaj_removals(smallint, date, text, text[]), private.aaj_day_list(smallint, date) from public, anon, authenticated;
