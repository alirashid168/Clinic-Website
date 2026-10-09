// Pieces shared by the Aaj ki List and the Checkups page. A checkup patient has a date, a branch, a name, a phone
// and a treatment, but no Mr#: they get a patient file (and an Mr#) only when they start treatment.
import { h, mount, modal, field, toast, friendlyError, announce, showFormErrors, clearFieldErrors, localISO, shortDate, busy } from '../../ui/dom.js';
import { state, can, isAdmin, myBranches, defaultBranchId, branchName, cityName } from '../../state.js';
import { FOLLOW_UP_STATUSES, checkupPhone } from '../../lib/checkups.js';
import { commitOnFinish } from './common.js';

const digitsOf = (v) => String(v || '').replace(/\D/g, '');
const PHONE_HINT = 'Write a full phone number with at least 10 digits, e.g. 0300 1234567.';
const mrLine = (p) => `${p.full_name} (Mr# ${p.mr_number}${p.phone ? `, ${p.phone}` : ''})`;
let formSeq = 0;

/** A checkup row that is already a patient: the Mr# to show, or '' when it is not (or the reader may not see patients). */
export const registeredMr = (row) => (row?.patient_id ? row.mr_number || '' : '');

// One colour family per follow-up status group; the text of the option always says which one it is.
export function followTone(value) {
  if (value === 'Started' || value === 'Completed') return 'tone-ok';
  if (value === 'Scheduled' || value === 'Interested' || value === 'Follow-up Sent') return 'tone-info';
  if (value === 'Not Contacted') return 'tone-warn';
  return 'tone-muted';
}

/**
 * The follow-up status dropdown of a checkup. Only the 11 statuses can be chosen (typing would split the filters),
 * but a value the row already holds (imported, or from the sheet) is kept as one more option.
 * It saves once the person has finished choosing, like the status select of the Aaj ki List:
 * onCommit(value, ctl, previous) runs once per change, and ctl.set(previous) puts the old value back if the save failed.
 */
export function followUpSelect(row, onCommit, { disabled = false, label } = {}) {
  const current = row.follow_up || 'Not Contacted';
  const values = FOLLOW_UP_STATUSES.includes(current) ? FOLLOW_UP_STATUSES : [...FOLLOW_UP_STATUSES, current];
  const sel = h('select', {
    class: `status-chip follow-chip ${followTone(current)}`, 'aria-label': label || `Follow-up status for ${row.patient_name}`,
    disabled, dataset: { focus: 'follow-up' },
  }, values.map((v) => h('option', { value: v, selected: v === current }, v)));
  const ctl = commitOnFinish(sel, (value, previous) => onCommit(value, ctl, previous), (value) => { sel.className = `status-chip follow-chip ${followTone(value)}`; });
  return sel;
}

/** Only people who keep the list may remove a checkup; a row from the old list can be removed by Dr. Ali only. */
export const canRemoveCheckup = (row) => can('sheet.edit') && (isAdmin() || row.source !== 'archive');

/** Registering links the checkup to the new patient file and moves its follow-up status, so (as in the database) it needs both rights. */
export const canRegisterCheckup = () => can('patients.create') && can('sheet.edit');

/**
 * The form for one checkup patient. Resolves the saved row, or { patient } when staff chose the existing patient
 * file of the same person instead (Aaj ki List only), or null when it was cancelled.
 * fixedDay: the date and branch come from the list on screen and are not asked.
 */
export function checkupFormModal({ branchId, date, fixedDay = false, onSaved } = {}) {
  return new Promise((resolve) => {
    const today = localISO();
    const n = ++formSeq;
    const name = h('input', { autocomplete: 'off', maxlength: 200 });
    const phone = h('input', { type: 'tel', placeholder: '03xx xxxxxxx', maxlength: 40 });
    const checkupFor = h('input', { value: 'Checkup', list: `cf-treatments-${n}`, maxlength: 300, autocomplete: 'off' });
    const doctor = h('input', { list: `cf-doctors-${n}`, maxlength: 300, autocomplete: 'off', placeholder: 'Optional. Several names are fine.' });
    const details = h('input', { maxlength: 2000, autocomplete: 'off', placeholder: 'Optional, e.g. Scaling advised' });
    const dateIn = fixedDay ? null : h('input', { type: 'date', value: date || today, max: today });
    const branch = fixedDay ? null : h('select', {}, myBranches().map((b) => h('option', { value: b.id, selected: b.id === Number(branchId || defaultBranchId()) }, b.name)));
    const followUp = fixedDay ? null : h('select', {}, FOLLOW_UP_STATUSES.map((s) => h('option', { value: s, selected: s === 'Not Contacted' }, s)));
    const notes = fixedDay ? null : h('textarea', { rows: 2, maxlength: 2000, placeholder: 'Optional' });
    const warn = h('div', {});
    let done = false;
    let dupSeq = 0;
    let dialog = null;

    const checkDupes = async () => {
      const mine = ++dupSeq;
      const day = fixedDay ? date : dateIn.value;
      const bId = fixedDay ? Number(branchId) : Number(branch.value) || null;
      const phoneKey = checkupPhone(phone.value);
      const [rows, sameDay] = await Promise.all([
        state.data.findDuplicates(name.value, phone.value).catch(() => []),
        // The same phone number on the same day's list at the same branch: almost always one person typed twice.
        phoneKey && day && state.data.listDayCheckups
          ? state.data.listDayCheckups({ branchId: bId, date: day }).then((list) => list.filter((c) => checkupPhone(c.phone) === phoneKey)).catch(() => [])
          : [],
      ]);
      if (mine !== dupSeq || done) return;
      const phoneDigits = digitsOf(phone.value);
      const sorted = [...rows].sort((a, b) => Number(digitsOf(b.phone) === phoneDigits && phoneDigits.length >= 7) - Number(digitsOf(a.phone) === phoneDigits && phoneDigits.length >= 7)).slice(0, 3);
      mount(warn,
        sameDay.length ? h('div', { class: 'alert alert-warning', role: 'status' }, sameDay.slice(0, 3).map((c) => h('div', { class: 'dup-line' },
          h('span', {}, h('strong', {}, `Already on the list for ${shortDate(day)}: `), `${c.patient_name} (${c.phone}). Press Cancel unless this is a different person.`)))) : null,
        sorted.length ? h('div', { class: 'alert alert-warning', role: 'status' }, sorted.map((p) => {
          const samePhone = phoneDigits.length >= 7 && digitsOf(p.phone) === phoneDigits;
          return h('div', { class: 'dup-line' },
            h('span', {}, h('strong', {}, samePhone ? 'This person already has a patient file: ' : 'A patient file with the same name exists: '), mrLine(p), samePhone ? '.' : '. Same person?'),
            fixedDay
              ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => { done = true; resolve({ patient: p }); dialog?.close(); } }, `Add Mr# ${p.mr_number} to the list instead`)
              : h('a', { class: 'btn btn-small', href: `#/staff/patient/${p.id}` }, 'Open the patient file'));
        })) : null);
    };
    let typing;
    name.addEventListener('change', checkDupes);
    phone.addEventListener('change', checkDupes);
    phone.addEventListener('input', () => { clearTimeout(typing); if (digitsOf(phone.value).length >= 7) typing = setTimeout(checkDupes, 500); });
    dateIn?.addEventListener('change', checkDupes);
    branch?.addEventListener('change', checkDupes);

    const where = fixedDay ? `${branchName(branchId)} on ${shortDate(date)}` : '';
    const body = h('div', {},
      h('p', { class: 'muted' }, fixedDay
        ? `Goes on the list for ${where} and on the Checkups page. A checkup patient has no Mr#; they get one when they start treatment.`
        : "Goes on the Checkups page, and on that branch's Aaj ki List for the day you choose. A checkup patient has no Mr#; they get one when they start treatment."),
      warn,
      h('div', { class: 'form-grid' },
        field('Name', name, null, { required: true }),
        field('Phone number', phone, null, { required: true }),
        field('Treatment', checkupFor),
        field("Doctor's name", doctor),
        fixedDay ? null : field('Date', dateIn, 'Today or an earlier day.', { required: true }),
        fixedDay ? null : field('Branch', branch),
        field('Treatment details', details),
        fixedDay ? null : field('Follow-up status', followUp),
        fixedDay ? null : field('Notes', notes)),
      h('datalist', { id: `cf-treatments-${n}` }, state.ref.treatments.map((t) => h('option', { value: t.name }))),
      h('datalist', { id: `cf-doctors-${n}` }, state.ref.clinicians.filter((c) => c.is_doctor).map((c) => h('option', { value: c.display_name }))));

    dialog = modal(fixedDay ? 'Add a checkup patient' : 'Add a checkup', body, [
      { label: 'Cancel' },
      { label: 'Add checkup patient', primary: true, onClick: async () => {
        const errors = [];
        if (name.value.trim().length < 2) errors.push({ input: name, message: 'Write the patient name.' });
        if (digitsOf(phone.value).length < 10) errors.push({ input: phone, message: PHONE_HINT });
        if (!fixedDay && !dateIn.value) errors.push({ input: dateIn, message: 'Choose the day of the checkup.' });
        else if (!fixedDay && dateIn.value > today) errors.push({ input: dateIn, message: 'Choose today or an earlier day.' });
        if (errors.length) return showFormErrors(body, errors);
        clearFieldErrors(body);
        const day = fixedDay ? date : dateIn.value;
        const bId = fixedDay ? Number(branchId) : Number(branch.value) || null;
        const b = state.ref.branches.find((x) => x.id === bId);
        try {
          const row = await state.data.addCheckup({
            checkup_date: day, branch_id: bId, patient_name: name.value.trim().replace(/\s+/g, ' '), phone: phone.value.trim(),
            city: (b && cityName(b.city_id)) || null, doctors: doctor.value.trim() || null, checkup_for: checkupFor.value.trim() || 'Checkup',
            details: details.value.trim() || null, day_status: day === today ? 'waiting' : 'completed',
            follow_up: fixedDay ? 'Not Contacted' : followUp.value, notes: fixedDay ? null : (notes.value.trim() || null),
          });
          done = true;
          onSaved?.(row);
          resolve(row);
        } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ], { onClose: () => { done = true; resolve(null); } });
  });
}

/**
 * "Register as patient": gives a checkup patient a patient file with the next Mr# (or links them to the file they
 * already have). onDone() runs as soon as something changed. list = { add(patient, treatment) } when opened from the
 * Aaj ki List, which adds "Put Mr# N on this list".
 */
export function registerCheckupModal(row, { onDone, list } = {}) {
  const d = state.data;
  const who = row.patient_name;
  const content = h('div', {}, h('p', { class: 'muted', role: 'status' }, 'Checking for an existing patient file…'));
  let dialog = null;

  const success = (r, verb) => {
    onDone?.();
    const open = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { dialog?.close(); location.hash = `#/staff/patient/${r.patient_id}`; } }, 'Open patient file');
    const put = list ? h('button', { type: 'button', class: 'btn', onclick: busy(async () => {
      await list.add({ id: r.patient_id, full_name: r.full_name, mr_number: r.mr_number, braces_active: false }, row.checkup_for || 'Checkup');
      dialog?.close();
    }) }, `Put Mr# ${r.mr_number} on this list`) : null;
    mount(content,
      h('p', { class: 'registered-mr', tabindex: '-1', role: 'status' }, `${verb}: Mr# ${r.mr_number}`),
      h('p', { class: 'muted' }, `${r.full_name} has a patient file now. Their checkup stays on the Checkups page.`),
      h('div', { class: 'inline' }, open, put, h('button', { type: 'button', class: 'btn', onclick: () => dialog?.close() }, 'Close')));
    announce(`${verb}: Mr# ${r.mr_number}.`);
    open.focus();
  };

  const create = busy(async () => {
    try { success(await d.registerCheckupAsPatient(row.id), 'Registered'); } catch (e) { if (/ALREADY_REGISTERED/.test(e?.message || '')) onDone?.(); throw e; }
  });
  const link = (p) => busy(async () => {
    try { success(await d.linkCheckupToPatient(row.id, p.id), 'Linked'); } catch (e) { if (/ALREADY_REGISTERED/.test(e?.message || '')) onDone?.(); throw e; }
  });

  function showChoices(matches) {
    const createBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: create }, 'Create patient file');
    const canLink = can('sheet.edit') && can('patients.view');
    mount(content,
      h('p', {}, `This creates a patient file for ${who} with the next Mr#, using this name, phone and branch. Use it when they start treatment.`),
      matches.length ? h('div', { class: 'alert alert-warning' },
        h('strong', {}, matches.length === 1 ? 'This patient file may be the same person: ' : 'These patient files may be the same person: '),
        matches.map((p) => h('div', { class: 'dup-line' }, h('span', {}, mrLine(p)),
          canLink ? h('button', { type: 'button', class: 'btn btn-small', onclick: link(p) }, `Same person: link to Mr# ${p.mr_number}`) : null))) : null,
      h('div', { class: 'inline' }, createBtn, h('button', { type: 'button', class: 'btn', onclick: () => dialog?.close() }, 'Cancel')));
    if (dialog?.dialog.contains(document.activeElement) || document.activeElement === document.body) createBtn.focus();
  }

  dialog = modal(`Register ${who} as a patient`, content, []);
  d.findDuplicates(row.patient_name, row.phone).catch(() => []).then((rows) => { if (dialog.dialog.isConnected) showChoices(rows.slice(0, 5)); });
  return dialog;
}

/** Asks first, then removes the checkup (a real delete). onDone(row) runs after it is gone. */
export function removeCheckupModal(row, { onDone } = {}) {
  return modal(`Remove ${row.patient_name}?`,
    h('p', {}, `Remove ${row.patient_name} from the list? Use this for a wrong entry or someone who did not come. It is removed from the checkup list too.`), [
      { label: 'Keep it' },
      { label: 'Remove', danger: true, onClick: async () => {
        await state.data.deleteCheckup(row.id);
        toast(`${row.patient_name} removed.`, 'ok');
        onDone?.(row);
      } },
    ], { destructive: true });
}
