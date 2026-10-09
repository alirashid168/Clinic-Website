// The data layer of the checkup list (patients without a patient file / Mr#): the live adapter (web/js/data/supabase.js) run against a
// stand-in for supabase-js (the real library is loaded from a CDN in the browser), and the demo adapter (web/js/data/demo.js), which
// must follow the same rules as the database. All names and phones are made up. What it pins down:
//   live:  the requests the Checkups page makes (filters, search by name and phone, paging, the Excel file's pages), what addCheckup and
//          updateCheckup send (only the allowed columns), deleteCheckup's "not removed", the three database functions' arguments,
//          and the answers of a database where the update is not run yet (CHECKUPS_MISSING; the day list is just empty).
//   demo:  who sees, adds, changes, removes, registers, links and imports what (the database's row-level rules), the seed, the
//          fill / overwrite import with its counts, and the Mr# a registration gets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setMaxListeners } from 'node:events';

// ---- a browser-like page
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k) : null),
  setItem: (k: string, v: unknown) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
};
const page = new EventTarget();
setMaxListeners(0, page);
(globalThis as any).window = page;
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test', onLine: true }, configurable: true, writable: true });

// ---- the SDK import of the adapter (a CDN URL) is answered by this stand-in
registerHooks({
  resolve(spec, ctx, nextResolve) {
    if (spec.startsWith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@')) {
      return { url: 'data:text/javascript,export const createClient = (...a) => globalThis.__fakeCreateClient(...a);', shortCircuit: true };
    }
    return nextResolve(spec, ctx);
  },
});
const { createSupabaseAdapter, checkupFilters, checkupPatch } = await import('../web/js/data/supabase.js');
const { createDemoAdapter } = await import('../web/js/data/demo.js');
const { FOLLOW_UP_STATUSES, checkupKey } = await import('../web/js/lib/checkups.js');
const { todayISO } = await import('../web/js/ui/dom.js');

// ======================================================================================= the live adapter
type Op = [string, ...any[]];
/** A stand-in for supabase-js: records every table request (the calls chained before it was awaited), rpc and channel. */
function fakeClient(answer: (table: string, ops: Op[]) => any) {
  const f: any = { requests: [] as Array<{ table: string; ops: Op[] }>, rpcs: [] as Array<{ name: string; args: any }>, channels: [] as any[], removed: [] as any[],
    rpcAnswer: (_name: string, _args: any): any => ({ data: null, error: null }) };
  f.from = (table: string) => {
    const ops: Op[] = [];
    const b: any = new Proxy({}, {
      get(_t, name) {
        if (name === 'then') return (res: any, rej: any) => { f.requests.push({ table, ops }); return Promise.resolve(answer(table, ops)).then(res, rej); };
        return (...a: any[]) => { ops.push([String(name), ...a]); return b; };
      },
    });
    return b;
  };
  f.client = () => ({
    auth: {
      storageKey: 'sb-test-auth-token',
      async getSession() { return { data: { session: { access_token: 'jwt-u1', user: { id: 'u1' } } }, error: null }; },
      async getUser() { return { data: { user: { id: 'u1' } }, error: null }; },
      async signOut() { return { error: null }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      stopAutoRefresh() {},
    },
    from: f.from,
    rpc: (name: string, args: any) => { f.rpcs.push({ name, args }); const r: any = Promise.resolve(f.rpcAnswer(name, args)); r.abortSignal = () => r; return r; },
    channel(name: string) {
      const ch: any = { name, handlers: [] as any[], subscribed: false, on(kind: string, filter: any, cb: any) { ch.handlers.push({ kind, filter, cb }); return ch; }, subscribe() { ch.subscribed = true; return ch; } };
      f.channels.push(ch);
      return ch;
    },
    removeChannel(ch: any) { f.removed.push(ch); },
    functions: { invoke: async () => ({ data: null, error: null }) },
    storage: { from: () => ({}) },
  });
  return f;
}
async function openPage(answer: (table: string, ops: Op[]) => any) {
  const f = fakeClient(answer);
  (globalThis as any).__fakeCreateClient = () => f.client();
  const data = await createSupabaseAdapter();
  return { f, data };
}
const ok = (data: any, extra: any = {}) => ({ data, error: null, status: 200, ...extra });
const fail = (code: string, message = 'x', status = 400) => ({ data: null, error: { code, message }, status });
const has = (ops: Op[], name: string, ...args: any[]) => ops.some((o) => o[0] === name && JSON.stringify(o.slice(1)) === JSON.stringify(args));
const arg = (ops: Op[], name: string) => ops.find((o) => o[0] === name)?.slice(1);
const MISSING = 'CHECKUPS_MISSING: the checkup list is not switched on yet. It appears once the database update has been run.';

test('live: listCheckups asks the view for one page, newest first, with every filter and the exact count', async () => {
  const { f, data } = await openPage(() => ok([{ id: 'a' }], { count: 5466 }));
  const r = await data.listCheckups({ q: 'Sample Per%on (x)', branchId: 2, from: '2024-10', to: '2025-12', followUp: 'Interested', source: 'archive', registered: 'no', page: 2, pageSize: 50 });
  assert.deepEqual(r, { rows: [{ id: 'a' }], total: 5466 });
  const { table, ops } = f.requests[0];
  assert.equal(table, 'checkup_list');
  assert.deepEqual(arg(ops, 'select'), ['*', { count: 'exact' }]);
  assert.deepEqual(arg(ops, 'or'), ['patient_name.ilike.%Sample Peron x%'], 'the characters that would break the or() list are taken out; no phone clause without 4 digits');
  assert.ok(has(ops, 'eq', 'branch_id', 2));
  assert.ok(has(ops, 'gte', 'checkup_date', '2024-10-01'));
  assert.ok(has(ops, 'lt', 'checkup_date', '2026-01-01'), '"to" December 2025 means before 1 Jan 2026');
  assert.ok(has(ops, 'eq', 'follow_up', 'Interested'));
  assert.ok(has(ops, 'eq', 'source', 'archive'));
  assert.ok(has(ops, 'is', 'patient_id', null));
  assert.deepEqual(ops.filter((o) => o[0] === 'order'), [['order', 'checkup_date', { ascending: false, nullsFirst: false }], ['order', 'created_at', { ascending: false }], ['order', 'id']]);
  assert.deepEqual(arg(ops, 'range'), [100, 149]);
});

test('live: search by name or phone, however the phone is written', async () => {
  const { f, data } = await openPage(() => ok([], { count: 0 }));
  const orOf = async (q: string) => { f.requests.length = 0; await data.listCheckups({ q }); return arg(f.requests[0].ops, 'or')?.[0]; };
  assert.equal(await orOf('0300-5550'), 'patient_name.ilike.%0300-5550%,phone_key.ilike.%03005550%');
  assert.equal(await orOf('+92 300 5550'), 'patient_name.ilike.%+92 300 5550%,phone_key.ilike.%923005550%,phone_key.ilike.%3005550%', 'the 92 prefix is also tried without it, as phone_key starts with 0');
  assert.equal(await orOf('  sample   person '), 'patient_name.ilike.%sample person%');
  assert.equal(await orOf('123'), 'patient_name.ilike.%123%', 'three digits are not a phone search');
  assert.equal(await orOf('a,b)c"d\\e*'), 'patient_name.ilike.%abcde%');
  f.requests.length = 0;
  await data.listCheckups({ q: '  ' });
  assert.equal(arg(f.requests[0].ops, 'or'), undefined, 'no search text, no filter');
  await data.listCheckups({ q: '%,()' });
  assert.equal(arg(f.requests[1].ops, 'or'), undefined, 'only special characters is no search either');
});

test('live: branch "none", no branch filter, impossible months ignored, December rolls into the next year', async () => {
  const { f, data } = await openPage(() => ok([], { count: 0 }));
  await data.listCheckups({ branchId: 'none' });
  assert.ok(has(f.requests[0].ops, 'is', 'branch_id', null));
  await data.listCheckups({ branchId: null, from: '2024-13', to: 'soon', source: 'spreadsheet', registered: 'maybe' });
  const o = f.requests[1].ops;
  assert.ok(!o.some((x: Op) => ['eq', 'gte', 'lt', 'is', 'not'].includes(x[0])), 'nothing filtered: ' + JSON.stringify(o));
  await data.listCheckups({ to: '2024-12', registered: 'yes' });
  assert.ok(has(f.requests[2].ops, 'lt', 'checkup_date', '2025-01-01'));
  assert.ok(has(f.requests[2].ops, 'not', 'patient_id', 'is', null));
  await data.listCheckups({ to: '2024-09' });
  assert.ok(has(f.requests[3].ops, 'lt', 'checkup_date', '2024-10-01'));
  assert.deepEqual(arg(f.requests[3].ops, 'range'), [0, 49], 'page 0, 50 rows by default');
});

test('live: a page past the end gives no rows and the right total', async () => {
  const { f, data } = await openPage((_t, ops) => (ops.some((o) => o[0] === 'range') ? fail('PGRST103', 'Requested range not satisfiable', 416) : ok(null, { count: 120 })));
  const r = await data.listCheckups({ page: 9 });
  assert.deepEqual(r, { rows: [], total: 120 });
  assert.deepEqual(arg(f.requests[1].ops, 'select'), ['*', { count: 'exact', head: true }]);
});

test('live: the Excel file reads every page (1000 a time) up to 20000 rows and says when it cut', async () => {
  const rowsFor = (ops: Op[]) => { const [from, to] = arg(ops, 'range')!; return Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i })); };
  let { f, data } = await openPage((_t, ops) => ok(rowsFor(ops).slice(0, Math.max(0, 1400 - arg(ops, 'range')![0]))));
  const rows = await data.exportCheckups({ followUp: 'Started' });
  assert.equal(rows.length, 1400);
  assert.equal(rows.truncated, undefined);
  assert.deepEqual(f.requests.map((r: any) => arg(r.ops, 'range')), [[0, 999], [1000, 1999]]);
  assert.ok(has(f.requests[0].ops, 'eq', 'follow_up', 'Started'));
  ({ f, data } = await openPage((_t, ops) => ok(rowsFor(ops))));
  const all = await data.exportCheckups({});
  assert.equal(all.length, 20000);
  assert.equal(all.truncated, true);
  assert.equal(all.cap, 20000);
});

test('live: listDayCheckups reads one exact day; a database without the update gives an empty list marked missing', async () => {
  let { f, data } = await openPage(() => ok([{ id: 'a' }, { id: 'b' }]));
  assert.deepEqual(await data.listDayCheckups({ branchId: 2, date: '2026-10-09' }), [{ id: 'a' }, { id: 'b' }]);
  let ops = f.requests[0].ops;
  assert.equal(f.requests[0].table, 'checkup_list');
  assert.ok(has(ops, 'eq', 'checkup_date', '2026-10-09') && has(ops, 'eq', 'date_is_month', false) && has(ops, 'eq', 'branch_id', 2));
  await data.listDayCheckups({ branchId: null, date: '2026-10-09' });
  assert.ok(!f.requests[1].ops.some((o: Op) => o[1] === 'branch_id'), 'no branch: every branch the reader may see');
  for (const answer of [fail('PGRST205', "Could not find the table 'public.checkup_list' in the schema cache", 404), fail('42P01', 'relation does not exist'), fail('PGRST202'), fail('42883'), fail('', 'not found', 404)]) {
    ({ data } = await openPage(() => answer));
    const none = await data.listDayCheckups({ branchId: 1, date: '2026-10-09' });
    assert.deepEqual([...none], []);
    assert.equal(none.missing, true, JSON.stringify(answer.error));
  }
  ({ data } = await openPage(() => fail('42501', 'permission denied', 403)));
  await assert.rejects(() => data.listDayCheckups({ branchId: 1, date: '2026-10-09' }), (e: any) => e.code === '42501', 'any other error is an error, not "missing"');
});

test('live: addCheckup sends the allowed columns (the token is one of them) with source website, whatever else is passed', async () => {
  const { f, data } = await openPage((_t, ops) => (ops.some((o) => o[0] === 'insert') ? ok({ id: 'new-1', ...arg(ops, 'insert')![0] }) : ok(null)));
  const row = await data.addCheckup({ checkup_date: '2026-10-09', branch_id: '2', patient_name: '  Sample Person ', phone: ' 0300-5550101 ', city: 'Karachi', doctors: '',
    checkup_for: 'Checkup', details: '   ', day_status: 'waiting', follow_up: '', notes: null,
    source: 'archive', id: 'forced', patient_id: 'p1', sheet_key: 'S-1', est_fee: 99, created_by: 'x', token: '9' });
  const sent = arg(f.requests[0].ops, 'insert')![0];
  assert.equal(f.requests[0].table, 'checkups');
  assert.deepEqual(sent, { checkup_date: '2026-10-09', date_is_month: false, source: 'website', branch_id: 2, patient_name: 'Sample Person', phone: '0300-5550101', city: 'Karachi',
    doctors: null, checkup_for: 'Checkup', details: null, day_status: 'waiting', follow_up: 'Not Contacted', notes: null, token: '9' });
  assert.equal(row.id, 'new-1');
  assert.equal(row.phone_key, '03005550101');
  assert.equal(row.mr_number, null);
  await data.addCheckup({ patient_name: 'Sample Two' });
  const second = arg(f.requests[1].ops, 'insert')![0];
  assert.equal(second.checkup_date, todayISO(), 'today when no date is given');
  assert.equal(second.branch_id, undefined);
});

test('live: updateCheckup sends only the allowed columns (the token among them); null when no row was changed', async () => {
  let changed = [{ id: 'c1', patient_id: null, phone: '0300-5550101' }];
  const { f, data } = await openPage((table, ops) => {
    if (table === 'patients') return ok({ mr_number: '50007' });
    return ops.some((o) => o[0] === 'update') ? ok(changed) : ok(null);
  });
  const row = await data.updateCheckup('c1', { follow_up: 'Interested', notes: 'call back', est_fee: '', branch_id: 'none', phone: ' ', patient_name: ' Sample ',
    source: 'archive', patient_id: 'p', id: 'z', sheet_key: 'k', checkup_date: '2020-01-01', date_is_month: true, created_at: 'x', token: '3', details: 'd', day_status: '' });
  assert.deepEqual(arg(f.requests[0].ops, 'update')![0], { follow_up: 'Interested', notes: 'call back', est_fee: null, branch_id: null, phone: null, patient_name: 'Sample', details: 'd', day_status: null, token: '3' });
  assert.ok(has(f.requests[0].ops, 'eq', 'id', 'c1'));
  assert.equal(row.phone_key, '03005550101');
  assert.equal(row.mr_number, null, 'no patient file, no Mr#');
  changed = [{ id: 'c1', patient_id: 'p9', phone: '0300-5550101' }];
  const linked = await data.updateCheckup('c1', { notes: 'x' });
  assert.equal(linked.mr_number, '50007', 'the Mr# of the linked patient file is looked up');
  changed = [];
  assert.equal(await data.updateCheckup('c1', { notes: 'x' }), null, 'removed or not visible: nothing was updated');
  const before = f.requests.length;
  assert.equal(await data.updateCheckup('c1', { source: 'archive', id: 'zz' }), null, 'nothing allowed to send: nothing sent');
  assert.equal(f.requests.length, before);
  assert.deepEqual(checkupPatch({ est_fee: '1500.5', branch_id: '3', follow_up: ' Started ' }), { est_fee: 1500.5, branch_id: 3, follow_up: 'Started' });
  assert.deepEqual(checkupPatch(null), {});
  // The token of a checkup is typed by hand (a website checkup has none, and the sheet's own keep the number written there).
  assert.deepEqual(checkupPatch({ token: ' 12 ' }), { token: '12' });
  assert.deepEqual(checkupPatch({ token: '   ' }), { token: null });
  assert.deepEqual(checkupPatch({ token: null }), { token: null });
});

test('live: deleteCheckup says when nothing was removed', async () => {
  let rows: any[] = [{ id: 'c1' }];
  const { f, data } = await openPage(() => ok(rows));
  await data.deleteCheckup('c1');
  assert.ok(f.requests[0].ops.some((o: Op) => o[0] === 'delete') && has(f.requests[0].ops, 'eq', 'id', 'c1') && has(f.requests[0].ops, 'select', 'id'));
  rows = [];
  await assert.rejects(() => data.deleteCheckup('c1'), (e: any) => e.code === 'NOT_REMOVED'
    && e.message === 'NOT_REMOVED: this checkup could not be removed (rows from the old list can only be removed by Dr. Ali).');
});

test('live: register, link and import call the three database functions', async () => {
  const { f, data } = await openPage(() => ok(null));
  f.rpcAnswer = (name: string) => ({ data: name === 'import_checkups' ? { inserted: 3 } : { patient_id: 'p1', mr_number: '50001', full_name: 'Sample Person' }, error: null });
  assert.deepEqual(await data.registerCheckupAsPatient('c1'), { patient_id: 'p1', mr_number: '50001', full_name: 'Sample Person' });
  assert.deepEqual(await data.linkCheckupToPatient('c1', 'p2'), { patient_id: 'p1', mr_number: '50001', full_name: 'Sample Person' });
  assert.deepEqual(await data.importCheckups([{ row: 5 }], { overwrite: true }), { inserted: 3 });
  await data.importCheckups([{ row: 6 }]);
  assert.deepEqual(f.rpcs, [
    { name: 'register_checkup_as_patient', args: { p_checkup: 'c1' } },
    { name: 'link_checkup_to_patient', args: { p_checkup: 'c1', p_patient: 'p2' } },
    { name: 'import_checkups', args: { p_rows: [{ row: 5 }], p_overwrite: true } },
    { name: 'import_checkups', args: { p_rows: [{ row: 6 }], p_overwrite: false } },
  ]);
  f.rpcAnswer = () => ({ data: null, error: { code: '23505', message: 'ALREADY_REGISTERED: Sample Person already has a patient file (Mr# 50001).' } });
  await assert.rejects(() => data.registerCheckupAsPatient('c1'), (e: any) => e.code === '23505' && e.message.startsWith('ALREADY_REGISTERED: Sample Person'));
});

test('live: without the database update every method but the day list throws CHECKUPS_MISSING', async () => {
  for (const answer of [fail('PGRST205', 'no table', 404), fail('42P01'), fail('PGRST202'), fail('42883'), fail('', 'Not Found', 404)]) {
    const { f, data } = await openPage(() => answer);
    f.rpcAnswer = () => answer;
    const calls: Array<[string, () => Promise<any>]> = [
      ['listCheckups', () => data.listCheckups({})], ['exportCheckups', () => data.exportCheckups({})], ['addCheckup', () => data.addCheckup({ patient_name: 'Sample' })],
      ['updateCheckup', () => data.updateCheckup('a', { notes: 'x' })], ['deleteCheckup', () => data.deleteCheckup('a')],
      ['registerCheckupAsPatient', () => data.registerCheckupAsPatient('a')], ['linkCheckupToPatient', () => data.linkCheckupToPatient('a', 'b')],
      ['importCheckups', () => data.importCheckups([])],
    ];
    for (const [name, run] of calls) {
      await assert.rejects(run, (e: any) => e.code === 'CHECKUPS_MISSING' && e.message === MISSING, `${name} / ${JSON.stringify(answer.error)}`);
    }
  }
  // ... but another failure is shown as it is.
  const { data } = await openPage(() => fail('42501', 'new row violates row-level security policy for table "checkups"', 403));
  await assert.rejects(() => data.addCheckup({ patient_name: 'Sample' }), (e: any) => e.code === '42501' && /row-level security/.test(e.message));
});

test('live: subscribeCheckups listens to the table (one branch or all) and stops', async () => {
  const { f, data } = await openPage(() => ok(null));
  const seen: string[] = [];
  const stopOne = data.subscribeCheckups(2, () => seen.push('change'));
  const stopAll = data.subscribeCheckups(null, () => {});
  assert.deepEqual(f.channels[0].handlers[0].filter, { event: '*', schema: 'public', table: 'checkups', filter: 'branch_id=eq.2' });
  assert.deepEqual(f.channels[1].handlers[0].filter, { event: '*', schema: 'public', table: 'checkups' });
  assert.ok(f.channels[0].subscribed && f.channels[1].subscribed);
  f.channels[0].handlers[0].cb();
  assert.deepEqual(seen, ['change']);
  stopOne();
  assert.deepEqual(f.removed, [f.channels[0]]);
  stopAll();
  assert.equal(f.removed.length, 2);
});

test('checkupFilters is a pure helper over any query object', () => {
  const calls: string[] = [];
  const q: any = new Proxy({}, { get: (_t, name) => (...a: any[]) => { calls.push(String(name) + JSON.stringify(a)); return q; } });
  checkupFilters(q, { followUp: 'Started' });
  assert.deepEqual(calls, ['eq["follow_up","Started"]']);
});

// ======================================================================================= the demo adapter
async function demoAs(id: string) {
  const d: any = createDemoAdapter();
  await d.signInDemo(id);
  return d;
}
const TODAY = todayISO();
const EM = String.fromCharCode(0x2014);   // the owner's list writes "nothing" as dashes
const EN = String.fromCharCode(0x2013);
const wire = (row: number, month: string | null, name: string, phone: string | null, branch: string | null, status = 'Not Contacted', notes: string | null = null) =>
  ({ row, month, name, phone, city: 'Karachi', branch, doctors: 'Dr. Sample (sample)', checkup_for: 'Scaling', est_fee: 8000, follow_up: status, notes, source_tab: 'Sample tab A' });

test('demo: the seed has an old list of 60+ rows (every status, some without a month, one with a patient file) and today\'s checkups', async () => {
  const d = await demoAs('s-admin');
  const first = await d.listCheckups({});
  assert.equal(first.rows.length, 50);
  assert.ok(first.total >= 64, 'more than one page: ' + first.total);
  const second = await d.listCheckups({ page: 1 });
  assert.equal(second.rows.length, first.total - 50);
  const all = await d.exportCheckups({});
  assert.equal(all.length, first.total);
  assert.equal(new Set(all.map((c: any) => c.id)).size, all.length);
  const archive = all.filter((c: any) => c.source === 'archive');
  assert.equal(archive.length, 64);
  assert.deepEqual([...new Set(archive.map((c: any) => c.follow_up))].sort(), [...FOLLOW_UP_STATUSES].sort(), 'every one of the 11 statuses');
  assert.equal(archive.filter((c: any) => c.checkup_date === null).length, 3);
  assert.ok(archive.every((c: any) => c.date_is_month && /^0300-555\d{4}$/.test(c.phone) && c.source_tab.startsWith('Sample tab ')));
  assert.deepEqual([...new Set(archive.map((c: any) => c.branch_id))].sort(), [1, 2, 3, 4, 5, null].sort());
  assert.ok(archive.some((c: any) => c.notes) && archive.some((c: any) => c.est_fee));
  const linked = archive.filter((c: any) => c.patient_id);
  assert.equal(linked.length, 1);
  assert.match(linked[0].mr_number, /^[0-9]+$/);
  assert.equal(new Set(archive.map((c: any) => checkupKey({ phone: c.phone, name: c.patient_name, month: c.checkup_date }))).size, 64, 'no two old-list rows share a key');
  const firstWithoutMonth = all.findIndex((c: any) => c.checkup_date === null);
  assert.ok(firstWithoutMonth > 0 && all.slice(firstWithoutMonth).every((c: any) => c.checkup_date === null), 'rows without a month come last');
  const nn = await d.listDayCheckups({ branchId: 2, date: TODAY });
  assert.deepEqual(nn.map((c: any) => [c.source, c.day_status, c.token, c.sheet_key]), [['website', 'waiting', null, null], ['google_sheet', 'completed', '7', 'S-demo00000001']]);
  const gul = await d.listDayCheckups({ branchId: 1, date: TODAY });
  assert.deepEqual(gul.map((c: any) => [c.source, c.day_status]), [['website', 'waiting']]);
  assert.equal((await d.listDayCheckups({ branchId: null, date: TODAY })).length, 3);
  assert.deepEqual(await d.listDayCheckups({ branchId: 2, date: '2020-01-01' }), []);
  assert.ok(nn.every((c: any) => c.phone_key === c.phone.replace(/[^0-9]/g, '') && c.mr_number === null));
  assert.equal(typeof d.subscribeCheckups(2, () => {}), 'function');
});

test('demo: search, filters and paging follow the database\'s', async () => {
  const d = await demoAs('s-admin');
  const all = (await d.exportCheckups({})) as any[];
  const sample = all.find((c) => c.source === 'archive' && c.checkup_date && c.branch_id === 3);
  assert.ok((await d.listCheckups({ q: sample.patient_name.toLowerCase() })).rows.some((c: any) => c.id === sample.id), 'by name, any case');
  const phone = sample.phone; // 0300-555xxxx
  for (const q of [phone, phone.replace('-', ' '), '+92 ' + phone.slice(1).replace('-', ' '), phone.slice(5)]) {
    assert.ok((await d.listCheckups({ q })).rows.some((c: any) => c.id === sample.id), 'by phone: ' + q);
  }
  assert.equal((await d.listCheckups({ q: '55' })).rows.every((c: any) => c.patient_name.toLowerCase().includes('55')), true, 'two digits are only a name search');
  assert.equal((await d.listCheckups({ branchId: 'none', pageSize: 500 })).rows.every((c: any) => c.branch_id === null), true);
  assert.equal((await d.listCheckups({ branchId: 3, pageSize: 500 })).total, all.filter((c) => c.branch_id === 3).length);
  const ym = sample.checkup_date.slice(0, 7);
  const inMonth = (await d.listCheckups({ from: ym, to: ym, pageSize: 500 })).rows;
  assert.ok(inMonth.length > 0 && inMonth.every((c: any) => c.checkup_date.slice(0, 7) === ym), 'one month: from = to');
  assert.equal((await d.listCheckups({ from: '2000-01', pageSize: 500 })).rows.some((c: any) => c.checkup_date === null), false, 'rows without a month are left out once a month is asked for');
  assert.equal((await d.listCheckups({ followUp: 'Interested', pageSize: 500 })).rows.every((c: any) => c.follow_up === 'Interested'), true);
  assert.equal((await d.listCheckups({ source: 'google_sheet' })).total, 1);
  assert.equal((await d.listCheckups({ source: 'website' })).total, 2);
  assert.equal((await d.listCheckups({ registered: 'yes' })).total, 1);
  assert.equal((await d.listCheckups({ registered: 'no' })).total, all.length - 1);
  assert.equal((await d.listCheckups({ page: 99 })).rows.length, 0);
  const dates = all.filter((c) => c.checkup_date).map((c) => c.checkup_date);
  assert.deepEqual(dates, [...dates].sort().reverse(), 'newest first');
});

test('demo: a front desk limited to North Nazimabad sees its branch and the rows with no branch, and may remove only its own website rows', async () => {
  const d = await demoAs('s-fd-nn');
  const rows = (await d.exportCheckups({})) as any[];
  assert.ok(rows.length > 0 && rows.every((c) => c.branch_id === null || c.branch_id === 2));
  assert.ok(rows.some((c) => c.branch_id === null) && rows.some((c) => c.branch_id === 2));
  const mine = await d.addCheckup({ checkup_date: TODAY, branch_id: 2, patient_name: ' Checkup Test Person ', phone: '0300 5550101', checkup_for: 'Scaling', day_status: 'waiting' });
  assert.equal(mine.patient_name, 'Checkup Test Person');
  assert.equal(mine.source, 'website');
  assert.equal(mine.follow_up, 'Not Contacted');
  assert.equal(mine.phone_key, '03005550101');
  assert.equal(mine.date_is_month, false);
  assert.ok((await d.listDayCheckups({ branchId: 2, date: TODAY })).some((c: any) => c.id === mine.id));
  await assert.rejects(() => d.addCheckup({ checkup_date: TODAY, branch_id: 1, patient_name: 'Sample Elsewhere' }), /row-level security/);
  await assert.rejects(() => d.addCheckup({ checkup_date: TODAY, branch_id: 2, patient_name: '   ' }), /patient_name/);
  await assert.rejects(() => d.addCheckup({ checkup_date: TODAY, branch_id: 2, patient_name: 'x'.repeat(201) }), /checkups_patient_name_check/);
  const upd = await d.updateCheckup(mine.id, { day_status: 'completed', details: 'Scaling done', source: 'archive', patient_id: 'x' });
  assert.deepEqual([upd.day_status, upd.details, upd.source, upd.patient_id], ['completed', 'Scaling done', 'website', null]);
  await assert.rejects(() => d.updateCheckup(mine.id, { day_status: 'scheduled' }), /checkups_day_status_check/);
  assert.equal(mine.token, null, 'a website checkup has no token');
  assert.equal((await d.updateCheckup(mine.id, { token: ' 12 ' })).token, '12', 'the token is typed by hand');
  assert.equal((await d.listDayCheckups({ branchId: 2, date: TODAY })).find((c: any) => c.id === mine.id).token, '12');
  assert.equal((await d.updateCheckup(mine.id, { token: '' })).token, null, 'and can be cleared');
  await assert.rejects(() => d.updateCheckup(mine.id, { token: 'x'.repeat(41) }), /checkups_token_check/);
  assert.equal((await d.updateCheckup(mine.id, { follow_up: 'Interested' })).follow_up, 'Interested');
  const archiveNN = rows.find((c) => c.source === 'archive' && c.branch_id === 2);
  assert.equal((await d.updateCheckup(archiveNN.id, { follow_up: 'No Response', notes: 'call back' })).notes, 'call back', 'the desk may change status and notes of an old-list row');
  await assert.rejects(() => d.deleteCheckup(archiveNN.id), /NOT_REMOVED/);
  const sheetRow = rows.find((c) => c.source === 'google_sheet');
  assert.equal(sheetRow.branch_id, 2);
  await d.signInDemo('s-admin');
  const other = (await d.exportCheckups({})).find((c: any) => c.branch_id === 1);
  await d.signInDemo('s-fd-nn');
  assert.equal(await d.updateCheckup(other.id, { notes: 'x' }), null, 'a row of another branch: the update reaches no row');
  await assert.rejects(() => d.deleteCheckup(other.id), /NOT_REMOVED/);
  await d.deleteCheckup(mine.id);
  assert.equal((await d.exportCheckups({})).some((c: any) => c.id === mine.id), false);
  await assert.rejects(() => d.deleteCheckup(mine.id), /NOT_REMOVED/, 'already gone');
  assert.equal(await d.updateCheckup(mine.id, { notes: 'x' }), null, 'a queued edit for a removed row ends quietly');
});

test('demo: an accountant may read but not add, change, register, link or import; a patient sees nothing', async () => {
  const d = await demoAs('s-acct');
  assert.ok((await d.listCheckups({})).total > 60);
  const id = (await d.exportCheckups({}))[0].id;
  await assert.rejects(() => d.addCheckup({ checkup_date: TODAY, branch_id: 2, patient_name: 'Sample X' }), /row-level security/);
  assert.equal(await d.updateCheckup(id, { notes: 'x' }), null);
  await assert.rejects(() => d.deleteCheckup(id), /NOT_REMOVED/);
  await assert.rejects(() => d.registerCheckupAsPatient(id), /NOT_ALLOWED: registering a patient needs/);
  const patientId = (await d.searchPatients(''))[0].id;
  await assert.rejects(() => d.linkCheckupToPatient(id, patientId), /NOT_ALLOWED: linking a checkup/);
  await assert.rejects(() => d.importCheckups([]), /NOT_ALLOWED: only Dr. Ali/);
  const patient = createDemoAdapter() as any;
  await patient.signInDemo('p-demo');
  assert.deepEqual(await patient.listCheckups({}), { rows: [], total: 0 });
  assert.deepEqual(await patient.exportCheckups({}), []);
  assert.deepEqual(await patient.listDayCheckups({ branchId: null, date: TODAY }), []);
  await assert.rejects(() => patient.registerCheckupAsPatient(id), /NOT_ALLOWED/);
});

test('demo: registering needs both "Register new patients" and "Add and edit Aaj ki List entries" (as in the database); nothing is created without them', async () => {
  const d = await demoAs('s-admin');
  const row = await d.addCheckup({ checkup_date: TODAY, branch_id: 2, patient_name: 'Sample Needs Both', phone: '0300-555 0301' });
  // the front desk may register patients and edit the list by default; with list editing switched off for this person the database says no
  await d.setOverride('s-fd-nn', 'sheet.edit', false);
  await d.signInDemo('s-fd-nn');
  const before = (await d.searchPatients('')).length;
  await assert.rejects(() => d.registerCheckupAsPatient(row.id), /NOT_ALLOWED: registering a patient needs "Register new patients" and "Add and edit Aaj ki List entries"/);
  assert.equal((await d.searchPatients('')).length, before, 'no patient file was created');
  assert.equal((await d.exportCheckups({ q: 'Sample Needs Both' }))[0].patient_id, null, 'and the checkup was not touched');
  await d.signInDemo('s-admin');
  await d.setOverride('s-fd-nn', 'sheet.edit', null);
  await d.setOverride('s-fd-nn', 'patients.create', false);
  await d.signInDemo('s-fd-nn');
  await assert.rejects(() => d.registerCheckupAsPatient(row.id), /NOT_ALLOWED: registering a patient needs/);
  await d.signInDemo('s-admin');
  await d.setOverride('s-fd-nn', 'patients.create', null);
  await d.signInDemo('s-fd-nn');
  const r = await d.registerCheckupAsPatient(row.id);
  assert.match(r.mr_number, /^[0-9]+$/, 'with both rights it works');
});

test('demo: registering gives the next Mr#, the patient file, the link and the follow-up; once only', async () => {
  const d = await demoAs('s-coord');
  const before = (await d.searchPatients('')).length;
  const row = await d.addCheckup({ checkup_date: TODAY, branch_id: 2, patient_name: '  Sample   Reg One ', phone: '0300-555 0201', city: 'karachi', checkup_for: 'Scaling', day_status: 'waiting' });
  const r = await d.registerCheckupAsPatient(row.id);
  assert.match(r.mr_number, /^[0-9]+$/);
  assert.equal(r.full_name, 'Sample Reg One');
  const patients = await d.searchPatients('Sample Reg One');
  assert.equal(patients.length, 1);
  const p = patients[0];
  assert.deepEqual([p.id, p.mr_number, p.full_name, p.phone, p.first_branch_id, p.city_id], [r.patient_id, r.mr_number, 'Sample Reg One', '03005550201', 2, 1]);
  assert.equal(p.notes, `From the checkup list: checkup ${TODAY.slice(8, 10)} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+TODAY.slice(5, 7) - 1]} ${TODAY.slice(0, 4)} at North Nazimabad, for Scaling`);
  const after = (await d.listDayCheckups({ branchId: 2, date: TODAY })).find((c: any) => c.id === row.id);
  assert.deepEqual([after.patient_id, after.follow_up, after.mr_number], [r.patient_id, 'Started', r.mr_number]);
  assert.equal((await d.searchPatients('')).length, before + 1);
  await assert.rejects(() => d.registerCheckupAsPatient(row.id), new RegExp(`ALREADY_REGISTERED: Sample Reg One already has a patient file \\(Mr# ${r.mr_number}\\)`));
  assert.equal((await d.searchPatients('')).length, before + 1);
  // The next one gets the next number; Completed stays Completed; a short phone is left out; no branch and no date are said so.
  const two = await d.addCheckup({ checkup_date: TODAY, branch_id: 2, patient_name: 'Sample Reg Two', phone: '123', follow_up: 'Completed' });
  const r2 = await d.registerCheckupAsPatient(two.id);
  assert.ok(Number(r2.mr_number) > Number(r.mr_number));
  assert.equal((await d.searchPatients('Sample Reg Two'))[0].phone, null);
  assert.equal((await d.exportCheckups({ q: 'Sample Reg Two' }))[0].follow_up, 'Completed');
  const shortName = await d.addCheckup({ checkup_date: TODAY, branch_id: 2, patient_name: 'A' });
  await assert.rejects(() => d.registerCheckupAsPatient(shortName.id), /NAME_TOO_SHORT/);
  const unregistered = (await d.exportCheckups({ source: 'archive', registered: 'no' })) as any[];
  const noBranch = unregistered.find((c) => c.checkup_date !== null && c.branch_id === null);
  const r3 = await d.registerCheckupAsPatient(noBranch.id);
  const p3 = (await d.searchPatients(r3.full_name)).find((x: any) => x.id === r3.patient_id);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  assert.equal(p3.notes, `From the checkup list: checkup ${months[+noBranch.checkup_date.slice(5, 7) - 1]} ${noBranch.checkup_date.slice(0, 4)}, for ${noBranch.checkup_for}`, 'an old-list row says the month; no branch is left out');
  assert.equal(p3.first_branch_id, null);
  const noMonth = unregistered.find((c) => c.checkup_date === null);
  const r4 = await d.registerCheckupAsPatient(noMonth.id);
  assert.match((await d.searchPatients(r4.full_name)).find((x: any) => x.id === r4.patient_id).notes, /^From the checkup list: checkup date not recorded at .+, for .+$/);
  await assert.rejects(() => d.registerCheckupAsPatient('nope'), /NOT_FOUND: this checkup is not on your list/);
  const gulshan = (await d.exportCheckups({})).find((c: any) => c.branch_id === 1 && !c.patient_id);
  await d.signInDemo('s-fd-nn');
  await assert.rejects(() => d.registerCheckupAsPatient(gulshan.id), /NOT_FOUND: this checkup is not on your list/);
});

test('demo: linking to a patient file that already exists', async () => {
  const d = await demoAs('s-fd-nn');
  const [existing, other] = await d.searchPatients('');
  const a = await d.addCheckup({ checkup_date: TODAY, branch_id: 2, patient_name: 'Sample Link One', phone: '0300-5550801' });
  const done = await d.addCheckup({ checkup_date: TODAY, branch_id: 2, patient_name: 'Sample Link Two', phone: '0300-5550802', follow_up: 'Completed' });
  const r = await d.linkCheckupToPatient(a.id, existing.id);
  assert.deepEqual(r, { patient_id: existing.id, mr_number: existing.mr_number, full_name: existing.full_name });
  const row = (await d.exportCheckups({ q: 'Sample Link One' }))[0];
  assert.deepEqual([row.patient_id, row.follow_up, row.mr_number], [existing.id, 'Started', existing.mr_number]);
  assert.deepEqual(await d.linkCheckupToPatient(a.id, existing.id), r, 'the same link again is fine');
  await assert.rejects(() => d.linkCheckupToPatient(a.id, other.id), /ALREADY_REGISTERED: Sample Link One already has a patient file/);
  await d.linkCheckupToPatient(done.id, other.id);
  assert.equal((await d.exportCheckups({ q: 'Sample Link Two' }))[0].follow_up, 'Completed');
  await assert.rejects(() => d.linkCheckupToPatient(a.id, 'no-such-patient'), /NOT_FOUND: that patient file does not exist/);
});

test('demo: the import follows the database - same key, fill versus overwrite, counts, skips, limits', async () => {
  const d = await demoAs('s-admin');
  await assert.rejects(() => d.importCheckups({}), /BAD_ROWS/);
  await assert.rejects(() => d.importCheckups(Array.from({ length: 501 }, (_, i) => wire(i, '2025-01-01', 'Sample Over ' + i, null, null))), /TOO_MANY_ROWS/);
  const base = (await d.exportCheckups({})).length;
  const rows4 = [wire(5, '2024-12-01', 'Sample Alpha', '0300-5550101', 'GUL', 'Follow-up Sent', 'called twice'), wire(6, '2025-03-01', 'Sample Bravo', '0300-5550102', 'NN', 'Interested'),
    wire(7, '2025-06-01', 'Sample Charlie', '0300-5550103', null), wire(8, null, 'Sample Delta', '0300-5550104', 'NN')];
  let r = await d.importCheckups(rows4);
  assert.deepEqual([r.given, r.inserted, r.updated, r.unchanged, r.kept, r.skipped_count], [4, 4, 0, 0, 0, 0]);
  const alpha = (await d.exportCheckups({ q: 'Sample Alpha' }))[0];
  assert.deepEqual([alpha.source, alpha.date_is_month, alpha.checkup_date, alpha.branch_id, alpha.est_fee, alpha.follow_up, alpha.notes, alpha.day_status, alpha.token],
    ['archive', true, '2024-12-01', 1, 8000, 'Follow-up Sent', 'called twice', null, null]);
  assert.equal((await d.exportCheckups({})).length, base + 4);
  r = await d.importCheckups(rows4);
  assert.deepEqual([r.inserted, r.updated, r.unchanged, r.kept], [0, 0, 4, 0], 'the same rows again: nothing added, nothing changed');
  r = await d.importCheckups([...rows4, wire(9, '2025-01-01', EM, '0300-5550199', 'NN'), wire(11, '2024-12-15', '  SAMPLE   alpha ', '+92 300 5550101', 'GUL', 'Completed')]);
  assert.deepEqual(r.skipped, [{ row: 9, reason: 'No patient name' }, { row: 11, reason: 'Same person and month as row 5' }]);
  assert.equal(r.skipped_count, 2);
  assert.equal(r.given, r.inserted + r.updated + r.unchanged + r.kept + r.skipped_count);
  // Fill: only where the website still says Not Contacted / has no note.
  r = await d.importCheckups([wire(7, '2025-06-01', 'Sample Charlie', '0300-5550103', null, 'Interested', 'asked about the price')]);
  assert.deepEqual([r.updated, r.kept, r.unchanged], [1, 0, 0]);
  await d.signInDemo('s-fd-nn');
  const bravo = (await d.exportCheckups({ q: 'Sample Bravo' }))[0];
  await d.updateCheckup(bravo.id, { follow_up: 'Interested', notes: 'call back Monday' });
  await d.signInDemo('s-admin');
  r = await d.importCheckups([wire(6, '2025-03-01', 'Sample Bravo', '0300-5550102', 'NN', 'No Response', 'file note')]);
  assert.deepEqual([r.updated, r.kept], [0, 1]);
  assert.deepEqual([(await d.exportCheckups({ q: 'Sample Bravo' }))[0].follow_up, (await d.exportCheckups({ q: 'Sample Bravo' }))[0].notes], ['Interested', 'call back Monday']);
  r = await d.importCheckups([wire(6, '2025-03-01', 'Sample Bravo', '0300-5550102', 'NN', 'No Response', 'file note')], { overwrite: true });
  assert.deepEqual([r.updated, r.kept], [1, 0]);
  r = await d.importCheckups([wire(6, '2025-03-01', 'Sample Bravo', '0300-5550102', 'NN', 'Completed', null)], { overwrite: true });
  const b2 = (await d.exportCheckups({ q: 'Sample Bravo' }))[0];
  assert.deepEqual([r.updated, b2.follow_up, b2.notes], [1, 'Completed', 'file note'], 'an empty note in the file never wipes a note');
  // Nothing but the status and notes of a matched row changes.
  r = await d.importCheckups([{ ...wire(5, '2024-12-01', 'Sample Alpha', '0300-5550101', 'NN', 'Completed', 'another'), city: 'Lahore', est_fee: 99999, doctors: 'Someone Else' }], { overwrite: true });
  const a2 = (await d.exportCheckups({ q: 'Sample Alpha' }))[0];
  assert.deepEqual([a2.branch_id, a2.city, a2.est_fee, a2.doctors, a2.follow_up, a2.notes], [1, 'Karachi', 8000, 'Dr. Sample (sample)', 'Completed', 'another']);
  // Cleaning: dash cells, long text, a bad fee, an unknown branch, an impossible month - none fails the batch.
  r = await d.importCheckups([{ row: 20, month: '2025-13-01', name: ' Sample Echo ', phone: EM, city: '-', branch: 'XXX', doctors: '-', checkup_for: EN, est_fee: -5, follow_up: '', notes: 'n'.repeat(2500) },
    { row: 21, month: '2025-02-30', name: 'Sample Foxtrot', phone: '0300-5550106', branch: 'nn', est_fee: 1234.567, follow_up: 'f'.repeat(80) }, 'text', null, 5]);
  assert.deepEqual([r.inserted, r.skipped_count], [2, 3]);
  const echo = (await d.exportCheckups({ q: 'Sample Echo' }))[0];
  assert.deepEqual([echo.patient_name, echo.phone, echo.city, echo.branch_id, echo.doctors, echo.checkup_for, echo.est_fee, echo.follow_up, echo.notes.length, echo.checkup_date, echo.date_is_month],
    ['Sample Echo', null, null, null, null, null, null, 'Not Contacted', 2000, null, true]);
  const fox = (await d.exportCheckups({ q: 'Sample Foxtrot' }))[0];
  assert.deepEqual([fox.est_fee, fox.branch_id, fox.checkup_date, fox.follow_up.length], [1234.57, 2, '2025-02-01', 60]);
  // A person who is on the website alone for that month still gets the old-list row.
  await d.signInDemo('s-fd-nn');
  const web = await d.addCheckup({ checkup_date: '2025-04-10', branch_id: 2, patient_name: 'Sample Webonly', phone: '0300-5550501' });
  await d.signInDemo('s-admin');
  r = await d.importCheckups([wire(40, '2025-04-01', 'Sample Webonly', '0300-5550501', 'NN', 'Interested', 'from the file')]);
  assert.deepEqual([r.inserted, r.updated, r.unchanged, r.kept], [1, 0, 0, 0]);
  assert.equal((await d.exportCheckups({ q: 'Sample Webonly' })).length, 2);
  assert.deepEqual((await d.exportCheckups({ q: 'Sample Webonly', source: 'website' }))[0].follow_up, 'Not Contacted');
  assert.equal(web.source, 'website');
  // Only the old list can be imported again; the admin may remove an old-list row (and the next import adds it back).
  await d.deleteCheckup(alpha.id);
  r = await d.importCheckups([rows4[0]]);
  assert.equal(r.inserted, 1);
});
