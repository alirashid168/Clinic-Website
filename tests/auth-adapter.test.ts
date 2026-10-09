// The login side of the live data layer (web/js/data/supabase.js), run against a stand-in for supabase-js (the real library is
// loaded from a CDN in the browser). What it pins down:
//   - a final answer of the login server about the account (403 user_banned, 403 user_not_found) or a switched-off staff row ends the
//     login on this computer, with a reason, and getSession() fails with ACCOUNT_OFF / ACCOUNT_GONE;
//   - nothing transient ever does (offline, timeout, 5xx, 408, 429, a 4xx the server gave for another reason);
//   - the reason travels with SIGNED_OUT, also to the other tabs of the browser, which see only the event;
//   - a token refresh that is answered with a rate limit or a proxy's error page cannot make auth-js delete the stored login;
//   - another tab's hand-made removal of the stored login (no event) still reaches this tab;
//   - updateVisit asks the login server who the user is only when an override needs it.
// The stand-in only models the answers of supabase-js (error names, statuses, codes); the same adapter was also run against the real
// auth-js 2.117.2 with a fake login server when this was written.
import { test } from 'node:test';
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

/** A stand-in for one tab's supabase-js client: what getUser() answers, which tables hold what, and a record of what was called. */
function fakeClient() {
  const f: any = {
    user: GOOD_USER as any, // the next getUser() answer, or a function giving it
    tables: { staff: [{ id: 'u1', role: 'admin', active: true }], patients: [], visits: [{ id: 'v1', patient_id: 'p1' }] } as Record<string, any>,
    signOuts: [] as any[], getUserCalls: 0, reads: [] as string[], updates: [] as any[], listeners: new Set<Function>(), fetchOption: null as any,
    signInResult: { data: {}, error: null } as any,
    invokes: [] as any[], invokeAnswer: { data: null, error: null } as any, userUpdates: [] as any[], resets: [] as any[],
  };
  f.emit = (event: string) => { for (const cb of [...f.listeners]) cb(event, null); };
  f.auth = {
    storageKey: KEY,
    async getUser() { f.getUserCalls += 1; const r = typeof f.user === 'function' ? f.user() : f.user; if (r instanceof Error) throw r; return r; },
    async signOut(opts: any) { f.signOuts.push(opts); store.delete(KEY); f.emit('SIGNED_OUT'); return { error: null }; }, // auth-js sends SIGNED_OUT before it answers
    onAuthStateChange(cb: Function) { f.listeners.add(cb); return { data: { subscription: { unsubscribe: () => f.listeners.delete(cb) } } }; },
    async signInWithPassword() { return f.signInResult; },
    async updateUser(attrs: any) { f.userUpdates.push(attrs); return { data: {}, error: null }; },
    async resetPasswordForEmail(email: string) { f.resets.push(email); return { data: {}, error: null }; },
    stopAutoRefresh() {},
  };
  f.from = (table: string) => {
    let single = false;
    const b: any = {
      select() { return b; }, eq() { return b; }, in() { return b; }, is() { return b; }, order() { return b; },
      maybeSingle() { single = true; return b; }, single() { single = true; return b; },
      insert() { return b; }, update(patch: any) { f.updates.push([table, patch]); return b; },
      then(resolve: any, reject: any) {
        f.reads.push(table);
        const t = f.tables[table];
        const rows = (typeof t === 'function' ? t() : t) ?? [];
        return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null }).then(resolve, reject);
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

test('an ordinary logout has no reason; a reason does not outlive 30 seconds or the next sign-in', async () => {
  fresh();
  const a = await openTab();
  const b = await openTab();
  await a.data.signOut(); // Log out clicked
  b.f.emit('SIGNED_OUT');
  assert.deepEqual(b.heard, [['SIGNED_OUT', null]]);

  await a.data.signOut({ scope: 'local', reason: 'idle' });
  const saved = JSON.parse(store.get('clinic-logout-reason') as string);
  store.set('clinic-logout-reason', JSON.stringify({ ...saved, at: saved.at - 31000 }));
  b.f.emit('SIGNED_OUT');
  assert.equal(b.heard[1][1], null, 'too old');

  await a.data.signOut({ scope: 'local', reason: 'idle' });
  await a.data.signIn('a@dralirashid.com', 'x');
  b.f.emit('SIGNED_OUT');
  assert.equal(b.heard[2][1], null, 'a new sign-in clears it');
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

// ---- patient logins made at the clinic
const patientUser = (metadata: any) => ({ data: { user: { id: 'pu1', user_metadata: metadata } }, error: null });
const patientRow = { id: 'pat-1', full_name: 'Ali Rashid', mr_number: '1705', portal_user_id: 'pu1' };

test('a patient login the clinic made reports mustChangePassword from the metadata of the login, read fresh each time; staff never carry the flag', async () => {
  fresh();
  const { f, data } = await openTab();
  f.tables.staff = [];
  f.tables.patients = [patientRow];
  f.user = patientUser({ kind: 'patient', must_change_password: true });
  const first = await data.getSession();
  assert.equal(first.kind, 'patient');
  assert.equal(first.mustChangePassword, true);
  f.user = patientUser({ kind: 'patient', must_change_password: false });
  assert.equal((await data.getSession()).mustChangePassword, false, 'the cached profile does not keep an old flag');
  f.user = patientUser(undefined);
  assert.equal((await data.getSession()).mustChangePassword, false, 'an invited patient (no flag) is never held back');
  f.user = GOOD_USER;
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
