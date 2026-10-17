// Staff area: a top menu bar (Today · Aaj ki List ▾ · Patients · Billing · Reports ▾ · Coordinator ▾ · More ▾),
// a patient search box that finds by name, Mr# or phone from any screen, the signed-in person's menu,
// and page routing. Below 73.75em (1180px at the default text size: phones, tablets, small laptops and
// larger text settings) the same menu opens as a side drawer.
// A shared login (several people at one branch's desk) first asks the person's name (desk-name.js).
// Each page's module is loaded the first time it is opened, so the heavy ones (reports, admin with
// its importers) are only downloaded by the people who use them.
import { h, mount, toast, friendlyError, empty, rupees, srOnly, announce, unsavedWork } from '../../ui/dom.js';
import { state, can, isAdmin, loadStaffRef, branchName } from '../../state.js';
import { ROLE_LABELS } from '../../lib/permissions.js';
import { combobox } from './common.js';
import { askDeskName, changeDeskName, endDeskName, needsDeskName, syncDeskName } from './desk-name.js';
import { deskNameFor, deskLabel, dropStaleDeskName, touchDeskName, deskNameFromOtherTab, deskNameMaxAgeMs, deskNameUnused, deskNameExpiresIn, idleLogoutOn } from '../../lib/desk-name.js';
import { arrangeNav, loadArrangement, openArrangeMenu } from './nav-arrange.js';

const lazy = (load, name) => (...args) => load().then((m) => m[name](...args));
const passwordDialogModule = () => import('../../ui/password-dialog.js');
const openChangePassword = lazy(passwordDialogModule, 'openChangePassword');
// Fetched as soon as the account menu or the phone drawer is opened, so the first click on "Change password" is not a silent wait
// (offline it is left alone: a failed module load is remembered by the browser, and the click itself then reports the problem).
const warmPasswordDialog = () => { if (navigator.onLine) passwordDialogModule().catch(() => {}); };
// What the top search box is carried over to the Checkups page as: the digits of a phone number (4 or more), otherwise the text as typed.
const checkupQuery = (t) => { const text = String(t || '').trim(); const digits = text.replace(/\D/g, ''); return /^[\d\s+()-]+$/.test(text) && digits.length >= 4 ? digits : text; };
const pagesModule = () => import('./pages.js');
const patientsModule = () => import('./patients.js');
const renderPatient = lazy(patientsModule, 'renderPatient');
const renderPortalPreview = lazy(() => import('../portal.js'), 'renderPortalPreview');
const openCreate = lazy(() => import('./create-menu.js'), 'openCreate');

const PAGES = {
  today: { render: lazy(pagesModule, 'renderDashboard'), show: () => true },
  sheet: { render: lazy(() => import('./sheet.js'), 'renderSheet'), show: () => can('sheet.view') },
  'day-history': { render: lazy(() => import('./day-history.js'), 'renderDayHistory'), show: () => can('sheet.view') },
  queue: { render: lazy(pagesModule, 'renderQueue'), show: () => can('sheet.view') },
  checkups: { render: lazy(() => import('./checkups.js'), 'renderCheckups'), show: () => can('sheet.view') },
  patients: { render: lazy(patientsModule, 'renderPatients'), show: () => can('patients.view') },
  // The Photo inbox (owner, 17 Oct 2026: assistants, the coordinator and Dr. Ali upload the day's photos; 20261017000200_photo_intake.sql)
  // and the Photo library (every patient's edited photos, for whoever opens patient profiles).
  'photo-inbox': { render: lazy(() => import('./photo-inbox.js'), 'renderPhotoInbox'), show: () => can('photos.intake') && can('photos.view_raw') },
  'photo-library': { render: lazy(() => import('./photo-library.js'), 'renderPhotoLibrary'), show: () => can('patients.view') },
  billing: { render: lazy(pagesModule, 'renderBilling'), show: () => can('billing.view') || can('discount.approve') },
  accounts: { render: lazy(() => import('./accounts.js'), 'renderAccounts'), show: () => can('finance.view') || can('cash.close') || can('cash.verify') },
  reports: { render: lazy(() => import('./reports.js'), 'renderReports'), show: () => can('finance.view') || can('billing.view') || can('patients.view') || can('sheet.view') },
  coordinator: { render: lazy(() => import('./coordinator.js'), 'renderCoordinator'), show: () => can('reminders.manage') || can('lab.manage') || can('retainers.manage') },
  // Laid out like the clinic's Google Sheets; anyone who may open patient files reads them, the manage rights change them.
  retainers: { render: lazy(() => import('./retainers.js'), 'renderRetainers'), show: () => can('retainers.manage') || can('patients.view') },
  lab: { render: lazy(() => import('./lab.js'), 'renderLab'), show: () => can('lab.manage') || can('patients.view') },
  stock: { render: lazy(() => import('./inventory.js'), 'renderInventory'), show: () => can('inventory.manage') },
  complaints: { render: lazy(pagesModule, 'renderComplaints'), show: () => can('complaints.view') },
  jobs: { render: lazy(() => import('./jobs.js'), 'renderJobs'), show: () => can('jobs.view') },
  review: { render: lazy(pagesModule, 'renderReview'), show: () => isAdmin() || can('complaints.view') || can('flags.clear') },
  log: { render: lazy(pagesModule, 'renderDoctorLog'), show: () => state.session.staff.role === 'doctor' || can('doctor_log.view_all') },
  admin: { render: lazy(() => import('./admin.js'), 'renderAdmin'), show: () => can('users.manage') || can('export.data') || can('audit.view') || can('schedule.manage') || isAdmin() },
};

// Menu bar. An entry is a link ({ label, href }) or a dropdown ({ label, items }); items may carry their own show().
function menu() {
  const show = (key) => PAGES[key].show();
  const link = (label, path, key = path.split('?')[0]) => ({ label, href: `#/staff/${path}`, key, show: () => show(key) });
  const M = [
    link('Today', 'today'),
    { label: 'Aaj ki List', key: 'sheet', show: () => show('sheet'), items: [link('Aaj ki List', 'sheet'), link('History of Aaj ki List', 'day-history'), link('Queue board', 'queue'), link('Checkups', 'checkups')] },
    link('Patients', 'patients'),
    { label: 'Photos', key: 'photos', show: () => show('photo-inbox') || show('photo-library'), items: [link('Photo inbox', 'photo-inbox'), link('Photo library', 'photo-library')] },
    link('Billing', 'billing'),
    { label: 'Reports', key: 'reports', show: () => show('reports') || show('accounts'), items: [
      { ...link('Financial', 'reports?group=financial'), show: () => can('finance.view') },
      { ...link('Patients', 'reports?group=patients'), show: () => can('patients.view') },
      { ...link('OPD', 'reports?group=opd'), show: () => can('sheet.view') },
      { ...link('Inventory', 'reports?group=inventory'), show: () => can('inventory.manage') },
      { ...link('Accounts', 'reports?group=accounts'), show: () => can('finance.view') || can('cash.verify') },
      { ...link('HR', 'reports?group=hr'), show: () => can('doctor_log.view_all') || isAdmin() },
      { divider: true, show: () => show('accounts') },
      { ...link('Branch income vs expenses', 'accounts?tab=pnl'), show: () => can('finance.view') },
      { ...link('Expenses', 'accounts?tab=expenses'), show: () => can('finance.view') },
      { ...link('Cash closing', 'accounts?tab=cash'), show: () => can('cash.close') || can('cash.verify') },
    ] },
    { label: 'Coordinator', key: 'coordinator', show: () => show('coordinator') || show('retainers') || show('lab'), items: [
      { ...link('Reminders', 'coordinator?tab=reminders'), show: () => can('reminders.manage') },
      { ...link('Drop-offs', 'coordinator?tab=dropoffs'), show: () => can('reminders.manage') },
      link('Lab work', 'lab'),
      link('Retainer Record', 'retainers'),
      { ...link('Low ratings', 'coordinator?tab=ratings'), show: () => can('reminders.manage') },
    ] },
    { label: 'More', key: 'more', show: () => true, items: [
      link('Stock', 'stock'), link('Complaints', 'complaints'), link('Job applications', 'jobs'), link("Dr. Ali's list", 'review'), link('Doctor log', 'log'),
      { divider: true, show: () => show('admin') },
      { ...link('Access list', 'admin?tab=access'), show: () => can('users.manage') },
      { ...link('Staff accounts', 'admin?tab=staff'), show: () => can('users.manage') },
      { ...link('Settings', 'admin?tab=settings'), show: () => isAdmin() },
      { ...link('Clinic setup', 'admin?tab=setup'), show: () => isAdmin() },
      { ...link("Dr. Ali's calendar", 'admin?tab=calendar'), show: () => can('schedule.manage') },
      { ...link('Download data', 'admin?tab=export'), show: () => can('export.data') },
      { ...link('Import (Healthwire, Aaj ki List, checkups, retainers)', 'admin?tab=import'), show: () => isAdmin() },
      { ...link('Duplicate patients', 'admin?tab=duplicates'), show: () => isAdmin() },
      { ...link('Audit log', 'admin?tab=audit'), show: () => can('audit.view') },
    ] },
  ];
  // Hide dropdowns with nothing to show; drop dividers at the edges.
  return M.filter((m) => m.show()).map((m) => {
    if (!m.items) return m;
    const items = m.items.filter((i) => i.show());
    while (items[0]?.divider) items.shift();
    while (items[items.length - 1]?.divider) items.pop();
    return items.length ? { ...m, items } : null;
  }).filter(Boolean);
}

// Mark the link for the page on screen with aria-current="page". Pages switch tabs with
// history.replaceState, so this reads the live URL each time a menu opens.
const parseHref = (href) => { const [path, query = ''] = String(href).replace(/^#\/?/, '').split('?'); return { path, params: new URLSearchParams(query) }; };
function markCurrent(container) {
  const here = parseHref(location.hash);
  const links = [...container.querySelectorAll('a[href]')];
  const target = (a) => parseHref(a.getAttribute('href'));
  let hits = links.filter((a) => { const t = target(a); return t.path === here.path && [...t.params].every(([k, v]) => here.params.get(k) === v); });
  // A section opened without its ?tab= (or ?group=) shows its first tab.
  if (!hits.length) hits = links.filter((a) => { const t = target(a); return t.path === here.path && [...t.params.keys()].every((k) => !here.params.has(k)); }).slice(0, 1);
  for (const a of links) {
    const on = hits.includes(a);
    a.classList.toggle('current', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

// The top bar needs room for the menu, the search box and the account menu, so below 73.75em the same
// menu is a drawer (the CSS uses the same breakpoint). It is in em, not px: a media query's em is the
// browser's default text size, so at 125% or 150% text the switch moves out to 1475px or 1770px and the
// bar never overflows. 73.75em is 1180px at the default size.
const hoverMenus = matchMedia('(hover: hover) and (min-width: 73.75em)');
const wideScreen = matchMedia('(min-width: 73.75em)');
let refSession = null; // the session the clinician, treatment and settings lists were loaded for
// The Photo inbox's "Which patient?" count shown on the menu (see inboxBadge in renderStaff). Kept between pages, so a menu drawn again
// (Arrange my menu, a narrower window) shows it at once; the Photo inbox page sends a fresh count after each change.
let inboxCount = 0;
function paintInboxBadge(el) {
  el.hidden = !inboxCount;
  el.replaceChildren(...(inboxCount ? [h('span', { 'aria-hidden': 'true' }, String(inboxCount)),
    srOnly(` ${inboxCount} photo set${inboxCount === 1 ? '' : 's'} ${inboxCount === 1 ? 'waits' : 'wait'} for Which patient?`)] : []));
}
function setInboxCount(n) {
  inboxCount = Number(n) || 0;
  document.querySelectorAll('.photo-inbox-count').forEach(paintInboxBadge);
}
window.addEventListener('photo-inbox-count', (e) => setInboxCount(e.detail));
let renderCtl = null;
// Another tab of this browser took a new name for the same shared login (the next person at this computer chose "Change name"
// there): this tab stops the old name too, and asks. deskTab is the shared login of the page on screen, with its "Change name".
let deskTab = null;
window.addEventListener('storage', (e) => {
  const s = state.session?.staff;
  if (deskTab && s?.shared_login && s.id === deskTab.staffId && deskNameFromOtherTab(e, s.id)) deskTab.change();
});

export async function renderStaff(root, path, params, signOut) {
  // Listeners and page polling set up by a render stop at the next navigation.
  renderCtl?.abort();
  const ctl = new AbortController();
  renderCtl = ctl;
  const { signal } = ctl;
  const on = (target, type, fn) => target.addEventListener(type, fn, { signal });
  document.body.classList.remove('drawer-open');
  // Reload these lists for every new login (and token refresh), so a settings change reaches a
  // shared computer that is never reloaded; page changes within one session reuse them.
  const session = state.session;
  if (refSession !== session) { await Promise.all([loadStaffRef(), loadArrangement()]); refSession = session; }
  if (signal.aborted) return;
  const [section, id, sub] = path.split('/');
  const page = PAGES[section];
  const s = state.session.staff;
  const current = (key) => key === section || (section === 'patient' && key === 'patients') || (section === 'accounts' && key === 'reports') || (section === 'checkups' && key === 'sheet') || ((section === 'retainers' || section === 'lab') && key === 'coordinator') || (section === 'day-history' && key === 'sheet')
    || ((section === 'photo-inbox' || section === 'photo-library') && key === 'photos');
  // The "Which patient?" count (sets waiting, and filed sets Claude flagged) on the Photos drop-down, the Photo inbox link (top bar and
  // drawer) and More when they are arranged under it. Asked once per page (never blocking it); the Photo inbox page sends fresh counts.
  const showsInboxCount = can('photos.intake') && can('photos.view_raw') && !!state.data.photoInboxCounts;
  const inboxBadge = () => {
    const el = h('span', { class: 'badge badge-warn nav-count photo-inbox-count', hidden: !inboxCount });
    paintInboxBadge(el);
    return el;
  };
  const leadsToInbox = (m) => (m.href === '#/staff/photo-inbox') || (m.items || []).some((i) => leadsToInbox(i));
  const items = menu();

  // ---- dropdowns: the disclosure pattern (a button with aria-expanded over a plain list of links).
  // Click or Enter opens them (touch and keyboard); desktop CSS also opens them on hover.
  const setOpen = (wrap, open) => { wrap.classList.toggle('open', open); wrap.querySelector(':scope > button')?.setAttribute('aria-expanded', String(open)); };
  const closeAll = () => document.querySelectorAll('.menu.open').forEach((m) => setOpen(m, false));
  const disclosure = (wrap, btn, list) => {
    btn.addEventListener('click', () => { const open = !wrap.classList.contains('open'); closeAll(); if (open) markCurrent(list); setOpen(wrap, open); });
    wrap.addEventListener('mouseenter', () => { if (hoverMenus.matches) { markCurrent(list); btn.setAttribute('aria-expanded', 'true'); } });
    wrap.addEventListener('mouseleave', () => { if (hoverMenus.matches) btn.setAttribute('aria-expanded', String(wrap.classList.contains('open'))); });
    // Close once focus moves on to something outside the menu.
    wrap.addEventListener('focusout', (e) => { if (!wrap.contains(e.relatedTarget) && !(e.relatedTarget === null && wrap.matches(':hover'))) setOpen(wrap, false); });
    return wrap;
  };
  on(document, 'click', (e) => { if (!e.target.closest('.menu')) closeAll(); });
  on(document, 'keydown', (e) => {
    if (e.key !== 'Escape' || document.querySelector('.modal')) return;
    // A menu opened by hover has aria-expanded but not .open; Escape closes it as well (WCAG 1.4.13).
    const open = document.querySelector('.menu.open') || document.querySelector('.menu > button[aria-expanded="true"]')?.parentElement;
    if (open) {
      const inside = open.contains(document.activeElement);
      setOpen(open, false);
      if (inside) open.querySelector(':scope > button')?.focus();
      return;
    }
    if (drawer.classList.contains('open')) closeDrawer(true);
  });
  const dropdown = (m) => {
    const listId = `menu-list-${m.key}`;
    const btn = h('button', { type: 'button', class: ['nav-link', current(m.key) ? 'current' : ''], 'aria-expanded': 'false', 'aria-controls': listId },
      m.label, current(m.key) ? srOnly(' (current section)') : null, showsInboxCount && leadsToInbox(m) ? inboxBadge() : null, h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'));
    const item = (i) => (i.divider ? h('hr', {}) : h('a', { href: i.href, onclick: () => {
      // Choosing the page already on screen fires no hashchange, so give focus back to the menu button.
      const same = i.href === location.hash;
      closeAll();
      if (same) btn.focus();
    } }, i.label, showsInboxCount && i.href === '#/staff/photo-inbox' ? inboxBadge() : null));
    // A drop-down put under More with "Arrange my menu" is a section of it ({ heading, items }): one group named after it, with
    // all its pages and a line inside it (Reports: the reports, then the Accounts tabs) indented under its name.
    const section = (i, n) => h('div', { class: 'menu-section', role: 'group', 'aria-labelledby': `${listId}-${n}` },
      h('div', { class: 'menu-heading', id: `${listId}-${n}` }, i.heading), i.items.map(item));
    const list = h('div', { class: 'menu-list', id: listId }, m.items.map((i, n) => (i.heading ? section(i, n) : item(i))));
    markCurrent(list);
    return disclosure(h('div', { class: 'menu' }, btn, list), btn, list);
  };
  const navEntry = (m) => (m.items ? dropdown(m)
    : h('a', { class: ['nav-link', current(m.key) ? 'current' : ''], href: m.href, 'aria-current': current(m.key) ? 'page' : null }, m.label,
      showsInboxCount && m.href === '#/staff/photo-inbox' ? inboxBadge() : null));
  const topnav = h('nav', { class: 'topnav', 'aria-label': 'Staff navigation' }); // its entries: arrangeNav, below the drawer

  // ---- "Create ▾" beside the search (owner, 15 Oct 2026, as on Healthwire): a new patient, an invoice, a health record
  // (create-menu.js), each for whoever may make one; no menu for someone who may make none. It is not a page, so "Arrange my
  // menu" leaves it where it is, and it stays in the top bar on a phone (a "+" there).
  const createChoices = [
    can('patients.create') ? ['patient', 'Patient'] : null,
    can('billing.create') ? ['invoice', 'Invoice'] : null,
    can('treatment.enter') || can('patients.edit') ? ['health', 'Health record'] : null,
  ].filter(Boolean);
  const createMenu = createChoices.length ? (() => {
    const btn = h('button', { type: 'button', class: 'nav-link create-btn', 'aria-expanded': 'false', 'aria-controls': 'create-menu-list' },
      h('span', { class: 'create-plus', 'aria-hidden': 'true' }, '+'), h('span', { class: 'create-label' }, 'Create'), h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'));
    const list = h('div', { class: 'menu-list', id: 'create-menu-list' }, createChoices.map(([key, label]) => h('button', {
      type: 'button', class: 'menu-btn', 'aria-haspopup': 'dialog',
      // The menu closes and focus goes back to "Create" first, so the dialog gives focus back to something visible.
      onclick: () => { closeAll(); btn.focus(); openCreate(key).catch((e) => toast(friendlyError(e), 'error')); },
    }, label)));
    return disclosure(h('div', { class: 'menu create-menu' }, btn, list), btn, list);
  })() : null;

  // ---- patient search from any screen: name, Mr# or phone (an ARIA combobox).
  const searchBox = can('patients.view') ? (() => {
    const input = h('input', { type: 'search', placeholder: 'Search by name, Mr# or phone', 'aria-label': 'Search patients', autocomplete: 'off' });
    const results = h('div', { class: 'search-results', hidden: true });
    const wrap = h('div', { class: 'topsearch', role: 'search' },h('span', { class: 'search-icon', 'aria-hidden': 'true' }, '🔍'), input, results);
    combobox({
      wrap, input, popup: results, listLabel: 'Patients found', reopenOnFocus: true,
      search: async (t) => (await state.data.searchPatients(t)).slice(0, 8),
      option: (p) => h('a', { href: `#/staff/patient/${p.id}` },
        h('span', { class: 'mr' }, `Mr# ${p.mr_number}`), h('strong', { title: p.full_name }, p.full_name),
        h('span', { class: 'muted' }, [p.phone, branchName(p.first_branch_id)].filter(Boolean).join(' · ')),
        can('dues.view') && Number(p.dues) > 0 ? h('span', { class: 'badge badge-dues' }, h('span', { 'aria-hidden': 'true' }, '$$ '), srOnly('Dues '), rupees(p.dues)) : null),
      onPick: (p) => { input.value = ''; location.hash = `#/staff/patient/${p.id}`; },
      onEnter: (t) => { location.hash = `#/staff/patients?q=${encodeURIComponent(t)}`; },
      // A checkup patient has no Mr#, so this search cannot find them: say where they are before anyone makes a second record for them.
      note: (t, rows) => (rows.length ? null : h('div', { class: 'muted', style: { padding: '10px 12px' } }, 'No patient matches.',
        can('patients.create') ? h('a', { href: '#/staff/patients?new=1', style: { marginLeft: '8px' } }, 'Register a new patient') : null,
        can('sheet.view') ? h('div', { style: { marginTop: '6px' } }, 'Checkup patients have no Mr#. ', h('a', { href: `#/staff/checkups?q=${encodeURIComponent(checkupQuery(t))}` }, 'Look on the Checkups page')) : null)),
      count: (rows) => (rows.length ? `${rows.length} patient${rows.length === 1 ? '' : 's'} found. Use the up and down arrows to choose, then Enter to open.` : `No patient matches.${can('sheet.view') ? ' Checkup patients have no Mr#: the list has a link to the Checkups page.' : ''}`),
    });
    return wrap;
  })() : null;

  // A shared login shows the name of the person at the desk with it ("Front desk Islamabad · Ayesha"); "Change name" is for the next person.
  // A name kept from before this page (a reload, or a tab the browser restored after a power cut) holds only if it was used within
  // the idle logout time, or within 12 hours when there is no idle logout (Admin -> Settings: 0 is never; a missing setting is the
  // same); while the person works, that time is kept fresh.
  const idleMinutes = state.ref.settings?.session_timeout_minutes;
  const deskMaxAge = deskNameMaxAgeMs(idleMinutes);
  // With no idle logout nothing else ends a name in a page that stays open: this page watches for 12 hours without use.
  const watchDesk = s.shared_login && !idleLogoutOn(idleMinutes);
  if (s.shared_login) {
    dropStaleDeskName(s.id, deskMaxAge);
    // A page opened with no click or key after such a gap (the browser's Back button): that name stops before the page is drawn.
    if (watchDesk && deskNameUnused(s.id, deskMaxAge) && !(await endDeskName(s))) return;
    if (signal.aborted) return;
    for (const type of ['pointerdown', 'keydown']) on(document, type, () => touchDeskName());
  }
  syncDeskName(s);
  let rewatchDesk = () => {};
  const nameLabels = [];
  // (the name in <bdi>, so an Urdu name and the login around it each keep their own direction; in the top bar a long login is cut
  // short, not the person's name: app.css)
  const labelParts = (desk) => [h('span', { class: 'desk-login' }, s.full_name), desk ? [h('span', { class: 'desk-sep' }, ' · '), h('bdi', { class: 'desk-who' }, desk)] : null];
  const nameLabel = (props) => { const el = h('span', props, labelParts(deskNameFor(s.id))); nameLabels.push(el); return el; };
  const showDeskName = (desk) => {
    for (const el of nameLabels) mount(el, labelParts(desk));
    userBtn.setAttribute('aria-label', `Account menu, ${deskLabel(s.full_name, desk)}`);
    rewatchDesk();
  };
  // Resolves true once a name is given, false when the popup closed without one (the person moved on, or logged out).
  const askName = () => new Promise((resolve) => askDeskName({ staff: s, signOut, onName: (desk) => { showDeskName(desk); resolve(true); }, onGone: () => resolve(false) }));
  // Once the new person has given their name the page is drawn again for them (its greeting; the offline typing kept under their
  // name), unless a dialog under the popup holds unsaved work (only possible when another tab changed the name): it is left alone.
  const changeName = () => changeDeskName({ staff: s, signOut, onName: (desk) => {
    showDeskName(desk);
    if (desk) setTimeout(() => { if (!unsavedWork()) window.dispatchEvent(new HashChangeEvent('hashchange')); }, 0);
  } });
  deskTab = s.shared_login ? { staffId: s.id, change: changeName } : null;
  // No idle logout (see watchDesk): 12 hours after the name was last used (the evening's name on a computer left on overnight) the
  // popup asks again, as "Change name" does. The first click or key after a computer slept through that time opens it too, and is
  // not used under the old name; so does coming back to the tab.
  if (watchDesk) {
    let timer = null;
    const expire = () => { clearTimeout(timer); timer = null; changeName(); };
    rewatchDesk = () => {
      clearTimeout(timer);
      const left = deskNameExpiresIn(s.id, deskMaxAge);
      if (left === null || signal.aborted) return; // no name: the popup is asking (watched again once a name is given)
      timer = setTimeout(() => (deskNameUnused(s.id, deskMaxAge) ? expire() : rewatchDesk()), Math.min(left + 1000, 2 ** 31 - 1));
    };
    signal.addEventListener('abort', () => clearTimeout(timer));
    for (const type of ['pointerdown', 'keydown', 'click']) {
      window.addEventListener(type, (e) => {
        if (!deskNameUnused(s.id, deskMaxAge)) return;
        e.preventDefault();
        e.stopPropagation();
        expire();
      }, { signal, capture: true });
    }
    on(document, 'visibilitychange', () => { if (document.visibilityState === 'visible' && deskNameUnused(s.id, deskMaxAge)) expire(); });
    rewatchDesk();
  }
  const userBtn = h('button', { type: 'button', class: 'nav-link', 'aria-expanded': 'false', 'aria-controls': 'user-menu-list', 'aria-label': `Account menu, ${deskLabel(s.full_name, deskNameFor(s.id))}` },
    nameLabel({ class: ['user-name', s.shared_login ? 'has-desk-name' : ''] }), h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'));
  const userList = h('div', { class: 'menu-list', id: 'user-menu-list' },
    h('div', { class: 'menu-note' }, nameLabel({}), h('div', { class: 'muted' }, ROLE_LABELS[s.role])),
    h('hr', {}),
    s.shared_login ? h('button', { type: 'button', class: 'menu-btn', onclick: () => { closeAll(); userBtn.focus(); changeName(); } }, 'Change name') : null,
    // The public homepage, as visitors see it (owner, 12 Oct 2026); it has a "Back to staff pages" link while signed in (views/public.js).
    h('a', { href: '#/', onclick: () => closeAll() }, 'View the website'),
    // The menu closes and focus goes back to the account button first, so the dialog gives focus back to something visible.
    h('button', { type: 'button', class: 'menu-btn', onclick: () => { closeAll(); userBtn.focus(); openArrangeMenu(menu()); } }, 'Arrange my menu'),
    h('button', { type: 'button', class: 'menu-btn', onclick: () => { closeAll(); userBtn.focus(); openChangePassword({ who: 'staff', username: s.email }); } }, 'Change password'),
    h('button', { type: 'button', class: 'menu-btn', onclick: signOut }, 'Log out'));
  const userMenu = disclosure(h('div', { class: 'menu user-menu' }, userBtn, userList), userBtn, userList);
  userBtn.addEventListener('click', warmPasswordDialog, { once: true });
  userMenu.addEventListener('mouseenter', warmPasswordDialog, { once: true });

  // ---- narrow screens (below the drawer breakpoint above): the menu as a drawer (same items, dropdowns
  // expanded as groups). It closes on the scrim, on Escape, on its close button and on navigation, gives
  // focus back to ☰, and is inert (out of the tab order) while closed.
  const toggle = h('button', { type: 'button', class: 'icon-btn menu-toggle', 'aria-label': 'Menu', 'aria-expanded': 'false', 'aria-controls': 'staff-drawer' }, h('span', { 'aria-hidden': 'true' }, '☰'));
  const drawerLink = (i, cur = false) => h('a', { class: ['nav-link', cur ? 'current' : ''], href: i.href, 'aria-current': cur ? 'page' : null, onclick: () => closeDrawer(i.href === location.hash) }, i.label,
    showsInboxCount && i.href === '#/staff/photo-inbox' ? inboxBadge() : null);
  // A drop-down put under More with "Arrange my menu" is a section of it ({ heading, items }): a group of its own, named after
  // it, with all its pages (the drawer draws no lines inside a group). The pages after it are More's own, not that drop-down's,
  // to the eye (they are not indented under it) and to a screen reader.
  const drawerItems = (m) => m.items.filter((i) => !i.divider).map((i, n) => (i.heading
    ? h('div', { class: 'drawer-subgroup', role: 'group', 'aria-labelledby': `drawer-group-${m.key}-${n}` },
      h('div', { class: 'nav-group nav-subgroup', id: `drawer-group-${m.key}-${n}` }, i.heading), drawerItems(i))
    : drawerLink(i)));
  const drawerEntry = (m) => (m.items
    ? h('div', { class: 'drawer-group', role: 'group', 'aria-labelledby': `drawer-group-${m.key}` }, h('div', { class: 'nav-group', id: `drawer-group-${m.key}` }, m.label), drawerItems(m))
    : drawerLink(m, current(m.key)));
  const drawerLinks = h('div', { class: 'drawer-links' }); // its entries: arrangeNav, below
  const drawer = h('nav', { class: 'sidebar', id: 'staff-drawer', 'aria-label': 'Staff navigation' },
    h('button', { type: 'button', class: 'icon-btn drawer-close', 'aria-label': 'Close menu', onclick: () => closeDrawer(true) }, h('span', { 'aria-hidden': 'true' }, '×')),
    h('a', { href: '#/staff/today', class: 'wordmark', style: { textDecoration: 'none' }, onclick: () => closeDrawer(location.hash === '#/staff/today') }, "Dr. Ali Rashid's", h('small', {}, 'Clinic system')),
    drawerLinks,
    // Right after the menu it arranges, so the foot that stays on a phone's screen keeps its size ("Change name" too).
    h('button', { type: 'button', class: 'link-btn drawer-arrange', onclick: () => { closeDrawer(false); toggle.focus(); openArrangeMenu(menu()); } }, 'Arrange my menu'),
    s.shared_login ? h('button', { type: 'button', class: 'link-btn drawer-arrange', onclick: () => { closeDrawer(false); toggle.focus(); changeName(); } }, 'Change name') : null,
    h('div', { class: 'sidebar-foot' },
      h('div', {}, nameLabel({})), h('div', { style: { opacity: .7 } }, ROLE_LABELS[s.role]),
      // On its own line: Change password and Log out keep their row, well apart.
      h('a', { class: 'link-btn', href: '#/', onclick: () => closeDrawer(false) }, 'View the website'),
      h('div', { class: 'inline', style: { marginTop: '8px', columnGap: 'var(--space-6)' } },
        h('button', { type: 'button', class: 'link-btn', onclick: () => { closeDrawer(false); toggle.focus(); openChangePassword({ who: 'staff', username: s.email }); } }, 'Change password'),
        h('button', { type: 'button', class: 'link-btn', onclick: () => { closeDrawer(false); signOut(); } }, 'Log out'))));
  // The top bar and the drawer as this person arranged them ("Arrange my menu", nav-arrange.js): only what menu() allows them.
  arrangeNav(items, { topnav, navEntry, drawerLinks, drawerEntry, signal });
  drawer.querySelectorAll('.drawer-group').forEach(markCurrent);
  drawer.inert = true;
  const scrim = h('div', { class: 'drawer-scrim', hidden: true, 'aria-hidden': 'true', onclick: () => closeDrawer(true) });

  const topbar = h('header', { class: 'topbar' },
    toggle,
    h('a', { href: '#/staff/today', class: 'wordmark', style: { textDecoration: 'none' } }, "Dr. Ali Rashid's", h('small', {}, 'Clinic system')),
    topnav,
    searchBox,
    createMenu,
    userMenu);

  const main = h('main', { class: 'main', id: 'main' });
  const demoBanner = state.data.mode === 'demo'
    ? h('div', { class: 'demo-banner' }, h('span', {}, 'Demo mode with made-up patients. Nothing here is real or saved permanently.'),
      h('button', { class: 'link-btn', onclick: signOut }, 'Try another role'))
    : null;
  const content = h('div', {}, h('div', { class: 'main', style: { paddingBottom: 0 } }, demoBanner), main);

  function openDrawer() {
    drawer.querySelectorAll('.drawer-group').forEach(markCurrent); // tabs may have changed the URL since render
    drawer.inert = false;
    drawer.classList.add('open');
    scrim.hidden = false;
    content.inert = true; // the page behind the drawer cannot be tapped or tabbed into
    document.body.classList.add('drawer-open');
    toggle.setAttribute('aria-expanded', 'true');
    (drawer.querySelector('a[aria-current="page"]') || drawer.querySelector('.drawer-close')).focus();
  }
  function closeDrawer(returnFocus) {
    const wasOpen = drawer.classList.contains('open');
    drawer.classList.remove('open');
    drawer.inert = true;
    scrim.hidden = true;
    content.inert = false;
    document.body.classList.remove('drawer-open');
    toggle.setAttribute('aria-expanded', 'false');
    if (wasOpen && returnFocus) toggle.focus();
  }
  toggle.addEventListener('click', () => (drawer.classList.contains('open') ? closeDrawer(true) : openDrawer()));
  toggle.addEventListener('click', warmPasswordDialog, { once: true });
  on(window, 'hashchange', () => { closeDrawer(false); ctl.abort(); });
  on(wideScreen, 'change', () => { if (wideScreen.matches) closeDrawer(false); });

  // Load-shedding: say so at the top, and say exactly what keeps working. Only typed cells on the
  // Aaj ki List (treatment, details, notes) are kept on the device; everything else needs the connection.
  const offlineBanner = h('div', { class: 'offline-banner', hidden: navigator.onLine },
    h('strong', {}, 'No internet connection. '), 'Typing in the cells of the Aaj ki List (treatment, details, notes and the checkup rows) and in the Notes of the Checkups page is kept on this device and sent when the connection is back. Status and doctor changes, new patients, payments, invoices and all other entries are not saved until you are online again.');
  on(window, 'online', () => { offlineBanner.hidden = true; announce('Back online.'); });
  on(window, 'offline', () => { offlineBanner.hidden = false; announce('No internet connection. Only typing in the Aaj ki List cells is kept on this device; other changes are not saved until you are online again.', { assertive: true }); });

  mount(root,
    offlineBanner,
    topbar,
    h('div', { class: 'app topnav-layout' }, drawer, content),
    scrim);
  if (showsInboxCount) state.data.photoInboxCounts().then((c) => setInboxCount(c.waiting + c.check)).catch(() => {});
  // Before the person can use anything: a shared login says who is at the desk, and only then is the page drawn (and its data read).
  if (needsDeskName(s) && !(await askName())) return;
  if (signal.aborted) return;

  try {
    if (section === 'patient' && id && sub === 'portal' && can('patients.view')) await renderPortalPreview(main, id);
    else if (section === 'patient' && id && can('patients.view')) await renderPatient(main, id);
    else if (page && page.show()) await page.render(main, params, signal);
    else {
      document.title = 'Page not available | Clinic system';
      mount(main, h('div', { class: 'page-head' }, h('h1', {}, 'Page not available')),
        empty('This page is not available for your account.', h('a', { class: 'btn', href: '#/staff/today' }, 'Go to Today')));
    }
  } catch (e) {
    toast(friendlyError(e), 'error');
    // The tab and screen-reader title say so too, like "Page not available" above. Not when the person has
    // already moved on (this render was aborted): the route they went to has set its own title by now.
    if (!signal.aborted) document.title = 'This page could not load | Clinic system';
    mount(main, h('div', { class: 'page-head' }, h('h1', {}, 'This page could not load')), empty(friendlyError(e)));
  }
}
