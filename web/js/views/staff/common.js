// Pieces shared by several staff screens: patient search box, new patient
// form, flag buttons, photo upload, braces guidance.
import { h, mount, modal, field, select, toast, friendlyError, rupees, announce, showFormErrors, clearFieldErrors, localISO } from '../../ui/dom.js';
import { state, can, myBranches, defaultBranchId } from '../../state.js';
import { makeThumbnail } from '../../ui/photos.js';

/**
 * The notice for a list the server cut off (the data layer sets rows.truncated and rows.cap), so a
 * partial list never reads as complete. `effect` says what the person is missing; null when the list is whole.
 */
export function capNote(rows, what, effect = 'totals may be incomplete') {
  return rows?.truncated
    ? h('div', { class: 'alert alert-warning', role: 'status' }, h('strong', {}, 'Incomplete: '), `showing the first ${rows.cap ?? rows.length} ${what}; ${effect}.`)
    : null;
}

export const STATUS_LABELS = { scheduled: 'Scheduled', waiting: 'Waiting', in_treatment: 'In treatment', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No show' };

export function duesBadge(dues) {
  return dues > 0 && can('dues.view') ? h('span', { class: 'badge badge-dues', title: `Pending dues ${rupees(dues)}` }, '💲💲', h('span', { class: 'sr-only' }, `Pending dues ${rupees(dues)}`)) : null;
}
export function aliBadge(on) {
  return on ? h('span', { class: 'badge badge-ali', title: 'Next appointment with Dr. Ali Rashid' }, 'See Dr. Ali') : null;
}

let idSeq = 0;
/** Unique element ids for widgets that can appear more than once on a page. */
const nextId = (prefix) => `${prefix}-${++idSeq}`;

/**
 * ARIA 1.2 combobox. Focus stays in the input; Up/Down move through the options
 * (aria-activedescendant), Enter picks, Escape closes, and the number of results
 * is announced. search(q) resolves to items; option(item) builds one option's
 * element (it is given role=option); note(q, items) is optional non-option text
 * shown under the list; onEnter(text) runs on Enter when no option is active.
 */
export function combobox({ wrap, input, popup, listLabel, search, option, onPick, onEnter, note, count, reopenOnFocus = false }) {
  const listbox = h('div', { role: 'listbox', id: nextId('listbox'), 'aria-label': listLabel });
  const noteHost = h('div', {});
  mount(popup, listbox, noteHost);
  for (const [k, v] of Object.entries({ role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listbox.id })) input.setAttribute(k, v);
  let items = [];
  let active = -1;
  let timer;
  let seq = 0;
  const setActive = (i) => {
    active = i;
    const opts = [...listbox.children];
    opts.forEach((o, j) => o.setAttribute('aria-selected', String(j === i)));
    if (opts[i]) { input.setAttribute('aria-activedescendant', opts[i].id); opts[i].scrollIntoView?.({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
  };
  const close = () => { clearTimeout(timer); seq++; popup.hidden = true; input.setAttribute('aria-expanded', 'false'); setActive(-1); };
  const pick = (i) => { if (i < 0 || i >= items.length) return; const item = items[i]; close(); onPick(item); };
  const run = async () => {
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    const n = ++seq;
    let found;
    try { found = await search(q); } catch (e) { if (n === seq) toast(friendlyError(e), 'error'); return; }
    if (n !== seq) return;
    items = found;
    mount(listbox, items.map((item, i) => {
      const el = option(item);
      el.id = `${listbox.id}-${i}`;
      el.tabIndex = -1;
      el.setAttribute('role', 'option');
      el.setAttribute('aria-selected', 'false');
      el.addEventListener('click', (e) => { if (e.ctrlKey || e.metaKey || e.shiftKey) return; e.preventDefault(); pick(i); });
      return el;
    }));
    mount(noteHost, note?.(q, items) || null);
    setActive(-1);
    popup.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    announce(count(items, q));
  };
  // A click on an option must not take focus out of the input (that would close the list first).
  popup.addEventListener('mousedown', (e) => { if (e.target.closest('[role=option]') || !e.target.closest('a, button, input')) e.preventDefault(); });
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 220); });
  if (reopenOnFocus) input.addEventListener('focus', () => { if (input.value.trim().length >= 2) run(); });
  input.addEventListener('keydown', (e) => {
    const open = !popup.hidden;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { run(); return; }
      if (items.length) setActive(e.key === 'ArrowDown' ? (active + 1) % items.length : active <= 0 ? items.length - 1 : active - 1);
    } else if (e.key === 'Enter') {
      if (open && active >= 0) { e.preventDefault(); pick(active); } else if (onEnter) { e.preventDefault(); close(); onEnter(input.value.trim()); }
    } else if (e.key === 'Escape' && open) {
      e.preventDefault(); e.stopPropagation(); close();
    }
  });
  wrap.addEventListener('focusout', (e) => { if (!wrap.contains(e.relatedTarget)) close(); });
  return { close };
}

/** Search-as-you-type patient picker (an ARIA combobox). */
export function patientSearch({ placeholder = 'Search name, Mr# or phone', label = placeholder, onPick, onNew }) {
  const input = h('input', { type: 'search', placeholder, autocomplete: 'off', 'aria-label': label });
  const box = h('div', { class: 'suggestions', hidden: true });
  // The .suggestions box is the positioned popup; the listbox sits inside it with the "no match" note.
  const wrap = h('div', { style: { position: 'relative', flex: '1 1 280px', maxWidth: '420px' } }, input, box);
  const allowNew = !!onNew && can('patients.create');
  const isNew = (p) => p.newName !== undefined;
  combobox({
    wrap, input, popup: box, listLabel: 'Matching patients',
    search: async (q) => [...(await state.data.searchPatients(q)).slice(0, 12), ...(allowNew ? [{ newName: q }] : [])],
    option: (p) => (isNew(p)
      ? h('button', { type: 'button' }, h('strong', {}, `+ New patient "${p.newName}"`))
      : h('button', { type: 'button' },
        h('span', {}, h('strong', {}, p.full_name), ' ', h('span', { class: 'muted' }, `Mr# ${p.mr_number}`)),
        h('span', { class: 'inline' }, duesBadge(p.dues), aliBadge(p.see_dr_ali), h('span', { class: 'muted' }, p.phone)))),
    onPick: (p) => {
      input.value = '';
      if (isNew(p)) { onNew(p.newName); return; }
      announce(`Selected: ${p.full_name}, Mr# ${p.mr_number}`);
      onPick(p);
    },
    note: (q, items) => (items.length ? null : h('div', { class: 'muted', style: { padding: '10px' } }, 'No patient found.')),
    count: (items) => {
      const n = items.filter((p) => !isNew(p)).length;
      if (n) return `${n} patient${n === 1 ? '' : 's'} found. Use the up and down arrows to choose.`;
      return allowNew ? 'No patient found. The list has an option to register a new patient.' : 'No patient found.';
    },
  });
  return wrap;
}

/**
 * A native <select> (or date input) that saved on every `change` would save each
 * step of an arrow-key walk on Windows. Keyboard changes stay provisional until
 * Enter or leaving the control; a pick from the open list (mouse, touch) commits
 * at once; Escape undoes a provisional change. onCommit(value, previous) runs
 * once per real change; onPreview(value) runs whenever the shown value changes.
 * Returns { set(value) } to move the committed value (e.g. revert after a failed save).
 */
export function commitOnFinish(el, onCommit, onPreview) {
  let committed = el.value;
  let fromKey = false;
  const finish = () => {
    fromKey = false;
    if (el.value === committed) return;
    const previous = committed;
    committed = el.value;
    onCommit(committed, previous);
  };
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish();
    else if (e.key === 'Escape' && el.value !== committed) { e.preventDefault(); e.stopPropagation(); el.value = committed; onPreview?.(committed); }
    else if (e.key.length === 1 || /^(Arrow|Page|Home|End|Backspace|Delete)/.test(e.key)) {
      // On Windows these change a closed select at once, firing `change` within this same task.
      // Backspace and Delete do the same to a date input (clearing a part empties it), so clearing
      // a date stays provisional until Enter or leaving the field.
      fromKey = true;
      setTimeout(() => { fromKey = false; }, 0);
    }
  });
  el.addEventListener('change', () => { onPreview?.(el.value); if (!fromKey) finish(); });
  el.addEventListener('blur', finish);
  return { set: (value) => { committed = value; el.value = value; onPreview?.(value); } };
}

/** New patient form with branch dropdown and duplicate check. Resolves with the created patient. */
export function newPatientModal(prefillName = '', branchId) {
  return new Promise((resolve) => {
    const looksLikePhone = /^[\d\s+-]{7,}$/.test(prefillName);
    const name = h('input', { value: looksLikePhone ? '' : prefillName, autocomplete: 'off' });
    const phone = h('input', { type: 'tel', value: looksLikePhone ? prefillName : '', placeholder: '03xx xxxxxxx' });
    const email = h('input', { type: 'email', placeholder: 'For photos and receipts (optional)' });
    const gender = select([{ value: '', label: 'Not set' }, { value: 'female', label: 'Female' }, { value: 'male', label: 'Male' }, { value: 'other', label: 'Other' }], '');
    const dob = h('input', { type: 'date' });
    const branch = select(myBranches().map((b) => ({ value: b.id, label: b.name })), branchId || defaultBranchId());
    const source = select(['', 'Walk-in', 'Instagram', 'Facebook', 'Google', 'Referral (patient)', 'Referral (doctor)', 'TikTok', 'Other'].map((v) => ({ value: v, label: v || 'Choose…' })), '');
    // A doctor's own patient (they brought them in): their 40% share counts on this patient's bills.
    const ownDoctor = select([{ value: '', label: "Clinic's patient (Dr. Ali)" }, ...state.ref.clinicians.filter((c) => c.is_doctor && c.display_name !== 'Dr. Ali Rashid').map((c) => ({ value: c.id, label: c.display_name }))], '');
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
    const body = h('div', {},
      h('p', { class: 'muted' }, 'Mr# is given automatically. Write the name only, without the branch (no "lhr" or "N.N").'),
      warn,
      h('div', { class: 'form-grid' },
        field('Full name', name, null, { required: true }), field('Phone number', phone, null, { required: true }), field('Email', email),
        field('Branch', branch), field('Gender', gender), field('Date of birth', dob),
        field('How did they hear about us?', source), field('Brought in by doctor', ownDoctor, "Only when a doctor brings their own patient. Their percentage is counted on this patient's bills.")),
      h('label', { class: 'inline' }, consent, 'Patient agrees their before/after photos can be shown on the website'));
    modal('New patient', body, [
      { label: 'Cancel', onClick: () => resolve(null) },
      { label: 'Create patient', primary: true, onClick: async () => {
        const errors = [];
        if (name.value.trim().length < 2) errors.push({ input: name, message: 'Write the patient name.' });
        if (phone.value.replace(/\D/g, '').length < 10) errors.push({ input: phone, message: 'Write a full phone number with at least 10 digits, e.g. 0300 1234567.' });
        if (errors.length) { showFormErrors(body, errors); return false; }
        clearFieldErrors(body);
        try {
          const p = await state.data.createPatient({ full_name: name.value, phone: phone.value, email: email.value || null, gender: gender.value || null,
            date_of_birth: dob.value || null, first_branch_id: Number(branch.value), referral_source: source.value || null, referred_by_clinician: ownDoctor.value || null,
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
  const body = h('div', {},
    h('p', {}, `${patient.full_name} will see the message "Please get your next appointment done by Dr. Ali Rashid", and will appear on Dr. Ali's list.`),
    field('Reason', reason, null, { required: true }));
  modal('Next appointment with Dr. Ali Rashid', body, [
    { label: 'Cancel' },
    { label: 'Flag for Dr. Ali', primary: true, onClick: async () => {
      if (!reason.value.trim()) { showFormErrors(body, [{ input: reason, message: 'Write the reason, so Dr. Ali knows what to look at.' }]); return false; }
      clearFieldErrors(body);
      try { await state.data.raiseFlag(patient.id, reason.value.trim()); toast('Flagged for Dr. Ali.', 'ok'); onDone?.(); } catch (e) { toast(friendlyError(e), 'error'); return false; }
    } },
  ]);
}

export const PHOTO_VIEWS = ['Front', 'Smile', 'Left', 'Right', 'Upper occlusal', 'Lower occlusal', 'Profile', 'X-ray / OPG', 'Other'];

// Edited before/after photos are what patients open in their account, mostly on
// mobile data. Phone cameras give 4000px+ files of several MB, so these are
// shrunk to this long edge before upload. Raw clinical photos and X-rays are
// uploaded untouched (they are the clinical record). Edited collages are often PNG exports, so
// PNG is shrunk too (HEIC is already turned into JPEG by the phone's file picker).
const PATIENT_PHOTO_MAX_EDGE = 2400;

async function shrinkPhoto(file) {
  if (!/^image\/(jpeg|webp|png)$/.test(file.type) || file.size < 1.5e6 || typeof createImageBitmap !== 'function') return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, PATIENT_PHOTO_MAX_EDGE / Math.max(bmp.width, bmp.height));
    if (scale === 1) { bmp.close?.(); return file; }
    const canvas = h('canvas', { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // a transparent PNG would turn black as a JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg', lastModified: file.lastModified });
  } catch { return file; }
}

const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function photoUploadModal(patient, { visitId, branchId, onDone } = {}) {
  const files = h('input', { type: 'file', accept: 'image/*', multiple: true, capture: 'environment' });
  const view = select(PHOTO_VIEWS, 'Front');
  const edited = h('input', { type: 'checkbox' });
  const publicOk = h('input', { type: 'checkbox', disabled: !patient.photo_consent_public });
  // A failed batch must not upload the photos that already went through again:
  // remember which files are done, and give each file one idempotency key for all attempts.
  const done = new Set();
  const keys = new Map();
  const body = h('div', {},
    h('p', { class: 'muted' }, 'Raw photos go to the clinic photos folder (staff only). Tick "edited" for the finished before/after versions: those are the ones the patient sees in their account.'),
    field('Photos', files, null, { required: true }), field('View', view, 'For several photos, the view is numbered automatically. Choose "X-ray / OPG" for X-rays.'),
    h('label', { class: 'inline' }, edited, 'Edited before/after version (shared with the patient)'),
    h('label', { class: 'inline', style: { marginTop: '6px' } }, publicOk, patient.photo_consent_public ? 'May be shown on the website (patient has given consent)' : 'May be shown on the website — the patient has not given photo consent yet'));
  modal(`Upload photos · ${patient.full_name}`, body, [
    { label: 'Cancel' },
    { label: 'Upload', primary: true, onClick: async () => {
      const list = [...files.files];
      if (!list.length) { showFormErrors(body, [{ input: files, message: 'Choose at least one photo.' }]); return false; }
      clearFieldErrors(body);
      const isEdited = edited.checked;
      try {
        for (const [i, file] of list.entries()) {
          if (done.has(file)) continue;
          if (!keys.has(file)) keys.set(file, newKey());
          const upload = isEdited && view.value !== 'X-ray / OPG' ? await shrinkPhoto(file) : file;
          // A small copy (320 px) is saved with the photo for the photo grids; null (the browser cannot read this file, e.g. HEIC on a
          // desktop) just means no copy: the photo is saved all the same.
          const thumb = await makeThumbnail(upload);
          await state.data.uploadPhoto({ patientId: patient.id, visitId, branchId, file: upload, thumb, viewLabel: list.length > 1 ? `${view.value} ${i + 1}` : view.value,
            kind: isEdited ? 'edited' : 'raw', publicOk: isEdited && publicOk.checked && patient.photo_consent_public, idempotencyKey: keys.get(file) });
          done.add(file);
        }
        toast(`${list.length} photo${list.length > 1 ? 's' : ''} uploaded.`, 'ok');
        onDone?.();
      } catch (e) {
        const partly = list.filter((f) => done.has(f)).length;
        toast(`${friendlyError(e)}${partly ? ` ${partly} of ${list.length} photos were uploaded; pressing Upload again sends only the rest.` : ''}`, 'error');
        return false;
      }
    } },
  ]);
}

export const DOCUMENT_KINDS = { consent: 'Consent form', id: 'ID copy', report: 'Report', other: 'Other' };

// Consent forms, ID copies and reports (PDF or photo) for a patient's record.
export function documentUploadModal(patient, { onDone } = {}) {
  const file = h('input', { type: 'file', accept: 'application/pdf,image/*' });
  const kind = select(Object.entries(DOCUMENT_KINDS).map(([value, label]) => ({ value, label })), 'consent');
  const title = h('input', { placeholder: 'e.g. Consent and information form', value: 'Consent and information form' });
  const date = h('input', { type: 'date', value: localISO() });
  kind.addEventListener('change', () => { if (!title.value || Object.values(DOCUMENT_KINDS).includes(title.value) || title.value.startsWith('Consent')) title.value = kind.value === 'consent' ? 'Consent and information form' : DOCUMENT_KINDS[kind.value]; });
  const body = h('div', {},
    h('p', { class: 'muted' }, 'Scanned forms and ID copies stay private to staff; patients see only their own.'),
    field('File', file, 'PDF or a photo of the signed form.', { required: true }), field('Type', kind), field('Title', title), field('Date', date));
  modal(`Add document · ${patient.full_name}`, body, [
    { label: 'Cancel' },
    { label: 'Save', primary: true, onClick: async () => {
      if (!file.files.length) { showFormErrors(body, [{ input: file, message: 'Choose a file.' }]); return false; }
      clearFieldErrors(body);
      try {
        await state.data.uploadDocument({ patientId: patient.id, file: file.files[0], kind: kind.value, title: title.value.trim() || DOCUMENT_KINDS[kind.value], addedOn: date.value });
        toast('Document saved.', 'ok');
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
