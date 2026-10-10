// Checkup patients: people who came for a checkup and have no patient file (no Mr#). The rules the website shares with
// the database (supabase/migrations/20261009000260_checkups_functions.sql), the reader of the owner's old checkup list,
// and the Excel export. Pure functions, no DOM, no network, so every rule can be tested in Node (tests/checkups.test.ts).
//
// The old list is one Excel sheet (any tab name) that looks like this:
//   row 1 a title, row 2 a note, a blank row, then the header row, then one row per person:
//   Month | Patient Name | Phone | City | Clinic | Doctor | Treatment / Checkup For | Est. Fee (Rs) | Status | Notes | Source Tab
// The header row is FOUND (never assumed to be row 4). "Month" is an Excel date (the 1st of a month) or the text
// "Not recorded"; an empty cell is often written as a dash; the phone is text such as 0300-5550142.
// The website export (checkupsToSheet) starts with the same eleven columns, so an export can be imported again.

export const FOLLOW_UP_STATUSES = ['Not Contacted', 'Follow-up Sent', 'No Response', 'Interested', 'Scheduled',
  'Started', 'Completed', 'Did Not Come', 'Not Interested', 'Referred', 'Not Recorded'];
export const DAY_STATUSES = ['waiting', 'in_treatment', 'completed', 'cancelled', 'no_show'];
export const DAY_STATUS_LABELS = { waiting: 'Waiting', in_treatment: 'In treatment', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No show' };
export const SOURCE_LABELS = { website: 'Website', google_sheet: 'Google Sheet', archive: 'Old list' };
export const IMPORT_BATCH = 250;
// Clinic text (trimmed, lower case, inner spaces collapsed) -> branch code. Includes the app's own branch names so an
// export can be imported again.
export const CLINIC_BRANCH = { 'rj mall': 'GUL', 'gulshan': 'GUL', 'gulshan (rj mall)': 'GUL',
  'north nazimabad': 'NN', 'n. nazimabad': 'NN', 'nn': 'NN', 'dha karachi': 'DHA', 'dha': 'DHA',
  'lahore gulberg': 'LHR', 'gulberg lahore': 'LHR', 'gulberg': 'LHR', 'lahore': 'LHR', 'islamabad': 'ISB', 'isb': 'ISB' };
/** The columns of the Excel export, in order: the owner's eleven first, then the website's own. */
export const EXPORT_HEADER = ['Month', 'Patient Name', 'Phone', 'City', 'Clinic', 'Doctor', 'Treatment / Checkup For', 'Est. Fee (Rs)', 'Status',
  'Notes', 'Source Tab', 'Date', 'Day status', 'Treatment details', 'Source', 'Mr#', 'Added on'];

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MIN_YEAR = 1990, MAX_YEAR = 2100;     // a "month" outside these years is a typing slip, not a date
const MAX_FEE = 9999999999.99;               // what the database column holds
const pad2 = (n) => String(n).padStart(2, '0');

// ------------------------------------------------------------------------------------------------ cells
/** Empty, only spaces, or only dashes (-, en dash, em dash): the old list writes "nothing" as a dash in several columns. */
export function isEmptyCell(v) {
  return v === null || v === undefined || /^[\s\-\u2013\u2014]*$/.test(String(v));
}

/** { value, cut }: the text trimmed and cut to `max` characters (cut = true when text was lost); value is null for an empty cell. */
export function cleanText(v, max) {
  if (isEmptyCell(v)) return { value: null, cut: false };
  const s = String(v).trim();
  if (s.length <= max) return { value: s, cut: false };
  const chars = Array.from(s);       // count characters the way the database does (an emoji is one)
  return chars.length <= max ? { value: s, cut: false } : { value: chars.slice(0, max).join(''), cut: true };
}

/** The phone as digits, so 0300-5550142, +92 300 5550142 and 300 5550035 are one number; null when under 7 digits. Same rule as private.checkup_phone. */
export function checkupPhone(raw) {
  const d = String(raw ?? '').replace(/[^0-9]/g, '');
  if (/^3[0-9]{9}$/.test(d)) return '0' + d;
  if (/^92[0-9]{10}$/.test(d)) return '0' + d.slice(2);
  return d.length >= 7 ? d : null;
}

/** "phone|name|YYYYMM" (month = 'YYYY-MM-DD' or null). Same rule as private.checkup_key; the database stays the judge, this only finds repeats inside one file. */
export function checkupKey({ phone, name, month } = {}) {
  const m = /^(\d{4})-(\d{2})/.exec(month || '');
  return (checkupPhone(phone) ?? '') + '|' + String(name ?? '').replace(/\s+/g, ' ').trim().toLowerCase() + '|' + (m ? String(Number(m[1]) * 100 + Number(m[2])) : '');
}

// ------------------------------------------------------------------------------------------------ months and fees
/** An Excel date serial (1900 system, whole days) -> 'YYYY-MM-DD'; null when it is not a number or outside 1..2958465. */
export function excelSerialToISO(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const days = Math.floor(n);
  if (days < 1 || days > 2958465) return null;
  return new Date(Date.UTC(1899, 11, 30) + days * 86400000).toISOString().slice(0, 10);
}

const monthNumber = (word) => {
  const w = String(word).toLowerCase();
  if (w === 'sept') return 9;
  return w.length >= 3 ? MONTH_NAMES.findIndex((name) => name.startsWith(w)) + 1 : 0;
};
const yearOf = (y) => (String(y).length === 2 ? 2000 + Number(y) : Number(y));
const monthIso = (y, m) => (m >= 1 && m <= 12 && y >= MIN_YEAR && y <= MAX_YEAR ? `${y}-${pad2(m)}-01` : null);
const dayOk = (d) => d === undefined || (d >= 1 && d <= 31);

/** A month cell -> { iso: 'YYYY-MM-01' | null, bad }. bad is true only when something was written that could not be understood. */
function parseMonth(v) {
  if (v === null || v === undefined || isEmptyCell(v)) return { iso: null, bad: false };
  const bad = { iso: null, bad: true };
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? bad : (monthIso(v.getFullYear(), v.getMonth() + 1) ? { iso: monthIso(v.getFullYear(), v.getMonth() + 1), bad: false } : bad);
  if (typeof v === 'number') {
    const iso = excelSerialToISO(v);
    const out = iso && monthIso(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)));
    return out ? { iso: out, bad: false } : bad;
  }
  const s = String(v).trim().replace(/\s+/g, ' ');
  if (/^not recorded$/i.test(s)) return { iso: null, bad: false };
  let m;
  // 2024-12-01, 2024-12-01T00:00:00, 2024-12
  if ((m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?(?:[T ].*)?$/.exec(s))) {
    const iso = dayOk(m[3] === undefined ? undefined : Number(m[3])) && monthIso(Number(m[1]), Number(m[2]));
    return iso ? { iso, bad: false } : bad;
  }
  // Dec 2024, December 2024, Dec-24, Dec 24, Dec, 2024
  if ((m = /^([a-z]+)[ .,/-]*(\d{4}|\d{2})$/i.exec(s))) {
    const iso = monthNumber(m[1]) && monthIso(yearOf(m[2]), monthNumber(m[1]));
    return iso ? { iso, bad: false } : bad;
  }
  // 12/2024
  if ((m = /^(\d{1,2})[/.-](\d{4})$/.exec(s))) {
    const iso = monthIso(Number(m[2]), Number(m[1]));
    return iso ? { iso, bad: false } : bad;
  }
  // 2024/12
  if ((m = /^(\d{4})[/.](\d{1,2})$/.exec(s))) {
    const iso = monthIso(Number(m[1]), Number(m[2]));
    return iso ? { iso, bad: false } : bad;
  }
  // 01/12/2024: day first, as written in Pakistan
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/.exec(s))) {
    const iso = dayOk(Number(m[1])) && monthIso(yearOf(m[3]), Number(m[2]));
    return iso ? { iso, bad: false } : bad;
  }
  return bad;
}

/** A month cell -> 'YYYY-MM-01', or null for "Not recorded", an empty cell or something that is not a month. */
export function monthCell(v) {
  return parseMonth(v).iso;
}

/** A fee cell -> number (rounded to 2 places) or null. Accepts 8000, "8,000", "Rs 8,000", "PKR 8000", "8000/-", "8k". */
export function feeCell(v) {
  let n;
  if (typeof v === 'number') n = v;
  else {
    if (isEmptyCell(v)) return null;
    let s = String(v).toLowerCase().replace(/rs\.?|pkr/g, '').replace(/[,\s]/g, '').replace(/[/]-$/, '');
    let times = 1;
    if (s.endsWith('k')) { times = 1000; s = s.slice(0, -1); }
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    n = Number(s) * times;
  }
  return Number.isFinite(n) && n >= 0 && n <= MAX_FEE ? Math.round(n * 100) / 100 : null;
}

/** 'YYYY-MM-DD' (or 'YYYY-MM') -> 'Dec 2024'; '' when it is not a date. */
export function monthLabel(iso) {
  const m = /^(\d{4})-(\d{2})/.exec(iso || '');
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${MONTH_ABBR[Number(m[2]) - 1]} ${m[1]}` : '';
}

/** A status cell -> one of FOLLOW_UP_STATUSES when it matches ignoring case, spaces and hyphens; empty -> 'Not Contacted'; anything else stays as written (cut to 60). */
export function canonicalStatus(v) {
  if (isEmptyCell(v)) return 'Not Contacted';
  const key = (t) => String(t).toLowerCase().replace(/[\s\-_]+/g, ' ').trim();
  const hit = FOLLOW_UP_STATUSES.find((s) => key(s) === key(v));
  return hit || cleanText(v, 60).value;
}

// ------------------------------------------------------------------------------------------------ the Aaj ki List
/** Checkups to show on a day's list: only exact-day rows, and not a person who has become a patient with a visit on that list (D7). */
export function dayListCheckups(checkups, visits) {
  const patients = new Set((visits || []).map((v) => v.patient_id).filter(Boolean));
  return (checkups || []).filter((c) => !c.date_is_month && !(c.patient_id && patients.has(c.patient_id)));
}

// ------------------------------------------------------------------------------------------------ reading the old list
const normHeader = (h) => String(h ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.]$/, '');
const ALIASES = {
  month: ['month', 'date', 'checkup month'],
  name: ['patient name', 'name'],
  phone: ['phone', 'contact no', 'mobile', 'mobile number'],
  city: ['city'],
  clinic: ['clinic', 'branch'],
  doctor: ['doctor', 'doctors', "doctor's name"],
  checkupFor: ['treatment / checkup for', 'checkup for', 'treatment'],
  fee: ['est. fee (rs)', 'est fee (rs)', 'est fee', 'fee'],
  status: ['status', 'follow-up', 'follow up status'],
  notes: ['notes', 'note'],
  sourceTab: ['source tab'],
  source: ['source'],
};
export const COLUMN_LABELS = { name: 'Patient Name', phone: 'Phone' };

/** A header row -> { field: columnIndex } for the columns it has (exact names only; the first column of a name wins). */
export function detectCheckupColumns(headers) {
  const H = (Array.isArray(headers) ? headers : []).map(normHeader);
  const out = {};
  const taken = new Set();
  for (const [field, names] of Object.entries(ALIASES)) {
    for (const alias of names) {
      const i = H.findIndex((x, k) => !taken.has(k) && x === alias);
      if (i >= 0) { out[field] = i; taken.add(i); break; }
    }
  }
  return out;
}

/** The row index of the header among the first 15 rows (the one with a patient name column and a phone column); -1 when there is none. */
export function findHeader(rows2d) {
  const limit = Math.min(15, Array.isArray(rows2d) ? rows2d.length : 0);
  for (let i = 0; i < limit; i++) {
    const c = detectCheckupColumns(rows2d[i]);
    if (c.name !== undefined && c.phone !== undefined) return i;
  }
  return -1;
}

/** The first tab of [{ name, rows }] that holds a checkup list header, or null. */
export function findCheckupSheet(tabs) {
  return (tabs || []).find((t) => findHeader(t?.rows) >= 0) || null;
}

const bump = (map, key) => {
  const had = Object.prototype.hasOwnProperty.call(map, key);
  Object.defineProperty(map, key, { value: (had ? map[key] : 0) + 1, enumerable: true, writable: true, configurable: true });   // safe for any text, even "__proto__"
};

/**
 * Reads the rows of a sheet into the rows import_checkups() takes.
 * -> { headerAt, columns, missing, rows, skipped, summary }
 *   rows: [{ row, month, name, phone, city, branch, doctors, checkup_for, est_fee, follow_up, notes, source_tab }]  (row = the row number in the sheet, counting the title rows)
 *   skipped: [{ row, reason }]   summary: counts for the preview (of the rows that are ready to import, except total/ready/skipped)
 */
export function readCheckupList(rows2d) {
  const grid = Array.isArray(rows2d) ? rows2d : [];
  const headerAt = findHeader(grid);
  const summary = { total: 0, ready: 0, skipped: 0, from: null, to: null, noMonth: 0, badMonth: 0, withFee: 0, cut: 0,
    perClinic: {}, perBranch: {}, unknownClinics: {}, perStatus: {}, unknownStatuses: {} };
  if (headerAt < 0) return { headerAt, columns: {}, missing: Object.values(COLUMN_LABELS), rows: [], skipped: [], summary };
  const columns = detectCheckupColumns(grid[headerAt]);
  const missing = Object.entries(COLUMN_LABELS).filter(([field]) => columns[field] === undefined).map(([, label]) => label);
  const rows = [];
  const skipped = [];
  const firstOfKey = new Map();
  const skip = (row, reason) => { skipped.push({ row, reason }); summary.total++; summary.skipped++; };
  let from = null, to = null;

  for (let i = headerAt + 1; i < grid.length; i++) {
    const cells = Array.isArray(grid[i]) ? grid[i] : [];
    if (cells.every(isEmptyCell)) continue;
    const row = i + 1;
    const at = (field) => (columns[field] === undefined ? undefined : cells[columns[field]]);
    const name = cleanText(isEmptyCell(at('name')) ? null : String(at('name')).replace(/\s+/g, ' '), 200);
    if (name.value === null) { skip(row, 'No patient name'); continue; }
    if (columns.source !== undefined && /^(website|google sheet)$/i.test(String(at('source') ?? '').trim())) { skip(row, 'Already on the website (exported from it)'); continue; }

    const month = parseMonth(at('month'));
    const phone = cleanText(at('phone'), 40);
    const key = checkupKey({ phone: phone.value, name: name.value, month: month.iso });
    if (firstOfKey.has(key)) { skip(row, `Same person and month as row ${firstOfKey.get(key)}`); continue; }
    firstOfKey.set(key, row);

    const city = cleanText(at('city'), 80);
    const clinicText = isEmptyCell(at('clinic')) ? null : String(at('clinic')).trim();
    const clinicKey = clinicText === null ? null : clinicText.toLowerCase().replace(/\s+/g, ' ');
    const branch = clinicKey !== null && Object.prototype.hasOwnProperty.call(CLINIC_BRANCH, clinicKey) ? CLINIC_BRANCH[clinicKey] : null;
    const doctors = cleanText(at('doctor'), 300);
    const checkupFor = cleanText(at('checkupFor'), 300);
    const fee = feeCell(at('fee'));
    const followUp = canonicalStatus(at('status'));
    const notes = cleanText(at('notes'), 2000);
    const sourceTab = cleanText(at('sourceTab'), 120);

    rows.push({ row, month: month.iso, name: name.value, phone: phone.value, city: city.value, branch, doctors: doctors.value,
      checkup_for: checkupFor.value, est_fee: fee, follow_up: followUp, notes: notes.value, source_tab: sourceTab.value });

    summary.total++;
    summary.ready++;
    if (month.iso === null) summary.noMonth++;
    else {
      const ym = month.iso.slice(0, 7);
      if (from === null || ym < from) from = ym;
      if (to === null || ym > to) to = ym;
    }
    if (month.bad) summary.badMonth++;
    if (fee !== null) summary.withFee++;
    summary.cut += [name, phone, city, doctors, checkupFor, notes, sourceTab].filter((c) => c.cut).length;
    bump(summary.perClinic, clinicText === null ? '(empty)' : clinicText);
    bump(summary.perBranch, branch || 'none');
    if (clinicText !== null && branch === null) bump(summary.unknownClinics, clinicText);
    bump(summary.perStatus, followUp);
    if (!FOLLOW_UP_STATUSES.includes(followUp)) bump(summary.unknownStatuses, followUp);
  }
  summary.from = from;
  summary.to = to;
  return { headerAt, columns, missing, rows, skipped, summary };
}

// ------------------------------------------------------------------------------------------------ the Excel export
const karachiDate = (ts) => {
  const d = new Date(ts);
  if (!ts || Number.isNaN(d.getTime())) return '';
  const p = {};
  for (const part of new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
};

/**
 * Checkup rows (as the Checkups page holds them) -> an array of arrays for the Excel file: the header, then one row per person.
 * Everything is text (phones keep their leading 0) except the fee. `branches` = [{ id, name }].
 */
export function checkupsToSheet(rows, branches) {
  const names = new Map((branches || []).map((b) => [Number(b.id), b.name]));
  const text = (v) => (v === null || v === undefined ? '' : String(v));
  const out = [EXPORT_HEADER.slice()];
  for (const c of rows || []) {
    const exactDay = !c.date_is_month && c.checkup_date ? String(c.checkup_date).slice(0, 10) : '';
    out.push([
      monthLabel(c.checkup_date) || 'Not recorded',
      text(c.patient_name), text(c.phone), text(c.city),
      c.branch_id === null || c.branch_id === undefined ? '' : text(names.get(Number(c.branch_id))),
      text(c.doctors), text(c.checkup_for),
      c.est_fee === null || c.est_fee === undefined || c.est_fee === '' ? '' : Number(c.est_fee),
      text(c.follow_up), text(c.notes), text(c.source_tab),
      exactDay, DAY_STATUS_LABELS[c.day_status] || '', text(c.details), SOURCE_LABELS[c.source] || '', text(c.mr_number), karachiDate(c.created_at),
    ]);
  }
  return out;
}
