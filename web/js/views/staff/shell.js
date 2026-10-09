// Staff area: a top menu bar (Today · Aaj ki List ▾ · Patients · Billing · Reports ▾ · Coordinator ▾ · More ▾),
// a patient search box that finds by name, Mr# or phone from any screen, the signed-in person's menu,
// and page routing. Below 73.75em (1180px at the default text size: phones, tablets, small laptops and
// larger text settings) the same menu opens as a side drawer.
// Each page's module is loaded the first time it is opened, so the heavy ones (reports, admin with
// its importers) are only downloaded by the people who use them.
import { h, mount, toast, friendlyError, empty, rupees, srOnly, announce } from '../../ui/dom.js';
import { state, can, isAdmin, loadStaffRef, branchName } from '../../state.js';
import { ROLE_LABELS } from '../../lib/permissions.js';
import { combobox } from './common.js';

const lazy = (load, name) => (...args) => load().then((m) => m[name](...args));
const passwordDialogModule = () => import('../../ui/password-dialog.js');
const openChangePassword = lazy(passwordDialogModule, 'openChangePassword');
// Fetched as soon as the account menu or the phone drawer is opened, so the first click on "Change password" is not a silent wait
// (offline it is left alone: a failed module load is remembered by the browser, and the click itself then reports the problem).
const warmPasswordDialog = () => { if (navigator.onLine) passwordDialogModule().catch(() => {}); };
const pagesModule = () => import('./pages.js');
const patientsModule = () => import('./patients.js');
const renderPatient = lazy(patientsModule, 'renderPatient');
const renderPortalPreview = lazy(() => import('../portal.js'), 'renderPortalPreview');

const PAGES = {
  today: { render: lazy(pagesModule, 'renderDashboard'), show: () => true },
  sheet: { render: lazy(() => import('./sheet.js'), 'renderSheet'), show: () => can('sheet.view') },
  queue: { render: lazy(pagesModule, 'renderQueue'), show: () => can('sheet.view') },
  patients: { render: lazy(patientsModule, 'renderPatients'), show: () => can('patients.view') },
  billing: { render: lazy(pagesModule, 'renderBilling'), show: () => can('billing.view') || can('discount.approve') },
  accounts: { render: lazy(() => import('./accounts.js'), 'renderAccounts'), show: () => can('finance.view') || can('cash.close') || can('cash.verify') },
  reports: { render: lazy(() => import('./reports.js'), 'renderReports'), show: () => can('finance.view') || can('billing.view') || can('patients.view') || can('sheet.view') },
  coordinator: { render: lazy(() => import('./coordinator.js'), 'renderCoordinator'), show: () => can('reminders.manage') || can('lab.manage') || can('retainers.manage') },
  stock: { render: lazy(() => import('./inventory.js'), 'renderInventory'), show: () => can('inventory.manage') },
  complaints: { render: lazy(pagesModule, 'renderComplaints'), show: () => can('complaints.view') },
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
    { label: 'Aaj ki List', key: 'sheet', show: () => show('sheet'), items: [link('Aaj ki List', 'sheet'), link('Queue board', 'queue')] },
    link('Patients', 'patients'),
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
    { label: 'Coordinator', key: 'coordinator', show: () => show('coordinator'), items: [
      { ...link('Reminders', 'coordinator?tab=reminders'), show: () => can('reminders.manage') },
      { ...link('Drop-offs', 'coordinator?tab=dropoffs'), show: () => can('reminders.manage') },
      { ...link('Lab work', 'coordinator?tab=lab'), show: () => can('lab.manage') },
      { ...link('Retainers', 'coordinator?tab=retainers'), show: () => can('retainers.manage') || can('patients.view') },
      { ...link('Low ratings', 'coordinator?tab=ratings'), show: () => can('reminders.manage') },
    ] },
    { label: 'More', key: 'more', show: () => true, items: [
      link('Stock', 'stock'), link('Complaints', 'complaints'), link("Dr. Ali's list", 'review'), link('Doctor log', 'log'),
      { divider: true, show: () => show('admin') },
      { ...link('Access list', 'admin?tab=access'), show: () => can('users.manage') },
      { ...link('Staff accounts', 'admin?tab=staff'), show: () => can('users.manage') },
      { ...link('Settings', 'admin?tab=settings'), show: () => isAdmin() },
      { ...link('Clinic setup', 'admin?tab=setup'), show: () => isAdmin() },
      { ...link("Dr. Ali's calendar", 'admin?tab=calendar'), show: () => can('schedule.manage') },
      { ...link('Download data', 'admin?tab=export'), show: () => can('export.data') },
      { ...link('Import (Healthwire, Aaj ki List)', 'admin?tab=import'), show: () => isAdmin() },
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
let renderCtl = null;

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
  if (refSession !== session) { await loadStaffRef(); refSession = session; }
  if (signal.aborted) return;
  const [section, id, sub] = path.split('/');
  const page = PAGES[section];
  const s = state.session.staff;
  const current = (key) => key === section || (section === 'patient' && key === 'patients') || (section === 'accounts' && key === 'reports');
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
      m.label, current(m.key) ? srOnly(' (current section)') : null, h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'));
    const list = h('div', { class: 'menu-list', id: listId }, m.items.map((i) => (i.divider ? h('hr', {}) : h('a', { href: i.href, onclick: () => {
      // Choosing the page already on screen fires no hashchange, so give focus back to the menu button.
      const same = i.href === location.hash;
      closeAll();
      if (same) btn.focus();
    } }, i.label))));
    markCurrent(list);
    return disclosure(h('div', { class: 'menu' }, btn, list), btn, list);
  };
  const navLinks = items.map((m) => (m.items ? dropdown(m)
    : h('a', { class: ['nav-link', current(m.key) ? 'current' : ''], href: m.href, 'aria-current': current(m.key) ? 'page' : null }, m.label)));

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
      note: (t, rows) => (rows.length ? null : h('div', { class: 'muted', style: { padding: '10px 12px' } }, 'No patient matches.',
        can('patients.create') ? h('a', { href: '#/staff/patients?new=1', style: { marginLeft: '8px' } }, 'Register a new patient') : null)),
      count: (rows) => (rows.length ? `${rows.length} patient${rows.length === 1 ? '' : 's'} found. Use the up and down arrows to choose, then Enter to open.` : 'No patient matches.'),
    });
    return wrap;
  })() : null;

  const userBtn = h('button', { type: 'button', class: 'nav-link', 'aria-expanded': 'false', 'aria-controls': 'user-menu-list', 'aria-label': `Account menu, ${s.full_name}` },
    h('span', { class: 'user-name' }, s.full_name), h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'));
  const userList = h('div', { class: 'menu-list', id: 'user-menu-list' },
    h('div', { class: 'menu-note' }, s.full_name, h('div', { class: 'muted' }, ROLE_LABELS[s.role])),
    h('hr', {}),
    // The menu closes and focus goes back to the account button first, so the dialog gives focus back to something visible.
    h('button', { type: 'button', class: 'menu-btn', onclick: () => { closeAll(); userBtn.focus(); openChangePassword({ who: 'staff', username: s.email }); } }, 'Change password'),
    h('button', { type: 'button', class: 'menu-btn', onclick: signOut }, 'Log out'));
  const userMenu = disclosure(h('div', { class: 'menu user-menu' }, userBtn, userList), userBtn, userList);
  userBtn.addEventListener('click', warmPasswordDialog, { once: true });
  userMenu.addEventListener('mouseenter', warmPasswordDialog, { once: true });

  // ---- narrow screens (below the drawer breakpoint above): the menu as a drawer (same items, dropdowns
  // expanded as groups). It closes on the scrim, on Escape, on its close button and on navigation, gives
  // focus back to ☰, and is inert (out of the tab order) while closed.
  const toggle = h('button', { type: 'button', class: 'icon-btn menu-toggle', 'aria-label': 'Menu', 'aria-expanded': 'false', 'aria-controls': 'staff-drawer' }, h('span', { 'aria-hidden': 'true' }, '☰'));
  const drawerLink = (i, cur = false) => h('a', { class: ['nav-link', cur ? 'current' : ''], href: i.href, 'aria-current': cur ? 'page' : null, onclick: () => closeDrawer(i.href === location.hash) }, i.label);
  const drawer = h('nav', { class: 'sidebar', id: 'staff-drawer', 'aria-label': 'Staff navigation' },
    h('button', { type: 'button', class: 'icon-btn drawer-close', 'aria-label': 'Close menu', onclick: () => closeDrawer(true) }, h('span', { 'aria-hidden': 'true' }, '×')),
    h('a', { href: '#/staff/today', class: 'wordmark', style: { textDecoration: 'none' }, onclick: () => closeDrawer(location.hash === '#/staff/today') }, "Dr. Ali Rashid's", h('small', {}, 'Clinic system')),
    items.map((m) => (m.items
      ? h('div', { class: 'drawer-group', role: 'group', 'aria-labelledby': `drawer-group-${m.key}` }, h('div', { class: 'nav-group', id: `drawer-group-${m.key}` }, m.label), m.items.filter((i) => !i.divider).map((i) => drawerLink(i)))
      : drawerLink(m, current(m.key)))),
    h('div', { class: 'sidebar-foot' },
      h('div', {}, s.full_name), h('div', { style: { opacity: .7 } }, ROLE_LABELS[s.role]),
      h('div', { class: 'inline', style: { marginTop: '8px', columnGap: 'var(--space-6)' } },
        h('button', { type: 'button', class: 'link-btn', onclick: () => { closeDrawer(false); toggle.focus(); openChangePassword({ who: 'staff', username: s.email }); } }, 'Change password'),
        h('button', { type: 'button', class: 'link-btn', onclick: () => { closeDrawer(false); signOut(); } }, 'Log out'))));
  drawer.querySelectorAll('.drawer-group').forEach(markCurrent);
  drawer.inert = true;
  const scrim = h('div', { class: 'drawer-scrim', hidden: true, 'aria-hidden': 'true', onclick: () => closeDrawer(true) });

  const topbar = h('header', { class: 'topbar' },
    toggle,
    h('a', { href: '#/staff/today', class: 'wordmark', style: { textDecoration: 'none' } }, "Dr. Ali Rashid's", h('small', {}, 'Clinic system')),
    h('nav', { class: 'topnav', 'aria-label': 'Staff navigation' }, navLinks),
    searchBox,
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
    h('strong', {}, 'No internet connection. '), 'Typing in the Treatment, Treatment details and Notes cells of the Aaj ki List is kept on this device and sent when the connection is back. Status and doctor changes, new patients, payments, invoices and all other entries are not saved until you are online again.');
  on(window, 'online', () => { offlineBanner.hidden = true; announce('Back online.'); });
  on(window, 'offline', () => { offlineBanner.hidden = false; announce('No internet connection. Only typing in the Aaj ki List cells is kept on this device; other changes are not saved until you are online again.', { assertive: true }); });

  mount(root,
    offlineBanner,
    topbar,
    h('div', { class: 'app topnav-layout' }, drawer, content),
    scrim);

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
