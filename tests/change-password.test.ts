// A logged-in person changing their OWN password: changeOwnPassword(current, new) of the live data layer (web/js/data/supabase.js, run against a
// stand-in for supabase-js and a stand-in for fetch), of the demo data layer, and the rules both share (web/js/password-rules.js). What it pins down:
//   - the current password is checked with a request of its own (POST /auth/v1/token?grant_type=password), never through the page's client: no
//     sign-in call, no sign-out call, no login event heard, nothing written to the page's storage; the session that check opens is ended at once
//     (POST /auth/v1/logout?scope=local with its own token), and only then does the page's client set the new password (updateUser);
//   - a wrong current password, a rate limit, no connection, a server error, same_password, weak_password and reauthentication_needed each fail
//     with their own code and sentence, and none of them ends the login or sends a login event;
//   - a session that cannot be ended (the request fails, or is refused) does not fail the change;
//   - no password ever reaches the console, the storage, a URL, an error or a login event;
//   - the USER_UPDATED that updateUser sends is the same person for the login watcher: nothing ends, the person stays on screen;
//   - the new password goes to the account whose password was checked (a login that changes during the check changes nothing), the check
//     uses the login name the server has now, a 401 of the check is not "you are not logged in", a switched-off account ends the login,
//     and an update that never answers gives up (the dialog is locked while it runs).
import { test, mock } from 'node:test';
import { setImmediate as nextTick } from 'node:timers/promises';
import { inspect } from 'node:util';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setMaxListeners } from 'node:events';

// ---- a browser-like page
const store = new Map<string, string>();
const sessionStore = new Map<string, string>();
const storageOf = (m: Map<string, string>) => ({
  getItem: (k: string) => (m.has(k) ? m.get(k) : null),
  setItem: (k: string, v: unknown) => { m.set(k, String(v)); },
  removeItem: (k: string) => { m.delete(k); },
  clear: () => m.clear(),
});
(globalThis as any).localStorage = storageOf(store);
(globalThis as any).sessionStorage = storageOf(sessionStore);
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
const { createDemoAdapter } = await import('../web/js/data/demo.js');
const { passwordProblems, passwordError, PASSWORD_MESSAGES } = await import('../web/js/password-rules.js');
const { authChangeHandler } = await import('../web/js/auth-watch.js');
const { friendlyError } = await import('../web/js/ui/dom.js');
const { CONFIG } = await import('../web/js/config.js');

const CURRENT = 'Cur-Sentinel-7731';
const NEXT = 'New-Sentinel-9042';
const EMAIL = 'asma@dralirashid.com';
const KEY = 'sb-test-auth-token';
const VERIFY_TOKEN = 'verification-access-token-AAA';
const VERIFY_REFRESH = 'verification-refresh-token-BBB';

// ---- the network: every request goes through here, in the order it was made (the record is made before the first await)
type Reply = { status?: number; body?: unknown; raw?: string; throws?: Error; during?: () => void }; // during: runs when the request is made
const log: string[] = []; // everything that happened, in order: 'token', 'logout' (requests), 'updateUser', 'signIn', 'signOut' (calls on the page's client)
const requests: Array<{ kind: string; url: string; init: any }> = [];
const plan: Record<string, Reply> = {};
const GOOD_TOKEN: Reply = { status: 200, body: { access_token: VERIFY_TOKEN, refresh_token: VERIFY_REFRESH, token_type: 'bearer', user: { id: 'u1', email: EMAIL } } };
const GOOD_LOGOUT: Reply = { status: 204 };
globalThis.fetch = (async (url: any, init: any = {}) => {
  const u = String(url);
  const kind = u.includes('/auth/v1/token?grant_type=password') ? 'token' : u.includes('/auth/v1/logout') ? 'logout' : 'other';
  requests.push({ kind, url: u, init });
  log.push(kind);
  const reply = plan[kind] ?? {};
  reply.during?.();
  if (reply.throws) throw reply.throws;
  const status = reply.status ?? 200;
  return new Response(status === 204 ? null : (reply.raw ?? JSON.stringify(reply.body ?? {})), { status, headers: { 'content-type': 'application/json' } });
}) as any;

const authError = (name: string, status: number | undefined, code?: string, extra: object = {}) => Object.assign(new Error(code || name), { name, status, code }, extra);
const loginOf = (id: string, email = EMAIL) => ({ access_token: `tok-${id}`, user: { id, email } });

/** A stand-in for one tab's supabase-js client (see auth-adapter.test.ts), with updateUser, which sends USER_UPDATED the way the real library does. */
function fakeClient() {
  const f: any = {
    session: loginOf('u1') as any, getSessionError: null as any,
    updateResult: { error: null } as any, // or { error } for a refused update
    tables: { staff: [{ id: 'u1', role: 'admin', active: true }], patients: [] } as Record<string, any>,
    signOuts: [] as any[], signIns: [] as any[], updates: [] as any[], listeners: new Set<Function>(),
    atUpdate: null as any, // what the page looked like at the moment updateUser was called
    serverEmail: undefined as any, // the login name the server has (GET /user); the stored copy is the session's
    userAnswers: [] as any[], // answers of the next getUser() calls, in order; null = the usual answer
    userCalls: [] as string[], // the tokens getUser() was asked about
    heardCount: () => 0,
  };
  f.emit = (event: string, session: any = null) => { for (const cb of [...f.listeners]) cb(event, session); };
  f.auth = {
    storageKey: KEY,
    async getSession() { return f.session ? { data: { session: f.session }, error: null } : { data: { session: null }, error: f.getSessionError }; },
    async getUser(jwt: string) {
      f.userCalls.push(jwt);
      const special = f.userAnswers.length ? f.userAnswers.shift() : null;
      if (special) return special;
      if (!f.session) return { data: { user: null }, error: authError('AuthSessionMissingError', 400) };
      return { data: { user: { id: f.session.user.id, email: f.serverEmail ?? f.session.user.email } }, error: null };
    },
    async signOut(opts: any) { log.push('signOut'); f.signOuts.push(opts); f.session = null; store.delete(KEY); f.emit('SIGNED_OUT'); return { error: null }; },
    async signInWithPassword(creds: any) { log.push('signIn'); f.signIns.push(creds); return { data: {}, error: null }; },
    async updateUser(attrs: any) {
      log.push('updateUser');
      f.updates.push(attrs);
      f.atUpdate = { store: JSON.stringify([...store]), session: JSON.stringify([...sessionStore]), heard: f.heardCount() };
      if (f.updateResult.error) return { data: { user: null }, error: f.updateResult.error };
      f.emit('USER_UPDATED', f.session); // after the new password is saved, the library tells every listener (and the other tabs)
      return { data: { user: f.session.user }, error: null };
    },
    onAuthStateChange(cb: Function) { f.listeners.add(cb); return { data: { subscription: { unsubscribe: () => f.listeners.delete(cb) } } }; },
    stopAutoRefresh() {},
  };
  f.from = (table: string) => {
    let single = false;
    const b: any = {
      select() { return b; }, eq() { return b; }, in() { return b; }, is() { return b; }, order() { return b; }, setHeader() { return b; },
      maybeSingle() { single = true; return b; }, single() { single = true; return b; },
      then(resolve: any, reject: any) {
        return Promise.resolve(f.tables[table]).then((got) => {
          const rows = got ?? [];
          return { data: single ? (rows[0] ?? null) : rows, error: null };
        }).then(resolve, reject);
      },
    };
    return b;
  };
  f.client = () => ({ auth: f.auth, from: f.from, rpc: () => { const r: any = Promise.resolve({ data: [], error: null }); r.abortSignal = () => r; return r; }, functions: {}, storage: { from: () => ({}) } });
  return f;
}

const tabs: Array<() => void> = [];
/** One "tab": an adapter on a fresh stand-in client, with the events its onAuthChange listener hears. */
async function openTab() {
  const f = fakeClient();
  (globalThis as any).__fakeCreateClient = () => f.client();
  const data = await createSupabaseAdapter();
  const heard: any[] = [];
  f.heardCount = () => heard.length;
  tabs.push(data.onAuthChange((event: string, reason: string | null) => heard.push([event, reason])));
  return { f, data, heard };
}
/** Starts a test on a blank browser with a working network. */
function fresh() {
  store.clear();
  sessionStore.clear();
  for (const stop of tabs.splice(0)) stop();
  log.length = 0;
  requests.length = 0;
  for (const k of Object.keys(plan)) delete plan[k];
  plan.token = GOOD_TOKEN;
  plan.logout = GOOD_LOGOUT;
}
const wrongPassword: Reply = { status: 400, body: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' } };
const codeOf = (code: string) => (e: any) => e.code === code;

// ======================================================================================= the rules
test('the rules: filled in, 8 characters or more, 72 bytes or less, the two new ones equal, different from the current one', () => {
  const fields = (p: any) => passwordProblems(p).map((x: any) => x.field);
  assert.deepEqual(passwordProblems({ current: CURRENT, next: NEXT, again: NEXT }), []);
  assert.deepEqual(fields({ current: '', next: '', again: '' }), ['current', 'next', 'again']);
  assert.deepEqual(fields({ current: CURRENT, next: 'short7!', again: 'short7!' }), ['next']);
  assert.deepEqual(fields({ current: CURRENT, next: 'exactly8', again: 'exactly8' }), []);
  assert.deepEqual(fields({ current: CURRENT, next: 'a'.repeat(72), again: 'a'.repeat(72) }), [], '72 bytes is the limit and still fine');
  assert.deepEqual(fields({ current: CURRENT, next: 'a'.repeat(73), again: 'a'.repeat(73) }), ['next']);
  assert.deepEqual(fields({ current: CURRENT, next: 'é'.repeat(37), again: 'é'.repeat(37) }), ['next'], '37 letters, but 74 bytes: bcrypt would cut it');
  assert.deepEqual(fields({ current: CURRENT, next: NEXT, again: `${NEXT}x` }), ['again']);
  assert.deepEqual(fields({ current: CURRENT, next: NEXT, again: '' }), ['again']);
  assert.deepEqual(fields({ current: NEXT, next: NEXT, again: NEXT }), ['next'], 'the new password must differ from the current one');
  assert.deepEqual(fields({ current: CURRENT, next: ' spaced out ', again: ' spaced out ' }), [], 'passwords are used as typed, spaces included');
  assert.deepEqual(fields({ current: CURRENT, next: NEXT }), [], 'the data layers do not get a second copy');
  assert.match(passwordProblems({ current: CURRENT, next: NEXT, again: 'x' })[0].message, /not the same/);
  for (const text of Object.values(PASSWORD_MESSAGES)) assert.ok(!text.includes(CURRENT) && !text.includes(NEXT));
  assert.equal(passwordError('WRONG_PASSWORD').code, 'WRONG_PASSWORD');
});

// ======================================================================================= the live data layer
test('success: the current password is checked with a request of its own, that session is ended, then the page\'s client sets the new password', async () => {
  fresh();
  const { f, data, heard } = await openTab();
  store.set(KEY, JSON.stringify(f.session));
  const before = JSON.stringify([...store]);
  assert.equal(await data.changeOwnPassword(CURRENT, NEXT), undefined);
  assert.deepEqual(log, ['token', 'logout', 'updateUser'], 'check, end that session at once, then update');

  const [check, ended] = requests;
  assert.equal(check.url, `${CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=password`, 'no password in the URL');
  assert.equal(check.init.method, 'POST');
  assert.equal(check.init.headers.apikey, CONFIG.SUPABASE_ANON_KEY);
  assert.deepEqual(JSON.parse(check.init.body), { email: EMAIL, password: CURRENT }, 'the signed-in person\'s own email, and the current password');
  assert.ok(!('Authorization' in check.init.headers), 'the page\'s own token is not sent along');
  assert.equal(ended.url, `${CONFIG.SUPABASE_URL}/auth/v1/logout?scope=local`);
  assert.equal(ended.init.method, 'POST');
  assert.equal(ended.init.headers.Authorization, `Bearer ${VERIFY_TOKEN}`, 'ends the check\'s session, with the check\'s own token');
  assert.deepEqual(f.updates, [{ password: NEXT }]);

  // the page's login was never touched by the check
  assert.deepEqual(f.signIns, []);
  assert.deepEqual(f.signOuts, []);
  assert.equal(f.atUpdate.store, before, 'nothing was written to the page\'s storage before the update');
  assert.equal(f.atUpdate.heard, 0, 'no login event had reached the page before the update');
  assert.deepEqual(heard, [['USER_UPDATED', null]], 'the only event is the one the update itself sends');
  assert.equal(f.session.access_token, 'tok-u1');
  // the check's tokens are kept nowhere
  for (const m of [store, sessionStore]) assert.ok(![...m.values()].some((v) => v.includes(VERIFY_TOKEN) || v.includes(VERIFY_REFRESH)));
});

test('a wrong current password: WRONG_PASSWORD, nothing updated, no session to end, the login untouched (both ways the server words it)', async () => {
  for (const reply of [wrongPassword, { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid login credentials' } }]) {
    fresh();
    plan.token = reply;
    const { f, data, heard } = await openTab();
    await assert.rejects(() => data.changeOwnPassword('not-the-password', NEXT), (e: any) => e.code === 'WRONG_PASSWORD' && e.message === 'Your current password is not right.');
    assert.deepEqual(log, ['token'], 'no update, and no session was opened, so none is ended');
    assert.deepEqual(f.signOuts, []);
    assert.deepEqual(heard, []);
    assert.equal(f.session.access_token, 'tok-u1');
  }
});

test('a rate limit (429) on the check or on the update: RATE_LIMITED, and nothing about the login ends', async () => {
  fresh();
  plan.token = { status: 429, body: { code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' } };
  const a = await openTab();
  await assert.rejects(() => a.data.changeOwnPassword(CURRENT, NEXT), (e: any) => e.code === 'RATE_LIMITED' && e.message === 'Too many tries. Wait a few minutes and try again.');
  assert.deepEqual(log, ['token']);

  fresh();
  const b = await openTab();
  b.f.updateResult = { error: authError('AuthApiError', 429, 'over_request_rate_limit') };
  await assert.rejects(() => b.data.changeOwnPassword(CURRENT, NEXT), codeOf('RATE_LIMITED'));
  assert.deepEqual(log, ['token', 'logout', 'updateUser'], 'the check\'s session is ended even though the update failed');
  for (const t of [a, b]) { assert.deepEqual(t.f.signOuts, []); assert.deepEqual(t.heard, []); }
});

test('no connection: the browser\'s own error comes through for friendlyError ("No internet connection"), on the check and on the update; nothing ends', async () => {
  fresh();
  plan.token = { throws: new TypeError('Failed to fetch') };
  const a = await openTab();
  await assert.rejects(() => a.data.changeOwnPassword(CURRENT, NEXT), (e: any) => /No internet connection/.test(friendlyError(e)));
  assert.deepEqual(log, ['token']);

  fresh();
  const b = await openTab();
  b.f.updateResult = { error: authError('AuthRetryableFetchError', 0, undefined, { message: 'Failed to fetch' }) };
  b.f.updateResult.error.message = 'Failed to fetch';
  await assert.rejects(() => b.data.changeOwnPassword(CURRENT, NEXT), (e: any) => /No internet connection/.test(friendlyError(e)));
  assert.deepEqual(log, ['token', 'logout', 'updateUser']);
  for (const t of [a, b]) { assert.deepEqual(t.f.signOuts, []); assert.deepEqual(t.heard, []); }
});

test('a server error (500, 503, an HTML error page): the usual "did not answer" wording, nothing updated, the login kept', async () => {
  for (const reply of [{ status: 500, body: { code: 500, msg: 'Database error' } }, { status: 503, raw: '<html>Service Unavailable</html>' }, { status: 502, body: {} }]) {
    fresh();
    plan.token = reply;
    const { f, data, heard } = await openTab();
    await assert.rejects(() => data.changeOwnPassword(CURRENT, NEXT), (e: any) => /did not answer in time/.test(friendlyError(e)) && !/Database error/.test(e.message));
    assert.deepEqual(log, ['token']);
    assert.deepEqual(f.signOuts, []);
    assert.deepEqual(heard, []);
  }
  // an answer that is "ok" but has no token in it is a server fault too
  fresh();
  plan.token = { status: 200, body: {} };
  const { data } = await openTab();
  await assert.rejects(() => data.changeOwnPassword(CURRENT, NEXT), (e: any) => /did not answer in time/.test(friendlyError(e)));
  assert.deepEqual(log, ['token']);
});

test('same_password, weak_password and reauthentication_needed from the update each have their own code and plain words', async () => {
  fresh();
  const same = await openTab();
  same.f.updateResult = { error: authError('AuthApiError', 422, 'same_password') };
  await assert.rejects(() => same.data.changeOwnPassword(CURRENT, NEXT), (e: any) => e.code === 'SAME_PASSWORD' && e.message === 'The new password must be different from the old one.');

  const weak = await openTab();
  weak.f.updateResult = { error: authError('AuthWeakPasswordError', 422, 'weak_password', { reasons: ['length', 'pwned'] }) };
  await assert.rejects(() => weak.data.changeOwnPassword(CURRENT, NEXT), (e: any) => e.code === 'WEAK_PASSWORD'
    && /too easy to guess/.test(e.message) && /too short/.test(e.message) && /leaked/.test(e.message) && !/length|pwned/.test(e.message));
  const weakNoReasons = await openTab();
  weakNoReasons.f.updateResult = { error: authError('AuthWeakPasswordError', 422, 'weak_password', { reasons: [] }) };
  await assert.rejects(() => weakNoReasons.data.changeOwnPassword(CURRENT, NEXT), (e: any) => e.code === 'WEAK_PASSWORD' && /Choose a different one/.test(e.message));

  const reauth = await openTab();
  reauth.f.updateResult = { error: authError('AuthApiError', 400, 'reauthentication_needed') };
  await assert.rejects(() => reauth.data.changeOwnPassword(CURRENT, NEXT), (e: any) => e.code === 'REAUTH_NEEDED'
    && e.message === 'For safety, ask Dr. Ali to set a new password for you.');

  for (const t of [same, weak, weakNoReasons, reauth]) {
    assert.deepEqual(t.f.signOuts, [], 'a refusal never ends the login');
    assert.deepEqual(t.heard, []);
  }
  assert.equal(log.filter((x) => x === 'logout').length, 4, 'every check\'s session was ended, also when the update was refused');
});

test('a session that cannot be ended does not fail the change (the request fails, or is refused)', async () => {
  for (const reply of [{ throws: new TypeError('Failed to fetch') }, { status: 500, body: { msg: 'oops' } }, { status: 401, body: { code: 401, error_code: 'bad_jwt' } }]) {
    fresh();
    plan.logout = reply;
    const { f, data, heard } = await openTab();
    assert.equal(await data.changeOwnPassword(CURRENT, NEXT), undefined);
    assert.deepEqual(log, ['token', 'logout', 'updateUser']);
    assert.deepEqual(f.updates, [{ password: NEXT }]);
    assert.deepEqual(heard, [['USER_UPDATED', null]]);
  }
});

test('the login is gone or unreadable: NOT_LOGGED_IN (or the connection error) before anything is sent', async () => {
  fresh();
  const a = await openTab();
  a.f.session = null;
  await assert.rejects(() => a.data.changeOwnPassword(CURRENT, NEXT), codeOf('NOT_LOGGED_IN'));
  const b = await openTab();
  b.f.session = loginOf('u1', undefined as any);
  b.f.session.user.email = undefined;
  await assert.rejects(() => b.data.changeOwnPassword(CURRENT, NEXT), codeOf('NOT_LOGGED_IN'));
  const c = await openTab();
  c.f.session = null;
  c.f.getSessionError = authError('AuthRetryableFetchError', 0, undefined);
  c.f.getSessionError.message = 'Failed to fetch';
  await assert.rejects(() => c.data.changeOwnPassword(CURRENT, NEXT), (e: any) => /No internet connection/.test(friendlyError(e)));
  assert.deepEqual(log, [], 'no request was made');
});

test('the rules are checked before any request: empty, too short, too long (in bytes), same as the current one', async () => {
  fresh();
  const { f, data } = await openTab();
  for (const [current, next] of [['', NEXT], [CURRENT, ''], [CURRENT, 'short'], [CURRENT, 'a'.repeat(73)], [CURRENT, 'é'.repeat(37)], [CURRENT, CURRENT]]) {
    await assert.rejects(() => data.changeOwnPassword(current, next), codeOf('PASSWORD_RULE'));
  }
  assert.deepEqual(log, []);
  assert.deepEqual(f.updates, []);
});

test('no password reaches the console, the storage, a URL, an error or a login event', async () => {
  const names = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const original: Record<string, any> = {};
  const heardByConsole: unknown[][] = [];
  for (const n of names) { original[n] = console[n]; (console as any)[n] = (...args: unknown[]) => { heardByConsole.push(args); }; }
  const everything: unknown[] = [];
  try {
    const attempts: Array<(t: any) => void> = [
      () => {},
      (t) => { t.f.updateResult = { error: authError('AuthApiError', 422, 'same_password') }; },
      (t) => { t.f.updateResult = { error: authError('AuthWeakPasswordError', 422, 'weak_password', { reasons: ['length'] }) }; },
      (t) => { t.f.updateResult = { error: authError('AuthApiError', 400, 'reauthentication_needed') }; },
      () => { plan.token = wrongPassword; },
      () => { plan.token = { throws: new TypeError('Failed to fetch') }; },
      () => { plan.token = { status: 500, body: { msg: 'boom' } }; },
      () => { plan.logout = { throws: new TypeError('Failed to fetch') }; },
    ];
    for (const setUp of attempts) {
      fresh();
      const t = await openTab();
      setUp(t);
      await t.data.changeOwnPassword(CURRENT, NEXT).catch((e: any) => { everything.push(e.message, e.stack, JSON.stringify({ ...e }), friendlyError(e), friendlyError(e, { audience: 'public' })); });
      everything.push(t.heard, [...store], [...sessionStore], requests.map((r) => r.url), requests.map((r) => r.init.headers));
      await nextTick();
    }
  } finally {
    for (const n of names) (console as any)[n] = original[n];
  }
  const text = inspect([heardByConsole, everything], { depth: 8, maxStringLength: 100000, breakLength: Infinity });
  assert.ok(!text.includes(CURRENT) && !text.includes(NEXT), 'a password was found where none belongs');
  assert.ok(text.includes('Failed to fetch'), 'the scan looked at real content');
});

test('the new password goes to the account that was checked: a login that changes during the check changes nothing', async () => {
  // Ali is checked (the network takes seconds); on another tab Ali logs out and Sara logs in meanwhile. The library's updateUser() acts on
  // whatever login is stored when it runs, so without a look at the stored login right before, Sara's password would be set to Ali's choice.
  fresh();
  const { f, data, heard } = await openTab();
  plan.token = { ...GOOD_TOKEN, during: () => { f.session = loginOf('u2', 'sara@dralirashid.com'); } };
  await assert.rejects(() => data.changeOwnPassword(CURRENT, NEXT), (e: any) => e.code === 'LOGIN_CHANGED' && /login changed/.test(e.message));
  assert.deepEqual(f.updates, [], 'nobody\'s password was set');
  assert.deepEqual(log, ['token', 'logout'], 'the check\'s session was still ended');
  assert.deepEqual(f.signOuts, []);
  assert.deepEqual(heard, []);

  // the check says the password belongs to somebody else than the login that is on screen, or does not say whose it is: also nothing
  for (const body of [{ ...GOOD_TOKEN.body as object, user: { id: 'someone-else', email: EMAIL } }, { access_token: VERIFY_TOKEN, refresh_token: VERIFY_REFRESH }]) {
    fresh();
    plan.token = { status: 200, body };
    const t = await openTab();
    await assert.rejects(() => t.data.changeOwnPassword(CURRENT, NEXT), codeOf('LOGIN_CHANGED'));
    assert.deepEqual(t.f.updates, []);
    assert.deepEqual(log, ['token', 'logout']);
  }
});

test('the check uses the login name the server has now, not the stored copy (a login renamed since the last refresh)', async () => {
  fresh();
  const { f, data } = await openTab();
  f.serverEmail = 'asma.new@dralirashid.com';
  assert.equal(await data.changeOwnPassword(CURRENT, NEXT), undefined);
  assert.deepEqual(JSON.parse(requests[0].init.body), { email: 'asma.new@dralirashid.com', password: CURRENT });
  assert.deepEqual(f.userCalls, ['tok-u1'], 'asked about the stored token, which the server answers for');
});

test('a 401 of the check (gateway, API key) is not "you are not logged in"; the login is kept', async () => {
  fresh();
  plan.token = { status: 401, body: { message: 'Invalid authentication credentials' } };
  const { f, data, heard } = await openTab();
  await assert.rejects(() => data.changeOwnPassword(CURRENT, NEXT), (e: any) => e.code !== 'NOT_LOGGED_IN' && /could not be changed just now/.test(e.message));
  assert.deepEqual(log, ['token']);
  assert.deepEqual(f.signOuts, []);
  assert.deepEqual(heard, []);
});

test('a switched-off account ends the login the usual way: seen before the check, seen by the check, seen by the update', async () => {
  const banned = (status: number) => ({ data: { user: null }, error: authError('AuthApiError', status, 'user_banned') });
  // 1. the look at who is logged in already says so: nothing is sent
  fresh();
  const a = await openTab();
  a.f.userAnswers = [banned(403)];
  await assert.rejects(() => a.data.changeOwnPassword(CURRENT, NEXT), codeOf('ACCOUNT_OFF'));
  assert.deepEqual(log, ['signOut'], 'the login was ended and no password was checked');
  assert.deepEqual(a.f.signOuts, [{ scope: 'local' }]);

  // 2. the check says so (the account was switched off a moment after that look): the login is ended now, not at the next recheck
  fresh();
  plan.token = { status: 400, body: { code: 400, error_code: 'user_banned', msg: 'User is banned' } };
  const b = await openTab();
  b.f.userAnswers = [null, banned(403)];
  await assert.rejects(() => b.data.changeOwnPassword(CURRENT, NEXT), (e: any) => e.code === 'ACCOUNT_OFF' && /switched off/.test(e.message));
  assert.deepEqual(log, ['token', 'signOut']);
  assert.deepEqual(b.f.signOuts, [{ scope: 'local' }]);

  // 3. the update says so
  fresh();
  const c = await openTab();
  c.f.updateResult = { error: authError('AuthApiError', 403, 'user_banned') };
  c.f.userAnswers = [null, banned(403)];
  await assert.rejects(() => c.data.changeOwnPassword(CURRENT, NEXT), codeOf('ACCOUNT_OFF'));
  assert.deepEqual(log, ['token', 'logout', 'updateUser', 'signOut']);
  assert.deepEqual(c.f.signOuts, [{ scope: 'local' }]);
});

test('the look at who is logged in fails: a rate limit is "too many tries", no connection is the usual wording; nothing is sent, the login is kept', async () => {
  fresh();
  const a = await openTab();
  a.f.userAnswers = [{ data: { user: null }, error: authError('AuthApiError', 429, 'over_request_rate_limit') }];
  await assert.rejects(() => a.data.changeOwnPassword(CURRENT, NEXT), codeOf('RATE_LIMITED'));
  const b = await openTab();
  b.f.userAnswers = [{ data: { user: null }, error: Object.assign(authError('AuthRetryableFetchError', 0, undefined), { message: 'Failed to fetch' }) }];
  await assert.rejects(() => b.data.changeOwnPassword(CURRENT, NEXT), (e: any) => /No internet connection/.test(friendlyError(e)));
  const c = await openTab();
  c.f.userAnswers = [{ data: { user: null }, error: authError('AuthApiError', 403, 'session_not_found') }]; // the server no longer knows this login
  await assert.rejects(() => c.data.changeOwnPassword(CURRENT, NEXT), codeOf('NOT_LOGGED_IN'));
  assert.deepEqual(log, [], 'no password was checked');
  for (const t of [a, b, c]) { assert.deepEqual(t.f.signOuts, []); assert.deepEqual(t.heard, []); }
});

test('an update that never answers gives up after 30 seconds, the check\'s session is ended, the login is kept', async () => {
  fresh();
  const { f, data, heard } = await openTab();
  f.auth.updateUser = () => { log.push('updateUser'); return new Promise(() => {}); };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let settled = false;
    const result = data.changeOwnPassword(CURRENT, NEXT);
    result.then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 200 && !log.includes('updateUser'); i++) await nextTick();
    for (let i = 0; i < 10; i++) await nextTick();
    assert.ok(!settled, 'still waiting for the answer');
    mock.timers.tick(29999);
    for (let i = 0; i < 10; i++) await nextTick();
    assert.ok(!settled, 'not before the 30 seconds are over');
    mock.timers.tick(1);
    for (let i = 0; i < 50 && !settled; i++) await nextTick();
    assert.ok(settled, 'gave up');
    await assert.rejects(result, (e: any) => /took too long to answer/.test(e.message) && /took too long/.test(friendlyError(e)));
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(log, ['token', 'logout', 'updateUser']);
  assert.deepEqual(f.signOuts, []);
  assert.deepEqual(heard, []);
});

test('the words: plain, short, and nothing in them the person cannot do', () => {
  assert.equal(PASSWORD_MESSAGES.REAUTH_NEEDED, 'For safety, ask Dr. Ali to set a new password for you.');
  assert.ok(!/Admin|Staff accounts/.test(PASSWORD_MESSAGES.REAUTH_NEEDED), 'most staff have no Admin menu');
  const tooLong = passwordProblems({ current: CURRENT, next: 'a'.repeat(73), again: 'a'.repeat(73) })[0].message;
  assert.equal(tooLong, 'The new password is too long. Use 72 characters or fewer (accented letters count more).');
});

// ======================================================================================= the login watcher
test('after the password is changed the USER_UPDATED is the same person: nothing ends, the person stays on screen, their edits are not touched', async () => {
  fresh();
  const { f, data } = await openTab();
  const ali = await data.getSession();
  assert.equal(ali.kind, 'staff');
  let shown: any = ali;
  const ended: any[] = [];
  const accepted: any[] = [];
  const watch = authChangeHandler({
    data, current: () => shown, busy: () => false,
    ended: (reason: any) => { ended.push(reason); shown = null; },
    accept: (session: any) => { shown = session; accepted.push(session); },
  });
  data.onAuthChange(watch); // exactly as main.js wires it
  await data.changeOwnPassword(CURRENT, NEXT);
  for (let i = 0; i < 20 && !accepted.length; i++) await nextTick();
  assert.deepEqual(ended, [], 'no logout, so no "logged out in another tab" message and no queued edits cleared');
  assert.equal(accepted.length, 1, 'the lookup after USER_UPDATED confirmed the same person');
  assert.equal(shown.staff.id, 'u1');
  assert.deepEqual(f.signOuts, []);
});

// ======================================================================================= the demo data layer
test('demo: the same rules; any current password the first time, then the one chosen; independent per account; a reset forgets', async () => {
  const d = createDemoAdapter();
  await assert.rejects(() => d.changeOwnPassword(CURRENT, NEXT), codeOf('NOT_LOGGED_IN'));
  const staff = (await d.demoAccounts()).filter((a: any) => a.kind === 'staff');
  await d.signInDemo(staff[0].id);
  for (const [current, next] of [['', NEXT], [CURRENT, 'short'], [CURRENT, 'a'.repeat(73)], [CURRENT, CURRENT]]) {
    await assert.rejects(() => d.changeOwnPassword(current, next), codeOf('PASSWORD_RULE'));
  }
  await d.changeOwnPassword('anything at all', NEXT); // the first time
  await assert.rejects(() => d.changeOwnPassword('anything at all', 'Another-pass-1'), (e: any) => e.code === 'WRONG_PASSWORD' && e.message === 'Your current password is not right.');
  await d.changeOwnPassword(NEXT, 'Another-pass-1'); // now it has to be the one chosen
  await assert.rejects(() => d.changeOwnPassword(NEXT, 'Third-pass-33'), codeOf('WRONG_PASSWORD'));
  assert.equal((await d.getSession())?.staff.id, staff[0].id, 'still logged in');
  await d.signInDemo(staff[1].id);
  await d.changeOwnPassword('whatever', NEXT); // another account has its own first time
  await d.signInDemo(staff[0].id);
  await assert.rejects(() => d.changeOwnPassword('whatever', 'Third-pass-33'), codeOf('WRONG_PASSWORD'), 'the first account remembers its choice');
  await d.resetDemo();
  await d.signInDemo(staff[0].id);
  await d.changeOwnPassword('whatever', NEXT);
});
