// The reader of the "Retainer Record" Google Sheet (web/js/lib/retainers-import.js). Every row below is made up ("Sample ..."
// names, phones 0300-555xxxx, makers "Maker ..."); nothing here comes from the clinic's real sheet. The date shapes are the
// ones seen on the real tabs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RETAINER_COPY_MAX, isBlank, teamName, contactCell, mrCell, statusCell, paymentCell, yearCandidates, monthOfWord, excelSerial, parseDateCell,
  resolveColumn, farFromNeighbours, detectRetainerColumns, findRetainerHeader, readRetainerTab, FIELD_LABELS, tabCityHint,
} from '../web/js/lib/retainers-import.js';
import { retainerStatuses } from '../web/js/lib/records.js';
import { parseCSV } from '../web/js/lib/healthwire.js';
import fs from 'node:fs';

const TODAY = '2026-10-12';
const isoOf = (cells: any[], opts: any = {}) => resolveColumn(cells.map(parseDateCell), { today: TODAY, ...opts }).map((d: any) => d.iso);

test('constants: a whole tab goes in one call (the copy takes at most 3000 rows, as the database), a label for every field', () => {
  assert.equal(RETAINER_COPY_MAX, 3000);
  const sql = fs.readFileSync(new URL('../supabase/migrations/20261012000200_retainer_lab_records.sql', import.meta.url), 'utf8');
  assert.match(sql, /if n_given > 3000 then/, 'the copy refuses more than 3000 rows');
  assert.ok(sql.includes('if jsonb_array_length(p_rows) > 3000 then'), 'and the Mr# check takes a whole tab too');
  for (const f of ['mr', 'contact', 'name', 'impression', 'model_check', 'made_by', 'retainer_date', 'status', 'retainer_sheet', 'payment', 'notes']) assert.ok(FIELD_LABELS[f], f);
});

test('cells: blanks, team names, contacts', () => {
  for (const v of [null, undefined, '', '  ', '-', '–', '— ', ' - ']) assert.equal(isBlank(v), true, JSON.stringify(v));
  assert.equal(isBlank('a-b'), false);
  assert.equal(teamName('  maker   alpha '), 'Maker Alpha', 'all small letters get capitals, spaces collapse');
  assert.equal(teamName('dr. sample checker'), 'Dr. Sample Checker');
  assert.equal(teamName('McSample'), 'McSample', 'a name with capitals is kept as written');
  assert.equal(teamName('—'), null);
  assert.equal(contactCell(3005550101), '03005550101', 'a phone that lost its 0 gets it back');
  assert.equal(contactCell('0300-5550101'), '0300-5550101');
  assert.equal(contactCell(' - '), null);
});

test('the Karachi cells: Mr# kept as typed, a phone in the Mr# column is the contact, Status and Payments in the list\'s words', () => {
  assert.deepEqual(mrCell('082'), { mr: '082', contact: null }, 'the leading 0 stays');
  assert.deepEqual(mrCell(' 6620 '), { mr: '6620', contact: null });
  assert.deepEqual(mrCell('123-4'), { mr: '123-4', contact: null }, 'kept as typed, even when it is not an Mr#');
  assert.deepEqual(mrCell(3005550199), { mr: null, contact: '03005550199' }, 'ten digits or more is a phone');
  assert.deepEqual(mrCell('0300-5550199'), { mr: null, contact: '0300-5550199' });
  assert.deepEqual(mrCell(''), { mr: null, contact: null });
  const list = retainerStatuses({});
  assert.deepEqual(statusCell('Model Poured', list), { status: 'Model poured', note: null }, 'Model Poured is on the list');
  assert.deepEqual(statusCell('Delivered to Patient', list), { status: 'Delivered to patient', note: null });
  assert.deepEqual(statusCell('Impression Repeat', list), { status: 'Impression repeat', note: null });
  assert.deepEqual(statusCell('Waiting for sheet', list), { status: 'Waiting for sheet', note: null }, 'a short status not on the list is kept as written');
  assert.deepEqual(statusCell('Upper wire changed, lower bonded on 14/9', list), { status: null, note: 'Upper wire changed, lower bonded on 14/9' },
    'treatment text typed into Status is no status; the text is the note');
  assert.equal(statusCell('Upper and lower wires changed again today', list).status, null, 'more than four words is a note too');
  assert.deepEqual(statusCell(' - ', list), { status: null, note: null });
  assert.equal(paymentCell('Payment Done'), 'Paid');
  assert.equal(paymentCell('payment  done'), 'Paid');
  assert.equal(paymentCell('Dues'), 'Pending');
  assert.equal(paymentCell('Unpaid'), 'Pending');
  assert.equal(paymentCell('FOC'), 'Free');
  assert.equal(paymentCell('paid'), 'Paid');
  assert.equal(paymentCell('Half now'), 'Half now', 'anything else is kept as written');
  assert.equal(paymentCell(''), null);
});

test('years: two digits, four digits, and five-digit slips give every year one deleted digit makes', () => {
  assert.deepEqual(yearCandidates('25'), [2025]);
  assert.deepEqual(yearCandidates('2025'), [2025]);
  assert.deepEqual(yearCandidates('20225'), [2025, 2022], '17-05--20225');
  assert.deepEqual(yearCandidates('20256'), [2026, 2025], '09-07-20256');
  assert.deepEqual(yearCandidates('1999'), [], 'outside 2020-2035');
  assert.deepEqual(yearCandidates('202'), []);
});

test('month words: names, short names and typing slips', () => {
  assert.equal(monthOfWord('November'), 11);
  assert.equal(monthOfWord('december'), 12);
  assert.equal(monthOfWord('march'), 3);
  assert.equal(monthOfWord('may'), 5);
  assert.equal(monthOfWord('feburary'), 2, '11 feburary');
  assert.equal(monthOfWord('decmber'), 12);
  assert.equal(monthOfWord('sept'), 9);
  assert.equal(monthOfWord('jan'), 1);
  assert.equal(monthOfWord('rd'), 0);
  assert.equal(monthOfWord('pending'), 0);
  assert.equal(monthOfWord('soon'), 0);
});

test('one cell: every shape on the Karachi tab', () => {
  assert.deepEqual(parseDateCell('15/04/2025'), { kind: 'date', options: ['2025-04-15'], text: '15/04/2025' }, 'day first with slashes');
  assert.deepEqual(parseDateCell('17-04-2025').options, ['2025-04-17'], 'day first with dashes');
  assert.deepEqual(parseDateCell('11-06-25').options, ['2025-06-11'], 'a two-digit year, day first (a dash date is never month first)');
  assert.deepEqual(parseDateCell('19\\-04-2025').options, ['2025-04-19'], 'a stray backslash');
  assert.deepEqual(parseDateCell('24-04=2025').options, ['2025-04-24'], 'an equals sign for a dash');
  const a = parseDateCell('17-05--20225');
  assert.equal(a.kind, 'ambiguous', 'a doubled dash and a five-digit year');
  assert.deepEqual(a.options, ['2025-05-17', '2022-05-17']);
  const b = parseDateCell('09-07-20256');
  assert.equal(b.kind, 'ambiguous');
  assert.deepEqual(b.options, ['2026-07-09', '2025-07-09']);
  const c = parseDateCell('04/08/2025');
  assert.equal(c.kind, 'ambiguous', 'a slash date with both numbers 12 or less: 4 August or (as Google Sheets shows) 8 April');
  assert.deepEqual(c.options, ['2025-08-04', '2025-04-08']);
  assert.deepEqual(parseDateCell('4/15/2025').options, ['2025-04-15'], 'month first when the second number cannot be a month');
  assert.deepEqual(parseDateCell('04-15-2025').options, ['2025-04-15'], 'even with dashes, when day first is impossible');
  assert.deepEqual(parseDateCell('2025-04-08').options, ['2025-04-08'], 'year first (the website\'s own download)');
  assert.deepEqual(parseDateCell(45755).options, ['2025-04-08'], 'a real date from an .xlsx tab');
  assert.equal(parseDateCell('31/02/2025').kind, 'bad', 'a day that does not exist');
  assert.equal(parseDateCell('15/04/1999').kind, 'bad', 'a year outside 2020-2035');
  assert.equal(parseDateCell('soon').kind, 'bad');
  assert.equal(parseDateCell('12345').kind, 'bad');
  assert.equal(parseDateCell(' - ').kind, 'empty');
  assert.equal(parseDateCell('').kind, 'empty');
});

test('one cell: every shape on the Lahore tab', () => {
  for (const [typed, month, day] of [['20- November', 11, 20], ['23rd december', 12, 23], ['16March', 3, 16], ['23may', 5, 23], ['11 feburary', 2, 11], ['nov 2', 11, 2], ['1st Jan', 1, 1]] as [string, number, number][]) {
    const p = parseDateCell(typed);
    assert.equal(p.kind, 'noyear', typed);
    assert.equal(p.month, month, typed);
    assert.equal(p.day, day, typed);
  }
  assert.deepEqual(parseDateCell('23/5/26').options, ['2026-05-23'], 'day/month/two-digit year');
  assert.deepEqual(parseDateCell('20 November 2025').options, ['2025-11-20'], 'a month name with a year');
  assert.deepEqual(parseDateCell('20 nov 25').options, ['2025-11-20'], 'a month name with a two-digit year');
  const p = parseDateCell('23/5');
  assert.equal(p.kind, 'noyear', 'day/month without a year');
  assert.equal(p.month, 5);
  assert.equal(parseDateCell('november').kind, 'bad', 'a month without a day');
  assert.equal(parseDateCell('35 november').kind, 'bad');
});

test('a column: the rows around a cell settle what it can mean', () => {
  // 04/08/2025 among April rows is 8 April (Google Sheets shows recognised dates month first); among August rows it is 4 August.
  assert.deepEqual(isoOf(['04/08/2025', '15/04/2025', '17-04-2025']), ['2025-04-08', '2025-04-15', '2025-04-17'], 'above the first sure date: the row after it decides');
  assert.deepEqual(isoOf(['01-08-2025', '04/08/2025', '06-08-2025']), ['2025-08-01', '2025-08-04', '2025-08-06']);
  // A slipped year follows its neighbours.
  assert.deepEqual(isoOf(['15-05-2025', '17-05--20225', '20-05-2025']), ['2025-05-15', '2025-05-17', '2025-05-20']);
  assert.deepEqual(isoOf(['05-07-2025', '09-07-20256', '11-07-2025']), ['2025-07-05', '2025-07-09', '2025-07-11']);
  // Unreadable and empty cells are passed over and keep their text.
  const res = resolveColumn(['15/04/2025', 'soon', '', '17-04-2025'].map(parseDateCell), { today: TODAY });
  assert.deepEqual(res.map((d: any) => d.iso), ['2025-04-15', null, null, '2025-04-17']);
  assert.equal(res[1].text, 'soon');
  assert.equal(res[2].text, null);
  assert.deepEqual(res.map((d: any) => d.guessed), [false, false, false, false]);
});

test('a column of Lahore dates without a year: November 2025 onwards, a new year when the months go back', () => {
  const lahore = ['20- November', '28 november', '23rd december', '2 jan', '11 feburary', '16March', '23may', '1 june', '5 august'];
  assert.deepEqual(isoOf(lahore), ['2025-11-20', '2025-11-28', '2025-12-23', '2026-01-02', '2026-02-11', '2026-03-16', '2026-05-23', '2026-06-01', '2026-08-05'],
    'with no sure date the column ends on or before today (12 Oct 2026)');
  assert.deepEqual(isoOf(lahore, { startYear: 2024 }), ['2024-11-20', '2024-11-28', '2024-12-23', '2025-01-02', '2025-02-11', '2025-03-16', '2025-05-23', '2025-06-01', '2025-08-05'],
    'the first row\'s year can be given');
  // A sure date further down (23/5/26) anchors the rows above it, back across the new year.
  assert.deepEqual(isoOf(['20- November', '23rd december', '16March', '23/5/26', '1 june']), ['2025-11-20', '2025-12-23', '2026-03-16', '2026-05-23', '2026-06-01']);
  // A row typed out of order goes back a little, not a whole year forward.
  assert.deepEqual(isoOf(['28 november', '3 december', '30 november', '5 december']), ['2025-11-28', '2025-12-03', '2025-11-30', '2025-12-05']);
  // 29 February only in a leap year.
  assert.deepEqual(isoOf(['20 february', '29 feb'], { startYear: 2028 }), ['2028-02-20', '2028-02-29']);
  const guessed = resolveColumn(lahore.map(parseDateCell), { today: TODAY }).map((d: any) => d.guessed);
  assert.ok(guessed.every(Boolean), 'every date without a year is marked as read from the rows around it');
});

// A Lahore-style column: a row every two weeks from 20 November 2025 to today (12 Oct 2026), the day and the month only.
const MONTH_WORDS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const fortnightly = () => {
  const out: string[] = [];
  for (let t = Date.UTC(2025, 10, 20); t <= Date.UTC(2026, 9, 12); t += 14 * 86400000) { const d = new Date(t); out.push(`${d.getUTCDate()} ${MONTH_WORDS[d.getUTCMonth()]}`); }
  return out;
};

test('a column without a year: a slip or two after today stays a slip, it does not move the whole column a year back', () => {
  const rows = fortnightly();
  assert.equal(rows.length, 24);
  const plain = isoOf(rows);
  assert.equal(plain[0], '2025-11-20');
  assert.equal(plain[23], '2026-10-08');
  // The last row typed one day after today ("13 october"), or "19 october" for "9 october": the column keeps its years.
  for (const slip of ['13 october', '19 october']) {
    const res = isoOf([...rows, slip]);
    assert.equal(res[0], '2025-11-20', `${slip}: the first row stays in November 2025`);
    assert.equal(res[24], `2026-10-${slip.slice(0, 2)}`, `${slip}: the slip is read after today`);
  }
  assert.equal(isoOf([...rows, '13 october', '20 october'])[0], '2025-11-20', 'two slips: the same');
  // Three dates after today are no slip: the column is read a year earlier, so none is after today.
  const three = isoOf([...rows, '13 october', '20 october', '27 october']);
  assert.equal(three[0], '2024-11-20');
  assert.ok(three.every((d: string) => d <= TODAY));
  // A short column has no room for a slip: two rows that would both be after today are last year's.
  assert.deepEqual(isoOf(['20 november', '5 december']), ['2025-11-20', '2025-12-05']);
  assert.deepEqual(isoOf(['13 october']), ['2025-10-13'], 'one row');
});

test('a Lahore tab whose last row is one day after today: the 2025 and 2026 dates stay, and that row is pointed out as after today', () => {
  const tab = [['Contact #', 'Patient Name ', 'Impression Date', 'Model Check By', 'Retainer Made By', 'Retainer Date ', 'Status'],
    ...[...fortnightly(), '13 october'].map((imp, i) => ['', `Sample Lahore ${i + 1}`, imp, 'Dr. Sample Checker', 'Maker Lahore', '', 'Retainer Made'])];
  const r = readRetainerTab(tab, { today: TODAY });
  assert.equal(r.rows.length, 25);
  assert.equal(r.rows[0].impression_date, '2025-11-20');
  assert.equal(r.rows[23].impression_date, '2026-10-08');
  assert.deepEqual(r.future, [{ row: 26, field: 'impression', iso: '2026-10-13' }]);
  assert.deepEqual(r.far, []);
  assert.equal(r.summary.from, '2025-11-20');
  assert.equal(r.summary.to, '2026-10-08', 'the months on the tab leave out the date after today');
  // The day of the clinic decides: on 13 October that row is no longer after today.
  assert.deepEqual(readRetainerTab(tab, { today: '2026-10-13' }).future, []);
});

test('the retainer date comes on or after its row\'s impression date', () => {
  const imp = isoOf(['28 december', '30 december']);
  assert.deepEqual(imp, ['2025-12-28', '2025-12-30']);
  const ret = resolveColumn(['5 january', '2 jan'].map(parseDateCell), { today: TODAY, rowAnchors: imp }).map((d: any) => d.iso);
  assert.deepEqual(ret, ['2026-01-05', '2026-01-02'], 'January after a December impression is the next January');
  const ret2 = resolveColumn(['04/05/2025'].map(parseDateCell), { today: TODAY, rowAnchors: ['2025-04-20'] }).map((d: any) => d.iso);
  assert.deepEqual(ret2, ['2025-05-04'], 'of 4 May and 5 April, the one after the 20 April impression');
});

test('headings: matched by name, a blank first heading in front of the name is the Mr#, the header row is found', () => {
  assert.deepEqual(detectRetainerColumns(['', 'Patient name', 'Impression Date', 'Model Check By', 'Retainer Made By', 'Retainer Date', 'Status', 'retainer sheet', 'Payments']),
    { mr: 0, name: 1, impression: 2, model_check: 3, made_by: 4, retainer_date: 5, status: 6, retainer_sheet: 7, payment: 8 });
  assert.deepEqual(detectRetainerColumns(['Mr #', 'Patient name', 'Impression Date']), { mr: 0, name: 1, impression: 2 }, 'an Mr# heading');
  // The real Karachi tab: column A headed with a patient's first name, column B "Column 2", the sheet's own headings from C.
  assert.deepEqual(detectRetainerColumns(['Sample', 'Column 2', 'Impression Date', 'Model Check By', 'Retainer Made By', 'Retainer Date ', 'Status', 'retainer sheet', 'Payments']),
    { impression: 2, model_check: 3, made_by: 4, retainer_date: 5, status: 6, retainer_sheet: 7, payment: 8, mr: 0, name: 1 }, 'A and B by position');
  assert.deepEqual(detectRetainerColumns(['Sample', 'Impression Date', 'Retainer Made By']), { impression: 1, made_by: 2, name: 0 }, 'one column before the headings: the name');
  assert.equal(detectRetainerColumns(['Status', 'Sample', 'Impression Date']).name, undefined, 'never by position when a known heading sits in front');
  assert.equal(findRetainerHeader([['Sample', 'Column 2', 'Impression Date', 'Model Check By']]), 0, 'the Karachi header row is found');
  assert.deepEqual(detectRetainerColumns(['Contact #', 'Patient Name', 'Impression Date', 'Model Check By', 'Retainer Made By', 'Retainer Date', 'Status']),
    { contact: 0, name: 1, impression: 2, model_check: 3, made_by: 4, retainer_date: 5, status: 6 });
  assert.deepEqual(detectRetainerColumns(['Status', 'Patient Name', 'Retainer Made By']), { status: 0, name: 1, made_by: 2 }, 'any order');
  assert.equal(findRetainerHeader([['Retainer Record'], [], ['', 'Patient name', 'Impression Date']]), 2);
  assert.equal(findRetainerHeader([['Name', 'Phone']]), -1, 'a name alone is not this sheet');
});

// A Karachi tab as the CSV download gives it: a header row, then made-up people.
const KARACHI = [
  ['', 'Patient name', 'Impression Date', 'Model Check By', 'Retainer Made By', 'Retainer Date', 'Status', 'retainer sheet', 'Payments'],
  ['', 'Sample Patient One', '04/08/2025', 'dr. sample checker', 'Maker Alpha', '15/04/2025', 'Delivered to Patient', '', ''],
  ['', 'Sample Patient Two', '15/04/2025', 'Dr. Sample Checker', 'maker  beta', '17-04-2025', 'Retainer Made', 'Re-purchase needed', 'paid'],
  ['0300-5550103', 'Sample Patient Three', '19\\-04-2025', 'Checker Gamma', 'Maker Alpha', '24-04=2025', 'Impression Repeat', 're purchase needed', 'Unpaid'],
  ['', '', '', '', '', '', '', '', ''],
  ['', ' - ', '20-04-2025', '', 'Maker Alpha', '', '', '', ''],
  [3005550105, 'Sample Patient Five', '17-05--20225', '', 'Maker Beta', '11-06-25', 'Waiting for sheet', '', 'FOC'],
  ['', 'Sample Patient Six', 'soon', '', '', '09-07-20256', '', '', ''],
  ['', 'Sample Patient Seven', '12-12-2026', '', '', '', '', '', ''],
];

test('a Karachi tab: rows, dates, names, statuses and what the page warns about', () => {
  const r = readRetainerTab(KARACHI, { today: TODAY });
  assert.equal(r.missing, undefined);
  assert.equal(r.rows.length, 6, 'six people; the blank row is passed over, the row without a name is skipped');
  assert.deepEqual(r.skipped, [{ row: 6, reason: 'No patient name' }]);
  const [one, two, three, five, six, seven] = r.rows;
  assert.deepEqual(one, { row: 2, mr: null, name: 'Sample Patient One', contact: null, impression_date: '2025-04-08', impression_text: null, model_check: 'Dr. Sample Checker',
    made_by: 'Maker Alpha', retainer_date: '2025-04-15', retainer_text: null, status: 'Delivered to patient', retainer_sheet: null, payment: null, notes: null });
  assert.equal(two.made_by, 'Maker Beta', 'all-small "maker  beta" is the same person as "Maker Beta"');
  assert.equal(two.status, 'Retainer made');
  assert.equal(two.retainer_sheet, 'Re-purchase needed');
  assert.equal(two.payment, 'Paid');
  assert.equal(three.contact, '0300-5550103', 'a phone in the first column is the contact');
  assert.equal(three.mr, null);
  assert.equal(three.impression_date, '2025-04-19');
  assert.equal(three.retainer_date, '2025-04-24');
  assert.equal(three.retainer_sheet, 'Re-purchase needed', '"re purchase needed" is the list\'s "Re-purchase needed"');
  assert.equal(three.payment, 'Pending', 'Unpaid is Pending');
  assert.equal(five.contact, '03005550105');
  assert.equal(five.impression_date, '2025-05-17', 'the slipped year 20225 is 2025 among 2025 rows');
  assert.equal(five.retainer_date, '2025-06-11');
  assert.equal(five.status, 'Waiting for sheet', 'a status not on the list is kept as written');
  assert.equal(five.payment, 'Free');
  assert.equal(six.impression_date, null);
  assert.equal(six.impression_text, 'soon', 'an unreadable date keeps its text');
  assert.equal(six.retainer_date, '2025-07-09', '20256 among 2025 rows is 2025');
  assert.equal(seven.impression_date, '2026-12-12');
  assert.deepEqual(r.unreadable, [{ row: 8, field: 'impression', text: 'soon' }]);
  assert.deepEqual(r.future, [{ row: 9, field: 'impression', iso: '2026-12-12' }], 'a date after today is pointed out');
  assert.deepEqual(r.guessed.map((g: any) => [g.row, g.field, g.iso]), [[2, 'impression', '2025-04-08'], [7, 'impression', '2025-05-17'], [8, 'retainer_date', '2025-07-09']]);
  assert.deepEqual(r.summary.models, { 'Dr. Sample Checker': 2, 'Checker Gamma': 1 });
  assert.deepEqual(r.summary.makers, { 'Maker Alpha': 2, 'Maker Beta': 2 });
  assert.deepEqual(r.summary.unknownStatuses, { 'Waiting for sheet': 1 });
  assert.equal(r.summary.perStatus['Delivered to patient'], 1);
  assert.equal(r.summary.from, '2025-04-08');
  assert.equal(r.summary.to, '2025-07-09', 'the months on the tab leave out the date after today');
});

test('a Lahore tab from its CSV text: no years, a contact column, a sure date further down', () => {
  const csv = 'Contact #,Patient Name,Impression Date,Model Check By,Retainer Made By,Retainer Date,Status\n'
    + '0300-5550201,Sample Lahore One,20- November,Dr. Sample Checker,Maker Lahore,28 november,Delivered to Patient\n'
    + '0300-5550202,Sample Lahore Two,23rd december,Dr. Sample Checker,Maker Lahore,2 jan,Retainer Made\n'
    + '0300-5550203,Sample Lahore Three,16March,,Maker Lahore,,\n'
    + '0300-5550204,Sample Lahore Four,23/5/26,,,,\n'
    + '0300-5550205,Sample Lahore Five,11 feburary,,,,\n';
  const r = readRetainerTab(parseCSV(csv), { today: TODAY });
  assert.deepEqual(r.rows.map((x: any) => [x.impression_date, x.retainer_date]), [
    ['2025-11-20', '2025-11-28'], ['2025-12-23', '2026-01-02'], ['2026-03-16', null], ['2026-05-23', null], ['2026-02-11', null]]);
  assert.equal(r.rows[0].contact, '0300-5550201');
  assert.equal(r.rows[0].status, 'Delivered to patient');
  // The last row, typed after May 2026, is a row out of order three months back (February 2026), not February 2027: a month name
  // starts a new year only when the months go back by half a year or more (December, then January).
  assert.deepEqual(r.future, []);
});

// The real Karachi tab's layout (made-up rows): no headings for the Mr# and the name, Mr#s with and without a leading 0, the
// sheet's wording for statuses and payments, team names in small letters, and treatment text typed into Status.
const KARACHI_REAL = [
  ['Sample', 'Column 2', 'Impression Date', 'Model Check By', 'Retainer Made By', 'Retainer Date ', 'Status', 'retainer sheet', 'Payments'],
  ['082', 'Sample Real One', '15/04/2025', 'syed sample', 'maker alpha', '20/04/2025', 'Delivered to Patient', '', 'Payment Done'],
  ['', 'Sample Real Two', '16/04/2025', 'Syed Sample', 'Maker Alpha', '', 'Model Poured', '', 'Dues'],
  ['6620', 'Sample Real Three', '17/04/2025', 'Syed Sample', 'maker beta', '', 'Upper wire changed, lower bonded on 14/9', '', ''],
  ['123-4', 'Sample Real Four', '18/04/2025', '', 'Maker Beta', '', 'Impression Repeat', 'Re-purchase needed', ''],
  ['3005550199', 'Sample Real Five', '19/04/2025', '', '', '', '', '', ''],
];

test('the real Karachi layout: Mr# and name by position, Model Poured, Payment Done / Dues, Status text to the notes', () => {
  const r = readRetainerTab(KARACHI_REAL, { today: TODAY });
  assert.equal(r.missing, undefined, 'the tab is read');
  assert.equal(r.byPosition, true);
  assert.deepEqual(r.columns, { impression: 2, model_check: 3, made_by: 4, retainer_date: 5, status: 6, retainer_sheet: 7, payment: 8, mr: 0, name: 1 });
  assert.equal(r.rows.length, 5);
  const [one, two, three, four, five] = r.rows;
  assert.deepEqual([one.mr, two.mr, three.mr, four.mr, five.mr], ['082', null, '6620', '123-4', null], 'the Mr# as typed, leading 0 kept');
  assert.equal(five.contact, '03005550199', 'a phone typed in the Mr# column is the contact');
  assert.deepEqual([one.status, two.status, three.status, four.status], ['Delivered to patient', 'Model poured', null, 'Impression repeat']);
  assert.equal(three.notes, 'Upper wire changed, lower bonded on 14/9', 'the treatment text typed into Status is in the notes');
  assert.deepEqual(r.statusNotes, [{ row: 4, text: 'Upper wire changed, lower bonded on 14/9' }]);
  assert.deepEqual(r.summary.unknownStatuses, {}, 'nothing left that is not on the list');
  assert.deepEqual([one.payment, two.payment, three.payment], ['Paid', 'Pending', null], 'Payment Done is Paid, Dues is Pending');
  assert.equal(four.retainer_sheet, 'Re-purchase needed');
  assert.deepEqual(r.summary.models, { 'Syed Sample': 3 }, '"syed sample" and "Syed Sample" are one person, with capitals');
  assert.deepEqual(r.summary.makers, { 'Maker Alpha': 2, 'Maker Beta': 2 });
  assert.deepEqual(r.summary.mr, { given: 3, linkable: 2 }, 'three Mr# cells, two of them Mr#s ("123-4" is not)');
});

test('a date far from the rows around it (a slip in the year) is pointed out, also in a run, also at the bottom of the tab', () => {
  const day = (n) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);
  const col = [...Array.from({ length: 15 }, (_, i) => day(i * 7)), ...Array.from({ length: 6 }, (_, i) => `2024-0${8 + (i % 2)}-1${i}`), day(110), day(112), null, day(115)];
  assert.deepEqual(farFromNeighbours(col), [15, 16, 17, 18, 19, 20], 'the six 2024 dates among 2026 rows, not the 2026 rows below them');
  assert.deepEqual(farFromNeighbours(['2025-04-01', '2025-04-03', '2025-11-20', '2025-04-05', '2025-04-08', '2025-04-09']), [2]);
  assert.deepEqual(farFromNeighbours(['2025-04-01', '2025-11-20', '2025-04-05']), [], 'too few dates around to tell');
  const tab = [['', 'Patient name', 'Impression Date'], ...col.map((d, i) => ['', `Sample Far ${i}`, d ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : ''])];
  const r = readRetainerTab(tab, { today: TODAY });
  assert.equal(r.far.length, 6);
  assert.equal(r.summary.from, '2026-01-01', 'the months on the tab leave them out');
});

test('a tab without the header row says what is missing', () => {
  const r = readRetainerTab([['Name', 'Phone'], ['Sample', '0300']], { today: TODAY });
  assert.deepEqual(r.missing, ['Patient name', 'Impression date']);
  assert.deepEqual(r.rows, []);
});

test('the city of a tab: from the file or tab name (Google\'s "<sheet> - <tab>.csv"), else from its columns', () => {
  const cities = [{ id: 1, name: 'Karachi' }, { id: 2, name: 'Lahore' }, { id: 3, name: 'Islamabad' }];
  const city = (o) => tabCityHint(o, cities)?.cityId ?? null;
  assert.equal(city({ name: 'Retainer Record - Lahore.csv' }), 2);
  assert.equal(city({ name: 'Retainer Record - Karachi.csv' }), 1);
  assert.equal(city({ name: 'lahore retainers.CSV' }), 2);
  assert.equal(city({ name: 'Karachi and Lahore - Lahore.csv' }), 2, 'the tab\'s part of the name wins');
  assert.equal(city({ name: 'Karachi and Lahore.csv' }), null, 'two cities named: nothing said');
  assert.equal(city({ name: 'Retainer Record - Sheet1.csv' }), null);
  assert.equal(city({ name: 'Lahorean.csv' }), null, 'whole words only');
  assert.equal(tabCityHint({ name: 'Retainer Record - Lahore.csv' }, cities).why, 'its name says Lahore');
  // The columns, as the reader finds them on the two tabs.
  const karachi = readRetainerTab([['Sample', 'Column 2', 'Impression Date', 'Model Check By', 'Retainer Made By', 'Retainer Date ', 'Status', 'retainer sheet', 'Payments'],
    ['082', 'Sample One', '08-04-2025', '', 'Maker A', '', '', '', '']], { today: TODAY });
  const lahore = readRetainerTab([['Contact #', 'Patient Name ', 'Impression Date', 'Model Check By', 'Retainer Made By', 'Retainer Date ', 'Status'],
    ['', 'Sample Two', '20- November', '', 'Maker B', '', '']], { today: TODAY });
  assert.equal(city({ name: 'retainers.csv', columns: karachi.columns }), 1, 'the Mr# column: Karachi');
  assert.equal(city({ columns: lahore.columns }), 2, '"Contact #" and no Mr#: Lahore');
  assert.equal(city({ name: 'Retainer Record - Karachi.csv', columns: lahore.columns }), 1, 'the name comes first');
  assert.equal(city({ columns: { name: 0, impression: 1 } }), null);
});
