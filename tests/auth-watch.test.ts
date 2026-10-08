// The login-change handler of main.js (web/js/auth-watch.js): a momentary "nobody is logged in" answer, or any failed
// lookup, must never log a person out; only the SIGNED_OUT event, a different person, or the data layer saying the
// account itself is gone (switched off / deleted) does, and then the reason reaches the screen. Only the newest lookup counts, and a
// tab that stays visible looks again every 4 minutes (startRecheck), with the same strict rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTick } from 'node:timers/promises';
import { authChangeHandler, endedNotice, startRecheck, accountEnding, RECHECK_EVENT, RECHECK_EVERY_MS } from '../web/js/auth-watch.js';

const ali = { kind: 'staff', staff: { id: 'staff-1' } };
const sara = { kind: 'staff', staff: { id: 'staff-2' } };

/** A tab showing `shown`, whose data layer answers getSession() with whatever `answers` holds next. */
function tab(shown: any, answers: Array<any> = []) {
  const t: any = {
    session: shown, busy: false, ended: 0, reasons: [] as any[], accepted: [] as any[], asked: 0, askedWith: [] as any[],
    gate: null as null | Promise<void>, // lets a test hold an answer back
  };
  t.data = {
    async getSession(...args: any[]) {
      t.asked += 1;
      t.askedWith.push(args);
      if (t.gate) await t.gate;
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
  // The handler exactly as main.js wires it: ended() leaves the screen, accept() keeps the refreshed login.
  t.fire = authChangeHandler({
    data: t.data, current: () => t.session, busy: () => t.busy,
    ended: (reason: any) => { t.ended += 1; t.reasons.push(reason); t.session = null; },
    accept: (s: any) => { t.session = s; t.accepted.push(s); },
  });
  return t;
}

test('a momentary "nobody" (network blip, refresh in flight) keeps the person logged in; the next valid answer keeps them in too', async () => {
  const t = tab(ali, [null, ali]);
  await t.fire('SIGNED_IN'); // tab focused again while GET /user fails: getSession() answers null
  assert.equal(t.ended, 0);
  assert.equal(t.session, ali, 'still logged in, nothing replaced');
  assert.equal(t.accepted.length, 0);
  await t.fire('SIGNED_IN'); // network is back
  assert.equal(t.ended, 0);
  assert.equal(t.session, ali);
  assert.deepEqual(t.accepted, [ali]);
});

test('a failed lookup (it throws) does not log anyone out', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const t = tab(ali, [new Error('Failed to fetch'), ali]);
    await t.fire('TOKEN_REFRESHED');
    assert.equal(t.ended, 0);
    assert.equal(t.session, ali);
    await t.fire('SIGNED_IN');
    assert.equal(t.ended, 0);
  } finally {
    console.error = quiet;
  }
});

test('repeated "nobody" answers never log out, with or without an event name', async () => {
  const t = tab(ali, [null, null, null, null]);
  for (const event of ['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED', undefined]) await t.fire(event);
  assert.equal(t.ended, 0);
  assert.equal(t.session, ali);
});

test('the SIGNED_OUT event ends the login, once, without asking the data layer', async () => {
  const t = tab(ali, [ali]);
  await t.fire('SIGNED_OUT');
  assert.equal(t.ended, 1);
  assert.equal(t.session, null);
  assert.equal(t.asked, 0, 'no lookup: the event itself is the proof');
  await t.fire('SIGNED_OUT'); // nothing left on screen to end
  assert.equal(t.ended, 1);
});

test('SIGNED_OUT with nobody shown is not news', async () => {
  const t = tab(null);
  await t.fire('SIGNED_OUT');
  assert.equal(t.ended, 0);
});

test('a different person confirmed by the data layer (signed in from another tab) ends the login', async () => {
  const t = tab(ali, [sara]);
  await t.fire('SIGNED_IN');
  assert.equal(t.ended, 1);
  assert.equal(t.accepted.length, 0);
});

test('a login that appears in a tab that showed nobody is accepted', async () => {
  const t = tab(null, [ali]);
  await t.fire('SIGNED_IN');
  assert.equal(t.ended, 0);
  assert.deepEqual(t.accepted, [ali]);
});

test("this tab's own logout is not news, including its SIGNED_OUT", async () => {
  const t = tab(ali, [ali]);
  t.busy = true;
  await t.fire('SIGNED_OUT');
  await t.fire('SIGNED_IN');
  assert.equal(t.ended, 0);
  assert.equal(t.asked, 0);
});

test('an answer still on its way when SIGNED_OUT arrives does not put the login back', async () => {
  const t = tab(ali, [ali]);
  let release: () => void = () => {};
  t.gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = t.fire('SIGNED_IN'); // asks, and waits
  await t.fire('SIGNED_OUT');
  assert.equal(t.ended, 1);
  release();
  await pending;
  assert.equal(t.session, null, 'the late answer was dropped');
  assert.equal(t.accepted.length, 0);
});

test('an answer that comes back after this tab finished its own logout does not put the login back', async () => {
  const t = tab(ali, [ali]);
  let release: () => void = () => {};
  t.gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = t.fire('TOKEN_REFRESHED');
  t.busy = true;
  await t.fire('SIGNED_OUT'); // the library's event for this tab's own logout (ignored as news, but it still cancels the pending answer)
  t.session = null; // main.js: state.session = null
  t.busy = false; // logout finished
  release();
  await pending;
  assert.equal(t.session, null);
  assert.equal(t.accepted.length, 0);
});

/** Switched off / deleted: the data layer ends the login itself, then getSession() fails with one of these codes. */
const accountError = (code: string) => Object.assign(new Error('account problem'), { code });

test('the watcher asks the data layer strictly (a login without any account record counts as gone)', async () => {
  const t = tab(ali, [ali]);
  await t.fire('SIGNED_IN');
  assert.deepEqual(t.askedWith, [[{ strict: true }]]);
});

test('SIGNED_OUT carries its reason to the screen: switched off, account gone, idle logout of another tab', async () => {
  for (const reason of ['switched_off', 'account_gone', 'idle']) {
    const t = tab(ali);
    await t.fire('SIGNED_OUT', reason);
    assert.equal(t.ended, 1);
    assert.deepEqual(t.reasons, [reason]);
  }
});

test('SIGNED_OUT without a reason (logged out in another tab, expired) ends the login with no reason', async () => {
  const t = tab(ali);
  await t.fire('SIGNED_OUT');
  assert.deepEqual(t.reasons, [null]);
});

test('a switched-off account (getSession fails with ACCOUNT_OFF) ends the login with that reason, even if no SIGNED_OUT ever came', async () => {
  // e.g. the server never confirmed the data layer's own logout, so auth-js sent no event
  const t = tab(ali, [accountError('ACCOUNT_OFF')]);
  await t.fire('SIGNED_IN');
  assert.equal(t.ended, 1);
  assert.deepEqual(t.reasons, ['switched_off']);
  assert.equal(t.session, null);
});

test('a deleted or unlinked account (ACCOUNT_GONE) ends the login with the account_gone reason', async () => {
  const t = tab(ali, [accountError('ACCOUNT_GONE')]);
  await t.fire('TOKEN_REFRESHED');
  assert.deepEqual(t.reasons, ['account_gone']);
});

test('the usual order for a switched-off account (SIGNED_OUT first, then the error) logs out exactly once', async () => {
  const t = tab(ali);
  // The data layer ends the login: auth-js sends SIGNED_OUT (and main.js is then busy logging out); only afterwards getSession() fails.
  let fail: (e: Error) => void = () => {};
  t.data.getSession = () => new Promise((_, reject) => { fail = reject; });
  const asking = t.fire('SIGNED_IN');
  await Promise.resolve();
  await t.fire('SIGNED_OUT', 'switched_off');
  t.busy = true; // endedElsewhere() has started its logout
  fail(accountError('ACCOUNT_OFF'));
  await asking;
  assert.deepEqual(t.reasons, ['switched_off'], 'ended once, by the event, with its reason');
});

test('an ACCOUNT_OFF failure is not news when nobody is shown (the login page)', async () => {
  const t = tab(null, [accountError('ACCOUNT_OFF')]);
  await t.fire('SIGNED_IN');
  assert.equal(t.ended, 0);
});

test('an ACCOUNT_OFF failure that comes back after this tab logged itself out does not log out again', async () => {
  const t = tab(ali, [accountError('ACCOUNT_OFF')]);
  let release: () => void = () => {};
  t.gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = t.fire('SIGNED_IN');
  t.busy = true; // own Log out starts
  await t.fire('SIGNED_OUT');
  t.session = null; t.busy = false; // and finishes
  release();
  await pending;
  assert.equal(t.ended, 0);
});

test('failed lookups of every transient kind never log anyone out (offline, timeout, 5xx, 52x, 408, 429)', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const kinds = [
      { name: 'TypeError', message: 'Failed to fetch' },
      { name: 'TIMEOUT', code: 'ABORT_ERR', message: 'The clinic server took too long to answer.' },
      { name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed' },
      { name: 'AuthUnknownError', message: 'Unexpected token < in JSON' }, // an HTML error page
      { status: 500 }, { status: 503 }, { status: 522 }, { status: 408 }, { status: 429 },
    ];
    for (const k of kinds) {
      const t = tab(ali, [Object.assign(new Error('lookup failed'), k)]);
      await t.fire('SIGNED_IN');
      assert.equal(t.ended, 0, JSON.stringify(k));
      assert.equal(t.session, ali);
    }
  } finally {
    console.error = quiet;
  }
});

/** A tab whose every getSession() call is answered by hand (resolve/reject in the order the test wants). */
function manualTab(shown: any) {
  const answers: Array<{ resolve: (v: any) => void; reject: (e: Error) => void }> = [];
  const t: any = { session: shown, busy: false, ended: 0, accepted: [] as any[], log: [] as string[] };
  t.data = { getSession: () => new Promise((resolve, reject) => { answers.push({ resolve, reject }); }) };
  t.fire = authChangeHandler({
    data: t.data, current: () => t.session, busy: () => t.busy,
    ended: () => { t.ended += 1; t.session = null; t.log.push('ended'); },
    accept: (s: any) => { t.session = s; t.accepted.push(s); t.log.push('accepted ' + (s.staff?.id || s.patient?.id)); },
  });
  return { t, answers };
}

test('a slow answer about the previous person does not put them back after another person took over (no SIGNED_OUT in between)', async () => {
  const { t, answers } = manualTab(ali);
  const first = t.fire('SIGNED_IN'); // lookup #1 (Ali's token) is slow
  const second = t.fire('SIGNED_IN'); // another tab signed in as Sara; lookup #2 names her
  answers[1].resolve(sara);
  await second;
  assert.equal(t.ended, 1, 'Ali is logged out: someone else is signed in');
  answers[0].resolve(ali); // lookup #1 finally answers
  await first;
  assert.equal(t.session, null, 'nobody is put back on screen');
  assert.deepEqual(t.accepted, []);
  assert.deepEqual(t.log, ['ended']);
});

test('a slow answer about the previous person neither replaces nor ends a person who logged in on this tab meanwhile', async () => {
  const { t, answers } = manualTab(ali);
  const asking = t.fire('SIGNED_IN'); // asked while Ali was shown
  t.session = sara; // meanwhile Ali's screen ended and Sara logged in here
  answers[0].resolve(ali);
  await asking;
  assert.equal(t.session, sara);
  assert.equal(t.ended, 0);
  assert.deepEqual(t.accepted, []);
});

test('a slow answer for the person who is still shown is accepted', async () => {
  const { t, answers } = manualTab(ali);
  const asking = t.fire('TOKEN_REFRESHED');
  answers[0].resolve({ kind: 'staff', staff: { id: 'staff-1' }, newer: true });
  await asking;
  assert.equal(t.accepted.length, 1);
});

test('endedNotice words each reason (staff are told to contact Dr. Ali, patients the clinic)', () => {
  assert.equal(endedNotice('switched_off'), 'You were logged out because this account was switched off. Contact Dr. Ali.');
  assert.equal(endedNotice('account_gone'), 'You were logged out because this account no longer exists. Contact Dr. Ali.');
  assert.equal(endedNotice('account_gone', { patient: true }), 'You were logged out because this account no longer exists. Please contact the clinic.');
  assert.equal(endedNotice('idle', { idleMinutes: 30 }), 'You were logged out because there was no activity for 30 minutes.');
  assert.equal(endedNotice('idle', { idleMinutes: 1 }), 'You were logged out because there was no activity for 1 minute.');
  assert.equal(endedNotice(null), 'You were logged out. Your login ended in another tab or window, or it expired. Please log in again.');
  assert.equal(endedNotice(undefined as any), endedNotice(null));
});

// ---- only the newest lookup counts
test('from "nobody shown", an older lookup that answers first is dropped when a newer lookup is on its way (two sign-ins overlapping)', async () => {
  const { t, answers } = manualTab(null);
  const first = t.fire('SIGNED_IN'); // Ali signed in in tab A: lookup #1 (his token)
  const second = t.fire('SIGNED_IN'); // Sara signed in over him in tab C (no SIGNED_OUT in between): lookup #2
  answers[0].resolve(ali); // the older lookup answers first
  await first;
  assert.equal(t.session, null, 'Ali is not put on screen while the stored login is Sara\'s');
  assert.deepEqual(t.accepted, []);
  answers[1].resolve(sara);
  await second;
  assert.deepEqual(t.log, ['accepted staff-2']);
  assert.equal(t.session, sara);
});

test('the newer lookup answering first is accepted, and the older one that follows changes nothing', async () => {
  const { t, answers } = manualTab(null);
  const first = t.fire('SIGNED_IN');
  const second = t.fire('SIGNED_IN');
  answers[1].resolve(sara);
  await second;
  answers[0].resolve(ali);
  await first;
  assert.deepEqual(t.log, ['accepted staff-2']);
  assert.equal(t.session, sara);
});

test('"somebody else is logged in" ends the screen of the previous person even when it comes from an older lookup and the newer one then fails', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const { t, answers } = manualTab(ali);
    const first = t.fire('SIGNED_IN'); // Sara signed in over Ali in another tab (no SIGNED_OUT): lookup #1 (slow) will name her
    const second = t.fire('SIGNED_IN'); // the person focuses the tab, or the 4-minute check fires: lookup #2
    answers[1].reject(new TypeError('Failed to fetch')); // a blip: no proof either way
    await second;
    assert.equal(t.session, ali, 'a failed lookup changes nothing');
    answers[0].resolve(sara); // lookup #1: the stored login is Sara's
    await first;
    assert.deepEqual(t.log, ['ended'], "Ali is not left on screen over Sara's login (his saves would go out as her)");
    assert.equal(t.session, null);
  } finally {
    console.error = quiet;
  }
});

test('the same, when the newer lookup has not answered at all yet', async () => {
  const { t, answers } = manualTab(ali);
  const first = t.fire('SIGNED_IN');
  const second = t.fire('RECHECK');
  answers[0].resolve(sara);
  await first;
  assert.deepEqual(t.log, ['ended']);
  answers[1].resolve(sara); // the newer lookup answers later: the screen has ended meanwhile, so it changes nothing
  await second;
  assert.deepEqual(t.log, ['ended']);
  assert.equal(t.session, null);
});

test('an overtaken lookup still may not put anybody on screen: only the newest decides who is accepted', async () => {
  const { t, answers } = manualTab(ali);
  const first = t.fire('SIGNED_IN');
  const second = t.fire('SIGNED_IN');
  answers[0].resolve(ali); // the same person that is shown, from the older lookup
  await first;
  assert.deepEqual(t.accepted, [], 'not accepted while a newer lookup is on its way');
  answers[1].resolve(ali);
  await second;
  assert.equal(t.accepted.length, 1);
  assert.deepEqual(t.log, ['accepted staff-1']);
});

test('a lookup that found no proof (the login changed under it, could not be confirmed) is not news, and is not logged as an error', async () => {
  const logged: unknown[] = [];
  const quiet = console.error;
  console.error = (...a: unknown[]) => { logged.push(a); };
  try {
    for (const code of ['LOGIN_CHANGED', 'LOGIN_UNCONFIRMED']) {
      const t = tab(ali, [Object.assign(new Error('x'), { code })]);
      await t.fire('SIGNED_IN');
      assert.equal(t.ended, 0);
      assert.equal(t.session, ali);
    }
    assert.deepEqual(logged, []);
    const other = tab(ali, [new Error('Failed to fetch')]);
    await other.fire('SIGNED_IN');
    assert.equal(logged.length, 1, 'any other failure is still reported');
  } finally {
    console.error = quiet;
  }
});

test('a late ACCOUNT_OFF about the old person does not end the person who is shown now', async () => {
  const t = tab(ali, [accountError('ACCOUNT_OFF')]);
  let release: () => void = () => {};
  t.gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = t.fire('SIGNED_IN'); // asked while Ali was shown
  t.session = sara; // Ali's screen ended and Sara logged in here meanwhile
  release();
  await pending;
  assert.equal(t.ended, 0);
  assert.equal(t.session, sara);
});

test('accountEnding names the reason of an ACCOUNT_OFF / ACCOUNT_GONE failure and nothing else', () => {
  assert.equal(accountEnding(accountError('ACCOUNT_OFF')), 'switched_off');
  assert.equal(accountEnding(accountError('ACCOUNT_GONE')), 'account_gone');
  assert.equal(accountEnding(accountError('LOGIN_CHANGED')), null);
  assert.equal(accountEnding(new Error('x')), null);
  assert.equal(accountEnding(undefined), null);
});

// ---- the periodic look (a tab that stays visible)
test('the periodic check asks strictly and reads the record again (fresh), unlike a login event', async () => {
  const t = tab(ali, [ali, ali]);
  await t.fire(RECHECK_EVENT);
  await t.fire('SIGNED_IN');
  assert.deepEqual(t.askedWith, [[{ strict: true, fresh: true }], [{ strict: true }]]);
  assert.equal(t.session, ali);
});

test('the periodic check ends a switched-off or deleted account with the right reason, and leaves a failed or empty answer alone', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    for (const [code, reason] of [['ACCOUNT_OFF', 'switched_off'], ['ACCOUNT_GONE', 'account_gone']]) {
      const t = tab(ali, [accountError(code)]);
      await t.fire(RECHECK_EVENT);
      assert.deepEqual(t.reasons, [reason]);
      assert.equal(t.session, null);
    }
    const t = tab(ali, [new Error('Failed to fetch'), null, ali]);
    for (let i = 0; i < 3; i++) await t.fire(RECHECK_EVENT);
    assert.equal(t.ended, 0);
    assert.equal(t.session, ali);
  } finally {
    console.error = quiet;
  }
});

/** A page's document and window for startRecheck: visibility and the events that change it. */
function page(visibility = 'visible') {
  const listeners = new Map<string, Set<() => void>>();
  const target = {
    visibilityState: visibility,
    addEventListener: (type: string, fn: () => void) => { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn); },
    removeEventListener: (type: string, fn: () => void) => { listeners.get(type)?.delete(fn); },
    send: (type: string) => { for (const fn of [...(listeners.get(type) ?? [])]) fn(); },
    count: (type: string) => listeners.get(type)?.size ?? 0,
  };
  return target;
}
const flush = () => nextTick(); // lets the look that just fired finish and schedule the next one

test('the periodic check looks every 4 minutes while the tab is visible and somebody is signed in', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = page();
  let looks = 0;
  const recheck = startRecheck({ fire: async () => { looks += 1; }, active: () => true, doc, win: page() });
  recheck.poke();
  ctx.mock.timers.tick(RECHECK_EVERY_MS - 1);
  assert.equal(looks, 0);
  ctx.mock.timers.tick(1);
  await flush();
  assert.equal(looks, 1);
  ctx.mock.timers.tick(RECHECK_EVERY_MS);
  await flush();
  assert.equal(looks, 2);
  recheck.stop();
});

test('the periodic check is 4 minutes by default (a switched-off account ends within minutes)', () => {
  assert.equal(RECHECK_EVERY_MS, 4 * 60 * 1000);
});

test('the periodic check stops while the tab is hidden and starts again, with a full wait, when it is visible again', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = page();
  let looks = 0;
  const recheck = startRecheck({ fire: async () => { looks += 1; }, active: () => true, doc, win: page() });
  recheck.poke();
  ctx.mock.timers.tick(RECHECK_EVERY_MS - 1000);
  doc.visibilityState = 'hidden';
  doc.send('visibilitychange');
  ctx.mock.timers.tick(RECHECK_EVERY_MS * 3);
  await flush();
  assert.equal(looks, 0, 'nothing looks while hidden, and nothing is waiting to');
  doc.visibilityState = 'visible';
  doc.send('visibilitychange');
  ctx.mock.timers.tick(RECHECK_EVERY_MS - 1);
  await flush();
  assert.equal(looks, 0);
  ctx.mock.timers.tick(1);
  await flush();
  assert.equal(looks, 1);
  recheck.stop();
});

test('the periodic check stops when nobody is signed in and starts when somebody is (poke)', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  let signedIn = false;
  let looks = 0;
  const recheck = startRecheck({ fire: async () => { looks += 1; }, active: () => signedIn, doc: page(), win: page() });
  recheck.poke();
  ctx.mock.timers.tick(RECHECK_EVERY_MS * 2);
  await flush();
  assert.equal(looks, 0, 'nobody to look for');
  signedIn = true;
  recheck.poke();
  ctx.mock.timers.tick(RECHECK_EVERY_MS);
  await flush();
  assert.equal(looks, 1);
  signedIn = false; // logged out while a look is scheduled
  recheck.poke();
  ctx.mock.timers.tick(RECHECK_EVERY_MS * 2);
  await flush();
  assert.equal(looks, 1, 'the scheduled look is cancelled');
  recheck.stop();
});

test('a look that finds nobody signed in any more (the timer fires just after the logout) does nothing and schedules nothing', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  let signedIn = true;
  let looks = 0;
  const recheck = startRecheck({ fire: async () => { looks += 1; }, active: () => signedIn, doc: page(), win: page() });
  recheck.poke();
  signedIn = false; // no poke: the person went away without telling it
  ctx.mock.timers.tick(RECHECK_EVERY_MS);
  await flush();
  assert.equal(looks, 0);
  ctx.mock.timers.tick(RECHECK_EVERY_MS * 3);
  await flush();
  assert.equal(looks, 0, 'no timer left running');
  recheck.stop();
});

test('the periodic check looks at once when the connection comes back, only while visible and signed in', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = page();
  const win = page();
  let signedIn = true;
  let looks = 0;
  const recheck = startRecheck({ fire: async () => { looks += 1; }, active: () => signedIn, doc, win });
  recheck.poke();
  win.send('online');
  await flush();
  assert.equal(looks, 1, 'a check that failed offline said nothing: look again now');
  doc.visibilityState = 'hidden';
  win.send('online');
  await flush();
  assert.equal(looks, 1, 'hidden: no');
  doc.visibilityState = 'visible';
  signedIn = false;
  win.send('online');
  await flush();
  assert.equal(looks, 1, 'nobody signed in: no');
  recheck.stop();
});

test('looks never overlap, and one that never answers stops holding back the next after two minutes', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const win = page();
  let looks = 0;
  const recheck = startRecheck({ fire: () => { looks += 1; return new Promise<void>(() => {}); }, active: () => true, doc: page(), win });
  recheck.poke();
  ctx.mock.timers.tick(RECHECK_EVERY_MS);
  await flush();
  assert.equal(looks, 1);
  win.send('online');
  await flush();
  assert.equal(looks, 1, 'still looking: not twice at once');
  ctx.mock.timers.tick(2 * 60 * 1000);
  await flush();
  ctx.mock.timers.tick(RECHECK_EVERY_MS);
  await flush();
  assert.equal(looks, 2, 'the hung look was given up and the next one went ahead');
  recheck.stop();
});

test('a look that fails is reported and the next one still comes; stop() removes the listeners and the timer', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const quiet = console.error;
  const logged: unknown[] = [];
  console.error = (...a: unknown[]) => { logged.push(a); };
  const doc = page();
  const win = page();
  let looks = 0;
  try {
    const recheck = startRecheck({ fire: async () => { looks += 1; throw new Error('boom'); }, active: () => true, doc, win });
    recheck.poke();
    ctx.mock.timers.tick(RECHECK_EVERY_MS);
    await flush();
    ctx.mock.timers.tick(RECHECK_EVERY_MS);
    await flush();
    assert.equal(looks, 2);
    assert.equal(logged.length, 2);
    assert.equal(doc.count('visibilitychange'), 1);
    assert.equal(win.count('online'), 1);
    recheck.stop();
    assert.equal(doc.count('visibilitychange'), 0);
    assert.equal(win.count('online'), 0);
    ctx.mock.timers.tick(RECHECK_EVERY_MS * 3);
    await flush();
    assert.equal(looks, 2, 'stopped');
  } finally {
    console.error = quiet;
  }
});
