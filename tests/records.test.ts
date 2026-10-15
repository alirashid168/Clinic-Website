// Retainer Record and Lab Work: the shared lists and rules (web/js/lib/records.js), and the demo's copy of a sheet tab (data/demo-records.js,
// the same rules as the database). Made-up rows and names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  PALETTE, colourKey, colourClass, MAKER_COLOURS, STRONG_COLOURS, LIGHT_COLOURS, DEFAULT_RETAINER_STATUSES, LAB_STATUSES, cleanList, retainerStatuses, labWorkTypes,
  findOption, canonicalOption, statusMeans, teamFor, sheetOrder, newestFirst, rowMonth, rowMatches, bannerCounts, bannerTeam, topMakers, pickColour, teamNameKey,
  friendlyLine, labOverdue, monthName, mrKey, nameFits, checkState, checkOverdue, checkDue, CHECK_SOON_DAYS,
} from '../web/js/lib/records.js';
import { recordsDemo } from '../web/js/data/demo-records.js';
import { recordsLive } from '../web/js/data/supabase-records.js';
import { friendlyError, todayISO, addMonthsISO, addDaysISO } from '../web/js/ui/dom.js';

const MIGRATION = fs.readFileSync(new URL('../supabase/migrations/20261012000200_retainer_lab_records.sql', import.meta.url), 'utf8');
const sqlList = (name) => (new RegExp(`${name} text\\[\\] := array\\[([^\\]]*)\\]`).exec(MIGRATION)?.[1] || '').split(',').map((x) => x.trim().replace(/'/g, ''));

test('the palette, the makers\' colours and the lists are the same as the database\'s', () => {
  const keys = PALETTE.map((p) => p.key);
  assert.equal(keys.length, 18);
  for (const k of keys) assert.match(MIGRATION, new RegExp(`'${k}'`), k);
  assert.deepEqual(sqlList('v_strong'), STRONG_COLOURS, 'the strong colours, in the same order as the copy gives them');
  assert.deepEqual(sqlList('v_light'), LIGHT_COLOURS, 'the light colours, in the same order');
  assert.deepEqual([...MAKER_COLOURS].sort(), keys.filter((k) => k !== 'grey' && k !== 'purple').sort(), 'every colour but light grey and deep purple goes to makers');
  assert.ok(STRONG_COLOURS.every((k) => PALETTE.find((p) => p.key === k).dark) && LIGHT_COLOURS.every((k) => !PALETTE.find((p) => p.key === k).dark),
    'the strong ones are the dark chips (white text), the light ones the light chips');
  for (const s of DEFAULT_RETAINER_STATUSES) assert.match(MIGRATION, new RegExp(`"label": "${s.label}", "colour": "${s.colour}"`), s.label);
  assert.deepEqual(DEFAULT_RETAINER_STATUSES.slice(1, 4).map((s) => s.label), ['Model checked', 'Model poured', 'Retainer made'], '"Model poured" in its place, as in the database');
  assert.match(MIGRATION, /status in \('sent', 'in_lab', 'received', 'fitted', 'remake', 'cancelled'\)/);
  assert.deepEqual(LAB_STATUSES.map((s) => s.value), ['sent', 'in_lab', 'received', 'fitted', 'remake', 'cancelled']);
  assert.equal(colourKey('black'), 'black');
  assert.equal(colourKey('hotpink'), 'grey', 'an unknown colour is grey');
  assert.equal(colourClass('"><x'), 'c-grey', 'never a class name from outside the palette');
});

test('lists from the settings: cleaned, defaults when missing', () => {
  assert.equal(retainerStatuses({}).length, 8);
  assert.equal(retainerStatuses({ retainer_statuses: 'broken' }).length, 8);
  assert.deepEqual(retainerStatuses({ retainer_statuses: [{ label: ' Done ', colour: 'nope', means: 'delivered' }, { label: 'done' }, { label: '' }, { label: 'Off', active: false }] }),
    [{ label: 'Done', colour: 'grey', means: 'delivered', active: true }, { label: 'Off', colour: 'grey', means: '', active: false }]);
  assert.equal(labWorkTypes({}).length, 9);
  assert.deepEqual(cleanList(['Crown', 'crown', 'Bridge'], []).map((x: any) => x.label), ['Crown', 'Bridge']);
});

test('matching typed values to a list', () => {
  const list = retainerStatuses({});
  assert.equal(findOption(list, 'delivered TO patient')?.label, 'Delivered to patient');
  assert.equal(canonicalOption(list, 'retainer made'), 'Retainer made');
  assert.equal(canonicalOption(list, ' Something new '), 'Something new');
  assert.equal(canonicalOption(list, '  '), null);
  assert.equal(statusMeans(list, 'Delivered to Patient'), 'delivered');
  assert.equal(statusMeans(list, 'Retainer made'), 'made');
  assert.equal(statusMeans(list, 'Unknown'), '');
});

test('team members for a drop-down; a name compared as the database does', () => {
  const team = [
    { id: 'a', name: 'Maker A', role: 'maker', city_id: 1, active: true }, { id: 'b', name: 'Both B', role: 'both', city_id: null, active: true },
    { id: 'c', name: 'Checker C', role: 'model_check', city_id: null, active: true }, { id: 'd', name: 'Left D', role: 'maker', city_id: 1, active: false },
    { id: 'e', name: 'Lahore E', role: 'maker', city_id: 2, active: true },
  ];
  assert.deepEqual(teamFor(team, { role: 'maker', cityId: 1 }).map((m) => m.id), ['a', 'b']);
  assert.deepEqual(teamFor(team, { role: 'model_check', cityId: 2 }).map((m) => m.id), ['b', 'c']);
  assert.deepEqual(teamFor(team, { role: 'maker', cityId: 1, includeId: 'd' }).map((m) => m.id), ['a', 'b', 'd'], 'the row\'s own member stays even when switched off');
  assert.equal(teamNameKey('  Sample   maker A '), teamNameKey('sample Maker a'), 'any spacing and capitals: one name (the unique name on the team)');
  assert.notEqual(teamNameKey('Sample Maker'), teamNameKey('Sample Makers'));
});

test('order, months and search', () => {
  const rows = [
    { id: '1', source: 'website', created_at: '2026-10-02T10:00:00Z' }, { id: '2', source: 'sheet_import', source_row: 10, created_at: '2026-10-01T00:00:00Z' },
    { id: '3', source: 'sheet_import', source_row: 2, created_at: '2026-10-01T00:00:00Z' }, { id: '4', source: 'website', created_at: '2026-10-01T09:00:00Z' },
    { id: '5', source: 'website', source_row: 5, created_at: '2026-09-20T00:00:00Z' },
  ];
  assert.deepEqual([...rows].sort(sheetOrder).map((r) => r.id), ['3', '5', '2', '4', '1'], 'sheet rows (and a row an undo kept) by their row, then website rows as added');
  assert.deepEqual([...rows].sort(newestFirst).map((r) => r.id), ['1', '4', '2', '5', '3']);
  assert.equal(rowMonth({ impression_date: '2025-04-08' }), '2025-04');
  assert.equal(rowMonth({ impression_date: null, retainer_date: '2025-05-01' }), '2025-05');
  assert.equal(rowMonth({}), '');
  assert.equal(monthName('2026-10'), 'October 2026');
  const row = { patient_name: 'Sample Patient', contact: '0300-5550101', patient: { full_name: 'Sample Linked', mr_number: '9811', phone: '+92 300 5550199' } };
  assert.ok(rowMatches(row, 'sample pat'));
  assert.ok(rowMatches(row, 'linked'));
  assert.ok(rowMatches(row, '9811'));
  assert.ok(rowMatches(row, '5550101'));
  assert.ok(rowMatches(row, '923005550199'));
  assert.ok(!rowMatches(row, '555'), 'three digits are not a phone search');
  assert.ok(!rowMatches(row, 'nobody'));
  const typed = { patient_name: 'Sample Unlinked', mr_text: '082' };
  assert.ok(rowMatches(typed, '082') && rowMatches(typed, '82') && rowMatches(typed, 'Mr# 082'), 'the Mr# typed on the sheet, with or without its leading 0');
  assert.ok(!rowMatches(typed, '820'));
});

test('the Mr# typed on the sheet and the name-fit rule (the same cases as private.aaj_name_fits in SQL test 25)', () => {
  assert.equal(mrKey('082'), '82');
  assert.equal(mrKey(' 6620 '), '6620');
  for (const v of ['123-4', '000', 'abc', '', null, '12345678']) assert.equal(mrKey(v), null, String(v));
  for (const [t, f] of [['Ayesha Khan', 'Ayesha Khan'], ['Ayesha', 'Ayesha Khan'], ['Saima Akhtar', 'Saima Bibi Akhtar'], ['Asif Ali Khan', 'Asif Ali'], ['Muhammad Umer', 'Umer'],
    ['Syed Ali Raza', 'Ali Raza'], ['Bilal Ahmad', 'Bilal Ahmed'], ['Maryam Bibi', 'Mariam Bibi'], ['Eman Ali', 'Iman Ali'], ['AYESHA  KHAN', 'ayesha khan'],
    ['Usman', 'Usman Tariq'], ['M Usman', 'Muhammad Usman Tariq'], ['Usman Tariq', 'Muhammad Usman Tariq'], ['Md. Usman', 'Muhammad Usman'], ['Mohd Usman', 'Muhammad Usman'],
    ['Mohammed Usman', 'Muhammad Usman'], ['Mr Ali Raza', 'Ali Raza'], ['Sayed Ali Raza', 'Syed Ali Raza'], ['Usman', 'Muhammad Usman'], ['Dr. Sana Khan', 'Sana Khan'],
    ['Ali Hassan Raza Khan Niazi', 'Ali Hassan Raza Khan Niazi'], ['ali hassan raza khan  niazi.', 'Ali Hassan Raza Khan Niazi']]) assert.ok(nameFits(t, f), `${t} fits ${f}`);
  for (const [t, f] of [['Ayesha Rajpoot', 'Ayesha Khan'], ['Ayesh Khan', 'Ayesha Khan'], ['Rana Asif Ali', 'Asif Ali'], ['Farooq Umer', 'Umer Farooq'], ['Malik Asif', 'Asif Mehmood'],
    ['Ali Hassan Raza', 'Hassan Raza'], ['Umair Farooq', 'Umar Farooq'], ['Umair Farooq', 'Umer Farooq'], ['Hussain Raza', 'Hassan Raza'], ['Rizwana Khan', 'Rizwan Khan'],
    ['Shahida Khan', 'Shahid Khan'], ['Alia Raza', 'Ali Raza'], ['Sania Ali', 'Sana Ali'], ['Kashaf Ali', 'Kashif Ali'], ['Zara Khan', 'Sara Khan'], ['Faisal Khan', 'Fazal Khan'],
    ['Nadia Khan', 'Nida Khan'], ['Saeed Ali', 'Saad Ali'], ['Ehsan Ali', 'Ahsan Ali'], ['Qq Ayesha Bilal Fatima Sana', 'Ayesha Khan'], ['بلال', 'بلال'], ['', 'Sana'],
    ['Khan', 'Ayesha Khan'], ['Muhammad Usman', 'Usman Tariq'], ['Hafiz Bilal', 'Bilal Ahmed'], ['Syed Ali', 'Ali Raza'], ['Syeda Fatima', 'Fatima Noor'], ['Baby Ayesha', 'Ayesha Khan'],
    ['Usman Tariq', 'Muhammad Usman'], ['M. Usman', 'Usman Tariq'], ['Usman Muhammad', 'Usman Tariq'], ['Haji Aslam', 'Aslam Pervaiz'],
    ['Ali Hassan Raza Khan Niazi', 'Ali Hassan Raza Khan']]) assert.ok(!nameFits(t, f), `${t} does not fit ${f}`);
});

test('the banner: this month\'s and all time\'s numbers per person, so it never opens with only zeros; who is shown', () => {
  const statuses = retainerStatuses({});
  const rows = [
    { made_by: 'a', retainer_date: '2026-10-03', status: 'Retainer made' },
    { made_by: 'a', retainer_date: '2026-10-04', delivered_date: '2026-10-09', status: 'Delivered to patient' },
    { made_by: 'b', retainer_date: '2026-09-28', delivered_date: '2026-10-01', status: 'Delivered to patient' },
    { made_by: 'b', retainer_date: '2026-10-02', status: 'Delivered to patient' },
    { made_by: 'b', retainer_date: '2026-10-05', status: 'Cancelled' },
    { made_by: null, retainer_date: '2026-10-06', status: 'Retainer made' },
    // copied from the sheet: delivered long ago, most with no retainer date
    { made_by: 'a', status: 'Delivered to patient' }, { made_by: 'a', status: 'Delivered to patient' }, { made_by: 'a', retainer_date: '2025-06-10', status: 'Delivered to patient' },
    { made_by: 'a', status: 'Impression taken' }, { made_by: 'a', status: 'Cancelled' },
  ];
  const c = bannerCounts(rows, statuses, '2026-10');
  assert.deepEqual(c.byMember.a, { made: 2, delivered: 1, checked: 0, allMade: 5, allDelivered: 4, allChecked: 0 },
    'a: 2 made this month; all time 5 made (a status that means made or delivered counts without a retainer date; a row not made yet and a cancelled one do not)');
  assert.deepEqual(c.byMember.b, { made: 1, delivered: 2, checked: 0, allMade: 2, allDelivered: 2, allChecked: 0 });
  assert.deepEqual([c.made, c.delivered, c.allMade, c.allDelivered], [4, 3, 8, 6], 'the tab\'s numbers, this month and all time (cancelled rows left out)');
  const october = bannerCounts(rows.filter((r) => !String(r.retainer_date || '').startsWith('2026-10') && !String(r.delivered_date || '').startsWith('2026')), statuses, '2026-10');
  assert.deepEqual([october.byMember.a.made, october.byMember.a.allMade], [0, 3], 'right after a copy (nothing this month yet), the chip still has its all-time number');
  const checked = bannerCounts([{ model_check_by: 'k', impression_date: '2026-10-02' }, { model_check_by: 'k', impression_date: '2026-09-30', retainer_date: '2026-10-03' },
    { model_check_by: 'k', retainer_date: '2026-10-04' }, { model_check_by: 'k', impression_date: '2025-01-04' }], statuses, '2026-10');
  assert.deepEqual(checked.byMember.k, { made: 0, delivered: 0, checked: 2, allMade: 0, allDelivered: 0, allChecked: 4 },
    'a model checker: the models checked this month (by the impression date, else the retainer date) and all time');
  const team = [{ id: 'k', name: 'K', role: 'model_check', active: true, featured: true }, { id: 'a', name: 'A', role: 'maker', active: true },
    { id: 'b', name: 'B', role: 'both', active: true, featured: true }, { id: 'z', name: 'Z', role: 'maker', active: true }];
  assert.deepEqual(bannerTeam(team, rows, 1).map((m) => m.id), ['b', 'k'], 'the members marked "In the banner": makers first, then model checkers');
  team[0].featured = false; team[2].featured = false;
  const tabRows = rows.map((r) => ({ ...r, city_id: 1 }));
  assert.deepEqual(bannerTeam(team, tabRows, 1).map((m) => m.id), ['a', 'b'], 'otherwise the most active makers of the tab (topMakers)');
  assert.equal(friendlyLine('2026-10-12'), friendlyLine('2026-10-12'));
  assert.notEqual(friendlyLine('2026-10-12'), friendlyLine('2026-10-13'));
});

test('the most active makers of a tab (the same people private.retainer_top_makers picks; SQL test 32 part 12 copies the same tab)', () => {
  const plan = ['one', 'one', 'one', 'one', 'one', 'one', 'one', 'two', 'two', 'two', 'three', 'four'];
  const rows = plan.map((maker) => ({ city_id: 3, made_by: maker, model_check_by: 'checker', status: 'Delivered to patient' }));
  const member = (id, role, extra = {}) => ({ id, name: `Sample Isb Maker ${id}`, role, active: true, city_id: 3, ...extra });
  const team = [member('one', 'maker'), member('two', 'maker'), member('three', 'maker'), member('four', 'maker'), member('checker', 'model_check')];
  assert.deepEqual(topMakers(rows, team, 3), ['one', 'two'], '7 and 3 of 12 rows: a fifth or more each; 1 of 12 is not enough; a model checker is no maker');
  assert.deepEqual(topMakers(rows, team.map((m) => (m.id === 'two' ? { ...m, active: false } : m)), 3), ['one'], 'only active members');
  assert.deepEqual(topMakers(rows, team.map((m) => ({ ...m, city_id: 1 })), 3), [], 'only members who work in the city');
  assert.deepEqual(topMakers(rows, team, 1), [], 'only the city\'s own rows');
  const even = Array.from({ length: 10 }, (_, i) => ({ city_id: 3, made_by: ['one', 'two', 'three', 'four', 'checker'][i % 5] }));
  assert.deepEqual(topMakers(even, team.map((m) => ({ ...m, role: 'both' })), 3), ['checker', 'four', 'one'], 'at most three (the same counts: by name)');
  assert.deepEqual(topMakers([], team, 3), []);
});

test('the colour for a maker: the most active the strong colours, the others the light ones, each one nobody has; light grey never', () => {
  const team: any[] = [{ id: 'k', name: 'Sample Checker', role: 'model_check', colour: 'purple', city_id: 1, active: true }];
  const add = (id, top, cityId = 1) => { const m = { id, name: id, role: 'maker', colour: 'grey', city_id: cityId, active: true }; team.push(m); m.colour = pickColour(team, { id, cityId, top }); return m.colour; };
  assert.deepEqual([add('Sample Top One', true), add('Sample Top Two', true), add('Sample Top Three', true)], ['navy', 'forest', 'plum'], 'three most active makers: three different strong colours');
  assert.deepEqual([add('Sample Other One', false), add('Sample Other Two', false)], ['amber', 'rose'], 'the others: light colours');
  assert.equal(add('Sample Lahore Top', true, 2), 'ocean', 'another city\'s top maker: a strong colour nobody has anywhere');
  team.find((m) => m.id === 'Sample Top One').active = false;
  assert.equal(pickColour(team, { id: 'x', cityId: 1, top: true }), 'navy', 'the colour of someone who left is free again');
  const full = MAKER_COLOURS.map((c, i) => ({ id: `m${i}`, colour: c, city_id: 1, active: true }));
  assert.equal(pickColour(full, { id: 'new', cityId: 1, top: false }), 'amber', 'every colour taken: the first of its list, still never light grey');
  for (const top of [true, false]) assert.notEqual(pickColour([], { top }), 'grey');
});

// The demo's copy (data/demo-records.js) follows public.import_retainer_records: here on a made-up database with no team yet.
function demoWith(patients) {
  const db: any = { cities: [{ id: 1, name: 'Karachi' }, { id: 3, name: 'Islamabad' }], branches: [], retainer_cases: [], retainer_team: [], patients, settings: {} };
  let n = 0;
  const api = recordsDemo({ db: () => db, me: () => ({ id: 's-admin', role: 'admin', active: true, branch_ids: [] }), can: () => true, need: () => {}, branchOk: () => true,
    clone: (x) => JSON.parse(JSON.stringify(x)), fail: (m) => { throw new Error(m); }, uid: () => `id-${++n}`, audit: () => {}, patient: (id) => patients.find((p) => p.id === id) });
  return { db, api };
}
const wire = (row, name, extra: any = {}) => ({ row, name, impression_date: `2025-06-${String(row).padStart(2, '0')}`, model_check: 'sample checker', made_by: 'Maker One', ...extra });

test('the demo and the live data layer have the same Retainer Record and Lab work methods', () => {
  const demo = Object.keys(demoWith([]).api).sort();
  const live = Object.keys(recordsLive({ sb: {}, check: (x) => x, fetchPaged: async () => [], attachPatients: async (x) => x, plainError: (m) => new Error(m) })).sort();
  assert.deepEqual(demo, live);
  assert.ok(demo.includes('undoRetainerCopy') && demo.includes('retainerCopies'));
});

test('the demo copy: the whole tab at once, the Mr# linked only when the name fits, the colours and the banner; the dry run says the same and keeps nothing', async () => {
  const { db, api } = demoWith([{ id: 'p1', mr_number: '73201', full_name: 'Hamna Sampleton' }, { id: 'p2', mr_number: '73202', full_name: 'Zoha Sampleton' }]);
  const rows = [wire(2, 'Hamna Sampleton', { mr: '073201' }), wire(3, 'Minahil Sampleton', { mr: '73202' }), wire(4, 'Rida Sampleton', { mr: '73203', made_by: 'Maker Two' }),
    wire(5, 'Sameen Sampleton', { mr: '732-1' }), wire(6, 'Ifrah Sampleton'), wire(7, ' - '), wire(3, 'Sample Twice')];
  const check = await api.retainerMrCheck(rows.filter((r) => r.mr).map(({ row, mr, name }) => ({ row, mr, name })));
  assert.deepEqual(check, { given: 4, linked: 1, name_differs: 1, not_found: 1, not_an_mr: 1,
    rows: [{ row: 2, outcome: 'linked' }, { row: 3, outcome: 'name_differs' }, { row: 4, outcome: 'not_found' }, { row: 5, outcome: 'not_an_mr' }] });
  const dry = await api.importRetainerRecords(3, rows, { dryRun: true });
  assert.deepEqual([db.retainer_cases.length, db.retainer_team.length], [0, 0], 'the dry run kept no row and no team name');
  const r = await api.importRetainerRecords(3, rows);
  assert.deepEqual({ ...r, dry_run: true }, dry, 'the dry run said exactly what the copy did');
  assert.deepEqual([r.given, r.inserted, r.skipped_count], [7, 5, 2]);
  assert.deepEqual(r.skipped.map((x) => x.reason), ['No patient name', 'The same sheet row is in the tab twice']);
  assert.deepEqual([r.mr_given, r.linked, r.not_linked], [4, 1, 3]);
  assert.deepEqual(r.not_linked_why, { name_differs: 1, not_found: 1, not_an_mr: 1 });
  assert.deepEqual(r.top_makers, ['Maker One', 'Maker Two'], 'Maker One (4 of 5 rows) and Maker Two (1 of 5: a fifth)');
  assert.deepEqual(r.team_featured, ['Maker One', 'Maker Two'], 'nobody was in the banner: the most active makers go there');
  assert.deepEqual(r.team_colours, [{ name: 'Maker One', colour: 'navy', top: true }, { name: 'Maker Two', colour: 'forest', top: true }]);
  assert.equal(db.retainer_team.find((m) => m.name === 'Sample Checker').colour, 'purple', 'the model checker is deep purple');
  assert.ok(!db.retainer_team.some((m) => m.colour === 'grey'), 'nobody is light grey');
  const row2 = db.retainer_cases.find((x) => x.source_row === 2);
  assert.deepEqual([row2.patient_id, row2.mr_text, row2.linked_by_hand, row2.edited_on_site], ['p1', '073201', false, false], 'linked by the copy, not by hand, not changed');
  assert.equal(db.retainer_cases.find((x) => x.source_row === 3).patient_id, null);
});

test('the demo copy: a second copy of a city is refused in plain words, also when the same call comes again; nothing is added twice', async () => {
  const { db, api } = demoWith([]);
  const rows = [wire(2, 'Sample Asad'), wire(3, 'Sample Bilal'), wire(4, 'Sample Cyrus')];
  await api.importRetainerRecords(1, rows);
  const before = JSON.stringify(db);
  const plain = /^Karachi was already copied on \d{1,2} [A-Z][a-z]{2} \d{4} \(3 retainers\)\. The website is now the Retainer Record: add or change retainers there\.$/;
  for (const again of [() => api.importRetainerRecords(1, rows), () => api.importRetainerRecords(1, rows, { dryRun: true }), () => api.importRetainerRecords(1, [wire(9, 'Sample Late')])]) {
    const e = await again().then(() => null, (x) => x);
    assert.ok(e && /^ALREADY_COPIED: /.test(e.message), 'refused');
    assert.match(friendlyError(e), plain, 'and said in plain words');
  }
  assert.equal(JSON.stringify(db), before, 'nothing changed: no row twice, no team name');
  assert.equal((await api.importRetainerRecords(3, [wire(2, 'Sample Asad')])).inserted, 1, 'another city is its own copy');
});

test('the demo: rows changed on the website are marked; "Undo the copy" takes back the rest; a corrected copy leaves out the rows that stayed', async () => {
  const { db, api } = demoWith([{ id: 'p1', mr_number: '73201', full_name: 'Hamna Sampleton' }]);
  await api.importRetainerRecords(1, [wire(2, 'Sample Edited'), wire(3, 'Sample Linked'), wire(4, 'Sample Paid'), wire(5, 'Sample Untouched'), wire(6, 'Sample Saved Same')]);
  const at = (row) => db.retainer_cases.find((x) => x.source_row === row);
  await api.updateRetainerRecord(at(2).id, { notes: 'Upper only' });
  await api.updateRetainerRecord(at(3).id, { patient_id: 'p1' });
  await api.updateRetainerRecord(at(4).id, { payment: 'Paid' });
  await api.updateRetainerRecord(at(6).id, { status: at(6).status, notes: at(6).notes });
  assert.deepEqual([2, 3, 4, 5, 6].map((r) => [at(r).edited_on_site, at(r).linked_by_hand]), [[true, false], [true, true], [true, false], [false, false], [false, false]],
    'a note, a link and a payment are changes (the link by hand too); a save that changes nothing is none');
  const karachiToday = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
  assert.deepEqual(await api.retainerCopies(), [{ city_id: 1, city: 'Karachi', copied_on: karachiToday, retainers: 5, changed: 3, kept: 0 }], 'copied today (Karachi), 5 rows, 3 changed');
  const ask = await api.undoRetainerCopy(1, { dryRun: true });
  assert.deepEqual(ask, { city: 'Karachi', removed: 2, stayed: 3, dry_run: true });
  assert.equal(db.retainer_cases.length, 5, 'the question changes nothing');
  assert.deepEqual(await api.undoRetainerCopy(1), { city: 'Karachi', removed: 2, stayed: 3, dry_run: false });
  assert.deepEqual(db.retainer_cases.map((x) => [x.source, x.source_row, x.patient_name]).sort(),
    [['website', 2, 'Sample Edited'], ['website', 3, 'Sample Linked'], ['website', 4, 'Sample Paid']], 'the changed rows stay, as website rows that remember their sheet row');
  assert.deepEqual([at(2).notes, at(3).patient_id, at(4).payment], ['Upper only', 'p1', 'Paid'], 'with their changes');
  assert.deepEqual((await api.retainerCopies()).map((c) => [c.city, c.retainers, c.kept]), [['Karachi', 0, 3]]);
  await assert.rejects(api.undoRetainerCopy(1), /NOT_COPIED: Karachi has no copy of the sheet to undo\./);
  // The corrected tab: row 2 (stayed, the same name in other capitals) is left out; row 3 (stayed, not on the sheet now) and row 4 (stayed,
  // another name on its row now) find no sheet row of their name and are reported.
  const fixed = await api.importRetainerRecords(1, [wire(2, ' sample  EDITED '), wire(4, 'Sample Paid Fixed'), wire(5, 'Sample Untouched'), wire(6, 'Sample Saved Same')]);
  assert.deepEqual([fixed.inserted, fixed.kept, fixed.skipped_count], [3, 1, 1]);
  assert.deepEqual(fixed.kept_other, [{ row: 3, name: null, kept_name: 'Sample Linked' }, { row: 4, name: 'Sample Paid Fixed', kept_name: 'Sample Paid' }]);
  assert.deepEqual(fixed.kept_date_differs, [], 'row 2 has the same (no) date on both sides');
  assert.equal(db.retainer_cases.filter((x) => x.source_row === 2).length, 1, 'row 2 is on the Retainer Record once');
  await assert.rejects(api.importRetainerRecords(1, [wire(9, 'Sample Again')]), /ALREADY_COPIED: Karachi was already copied on .* \(3 retainers\)/);
});

test('the demo: after "Undo the copy", rows that moved up on the corrected sheet are not copied twice; a second line of one patient is; a fixed date still pairs', async () => {
  const { db, api } = demoWith([]);
  const names = ['Sample A', 'Sample B', 'Sample C', 'Sample D', 'Sample E', 'Sample F', 'Sample G', 'Sample H', 'Sample Twin', 'Sample Twin', 'Sample Same', 'Sample Same',
    'Sample Slip', 'Sample Dated'];
  const imps = ['2025-03-01', '2025-03-02', '2025-03-03', '2025-03-04', '2025-03-05', '2025-03-06', '2025-03-07', '2025-03-08', '2025-05-01', '2025-09-01', null, null,
    '2028-12-15', '2025-03-09'];
  const tab = names.map((n, i) => wire(i + 2, n, { impression_date: imps[i] }));
  await api.importRetainerRecords(1, tab);
  const at = (row) => db.retainer_cases.find((x) => x.source_row === row);
  await api.updateRetainerRecord(at(8).id, { notes: 'Delivered' });   // Sample G
  await api.updateRetainerRecord(at(10).id, { payment: 'Paid' });     // Sample Twin, the line of 1 May
  await api.updateRetainerRecord(at(12).id, { notes: 'Upper only' }); // Sample Same, the first line
  await api.updateRetainerRecord(at(14).id, { impression_date: '2025-12-15' }); // Sample Slip: the copy read a slipped year, fixed on the website
  await api.updateRetainerRecord(at(15).id, { payment: 'Paid' });     // Sample Dated (its date is corrected on the sheet below)
  assert.deepEqual(await api.undoRetainerCopy(1), { city: 'Karachi', removed: 9, stayed: 5, dry_run: false });
  // The corrected sheet: row 4 (Sample C) deleted, so every row below it is one up; the date of Sample Dated corrected; the date of the
  // second Twin line cleared (it now sits at the kept Twin row's old number: the line with the kept row's date still wins).
  const fixed = tab.map((x, j) => ({ ...x, impression_date: j === 9 ? null : x.name === 'Sample Dated' ? '2025-03-10' : x.impression_date }))
    .filter((x) => x.name !== 'Sample C').map((x, i) => ({ ...x, row: i + 2 }));
  const r = await api.importRetainerRecords(1, fixed);
  assert.deepEqual([r.inserted, r.kept, r.kept_other], [8, 5, []], 'each row that stayed leaves out one sheet row of its own, nothing to check by hand');
  assert.deepEqual(r.skipped.map((x) => x.row), [7, 9, 12, 13, 14], 'Sample G (now row 7), the Twin line of 1 May (now row 9), the nearest Same line (now row 12), Slip and Dated');
  assert.deepEqual(r.kept_date_differs, [{ row: 13, name: 'Sample Slip', kept_date: '2025-12-15', sheet_date: '2028-12-15' },
    { row: 14, name: 'Sample Dated', kept_date: '2025-03-09', sheet_date: '2025-03-10' }], 'a date fixed on either side still pairs, and is reported');
  const count = (n) => db.retainer_cases.filter((x) => x.patient_name === n).length;
  assert.deepEqual([db.retainer_cases.length, count('Sample G'), count('Sample C'), count('Sample Twin'), count('Sample Same'), count('Sample Slip'), count('Sample Dated')],
    [13, 1, 0, 2, 2, 1, 1], '13 rows for the 13 sheet rows: nobody twice by mistake, both lines of a patient with two');
  assert.deepEqual(db.retainer_cases.filter((x) => x.patient_name === 'Sample Twin').map((x) => [x.impression_date, x.payment ?? null]).sort(), [[null, null], ['2025-05-01', 'Paid']]);
});

test('the demo copy: a chosen colour stays, light grey is replaced, a city with somebody in the banner keeps its banner', async () => {
  const { db, api } = demoWith([]);
  db.retainer_team.push({ id: 'chosen', name: 'Sample Chosen', role: 'maker', colour: 'lime', city_id: 1, featured: false, active: true },
    { id: 'greyed', name: 'Sample Greyed', role: 'maker', colour: 'grey', city_id: 1, featured: false, active: true },
    { id: 'picked', name: 'Sample Picked', role: 'maker', colour: 'brown', city_id: 3, featured: true, active: true });
  const r = await api.importRetainerRecords(1, [1, 2, 3, 4].map((i) => wire(i + 1, `Sample Patient ${i}`, { made_by: 'Sample Chosen' }))
    .concat([5, 6, 7].map((i) => wire(i + 1, `Sample Patient ${i}`, { made_by: 'sample greyed' }))).concat([wire(9, 'Sample Patient 8', { made_by: 'Sample New' })]));
  assert.deepEqual(r.top_makers, ['Sample Chosen', 'Sample Greyed']);
  assert.deepEqual(r.team_colours, [{ name: 'Sample Greyed', colour: 'navy', top: true }, { name: 'Sample New', colour: 'amber', top: false }],
    'light grey (not chosen) becomes a strong colour; a new maker gets a light one');
  assert.equal(db.retainer_team.find((m) => m.id === 'chosen').colour, 'lime', 'a colour chosen in Clinic setup stays');
  assert.deepEqual(r.team_featured, ['Sample Chosen', 'Sample Greyed']);
  const isb = await api.importRetainerRecords(3, [wire(2, 'Sample Isb', { made_by: 'Sample Isb Top' }), wire(3, 'Sample Isb Two', { made_by: 'Sample Isb Top' })]);
  assert.deepEqual([isb.team_featured, isb.team_colours], [[], [{ name: 'Sample Isb Top', colour: 'forest', top: true }]],
    'somebody of the city is in the banner already: nobody else goes there; its top maker still gets a strong colour nobody has');
});

test('the demo: a status in new words keeps its rows', async () => {
  const { db, api } = demoWith([]);
  db.settings = { retainer_statuses: DEFAULT_RETAINER_STATUSES.map((s) => ({ ...s })) };
  await api.importRetainerRecords(1, [wire(2, 'Hamna Sampleton', { status: 'Delivered to patient' })]);
  const r = db.retainer_cases[0];
  await assert.rejects(api.renameRecordOption('retainer_statuses', 'Delivered to patient', 'model-checked'), /ALREADY_ON_LIST/);
  assert.equal(await api.renameRecordOption('retainer_statuses', 'delivered TO patient', 'Delivered'), 1);
  assert.equal(r.status, 'Delivered');
  assert.equal(statusMeans(retainerStatuses(db.settings), r.status), 'delivered', 'the new words still mean delivered');
});

test('the next retainer check: overdue once its day has passed, "Checks due" a week ahead, never for a cancelled retainer or a row without a date', () => {
  const statuses = retainerStatuses({});
  const day = '2026-10-15';
  const row = (next_check_date, status: any = 'Delivered to patient') => ({ next_check_date, status });
  assert.equal(CHECK_SOON_DAYS, 7);
  assert.equal(checkState(row('2026-10-14'), statuses, day), 'overdue');
  assert.equal(checkState(row('2026-10-15'), statuses, day), 'soon', 'due today is not overdue yet');
  assert.equal(checkState(row('2026-10-22'), statuses, day), 'soon', 'seven days ahead is still "due"');
  assert.equal(checkState(row('2026-10-23'), statuses, day), 'later');
  assert.equal(checkState(row('2027-01-04'), statuses, '2026-12-29'), 'soon', 'across the end of a year');
  assert.equal(checkState(row(null), statuses, day), null, 'no check date: nothing to miss');
  assert.equal(checkState(row('2026-1-4'), statuses, day), null, 'a date not written as a date is none');
  assert.equal(checkState(row('2026-09-01', 'Cancelled'), statuses, day), null, 'a cancelled retainer has no check to miss');
  assert.equal(checkState(row('2026-09-01', 'cancelled'), statuses, day), null, 'any capitals');
  assert.equal(checkState(row('2026-09-01', null), statuses, day), 'overdue', 'a row without a status still has its check');
  // What a status means comes from Clinic setup: another word that means cancelled stops the check; the word alone does not.
  const own = retainerStatuses({ retainer_statuses: [{ label: 'Stopped', means: 'cancelled' }, { label: 'Delivered to patient', means: 'delivered' }] });
  assert.equal(checkState(row('2026-09-01', 'Stopped'), own, day), null);
  assert.equal(checkState(row('2026-09-01', 'Cancelled'), own, day), 'overdue');
  assert.deepEqual([checkOverdue(row('2026-10-14'), statuses, day), checkDue(row('2026-10-14'), statuses, day)], [true, true], 'overdue is "due" too');
  assert.deepEqual([checkOverdue(row('2026-10-20'), statuses, day), checkDue(row('2026-10-20'), statuses, day)], [false, true], 'in five days: due, not overdue');
  assert.deepEqual([checkOverdue(row('2026-11-20'), statuses, day), checkDue(row('2026-11-20'), statuses, day)], [false, false], 'next month: neither');
  // The rows copied from the Google Sheet: hundreds delivered long ago, none with a check date, so none of them is overdue.
  const sheet = Array.from({ length: 300 }, (_, i) => ({ status: i % 3 ? 'Delivered to patient' : 'Retainer made', next_check_date: null, source: 'sheet_import' }));
  assert.equal(sheet.filter((r) => checkOverdue(r, statuses, day) || checkDue(r, statuses, day)).length, 0);
});

test('the demo: Delivered sets the first retainer check a calendar month later (the database\'s rule), a check date set already stays, the copy sets none; the Coordinator\'s list', async () => {
  assert.match(MIGRATION, /if v_means = 'delivered' and new\.next_check_date is null then new\.next_check_date := \(v_today \+ interval '1 month'\)::date; end if;/,
    'the database has the same rule');
  assert.deepEqual([addMonthsISO('2027-01-31', 1), addMonthsISO('2028-01-31', 1), addMonthsISO('2026-12-15', 1)], ['2027-02-28', '2028-02-29', '2027-01-15'],
    'a calendar month, as the database counts it (date + interval \'1 month\')');
  const { db, api } = demoWith([]);
  await api.importRetainerRecords(1, [wire(2, 'Sample Sheet Done', { status: 'Delivered to patient' }), wire(3, 'Sample Sheet Made', { status: 'Retainer made' })]);
  assert.ok(db.retainer_cases.every((r) => r.next_check_date === null), 'the copy sets no check date, so no copied row is overdue');
  const today = todayISO();
  const at = (row) => db.retainer_cases.find((x) => x.source_row === row);
  assert.equal((await api.updateRetainerRecord(at(3).id, { status: 'Delivered to patient' })).next_check_date, addMonthsISO(today, 1), 'delivered on the website: a month later');
  const set = await api.addRetainerRecord({ city_id: 1, patient_name: 'Sample Check Set', next_check_date: '2027-03-01' });
  assert.equal((await api.updateRetainerRecord(set.id, { status: 'Delivered to patient' })).next_check_date, '2027-03-01', 'a check date set already stays');
  assert.equal((await api.addRetainerRecord({ city_id: 1, patient_name: 'Sample Delivered At Once', status: 'Delivered to patient' })).next_check_date, addMonthsISO(today, 1),
    'a row added as delivered gets it too');
  assert.equal((await api.updateRetainerRecord(set.id, { next_check_date: null })).next_check_date, null, 'cleared by hand, it stays cleared');
  // The Coordinator page's list: the checks whose day has passed, earliest first (a check due today is not one of them).
  await api.updateRetainerRecord(at(2).id, { next_check_date: addDaysISO(today, -3) });
  await api.updateRetainerRecord(set.id, { next_check_date: addDaysISO(today, -10) });
  await api.updateRetainerRecord(at(3).id, { next_check_date: today });
  assert.deepEqual((await api.retainerChecksOverdue({ today })).map((r) => r.patient_name), ['Sample Check Set', 'Sample Sheet Done']);
});

test('lab work: overdue means past due and not back', () => {
  assert.equal(labOverdue({ due_date: '2026-10-10', status: 'sent' }, '2026-10-12'), true);
  assert.equal(labOverdue({ due_date: '2026-10-10', status: 'in_lab' }, '2026-10-12'), true);
  assert.equal(labOverdue({ due_date: '2026-10-12', status: 'sent' }, '2026-10-12'), false, 'due today is not late yet');
  assert.equal(labOverdue({ due_date: '2026-10-10', status: 'sent', received_date: '2026-10-11' }, '2026-10-12'), false);
  assert.equal(labOverdue({ due_date: '2026-10-10', status: 'fitted' }, '2026-10-12'), false);
  assert.equal(labOverdue({ due_date: '2026-10-10', status: 'cancelled' }, '2026-10-12'), false);
  assert.equal(labOverdue({ due_date: null, status: 'sent' }, '2026-10-12'), false);
});
