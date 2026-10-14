// "End the day" on the Aaj ki List and the History of Aaj ki List (owner, 12 Oct 2026): the order and counts of a saved list
// (web/js/lib/day-list.js, the same rules as the database's private.day_list_rows), the live adapter's requests (it sends only the
// branch and the day: the database builds the copy), and the demo adapter, which follows the database's rules. Made-up people only.
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
registerHooks({
  resolve(spec, ctx, nextResolve) {
    if (spec.startsWith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@')) {
      return { url: 'data:text/javascript,export const createClient = (...a) => globalThis.__fakeCreateClient(...a);', shortCircuit: true };
    }
    return nextResolve(spec, ctx);
  },
});
const { createSupabaseAdapter } = await import('../web/js/data/supabase.js');
const { createDemoAdapter } = await import('../web/js/data/demo.js');
const { orderDayList, countDayList, dayLabel, clinicTime, clinicDate, endedAt, endDayCounts, listAfterEnding, pastMidnight, FIRST_DAY } = await import('../web/js/lib/day-list.js');
const { todayISO, addDaysISO } = await import('../web/js/ui/dom.js');
const { PERMISSIONS, defaultGrid, hasPermission } = await import('../web/js/lib/permissions.js');

// ======================================================================================= the shared rules
test('order: Waiting, In treatment, Scheduled, no status, Completed, Cancelled, No show; patients before checkups; by token, then by time added', () => {
  const rows = [
    { id: 'a', kind: 'patient', status: 'completed', token: '1', created_at: '2026-10-12T04:00:00Z', name: 'Done One' },
    { id: 'b', kind: 'patient', status: 'waiting', token: '3', created_at: '2026-10-12T04:01:00Z', name: 'Waiting Three' },
    { id: 'c', kind: 'patient', status: 'waiting', token: '2', created_at: '2026-10-12T04:02:00Z', name: 'Waiting Two' },
    { id: 'd', kind: 'checkup', status: 'waiting', token: '1', created_at: '2026-10-12T04:03:00Z', name: 'Checkup Waiting One' },
    { id: 'e', kind: 'checkup', status: 'waiting', token: ' 9 ', created_at: '2026-10-12T04:04:00Z', name: 'Checkup Waiting Nine' },
    { id: 'f', kind: 'patient', status: 'in_treatment', token: '4', created_at: '2026-10-12T04:05:00Z', name: 'In Chair' },
    { id: 'g', kind: 'patient', status: 'scheduled', token: null, created_at: '2026-10-12T04:06:00Z', name: 'Booked' },
    { id: 'h', kind: 'checkup', status: null, token: null, created_at: '2026-10-12T04:07:00Z', name: 'Checkup Not Set' },
    { id: 'i', kind: 'checkup', status: 'completed', token: 'kit A', created_at: '2026-10-12T04:08:00Z', name: 'Checkup Done Kit' },
    { id: 'j', kind: 'patient', status: 'cancelled', token: '5', created_at: '2026-10-12T04:09:00Z', name: 'Cancelled' },
    { id: 'k', kind: 'patient', status: 'no_show', token: '6', created_at: '2026-10-12T04:10:00Z', name: 'No Show' },
    { id: 'l', kind: 'patient', status: 'completed', token: '7', created_at: '2026-10-12T04:11:00Z', name: 'Done Seven' },
  ];
  const out = orderDayList(rows.reverse());
  // the same names and order as supabase/tests/31_day_list_history_test.sql expects from the database
  assert.deepEqual(out.map((r: any) => r.name), ['Waiting Two', 'Waiting Three', 'Checkup Waiting One', 'Checkup Waiting Nine', 'In Chair', 'Booked',
    'Checkup Not Set', 'Done One', 'Done Seven', 'Checkup Done Kit', 'Cancelled', 'No Show']);
  assert.deepEqual(out.map((r: any) => r.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 'serial numbers 1..n');
  assert.deepEqual(countDayList(out), { total: 12, completed: 3, waiting: 4, in_treatment: 1, scheduled: 1, cancelled: 1, no_show: 1, not_set: 1, checkups: 4 });
  const same = orderDayList([{ id: 'y', kind: 'patient', status: 'waiting', token: null, created_at: 't2' }, { id: 'x', kind: 'patient', status: 'waiting', token: null, created_at: 't1' }]);
  assert.deepEqual(same.map((r: any) => r.id), ['x', 'y'], 'no token: by time added');
});

test('day and time: a calendar day keeps its date, a moment is shown in Pakistan time', () => {
  assert.equal(dayLabel('2026-10-12'), 'Mon 12 Oct 2026');
  assert.equal(dayLabel('2026-03-01'), 'Sun 1 Mar 2026');
  assert.equal(clinicTime('2026-10-12T16:05:00Z'), '21:05');
  assert.equal(clinicTime('2026-10-12T19:30:00Z'), '00:30');
  assert.equal(clinicDate('2026-10-12T19:30:00Z'), '2026-10-13', 'half past midnight in Karachi is the next day');
  assert.equal(endedAt({ closed_at: '2026-10-12T16:05:00Z' }, '2026-10-12'), '21:05');
  assert.equal(endedAt({ closed_at: '2026-10-13T04:10:00Z' }, '2026-10-12'), '09:10 on Tue 13 Oct 2026', 'ended the next morning: the day is said too');
});

test('the "End the day" dialog: its counts add up, a part that is 0 is left out, and the checkup patients are counted as in the list\'s header', () => {
  const c = (o: any) => ({ total: 0, completed: 0, waiting: 0, in_treatment: 0, scheduled: 0, cancelled: 0, no_show: 0, not_set: 0, checkups: 0, ...o });
  assert.equal(endDayCounts(c({ total: 9, completed: 3, waiting: 3, in_treatment: 1, scheduled: 1, cancelled: 1, checkups: 2 })),
    '9 patients (incl. 2 checkup patients): 3 completed, 4 still waiting or in treatment, 2 other (scheduled, cancelled or no show).');
  assert.equal(endDayCounts(c({ total: 5, completed: 5 })), '5 patients: 5 completed.', 'no other part when it is 0');
  assert.equal(endDayCounts(c({ total: 1, waiting: 1, checkups: 1 })), '1 patient (incl. 1 checkup patient): 1 still waiting or in treatment.');
  assert.equal(endDayCounts(c({ total: 3, completed: 1, no_show: 1, not_set: 1, checkups: 1 })),
    '3 patients (incl. 1 checkup patient): 1 completed, 2 other (scheduled, cancelled, no show or no status yet).', 'a checkup patient with no status yet is counted too');
  // The parts always add up to the total, for the counts of a real list.
  const rows = ['completed', 'waiting', 'in_treatment', 'scheduled', 'cancelled', 'no_show', null].map((status, i) => ({ id: String(i), kind: i % 2 ? 'checkup' : 'patient', status }));
  const text = endDayCounts(countDayList(rows));
  const [total, ...parts] = [...text.matchAll(/(\d+) (?:patients|completed|still|other)/g)].map((m) => Number(m[1]));
  assert.equal(parts.reduce((a, b) => a + b, 0), total, text);
});

test('after "End the day": the next day\'s list, or today\'s when that has gone by too; the warning when midnight has passed since the page was opened', () => {
  assert.equal(listAfterEnding('2026-10-14', '2026-10-14'), '2026-10-15', 'today ended: tomorrow\'s list');
  assert.equal(listAfterEnding('2026-10-13', '2026-10-14'), '2026-10-14', 'yesterday ended: today\'s list');
  assert.equal(listAfterEnding('2026-10-12', '2026-10-14'), '2026-10-14', 'ending 12 Oct on 14 Oct opens 14 Oct, not 13 Oct');
  assert.equal(listAfterEnding('2026-12-31', '2026-12-31'), '2027-01-01');
  assert.equal(pastMidnight('2026-10-13', '2026-10-13', '2026-10-14'), 'It is now Wed 14 Oct 2026; you are ending Tue 13 Oct 2026.');
  assert.equal(pastMidnight('2026-10-13', '2026-10-13', '2026-10-13'), null, 'the same day: no warning');
  assert.equal(pastMidnight('2026-10-14', '2026-10-13', '2026-10-14'), null, 'past midnight, but ending the new day (Today was pressed): no warning');
  assert.equal(pastMidnight('2026-10-10', '2026-10-14', '2026-10-14'), null, 'an earlier day opened today: no warning');
  assert.equal(FIRST_DAY, '2024-01-01', 'the same first day as end_day() in the database');
});

test('permission grid: "End the day on the Aaj ki List" sits under Daily list, on for the roles that may edit the list (as the database seed)', () => {
  const p = PERMISSIONS.find((x: any) => x.key === 'sheet.end_day');
  assert.equal(p.label, 'End the day on the Aaj ki List');
  assert.equal(p.category, 'Daily list');
  const grid = defaultGrid();
  const roles = ['front_desk', 'assistant', 'doctor', 'coordinator', 'accountant', 'admin'];
  assert.deepEqual(roles.filter((r) => hasPermission(r, 'sheet.end_day', grid)), roles.filter((r) => hasPermission(r, 'sheet.edit', grid) || r === 'admin'));
  assert.deepEqual(roles.filter((r) => hasPermission(r, 'sheet.end_day', grid)), ['front_desk', 'assistant', 'doctor', 'coordinator', 'admin']);
});

// ======================================================================================= the live adapter
function fakeClient(answer: (table: string, ops: any[]) => any) {
  const f: any = { requests: [] as any[], rpcs: [] as any[], rpcAnswer: (_n: string, _a: any): any => ({ data: null, error: null, status: 200 }) };
  f.from = (table: string) => {
    const ops: any[] = [];
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
    channel() { const ch: any = { on: () => ch, subscribe: () => ch }; return ch; },
    removeChannel() {},
    functions: { invoke: async () => ({ data: null, error: null }) },
    storage: { from: () => ({}) },
  });
  return f;
}
async function openPage(answer: (table: string, ops: any[]) => any = () => ({ data: null, error: null, status: 200 })) {
  const f = fakeClient(answer);
  (globalThis as any).__fakeCreateClient = () => f.client();
  return { f, data: await createSupabaseAdapter() as any };
}

test('live: endDay sends only the branch and the day; the database builds the copy', async () => {
  const { f, data } = await openPage();
  f.rpcAnswer = () => ({ data: { total: 3, completed: 2, times_updated: 0 }, error: null, status: 200 });
  assert.deepEqual(await data.endDay({ branchId: '2', date: '2026-10-12' }), { total: 3, completed: 2, times_updated: 0 });
  assert.deepEqual(f.rpcs, [{ name: 'end_day', args: { p_branch: 2, p_date: '2026-10-12' } }]);
  f.rpcAnswer = () => ({ data: null, error: { code: '42501', message: 'NOT_ALLOWED: ending the day needs "End the day on the Aaj ki List" in the access list.' }, status: 403 });
  await assert.rejects(() => data.endDay({ branchId: 2, date: '2026-10-12' }), /NOT_ALLOWED/);
  f.rpcAnswer = () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 });
  await assert.rejects(() => data.endDay({ branchId: 2, date: '2026-10-12' }), (e: any) => e.code === 'DAY_HISTORY_MISSING');
});

test('live: the History asks for one page with its filters; the total comes with the rows; before the update it says missing', async () => {
  const { f, data } = await openPage();
  f.rpcAnswer = () => ({ data: [{ list_date: '2026-10-12', branch_id: 2, total_count: 75 }], error: null, status: 200 });
  assert.deepEqual(await data.dayListHistory({ branchId: '2', from: '2026-10-01', to: '2026-10-31', limit: 60, offset: 60 }),
    { rows: [{ list_date: '2026-10-12', branch_id: 2, total_count: 75 }], total: 75 });
  assert.deepEqual(f.rpcs[0], { name: 'day_list_history', args: { p_branch: 2, p_from: '2026-10-01', p_to: '2026-10-31', p_limit: 60, p_offset: 60 } });
  await data.dayListHistory();
  assert.deepEqual(f.rpcs[1].args, { p_branch: null, p_from: null, p_to: null, p_limit: 60, p_offset: 0 }, 'no filters: every branch, every day');
  f.rpcAnswer = () => ({ data: [], error: null, status: 200 });
  assert.deepEqual(await data.dayListHistory({ offset: 600 }), { rows: [], total: 0 });
  const old = await openPage();
  old.f.rpcAnswer = () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 });
  assert.equal((await old.data.dayListHistory()).missing, true);
  assert.equal((await old.data.dayListCopy({ branchId: 2, date: '2026-10-12' })).missing, true);
});

test('live: dayListCopy asks the database for one day; dayClosing reads the line only (never the copy) and is null before the update', async () => {
  let { f, data } = await openPage((_t, ops) => ({ data: ops.length ? { closed_at: '2026-10-12T16:05:00Z', closed_by_name: 'Sample Desk' } : null, error: null, status: 200 }));
  f.rpcAnswer = () => ({ data: { ended: true, rows: [] }, error: null, status: 200 });
  assert.deepEqual(await data.dayListCopy({ branchId: '1', date: '2026-10-11' }), { ended: true, rows: [] });
  assert.deepEqual(f.rpcs[0], { name: 'day_list_copy', args: { p_branch: 1, p_date: '2026-10-11' } });
  const closing = await data.dayClosing({ branchId: '2', date: '2026-10-12' });
  assert.equal(closing.closed_by_name, 'Sample Desk');
  const { table, ops } = f.requests.at(-1);
  assert.equal(table, 'day_list_closings');
  const cols = ops.find((o: any) => o[0] === 'select')[1];
  assert.ok(!/snapshot|\*/.test(cols), `the copy itself is not asked for: ${cols}`);
  assert.ok(ops.some((o: any) => o[0] === 'eq' && o[1] === 'branch_id' && o[2] === 2) && ops.some((o: any) => o[0] === 'eq' && o[1] === 'list_date' && o[2] === '2026-10-12'));
  ({ data } = await openPage(() => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.day_list_closings'" }, status: 404 })));
  assert.equal(await data.dayClosing({ branchId: 2, date: '2026-10-12' }), null);
  ({ data } = await openPage(() => ({ data: null, error: { code: '42501', message: 'permission denied' }, status: 403 })));
  await assert.rejects(() => data.dayClosing({ branchId: 2, date: '2026-10-12' }), /permission denied/);
});

test('live: the Aaj ki List asks for its visits by token (none last), then created_at, then id: the order of the History\'s copy, also for an imported day', async () => {
  const { f, data } = await openPage(() => ({ data: [], error: null, status: 200 }));
  await data.listVisits({ branchId: '3', date: '2025-03-04' });
  const { ops } = f.requests.find((r: any) => r.table === 'visits');
  assert.deepEqual(ops.filter((o: any) => o[0] === 'order'),
    [['order', 'token_no', { ascending: true, nullsFirst: false }], ['order', 'created_at', { ascending: true }], ['order', 'id', { ascending: true }]]);
});

// ======================================================================================= the demo adapter
async function demoAs(id: string) {
  const d: any = createDemoAdapter();
  await d.signInDemo(id);
  return d;
}

test('demo: one day is ended already (North Nazimabad, five days ago, 21:05, by its front desk)', async () => {
  const d = await demoAs('s-admin');
  const day = addDaysISO(todayISO(), -5);
  const closing = await d.dayClosing({ branchId: 2, date: day });
  assert.equal(closing.closed_by_name, 'Front desk (North Nazimabad)');
  assert.equal(clinicTime(closing.closed_at), '21:05');
  const copy = await d.dayListCopy({ branchId: 2, date: day });
  assert.equal(copy.ended, true);
  assert.ok(copy.rows.length >= 3 && copy.rows.every((r: any) => r.status === 'completed'), 'its three braces patients, all completed');
  assert.deepEqual(copy.rows.map((r: any) => r.n), copy.rows.map((_: any, i: number) => i + 1));
  assert.ok(copy.rows.every((r: any) => r.kind === 'checkup' || r.mr), 'patients carry their Mr#');
  const lines = (await d.dayListHistory({ from: day, to: day })).rows;
  assert.deepEqual(lines.filter((r: any) => r.ended).map((r: any) => r.branch_id), [2], 'only North Nazimabad was ended that day');
  assert.ok(lines.some((r: any) => r.branch_id === 1 && !r.ended), 'Gulshan has a list that day too, not ended');
});

test('demo: endDay follows the database: permission, branch, never a day to come; ending again counts up; nothing on the list changes', async () => {
  const acct = await demoAs('s-acct');
  await assert.rejects(() => acct.endDay({ branchId: 2, date: todayISO() }), /NOT_ALLOWED: ending the day needs/);
  const desk = await demoAs('s-fd-nn');
  await assert.rejects(() => desk.endDay({ branchId: 1, date: todayISO() }), /only at the branches you work at/);
  await assert.rejects(() => desk.endDay({ branchId: 2, date: addDaysISO(todayISO(), 1) }), /FUTURE_DAY/);
  await assert.rejects(() => desk.endDay({ branchId: 2, date: '2023-12-31' }), /TOO_FAR_BACK: That date is too far back\./, 'before 2024: refused');
  assert.equal((await desk.endDay({ branchId: 2, date: '2024-01-01' })).total, 0, '1 Jan 2024 itself may be ended (an empty list here)');
  const before = JSON.stringify(await desk.listVisits({ branchId: 2, date: todayISO() }));
  const r = await desk.endDay({ branchId: 2, date: todayISO() });
  assert.equal(r.times_updated, 0);
  assert.equal(r.closed_by_name, 'Front desk (North Nazimabad)');
  assert.ok(r.total >= 8, `today's North Nazimabad list: ${r.total} rows`);
  assert.equal(JSON.stringify(await desk.listVisits({ branchId: 2, date: todayISO() })), before, 'ending the day changes no visit');
  const again = await desk.endDay({ branchId: 2, date: todayISO() });
  assert.equal(again.times_updated, 1);
  const line = (await desk.dayListHistory({ from: todayISO(), to: todayISO() })).rows;
  assert.deepEqual(line.map((x: any) => [x.branch_id, x.ended, x.times_updated]), [[2, true, 1]], 'the desk sees its own branch only');
  await assert.rejects(() => desk.dayListHistory({ branchId: 1 }), /NOT_ALLOWED/);
  await assert.rejects(() => desk.dayListCopy({ branchId: 1, date: todayISO() }), /NOT_ALLOWED/);
});

test('demo: the History pages newest first and filters by branch and dates; a day to come is never listed', async () => {
  const d = await demoAs('s-admin');
  const first = await d.dayListHistory({ limit: 5 });
  assert.equal(first.rows.length, 5);
  assert.ok(first.total > 5);
  const days = first.rows.map((r: any) => r.list_date);
  assert.deepEqual(days, [...days].sort().reverse(), 'newest first');
  assert.ok(first.rows.every((r: any) => r.list_date <= todayISO()), 'never a day to come (the sample patient has a booking in 24 days)');
  const second = await d.dayListHistory({ limit: 5, offset: 5 });
  assert.notDeepEqual(second.rows.map((r: any) => `${r.list_date}|${r.branch_id}`), first.rows.map((r: any) => `${r.list_date}|${r.branch_id}`));
  const nn = await d.dayListHistory({ branchId: 2, limit: 200 });
  assert.ok(nn.rows.length && nn.rows.every((r: any) => r.branch_id === 2));
  const today = await d.dayListHistory({ from: todayISO(), to: todayISO() });
  assert.deepEqual(today.rows.map((r: any) => r.branch_id), [1, 2], 'today: Gulshan and North Nazimabad have lists, in the branches\' order');
  assert.ok(today.rows.every((r: any) => !r.ended && r.counts.total > 0));
});

test('demo: a reader without "See pending dues" gets the copy without dues; without patient files, without the patients\' phones', async () => {
  const admin = await demoAs('s-admin');
  await admin.setOverride('s-asst', 'dues.view', false);
  await admin.setOverride('s-coord', 'patients.view', false);
  const day = todayISO(); // North Nazimabad's list of today, not ended: the list as stored now, with two checkup patients
  await admin.signInDemo('s-asst');
  let copy = await admin.dayListCopy({ branchId: 2, date: day });
  assert.ok(copy.rows.every((r: any) => !('dues' in r)));
  await admin.signInDemo('s-coord');
  copy = await admin.dayListCopy({ branchId: 2, date: day });
  assert.ok(copy.rows.filter((r: any) => r.kind === 'patient').every((r: any) => !('phone' in r)));
  assert.equal(copy.rows.find((r: any) => r.name === 'Bareera Khalid').phone, '0300-5550701', 'a checkup patient keeps the phone (as on the Checkups page)');
  await admin.signInDemo('s-admin');
  copy = await admin.dayListCopy({ branchId: 2, date: day });
  assert.ok(copy.rows.filter((r: any) => r.kind === 'patient').every((r: any) => typeof r.dues === 'number' && r.phone));
  assert.equal(copy.ended, false);
  assert.deepEqual(copy.rows.filter((r: any) => r.kind === 'checkup').map((r: any) => r.dues), [null, null], 'checkup patients have no dues');
});

test('demo: an imported day (every row added at one moment, no tokens) has the same order on the Aaj ki List and in its History copy', async () => {
  const d = await demoAs('s-admin');
  const day = addDaysISO(todayISO(), -400);
  assert.equal((await d.listVisits({ branchId: 2, date: day })).length, 0, 'a day with no other rows');
  const names = Array.from({ length: 12 }, (_, i) => `Imported Person ${String(i + 1).padStart(2, '0')}`);
  for (const [i, name] of names.entries()) await d.createPatient({ mr_number: String(77201 + i), full_name: name, phone: `031600${77201 + i}`, first_branch_id: 2 });
  const out = await d.importAajSheet(names.map((name, i) =>
    [day, 2, String(77201 + i), name, null, null, null, 'Checkup', null, 'completed', null, [], [], [], null, null, 'North Nazimabad', false, null]), false);
  assert.equal(out.visits_inserted, 12);
  const visits = await d.listVisits({ branchId: 2, date: day });
  assert.equal(new Set(visits.map((v: any) => v.created_at)).size, 1, 'one created_at');
  assert.ok(visits.every((v: any) => v.token_no == null), 'no tokens');
  // (all completed, no token, one created_at: the Aaj ki List's own sort keeps the order the rows came in)
  const list = visits.map((v: any) => v.id);
  assert.deepEqual((await d.dayListCopy({ branchId: 2, date: day })).rows.map((r: any) => r.id), list, 'the list as stored now');
  await d.endDay({ branchId: 2, date: day });
  assert.deepEqual((await d.dayListCopy({ branchId: 2, date: day })).rows.map((r: any) => r.id), list, 'the saved copy');
});
