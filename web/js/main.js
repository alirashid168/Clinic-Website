// Router: #/ (home), #/visitor, #/clinics and #/dr-ali (home, scrolled to that
// section), #/login/staff, #/login/patient, #/patient (portal), #/patient/demo
// (sample portal), #/staff/<page>. Hash routing keeps the site a set of static
// files. Search engines index only "/", so index.html carries the description,
// link-preview tags and clinic details; each view still gets its own title.
//
// The public pages render straight away and fill in their data when
// state.ready resolves. Login, portal and staff code load only when visited.
import { h, mount, toast, friendlyError, empty, modal, closeAllModals, clearMessages, extLink } from './ui/dom.js';
import { state } from './state.js';
import { CONFIG } from './config.js';
import * as content from './content.js';
import { renderHome, renderVisitor } from './views/public.js';

const SITE = CONFIG.CLINIC_NAME;
const descMeta = document.querySelector('meta[name="description"]');
const HOME_TITLE = document.title;
const HOME_DESC = descMeta?.getAttribute('content') || '';
const CLINICS_DESC = "Clinic locations, opening hours and Dr. Ali Rashid's days at each clinic in Karachi, Lahore and Islamabad.";

const STAFF_TITLES = {
  today: 'Today', sheet: 'Aaj ki List', queue: 'Queue board', patients: 'Patients', patient: 'Patient record',
  billing: 'Billing', accounts: 'Accounts', reports: 'Reports', coordinator: 'Coordinator', stock: 'Stock',
  complaints: 'Complaints', review: "Dr. Ali's list", log: 'Doctor log', admin: 'Admin',
};

let routeGen = 0;
let firstRoute = true;
let signingOut = false;
// Where to go after logging in, when a login was needed on the way: { hash }, or after a logout
// { hash, staffId }, which only that same person is taken back to (see onSignedIn).
let returnTo = null;
let onLoginPage = false;

function setMeta(title, description = HOME_DESC) {
  document.title = title;
  descMeta?.setAttribute('content', description);
}

// Each route renders into a fresh #app. A slower, older route can only ever
// fill its own detached container, never the page the person moved on to.
function newView() {
  const view = h('div', { id: 'app' });
  document.getElementById('app').replaceWith(view);
  return view;
}

// Moves focus to the new view's heading so keyboard and screen-reader users
// hear where they are, unless they have already moved on inside it.
function focusHeading(view, el = view.querySelector('h1')) {
  if (!el) return false;
  const active = document.activeElement;
  if (active && active !== document.body && active !== document.documentElement) return false;
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
  return true;
}

// Public views mount their static part before their first await, so the
// heading usually exists at once; otherwise it is focused when the render ends
// (and a view that ended up with no h1 at all gets its main region focused instead).
async function show(gen, view, first, render, section) {
  const pending = render();
  if (!first && !section) focusHeading(view);
  await pending;
  if (gen !== routeGen) return;
  if (section) {
    const target = view.querySelector(`#${section}`);
    if (target) {
      target.scrollIntoView({ block: 'start' });
      focusHeading(view, target.querySelector('h2, h3') || target);
    }
  } else if (!first) {
    focusHeading(view, view.querySelector('h1') || view.querySelector('main'));
  }
}

const go = (hash) => location.replace(hash); // a redirect, not a new history entry

async function route() {
  const gen = ++routeGen;
  const first = firstRoute;
  firstRoute = false;
  closeAllModals();
  const hash = location.hash.replace(/^#\/?/, '') || '';
  const [pathPart, query = ''] = hash.split('?');
  const params = new URLSearchParams(query);
  const parts = pathPart.split('/').filter(Boolean);
  const current = () => gen === routeGen;
  // Leaving the login page without signing in forgets where the person was heading.
  if (onLoginPage && parts[0] !== 'login') returnTo = null;
  onLoginPage = parts[0] === 'login';

  const view = newView();
  window.scrollTo(0, 0);
  // Only if loading takes a moment: a quick render never flashes this.
  const slow = setTimeout(() => { if (current() && !view.childNodes.length) mount(view, h('div', { class: 'empty route-loading' }, 'Loading…')); }, 300);

  try {
    if (parts[0] === 'visitor') {
      setMeta(`Braces and treatments | ${SITE}`, "Braces options, what happens at each visit and other dental treatments at Dr. Ali Rashid's Dental Clinic in Karachi, Lahore and Islamabad.");
      return await show(gen, view, first, () => renderVisitor(view));
    }
    if (parts[0] === 'clinics') {
      setMeta(`Our clinics | ${SITE}`, CLINICS_DESC);
      return await show(gen, view, first, () => renderHome(view), 'branches');
    }
    if (parts[0] === 'dr-ali') {
      setMeta(`Dr. Ali's days at each clinic | ${SITE}`, CLINICS_DESC);
      return await show(gen, view, first, () => renderHome(view), 'dr-ali');
    }

    if (parts[0] === 'login') {
      const who = parts[1] === 'patient' ? 'patient' : 'staff';
      setMeta(who === 'patient' ? `Patient login | ${SITE}` : `Staff login | ${SITE}`,
        who === 'patient' ? 'Log in to your patient account to see your visits, invoices and dues, progress photos and X-rays.' : HOME_DESC);
      await state.ready;
      if (!current() || unavailable(view)) return;
      const s = signingOut ? null : state.session;
      if (s?.kind === 'staff' && who === 'staff') return go('#/staff/today');
      if (s?.kind === 'patient' && who === 'patient') return go('#/patient');
      const { renderLogin } = await import('./views/login.js');
      if (!current()) return;
      return await show(gen, view, first, () => renderLogin(view, who, onSignedIn));
    }

    if (parts[0] === 'patient') {
      if (parts[1] === 'demo') {
        setMeta(`Sample patient account | ${SITE}`, 'A sample patient account with made-up details, so you can see what you get before your first visit.');
        await state.ready; // branch names; the sample itself needs no connection
        if (!current()) return;
        const { renderPortalDemo } = await import('./views/portal.js');
        if (!current()) return;
        return await show(gen, view, first, () => renderPortalDemo(view));
      }
      setMeta(`Your patient account | ${SITE}`);
      await state.ready;
      if (!current() || unavailable(view)) return;
      if ((signingOut ? null : state.session)?.kind !== 'patient') { returnTo = { hash: location.hash }; return go('#/login/patient'); }
      const { renderPortal } = await import('./views/portal.js');
      if (!current()) return;
      return await show(gen, view, first, () => renderPortal(view, signOut));
    }

    if (parts[0] === 'staff') {
      // Fixed page names only: a patient's name in the title would end up in the browser history of a shared computer.
      setMeta(`${STAFF_TITLES[parts[1] || 'today'] || 'Clinic system'} | Clinic system`);
      await state.ready;
      if (!current() || unavailable(view)) return;
      if ((signingOut ? null : state.session)?.kind !== 'staff') { returnTo = { hash: location.hash }; return go('#/login/staff'); }
      const { renderStaff } = await import('./views/staff/shell.js');
      if (!current()) return;
      await show(gen, view, first, () => renderStaff(view, parts.slice(1).join('/') || 'today', params, signOut));
      // The staff lists are loaded now, including the idle limit: count down from the new limit straight away.
      if (current() && !warning && idleApplies()) scheduleIdle();
      return;
    }

    setMeta(HOME_TITLE);
    return await show(gen, view, first, () => renderHome(view));
  } catch (e) {
    console.error(e);
    if (!current()) return;
    mount(view, parts[0] === 'staff'
      ? h('main', { class: 'public-main' }, h('h1', {}, 'This page could not load'), empty(friendlyError(e), retryButton()))
      : visitorFallback('Sorry, this page could not load', 'Please try again in a moment. You can always reach the clinic directly:'));
    focusHeading(view);
  } finally {
    clearTimeout(slow);
    if (current()) view.querySelector(':scope > .route-loading')?.remove();
  }
}

// ---------------------------------------------------------------- fallbacks
const retryButton = () => h('button', { type: 'button', class: 'btn btn-primary', onclick: () => location.reload() }, 'Try again');

// Visitor-safe: no database wording, and a phone and WhatsApp that work without the clinic system.
function visitorFallback(title, text) {
  return h('main', { class: 'public-main public-fallback' },
    h('h1', {}, title),
    h('p', {}, text),
    contactLinks(),
    h('p', { class: 'inline' }, retryButton(), h('a', { class: 'btn', href: '#/' }, 'Go to the homepage')));
}

function contactLinks() {
  const c = content.CONTACT || {};
  const digits = (v) => String(v || '').replace(/\D/g, '');
  const intl = (v) => { const d = digits(v); return d.startsWith('0') ? '92' + d.slice(1) : d; };
  const shown = (v) => { const d = intl(v); return d.startsWith('92') && d.length === 12 ? `0${d.slice(2, 5)} ${d.slice(5)}` : String(v); };
  const links = [];
  if (digits(c.phone).length >= 7) links.push(h('a', { class: 'btn', href: `tel:+${intl(c.phone)}` }, `Call ${shown(c.phone)}`));
  if (digits(c.whatsapp).length >= 7) links.push(extLink(`https://wa.me/${intl(c.whatsapp)}`, 'Message us on WhatsApp', { class: 'btn' }));
  const facebook = content.HOME?.social?.find((s) => /facebook/i.test(s.name));
  if (!links.length && facebook) links.push(extLink(facebook.url, 'Message us on Facebook', { class: 'btn' }));
  return links.length ? h('p', { class: 'inline' }, links) : null;
}

// Login, portal and staff screens need the clinic system. If it could not load, say so plainly.
function unavailable(view) {
  if (!state.dataError) return false;
  mount(view, visitorFallback('The clinic system is not available right now',
    'We could not connect to the clinic system. Please try again in a few minutes. To book or ask a question, contact the clinic directly:'));
  focusHeading(view);
  return true;
}

// ---------------------------------------------------------------- login and logout
function onSignedIn() {
  const kind = state.session?.kind;
  const area = kind === 'staff' ? '#/staff' : '#/patient';
  // A page saved at an idle logout belongs to the person who was working on it: on a shared computer the
  // next login must not land on someone else's patient record. A page the person asked for before logging in is theirs.
  const mine = !returnTo?.staffId || returnTo.staffId === state.session?.staff?.id;
  const back = mine && returnTo?.hash.startsWith(area) ? returnTo.hash : null;
  returnTo = null;
  startIdle();
  location.hash = back || (kind === 'staff' ? '#/staff/today' : '#/patient');
}

// What the logout toast says about Aaj ki List edits still on this computer. autosave.clearForUser resolves to
// { pending, failed }: pending edits are sent by themselves the next time that person opens the list (if within a
// day), failed ones wait for Try again or Discard. (An older autosave.js resolved to one number for both.)
function waitingMessage(left) {
  const changes = (n) => `${n} change${n === 1 ? '' : 's'} on the Aaj ki List`;
  const it = (n) => (n === 1 ? 'it' : 'them');
  const listed = (n) => `${n === 1 ? 'It' : 'They'} will be listed at the top of the Aaj ki List the next time you log in here, where you can Try again or Discard ${it(n)}.`;
  if (typeof left === 'number') {
    return left > 0 ? `${changes(left)} ${left === 1 ? 'is' : 'are'} still on this computer. Recent ones are sent the next time you log in here and open the Aaj ki List; any that could not be saved are listed at the top, where you can Try again or Discard ${it(left)}.` : '';
  }
  const { pending = 0, failed = 0 } = left || {};
  const text = [];
  if (pending) text.push(`${changes(pending)} ${pending === 1 ? 'is' : 'are'} waiting on this computer. ${pending === 1 ? 'It' : 'They'} will be sent the next time you log in here and open the Aaj ki List, as long as that is within a day; after that ${pending === 1 ? 'it is' : 'they are'} listed at the top for you to check.`);
  if (failed) text.push(`${changes(failed)} could not be saved. ${listed(failed)}`);
  return text.join(' ');
}

// { remote: true }: the login already ended in another tab, so there is nothing to send or to end here.
// { local: true }: end only this computer's login (the data layer keeps other computers on a shared login signed in).
// { notice }: a message to show after logging out, along with the one about waiting Aaj ki List edits.
async function signOut({ remote = false, local = false, notice = '' } = {}) {
  if (signingOut) return;
  signingOut = true;
  stopIdle();
  closeAllModals();
  clearMessages(); // toasts and announcements can name patients
  // Take patient details off the screen straight away; the rest can take a moment.
  routeGen++;
  mount(newView(), h('div', { class: 'empty' }, h('p', {}, 'Logging out…')));
  let left = null;
  try {
    // Send any Aaj ki List edits still waiting, then stop the queue so nothing goes out under the next login.
    // Not for a remote logout: the login in this tab is gone, and edits would go out under whoever signed in elsewhere.
    const autosave = await import('./lib/autosave.js');
    left = await autosave.clearForUser?.({ flush: !remote, timeoutMs: 3000 });
  } catch (e) {
    console.error(e);
  }
  // The data layer answers false when the server never confirmed (hung or offline) and only this computer's
  // stored login was removed. (An adapter that answers nothing is taken as confirmed.)
  let confirmed = true;
  if (!remote) {
    try { confirmed = (await state.data?.signOut(local ? { scope: 'local' } : undefined)) !== false; } catch (e) { console.error(e); confirmed = false; }
  }
  state.session = null;
  clearMessages(); // anything that arrived while the edits were being sent
  const notices = [{ message: waitingMessage(left), ms: 12000 }, { message: notice, ms: 10000 }].filter((n) => n.message);
  // Offline there is nothing hung to clear, and a reload would only show the browser's "no internet" page.
  if (!confirmed && navigator.onLine !== false) return reloadAfterLogout(notices); // signingOut stays true: nothing else runs in this page
  signingOut = false;
  if (location.hash.replace(/^#\/?/, '')) location.hash = '#/';
  else route();
  for (const n of notices) toast(n.message, 'info', n.ms);
}

// A logout the server never confirmed (it hung) leaves the old auth client in memory: a refresh request that
// was already on its way could still save the login again, and the hung logout request could hold its lock
// against the next sign-in. A full page load drops all of that. The messages for the person, and where an
// idle logout should take them back to, wait in sessionStorage (this tab only) and are picked up on the new page.
const AFTER_RELOAD_KEY = 'after-logout';

function reloadAfterLogout(notices) {
  try { sessionStorage.setItem(AFTER_RELOAD_KEY, JSON.stringify({ notices, returnTo })); } catch { /* storage blocked: the messages are lost, the logout still stands */ }
  location.replace('/');
}

function showMessagesFromBeforeReload() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(AFTER_RELOAD_KEY) || 'null'); sessionStorage.removeItem(AFTER_RELOAD_KEY); } catch { return; }
  const back = saved?.returnTo; // only an idle logout's, which belongs to one person (staffId)
  if (typeof back?.hash === 'string' && back.hash.startsWith('#/staff') && back.staffId) returnTo = { hash: back.hash, staffId: back.staffId };
  for (const n of Array.isArray(saved?.notices) ? saved.notices : []) if (typeof n?.message === 'string') toast(n.message, 'info', Number(n.ms) || 10000);
}

// ---------------------------------------------------------------- idle logout
// Staff are logged out after a period of no activity (shared clinic computers).
// A warning comes a minute before, with a "Stay signed in" button. The limit
// is checked against the clock, so a computer that slept is not given extra time.
//
// All tabs of one browser share a single login, so activity is shared too (through localStorage):
// a tab left idle in the background never logs out the tab that is in use. Each tab warns, and
// logs out, only when every tab has been idle; "Stay signed in" in any tab keeps them all.
const WARN_MS = 60 * 1000;
const SHARED_KEY = 'staff-last-active';
let lastActive = Date.now();
let lastShared = 0;
let lastScheduled = 0;
let idleTimer = null;
let warning = null;

const idleApplies = () => !signingOut && state.session?.kind === 'staff' && state.data?.mode !== 'demo';
const idleLimitMs = () => (Number(state.ref.settings?.session_timeout_minutes) || 30) * 60 * 1000;

function sharedActive() {
  try { return Number(localStorage.getItem(SHARED_KEY)) || 0; } catch { return 0; }
}

function shareActivity(at) {
  if (at - lastShared < 1000) return;
  lastShared = at;
  try { localStorage.setItem(SHARED_KEY, String(at)); } catch { /* storage blocked or full: this tab then counts alone */ }
}

// How long nothing has happened in this tab or any other tab of this browser.
const idleFor = () => Date.now() - Math.max(lastActive, sharedActive());

function startIdle() {
  lastActive = Date.now();
  shareActivity(lastActive);
  scheduleIdle();
}

function stopIdle() {
  clearTimeout(idleTimer);
  idleTimer = null;
  const w = warning;
  warning = null;
  w?.close();
}

function scheduleIdle() {
  clearTimeout(idleTimer);
  idleTimer = null;
  if (!idleApplies()) return;
  lastScheduled = Date.now();
  const left = idleLimitMs() - idleFor();
  idleTimer = setTimeout(warnIdle, Math.max(left - WARN_MS, 0));
}

function onActivity(e) {
  if (!idleApplies()) return;
  if (e?.type === 'visibilitychange' && document.visibilityState !== 'visible') return;
  // Inside the warning, its own buttons decide (so "Log out now" is not taken as activity).
  if (warning && e?.target instanceof Node && warning.dialog.contains(e.target)) return;
  const now = Date.now();
  if (idleFor() >= idleLimitMs()) { idleSignOut(); return; } // the limit passed while the tab was hidden or the computer slept
  lastActive = now;
  shareActivity(now);
  if (warning) { const w = warning; warning = null; w.close(); }
  // Scrolling and typing fire constantly; rescheduling once a second is plenty.
  if (idleTimer && now - lastScheduled < 1000) return;
  scheduleIdle();
}

// Another tab of this browser had activity: whatever this tab was counting down is off.
window.addEventListener('storage', (e) => {
  if (e.key !== SHARED_KEY || !idleApplies()) return;
  if (warning) { const w = warning; warning = null; w.close(); }
  scheduleIdle();
});

function warnIdle() {
  if (!idleApplies()) return;
  const left = idleLimitMs() - idleFor();
  if (left <= 0) { idleSignOut(); return; }
  if (left > WARN_MS + 1000) { scheduleIdle(); return; } // there was activity since this was set (here or in another tab)
  const seconds = h('span', { class: 'idle-countdown' }, String(Math.round(left / 1000)));
  const tick = setInterval(() => { seconds.textContent = String(Math.max(0, Math.round((idleLimitMs() - idleFor()) / 1000))); }, 1000);
  const w = modal('Are you still there?',
    h('div', { class: 'idle-warning' },
      h('p', {}, 'Nothing has happened on this screen for a while. To keep patient details private, you will be logged out in ', seconds, ' seconds.'),
      h('p', {}, 'Choose “Stay signed in” to keep working.')),
    [{ label: 'Log out now', onClick: () => signOut() }, { label: 'Stay signed in', primary: true }],
    { alert: true, onClose: () => { clearInterval(tick); if (warning === w) { warning = null; onActivity(); } } });
  warning = w;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(idleSignOut, left);
}

async function idleSignOut() {
  if (!idleApplies()) return;
  const minutes = Math.max(1, Math.round(idleLimitMs() / 60000));
  if (location.hash.startsWith('#/staff')) returnTo = { hash: location.hash, staffId: state.session?.staff?.id };
  // Only this computer's login ends: the same shared login may be in use on another computer.
  await signOut({ local: true, notice: `You were logged out because there was no activity for ${minutes} minute${minutes === 1 ? '' : 's'}.` });
}

// The login ended in another tab (logged out there, or the session expired): leave the same way
// signOut() does, instead of leaving patient details on screen under a login that no longer exists.
async function endedElsewhere() {
  const staffId = state.session?.staff?.id;
  if (staffId && location.hash.startsWith('#/staff')) returnTo = { hash: location.hash, staffId };
  await signOut({ remote: true, notice: 'You were logged out. Your login ended in another tab or window, or it expired. Please log in again.' });
}

// 'app:activity' is sent by long jobs (an import running for an hour) so they are not cut off mid-way.
['pointerdown', 'click', 'keydown', 'touchstart', 'input', 'scroll', 'wheel', 'visibilitychange', 'app:activity']
  .forEach((ev) => document.addEventListener(ev, onActivity, { passive: true, capture: true }));

// ---------------------------------------------------------------- start
// "Skip to content" (index.html) must not change the hash: that would be a route change.
document.getElementById('skip-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  const app = document.getElementById('app');
  const target = app?.querySelector('h1') || app?.querySelector('main');
  if (!target) return;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus();
});

// Safety net: a failure no handler caught (an inline save without its own try/catch) still tells the
// person, instead of a button that seems to do nothing. Visitors and patients never see database wording.
window.addEventListener('unhandledrejection', (e) => {
  e.preventDefault(); // logged below instead of by the browser
  console.error(e.reason);
  if (e.reason?.name === 'AbortError') return; // a request that was cancelled on purpose
  toast(friendlyError(e.reason, { audience: state.session?.kind === 'staff' ? 'staff' : 'public' }), 'error');
});

showMessagesFromBeforeReload();
window.addEventListener('hashchange', route);
route();

state.ready.then(() => {
  if (!state.data) return;
  const personOf = (s) => s?.staff?.id || s?.patient?.id || null;
  state.data.onAuthChange?.(async () => {
    let s;
    try { s = await state.data.getSession(); } catch (e) { console.error(e); return; } // a hiccup (offline?) is not a logout
    if (signingOut) return;
    const was = state.session;
    // The login this tab was using is gone, or another person signed in from another tab.
    if (was && personOf(s) !== personOf(was)) { endedElsewhere(); return; }
    state.session = s;
    if (!idleApplies()) stopIdle();
    else if (!idleTimer && !warning) scheduleIdle();
  });
  if (idleApplies()) startIdle();
});
