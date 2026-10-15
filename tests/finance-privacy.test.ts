// The clinic's money is for Dr. Ali and accounts (owner, 15 Oct 2026: "no one can see the overall finances of the clinic except me and
// accounts. no assistant can see the income, only front desk can see the daily payments with each payment along with patient name. but
// not the full amount"). The permission grid, the demo adapter (which follows the database's rules of
// supabase/migrations/20261015000400_finance_privacy.sql) and the live adapter's requests. Made-up people only.
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
const { todayISO } = await import('../web/js/ui/dom.js');
const { PERMISSIONS, defaultGrid, hasPermission } = await import('../web/js/lib/permissions.js');

const ROLES = ['front_desk', 'assistant', 'doctor', 'coordinator', 'accountant', 'admin'];

test('permission grid: "Today\'s payments, one by one (no totals)" sits under Billing, on for the front desk and the accountant (as the database)', () => {
  const p = PERMISSIONS.find((x: any) => x.key === 'payments.day_list');
  assert.equal(p.label, "Today's payments, one by one (no totals)");
  assert.equal(p.category, 'Billing');
  assert.deepEqual(ROLES.filter((r) => hasPermission(r, 'payments.day_list', defaultGrid())), ['front_desk', 'accountant', 'admin']);
  const keys = PERMISSIONS.map((x: any) => x.key);
  assert.equal(keys.indexOf('payments.day_list'), keys.indexOf('billing.view') + 1, 'next to "View invoices and payments" in the access list');
});

// ======================================================================================= the demo adapter
/**
 * A demo page with the grid as the clinic has it live: "View invoices and payments" and discounts are for accounts and Dr. Ali; the
 * front desk makes invoices and takes payments ("Create invoices and take payments", 20261015000500_front_desk_billing.sql).
 */
async function demoLive() {
  const d: any = createDemoAdapter();
  await d.signInDemo('s-admin');
  for (const [role, key] of [['front_desk', 'billing.view'], ['front_desk', 'discount.give'], ['coordinator', 'billing.view']]) {
    await d.setRolePermission(role, key, false);
  }
  await d.setRolePermission('front_desk', 'billing.create', true);
  return d;
}
const as = async (d: any, id: string) => { await d.signOut(); await d.signInDemo(id); return d; };

test('demo: today\'s payments one by one: the desk sees its branch\'s, each with the patient, amount, method and who took it; never a total', async () => {
  const d = await as(await demoLive(), 's-fd-nn');
  const rows = await d.paymentsToday();
  assert.deepEqual(rows.map((r: any) => [r.patient_name, r.mr_number, r.amount, r.method, r.branch_id, r.received_by_name]), [
    ['Kinza Rauf', '9825', 8000, 'card', 2, 'Accountant (sample)'],
    ['Mariam Akhtar', '9824', 2500, 'cash', 2, 'Accountant (sample)'],
  ], 'North Nazimabad only, newest first');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['amount', 'branch_id', 'id', 'method', 'mr_number', 'patient_id', 'patient_name', 'received_at', 'received_by_name'],
    'rows only: no total, sum or count');
  await assert.rejects(() => d.paymentsToday({ branchId: 1 }), /only at the branches you work at/);
  await assert.rejects(() => d.todaysPayments(null), /row-level security/, 'not the billing list (with its total)');
  for (const id of ['s-asst', 's-doc', 's-coord']) {
    await as(d, id);
    await assert.rejects(() => d.paymentsToday(), /NOT_ALLOWED: today's payments need/, id);
  }
  await as(d, 's-acct');
  assert.deepEqual([...new Set((await d.paymentsToday()).map((r: any) => r.branch_id))].sort(), [1, 2, 4], 'the accountant: every branch with payments today');
});

test('demo: money totals refuse everyone but accounts and Dr. Ali; the Today rows carry no amounts for them', async () => {
  const d = await demoLive();
  for (const id of ['s-fd-nn', 's-asst', 's-doc', 's-coord']) {
    await as(d, id);
    await assert.rejects(() => d.totalDues(), /NOT_ALLOWED: money totals/, `${id}: total dues`);
    await assert.rejects(() => d.paymentsSummary({ from: todayISO(), to: todayISO() }), /row-level security/, `${id}: payment totals`);
    await assert.rejects(() => d.report('pnl_trend', todayISO(), todayISO()), /row-level security/, `${id}: reports`);
    const nn = (await d.dashboard(todayISO())).find((r: any) => r.branch.id === 2);
    assert.equal(nn.received, 0, `${id}: nothing received shown`);
    assert.equal(nn.dues, null, `${id}: the dues are not added up`);
    assert.equal(nn.dues_patients, 2, `${id}: how many patients on the list have dues`);
  }
  await as(d, 's-acct');
  assert.ok(await d.totalDues() > 0);
  const nn = (await d.dashboard(todayISO())).find((r: any) => r.branch.id === 2);
  assert.equal(nn.received, 10500, 'the accountant: what came in at North Nazimabad today');
  assert.equal(nn.dues, 30000, 'and the dues on its list, added up');
});

test('demo: the cash closing is a blind count for the desk; accounts see expected, counted and the difference', async () => {
  const d = await as(await demoLive(), 's-fd-nn');
  assert.equal(await d.expectedCash(2, todayISO()), 0, 'the desk is not given the day\'s cash');
  const c = await d.closeCash(2, todayISO(), 3000, 'Counted twice');
  assert.equal(c.counted_cash, 3000);
  assert.equal(c.expected_cash, null, 'not told the expected cash');
  assert.equal(c.difference, null, 'not told the difference');
  assert.deepEqual(await d.cashClosings(), [], 'the table with the amounts is not for the desk');
  const blind = await d.cashClosingsBlind();
  assert.deepEqual(blind.map((r: any) => [r.branch_id, r.closing_date, r.closed_by_name, r.checked]), [[2, todayISO(), 'Front desk (North Nazimabad)', false]]);
  assert.deepEqual(Object.keys(blind[0]).sort(), ['branch_id', 'checked', 'closed_at', 'closed_by_name', 'closing_date', 'id'], 'no amount and no note');
  const today = (await d.dashboard(todayISO())).find((r: any) => r.branch.id === 2);
  assert.equal(today.closing.difference, undefined, 'Today: closed, without how much it was off by');
  await as(d, 's-asst');
  await assert.rejects(() => d.cashClosingsBlind(), /NOT_ALLOWED/);
  await as(d, 's-acct');
  const [row] = await d.cashClosings();
  assert.deepEqual([row.expected_cash, row.counted_cash, row.difference], [2500, 3000, 500], 'expected = today\'s cash at North Nazimabad');
});

test('demo: the doctor dashboard\'s rupees only for accounts, Dr. Ali, or the doctor on their own', async () => {
  const d = await demoLive();
  const bushra = (await d.clinicians()).find((c: any) => c.display_name === 'Dr. Bushra (sample)').id;
  const from = todayISO().slice(0, 8) + '01';
  const money = (s: any) => [s.billed, s.referred_paid, s.share, s.rule];
  await as(d, 's-coord');
  const coord = await d.doctorSummary(bushra, from, todayISO());
  assert.deepEqual(money(coord), [null, null, null, null], 'the coordinator: no money');
  assert.equal(coord.referred_patients, 2, 'the coordinator: the counts');
  await as(d, 's-doc');
  assert.notEqual((await d.doctorSummary(bushra, from, todayISO())).rule, null, 'the doctor on their own, with "See own doctor percentage"');
  await as(d, 's-admin');
  await d.setRolePermission('doctor', 'commission.view_own', false);
  await as(d, 's-doc');
  assert.deepEqual(money(await d.doctorSummary(bushra, from, todayISO())), [null, null, null, null], 'without it: no money on their own either');
  await as(d, 's-acct');
  assert.equal(typeof (await d.doctorSummary(bushra, from, todayISO())).billed, 'number', 'the accountant');
});

test('demo: a patient\'s invoices and payments: none for the assistant; the front desk (Create invoices and take payments) bills, takes payments and makes plans at its branch, and gets no totals', async () => {
  const d = await demoLive();
  const hamza = (await d.searchPatients('Hamza'))[0];
  await as(d, 's-asst');
  const p = await d.getPatient(hamza.id);
  assert.deepEqual([p.invoices.length, p.payments.length, p.plans.length, p.dues], [0, 0, 0, 15000], 'the assistant: only the dues');
  await assert.rejects(() => d.patientBilling(hamza.id), /NOT_ALLOWED/);
  await assert.rejects(() => d.createInvoice({ patient_id: hamza.id, branch_id: 2, items: [{ description: 'Sample', quantity: 1, unit_price: 100 }] }), /row-level security/,
    'the assistant makes no invoice');
  await as(d, 's-fd-nn');
  const own = await d.patientBilling(hamza.id);
  assert.equal(own.invoices.length, 1, 'the desk: that patient\'s invoice');
  assert.equal((await d.getPatient(hamza.id)).invoices.length, 1, 'and on the profile\'s Money panel');
  const inv = await d.createInvoice({ patient_id: hamza.id, branch_id: 2, items: [{ description: 'Sample', quantity: 1, unit_price: 1000 }] });
  assert.deepEqual([inv.status, inv.total], ['issued', 1000], 'the desk makes an invoice (save_invoice reads it back with the billers policy)');
  await assert.rejects(() => d.createInvoice({ patient_id: hamza.id, branch_id: 1, items: [{ description: 'Sample', quantity: 1, unit_price: 100 }] }), /row-level security/,
    'not at a branch it does not work at');
  const pay = await d.recordPayment({ patient_id: hamza.id, branch_id: 2, amount: 5000, method: 'cash', invoice_id: inv.id });
  assert.equal(pay.amount, 5000, 'the payment is answered back (for the receipt)');
  assert.equal((await d.getPatient(hamza.id)).dues, 11000, 'the payment is taken');
  assert.ok((await d.paymentsToday()).some((r: any) => r.patient_name === 'Hamza Qureshi' && r.amount === 5000 && r.received_by_name === 'Front desk (North Nazimabad)'));
  await d.savePaymentPlan({ patient_id: hamza.id, total_fee: 60000, starts_on: todayISO(), installments: [{ due_date: todayISO(), amount: 60000 }] });
  assert.deepEqual([(await d.getPatient(hamza.id)).plans.length, (await d.paymentPlans(hamza.id)).length], [1, 1], 'and an installment plan, which it reads back');
  await assert.rejects(() => d.totalDues(), /NOT_ALLOWED: money totals/, 'and still no totals');
  await assert.rejects(() => d.paymentsSummary({ from: todayISO(), to: todayISO() }), /row-level security/, 'nor the payments added up');
  assert.equal((await d.dashboard(todayISO())).find((r: any) => r.branch.id === 2).received, 0, 'nor what came in today');
  // "Create invoices and take payments" unticked for the desk: the patient's invoices and payments are with accounts again.
  await as(d, 's-admin');
  await d.setRolePermission('front_desk', 'billing.create', false);
  await as(d, 's-fd-nn');
  const none = await d.getPatient(hamza.id);
  assert.deepEqual([none.invoices.length, none.payments.length, none.plans.length], [0, 0, 0]);
  await assert.rejects(() => d.patientBilling(hamza.id), /NOT_ALLOWED/);
});

test('demo: a payment taken at another branch is not read by a branch-restricted front desk, but the dues it gets with the invoices count it (the payment form fills in no more than the dues)', async () => {
  const d = await demoLive();
  const hamza = (await d.searchPatients('Hamza'))[0];
  await as(d, 's-fd-nn');
  const before = await d.patientBilling(hamza.id);
  assert.equal(before.dues, 15000, 'the desk sees the dues flag ("See $$ pending dues flag"), so the dues come with the invoices');
  await as(d, 's-admin');
  await d.recordPayment({ patient_id: hamza.id, branch_id: 1, amount: 4000, method: 'cash', invoice_id: before.invoices[0].id });
  await as(d, 's-fd-nn');
  const after = await d.patientBilling(hamza.id);
  assert.equal(after.payments.length, before.payments.length, 'the Gulshan payment is not read ("billers view payments": its own branches)');
  assert.equal(after.dues, 11000, 'the dues count every branch');
  await as(d, 's-admin');
  await d.setRolePermission('front_desk', 'dues.view', false);
  await as(d, 's-fd-nn');
  assert.equal((await d.patientBilling(hamza.id)).dues, undefined, 'without the dues flag, no dues');
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
/** A live page signed in as a staff member with these permissions (getSession is answered without asking the login server). */
async function livePage(perms: string[], answer: (table: string, ops: any[]) => any = () => ({ data: [], error: null, status: 200 })) {
  const f = fakeClient(answer);
  (globalThis as any).__fakeCreateClient = () => f.client();
  const data: any = await createSupabaseAdapter();
  data.getSession = async () => ({ kind: 'staff', staff: { id: 'u1', role: 'front_desk', active: true }, perms: new Set(perms) });
  return { f, data };
}

test('live: today\'s payments and the blind closings come from the database functions; before the update the payments say missing and the closings come without amounts', async () => {
  const { f, data } = await livePage(['payments.day_list', 'cash.close']);
  f.rpcAnswer = (name: string) => ({ data: name === 'payments_today' ? [{ id: 'y1', patient_name: 'Sample Payer', amount: 2500 }] : [{ id: 'c1', checked: false }], error: null, status: 200 });
  assert.deepEqual(await data.paymentsToday(), [{ id: 'y1', patient_name: 'Sample Payer', amount: 2500 }]);
  await data.paymentsToday({ branchId: '2' });
  assert.deepEqual(await data.cashClosingsBlind(), [{ id: 'c1', checked: false }]);
  assert.deepEqual(f.rpcs, [{ name: 'payments_today', args: { p_branch: null } }, { name: 'payments_today', args: { p_branch: 2 } }, { name: 'cash_closings_blind', args: { p_limit: 200 } }]);
  // Before the database update: no payments list, and the closer reads the closings from the table (the old "view closings" policy
  // lets them) asking only for the columns without any amount.
  const closed = { id: 'c0', branch_id: 2, closing_date: '2026-10-14', closed_at: '2026-10-14T16:00:00Z', verified_at: null, verified_by: null };
  const old = await livePage(['payments.day_list', 'cash.close'], (table: string) => ({ data: table === 'cash_closings' ? [closed] : [], error: null, status: 200 }));
  old.f.rpcAnswer = () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 });
  assert.equal((await old.data.paymentsToday()).missing, true);
  assert.deepEqual(await old.data.cashClosingsBlind(), [{ id: 'c0', branch_id: 2, closing_date: '2026-10-14', closed_at: '2026-10-14T16:00:00Z', closed_by_name: null, checked: false }]);
  const asked = old.f.requests.find((r: any) => r.table === 'cash_closings').ops.find((o: any) => o[0] === 'select')[1];
  assert.equal(asked, 'id,branch_id,closing_date,closed_at,verified_at,verified_by', 'no expected cash, counted cash, difference or notes');
  const none = await livePage(['cash.close'], () => ({ data: null, error: { code: '42501', message: 'permission denied' }, status: 403 }));
  none.f.rpcAnswer = old.f.rpcAnswer;
  assert.equal((await none.data.cashClosingsBlind()).missing, true, 'if the table cannot be read either: an empty list marked missing');
});

test('live: before the database update the desk\'s Today still says the cash is closed; the dues are asked for 100 patients at a time', async () => {
  const visits = Array.from({ length: 250 }, (_, i) => ({ branch_id: 2, status: 'waiting', patient_id: 'p' + i }));
  const answer = (table: string) => ({ data: table === 'branches' ? [{ id: 2, name: 'North Nazimabad', active: true }] : table === 'visits' ? visits
    : table === 'cash_closings' ? [{ id: 'c0', branch_id: 2, closing_date: todayISO(), closed_at: 'x', verified_at: null, verified_by: null }] : [], error: null, status: 200 });
  const desk = await livePage(['cash.close', 'dues.view', 'payments.day_list'], answer);
  desk.f.rpcAnswer = (name: string, args: any) => (name === 'dues_for' ? { data: args.p_patients.map((id: string) => ({ patient_id: id, dues: id === 'p7' ? 900 : 0 })), error: null, status: 200 }
    : { data: null, error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 });
  const [row] = await desk.data.dashboard(todayISO());
  assert.deepEqual([row.closing?.id, row.closing?.expected_cash, row.closing?.difference, row.dues, row.dues_patients], ['c0', undefined, undefined, null, 1]);
  assert.deepEqual(desk.f.rpcs.filter((r: any) => r.name === 'dues_for').map((r: any) => r.args.p_patients.length), [100, 100, 50],
    'the database answers at most 500 a call to whoever does not see the totals');
});

test('live: the desk\'s Today asks for the closings without amounts and does not add up the dues; accounts read the closings themselves', async () => {
  const visits = [{ branch_id: 2, status: 'waiting', patient_id: 'pa' }, { branch_id: 2, status: 'completed', patient_id: 'pb' }];
  const answer = (table: string) => ({ data: table === 'branches' ? [{ id: 2, name: 'North Nazimabad', active: true }] : table === 'visits' ? visits : [], error: null, status: 200 });
  const desk = await livePage(['cash.close', 'dues.view', 'payments.day_list'], answer);
  desk.f.rpcAnswer = (name: string) => ({ data: name === 'dues_for' ? [{ patient_id: 'pa', dues: 4000 }, { patient_id: 'pb', dues: 0 }]
    : name === 'cash_closings_blind' ? [{ id: 'c1', branch_id: 2, closing_date: todayISO(), checked: false }] : [], error: null, status: 200 });
  const [row] = await desk.data.dashboard(todayISO());
  assert.deepEqual([row.dues, row.dues_patients, row.closing?.id, row.received], [null, 1, 'c1', 0]);
  assert.ok(!desk.f.requests.some((r: any) => r.table === 'cash_closings'), 'the desk never reads the cash_closings table');
  assert.ok(!desk.f.requests.some((r: any) => r.table === 'branch_daily_income'), 'nor the branch\'s income');
  const acct = await livePage(['finance.view', 'billing.view', 'cash.verify', 'dues.view'], answer);
  acct.f.rpcAnswer = (name: string) => ({ data: name === 'dues_for' ? [{ patient_id: 'pa', dues: 4000 }] : [], error: null, status: 200 });
  const [a] = await acct.data.dashboard(todayISO());
  assert.equal(a.dues, 4000);
  assert.ok(acct.f.requests.some((r: any) => r.table === 'cash_closings'), 'accounts read the closings with their amounts');
  assert.ok(acct.f.requests.some((r: any) => r.table === 'branch_daily_income'), 'and what came in');
  assert.ok(!acct.f.rpcs.some((r: any) => r.name === 'cash_closings_blind'));
});

test('live: the front desk (Create invoices and take payments, no View invoices and payments) reads a patient\'s invoices and payments and the new payment back from the tables, as accounts do', async () => {
  // 20261015000500_front_desk_billing.sql: billing.create reads back the invoices, lines and payments of its branches, so the website
  // asks the tables for both, with no database function of their own.
  for (const perms of [['billing.create', 'payments.day_list', 'cash.close'], ['billing.view', 'billing.create']]) {
    const { f, data } = await livePage(perms, (table: string, ops: any[]) => ({
      data: ops.some((o: any) => o[0] === 'single') ? { id: 'y9', table } : [{ id: table + '-1', patient_id: 'pt-1' }], error: null, status: 200 }));
    const got = await data.patientBilling('pt-1');
    assert.deepEqual([got.invoices[0].id, got.payments[0].id], ['invoices-1', 'payments-1'], perms.join(','));
    assert.ok(!f.rpcs.length, `${perms.join(',')}: no database function`);
    assert.deepEqual(await data.recordPayment({ patient_id: 'pt-1', branch_id: '2', amount: '5000', method: 'cash' }), { id: 'y9', table: 'payments' });
    const insert = f.requests.find((r: any) => r.table === 'payments' && r.ops.some((o: any) => o[0] === 'insert'));
    assert.ok(insert.ops.some((o: any) => o[0] === 'insert' && o[1].amount === 5000 && o[1].branch_id === 2) && insert.ops.some((o: any) => o[0] === 'select'),
      `${perms.join(',')}: the payment is sent and read back (for the receipt)`);
  }
});

test('live: with the dues flag, the payment form\'s invoices and payments come with the patient\'s dues (dues_for, every branch); without it no dues are asked for', async () => {
  const { f, data } = await livePage(['billing.create', 'dues.view']);
  f.rpcAnswer = (name: string) => ({ data: name === 'dues_for' ? [{ patient_id: 'pt-1', dues: 7000 }] : [], error: null, status: 200 });
  assert.equal((await data.patientBilling('pt-1')).dues, 7000);
  assert.deepEqual(f.rpcs.map((r: any) => [r.name, r.args.p_patients]), [['dues_for', ['pt-1']]]);
  const blind = await livePage(['billing.create']);
  assert.equal((await blind.data.patientBilling('pt-1')).dues, undefined);
  assert.equal(blind.f.rpcs.length, 0);
});
