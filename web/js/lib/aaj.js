// Reading the Aaj ki List Google Sheet (downloaded as one .xlsx with a tab per
// branch) and turning every day's rows into visits for the website's
// import_aaj_sheet() function. Pure functions, no DOM, so the rules can be
// tested in Node (tests/aaj.test.mjs).
//
// What a tab can look like (all handled):
//   - a header row ("Tt Mr #", "Tt Patient Name", "Monthly", "Tt Treatment", "Token No", "Waiting",
//     "Group", "Doctor's Name", "Tt Treatment Details", "P.P", "Healthwire", "Tt Contact No", "Reminder Status"),
//     then patient rows; a day's rows are introduced by a row holding only the date,
//   - or a "Date" column on every row,
//   - or no dates at all (today's list): the date is given on the import page.
// Header names vary between tabs ("Waiting" vs "Status", "Month" vs "Months" vs "Monthly", "Column 13").
//
// readRow() and the small readers it uses (firstPhone, tokenOf, groupOf, liveStatus, mrOf, givenName) are ALSO
// copied into the Google Apps Script apps-script/AajSync.js (the two-way sync), which cannot import this file.
// tests/aaj-sync-script.test.mjs reads every fixture row with both copies and fails on any difference: change both together.
import { cleanLegacyName, splitPeople, matchClinician } from './legacy.js';
import { parseMonthCell } from './protocol.js';
import { phoneOf, treatmentFor, chunk } from './healthwire.js';

export const FIELD_LABELS = {
  date: 'Date', mr: 'Mr#', name: 'Patient name', month: 'Braces month', treatment: 'Treatment', token: 'Token', status: 'Status',
  group: 'Group', doctors: "Doctor's name", details: 'Treatment details', pp: 'P.P (ignored)', healthwire: 'Healthwire (ignored)',
  phone: 'Contact no', reminder: 'Reminder status', ignore: '— ignore —',
};
const ALIASES = {
  date: ['date', 'day', 'visit date'],
  mr: ['mr #', 'mr#', 'mr', 'mr no', 'mr no.', 'mr number', 'mrn', 'mr num'],
  name: ['patient name', 'name', 'patient', 'patients name', "patient's name"],
  month: ['month', 'months', 'monthly', 'braces month', 'month no'],
  treatment: ['treatment', 'treatments', 'procedure', 'work'],
  token: ['token no', 'token #', 'token', 'token number', 'token no.'],
  status: ['waiting', 'status', 'waiting / status', 'waiting status'],
  group: ['group', 'column 13', 'doctor group', 'grp'],
  doctors: ["doctor's name", 'doctors name', 'doctor name', 'doctors', 'doctor', 'dr', 'dr name', 'dr. name', 'doctor / assistant'],
  details: ['treatment details', 'details', 'treatment detail', 'work done', 'detail'],
  pp: ['p.p', 'pp', 'p p', 'pending payment', 'p.p.', 'pending'],
  healthwire: ['healthwire', 'health wire', 'hw'],
  phone: ['contact no', 'contact', 'phone', 'mobile', 'contact no.', 'contact number', 'phone no', 'cell', 'number'],
  reminder: ['reminder status', 'reminder', 'reminders', 'follow up', 'followup'],
};
const norm = (h) => String(h ?? '').toLowerCase().replace(/^tt\s+/, '').replace(/[_\n]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Header cells -> { field: columnIndex }. Exact alias match first, then "starts with". */
export function detectColumns(headers) {
  const H = headers.map(norm);
  const out = {};
  const taken = new Set();
  for (const [field, names] of Object.entries(ALIASES)) {
    let i = H.findIndex((x, k) => !taken.has(k) && names.includes(x));
    if (i < 0) i = H.findIndex((x, k) => !taken.has(k) && x && names.some((n) => x.startsWith(n + ' ') || x.startsWith(n + '/')));
    if (i >= 0) { out[field] = i; taken.add(i); }
  }
  return out;
}

export function isHeaderRow(cells) {
  const m = detectColumns(cells || []);
  return m.name !== undefined && ['treatment', 'doctors', 'token', 'mr', 'month'].filter((f) => m[f] !== undefined).length >= 2;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y, m, d) => {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  if (y < 100) y += 2000;
  if (y < 2015 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
};

/** A cell that holds a date (Excel serial, Date, or text in any usual Pakistani format) -> "yyyy-mm-dd", else null. */
export function cellDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : iso(v.getFullYear(), v.getMonth() + 1, v.getDate());
  if (typeof v === 'number') {
    if (v < 42000 || v > 80000) return null;                   // serials for 2015–2119 only; tokens and Healthwire Mr# are far smaller; the website's Mr# (50000 up) are handled in readTab
    return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10);
  }
  let s = String(v).trim().toLowerCase().replace(/^(date|dated|day)\s*[:\-]?\s*/, '')
    .replace(/\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day|nesday|rsday|urday|sday)?\b,?/g, ' ')
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (m) return iso(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[\s\-\/,.]*([a-z]{3,9})[\s\-\/,.]*(\d{2,4})$/);
  if (m && MONTHS[m[2].slice(0, 3)] !== undefined && (m[2].length <= 4 || MONTHS[m[2].slice(0, 3)])) return iso(+m[3], MONTHS[m[2].slice(0, 3)], +m[1]);
  m = s.match(/^([a-z]{3,9})[\s\-\/,.]*(\d{1,2})[\s\-\/,.]*(\d{2,4})$/);
  if (m && MONTHS[m[1].slice(0, 3)] !== undefined) return iso(+m[3], MONTHS[m[1].slice(0, 3)], +m[2]);
  return null;
}

/** Tab (or file) name -> branch code, when the name says which branch it is. */
export function tabBranch(name) {
  const n = String(name || '').toLowerCase();
  if (/gulshan|rj\s*mall|\brj\b/.test(n)) return 'GUL';
  if (/nazimabad|\bn\.?\s*n\b|\bnn\b/.test(n)) return 'NN';
  if (/\bdha\b|defence/.test(n)) return 'DHA';
  if (/islamabad|\bisb\b|\bisl\b/.test(n)) return 'ISB';
  if (/lahore|\blhr\b|gulberg|^g\b|^g\.\.\./.test(n)) return 'LHR';
  return null;
}

const STATUS = (raw) => {
  const s = String(raw || '').toLowerCase();
  if (/cancel/.test(s)) return 'cancelled';
  if (/no\s*show|not\s*came|didn|absent|left|went\s*back|not\s*come/.test(s)) return 'no_show';
  return 'completed';
};
const text = (c) => (c === null || c === undefined ? '' : (c instanceof Date ? '' : String(c).trim()));

/** A Contact cell with two numbers ("0300 1111111 / 0321 2222222") -> the first number (the cell used to be glued into one 22-digit number). */
export function firstPhone(cell) {
  for (const part of String(cell ?? '').split(/[,;\/]|\s{2,}|\bor\b/i)) {
    const t = part.trim();
    if (t) return phoneOf(t);
  }
  return null;
}

/** Token cell: only a whole number 1..999 is a token ("Kit 80k", "1 pfm", "4 Zirconia", "Dr Verda" are not: they were read as 80, 1, 4). */
export function tokenOf(t) {
  const m = String(t ?? '').match(/^\s*(\d{1,3})(?:\.0+)?\s*$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 999 ? n : null;
}

/** "Group 3" -> '3' (a string); "Group 4" -> null; "Group 1, Group 2" -> '1'. */
export function groupOf(t) {
  const m = String(t ?? '').match(/(?:^|[^0-9])([1-3])(?![0-9])/);
  return m ? m[1] : null;
}

/** The live list's status words (the inverse of what the website writes). Empty or unknown -> null: the website's status is left alone. */
export function liveStatus(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/cancel/.test(s)) return 'cancelled';
  if (/no\s*-?\s*show|not\s*came|not\s*come|didn|absent|\bleft\b|went\s*back/.test(s)) return 'no_show';
  if (/complet|\bdone\b|finish/.test(s)) return 'completed';
  if (/treat|chair|progress|start/.test(s)) return 'in_treatment';
  if (/wait|arriv|present|\bcame\b|\bhere\b/.test(s)) return 'waiting';
  if (/sched|appoint|book|coming|later/.test(s)) return 'scheduled';
  return null;
}

/** Mr# cell -> { mr, isNew }. "NEW" asks for a new patient; "98 51" or "abc" is not a Mr# (mr null, isNew false). A stray dot or space after it ("8602.") is ignored. */
export function mrOf(t) {
  const s = String(t ?? '').trim().replace(/\.0$/, '').replace(/[.\s]+$/, '');
  if (/^new$/i.test(s)) return { mr: null, isNew: true };
  if (/^[\w-]+$/.test(s) && /\d/.test(s)) return { mr: s, isNew: false };
  return { mr: null, isNew: false };
}

const NAME_STOP = new Set('m mr mrs ms miss dr md muhammad mohammad muhammed mohammed mohd syed syeda sayed hafiz haji baby master kid'.split(' '));
/** First real name: "M Umer" and "Muhammad Umer" both give "umer" (private.aaj_given_name in the database). */
export function givenName(t) {
  const tokens = String(t ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const list = tokens ? tokens.split(' ') : [];
  let i = 0;
  while (i < list.length && NAME_STOP.has(list[i])) i++;
  if (i < list.length) return list[i];
  return list.length ? list[list.length - 1] : '';
}

/** One row of cells + the detected columns -> what the row says. The live sync (apps-script/AajSync.js) has a copy of this function. */
export function readRow(r, cols) {
  const get = (f) => (cols[f] === undefined ? '' : text(r[cols[f]]));
  const rawName = get('name');
  const cl = cleanLegacyName(rawName);
  const mr = mrOf(get('mr'));
  const pm = parseMonthCell(get('month'));
  return {
    mr: mr.mr, isNew: mr.isNew, name: cl.name, legacyName: rawName.trim(), suffixBranch: cl.branch,
    phone: firstPhone(get('phone')), month: pm.month && pm.month <= 60 ? pm.month : null, photoMarked: pm.photoMarked,
    treatment: get('treatment') || null, token: tokenOf(get('token')), status: STATUS(get('status')),
    liveStatus: liveStatus(get('status')), group: groupOf(get('group')), people: splitPeople(get('doctors')),
    details: get('details') || null, reminder: get('reminder') || null, pp: get('pp') || null, healthwire: get('healthwire') || null,
  };
}
const nonEmpty = (row) => (row || []).filter((c) => text(c) !== '' || c instanceof Date || typeof c === 'number');

/**
 * One tab (rows of cells) -> its days and patient rows.
 * opts.columns overrides the detected mapping; opts.fixedDate is used when the tab carries no dates.
 */
export function readTab(rows, opts = {}) {
  const out = { columns: opts.columns || null, headerAt: -1, rows: [], dateMode: 'none', days: new Set(), issues: [], headers: [] };
  let cols = opts.columns || null;
  let currentDate = null;
  const seenDates = new Set();
  rows.forEach((raw, idx) => {
    const r = raw || [];
    const cells = nonEmpty(r);
    if (!cells.length) return;
    if (isHeaderRow(r)) {
      if (!opts.columns) cols = detectColumns(r);
      if (out.headerAt < 0) { out.headerAt = idx; out.headers = r.map((c) => text(c)); out.columns = cols; }
      return;
    }
    // A day row: only a date on it (and maybe a word or two), no patient name. A number of 50000 or more in the Mr# column is a
    // Mr#, not a date: the website's Mr# start at 50000, which is also an Excel date serial (24 Nov 2036), and a row with a Mr#
    // typed but no name yet must not become a day row (every row after it would be dated 2036 and skipped as "future").
    // Below 50000 it stays a date (real serials: 2015 to 2036), whatever else is on the row.
    if (cells.length <= 3) {
      const dateOf = (c, i) => (typeof c === 'number' && cols && i === cols.mr && c >= 50000 ? null : cellDate(c));
      const d = r.map(dateOf).find(Boolean);
      const nameCell = cols && cols.name !== undefined ? text(r[cols.name]) : '';
      if (d && (!nameCell || cellDate(r[cols.name]) === d)) { currentDate = d; out.dateMode = out.dateMode === 'column' ? 'column' : 'rows'; return; }
    }
    if (!cols) return;                                             // rows before the first header
    const get = (f) => (cols[f] === undefined ? '' : text(r[cols[f]]));
    const rawName = get('name');
    if (!rawName || /^(total|count|patients?)\b/i.test(rawName) || cellDate(r[cols.name]) || isHeaderRow(r)) return;
    let date = currentDate;
    if (cols.date !== undefined) { const d = cellDate(r[cols.date]); if (d) { date = d; out.dateMode = 'column'; } }
    if (!date && opts.fixedDate) { date = opts.fixedDate; if (out.dateMode === 'none') out.dateMode = 'fixed'; }
    out.rows.push({ line: idx + 1, date, ...readRow(r, cols) });
    if (date) { out.days.add(date); seenDates.add(date); }
  });
  if (out.headerAt < 0) out.issues.push('No header row found (a row with "Patient Name" and "Treatment" or "Doctor\'s Name").');
  else if (out.rows.length && out.dateMode === 'none') out.issues.push('No dates found on this tab: the rows will be imported for the date you choose below.');
  const undated = out.rows.filter((r) => !r.date).length;
  if (undated && out.dateMode !== 'none') out.issues.push(`${undated} rows come before the first date on the tab and will be skipped.`);
  out.days = [...out.days].sort();
  return out;
}

/** Live clinicians -> a matcher: raw name -> { id, isDoctor } or null. Names are matched with their aliases from Clinic setup. */
export function clinicianMatcher(clinicians) {
  const list = clinicians.map((c) => ({ displayName: c.display_name, aliases: c.aliases || [], id: c.id, isDoctor: c.is_doctor !== false }));
  return (raw) => { const c = matchClinician(raw, list); return c ? { id: c.id, isDoctor: c.isDoctor } : null; };
}

/**
 * Tabs [{ name, branchId, read }] -> rows for import_aaj_sheet() plus a summary.
 * Rows dated today or later are left to the live sheet and counted in summary.future.
 */
export function buildImport(tabs, clinicians, treatments, today) {
  const match = clinicianMatcher(clinicians);
  const tid = (label) => {
    if (!label) return null;
    const t = treatments.find((x) => x.name.toLowerCase() === label.toLowerCase());
    return t ? t.id : treatmentFor(label)[0];
  };
  const rows = [];
  const unmatchedPeople = {};
  const summary = { rows: 0, future: 0, undated: 0, days: new Set(), from: null, to: null, noId: 0, withMr: 0, withPhone: 0, people: 0, unmatchedPeople };
  for (const t of tabs) {
    if (!t.branchId) continue;
    const usedTokens = new Set();
    for (const r of t.read.rows) {
      if (!r.date) { summary.undated++; continue; }
      if (today && r.date >= today) { summary.future++; continue; }
      const doctors = [], assistants = [], unmatched = [];
      for (const raw of r.people) {
        const m = match(raw);
        summary.people++;
        if (!m) { unmatched.push(raw); unmatchedPeople[raw] = (unmatchedPeople[raw] || 0) + 1; }
        else (m.isDoctor ? doctors : assistants).push(m.id);
      }
      const tokenKey = `${r.date}|${r.token}`;
      const token = r.token && !usedTokens.has(tokenKey) ? r.token : null;
      if (token) usedTokens.add(tokenKey);
      rows.push([r.date, t.branchId, r.mr, r.name, r.legacyName !== r.name ? r.legacyName : null, r.phone, r.month, r.treatment, token, r.status,
        r.group ? Number(r.group) : null, doctors, assistants, unmatched, r.details, r.reminder, t.name, r.photoMarked, tid(r.treatment)]);
      summary.rows++;
      summary.days.add(r.date);
      if (!r.mr && !r.phone) summary.noId++;
      if (r.mr) summary.withMr++;
      if (r.phone) summary.withPhone++;
      if (!summary.from || r.date < summary.from) summary.from = r.date;
      if (!summary.to || r.date > summary.to) summary.to = r.date;
    }
  }
  summary.days = summary.days.size;
  // One patient's rows together (then by date), so a patient's braces history lands in one batch.
  const key = (r) => `${r[2] || ''}|${r[5] || ''}|${String(r[3]).toLowerCase()}`;
  rows.sort((a, b) => key(a).localeCompare(key(b)) || a[0].localeCompare(b[0]) || a[16].localeCompare(b[16]));
  return { rows, summary };
}

export { chunk };
