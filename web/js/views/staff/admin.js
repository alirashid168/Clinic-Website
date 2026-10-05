// Admin (Dr. Ali): access list with checkboxes, staff accounts, settings,
// Dr. Ali's calendar, data export, audit log.
import { h, mount, toast, friendlyError, modal, field, select, empty, downloadCSV, todayISO, shortDate } from '../../ui/dom.js';
import { state, can, isAdmin, branchName } from '../../state.js';
import { ROLE_LABELS } from '../../lib/permissions.js';
import { WEEKDAYS } from '../../content.js';
import { tabs } from './accounts.js';
import { CONFIG } from '../../config.js';

export async function renderAdmin(root, params) {
  const available = [
    can('users.manage') && ['access', 'Access list'],
    can('users.manage') && ['staff', 'Staff accounts'],
    isAdmin() && ['settings', 'Settings'],
    can('schedule.manage') && ['calendar', "Dr. Ali's calendar"],
    can('export.data') && ['export', 'Download data'],
    can('audit.view') && ['audit', 'Audit log'],
  ].filter(Boolean);
  let tab = params.get('tab') || available[0]?.[0];
  const head = h('div', {});
  const body = h('div', {});
  const pick = (k) => { tab = k; history.replaceState(null, '', `#/staff/admin?tab=${k}`); draw(); };
  async function draw() {
    mount(head, tabs(available, tab, pick));
    try {
      if (tab === 'access') await access(body);
      else if (tab === 'staff') await staff(body, draw);
      else if (tab === 'settings') await settings(body);
      else if (tab === 'calendar') await calendar(body, draw);
      else if (tab === 'export') await exportData(body);
      else await audit(body);
    } catch (e) { mount(body, empty(friendlyError(e))); }
  }
  mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'Admin')), head, body);
  await draw();
}

// ---------------------------------------------------------------- access grid
async function access(root) {
  const d = state.data;
  const { permissions, roles, grid } = await d.permissionGrid();
  const cats = [...new Set(permissions.map((p) => p.category))];
  const cols = roles.filter((r) => r !== 'admin');
  mount(root,
    h('p', { class: 'muted' }, 'Tick what each role can do. Changes save straight away and apply the next time that person opens a page. Admin (you) always has everything.'),
    h('section', { class: 'panel' }, h('div', { class: 'table-scroll' }, h('table', { class: 'perm-grid' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Feature'), cols.map((r) => h('th', {}, ROLE_LABELS[r])), h('th', {}, 'Admin'))),
      h('tbody', {}, cats.map((cat) => [
        h('tr', { class: 'cat' }, h('td', { colspan: cols.length + 2 }, cat)),
        ...permissions.filter((p) => p.category === cat).map((p) => h('tr', {},
          h('td', {}, p.label),
          cols.map((r) => h('td', {}, h('input', {
            type: 'checkbox', checked: !!grid[r]?.[p.key], 'aria-label': `${ROLE_LABELS[r]}: ${p.label}`,
            onchange: async (e) => {
              try { await d.setRolePermission(r, p.key, e.target.checked); toast(`${ROLE_LABELS[r]}: ${p.label} ${e.target.checked ? 'allowed' : 'removed'}.`, 'ok', 2500); } catch (err) { e.target.checked = !e.target.checked; toast(friendlyError(err), 'error'); }
            },
          }))),
          h('td', {}, h('input', { type: 'checkbox', checked: true, disabled: true, 'aria-label': `Admin: ${p.label}` })))),
      ]))))));
}

// ---------------------------------------------------------------- staff
async function staff(root, redraw) {
  const d = state.data;
  const [list, gridData] = await Promise.all([d.staffList(), d.permissionGrid()]);
  const { permissions, grid, overrides } = gridData;

  const add = () => {
    const name = h('input', { placeholder: 'Full name' });
    const email = h('input', { type: 'email', placeholder: `name@${CONFIG.STAFF_EMAIL_DOMAIN}` });
    const role = select(Object.entries(ROLE_LABELS).filter(([k]) => k !== 'admin').map(([value, label]) => ({ value, label })), 'front_desk');
    const branchBoxes = state.ref.branches.map((b) => ({ b, box: h('input', { type: 'checkbox' }) }));
    const doctor = select([{ value: '', label: 'Not a doctor on visits' }, ...state.ref.clinicians.filter((c) => !c.staff_id).map((c) => ({ value: c.id, label: c.display_name }))], '');
    modal('New staff account', h('div', {},
      h('div', { class: 'form-grid' }, field('Name', name), field('Login email', email), field('Role', role), field('Link to doctor/assistant name', doctor, 'So their visits count in their daily log')),
      h('p', { class: 'field-label' }, 'Limit to branches (leave empty for all branches)'),
      h('div', { class: 'inline' }, branchBoxes.map(({ b, box }) => h('label', { class: 'inline' }, box, b.name))),
      h('p', { class: 'muted', style: { marginTop: '10px' } }, 'They get an email to set their own password.')), [
      { label: 'Cancel' },
      { label: 'Create account', primary: true, onClick: async () => {
        const branch_ids = branchBoxes.filter((x) => x.box.checked).map((x) => x.b.id);
        try {
          await d.createStaff({ full_name: name.value.trim(), email: email.value.trim().toLowerCase(), role: role.value, branch_ids, restrict_to_branches: branch_ids.length > 0, home_branch_id: branch_ids[0] || null, clinician_id: doctor.value || null });
          toast('Account created.', 'ok'); redraw();
        } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  };

  const personal = (s) => {
    const mine = overrides[s.id] || {};
    modal(`Personal access · ${s.full_name}`, h('div', {},
      h('p', { class: 'muted' }, `Starts from the ${ROLE_LABELS[s.role]} column of the access list. Change a row here to give or take away access for this person only.`),
      h('table', { class: 'list' }, h('tbody', {}, permissions.map((p) => {
        const value = p.key in mine ? String(mine[p.key]) : '';
        const roleDefault = !!grid[s.role]?.[p.key];
        return h('tr', {}, h('td', {}, p.label), h('td', {}, select([
          { value: '', label: `As role (${roleDefault ? 'yes' : 'no'})` }, { value: 'true', label: 'Yes, for this person' }, { value: 'false', label: 'No, for this person' },
        ], value, { 'aria-label': p.label, onchange: async (e) => {
          const v = e.target.value === '' ? null : e.target.value === 'true';
          try { await d.setOverride(s.id, p.key, v); toast('Saved.', 'ok', 1500); } catch (err) { toast(friendlyError(err), 'error'); }
        } })));
      })))), [{ label: 'Done', primary: true, onClick: () => redraw() }]);
  };

  mount(root, h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Staff accounts'), h('button', { class: 'btn btn-primary btn-small', onclick: add }, 'New staff account')),
    h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Email'), h('th', {}, 'Role'), h('th', {}, 'Branches'), h('th', {}, ''), h('th', {}))),
      h('tbody', {}, list.map((s) => h('tr', { style: { opacity: s.active ? 1 : .55 } },
        h('td', {}, s.full_name), h('td', {}, s.email), h('td', {}, ROLE_LABELS[s.role]),
        h('td', {}, s.restrict_to_branches ? s.branch_ids.map(branchName).join(', ') : 'All'),
        h('td', {}, s.role !== 'admin' && Object.keys(overrides[s.id] || {}).length ? h('span', { class: 'badge badge-warn' }, 'Personal changes') : null),
        h('td', { class: 'right nowrap' },
          s.role !== 'admin' ? h('button', { class: 'btn btn-small', onclick: () => personal(s) }, 'Personal access') : null, ' ',
          s.role === 'admin' ? null : s.active
            ? h('button', { class: 'btn btn-small btn-danger', onclick: () => modal('Switch off account', h('p', {}, `${s.full_name} will be logged out and lose access to everything immediately.`), [
              { label: 'Cancel' }, { label: 'Switch off now', primary: true, onClick: async () => { try { await d.deactivateStaff(s.id); toast('Account switched off.', 'ok'); redraw(); } catch (e) { toast(friendlyError(e), 'error'); return false; } } }]) }, 'Switch off')
            : h('button', { class: 'btn btn-small', onclick: async () => { await d.reactivateStaff(s.id); toast('Account switched back on.', 'ok'); redraw(); } }, 'Switch on')))))))));
}

// ---------------------------------------------------------------- settings
async function settings(root) {
  const d = state.data;
  const [s, caps] = await Promise.all([d.settings(), d.discountCaps()]);
  const hold = select([
    { value: 'warn', label: 'Warn only: show "Clear dues first", treatment can continue' },
    { value: 'block', label: 'Block: treatment cannot start until dues are cleared or overridden' },
    { value: 'block_at_checkpoints', label: 'Block only at braces dues months (8 and 15)' },
  ], typeof s.dues_hold_mode === 'string' ? s.dues_hold_mode : 'warn');
  const wa = h('input', { value: s.whatsapp_number || '', placeholder: '03xx xxxxxxx' });
  const drop = h('input', { type: 'number', min: 7, value: s.dropoff_days ?? 42 });
  const capRows = ['front_desk', 'accountant', 'coordinator'].map((role) => {
    const c = caps[role] || { maxPercent: null, maxAmount: null };
    return { role, pct: h('input', { type: 'number', min: 0, max: 100, value: c.maxPercent ?? '', placeholder: 'No % limit' }), amt: h('input', { type: 'number', min: 0, value: c.maxAmount ?? '', placeholder: 'No rupee limit' }) };
  });
  const saveAll = async () => {
    try {
      await d.setSetting('dues_hold_mode', hold.value);
      await d.setSetting('whatsapp_number', wa.value.trim());
      await d.setSetting('dropoff_days', Number(drop.value) || 42);
      for (const r of capRows) await d.setDiscountCap(r.role, r.pct.value === '' ? null : Number(r.pct.value), r.amt.value === '' ? null : Number(r.amt.value));
      state.ref.settings = await d.settings();
      toast('Settings saved.', 'ok');
    } catch (e) { toast(friendlyError(e), 'error'); }
  };
  mount(root,
    h('section', { class: 'panel' }, h('h2', {}, 'Pending dues'), field('When a patient with dues is checked in', hold)),
    h('section', { class: 'panel' }, h('h2', {}, 'Discount limits'),
      h('p', { class: 'muted' }, 'Above these limits, a discount waits for approval by the accountant or you. Empty means no limit of that kind. A role without any row always needs approval.'),
      h('table', { class: 'list' }, h('thead', {}, h('tr', {}, h('th', {}, 'Role'), h('th', {}, 'Max %'), h('th', {}, 'Max Rs'))),
        h('tbody', {}, capRows.map((r) => h('tr', {}, h('td', {}, ROLE_LABELS[r.role]), h('td', {}, r.pct), h('td', {}, r.amt)))))),
    h('section', { class: 'panel' }, h('h2', {}, 'Website and follow-ups'),
      h('div', { class: 'form-grid' }, field('WhatsApp number for "Book free consultation"', wa), field('Drop-off list after (days without a visit)', drop))),
    h('button', { class: 'btn btn-primary', style: { marginTop: '16px' }, onclick: saveAll }, 'Save settings'));
}

// ---------------------------------------------------------------- calendar
async function calendar(root, redraw) {
  const d = state.data;
  const rows = (await d.schedule()).filter((r) => r.weekday !== null && r.weekday !== undefined).sort((a, b) => a.weekday - b.weekday || a.start_time.localeCompare(b.start_time));
  const day = select(WEEKDAYS.map((w, i) => ({ value: i, label: w })), 1);
  const branch = select(state.ref.branches.map((b) => ({ value: b.id, label: b.name })), state.ref.branches[0]?.id);
  const start = h('input', { type: 'time', value: '14:00' });
  const end = h('input', { type: 'time', value: '17:00' });
  mount(root,
    h('section', { class: 'panel' }, h('h2', {}, 'Add a time'),
      h('div', { class: 'form-grid' }, field('Day', day), field('Branch', branch), field('From', start), field('To', end)),
      h('button', { class: 'btn btn-primary', onclick: async () => {
        if (end.value <= start.value) return toast('The end time must be after the start time.');
        try { await d.saveScheduleRow({ weekday: Number(day.value), branch_id: Number(branch.value), start_time: start.value, end_time: end.value }); toast('Added to the calendar.', 'ok'); redraw(); } catch (e) { toast(friendlyError(e), 'error'); }
      } }, 'Add to calendar')),
    h('section', { class: 'panel' }, h('h2', {}, 'Weekly calendar shown on the homepage'),
      rows.length ? h('table', { class: 'list' }, h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', {}, WEEKDAYS[r.weekday]), h('td', {}, branchName(r.branch_id)), h('td', {}, `${r.start_time.slice(0, 5)} – ${r.end_time.slice(0, 5)}`),
        h('td', { class: 'right' }, h('button', { class: 'btn btn-small btn-danger', onclick: async () => { await d.deleteScheduleRow(r.id); redraw(); } }, 'Remove')))))) : empty('No times yet.')));
}

// ---------------------------------------------------------------- export
async function exportData(root) {
  const d = state.data;
  const tables = [['patients', 'Patients'], ['visits', 'Visits (Aaj ki List)'], ['invoices', 'Invoices'], ['payments', 'Payments'], ['expenses', 'Expenses'], ['cash_closings', 'Cash closings']];
  const branch = select([{ value: '', label: 'All branches' }, ...state.ref.branches.map((b) => ({ value: b.id, label: b.name }))], '');
  mount(root, h('section', { class: 'panel' },
    h('h2', {}, 'Download data'),
    h('p', { class: 'muted' }, 'Files are named with the date and branch, ready to upload to the clinic cloud. They open in Excel and Google Sheets.'),
    field('Branch', branch),
    h('div', { class: 'inline' }, tables.map(([key, label]) => h('button', { class: 'btn', onclick: async () => {
      try {
        let rows = await d.exportTable(key);
        if (branch.value && rows.length && 'branch_id' in rows[0]) rows = rows.filter((r) => String(r.branch_id) === branch.value);
        const tag = branch.value ? state.ref.branches.find((b) => String(b.id) === branch.value)?.code : 'ALL';
        downloadCSV(`${key}_${tag}_${todayISO()}.csv`, rows);
      } catch (e) { toast(friendlyError(e), 'error'); }
    } }, label)))));
}

async function audit(root) {
  const rows = await state.data.auditLog();
  mount(root, h('section', { class: 'panel' }, h('h2', {}, 'Recent changes'),
    rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Who'), h('th', {}, 'What'), h('th', {}, 'Change'))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', { class: 'nowrap' }, `${shortDate(r.at.slice(0, 10))} ${new Date(r.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`),
        h('td', {}, r.actor_name || r.actor || 'System'), h('td', {}, r.table_name.replace('_', ' ')), h('td', {}, r.action.toLowerCase())))))) : empty('No changes recorded yet.')));
}
