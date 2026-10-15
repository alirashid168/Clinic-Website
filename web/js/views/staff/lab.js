// Lab Work: lab cases in the same sheet-like layout as the Retainer Record (owner, 12 Oct 2026: "if you could make one similar
// for lab works that would be great too ... make a tab and put things in it, it'll add or remobe or edit things once when i
// habe more time to see it"). Teal instead of purple; one tab per branch (lab work is sent from a branch), plus "All branches"
// for people who work at more than one. A case past its due date that is not back yet shows an "Overdue" chip.
// The owner will change the columns: they are all in LAB_COLUMNS below (a new column also needs its database column).
import { h, mount, toast, modal, field, select, showFormErrors, localISO, shortDate, busy, announce, empty } from '../../ui/dom.js';
import { state, can, myBranches, branchName, defaultBranchId } from '../../state.js';
import { patientSearch, commitOnFinish } from './common.js';
import { renderRecordSheet, recordQueue, rowName, notSaved, pill } from './record-sheet.js';
import { labWorkTypes, LAB_STATUSES, LAB_STATUS_LABELS, PAYMENT_OPTIONS, labOverdue, optionKey } from '../../lib/records.js';

const OTHER = '__other';
/**
 * The columns, left to right (the row number comes first by itself). kind: text (typed, saves by itself), date, money, or pill
 * (a drop-down chip; `list` says which: work types (Clinic setup), labs and people (the lab team in Clinic setup), status, payment).
 * What is followed every day comes first (the work, the lab, the dates and the status), so it fits a laptop screen; the details
 * (teeth, shade, who handles it, money, contact, notes) after it.
 */
export const LAB_COLUMNS = [
  { key: 'patient', label: 'Patient', kind: 'who' },
  { key: 'work_type', label: 'Work', kind: 'pill', list: 'work' },
  { key: 'lab_name', label: 'Lab', kind: 'pill', list: 'labs' },
  { key: 'sent_date', label: 'Sent', kind: 'date' },
  { key: 'due_date', label: 'Due', kind: 'date' },
  { key: 'received_date', label: 'Received', kind: 'date' },
  { key: 'fitted_date', label: 'Fitted', kind: 'date' },
  { key: 'status', label: 'Status', kind: 'pill', list: 'status', allowEmpty: false },
  { key: 'teeth', label: 'Teeth', kind: 'text', max: 60, width: 'short' },
  { key: 'shade', label: 'Shade', kind: 'text', max: 40, width: 'short' },
  { key: 'handled_by', label: 'Handled by', kind: 'pill', list: 'people' },
  { key: 'cost', label: 'Cost (Rs)', kind: 'money' },
  { key: 'payment', label: 'Payment', kind: 'pill', list: 'payment' },
  { key: 'contact', label: 'Contact', kind: 'text', type: 'tel', max: 60, width: 'text' },
  { key: 'notes', label: 'Notes', kind: 'text', max: 2000, width: 'wide' },
];
const MISSING = 'Lab work is not switched on yet. It appears here once the database update has been run.';

const queue = recordQueue({
  storageKey: 'lab-work-pending-v1', table: 'lab_cases', page: 'Lab work',
  fieldNames: { patient_name: 'Name', contact: 'Contact', teeth: 'Teeth', shade: 'Shade', cost: 'Cost', notes: 'Notes' },
  send: (id, changes) => state.data.updateLabRecord(id, changes),
});

/** A small dialog for a name that is not on the list. Resolves to the name, or undefined when cancelled. */
function askName(title, label, current) {
  return new Promise((resolve) => {
    const input = h('input', { maxlength: 120, autocomplete: 'off', value: current || '' });
    const body = h('div', {}, field(label, input, null, { required: true }));
    modal(title, body, [
      { label: 'Cancel' },
      { label: 'Use this name', primary: true, onClick: () => {
        const v = input.value.trim().replace(/\s+/g, ' ');
        if (!v) return showFormErrors(body, [{ input, message: 'Write the name, or press Cancel.' }]);
        resolve(v);
      } },
    ], { onClose: () => resolve(undefined), initialFocus: input });
  });
}

export async function renderLab(root, params, signal) {
  const d = state.data;
  const canEdit = can('lab.manage');
  const branches = myBranches();
  if (!branches.length) { mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'Lab work')), empty('No branch is open to your account.')); return; }
  const tabsList = [...(branches.length > 1 ? [{ id: 'all', label: 'All branches' }] : []), ...branches.map((b) => ({ id: b.id, label: b.name }))];
  const want = params.get('branch');
  const tab = want === 'all' && branches.length > 1 ? 'all'
    : branches.some((b) => String(b.id) === want) ? Number(want)
      : branches.some((b) => b.id === defaultBranchId()) ? defaultBranchId() : tabsList[0].id;

  let team = [];
  try { team = await d.labTeam(); } catch (e) {
    if (e?.code === 'RECORDS_MISSING') { mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'Lab work')), empty(MISSING)); return; }
    toast(notSaved(e, ''), 'error');
  }
  if (signal?.aborted) return;
  const works = labWorkTypes(state.ref.settings);
  const today = localISO();
  const byName = (kind, name) => team.find((m) => m.kind === kind && optionKey(m.name) === optionKey(name));
  const teamList = (kind, key) => (row) => {
    const out = team.filter((m) => m.kind === kind && (m.active !== false || optionKey(m.name) === optionKey(row?.[key]))).map((m) => ({ value: m.name, label: m.name, colour: m.colour }));
    // (short words: a drop-down is as wide as its longest choice)
    return [...out, { value: OTHER, label: kind === 'lab' ? 'Other lab…' : 'Someone else…', colour: 'grey' }];
  };
  const lists = {
    work: (row) => works.filter((w) => w.active || optionKey(w.label) === optionKey(row?.work_type)).map((w) => ({ value: w.label, label: w.label, colour: w.colour })),
    labs: teamList('lab', 'lab_name'),
    people: teamList('person', 'handled_by'),
    status: () => LAB_STATUSES.map((s) => ({ value: s.value, label: s.label, colour: s.colour })),
    payment: () => PAYMENT_OPTIONS.map((o) => ({ value: o.label, label: o.label, colour: o.colour })),
  };
  const asks = {
    labs: (row) => askName('Another lab', 'Lab name', byName('lab', row.lab_name) ? '' : row.lab_name),
    people: (row) => askName('Someone else', 'Who handles it', byName('person', row.handled_by) ? '' : row.handled_by),
  };
  const columns = LAB_COLUMNS.map((c) => (c.list ? { ...c, options: lists[c.list], ask: asks[c.list] || null, askValue: OTHER } : c));

  // ---- adding a case
  function add(tabId) {
    return new Promise((resolve) => {
      let picked = null;
      const name = h('input', { maxlength: 200, autocomplete: 'off' });
      const contact = h('input', { type: 'tel', maxlength: 60, autocomplete: 'off' });
      const linkNote = h('p', { class: 'muted', hidden: true });
      const search = can('patients.view') ? patientSearch({ placeholder: 'Find a patient file (optional)', label: 'Find a patient file (optional): name, Mr# or phone', onPick: (p) => {
        picked = p; name.value = p.full_name; if (!contact.value) contact.value = p.phone || '';
        linkNote.textContent = `Linked to the patient file Mr# ${p.mr_number}.`; linkNote.hidden = false; announce(linkNote.textContent);
      } }) : null;
      const active = works.filter((w) => w.active);
      const work = select([{ value: '', label: 'Choose' }, ...active.map((w) => ({ value: w.label, label: w.label }))], '');
      const teeth = h('input', { maxlength: 60, autocomplete: 'off', placeholder: 'e.g. UR6 or 11, 21' });
      const shade = h('input', { maxlength: 40, autocomplete: 'off', placeholder: 'e.g. A2' });
      const stamp = Math.random().toString(36).slice(2, 7);
      const labName = h('input', { maxlength: 120, autocomplete: 'off', list: `lab-names-${stamp}`, value: team.find((m) => m.kind === 'lab' && m.active !== false)?.name || '' });
      const handled = h('input', { maxlength: 120, autocomplete: 'off', list: `lab-people-${stamp}` });
      const sent = h('input', { type: 'date', value: today });
      const due = h('input', { type: 'date' });
      const cost = h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal' });
      const notes = h('input', { maxlength: 2000, autocomplete: 'off' });
      const branch = tabId === 'all' ? select(branches.map((b) => ({ value: b.id, label: b.name })), defaultBranchId() || branches[0].id) : null;
      const body = h('div', {},
        search ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Patient file (optional)'), search, linkNote) : null,
        h('div', { class: 'form-grid' },
          field('Patient name', name, null, { required: true }), field('Contact', contact), branch ? field('Branch', branch) : null,
          field('Work', work), field('Teeth', teeth), field('Shade', shade), field('Lab', labName), field('Handled by', handled),
          field('Sent', sent), field('Due back', due), field('Cost (Rs)', cost)),
        field('Notes', notes),
        h('datalist', { id: `lab-names-${stamp}` }, team.filter((m) => m.kind === 'lab' && m.active !== false).map((m) => h('option', { value: m.name }))),
        h('datalist', { id: `lab-people-${stamp}` }, team.filter((m) => m.kind === 'person' && m.active !== false).map((m) => h('option', { value: m.name }))));
      modal(`New lab case · ${tabId === 'all' ? 'Lab work' : branchName(tabId)}`, body, [
        { label: 'Cancel' },
        { label: 'Add lab case', primary: true, onClick: async () => {
          const errors = [];
          if (!name.value.trim() && !picked) errors.push({ input: name, message: 'Write the patient name.' });
          const costValue = cost.value === '' ? null : Number(cost.value);
          if (costValue !== null && (!Number.isFinite(costValue) || costValue < 0)) errors.push({ input: cost, message: 'Write the cost as a number from 0 up, or leave it empty.' });
          if (errors.length) return showFormErrors(body, errors);
          try {
            const row = await d.addLabRecord({
              branch_id: branch ? Number(branch.value) : Number(tabId), patient_id: picked?.id || null,
              patient_name: name.value.trim().replace(/\s+/g, ' ') || picked?.full_name, contact: contact.value.trim() || null,
              work_type: work.value || null, teeth: teeth.value.trim() || null, shade: shade.value.trim() || null, lab_name: labName.value.trim() || null,
              handled_by: handled.value.trim() || null, sent_date: sent.value || null, due_date: due.value || null, cost: costValue, notes: notes.value.trim() || null,
            });
            toast(`${rowName(row)} added to Lab work.`, 'ok');
            resolve(row);
          } catch (e) { toast(notSaved(e, 'The lab case was not added.'), 'error', 9000); return false; }
        } },
      ], { onClose: () => resolve(null) });
    });
  }

  // ---- the row's "More" dialog: patient file, branch, remove
  function rowOptions(row, { save, removed }) {
    const who = rowName(row);
    let dialog = null;
    const parts = [];
    if (row.patient_id) {
      parts.push(h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Patient file'), h('div', { class: 'inline' },
        row.patient ? h('a', { class: 'btn btn-small', href: `#/staff/patient/${row.patient_id}`, onclick: () => dialog?.close() }, `Mr# ${row.patient.mr_number} · Open the patient file`) : h('span', {}, 'Linked to a patient file.'),
        canEdit ? h('button', { type: 'button', class: 'btn btn-small', onclick: busy(async () => { if (await save({ patient_id: null }, 'the patient file is no longer linked')) dialog?.close(); }) }, 'Unlink') : null)));
    } else if (canEdit && can('patients.view')) {
      parts.push(h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Link to a patient file'),
        patientSearch({ placeholder: 'Search name, Mr# or phone', label: `Link ${who} to a patient file: search name, Mr# or phone`, onPick: async (p) => {
          if (await save({ patient_id: p.id, contact: row.contact || p.phone || null }, `linked to Mr# ${p.mr_number}`)) { toast(`${who} is linked to Mr# ${p.mr_number}.`, 'ok'); dialog?.close(); }
        } })));
    }
    if (canEdit && branches.length > 1) {
      const branch = select(branches.map((b) => ({ value: b.id, label: b.name })), row.branch_id);
      const ctl = commitOnFinish(branch, async (v, previous) => {
        if (await save({ branch_id: Number(v) }, `branch ${branchName(v)}`)) { toast(`${who} moved to ${branchName(v)}.`, 'ok'); dialog?.close(); } else ctl.set(previous);
      });
      parts.push(field('Branch', branch, 'Moving a case takes it to that branch\'s tab.'));
    } else parts.push(h('p', {}, `Branch: ${branchName(row.branch_id)}`));
    if (labOverdue(row, today)) parts.push(h('p', {}, pill('Overdue', 'red'), ` Due back on ${shortDate(row.due_date)} and not received yet.`));
    parts.push(h('p', { class: 'muted' }, `Added${row.created_at ? ` on ${shortDate(String(row.created_at).slice(0, 10))}` : ''}. Status: ${LAB_STATUS_LABELS[row.status] || row.status}.`));
    dialog = modal(who, h('div', {}, parts), [
      ...(canEdit ? [{ label: 'Remove this case', danger: true, onClick: () => {
        modal('Remove this lab case?', h('p', {}, `${who}${row.work_type ? ` (${row.work_type})` : ''} will be taken off Lab work. This cannot be undone.`), [
          { label: 'Keep it' },
          { label: 'Remove', danger: true, onClick: async () => {
            try { await d.deleteLabRecord(row.id); toast(`${who} removed.`, 'ok'); removed(); } catch (e) { toast(notSaved(e, `${who} was not removed.`), 'error', 9000); return false; }
          } },
        ], { destructive: true });
      } }] : []),
      { label: 'Done', primary: true },
    ]);
  }

  function csv(rows, tabId) {
    const code = tabId === 'all' ? 'all-branches' : (state.ref.branches.find((b) => b.id === Number(tabId))?.code || 'branch').toLowerCase();
    return {
      filename: `lab-work_${code}_${today}.csv`,
      rows: rows.map((r, i) => ({
        '#': i + 1, Patient: rowName(r), 'Mr#': r.patient?.mr_number || '', Contact: r.contact || '', Branch: branchName(r.branch_id), Work: r.work_type || '',
        Teeth: r.teeth || '', Shade: r.shade || '', Lab: r.lab_name || '', Sent: r.sent_date || '', Due: r.due_date || '', Received: r.received_date || '',
        Fitted: r.fitted_date || '', Status: LAB_STATUS_LABELS[r.status] || r.status || '', Overdue: labOverdue(r, today) ? 'Overdue' : '',
        'Handled by': r.handled_by || '', 'Cost (Rs)': r.cost ?? '', Payment: r.payment || '', Notes: r.notes || '',
      })),
    };
  }

  await renderRecordSheet(root, params, signal, {
    page: 'Lab work', title: 'Lab work', accent: 'teal', path: '#/staff/lab',
    tabs: tabsList, tab, tabParam: 'branch', queue, canEdit, canAdd: canEdit, canDownload: canEdit || can('export.data'),
    columns,
    load: (tabId) => d.labRecords({ branchId: tabId === 'all' ? null : tabId }),
    save: (id, changes) => d.updateLabRecord(id, changes),
    filters: [
      { key: 'status', label: 'Status', always: true, options: () => [...LAB_STATUSES.map((s) => ({ value: s.value, label: s.label, colour: s.colour })), { value: '__late', label: 'Overdue', colour: 'red' }],
        test: (r, v) => (v === '__late' ? labOverdue(r, today) : r.status === v) },
      { key: 'who', label: 'Handled by', options: (rows) => {
        const names = [...new Set(rows.map((r) => r.handled_by).filter(Boolean))];
        const out = team.filter((m) => m.kind === 'person' && (m.active !== false || names.includes(m.name))).map((m) => ({ value: m.name, label: m.name, colour: m.colour }));
        for (const n of names) if (!out.some((o) => optionKey(o.value) === optionKey(n))) out.push({ value: n, label: n });
        return out;
      }, test: (r, v) => optionKey(r.handled_by) === optionKey(v) },
    ],
    monthKeys: ['sent_date', 'due_date'],
    rowClass: (row, day) => (labOverdue(row, day) ? 'rs-late' : null),
    decorate: (col, row, day) => (col.key === 'due_date' && labOverdue(row, day) ? pill('Overdue', 'red') : null),
    whoNote: (row, tabId) => (tabId === 'all' ? state.ref.branches.find((b) => b.id === row.branch_id)?.code || '' : null),
    add, addLabel: '+ New lab case', rowOptions, csv,
    words: ['lab case', 'lab cases'], missingText: MISSING,
    emptyText: (where) => (canEdit ? `No lab work for ${where} yet. Use "+ New lab case" to add one.` : `No lab work for ${where} yet.`),
  });
}
