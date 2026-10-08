// Clinic coordinator: follow-up reminders, drop-off list, lab work,
// retainers (made in-house), low ratings.
import { h, mount, rupees, shortDate, toast, friendlyError, modal, field, select, empty, phoneLink, tabs, localISO, addMonthsISO, srOnly, announce, showFormErrors, clearFieldErrors, busy } from '../../ui/dom.js';
import { state, can, branchName, myBranches, defaultBranchId } from '../../state.js';
import { patientSearch, commitOnFinish, capNote } from './common.js';

const REMINDER_KINDS = { followup: 'Follow-up', appointment: 'Appointment due', installment: 'Installment', retainer: 'Retainer', lab: 'Lab', recall: 'Recall', dues: 'Dues' };
const REMINDER_STATUS = { open: 'Open', contacted: 'Contacted', no_answer: 'No answer', booked: 'Booked', done: 'Done', cancelled: 'Cancelled' };
const LAB_STATUS = { sent: 'Sent to lab', received: 'Received', fitted: 'Fitted', returned: 'Returned to lab', cancelled: 'Cancelled' };
const RETAINER_STAGES = { impression: 'Impression / scan', fabrication: 'Being made', ready: 'Ready', delivered: 'Delivered', follow_up: 'Follow-up check', replacement_needed: 'Needs replacement', closed: 'Closed' };
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

export async function renderCoordinator(root, params) {
  const available = [
    can('reminders.manage') && ['reminders', 'Reminders'],
    can('reminders.manage') && ['dropoffs', 'Drop-offs'],
    can('lab.manage') && ['lab', 'Lab work'],
    (can('retainers.manage') || can('patients.view')) && ['retainers', 'Retainers'],
    can('reminders.manage') && ['ratings', 'Low ratings'],
  ].filter(Boolean);
  let tab = available.some(([k]) => k === params.get('tab')) ? params.get('tab') : available[0]?.[0];
  const panel = h('div', {});
  // Each draw gets a number. A list that arrives after the person has moved to another tab (or
  // after a newer draw) finds its number out of date and leaves the panel alone.
  let gen = 0;
  async function draw() {
    const mine = ++gen;
    const live = () => mine === gen;
    try {
      if (tab === 'reminders') await reminders(panel, draw, live);
      else if (tab === 'dropoffs') await dropoffs(panel, live);
      else if (tab === 'lab') await lab(panel, draw, live);
      else if (tab === 'retainers') await retainers(panel, draw, live);
      else await ratings(panel, draw, live);
    } catch (e) { if (live()) mount(panel, empty(friendlyError(e))); }
  }
  // The tab strip is built once; choosing a tab only redraws the panel (role=tabpanel, linked by
  // tabs()), so focus stays on the tab.
  const strip = tabs({
    label: 'Coordinator lists', items: available.map(([id, label]) => ({ id, label })), current: tab, panel,
    onChange: (k) => { tab = k; history.replaceState(null, '', `#/staff/coordinator?tab=${k}`); draw(); },
  });
  const hint = srOnly('Choices save when you press Enter or move to the next control. Escape undoes a change that is not saved yet.');
  hint.id = COMMIT_HINT;
  mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'Coordinator')), hint, strip.el, panel);
  await draw();
}

async function reminders(root, redraw, live) {
  const d = state.data;
  const [rows, due] = await Promise.all([d.reminders(), d.installmentsDue ? d.installmentsDue().catch(() => []) : []]);
  if (!live()) return;
  const today = localISO();
  const installmentsPanel = due.length ? h('section', { class: 'panel' },
    h('h2', {}, 'Installments due'),
    h('p', { class: 'muted' }, 'From installment plans on patient pages. Overdue first; "due soon" is within a week.'),
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

async function lab(root, redraw, live) {
  const d = state.data;
  const rows = await d.labCases();
  if (!live()) return;
  const add = () => {
    const pp = pickPatient();
    const branch = select(myBranches().map((b) => ({ value: b.id, label: b.name })), defaultBranchId());
    const labName = h('input', { placeholder: 'In-house lab or lab name', value: 'In-house lab' });
    const work = h('input', { placeholder: 'Crown, veneers, denture, retainer…' });
    const dueDate = h('input', { type: 'date' });
    const cost = h('input', { type: 'number', min: 0, placeholder: 'Rs' });
    const body = h('div', {}, pp.el, h('div', { class: 'form-grid' }, field('Branch', branch), field('Lab', labName), field('Work', work, null, { required: true }), field('Expected back', dueDate), field('Lab cost', cost)));
    modal('New lab case', body, [
      { label: 'Cancel' },
      { label: 'Save', primary: true, onClick: async () => {
        const errors = [];
        if (!pp.get()) errors.push({ input: pp.input, message: 'Choose a patient: type a name, Mr# or phone and pick from the list.' });
        if (!work.value.trim()) errors.push({ input: work, message: 'Write the work, e.g. crown or retainer.' });
        if (errors.length) { showFormErrors(body, errors); return false; }
        clearFieldErrors(body);
        try { await d.saveLabCase({ patient_id: pp.get().id, branch_id: Number(branch.value), lab_name: labName.value, work_type: work.value, due_date: dueDate.value || null, cost: cost.value ? Number(cost.value) : null }); setTimeout(redraw); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  };
  const today = localISO();
  const labRow = (r) => {
    const late = () => !!r.due_date && r.due_date < today && r.status === 'sent';
    let dateTd = dueCell(r.due_date, late());
    const statusCell = can('lab.manage') ? statusSelect(LAB_STATUS, r.status, { label: `Lab status for ${r.patient?.full_name || 'patient'}, ${r.work_type || 'lab work'}`, key: `lab-${r.id}`, minWidth: '140px', save: async (value) => {
      const patch = { id: r.id, status: value };
      if (value === 'received') patch.received_date = today;
      if (value === 'fitted') patch.fitted_date = today;
      await d.saveLabCase(patch);
      r.status = value;
      const fresh = dueCell(r.due_date, late()); dateTd.replaceWith(fresh); dateTd = fresh;
    } }) : LAB_STATUS[r.status];
    return h('tr', {},
      h('td', {}, h('a', { href: `#/staff/patient/${r.patient_id}` }, r.patient?.full_name), h('div', { class: 'muted' }, branchName(r.branch_id))),
      h('td', {}, r.work_type), h('td', {}, r.lab_name), h('td', { class: 'nowrap' }, shortDate(r.sent_date)),
      dateTd,
      h('td', { class: 'right' }, r.cost ? rupees(r.cost) : ''),
      h('td', {}, statusCell));
  };
  remount(root, h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Lab work'), h('button', { class: 'btn btn-primary btn-small', dataset: { key: 'add' }, onclick: add }, 'New lab case')),
    capNote(rows, 'lab cases (newest first)', 'older cases are not listed'),
    rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Patient'), h('th', { scope: 'col' }, 'Work'), h('th', { scope: 'col' }, 'Lab'), h('th', { scope: 'col' }, 'Sent'), h('th', { scope: 'col' }, 'Due'), h('th', { scope: 'col', class: 'right' }, 'Cost'), h('th', { scope: 'col' }, 'Status'))),
      h('tbody', {}, rows.map(labRow)))) : empty('No lab cases yet.')));
}

async function retainers(root, redraw, live) {
  const d = state.data;
  const rows = await d.retainerCases();
  if (!live()) return;
  const add = () => {
    const pp = pickPatient();
    const arch = select([{ value: 'both', label: 'Upper and lower' }, { value: 'upper', label: 'Upper' }, { value: 'lower', label: 'Lower' }], 'both');
    const type = h('input', { placeholder: 'Type (optional)' });
    const price = h('input', { type: 'number', min: 0, placeholder: 'Rs' });
    const labCost = h('input', { type: 'number', min: 0, placeholder: 'In-house cost (Rs)' });
    const repl = h('input', { type: 'checkbox' });
    const reason = h('input', { placeholder: 'If a repeat, why?' });
    const body = h('div', {}, pp.el, h('div', { class: 'form-grid' }, field('Arch', arch), field('Type', type), field('Price', price), field('Lab cost', labCost)),
      h('label', { class: 'inline' }, repl, 'Replacement or repeat'), field('Reason', reason));
    modal('New retainer', body, [
      { label: 'Cancel' },
      { label: 'Save', primary: true, onClick: async () => {
        if (!pp.get()) { showFormErrors(body, [{ input: pp.input, message: 'Choose a patient: type a name, Mr# or phone and pick from the list.' }]); return false; }
        clearFieldErrors(body);
        try { await d.saveRetainerCase({ patient_id: pp.get().id, arch: arch.value, retainer_type: type.value || null, price: price.value ? Number(price.value) : null, lab_cost: labCost.value ? Number(labCost.value) : null, is_replacement: repl.checked, repeat_reason: reason.value || null, branch_id: defaultBranchId() }); setTimeout(redraw); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  };
  const stageDate = { fabrication: 'fabricated_date', ready: 'ready_date', delivered: 'delivered_date' };
  const today = localISO();
  const isLate = (r) => !!r.next_check_date && r.next_check_date < today && r.stage !== 'closed';
  const alertHost = h('div', {});
  const drawAlert = () => {
    const overdue = rows.filter(isLate);
    // On a cut-off list there may be more overdue checks than the ones shown.
    const atLeast = rows.truncated ? 'At least ' : '';
    mount(alertHost, overdue.length ? h('div', { class: 'alert alert-warning' }, `${atLeast}${overdue.length} retainer check${overdue.length > 1 ? 's are' : ' is'} overdue: `, overdue.slice(0, 6).map((r, i) => [i ? ', ' : '', h('a', { href: `#/staff/patient/${r.patient_id}` }, r.patient?.full_name || 'patient')]), overdue.length > 6 ? ', …' : '', '. Call them for a follow-up.') : null);
  };
  const nextCheckCell = (r) => {
    const late = isLate(r);
    if (!can('retainers.manage')) return dueCell(r.next_check_date, late);
    const input = h('input', { type: 'date', value: r.next_check_date || '', 'aria-label': `Next check for ${r.patient?.full_name || 'patient'}`, 'aria-describedby': COMMIT_HINT, style: { width: '150px' }, dataset: { key: `next-${r.id}` } });
    const ctl = commitOnFinish(input, async (value, previous) => {
      try { await d.saveRetainerCase({ id: r.id, next_check_date: value || null }); r.next_check_date = value || null; drawAlert(); toast('Next check saved.', 'ok'); } catch (err) { ctl.set(previous); toast(friendlyError(err), 'error'); }
    });
    return h('td', { class: 'nowrap' }, input, overdueBadge(late));
  };
  const retainerRow = (r) => {
    let nextTd = nextCheckCell(r);
    const stage = can('retainers.manage') ? statusSelect(RETAINER_STAGES, r.stage, { label: `Retainer stage for ${r.patient?.full_name || 'patient'}`, key: `stage-${r.id}`, minWidth: '160px', save: async (value) => {
      const patch = { id: r.id, stage: value };
      if (stageDate[value]) patch[stageDate[value]] = today;
      // Delivered → first check a month later (calendar month, Karachi date), unless a date is already set.
      if (value === 'delivered' && !r.next_check_date) patch.next_check_date = addMonthsISO(today, 1);
      if (value === 'closed') patch.next_check_date = null;
      await d.saveRetainerCase(patch);
      Object.assign(r, patch);
      // Update this row's check date and the overdue note in place (instead of redrawing the
      // whole table), so the stage select keeps focus.
      const fresh = nextCheckCell(r); nextTd.replaceWith(fresh); nextTd = fresh; drawAlert();
    } }) : RETAINER_STAGES[r.stage];
    return h('tr', {},
      h('td', {}, h('a', { href: `#/staff/patient/${r.patient_id}` }, r.patient?.full_name), r.is_replacement ? h('span', { class: 'badge badge-warn', style: { marginLeft: '6px' } }, 'Repeat') : null),
      h('td', {}, r.arch), h('td', { class: 'nowrap' }, shortDate(r.impression_date)), nextTd, h('td', { class: 'right' }, r.lab_cost ? rupees(r.lab_cost) : ''),
      h('td', {}, stage));
  };
  drawAlert();
  remount(root, h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Retainers (made in-house)'), can('retainers.manage') ? h('button', { class: 'btn btn-primary btn-small', dataset: { key: 'add' }, onclick: add }, 'New retainer') : null),
    capNote(rows, 'retainer cases (newest first)', 'older cases are not listed'),
    alertHost,
    rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Patient'), h('th', { scope: 'col' }, 'Arch'), h('th', { scope: 'col' }, 'Impression'), h('th', { scope: 'col' }, 'Next check'), h('th', { scope: 'col', class: 'right' }, 'Lab cost'), h('th', { scope: 'col' }, 'Stage'))),
      h('tbody', {}, rows.map(retainerRow)))) : empty('No retainer cases yet.')));
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
