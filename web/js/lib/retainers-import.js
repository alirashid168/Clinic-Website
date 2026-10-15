// The reader of the clinic's "Retainer Record" Google Sheet: one tab (downloaded as CSV, or a tab of the .xlsx) -> the rows
// public.import_retainer_records() takes (supabase/migrations/20261012000200_retainer_lab_records.sql), all in one call: each city's
// tab is copied ONCE (owner, 12 Oct 2026: "the retainer sheet can be copied, its complete"), and from then on the website is the
// Retainer Record. Pure functions, no DOM, no network (tests/retainers-import.test.ts).
//
// The tabs look like this (the header row is FOUND, columns are matched by their heading):
//   Karachi:  Mr# | Patient name | Impression Date | Model Check By | Retainer Made By | Retainer Date | Status | retainer sheet | Payments
//   Lahore:   Contact # | Patient Name | Impression Date | Model Check By | Retainer Made By | Retainer Date | Status
// The Karachi tab lost its first two headings (column A is headed with a patient's first name, column B "Column 2"), so when the
// sheet's own headings start in column C, column A is read as the Mr# and column B as the patient name, by position. Most Mr# cells
// are blank; the ones there are kept as typed ("082" keeps its 0) and the import links the row to the patient file of that Mr# only
// when the name fits too (the database's rule). The other cells:
//   Status: the list's wording ("Delivered to Patient" is "Delivered to patient", "Model Poured" is "Model poured"); a value not on
//           the list is kept as written when it reads like a status (a few words, no digits); longer text (a treatment typed into
//           Status) is no status, and the text goes to the row's notes.
//   Payments: "Payment Done" is Paid, "Dues" is Pending.
//   Team names: matched whatever the capitals; a name typed all in small letters gets capitals ("syed sample" -> "Syed Sample").
// The dates were typed by hand:
//   Karachi: day first with a year, in many shapes and with typing slips: 15/04/2025, 17-04-2025, 11-06-25, 19\-04-2025,
//            24-04=2025, 17-05--20225, 09-07-20256. Google Sheets turned some typed dates into real dates and shows those month
//            first (04/08/2025 is 8 April), so a slash date whose two numbers are both 12 or less can be read either way.
//   Lahore:  a day and a month name WITHOUT a year (20- November, 23rd december, 16March, 23may, 11 feburary), a few day/month/year
//            (23/5/26), in time order from November 2025.
// How a date is read: a cell gives the dates it can mean ("candidates"). One candidate is that date. Several (day/month or
// month/day, a slipped year such as 20256 = 2025 or 2026, or no year at all) are settled by the rows around it, because the
// sheet is written in time order: the candidate nearest to the date of the row before it wins (for the rows above the first
// sure date, the row after it). A month name with no year so moves to the next year when the months go back (December, then
// January). A cell nothing can be read from keeps its typed text, and the page shows it as typed.

import { DEFAULT_RETAINER_STATUSES, RETAINER_SHEET_OPTIONS, PAYMENT_OPTIONS, canonicalOption, findOption, optionKey, mrKey } from './records.js';

export const RETAINER_COPY_MAX = 3000;        // a whole tab goes in one call (the function takes at most 3000 rows)
export const MIN_YEAR = 2020, MAX_YEAR = 2035; // a year outside these is a typing slip
const DAY = 86400000;
const pad2 = (n) => String(n).padStart(2, '0');
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// ------------------------------------------------------------------------------------------------ cells
/** Empty, only spaces, or only dashes (-, en dash, em dash). */
export const isBlank = (v) => v === null || v === undefined || /^[\s\-–—]*$/.test(String(v));
const text = (v, max) => (isBlank(v) ? null : String(v).trim().replace(/\s+/g, ' ').slice(0, max));
/** A team member's name as the database stores it: single spaces, all-small names get capitals ("syed sample" -> "Syed Sample"). */
export function teamName(v) {
  const n = text(v, 80);
  if (!n) return null;
  return n === n.toLowerCase() ? n.replace(/(^|[^a-z])([a-z])/g, (_, a, b) => a + b.toUpperCase()) : n;
}
/** A phone that lost its leading 0 in a spreadsheet (3001234567) gets it back; anything else is kept as typed. */
export function contactCell(v) {
  const t = text(v, 60);
  if (!t) return null;
  return /^3\d{9}$/.test(t) ? '0' + t : t;
}
/** The Mr# column: { mr } kept as typed, leading zeros too ("082"); a phone typed there (ten digits or more) is { contact } instead. */
export function mrCell(v) {
  const t = text(v, 60);
  if (!t) return { mr: null, contact: null };
  return t.replace(/\D/g, '').length >= 10 ? { mr: null, contact: contactCell(t) } : { mr: t.slice(0, 20), contact: null };
}
/**
 * A Status cell: { status, note }. The list's own wording when it is on the list; a value not on the list that reads like a status
 * (30 letters or fewer, four words or fewer, no digits) is kept as written; anything else (a treatment typed into Status) is no
 * status, and its text is the note.
 */
export function statusCell(v, statuses) {
  const t = text(v, 2000);
  if (!t) return { status: null, note: null };
  const found = findOption(statuses, t);
  if (found) return { status: found.label, note: null };
  return t.length <= 30 && t.split(' ').length <= 4 && !/\d/.test(t) ? { status: t, note: null } : { status: null, note: t };
}

// ------------------------------------------------------------------------------------------------ dates
const iso = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const valid = (y, m, d) => y >= MIN_YEAR && y <= MAX_YEAR && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
const toDay = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))) / DAY;

/** The years a typed year can be: 25 -> 2025, 2025 -> 2025, a five-digit slip -> every year one deleted digit gives (20256 -> 2026, 2025). */
export function yearCandidates(s) {
  const t = String(s);
  if (/^\d{2}$/.test(t)) return [2000 + Number(t)];
  if (/^\d{4}$/.test(t)) return Number(t) >= MIN_YEAR && Number(t) <= MAX_YEAR ? [Number(t)] : [];
  if (/^\d{5}$/.test(t)) {
    const out = [];
    for (let i = 0; i < 5; i++) { const y = Number(t.slice(0, i) + t.slice(i + 1)); if (y >= MIN_YEAR && y <= MAX_YEAR && !out.includes(y)) out.push(y); }
    return out;
  }
  return [];
}

/** The month a word stands for, 1-12, or 0: the start of a month's name (jan, sept, decem), or for a word of 4 letters or more a
 *  month's name with at most two letters wrong (feburary, decmber, novmber). */
export function monthOfWord(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (w.length < 3) return 0;
  const start = MONTHS.findIndex((m) => m.startsWith(w));
  if (start >= 0) return start + 1;
  if (w.length < 4) return 0;
  let best = 0, bestD = 3;
  MONTHS.forEach((m, i) => { const dist = editDistance(w, m); if (dist < bestD) { bestD = dist; best = i + 1; } });
  return best;
}
function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) { const cur = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  }
  return row[b.length];
}

/** An Excel date serial (a real date in an .xlsx tab) -> 'YYYY-MM-DD', or null. */
export function excelSerial(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1 || n > 2958465) return null;
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * DAY).toISOString().slice(0, 10);
}

/**
 * What one cell can mean:
 *   { kind: 'empty' }
 *   { kind: 'date', options: ['2025-04-15'] }                       one reading
 *   { kind: 'ambiguous', options: ['2025-08-04', '2025-04-08'] }    several (day/month order, a slipped year)
 *   { kind: 'noyear', month: 11, day: 20 }                          a day and a month, the year comes from the rows around it
 *   { kind: 'bad' }                                                  nothing can be read
 * (text: the cell as typed, on every kind but empty.)
 */
export function parseDateCell(raw) {
  if (typeof raw === 'number') {
    const d = excelSerial(raw);
    return d && valid(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8, 10)) ? { kind: 'date', options: [d], text: String(raw) } : { kind: 'bad', text: String(raw) };
  }
  if (isBlank(raw)) return { kind: 'empty' };
  const typed = String(raw).trim();
  const t = typed.toLowerCase();
  // Year first (2025-04-08, as the website's own download writes it).
  let m = /^(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})$/.exec(t);
  if (m) return valid(+m[1], +m[2], +m[3]) ? { kind: 'date', options: [iso(+m[1], +m[2], +m[3])], text: typed } : { kind: 'bad', text: typed };
  if (/[a-z]/.test(t)) return parseWordDate(t, typed);
  const parts = t.split(/[^0-9]+/).filter(Boolean);
  if (parts.length === 2) {
    // "23/5": a day and a month, typed (Google Sheets adds a year to a date it understood), so day first.
    const [d, mo] = parts.map(Number);
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? { kind: 'noyear', month: mo, day: d, text: typed } : { kind: 'bad', text: typed };
  }
  if (parts.length !== 3 || parts[0].length > 2 || parts[1].length > 2) return { kind: 'bad', text: typed };
  const [a, b] = [Number(parts[0]), Number(parts[1])];
  const years = yearCandidates(parts[2]);
  // Day first always; month first only for a slash date (Google Sheets shows the dates it recognised that way) or when day first
  // cannot be right (04-15-2025).
  const slash = t.includes('/');
  const options = [];
  for (const y of years) {
    if (valid(y, b, a)) options.push(iso(y, b, a));
    if ((slash || b > 12) && valid(y, a, b)) options.push(iso(y, a, b));
  }
  const unique = [...new Set(options)];
  return unique.length === 0 ? { kind: 'bad', text: typed } : { kind: unique.length === 1 ? 'date' : 'ambiguous', options: unique, text: typed };
}

// "20- november", "23rd december", "16march", "23may", "11 feburary", "nov 20", "20 november 2025", "20 nov 25"
function parseWordDate(t, typed) {
  const words = t.match(/[a-z]+/g) || [];
  let month = 0;
  for (const w of words) { if (['st', 'nd', 'rd', 'th', 'of'].includes(w)) continue; month = monthOfWord(w); if (month) break; }
  const nums = t.match(/\d+/g) || [];
  if (!month || !nums.length) return { kind: 'bad', text: typed };
  let day = null, years = null;
  for (const n of nums) {
    if (day === null && n.length <= 2 && Number(n) >= 1 && Number(n) <= 31) day = Number(n);
    else if (years === null && (n.length === 4 || n.length === 5 || (n.length === 2 && day !== null))) years = yearCandidates(n);
    else return { kind: 'bad', text: typed };
  }
  if (day === null || (years !== null && !years.length)) return { kind: 'bad', text: typed };
  if (years === null) return day <= 31 ? { kind: 'noyear', month, day, text: typed } : { kind: 'bad', text: typed };
  const options = years.filter((y) => valid(y, month, day)).map((y) => iso(y, month, day));
  return !options.length ? { kind: 'bad', text: typed } : { kind: options.length === 1 ? 'date' : 'ambiguous', options, text: typed };
}

/** The readings of a parsed cell near an anchor date: its options, or for a cell without a year, that day in the years around the anchor. */
function readingsNear(p, anchor) {
  if (p.kind !== 'noyear') return p.options;
  const y = Number(anchor.slice(0, 4));
  return [y - 1, y, y + 1].filter((yy) => valid(yy, p.month, p.day)).map((yy) => iso(yy, p.month, p.day));
}
/** The reading nearest to the anchor. With { after: true } a reading on or after it costs a third of one before it (a retainer comes after its impression). */
function nearest(readings, anchor, { after = false } = {}) {
  const a = toDay(anchor);
  let best = null, bestCost = Infinity;
  for (const r of readings) {
    const diff = toDay(r) - a;
    const cost = after && diff < 0 ? -diff * 3 : Math.abs(diff);
    if (cost < bestCost) { best = r; bestCost = cost; }
  }
  return best;
}

/**
 * Settles one column of parsed cells (in sheet order) into dates: [{ iso, text, guessed }] (iso null when nothing could be read;
 * text = the cell as typed when it is not empty; guessed = the rows around it decided). `rowAnchors` (optional) gives, per row,
 * a date the cell should come on or after (the row's impression date, for the retainer column).
 * Without any sure date in the column the first cell's year is `startYear` (and the next ones follow it); with { startYear }
 * given, it is used even when the column has sure dates further down. `today` ('YYYY-MM-DD', the clinic's day; the computer's UTC
 * day when left out) is what "after today" means when the start year is chosen.
 */
export function resolveColumn(cells, { startYear = null, rowAnchors = null, today = null } = {}) {
  const out = cells.map((p) => ({ iso: p.kind === 'date' ? p.options[0] : null, text: p.kind === 'empty' ? null : p.text, guessed: false }));
  const open = (i) => cells[i].kind === 'ambiguous' || cells[i].kind === 'noyear';
  const settle = (i, anchor) => {
    const own = rowAnchors?.[i];
    const pick = own ? nearest(readingsNear(cells[i], own), own, { after: true }) : nearest(readingsNear(cells[i], anchor), anchor);
    if (pick) { out[i].iso = pick; out[i].guessed = true; }
    return pick;
  };
  const firstSure = startYear ? -1 : cells.findIndex((p) => p.kind === 'date');
  if (firstSure >= 0) {
    let anchor = out[firstSure].iso;
    for (let i = firstSure + 1; i < cells.length; i++) {
      if (cells[i].kind === 'date') anchor = out[i].iso;
      else if (open(i)) anchor = settle(i, anchor) || anchor;
    }
    anchor = out[firstSure].iso;
    for (let i = firstSure - 1; i >= 0; i--) if (open(i)) anchor = settle(i, anchor) || anchor;
    return out;
  }
  // No sure date at all (or the year was given): walk down from the first open cell in the start year.
  const walk = (year) => {
    const res = out.map((o) => ({ ...o }));
    let anchor = null;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].kind === 'date') { anchor = res[i].iso; continue; }
      if (!open(i)) continue;
      const first = anchor || (cells[i].kind === 'noyear' ? iso(year, cells[i].month, Math.min(cells[i].day, daysIn(year, cells[i].month))) : `${year}-01-01`);
      const own = rowAnchors?.[i];
      const pick = own ? nearest(readingsNear(cells[i], own), own, { after: true }) : nearest(readingsNear(cells[i], first), first);
      if (pick) { res[i].iso = pick; res[i].guessed = true; anchor = pick; }
    }
    return res;
  };
  if (startYear) return walk(Number(startYear));
  // The start year: the sheet is not written ahead of time, so the latest year (this year, or up to three back) that puts at most two
  // dates after today (one in ten on a short tab, none below ten dates). A slip or two ("19 october" typed for "9 october") so stays a
  // slip, which the page points out as after today, instead of moving the whole column a year back. When every year puts more there,
  // the year with the fewest (the later one of two the same).
  const now = today || new Date().toISOString().slice(0, 10);
  const thisYear = Number(now.slice(0, 4));
  let best = null;
  for (let year = thisYear; year >= thisYear - 3; year--) {
    const res = walk(year);
    const dated = res.filter((r) => r.iso).length;
    const late = res.filter((r) => r.iso && r.iso > now).length;
    if (late <= Math.min(2, Math.floor(dated / 10))) return res;
    if (!best || late < best.late) best = { res, late };
  }
  return best.res;
}

/**
 * The places of a column's dates (in sheet order, null for no date) that are far from the rows around them: more than half a year
 * from the middle date of the twenty dated rows nearest to it (ten before and ten after; near the top or the bottom of the tab the
 * twenty nearest on one side). The sheet is written in time order, so such a date is a slip in the year (a run of "d m 24" among
 * 2026 rows). The import keeps it as read; the page points it out to check on the sheet.
 */
export function farFromNeighbours(isos, { around = 10, days = 183 } = {}) {
  const dated = isos.map((d, i) => ({ d, i })).filter((x) => x.d);
  const out = [];
  dated.forEach((x, k) => {
    const from = Math.max(0, Math.min(k - around, dated.length - 1 - 2 * around));
    const near = dated.slice(from, from + 2 * around + 1).filter((y) => y !== x).map((y) => y.d).sort();
    if (near.length >= 4 && Math.abs(toDay(x.d) - toDay(near[Math.floor(near.length / 2)])) > days) out.push(x.i);
  });
  return out;
}

// ------------------------------------------------------------------------------------------------ the tab
// Headings (letters and digits only, lower case) -> the field they hold.
const HEADINGS = {
  mr: ['mr', 'mrno', 'mrnumber', 'mrn'],
  contact: ['contact', 'contactno', 'contactnumber', 'phone', 'phoneno', 'mobile', 'mobileno', 'cell', 'number'],
  name: ['patientname', 'name', 'patient', 'patientsname'],
  impression: ['impressiondate', 'impression', 'dateofimpression', 'impdate'],
  model_check: ['modelcheckby', 'modelcheck', 'modelcheckedby', 'checkedby', 'modelchecker'],
  made_by: ['retainermadeby', 'madeby', 'maker', 'retainermaker'],
  retainer_date: ['retainerdate', 'dateofretainer', 'deliverydate', 'retainergiven'],
  status: ['status'],
  retainer_sheet: ['retainersheet', 'sheet'],
  payment: ['payments', 'payment', 'paymentstatus', 'paid'],
  notes: ['notes', 'note', 'remarks', 'remark', 'comments', 'comment'],
};
export const FIELD_LABELS = { mr: 'Mr#', contact: 'Contact', name: 'Patient name', impression: 'Impression date', model_check: 'Model check by', made_by: 'Retainer made by',
  retainer_date: 'Retainer date', status: 'Status', retainer_sheet: 'Retainer sheet', payment: 'Payments', notes: 'Notes' };

/**
 * { field: column index } for a header row. Columns are matched by heading; when there is no name heading and the sheet's own
 * headings start in column C with nothing known in A or B (the Karachi tab: A headed with a patient's first name, B "Column 2"),
 * A is the Mr# and B the patient name. A blank first heading in front of "Patient name" is the Mr# column too.
 */
export function detectRetainerColumns(header) {
  const cols = {};
  (header || []).forEach((cell, i) => {
    const k = optionKey(cell);
    for (const [field, names] of Object.entries(HEADINGS)) if (cols[field] === undefined && names.includes(k)) { cols[field] = i; break; }
  });
  if (cols.name === undefined) {
    const first = Math.min(...['impression', 'model_check', 'made_by', 'retainer_date'].map((f) => cols[f] ?? Infinity));
    const taken = Object.values(cols).some((i) => i < first);
    if (first === 2 && !taken) { cols.mr = 0; cols.name = 1; } else if (first === 1 && !taken) cols.name = 0;
  }
  if (cols.mr === undefined && cols.contact === undefined && cols.name === 1 && isBlank((header || [])[0])) cols.mr = 0;
  return cols;
}
/** The index of the header row: the first of the first 10 rows with a name heading and one more known heading. */
export function findRetainerHeader(rows2d) {
  for (let i = 0; i < Math.min(10, rows2d.length); i++) {
    const c = detectRetainerColumns(rows2d[i]);
    if (c.name !== undefined && (c.impression !== undefined || c.made_by !== undefined || c.model_check !== undefined)) return i;
  }
  return -1;
}

/**
 * One tab -> what the import sends, and what the page shows before it does.
 *   rows: [{ row, mr, name, contact, impression_date, impression_text, model_check, made_by, retainer_date, retainer_text, status,
 *            retainer_sheet, payment, notes }]   (row = the row number on the sheet)
 *   skipped: [{ row, reason }]   rows with something in them but no patient name (fully blank rows are passed over quietly)
 *   unreadable: [{ row, field, text }]   guessed: [{ row, field, text, iso }]   future: [{ row, field, iso }]
 *   far: [{ row, field, iso }]   dates far from the rows around them (farFromNeighbours; not the ones after today)
 *   statusNotes: [{ row, text }]   Status cells that were a note (no status; the text is in the notes)
 *   summary: { ready, from, to, perStatus, unknownStatuses, models: { name: rows }, makers: { name: rows }, mr: { given, linkable } }
 *   byPosition: true when the Mr# and name columns were read by position (no headings); missing: [...] when there is no header row.
 * statuses: the Status list ([{ label }]) the values are matched to; startYear, today: see resolveColumn.
 */
export function readRetainerTab(rows2d, { statuses = DEFAULT_RETAINER_STATUSES, startYear = null, today = null } = {}) {
  const empty = { rows: [], skipped: [], unreadable: [], guessed: [], future: [], far: [], statusNotes: [],
    summary: { ready: 0, from: null, to: null, perStatus: {}, unknownStatuses: {}, models: {}, makers: {}, mr: { given: 0, linkable: 0 } } };
  const h = findRetainerHeader(rows2d || []);
  if (h < 0) return { ...empty, missing: ['Patient name', 'Impression date'] };
  const cols = detectRetainerColumns(rows2d[h]);
  const byPosition = !HEADINGS.name.includes(optionKey(rows2d[h][cols.name]));
  const cell = (r, f) => (cols[f] === undefined ? '' : r[cols[f]]);
  const body = [];
  const skipped = [];
  for (let i = h + 1; i < rows2d.length; i++) {
    const r = rows2d[i] || [];
    if (r.every(isBlank)) continue;
    const name = text(cell(r, 'name'), 200);
    if (!name) { skipped.push({ row: i + 1, reason: 'No patient name' }); continue; }
    body.push({ row: i + 1, r, name });
  }
  const now = today || new Date().toISOString().slice(0, 10);
  const imp = resolveColumn(body.map((b) => parseDateCell(cell(b.r, 'impression'))), { startYear, today: now });
  const ret = resolveColumn(body.map((b) => parseDateCell(cell(b.r, 'retainer_date'))), { startYear, today: now, rowAnchors: imp.map((x) => x.iso) });
  const farImp = new Set(farFromNeighbours(imp.map((x) => x.iso)));
  const farRet = new Set(farFromNeighbours(ret.map((x) => x.iso)));
  const unreadable = [], guessed = [], future = [], far = [];
  const note = (row, field, d, isFar) => {
    if (d.text && !d.iso) unreadable.push({ row, field, text: d.text });
    if (d.guessed) guessed.push({ row, field, text: d.text, iso: d.iso });
    if (d.iso && d.iso > now) future.push({ row, field, iso: d.iso });
    else if (d.iso && isFar) far.push({ row, field, iso: d.iso });
  };
  const perStatus = {}, unknownStatuses = {}, models = {}, makers = {}, mr = { given: 0, linkable: 0 };
  const statusNotes = [];
  const rows = body.map((b, i) => {
    note(b.row, 'impression', imp[i], farImp.has(i));
    note(b.row, 'retainer_date', ret[i], farRet.has(i));
    const st = statusCell(cell(b.r, 'status'), statuses);
    const status = st.status;
    if (status) {
      perStatus[status] = (perStatus[status] || 0) + 1;
      if (!findOption(statuses, status)) unknownStatuses[status] = (unknownStatuses[status] || 0) + 1;
    }
    if (st.note) statusNotes.push({ row: b.row, text: st.note });
    const model = teamName(cell(b.r, 'model_check'));
    const maker = teamName(cell(b.r, 'made_by'));
    if (model) models[model] = (models[model] || 0) + 1;
    if (maker) makers[maker] = (makers[maker] || 0) + 1;
    const m = mrCell(cell(b.r, 'mr'));
    if (m.mr) { mr.given += 1; if (mrKey(m.mr)) mr.linkable += 1; }
    return {
      row: b.row, mr: m.mr, name: b.name, contact: contactCell(cell(b.r, 'contact')) || m.contact,
      impression_date: imp[i].iso, impression_text: imp[i].iso ? null : imp[i].text,
      model_check: model, made_by: maker,
      retainer_date: ret[i].iso, retainer_text: ret[i].iso ? null : ret[i].text,
      status,
      retainer_sheet: isBlank(cell(b.r, 'retainer_sheet')) ? null : canonicalOption(RETAINER_SHEET_OPTIONS, text(cell(b.r, 'retainer_sheet'), 60)),
      payment: paymentCell(cell(b.r, 'payment')),
      notes: [text(cell(b.r, 'notes'), 2000), st.note].filter(Boolean).join(' · ').slice(0, 2000) || null,
    };
  });
  // (the months on the tab leave out the dates pointed out as after today or far from the rows around them)
  const odd = new Set([...future, ...far].map((x) => `${x.row}|${x.iso}`));
  const dates = [];
  for (const r of rows) for (const d of [r.impression_date, r.retainer_date]) if (d && !odd.has(`${r.row}|${d}`)) dates.push(d);
  dates.sort();
  return {
    rows, skipped, unreadable, guessed, future, far, statusNotes, columns: cols, byPosition,
    summary: { ready: rows.length, from: dates[0] || null, to: dates[dates.length - 1] || null, perStatus, unknownStatuses, models, makers, mr },
  };
}

/**
 * The city a tab is for, so the Import page can choose it and stop when another city is chosen (the Lahore tab copied as Karachi
 * would put Lahore's patients on the Karachi tab, and Karachi's one copy would be used up):
 *   from the name: the city named in the file or tab name; Google names a downloaded tab "<sheet> - <tab>.csv", so a city in the part
 *     after the last " - " wins ("Retainer Record - Lahore.csv"); two cities named there, or none, say nothing;
 *   from the columns (when the name says nothing): the clinic's Karachi tab has the Mr# column and no contact column, its Lahore tab
 *     a "Contact #" column and no Mr#.
 * cities: [{ id, name }]. -> { cityId, city, from: 'name' | 'columns', why } or null
 */
export function tabCityHint({ name = '', columns = null } = {}, cities = []) {
  const words = (s) => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const named = (s) => cities.filter((c) => c?.name && words(s).includes(words(c.name)));
  if (name) {
    const base = String(name).replace(/\.(csv|xlsx?|tsv)$/i, '');
    const parts = base.split(/\s+-\s+/);
    for (const s of parts.length > 1 ? [parts[parts.length - 1], base] : [base]) {
      const hit = named(s);
      if (hit.length === 1) return { cityId: hit[0].id, city: hit[0].name, from: 'name', why: `its name says ${hit[0].name}` };
      if (hit.length > 1) return null;
    }
  }
  if (columns) {
    const byName = (n) => cities.find((c) => String(c?.name || '').toLowerCase() === n);
    const mr = columns.mr !== undefined, contact = columns.contact !== undefined;
    const c = mr && !contact ? byName('karachi') : contact && !mr ? byName('lahore') : null;
    if (c) return { cityId: c.id, city: c.name, from: 'columns', why: mr ? 'it has the Mr# column, like the Karachi tab' : 'it has the "Contact #" column and no Mr#, like the Lahore tab' };
  }
  return null;
}

/** A Payments cell: Paid / Pending / Free ("Payment Done" is Paid, "Dues" is Pending); anything else is kept as written. */
export function paymentCell(v) {
  const t = text(v, 60);
  if (!t) return null;
  const k = optionKey(t);
  if (['paymentdone', 'done', 'paymentreceived', 'received'].includes(k)) return 'Paid';
  if (['dues', 'due', 'unpaid', 'notpaid'].includes(k)) return 'Pending';
  if (['foc', 'freeofcost', 'nocharge'].includes(k)) return 'Free';
  return canonicalOption(PAYMENT_OPTIONS, t);
}
