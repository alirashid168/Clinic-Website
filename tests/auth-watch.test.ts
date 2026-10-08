// The login-change handler of main.js (web/js/auth-watch.js): a momentary "nobody is logged in" answer must
// never log a person out; only the SIGNED_OUT event, or a different person, does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authChangeHandler } from '../web/js/auth-watch.js';

const ali = { kind: 'staff', staff: { id: 'staff-1' } };
const sara = { kind: 'staff', staff: { id: 'staff-2' } };

/** A tab showing `shown`, whose data layer answers getSession() with whatever `answers` holds next. */
function tab(shown: any, answers: Array<any> = []) {
  const t: any = {
    session: shown, busy: false, ended: 0, accepted: [] as any[], asked: 0,
    gate: null as null | Promise<void>, // lets a test hold an answer back
  };
  t.data = {
    async getSession() {
      t.asked += 1;
      if (t.gate) await t.gate;
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
  // The handler exactly as main.js wires it: ended() leaves the screen, accept() keeps the refreshed login.
  t.fire = authChangeHandler({
    data: t.data, current: () => t.session, busy: () => t.busy,
    ended: () => { t.ended += 1; t.session = null; },
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
