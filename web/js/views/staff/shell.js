// Staff area: sidebar navigation (only what this person may use) and page routing.
import { h, mount, toast, friendlyError, empty } from '../../ui/dom.js';
import { state, can, isAdmin, loadStaffRef } from '../../state.js';
import { ROLE_LABELS } from '../../lib/permissions.js';
import { renderSheet } from './sheet.js';
import { renderPatients, renderPatient } from './patients.js';
import { renderDashboard, renderQueue, renderBilling, renderReview, renderComplaints, renderDoctorLog } from './pages.js';
import { renderAccounts } from './accounts.js';
import { renderCoordinator } from './coordinator.js';
import { renderAdmin } from './admin.js';
import { renderInventory } from './inventory.js';
import { renderPortalPreview } from '../portal.js';

const PAGES = [
  { path: 'today', label: 'Today', show: () => true, render: renderDashboard },
  { path: 'sheet', label: 'Aaj ki List', show: () => can('sheet.view'), render: renderSheet },
  { path: 'queue', label: 'Queue board', show: () => can('sheet.view'), render: renderQueue },
  { path: 'patients', label: 'Patients', show: () => can('patients.view'), render: renderPatients },
  { path: 'billing', label: 'Billing', show: () => can('billing.view') || can('discount.approve'), render: renderBilling },
  { path: 'accounts', label: 'Accounts', show: () => can('finance.view') || can('cash.close') || can('cash.verify'), render: renderAccounts },
  { path: 'coordinator', label: 'Coordinator', show: () => can('reminders.manage') || can('lab.manage') || can('retainers.manage'), render: renderCoordinator },
  { path: 'stock', label: 'Stock', show: () => can('inventory.manage'), render: renderInventory },
  { path: 'complaints', label: 'Complaints', show: () => can('complaints.view'), render: renderComplaints },
  { path: 'review', label: "Dr. Ali's list", show: () => isAdmin() || can('complaints.view') || can('flags.clear'), render: renderReview },
  { path: 'log', label: 'Doctor log', show: () => state.session.staff.role === 'doctor' || can('doctor_log.view_all'), render: renderDoctorLog },
  { path: 'admin', label: 'Admin', show: () => can('users.manage') || can('export.data') || can('audit.view') || can('schedule.manage') || isAdmin(), render: renderAdmin },
];

let refLoaded = false;

export async function renderStaff(root, path, params, signOut) {
  if (!refLoaded) { await loadStaffRef(); refLoaded = true; }
  const [section, id, sub] = path.split('/');
  const page = PAGES.find((p) => p.path === section);
  const s = state.session.staff;

  const sidebar = h('nav', { class: 'sidebar', 'aria-label': 'Staff navigation' },
    h('a', { href: '#/staff/today', class: 'wordmark', style: { textDecoration: 'none' } }, "Dr. Ali Rashid's", h('small', {}, 'Clinic system')),
    PAGES.filter((p) => p.show()).map((p) => h('a', {
      class: 'nav-link', href: `#/staff/${p.path}`, 'aria-current': p.path === section || (section === 'patient' && p.path === 'patients') ? 'page' : null,
      onclick: () => sidebar.classList.remove('open'),
    }, p.label)),
    h('div', { class: 'sidebar-foot' },
      h('div', {}, s.full_name), h('div', { style: { opacity: .7 } }, ROLE_LABELS[s.role]),
      h('button', { class: 'link-btn', onclick: signOut, style: { marginTop: '8px' } }, 'Log out')));

  const main = h('main', { class: 'main', id: 'main' });
  const demoBanner = state.data.mode === 'demo'
    ? h('div', { class: 'demo-banner' }, h('span', {}, 'Demo mode with made-up patients. Nothing here is real or saved permanently.'),
      h('button', { class: 'link-btn', onclick: signOut }, 'Try another role'))
    : null;

  mount(root,
    h('div', { class: 'mobile-bar' },
      h('button', { class: 'icon-btn', 'aria-label': 'Menu', onclick: () => sidebar.classList.toggle('open') }, '☰'),
      h('strong', {}, page?.label || 'Clinic'),
      h('span', {})),
    h('div', { class: 'app' }, sidebar, h('div', {}, h('div', { class: 'main', style: { paddingBottom: 0 } }, demoBanner), main)));

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
