-- =============================================================================
-- Aaj ki List sync: a token number that is already used that day is normal, so it gives no warning.
--
-- The owner's rule (Dr. Ali, 11 Oct 2026): "tokens arent a problem. because token numbers are different for
-- different treatment category. checkup habe different token, monthly habe different token, surgery and ect
-- habe different token. and my(dr. ali) habe different token".
--
-- So two rows of one tab and day with the same token number are how the clinic works, not a mistake. Until now
-- private.aaj_sync_row (20261009000300_aaj_two_way_sync.sql) answered such a row with a warning ("Token 41 is
-- already used by ... Token not changed on the website.", or "That token was just taken on the website. ..."
-- when another visit took the number at the same moment). The sheet showed a warning sign on each of those rows,
-- which buried the rows that really need attention.
--
-- WHAT CHANGES
--   Only those two answers: a token number that another visit of that branch and day already holds gives no
--   message and no warning, and the row gets a plain tick. Everything else stays as it was:
--     * the website still has one token per branch and day (visits_token_unique_idx): the visit keeps the
--       token the website gave it;
--     * the sheet keeps its own typed token (sheet_cells token with own = true): the website never rewrites
--       that cell.
--   This file is one statement: private.aaj_sync_row as 20261009000300 defines it, with only those two
--   branches changed (the other patient's name is no longer looked up). Its grants stay as they are (a
--   replaced function keeps them; 20261009000300 revoked execute from public, anon and authenticated, and only
--   public.aaj_sync calls it). The sheet's script (apps-script/AajSync.js) does not change.
--
-- HOW TO APPLY
--   Supabase dashboard -> SQL Editor -> New query -> paste this whole file -> Run.
--   It is safe to run more than once. With the Supabase CLI, keep the file name as it is: 20261011000100
--   sorts after the last migration (20261009000400_mr_50000_front_desk_portal.sql).
--
-- AFTER RUNNING IT: WARNINGS ALREADY IN THE SHEET STAY UNTIL TONIGHT
--   Running this file does not clear a token warning that a row of today's list already shows ("Token 41 is
--   already used by ..." or "That token was just taken on the website ..."), and the tab heading keeps counting
--   those rows in "N need attention". The sheet sends a row again only when one of its cells changes, and in those
--   rows nothing changed (the old version had already kept the typed token, own = true), so no new answer comes
--   for them. The website cannot reach a row the sheet does not send, and the sheet's script does not change.
--   Nothing is wrong with those rows. They go away:
--     * by themselves at the nightly clear (from 00:05), which empties the tabs;
--     * or as soon as staff change anything else in the row (its Status, Treatment, ...): the row is sent again
--       and its new answer replaces the warning (a plain tick when nothing else is wrong);
--     * or at once by hand: in today's tabs, select the Website cells that still show a token warning and press
--       Delete. The heading stops counting them within about five minutes, and each shows "On website" with a
--       tick the next time anything changes on that branch's list on the website.
--   (Typing the same token again does not help: the cell does not change, so the row is not sent.)
--   tests/aaj-sync-script.test.mjs pins this ("a token warning written before 20261011000100 was run ...").
-- =============================================================================

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
    -- the patient is on today's list already (a visit, or a checkup registered as them): the sheet sees them anyway
    v_onlist := v_oc = 'mr' and (exists (select 1 from public.visits x where x.patient_id = (v_find->>'patient_id')::uuid
                                                and x.branch_id = p_branch and x.visit_date = p_date)
                                 or exists (select 1 from public.checkups x where x.patient_id = (v_find->>'patient_id')::uuid and x.branch_id = p_branch
                                               and x.checkup_date = p_date and x.source <> 'archive' and not x.date_is_month));

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
       and lower(regexp_replace(btrim(coalesce(v_set->>'name', '')), '\s+', ' ', 'g')) <> lower(regexp_replace(btrim(v_pat.full_name), '\s+', ' ', 'g')) then
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
          if sqlstate <> 'P0001' or v_try >= 4 or not (v_err like 'PHOTO\_REQUIRED%' or v_err like 'CHECK\_REQUIRED%' or v_err like 'DUES\_HOLD%') then raise; end if;
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
        if sqlstate <> 'P0001' or sqlerrm not like 'GROUP\_NOT\_ALLOWED%' then raise; end if;
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
