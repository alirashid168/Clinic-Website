// Retainer Record and Lab Work: the lists, colours and rules both pages share with the database
// (supabase/migrations/20261012000200_retainer_lab_records.sql). Pure functions, no DOM, no network, so every rule can be
// tested in Node (tests/records.test.ts).
//
// Colours: every chip is one key of PALETTE. The dark keys carry white text, the light keys dark text; app.css has each
// pair (all at least 6:1). The database accepts exactly these keys for a team member's colour.

export const PALETTE = [
  { key: 'purple', label: 'Deep purple', dark: true }, { key: 'black', label: 'Black', dark: true },
  { key: 'navy', label: 'Navy', dark: true }, { key: 'red', label: 'Red', dark: true },
  { key: 'forest', label: 'Forest green', dark: true }, { key: 'ocean', label: 'Ocean', dark: true },
  { key: 'plum', label: 'Plum', dark: true }, { key: 'brown', label: 'Brown', dark: true },
  { key: 'lavender', label: 'Lavender', dark: false }, { key: 'grey', label: 'Light grey', dark: false },
  { key: 'green', label: 'Mint green', dark: false }, { key: 'blue', label: 'Light blue', dark: false },
  { key: 'amber', label: 'Amber', dark: false }, { key: 'rose', label: 'Rose', dark: false },
  { key: 'teal', label: 'Light teal', dark: false }, { key: 'peach', label: 'Peach', dark: false },
  { key: 'sky', label: 'Sky', dark: false }, { key: 'lime', label: 'Lime', dark: false },
];
const COLOUR_KEYS = new Set(PALETTE.map((p) => p.key));
/** The colour key itself when it is one of ours, otherwise the neutral grey (an unknown key never reaches the page's class names). */
export const colourKey = (key) => (COLOUR_KEYS.has(key) ? key : 'grey');
/** The class of a chip in that colour (app.css: .c-black { --pill-bg ... }). */
export const colourClass = (key) => `c-${colourKey(key)}`;
/**
 * The colours the copy of a sheet tab gives makers (the same two lists as public.import_retainer_records): the most active makers the
 * strong ones, in this order, the others the light ones. Deep purple is the model checkers'; light grey is never given to anybody (it is
 * the blank chip and "someone not on the team").
 */
export const STRONG_COLOURS = ['navy', 'forest', 'plum', 'ocean', 'brown', 'red', 'black'];
export const LIGHT_COLOURS = ['amber', 'rose', 'teal', 'sky', 'lime', 'peach', 'blue', 'green', 'lavender'];
export const MAKER_COLOURS = [...STRONG_COLOURS, ...LIGHT_COLOURS];
/**
 * The colour for a maker (the copy's rule): from the strong list first for one of the most active makers (`top`), else from the light
 * list first; the first colour that no other active member has who works in the city, else that nobody else has at all, else the first.
 */
export function pickColour(team, { id = null, cityId = null, top = false } = {}) {
  const others = (team || []).filter((m) => m.id !== id && m.active !== false);
  const here = (c) => others.some((m) => m.colour === c && (!m.city_id || !cityId || Number(m.city_id) === Number(cityId)));
  const anywhere = (c) => others.some((m) => m.colour === c);
  const order = top ? MAKER_COLOURS : [...LIGHT_COLOURS, ...STRONG_COLOURS];
  return order.find((c) => !here(c) && !anywhere(c)) || order.find((c) => !here(c)) || order[0];
}
/** A team member's name as the database compares it: trimmed, single spaces, any capitals ("Sample  maker " is "sample maker"). */
export const teamNameKey = (name) => String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export const TEAM_ROLES = { model_check: 'Checks models', maker: 'Makes retainers', both: 'Checks models and makes retainers' };
export const STATUS_MEANS = { '': 'Nothing special', made: 'Retainer made: fills the retainer date', delivered: 'Delivered: fills the dates, sets the first check a month later and says "Delivered!"', cancelled: 'Cancelled: left out of the counts' };

// The lists of the drop-downs. The status list and the work types are data (app_settings, edited in Clinic setup); these are
// the defaults the database starts with, used while the setting is missing. The others are fixed here.
export const DEFAULT_RETAINER_STATUSES = [
  { label: 'Impression taken', colour: 'blue' },
  { label: 'Model checked', colour: 'lavender' },
  { label: 'Model poured', colour: 'peach' },
  { label: 'Retainer made', colour: 'teal', means: 'made' },
  { label: 'Delivered to patient', colour: 'green', means: 'delivered' },
  { label: 'Impression repeat', colour: 'amber' },
  { label: 'Re-purchase needed', colour: 'red' },
  { label: 'Cancelled', colour: 'grey', means: 'cancelled' },
];
export const RETAINER_SHEET_OPTIONS = [{ label: 'Re-purchase needed', colour: 'red' }, { label: 'Sheet available', colour: 'green' }];
export const PAYMENT_OPTIONS = [{ label: 'Paid', colour: 'green' }, { label: 'Pending', colour: 'amber' }, { label: 'Free', colour: 'sky' }];
export const DEFAULT_LAB_WORK_TYPES = ['Crown', 'Bridge', 'Veneer', 'Denture', 'Night guard', 'Implant crown', 'Retainer', 'Aligner', 'Other'].map((label) => ({ label }));
/** Lab status keys as stored (the database's check), with the words and colour the page shows. */
export const LAB_STATUSES = [
  { value: 'sent', label: 'Sent to lab', colour: 'blue' },
  { value: 'in_lab', label: 'In lab', colour: 'lavender' },
  { value: 'received', label: 'Received', colour: 'teal' },
  { value: 'fitted', label: 'Fitted', colour: 'green' },
  { value: 'remake', label: 'Remake', colour: 'amber' },
  { value: 'cancelled', label: 'Cancelled', colour: 'grey' },
];
export const LAB_STATUS_LABELS = Object.fromEntries(LAB_STATUSES.map((s) => [s.value, s.label]));

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** 'YYYY-MM' -> 'October 2026' ('' for anything else). */
export function monthName(ym) {
  const m = /^(\d{4})-(\d{2})/.exec(ym || '');
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
}

/** Lower case, letters and digits only: "Re-purchase  Needed" and "repurchase needed" are one value. */
export const optionKey = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * A list from app_settings ([{ label, colour, means, active }]) made safe to use: items without a label are dropped,
 * colours outside the palette become grey. A missing or broken setting gives the default list.
 */
export function cleanList(value, fallback) {
  const list = Array.isArray(value) ? value : fallback;
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const label = String((typeof item === 'string' ? item : item?.label) ?? '').trim().slice(0, 60);
    if (!label || seen.has(optionKey(label))) continue;
    seen.add(optionKey(label));
    out.push({ label, colour: colourKey(item?.colour), means: ['made', 'delivered', 'cancelled'].includes(item?.means) ? item.means : '', active: item?.active !== false });
  }
  return out.length ? out : (list === fallback ? [] : cleanList(fallback, fallback));
}
export const retainerStatuses = (settings) => cleanList(settings?.retainer_statuses, DEFAULT_RETAINER_STATUSES);
export const labWorkTypes = (settings) => cleanList(settings?.lab_work_types, DEFAULT_LAB_WORK_TYPES);

/** The item of `list` a typed value stands for (same letters and digits, any capitals and punctuation), or null. */
export function findOption(list, text) {
  const k = optionKey(text);
  return k ? list.find((o) => optionKey(o.label) === k) || null : null;
}
/** The list's own wording for a typed value; a value not on the list is kept as written (trimmed); empty is null. */
export function canonicalOption(list, text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  return findOption(list, t)?.label ?? t;
}
/** What a status does: 'made', 'delivered', 'cancelled' or ''. */
export const statusMeans = (statuses, status) => findOption(statuses, status)?.means || '';

/** Team members for a drop-down: active, in the role (a "both" member is in both), working in the city (or every city). */
export function teamFor(team, { role = null, cityId = null, includeId = null } = {}) {
  return (team || []).filter((m) => m.id === includeId || (m.active !== false
    && (!role || m.role === role || m.role === 'both')
    && (!cityId || !m.city_id || Number(m.city_id) === Number(cityId))));
}

// ------------------------------------------------------------------------------------------------ order, search, months
/**
 * The sheet's order: rows that came from the sheet by their row on it (a copied row, or one an undo kept), then the rows added on the
 * website in the order they were added. "Newest first" is the same list backwards (the sheet is written top to bottom as impressions
 * come in).
 */
export function sheetOrder(a, b) {
  const sa = a.source_row !== null && a.source_row !== undefined ? 0 : 1;
  const sb = b.source_row !== null && b.source_row !== undefined ? 0 : 1;
  if (sa !== sb) return sa - sb;
  if (sa === 0 && a.source_row !== b.source_row) return Number(a.source_row) - Number(b.source_row);
  const ca = String(a.created_at || ''), cb = String(b.created_at || '');
  return ca === cb ? String(a.id).localeCompare(String(b.id)) : ca < cb ? -1 : 1;
}
export const newestFirst = (a, b) => sheetOrder(b, a);

/** 'YYYY-MM' a row is filed under for the month filter: its first date (impression, then retainer or sent), or ''. */
export function rowMonth(row, keys = ['impression_date', 'retainer_date']) {
  for (const k of keys) if (/^\d{4}-\d{2}/.test(row?.[k] || '')) return row[k].slice(0, 7);
  return '';
}

/** Search text of a row: the name (or the linked patient's), the Mr# (the patient file's, or the one typed on the sheet, leading zeros
 *  or not), and the phone as typed and as digits. */
export function rowMatches(row, q) {
  const text = String(q || '').trim().toLowerCase();
  if (!text) return true;
  const digits = text.replace(/\D/g, '');
  const name = `${row.patient?.full_name || ''} ${row.patient_name || ''}`.toLowerCase();
  if (name.includes(text)) return true;
  const mr = text.replace(/^mr#?\s*/, '');
  if (row.patient?.mr_number && String(row.patient.mr_number) === mr) return true;
  if (row.mr_text && (String(row.mr_text).toLowerCase() === mr || (mrKey(mr) && mrKey(row.mr_text) === mrKey(mr)))) return true;
  if (digits.length >= 4) {
    const phones = `${row.contact || ''} ${row.patient?.phone || ''}`.replace(/\D/g, '');
    if (phones.includes(digits) || (digits.startsWith('92') && phones.includes(digits.slice(2)))) return true;
  }
  return false;
}

// ------------------------------------------------------------------------------------------------ the Retainer Lab banner
/**
 * The banner's numbers per team member and for the tab: this month's (`month` is 'YYYY-MM', Karachi) and all time's, so the banner never
 * opens with only zeros for the people it is for (right after the copy of a sheet tab, or early in a month).
 *   this month  made:      rows with this maker whose retainer date is in the month;
 *               delivered: rows with this maker whose status means delivered, by the delivered date (or, for rows from the sheet that
 *                          have none, the retainer date) in the month;
 *               checked:   rows whose model this member checked, by the impression date (else the retainer date) in the month;
 *   all time    made:      rows with this maker that have a retainer date or a status that means made or delivered (most rows from the
 *                          sheet have a status and no retainer date);
 *               delivered: rows with this maker whose status means delivered;
 *               checked:   rows whose model this member checked.
 * Cancelled rows are left out of every number.
 * -> { byMember: { [id]: { made, delivered, checked, allMade, allDelivered, allChecked } }, made, delivered, allMade, allDelivered }
 */
export function bannerCounts(rows, statuses, month) {
  const byMember = {};
  const of = (id) => (byMember[id] ||= { made: 0, delivered: 0, checked: 0, allMade: 0, allDelivered: 0, allChecked: 0 });
  let made = 0, delivered = 0, allMade = 0, allDelivered = 0;
  for (const r of rows || []) {
    const means = statusMeans(statuses, r.status);
    if (means === 'cancelled') continue;
    if (String(r.retainer_date || '').startsWith(month)) { made += 1; if (r.made_by) of(r.made_by).made += 1; }
    if (means === 'delivered' && String(r.delivered_date || r.retainer_date || '').startsWith(month)) { delivered += 1; if (r.made_by) of(r.made_by).delivered += 1; }
    if (r.model_check_by && String(r.impression_date || r.retainer_date || '').startsWith(month)) of(r.model_check_by).checked += 1;
    if (r.retainer_date || means === 'made' || means === 'delivered') { allMade += 1; if (r.made_by) of(r.made_by).allMade += 1; }
    if (means === 'delivered') { allDelivered += 1; if (r.made_by) of(r.made_by).allDelivered += 1; }
    if (r.model_check_by) of(r.model_check_by).allChecked += 1;
  }
  return { byMember, made, delivered, allMade, allDelivered };
}

/** Makers (and members who do both) first, then the model checkers, each in the team's own order. */
const makersFirst = (list) => [...list.filter((m) => m.role !== 'model_check'), ...list.filter((m) => m.role === 'model_check')];

/**
 * Who the banner shows: the team members marked "In the banner" who work in this city (makers first, then model checkers), or,
 * when nobody is marked, the most active makers of the tab (topMakers), at most eight.
 */
export function bannerTeam(team, rows, cityId) {
  const here = teamFor(team, { cityId });
  const marked = here.filter((m) => m.featured);
  if (marked.length) return makersFirst(marked).slice(0, 8);
  const top = topMakers(rows, team, cityId);
  return top.map((id) => here.find((m) => m.id === id)).filter(Boolean);
}

/**
 * The most active makers of a city's tab (private.retainer_top_makers in the database picks the same people; the copy of a tab gives them
 * the strongest colours and puts them "In the banner" when nobody of that city is in it yet): by the number of the city's rows they made
 * (the whole tab, whatever the dates), at most three, each with at least a fifth of the rows that have a maker, and only active members who
 * make retainers and work in the city. -> member ids, the most active first
 */
export function topMakers(rows, team, cityId) {
  const used = (rows || []).filter((r) => Number(r.city_id) === Number(cityId) && r.made_by);
  const per = {};
  for (const r of used) per[r.made_by] = (per[r.made_by] || 0) + 1;
  return teamFor(team, { role: 'maker', cityId }).filter((m) => per[m.id]).sort((a, b) => per[b.id] - per[a.id] || a.name.localeCompare(b.name))
    .slice(0, 3).filter((m) => per[m.id] * 5 >= used.length).map((m) => m.id);
}

// ------------------------------------------------------------------------------------------------ the Mr# typed on the sheet
/** The Mr# a typed cell stands for: digits only, leading zeros left out ("082" -> "82"), or null when it is not an Mr# ("123-4", "abc"). */
export function mrKey(text) {
  const m = /^\s*0*([1-9]\d{0,6})\s*$/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

// Port of private.aaj_name_fits (supabase/migrations/20261009000300_aaj_two_way_sync.sql), the site's rule for "this typed name is that
// patient WITHOUT DOUBT": the same first name (or an everyday spelling of it) and no other surname. The import links a sheet row to the
// patient file of its Mr# only when the name fits (the database checks with the SQL function itself; the demo uses this port).
const TITLES = new Set(['m', 'mr', 'mrs', 'ms', 'miss', 'dr', 'md', 'muhammad', 'mohammad', 'muhammed', 'mohammed', 'mohd', 'syed', 'syeda', 'sayed', 'hafiz', 'haji', 'baby', 'master', 'kid']);
const normName = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/ +/g, ' ').trim();
const nameWords = (t) => normName(t).split(' ').filter((w) => w && !TITLES.has(w));
function spelling(t) {
  let s = String(t || '').toLowerCase().replace(/[^a-z]/g, '').replace(/[qv]/g, (c) => ({ q: 'k', v: 'w' }[c]));
  s = s.replace(/([aeiou])ye/g, '$1i').replace(/(.)y(?![aeiou])/g, '$1i').replace(/([^aeiou])y(?=[aeiou])/g, '$1i');
  s = s.replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/ou/g, 'u').replace(/^e/, 'i').replace(/[oe]/g, (c) => ({ o: 'u', e: 'a' }[c]));
  return s.replace(/(.)\1+/g, '$1').replace(/([aiu])h$/, '$1');
}
const within = (a, b) => a.every((w) => b.includes(w));
/** Does the typed name `a` fit the patient file's name `b` without doubt? */
export function nameFits(a, b) {
  const wa = nameWords(a), wb = nameWords(b);
  if (wa.length && normName(a) === normName(b)) return true;
  if (!wa.length || !wb.length || wa.length > 4) return false;
  const ka = wa.map(spelling), kb = wb.map(spelling);
  if (!ka[0] || ka[0] !== kb[0] || !(within(ka, kb) || within(kb, ka))) return false;
  const raw = (t) => normName(t).split(' ').filter((w) => w && !['mr', 'mrs', 'ms', 'miss', 'dr'].includes(w))
    .map((w) => (['m', 'md', 'mohd', 'mohammad', 'muhammed', 'mohammed'].includes(w) ? 'muhammad' : w === 'sayed' ? 'syed' : w)).map(spelling);
  const ra = raw(a), rb = raw(b);
  return ra.length < 2 || rb.length < 2 || within(ra, rb) || within(rb, ra);
}

const LINES = [
  'Every retainer here keeps a smile straight for years. Thank you, team.',
  'Steady hands, straight smiles.',
  'Each delivered retainer is a patient who keeps the result they waited for.',
  'Neat models, good fits, happy patients: that is this team.',
];
/** The friendly line under the banner's title: one per day, the same all day long. */
export function friendlyLine(today) {
  const [y, m, d] = String(today).split('-').map(Number);
  const day = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  return LINES[((day % LINES.length) + LINES.length) % LINES.length];
}

// ------------------------------------------------------------------------------------------------ saving
// The columns the website writes (never source, source_row or created_by: the database sets those), and how each is stored.
export const RETAINER_FIELDS = ['patient_id', 'patient_name', 'mr_text', 'contact', 'city_id', 'branch_id', 'impression_date', 'impression_text', 'retainer_date', 'retainer_text',
  'model_check_by', 'made_by', 'status', 'retainer_sheet', 'payment', 'price', 'lab_cost', 'notes', 'next_check_date', 'delivered_date', 'arch', 'braces_case_id'];
export const LAB_FIELDS = ['patient_id', 'patient_name', 'contact', 'branch_id', 'visit_id', 'lab_name', 'work_type', 'teeth', 'shade', 'sent_date', 'due_date',
  'received_date', 'fitted_date', 'status', 'handled_by', 'cost', 'payment', 'notes'];
const NUMBER_FIELDS = new Set(['city_id', 'branch_id', 'price', 'lab_cost', 'cost']);
/** { field: value } of the known fields present in `changes`: text trimmed (empty is null), numbers as numbers, dates as 'YYYY-MM-DD' or null. */
export function recordPatch(changes, fields) {
  const out = {};
  for (const f of fields) {
    if (!changes || changes[f] === undefined) continue;
    const v = changes[f];
    const empty = v === null || (typeof v === 'string' && v.trim() === '');
    if (NUMBER_FIELDS.has(f)) out[f] = empty || !Number.isFinite(Number(v)) ? null : Number(v);
    else if (f.endsWith('_date')) out[f] = !empty && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null;
    else out[f] = empty ? null : typeof v === 'string' ? (f === 'notes' ? v : v.trim()) : v;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the next retainer check
// The rule the Coordinator -> Retainers list had on the live site until the Retainer Record replaced it: a retainer delivered on the website
// gets its first check one calendar month later (the Karachi date; 31 January -> 28 February), unless a check date is set already. The
// database fills it (private.retainer_status_dates, with the delivered date), the demo the same (data/demo-records.js). The date can be
// changed or cleared by hand. Rows copied from the Google Sheet have no check date (the copy fills no date), so none of them is overdue.
/** How many days ahead "Checks due" looks (today included), besides the overdue checks. */
export const CHECK_SOON_DAYS = 7;
const dayNumber = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
/**
 * Where a row's next check stands on `today` ('YYYY-MM-DD', Karachi): 'overdue' once its day has passed, 'soon' from today up to
 * CHECK_SOON_DAYS days ahead, 'later' after that, or null (no check date, or a retainer whose status means cancelled: no check to miss).
 */
export function checkState(row, statuses, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row?.next_check_date || '')) || statusMeans(statuses, row.status) === 'cancelled') return null;
  if (row.next_check_date < today) return 'overdue';
  return dayNumber(row.next_check_date) - dayNumber(today) <= CHECK_SOON_DAYS ? 'soon' : 'later';
}
/** The check's day has passed (and the retainer is not cancelled). */
export const checkOverdue = (row, statuses, today) => checkState(row, statuses, today) === 'overdue';
/** "Checks due": overdue, or due within the next CHECK_SOON_DAYS days. */
export const checkDue = (row, statuses, today) => ['overdue', 'soon'].includes(checkState(row, statuses, today));

// ------------------------------------------------------------------------------------------------ lab work
/** Past its due date and not back from the lab yet (and not cancelled). */
export function labOverdue(row, today) {
  return !!row?.due_date && row.due_date < today && !row.received_date && !['received', 'fitted', 'cancelled'].includes(row.status);
}
