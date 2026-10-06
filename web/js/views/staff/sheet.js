// Aaj ki List: the daily sheet, Google Sheets style. Every change saves by
// itself; if the internet drops, changes wait on this device and are sent
// when it comes back.
import { h, mount, toast, friendlyError, todayISO, rupees, modal, select, timeOf, $$ } from '../../ui/dom.js';
import { state, can, myBranches, defaultBranchId, branchName } from '../../state.js';
import { AutosaveQueue, PermanentSaveError } from '../../lib/autosave.js';
import { protocolFor, canTreat, canCheck, guidance as protocolGuidance } from '../../lib/protocol.js';
import { STATUS_LABELS, duesBadge, aliBadge, patientSearch, newPatientModal, flagForAliModal, photoUploadModal, guidancePanel } from './common.js';
import { newInvoiceModal, paymentModal } from './invoice.js';

const NETWORK = /Failed to fetch|NetworkError|network|timeout|Load failed/i;

let queue;
let saveStateEl;

function getQueue() {
  if (queue) return queue;
  let store;
  try { store = window.localStorage; store.getItem('x'); } catch { store = { getItem: () => null, setItem: () => {} }; }
  queue = new AutosaveQueue({
    store,
    storageKey: 'aaj-ki-list-pending-v1',
    send: async (edit) => {
      try {
        await state.data.updateVisit(edit.rowId, edit.changes);
      } catch (e) {
        const msg = e?.message || String(e);
        if (NETWORK.test(msg)) throw e;
        toast(friendlyError(e), 'error', 7000);
        document.dispatchEvent(new CustomEvent('sheet-reload'));
        throw new PermanentSaveError(msg);
      }
    },
    onState: (s, pending) => {
      if (!saveStateEl) return;
      saveStateEl.dataset.state = s;
      saveStateEl.textContent = s === 'saved' ? 'All changes saved' : s === 'saving' ? `Saving ${pending || ''}…` : s === 'offline' ? `Offline: ${pending} change${pending === 1 ? '' : 's'} waiting` : 'Some changes could not be saved';
    },
  });
  window.addEventListener('online', () => queue.setOnline(true));
  window.addEventListener('offline', () => queue.setOnline(false));
  if (!navigator.onLine) queue.setOnline(false);
  window.addEventListener('beforeunload', (e) => { if (queue.pendingCount) { e.preventDefault(); e.returnValue = ''; } });
  return queue;
}

export async function renderSheet(root, params) {
  const d = state.data;
  const q = getQueue();
  const branches = myBranches();
  let branchId = Number(params.get('branch')) || defaultBranchId();
  let date = params.get('date') || todayISO();
  let rows = [];
  let filter = '';

  saveStateEl = h('span', { class: 'save-state', dataset: { state: 'saved' } }, 'All changes saved');
  const tableBody = h('tbody', {});
  const counts = h('span', { class: 'muted' });

  const branchSel = select(branches.map((b) => ({ value: b.id, label: b.name })), branchId, {
    'aria-label': 'Branch', onchange: (e) => { branchId = Number(e.target.value); setURL(); load(); },
  });
  const dateInput = h('input', { type: 'date', value: date, 'aria-label': 'Date', onchange: (e) => { date = e.target.value; setURL(); load(); } });
  const filterSel = select([{ value: '', label: 'All statuses' }, ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))], '', {
    'aria-label': 'Filter', onchange: (e) => { filter = e.target.value; draw(); },
  });
  const setURL = () => history.replaceState(null, '', `#/staff/sheet?branch=${branchId}&date=${date}`);

  async function load() {
    try {
      rows = await d.listVisits({ branchId, date });
      draw();
    } catch (e) { toast(friendlyError(e), 'error'); }
  }

  // ---------------------------------------------------------------- cells
  const canEdit = can('sheet.edit');
  const canTreatment = can('treatment.enter') || canEdit;

  function save(row, field, value) {
    row[field] = value;
    q.edit('visits', row.id, field, value);
  }

  async function changeStatus(row, value, el) {
    const before = row.status;
    try {
      const updated = await d.updateVisit(row.id, { status: value });
      Object.assign(row, updated);
      redrawRow(row);
      if (value === 'in_treatment' && updated.dues > 0 && can('dues.view')) {
        toast(`Clear dues first: ${rupees(updated.dues)} pending.`, 'error', 6000);
      }
    } catch (e) {
      el.value = before;
      el.className = `status-chip status-${before}`;
      const msg = friendlyError(e);
      if (/dues/i.test(e.message) && can('dues.override')) {
        modal('Pending dues', h('p', {}, msg), [
          { label: 'Cancel' },
          { label: 'Override and start treatment', primary: true, onClick: async () => {
            try { Object.assign(row, await d.updateVisit(row.id, { status: value, dues_override_by: true, dues_override_reason: 'Override from Aaj ki List' })); redrawRow(row); } catch (err) { toast(friendlyError(err), 'error'); }
          } },
        ]);
      } else toast(msg, 'error', 7000);
    }
  }

  function peopleCell(row) {
    const rule = row.braces_month ? protocolFor(row.braces_month) : null;
    const chips = row.staff.map((s) => h('span', { class: ['person', s.role] }, s.role === 'checker' ? '✓ ' : '', s.name || 'Unknown',
      canTreatment ? h('button', { 'aria-label': `Remove ${s.name}`, onclick: async () => {
        try { Object.assign(row, await d.setVisitStaff(row.id, s.clinician_id, s.role, false)); redrawRow(row); } catch (e) { toast(friendlyError(e), 'error'); }
      } }, '×') : null));
    const add = canTreatment ? h('button', { class: 'add-person', onclick: () => pickPeople(row) }, '+ add') : null;
    const hint = rule ? h('span', { class: 'muted', style: { fontSize: '11.5px' } }, `G${rule.treatingGroups.join('/')}${rule.checkerGroup ? ` · check G${rule.checkerGroup}` : ''}`) : null;
    return h('div', { class: 'people' }, chips, add, hint);
  }

  function pickPeople(row) {
    const month = row.braces_month;
    const role = select([{ value: 'doctor', label: 'Doctor' }, { value: 'assistant', label: 'Assistant / hygienist' }, { value: 'checker', label: 'Checked by' }], 'doctor');
    const listHost = h('div', { class: 'stack', style: { maxHeight: '50vh', overflow: 'auto' } });
    const drawList = () => {
      const r = role.value;
      const people = state.ref.clinicians.filter((c) => (r === 'assistant' ? !c.is_doctor : c.is_doctor));
      const isAli = (c) => c.display_name === 'Dr. Ali Rashid';
      mount(listHost, h('div', { class: 'inline' }, people.map((c) => {
        const allowed = !month || !c.is_doctor || (r === 'doctor' ? canTreat(month, c.doctor_group_id, isAli(c)) : r === 'checker' ? canCheck(month, c.doctor_group_id, isAli(c)) : true);
        return h('button', {
          class: ['btn btn-small', !allowed && 'btn-danger'], title: allowed ? '' : 'Not in the group for this braces month',
          onclick: async () => {
            try { Object.assign(row, await d.setVisitStaff(row.id, c.id, r, true)); redrawRow(row); toast(`${c.display_name} added.`, 'ok'); } catch (e) { toast(friendlyError(e), 'error', 7000); }
          },
        }, c.display_name, c.doctor_group_id ? h('span', { class: 'muted' }, ` G${c.doctor_group_id}`) : '');
      })));
    };
    role.addEventListener('change', drawList);
    drawList();
    modal(`Who treated ${row.patient.full_name}?`, h('div', {},
      month ? h('p', { class: 'muted' }, `Braces month ${month}: treated by Group ${protocolFor(month).treatingGroups.join(' or ')}${protocolFor(month).checkerGroup ? `, checked by Group ${protocolFor(month).checkerGroup}` : ''}. Names in red are not allowed this month.`) : null,
      role, listHost), [{ label: 'Done', primary: true }]);
  }

  async function openRow(row) {
    let g = row.braces_month ? await d.bracesGuidance(row.patient_id).catch(() => null) : null;
    // Guidance is for this row's month (a completed visit is no longer the "next" month).
    if (g?.has_active_case && g.month !== row.braces_month) {
      const local = protocolGuidance({ month: row.braces_month, extractionPlan: g.extraction_plan || 'undecided',
        extractionsDone: !!g.extractions_done, hasDrAliPlan: !!g.has_dr_ali_plan, dues: row.dues });
      g = { ...g, month: row.braces_month, treating_groups: local.rule.treatingGroups, checker_group: local.rule.checkerGroup,
        planned_wire: local.rule.plannedWire, photo_required: local.rule.photoRequired && !local.beyondProtocol,
        rule_confirmed: local.rule.confirmed && !local.beyondProtocol, alerts: local.alerts };
    }
    const actions = [
      can('photos.upload') ? h('button', { class: 'btn', onclick: () => photoUploadModal(row.patient, { visitId: row.id, branchId: row.branch_id, onDone: load }) }, 'Upload photos') : null,
      can('billing.create') ? h('button', { class: 'btn', onclick: () => newInvoiceModal(row.patient, { branchId: row.branch_id, visitId: row.id, onDone: load }) }, 'New invoice') : null,
      can('billing.create') ? h('button', { class: 'btn', onclick: () => paymentModal(row.patient, { branchId: row.branch_id, dues: row.dues, onDone: load }) }, 'Take payment') : null,
      can('flags.raise') && !row.see_dr_ali ? h('button', { class: 'btn', onclick: () => flagForAliModal(row.patient, load) }, 'Next appointment with Dr. Ali') : null,
      h('a', { class: 'btn', href: `#/staff/patient/${row.patient_id}` }, 'Open profile'),
    ];
    modal(`${row.patient.full_name} · Mr# ${row.patient.mr_number}`, h('div', {},
      row.dues > 0 && can('dues.view') ? h('div', { class: 'alert alert-stop' }, `Pending dues ${rupees(row.dues)}. Clear dues before treatment.`) : null,
      row.see_dr_ali ? h('div', { class: 'alert alert-warning' }, 'Flagged: next appointment should be with Dr. Ali Rashid.') : null,
      g ? guidancePanel(g) : null,
      h('div', { class: 'inline', style: { marginTop: '10px' } }, actions)), []);
  }

  function rowEl(row) {
    const status = h('select', {
      class: `status-chip status-${row.status}`, 'aria-label': 'Status', disabled: !canEdit,
      onchange: (e) => { e.target.className = `status-chip status-${e.target.value}`; changeStatus(row, e.target.value, e.target); },
    }, Object.entries(STATUS_LABELS).map(([value, label]) => h('option', { value, selected: value === row.status }, label)));

    const treatment = h('input', {
      class: 'cell-input', value: row.treatment_label || '', list: 'sheet-treatments', disabled: !canEdit, 'aria-label': 'Treatment',
      onchange: (e) => save(row, 'treatment_label', e.target.value),
    });
    const details = h('input', {
      class: 'cell-input', value: row.details_text || '', disabled: !canTreatment, placeholder: 'e.g. U L 018 PC refresh', 'aria-label': 'Treatment details',
      oninput: (e) => save(row, 'details_text', e.target.value),
    });
    const notes = h('input', {
      class: 'cell-input', value: row.notes || '', disabled: !canEdit, 'aria-label': 'Notes',
      oninput: (e) => save(row, 'notes', e.target.value),
    });
    const month = row.braces_month
      ? h('button', { class: 'link-btn month-pill', onclick: () => openRow(row), title: 'Braces guidance for this month' },
        String(row.braces_month).padStart(2, '0'), row.photo_required ? h('span', { class: ['badge', row.photos_uploaded ? 'badge-ok' : 'badge-photo'], style: { marginLeft: '4px' } }, row.photos_uploaded ? 'Photo ✓' : '📸 Photo') : null)
      : h('span', { class: 'muted' }, '–');

    return h('tr', { dataset: { id: row.id } },
      h('td', { class: 'frozen' }, h('div', { class: 'cell' },
        h('span', { class: 'token', title: row.checked_in_at ? `Arrived ${timeOf(row.checked_in_at)}` : '' }, row.token_no ?? '–'),
        h('button', { class: 'link-btn', style: { textDecoration: 'none', textAlign: 'left' }, onclick: () => openRow(row) },
          h('div', {}, row.patient.full_name), h('div', { class: 'muted', style: { fontSize: '12px', fontWeight: 500 } }, `Mr# ${row.patient.mr_number}`)))),
      h('td', {}, h('div', { class: 'cell row-flags' }, duesBadge(row.dues), aliBadge(row.see_dr_ali))),
      h('td', {}, h('div', { class: 'cell' }, month)),
      h('td', { style: { minWidth: '150px' } }, treatment),
      h('td', {}, h('div', { class: 'cell' }, status)),
      h('td', { style: { minWidth: '250px' } }, peopleCell(row)),
      h('td', { style: { minWidth: '230px' } }, details),
      h('td', { class: 'right' }, h('div', { class: 'cell', style: { justifyContent: 'flex-end', fontWeight: 700, color: row.dues > 0 ? 'var(--stop)' : 'var(--muted)' } }, can('dues.view') ? (row.dues > 0 ? rupees(row.dues) : '0') : '')),
      h('td', { style: { minWidth: '160px' } }, notes),
      h('td', {}, h('div', { class: 'cell muted nowrap' }, row.patient.phone)));
  }

  function redrawRow(row) {
    const old = tableBody.querySelector(`tr[data-id="${row.id}"]`);
    if (old) old.replaceWith(rowEl(row));
    drawCounts();
  }

  function drawCounts() {
    const by = (s) => rows.filter((r) => r.status === s).length;
    counts.textContent = `${rows.length} patients · ${by('waiting')} waiting · ${by('in_treatment')} in treatment · ${by('completed')} completed`;
  }

  function draw() {
    const shown = filter ? rows.filter((r) => r.status === filter) : rows;
    mount(tableBody, shown.length ? shown.map(rowEl) : h('tr', {}, h('td', { colspan: 10 }, h('div', { class: 'empty' }, `No patients on the list for ${branchName(branchId)} on this day yet. Use "Add a patient" above to add them.`))));
    drawCounts();
  }

  // Arrow keys / Enter move between cells like a spreadsheet.
  function onKey(e) {
    if (!['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key) || !e.target.classList.contains('cell-input')) return;
    const td = e.target.closest('td');
    const tr = td.parentElement;
    const col = [...tr.children].indexOf(td);
    const target = e.key === 'ArrowUp' ? tr.previousElementSibling : tr.nextElementSibling;
    const next = target?.children[col]?.querySelector('.cell-input');
    if (next) { e.preventDefault(); next.focus(); next.select?.(); }
  }

  async function addPatient(p) {
    try {
      const braces = !!p.braces_active;
      const row = await d.addVisit({ patient_id: p.id, branch_id: branchId, visit_date: date, treatment_label: braces ? 'Monthly' : 'Checkup', braces, status: date === todayISO() ? 'waiting' : 'scheduled' });
      rows.push(row);
      draw();
      toast(`${p.full_name} added${row.token_no ? ` with token ${row.token_no}` : ''}.`, 'ok');
      if (row.braces_month) openRow(row);
    } catch (e) { toast(friendlyError(e), 'error'); }
  }

  const search = canEdit ? patientSearch({
    placeholder: 'Add patient: search name, Mr# or phone',
    onPick: addPatient,
    onNew: async (text) => { const p = await newPatientModal(text, branchId); if (p) addPatient(p); },
  }) : null;

  const onReload = () => load();
  document.addEventListener('sheet-reload', onReload);
  // Pick up other people's changes every 20 seconds while nobody is typing.
  const poll = setInterval(() => {
    if (!document.body.contains(tableBody)) { clearInterval(poll); document.removeEventListener('sheet-reload', onReload); return; }
    if (!q.pendingCount && !tableBody.contains(document.activeElement) && !document.querySelector('.modal')) load();
  }, 20000);

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Aaj ki List'), h('p', {}, counts)),
      saveStateEl),
    h('div', { class: 'sheet-toolbar' }, branchSel, dateInput, filterSel,
      h('button', { class: 'btn', onclick: () => { date = todayISO(); dateInput.value = date; setURL(); load(); } }, 'Today'),
      h('a', { class: 'btn', href: `#/staff/queue?branch=${branchId}` }, 'Queue board')),
    search ? h('div', { class: 'add-panel' },
      h('div', { class: 'add-panel-text' },
        h('strong', {}, 'Add a patient to this list'),
        h('span', { class: 'muted' }, 'Search by name, Mr# or phone. New walk-in? Register them here. To book an appointment, pick that date above first.')),
      search,
      can('patients.create') ? h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => { const p = await newPatientModal('', branchId); if (p) addPatient(p); } }, '+ New walk-in') : null) : null,
    h('datalist', { id: 'sheet-treatments' }, state.ref.treatments.map((t) => h('option', { value: t.name }))),
    h('div', { class: 'sheet-wrap', onkeydown: onKey },
      h('table', { class: 'sheet' },
        h('thead', {}, h('tr', {},
          h('th', { class: 'frozen', style: { minWidth: '210px' } }, 'Token · Patient'), h('th', {}, 'Flags'), h('th', {}, 'Month'), h('th', {}, 'Treatment'),
          h('th', {}, 'Status'), h('th', {}, "Doctor's name"), h('th', {}, 'Treatment details'), h('th', { class: 'right' }, 'P.P'),
          h('th', {}, 'Notes'), h('th', {}, 'Contact'))),
        tableBody)));

  await load();
  q.setOnline(navigator.onLine);
  $$('.cell-input', root)[0]?.blur();
}
