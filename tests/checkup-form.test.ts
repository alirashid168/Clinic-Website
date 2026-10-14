// The reader of the Google Form "Checkup Patient Form 2.0" answers (web/js/lib/checkup-form.js): the CSV of the "Form Responses 2" tab
// into the rows import_checkup_form() takes. Every row below is made up (names "Sample ...", phones 0300-555xxxx, doctors "(sample)");
// nothing here comes from the clinic's real answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORM_SOURCE_TAB, FORM_IMPORT_BATCH, FORM_QUESTIONS, detectFormColumns, findFormHeader, formTimestamp, formBranch, formYesNo, formPricing,
  reminderFollowUp, formCheckupFor, doctorNamer, readFormResponses,
} from '../web/js/lib/checkup-form.js';
import { CHECKUP_FOR_CHOICES, FOLLOW_UP_STATUSES } from '../web/js/lib/checkups.js';
import { parseCSV } from '../web/js/lib/healthwire.js';

// The headings of the tab, as Google writes them.
const HEADER = ['Timestamp', 'Patient Full Name', 'Which Branch did you visit?', 'Mobile Number', 'Who did your Checkup?', 'Did Dr. Ali recommend your treatment?',
  'What was your checkup for?', 'Did you understand the pricing details?', 'Would you like to start the treatment?', 'If yes then when? If no then why not?', 'REMINDERS'];
// Made-up doctors in the shape of the website's clinician list (state.ref.clinicians).
const CLINICIANS = [
  { id: 'c1', display_name: 'Dr. Sample Hina (sample)', aliases: ['Dr Hina S'], is_doctor: true, active: true },
  { id: 'c2', display_name: 'Dr. Sample Rabia (sample)', aliases: [], is_doctor: true, active: true },
  { id: 'c3', display_name: 'Assistant Sample Bilal (sample)', aliases: [], is_doctor: false, active: true },
  { id: 'c4', display_name: 'Dr. Sample Gone (sample)', aliases: [], is_doctor: true, active: false },
];

test('constants: the source tab, the batch of the database function, the questions named on the import page', () => {
  assert.equal(FORM_SOURCE_TAB, 'Checkup Form 2.0');
  assert.equal(FORM_IMPORT_BATCH, 500, 'import_checkup_form takes at most 500 rows a call');
  assert.deepEqual(Object.keys(FORM_QUESTIONS), ['branch', 'ali', 'pricing', 'wants']);
});

test('headings: every column is found by its heading, in any order, with a byte-order mark, extra columns, or the header lower down', () => {
  const cols = detectFormColumns(HEADER);
  assert.deepEqual(cols, { timestamp: 0, name: 1, branch: 2, phone: 3, doctor: 4, ali: 5, checkupFor: 6, pricing: 7, wants: 8, plan: 9, reminders: 10 });
  const shuffled = ['REMINDERS', 'Extra column', ...HEADER.slice(0, 10).reverse()];
  shuffled[11] = '﻿' + shuffled[11];   // "Timestamp" with the mark Excel puts at the start of a file
  const c2 = detectFormColumns(shuffled);
  assert.deepEqual([c2.reminders, c2.timestamp, c2.name, c2.plan, c2.wants, c2.pricing, c2.ali, c2.doctor, c2.checkupFor, c2.branch, c2.phone], [0, 11, 10, 2, 3, 4, 6, 7, 5, 9, 8]);
  assert.equal(findFormHeader([HEADER]), 0);
  assert.equal(findFormHeader([['Checkup answers (sample)'], [], HEADER]), 2);
  assert.equal(findFormHeader([['Month', 'Patient Name', 'Phone']]), -1, 'the old checkup list is not the form');
  assert.equal(findFormHeader([]), -1);
  assert.deepEqual(detectFormColumns(null), {});
});

test('timestamps: M/D/YYYY H:MM:SS in Karachi time, the hand-typed "9\\1\\2026     14.21.1", AM / PM, no seconds, ISO and Excel numbers', () => {
  assert.deepEqual(formTimestamp('8/12/2026 19:25:03'), { date: '2026-08-12', local: '2026-08-12 19:25:03', iso: '2026-08-12T19:25:03+05:00' });
  assert.deepEqual(formTimestamp('10/11/2026 18:51:00'), { date: '2026-10-11', local: '2026-10-11 18:51:00', iso: '2026-10-11T18:51:00+05:00' }, 'month first, as Google writes it');
  assert.deepEqual(formTimestamp('9\\1\\2026     14.21.1'), { date: '2026-09-01', local: '2026-09-01 14:21:01', iso: '2026-09-01T14:21:01+05:00' }, 'backslashes, spaces, dots: 1 Sep 2026');
  assert.equal(formTimestamp(' 9/1/2026 9:05 ')?.local, '2026-09-01 09:05:00', 'no seconds');
  assert.equal(formTimestamp('9/1/2026 6:51:00 PM')?.local, '2026-09-01 18:51:00');
  assert.equal(formTimestamp('9/1/2026 12:10:00 am')?.local, '2026-09-01 00:10:00');
  assert.equal(formTimestamp('9/1/2026')?.local, '2026-09-01 00:00:00', 'a date alone');
  assert.equal(formTimestamp('2026-08-12 19:25:03')?.iso, '2026-08-12T19:25:03+05:00');
  assert.equal(formTimestamp('2026-08-12T07:05')?.local, '2026-08-12 07:05:00');
  // 46246 is 12 Aug 2026 in Excel; .5 is noon
  assert.equal(formTimestamp(46246.5)?.local, '2026-08-12 12:00:00', 'an Excel date number (the tab downloaded as .xlsx)');
  for (const bad of ['', '   ', null, undefined, 'soon', '13/1/2026 10:00:00', '2/30/2026 10:00:00', '8/12/2026 24:00:00', '8/12/2026 10:60:00', '1/1/1999 10:00:00',
    '9/1/2026 13:00 PM', '8/12/26 10:00:00', 0, -3, Number.NaN, '2026-13-01']) {
    assert.equal(formTimestamp(bad as any), null, `not a time: ${JSON.stringify(bad)}`);
  }
});

test('branches: the form\'s five choices and the old spellings ("DHA Phase 6 - Karachi", "RJ MALL karachi"); Islamabad\'s DHA Phase II is Islamabad', () => {
  const cases: Array<[string | null, string | null]> = [
    ['RJ Mall - Karachi', 'GUL'], ['RJ MALL karachi', 'GUL'], ['rjmall', 'GUL'], ['Gulshan (RJ Mall)', 'GUL'],
    ['North Nazimabad - Karachi', 'NN'], ['N. Nazimabad', 'NN'],
    ['DHA - Karachi', 'DHA'], ['DHA Phase 6 - Karachi', 'DHA'], ['DHA Karachi', 'DHA'],
    ['Lahore - Gulberg', 'LHR'], ['Gulberg Lahore', 'LHR'],
    ['Islamabad - DHA Phase II', 'ISB'], ['ISB', 'ISB'],
    ['', null], [null, null], ['Karachi', null], ['Clinic X', null], ['Sample Person', null],
  ];
  for (const [text, code] of cases) assert.equal(formBranch(text), code, String(text));
});

test('Yes / No and the pricing answer: the stored values; anything else is an answer in the wrong column', () => {
  assert.deepEqual(['Yes', ' yes ', 'YES.', 'No', 'no!', '', '  ', null].map((v) => formYesNo(v)),
    [{ value: true, bad: false }, { value: true, bad: false }, { value: true, bad: false }, { value: false, bad: false }, { value: false, bad: false },
      { value: null, bad: false }, { value: null, bad: false }, { value: null, bad: false }]);
  assert.deepEqual(formYesNo('Sample Person'), { value: null, bad: true });
  assert.deepEqual(formYesNo('Lahore - Gulberg'), { value: null, bad: true });
  assert.deepEqual(['Yes', 'No', 'Needs More Clear Explanation', 'needs clearer explanation', 'Need more clear explanation', ''].map((v) => formPricing(v).value),
    ['yes', 'no', 'needs_explanation', 'needs_explanation', 'needs_explanation', null]);
  assert.deepEqual(formPricing('Sample Person'), { value: null, bad: true });
  assert.deepEqual(formPricing('Maybe'), { value: null, bad: true });
});

test('REMINDERS: done is Follow-up Sent, WhatsApp / wrong number / no contact is No Response, treatment done is Completed, started is Started; the word stays in the notes', () => {
  const cases: Array<[any, string | null, string | null]> = [
    ['done', 'Follow-up Sent', null], ['DONE', 'Follow-up Sent', null], [' Done. ', 'Follow-up Sent', null],
    ['done twice', 'Follow-up Sent', 'Reminder: done twice'],
    ['not on whatsapp', 'No Response', 'Reminder: not on whatsapp'], ['Not on whats app', 'No Response', 'Reminder: Not on whats app'],
    ['no watsapp', 'No Response', 'Reminder: no watsapp'], ['NOT ON WHATSAAP', 'No Response', 'Reminder: NOT ON WHATSAAP'], ['not on whatsap', 'No Response', 'Reminder: not on whatsap'],
    ['WRONG NUMBER', 'No Response', 'Reminder: WRONG NUMBER'], ['INCORRECT NO', 'No Response', 'Reminder: INCORRECT NO'], ['NO CONACT', 'No Response', 'Reminder: NO CONACT'],
    ['no contact', 'No Response', 'Reminder: no contact'],
    ['treatment done', 'Completed', 'Reminder: treatment done'], ['already done', 'Completed', 'Reminder: already done'],
    ['treatment started', 'Started', 'Reminder: treatment started'], ['start', 'Started', 'Reminder: start'],
    ['not started yet', null, 'Reminder: not started yet'],
    ['Interested', 'Interested', null], ['follow up sent', 'Follow-up Sent', null], ['NOT INTERESTED', 'Not Interested', null],
    ['Sample Staff', null, 'Reminder: Sample Staff'],
  ];
  for (const [raw, status, note] of cases) {
    const r = reminderFollowUp(raw);
    assert.deepEqual([r.status, r.note], [status, note], String(raw));
    assert.ok(r.status === null || FOLLOW_UP_STATUSES.includes(r.status), 'always one of the eleven statuses');
  }
  for (const empty of ['', '  ', null, undefined, '-']) assert.deepEqual(reminderFollowUp(empty), { status: null, note: null, kind: 'empty' });
  assert.equal(reminderFollowUp('Sample Staff').kind, 'other');
  assert.equal(reminderFollowUp('x'.repeat(400)).note!.length, 'Reminder: '.length + 300, 'a long reminder is cut');
});

test('"What was your checkup for?": the form\'s choices are written the website\'s way, also in a list; "Other" text stays as written', () => {
  assert.equal(formCheckupFor('General Checkup').value, 'General checkup');
  assert.equal(formCheckupFor('Crown/Bridge').value, 'Crown / bridge');
  assert.equal(formCheckupFor('Root Canal').value, 'Root canal');
  assert.equal(formCheckupFor('Scaling & Polishing').value, 'Scaling and polishing');
  assert.equal(formCheckupFor('Braces, Scaling and Polishing').value, 'Braces, Scaling and polishing');
  assert.equal(formCheckupFor('Braces,  pain on the left').value, 'Braces, pain on the left');
  assert.equal(formCheckupFor('pain on the left,swelling').value, 'pain on the left,swelling', 'no choice in it: kept exactly as written');
  assert.deepEqual(formCheckupFor(''), { value: null, cut: false });
  assert.deepEqual(formCheckupFor('y'.repeat(310)), { value: 'y'.repeat(300), cut: true });
  for (const c of CHECKUP_FOR_CHOICES) assert.equal(formCheckupFor(c.toUpperCase()).value, c);
});

test('"Who did your Checkup?": a doctor on the website\'s list is written as the website writes it; anyone else as written', () => {
  const name = doctorNamer(CLINICIANS);
  assert.deepEqual(name('dr. sample hina (SAMPLE)'), { value: 'Dr. Sample Hina (sample)', cut: false, listed: true });
  assert.deepEqual(name('Dr Hina S'), { value: 'Dr. Sample Hina (sample)', cut: false, listed: true }, 'an alias from Clinic setup');
  assert.deepEqual(name('Assistant Sample Bilal (sample)'), { value: 'Assistant Sample Bilal (sample)', cut: false, listed: false }, 'only doctors are matched (the website\'s form lists doctors)');
  assert.deepEqual(name('Dr. Sample Gone (sample)'), { value: 'Dr. Sample Gone (sample)', cut: false, listed: false }, 'a doctor no longer active is kept as written');
  assert.deepEqual(name('Somebody   Else'), { value: 'Somebody Else', cut: false, listed: false });
  assert.deepEqual(name(''), { value: null, cut: false, listed: false });
  assert.deepEqual(doctorNamer([])('Dr. Sample Hina (sample)'), { value: 'Dr. Sample Hina (sample)', cut: false, listed: false }, 'no list: as written');
});

// A tab laid out like the real one (made up): one header row, then the answers. Row numbers are the sheet's (the header is row 1).
const FIXTURE: any[][] = [
  HEADER,
  /* R2  */ ['8/12/2026 19:25:03', 'Sample Alpha', 'RJ Mall - Karachi', '0300-5550301', 'Dr. Sample Hina (sample)', 'Yes', 'Braces', 'Yes', 'Yes', 'Next month', 'done'],
  /* R3  */ ['9\\1\\2026     14.21.1', 'Sample  Bravo ', 'DHA Phase 6 - Karachi', '3005550302', 'Other doctor', 'No', 'General Checkup', 'Needs More Clear Explanation', 'No', 'Too costly for now', 'not on whatsapp'],
  /* R4  */ ['9/2/2026 10:00:00', 'Sample Charlie', 'Lahore - Gulberg', '0300-5550303', 'Dr. Sample Rabia (sample)', 'Yes', 'Crown/Bridge', 'Sample Person', 'Lahore - Gulberg', '', 'treatment started'],
  /* R5  */ ['9/3/2026 11:00:00', '', 'RJ Mall - Karachi', '0300-5550304', '', 'Yes', 'Braces', 'Yes', 'Yes', '', ''],
  /* R6  */ ['someday', 'Sample Delta', 'North Nazimabad - Karachi', '0300-5550305', '', 'Yes', 'Braces', 'Yes', 'Yes', '', ''],
  /* R7  */ ['', '', '', '', '', '', '', '', '', '', ''],
  /* R8  */ ['8/12/2026 19:25:03', 'sample alpha', 'RJ Mall - Karachi', '+92 300 5550301', '', 'Yes', 'Braces', 'Yes', 'Yes', '', ''],
  /* R9  */ ['9/4/2026 12:00:00', 'Sample Echo', 'Clinic X', '', '', '', 'Implant', '', '', '', 'Sample Staff'],
  /* R10 */ ['9/5/2026 13:00:00', 'Sample Foxtrot', '', '0300-5550306', '', 'Yes', 'Root Canal', 'No', 'Yes', 'After Eid', 'WRONG NUMBER'],
  /* R11 */ ['9/6/2026 14:00:00', 'Sample Golf', 'Islamabad - DHA Phase II', '0300-5550307', '', 'No', 'Scaling and Polishing', 'Yes', 'Yes', 'p'.repeat(520), 'already done'],
  /* R12 */ ['9/7/2026 15:00:00', 'Sample Hotel', 'RJ MALL karachi', '0300-5550308', '', 'Yes', 'Extraction', 'Yes', 'Yes', 'Soon', 'start'],
];

test('the whole tab: rows for the database, skipped rows with the reason, and the counts of the preview', () => {
  const read = readFormResponses(FIXTURE, { clinicians: CLINICIANS });
  assert.equal(read.headerAt, 0);
  assert.deepEqual(read.missing, []);
  assert.deepEqual(read.skipped, [
    { row: 5, reason: 'No patient name' },
    { row: 6, reason: 'The date could not be read' },
    { row: 8, reason: 'Same answer twice in the file (row 2)' },
  ], 'a blank row is no row at all; the same time, phone (as digits) and name twice is one answer');
  assert.deepEqual(read.rows.map((r: any) => r.row), [2, 3, 4, 9, 10, 11, 12]);
  assert.deepEqual(read.rows[0], {
    row: 2, submitted_at: '2026-08-12T19:25:03+05:00', name: 'Sample Alpha', phone: '0300-5550301', branch: 'GUL', doctors: 'Dr. Sample Hina (sample)', checkup_for: 'Braces',
    ali_recommended: true, pricing_understood: 'yes', wants_treatment: true, treatment_plan: 'Next month', follow_up: 'Follow-up Sent', notes: null,
  });
  assert.deepEqual(read.rows[1], {
    row: 3, submitted_at: '2026-09-01T14:21:01+05:00', name: 'Sample Bravo', phone: '03005550302', branch: 'DHA', doctors: 'Other doctor', checkup_for: 'General checkup',
    ali_recommended: false, pricing_understood: 'needs_explanation', wants_treatment: false, treatment_plan: 'Too costly for now', follow_up: 'No Response',
    notes: 'Reminder: not on whatsapp',
  }, 'the hand-typed time, a name with extra spaces, a phone that lost its 0, an old branch spelling');
  // the wrong-column row: the two answers that are not answers stay empty, what was written is in the notes
  assert.deepEqual(read.rows[2], {
    row: 4, submitted_at: '2026-09-02T10:00:00+05:00', name: 'Sample Charlie', phone: '0300-5550303', branch: 'LHR', doctors: 'Dr. Sample Rabia (sample)', checkup_for: 'Crown / bridge',
    ali_recommended: true, pricing_understood: null, wants_treatment: null, treatment_plan: null, follow_up: 'Started',
    notes: 'Form answer in the wrong place: "Did you understand the pricing details?" was "Sample Person"; Form answer in the wrong place: "Would you like to start the treatment?" was "Lahore - Gulberg"; Reminder: treatment started',
  });
  const echo = read.rows[3];
  assert.deepEqual([echo.branch, echo.phone, echo.ali_recommended, echo.pricing_understood, echo.wants_treatment, echo.follow_up, echo.notes],
    [null, null, null, null, null, null, 'Branch on the form: "Clinic X"; Reminder: Sample Staff'], 'an unknown branch is kept in the notes; empty answers are no wrong column');
  assert.deepEqual([read.rows[4].branch, read.rows[4].follow_up, read.rows[4].notes], [null, 'No Response', 'Reminder: WRONG NUMBER'], 'no branch at all');
  assert.deepEqual([read.rows[5].branch, read.rows[5].treatment_plan.length, read.rows[5].follow_up], ['ISB', 500, 'Completed']);
  assert.deepEqual([read.rows[6].branch, read.rows[6].follow_up, read.rows[6].checkup_for], ['GUL', 'Started', 'Extraction']);

  const s = read.summary;
  assert.deepEqual([s.total, s.ready, s.skipped, s.badDate, s.from, s.to], [10, 7, 3, 1, '2026-08-12', '2026-09-07']);
  assert.deepEqual(s.perBranch, { GUL: 2, DHA: 1, LHR: 1, none: 2, ISB: 1 });
  assert.deepEqual(s.perBranchText, { 'RJ Mall - Karachi': 1, 'DHA Phase 6 - Karachi': 1, 'Lahore - Gulberg': 1, 'Clinic X': 1, '(empty)': 1, 'Islamabad - DHA Phase II': 1, 'RJ MALL karachi': 1 });
  assert.deepEqual(s.unknownBranches, { 'Clinic X': 1 });
  assert.equal(s.noBranch, 1);
  assert.deepEqual(s.wrongColumn, [{ row: 4, questions: ['Did you understand the pricing details?', 'Would you like to start the treatment?'] }]);
  assert.deepEqual(s.perReminder, { 'Follow-up Sent': 1, 'No Response': 2, Started: 2, other: 1, Completed: 1 });
  assert.deepEqual(s.doctorsNotListed, { 'Other doctor': 1 });
  assert.equal(s.cut, 1, 'the 520-character plan');
});

test('the tab as Google downloads it (CSV with quotes, commas inside answers, CRLF), and a file that is not the form', () => {
  const csv = [HEADER.map((x) => `"${x}"`).join(','),
    '8/12/2026 19:25:03,Sample Quote,RJ Mall - Karachi,0300-5550311,"Dr. Sample Hina (sample)",Yes,"Braces, Scaling and Polishing",Yes,Yes,"After the exams, in December",done',
    '9\\1\\2026     14.21.1,Sample Slash,North Nazimabad - Karachi,0300-5550312,,No,Implant,No,No,"says ""too far""",',
    ''].join('\r\n');
  const read = readFormResponses(parseCSV(csv), { clinicians: CLINICIANS });
  assert.deepEqual(read.rows.map((r: any) => [r.name, r.submitted_at, r.branch, r.checkup_for, r.treatment_plan]), [
    ['Sample Quote', '2026-08-12T19:25:03+05:00', 'GUL', 'Braces, Scaling and polishing', 'After the exams, in December'],
    ['Sample Slash', '2026-09-01T14:21:01+05:00', 'NN', 'Implant', 'says "too far"'],
  ]);
  const old = readFormResponses([['Month', 'Patient Name', 'Phone'], ['Dec 2024', 'Sample', '0300']]);
  assert.deepEqual([old.headerAt, old.missing, old.rows.length], [-1, ['Timestamp', 'Patient Full Name'], 0]);
  assert.deepEqual(readFormResponses(null).missing, ['Timestamp', 'Patient Full Name']);
  const noName = readFormResponses([['Timestamp', 'Comments'], ['8/12/2026 10:00:00', 'x']]);
  assert.equal(noName.headerAt, -1, 'a Timestamp alone is not the form');
});

test('odd cells never break the reader: a branch named "__proto__", numbers where text is expected, short rows', () => {
  const read = readFormResponses([HEADER,
    ['8/12/2026 10:00:00', 'Sample Proto', '__proto__', 3005550321, '', 'Yes', '', 'Yes', 'Yes', 42, ''],
    ['8/12/2026 11:00:00', 'Sample Short'],
  ]);
  assert.deepEqual(read.rows.map((r: any) => [r.name, r.phone, r.branch, r.treatment_plan, r.ali_recommended]), [['Sample Proto', '03005550321', null, '42', true], ['Sample Short', null, null, null, null]]);
  assert.equal(read.summary.unknownBranches.__proto__, 1);
  assert.equal(read.summary.perBranchText['(empty)'], 1);
});
