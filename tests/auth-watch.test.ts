// The login-change handler of main.js (web/js/auth-watch.js): a momentary "nobody is logged in" answer, or any failed
// lookup, must never log a person out; only the SIGNED_OUT event, a different person, or the data layer saying the
// account itself is gone (switched off / deleted) does, and then the reason reaches the screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authChangeHandler, endedNotice } from '../web/js/auth-watch.js';

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
