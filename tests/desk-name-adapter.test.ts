// Shared logins in the live data layer (web/js/data/supabase.js), run against a stand-in for supabase-js and for the network (the
// real library is loaded from a CDN in the browser; nothing here reaches a server). What it pins down:
//   - the x-desk-name header: the client's own fetch adds it, percent-encoded (an Urdu name survives), to the database's REST
//     requests (tables and functions: /rest/v1/) sent with the token of the login the name was given for, and to nothing else (the
//     login server, the Edge Functions, Storage; another login's token; the public key); setDeskName(null) stops it;
//   - the probe: one small read tries the header first. Refused: the requests go without it and still work, and it is not tried
//     again; no answer at all, or only a slow one with the header: the requests go without it, reads never wait, and it is tried
//     again a minute later, not for every request; a change waits for a probe that is running, so it can carry the name;
//   - the list of names and the "Shared login" switch before the database update is run (missing, SHARED_LOGIN_MISSING).
// Made-up names only.
import { test, mock } from 'node:test';
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

// ---- the network: every request is recorded and answered here (never a real server)
type Call = { url: string; method: string; headers: Headers };
const calls: Call[] = [];
let answer: (url: string, init: any) => Promise<Response> = async () => new Response('[]', { status: 200 });
(globalThis as any).fetch = (input: any, init: any = {}) => {
  const url = String(input?.url ?? input);
  calls.push({ url, method: String(init.method || 'GET').toUpperCase(), headers: new Headers(init.headers) });
  return answer(url, init);
};
const PROBE = '/rest/v1/branches?select=id&limit=1';
const probes = () => calls.filter((c) => c.url.endsWith(PROBE));
const named = (c: Call | undefined) => c?.headers.get('x-desk-name') ?? null;

// ---- the SDK import of the adapter (a CDN URL) is answered by this stand-in; its options (global.fetch) are kept
registerHooks({
  resolve(spec, ctx, nextResolve) {
    if (spec.startsWith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@')) {
      return { url: 'data:text/javascript,export const createClient = (...a) => globalThis.__fakeCreateClient(...a);', shortCircuit: true };
    }
    return nextResolve(spec, ctx);
  },
});
const { createSupabaseAdapter } = await import('../web/js/data/supabase.js');
const { CONFIG } = await import('../web/js/config.js');
const BASE = String(CONFIG.SUPABASE_URL).replace(/\/+$/, '');

type Op = [string, ...any[]];
function fakeClient(reply: (table: string, ops: Op[]) => any) {
  const f: any = { requests: [] as Array<{ table: string; ops: Op[] }> };
  const from = (table: string) => {
    const ops: Op[] = [];
    const b: any = new Proxy({}, {
      get(_t, name) {
        if (name === 'then') return (res: any, rej: any) => { f.requests.push({ table, ops }); return Promise.resolve(reply(table, ops)).then(res, rej); };
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
    from,
    rpc: () => { const r: any = Promise.resolve({ data: null, error: null }); r.abortSignal = () => r; return r; },
    channel() { const ch: any = { on: () => ch, subscribe: () => ch }; return ch; },
    removeChannel() {},
    functions: { invoke: async () => ({ data: null, error: null }) },
    storage: { from: () => ({}) },
  });
  return f;
}
/** Moves the clock on (the probe's minute between tries). */
const later = (ms: number) => { const now = Date.now(); mock.method(Date, 'now', () => now + ms); };
/** A new page: a fresh adapter, its client's own fetch (send), and the recorded table requests. */
async function openPage(reply: (table: string, ops: Op[]) => any = () => ({ data: [], error: null, status: 200 })) {
  const f = fakeClient(reply);
  let send: any = null;
  (globalThis as any).__fakeCreateClient = (_url: string, _key: string, opts: any) => { send = opts.global.fetch; return f.client(); };
  const data: any = await createSupabaseAdapter();
  calls.length = 0;
  return { f, data, send: (path: string, init: any = {}) => send(`${BASE}${path}`, init) };
}
const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
const as = (sub: string, init: any = {}) => ({ ...init, headers: { Authorization: `Bearer ${jwt({ sub, session_id: 'sess-1' })}`, ...(init.headers || {}) } });
const tick = () => new Promise((r) => setTimeout(r, 0));
const URDU = 'عائشہ نمونہ'; // "Ayesha Namuna" (a made-up name)
const ok = () => new Response('[]', { status: 200 });

test('the name goes, percent-encoded, with every database request of the login it was given for', async () => {
  answer = async () => ok();
  const { data, send } = await openPage();
  data.setDeskName('u1', URDU);
  await tick();
  assert.equal(probes().length, 1, 'one probe, as soon as the name is set');
  assert.equal(named(probes()[0]), encodeURIComponent(URDU), 'the probe tries the header itself');
  for (const [path, method] of [['/rest/v1/visits?id=eq.5', 'PATCH'], ['/rest/v1/rpc/end_day', 'POST'], ['/rest/v1/patients?select=*', 'GET'], ['/rest/v1/visits?id=eq.6', 'DELETE']]) {
    calls.length = 0;
    const res = await send(path, as('u1', { method, body: method === 'GET' ? undefined : '{}' }));
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1, `${method} ${path}: sent once, no new probe`);
    assert.equal(named(calls[0]), '%D8%B9%D8%A7%D8%A6%D8%B4%DB%81%20%D9%86%D9%85%D9%88%D9%86%DB%81', `${method} ${path}`);
    assert.match(named(calls[0])!, /^[\x21-\x7e]+$/, 'plain ASCII only');
  }
  data.setDeskName('u1', 'Sample Hina');
  calls.length = 0;
  await send('/rest/v1/visits?id=eq.5', as('u1', { method: 'PATCH', body: '{}' }));
  assert.equal(named(calls[0]), 'Sample%20Hina', 'a new name is used from the next request on (Change name)');
  assert.equal(probes().length, 0, 'the header is known to be taken: no new probe');
});

test('never to the login server, the Edge Functions or Storage, nor with another login\'s token or the public key', async () => {
  answer = async () => ok();
  const { data, send } = await openPage();
  data.setDeskName('u1', 'Sample Sadia');
  await tick();
  calls.length = 0;
  await send('/auth/v1/user', as('u1'));
  await send('/functions/v1/admin-users', as('u1', { method: 'POST', body: '{}' }));
  await send('/storage/v1/object/photos/a.jpg', as('u1'));
  assert.deepEqual(calls.map(named), [null, null, null], 'only /rest/v1/ requests carry it');
  calls.length = 0;
  await send('/rest/v1/visits?id=eq.5', as('u2', { method: 'PATCH', body: '{}' }));
  await send('/rest/v1/branches?select=*', { headers: { Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}` } });
  await send('/rest/v1/branches?select=*');
  assert.deepEqual(calls.map(named), [null, null, null], 'another login (the next person signed in meanwhile), the public key, no token: no name');
  data.setDeskName(null, null);
  calls.length = 0;
  await send('/rest/v1/visits?id=eq.5', as('u1', { method: 'PATCH', body: '{}' }));
  assert.equal(named(calls[0]), null, 'setDeskName(null): no name any more (logout, Change name)');
  data.setDeskName('u1', null);
  await send('/rest/v1/visits?id=eq.5', as('u1', { method: 'PATCH', body: '{}' }));
  assert.equal(named(calls[1]), null);
});

test('a server that refuses the header: the requests go without it and still work, and it is not tried again', async () => {
  // A browser whose CORS check refuses the header fails the request before it is sent ("Failed to fetch").
  answer = async (_url, init) => (new Headers(init.headers).has('x-desk-name') ? Promise.reject(new TypeError('Failed to fetch')) : ok());
  const { data, send } = await openPage();
  data.setDeskName('u1', 'Sample Sadia');
  const res = await send('/rest/v1/visits?id=eq.5', as('u1', { method: 'PATCH', body: '{}' }));
  assert.equal(res.status, 200, 'the change is saved');
  assert.deepEqual(probes().map((c) => named(c) !== null), [true, false, true], 'tried with it, without it, and with it once more (one dropped request is not a refusal)');
  const sent = calls.filter((c) => !c.url.endsWith(PROBE));
  assert.equal(sent.length, 1);
  assert.equal(named(sent[0]), null, 'sent without the name');
  calls.length = 0;
  await send('/rest/v1/visits?id=eq.6', as('u1', { method: 'PATCH', body: '{}' }));
  await send('/rest/v1/patients?select=*', as('u1'));
  assert.equal(probes().length, 0, 'not tried again on this page');
  assert.deepEqual(calls.map(named), [null, null]);
  later(10 * 60 * 1000);
  await send('/rest/v1/visits?id=eq.7', as('u1', { method: 'PATCH', body: '{}' }));
  mock.restoreAll();
  assert.equal(probes().length, 0, 'a refusal is final for the page, even minutes later');
});

test('a slow answer to the header (it timed out while the plain request got through) is no refusal: tried again a minute later', async () => {
  const slow = () => Object.assign(new Error('The clinic server took too long to answer.'), { name: 'TIMEOUT' });
  answer = async (_url, init) => (new Headers(init.headers).has('x-desk-name') ? Promise.reject(slow()) : ok());
  const { data, send } = await openPage();
  data.setDeskName('u1', 'Sample Sadia');
  await send('/rest/v1/visits?id=eq.5', as('u1', { method: 'PATCH', body: '{}' }));
  assert.equal(probes().length, 3, 'with, without, with');
  assert.equal(named(calls.at(-1)), null, 'the change went without the name');
  calls.length = 0;
  await send('/rest/v1/visits?id=eq.6', as('u1', { method: 'PATCH', body: '{}' }));
  assert.equal(probes().length, 0, 'not tried again at once');
  answer = async () => ok(); // the connection is better now
  later(61 * 1000);
  await send('/rest/v1/visits?id=eq.7', as('u1', { method: 'PATCH', body: '{}' }));
  mock.restoreAll();
  assert.equal(probes().length, 1, 'tried again a minute later');
  assert.equal(named(calls.at(-1)), 'Sample%20Sadia', 'and from then on the name goes with the changes');
});

test('no answer to the probe: reads never wait for it, a change waits for a running one, and it is not tried for every request', async () => {
  // The probe hangs until the test lets it go (a slow branch connection).
  const held: Array<() => void> = [];
  answer = (url) => (url.endsWith(PROBE) ? new Promise<Response>((resolve) => { held.push(() => resolve(ok())); }) : Promise.resolve(ok()));
  const { data, send } = await openPage();
  data.setDeskName('u1', 'Sample Sadia');
  const read = await send('/rest/v1/patients?select=*', as('u1'));
  assert.equal(read.status, 200, 'a read goes at once, while the probe is still waiting');
  assert.equal(named(calls.find((c) => c.url.includes('/patients'))), null, '... without the name (not known yet)');
  let saved = false;
  const save = send('/rest/v1/visits?id=eq.5', as('u1', { method: 'PATCH', body: '{}' })).then(() => { saved = true; });
  await tick();
  assert.equal(saved, false, 'a change waits for the probe that is running (a few seconds at most)');
  held.forEach((go) => go());
  await save;
  assert.equal(named(calls.find((c) => c.url.includes('/visits'))), 'Sample%20Sadia', 'so it carries the name');

  // No connection at all for the probe: the requests go without the name, and the probe is not repeated for each of them.
  answer = (url) => (url.endsWith(PROBE) ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(ok()));
  const next = await openPage();
  next.data.setDeskName('u1', 'Sample Sadia');
  await next.send('/rest/v1/visits?id=eq.5', as('u1', { method: 'PATCH', body: '{}' }));
  assert.deepEqual(probes().map((c) => named(c) !== null), [true, false], 'tried with and without it: no answer either way');
  calls.length = 0;
  for (let i = 0; i < 3; i++) await next.send(`/rest/v1/visits?id=eq.${i}`, as('u1', { method: 'PATCH', body: '{}' }));
  await next.send('/rest/v1/patients?select=*', as('u1'));
  assert.equal(probes().length, 0, 'not tried again for every request (a minute later at the earliest)');
  assert.deepEqual(calls.map(named), [null, null, null, null], 'and they all went, without the name');
  later(61 * 1000);
  await next.send('/rest/v1/patients?select=*', as('u1'));
  mock.restoreAll();
  assert.ok(probes().length >= 1, 'a minute later it is tried again (in the background: the read did not wait for it)');
  await tick();
  await tick();
});

test('the list of names and the "Shared login" switch: what they send, and before the database update is run', async () => {
  let reply: any = { data: null, error: null, status: 201 };
  const { f, data } = await openPage(() => reply);
  assert.deepEqual(await data.saveDeskName('  Sample   Sadia '), { missing: false });
  assert.deepEqual(f.requests.at(-1), { table: 'desk_names', ops: [['insert', { staff_id: 'u1', name: 'Sample Sadia' }]] }, 'the tidied name, for the login signed in');
  await assert.rejects(data.saveDeskName('S'), /at least 2 letters/, 'a name that is too short is not sent');
  reply = { data: null, error: { code: 'PGRST205', message: 'Could not find the table' }, status: 404 };
  assert.deepEqual(await data.saveDeskName('Sample Sadia'), { missing: true }, 'no table yet: the person still gets through');
  const missing = await data.deskNamesOf('s-x');
  assert.deepEqual([...missing], []);
  assert.equal(missing.missing, true, '"Names used" says the update is needed');
  reply = { data: [{ id: 2, name: 'Sample Hina', entered_at: '2026-10-15T04:00:00Z' }], error: null, status: 200 };
  const rows = await data.deskNamesOf('s-x', { days: 60 });
  assert.equal(rows.length, 1);
  const ops = f.requests.at(-1).ops;
  assert.deepEqual(ops.filter((o: Op) => o[0] === 'eq'), [['eq', 'staff_id', 's-x']]);
  assert.deepEqual(ops.filter((o: Op) => o[0] === 'order'), [['order', 'entered_at', { ascending: false }], ['order', 'id', { ascending: false }]], 'newest first');
  const since = Date.parse(ops.find((o: Op) => o[0] === 'gte')[2]);
  assert.ok(Math.abs(Date.now() - 60 * 86400000 - since) < 60000, 'the last 60 days');
  reply = { data: null, error: { code: 'PGRST204', message: "Could not find the 'shared_login' column" }, status: 400 };
  await assert.rejects(data.setStaffShared('s-x', true), (e: any) => e.code === 'SHARED_LOGIN_MISSING' && /database update/.test(e.message));
  reply = { data: [], error: null, status: 200 };
  await assert.rejects(data.setStaffShared('s-x', true), /not saved/, 'no row changed (row-level security): said, not taken as saved');
  reply = { data: [{ id: 's-x' }], error: null, status: 200 };
  await data.setStaffShared('s-x', false);
  assert.deepEqual(f.requests.at(-1).ops.slice(0, 2), [['update', { shared_login: false }], ['eq', 'id', 's-x']]);
});
