// Pieces shared by several staff screens: patient search box, new patient
// form, flag buttons, photo upload, braces guidance.
import { h, mount, modal, field, select, toast, friendlyError, rupees, $ } from '../../ui/dom.js';
import { state, can, myBranches, defaultBranchId } from '../../state.js';

export const STATUS_LABELS = { scheduled: 'Scheduled', waiting: 'Waiting', in_treatment: 'In treatment', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No show' };

export function duesBadge(dues) {
  return dues > 0 && can('dues.view') ? h('span', { class: 'badge badge-dues', title: `Pending dues ${rupees(dues)}` }, '💲💲', h('span', { class: 'sr-only' }, `Pending dues ${rupees(dues)}`)) : null;
}
export function aliBadge(on) {
  return on ? h('span', { class: 'badge badge-ali', title: 'Next appointment with Dr. Ali Rashid' }, 'See Dr. Ali') : null;
}

/** Search-as-you-type patient picker. */
export function patientSearch({ placeholder = 'Search name, Mr# or phone', onPick, onNew }) {
  const input = h('input', { type: 'search', placeholder, autocomplete: 'off', 'aria-label': placeholder });
  const box = h('div', { class: 'suggestions', hidden: true });
  const wrap = h('div', { style: { position: 'relative', flex: '1 1 280px', maxWidth: '420px' } }, input, box);
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) { box.hidden = true; return; }
      try {
        const rows = await state.data.searchPatients(q);
        mount(box,
          rows.slice(0, 12).map((p) => h('button', { type: 'button', onclick: () => { box.hidden = true; input.value = ''; onPick(p); } },
            h('span', {}, h('strong', {}, p.full_name), ' ', h('span', { class: 'muted' }, `Mr# ${p.mr_number}`)),
            h('span', { class: 'inline' }, duesBadge(p.dues), aliBadge(p.see_dr_ali), h('span', { class: 'muted' }, p.phone)))),
          onNew && can('patients.create') ? h('button', { type: 'button', onclick: () => { box.hidden = true; onNew(q); } }, h('strong', {}, `+ New patient "${q}"`)) : null,
          !rows.length && !onNew ? h('div', { class: 'muted', style: { padding: '10px' } }, 'No patient found.') : null);
        box.hidden = false;
      } catch (e) { toast(friendlyError(e), 'error'); }
    }, 220);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') box.hidden = true; if (e.key === 'ArrowDown') $('button', box)?.focus(); });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) box.hidden = true; });
  return wrap;
}

/** New patient form with branch dropdown and duplicate check. Resolves with the created patient. */
export function newPatientModal(prefillName = '', branchId) {
  return new Promise((resolve) => {
    const looksLikePhone = /^[\d\s+-]{7,}$/.test(prefillName);
    const name = h('input', { value: looksLikePhone ? '' : prefillName, required: true, autocomplete: 'off' });
    const phone = h('input', { type: 'tel', value: looksLikePhone ? prefillName : '', required: true, placeholder: '03xx xxxxxxx' });
    const email = h('input', { type: 'email', placeholder: 'For photos and receipts (optional)' });
    const gender = select([{ value: '', label: 'Not set' }, { value: 'female', label: 'Female' }, { value: 'male', label: 'Male' }, { value: 'other', label: 'Other' }], '');
    const dob = h('input', { type: 'date' });
    const branch = select(myBranches().map((b) => ({ value: b.id, label: b.name })), branchId || defaultBranchId());
    const source = select(['', 'Walk-in', 'Instagram', 'Facebook', 'Google', 'Referral (patient)', 'Referral (doctor)', 'TikTok', 'Other'].map((v) => ({ value: v, label: v || 'Choose…' })), '');
    const consent = h('input', { type: 'checkbox' });
    const warn = h('div', {});
    const checkDupes = async () => {
      const rows = await state.data.findDuplicates(name.value, phone.value).catch(() => []);
      mount(warn, rows.length ? h('div', { class: 'alert alert-warning' }, 'Possible existing patient: ',
        rows.slice(0, 3).map((p, i) => [i ? ', ' : '', h('strong', {}, `${p.full_name} (Mr# ${p.mr_number}${p.phone ? ', ' + p.phone : ''})`)]),
        '. Check before creating a duplicate.') : null);
    };
    name.addEventListener('change', checkDupes);
    phone.addEventListener('change', checkDupes);
    modal('New patient', h('div', {},
      h('p', { class: 'muted' }, 'Mr# is given automatically. Write the name only, without the branch (no "lhr" or "N.N").'),
      warn,
      h('div', { class: 'form-grid' },
        field('Full name', name), field('Phone number', phone), field('Email', email),
        field('Branch', branch), field('Gender', gender), field('Date of birth', dob),
        field('How did they hear about us?', source)),
      h('label', { class: 'inline' }, consent, 'Patient agrees their before/after photos can be shown on the website')), [
      { label: 'Cancel', onClick: () => resolve(null) },
      { label: 'Create patient', primary: true, onClick: async () => {
        if (name.value.trim().length < 2) { toast('Write the patient name.'); return false; }
        if (phone.value.replace(/\D/g, '').length < 10) { toast('Write a full phone number.'); return false; }
        try {
          const p = await state.data.createPatient({ full_name: name.value, phone: phone.value, email: email.value || null, gender: gender.value || null,
            date_of_birth: dob.value || null, first_branch_id: Number(branch.value), referral_source: source.value || null,
            photo_consent_public: consent.checked, photo_consent_at: consent.checked ? new Date().toISOString() : null });
          toast(`${p.full_name} registered as Mr# ${p.mr_number}.`, 'ok');
          resolve(p);
        } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  });
}

export function flagForAliModal(patient, onDone) {
  const reason = h('textarea', { placeholder: 'What seems wrong? Dr. Ali will see this.' });
  modal('Next appointment with Dr. Ali Rashid', h('div', {},
    h('p', {}, `${patient.full_name} will see the message "Please get your next appointment done by Dr. Ali Rashid", and will appear on Dr. Ali's list.`),
    field('Reason', reason)), [
    { label: 'Cancel' },
    { label: 'Flag for Dr. Ali', primary: true, onClick: async () => {
      if (!reason.value.trim()) { toast('Write the reason.'); return false; }
      try { await state.data.raiseFlag(patient.id, reason.value.trim()); toast('Flagged for Dr. Ali.', 'ok'); onDone?.(); } catch (e) { toast(friendlyError(e), 'error'); return false; }
    } },
  ]);
}

export const PHOTO_VIEWS = ['Front', 'Smile', 'Left', 'Right', 'Upper occlusal', 'Lower occlusal', 'Profile', 'X-ray / OPG', 'Other'];

export function photoUploadModal(patient, { visitId, branchId, onDone } = {}) {
  const files = h('input', { type: 'file', accept: 'image/*', multiple: true, capture: 'environment' });
  const view = select(PHOTO_VIEWS, 'Front');
  modal(`Upload photos · ${patient.full_name}`, h('div', {},
    h('p', { class: 'muted' }, 'Raw photos go to the clinic photos folder (staff only). Edited before/after versions are added later and shared with the patient.'),
    field('Photos', files), field('View', view, 'For several photos, the view is numbered automatically.')), [
    { label: 'Cancel' },
    { label: 'Upload', primary: true, onClick: async () => {
      if (!files.files.length) { toast('Choose at least one photo.'); return false; }
      try {
        let i = 0;
        for (const file of files.files) {
          i++;
          await state.data.uploadPhoto({ patientId: patient.id, visitId, branchId, file, viewLabel: files.files.length > 1 ? `${view.value} ${i}` : view.value });
        }
        toast(`${files.files.length} photo${files.files.length > 1 ? 's' : ''} uploaded.`, 'ok');
        onDone?.();
      } catch (e) { toast(friendlyError(e), 'error'); return false; }
    } },
  ]);
}

export function guidancePanel(g) {
  if (!g?.has_active_case) return null;
  const groups = (g.treating_groups || []).map((x) => `Group ${x}`).join(' or ');
  return h('div', {},
    h('div', { class: 'stat-row', style: { marginBottom: '10px' } },
      h('div', { class: 'stat' }, h('strong', {}, `Month ${g.month}`), h('span', {}, g.rule_confirmed ? 'Braces month' : 'Braces month (rule to confirm)')),
      h('div', { class: 'stat' }, h('strong', {}, groups || 'Any'), h('span', {}, 'Who treats')),
      h('div', { class: 'stat' }, h('strong', {}, g.checker_group ? `Group ${g.checker_group}` : 'No check'), h('span', {}, 'Who checks')),
      h('div', { class: 'stat' }, h('strong', {}, g.planned_wire || 'Per doctor'), h('span', {}, 'Planned wire'))),
    (g.alerts || []).map((a) => h('div', { class: `alert alert-${a.level}` }, a.text)));
}
