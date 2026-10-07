// Router: #/ (home), #/visitor, #/clinics and #/dr-ali (home, scrolled to that
// section), #/login/staff, #/login/patient, #/patient (portal), #/patient/demo
// (sample portal), #/staff/<page>. Hash routing keeps the site a set of static
// files. Search engines index only "/", so index.html carries the description,
// link-preview tags and clinic details; each view still gets its own title.
//
// The public pages render straight away and fill in their data when
// state.ready resolves. Login, portal and staff code load only when visited.
import { h, mount, toast, friendlyError, empty, modal, closeAllModals, extLink } from './ui/dom.js';
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
let returnTo = null; // where to go after logging in, when a login was needed on the way

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
// heading usually exists at once; otherwise it is focused when the render ends.
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
    focusHeading(view);
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
      if ((signingOut ? null : state.session)?.kind !== 'patient') { returnTo = location.hash; return go('#/login/patient'); }
      const { renderPortal } = await import('./views/portal.js');
      if (!current()) return;
      return await show(gen, view, first, () => renderPortal(view, signOut));
    }

    if (parts[0] === 'staff') {
      // Fixed page names only: a patient's name in the title would end up in the browser history of a shared computer.
      setMeta(`${STAFF_TITLES[parts[1] || 'today'] || 'Clinic system'} | Clinic system`);
      await state.ready;
      if (!current() || unavailable(view)) return;
      if ((signingOut ? null : state.session)?.kind !== 'staff') { returnTo = location.hash; return go('#/login/staff'); }
      const { renderStaff } = await import('./views/staff/shell.js');
      if (!current()) return;
      return await show(gen, view, first, () => renderStaff(view, parts.slice(1).join('/') || 'today', params, signOut));
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
  const back = returnTo?.startsWith(area) ? returnTo : null;
  returnTo = null;
  startIdle();
  location.hash = back || (kind === 'staff' ? '#/staff/today' : '#/patient');
}

async function signOut() {
  if (signingOut) return;
  signingOut = true;
  stopIdle();
  closeAllModals();
  // Take patient details off the screen straight away; the rest can take a moment.
  routeGen++;
  mount(newView(), h('div', { class: 'empty' }, h('p', {}, 'Logging out…')));
  let waiting = 0;
  try {
    // Send any Aaj ki List edits still waiting, then stop the queue so nothing goes out under the next login.
    const autosave = await import('./lib/autosave.js');
    waiting = (await autosave.clearForUser?.({ flush: true, timeoutMs: 3000 })) || 0;
  } catch (e) {
    console.error(e);
  }
  try { await state.data?.signOut(); } catch (e) { console.error(e); }
  state.session = null;
  signingOut = false;
  if (location.hash.replace(/^#\/?/, '')) location.hash = '#/';
  else route();
  if (waiting) {
    toast(`${waiting} change${waiting === 1 ? '' : 's'} on the Aaj ki List could not be sent yet. ${waiting === 1 ? 'It stays' : 'They stay'} on this computer and will be sent the next time you log in here and open the Aaj ki List.`, 'info', 10000);
  }
}

// ---------------------------------------------------------------- idle logout
// Staff are logged out after a period of no activity (shared clinic computers).
// A warning comes a minute before, with a "Stay signed in" button. The limit
// is checked against the clock, so a computer that slept is not given extra time.
const WARN_MS = 60 * 1000;
let lastActive = Date.now();
let lastScheduled = 0;
let idleTimer = null;
let warning = null;

const idleApplies = () => !signingOut && state.session?.kind === 'staff' && state.data?.mode !== 'demo';
const idleLimitMs = () => (Number(state.ref.settings?.session_timeout_minutes) || 30) * 60 * 1000;

function startIdle() {
  lastActive = Date.now();
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
  const left = idleLimitMs() - (Date.now() - lastActive);
  idleTimer = setTimeout(warnIdle, Math.max(left - WARN_MS, 0));
}

function onActivity(e) {
  if (!idleApplies()) return;
  if (e?.type === 'visibilitychange' && document.visibilityState !== 'visible') return;
  // Inside the warning, its own buttons decide (so "Log out now" is not taken as activity).
  if (warning && e?.target instanceof Node && warning.dialog.contains(e.target)) return;
  const now = Date.now();
  if (now - lastActive >= idleLimitMs()) { idleSignOut(); return; } // the limit passed while the tab was hidden or the computer slept
  lastActive = now;
  if (warning) { const w = warning; warning = null; w.close(); }
  // Scrolling and typing fire constantly; rescheduling once a second is plenty.
  if (idleTimer && now - lastScheduled < 1000) return;
  scheduleIdle();
}

function warnIdle() {
  if (!idleApplies()) return;
  const left = idleLimitMs() - (Date.now() - lastActive);
  if (left <= 0) { idleSignOut(); return; }
  if (left > WARN_MS + 1000) { scheduleIdle(); return; } // there was activity since this was set
  const seconds = h('span', {}, String(Math.round(left / 1000)));
  const tick = setInterval(() => { seconds.textContent = String(Math.max(0, Math.round((idleLimitMs() - (Date.now() - lastActive)) / 1000))); }, 1000);
  const w = modal('Are you still there?',
    [h('p', {}, 'Nothing has happened on this screen for a while. To keep patient details private, you will be logged out in ', seconds, ' seconds.'),
      h('p', {}, 'Choose “Stay signed in” to keep working.')],
    [{ label: 'Log out now', onClick: () => signOut() }, { label: 'Stay signed in', primary: true }],
    { alert: true, onClose: () => { clearInterval(tick); if (warning === w) { warning = null; onActivity(); } } });
  warning = w;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(idleSignOut, left);
}

async function idleSignOut() {
  if (!idleApplies()) return;
  const minutes = Math.max(1, Math.round(idleLimitMs() / 60000));
  if (location.hash.startsWith('#/staff')) returnTo = location.hash;
  await signOut();
  toast(`You were logged out because there was no activity for ${minutes} minutes.`, 'info', 10000);
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

window.addEventListener('hashchange', route);
route();

state.ready.then(() => {
  if (!state.data) return;
  state.data.onAuthChange?.(async () => {
    const s = await state.data.getSession().catch(() => null);
    if (signingOut) return;
    state.session = s;
    if (!idleApplies()) stopIdle();
    else if (!idleTimer && !warning) scheduleIdle();
  });
  if (idleApplies()) startIdle();
});
