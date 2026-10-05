// Clinic coordinator: follow-up reminders, drop-off list, lab work,
// retainers (made in-house), low ratings.
import { h, mount, rupees, shortDate, toast, friendlyError, modal, field, select, empty, todayISO } from '../../ui/dom.js';
import { state, can, branchName, myBranches, defaultBranchId } from '../../state.js';
import { patientSearch } from './common.js';
import { tabs } from './accounts.js';

const REMINDER_KINDS = { followup: 'Follow-up', appointment: 'Appointment due', installment: 'Installment', retainer: 'Retainer', lab: 'Lab', recall: 'Recall', dues: 'Dues' };
const REMINDER_STATUS = { open: 'Open', contacted: 'Contacted', no_answer: 'No answer', booked: 'Booked', done: 'Done', cancelled: 'Cancelled' };
const LAB_STATUS = { sent: 'Sent to lab', received: 'Received', fitted: 'Fitted', returned: 'Returned to lab', cancelled: 'Cancelled' };
const RETAINER_STAGES = { impression: 'Impression / scan', fabrication: 'Being made', ready: 'Ready', delivered: 'Delivered', follow_up: 'Follow-up check', replacement_needed: 'Needs replacement', closed: 'Closed' };

function pickPatient(onPick) {
  let chosen = null;
  const label = h('p', { class: 'muted' }, 'No patient chosen');
  const search = patientSearch({ onPick: (p) => { chosen = p; label.textContent = `${p.full_name} · Mr# ${p.mr_number}`; onPick?.(p); } });
  return { el: h('div', {}, search, label), get: () => chosen };
}

export async function renderCoordinator(root, params) {
  const available = [
    can('reminders.manage') && ['reminders', 'Reminders'],
    can('reminders.manage') && ['dropoffs', 'Drop-offs'],
    can('lab.manage') && ['lab', 'Lab work'],
    (can('retainers.manage') || can('patients.view')) && ['retainers', 'Retainers'],
    can('reminders.manage') && ['ratings', 'Low ratings'],
  ].filter(Boolean);
  let tab = params.get('tab') || available[0]?.[0];
  const head = h('div', {});
  const body = h('div', {});
  const pick = (k) => { tab = k; history.replaceState(null, '', `#/staff/coordinator?tab=${k}`); draw(); };
  async function draw() {
    mount(head, tabs(available, tab, pick));
    try {
      if (tab === 'reminders') await reminders(body, draw);
      else if (tab === 'dropoffs') await dropoffs(body);
      else if (tab === 'lab') await lab(body, draw);
      else if (tab === 'retainers') await retainers(body, draw);
      else await ratings(body);
    } catch (e) { mount(body, empty(friendlyError(e))); }
  }
  mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'Coordinator')), head, body);
  await draw();
}

async function reminders(root, redraw) {
  const d = state.data;
  const rows = await d.reminders();
  const today = todayISO();
  const add = () => {
    const pp = pickPatient();
    const kind = select(Object.entries(REMINDER_KINDS).map(([value, label]) => ({ value, label })), 'followup');
    const due = h('input', { type: 'date', value: today });
    const note = h('input', { placeholder: 'What to remind about' });
    modal('New reminder', h('div', {}, pp.el, h('div', { class: 'form-grid' }, field('Type', kind), field('Due', due)), field('Note', note)), [
      { label: 'Cancel' },
      { label: 'Save', primary: true, onClick: async () => {
        if (!pp.get()) { toast('Choose a patient.'); return false; }
        try { await d.saveReminder({ patient_id: pp.get().id, kind: kind.value, due_date: due.value, note: note.value, branch_id: defaultBranchId() }); redraw(); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  };
  mount(root, h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Who to call'), h('button', { class: 'btn btn-primary btn-small', onclick: add }, 'New reminder')),
    rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Due'), h('th', {}, 'Patient'), h('th', {}, 'Type'), h('th', {}, 'Note'), h('th', {}, 'Status'))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', { class: 'nowrap', style: { color: r.due_date < today && r.status === 'open' ? 'var(--stop)' : '' } }, shortDate(r.due_date)),
        h('td', {}, h('a', { href: `#/staff/patient/${r.patient_id}` }, r.patient?.full_name), h('div', { class: 'muted' }, r.patient?.phone)),
        h('td', {}, REMINDER_KINDS[r.kind]), h('td', {}, r.note || ''),
        h('td', {}, select(Object.entries(REMINDER_STATUS).map(([value, label]) => ({ value, label })), r.status, {
          'aria-label': 'Reminder status', style: { minWidth: '130px' },
          onchange: async (e) => { try { await d.saveReminder({ id: r.id, status: e.target.value, last_contacted_at: new Date().toISOString() }); toast('Updated.', 'ok'); } catch (err) { toast(friendlyError(err), 'error'); } },
        }))))))) : empty('Nothing to follow up. Add a reminder when a patient needs a call.')));
}

async function dropoffs(root) {
  const rows = await state.data.dropoffs();
  mount(root, h('section', { class: 'panel' },
    h('h2', {}, 'Braces patients who have not come back'),
    h('p', { class: 'muted' }, `Active braces patients with no completed visit in the last ${state.ref.settings?.dropoff_days || 42} days.`),
    rows.length ? h('table', { class: 'list' }, h('tbody', {}, rows.map((r) => h('tr', {},
      h('td', {}, h('a', { href: `#/staff/patient/${r.patient?.id || r.patient_id}` }, r.patient?.full_name), h('div', { class: 'muted' }, r.patient?.phone)),
      h('td', {}, r.last_visit ? `Last visit ${shortDate(r.last_visit)}` : 'No visit yet'),
      h('td', { class: 'right' }, r.days_since !== null && r.days_since !== undefined ? `${r.days_since} days` : ''))))) : empty('Every braces patient has been seen recently.')));
}

async function lab(root, redraw) {
  const d = state.data;
  const rows = await d.labCases();
  const add = () => {
    const pp = pickPatient();
    const branch = select(myBranches().map((b) => ({ value: b.id, label: b.name })), defaultBranchId());
    const labName = h('input', { placeholder: 'In-house lab or lab name', value: 'In-house lab' });
    const work = h('input', { placeholder: 'Crown, veneers, denture, retainer…' });
    const due = h('input', { type: 'date' });
    const cost = h('input', { type: 'number', min: 0, placeholder: 'Rs' });
    modal('New lab case', h('div', {}, pp.el, h('div', { class: 'form-grid' }, field('Branch', branch), field('Lab', labName), field('Work', work), field('Expected back', due), field('Lab cost', cost))), [
      { label: 'Cancel' },
      { label: 'Save', primary: true, onClick: async () => {
        if (!pp.get() || !work.value.trim()) { toast('Choose a patient and write the work.'); return false; }
        try { await d.saveLabCase({ patient_id: pp.get().id, branch_id: Number(branch.value), lab_name: labName.value, work_type: work.value, due_date: due.value || null, cost: cost.value ? Number(cost.value) : null }); redraw(); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  };
  const today = todayISO();
  mount(root, h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Lab work'), h('button', { class: 'btn btn-primary btn-small', onclick: add }, 'New lab case')),
    rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Patient'), h('th', {}, 'Work'), h('th', {}, 'Lab'), h('th', {}, 'Sent'), h('th', {}, 'Due'), h('th', { class: 'right' }, 'Cost'), h('th', {}, 'Status'))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', {}, h('a', { href: `#/staff/patient/${r.patient_id}` }, r.patient?.full_name), h('div', { class: 'muted' }, branchName(r.branch_id))),
        h('td', {}, r.work_type), h('td', {}, r.lab_name), h('td', { class: 'nowrap' }, shortDate(r.sent_date)),
        h('td', { class: 'nowrap', style: { color: r.due_date && r.due_date < today && r.status === 'sent' ? 'var(--stop)' : '' } }, shortDate(r.due_date)),
        h('td', { class: 'right' }, r.cost ? rupees(r.cost) : ''),
        h('td', {}, can('lab.manage') ? select(Object.entries(LAB_STATUS).map(([value, label]) => ({ value, label })), r.status, {
          'aria-label': 'Lab status', style: { minWidth: '140px' },
          onchange: async (e) => {
            const patch = { id: r.id, status: e.target.value };
            if (e.target.value === 'received') patch.received_date = today;
            if (e.target.value === 'fitted') patch.fitted_date = today;
            try { await d.saveLabCase(patch); toast('Updated.', 'ok'); } catch (err) { toast(friendlyError(err), 'error'); }
          },
        }) : LAB_STATUS[r.status])))))) : empty('No lab cases yet.')));
}

async function retainers(root, redraw) {
  const d = state.data;
  const rows = await d.retainerCases();
  const add = () => {
    const pp = pickPatient();
    const arch = select([{ value: 'both', label: 'Upper and lower' }, { value: 'upper', label: 'Upper' }, { value: 'lower', label: 'Lower' }], 'both');
    const type = h('input', { placeholder: 'Type (optional)' });
    const price = h('input', { type: 'number', min: 0, placeholder: 'Rs' });
    const labCost = h('input', { type: 'number', min: 0, placeholder: 'In-house cost (Rs)' });
    const repl = h('input', { type: 'checkbox' });
    const reason = h('input', { placeholder: 'If a repeat, why?' });
    modal('New retainer', h('div', {}, pp.el, h('div', { class: 'form-grid' }, field('Arch', arch), field('Type', type), field('Price', price), field('Lab cost', labCost)),
      h('label', { class: 'inline' }, repl, 'Replacement or repeat'), field('Reason', reason)), [
      { label: 'Cancel' },
      { label: 'Save', primary: true, onClick: async () => {
        if (!pp.get()) { toast('Choose a patient.'); return false; }
        try { await d.saveRetainerCase({ patient_id: pp.get().id, arch: arch.value, retainer_type: type.value || null, price: price.value ? Number(price.value) : null, lab_cost: labCost.value ? Number(labCost.value) : null, is_replacement: repl.checked, repeat_reason: reason.value || null, branch_id: defaultBranchId() }); redraw(); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  };
  const stageDate = { fabrication: 'fabricated_date', ready: 'ready_date', delivered: 'delivered_date' };
  mount(root, h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Retainers (made in-house)'), can('retainers.manage') ? h('button', { class: 'btn btn-primary btn-small', onclick: add }, 'New retainer') : null),
    rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Patient'), h('th', {}, 'Arch'), h('th', {}, 'Impression'), h('th', { class: 'right' }, 'Lab cost'), h('th', {}, 'Stage'))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', {}, h('a', { href: `#/staff/patient/${r.patient_id}` }, r.patient?.full_name), r.is_replacement ? h('span', { class: 'badge badge-warn', style: { marginLeft: '6px' } }, 'Repeat') : null),
        h('td', {}, r.arch), h('td', { class: 'nowrap' }, shortDate(r.impression_date)), h('td', { class: 'right' }, r.lab_cost ? rupees(r.lab_cost) : ''),
        h('td', {}, can('retainers.manage') ? select(Object.entries(RETAINER_STAGES).map(([value, label]) => ({ value, label })), r.stage, {
          'aria-label': 'Retainer stage', style: { minWidth: '160px' },
          onchange: async (e) => {
            const patch = { id: r.id, stage: e.target.value };
            if (stageDate[e.target.value]) patch[stageDate[e.target.value]] = todayISO();
            try { await d.saveRetainerCase(patch); toast('Updated.', 'ok'); } catch (err) { toast(friendlyError(err), 'error'); }
          },
        }) : RETAINER_STAGES[r.stage])))))) : empty('No retainer cases yet.')));
}

async function ratings(root) {
  const rows = await state.data.lowRatings();
  mount(root, h('section', { class: 'panel' },
    h('h2', {}, 'Low ratings to follow up'),
    rows.length ? h('table', { class: 'list' }, h('tbody', {}, rows.map((r) => h('tr', {},
      h('td', {}, h('a', { href: `#/staff/patient/${r.patient_id}` }, r.patient?.full_name), h('div', { class: 'muted' }, r.patient?.phone)),
      h('td', {}, '★'.repeat(r.stars) + '☆'.repeat(5 - r.stars)),
      h('td', {}, r.comment || ''),
      h('td', { class: 'nowrap muted' }, shortDate(String(r.created_at).slice(0, 10))))))) : empty('No low ratings. Patients are happy.')));
}
