// Half in cash, half by card (owner, 17 Oct 2026: "some times patient pays half in cash and half by card or smthng, there should be a
// add payment too so multiple payment forms could be entered"). What the payment rows of the invoice form and the Take payment dialog
// say (web/js/lib/split-payments.js), and each payment saved once however often it is sent: the demo adapter and the live adapter take
// a payment's idempotency key as its id (no database change). Made-up people only.
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
const { readPayments, nextMethod } = await import('../web/js/lib/split-payments.js');
const { createSupabaseAdapter } = await import('../web/js/data/supabase.js');
const { createDemoAdapter } = await import('../web/js/data/demo.js');

const METHODS = [{ value: 'cash' }, { value: 'card' }, { value: 'bank_transfer' }, { value: 'cheque' }, { value: 'other' }];

test('the rows: Cash 20,000 + Card 15,000 are two payments that add up to 35,000', () => {
  assert.deepEqual(readPayments([{ method: 'cash', amount: '20000' }, { method: 'card', amount: '15000' }]), {
    errors: [], paid: 35000,
    payments: [{ index: 0, method: 'cash', amount: 20000 }, { index: 1, method: 'card', amount: 15000 }],
  });
});

test('the rows: one row is one payment, as before; nothing typed or 0 is no payment', () => {
  assert.deepEqual(readPayments([{ method: 'card', amount: ' 5000 ' }]).payments, [{ index: 0, method: 'card', amount: 5000 }]);
  for (const amount of ['', '0', '  ', null, undefined]) {
    assert.deepEqual(readPayments([{ method: 'cash', amount }]), { errors: [], payments: [], paid: 0 }, String(amount));
  }
  assert.deepEqual(readPayments([]), { errors: [], payments: [], paid: 0 });
  assert.deepEqual(readPayments([{ method: 'cash', amount: '0' }, { method: 'card', amount: '15000' }, { method: 'cheque', amount: '' }]).payments,
    [{ index: 1, method: 'card', amount: 15000 }], 'a row left at 0 or empty is left out, the others keep their place');
});

test('the rows: the same method twice is two payments (unusual, allowed), added up', () => {
  const out = readPayments([{ method: 'cash', amount: '10000' }, { method: 'cash', amount: '2500' }]);
  assert.equal(out.payments.length, 2);
  assert.equal(out.paid, 12500);
});

test('the rows: a negative or unreadable amount is an error on that row, and is not counted', () => {
  const out = readPayments([{ method: 'cash', amount: '20000' }, { method: 'card', amount: '-500' }, { method: 'other', amount: 'abc' }]);
  assert.deepEqual(out.errors.map((e: any) => e.index), [1, 2]);
  assert.match(out.errors[0].message, /cannot be negative/);
  assert.equal(out.paid, 20000);
  assert.deepEqual(out.payments.map((p: any) => p.index), [0]);
});

test('a new row starts with a method no row has yet (Cash taken: Card), else the first', () => {
  assert.equal(nextMethod(METHODS, ['cash']), 'card');
  assert.equal(nextMethod(METHODS, ['cash', 'card']), 'bank_transfer');
  assert.equal(nextMethod(METHODS, []), 'cash');
  assert.equal(nextMethod(METHODS, METHODS.map((m) => m.value)), 'cash');
});

test('demo: each payment of a split is its own payment on the invoice; the same key sent again is the payment saved the first time', async () => {
  const d: any = createDemoAdapter();
  await d.signInDemo('s-admin');
  const p = (await d.searchPatients('Hamza'))[0];
  const before = (await d.patientBilling(p.id)).payments.length;
  const inv = await d.createInvoice({ patient_id: p.id, branch_id: 2, items: [{ description: 'Sample treatment', quantity: 1, unit_price: 35000 }] });
  const cashKey = crypto.randomUUID();
  const cardKey = crypto.randomUUID();
  const cash = await d.recordPayment({ patient_id: p.id, branch_id: 2, amount: 20000, method: 'cash', invoice_id: inv.id, idempotencyKey: cashKey }, { idempotencyKey: cashKey });
  const card = await d.recordPayment({ patient_id: p.id, branch_id: 2, amount: 15000, method: 'card', invoice_id: inv.id }, { idempotencyKey: cardKey });
  const again = await d.recordPayment({ patient_id: p.id, branch_id: 2, amount: 15000, method: 'card', invoice_id: inv.id, idempotencyKey: cardKey });
  assert.equal(again.id, card.id, 'a retry answers the payment already saved');
  const mine = (await d.patientBilling(p.id)).payments.filter((x: any) => x.invoice_id === inv.id);
  assert.deepEqual(mine.map((x: any) => [x.method, x.amount]), [['cash', 20000], ['card', 15000]], 'two payments, one per method');
  assert.equal((await d.patientBilling(p.id)).payments.length, before + 2);
  assert.notEqual(cash.id, card.id);
  // Without a key, as before: each call is a payment.
  await d.recordPayment({ patient_id: p.id, branch_id: 2, amount: 100, method: 'cash', invoice_id: inv.id });
  await d.recordPayment({ patient_id: p.id, branch_id: 2, amount: 100, method: 'cash', invoice_id: inv.id });
  assert.equal((await d.patientBilling(p.id)).payments.length, before + 4);
});

// ---- the live adapter, with a made-up Supabase client that records what is asked
function fakeClient(answer: (table: string, ops: any[]) => any) {
  const f: any = { requests: [] as any[] };
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
    rpc: () => { const r: any = Promise.resolve({ data: null, error: null, status: 200 }); r.abortSignal = () => r; return r; },
    channel() { const ch: any = { on: () => ch, subscribe: () => ch }; return ch; },
    removeChannel() {},
    functions: { invoke: async () => ({ data: null, error: null }) },
    storage: { from: () => ({}) },
  });
  return f;
}
async function livePage(answer: (table: string, ops: any[]) => any) {
  const f = fakeClient(answer);
  (globalThis as any).__fakeCreateClient = () => f.client();
  const data: any = await createSupabaseAdapter();
  data.getSession = async () => ({ kind: 'staff', staff: { id: 'u1', role: 'front_desk', active: true }, perms: new Set(['billing.create']) });
  return { f, data };
}
const inserted = (f: any) => f.requests.filter((r: any) => r.table === 'payments' && r.ops.some((o: any) => o[0] === 'insert')).map((r: any) => r.ops.find((o: any) => o[0] === 'insert')[1]);

test('live: the payment\'s key is its id; sent again after a lost answer, the database refuses a second row (23505) and the one saved is read back', async () => {
  const key = crypto.randomUUID();
  const savedRow = { id: key, patient_id: 'pt-1', branch_id: 2, amount: 15000, method: 'card', invoice_id: 'inv-1', received_at: '2026-10-17T10:00:00Z' };
  let first = true;
  const { f, data } = await livePage((_table: string, ops: any[]) => {
    if (ops.some((o: any) => o[0] === 'insert')) {
      if (first) { first = false; return { data: savedRow, error: null, status: 201 }; }
      return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "payments_pkey"' }, status: 409 };
    }
    if (ops.some((o: any) => o[0] === 'eq' && o[1] === 'id' && o[2] === key)) return { data: savedRow, error: null, status: 200 };
    return { data: null, error: null, status: 200 };
  });
  const pay = { patient_id: 'pt-1', branch_id: '2', amount: '15000', method: 'card', invoice_id: 'inv-1' };
  assert.deepEqual(await data.recordPayment(pay, { idempotencyKey: key }), savedRow);
  assert.deepEqual(await data.recordPayment({ ...pay, idempotencyKey: key }), savedRow, 'the retry answers the payment saved the first time');
  const rows = inserted(f);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r: any) => r.id === key && r.amount === 15000 && r.branch_id === 2 && r.method === 'card' && r.invoice_id === 'inv-1'), JSON.stringify(rows));
  assert.ok(!('idempotencyKey' in rows[0]), 'the key goes in as the id, not as a column of its own');
});

test('live: a 23505 whose row cannot be read back is still saved (answered as it was sent); without a key there is no id, and an error is an error', async () => {
  const key = crypto.randomUUID();
  const dup = await livePage((_table: string, ops: any[]) => (ops.some((o: any) => o[0] === 'insert')
    ? { data: null, error: { code: '23505', message: 'duplicate key' }, status: 409 } : { data: null, error: null, status: 200 }));
  const got = await dup.data.recordPayment({ patient_id: 'pt-1', branch_id: 2, amount: 20000, method: 'cash', invoice_id: 'inv-1' }, { idempotencyKey: key });
  assert.deepEqual([got.id, got.amount, got.method, got.invoice_id], [key, 20000, 'cash', 'inv-1']);
  const plain = await livePage(() => ({ data: { id: 'y1' }, error: null, status: 201 }));
  await plain.data.recordPayment({ patient_id: 'pt-1', branch_id: 2, amount: 500, method: 'cash' });
  assert.ok(!('id' in inserted(plain.f)[0]), 'no key: the database makes the id');
  const refused = await livePage(() => ({ data: null, error: { code: '23505', message: 'duplicate key' }, status: 409 }));
  await assert.rejects(() => refused.data.recordPayment({ patient_id: 'pt-1', branch_id: 2, amount: 500, method: 'cash' }), /duplicate key/, 'without a key a 23505 is not taken as saved');
  const denied = await livePage(() => ({ data: null, error: { code: '42501', message: 'new row violates row-level security policy' }, status: 403 }));
  await assert.rejects(() => denied.data.recordPayment({ patient_id: 'pt-1', branch_id: 9, amount: 500, method: 'cash' }, { idempotencyKey: key }), /row-level security/);
});
