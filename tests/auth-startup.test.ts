// What state.js (web/js/state.js) does with the login it finds while the page loads: a person whose account was switched off or deleted
// while their tab was open has their login ended by the data layer, and if they reload that tab, state.endedReason carries why, so
// main.js can tell them instead of showing the login page with no explanation. Only the tab that had been showing a login says it
// (sessionStorage): whoever opens a new tab or the site later, on a shared computer, is not told about somebody else's account, and a
// visitor on the public pages never sees such a notice. Anything else that goes wrong at startup says nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// state.js asks ./data/index.js for the data layer: here it is a stand-in that the test sets per run.
registerHooks({
  resolve(spec, ctx, nextResolve) {
    if (spec === './data/index.js' && ctx.parentURL?.includes('/web/js/state.js')) {
      return { url: 'data:text/javascript,export const getData = async () => globalThis.__startupData;', shortCircuit: true };
    }
    return nextResolve(spec, ctx);
  },
});

// this tab's sessionStorage (it survives a reload of the tab, not a new tab: a new tab is a new, empty one)
const tab = new Map<string, string>();
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => (tab.has(k) ? tab.get(k) : null),
    setItem: (k: string, v: unknown) => { tab.set(k, String(v)); },
    removeItem: (k: string) => { tab.delete(k); },
  },
});

const accountError = (code: string) => Object.assign(new Error('account problem'), { code });
const ali = { kind: 'staff', staff: { id: 'staff-1' }, perms: new Set() };
let run = 0;

/** Loads a fresh copy of state.js (it starts loading as soon as it is imported) against a data layer whose getSession() does `getSession`. */
async function startUp(getSession: () => Promise<unknown>) {
  (globalThis as any).__startupData = {
    getSession, branches: async () => [], cities: async () => [], settings: async () => ({}),
  };
  const { state } = await import(`../web/js/state.js?run=${(run += 1)}`);
  await state.ready;
  return state;
}
/** The tab was showing a login when it was reloaded: what it leaves behind in sessionStorage. */
const reloadedTab = () => { tab.clear(); tab.set('tab-had-login', '1'); };
const newTab = () => tab.clear();

test('a switched-off account found while a tab that showed its login reloads: nobody is shown, and the reason is kept for main.js to say', async () => {
  reloadedTab();
  const state = await startUp(async () => { throw accountError('ACCOUNT_OFF'); });
  assert.equal(state.session, null);
  assert.equal(state.endedReason, 'switched_off');
  assert.equal(state.dataError, null, 'the rest of the page still loads');
});

test('a deleted account found while that tab reloads keeps the account_gone reason', async () => {
  reloadedTab();
  const state = await startUp(async () => { throw accountError('ACCOUNT_GONE'); });
  assert.equal(state.session, null);
  assert.equal(state.endedReason, 'account_gone');
});

test('a NEW tab (or the site opened later) says nothing about somebody else\'s switched-off or deleted account, on any page', async () => {
  for (const code of ['ACCOUNT_OFF', 'ACCOUNT_GONE']) {
    newTab();
    const state = await startUp(async () => { throw accountError(code); });
    assert.equal(state.session, null);
    assert.equal(state.endedReason, null, code);
    assert.equal(state.dataError, null, 'the page itself still loads normally');
  }
});

test('a login that is fine, nobody logged in, or any other failure while loading gives no reason', async () => {
  for (const getSession of [
    async () => ali,
    async () => null,
    async () => { throw new Error('Failed to fetch'); },
    async () => { throw accountError('LOGIN_CHANGED'); },
  ]) {
    const quiet = console.error;
    console.error = () => {};
    try {
      reloadedTab();
      const state = await startUp(getSession);
      assert.equal(state.endedReason, null);
    } finally {
      console.error = quiet;
    }
  }
});

test('a logged-in person is kept as the session', async () => {
  newTab();
  const state = await startUp(async () => ali);
  assert.equal(state.session, ali);
  assert.equal(state.endedReason, null);
});

test('the tab remembers that it shows a login for as long as it does: set with state.session, gone with a logout, and after a load that found nobody', async () => {
  newTab();
  const state = await startUp(async () => ali);
  assert.equal(tab.get('tab-had-login'), '1', 'a login found while loading');
  state.session = null; // a logout
  assert.equal(tab.has('tab-had-login'), false);
  state.session = ali; // a login on this tab
  assert.equal(tab.get('tab-had-login'), '1');
  const quiet = console.error;
  console.error = () => {};
  try {
    reloadedTab();
    await startUp(async () => { throw accountError('ACCOUNT_OFF'); });
  } finally {
    console.error = quiet;
  }
  assert.equal(tab.has('tab-had-login'), false, 'the login ended while loading: the next reload is not "a tab that showed a login" any more');
});

test('with sessionStorage blocked everything still works, and nothing is said', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage') as PropertyDescriptor;
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('blocked'); } });
  try {
    const state = await startUp(async () => { throw accountError('ACCOUNT_OFF'); });
    assert.equal(state.endedReason, null);
    assert.equal(state.session, null);
    state.session = ali;
    assert.equal(state.session, ali);
  } finally {
    Object.defineProperty(globalThis, 'sessionStorage', saved);
  }
});
