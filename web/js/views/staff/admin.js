// Admin (Dr. Ali): access list with checkboxes, staff accounts, settings,
// clinic setup (branches, doctors, treatments), Dr. Ali's calendar, data
// export, import from Healthwire, audit log.
import { h, mount, toast, friendlyError, modal, field, select, empty, downloadCSV, todayISO, shortDate, timeOf, busy, srOnly, localISO, showFormErrors, clearFieldErrors } from '../../ui/dom.js';
import { state, can, isAdmin, branchName } from '../../state.js';
import { ROLE_LABELS } from '../../lib/permissions.js';
import { DAY_ORDER, branchHoursFrom } from '../../lib/hours.js';
import { WEEKDAYS } from '../../content.js';
import { tabbed } from './accounts.js';
import { CONFIG } from '../../config.js';
// Clinic setup, the Healthwire import (with its file readers) and the duplicate finder
// are loaded only when their tab is opened.

/** The Karachi calendar day of a timestamp (its UTC day is a day behind before 5 AM PKT). */
const dayOf = (ts) => (ts ? localISO(new Date(ts)) : '');
const when = (ts) => `${shortDate(dayOf(ts))} ${timeOf(ts)}`;

export async function renderAdmin(root, params) {
  const available = [
    can('users.manage') && ['access', 'Access list'],
    can('users.manage') && ['staff', 'Staff accounts'],
    isAdmin() && ['settings', 'Settings'],
    isAdmin() && ['setup', 'Clinic setup'],
    can('schedule.manage') && ['calendar', "Dr. Ali's calendar"],
    can('export.data') && ['export', 'Download data'],
    isAdmin() && ['import', 'Import from Healthwire'],
    isAdmin() && ['duplicates', 'Duplicate patients'],
    can('audit.view') && ['audit', 'Audit log'],
  ].filter(Boolean);
  // An old link or a tab this person may not use falls back to the first tab, the same one tabs() selects.
  const want = params.get('tab');
  let tab = available.some(([k]) => k === want) ? want : available[0]?.[0];
  const strip = tabbed('Admin sections', available, tab, (k) => { tab = k; history.replaceState(null, '', `#/staff/admin?tab=${k}`); draw(); });
  const body = strip.panel;
  let drawing = 0;
  async function draw() {
    // Each tab renders into its own holder, shown only if it is still the tab picked last.
    const n = ++drawing;
    const host = h('div', {});
    mount(body, h('p', { class: 'muted' }, 'Loading…'));
    try {
      if (tab === 'access') await access(host);
      else if (tab === 'staff') await staff(host, draw);
      else if (tab === 'settings') await settings(host);
      else if (tab === 'setup') await (await import('./setup.js')).renderSetup(host);
      else if (tab === 'calendar') await calendar(host, draw);
      else if (tab === 'export') await exportData(host);
      else if (tab === 'import') await (await import('./import.js')).renderImport(host);
      else if (tab === 'duplicates') await (await import('./duplicates.js')).renderDuplicates(host);
      else await audit(host);
    } catch (e) { mount(host, empty(friendlyError(e))); }
    if (n === drawing) mount(body, host);
  }
  mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'Admin')), strip.el, body);
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
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Feature'), cols.map((r) => h('th', { scope: 'col' }, ROLE_LABELS[r])), h('th', { scope: 'col' }, 'Admin'))),
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
  const [list, gridData, logins] = await Promise.all([d.staffList(), d.permissionGrid(), isAdmin() ? d.staffLogins().catch(() => null) : null]);
  const { permissions, grid, overrides } = gridData;
  const lastLogin = (id) => { const row = logins?.staff?.find((x) => x.id === id); return row?.last_sign_in_at ? when(row.last_sign_in_at) : 'Never'; };

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

  // Staff login emails need not be real inboxes, so staff never get a reset email:
  // when someone forgets their password, the admin sets a new one here.
  const loginDetails = (s) => {
    const email = h('input', { type: 'email', value: s.email, autocomplete: 'off' });
    const pw = passwordField();
    const newPw = h('input', { type: 'checkbox' });
    const pwWrap = field('New password', pw.row, 'At least 8 characters. Give it to them in person or on WhatsApp.');
    pwWrap.style.display = 'none';
    newPw.addEventListener('change', () => { pwWrap.style.display = newPw.checked ? '' : 'none'; });
    const body = h('div', {},
      field('Login email', email, `Must end with @${CONFIG.STAFF_EMAIL_DOMAIN}. It does not need a real inbox: staff are never sent a reset email.`, { required: true }),
      h('label', { class: 'inline', style: { margin: '6px 0 10px' } }, newPw, 'Set a new password (for example, they forgot theirs)'),
      pwWrap,
      h('p', { class: 'muted' }, s.role === 'admin' ? 'This is your own login. After a change, log in with the new details.' : 'Their old email or password stops working as soon as you save.'));
    modal(`Login and password · ${s.full_name}`, body, [
      { label: 'Cancel' },
      { label: 'Save', primary: true, onClick: async () => {
        clearFieldErrors(body);
        const nextEmail = email.value.trim().toLowerCase();
        const password = newPw.checked ? pw.input.value.trim() : '';
        const errors = [];
        if (!nextEmail.includes('@')) errors.push({ input: email, message: 'Write their login email.' });
        if (newPw.checked && password.length < 8) errors.push({ input: pw.input, message: 'The password needs at least 8 characters.' });
        if (errors.length) { showFormErrors(body, errors); return false; }
        if (nextEmail === s.email && !password) { toast('Nothing changed.'); return false; }
        try {
          await d.updateStaffLogin(s.id, { email: nextEmail, password: password || null });
          const parts = [nextEmail !== s.email ? `Login is now ${nextEmail}` : null, password ? `Password: ${password}` : null].filter(Boolean);
          toast(`Saved. ${parts.join(' · ')}`, 'ok', password ? 15000 : 5000); await redraw();
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
    const body = h('div', {},
      h('div', { class: 'form-grid' }, field('Name', name, null, { required: true }), field('Login email', email, 'Used only as their login name. It does not need a real inbox. If they forget their password, you set a new one with "Login and password".', { required: true }), field('Role', role), field('Link to doctor/assistant name', doctor, 'So their visits count in their daily log')),
      h('div', { class: 'form-grid', style: { marginTop: '10px' } }, field('How will they log in?', how), pwWrap),
      h('fieldset', { class: 'fieldset-plain' }, h('legend', {}, 'Limit to branches (leave empty for all branches)'),
        h('div', { class: 'inline' }, branchBoxes.map(({ b, box }) => h('label', { class: 'inline' }, box, b.name)))));
    modal('New staff account', body, [
      { label: 'Cancel' },
      { label: 'Create account', primary: true, onClick: async () => {
        clearFieldErrors(body);
        const branch_ids = branchBoxes.filter((x) => x.box.checked).map((x) => x.b.id);
        const password = how.value === 'password' ? pw.input.value.trim() : null;
        const login = email.value.trim().toLowerCase();
        const errors = [];
        if (name.value.trim().length < 2) errors.push({ input: name, message: 'Write their full name.' });
        if (!login.includes('@')) errors.push({ input: email, message: 'Write their login email.' });
        if (password !== null && password.length < 8) errors.push({ input: pw.input, message: 'The password needs at least 8 characters.' });
        if (errors.length) { showFormErrors(body, errors); return false; }
        try {
          await d.createStaff({ full_name: name.value.trim(), email: login, role: role.value, branch_ids, restrict_to_branches: branch_ids.length > 0, home_branch_id: branch_ids[0] || null, clinician_id: doctor.value || null, ...(password ? { password } : {}) });
          toast(password ? `Account created. Login: ${login} · Password: ${password}` : 'Account created. They will get an email to set a password.', 'ok', password ? 15000 : 4000); await redraw();
        } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  };

  const personal = (s) => {
    const mine = overrides[s.id] || {};
    modal(`Personal access · ${s.full_name}`, h('div', {},
      h('p', { class: 'muted' }, `Starts from the ${ROLE_LABELS[s.role]} column of the access list. Change a row here to give or take away access for this person only.`),
      h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Feature'), h('th', { scope: 'col' }, 'Access'))),
        h('tbody', {}, permissions.map((p) => {
          const value = p.key in mine ? String(mine[p.key]) : '';
          const roleDefault = !!grid[s.role]?.[p.key];
          return h('tr', {}, h('td', {}, p.label), h('td', {}, select([
            { value: '', label: `As role (${roleDefault ? 'yes' : 'no'})` }, { value: 'true', label: 'Yes, for this person' }, { value: 'false', label: 'No, for this person' },
          ], value, { 'aria-label': p.label, onchange: async (e) => {
            const v = e.target.value === '' ? null : e.target.value === 'true';
            try { await d.setOverride(s.id, p.key, v); toast('Saved.', 'ok', 1500); } catch (err) { toast(friendlyError(err), 'error'); }
          } })));
        }))))), [{ label: 'Done', primary: true, onClick: () => redraw() }]);
  };

  const switchOff = (s) => modal(`Switch off ${s.full_name}'s account?`,
    h('p', {}, `${s.full_name} will be logged out and lose access to everything immediately. You can switch the account back on later.`), [
      { label: 'Cancel' },
      { label: `Switch off ${s.full_name}`, danger: true, onClick: async () => { try { await d.deactivateStaff(s.id); toast('Account switched off.', 'ok'); await redraw(); } catch (e) { toast(friendlyError(e), 'error'); return false; } } },
    ], { destructive: true });

  mount(root, h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Staff accounts'), h('button', { class: 'btn btn-primary btn-small', onclick: add }, 'New staff account')),
    h('p', { class: 'muted' }, 'Staff who forget their password cannot reset it by email. Open "Login and password" on their row and set a new one.'),
    h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Name'), h('th', { scope: 'col' }, 'Email'), h('th', { scope: 'col' }, 'Role'), h('th', { scope: 'col' }, 'Branches'), logins ? h('th', { scope: 'col' }, 'Last login') : null, h('th', { scope: 'col' }, 'Access'), h('th', { scope: 'col' }, srOnly('Actions')))),
      h('tbody', {}, list.map((s) => h('tr', { class: s.active ? null : 'is-inactive' },
        // Switched-off accounts say so in words; they are not dimmed, so they stay readable.
        h('td', {}, s.full_name, s.active ? null : [' ', h('span', { class: 'badge badge-inactive' }, 'Switched off')]),
        h('td', {}, s.email), h('td', {}, ROLE_LABELS[s.role]),
        h('td', {}, s.restrict_to_branches ? s.branch_ids.map(branchName).join(', ') : 'All'),
        logins ? h('td', { class: 'nowrap muted' }, lastLogin(s.id)) : null,
        h('td', {}, s.role !== 'admin' && Object.keys(overrides[s.id] || {}).length ? h('span', { class: 'badge badge-warn' }, 'Personal changes') : null),
        h('td', { class: 'right nowrap' },
          s.role !== 'admin' ? h('button', { class: 'btn btn-small', 'aria-label': `Personal access, ${s.full_name}`, onclick: () => personal(s) }, 'Personal access') : null, ' ',
          s.active && (s.role !== 'admin' || isAdmin()) ? h('button', { class: 'btn btn-small', 'aria-label': `Login and password, ${s.full_name}`, onclick: () => loginDetails(s) }, 'Login and password') : null, ' ',
          s.role === 'admin' ? null : s.active
            ? h('button', { class: 'btn btn-small btn-danger', 'aria-label': `Switch off ${s.full_name}`, onclick: () => switchOff(s) }, 'Switch off')
            : h('button', { class: 'btn btn-small', 'aria-label': `Switch on ${s.full_name}`, onclick: busy(async () => { await d.reactivateStaff(s.id); toast('Account switched back on.', 'ok'); redraw(); }) }, 'Switch on')))))))));
}

// ---------------------------------------------------------------- settings
const DAY_NAME = Object.fromEntries(DAY_ORDER.map((k, i) => [k, WEEKDAYS[(i + 1) % 7]]));

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
  const timeout = h('input', { type: 'number', min: 5, max: 720, step: 1, value: s.session_timeout_minutes ?? 30 });
  const lowStars = select([1, 2, 3, 4].map((n) => ({ value: n, label: `${n} star${n > 1 ? 's' : ''} or less` })), Number(s.low_rating_threshold ?? 3));
  const capRows = ['front_desk', 'accountant', 'coordinator'].map((role) => {
    const c = caps[role] || { maxPercent: null, maxAmount: null };
    return { role,
      pct: h('input', { type: 'number', min: 0, max: 100, value: c.maxPercent ?? '', placeholder: 'No % limit', 'aria-label': `Max % for ${ROLE_LABELS[role]}` }),
      amt: h('input', { type: 'number', min: 0, value: c.maxAmount ?? '', placeholder: 'No rupee limit', 'aria-label': `Max Rs for ${ROLE_LABELS[role]}` }) };
  });

  // Branch opening hours (the clinic_timings setting): what each branch card on the homepage shows.
  let timings = s.clinic_timings;
  if (typeof timings === 'string') { try { timings = JSON.parse(timings); } catch { timings = {}; } }
  if (!timings || typeof timings !== 'object') timings = {};
  const current = branchHoursFrom(timings);
  const hourRows = state.ref.branches.map((b) => {
    const cur = current[b.id] || {};
    const mode = select([
      { value: 'weekly', label: 'Open on fixed weekdays' },
      { value: 'visits', label: "Open only on Dr. Ali's visit dates" },
      { value: '', label: 'Not listed: patients are asked to message for timings' },
    ], cur.mode === 'weekly' || cur.mode === 'visits' ? cur.mode : '');
    const days = DAY_ORDER.map((k) => {
      const [o = '', c = ''] = String(cur.days?.[k] || '').split('-');
      return { k,
        open: h('input', { type: 'time', value: o.slice(0, 5), 'aria-label': `${DAY_NAME[k]} opens` }),
        close: h('input', { type: 'time', value: c.slice(0, 5), 'aria-label': `${DAY_NAME[k]} closes` }) };
    });
    const week = h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Day'), h('th', { scope: 'col' }, 'Opens'), h('th', { scope: 'col' }, 'Closes'))),
      h('tbody', {}, days.map((x) => h('tr', {}, h('td', {}, DAY_NAME[x.k]), h('td', {}, x.open), h('td', {}, x.close))))));
    const visitNote = h('p', { class: 'muted' }, "The card lists the dated visits in Dr. Ali's calendar, each with its own times.");
    const sync = () => { week.hidden = mode.value !== 'weekly'; visitNote.hidden = mode.value !== 'visits'; };
    mode.addEventListener('change', sync);
    sync();
    return { b, cur, mode, days, el: h('fieldset', { class: 'panel' }, h('legend', {}, b.name),
      field('Opening pattern', mode), week, visitNote, h('p', { class: 'muted' }, 'Leave both times empty on a closed day.')) };
  });
  const collectHours = () => {
    const errors = [];
    const branches = { ...current }; // entries for branches not listed here (switched off) are kept
    for (const r of hourRows) {
      if (!r.mode.value) { delete branches[r.b.id]; continue; }
      if (r.mode.value === 'visits') { branches[r.b.id] = { ...(r.cur.mode === 'visits' ? r.cur : {}), mode: 'visits' }; continue; }
      const days = {};
      for (const x of r.days) {
        const o = x.open.value; const c = x.close.value;
        if (!o && !c) continue;
        if (!o || !c) { errors.push({ input: o ? x.close : x.open, message: 'Fill in both times, or leave both empty when closed.' }); continue; }
        if (c <= o) { errors.push({ input: x.close, message: 'The closing time must be after the opening time.' }); continue; }
        days[x.k] = `${o}-${c}`;
      }
      if (!errors.length && !Object.keys(days).length) errors.push({ input: r.days[0].open, message: `Give ${r.b.name} at least one open day, or choose another opening pattern.` });
      branches[r.b.id] = { ...(r.cur.mode === 'weekly' ? r.cur : {}), mode: 'weekly', days };
    }
    return { errors, value: { ...timings, branches } };
  };

  const saveAll = busy(async () => {
    clearFieldErrors(root);
    const errors = [];
    const minutes = Number(timeout.value);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 720) errors.push({ input: timeout, message: 'Enter a whole number of minutes from 5 to 720.' });
    const hours = collectHours();
    errors.push(...hours.errors);
    if (errors.length) { showFormErrors(root, errors); return; }
    await d.setSetting('dues_hold_mode', hold.value);
    await d.setSetting('whatsapp_number', wa.value.trim());
    await d.setSetting('dropoff_days', Number(drop.value) || 42);
    await d.setSetting('session_timeout_minutes', minutes);
    await d.setSetting('low_rating_threshold', Number(lowStars.value) || 3);
    await d.setSetting('clinic_timings', hours.value);
    for (const r of capRows) await d.setDiscountCap(r.role, r.pct.value === '' ? null : Number(r.pct.value), r.amt.value === '' ? null : Number(r.amt.value));
    state.ref.settings = await d.settings();
    toast('Settings saved.', 'ok');
  });
  mount(root,
    h('section', { class: 'panel' }, h('h2', {}, 'Pending dues'), field('When a patient with dues is checked in', hold)),
    h('section', { class: 'panel' }, h('h2', {}, 'Discount limits'),
      h('p', { class: 'muted' }, 'Above these limits, a discount waits for approval by the accountant or you. Empty means no limit of that kind. A role without any row always needs approval.'),
      h('div', { class: 'table-scroll' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Role'), h('th', { scope: 'col' }, 'Max %'), h('th', { scope: 'col' }, 'Max Rs'))),
        h('tbody', {}, capRows.map((r) => h('tr', {}, h('td', {}, ROLE_LABELS[r.role]), h('td', {}, r.pct), h('td', {}, r.amt))))))),
    h('section', { class: 'panel' }, h('h2', {}, 'Website and follow-ups'),
      h('div', { class: 'form-grid' }, field('WhatsApp number for "Book free consultation"', wa), field('Drop-off list after (days without a visit)', drop),
        field('Low rating alert', lowStars, 'Ratings at or below this go to the coordinator\'s "Low ratings" list.'),
        field('Log staff out after (minutes of no activity)', timeout, 'From 5 to 720 minutes (12 hours). One minute before, staff see a warning with a "Stay signed in" button. Clicks, typing, scrolling and touch all count as activity. Other staff get the new time at their next login.', { required: true }))),
    h('section', { class: 'panel' }, h('h2', {}, 'Branch opening hours'),
      h('p', { class: 'muted' }, 'What each branch card on the homepage shows. Karachi branches open on fixed weekdays whether or not Dr. Ali is there; Lahore and Islamabad open only on his visit dates.'),
      hourRows.map((r) => r.el)),
    h('button', { class: 'btn btn-primary', style: { marginTop: '16px' }, onclick: saveAll }, 'Save settings'));
}

// ---------------------------------------------------------------- calendar
// Weekly times = Dr. Ali's normal Karachi week. Dated times = trips (Lahore,
// Islamabad) or one-off changes; any date with its own times replaces the
// normal week on the homepage. Lahore and Islamabad branch cards list only
// these dates as open days.
async function calendar(root, redraw) {
  const d = state.data;
  const all = await d.schedule({ fresh: true }); // the adapter caches the schedule; the editor needs it current
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
  const time = (r) => `${r.start_time.slice(0, 5)} – ${r.end_time.slice(0, 5)}`;
  const describe = (r) => `${r.on_date ? shortDate(r.on_date) : WEEKDAYS[r.weekday]}, ${branchName(r.branch_id)}, ${r.unavailable ? 'not available' : time(r)}`;
  // Removing a slot changes the public homepage at once, so it asks first and names the slot.
  const remove = (r) => h('td', { class: 'right' }, h('button', { class: 'btn btn-small btn-danger', 'aria-label': `Remove ${describe(r)}`, onclick: () => modal('Remove from the calendar?',
    h('p', {}, `${describe(r)}. It disappears from the homepage straight away.`), [
      { label: 'Cancel' },
      { label: 'Remove', danger: true, onClick: async () => { try { await d.deleteScheduleRow(r.id); toast('Removed from the calendar.', 'ok'); await redraw(); } catch (e) { toast(friendlyError(e), 'error'); return false; } } },
    ], { destructive: true }) }, 'Remove'));
  const timeErrors = (from, to) => (!from.value ? [{ input: from, message: 'Choose a start time.' }] : to.value <= from.value ? [{ input: to, message: 'The end time must be after the start time.' }] : []);
  const weeklyForm = h('section', { class: 'panel' }, h('h2', {}, 'Add a weekly time (normal Karachi week)'),
    h('div', { class: 'form-grid' }, field('Day', day), field('Branch', branch), field('From', start, null, { required: true }), field('To', end, null, { required: true })),
    h('button', { class: 'btn btn-primary', onclick: busy(async () => {
      clearFieldErrors(weeklyForm);
      const errors = timeErrors(start, end);
      if (errors.length) { showFormErrors(weeklyForm, errors); return; }
      await d.saveScheduleRow({ weekday: Number(day.value), branch_id: Number(branch.value), start_time: start.value, end_time: end.value });
      toast('Added to the calendar.', 'ok'); redraw();
    }) }, 'Add to calendar'));
  const datedForm = h('section', { class: 'panel' }, h('h2', {}, 'Add a dated visit (Lahore, Islamabad or a one-off day)'),
    h('p', { class: 'muted' }, 'On this date "This week with Dr. Ali" on the homepage shows only these times, not the normal week. Lahore and Islamabad branch cards show as open only on dated visits.'),
    h('div', { class: 'form-grid' }, field('Date', onDate, null, { required: true }), field('Branch', dBranch), field('From', dStart, null, { required: true }), field('To', dEnd, null, { required: true })),
    h('button', { class: 'btn btn-primary', onclick: busy(async () => {
      clearFieldErrors(datedForm);
      const errors = [...(!onDate.value ? [{ input: onDate, message: 'Choose a date.' }] : []), ...timeErrors(dStart, dEnd)];
      if (errors.length) { showFormErrors(datedForm, errors); return; }
      await d.saveScheduleRow({ on_date: onDate.value, branch_id: Number(dBranch.value), start_time: dStart.value, end_time: dEnd.value });
      toast('Visit added.', 'ok'); redraw();
    }) }, 'Add visit'));
  mount(root,
    weeklyForm,
    datedForm,
    h('section', { class: 'panel' }, h('h2', {}, 'Weekly calendar (normal Karachi week)'),
      rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Day'), h('th', { scope: 'col' }, 'Branch'), h('th', { scope: 'col' }, 'Time'), h('th', { scope: 'col' }, srOnly('Actions')))),
        h('tbody', {}, rows.map((r) => h('tr', {},
          h('td', {}, WEEKDAYS[r.weekday]), h('td', {}, branchName(r.branch_id)), h('td', {}, time(r)), remove(r)))))) : empty('No times yet.')),
    h('section', { class: 'panel' }, h('h2', {}, 'Upcoming dated visits'),
      dated.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Date'), h('th', { scope: 'col' }, 'Branch'), h('th', { scope: 'col' }, 'Time'), h('th', { scope: 'col' }, srOnly('Actions')))),
        h('tbody', {}, dated.map((r) => h('tr', {},
          h('td', {}, shortDate(r.on_date)), h('td', {}, branchName(r.branch_id)), h('td', {}, r.unavailable ? 'Not available' : time(r)), remove(r)))))) : empty('No dated visits.')));
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
    h('div', { class: 'inline' }, tables.map(([key, label]) => h('button', { class: 'btn', onclick: busy(async () => {
      let rows = await d.exportTable(key);
      // Patients carry the branch they first came to; everything else carries the branch it happened at.
      const branchKey = key === 'patients' ? 'first_branch_id' : 'branch_id';
      if (branch.value && rows.length && branchKey in rows[0]) rows = rows.filter((r) => String(r[branchKey]) === branch.value);
      const tag = branch.value ? state.ref.branches.find((b) => String(b.id) === branch.value)?.code : 'ALL';
      downloadCSV(`${key}_${tag}_${todayISO()}.csv`, rows);
    }) }, label)))));
}

async function audit(root) {
  const [rows, logins] = await Promise.all([state.data.auditLog(), isAdmin() ? state.data.staffLogins().catch(() => null) : null]);
  const device = (ua) => { const u = ua || ''; const os = /iPhone|iPad/.test(u) ? 'iPhone/iPad' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'Windows' : /Mac/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux' : ''; const br = /Edg\//.test(u) ? 'Edge' : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : /Firefox\//.test(u) ? 'Firefox' : ''; return [br, os].filter(Boolean).join(' on ') || u.slice(0, 40); };
  mount(root,
    logins ? h('section', { class: 'panel' }, h('h2', {}, 'Logins'),
      h('p', { class: 'muted' }, 'Every sign-in to the staff system and the patient portal. The last-login time on Staff accounts comes from the login system itself.'),
      logins.events?.length > 100 ? h('p', { class: 'muted' }, `Showing the latest 100 of ${logins.events.length} sign-ins.`) : null,
      logins.events?.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'When'), h('th', { scope: 'col' }, 'Who'), h('th', { scope: 'col' }, 'Device'))),
        h('tbody', {}, logins.events.slice(0, 100).map((e) => h('tr', {}, h('td', { class: 'nowrap' }, when(e.at)), h('td', {}, e.name || '', e.role ? h('span', { class: 'muted' }, ` · ${ROLE_LABELS[e.role] || e.role}`) : e.kind === 'patient' ? h('span', { class: 'muted' }, ' · patient') : null), h('td', {}, device(e.user_agent))))))) : empty('No sign-ins recorded yet.')) : null,
    h('section', { class: 'panel' }, h('h2', {}, 'Recent changes'),
    // The list is cut at its cap (newest first): say so, or an empty search for an older change reads as "it never happened".
    rows.truncated ? h('div', { class: 'alert alert-warning', role: 'status' }, `Showing the latest ${rows.cap ?? rows.length} changes. Older changes are not shown here.`) : null,
    rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'When'), h('th', { scope: 'col' }, 'Who'), h('th', { scope: 'col' }, 'What'), h('th', { scope: 'col' }, 'Change'))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', { class: 'nowrap' }, when(r.at)),
        h('td', {}, r.actor_name || r.actor || 'System'), h('td', {}, r.table_name.replace('_', ' ')), h('td', {}, r.action.toLowerCase())))))) : empty('No changes recorded yet.')));
}
