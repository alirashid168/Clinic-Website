// The top bar's "Create ▾" (owner, 15 Oct 2026: "on the top right there is a create button with drop down having patient, invoice and
// health record. we should have this on the website too"). Each item opens what the website already has:
//   Patient        the new-patient registration (patients.create), then the patient's file;
//   Invoice        a patient search (name, Mr# or phone), then the invoice form with the payment (billing.create) at the person's
//                  branch, for the patient's visit on today's list there when they are on it;
//   Health record  a patient search, then the patient's medical history (changed with patients.edit) and, when they are on today's
//                  Aaj ki List, that visit's treatment details and notes (changed with sheet.edit), the fields the list writes.
// shell.js shows the menu with the items the person may use (the same permissions as here), and loads this file the first time one is chosen.
import { h, modal, toast, friendlyError, field, localISO, capFirst } from '../../ui/dom.js';
import { state, can, defaultBranchId, branchName } from '../../state.js';
import { patientSearch, newPatientModal, STATUS_LABELS } from './common.js';
import { newInvoiceModal } from './invoice.js';

export async function openCreate(key) {
  if (key === 'patient' && can('patients.create')) {
    const p = await newPatientModal('', defaultBranchId());
    if (p) location.hash = `#/staff/patient/${p.id}`;
  } else if (key === 'invoice' && can('billing.create')) {
    pickPatient({ title: 'New invoice', hint: 'Find the patient by name, Mr# or phone. Then the invoice, the payment and the printed bill.', onPick: invoiceFor, allowNew: true });
  } else if (key === 'health' && (can('treatment.enter') || can('patients.edit'))) {
    pickPatient({ title: 'Health record', hint: 'Find the patient by name, Mr# or phone.', onPick: healthRecord });
  }
}

/** A dialog with the patient search; onPick(patient) once one is chosen (allowNew: "+ New patient" registers one first). */
function pickPatient({ title, hint, onPick, allowNew = false }) {
  let dialog = null;
  const go = (p) => Promise.resolve(onPick(p)).catch((e) => toast(friendlyError(e), 'error'));
  const search = patientSearch({
    placeholder: 'Name, Mr# or phone',
    label: 'Search patients by name, Mr# or phone',
    onPick: (p) => { dialog?.close(); go(p); },
    onNew: allowNew ? async (text) => { dialog?.close(); const p = await newPatientModal(text, defaultBranchId()); if (p) go(p); } : undefined,
  });
  dialog = modal(title, h('div', { class: 'pick-patient' }, h('p', { class: 'muted' }, hint), search), [{ label: 'Cancel' }]);
}

/** The patient's visit on today's list at a branch (any of the person's branches without one), or null. */
async function todaysVisit(patientId, branchId) {
  if (!can('sheet.view')) return null;
  try {
    const visits = (await state.data.listVisits({ branchId: branchId || null, date: localISO(), patientId }))
      .filter((v) => v.patient_id === patientId && v.status !== 'cancelled' && v.status !== 'no_show');
    return visits.find((v) => v.branch_id === defaultBranchId()) || visits[0] || null;
  } catch { return null; }
}

async function invoiceFor(p) {
  const branchId = defaultBranchId();
  // On today's list at this branch: the invoice is for that visit (its Invoice cell turns Done; its doctor is "Performed by").
  const visit = await todaysVisit(p.id, branchId);
  newInvoiceModal(p, {
    branchId, visitId: visit?.id, visitStaff: visit?.staff, treatment: visit?.treatment_label,
    onDone: () => document.dispatchEvent(new CustomEvent('sheet-reload')),
  });
}

async function healthRecord(p) {
  const d = state.data;
  const { MEDICAL_CONDITIONS } = await import('./patients.js');
  const editMedical = can('patients.edit');
  const visit = await todaysVisit(p.id, null);
  const editVisit = !!visit && can('sheet.edit');
  const mh = p.medical_history || {};
  const boxes = MEDICAL_CONDITIONS.map((c) => ({ c, box: h('input', { type: 'checkbox', checked: (mh.conditions || []).includes(c), disabled: !editMedical }) }));
  const allergies = h('input', { value: mh.allergies || '', disabled: !editMedical, placeholder: 'e.g. penicillin, latex' });
  const medications = h('input', { value: mh.medications || '', disabled: !editMedical, placeholder: 'Regular medicines' });
  const other = h('input', { value: mh.notes || '', disabled: !editMedical, placeholder: 'Anything else the doctor should know' });
  const details = visit ? h('input', { value: visit.details_text || '', disabled: !editVisit, maxlength: 2000, placeholder: 'e.g. U L 018 PC refresh' }) : null;
  const notes = visit ? h('input', { value: visit.notes || '', disabled: !editVisit, maxlength: 2000 }) : null;
  const medicalNow = () => ({ conditions: boxes.filter((x) => x.box.checked).map((x) => x.c), allergies: allergies.value.trim() || null, medications: medications.value.trim() || null, notes: other.value.trim() || null });
  const medicalBefore = JSON.stringify({ conditions: mh.conditions || [], allergies: mh.allergies || null, medications: mh.medications || null, notes: mh.notes || null });
  const body = h('div', { class: 'health-record' },
    h('p', {}, h('a', { href: `#/staff/patient/${p.id}` }, `Open the patient file (Mr# ${p.mr_number})`)),
    h('h3', {}, 'Medical history'),
    editMedical ? null : h('p', { class: 'muted' }, 'Changed by the staff who edit patient details.'),
    h('fieldset', { class: 'choice-group' }, h('legend', { class: 'sr-only' }, 'Conditions'),
      h('div', { class: 'choice-row' }, boxes.map(({ c, box }) => h('label', { class: 'choice' }, box, c)))),
    h('div', { class: 'form-grid' }, field('Allergies', allergies), field('Medications', medications), field('Other', other)),
    h('h3', {}, "Today's visit"),
    visit
      ? [h('p', { class: 'muted' }, [branchName(visit.branch_id), capFirst(visit.treatment_label), STATUS_LABELS[visit.status]].filter(Boolean).join(' · ')),
        h('div', { class: 'form-grid' }, field('Treatment details', details, 'As in the Treatment Details cell of the Aaj ki List.'), field('Notes', notes))]
      : h('p', { class: 'muted' }, "Not on today's Aaj ki List. The treatment done is written on the patient's row there."));
  const canSave = editMedical || editVisit;
  modal(`Health record · ${p.full_name}`, body, canSave ? [
    { label: 'Cancel' },
    { label: 'Save', primary: true, onClick: async () => {
      try {
        const medical = medicalNow();
        if (editMedical && JSON.stringify(medical) !== medicalBefore) await d.updatePatient(p.id, { medical_history: { ...mh, ...medical, updated_at: localISO() } });
        if (editVisit && (details.value.trim() !== (visit.details_text || '') || notes.value.trim() !== (visit.notes || ''))) {
          await d.updateVisit(visit.id, { details_text: details.value.trim() || null, notes: notes.value.trim() || null });
        }
      } catch (e) { toast(friendlyError(e), 'error'); return false; }
      toast(`Health record saved for ${p.full_name}.`, 'ok');
      document.dispatchEvent(new CustomEvent('sheet-reload'));
      return undefined;
    } },
  ] : [{ label: 'Close', primary: true }]);
}
