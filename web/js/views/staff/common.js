// Pieces shared by several staff screens: patient search box, new patient
// form, flag buttons, photo upload, braces guidance.
import { h, mount, modal, field, select, toast, friendlyError, rupees, announce, showFormErrors, clearFieldErrors, localISO, shortDate } from '../../ui/dom.js';
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
  return { close, open: run };
}

/**
 * Search-as-you-type patient picker (an ARIA combobox). onEnter(text) is optional: it runs on Enter when no option is
 * chosen and resolves to true when it dealt with the text; otherwise the text comes back with the matches to choose from.
 * The box is emptied at once on Enter, so the next one can be typed while the last is still being dealt with.
 */
export function patientSearch({ placeholder = 'Search name, Mr# or phone', label = placeholder, onPick, onNew, onEnter }) {
  const input = h('input', { type: 'search', placeholder, autocomplete: 'off', 'aria-label': label });
  const box = h('div', { class: 'suggestions', hidden: true });
  // The .suggestions box is the positioned popup; the listbox sits inside it with the "no match" note.
  const wrap = h('div', { style: { position: 'relative', flex: '1 1 280px', maxWidth: '420px' } }, input, box);
  const allowNew = !!onNew && can('patients.create');
  const isNew = (p) => p.newName !== undefined;
  const ctl = combobox({
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
    // (Something typed meanwhile is never overwritten: then it says that nothing was added.)
    onEnter: onEnter ? async (text) => {
      if (!text) return;
      input.value = '';
      if (await onEnter(text)) return;
      if (!input.value.trim()) { input.value = text; ctl.open(); } else toast(`Nothing was added for "${text}". Search for it again to choose the patient.`, 'error', 8000);
    } : undefined,
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
 * Only a real leave commits on blur: Chrome also fires blur when the control is
 * taken out of the page (a redraw) and when another window takes the focus, and
 * neither saves a provisional change. (A select can have two options with one
 * value, such as the Aaj ki List's group the sheet names and "No group": Escape
 * goes back to the option that was chosen, not just to its value.)
 * Returns { set(value), pending() }: set moves the committed value (e.g. revert
 * after a failed save); pending() is true while a value is chosen and not saved.
 */
export function commitOnFinish(el, onCommit, onPreview) {
  let committed = el.value;
  let committedAt = el.selectedIndex; // (undefined for a date input)
  let fromKey = false;
  const finish = () => {
    fromKey = false;
    committedAt = el.selectedIndex;
    if (el.value === committed) return;
    const previous = committed;
    committed = el.value;
    onCommit(committed, previous);
  };
  el.addEventListener('keydown', (e) => {
    // (Enter saves and nothing else: Chrome on Windows would also open a select's list, which then takes the next Tab and
    //  turns the letters typed next into a pick from it.)
    if (e.key === 'Enter') { e.preventDefault(); finish(); }
    else if (e.key === 'Escape' && (el.value !== committed || el.selectedIndex !== committedAt)) {
      e.preventDefault(); e.stopPropagation();
      el.value = committed;
      if (committedAt !== undefined && el.value === committed) el.selectedIndex = committedAt;
      onPreview?.(committed);
    }
    else if (e.key.length === 1 || /^(Arrow|Page|Home|End|Backspace|Delete)/.test(e.key)) {
      // On Windows these change a closed select at once, firing `change` within this same task.
      // Backspace and Delete do the same to a date input (clearing a part empties it), so clearing
      // a date stays provisional until Enter or leaving the field.
      fromKey = true;
      setTimeout(() => { fromKey = false; }, 0);
    }
  });
  el.addEventListener('change', () => { onPreview?.(el.value); if (!fromKey) finish(); });
  // (looked at once the blur is over: the control being removed is still in the page while its blur runs)
  el.addEventListener('blur', () => queueMicrotask(() => { if (el.isConnected && document.activeElement !== el) finish(); }));
  return { set: (value) => { committed = value; el.value = value; committedAt = el.selectedIndex; onPreview?.(value); }, pending: () => el.value !== committed };
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

// While files go up, the upload dialogs say how far they are ("Uploading X-ray 2 of 5…") and stay open: ×, Escape, a tap outside or Back
// then say "Saving, wait a moment." instead of hiding an upload that is still going (opened again, the same files would go twice).
const progressLine = () => h('p', { class: 'muted upload-progress', role: 'status', 'aria-live': 'polite' });
const stepText = (verb, unit, i, n) => (n > 1 ? `${verb} ${unit} ${i + 1} of ${n}…` : `${verb}…`);
const stayOpenWhile = (busy) => ({ confirmDismiss: () => true, unsaved: busy });

// { picture: true } is "Upload picture" on the patient profile: a phone or tablet offers the camera and the gallery both, so several
// pictures go at once (with the capture attribute a phone opens only the camera, one picture per tap), and the "X-ray / OPG" view is
// not offered (X-rays have their own button there and go to the X-ray store). From the day's list it stays as it was: camera first.
export function photoUploadModal(patient, { visitId, branchId, onDone, picture = false } = {}) {
  const files = h('input', { type: 'file', accept: 'image/*', multiple: true, capture: picture ? null : 'environment' });
  const view = select(picture ? PHOTO_VIEWS.filter((v) => v !== 'X-ray / OPG') : PHOTO_VIEWS, 'Front');
  const edited = h('input', { type: 'checkbox' });
  const publicOk = h('input', { type: 'checkbox', disabled: !patient.photo_consent_public });
  // A failed batch must not upload the photos that already went through again:
  // remember which files are done, and give each file one idempotency key for all attempts.
  const done = new Set();
  const keys = new Map();
  const progress = progressLine();
  let working = false;
  const body = h('div', {},
    h('p', { class: 'muted' }, 'Raw photos go to the clinic photos folder (staff only). Tick "edited" for the finished before/after versions: those are the ones the patient sees in their account.'),
    field(picture ? 'Pictures' : 'Photos', files, picture ? 'Several at once is fine. On a phone you can take them with the camera or choose them from the gallery.' : null, { required: true }),
    field('View', view, picture ? 'For several pictures, the view is numbered automatically. X-rays go in with "Upload X-ray".' : 'For several photos, the view is numbered automatically. Choose "X-ray / OPG" for X-rays.'),
    h('label', { class: 'inline' }, edited, 'Edited before/after version (shared with the patient)'),
    h('label', { class: 'inline', style: { marginTop: '6px' } }, publicOk, patient.photo_consent_public ? 'May be shown on the website (patient has given consent)' : 'May be shown on the website — the patient has not given photo consent yet'),
    progress);
  modal(`${picture ? 'Upload picture' : 'Upload photos'} · ${patient.full_name}`, body, [
    { label: 'Cancel' },
    { label: 'Upload', primary: true, onClick: async () => {
      const list = [...files.files];
      if (!list.length) { showFormErrors(body, [{ input: files, message: 'Choose at least one photo.' }]); return false; }
      clearFieldErrors(body);
      const isEdited = edited.checked;
      working = true;
      try {
        for (const [i, file] of list.entries()) {
          if (done.has(file)) continue;
          progress.textContent = stepText('Uploading', picture ? 'picture' : 'photo', i, list.length);
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
      } finally { working = false; progress.textContent = ''; }
    } },
  ], stayOpenWhile(() => working));
}

export const DOCUMENT_KINDS = { consent: 'Consent form', id: 'ID copy', report: 'Report', other: 'Other' };

// Consent forms, ID copies and reports (PDF or photo) for a patient's record. { consent: true } is "Upload consent form": the type
// is fixed, and a form photographed page by page goes in as several photos (one document each, numbered). On a phone or tablet the
// file picker offers the camera as well. A consent form ticks "Consent signed" on the record (the database does it).
export function documentUploadModal(patient, { onDone, consent = false } = {}) {
  const file = h('input', { type: 'file', accept: 'application/pdf,image/*', multiple: true });
  const kind = select(Object.entries(DOCUMENT_KINDS).map(([value, label]) => ({ value, label })), 'consent');
  const title = h('input', { placeholder: 'e.g. Consent and information form', value: 'Consent and information form' });
  const date = h('input', { type: 'date', value: localISO() });
  kind.addEventListener('change', () => { if (!title.value || Object.values(DOCUMENT_KINDS).includes(title.value) || title.value.startsWith('Consent')) title.value = kind.value === 'consent' ? 'Consent and information form' : DOCUMENT_KINDS[kind.value]; });
  // A failed batch must not save the files that already went through again: remember which files are done, and give each file one
  // idempotency key for all attempts (a save whose answer was lost is then found, not saved twice).
  const done = new Set();
  const keys = new Map();
  const progress = progressLine();
  let working = false;
  const body = h('div', {},
    h('p', { class: 'muted' }, consent ? 'The signed consent form: a PDF, or photos of its pages. Saving it ticks "Consent signed" on the record.'
      : 'Scanned forms and ID copies stay private to staff; patients see only their own.'),
    field('File', file, consent ? 'PDF or photos of the signed form (several pages at once is fine).' : 'PDF or a photo of the signed form.', { required: true }),
    consent ? null : field('Type', kind), field('Title', title), field('Date', date), progress);
  modal(`${consent ? 'Upload consent form' : 'Add document'} · ${patient.full_name}`, body, [
    { label: 'Cancel' },
    { label: 'Save', primary: true, onClick: async () => {
      const list = [...file.files];
      if (!list.length) { showFormErrors(body, [{ input: file, message: 'Choose a file.' }]); return false; }
      clearFieldErrors(body);
      const docKind = consent ? 'consent' : kind.value;
      const name = title.value.trim() || DOCUMENT_KINDS[docKind];
      // "Consent signed" as the record has it after the save (the database ticks it), so the message never claims a tick that did not happen.
      let signedAt = null;
      working = true;
      try {
        for (const [i, f] of list.entries()) {
          if (done.has(f)) continue;
          progress.textContent = stepText('Saving', docKind === 'consent' ? 'page' : 'file', i, list.length);
          if (!keys.has(f)) keys.set(f, newKey());
          const row = await state.data.uploadDocument({ patientId: patient.id, file: f, kind: docKind, title: list.length > 1 ? `${name} (${i + 1} of ${list.length})` : name,
            addedOn: date.value, idempotencyKey: keys.get(f) });
          signedAt = row?.treatment_consent_at || signedAt;
          done.add(f);
        }
        const what = consent ? 'Consent form' : 'Document';
        toast(`${list.length > 1 ? `${list.length} files saved` : `${what} saved`}.${docKind === 'consent' && !patient.treatment_consent_at && signedAt ? ' "Consent signed" is now ticked.' : ''}`, 'ok');
        await onDone?.();
      } catch (e) {
        const partly = list.filter((f) => done.has(f)).length;
        toast(`${friendlyError(e)}${partly ? ` ${partly} of ${list.length} files were saved; pressing Save again sends only the rest.` : ''}`, 'error');
        return false;
      } finally { working = false; progress.textContent = ''; }
    } },
  ], stayOpenWhile(() => working));
}

// Delete on the Documents list, for the people who may add documents: asks first, then removes the file and the row (the audit log
// keeps who deleted what). Deleting the last consent form also asks whether to untick "Consent signed".
export function deleteDocumentModal(patient, doc, { onDone } = {}) {
  const name = doc.title || DOCUMENT_KINDS[doc.kind] || 'this document';
  const lastConsent = doc.kind === 'consent' && !!patient.treatment_consent_at && !(patient.documents || []).some((x) => x.id !== doc.id && x.kind === 'consent');
  const untick = lastConsent ? h('input', { type: 'checkbox' }) : null;
  const body = h('div', {},
    h('p', {}, `Delete ${name} from ${patient.full_name}'s record? This cannot be undone.`),
    untick ? h('label', { class: 'inline', style: { marginTop: '8px' } }, untick, 'This is the last consent form on the record. Also untick "Consent signed"') : null);
  modal('Delete this document?', body, [
    { label: 'Cancel' },
    { label: 'Delete', danger: true, onClick: async () => {
      try {
        const res = await state.data.deleteDocument(doc, { clearConsent: !!untick?.checked });
        toast(res?.deleted === false ? 'This document was already deleted.' : res?.consent_cleared ? 'Document deleted. "Consent signed" is unticked.' : 'Document deleted.', 'ok');
      } catch (e) { toast(friendlyError(e), 'error'); return false; }
      await onDone?.();
    } },
  ], { destructive: true });
}

// Delete for a picture or an X-ray on the patient profile (owner, 16 Oct 2026: "they can delete assistant and coordinator";
// "Delete clinic photos and X-rays", 20261016000200). The dialog names what goes, and what goes with it: an edited picture disappears from
// the patient's page, one marked for the website from the website; edited pictures made from a raw one stay; when it is the last picture
// of a photo month not yet completed, that visit asks for photos again (a completed visit, or one that is no photo month, asks nothing).
export function deletePhotoModal(patient, photo, { onDone } = {}) {
  const what = [photo.view_label, shortDate(photo.taken_on)].filter(Boolean).join(', ');
  const others = (patient.photos || []).filter((x) => x.id !== photo.id);
  const copies = others.filter((x) => x.edited_from === photo.id).length;
  const visit = photo.visit_id && !others.some((x) => x.visit_id === photo.visit_id) ? (patient.visits || []).find((v) => v.id === photo.visit_id) : null;
  const asksAgain = !!visit?.photo_required && !['completed', 'cancelled', 'no_show'].includes(visit.status);
  const notes = [
    photo.kind === 'edited' || photo.sent_to_patient_at ? 'The patient sees this picture on their page: it disappears from there too.' : null,
    photo.public_ok ? 'It may be shown on the website ("Our results"): it disappears from the website too.' : null,
    copies ? `${copies === 1 ? 'The edited picture' : `The ${copies} edited pictures`} made from it stay${copies === 1 ? 's' : ''} on the record.` : null,
    asksAgain ? 'It is the only picture of its visit, a photo month not yet completed: that visit asks for photos again before it is completed.' : null,
  ].filter(Boolean);
  const body = h('div', {},
    h('p', {}, `Delete the picture${what ? ` (${what})` : ''} from ${patient.full_name}'s record? The picture and its small copy are removed for good. This cannot be undone.`),
    notes.length ? h('ul', { class: 'delete-notes' }, notes.map((n) => h('li', {}, n))) : null);
  modal('Delete this picture?', body, [
    { label: 'Cancel' },
    { label: 'Delete', danger: true, onClick: async () => {
      try {
        const res = await state.data.deletePhoto(photo);
        toast(res?.deleted === false ? 'This picture was already deleted.' : `Picture deleted.${res?.visit_asks_photos ? ' Its visit asks for photos again.' : ''}`, 'ok');
      } catch (e) { toast(friendlyError(e), 'error'); return false; }
      await onDone?.();
    } },
  ], { destructive: true });
}

export function deleteXrayModal(patient, xray, { onDone } = {}) {
  const what = [xray.kind, shortDate(xray.taken_on)].filter(Boolean).join(', ');
  const body = h('div', {},
    h('p', {}, `Delete the X-ray${what ? ` (${what})` : ''} from ${patient.full_name}'s record? The X-ray file is removed for good. This cannot be undone.`));
  modal('Delete this X-ray?', body, [
    { label: 'Cancel' },
    { label: 'Delete', danger: true, onClick: async () => {
      try {
        const res = await state.data.deleteXray(xray);
        toast(res?.deleted === false ? 'This X-ray was already deleted.' : 'X-ray deleted.', 'ok');
      } catch (e) { toast(friendlyError(e), 'error'); return false; }
      await onDone?.();
    } },
  ], { destructive: true });
}

export const XRAY_KINDS = ['OPG', 'Periapical (PA)', 'Bitewing', 'Lateral ceph', 'CBCT', 'Other'];

// X-rays go to the patient's X-ray store (the xrays table and its private bucket), not the clinic photos. Files from the X-ray
// machine, or a photo of the film or screen: no capture attribute, so a phone or tablet offers the camera and the gallery both.
export function xrayUploadModal(patient, { visitId, onDone } = {}) {
  const files = h('input', { type: 'file', accept: 'image/*', multiple: true });
  const kind = select(XRAY_KINDS, 'OPG');
  const date = h('input', { type: 'date', value: localISO() });
  const notes = h('input', { placeholder: 'Optional, e.g. lower left 6' });
  // As for photos: files already saved are not sent again, and each file keeps one idempotency key for all attempts.
  const done = new Set();
  const keys = new Map();
  const progress = progressLine();
  let working = false;
  const body = h('div', {},
    h('p', { class: 'muted' }, "X-rays are kept private with the patient's record. Choose the files from the X-ray machine, or take a photo of the X-ray."),
    field('X-rays', files, 'Several at once is fine.', { required: true }),
    h('div', { class: 'form-grid' }, field('Type', kind), field('Date taken', date)), field('Note', notes), progress);
  modal(`Upload X-ray · ${patient.full_name}`, body, [
    { label: 'Cancel' },
    { label: 'Upload', primary: true, onClick: async () => {
      const list = [...files.files];
      if (!list.length) { showFormErrors(body, [{ input: files, message: 'Choose at least one X-ray.' }]); return false; }
      clearFieldErrors(body);
      working = true;
      try {
        for (const [i, file] of list.entries()) {
          if (done.has(file)) continue;
          progress.textContent = stepText('Uploading', 'X-ray', i, list.length);
          if (!keys.has(file)) keys.set(file, newKey());
          await state.data.uploadXray({ patientId: patient.id, visitId, file, kind: kind.value, takenOn: date.value || localISO(), notes: notes.value.trim() || null, idempotencyKey: keys.get(file) });
          done.add(file);
        }
        toast(`${list.length} X-ray${list.length > 1 ? 's' : ''} uploaded.`, 'ok');
        await onDone?.();
      } catch (e) {
        const partly = list.filter((f) => done.has(f)).length;
        toast(`${friendlyError(e)}${partly ? ` ${partly} of ${list.length} X-rays were uploaded; pressing Upload again sends only the rest.` : ''}`, 'error');
        return false;
      } finally { working = false; progress.textContent = ''; }
    } },
  ], stayOpenWhile(() => working));
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
