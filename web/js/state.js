// Shared app state: the data layer, who is logged in, and cached reference
// lists (branches, doctors, treatments) used across screens.
//
// Loading starts as soon as this file runs. `state.ready` resolves when it is
// done and never rejects: if the data layer or the public lists fail to load,
// or the whole start-up takes longer than START_DEADLINE_MS, `state.dataError`
// holds the error and the lists stay empty, so the public pages can still show
// their own wording and a way to contact the clinic.
import { getData } from './data/index.js';
import { accountEnding } from './auth-watch.js';

// Whether THIS tab was showing somebody's login (sessionStorage: it survives a reload of the tab, and nothing else). A person whose account
// was switched off or deleted while the tab was open, and who reloads it, is told why. Whoever opens a new tab or the site later on a
// shared computer is not: the notice is about somebody else's account, and a visitor on the public pages would not understand it.
const LOGIN_MARK = 'tab-had-login';
function markLogin(on) {
  try { if (on) sessionStorage.setItem(LOGIN_MARK, '1'); else sessionStorage.removeItem(LOGIN_MARK); } catch { /* storage blocked: no notice after a reload */ }
}
function tabHadLogin() {
  try { return sessionStorage.getItem(LOGIN_MARK) === '1'; } catch { return false; }
}

let shownSession = null;
export const state = {
  data: null,
  // (main.js, login.js and this file all assign it: every change of who is shown also updates the tab's mark)
  get session() { return shownSession; },
  set session(value) { shownSession = value; markLogin(!!value); },
  endedReason: null, // 'switched_off' / 'account_gone' when this tab had a login on screen and it was found, while loading, to be of such an account: main.js says why
  ready: null,
  dataError: null,
  ref: { branches: [], cities: [], clinicians: [], treatments: [], categories: [], settings: {} },
};

// Each read gives up by itself (20 s in the data layer), but loading the library and then the
// lists one after the other could still add up to a minute of "Loading…". This is the limit for
// all of it together.
const START_DEADLINE_MS = 20000;

let readyPromise;
let timedOut = false;

/** Starts loading (once) and returns state.ready. */
export function init() {
  if (!readyPromise) {
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        state.dataError = new Error('TIMEOUT: the clinic system took too long to answer');
        console.error(state.dataError);
        resolve();
      }, START_DEADLINE_MS);
    });
    readyPromise = Promise.race([start(), deadline]).finally(() => clearTimeout(timer));
  }
  return readyPromise;
}

async function start() {
  try {
    const hadLogin = tabHadLogin(); // before the first assignment of state.session below
    state.data = await getData();
    // Who is logged in and the public lists load side by side.
    const [session, ref] = await Promise.allSettled([state.data.getSession(), loadPublicRef()]);
    if (timedOut) return; // the pages have already been told the system is not available
    state.session = session.status === 'fulfilled' ? session.value : null;
    // A switched-off or deleted account was found out while loading (the data layer has ended its login): the person is told why, not
    // just shown the login page, if this very tab had been showing that login (a reload; see LOGIN_MARK). A new tab says nothing.
    state.endedReason = hadLogin && session.status === 'rejected' ? accountEnding(session.reason) : null;
    if (ref.status === 'rejected') throw ref.reason;
  } catch (e) {
    if (timedOut) return;
    console.error(e);
    state.dataError = e instanceof Error ? e : new Error(String(e));
  }
}

export async function loadPublicRef() {
  const d = state.data;
  // Settings hold the clinic timings and the WhatsApp number: without them the
  // public pages would show confident but wrong text, so a failure counts as a failure.
  const [branches, cities, settings] = await Promise.all([d.branches(), d.cities(), d.settings()]);
  Object.assign(state.ref, { branches, cities, settings: settings || {} });
}

export async function loadStaffRef() {
  const d = state.data;
  const [clinicians, treatments, categories, settings] = await Promise.all([
    d.clinicians(), d.treatments(), d.expenseCategories().catch(() => []), d.settings().catch(() => ({})),
  ]);
  Object.assign(state.ref, { clinicians, treatments, categories, settings });
}

export const can = (key) => !!state.session?.perms?.has(key) || state.session?.staff?.role === 'admin';
export const isAdmin = () => state.session?.staff?.role === 'admin';
export const branchName = (id) => state.ref.branches.find((b) => b.id === Number(id))?.name || '';
export const cityName = (id) => state.ref.cities.find((c) => c.id === Number(id))?.name || '';
export const clinicianName = (id) => state.ref.clinicians.find((c) => c.id === id)?.display_name || '';

/** Branches this staff member may work in (front desk is usually one branch). */
export function myBranches() {
  const s = state.session?.staff;
  if (!s) return [];
  if (s.role !== 'admin' && s.restrict_to_branches) return state.ref.branches.filter((b) => s.branch_ids.includes(b.id));
  return state.ref.branches;
}

export function defaultBranchId() {
  const s = state.session?.staff;
  const mine = myBranches();
  return Number(s?.home_branch_id) || mine[0]?.id || null;
}

state.ready = init();
