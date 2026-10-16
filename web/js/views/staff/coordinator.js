// Clinic coordinator: follow-up reminders, drop-off list, low ratings. Lab work and the retainers have their own pages
// (lab.js, retainers.js, laid out like the clinic's Google Sheets); their old tabs here send people there. The overdue retainer
// checks the old Retainers tab warned about are still named over the tabs.
import { h, mount, rupees, shortDate, toast, friendlyError, modal, field, select, empty, phoneLink, tabs, localISO, srOnly, announce, showFormErrors, clearFieldErrors, busy } from '../../ui/dom.js';
import { state, can, defaultBranchId, cityName } from '../../state.js';
import { patientSearch, commitOnFinish, capNote } from './common.js';
import { retainerStatuses, checkOverdue } from '../../lib/records.js';

const REMINDER_KINDS = { followup: 'Follow-up', appointment: 'Appointment due', installment: 'Installment', retainer: 'Retainer', lab: 'Lab', recall: 'Recall', dues: 'Dues' };
const REMINDER_STATUS = { open: 'Open', contacted: 'Contacted', no_answer: 'No answer', booked: 'Booked', done: 'Done', cancelled: 'Cancelled' };
const COMMIT_HINT = 'coordinator-commit-hint';

const greeting = (p) => `Assalam o Alaikum ${(p?.full_name || '').split(' ')[0]}, this is Dr. Ali Rashid's Dental Clinic. `;
const options = (labels) => Object.entries(labels).map(([value, label]) => ({ value, label }));
// A date with an "Overdue" badge, so lateness is not shown by red text alone.
const overdueBadge = (late) => (late ? [' ', h('span', { class: 'badge badge-overdue' }, 'Overdue')] : null);
const dueCell = (iso, late) => h('td', { class: ['nowrap', late && 'status-bad'] }, shortDate(iso), overdueBadge(late));

// Re-render a list and put focus back on the same control (by data-key), or on the panel.
function remount(root, ...children) {
  const key = root.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  const hadFocus = root.contains(document.activeElement);
  mount(root, ...children);
  if (!hadFocus) return;
  const again = key && [...root.querySelectorAll('[data-key]')].find((el) => el.dataset.key === key);
  (again || root).focus();
}

// A status select that saves only once the person has finished choosing (Enter,
// leaving it, or a pick from the open list), then reverts if the save fails.
function statusSelect(labels, value, { label, key, minWidth, save }) {
  const sel = select(options(labels), value, { 'aria-label': label, 'aria-describedby': COMMIT_HINT, style: { minWidth }, dataset: { key } });
  const ctl = commitOnFinish(sel, async (next, previous) => {
    try { await save(next); toast('Updated.', 'ok'); } catch (err) { ctl.set(previous); toast(friendlyError(err), 'error'); }
  });
  return sel;
}

function pickPatient(onPick) {
  let chosen = null;
  const none = 'No patient chosen yet.';
  const status = h('p', { class: 'muted' }, none);
  const search = patientSearch({ label: 'Patient (required): search name, Mr# or phone', onPick: (p) => {
    chosen = p;
    status.textContent = `Selected: ${p.full_name} · Mr# ${p.mr_number}`;
    change.hidden = false;
    clearFieldErrors(el);
    onPick?.(p);
  } });
  const input = search.querySelector('input');
  input.required = true;
  input.setAttribute('aria-required', 'true');
  const change = h('button', { type: 'button', class: 'link-btn', hidden: true, onclick: () => {
    chosen = null; status.textContent = none; change.hidden = true; input.focus(); announce('Patient cleared. Search for another patient.');
  } }, 'Change patient');
  const el = h('div', { class: 'field' },
    h('span', { class: 'field-label' }, 'Patient', h('span', { class: 'req' }, ' (required)')),
    search, h('div', { class: 'inline' }, status, change));
  return { el, input, get: () => chosen };
}

// The old tabs of lab work and retainers, and where they are now.
const MOVED = { lab: '#/staff/lab', retainers: '#/staff/retainers' };

// The overdue retainer checks (the old Retainers tab warned about them; the Retainer Record sets the first check a month after delivery):
// every city this person may see, the names (a row linked to a patient file opens it) and, per city, a link to its tab of the Retainer
// Record showing only the overdue checks. Drawn when the list arrives, so the tabs never wait for it; when it cannot be read (the Retainer
// Record is not switched on yet) there is no warning.
function overdueChecks() {
  const host = h('div', {});
  if (!can('retainers.manage') && !can('patients.view')) return host;
  const today = localISO();
  const statuses = retainerStatuses(state.ref.settings);
  Promise.resolve(state.data.retainerChecksOverdue?.({ today })).then((list) => {
    const late = (list || []).filter((r) => checkOverdue(r, statuses, today));
    if (!late.length) return;
    const cities = [...new Set(late.map((r) => r.city_id))].sort((a, b) => a - b);
    mount(host, h('div', { class: 'alert alert-warning' },
      `${list.truncated ? 'At least ' : ''}${late.length} retainer check${late.length > 1 ? 's are' : ' is'} overdue: `,
      late.slice(0, 6).map((r, i) => [i ? ', ' : '', r.patient_id && r.patient ? h('a', { href: `#/staff/patient/${r.patient_id}` }, r.patient.full_name) : r.patient_name || 'a patient']),
      late.length > 6 ? ', …' : '', '. Call them for a follow-up. On the Retainer Record: ',
      cities.map((c, i) => [i ? ' · ' : '', h('a', { href: `#/staff/retainers?city=${c}&status=__overdue` }, `${cityName(c) || 'another city'} (${late.filter((r) => r.city_id === c).length})`)]), '.'));
  }).catch(() => { /* not switched on yet, or not readable: no warning */ });
  return host;
}

export async function renderCoordinator(root, params) {
  if (MOVED[params.get('tab')]) { location.replace(MOVED[params.get('tab')]); return; }
  const available = [
    can('reminders.manage') && ['reminders', 'Reminders'],
    can('reminders.manage') && ['dropoffs', 'Drop-offs'],
    can('reminders.manage') && ['ratings', 'Low ratings'],
  ].filter(Boolean);
  const moved = h('p', { class: 'muted' }, "Lab work and the retainers have their own pages, laid out like the clinic's sheets: ",
    h('a', { href: MOVED.lab }, 'Lab work'), ' and ', h('a', { href: MOVED.retainers }, 'Retainer Record'), '.');
  const checks = overdueChecks();
  if (!available.length) { mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'Coordinator')), checks, moved); return; }
  let tab = available.some(([k]) => k === params.get('tab')) ? params.get('tab') : available[0]?.[0];
  const panel = h('div', {});
  // Each draw gets a number. A list that arrives after the person has moved to another tab (or
  // after a newer draw) finds its number out of date and leaves the panel alone.
  let gen = 0;
  // The tab whose list is in the panel right now (null while it holds a note). Choosing another tab clears
  // the panel at once, so the old list, with its live status selects, never sits under the new tab's name
  // while the new one loads (reads can take 20 seconds on a bad connection). A redraw of the same tab after
  // a save keeps the list in place instead, so it does not flash and the focus restore in remount() still works.
  let shown = null;
  async function draw() {
    const mine = ++gen;
    const live = () => mine === gen;
    if (shown !== tab) { shown = null; mount(panel, h('p', { class: 'muted' }, 'Loading…')); }
    panel.setAttribute('aria-busy', 'true');
    try {
      if (tab === 'reminders') await reminders(panel, draw, live);
      else if (tab === 'dropoffs') await dropoffs(panel, live);
      else await ratings(panel, draw, live);
      if (live()) shown = tab;
    } catch (e) {
      if (live()) { mount(panel, empty(friendlyError(e))); shown = null; }
    } finally {
      if (live()) panel.removeAttribute('aria-busy');
    }
  }
  // The tab strip is built once; choosing a tab only redraws the panel (role=tabpanel, linked by
  // tabs()), so focus stays on the tab.
  const strip = tabs({
    label: 'Coordinator lists', items: available.map(([id, label]) => ({ id, label })), current: tab, panel,
    onChange: (k) => { tab = k; history.replaceState(null, '', `#/staff/coordinator?tab=${k}`); draw(); },
  });
  const hint = srOnly('Choices save when you press Enter or move to the next control. Escape undoes a change that is not saved yet.');
  hint.id = COMMIT_HINT;
  mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'Coordinator')), checks, moved, hint, strip.el, panel);
  await draw();
}

async function reminders(root, redraw, live) {
  const d = state.data;
  const [rows, due] = await Promise.all([d.reminders(), d.installmentsDue ? d.installmentsDue().catch(() => []) : []]);
  if (!live()) return;
  const today = localISO();
  // Each patient's installments, one row each, and never a sum (owner, 16 Oct 2026: "yes pending dues should only be seen for per patient
  // and not totals"). The coordinator ("Edit or void invoices") and the front desk ("Create invoices and take payments") get the plans of
  // the patients of their branches (20261016000100), the front desk also the plans it made; Dr. Ali and accounts (billing.view) every
  // plan. "Behind by" counts the patient's payments at every branch.
  const installmentsPanel = due.length ? h('section', { class: 'panel installments-due' },
    h('h2', {}, 'Installments due'),
    h('p', { class: 'muted' }, 'From installment plans on patient pages, one row per installment of each patient. Overdue first; "due soon" is within a week. The clinic\'s totals are with accounts.'),
    h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Due'), h('th', { scope: 'col' }, 'Patient'), h('th', { scope: 'col' }, 'Installment'), h('th', { scope: 'col', class: 'right' }, 'Amount'), h('th', { scope: 'col', class: 'right' }, 'Behind by'), h('th', { scope: 'col' }, 'Status'))),
      h('tbody', {}, due.map((r) => h('tr', {},
        h('td', { class: ['nowrap', r.status === 'overdue' && 'status-bad'] }, shortDate(r.due_date)),
        h('td', {}, h('a', { href: `#/staff/patient/${r.patient_id}` }, r.patient?.full_name), h('div', { class: 'muted' }, phoneLink(r.patient?.phone, greeting(r.patient)))),
        h('td', {}, r.note || ''), h('td', { class: 'right' }, rupees(r.amount)), h('td', { class: 'right' }, rupees(r.remaining)),
        h('td', {}, h('span', { class: ['badge', r.status === 'overdue' ? 'badge-overdue' : 'badge-warn'] }, r.status === 'overdue' ? 'Overdue' : 'Due soon')))))))) : null;
  const add = () => {
    const pp = pickPatient();
    const kind = select(options(REMINDER_KINDS), 'followup');
    const dueDate = h('input', { type: 'date', value: today });
    const note = h('input', { placeholder: 'What to remind about' });
    const body = h('div', {}, pp.el, h('div', { class: 'form-grid' }, field('Type', kind), field('Due', dueDate)), field('Note', note));
    modal('New reminder', body, [
      { label: 'Cancel' },
      { label: 'Save', primary: true, onClick: async () => {
        if (!pp.get()) { showFormErrors(body, [{ input: pp.input, message: 'Choose a patient: type a name, Mr# or phone and pick from the list.' }]); return false; }
        clearFieldErrors(body);
        try { await d.saveReminder({ patient_id: pp.get().id, kind: kind.value, due_date: dueDate.value, note: note.value, branch_id: defaultBranchId() }); setTimeout(redraw); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  };
  const reminderRow = (r) => {
    const late = () => r.due_date < today && r.status === 'open';
    let dateTd = dueCell(r.due_date, late());
    const who = r.patient?.full_name || 'patient';
    const status = statusSelect(REMINDER_STATUS, r.status, { label: `Reminder status for ${who}`, key: `reminder-${r.id}`, minWidth: '130px', save: async (value) => {
      await d.saveReminder({ id: r.id, status: value, last_contacted_at: new Date().toISOString() });
      r.status = value;
      const fresh = dueCell(r.due_date, late()); dateTd.replaceWith(fresh); dateTd = fresh;
    } });
    return h('tr', {}, dateTd,
      h('td', {}, h('a', { href: `#/staff/patient/${r.patient_id}` }, r.patient?.full_name), h('div', { class: 'muted' }, phoneLink(r.patient?.phone, greeting(r.patient)))),
      h('td', {}, REMINDER_KINDS[r.kind]), h('td', {}, r.note || ''),
      h('td', {}, status));
  };
  remount(root, installmentsPanel, h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Who to call'), h('button', { class: 'btn btn-primary btn-small', dataset: { key: 'add' }, onclick: add }, 'New reminder')),
    capNote(rows, 'reminders (earliest due first)', 'later reminders are not listed'),
    rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Due'), h('th', { scope: 'col' }, 'Patient'), h('th', { scope: 'col' }, 'Type'), h('th', { scope: 'col' }, 'Note'), h('th', { scope: 'col' }, 'Status'))),
      h('tbody', {}, rows.map(reminderRow)))) : empty('Nothing to follow up. Add a reminder when a patient needs a call.')));
}

async function dropoffs(root, live) {
  const rows = await state.data.dropoffs();
  if (!live()) return;
  remount(root, h('section', { class: 'panel' },
    h('h2', {}, 'Braces patients who have not come back'),
    h('p', { class: 'muted' }, `Active braces patients with no completed visit in the last ${state.ref.settings?.dropoff_days || 42} days.`),
    rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Patient'), h('th', { scope: 'col' }, 'Last visit'), h('th', { scope: 'col', class: 'right' }, 'Days since'))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', {}, h('a', { href: `#/staff/patient/${r.patient?.id || r.patient_id}` }, r.patient?.full_name), h('div', { class: 'muted' }, phoneLink(r.patient?.phone, greeting(r.patient)))),
        h('td', {}, r.last_visit ? shortDate(r.last_visit) : 'No visit yet'),
        h('td', { class: 'right' }, r.days_since !== null && r.days_since !== undefined ? `${r.days_since} days` : '')))))) : empty('Every braces patient has been seen recently.')));
}

async function ratings(root, redraw, live) {
  const d = state.data;
  const rows = await d.lowRatings();
  if (!live()) return;
  remount(root, h('section', { class: 'panel' },
    h('h2', {}, 'Low ratings to follow up'),
    h('p', { class: 'muted' }, 'Call the patient, then mark the rating as followed up so it leaves this list.'),
    rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Patient'), h('th', { scope: 'col' }, 'Rating'), h('th', { scope: 'col' }, 'Comment'), h('th', { scope: 'col' }, 'Date'), h('th', { scope: 'col', class: 'right' }, 'Follow-up'))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', {}, h('a', { href: `#/staff/patient/${r.patient_id}` }, r.patient?.full_name), h('div', { class: 'muted' }, phoneLink(r.patient?.phone, greeting(r.patient)))),
        h('td', { class: 'nowrap' }, h('span', { 'aria-hidden': 'true' }, '★'.repeat(r.stars) + '☆'.repeat(5 - r.stars)), srOnly(`${r.stars} of 5 stars`)),
        h('td', {}, r.comment || ''),
        h('td', { class: 'nowrap muted' }, shortDate(String(r.created_at).slice(0, 10))),
        h('td', { class: 'right' }, can('reminders.manage') ? h('button', { class: 'btn btn-small', dataset: { key: `followup-${r.visit_id}` }, 'aria-label': `Followed up: ${r.patient?.full_name || 'patient'}, ${r.stars} of 5 stars`, onclick: busy(async () => {
          // Redraw after busy() has given focus back to this button, so remount() can move it on.
          // The tab's own draw() shows the error in the panel if the new list cannot be fetched.
          try { await d.followUpRating(r.visit_id); toast('Marked as followed up.', 'ok'); setTimeout(redraw); } catch (e) { toast(friendlyError(e), 'error'); }
        }) }, 'Followed up') : null)))))) : empty('No low ratings waiting. Patients are happy.')));
}
