// LIVE data layer for the Retainer Record and Lab Work pages (supabase/migrations/20261012000200_retainer_lab_records.sql).
// supabase.js spreads these methods into its adapter, passing the helpers it already has; data/demo-records.js has the same
// methods with the same return shapes. Every request runs as the signed-in person, so row-level security decides what they
// see (branch and city) and change.
//
// While the migration is not applied, PostgREST answers "column does not exist" (42703) or "table not found" (PGRST205): the
// methods then throw one error with the code RECORDS_MISSING and the pages say "not switched on yet".
import { RETAINER_FIELDS, LAB_FIELDS, recordPatch } from '../lib/records.js';

const MISSING_CODES = new Set(['PGRST205', 'PGRST204', 'PGRST202', '42P01', '42703', '42883']);
export const RECORDS_MISSING_TEXT = 'RECORDS_MISSING: the Retainer Record and Lab Work are not switched on yet. They appear once the database update has been run.';
const ROWS_CAP = 5000; // a tab is read whole (the Karachi tab had about 600 rows in October 2026)
const CHECKS_CAP = 500; // overdue retainer checks read for the Coordinator page (it names six and counts the rest)
const TEAM_FIELDS = ['name', 'role', 'colour', 'city_id', 'featured', 'active', 'sort_order'];
const LAB_TEAM_FIELDS = ['name', 'kind', 'colour', 'active', 'sort_order'];

export function recordsLive({ sb, check, fetchPaged, attachPatients, plainError }) {
  const missing = (e) => !!e && (MISSING_CODES.has(e.code) || e.status === 404);
  /** Runs a request; "not installed" comes out as one error with the code RECORDS_MISSING. */
  async function call(run) {
    try { return await run(); } catch (e) { throw missing(e) ? plainError(RECORDS_MISSING_TEXT, 'RECORDS_MISSING') : e; }
  }
  const one = async (row) => (row ? (await attachPatients([row]))[0] : null);
  const teamRow = (row, fields) => {
    const out = {};
    for (const f of fields) {
      if (row[f] === undefined) continue;
      out[f] = f === 'city_id' || f === 'sort_order' ? (row[f] === '' || row[f] === null ? (f === 'sort_order' ? 50 : null) : Number(row[f])) : row[f];
    }
    return out;
  };
  async function saveTeam(table, row, fields) {
    const { id } = row;
    const data = teamRow(row, fields);
    if (id) return check(await sb.from(table).update(data).eq('id', id).select().single());
    return check(await sb.from(table).insert(data).select().single());
  }

  return {
    // ------------------------------------------------------------ Retainer Record
    /** Every row of one city's tab that this person may see, with the patient file (id, Mr#, name, phone) of linked rows. */
    async retainerRecords({ cityId }) {
      return call(async () => attachPatients(await fetchPaged(() => sb.from('retainer_cases').select('*').eq('city_id', Number(cityId))
        .order('created_at', { ascending: true }).order('id', { ascending: true }), ROWS_CAP)));
    },
    async retainerTeam() {
      return call(async () => check(await sb.from('retainer_team').select('*').order('sort_order').order('name')));
    },
    /** The rows this person may see whose next retainer check is before `today` ('YYYY-MM-DD', Karachi), every city, earliest check first
     *  (at most CHECKS_CAP, then `truncated`): the Coordinator page's warning. The page leaves out the cancelled ones (by the status list). */
    async retainerChecksOverdue({ today }) {
      return call(async () => attachPatients(await fetchPaged(() => sb.from('retainer_cases').select('id,patient_id,patient_name,contact,city_id,branch_id,status,next_check_date')
        .lt('next_check_date', today).order('next_check_date', { ascending: true }).order('id', { ascending: true }), CHECKS_CAP)));
    },
    /** Adds a row (source 'website'; the database sets the author). -> the row */
    async addRetainerRecord(row) {
      return call(async () => one(check(await sb.from('retainer_cases').insert(recordPatch(row, RETAINER_FIELDS)).select().single())));
    },
    /** Changes the listed columns of a row. -> the row as saved (with any date its status filled in), or null when no row was changed. */
    async updateRetainerRecord(id, changes) {
      return call(async () => {
        const patch = recordPatch(changes, RETAINER_FIELDS);
        delete patch.braces_case_id;
        if (!Object.keys(patch).length) return null;
        return one(check(await sb.from('retainer_cases').update(patch).eq('id', id).select())[0] || null);
      });
    },
    async deleteRetainerRecord(id) {
      return call(async () => {
        const rows = check(await sb.from('retainer_cases').delete().eq('id', id).select('id'));
        if (!rows.length) throw plainError('NOT_REMOVED: this row could not be removed (rows that came from the Google Sheet can only be removed by Dr. Ali).', 'NOT_REMOVED');
      });
    },
    /** Admin (Clinic setup): adds or changes a team member. -> the member */
    async saveRetainerTeamMember(row) { return call(async () => saveTeam('retainer_team', row, TEAM_FIELDS)); },
    /** Admin: the ONE copy of a city's sheet tab, every row in this one call (the rows readRetainerTab() makes, at most 3000); refused
     *  (ALREADY_COPIED, in plain words) once the city has a copy. `dryRun` works it all out and keeps nothing (the preview).
     *  -> { given, inserted, skipped, skipped_count, kept, kept_other, kept_date_differs, team_added, team_colours, top_makers, team_featured,
     *  mr_given, linked, not_linked, not_linked_why, dry_run } */
    async importRetainerRecords(cityId, rows, { dryRun = false } = {}) {
      return call(async () => check(await sb.rpc('import_retainer_records', { p_city: Number(cityId), p_rows: rows, p_dry_run: !!dryRun })));
    },
    /** Admin: "Undo the copy for <city>": the copied rows nobody changed on the website go, the changed ones stay. `dryRun` only counts.
     *  -> { city, removed, stayed, dry_run } */
    async undoRetainerCopy(cityId, { dryRun = false } = {}) {
      return call(async () => check(await sb.rpc('undo_retainer_copy', { p_city: Number(cityId), p_dry_run: !!dryRun })));
    },
    /** Admin: the cities with a copy. -> [{ city_id, city, copied_on, retainers, changed, kept }] */
    async retainerCopies() {
      return call(async () => check(await sb.rpc('retainer_copies')) || []);
    },
    /** Admin (Clinic setup): new words for a status ('retainer_statuses') or a lab work type ('lab_work_types'), on the list and on every
     *  row that has the old words. -> how many rows changed */
    async renameRecordOption(list, from, to) {
      return call(async () => check(await sb.rpc('rename_record_option', { p_list: list, p_from: from, p_to: to })));
    },
    /** Admin, the import's preview: which of [{ row, mr, name }] the import will link to a patient file (nothing is written).
     *  -> { given, linked, name_differs, not_found, not_an_mr, rows: [{ row, outcome }] } */
    async retainerMrCheck(rows) {
      return call(async () => check(await sb.rpc('retainer_mr_check', { p_rows: rows })));
    },

    // ------------------------------------------------------------ Lab Work
    /** Every lab row of one branch (or, with no branch, of every branch this person may see). */
    async labRecords({ branchId = null } = {}) {
      return call(async () => attachPatients(await fetchPaged(() => {
        let q = sb.from('lab_cases').select('*');
        if (branchId) q = q.eq('branch_id', Number(branchId));
        return q.order('created_at', { ascending: true }).order('id', { ascending: true });
      }, ROWS_CAP)));
    },
    async labTeam() {
      return call(async () => check(await sb.from('lab_team').select('*').order('kind').order('sort_order').order('name')));
    },
    async addLabRecord(row) {
      return call(async () => one(check(await sb.from('lab_cases').insert(recordPatch(row, LAB_FIELDS)).select().single())));
    },
    async updateLabRecord(id, changes) {
      return call(async () => {
        const patch = recordPatch(changes, LAB_FIELDS);
        delete patch.visit_id;
        if (!Object.keys(patch).length) return null;
        return one(check(await sb.from('lab_cases').update(patch).eq('id', id).select())[0] || null);
      });
    },
    async deleteLabRecord(id) {
      return call(async () => {
        const rows = check(await sb.from('lab_cases').delete().eq('id', id).select('id'));
        if (!rows.length) throw plainError('NOT_REMOVED: this row could not be removed.', 'NOT_REMOVED');
      });
    },
    async saveLabTeamMember(row) { return call(async () => saveTeam('lab_team', row, LAB_TEAM_FIELDS)); },
  };
}
