// Checkup patients: the shared rules and the reader of the old checkup list (web/js/lib/checkups.js).
// Every row below is made up (phones 0300-555xxxx, names "Sample ..."); nothing here comes from the clinic's real list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOLLOW_UP_STATUSES, DAY_STATUSES, SOURCE_LABELS, DAY_STATUS_LABELS, IMPORT_BATCH, CLINIC_BRANCH, EXPORT_HEADER,
  isEmptyCell, cleanText, checkupPhone, checkupKey, excelSerialToISO, monthCell, feeCell, monthLabel, canonicalStatus,
  dayListCheckups, detectCheckupColumns, findHeader, findCheckupSheet, readCheckupList, checkupsToSheet,
} from '../web/js/lib/checkups.js';

const EM = String.fromCharCode(0x2014);   // the owner's list writes "nothing" as an em dash
const EN = String.fromCharCode(0x2013);
const HEADER = ['Month', 'Patient Name', 'Phone', 'City', 'Clinic', 'Doctor', 'Treatment / Checkup For', 'Est. Fee (Rs)', 'Status', 'Notes', 'Source Tab'];
const serial = (iso: string) => Math.round((Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000);

// A sheet laid out like the owner's file: a title, a note, a blank row, the header, then the people.
const FIXTURE: any[][] = [
  ['Checkup list (made-up sample for the tests)'],
  ['Note: every row here is invented.'],
  [],
  HEADER,
  /* R5  */ [serial('2024-12-01'), 'Sample Alpha', '0300-5550101', 'Karachi', 'RJ Mall', 'Dr. Ali Rashid', 'Scaling', 8000, 'Follow-up Sent', 'called twice', 'Sample tab A'],
  /* R6  */ ['Not recorded', 'Sample Bravo', '0300-5550102', EM, 'North Nazimabad', EM, EM, '', 'Not Contacted', '', 'Sample tab B'],
  /* R7  */ [serial('2025-03-01'), 'Sample Charlie', '+92 300 5550103', 'Karachi', 'DHA Karachi', 'Dr. Ali Rashid, Dr. Sample (sample)', 'Braces checkup', 'Rs 8,000', 'interested', '', ''],
  /* R8  */ ['Dec 2025', 'Sample Delta', 3005550104, 'Lahore', 'Lahore Gulberg', '', 'Checkup', '', 'No Response', 'asked price', 'Sample tab A, Sample tab C'],
  /* R9  */ [serial('2025-06-01'), 'Sample Echo', '0300-5550105', 'Islamabad', 'Islamabad', '', '', 720000, 'NOT RECORDED', '', ''],
  /* R10 */ [serial('2025-07-01'), 'Sample Foxtrot', '0300-5550106', 'Karachi', 'Clinic X', '', '', '', 'Maybe later', 'n'.repeat(2100), ''],
  /* R11 */ ['', EM, '', '', '-', '', '', '', '', '', ''],
  /* R12 */ [serial('2025-08-01'), '', '0300-5550107', 'Karachi', 'RJ Mall', '', '', '', 'Not Contacted', '', ''],
  /* R13 */ [serial('2024-12-01'), '  sample   ALPHA ', '03005550101', 'Karachi', 'RJ Mall', '', '', '', 'Completed', 'later copy', ''],
  /* R14 */ [serial('2025-09-01'), 'Sample Golf', '0300-5550108', 'Karachi', 'Gulshan', '', '', '', 'Started', '', ''],
  /* R15 */ ['soon', 'Sample Hotel', '0300-5550109', 'Karachi', EM, '', '', '', 'Completed', '', ''],
  /* R16 */ [serial('2026-10-01'), 'Sample India', '0300-5550110', 'Karachi', 'RJ Mall', '', '', '', 'Did Not Come', '', ''],
  /* R17 */ ['Oct 2025', 'Sample Juliet', '0300-5550111', 'Lahore', 'Gulberg Lahore', '', '', '', 'Scheduled', '', ''],
  /* R18 */ ['2025-11-01', 'Sample Kilo', '0300-5550112', 'Karachi', 'rj mall ', '', '', '', 'Not Interested', '', ''],
  /* R19 */ [serial('2026-01-01'), 'Sample Lima', '0300-5550113', 'Karachi', '__proto__', '', '', '', 'Referred', '', ''],
  /* R20 */ [serial('2025-01-01'), 'Sample Alpha', '0300-5550101', 'Karachi', 'RJ Mall', '', '', '', '', '', ''],
];

test('constants: eleven follow-up statuses (no "scheduled" day status), the owner\'s import columns come first in the export', () => {
  assert.equal(FOLLOW_UP_STATUSES.length, 11);
  assert.equal(new Set(FOLLOW_UP_STATUSES).size, 11);
  assert.equal(FOLLOW_UP_STATUSES[0], 'Not Contacted');
  assert.deepEqual(DAY_STATUSES, ['waiting', 'in_treatment', 'completed', 'cancelled', 'no_show']);
  assert.deepEqual(Object.keys(DAY_STATUS_LABELS), DAY_STATUSES);
  assert.deepEqual(SOURCE_LABELS, { website: 'Website', google_sheet: 'Google Sheet', archive: 'Old list' });
  assert.equal(IMPORT_BATCH, 250);
  assert.deepEqual(EXPORT_HEADER.slice(0, 11), HEADER);
  assert.equal(EXPORT_HEADER.length, 17);
  for (const code of Object.values(CLINIC_BRANCH)) assert.ok(['GUL', 'NN', 'DHA', 'LHR', 'ISB'].includes(code as string));
});

test('keys: the strings the database gives for the same input (pinned in 27_checkups_test.sql too)', () => {
  assert.equal(checkupKey({ phone: '0300-5550142', name: '  Sample   Person ', month: '2024-12-01' }), '03005550142|sample person|202412');
  assert.equal(checkupPhone('+923005550142'), '03005550142');
  assert.equal(checkupPhone('3005550142'), '03005550142');
  assert.equal(checkupPhone('0300 5550142'), '03005550142');
  assert.equal(checkupPhone('(0300) 555-0142'), '03005550142');
  assert.equal(checkupPhone('12345'), null);
  assert.equal(checkupPhone('123456'), null);
  assert.equal(checkupPhone('1234567'), '1234567');
  assert.equal(checkupPhone('92300555014'), '92300555014', '11 digits starting with 92 are kept as they are');
  assert.equal(checkupPhone(null), null);
  assert.equal(checkupPhone(undefined), null);
  assert.equal(checkupPhone(3005550142), '03005550142', 'a phone Excel stored as a number');
  assert.equal(checkupKey({ phone: null, name: 'A B', month: null }), '|a b|');
  assert.equal(checkupKey({ phone: '03005550142', name: 'SAMPLE person', month: '2024-12-31' }), checkupKey({ phone: '+92 300 5550142', name: 'sample\tPERSON', month: '2024-12-01' }));
  assert.notEqual(checkupKey({ phone: '03005550142', name: 'Sample Person', month: '2024-11-30' }), checkupKey({ phone: '03005550142', name: 'Sample Person', month: '2024-12-01' }));
  assert.notEqual(checkupKey({ phone: '03005550143', name: 'Sample Person', month: '2024-12-01' }), checkupKey({ phone: '03005550142', name: 'Sample Person', month: '2024-12-01' }));
  assert.equal(checkupKey(), '||');
});

test('isEmptyCell and cleanText: dashes and blanks are "nothing"; text is trimmed and cut', () => {
  for (const v of [null, undefined, '', '   ', '-', ' - ', '--', EN, EM, ' ' + EM + ' ', EM + EM, '\t']) assert.equal(isEmptyCell(v), true, JSON.stringify(v));
  for (const v of [0, '0', 'x', 'a-b', 'Rs -', 'Not recorded', 8000]) assert.equal(isEmptyCell(v), false, JSON.stringify(v));
  assert.deepEqual(cleanText(EM, 10), { value: null, cut: false });
  assert.deepEqual(cleanText(null, 10), { value: null, cut: false });
  assert.deepEqual(cleanText('  hello  ', 10), { value: 'hello', cut: false });
  assert.deepEqual(cleanText('hello world', 5), { value: 'hello', cut: true });
  assert.deepEqual(cleanText('hello', 5), { value: 'hello', cut: false });
  assert.deepEqual(cleanText(3005550104, 40), { value: '3005550104', cut: false }, 'a number cell is kept as written');
  assert.deepEqual(cleanText('a-b', 5), { value: 'a-b', cut: false }, 'a dash inside text stays');
  const emoji = 'ab' + String.fromCodePoint(0x1F600) + 'cd';
  assert.deepEqual(cleanText(emoji, 3), { value: 'ab' + String.fromCodePoint(0x1F600), cut: true }, 'an emoji counts as one character, as in the database');
  assert.deepEqual(cleanText(emoji, 4), { value: 'ab' + String.fromCodePoint(0x1F600) + 'c', cut: true });
  assert.deepEqual(cleanText(emoji, 5), { value: emoji, cut: false }, 'five characters fit in five (the string is 6 UTF-16 units long)');
});

test('excelSerialToISO: whole days of the 1900 system', () => {
  assert.equal(excelSerialToISO(45627), '2024-12-01');
  assert.equal(excelSerialToISO(45566), '2024-10-01');
  assert.equal(excelSerialToISO(45627.75), '2024-12-01', 'the time of day is dropped');
  assert.equal(excelSerialToISO(serial('2026-10-01')), '2026-10-01');
  assert.equal(excelSerialToISO(2958465), '9999-12-31');
  for (const v of [0, -1, 0.5, 2958466, NaN, Infinity, '45627', null, undefined]) assert.equal(excelSerialToISO(v), null, String(v));
});

test('monthCell: every way a month is written', () => {
  assert.equal(monthCell(45627), '2024-12-01');
  assert.equal(monthCell(45640), '2024-12-01', 'a serial in the middle of the month gives that month');
  assert.equal(monthCell(new Date(2024, 11, 15)), '2024-12-01');
  assert.equal(monthCell('2024-12-01'), '2024-12-01');
  assert.equal(monthCell('2024-12-17'), '2024-12-01');
  assert.equal(monthCell('2024-12-01T00:00:00.000Z'), '2024-12-01');
  assert.equal(monthCell('2024-12'), '2024-12-01');
  assert.equal(monthCell('Dec 2024'), '2024-12-01');
  assert.equal(monthCell('December 2024'), '2024-12-01');
  assert.equal(monthCell('dec 2024'), '2024-12-01');
  assert.equal(monthCell('Dec-24'), '2024-12-01');
  assert.equal(monthCell('Dec 24'), '2024-12-01');
  assert.equal(monthCell('Sept 2025'), '2025-09-01');
  assert.equal(monthCell('  Oct   2025 '), '2025-10-01');
  assert.equal(monthCell('12/2024'), '2024-12-01');
  assert.equal(monthCell('2024/12'), '2024-12-01');
  assert.equal(monthCell('05/12/2024'), '2024-12-01', 'day first');
  assert.equal(monthCell('31/01/25'), '2025-01-01');
  for (const v of ['Not recorded', 'not recorded', 'NOT RECORDED', '', '  ', '-', EM, EN, null, undefined]) assert.equal(monthCell(v), null, JSON.stringify(v));
  for (const v of ['soon', '2024-13-01', '13/2024', '40/01/2025', 'Foo 2024', 'December', '1850-01-01', '2200-01-01', 'Dec 2200', 'x', 0, -5, NaN, new Date('nope'), true]) assert.equal(monthCell(v as any), null, String(v));
});

test('feeCell: numbers and the ways a fee is written', () => {
  assert.equal(feeCell(8000), 8000);
  assert.equal(feeCell(0), 0);
  assert.equal(feeCell(1234.567), 1234.57);
  assert.equal(feeCell('8000'), 8000);
  assert.equal(feeCell('8,000'), 8000);
  assert.equal(feeCell('Rs 8,000'), 8000);
  assert.equal(feeCell('Rs. 8,000'), 8000);
  assert.equal(feeCell('PKR 8000'), 8000);
  assert.equal(feeCell('pkr8,000'), 8000);
  assert.equal(feeCell('8000/-'), 8000);
  assert.equal(feeCell('Rs 8,000 /-'), 8000);
  assert.equal(feeCell('8k'), 8000);
  assert.equal(feeCell('1.5k'), 1500);
  assert.equal(feeCell('1.1K'), 1100);
  assert.equal(feeCell('720000'), 720000);
  for (const v of [-5, '-5', 'abc', '8000-10000', 'Rs', '', '  ', EM, null, undefined, NaN, Infinity, 1e12, 'k', '8k5']) assert.equal(feeCell(v as any), null, String(v));
});

test('monthLabel: "Dec 2024"', () => {
  assert.equal(monthLabel('2024-12-01'), 'Dec 2024');
  assert.equal(monthLabel('2025-01-17'), 'Jan 2025');
  assert.equal(monthLabel('2024-12'), 'Dec 2024');
  for (const v of [null, undefined, '', 'Dec 2024', '2024-13-01', '2024-00-01']) assert.equal(monthLabel(v as any), '', String(v));
});

test('canonicalStatus: the eleven statuses, any case; empty is Not Contacted; unknown text stays', () => {
  for (const s of FOLLOW_UP_STATUSES) {
    assert.equal(canonicalStatus(s), s);
    assert.equal(canonicalStatus(s.toUpperCase()), s);
    assert.equal(canonicalStatus('  ' + s.toLowerCase() + ' '), s);
  }
  assert.equal(canonicalStatus('follow-up sent'), 'Follow-up Sent');
  assert.equal(canonicalStatus('follow up sent'), 'Follow-up Sent');
  assert.equal(canonicalStatus('NOT RECORDED'), 'Not Recorded');
  assert.equal(canonicalStatus('did   not come'), 'Did Not Come');
  for (const v of [null, undefined, '', '  ', '-', EM]) assert.equal(canonicalStatus(v), 'Not Contacted');
  assert.equal(canonicalStatus('Maybe later'), 'Maybe later');
  assert.equal(canonicalStatus('x'.repeat(70)), 'x'.repeat(60));
});

test('dayListCheckups: month-only rows and people who became patients with a visit on the list are left out', () => {
  const checkups = [
    { id: 1, date_is_month: false, patient_id: null },
    { id: 2, date_is_month: true, patient_id: null },
    { id: 3, date_is_month: false, patient_id: 'p1' },
    { id: 4, date_is_month: false, patient_id: 'p2' },
  ];
  assert.deepEqual(dayListCheckups(checkups, [{ patient_id: 'p1' }, { patient_id: 'p9' }]).map((c) => c.id), [1, 4]);
  assert.deepEqual(dayListCheckups(checkups, []).map((c) => c.id), [1, 3, 4]);
  assert.deepEqual(dayListCheckups(checkups, [{ patient_id: null }]).map((c) => c.id), [1, 3, 4], 'a visit without a patient hides nothing');
  assert.deepEqual(dayListCheckups(null, null), []);
});

test('header: found among the first 15 rows, never assumed to be row 4', () => {
  assert.equal(findHeader(FIXTURE), 3);
  assert.equal(findHeader([HEADER, ['x']]), 0);
  assert.equal(findHeader([['a'], ['b'], ['Patient Name', 'Phone']]), 2);
  assert.equal(findHeader([['  PATIENT   NAME ', 'Phone.']]), 0, 'case, spaces and a trailing dot do not matter');
  assert.equal(findHeader([['Name', 'Mobile Number']]), 0);
  assert.equal(findHeader([['Name', 'Contact No']]), 0);
  assert.equal(findHeader([['Patient Name', 'City']]), -1, 'a phone column is required');
  assert.equal(findHeader([['Phone', 'City']]), -1, 'a name column is required');
  assert.equal(findHeader([]), -1);
  assert.equal(findHeader(null), -1);
  assert.equal(findHeader([['Tt Patient Name', 'Tt Contact No', 'Tt Mr #']]), -1, 'the Aaj ki List tabs are not a checkup list');
  const late = Array.from({ length: 15 }, () => ['x']);
  assert.equal(findHeader([...late, HEADER]), -1, 'a header after row 15 is not looked for');
  assert.equal(findHeader([...late.slice(0, 14), HEADER]), 14);
  const tabs = [{ name: 'Daily', rows: [['Tt Patient Name', 'Tt Contact No']] }, { name: 'Checkups', rows: FIXTURE }, { name: 'Other', rows: [HEADER] }];
  assert.equal(findCheckupSheet(tabs)?.name, 'Checkups');
  assert.equal(findCheckupSheet([{ name: 'a', rows: [['x']] }]), null);
  assert.equal(findCheckupSheet([]), null);
  assert.deepEqual(detectCheckupColumns(HEADER), { month: 0, name: 1, phone: 2, city: 3, clinic: 4, doctor: 5, checkupFor: 6, fee: 7, status: 8, notes: 9, sourceTab: 10 });
  assert.deepEqual(detectCheckupColumns(['Date', 'Name', 'Mobile', 'Branch', "Doctor's Name", 'Treatment', 'Est Fee', 'Follow-up', 'Note']),
    { month: 0, name: 1, phone: 2, clinic: 3, doctor: 4, checkupFor: 5, fee: 6, status: 7, notes: 8 });
  assert.deepEqual(detectCheckupColumns(null), {});
});

test('the sheet laid out like the owner\'s: wire rows, row numbers, skips and every summary count', () => {
  const copy = JSON.stringify(FIXTURE);
  const r = readCheckupList(FIXTURE);
  assert.equal(JSON.stringify(FIXTURE), copy, 'the grid is not changed');
  assert.equal(r.headerAt, 3);
  assert.deepEqual(r.columns, { month: 0, name: 1, phone: 2, city: 3, clinic: 4, doctor: 5, checkupFor: 6, fee: 7, status: 8, notes: 9, sourceTab: 10 });
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.rows.map((x) => x.row), [5, 6, 7, 8, 9, 10, 14, 15, 16, 17, 18, 19, 20], 'row numbers count the title rows (the first person is row 5)');
  assert.deepEqual(r.skipped, [{ row: 12, reason: 'No patient name' }, { row: 13, reason: 'Same person and month as row 5' }]);

  assert.deepEqual(r.rows[0], { row: 5, month: '2024-12-01', name: 'Sample Alpha', phone: '0300-5550101', city: 'Karachi', branch: 'GUL', doctors: 'Dr. Ali Rashid',
    checkup_for: 'Scaling', est_fee: 8000, follow_up: 'Follow-up Sent', notes: 'called twice', source_tab: 'Sample tab A' });
  assert.deepEqual(r.rows[1], { row: 6, month: null, name: 'Sample Bravo', phone: '0300-5550102', city: null, branch: 'NN', doctors: null,
    checkup_for: null, est_fee: null, follow_up: 'Not Contacted', notes: null, source_tab: 'Sample tab B' }, 'dash cells and "Not recorded" become null');
  assert.deepEqual(r.rows[2], { row: 7, month: '2025-03-01', name: 'Sample Charlie', phone: '+92 300 5550103', city: 'Karachi', branch: 'DHA', doctors: 'Dr. Ali Rashid, Dr. Sample (sample)',
    checkup_for: 'Braces checkup', est_fee: 8000, follow_up: 'Interested', notes: null, source_tab: null }, 'phone kept as written, fee read from "Rs 8,000", status from lower case');
  assert.deepEqual(r.rows[3], { row: 8, month: '2025-12-01', name: 'Sample Delta', phone: '3005550104', city: 'Lahore', branch: 'LHR', doctors: null,
    checkup_for: 'Checkup', est_fee: null, follow_up: 'No Response', notes: 'asked price', source_tab: 'Sample tab A, Sample tab C' }, 'a text month, a numeric phone');
  assert.equal(r.rows[4].branch, 'ISB');
  assert.equal(r.rows[4].est_fee, 720000);
  assert.equal(r.rows[4].follow_up, 'Not Recorded');
  assert.equal(r.rows[5].branch, null);
  assert.equal(r.rows[5].follow_up, 'Maybe later');
  assert.equal(r.rows[5].notes?.length, 2000, 'an over-long note is cut to 2000');
  assert.deepEqual([r.rows[6].row, r.rows[6].branch, r.rows[6].month, r.rows[6].follow_up], [14, 'GUL', '2025-09-01', 'Started'], '"Gulshan" is Gulshan');
  assert.deepEqual([r.rows[7].row, r.rows[7].month, r.rows[7].branch, r.rows[7].follow_up], [15, null, null, 'Completed'], 'a month nobody can read is "no month"; a dash clinic is no branch');
  assert.deepEqual([r.rows[8].row, r.rows[8].branch, r.rows[8].month, r.rows[8].follow_up], [16, 'GUL', '2026-10-01', 'Did Not Come']);
  assert.deepEqual([r.rows[9].row, r.rows[9].branch, r.rows[9].month, r.rows[9].follow_up], [17, 'LHR', '2025-10-01', 'Scheduled'], '"Oct 2025" and "Gulberg Lahore"');
  assert.deepEqual([r.rows[10].row, r.rows[10].branch, r.rows[10].month, r.rows[10].follow_up], [18, 'GUL', '2025-11-01', 'Not Interested'], 'the clinic text is matched ignoring case and spaces');
  assert.deepEqual([r.rows[11].row, r.rows[11].branch, r.rows[11].follow_up], [19, null, 'Referred'], '"__proto__" is just an unknown clinic');
  assert.deepEqual([r.rows[12].row, r.rows[12].month, r.rows[12].follow_up], [20, '2025-01-01', 'Not Contacted'], 'the same person in another month is another row');
  for (const w of r.rows) assert.deepEqual(Object.keys(w), ['row', 'month', 'name', 'phone', 'city', 'branch', 'doctors', 'checkup_for', 'est_fee', 'follow_up', 'notes', 'source_tab']);

  const s = r.summary;
  assert.equal(s.total, 15, 'the fully empty row is not counted');
  assert.equal(s.ready, 13);
  assert.equal(s.skipped, 2);
  assert.equal(s.from, '2024-12');
  assert.equal(s.to, '2026-10');
  assert.equal(s.noMonth, 2);
  assert.equal(s.badMonth, 1);
  assert.equal(s.withFee, 3);
  assert.equal(s.cut, 1);
  assert.deepEqual(s.perClinic, Object.fromEntries([['RJ Mall', 3], ['North Nazimabad', 1], ['DHA Karachi', 1], ['Lahore Gulberg', 1], ['Islamabad', 1], ['Clinic X', 1],
    ['Gulshan', 1], ['(empty)', 1], ['Gulberg Lahore', 1], ['rj mall', 1], ['__proto__', 1]]));
  assert.deepEqual(s.perBranch, { GUL: 5, NN: 1, DHA: 1, LHR: 2, ISB: 1, none: 3 });
  assert.deepEqual(s.unknownClinics, Object.fromEntries([['Clinic X', 1], ['__proto__', 1]]));
  assert.deepEqual(s.perStatus, { 'Follow-up Sent': 1, 'Not Contacted': 2, Interested: 1, 'No Response': 1, 'Not Recorded': 1, 'Maybe later': 1, Started: 1, Completed: 1,
    'Did Not Come': 1, Scheduled: 1, 'Not Interested': 1, Referred: 1 });
  assert.deepEqual(s.unknownStatuses, { 'Maybe later': 1 });
  assert.equal(Object.values(s.perClinic).reduce((a: number, b: number) => a + b, 0), s.ready);
  assert.equal(Object.values(s.perBranch).reduce((a: number, b: number) => a + b, 0), s.ready);
  assert.equal(Object.values(s.perStatus).reduce((a: number, b: number) => a + b, 0), s.ready);
  assert.equal(Object.getPrototypeOf(s.perClinic), Object.prototype, 'counting "__proto__" did not change the object');
});

test('every clinic label maps to its branch code', () => {
  const clinics: [string, string | null][] = [['RJ Mall', 'GUL'], ['Gulshan (RJ Mall)', 'GUL'], ['North Nazimabad', 'NN'], ['DHA Karachi', 'DHA'], ['Lahore Gulberg', 'LHR'],
    ['Gulberg Lahore', 'LHR'], ['Islamabad', 'ISB'], ['  rj   MALL ', 'GUL'], ['Peshawar', null], [EM, null], ['', null]];
  const grid = [HEADER, ...clinics.map(([c], i) => ['2025-01-01', 'Sample Person ' + i, '0300-555' + String(2000 + i), '', c, '', '', '', '', '', ''])];
  const r = readCheckupList(grid);
  assert.deepEqual(r.rows.map((x) => x.branch), clinics.map(([, b]) => b));
  assert.deepEqual(r.summary.unknownClinics, { Peshawar: 1 });
  assert.equal(r.summary.perClinic['(empty)'], 2);
});

test('a "Source" column: rows exported from the website are not added again', () => {
  const grid = [
    [...HEADER, 'Source'],
    ['Dec 2024', 'Sample Old', '0300-5550301', '', '', '', '', '', '', '', '', 'Old list'],
    ['Dec 2024', 'Sample Web', '0300-5550302', '', '', '', '', '', '', '', '', 'Website'],
    ['Dec 2024', 'Sample Sheet', '0300-5550303', '', '', '', '', '', '', '', '', ' google SHEET '],
    ['Dec 2024', 'Sample Blank', '0300-5550304', '', '', '', '', '', '', '', '', ''],
  ];
  const r = readCheckupList(grid);
  assert.deepEqual(r.rows.map((x) => x.name), ['Sample Old', 'Sample Blank']);
  assert.deepEqual(r.skipped, [{ row: 3, reason: 'Already on the website (exported from it)' }, { row: 4, reason: 'Already on the website (exported from it)' }]);
  assert.equal(r.summary.total, 4);
  assert.equal(r.summary.ready, 2);
  assert.equal(r.columns.source, 11);
  assert.equal(r.columns.sourceTab, 10, '"Source Tab" and "Source" are two different columns');
});

test('nothing to read: no header, an empty sheet, a header with no people', () => {
  for (const grid of [[], null, undefined, [['just', 'a title']], [['Patient Name', 'City']]]) {
    const r = readCheckupList(grid as any);
    assert.equal(r.headerAt, -1);
    assert.deepEqual(r.missing, ['Patient Name', 'Phone']);
    assert.deepEqual(r.rows, []);
    assert.equal(r.summary.ready, 0);
    assert.equal(r.summary.from, null);
  }
  const r = readCheckupList([HEADER]);
  assert.equal(r.headerAt, 0);
  assert.deepEqual(r.rows, []);
  assert.equal(r.summary.total, 0);
  assert.equal(r.summary.to, null);
});

test('short rows and numbers: a row with fewer cells than the header still reads', () => {
  const r = readCheckupList([HEADER, [serial('2025-02-01'), 'Sample Short'], [serial('2025-02-01'), 'Sample Phone Only', 3005550999]]);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].phone, null);
  assert.equal(r.rows[0].follow_up, 'Not Contacted');
  assert.equal(r.rows[1].phone, '3005550999');
});

test('a month cell with a serial in the middle of the month, or a real Date, gives the month', () => {
  const r = readCheckupList([HEADER, [45640, 'Sample One', '0300-5550401'], [new Date(2025, 4, 20), 'Sample Two', '0300-5550402']]);
  assert.deepEqual(r.rows.map((x) => x.month), ['2024-12-01', '2025-05-01']);
});

test('export and import again: archive rows come back with the same keys, website and sheet rows are skipped', () => {
  const branches = [{ id: 1, name: 'Gulshan (RJ Mall)' }, { id: 2, name: 'North Nazimabad' }, { id: 4, name: 'Gulberg Lahore' }];
  const rows = [
    { id: 'a', checkup_date: '2024-12-01', date_is_month: true, branch_id: 1, patient_name: 'Sample Alpha', phone: '0300-5550101', city: 'Karachi', doctors: 'Dr. Sample (sample)',
      checkup_for: 'Scaling', details: null, day_status: null, est_fee: '8000.00', follow_up: 'Follow-up Sent', notes: 'called twice', source: 'archive', source_tab: 'Sample tab A',
      patient_id: null, mr_number: null, created_at: '2026-10-09T08:00:00Z' },
    { id: 'b', checkup_date: null, date_is_month: true, branch_id: null, patient_name: 'Sample Bravo', phone: '0300-5550102', city: null, doctors: null, checkup_for: null, details: null,
      day_status: null, est_fee: null, follow_up: 'Not Contacted', notes: null, source: 'archive', source_tab: null, patient_id: null, mr_number: null, created_at: '2026-10-09T20:00:00Z' },
    { id: 'c', checkup_date: '2026-10-09', date_is_month: false, branch_id: 2, patient_name: 'Sample Charlie', phone: '0300-5550103', city: 'Karachi', doctors: 'Dr. Ali Rashid', checkup_for: 'Checkup',
      details: 'scaling advised', day_status: 'waiting', est_fee: null, follow_up: 'Not Contacted', notes: null, source: 'website', source_tab: null, patient_id: null, mr_number: null, created_at: '2026-10-09T08:00:00Z' },
    { id: 'd', checkup_date: '2026-10-08', date_is_month: false, branch_id: 4, patient_name: 'Sample Delta', phone: '0300-5550104', city: 'Lahore', doctors: null, checkup_for: 'Checkup',
      details: null, day_status: 'no_show', est_fee: null, follow_up: 'Started', notes: null, source: 'google_sheet', source_tab: null, patient_id: 'p1', mr_number: '50001', created_at: '2026-10-08T10:00:00Z' },
    { id: 'e', checkup_date: '2025-03-01', date_is_month: true, branch_id: 2, patient_name: 'Sample Echo', phone: '0300-5550105', city: 'Karachi', doctors: null, checkup_for: 'Braces checkup',
      details: null, day_status: null, est_fee: 720000, follow_up: 'Started', notes: null, source: 'archive', source_tab: 'Sample tab B', patient_id: 'p2', mr_number: '50002', created_at: '2026-10-09T08:00:00Z' },
  ];
  const sheet = checkupsToSheet(rows, branches);
  assert.deepEqual(sheet[0], EXPORT_HEADER);
  assert.equal(sheet.length, 6);
  for (const line of sheet) assert.equal(line.length, 17);
  assert.deepEqual(sheet[1], ['Dec 2024', 'Sample Alpha', '0300-5550101', 'Karachi', 'Gulshan (RJ Mall)', 'Dr. Sample (sample)', 'Scaling', 8000, 'Follow-up Sent', 'called twice', 'Sample tab A',
    '', '', '', 'Old list', '', '2026-10-09']);
  assert.equal(typeof sheet[1][2], 'string', 'the phone stays text, so the leading 0 survives Excel');
  assert.equal(typeof sheet[1][7], 'number', 'the fee is the one number');
  assert.deepEqual(sheet[2].slice(0, 5), ['Not recorded', 'Sample Bravo', '0300-5550102', '', ''], 'no month, no city, no branch');
  assert.equal(sheet[2][7], '');
  assert.equal(sheet[2][16], '2026-10-10', 'Added on is the Karachi date (20:00 UTC is already the next day there)');
  assert.deepEqual(sheet[3].slice(11, 17), ['2026-10-09', 'Waiting', 'scaling advised', 'Website', '', '2026-10-09'], 'a day row carries its date, day status and treatment details');
  assert.equal(sheet[3][0], 'Oct 2026');
  assert.deepEqual(sheet[4].slice(11, 16), ['2026-10-08', 'No show', '', 'Google Sheet', '50001']);
  assert.equal(sheet[5][15], '50002', 'the Mr# of a registered checkup');

  const back = readCheckupList(sheet);
  assert.equal(back.headerAt, 0);
  assert.deepEqual(back.rows.map((x) => checkupKey({ phone: x.phone, name: x.name, month: x.month })),
    [rows[0], rows[1], rows[4]].map((c) => checkupKey({ phone: c.phone, name: c.patient_name, month: c.checkup_date })), 'the old-list rows keep their keys');
  assert.deepEqual(back.rows.map((x) => [x.name, x.month, x.branch, x.est_fee, x.follow_up]),
    [['Sample Alpha', '2024-12-01', 'GUL', 8000, 'Follow-up Sent'], ['Sample Bravo', null, null, null, 'Not Contacted'], ['Sample Echo', '2025-03-01', 'NN', 720000, 'Started']]);
  assert.deepEqual(back.skipped, [{ row: 4, reason: 'Already on the website (exported from it)' }, { row: 5, reason: 'Already on the website (exported from it)' }]);
  assert.equal(back.summary.ready, 3);
  assert.deepEqual(checkupsToSheet([], branches), [EXPORT_HEADER]);
  assert.deepEqual(checkupsToSheet(null, null), [EXPORT_HEADER]);
});
