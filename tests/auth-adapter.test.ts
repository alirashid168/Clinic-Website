// The login side of the live data layer (web/js/data/supabase.js), run against a stand-in for supabase-js (the real library is
// loaded from a CDN in the browser). What it pins down:
//   - a final answer of the login server about the account (403 user_banned, 403 user_not_found) or a switched-off staff row ends the
//     login on this computer, with a reason, and getSession() fails with ACCOUNT_OFF / ACCOUNT_GONE;
//   - nothing transient ever does (offline, timeout, 5xx, 408, 429, a 4xx the server gave for another reason);
//   - the reason travels with SIGNED_OUT, also to the other tabs of the browser, which see only the event;
//   - a token refresh that is answered with a rate limit or a proxy's error page cannot make auth-js delete the stored login;
//   - another tab's hand-made removal of the stored login (no event) still reaches this tab;
//   - updateVisit asks the login server who the user is only when an override needs it;
//   - a reason belongs to one logout and to the person it was about: it is used once per tab, goes at the next logout without one and
//     when somebody else is logged in (on any tab), and never labels a later person's logout;
//   - every question about the login is asked with the stored token, and an answer about a login that is no longer the stored one
//     (somebody else signed in, or nobody) never ends, labels or reports the stored login: it fails with LOGIN_CHANGED;
//   - empty answers are never proof when a refresh landed or another person signed in meanwhile (LOGIN_UNCONFIRMED);
//   - a token refresh refused by something that is not the login server (JSON without an error code) keeps the login;
//   - a logout request that hangs is given up with the 4 s, so it cannot remove a later login (every request in flight, not only the latest);
//   - a token refresh answered 409 (GoTrue's row lock gave up) keeps the login like any other "try again";
//   - a refusal of a refresh that was sent for somebody else's login (answered after another person signed in) notes and asks nothing;
//   - GET /user answered "session not found" about a session that is not the stored one any more is dropped before auth-js can delete
//     the login stored now;
//   - an answer that finds nobody stored, with a fresh note that this very login was just ended for this very reason (another tab got
//     there first), is given as that reason; the first look of a page does the same for the login the page opened with.
// The stand-in only models the answers of supabase-js (error names, statuses, codes); the same adapter was also run against the real
// auth-js 2.117.2 with a fake login server when this was written.
import { test } from 'node:test';
import { setImmediate as nextTick } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setMaxListeners } from 'node:events';

// ---- a browser-like page shared by every "tab" of these tests
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
const { createSupabaseAdapter } = await import('../web/js/data/supabase.js');

const KEY = 'sb-test-auth-token';
const authError = (name: string, status: number | undefined, code?: string) => Object.assign(new Error(code || name), { name, status, code });
const answer = (error: any) => ({ data: { user: null }, error });
const GOOD_USER = { data: { user: { id: 'u1' } }, error: null };
/** The login a tab has stored: whose it is, and the access token that goes with it (the real library keeps both in its session). */
const loginOf = (id: string, token = `tok-${id}`) => ({ access_token: token, user: { id } });

/**
 * A stand-in for one tab's supabase-js client: the login it has stored (getSession()), what getUser() answers, which tables hold what,
 * and a record of what was called (the token each getUser() and each table read was sent with).
 */
function fakeClient() {
  const f: any = {
    session: loginOf('u1') as any, // what getSession() holds: the stored login, or null
    getSessionError: null as any, // set: getSession() answers no session and this error (a refresh that failed)
    user: GOOD_USER as any, // the next getUser() answer, or a function giving it (it may be async)
    tables: { staff: [{ id: 'u1', role: 'admin', active: true }], patients: [], visits: [{ id: 'v1', patient_id: 'p1' }] } as Record<string, any>,
    signOuts: [] as any[], getUserCalls: 0, getUserJwts: [] as any[], reads: [] as string[], readAuth: [] as Array<[string, string | undefined]>,
    updates: [] as any[], listeners: new Set<Function>(), fetchOption: null as any,
    signInResult: { data: {}, error: null } as any,
    invokes: [] as any[], invokeAnswer: { data: null, error: null } as any, userUpdates: [] as any[], resets: [] as any[],
  };
  f.emit = (event: string, session: any = null) => { for (const cb of [...f.listeners]) cb(event, session); };
  f.auth = {
    storageKey: KEY,
    async getSession() { return f.session ? { data: { session: f.session }, error: null } : { data: { session: null }, error: f.getSessionError }; },
    async getUser(jwt?: string) { f.getUserCalls += 1; f.getUserJwts.push(jwt); const r = typeof f.user === 'function' ? await f.user() : f.user; if (r instanceof Error) throw r; return r; },
    async signOut(opts: any) { f.signOuts.push(opts); f.session = null; store.delete(KEY); f.emit('SIGNED_OUT'); return { error: null }; }, // auth-js sends SIGNED_OUT before it answers
    onAuthStateChange(cb: Function) { f.listeners.add(cb); return { data: { subscription: { unsubscribe: () => f.listeners.delete(cb) } } }; },
    async signInWithPassword() { return f.signInResult; },
    async updateUser(attrs: any) { f.userUpdates.push(attrs); return { data: {}, error: null }; },
    async resetPasswordForEmail(email: string) { f.resets.push(email); return { data: {}, error: null }; },
    stopAutoRefresh() {},
  };
  f.from = (table: string) => {
    let single = false;
    let authorization: string | undefined;
    const b: any = {
      select() { return b; }, eq() { return b; }, in() { return b; }, is() { return b; }, order() { return b; },
      setHeader(name: string, value: string) { if (name === 'Authorization') authorization = value; return b; },
      maybeSingle() { single = true; return b; }, single() { single = true; return b; },
      insert() { return b; }, update(patch: any) { f.updates.push([table, patch]); return b; },
      then(resolve: any, reject: any) {
        f.reads.push(table);
        f.readAuth.push([table, authorization]);
        const t = f.tables[table];
        return Promise.resolve(typeof t === 'function' ? t() : t).then((got) => {
          const rows = got ?? [];
          return { data: single ? (rows[0] ?? null) : rows, error: null };
        }).then(resolve, reject);
      },
    };
    return b;
  };
  f.client = (options: any) => {
    f.fetchOption = options?.global?.fetch;
    const rpc = () => { const r: any = Promise.resolve({ data: [], error: null }); r.abortSignal = () => r; return r; };
    return { auth: f.auth, from: f.from, rpc, functions: { invoke: async (name: string, opts: any) => { f.invokes.push([name, opts.body]); return typeof f.invokeAnswer === 'function' ? f.invokeAnswer() : f.invokeAnswer; } }, storage: { from: () => ({}) } };
  };
  return f;
}

const tabs: Array<() => void> = [];
/** One "tab": an adapter on a fresh stand-in client, with the events its onAuthChange listener hears. */
async function openTab(f = fakeClient()) {
  (globalThis as any).__fakeCreateClient = (_url: string, _key: string, options: any) => f.client(options);
  const data = await createSupabaseAdapter();
  const heard: any[] = [];
  const stop = data.onAuthChange((event: string, reason: string | null) => heard.push([event, reason]));
  tabs.push(stop);
  return { f, data, heard, stop };
}
/** Starts a test on a blank browser: no stored data, and the tabs of earlier tests no longer listen. */
const fresh = () => { store.clear(); for (const stop of tabs.splice(0)) stop(); };
const banned = authError('AuthApiError', 403, 'user_banned');
const gone = authError('AuthApiError', 403, 'user_not_found');

test('403 user_banned (a switched-off account on a token that is still valid) ends the login on this computer and says why', async () => {
  fresh();
  const { f, data, heard } = await openTab();
  f.user = answer(banned);
  await assert.rejects(() => data.getSession(), (e: any) => e.code === 'ACCOUNT_OFF' && /switched off/.test(e.message));
  assert.deepEqual(f.signOuts, [{ scope: 'local' }], 'only this computer; the server decides about the others');
  assert.deepEqual(heard, [['SIGNED_OUT', 'switched_off']]);
});

test('403 user_not_found (the account was deleted) ends the login with the account_gone reason', async () => {
  fresh();
  const { f, data, heard } = await openTab();
  f.user = answer(gone);
  await assert.rejects(() => data.getSession(), (e: any) => e.code === 'ACCOUNT_GONE');
  assert.deepEqual(f.signOuts, [{ scope: 'local' }]);
  assert.deepEqual(heard, [['SIGNED_OUT', 'account_gone']]);
});

test('a staff row that comes back with active=false ends the login with the switched_off reason', async () => {
  fresh();
  const { f, data, heard } = await openTab();
  f.tables.staff = [{ id: 'u1', role: 'admin', active: false }];
  await assert.rejects(() => data.getSession(), (e: any) => e.code === 'ACCOUNT_OFF');
  assert.deepEqual(f.signOuts, [{ scope: 'local' }]);
  assert.deepEqual(heard, [['SIGNED_OUT', 'switched_off']]);
});

test('signing in with a switched-off account (400 user_banned) says it the same way', async () => {
  fresh();
  const { f, data } = await openTab();
  f.signInResult = { data: {}, error: authError('AuthApiError', 400, 'user_banned') };
  await assert.rejects(() => data.signIn('a@dralirashid.com', 'x'), (e: any) => e.code === 'ACCOUNT_OFF' && e.message === 'This account is switched off. Contact Dr. Ali.');
});

test('nothing transient ends the login: offline, timeout, 5xx, 52x, 408, 429, an HTML error page', async () => {
  fresh();
  const errors = [
    authError('AuthRetryableFetchError', 0), authError('AuthRetryableFetchError', 503), authError('AuthRetryableFetchError', 522),
    authError('AuthApiError', 429, 'over_request_rate_limit'), authError('AuthApiError', 408), authError('AuthUnknownError', undefined), authError('AuthApiError', 500),
    Object.assign(new Error('The clinic server took too long to answer.'), { name: 'TIMEOUT', code: 'ABORT_ERR' }),
  ];
  for (const error of errors) {
    const { f, data, heard } = await openTab();
    f.user = answer(error);
    await assert.rejects(() => data.getSession(), (e: any) => e.code !== 'ACCOUNT_OFF' && e.code !== 'ACCOUNT_GONE', error.message);
    assert.deepEqual(f.signOuts, [], `${error.name} ${error.status}`);
    assert.deepEqual(heard, []);
  }
});

test('a 4xx the server gave for another reason (bad_jwt) is "nobody", not a logout', async () => {
  fresh();
  const { f, data, heard } = await openTab();
  f.user = answer(authError('AuthApiError', 401, 'bad_jwt'));
  assert.equal(await data.getSession(), null);
  assert.deepEqual(f.signOuts, []);
  assert.deepEqual(heard, []);
});

test('strict getSession (the login watcher): a login the server knows but without any staff or patient record is gone', async () => {
  fresh();
  const { f, data, heard } = await openTab();
  f.tables.staff = [];
  assert.equal(await data.getSession(), null, 'the plain call keeps answering nobody');
  assert.deepEqual(f.signOuts, []);
  await assert.rejects(() => data.getSession({ strict: true }), (e: any) => e.code === 'ACCOUNT_GONE');
  assert.deepEqual(f.signOuts, [{ scope: 'local' }]);
  assert.deepEqual(heard, [['SIGNED_OUT', 'account_gone']]);
});

test('strict getSession: one empty answer (a request that went out without the token) is not proof; the second read finds the row', async () => {
  fresh();
  const { f, data, heard } = await openTab();
  let staffReads = 0;
  f.tables.staff = () => (++staffReads === 1 ? [] : [{ id: 'u1', role: 'admin', active: true }]);
  const session = await data.getSession({ strict: true });
  assert.equal(session?.kind, 'staff');
  assert.deepEqual(f.signOuts, []);
  assert.deepEqual(heard, []);
});

test('strict getSession: empty answers do not count when the login server cannot be asked again', async () => {
  fresh();
  const { f, data } = await openTab();
  f.tables.staff = [];
  let asked = 0;
  f.user = () => (++asked === 1 ? GOOD_USER : answer(authError('AuthRetryableFetchError', 0)));
  await assert.rejects(() => data.getSession({ strict: true }), (e: any) => e.code !== 'ACCOUNT_GONE');
  assert.deepEqual(f.signOuts, []);
});

// ---- the reason, across tabs
test('an idle logout names its reason for the other tabs of this browser, which only see SIGNED_OUT', async () => {
  fresh();
  const a = await openTab();
  const b = await openTab();
  await a.data.signOut({ scope: 'local', reason: 'idle' });
  b.f.emit('SIGNED_OUT'); // what the BroadcastChannel delivers to tab B
  assert.deepEqual(b.heard, [['SIGNED_OUT', 'idle']]);
});

test('an ordinary logout has no reason; a reason does not outlive 5 minutes or the next sign-in', async () => {
  fresh();
  const a = await openTab();
  const b = await openTab();
  await a.data.signOut(); // Log out clicked
  b.f.emit('SIGNED_OUT');
  assert.deepEqual(b.heard, [['SIGNED_OUT', null]]);

  await a.data.signOut({ scope: 'local', reason: 'idle' });
  const saved = JSON.parse(store.get('clinic-logout-reason') as string);
  store.set('clinic-logout-reason', JSON.stringify({ ...saved, at: saved.at - (5 * 60 * 1000 + 1000) }));
  b.f.emit('SIGNED_OUT');
  assert.equal(b.heard[1][1], null, 'too old');

  await a.data.signOut({ scope: 'local', reason: 'idle' });
  await a.data.signIn('a@dralirashid.com', 'x');
  b.f.emit('SIGNED_OUT');
  assert.equal(b.heard[2][1], null, 'a new sign-in clears it');
});

test('a tab that was frozen in the background and thaws a minute or two later still hears why the login ended', async () => {
  fresh();
  const a = await openTab();
  const b = await openTab(); // the frozen one: it only runs the SIGNED_OUT that was queued for it when it thaws
  await a.data.signOut({ scope: 'local', reason: 'switched_off' });
  const saved = JSON.parse(store.get('clinic-logout-reason') as string);
  store.set('clinic-logout-reason', JSON.stringify({ ...saved, at: saved.at - 2 * 60 * 1000 }));
  b.f.emit('SIGNED_OUT');
  assert.deepEqual(b.heard, [['SIGNED_OUT', 'switched_off']]);
});

test('only SIGNED_OUT carries a reason', async () => {
  fresh();
  const a = await openTab();
  await a.data.signOut({ scope: 'local', reason: 'idle' });
  a.f.emit('SIGNED_IN');
  a.f.emit('TOKEN_REFRESHED');
  assert.deepEqual(a.heard.map((h) => h[1]), [ 'idle', null, null ]);
});

// ---- a login removed by hand in another tab
test('another tab removing the stored login by hand (no auth-js event) still ends this tab, with the same reason', async () => {
  fresh();
  const { data, heard, stop } = await openTab();
  store.set(KEY, '{"access_token":"x"}');
  const storageEvent = (key: string | null) => Object.assign(new Event('storage'), { key });
  page.dispatchEvent(storageEvent(KEY)); // the key is still there (a refresh rewrote it): nothing happened
  page.dispatchEvent(storageEvent('some-other-key'));
  assert.deepEqual(heard, []);
  store.delete(KEY);
  page.dispatchEvent(storageEvent('some-other-key'));
  assert.deepEqual(heard, [], 'a different key says nothing about the login');
  page.dispatchEvent(storageEvent(KEY));
  assert.deepEqual(heard, [['SIGNED_OUT', null]]);
  page.dispatchEvent(storageEvent(null)); // localStorage.clear()
  assert.equal(heard.length, 2);
  stop();
  page.dispatchEvent(storageEvent(KEY));
  assert.equal(heard.length, 2, 'stopped listening');
  void data;
});

// ---- the token refresh
const json = (status: number, body: unknown, type = 'application/json') => new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const REFRESH = 'https://x.supabase.co/auth/v1/token?grant_type=refresh_token';

async function viaFetch(f: any, url: string, response: Response, init: any = { method: 'POST', body: '{}' }) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => response) as any;
  try { return await f.fetchOption(url, init); } finally { globalThis.fetch = realFetch; }
}

test('a token refresh answered with a rate limit, a timeout, any 5xx or a proxy error page fails like a lost connection, so auth-js keeps the login', async () => {
  fresh();
  const { f } = await openTab();
  const kept = [
    json(429, { code: 'over_request_rate_limit', message: 'Request rate limit reached' }),
    json(408, { code: 'request_timeout' }),
    json(409, { code: 'conflict', message: 'Too many concurrent token refresh requests on the same session or refresh token' }),
    new Response('<html>Attention required</html>', { status: 403, headers: { 'content-type': 'text/html' } }),
    new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
    new Response('blocked', { status: 451 }),
    json(503, { message: 'Service Unavailable' }),
    json(507, { message: 'Insufficient Storage' }),
    json(544, { message: 'upstream timeout' }), // Supabase's own upstream-timeout code: auth-js does not retry it
  ];
  for (const response of kept) {
    await assert.rejects(() => viaFetch(f, REFRESH, response), TypeError, `status ${response.status}`);
  }
});

test('a token refresh answered by the login server itself passes through unchanged (auth-js then decides)', async () => {
  fresh();
  const { f } = await openTab();
  for (const response of [
    json(200, { access_token: 'a' }),
    json(400, { code: 'refresh_token_not_found', message: 'Invalid Refresh Token: Refresh Token Not Found' }),
    json(400, { error_code: 'refresh_token_already_used', msg: 'Invalid Refresh Token: Already Used' }),
  ]) {
    const got = await viaFetch(f, REFRESH, response);
    assert.equal(got.status, response.status);
  }
});

test('other requests are left alone: a 429 on a logout or a read is returned as it is', async () => {
  fresh();
  const { f } = await openTab();
  const got = await viaFetch(f, 'https://x.supabase.co/auth/v1/logout?scope=local', json(429, {}));
  assert.equal(got.status, 429);
  const read = await viaFetch(f, 'https://x.supabase.co/rest/v1/staff?select=*', new Response('<html></html>', { status: 403, headers: { 'content-type': 'text/html' } }), { method: 'GET' });
  assert.equal(read.status, 403);
});

test('a refresh refused because the account is banned or deleted gives the SIGNED_OUT that follows its reason', async () => {
  fresh();
  for (const [code, reason] of [['user_banned', 'switched_off'], ['user_not_found', 'account_gone']]) {
    const { f, heard } = await openTab();
    const got = await viaFetch(f, REFRESH, json(400, { code, message: 'x' }));
    assert.equal(got.status, 400, 'the answer still goes to auth-js');
    f.emit('SIGNED_OUT'); // what auth-js does next, having deleted the login
    assert.deepEqual(heard, [['SIGNED_OUT', reason]]);
    store.delete('clinic-logout-reason');
  }
  // the legacy shape of the body
  const { f, heard } = await openTab();
  await viaFetch(f, REFRESH, json(400, { code: 400, error_code: 'user_banned', msg: 'x' }));
  f.emit('SIGNED_OUT');
  assert.deepEqual(heard, [['SIGNED_OUT', 'switched_off']]);
});

// ---- N1
test('updateVisit asks the login server who the user is only when an override needs it', async () => {
  fresh();
  const { f, data } = await openTab();
  f.user = answer(authError('AuthRetryableFetchError', 503)); // the login server is having a bad moment
  await data.updateVisit('v1', { status: 'completed', patient: { id: 'p1' } });
  assert.equal(f.getUserCalls, 0);
  assert.deepEqual(f.updates, [['visits', { status: 'completed' }]]);

  f.user = GOOD_USER;
  await data.updateVisit('v1', { dues_override_by: true, protocol_override_by: true, dues_override_note: 'ok' });
  assert.equal(f.getUserCalls, 1);
  assert.deepEqual(f.updates[1], ['visits', { dues_override_by: 'u1', protocol_override_by: 'u1', dues_override_note: 'ok' }]);
});

// ---- messages: a reason belongs to one logout and to the person it was about
const NOTE_KEY = 'clinic-logout-reason';
const storedAs = (id: string) => store.set(KEY, JSON.stringify({ access_token: `tok-${id}`, user: { id } }));

test('a reason is used once per tab: a later SIGNED_OUT of the same tab (another logout) does not repeat it', async () => {
  fresh();
  const a = await openTab();
  await a.data.signOut({ scope: 'local', reason: 'idle' });
  a.f.emit('SIGNED_OUT'); // e.g. the next person's logout, within the note's few minutes
  assert.deepEqual(a.heard, [['SIGNED_OUT', 'idle'], ['SIGNED_OUT', null]]);
});

test('a logout without a reason (Log out clicked) removes the reason of an earlier logout: no other tab repeats it', async () => {
  fresh();
  const a = await openTab();
  const b = await openTab();
  await a.data.signOut({ scope: 'local', reason: 'idle' }); // an idle logout...
  a.f.session = loginOf('u2');
  await a.data.signOut(); // ...and, within a few minutes, somebody else's own Log out
  b.f.emit('SIGNED_OUT'); // what tab B hears of it
  assert.deepEqual(b.heard, [['SIGNED_OUT', null]], 'the generic wording, not "no activity"');
  assert.equal(store.has(NOTE_KEY), false);
});

test('another person logging in, on any tab, removes the reason of the person before (switched off, then the next person)', async () => {
  fresh();
  const a = await openTab();
  const b = await openTab();
  storedAs('u1');
  a.f.user = answer(banned);
  await assert.rejects(() => a.data.getSession(), (e: any) => e.code === 'ACCOUNT_OFF');
  assert.deepEqual(a.heard, [['SIGNED_OUT', 'switched_off']]);
  assert.equal(JSON.parse(store.get(NOTE_KEY) as string).uid, 'u1', 'the note names the person it is about');
  b.f.emit('SIGNED_IN', loginOf('u2')); // Sara signs in (here or in a third tab); every tab hears it
  assert.equal(store.has(NOTE_KEY), false);
  b.f.emit('SIGNED_OUT'); // ...and later logs out
  assert.deepEqual(b.heard, [['SIGNED_IN', null], ['SIGNED_OUT', null]], 'Sara is not told that her account was switched off');
});

test('a refresh refused as banned names the person whose login it was, so the next person does not inherit the reason', async () => {
  fresh();
  const { f, heard } = await openTab();
  storedAs('u1');
  await viaFetch(f, REFRESH, json(400, { code: 'user_banned', message: 'x' }));
  assert.equal(JSON.parse(store.get(NOTE_KEY) as string).uid, 'u1');
  f.emit('SIGNED_IN', loginOf('u2'));
  f.emit('SIGNED_OUT');
  assert.deepEqual(heard, [['SIGNED_IN', null], ['SIGNED_OUT', null]]);
});

test('events of the same person (a refresh, a tab focus) keep the reason for the tabs that have not heard it yet', async () => {
  fresh();
  const a = await openTab();
  const b = await openTab();
  storedAs('u1');
  await a.data.signOut({ scope: 'local', reason: 'idle' });
  b.f.emit('TOKEN_REFRESHED', loginOf('u1'));
  b.f.emit('SIGNED_OUT');
  assert.deepEqual(b.heard, [['TOKEN_REFRESHED', null], ['SIGNED_OUT', 'idle']]);
});

// ---- races: an answer about an old login never ends the stored one
/** Holds an answer back until the test lets it go: the slow network of a real race. */
function held<T>(value: T) {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { release, wait, answer: async () => { await wait; return value; } };
}

test('a late 403 user_banned about the OLD token neither ends nor labels the login of the person who signed in meanwhile', async () => {
  fresh();
  const { f, data, heard } = await openTab();
  const slow = held(answer(banned));
  f.user = slow.answer;
  const asking = data.getSession(); // asked with Ali's token
  await nextTick();
  f.session = loginOf('u2'); // Sara signs in meanwhile
  slow.release();
  await assert.rejects(asking, (e: any) => e.code === 'LOGIN_CHANGED');
  assert.deepEqual(f.signOuts, [], 'Sara is not logged out (nor her server session revoked)');
  assert.deepEqual(heard, []);
  assert.equal(store.has(NOTE_KEY), false, 'no reason is left behind for her either');
});

test('a late "inactive" staff row about the old person neither ends nor labels the login of the person who signed in meanwhile', async () => {
  fresh();
  const { f, data, heard } = await openTab();
  const slow = held([{ id: 'u1', role: 'admin', active: false }]);
  f.tables.staff = slow.answer;
  const asking = data.getSession();
  await nextTick();
  f.session = loginOf('u2');
  slow.release();
  await assert.rejects(asking, (e: any) => e.code === 'LOGIN_CHANGED');
  assert.deepEqual(f.signOuts, []);
  assert.deepEqual(heard, []);
});

test('a late answer about a login that is gone (nobody is logged in any more) ends nothing and leaves no reason behind', async () => {
  fresh();
  const { f, data, heard } = await openTab();
  const slow = held(answer(banned));
  f.user = slow.answer;
  const asking = data.getSession();
  await nextTick();
  f.session = null; // Ali logged out meanwhile
  slow.release();
  await assert.rejects(asking, (e: any) => e.code === 'LOGIN_CHANGED');
  assert.deepEqual(f.signOuts, []);
  assert.deepEqual(heard, []);
  assert.equal(store.has(NOTE_KEY), false);
});

test('a lookup that finishes after another person signed in does not report the earlier person (it fails with LOGIN_CHANGED)', async () => {
  fresh();
  const { f, data } = await openTab();
  const slow = held([{ id: 'u1', role: 'admin', active: true }]);
  f.tables.staff = slow.answer;
  const asking = data.getSession({ strict: true });
  await nextTick();
  f.session = loginOf('u2');
  slow.release();
  await assert.rejects(asking, (e: any) => e.code === 'LOGIN_CHANGED');
});

test('the login server and every profile read are asked with the stored token, not whatever the library holds when the request goes out', async () => {
  fresh();
  const { f, data } = await openTab();
  f.session = loginOf('u1', 'tok-A');
  f.tables.staff = [{ id: 'u1', role: 'frontdesk', active: true }];
  const session = await data.getSession();
  assert.equal(session?.kind, 'staff');
  assert.deepEqual(f.getUserJwts, ['tok-A']);
  assert.deepEqual(f.readAuth.map(([, authorization]) => authorization), ['Bearer tok-A', 'Bearer tok-A', 'Bearer tok-A'], 'staff row, role grid and overrides');
  f.readAuth.length = 0;
  f.tables.staff = [];
  await data.getSession({ fresh: true }); // a patient lookup
  assert.deepEqual(f.readAuth, [['staff', 'Bearer tok-A'], ['patients', 'Bearer tok-A']]);
});

// ---- false logouts
test('strict getSession: empty answers are not proof when a refresh landed meanwhile (the token was replaced): nobody is logged out', async () => {
  fresh();
  const { f, data, heard } = await openTab();
  f.tables.staff = () => { f.session = loginOf('u1', 'tok-new'); return []; }; // tab B's refresh lands while this lookup reads
  await assert.rejects(() => data.getSession({ strict: true }), (e: any) => e.code === 'LOGIN_UNCONFIRMED');
  assert.deepEqual(f.signOuts, []);
  assert.deepEqual(heard, []);
  assert.ok(f.readAuth.every(([, authorization]) => authorization === 'Bearer tok-u1'), 'every read carried the token the lookup began with');
});

test('strict getSession: empty answers are not proof when another person signed in meanwhile', async () => {
  fresh();
  const { f, data } = await openTab();
  f.tables.staff = () => { f.session = loginOf('u2'); return []; };
  await assert.rejects(() => data.getSession({ strict: true }), (e: any) => e.code !== 'ACCOUNT_GONE');
  assert.deepEqual(f.signOuts, []);
});

test('a refresh that failed for a reason that says nothing about the login (offline, 5xx, 429) is not "nobody": the lookup fails, the login stays', async () => {
  fresh();
  const { f, data, heard } = await openTab();
  f.session = null;
  for (const error of [authError('AuthRetryableFetchError', 0), authError('AuthRetryableFetchError', 503), authError('AuthApiError', 429, 'over_request_rate_limit')]) {
    f.getSessionError = error;
    await assert.rejects(() => data.getSession(), (e: any) => e.code !== 'ACCOUNT_OFF' && e.code !== 'ACCOUNT_GONE', error.message);
  }
  f.getSessionError = authError('AuthApiError', 400, 'refresh_token_not_found'); // the library already ended that login
  assert.equal(await data.getSession(), null);
  assert.deepEqual(f.signOuts, []);
  assert.deepEqual(heard, []);
});

test('the periodic check (fresh: true) reads the account record again; an ordinary lookup answers from the remembered one', async () => {
  fresh();
  const { f, data } = await openTab();
  assert.equal((await data.getSession({ strict: true }))?.kind, 'staff');
  f.tables.staff = [{ id: 'u1', role: 'admin', active: false }]; // switched off since
  assert.equal((await data.getSession({ strict: true }))?.staff.active, true, 'remembered until the next login event');
  await assert.rejects(() => data.getSession({ strict: true, fresh: true }), (e: any) => e.code === 'ACCOUNT_OFF');
  assert.deepEqual(f.signOuts, [{ scope: 'local' }]);
});

test('a token refresh refused with JSON that carries no login-server error code (an API gateway, a WAF) keeps the login like a lost connection', async () => {
  fresh();
  const { f } = await openTab();
  for (const response of [
    json(401, { message: 'Invalid API key' }),
    json(403, { message: 'Forbidden' }),
    json(400, { error: 'bad request' }),
    json(401, {}),
    new Response('not json at all', { status: 401, headers: { 'content-type': 'application/json' } }),
  ]) {
    await assert.rejects(() => viaFetch(f, REFRESH, response), TypeError, `status ${response.status}`);
  }
  // the login server's own answers (a code, or the OAuth-style description) still reach auth-js
  for (const response of [json(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Already Used' }), json(400, { code: 'session_not_found' })]) {
    assert.equal((await viaFetch(f, REFRESH, response)).status, 400);
  }
});

// ---- a hung logout
test('a logout request that never answers is given up when its 4 seconds are over, so it cannot remove a later login when it ends', async (t) => {
  fresh();
  const { f, data } = await openTab();
  const realFetch = globalThis.fetch;
  let signal: AbortSignal | undefined;
  globalThis.fetch = ((_url: any, init: any) => new Promise((_resolve, reject) => {
    signal = init?.signal;
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  })) as any;
  // what auth-js does: its signOut waits for the request, and removes whatever login is stored when that ends
  f.auth.signOut = async (opts: any) => {
    f.signOuts.push(opts);
    try { await f.fetchOption('https://x.supabase.co/auth/v1/logout?scope=local', { method: 'POST', headers: {} }); } catch (error) { return { error }; }
    return { error: null };
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const ending = data.signOut({ scope: 'local', reason: 'switched_off' });
    await nextTick();
    t.mock.timers.tick(4000);
    assert.equal(await ending, false, 'the server never confirmed');
    assert.equal(signal?.aborted, true, 'the request was given up, not left hanging');
  } finally {
    t.mock.timers.reset();
    globalThis.fetch = realFetch;
  }
});

// ---- a refresh that auth-js keeps the login after (the access token still works): ask the login server
const later = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

test('a refresh refused as "refresh token not found" while the access token still works: the login server tells a deleted account apart, and the person is told', async () => {
  fresh();
  const { f, heard } = await openTab();
  f.user = answer(gone); // GET /user with the still valid access token: 403 user_not_found
  const got = await viaFetch(f, REFRESH, json(400, { code: 'refresh_token_not_found', message: 'Invalid Refresh Token: Refresh Token Not Found' }));
  assert.equal(got.status, 400, 'the answer still goes to auth-js');
  await later();
  assert.deepEqual(f.getUserJwts, ['tok-u1'], 'asked with the stored token');
  assert.deepEqual(f.signOuts, [{ scope: 'local' }]);
  assert.deepEqual(heard, [['SIGNED_OUT', 'account_gone']]);
});

test('the same refusal when the login server still knows the account (an ended session only) ends nothing here: auth-js decides', async () => {
  fresh();
  const { f, heard } = await openTab();
  f.user = GOOD_USER;
  await viaFetch(f, REFRESH, json(400, { code: 'refresh_token_not_found', message: 'x' }));
  await later();
  assert.equal(f.getUserCalls, 1);
  assert.deepEqual(f.signOuts, []);
  assert.deepEqual(heard, []);
});

test('a refresh refused as banned while the access token still works ends the login at once, with the switched_off reason', async () => {
  fresh();
  const { f, heard } = await openTab();
  f.user = answer(banned);
  await viaFetch(f, REFRESH, json(400, { code: 'user_banned', message: 'x' }));
  await later();
  assert.deepEqual(f.signOuts, [{ scope: 'local' }]);
  assert.deepEqual(heard, [['SIGNED_OUT', 'switched_off']]);
});

test('refused refreshes ask the login server once, not once per attempt (auth-js retries and ticks)', async () => {
  fresh();
  const { f } = await openTab();
  f.user = GOOD_USER;
  for (let i = 0; i < 4; i++) await viaFetch(f, REFRESH, json(400, { code: 'refresh_token_not_found', message: 'x' }));
  await later();
  assert.equal(f.getUserCalls, 1);
});

test('a refusal with nobody stored any more (the login is already gone) asks nothing and ends nothing', async () => {
  fresh();
  const { f, heard } = await openTab();
  f.session = null; // auth-js already removed it: the access token had run out
  f.user = answer(gone);
  await viaFetch(f, REFRESH, json(400, { code: 'refresh_token_not_found', message: 'x' }));
  await later();
  assert.equal(f.getUserCalls, 0);
  assert.deepEqual(f.signOuts, []);
  assert.deepEqual(heard, []);
});

// ---- loop 2: late answers about an old login, and the notice for the person whose login ended
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** An access token as the login server issues it: the session it belongs to is in its claims (a refresh keeps the session, changes the token). */
const jwtFor = (session: string, sub = 'u1', n = 1) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, session_id: session, exp: 4102444800, n })}.sig`;
const storedSession = (session: string, sub = 'u1', n = 1) => store.set(KEY, JSON.stringify({ access_token: jwtFor(session, sub, n), refresh_token: `rt-${session}`, user: { id: sub } }));
const USER = 'https://x.supabase.co/auth/v1/user';
const question = (jwt: string, as: 'plain' | 'headers' = 'plain') => ({ method: 'GET', headers: as === 'headers' ? new Headers({ Authorization: `Bearer ${jwt}`, apikey: 'k' }) : { Authorization: `Bearer ${jwt}`, apikey: 'k' } });
const sessionGone = () => json(403, { code: 'session_not_found', message: 'Session from session_id claim in JWT does not exist' });

test('GET /user answered "session not found" about a session that is not the stored one any more is dropped, so auth-js cannot delete the login stored now', async () => {
  fresh();
  const { f } = await openTab();
  storedSession('sara-session', 'u2'); // Sara signed in (on this tab or another) after Ali's question went out
  for (const as of ['plain', 'headers'] as const) {
    await assert.rejects(() => viaFetch(f, USER, sessionGone(), question(jwtFor('ali-session'), as)), TypeError, as);
  }
  store.delete(KEY); // Ali logged out and nobody has logged in yet: nothing to delete either, and the SIGNED_OUT was sent when he logged out
  await assert.rejects(() => viaFetch(f, USER, sessionGone(), question(jwtFor('ali-session'))), TypeError);
});

test('GET /user: the answer about the stored session itself goes through as it came (auth-js ends that login, and every tab hears it)', async () => {
  fresh();
  const { f } = await openTab();
  storedSession('ali-session');
  assert.equal((await viaFetch(f, USER, sessionGone(), question(jwtFor('ali-session')))).status, 403);
  storedSession('ali-session', 'u1', 2); // a refresh changed the token, not the session
  assert.equal((await viaFetch(f, USER, sessionGone(), question(jwtFor('ali-session', 'u1', 1)))).status, 403);
});

test('GET /user: every other answer, and a question that cannot be matched to a session, goes through unchanged', async () => {
  fresh();
  const { f } = await openTab();
  storedSession('sara-session', 'u2');
  for (const response of [
    json(200, { id: 'u1' }),
    json(403, { code: 'user_banned', message: 'User is banned' }),
    json(403, { code: 'user_not_found', message: 'x' }),
    json(403, { code: 'bad_jwt', message: 'invalid JWT' }),
    json(401, { message: 'Unauthorized' }),
    json(503, { message: 'Service Unavailable' }),
    new Response('<html>no</html>', { status: 403, headers: { 'content-type': 'text/html' } }),
  ]) {
    assert.equal((await viaFetch(f, USER, response, question(jwtFor('ali-session')))).status, response.status);
  }
  // a token without a session claim, or an unreadable stored login (nothing to compare with): auth-js decides, as before
  assert.equal((await viaFetch(f, USER, sessionGone(), question('tok-plain'))).status, 403);
  store.set(KEY, '{"access_token":"tok-plain","user":{"id":"u2"}}');
  assert.equal((await viaFetch(f, USER, sessionGone(), question(jwtFor('ali-session')))).status, 403);
  store.set(KEY, 'not json');
  assert.equal((await viaFetch(f, USER, sessionGone(), question(jwtFor('ali-session')))).status, 403);
});

test('a failed answer about a login that is not the stored one any more (a dropped one too) is LOGIN_CHANGED, not news; about the stored one it is an ordinary failure', async () => {
  fresh();
  const { f, data } = await openTab();
  f.user = async () => { f.session = loginOf('u2'); return answer(authError('AuthRetryableFetchError', 0)); };
  await assert.rejects(() => data.getSession(), (e: any) => e.code === 'LOGIN_CHANGED');
  f.session = loginOf('u1');
  f.user = answer(authError('AuthRetryableFetchError', 0));
  await assert.rejects(() => data.getSession(), (e: any) => e.code !== 'LOGIN_CHANGED');
  assert.deepEqual(f.signOuts, []);
});

test('a refusal of a refresh that was sent for ONE person, answered after ANOTHER signed in, notes nothing and asks nothing about her', async () => {
  fresh();
  const { f, heard } = await openTab();
  storedAs('u1');
  const realFetch = globalThis.fetch;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = (async () => { await wait; return json(400, { code: 'user_banned', message: 'x' }); }) as any;
  try {
    const sent = f.fetchOption(REFRESH, { method: 'POST', body: '{}' }); // Ali's refresh is on its way...
    storedAs('u2'); // ...and Sara signs in meanwhile
    release();
    assert.equal((await sent).status, 400, 'the answer still goes to auth-js');
  } finally {
    globalThis.fetch = realFetch;
  }
  await later();
  assert.equal(store.has(NOTE_KEY), false, 'nothing about Ali is left behind for Sara');
  assert.equal(f.getUserCalls, 0);
  f.emit('SIGNED_OUT'); // her own logout later on
  assert.deepEqual(heard, [['SIGNED_OUT', null]]);
});

test('"refresh token not found" for ONE person, answered after ANOTHER signed in, does not make the library ask about her', async () => {
  fresh();
  const { f } = await openTab();
  storedAs('u1');
  f.user = answer(gone);
  const realFetch = globalThis.fetch;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = (async () => { await wait; return json(400, { code: 'refresh_token_not_found', message: 'x' }); }) as any;
  try {
    const sent = f.fetchOption(REFRESH, { method: 'POST', body: '{}' });
    storedAs('u2');
    release();
    await sent;
  } finally {
    globalThis.fetch = realFetch;
  }
  await later();
  assert.equal(f.getUserCalls, 0);
  assert.deepEqual(f.signOuts, []);
});

test('a refusal of a refresh for the login that is still the stored one notes it, as before (also when nobody is stored: the library has already deleted it)', async () => {
  fresh();
  const { f } = await openTab();
  storedAs('u1');
  await viaFetch(f, REFRESH, json(400, { code: 'user_banned', message: 'x' }));
  assert.equal(JSON.parse(store.get(NOTE_KEY) as string).uid, 'u1');
  store.delete(NOTE_KEY);
  store.delete(KEY);
  await viaFetch(f, REFRESH, json(400, { code: 'user_banned', message: 'x' }));
  assert.equal(JSON.parse(store.get(NOTE_KEY) as string).reason, 'switched_off');
});

test('a hung logout is given up together with every other one still in flight (two logouts can overlap), not only the latest', async (t) => {
  fresh();
  const { f, data } = await openTab();
  const realFetch = globalThis.fetch;
  const signals: AbortSignal[] = [];
  globalThis.fetch = ((_url: any, init: any) => new Promise((_resolve, reject) => {
    signals.push(init?.signal);
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  })) as any;
  f.auth.signOut = async (opts: any) => {
    f.signOuts.push(opts);
    try { await f.fetchOption('https://x.supabase.co/auth/v1/logout?scope=local', { method: 'POST', headers: {} }); } catch (error) { return { error }; }
    return { error: null };
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const first = data.signOut({ scope: 'local', reason: 'switched_off' });
    await nextTick();
    t.mock.timers.tick(3000);
    const second = data.signOut({ scope: 'local', reason: 'switched_off' }); // a second lookup ended the same login while the first logout hangs
    await nextTick();
    t.mock.timers.tick(1000); // the first one's 4 seconds are over
    assert.equal(await first, false);
    assert.deepEqual(signals.map((s) => s.aborted), [true, true], 'the first request is given up too, not left to remove a later login when it ends');
    assert.equal(await second, false);
  } finally {
    t.mock.timers.reset();
    globalThis.fetch = realFetch;
  }
});

const noteOf = (reason: string, uid: string, age = 1000) => store.set(NOTE_KEY, JSON.stringify({ id: `n-${reason}-${uid}-${age}`, reason, at: Date.now() - age, uid }));

test('"switched off" answered late, nobody stored, and a fresh note says this very login was just ended for that reason (another tab got there first): the answer is given, nothing is ended again', async () => {
  fresh();
  const { f, data, heard } = await openTab();
  const slow = held(answer(banned));
  f.user = slow.answer;
  const lookup = data.getSession();
  await nextTick();
  f.session = null; // another tab of this browser ended Ali's login a moment ago...
  noteOf('switched_off', 'u1'); // ...and noted why
  slow.release();
  await assert.rejects(lookup, (e: any) => e.code === 'ACCOUNT_OFF');
  assert.deepEqual(f.signOuts, [], 'nothing is ended a second time');
  assert.deepEqual(heard, []);
  assert.equal(JSON.parse(store.get(NOTE_KEY) as string).uid, 'u1', 'and no new note either');
});

test('the same late answer with no such note (another person, another reason, too old, none), or with somebody else stored, is still LOGIN_CHANGED', async () => {
  for (const setup of [
    () => undefined,
    () => noteOf('switched_off', 'u9'),
    () => noteOf('idle', 'u1'),
    () => noteOf('account_gone', 'u1'),
    () => noteOf('switched_off', 'u1', 6 * 60 * 1000),
  ]) {
    fresh();
    const { f, data } = await openTab();
    const slow = held(answer(banned));
    f.user = slow.answer;
    const lookup = data.getSession();
    await nextTick();
    f.session = null;
    setup();
    slow.release();
    await assert.rejects(lookup, (e: any) => e.code === 'LOGIN_CHANGED');
  }
  fresh();
  const { f, data } = await openTab();
  const slow = held(answer(banned));
  f.user = slow.answer;
  const lookup = data.getSession();
  await nextTick();
  f.session = loginOf('u2'); // Sara is stored now, whatever the note says
  noteOf('switched_off', 'u1');
  slow.release();
  await assert.rejects(lookup, (e: any) => e.code === 'LOGIN_CHANGED');
  assert.deepEqual(f.signOuts, []);
});

test('the first look of a page that finds nobody stored, after the login it opened with was ended because the account is off or gone, says so (once)', async () => {
  for (const [code, reason, wording] of [['user_banned', 'switched_off', /switched off/], ['user_not_found', 'account_gone', /no longer belongs/]] as const) {
    fresh();
    storedAs('u1'); // the login this page opens with
    const { f, data } = await openTab();
    await viaFetch(f, REFRESH, json(400, { code, message: 'x' })); // its own start-up refresh is refused...
    store.delete(KEY); // ...and auth-js deletes the login
    f.session = null;
    await assert.rejects(() => data.getSession(), (e: any) => e.code === (reason === 'switched_off' ? 'ACCOUNT_OFF' : 'ACCOUNT_GONE') && wording.test(e.message));
    assert.equal(await data.getSession(), null, 'only the first look of the page');
  }
});

test('the first look says nothing when the page opened with nobody stored, when the note is about another person, an idle logout or too old, or when a login is there', async () => {
  const cases: Array<[string, () => void, boolean]> = [
    ['a note about the person stored when the page opened, but nothing was stored then', () => noteOf('switched_off', 'u1'), false],
    ['a note about another person', () => noteOf('switched_off', 'u9'), true],
    ['an idle logout', () => noteOf('idle', 'u1'), true],
    ['a note that is too old', () => noteOf('switched_off', 'u1', 6 * 60 * 1000), true],
    ['no note', () => undefined, true],
  ];
  for (const [label, note, openedWithLogin] of cases) {
    fresh();
    if (openedWithLogin) storedAs('u1');
    const { f, data } = await openTab();
    store.delete(KEY);
    f.session = null;
    note();
    assert.equal(await data.getSession(), null, label);
  }
  fresh();
  storedAs('u1');
  const { f, data } = await openTab();
  noteOf('switched_off', 'u1');
  assert.equal((await data.getSession())?.kind, 'staff', 'a login that is there is simply returned');
  store.delete(KEY);
  f.session = null;
  assert.equal(await data.getSession(), null, 'and that was the first look');
});

// ---- patient logins made at the clinic
const patientUser = (metadata: any) => ({ data: { user: { id: 'pu1', user_metadata: metadata } }, error: null });
const patientRow = { id: 'pat-1', full_name: 'Ali Rashid', mr_number: '1705', portal_user_id: 'pu1' };

test('a patient login the clinic made reports mustChangePassword from the metadata of the login, read fresh each time; staff never carry the flag', async () => {
  fresh();
  const { f, data } = await openTab();
  f.tables.staff = [];
  f.tables.patients = [patientRow];
  f.session = loginOf('pu1'); // the stored login is the patient's own (getSession checks it is the same person the server confirms)
  f.user = patientUser({ kind: 'patient', must_change_password: true });
  const first = await data.getSession();
  assert.equal(first.kind, 'patient');
  assert.equal(first.mustChangePassword, true);
  f.user = patientUser({ kind: 'patient', must_change_password: false });
  assert.equal((await data.getSession()).mustChangePassword, false, 'the cached profile does not keep an old flag');
  f.user = patientUser(undefined);
  assert.equal((await data.getSession()).mustChangePassword, false, 'an invited patient (no flag) is never held back');
  f.user = GOOD_USER;
  f.session = loginOf('u1');
  f.tables.staff = [{ id: 'u1', role: 'admin', active: true }];
  const staff = await data.getSession();
  assert.equal(staff.kind, 'staff');
  assert.ok(!('mustChangePassword' in staff));
});

test('changePassword sets the new password and clears the must-change flag in one update, and forgets the cached session', async () => {
  fresh();
  const { f, data } = await openTab();
  f.tables.staff = [];
  f.tables.patients = [patientRow];
  f.session = loginOf('pu1');
  f.user = patientUser({ kind: 'patient', must_change_password: true });
  assert.equal((await data.getSession()).mustChangePassword, true);
  await data.changePassword('my-own-pass-77');
  assert.deepEqual(f.userUpdates, [{ password: 'my-own-pass-77', data: { must_change_password: false } }]);
  f.user = patientUser({ kind: 'patient', must_change_password: false });
  assert.equal((await data.getSession()).mustChangePassword, false);
});

test('a clinic username has no inbox: it is not a staff address, and password reset refuses it (no email) with the clinic wording', async () => {
  fresh();
  const { f, data } = await openTab();
  // the clinic domain comes from config.js
  assert.equal(data.isPortalLoginName('alirashid-1705@dralirashid.com'), true);
  assert.equal(data.isStaffEmail('alirashid-1705@dralirashid.com'), false, 'a patient address is not a staff address');
  assert.equal(data.isStaffEmail('reception@dralirashid.com'), true);
  assert.equal(data.isPortalLoginName('reception@dralirashid.com'), false);
  assert.equal(data.isStaffEmail('sara@gmail.com'), false);
  await assert.rejects(() => data.sendPasswordReset('AliRashid-1705@dralirashid.com'), (e: any) => e.code === 'CLINIC_RESET' && e.message === 'Ask the clinic to reset your password.');
  await assert.rejects(() => data.sendPasswordReset('reception@dralirashid.com'), (e: any) => e.code === 'STAFF_RESET');
  assert.deepEqual(f.resets, [], 'no email was requested for either');
  (globalThis as any).location = { origin: 'https://www.dralirashid.com' };
  try {
    await data.sendPasswordReset(' Sara@Gmail.com ');
    assert.deepEqual(f.resets, ['sara@gmail.com'], 'a real email keeps the email reset');
  } finally { delete (globalThis as any).location; }
});

test('the staff calls for patient logins go to the admin-users function and resolve only what the screen needs (never the password)', async () => {
  fresh();
  const { f, data } = await openTab();
  f.invokeAnswer = { data: { ok: true, username: 'alirashid-1705@dralirashid.com' }, error: null };
  assert.deepEqual(await data.createPatientLogin('pat-1', 'sunny-grape-4827'), { username: 'alirashid-1705@dralirashid.com' });
  assert.deepEqual(await data.resetPatientPassword('pat-1', 'peach-zebra-5936'), { username: 'alirashid-1705@dralirashid.com' });
  f.invokeAnswer = { data: { ok: true, has_login: true, clinic_login: true, username: 'alirashid-1705@dralirashid.com' }, error: null };
  assert.deepEqual(await data.portalLoginInfo('pat-1'), { has_login: true, clinic_login: true, username: 'alirashid-1705@dralirashid.com' });
  assert.deepEqual(f.invokes, [
    ['admin-users', { action: 'create_patient_login', patient_id: 'pat-1', password: 'sunny-grape-4827' }],
    ['admin-users', { action: 'reset_patient_password', patient_id: 'pat-1', password: 'peach-zebra-5936' }],
    ['admin-users', { action: 'portal_login_info', patient_id: 'pat-1' }],
  ]);
});

test('an error of the function reaches the screen in its own words, also when it came with a non-2xx status', async () => {
  fresh();
  const { f, data } = await openTab();
  f.invokeAnswer = { data: { error: 'This patient already has a portal login.' }, error: null };
  await assert.rejects(() => data.createPatientLogin('pat-1', 'sunny-grape-4827'), /already has a portal login/);
  const refused = Object.assign(new Error('Edge Function returned a non-2xx status code'), { context: { json: async () => ({ error: 'You are not allowed to create patient logins.' }) } });
  f.invokeAnswer = { data: null, error: refused };
  await assert.rejects(() => data.createPatientLogin('pat-1', 'sunny-grape-4827'), /You are not allowed to create patient logins/);
  f.invokeAnswer = { data: null, error: Object.assign(new Error('Failed to send a request to the Edge Function'), { context: {} }) };
  await assert.rejects(() => data.resetPatientPassword('pat-1', 'peach-zebra-5936'), /Failed to send a request/);
});

// ---- the session of a patient whose login the clinic made, with the real login watcher (auth-watch.js) wired the way main.js wires it
const { authChangeHandler, endedNotice } = await import('../web/js/auth-watch.js');
const { readFileSync } = await import('node:fs');

/** What main.js does with a tab's login events: keep the refreshed login, or leave the screen with a notice. `shown` is state.session. */
function screenOf(tab: { data: any }, shown: any) {
  const screen: any = { session: shown, ended: [] as any[], notices: [] as string[], accepted: [] as any[] };
  const watch = authChangeHandler({
    data: tab.data,
    current: () => screen.session,
    busy: () => false,
    accept: (s: any) => { screen.session = s; screen.accepted.push(s); },
    ended: (reason: any) => { screen.ended.push(reason); screen.notices.push(endedNotice(reason, { patient: screen.session?.kind === 'patient' })); screen.session = null; },
  });
  tab.data.onAuthChange(watch);
  return screen;
}
/** Lets every lookup an event started run to its end (the stand-ins answer at once, so a few turns of the event loop are plenty). */
const settle = async () => { for (let i = 0; i < 5; i += 1) await nextTick(); };
const clinicPatientTab = async (flag: boolean | undefined) => {
  fresh();
  const tab = await openTab();
  tab.f.tables.staff = [];
  tab.f.tables.patients = [patientRow];
  tab.f.session = loginOf('pu1');
  tab.f.user = patientUser(flag === undefined ? { kind: 'patient' } : { kind: 'patient', must_change_password: flag });
  return tab;
};

test('a patient login with must_change_password=true reaches the forced-change screen, and stays there through the events of a busy tab', async () => {
  const tab = await clinicPatientTab(true);
  const session = await tab.data.signIn('alirashid-1705@dralirashid.com', 'sunny-grape-zebra-4827');
  assert.equal(session.kind, 'patient');
  assert.equal(session.mustChangePassword, true, 'signIn hands the screen the flag: portal.js shows "Choose your own password" for it');
  assert.equal((await tab.data.getSession()).mustChangePassword, true, 'and so does the first look of a reloaded page (state.js)');
  // portal.js decides by this flag, before it loads anything of the patient
  const portal = readFileSync(new URL('../web/js/views/portal.js', import.meta.url), 'utf8');
  const decide = portal.indexOf('if (state.session?.mustChangePassword) return renderChoosePassword(root, signOut);');
  assert.ok(decide > 0 && decide < portal.indexOf("loading(root, 'Loading your account"), 'decided before anything of the patient is loaded');
  // The tab is focused again, a token is refreshed: none of it lets the patient past the screen or logs them out.
  const screen = screenOf(tab, session);
  tab.f.emit('SIGNED_IN', tab.f.session);
  await settle();
  tab.f.session = loginOf('pu1', 'tok-pu1-newer');
  tab.f.emit('TOKEN_REFRESHED', tab.f.session);
  await settle();
  assert.deepEqual(screen.ended, []);
  assert.equal(screen.session.mustChangePassword, true, 'still the forced-change screen');
  assert.equal(screen.session.patient.id, 'pat-1');
  assert.ok(screen.accepted.length >= 2 && screen.accepted.every((s: any) => s.mustChangePassword === true));
});

test('changePassword, and the USER_UPDATED and TOKEN_REFRESHED events it causes, neither log the patient out nor show a "logged out" message, and the person stays the same', async () => {
  const tab = await clinicPatientTab(true);
  const { f, data } = tab;
  const screen = screenOf(tab, await data.getSession());
  assert.equal(screen.session.mustChangePassword, true);
  // What the login server and auth-js do for updateUser: the user is changed (the flag is off in the server's answers from now on),
  // then USER_UPDATED is sent, and the library may refresh the token right after.
  f.auth.updateUser = async (attrs: any) => {
    f.userUpdates.push(attrs);
    f.user = patientUser({ kind: 'patient', must_change_password: false });
    f.emit('USER_UPDATED', f.session);
    f.session = loginOf('pu1', 'tok-pu1-after-update');
    f.emit('TOKEN_REFRESHED', f.session);
    return { data: { user: { id: 'pu1' } }, error: null };
  };
  await data.changePassword('my-own-pass-77');
  await settle();
  assert.deepEqual(f.userUpdates, [{ password: 'my-own-pass-77', data: { must_change_password: false } }], 'one update: the password and the flag together');
  assert.deepEqual(screen.ended, [], 'the screen was never left');
  assert.deepEqual(screen.notices, [], 'no "You were logged out" message');
  assert.deepEqual(f.signOuts, [], 'no logout was sent');
  assert.deepEqual(tab.heard.map(([event]: [string]) => event), ['USER_UPDATED', 'TOKEN_REFRESHED'], 'and no SIGNED_OUT was heard');
  assert.equal(screen.session.kind, 'patient');
  assert.equal(screen.session.patient.id, 'pat-1', 'the same person');
  assert.equal(screen.session.mustChangePassword, false, 'and the portal opens from now on');
  assert.ok(screen.accepted.length >= 1 && screen.accepted.every((s: any) => s.patient.id === 'pat-1'));
  assert.equal((await data.getSession()).mustChangePassword, false, 'a reload shows the portal, not the forced screen');
});

test('the password change is a plain updateUser: if it fails, the flag stays on and the patient stays on the forced-change screen, logged in', async () => {
  const tab = await clinicPatientTab(true);
  const { f, data } = tab;
  const screen = screenOf(tab, await data.getSession());
  f.auth.updateUser = async () => ({ data: {}, error: Object.assign(new Error('New password should be different from the old password.'), { name: 'AuthApiError', status: 422, code: 'same_password' }) });
  await assert.rejects(() => data.changePassword('sunny-grape-zebra-4827'), (e: any) => e.code === 'same_password');
  f.emit('SIGNED_IN', f.session);
  await settle();
  assert.deepEqual(screen.ended, []);
  assert.equal(screen.session.mustChangePassword, true);
});

test('a staff session never carries mustChangePassword, whatever its own user_metadata says, also through login events', async () => {
  fresh();
  const { f, data } = await openTab();
  f.user = { data: { user: { id: 'u1', user_metadata: { kind: 'patient', must_change_password: true } } }, error: null }; // a staff member can edit their own metadata
  const first = await data.getSession();
  assert.equal(first.kind, 'staff');
  assert.ok(!('mustChangePassword' in first));
  const screen = screenOf({ data }, first);
  for (const event of ['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED']) { f.emit(event, f.session); await settle(); }
  assert.deepEqual(screen.ended, []);
  assert.ok(screen.accepted.length >= 3);
  for (const s of screen.accepted) { assert.equal(s.kind, 'staff'); assert.ok(!('mustChangePassword' in s)); }
  const signedIn = await data.signIn('reception@dralirashid.com', 'a-long-enough-pass');
  assert.ok(!('mustChangePassword' in signedIn));
});

test('a staff member who is also linked to a patient record is still staff: no forced screen', async () => {
  fresh();
  const { f, data } = await openTab();
  f.tables.patients = [patientRow]; // a bad link: a patient row points at this staff login
  f.user = { data: { user: { id: 'u1', user_metadata: { must_change_password: true } } }, error: null };
  const s = await data.getSession();
  assert.equal(s.kind, 'staff');
  assert.ok(!('mustChangePassword' in s));
});

test('"Unknown action" from a function that was not redeployed becomes "Update the admin-users function first." for all three patient login calls', async () => {
  fresh();
  const { f, data } = await openTab();
  const calls: Array<() => Promise<unknown>> = [
    () => data.createPatientLogin('pat-1', 'sunny-grape-zebra-4827'),
    () => data.resetPatientPassword('pat-1', 'sunny-grape-zebra-4827'),
    () => data.portalLoginInfo('pat-1'),
  ];
  for (const call of calls) {
    f.invokeAnswer = { data: { error: 'Unknown action' }, error: null }; // the function answered 200 with the error in the body
    await assert.rejects(call, (e: any) => e.message === 'Update the admin-users function first.');
    const refused = Object.assign(new Error('Edge Function returned a non-2xx status code'), { context: { json: async () => ({ error: 'Unknown action' }) } }); // or 400
    f.invokeAnswer = { data: null, error: refused };
    await assert.rejects(call, (e: any) => e.message === 'Update the admin-users function first.');
  }
  f.invokeAnswer = { data: { error: 'This patient already has a portal login.' }, error: null };
  await assert.rejects(calls[0], /already has a portal login/, 'other messages are left as they are');
});
