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

  // Readable passwords to hand over at the desk: no look-alike letters (l/1, O/0).
  const newPassword = () => {
    const pick = (set, n) => Array.from(crypto.getRandomValues(new Uint32Array(n)), (x) => set[x % set.length]).join('');
    return pick('ABCDEFGHJKMNPQRSTUVWXYZ', 1) + pick('abcdefghjkmnpqrstuvwxyz', 4) + '-' + pick('23456789', 4);
  };
  const passwordField = () => {
    const input = h('input', { type: 'text', value: newPassword(), autocomplete: 'new-password', spellcheck: 'false', style: { fontFamily: 'monospace' } });
    const again = h('button', { type: 'button', class: 'btn btn-small', onclick: () => { input.value = newPassword(); } }, 'New one');
    const copy = h('button', { type: 'button', class: 'btn btn-small', onclick: async () => { try { await navigator.clipboard.writeText(input.value); toast('Password copied.', 'ok', 1500); } catch { input.select(); } } }, 'Copy');
    return { input, row: h('div', { class: 'inline' }, input, again, copy) };
  };

  const loginDetails = (s) => {
    const email = h('input', { type: 'email', value: s.email, autocomplete: 'off' });
    const pw = passwordField();
    const newPw = h('input', { type: 'checkbox' });
    const pwWrap = field('New password', pw.row, 'At least 8 characters. Give it to them in person or on WhatsApp.');
    pwWrap.style.display = 'none';
    newPw.addEventListener('change', () => { pwWrap.style.display = newPw.checked ? '' : 'none'; });
    modal(`Login details · ${s.full_name}`, h('div', {},
      field('Login email', email, `Must end with @${CONFIG.STAFF_EMAIL_DOMAIN}. It does not need a real inbox.`),
      h('label', { class: 'inline', style: { margin: '6px 0 10px' } }, newPw, 'Also give a new password'),
      pwWrap,
      h('p', { class: 'muted' }, s.role === 'admin' ? 'This is your own login. After a change, log in with the new details.' : 'Their old email or password stops working as soon as you save.')), [
      { label: 'Cancel' },
      { label: 'Save', primary: true, onClick: async () => {
        const nextEmail = email.value.trim().toLowerCase();
        const password = newPw.checked ? pw.input.value.trim() : '';
        if (nextEmail === s.email && !password) { toast('Nothing changed.'); return false; }
        try {
          await d.updateStaffLogin(s.id, { email: nextEmail, password: password || null });
          const parts = [nextEmail !== s.email ? `Login is now ${nextEmail}` : null, password ? `Password: ${password}` : null].filter(Boolean);
          toast(`Saved. ${parts.join(' · ')}`, 'ok', password ? 15000 : 5000); redraw();
        } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  };

  const add = () => {
    const name = h('input', { placeholder: 'Full name' });
    const email = h('input', { type: 'email', placeholder: `name@${CONFIG.STAFF_EMAIL_DOMAIN}` });
    const role = select(Object.entries(ROLE_LABELS).filter(([k]) => k !== 'admin').map(([value, label]) => ({ value, label })), 'front_desk');
    const branchBoxes = state.ref.branches.map((b) => ({ b, box: h('input', { type: 'checkbox' }) }));
    const pw = passwordField();
    const how = select([
      { value: 'password', label: 'I set a password now (no email needed)' },
      { value: 'invite', label: 'Email them an invitation (needs a real inbox)' },
    ], 'password');
    const pwWrap = field('Password', pw.row, 'Write this down for them. They log in with the email above and this password.');
    how.addEventListener('change', () => { pwWrap.style.display = how.value === 'password' ? '' : 'none'; });
    const doctor = select([{ value: '', label: 'Not a doctor on visits' }, ...state.ref.clinicians.filter((c) => !c.staff_id).map((c) => ({ value: c.id, label: c.display_name }))], '');
    modal('New staff account', h('div', {},
      h('div', { class: 'form-grid' }, field('Name', name), field('Login email', email, 'Used only as their login name. It does not need a real inbox.'), field('Role', role), field('Link to doctor/assistant name', doctor, 'So their visits count in their daily log')),
      h('div', { class: 'form-grid', style: { marginTop: '10px' } }, field('How will they log in?', how), pwWrap),
      h('p', { class: 'field-label' }, 'Limit to branches (leave empty for all branches)'),
      h('div', { class: 'inline' }, branchBoxes.map(({ b, box }) => h('label', { class: 'inline' }, box, b.name))),
      ), [
      { label: 'Cancel' },
      { label: 'Create account', primary: true, onClick: async () => {
        const branch_ids = branchBoxes.filter((x) => x.box.checked).map((x) => x.b.id);
        try {
          const password = how.value === 'password' ? pw.input.value.trim() : null;
          const login = email.value.trim().toLowerCase();
          await d.createStaff({ full_name: name.value.trim(), email: login, role: role.value, branch_ids, restrict_to_branches: branch_ids.length > 0, home_branch_id: branch_ids[0] || null, clinician_id: doctor.value || null, ...(password ? { password } : {}) });
          toast(password ? `Account created. Login: ${login} · Password: ${password}` : 'Account created. They will get an email to set a password.', 'ok', password ? 15000 : 4000); redraw();
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
          s.active && (s.role !== 'admin' || isAdmin()) ? h('button', { class: 'btn btn-small', onclick: () => loginDetails(s) }, 'Login details') : null, ' ',
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
// Weekly times = Dr. Ali's normal Karachi week. Dated times = trips (Lahore,
// Islamabad) or one-off changes; any date with its own times replaces the
// normal week on the homepage. Lahore and Islamabad branch cards list only
// these dates as open days.
async function calendar(root, redraw) {
  const d = state.data;
  const all = await d.schedule();
  const rows = all.filter((r) => r.weekday !== null && r.weekday !== undefined && !r.on_date).sort((a, b) => a.weekday - b.weekday || a.start_time.localeCompare(b.start_time));
  const dated = all.filter((r) => r.on_date && r.on_date >= todayISO()).sort((a, b) => a.on_date.localeCompare(b.on_date) || a.start_time.localeCompare(b.start_time));
  const branchOpts = state.ref.branches.map((b) => ({ value: b.id, label: b.name }));
  const day = select(WEEKDAYS.map((w, i) => ({ value: i, label: w })), 1);
  const branch = select(branchOpts, state.ref.branches[0]?.id);
  const start = h('input', { type: 'time', value: '12:00' });
  const end = h('input', { type: 'time', value: '21:00' });
  const onDate = h('input', { type: 'date', value: todayISO() });
  const dBranch = select(branchOpts, state.ref.branches.find((b) => b.code === 'LHR')?.id || state.ref.branches[0]?.id);
  const dStart = h('input', { type: 'time', value: '12:00' });
  const dEnd = h('input', { type: 'time', value: '21:00' });
  const remove = (r) => h('td', { class: 'right' }, h('button', { class: 'btn btn-small btn-danger', onclick: async () => { await d.deleteScheduleRow(r.id); redraw(); } }, 'Remove'));
  const time = (r) => `${r.start_time.slice(0, 5)} – ${r.end_time.slice(0, 5)}`;
  mount(root,
    h('section', { class: 'panel' }, h('h2', {}, 'Add a weekly time (normal Karachi week)'),
      h('div', { class: 'form-grid' }, field('Day', day), field('Branch', branch), field('From', start), field('To', end)),
      h('button', { class: 'btn btn-primary', onclick: async () => {
        if (end.value <= start.value) return toast('The end time must be after the start time.');
        try { await d.saveScheduleRow({ weekday: Number(day.value), branch_id: Number(branch.value), start_time: start.value, end_time: end.value }); toast('Added to the calendar.', 'ok'); redraw(); } catch (e) { toast(friendlyError(e), 'error'); }
      } }, 'Add to calendar')),
    h('section', { class: 'panel' }, h('h2', {}, 'Add a dated visit (Lahore, Islamabad or a one-off day)'),
      h('p', { class: 'muted' }, 'On this date the homepage shows only the dated times, not the normal week. Lahore and Islamabad show as open only on these dates.'),
      h('div', { class: 'form-grid' }, field('Date', onDate), field('Branch', dBranch), field('From', dStart), field('To', dEnd)),
      h('button', { class: 'btn btn-primary', onclick: async () => {
        if (!onDate.value) return toast('Choose a date.');
        if (dEnd.value <= dStart.value) return toast('The end time must be after the start time.');
        try { await d.saveScheduleRow({ on_date: onDate.value, branch_id: Number(dBranch.value), start_time: dStart.value, end_time: dEnd.value }); toast('Visit added.', 'ok'); redraw(); } catch (e) { toast(friendlyError(e), 'error'); }
      } }, 'Add visit')),
    h('section', { class: 'panel' }, h('h2', {}, 'Weekly calendar (normal Karachi week)'),
      rows.length ? h('table', { class: 'list' }, h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', {}, WEEKDAYS[r.weekday]), h('td', {}, branchName(r.branch_id)), h('td', {}, time(r)), remove(r))))) : empty('No times yet.')),
    h('section', { class: 'panel' }, h('h2', {}, 'Upcoming dated visits'),
      dated.length ? h('table', { class: 'list' }, h('tbody', {}, dated.map((r) => h('tr', {},
        h('td', {}, shortDate(r.on_date)), h('td', {}, branchName(r.branch_id)), h('td', {}, r.unavailable ? 'Not available' : time(r)), remove(r))))) : empty('No dated visits.')));
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
