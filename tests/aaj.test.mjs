// Aaj ki List (Google Sheet) reader: node tests/aaj.test.mjs
import assert from 'node:assert/strict';
import { detectColumns, isHeaderRow, cellDate, tabBranch, readTab, buildImport } from '../web/js/lib/aaj.js';

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('ok -', name); } catch (e) { console.log('FAIL -', name, '\n   ', e.message.split('\n')[0]); process.exitCode = 1; } };

const HEADER = ['Tt Mr #', 'Tt Patient Name', 'Monthly', 'Tt Treatment', 'Token No', 'Waiting', 'Group', "Doctor's Name", 'Tt Treatment Details', 'P.P', 'Healthwire', 'Tt Contact No', 'Reminder Status'];
const serial = (iso) => Math.round((Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000);

test('header names are recognised with and without the "Tt" prefix and in their variants', () => {
  const m = detectColumns(HEADER);
  assert.deepEqual([m.mr, m.name, m.month, m.treatment, m.token, m.status, m.group, m.doctors, m.details, m.phone, m.reminder], [0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12]);
  const m2 = detectColumns(['Mr#', 'Patient Name', 'Month', 'Treatment', 'Token', 'Status', 'Column 13', 'Doctor', 'Details', 'Contact', 'Date']);
  assert.deepEqual([m2.mr, m2.name, m2.month, m2.treatment, m2.token, m2.status, m2.group, m2.doctors, m2.details, m2.phone, m2.date], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(isHeaderRow(HEADER));
  assert.ok(!isHeaderRow(['9694', 'Sample Person', '2', 'Monthly', '121', 'Completed']));
});

test('dates in every usual form', () => {
  assert.equal(cellDate(serial('2025-10-07')), '2025-10-07');
  assert.equal(cellDate(new Date(2025, 9, 7)), '2025-10-07');
  assert.equal(cellDate('7/10/2025'), '2025-10-07');
  assert.equal(cellDate('07-10-25'), '2025-10-07');
  assert.equal(cellDate('2025-10-07'), '2025-10-07');
  assert.equal(cellDate('Monday 7th October 2025'), '2025-10-07');
  assert.equal(cellDate('Date: 7 Oct 2025'), '2025-10-07');
  assert.equal(cellDate('Oct 7, 2025'), '2025-10-07');
  assert.equal(cellDate('7-Oct-2025 (Tuesday)'), '2025-10-07');
  assert.equal(cellDate(121), null, 'a token is not a date');
  assert.equal(cellDate('Monthly'), null);
  assert.equal(cellDate('U L 018'), null);
  assert.equal(cellDate('31/02/2025'), null, 'impossible date');
});

test('tab names give the branch', () => {
  assert.equal(tabBranch('Gulshan KHI'), 'GUL');
  assert.equal(tabBranch('North Nazimabad'), 'NN');
  assert.equal(tabBranch('N.N'), 'NN');
  assert.equal(tabBranch('DHA KHI'), 'DHA');
  assert.equal(tabBranch('Islamabad'), 'ISB');
  assert.equal(tabBranch('Gulberg Lahore'), 'LHR');
  assert.equal(tabBranch('G...'), 'LHR');
  assert.equal(tabBranch('Sheet1'), null);
});

const TAB = [
  ['Aaj ki List'],
  [serial('2025-10-06')],
  HEADER,
  ['9694', 'Sample Person Two', '2', 'Monthly', 121, 'Completed', '', 'Dr. Ali Rashid', '', '', 'Done', '03001112233', ''],
  ['8715', 'Sample Person Three lhr', '6 Photo', 'Monthly', 119, 'Completed', 'Group 3', 'Dr Haniya, Dr. Samrah Khan', 'Brac 16 13 45 46 U L 016', '35k', 'Done', 3004445566, ''],
  ['', 'Sample Person Seven', '', 'Checkup', 79, 'Not came', '', 'Dr. Unknown Person', '', '', '', '03211234567', 'Called'],
  ['', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['', 'Tuesday 7th October 2025', '', '', '', '', '', '', '', '', '', '', ''],
  ['9694', 'Sample Person Two', '3', 'Monthly', 1, 'Completed', '', 'Dr. Ali Rashid, Hira Anis', 'U L 014', '', '', '03001112233', ''],
  ['', 'Sample Person Eight', '', 'Scaling', 1, 'Completed', '', 'Hira Anis', '', '', '', '', ''],
  ['', 'Sample Person Nine', '', 'Filling', 2, '', '', '', '', '', '', '', ''],
  ['', 'Total', '', '', '', '', '', '', '', '', '', '', ''],
];

test('a tab with day rows: rows get their day, names are cleaned, months and people read', () => {
  const t = readTab(TAB);
  assert.equal(t.dateMode, 'rows');
  assert.deepEqual(t.days, ['2025-10-06', '2025-10-07']);
  assert.equal(t.rows.length, 6);
  const three = t.rows[1];
  assert.equal(three.date, '2025-10-06');
  assert.equal(three.name, 'Sample Person Three');
  assert.equal(three.legacyName, 'Sample Person Three lhr');
  assert.equal(three.month, 6);
  assert.ok(three.photoMarked);
  assert.equal(three.group, '3');
  assert.equal(three.phone, '03004445566', 'a phone typed as a number gets its leading 0 back');
  assert.deepEqual(three.people, ['Dr Haniya', 'Dr. Samrah Khan']);
  assert.equal(t.rows[2].status, 'no_show');
  assert.equal(t.rows[3].date, '2025-10-07');
  assert.equal(t.rows[3].token, 1);
  assert.equal(t.rows[5].name, 'Sample Person Nine');
  assert.equal(t.issues.length, 0);
});

test('a tab with a Date column, and a tab with no dates at all', () => {
  const withCol = [['Date', 'Patient Name', 'Treatment', 'Doctor', 'Token'], ['6/10/2025', 'Someone', 'Checkup', 'Dr. Ali Rashid', 4], ['7/10/2025', 'Else', 'Scaling', '', 5]];
  const a = readTab(withCol);
  assert.equal(a.dateMode, 'column');
  assert.deepEqual(a.rows.map((r) => r.date), ['2025-10-06', '2025-10-07']);
  const none = readTab([HEADER, ['', 'Only Today', '', 'Checkup', 1, 'Completed', '', '', '', '', '', '', '']]);
  assert.equal(none.dateMode, 'none');
  assert.ok(none.issues[0].includes('No dates'));
  const fixed = readTab(none === null ? [] : [HEADER, ['', 'Only Today', '', 'Checkup', 1, 'Completed', '', '', '', '', '', '', '']], { fixedDate: '2025-10-01' });
  assert.equal(fixed.rows[0].date, '2025-10-01');
  assert.equal(readTab([['nothing', 'here']]).issues[0].slice(0, 13), 'No header row');
});

test('rows for import: people matched through aliases, tokens not repeated, today left out', () => {
  const clinicians = [
    { id: 'ali', display_name: 'Dr. Ali Rashid', aliases: [], is_doctor: true },
    { id: 'haniya', display_name: 'Dr. Haniya Siddiqui', aliases: ['Dr Haniya'], is_doctor: true },
    { id: 'samrah', display_name: 'Dr. Samrah Khan', aliases: [], is_doctor: true },
    { id: 'hira', display_name: 'Hira Anis', aliases: [], is_doctor: false },
  ];
  const treatments = [{ id: 1, name: 'Monthly' }, { id: 14, name: 'Checkup' }, { id: 16, name: 'Scaling' }];
  const { rows, summary } = buildImport([{ name: 'North Nazimabad', branchId: 2, read: readTab(TAB) }], clinicians, treatments, '2025-10-07');
  assert.equal(summary.future, 3, 'rows dated today are left to the live sheet');
  assert.equal(rows.length, 3);
  assert.equal(summary.days, 1);
  const three = rows[1];
  assert.deepEqual(three.slice(0, 6), ['2025-10-06', 2, '8715', 'Sample Person Three', 'Sample Person Three lhr', '03004445566']);
  assert.deepEqual(three[11], ['haniya', 'samrah']);
  assert.equal(three[18], 1, 'treatment id from the catalogue');
  assert.deepEqual(rows[2][13], ['Dr. Unknown Person']);
  assert.equal(rows[2][9], 'no_show');
  assert.deepEqual(summary.unmatchedPeople, { 'Dr. Unknown Person': 1 });
  const later = buildImport([{ name: 'North Nazimabad', branchId: 2, read: readTab(TAB) }], clinicians, treatments, '2025-10-08');
  assert.equal(later.rows.length, 6);
  assert.equal(later.rows[4][8], null, 'a token used twice on one day is kept on the first row only');
  assert.deepEqual(later.rows[3][12], ['hira'], 'assistants are sent separately from doctors');
});

console.log(`${passed} passed`);
