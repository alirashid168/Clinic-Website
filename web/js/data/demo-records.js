// DEMO data for the Retainer Record and Lab Work pages: a made-up retainer team, retainer rows on the Karachi, Lahore and
// Islamabad tabs, a lab team and lab work at every branch, and the same rules as the database
// (supabase/migrations/20261012000200_retainer_lab_records.sql): who sees and changes what, the city that follows the branch,
// the dates a status fills in (Delivered: the first retainer check a month later too), the one copy of a sheet tab and its undo.
// demo.js seeds it and spreads the methods into its adapter.
//
// This file is public like demo.js: every name here is a clearly made-up placeholder ("(sample)" people, synthetic patients,
// phones 0300-555xxxx). Do not copy the clinic's real team or patients into it.
import {
  PALETTE, DEFAULT_RETAINER_STATUSES, DEFAULT_LAB_WORK_TYPES, RETAINER_FIELDS, LAB_FIELDS, LAB_STATUSES,
  recordPatch, statusMeans, retainerStatuses, nameFits, mrKey, topMakers, pickColour, optionKey,
} from '../lib/records.js';
import { todayISO, addMonthsISO } from '../ui/dom.js';

const COLOURS = new Set(PALETTE.map((p) => p.key));
const LAB_KEYS = new Set(LAB_STATUSES.map((s) => s.value));
const FIRST = ['Ayesha', 'Hamna', 'Zoha', 'Minahil', 'Arisha', 'Rida', 'Sameen', 'Ifrah', 'Momina', 'Hadia', 'Fizza', 'Eshal', 'Rayyan', 'Abdullah', 'Saim', 'Ahsan', 'Haider', 'Shahzaib', 'Moiz', 'Taimur', 'Laiba', 'Anaya'];
const LAST = ['Qureshi', 'Siddiqui', 'Malik', 'Durrani', 'Rauf', 'Butt', 'Sheikh', 'Mirza', 'Abbasi', 'Lodhi', 'Memon', 'Hashmi'];
const cleanName = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const capsIfSmall = (n) => (n === n.toLowerCase() ? n.replace(/(^|[^a-z])([a-z])/g, (_, a, b) => a + b.toUpperCase()) : n);
const blankCell = (v) => v === null || v === undefined || /^[\s\-–—]*$/.test(String(v));
const cell = (v, max) => (blankCell(v) ? null : String(v).trim().slice(0, max));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The Karachi day of a moment ('YYYY-MM-DD'), and as the database writes it in a message ("5 Oct 2026"). */
const karachiDay = (ts) => new Date(Date.parse(ts) + 5 * 3600000).toISOString().slice(0, 10);
const dayText = (ts) => { const d = karachiDay(ts); return `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`; };
const realDate = (v) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) return null;
  const [y, m, d] = String(v).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && y <= 2100 && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? String(v) : null;
};

// ---------------------------------------------------------------- seed
export function seedRecords(db, { uid, daysAgo }) {
  const now = new Date().toISOString();
  db.settings.retainer_statuses = DEFAULT_RETAINER_STATUSES.map((s) => ({ ...s }));
  db.settings.lab_work_types = DEFAULT_LAB_WORK_TYPES.map((s) => ({ ...s }));
  const member = (id, name, role, colour, city_id, featured = false, active = true, sort_order = 50) => ({ id, name, role, colour, city_id, featured, active, sort_order, created_at: now, updated_at: now });
  db.retainer_team = [
    member('rt-ali', 'Dr. Ali Rashid', 'model_check', 'purple', null, false, true, 10),
    member('rt-hina', 'Dr. Hina (sample)', 'model_check', 'purple', 1, true, true, 20),
    member('rt-hassan', 'Hassan (sample)', 'maker', 'black', 1, true, true, 30),
    member('rt-kamran', 'Kamran (sample)', 'maker', 'lavender', 1, true, true, 31),
    member('rt-rizwan', 'Rizwan (sample)', 'both', 'grey', null, true, true, 32),
    member('rt-saima', 'Saima (sample)', 'maker', 'rose', 2, true, true, 33),
    member('rt-former', 'Former maker (sample)', 'maker', 'amber', 1, false, false, 90),
  ];
  const person = (id, name, kind, colour) => ({ id, name, kind, colour, active: true, sort_order: 50, created_at: now, updated_at: now });
  db.lab_team = [
    person('lt-naveed', 'Naveed (sample)', 'person', 'teal'), person('lt-asma', 'Asma (sample)', 'person', 'rose'),
    person('lt-inhouse', 'In-house lab', 'lab', 'purple'), person('lt-sample', 'Sample Dental Lab', 'lab', 'grey'), person('lt-ceramics', 'Sample Ceramics', 'lab', 'sky'),
  ];

  // Retainer rows. The sheet's rows (source_row 2, 3, ...) run from about five months ago to ten days ago; the website's own rows
  // are the last ten days. Older rows are mostly delivered, the newest are still on their way. Some Karachi rows carry an Mr# as
  // typed on the sheet (made-up numbers no demo patient has, one with its leading 0), and one is linked to its patient file by Mr#.
  const name = (i) => `${FIRST[(i * 7) % FIRST.length]} ${LAST[(i * 5) % LAST.length]}`;
  const plus = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const rows = [];
  const add = (over) => rows.push({ id: uid(), patient_id: null, patient_name: null, mr_text: null, contact: null, city_id: 1, branch_id: null, braces_case_id: null, arch: null,
    impression_date: null, impression_text: null, retainer_date: null, retainer_text: null, delivered_date: null, next_check_date: null, model_check_by: null, made_by: null,
    status: 'Impression taken', retainer_sheet: null, payment: null, price: null, lab_cost: null, notes: null, source: 'website', source_row: null, source_name: null,
    linked_by_hand: false, edited_on_site: false, created_by: 's-admin', created_at: now, updated_at: now, ...over });
  const tabs = [
    { city_id: 1, count: 46, makers: ['rt-hassan', 'rt-kamran', 'rt-rizwan'], checkers: ['rt-ali', 'rt-hina'], from: 150, contact: false },
    { city_id: 2, count: 14, makers: ['rt-saima', 'rt-rizwan'], checkers: ['rt-ali'], from: 120, contact: true },
    { city_id: 3, count: 3, makers: ['rt-rizwan'], checkers: ['rt-ali'], from: 40, contact: true },
  ];
  let n = 0;
  for (const t of tabs) {
    for (let i = 0; i < t.count; i++, n++) {
      const back = Math.round(t.from - (i * (t.from - 10)) / Math.max(1, t.count - 1));
      const imp = daysAgo(back);
      const late = back <= 16;
      const status = i % 23 === 7 ? 'Impression repeat' : i % 29 === 11 ? 'Re-purchase needed' : i % 31 === 19 ? 'Cancelled'
        : !late ? 'Delivered to patient' : back <= 11 ? 'Model checked' : back <= 13 ? 'Model poured' : 'Retainer made';
      const made = ['Retainer made', 'Delivered to patient', 'Re-purchase needed'].includes(status);
      add({ city_id: t.city_id, patient_name: name(n), contact: t.contact || i % 6 === 0 ? `0300-555${String(2000 + n).slice(-4)}` : null,
        impression_date: i === 9 && t.city_id === 1 ? null : imp, impression_text: i === 9 && t.city_id === 1 ? 'soon' : null,
        model_check_by: t.checkers[i % t.checkers.length], made_by: status === 'Cancelled' && i % 2 ? null : t.makers[i % t.makers.length],
        retainer_date: made ? plus(imp, 5 + (i % 4)) : null, status,
        retainer_sheet: i % 9 === 4 ? 'Re-purchase needed' : i % 9 === 6 ? 'Sheet available' : null,
        payment: i % 5 === 0 ? 'Paid' : i % 7 === 3 ? 'Pending' : i % 13 === 5 ? 'Free' : null,
        mr_text: t.city_id === 1 && i % 8 === 3 ? (i % 16 === 3 ? `0${300 + i}` : String(4100 + i)) : null,
        source: 'sheet_import', source_row: i + 2, created_at: daysAgo(9) + 'T10:00:00Z' });
    }
  }
  for (const r of rows) r.source_name = r.patient_name; // (the name each sheet row was imported with)
  const byMr = db.patients[12];
  Object.assign(rows[5], { patient_id: byMr.id, patient_name: byMr.full_name, mr_text: byMr.mr_number, source_name: byMr.full_name });
  // The website's own rows (Karachi): this month's work, one linked to a patient file.
  const recent = [
    [6, 'rt-hassan', 'Retainer made', 2], [5, 'rt-kamran', 'Retainer made', 1], [4, 'rt-rizwan', 'Model checked', null], [3, 'rt-hassan', 'Impression taken', null],
    [2, 'rt-kamran', 'Impression taken', null], [1, 'rt-hassan', 'Delivered to patient', 1],
  ];
  // (delivered today: the first retainer check a calendar month later, as the database sets it)
  recent.forEach(([back, maker, status, madeBack], k) => add({ patient_name: name(100 + k), impression_date: daysAgo(back), model_check_by: k % 2 ? 'rt-hina' : 'rt-ali',
    made_by: maker, status, retainer_date: madeBack !== null ? daysAgo(madeBack) : null, delivered_date: status === 'Delivered to patient' ? daysAgo(0) : null,
    next_check_date: status === 'Delivered to patient' ? addMonthsISO(daysAgo(0), 1) : null,
    payment: k % 3 === 0 ? 'Paid' : null, created_at: new Date(Date.now() - (10 - k) * 3600000).toISOString() }));
  // Retainer checks: three retainers delivered on the website a month or more ago (Karachi), whose first check was set a month after delivery:
  // two have passed (one linked to its patient file), one is in three days. The rows copied from the sheet have no check date.
  const checked = db.patients[22];
  [[47, 16, checked], [36, 5, null], [27, -3, null]].forEach(([deliveredBack, checkBack, file], k) => add({
    patient_id: file?.id || null, patient_name: file?.full_name || name(110 + k), contact: file?.phone || (k === 1 ? '0300-5552301' : null), arch: 'both', linked_by_hand: !!file,
    impression_date: daysAgo(deliveredBack + 12), model_check_by: k % 2 ? 'rt-ali' : 'rt-hina', made_by: k % 2 ? 'rt-kamran' : 'rt-hassan', status: 'Delivered to patient',
    retainer_date: daysAgo(deliveredBack + 4), delivered_date: daysAgo(deliveredBack), next_check_date: daysAgo(checkBack), payment: 'Paid',
    created_at: daysAgo(deliveredBack + 12) + 'T09:00:00Z' }));
  const p = db.patients[7];
  add({ patient_id: p.id, patient_name: p.full_name, contact: p.phone, branch_id: p.first_branch_id <= 3 ? p.first_branch_id : null, city_id: 1, arch: 'both', linked_by_hand: true,
    impression_date: daysAgo(4), model_check_by: 'rt-ali', made_by: 'rt-kamran', status: 'Retainer made', retainer_date: daysAgo(1), lab_cost: 2000, price: 10000,
    created_at: new Date(Date.now() - 3600000).toISOString() });
  db.retainer_cases = rows;

  // Lab work at every branch: some on time, some overdue, some back or fitted.
  const lab = (over) => ({ id: uid(), patient_id: null, patient_name: null, contact: null, visit_id: null, branch_id: 2, lab_name: 'In-house lab', work_type: 'Crown',
    teeth: null, shade: null, sent_date: daysAgo(3), due_date: null, received_date: null, fitted_date: null, status: 'sent', handled_by: null, cost: null, payment: null,
    notes: null, created_by: 's-admin', created_at: now, updated_at: now, ...over });
  db.lab_cases = [
    lab({ patient_id: db.patients[14].id, patient_name: db.patients[14].full_name, contact: db.patients[14].phone, branch_id: 2, work_type: 'Crown', teeth: 'UR6', shade: 'A2',
      sent_date: daysAgo(6), due_date: daysAgo(-1), received_date: daysAgo(0), status: 'received', handled_by: 'Naveed (sample)', cost: 5000, payment: 'Paid', created_at: daysAgo(6) + 'T12:00:00Z' }),
    lab({ patient_id: db.patients[17].id, patient_name: db.patients[17].full_name, contact: db.patients[17].phone, branch_id: 1, lab_name: 'Sample Dental Lab', work_type: 'Veneer',
      teeth: '13-23', shade: 'B1', sent_date: daysAgo(10), due_date: daysAgo(2), status: 'sent', handled_by: 'Asma (sample)', cost: 30000, payment: 'Pending', created_at: daysAgo(10) + 'T12:00:00Z' }),
    lab({ patient_name: name(200), contact: '0300-5554101', branch_id: 2, work_type: 'Denture', teeth: 'Lower full', sent_date: daysAgo(12), due_date: daysAgo(5), received_date: daysAgo(5),
      fitted_date: daysAgo(3), status: 'fitted', handled_by: 'Naveed (sample)', cost: 18000, payment: 'Paid', created_at: daysAgo(12) + 'T12:00:00Z' }),
    lab({ patient_name: name(201), branch_id: 2, work_type: 'Night guard', sent_date: daysAgo(2), due_date: daysAgo(-3), status: 'in_lab', handled_by: 'Naveed (sample)', cost: 6000, created_at: daysAgo(2) + 'T12:00:00Z' }),
    lab({ patient_name: name(202), contact: '0300-5554103', branch_id: 1, lab_name: 'Sample Ceramics', work_type: 'Bridge', teeth: 'LL5-LL7', shade: 'A3', sent_date: daysAgo(14), due_date: daysAgo(4),
      status: 'in_lab', handled_by: 'Asma (sample)', cost: 24000, created_at: daysAgo(14) + 'T12:00:00Z' }),
    lab({ patient_name: name(203), branch_id: 1, work_type: 'Implant crown', teeth: 'UL6', sent_date: daysAgo(1), due_date: daysAgo(-6), status: 'sent', handled_by: 'Asma (sample)', created_at: daysAgo(1) + 'T12:00:00Z' }),
    lab({ patient_name: name(204), branch_id: 3, work_type: 'Crown', teeth: 'LR6', shade: 'A2', sent_date: daysAgo(9), due_date: daysAgo(1), received_date: daysAgo(1), status: 'remake',
      notes: 'Shade too light, sent back', cost: 5000, created_at: daysAgo(9) + 'T12:00:00Z' }),
    lab({ patient_name: name(205), branch_id: 3, lab_name: 'Sample Dental Lab', work_type: 'Aligner', sent_date: daysAgo(4), due_date: daysAgo(-10), status: 'sent', created_at: daysAgo(4) + 'T12:00:00Z' }),
    lab({ patient_name: name(206), contact: '0300-5554107', branch_id: 4, work_type: 'Veneer', teeth: '11, 21', shade: 'BL2', sent_date: daysAgo(3), due_date: daysAgo(-1), status: 'sent', cost: 20000, created_at: daysAgo(3) + 'T12:00:00Z' }),
    lab({ patient_name: name(207), branch_id: 4, work_type: 'Retainer', sent_date: daysAgo(8), due_date: daysAgo(4), received_date: daysAgo(4), fitted_date: daysAgo(2), status: 'fitted', payment: 'Free', created_at: daysAgo(8) + 'T12:00:00Z' }),
    lab({ patient_name: name(208), branch_id: 5, lab_name: 'Sample Dental Lab', work_type: 'Crown', teeth: 'UR1', sent_date: daysAgo(8), due_date: daysAgo(1), status: 'sent', cost: 7000, created_at: daysAgo(8) + 'T12:00:00Z' }),
  ];
}

// ---------------------------------------------------------------- methods
/**
 * ctx: { db: () => the demo database, me, can, need, branchOk, clone, fail, uid, audit, patient } from demo.js (the database is
 * replaced on "reset demo", so it is read through db() each time).
 */
export function recordsDemo({ db, me, can, need, branchOk, clone, fail, uid, audit, patient }) {
  const cityOfBranch = (id) => db().branches.find((b) => b.id === Number(id))?.city_id ?? null;
  const cityOk = (cityId) => { const s = me(); return !!s && s.active && (s.role === 'admin' || !s.restrict_to_branches || s.branch_ids.some((b) => cityOfBranch(b) === Number(cityId))); };
  const isAdmin = () => me()?.role === 'admin';
  const retainerAccess = (r) => (r.branch_id ? branchOk(r.branch_id) : cityOk(r.city_id));
  const retainerVisible = (r) => (can('patients.view') || can('retainers.manage')) && retainerAccess(r);
  const labVisible = (l) => (can('lab.manage') || can('patients.view')) && branchOk(l.branch_id);
  const rls = (table) => fail(`new row violates row-level security policy for table "${table}"`);
  const check = (table, name, ok) => { if (!ok) fail(`new row for relation "${table}" violates check constraint "${table}_${name}_check"`); };
  const withPatient = (r) => {
    const p = r.patient_id && can('patients.view') ? patient(r.patient_id) : null;
    return { ...clone(r), patient: p ? { id: p.id, mr_number: p.mr_number, full_name: p.full_name, phone: p.phone, email: p.email || null } : null };
  };
  const today = () => todayISO(); // the Karachi date
  const stamp = () => new Date().toISOString();
  const statuses = () => retainerStatuses(db().settings);

  function fillRetainer(row, prev) {
    if (row.branch_id) row.city_id = cityOfBranch(row.branch_id) ?? row.city_id;
    if (row.patient_id && !String(row.patient_name || '').trim()) row.patient_name = patient(row.patient_id)?.full_name?.slice(0, 200) || null;
    if (row.status && (!prev || prev.status !== row.status)) {
      const means = statusMeans(statuses(), row.status);
      if ((means === 'made' || means === 'delivered') && !row.retainer_date) { row.retainer_date = today(); row.retainer_text = null; }
      if (means === 'delivered' && !row.delivered_date) row.delivered_date = today();
      // (the first retainer check a calendar month later, unless the row has a check date already)
      if (means === 'delivered' && !row.next_check_date) row.next_check_date = addMonthsISO(today(), 1);
    }
  }
  function validRetainer(r) {
    check('retainer_cases', 'who', !!r.patient_id || !!String(r.patient_name || '').trim());
    check('retainer_cases', 'patient_name', !r.patient_name || r.patient_name.length <= 200);
    check('retainer_cases', 'contact', !r.contact || r.contact.length <= 60);
    check('retainer_cases', 'mr_text', !r.mr_text || (r.mr_text.trim().length >= 1 && r.mr_text.trim().length <= 20));
    check('retainer_cases', 'lists', (!r.status || (r.status.trim().length >= 1 && r.status.length <= 60)) && (!r.retainer_sheet || r.retainer_sheet.length <= 60) && (!r.payment || r.payment.length <= 60));
    check('retainer_cases', 'notes', !r.notes || r.notes.length <= 2000);
    check('retainer_cases', 'money', (r.price === null || r.price === undefined || r.price >= 0) && (r.lab_cost === null || r.lab_cost === undefined || r.lab_cost >= 0));
    if (!db().cities.some((c) => c.id === Number(r.city_id))) fail('null value in column "city_id" of relation "retainer_cases" violates not-null constraint');
  }
  function fillLab(row, prev) {
    if (row.patient_id && !String(row.patient_name || '').trim()) row.patient_name = patient(row.patient_id)?.full_name?.slice(0, 200) || null;
    if (!prev || prev.status !== row.status) {
      if (['received', 'fitted'].includes(row.status) && !row.received_date) row.received_date = today();
      if (row.status === 'fitted' && !row.fitted_date) row.fitted_date = today();
    }
  }
  function validLab(l) {
    check('lab_cases', 'who', !!l.patient_id || !!String(l.patient_name || '').trim());
    check('lab_cases', 'status', LAB_KEYS.has(l.status));
    check('lab_cases', 'cost', l.cost === null || l.cost === undefined || l.cost >= 0);
    check('lab_cases', 'text', [['patient_name', 200], ['contact', 60], ['lab_name', 120], ['work_type', 80], ['teeth', 60], ['shade', 40], ['handled_by', 120], ['payment', 60], ['notes', 2000]]
      .every(([k, max]) => !l[k] || String(l[k]).length <= max));
  }
  // private.retainer_mr_match: the patient file of a typed Mr# ("082" is Mr# 82), linked only when the name fits it (nameFits, the port of
  // private.aaj_name_fits).
  function mrMatch(mr, name) {
    const key = mrKey(mr);
    if (!key) return { outcome: 'not_an_mr', patient_id: null };
    const typed = String(mr).trim();
    const files = db().patients.filter((p) => p.mr_number === key || p.mr_number === typed).sort((x, y) => (y.mr_number === typed) - (x.mr_number === typed));
    const hit = files.find((p) => nameFits(name, p.full_name));
    return hit ? { outcome: 'linked', patient_id: hit.id } : { outcome: files.length ? 'name_differs' : 'not_found', patient_id: null };
  }
  function saveTeam(list, row, { kindKey = null } = {}) {
    if (!isAdmin()) rls(kindKey ? 'lab_team' : 'retainer_team');
    const name = cleanName(row.name);
    if (!name || name.length > 80) fail(`new row for relation "${kindKey ? 'lab_team' : 'retainer_team'}" violates check constraint "name_check"`);
    if (row.colour !== undefined && !COLOURS.has(row.colour)) fail(`new row for relation "${kindKey ? 'lab_team' : 'retainer_team'}" violates check constraint "colour_check"`);
    const found = row.id ? list.find((m) => m.id === row.id) : null;
    const kind = row.kind ?? found?.kind ?? 'person';
    if (list.some((m) => m.id !== found?.id && m.name.toLowerCase() === name.toLowerCase() && (!kindKey || m.kind === kind))) {
      fail(`duplicate key value violates unique constraint "${kindKey ? 'lab_team_name_idx' : 'retainer_team_name_idx'}"`);
    }
    const data = { ...row, name };
    delete data.id;
    if ('city_id' in data) data.city_id = data.city_id === '' || data.city_id === null ? null : Number(data.city_id);
    if ('sort_order' in data) data.sort_order = data.sort_order === '' || data.sort_order === null ? 50 : Number(data.sort_order);
    if (found) { Object.assign(found, data, { updated_at: stamp() }); audit(kindKey ? 'lab_team' : 'retainer_team', 'UPDATE', found); return clone(found); }
    const fresh = { id: uid(), role: 'maker', colour: 'grey', city_id: null, featured: false, active: true, sort_order: 50, ...(kindKey ? { kind: 'person' } : {}), ...data, created_at: stamp(), updated_at: stamp() };
    if (kindKey) { delete fresh.role; delete fresh.city_id; delete fresh.featured; }
    list.push(fresh);
    audit(kindKey ? 'lab_team' : 'retainer_team', 'INSERT', fresh);
    return clone(fresh);
  }

  const api = {
    // ------------------------------------------------------------ Retainer Record
    async retainerRecords({ cityId }) {
      if (!me()) fail('permission denied for table retainer_cases');
      return db().retainer_cases.filter((r) => r.city_id === Number(cityId) && retainerVisible(r)).map(withPatient);
    },
    async retainerTeam() { if (!me()) fail('permission denied for table retainer_team'); return clone(db().retainer_team); },
    /** Same as the live one: the rows this person may see whose next check is before `today`, every city, earliest check first. */
    async retainerChecksOverdue({ today: day }) {
      if (!me()) fail('permission denied for table retainer_cases');
      return db().retainer_cases.filter((r) => r.next_check_date && r.next_check_date < day && retainerVisible(r))
        .sort((a, b) => a.next_check_date.localeCompare(b.next_check_date) || String(a.id).localeCompare(String(b.id))).map(withPatient);
    },
    async addRetainerRecord(row) {
      need('retainers.manage');
      const r = { id: uid(), patient_id: null, patient_name: null, mr_text: null, contact: null, city_id: null, branch_id: null, braces_case_id: null, arch: null, impression_date: null,
        impression_text: null, retainer_date: null, retainer_text: null, delivered_date: null, next_check_date: null, model_check_by: null, made_by: null,
        status: 'Impression taken', retainer_sheet: null, payment: null, price: null, lab_cost: null, notes: null,
        ...recordPatch(row, RETAINER_FIELDS), source: 'website', source_row: null, source_name: null, created_by: me().id, created_at: stamp(), updated_at: stamp() };
      if (row.status === undefined) r.status = 'Impression taken';
      r.linked_by_hand = !!r.patient_id;
      r.edited_on_site = false;
      fillRetainer(r, null);
      validRetainer(r);
      if (!retainerAccess(r)) rls('retainer_cases');
      db().retainer_cases.push(r);
      audit('retainer_cases', 'INSERT', r);
      return withPatient(r);
    },
    async updateRetainerRecord(id, changes) {
      const r = db().retainer_cases.find((x) => x.id === id);
      const patch = recordPatch(changes, RETAINER_FIELDS);
      delete patch.braces_case_id;
      if (!r || !retainerVisible(r) || !can('retainers.manage') || !Object.keys(patch).length) return null;
      const next = { ...r, ...patch };
      // Marked as changed on the website (private.guard_record_columns): a patient file linked or unlinked, and any change ("Undo the copy" keeps the row).
      next.linked_by_hand = !!r.linked_by_hand || (next.patient_id ?? null) !== (r.patient_id ?? null);
      next.edited_on_site = !!r.edited_on_site || Object.keys(patch).some((k) => (patch[k] ?? null) !== (r[k] ?? null));
      fillRetainer(next, r);
      validRetainer(next);
      if (!retainerAccess(next)) rls('retainer_cases');
      Object.assign(r, next, { updated_at: stamp() });
      audit('retainer_cases', 'UPDATE', r);
      return withPatient(r);
    },
    async deleteRetainerRecord(id) {
      const i = db().retainer_cases.findIndex((x) => x.id === id);
      const r = db().retainer_cases[i];
      if (!r || !retainerVisible(r) || !can('retainers.manage') || (r.source !== 'website' && !isAdmin())) {
        fail('NOT_REMOVED: this row could not be removed (rows that came from the Google Sheet can only be removed by Dr. Ali).');
      }
      db().retainer_cases.splice(i, 1);
      audit('retainer_cases', 'DELETE', r);
    },
    async saveRetainerTeamMember(row) {
      if (row.role !== undefined && !['model_check', 'maker', 'both'].includes(row.role)) fail('new row for relation "retainer_team" violates check constraint "retainer_team_role_check"');
      return saveTeam(db().retainer_team, row);
    },
    /** Same rules and result as public.retainer_mr_check(): which rows link to a patient file by their Mr# (nothing is written). */
    async retainerMrCheck(rows) {
      if (!isAdmin()) fail('NOT_ALLOWED: only Dr. Ali can import the Retainer Record.');
      if (!Array.isArray(rows)) fail('BAD_ROWS: send the rows as a list.');
      if (rows.length > 2000) fail('TOO_MANY_ROWS: send at most 2000 rows at a time.');
      const out = rows.map((x) => ({ row: /^\d{1,7}$/.test(String(x?.row ?? '')) ? Number(x.row) : null, outcome: mrMatch(cell(x?.mr, 20), cell(x?.name, 200)).outcome }));
      const n = (k) => out.filter((o) => o.outcome === k).length;
      return { given: out.length, linked: n('linked'), name_differs: n('name_differs'), not_found: n('not_found'), not_an_mr: n('not_an_mr'), rows: out };
    },
    /**
     * Same rules and result as public.import_retainer_records(): the ONE copy of a city's tab, every row in this one call, refused
     * (ALREADY_COPIED) once the city has copied rows; { dryRun } works it all out and keeps nothing.
     */
    async importRetainerRecords(cityId, rows, { dryRun = false } = {}) {
      if (!isAdmin()) fail('NOT_ALLOWED: only Dr. Ali can copy the Retainer Record.');
      const city = Number(cityId);
      const cityRow = db().cities.find((c) => c.id === city);
      if (!cityRow) fail('BAD_CITY: choose the city of this sheet tab.');
      if (!Array.isArray(rows)) fail('BAD_ROWS: send the rows as a list.');
      if (rows.length > 3000) fail('TOO_MANY_ROWS: a tab of more than 3000 rows cannot be copied in one go.');
      const copied = db().retainer_cases.filter((r) => r.city_id === city && r.source === 'sheet_import');
      if (copied.length) {
        fail(`ALREADY_COPIED: ${cityRow.name} was already copied on ${dayText(copied.map((r) => r.created_at).sort()[0])} (${copied.length.toLocaleString('en-PK')} ${copied.length === 1 ? 'retainer' : 'retainers'}). The website is now the Retainer Record: add or change retainers there.`);
      }
      if (dryRun) {
        // (the database undoes a dry run; here it runs on copies of the two lists it changes, put back as soon as the run is done:
        // the run has no await, so nothing else can write to the copies meanwhile)
        const keep = { team: db().retainer_team, cases: db().retainer_cases };
        db().retainer_team = clone(keep.team);
        db().retainer_cases = clone(keep.cases);
        let run;
        try { run = api.importRetainerRecords(cityId, rows); } finally { db().retainer_team = keep.team; db().retainer_cases = keep.cases; }
        return { ...(await run), dry_run: true };
      }
      const team = db().retainer_team;
      const items = rows.map((x, i) => {
        const rowNo = /^\d{1,7}$/.test(String(x?.row ?? '')) && Number(x.row) >= 1 && Number(x.row) <= 1000000 ? Number(x.row) : null;
        const imp = realDate(x?.impression_date), ret = realDate(x?.retainer_date);
        const nameOf = (v) => { const t = cell(v, 80); return t ? capsIfSmall(cleanName(t)) : null; };
        return { item: i + 1, row: rowNo, mr: cell(x?.mr, 20), name: cell(x?.name, 200), contact: cell(x?.contact, 60), imp, impText: imp ? null : cell(x?.impression_text, 100),
          ret, retText: ret ? null : cell(x?.retainer_text, 100), model: nameOf(x?.model_check), maker: nameOf(x?.made_by), status: cell(x?.status, 60),
          sheet: cell(x?.retainer_sheet, 60), payment: cell(x?.payment, 60), notes: cell(x?.notes, 2000), skip: null, kept: false };
      });
      for (const it of items) {
        if (it.row === null) it.skip = 'No sheet row number';
        else if (!it.name) it.skip = 'No patient name';
        else if (items.some((o) => o !== it && !o.skip && o.row === it.row && o.item < it.item)) it.skip = 'The same sheet row is in the tab twice';
      }
      // The rows an undo kept (changed on the website): each takes at most one sheet row of its name, one with its impression date first,
      // then the nearest to its old row number (a corrected sheet moves rows up or down), and that sheet row is left out. The date only
      // chooses: a date fixed on either side still finds its own row (and is reported, kept_date_differs). One to one, so a second line of
      // the same patient is copied. A kept row that finds none is reported (kept_other).
      const letters = (t) => String(t ?? '').trim().replace(/\s+/g, ' ').toLowerCase(); // private.retainer_name_key
      const keptRows = db().retainer_cases.filter((r) => r.city_id === city && r.source === 'website' && r.source_row != null && r.source_name);
      const pairs = keptRows.flatMap((k) => items.filter((it) => !it.skip && letters(it.name) === letters(k.source_name)).map((it) => ({ k, it })));
      const sameDate = ({ k, it }) => (k.impression_date && k.impression_date === it.imp ? 1 : 0);
      pairs.sort((a, b) => sameDate(b) - sameDate(a) || Math.abs(a.it.row - a.k.source_row) - Math.abs(b.it.row - b.k.source_row) || a.k.source_row - b.k.source_row || a.it.item - b.it.item);
      const paired = new Map();
      for (const { k, it } of pairs) {
        if (paired.has(k) || it.kept) continue;
        paired.set(k, it);
        it.kept = true;
        it.skip = 'Kept from the earlier copy (changed on the website), so it is not copied again';
      }
      const keptOther = keptRows.filter((k) => !paired.has(k)).sort((a, b) => a.source_row - b.source_row || a.source_name.localeCompare(b.source_name)).slice(0, 100)
        .map((k) => ({ row: k.source_row, name: items.find((it) => it.row === k.source_row && it.name)?.name ?? null, kept_name: k.source_name }));
      const keptDates = [...paired].filter(([k, it]) => it.imp && (k.impression_date || null) !== it.imp).sort((a, b) => a[1].row - b[1].row).slice(0, 100)
        .map(([k, it]) => ({ row: it.row, name: it.name, kept_date: k.impression_date || null, sheet_date: it.imp }));
      const ok = items.filter((it) => !it.skip);
      for (const it of ok) if (it.mr) it.match = mrMatch(it.mr, it.name);
      // The team: names matched whatever the capitals; new ones added; a member in a new role becomes "both"; another city's member works everywhere.
      const used = new Map();
      for (const it of ok) for (const [n, kind] of [[it.model, 'model'], [it.maker, 'maker']]) if (n) {
        const k = n.toLowerCase(); const u = used.get(k) || { name: n, model: false, maker: false, made: 0 }; u[kind] = true; if (kind === 'maker') u.made += 1; if (n < u.name) u.name = n; used.set(k, u);
      }
      for (const [k, u] of used) {
        const m = team.find((x) => x.name.toLowerCase() === k);
        if (!m) continue;
        if ((u.maker && m.role === 'model_check') || (u.model && m.role === 'maker')) m.role = 'both';
        if (m.city_id && m.city_id !== city) m.city_id = null;
        u.id = m.id;
      }
      const added = [];
      for (const [, u] of [...used.entries()].filter(([, x]) => !x.id).sort((a, b) => a[1].name.localeCompare(b[1].name))) {
        const role = u.model && u.maker ? 'both' : u.model ? 'model_check' : 'maker';
        // (a maker's colour is chosen below, once the rows are in; light grey until then)
        const m = { id: uid(), name: u.name, role, colour: u.maker ? 'grey' : 'purple', city_id: city, featured: false, active: true, sort_order: 50, created_at: stamp(), updated_at: stamp() };
        team.push(m);
        u.id = m.id; u.added = true;
        added.push(u.name);
      }
      const idOf = (n) => (n ? used.get(n.toLowerCase())?.id ?? null : null);
      let inserted = 0, linked = 0;
      for (const it of ok) {
        const fileId = it.match?.patient_id || null;
        db().retainer_cases.push({ id: uid(), patient_id: fileId, patient_name: it.name, mr_text: it.mr, contact: it.contact, city_id: city, branch_id: null, braces_case_id: null, arch: null,
          impression_date: it.imp, impression_text: it.impText, retainer_date: it.ret, retainer_text: it.retText, delivered_date: null, next_check_date: null,
          model_check_by: idOf(it.model), made_by: idOf(it.maker), status: it.status, retainer_sheet: it.sheet, payment: it.payment, price: null, lab_cost: null, notes: it.notes,
          source: 'sheet_import', source_row: it.row, source_name: it.name, linked_by_hand: false, edited_on_site: false, created_by: me().id, created_at: stamp(), updated_at: stamp() });
        inserted += 1;
        if (fileId) linked += 1;
      }
      // The colours: every maker of the tab whose colour nobody chose yet (new, or still light grey), the most active first: the top makers
      // the strongest, the others the light ones, each one nobody else has where the palette allows (pickColour); never light grey.
      const top = topMakers(db().retainer_cases, team, city);
      const member = (id) => team.find((m) => m.id === id);
      const rank = (id) => (top.includes(id) ? top.indexOf(id) : 99);
      const colours = [];
      for (const u of [...used.values()].filter((x) => x.maker && (x.added || member(x.id)?.colour === 'grey'))
        .sort((a, b) => rank(a.id) - rank(b.id) || b.made - a.made || member(a.id).name.localeCompare(member(b.id).name))) {
        const m = member(u.id);
        m.colour = pickColour(team, { id: m.id, cityId: city, top: top.includes(m.id) });
        colours.push({ name: m.name, colour: m.colour, top: top.includes(m.id) });
      }
      // The banner: nobody of this city in it yet -> the most active makers.
      let featured = [];
      if (!team.some((m) => m.featured && m.active !== false && (!m.city_id || m.city_id === city))) {
        featured = top.map(member).map((m) => { m.featured = true; return m.name; });
      }
      const withMr = ok.filter((it) => it.mr);
      const notLinked = withMr.filter((it) => !it.match.patient_id);
      const why = (k) => notLinked.filter((it) => it.match.outcome === k).length;
      const skipped = items.filter((it) => it.skip);
      return { given: rows.length, inserted, skipped: skipped.slice(0, 100).map((it) => ({ row: it.row, item: it.item, reason: it.skip })), skipped_count: skipped.length,
        kept: items.filter((it) => it.kept).length, kept_other: keptOther, kept_date_differs: keptDates,
        team_added: added.sort(), team_colours: colours, top_makers: top.map((id) => member(id).name), team_featured: featured,
        mr_given: withMr.length, linked, not_linked: withMr.length - linked,
        not_linked_why: { name_differs: why('name_differs'), not_found: why('not_found'), not_an_mr: why('not_an_mr') }, dry_run: false };
    },
    /** Same rules and result as public.undo_retainer_copy(): the copied rows nobody changed go, the changed ones stay as website rows. */
    async undoRetainerCopy(cityId, { dryRun = false } = {}) {
      if (!isAdmin()) fail('NOT_ALLOWED: only Dr. Ali can undo a copy of the Retainer Record.');
      const cityRow = db().cities.find((c) => c.id === Number(cityId));
      if (!cityRow) fail('BAD_CITY: choose the city of the copy.');
      const copied = db().retainer_cases.filter((r) => r.city_id === cityRow.id && r.source === 'sheet_import');
      if (!copied.length) fail(`NOT_COPIED: ${cityRow.name} has no copy of the sheet to undo.`);
      const stay = copied.filter((r) => r.edited_on_site || r.linked_by_hand);
      if (!dryRun) {
        const gone = new Set(copied.filter((r) => !stay.includes(r)));
        for (const r of gone) audit('retainer_cases', 'DELETE', r);
        db().retainer_cases = db().retainer_cases.filter((r) => !gone.has(r));
        for (const r of stay) { r.source = 'website'; r.updated_at = stamp(); audit('retainer_cases', 'UPDATE', r); }
      }
      return { city: cityRow.name, removed: copied.length - stay.length, stayed: stay.length, dry_run: !!dryRun };
    },
    /** Same as public.retainer_copies(): the cities with a copy (or rows an undo kept). */
    async retainerCopies() {
      if (!isAdmin()) fail('NOT_ALLOWED: only Dr. Ali can see the copies of the Retainer Record.');
      const out = [];
      for (const c of db().cities) {
        const copied = db().retainer_cases.filter((r) => r.city_id === c.id && r.source === 'sheet_import');
        const kept = db().retainer_cases.filter((r) => r.city_id === c.id && r.source === 'website' && r.source_row !== null && r.source_row !== undefined);
        if (!copied.length && !kept.length) continue;
        out.push({ city_id: c.id, city: c.name, copied_on: copied.length ? karachiDay(copied.map((r) => r.created_at).sort()[0]) : null, retainers: copied.length,
          changed: copied.filter((r) => r.edited_on_site || r.linked_by_hand).length, kept: kept.length });
      }
      return out;
    },
    /**
     * Same rules as public.rename_record_option(): new words for a status (or a lab work type) on the list and on every row that has the old
     * words (any capitals and punctuation). -> how many rows changed
     */
    async renameRecordOption(list, from, to) {
      if (!isAdmin()) fail('NOT_ALLOWED: only Dr. Ali can change these lists.');
      if (!['retainer_statuses', 'lab_work_types'].includes(list)) fail('BAD_LIST: only the retainer statuses and the lab work types can be renamed here.');
      const words = cleanName(to);
      if (!optionKey(from) || !optionKey(words) || words.length > 60) fail('BAD_NAME: write the new words (at most 60 characters).');
      const items = db().settings[list];
      if (Array.isArray(items)) {
        if (items.some((x) => optionKey(x.label) === optionKey(words) && optionKey(x.label) !== optionKey(from))) fail(`ALREADY_ON_LIST: "${words}" is on the list already.`);
        db().settings[list] = items.map((x) => (optionKey(x.label) === optionKey(from) ? { ...x, label: words } : x));
      }
      const [rowsOf, key] = list === 'retainer_statuses' ? [db().retainer_cases, 'status'] : [db().lab_cases, 'work_type'];
      let n = 0;
      for (const r of rowsOf) {
        if (r[key] && optionKey(r[key]) === optionKey(from) && r[key] !== words) { r[key] = words; r.updated_at = stamp(); audit(list === 'retainer_statuses' ? 'retainer_cases' : 'lab_cases', 'UPDATE', r); n += 1; }
      }
      return n;
    },

    // ------------------------------------------------------------ Lab Work
    async labRecords({ branchId = null } = {}) {
      if (!me()) fail('permission denied for table lab_cases');
      return db().lab_cases.filter((l) => (!branchId || l.branch_id === Number(branchId)) && labVisible(l)).map(withPatient);
    },
    async labTeam() { if (!me()) fail('permission denied for table lab_team'); return clone(db().lab_team); },
    async addLabRecord(row) {
      need('lab.manage');
      const l = { id: uid(), patient_id: null, patient_name: null, contact: null, visit_id: null, branch_id: null, lab_name: null, work_type: null, teeth: null, shade: null,
        sent_date: today(), due_date: null, received_date: null, fitted_date: null, status: 'sent', handled_by: null, cost: null, payment: null, notes: null,
        ...recordPatch(row, LAB_FIELDS), created_by: me().id, created_at: stamp(), updated_at: stamp() };
      if (row.status === undefined) l.status = 'sent';
      if (row.sent_date === undefined) l.sent_date = today();
      fillLab(l, null);
      validLab(l);
      if (!l.branch_id || !branchOk(l.branch_id)) rls('lab_cases');
      db().lab_cases.push(l);
      audit('lab_cases', 'INSERT', l);
      return withPatient(l);
    },
    async updateLabRecord(id, changes) {
      const l = db().lab_cases.find((x) => x.id === id);
      const patch = recordPatch(changes, LAB_FIELDS);
      delete patch.visit_id;
      if (!l || !labVisible(l) || !can('lab.manage') || !Object.keys(patch).length) return null;
      const next = { ...l, ...patch };
      fillLab(next, l);
      validLab(next);
      if (!branchOk(next.branch_id)) rls('lab_cases');
      Object.assign(l, next, { updated_at: stamp() });
      audit('lab_cases', 'UPDATE', l);
      return withPatient(l);
    },
    async deleteLabRecord(id) {
      const i = db().lab_cases.findIndex((x) => x.id === id);
      const l = db().lab_cases[i];
      if (!l || !labVisible(l) || !can('lab.manage')) fail('NOT_REMOVED: this row could not be removed.');
      db().lab_cases.splice(i, 1);
      audit('lab_cases', 'DELETE', l);
    },
    async saveLabTeamMember(row) {
      if (row.kind !== undefined && !['person', 'lab'].includes(row.kind)) fail('new row for relation "lab_team" violates check constraint "lab_team_kind_check"');
      return saveTeam(db().lab_team, row, { kindKey: true });
    },
  };
  return api;
}
