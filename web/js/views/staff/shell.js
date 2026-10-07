// Staff area: a top menu bar (Today · Aaj ki List ▾ · Patients · Billing · Reports ▾ · Coordinator ▾ · More ▾),
// a patient search box that finds by name, Mr# or phone from any screen, the signed-in person's menu,
// and page routing. On phones the same menu opens as a side drawer.
import { h, mount, toast, friendlyError, empty, rupees } from '../../ui/dom.js';
import { state, can, isAdmin, loadStaffRef, branchName } from '../../state.js';
import { ROLE_LABELS } from '../../lib/permissions.js';
import { renderSheet } from './sheet.js';
import { renderPatients, renderPatient } from './patients.js';
import { renderDashboard, renderQueue, renderBilling, renderReview, renderComplaints, renderDoctorLog } from './pages.js';
import { renderAccounts } from './accounts.js';
import { renderReports } from './reports.js';
import { renderCoordinator } from './coordinator.js';
import { renderAdmin } from './admin.js';
import { renderInventory } from './inventory.js';
import { renderPortalPreview } from '../portal.js';

const PAGES = {
  today: { render: renderDashboard, show: () => true },
  sheet: { render: renderSheet, show: () => can('sheet.view') },
  queue: { render: renderQueue, show: () => can('sheet.view') },
  patients: { render: renderPatients, show: () => can('patients.view') },
  billing: { render: renderBilling, show: () => can('billing.view') || can('discount.approve') },
  accounts: { render: renderAccounts, show: () => can('finance.view') || can('cash.close') || can('cash.verify') },
  reports: { render: renderReports, show: () => can('finance.view') || can('billing.view') || can('patients.view') || can('sheet.view') },
  coordinator: { render: renderCoordinator, show: () => can('reminders.manage') || can('lab.manage') || can('retainers.manage') },
  stock: { render: renderInventory, show: () => can('inventory.manage') },
  complaints: { render: renderComplaints, show: () => can('complaints.view') },
  review: { render: renderReview, show: () => isAdmin() || can('complaints.view') || can('flags.clear') },
  log: { render: renderDoctorLog, show: () => state.session.staff.role === 'doctor' || can('doctor_log.view_all') },
  admin: { render: renderAdmin, show: () => can('users.manage') || can('export.data') || can('audit.view') || can('schedule.manage') || isAdmin() },
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

let refLoaded = false;
let globalHandlers = false;

export async function renderStaff(root, path, params, signOut) {
  if (!refLoaded) { await loadStaffRef(); refLoaded = true; }
  const [section, id, sub] = path.split('/');
  const page = PAGES[section];
  const s = state.session.staff;
  const current = (key) => key === section || (section === 'patient' && key === 'patients') || (section === 'accounts' && key === 'reports');
  const items = menu();

  // ---- dropdowns: click to open (works for touch and keyboard); hover handled by CSS on desktop.
  const closeAll = () => document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
  if (!globalHandlers) {
    globalHandlers = true;
    document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeAll(); if (!e.target.closest('.topsearch')) document.querySelectorAll('.search-results').forEach((r) => { r.hidden = true; }); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
  }
  const dropdown = (m, inDrawer = false) => {
    const btn = h('button', { class: ['nav-link', current(m.key) ? 'current' : ''], 'aria-haspopup': 'true', 'aria-expanded': 'false', onclick: (e) => {
      const wrap = e.currentTarget.parentElement; const open = !wrap.classList.contains('open'); closeAll(); wrap.classList.toggle('open', open); btn.setAttribute('aria-expanded', String(open));
    } }, m.label, h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'));
    return h('div', { class: ['menu', inDrawer ? 'in-drawer' : ''] }, btn,
      h('div', { class: 'menu-list', role: 'menu' }, m.items.map((i) => i.divider ? h('hr', {}) : h('a', { href: i.href, role: 'menuitem', onclick: () => { closeAll(); drawer.classList.remove('open'); } }, i.label))));
  };
  const navLinks = (inDrawer) => items.map((m) => m.items ? dropdown(m, inDrawer)
    : h('a', { class: ['nav-link', current(m.key) ? 'current' : ''], href: m.href, 'aria-current': current(m.key) ? 'page' : null, onclick: () => drawer.classList.remove('open') }, m.label));

  // ---- patient search from any screen: name, Mr# or phone.
  const searchBox = can('patients.view') ? (() => {
    const input = h('input', { type: 'search', placeholder: 'Search by name, Mr# or phone', 'aria-label': 'Search patients', autocomplete: 'off' });
    const results = h('div', { class: 'search-results', role: 'listbox', hidden: true });
    let timer, seq = 0;
    const close = () => { results.hidden = true; };
    const run = async () => {
      const t = input.value.trim();
      if (t.length < 2) { close(); return; }
      const n = ++seq;
      try {
        const rows = (await state.data.searchPatients(t)).slice(0, 8);
        if (n !== seq) return;
        mount(results, rows.length ? rows.map((p) => h('a', { href: `#/staff/patient/${p.id}`, role: 'option', onclick: () => { close(); input.value = ''; } },
          h('span', { class: 'mr' }, `Mr# ${p.mr_number}`), h('strong', {}, p.full_name),
          h('span', { class: 'muted' }, [p.phone, branchName(p.first_branch_id)].filter(Boolean).join(' · ')),
          can('dues.view') && Number(p.dues) > 0 ? h('span', { class: 'badge badge-dues' }, `$$ ${rupees(p.dues)}`) : null))
          : h('div', { class: 'muted', style: { padding: '10px 12px' } }, 'No patient matches.',
            can('patients.create') ? h('a', { href: '#/staff/patients?new=1', style: { marginLeft: '8px' } }, 'Register a new patient') : null));
        results.hidden = false;
      } catch (e) { toast(friendlyError(e), 'error'); }
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 220); });
    input.addEventListener('focus', () => { if (input.value.trim().length >= 2) run(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); close(); location.hash = `#/staff/patients?q=${encodeURIComponent(input.value.trim())}`; }
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowDown') { results.querySelector('a')?.focus(); e.preventDefault(); }
    });
    results.addEventListener('keydown', (e) => {
      const links = [...results.querySelectorAll('a')]; const i = links.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { (links[i + 1] || links[0])?.focus(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { (links[i - 1] || input).focus(); e.preventDefault(); }
      if (e.key === 'Escape') { close(); input.focus(); }
    });
    return h('div', { class: 'topsearch', role: 'search' }, h('span', { class: 'search-icon', 'aria-hidden': 'true' }, '🔍'), input, results);
  })() : null;

  const userMenu = h('div', { class: 'menu user-menu' },
    h('button', { class: 'nav-link', 'aria-haspopup': 'true', 'aria-expanded': 'false', onclick: (e) => { const w = e.currentTarget.parentElement; const open = !w.classList.contains('open'); closeAll(); w.classList.toggle('open', open); } },
      h('span', { class: 'user-name' }, s.full_name), h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾')),
    h('div', { class: 'menu-list', role: 'menu' },
      h('div', { class: 'menu-note' }, s.full_name, h('div', { class: 'muted' }, ROLE_LABELS[s.role])),
      h('hr', {}),
      h('button', { class: 'menu-btn', role: 'menuitem', onclick: signOut }, 'Log out')));

  // Phone: the menu as a drawer (same items, dropdowns expanded as groups).
  const drawer = h('nav', { class: 'sidebar', 'aria-label': 'Staff navigation' },
    h('a', { href: '#/staff/today', class: 'wordmark', style: { textDecoration: 'none' } }, "Dr. Ali Rashid's", h('small', {}, 'Clinic system')),
    items.map((m) => m.items
      ? h('div', { class: 'drawer-group' }, h('div', { class: 'nav-group' }, m.label), m.items.filter((i) => !i.divider).map((i) => h('a', { class: 'nav-link', href: i.href, onclick: () => drawer.classList.remove('open') }, i.label)))
      : h('a', { class: ['nav-link', current(m.key) ? 'current' : ''], href: m.href, 'aria-current': current(m.key) ? 'page' : null, onclick: () => drawer.classList.remove('open') }, m.label)),
    h('div', { class: 'sidebar-foot' },
      h('div', {}, s.full_name), h('div', { style: { opacity: .7 } }, ROLE_LABELS[s.role]),
      h('button', { class: 'link-btn', onclick: signOut, style: { marginTop: '8px' } }, 'Log out')));

  const topbar = h('header', { class: 'topbar' },
    h('button', { class: 'icon-btn menu-toggle', 'aria-label': 'Menu', onclick: () => drawer.classList.toggle('open') }, '☰'),
    h('a', { href: '#/staff/today', class: 'wordmark', style: { textDecoration: 'none' } }, "Dr. Ali Rashid's", h('small', {}, 'Clinic system')),
    h('nav', { class: 'topnav', 'aria-label': 'Staff navigation' }, navLinks(false)),
    searchBox,
    userMenu);

  const main = h('main', { class: 'main', id: 'main' });
  const demoBanner = state.data.mode === 'demo'
    ? h('div', { class: 'demo-banner' }, h('span', {}, 'Demo mode with made-up patients. Nothing here is real or saved permanently.'),
      h('button', { class: 'link-btn', onclick: signOut }, 'Try another role'))
    : null;

  // Load-shedding: say so at the top. The Aaj ki List keeps working offline (its changes queue on the device); other screens need the connection.
  const offlineBanner = h('div', { class: 'offline-banner', role: 'status', hidden: navigator.onLine },
    h('strong', {}, 'No internet connection. '), 'The Aaj ki List keeps working and sends its changes when the connection is back; payments, invoices and other entries need the connection.');
  window.addEventListener('online', () => { offlineBanner.hidden = true; });
  window.addEventListener('offline', () => { offlineBanner.hidden = false; });

  mount(root,
    offlineBanner,
    topbar,
    h('div', { class: 'app topnav-layout' }, drawer, h('div', {}, h('div', { class: 'main', style: { paddingBottom: 0 } }, demoBanner), main)));

  try {
    if (section === 'patient' && id && sub === 'portal' && can('patients.view')) await renderPortalPreview(main, id);
    else if (section === 'patient' && id && can('patients.view')) await renderPatient(main, id);
    else if (page && page.show()) await page.render(main, params);
    else mount(main, empty('This page is not available for your account.', h('a', { class: 'btn', href: '#/staff/today' }, 'Go to Today')));
  } catch (e) {
    toast(friendlyError(e), 'error');
    mount(main, empty(friendlyError(e)));
  }
}
