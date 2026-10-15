// The old answers of the clinic's Google Form "Checkup Patient Form 2.0" (Aug to Oct 2026, before the form was on the website), read from
// the CSV that Google Sheets downloads from the "Form Responses 2" tab of "Checkup karwaliya" (File -> Download -> Comma-separated values),
// into the rows the database function import_checkup_form() takes (migration 20261011000300). Pure functions, no DOM, no network, so
// every rule can be tested in Node (tests/checkup-form.test.ts).
//
// The tab is one header row, then one row per answer:
//   Timestamp | Patient Full Name | Which Branch did you visit? | Mobile Number | Who did your Checkup? | Did Dr. Ali recommend your treatment?
//   | What was your checkup for? | Did you understand the pricing details? | Would you like to start the treatment?
//   | If yes then when? If no then why not? | REMINDERS
// The columns are FOUND by their headings (never by position). REMINDERS is the team's own column: their follow-up notes, not a question.
// The owner (12 Oct 2026): "yes please bring the old 470 entries too, and design the form submitted entries all in similar way too."
import { FOLLOW_UP_STATUSES, CHECKUP_FOR_CHOICES, cleanText, isEmptyCell, checkupPhone, splitChoices, joinChoices } from './checkups.js';
import { matchClinician } from './legacy.js';

export const FORM_SOURCE_TAB = 'Checkup Form 2.0';
// Rows per call of import_checkup_form (its limit). The preview is exact for a file of up to this many rows: each call of the preview is
// undone at its end, so two answers of one person on one day that fall into two different calls are counted as two new rows there.
export const FORM_IMPORT_BATCH = 500;

// The form's questions, as the import page names them (the database stores the answers, not the questions).
export const FORM_QUESTIONS = {
  branch: 'Which branch did you visit?',
  ali: 'Did Dr. Ali recommend your treatment?',
  pricing: 'Did you understand the pricing details?',
  wants: 'Would you like to start the treatment?',
  plan: 'If yes then when? If no then why not?',
};

// ------------------------------------------------------------------------------------------------ the header
const normHeading = (h) => String(h ?? '').replace(/^﻿/, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Heading (as normHeading writes it) -> field. The first pattern a heading fits wins, and a column is used once.
const HEADINGS = [
  ['timestamp', /^(timestamp|time stamp|submitted at)$/],
  ['name', /^(patient )?(full )?name$/],
  ['branch', /\bbranch\b/],
  ['phone', /\b(mobile|phone|contact)\b/],
  ['doctor', /\bwho did\b|\bdoctor\b/],
  ['ali', /\brecommend/],
  ['checkupFor', /\bcheck ?up for\b/],
  ['pricing', /\bpric(e|ing)\b/],
  ['wants', /\bstart\b.*\btreatment\b/],
  ['plan', /\bif yes\b|\bwhy not\b/],
  ['reminders', /^reminders?\b/],
];
export const REQUIRED_HEADINGS = { timestamp: 'Timestamp', name: 'Patient Full Name' };

/** A header row -> { field: columnIndex } for the headings it has. */
export function detectFormColumns(headers) {
  const H = (Array.isArray(headers) ? headers : []).map(normHeading);
  const out = {};
  const taken = new Set();
  for (const [field, re] of HEADINGS) {
    const i = H.findIndex((x, k) => !taken.has(k) && x !== '' && re.test(x));
    if (i >= 0) { out[field] = i; taken.add(i); }
  }
  return out;
}

/** The row index of the header among the first 10 rows (the one with a Timestamp and a name column); -1 when there is none. */
export function findFormHeader(rows2d) {
  const limit = Math.min(10, Array.isArray(rows2d) ? rows2d.length : 0);
  for (let i = 0; i < limit; i++) {
    const c = detectFormColumns(rows2d[i]);
    if (c.timestamp !== undefined && c.name !== undefined) return i;
  }
  return -1;
}

// ------------------------------------------------------------------------------------------------ one cell
const pad2 = (n) => String(n).padStart(2, '0');
const realDay = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31 && new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d;

/**
 * The Timestamp cell -> { date: 'YYYY-MM-DD', local: 'YYYY-MM-DD HH:MM:SS', iso: 'YYYY-MM-DDTHH:MM:SS+05:00' }, or null when it cannot be read.
 * Google writes M/D/YYYY H:MM:SS in Karachi time (the form's own time zone; Pakistan keeps +05:00 all year). Also read: the one answer
 * typed by hand as "8\27\2026     16.05.9" (backslashes, a run of spaces, dots in the time: 27 Aug 2026 16:05:09), no seconds, AM / PM,
 * YYYY-MM-DD HH:MM:SS, and an Excel date number (the tab downloaded as .xlsx).
 */
export function formTimestamp(v) {
  let y, mo, d, hh = 0, mi = 0, ss = 0;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 1 || v > 2958466) return null;
    const secs = Math.round(v * 86400);
    const t = new Date(Date.UTC(1899, 11, 30) + secs * 1000);
    [y, mo, d, hh, mi, ss] = [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds()];
  } else {
    if (isEmptyCell(v)) return null;
    const s = String(v).trim().replace(/\s+/g, ' ');
    let m;
    if ((m = /^(\d{1,2})[/\\.-](\d{1,2})[/\\.-](\d{4})(?: (\d{1,2})[:.](\d{1,2})(?:[:.](\d{1,2}))? ?([ap])?\.?m?\.?)?$/i.exec(s))) {
      [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (m[4] !== undefined) [hh, mi, ss] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
      if (m[7]) {                                     // 12-hour clock
        if (hh < 1 || hh > 12) return null;
        hh = (hh % 12) + (/p/i.test(m[7]) ? 12 : 0);
      }
    } else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(s))) {
      [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (m[4] !== undefined) [hh, mi, ss] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
    } else return null;
  }
  if (y < 2000 || y > 2100 || !realDay(y, mo, d) || hh > 23 || mi > 59 || ss > 59) return null;
  const date = `${y}-${pad2(mo)}-${pad2(d)}`;
  const time = `${pad2(hh)}:${pad2(mi)}:${pad2(ss)}`;
  return { date, local: `${date} ${time}`, iso: `${date}T${time}+05:00` };
}

/**
 * "Which Branch did you visit?" -> branch code, or null. The form's five choices ("RJ Mall - Karachi", "North Nazimabad - Karachi",
 * "DHA - Karachi", "Lahore - Gulberg", "Islamabad - DHA Phase II") and the spellings of older versions of the form ("DHA Phase 6 - Karachi",
 * "RJ MALL karachi"). Islamabad is looked at before DHA: its branch is in DHA Phase II.
 */
export function formBranch(text) {
  const t = String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!t) return null;
  if (/\b(islamabad|isb)\b/.test(t)) return 'ISB';
  if (/\b(lahore|lhr|gulberg)\b/.test(t)) return 'LHR';
  if (/\bnazimabad\b|^nn\b/.test(t)) return 'NN';
  if (/\brj ?mall\b|\bgulshan\b/.test(t)) return 'GUL';
  if (/\bdha\b/.test(t)) return 'DHA';
  return null;
}

const word = (v) => String(v ?? '').trim().toLowerCase().replace(/[\s.!]+$/, '').replace(/\s+/g, ' ');

/** "Yes" / "No" -> { value: true | false | null, bad }. bad: something else was written (an answer in the wrong column). */
export function formYesNo(v) {
  const w = word(v);
  if (w === '') return { value: null, bad: false };
  if (w === 'yes') return { value: true, bad: false };
  if (w === 'no') return { value: false, bad: false };
  return { value: null, bad: true };
}

/** "Did you understand the pricing details?" -> { value: 'yes' | 'no' | 'needs_explanation' | null, bad }. */
export function formPricing(v) {
  const w = word(v);
  if (w === '') return { value: null, bad: false };
  if (w === 'yes' || w === 'no') return { value: w, bad: false };
  if (/^needs? (more )?clear(er)? explanation$/.test(w)) return { value: 'needs_explanation', bad: false };
  return { value: null, bad: true };
}

const statusKey = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/**
 * The REMINDERS cell -> { status, note, kind }: the follow-up status it means (null: none), the text to keep in the notes
 * ("Reminder: ...", null when the status says it all) and the group it falls in, for the preview.
 *   a follow-up status itself ("Interested")                               -> that status
 *   not on WhatsApp (any spelling), wrong / incorrect number, no contact   -> No Response
 *   treatment done / already done / completed                              -> Completed
 *   treatment started / start                                              -> Started
 *   done                                                                   -> Follow-up Sent (the reminder was sent)
 *   anything else (a name, ...)                                            -> no status, kept in the notes
 * The original word stays in the notes, except a plain "done" or a status written as it is.
 */
export function reminderFollowUp(raw) {
  const text = cleanText(isEmptyCell(raw) ? null : String(raw).replace(/\s+/g, ' '), 300).value;
  if (text === null) return { status: null, note: null, kind: 'empty' };
  const t = statusKey(text);
  const note = `Reminder: ${text}`;
  const exact = FOLLOW_UP_STATUSES.find((s) => statusKey(s) === t);
  if (exact) return { status: exact, note: null, kind: exact };
  if (/(wh?a?t+s*|wts) ?a*pp?\b/.test(t) || /\b(wrong|incorrect|invalid)\b/.test(t) || /\bno ?con\w*/.test(t) || /\bnot (reachable|responding|answering)\b/.test(t)) {
    return { status: 'No Response', note, kind: 'No Response' };
  }
  if (/\b(treatment|tx|already)( is)? (done|completed?)\b/.test(t) || /\bcompleted?\b/.test(t)) return { status: 'Completed', note, kind: 'Completed' };
  if (/\bnot start/.test(t)) return { status: null, note, kind: 'other' };
  if (/\bstart(ed)?\b/.test(t)) return { status: 'Started', note, kind: 'Started' };
  if (t === 'done') return { status: 'Follow-up Sent', note: null, kind: 'Follow-up Sent' };
  if (/\bdone\b/.test(t)) return { status: 'Follow-up Sent', note, kind: 'Follow-up Sent' };
  return { status: null, note, kind: 'other' };
}

const choiceKey = (s) => String(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z]+/g, '');
// (the Google Form's own spelling of a choice, where it is not the website's: "Wisdon tooth / Extraction")
const CHOICE_BY_KEY = new Map([...CHECKUP_FOR_CHOICES.map((c) => [choiceKey(c), c]), [choiceKey('Wisdon tooth / Extraction'), 'Wisdom tooth / extraction']]);
/**
 * "What was your checkup for?" -> the text to store (at most 300 characters). The form's choices are written the website's way
 * ("General Checkup" -> "General checkup", "Crown/Bridge" -> "Crown / bridge", "Wisdon tooth / Extraction" -> "Wisdom tooth / extraction"),
 * also inside a list of several ("Braces, Scaling and Polishing"); an "Other" answer stays as written.
 */
export function formCheckupFor(raw) {
  const text = cleanText(isEmptyCell(raw) ? null : String(raw).replace(/\s+/g, ' '), 300);
  if (text.value === null) return text;
  const parts = text.value.split(',').map((p) => p.trim());
  const mapped = parts.map((p) => CHOICE_BY_KEY.get(choiceKey(p)) || null);
  if (!mapped.some(Boolean)) return text;
  const joined = cleanText(parts.map((p, i) => mapped[i] || p).filter(Boolean).join(', '), 300);
  return { value: joined.value, cut: text.cut || joined.cut };
}

/**
 * The website's doctors (state.ref.clinicians) -> "Who did your Checkup?" text -> { value, cut, listed, other }: the doctors on the list written
 * as the website writes them, or the text as written. The form's question is tick boxes, so an answer can name several ("Dr A, Dr B"; typed
 * under Other also "Dr A / Dr B"): each one on the list is written the website's way, in the list's order, then the rest as written, joined
 * with ", " (what the website's own form stores). listed: every name is on the list; other: the part that is not (null when none).
 */
export function doctorNamer(clinicians) {
  const list = (clinicians || []).filter((c) => c && c.is_doctor !== false && c.active !== false)
    .map((c) => ({ displayName: c.display_name, aliases: c.aliases || [] }));
  const names = list.map((c) => c.displayName);
  const match = (part) => matchClinician(part, list)?.displayName ?? null;
  return (raw) => {
    const text = cleanText(isEmptyCell(raw) ? null : String(raw).replace(/\s+/g, ' '), 300);
    if (text.value === null) return { value: null, cut: false, listed: false, other: null };
    const parts = list.length ? splitChoices(text.value, names, { match, split: /,|\/|&/ }) : { picked: [], other: text.value };
    if (!parts.picked.length) return { ...text, listed: false, other: text.value };
    const joined = cleanText(joinChoices(parts.picked, parts.other), 300);
    return { value: joined.value, cut: text.cut || joined.cut, listed: !parts.other, other: parts.other || null };
  };
}

/** A cell that is a phone number and nothing else (0300-1234567, +92 300 1234567): no letters, at least 10 digits, so a date (15-10-2026) is not one. */
const isPhoneOnly = (t) => /^[+\d\s()-]+$/.test(t) && (checkupPhone(t)?.length ?? 0) >= 10;

/** A phone as written; a 10-digit mobile that lost its leading 0 in the sheet (3001234567) gets it back. */
function formPhone(raw) {
  const p = cleanText(raw, 40);
  if (p.value !== null && /^3\d{9}$/.test(p.value)) return { value: '0' + p.value, cut: false };
  return p;
}

const bump = (map, key) => {
  const had = Object.prototype.hasOwnProperty.call(map, key);
  Object.defineProperty(map, key, { value: (had ? map[key] : 0) + 1, enumerable: true, writable: true, configurable: true });   // safe for any text, even "__proto__"
};
const quoted = (s) => `"${String(s).replace(/\s+/g, ' ').trim().slice(0, 200)}"`;

// ------------------------------------------------------------------------------------------------ the whole tab
/**
 * Reads the rows of the tab into the rows import_checkup_form() takes.
 * -> { headerAt, columns, missing, rows, skipped, summary }
 *   rows: [{ row, submitted_at, name, phone, branch, doctors, checkup_for, ali_recommended, pricing_understood, wants_treatment,
 *            treatment_plan, follow_up, notes }]   (row = the row number in the sheet: the header is row 1)
 *   skipped: [{ row, reason }]
 *   summary: { total, ready, skipped, from, to, badDate, perBranch, perBranchText, unknownBranches, noBranch, wrongColumn: [{ row, questions }],
 *              perReminder, doctorsNotListed, cut }
 * clinicians: the website's doctors, so "Who did your Checkup?" is written as the website's own form writes it.
 */
export function readFormResponses(rows2d, { clinicians = [] } = {}) {
  const grid = Array.isArray(rows2d) ? rows2d : [];
  const headerAt = findFormHeader(grid);
  const summary = { total: 0, ready: 0, skipped: 0, from: null, to: null, badDate: 0, perBranch: {}, perBranchText: {}, unknownBranches: {}, noBranch: 0,
    wrongColumn: [], perReminder: {}, doctorsNotListed: {}, cut: 0 };
  if (headerAt < 0) return { headerAt, columns: {}, missing: Object.values(REQUIRED_HEADINGS), rows: [], skipped: [], summary };
  const columns = detectFormColumns(grid[headerAt]);
  const missing = Object.entries(REQUIRED_HEADINGS).filter(([field]) => columns[field] === undefined).map(([, label]) => label);
  const doctorOf = doctorNamer(clinicians);
  const rows = [];
  const skipped = [];
  const firstOfKey = new Map();
  const skip = (row, reason) => { skipped.push({ row, reason }); summary.total++; summary.skipped++; };

  for (let i = headerAt + 1; i < grid.length; i++) {
    const cells = Array.isArray(grid[i]) ? grid[i] : [];
    if (cells.every(isEmptyCell)) continue;
    const row = i + 1;
    const at = (field) => (columns[field] === undefined ? undefined : cells[columns[field]]);
    const name = cleanText(isEmptyCell(at('name')) ? null : String(at('name')).replace(/\s+/g, ' '), 200);
    if (name.value === null) { skip(row, 'No patient name'); continue; }
    const ts = formTimestamp(at('timestamp'));
    if (!ts) { summary.badDate++; skip(row, 'The date could not be read'); continue; }
    const phone = formPhone(at('phone'));
    const key = `${ts.local}|${checkupPhone(phone.value) ?? ''}|${name.value.toLowerCase()}`;
    if (firstOfKey.has(key)) { skip(row, `Same answer twice in the file (row ${firstOfKey.get(key)})`); continue; }
    firstOfKey.set(key, row);

    const notes = [];
    // the three questions answered with a choice: anything else written there is an answer in the wrong column, kept in the notes
    const ali = formYesNo(at('ali'));
    const pricing = formPricing(at('pricing'));
    const wants = formYesNo(at('wants'));
    // "If yes then when?" is free text, so it is in the wrong column only when it is clearly something else: a phone number alone, or the
    // row is shifted (a branch where "Would you like to start the treatment?" is: in the owner's file the next columns then hold a second
    // person's name, branch and phone)
    const plan = cleanText(isEmptyCell(at('plan')) ? null : String(at('plan')).replace(/\s+/g, ' '), 500);
    const planBad = plan.value !== null && (isPhoneOnly(plan.value) || (wants.bad && formBranch(at('wants')) !== null));
    const wrong = [['ali', ali], ['pricing', pricing], ['wants', wants], ['plan', { bad: planBad }]].filter(([, a]) => a.bad).map(([q]) => q);
    for (const q of wrong) notes.push(`Form answer in the wrong place: "${FORM_QUESTIONS[q]}" was ${quoted(at(q))}`);
    if (wrong.length) summary.wrongColumn.push({ row, questions: wrong.map((q) => FORM_QUESTIONS[q]) });

    const branchText = isEmptyCell(at('branch')) ? null : String(at('branch')).replace(/\s+/g, ' ').trim();
    const branch = formBranch(branchText);
    if (branchText !== null && branch === null) {
      bump(summary.unknownBranches, branchText);
      notes.push(`Branch on the form: ${quoted(branchText)}`);
    }
    if (branchText === null) summary.noBranch++;
    bump(summary.perBranch, branch || 'none');
    bump(summary.perBranchText, branchText === null ? '(empty)' : branchText);

    const reminder = reminderFollowUp(at('reminders'));
    if (reminder.note) notes.push(reminder.note);
    bump(summary.perReminder, reminder.kind);

    const doctors = doctorOf(at('doctor'));
    if (doctors.value !== null && !doctors.listed) bump(summary.doctorsNotListed, doctors.other);
    const checkupFor = formCheckupFor(at('checkupFor'));
    const note = cleanText(notes.length ? notes.join('; ') : null, 2000);

    rows.push({ row, submitted_at: ts.iso, name: name.value, phone: phone.value, branch, doctors: doctors.value, checkup_for: checkupFor.value,
      ali_recommended: ali.value, pricing_understood: pricing.value, wants_treatment: wants.value, treatment_plan: planBad ? null : plan.value,
      follow_up: reminder.status, notes: note.value });
    summary.total++;
    summary.ready++;
    summary.cut += [name, phone, doctors, checkupFor, planBad ? { cut: false } : plan, note].filter((c) => c.cut).length;
    if (summary.from === null || ts.date < summary.from) summary.from = ts.date;
    if (summary.to === null || ts.date > summary.to) summary.to = ts.date;
  }
  return { headerAt, columns, missing, rows, skipped, summary };
}
