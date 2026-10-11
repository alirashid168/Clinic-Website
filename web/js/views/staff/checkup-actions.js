// Pieces shared by the Aaj ki List, the Checkups page and the Today page. A checkup patient has a date, a branch, a name, a phone
// and a treatment, but no Mr#: they get a patient file (and an Mr#) only when they start treatment.
import { h, mount, modal, field, select, toast, friendlyError, announce, showFormErrors, clearFieldErrors, localISO, shortDate, busy } from '../../ui/dom.js';
import { state, can, isAdmin, myBranches, branchName, cityName } from '../../state.js';
import { FOLLOW_UP_STATUSES, CHECKUP_FOR_CHOICES, PRICING_LABELS, checkupPhone, formComplete } from '../../lib/checkups.js';
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

// ---------------------------------------------------------------- the checkup form ("Checkup Patient Form 2.0")
// The clinic's Google Form of the same name, now on the website (owner, 11 Oct 2026: "the checkup 2.0 form is good, and we are using
// that form now ... once entered, these details go into the checkup list"). The assistant asks the patient the nine questions after the
// checkup, in this order. Five of them have the columns checkups always had (name, branch, phone, doctors, checkup_for); the other four
// are the columns of migration 20261011000300.
const OTHER = '__other';
const YES_NO = [['yes', 'Yes'], ['no', 'No']];
const asYesNo = (v) => (v === true ? 'yes' : v === false ? 'no' : null);

// A question answered with radio buttons: a fieldset whose legend is the question. value() is the chosen value, or null.
// setFieldError() marks and listens on the first radio, so a choice anywhere in the group tells it the error is fixed.
function choiceQuestion(question, choices, current, { required = false } = {}) {
  const name = `cq-${++formSeq}`;
  const radios = choices.map(([value]) => h('input', { type: 'radio', name, value, checked: current === value }));
  const set = h('fieldset', { class: 'fieldset-plain choice-group' },
    h('legend', {}, question, required ? h('span', { class: 'req' }, ' (required)') : null),
    h('div', { class: 'choice-row' }, radios.map((r, i) => h('label', { class: 'choice' }, r, h('span', {}, choices[i][1])))));
  set.addEventListener('change', (e) => { if (e.target !== radios[0]) radios[0].dispatchEvent(new Event('change')); });
  return { el: h('div', { class: 'field' }, set), first: radios[0], value: () => radios.find((r) => r.checked)?.value ?? null };
}

// A drop-down with "Other" at the end, which shows a text box for the answer. value() is the choice, the text typed for Other, or null.
// An answer that is not one of the choices (a checkup from before the form, or from the sheet) opens as Other with its own text, so a
// row saved without touching it keeps what it had.
function choiceSelect(label, choices, current, { otherLabel, required = false }) {
  const text = String(current ?? '').trim();
  const hit = choices.includes(text) ? text : null;
  const sel = h('select', {},
    h('option', { value: '' }, required ? 'Choose…' : 'Not recorded'),
    choices.map((c) => h('option', { value: c, selected: c === hit }, c)),
    h('option', { value: OTHER, selected: !!text && !hit }, 'Other'));
  const other = h('input', { maxlength: 300, autocomplete: 'off', value: text && !hit ? text : '' });
  const otherField = field(otherLabel, other, null, { required: true });
  const sync = () => { otherField.hidden = sel.value !== OTHER; };
  sel.addEventListener('change', sync);
  sync();
  // (one cell of the form's grid: the text box opens right under its drop-down)
  return { sel, other, el: h('div', {}, field(label, sel, null, { required }), otherField), value: () => (sel.value === OTHER ? other.value.trim().replace(/\s+/g, ' ') || null : sel.value || null) };
}

/**
 * The nine questions of the form, in its order, as fields. "+ Add checkup patient" (row = null: a new checkup), "Fill in the checkup form"
 * on the Aaj ki List (row = a checkup on the list, fill = true) and Edit on the Checkups page (row = the checkup) use them. A new checkup
 * and the form filled in for a checkup on the list need every question. A checkup from before the form, from the sheet or from the old
 * list has no answers, and one answer may be added later (after a follow-up call), so Edit asks for the four new ones only when the form
 * was filled in for that checkup (all four answered when the dialog opened).
 * branchId: the branch to start with, else the person's home branch, else "Choose…" (a guessed branch would look answered);
 * branchFixed: shown, not asked (the branch's own Aaj ki List).
 * -> { el, name, phone, branch, values(), errors() }
 */
export function checkupQuestions({ row = null, branchId = null, branchFixed = false, fill = false } = {}) {
  const editing = !!row && !fill;
  const needAnswers = !editing || formComplete(row);
  const name = h('input', { autocomplete: 'off', maxlength: 200, value: row?.patient_name || '' });
  const phone = h('input', { type: 'tel', placeholder: '03xx xxxxxxx', maxlength: 40, value: row?.phone || '' });

  // The branch: a drop-down of the person's branches, starting at branchId or their home branch, else at "Choose…"; fixed when they work at
  // one branch only, or the list on screen is a branch's.
  const mine = myBranches();
  let branch;
  let branchValue;
  if (branchFixed || (!editing && mine.length === 1)) {
    const id = branchFixed ? Number(branchId) : mine[0].id;
    branch = h('input', { value: branchName(id), readonly: true, class: 'input-readonly' });
    branchValue = () => id;
  } else {
    const startAt = editing ? row.branch_id : Number(branchId || state.session?.staff?.home_branch_id) || null;
    const choices = mine.map((b) => ({ value: b.id, label: b.name }));
    if (editing && row.branch_id && !choices.some((b) => b.value === Number(row.branch_id))) choices.push({ value: Number(row.branch_id), label: branchName(row.branch_id) || `Branch ${row.branch_id}` });
    const known = choices.some((b) => b.value === Number(startAt));
    branch = select([...(editing ? [{ value: '', label: 'No branch' }] : known ? [] : [{ value: '', label: 'Choose…' }]), ...choices], known ? startAt : '');
    branchValue = () => Number(branch.value) || null;
  }

  const doctors = state.ref.clinicians.filter((c) => c.is_doctor && c.active !== false).map((c) => c.display_name);
  const doctor = choiceSelect('Who did your checkup?', doctors, row?.doctors, { otherLabel: 'Other: who did the checkup?', required: !editing });
  const ali = choiceQuestion('Did Dr. Ali recommend your treatment?', YES_NO, asYesNo(row?.ali_recommended), { required: needAnswers });
  // (the plain word "Checkup" that marks a checkup row in the sheet is no answer: filling in the form asks it)
  const forNow = fill && /^checkup$/i.test(String(row.checkup_for ?? '').trim()) ? null : row?.checkup_for;
  const checkupFor = choiceSelect('What was your checkup for?', CHECKUP_FOR_CHOICES, forNow, { otherLabel: 'Other: what was the checkup for?', required: !editing });
  const pricing = choiceQuestion('Did you understand the pricing details?', Object.entries(PRICING_LABELS), row?.pricing_understood || null, { required: needAnswers });
  const wants = choiceQuestion('Would you like to start the treatment?', YES_NO, asYesNo(row?.wants_treatment), { required: needAnswers });
  const plan = h('input', { maxlength: 500, autocomplete: 'off', value: row?.treatment_plan || '' });

  const el = h('div', { class: 'form-grid checkup-form' },
    field('Patient full name', name, null, { required: true }),
    field('Which branch did you visit?', branch, null, { required: !editing }),
    field('Mobile number', phone, null, { required: !editing }),
    doctor.el,
    ali.el,
    checkupFor.el,
    pricing.el,
    wants.el,
    h('div', { class: 'checkup-form-wide' }, field('If yes, then when? If no, then why not?', plan, 'At most 500 characters.', { required: needAnswers })));

  const values = () => ({
    patient_name: name.value.trim().replace(/\s+/g, ' '),
    branch_id: branchValue(),
    phone: phone.value.trim() || null,
    doctors: doctor.value(),
    ali_recommended: ali.value() === null ? null : ali.value() === 'yes',
    checkup_for: checkupFor.value(),
    pricing_understood: pricing.value(),
    wants_treatment: wants.value() === null ? null : wants.value() === 'yes',
    treatment_plan: plan.value.trim() || null,
  });
  const errors = () => {
    const out = [];
    if (editing ? !name.value.trim() : name.value.trim().length < 2) out.push({ input: name, message: 'Write the patient name.' });
    if (!editing && !branchValue()) out.push({ input: branch, message: 'Choose the branch.' });
    if (!editing && digitsOf(phone.value).length < 10) out.push({ input: phone, message: PHONE_HINT });
    if (!editing && !doctor.sel.value) out.push({ input: doctor.sel, message: 'Choose who did the checkup.' });
    if (doctor.sel.value === OTHER && !doctor.other.value.trim()) out.push({ input: doctor.other, message: 'Write who did the checkup.' });
    if (needAnswers && ali.value() === null) out.push({ input: ali.first, message: 'Choose whether Dr. Ali recommended the treatment.' });
    if (!editing && !checkupFor.sel.value) out.push({ input: checkupFor.sel, message: 'Choose what the checkup was for.' });
    if (checkupFor.sel.value === OTHER && !checkupFor.other.value.trim()) out.push({ input: checkupFor.other, message: 'Write what the checkup was for.' });
    if (needAnswers && !pricing.value()) out.push({ input: pricing.first, message: 'Choose whether the pricing was understood.' });
    if (needAnswers && wants.value() === null) out.push({ input: wants.first, message: 'Choose whether they want to start the treatment.' });
    if (needAnswers && !plan.value.trim()) out.push({ input: plan, message: 'Write when they want to start, or why not.' });
    else if (Array.from(plan.value.trim()).length > 500) out.push({ input: plan, message: 'Write at most 500 characters.' });
    return out;
  };
  return { el, name, phone, branch, values, errors };
}

// The form is a whole interview, filled in on phones all day: Escape, the × or a tap on the strip around the dialog asks before the
// answers are thrown away. snapshot() is what the form holds; nothing is asked while it holds what it opened with.
function discardGuard(snapshot) {
  const start = snapshot();
  return () => snapshot() === start || new Promise((resolve) => {
    let discard = false;
    modal('Discard this checkup form?', h('p', {}, 'The answers typed in it are not saved.'), [
      { label: 'Keep filling in' },
      { label: 'Discard', danger: true, onClick: () => { discard = true; } },
    ], { destructive: true, onClose: () => resolve(discard) });
  });
}

// Text typed under "More" for a checkup that already has some is added after it (cut to the column's 2,000 characters); undefined leaves it.
function addedText(had, typed) {
  const t = typed.trim();
  if (!t || (had && had.includes(t))) return undefined;
  return had ? Array.from(`${had}\n${t}`).slice(0, 2000).join('') : t;
}

/**
 * "+ Add checkup patient": the form for one checkup patient. Resolves the saved row; { updated } (the row) when the same person was already
 * on that day's list and the answers went on that checkup; { patient } when staff chose the existing patient file of the same person
 * instead (Aaj ki List only); or null when it was cancelled.
 * fixedDay: the date and branch come from the list on screen and are not asked. Otherwise the checkup is for today at the person's
 * branch; another day (and the follow-up status) can be chosen under "More (optional)".
 * The answers are given after the checkup, so the checkup is saved as Completed (also on the Aaj ki List and the Google Sheet, where a
 * deleted row then does not take the checkup and its answers with it).
 */
export function checkupFormModal({ branchId, date, fixedDay = false, onSaved } = {}) {
  return new Promise((resolve) => {
    const today = localISO();
    const q = checkupQuestions({ branchId, branchFixed: fixedDay });
    const { name, phone, branch } = q;
    const dateIn = fixedDay ? null : h('input', { type: 'date', value: date || today, max: today });
    const followUp = fixedDay ? null : h('select', {}, FOLLOW_UP_STATUSES.map((s) => h('option', { value: s, selected: s === 'Not Contacted' }, s)));
    const details = h('input', { maxlength: 2000, autocomplete: 'off', placeholder: 'e.g. Scaling advised' });
    const notes = h('textarea', { rows: 2, maxlength: 2000 });
    const more = h('details', { class: 'form-more' },
      h('summary', {}, 'More (optional)'),
      h('div', { class: 'form-grid' },
        fixedDay ? null : field('Date of the checkup', dateIn, 'Today or an earlier day.'),
        fixedDay ? null : field('Follow-up status', followUp),
        field('Treatment details', details),
        field('Notes', notes)));
    const warn = h('div', {});
    let done = false;
    let dupSeq = 0;
    let dialog = null;
    let body = null;
    let sameDayNow = []; // the checkups the warning names: the same phone on that day's list at that branch

    // The same person already on that day's list (typed into the Google Sheet on arrival, or added at the desk): the answers go on that
    // checkup instead of a second one. Its name and phone stay as they are. -> true once saved (the dialog is then closed).
    const saveAnswersOn = async (c) => {
      const errors = q.errors();
      if (errors.length) return showFormErrors(body, errors);
      clearFieldErrors(body);
      const a = q.values();
      if (checkupPhone(a.phone) !== checkupPhone(c.phone) || a.branch_id !== c.branch_id || (fixedDay ? date : dateIn.value) !== c.checkup_date) { checkDupes(); return false; }
      const row = await state.data.updateCheckup(c.id, {
        doctors: a.doctors, checkup_for: a.checkup_for, ali_recommended: a.ali_recommended, pricing_understood: a.pricing_understood,
        wants_treatment: a.wants_treatment, treatment_plan: a.treatment_plan, day_status: 'completed',
        details: addedText(c.details, details.value), notes: addedText(c.notes, notes.value),
        follow_up: !fixedDay && followUp.value !== 'Not Contacted' ? followUp.value : undefined,
      });
      if (!row) { toast(`${c.patient_name} is no longer on the list.`, 'error'); checkDupes(); return false; }
      done = true;
      onSaved?.(row);
      resolve({ updated: row });
      dialog?.close();
      return true;
    };
    // "Add checkup patient" pressed while the warning is there (above the questions, so out of sight on a phone by then): asked once more.
    // -> 'back', 'add' (a different person with the same phone) or the checkup to save the answers on.
    const sameDayChoice = (matches, day) => new Promise((answer) => {
      const one = matches.length === 1 ? matches[0] : null;
      let choice = 'back';
      modal(`Already on the list for ${shortDate(day)}`, h('div', {},
        h('p', {}, `${matches.map((c) => `${c.patient_name} (${c.phone})`).join(', ')} ${one ? 'is' : 'are'} already on the list for ${shortDate(day)} with this phone number.`),
        h('p', {}, one ? 'Same person? Save the answers on that checkup, so they are not on the list twice.' : 'Same person? Go back and save the answers on their checkup, so they are not on the list twice.')), [
        { label: 'Go back' },
        { label: 'Add as a different person', onClick: () => { choice = 'add'; } },
        ...(one ? [{ label: 'Save the answers on that checkup', primary: true, onClick: () => { choice = one; } }] : []),
      ], { onClose: () => answer(choice) });
    });

    const checkDupes = async () => {
      const mine = ++dupSeq;
      const day = fixedDay ? date : dateIn.value;
      const bId = q.values().branch_id;
      const phoneKey = checkupPhone(phone.value);
      const [rows, sameDay] = await Promise.all([
        state.data.findDuplicates(name.value, phone.value).catch(() => []),
        // The same phone number on the same day's list at the same branch: almost always one person typed twice.
        phoneKey && day && state.data.listDayCheckups
          ? state.data.listDayCheckups({ branchId: bId, date: day }).then((list) => list.filter((c) => checkupPhone(c.phone) === phoneKey)).catch(() => [])
          : [],
      ]);
      if (mine !== dupSeq || done) return;
      sameDayNow = sameDay;
      const phoneDigits = digitsOf(phone.value);
      const sorted = [...rows].sort((a, b) => Number(digitsOf(b.phone) === phoneDigits && phoneDigits.length >= 7) - Number(digitsOf(a.phone) === phoneDigits && phoneDigits.length >= 7)).slice(0, 3);
      mount(warn,
        sameDay.length ? h('div', { class: 'alert alert-warning', role: 'status' }, sameDay.slice(0, 3).map((c) => h('div', { class: 'dup-line' },
          h('span', {}, h('strong', {}, `Already on the list for ${shortDate(day)}: `), `${c.patient_name} (${c.phone}). `,
            formComplete(c) ? 'Its checkup form is already filled in. ' : '', 'Same person? Save the answers on this checkup, so they are not on the list twice.'),
          h('button', { type: 'button', class: 'btn btn-small', 'aria-label': `Save the answers on this checkup: ${c.patient_name}`, onclick: busy(() => saveAnswersOn(c)) }, 'Save the answers on this checkup')))) : null,
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
    branch.addEventListener('change', checkDupes);

    body = h('div', {},
      h('p', { class: 'muted' }, 'Ask the patient these questions after the checkup. ', fixedDay
        ? `Goes on the list for ${branchName(branchId)} on ${shortDate(date)} and on the Checkups page. A checkup patient has no Mr#; they get one when they start treatment.`
        : "Goes on the Checkups page, and on that branch's Aaj ki List for today (another day can be chosen under More). A checkup patient has no Mr#; they get one when they start treatment."),
      warn,
      q.el,
      more);

    const snapshot = () => JSON.stringify([q.values(), dateIn?.value, followUp?.value, details.value, notes.value]);
    dialog = modal('Add a checkup patient', body, [
      { label: 'Cancel' },
      { label: 'Add checkup patient', primary: true, onClick: async () => {
        const errors = q.errors();
        if (!fixedDay && !dateIn.value) errors.push({ input: dateIn, message: 'Choose the day of the checkup.' });
        else if (!fixedDay && dateIn.value > today) errors.push({ input: dateIn, message: 'Choose today or an earlier day.' });
        if (errors.length) {
          if (errors.some((e) => more.contains(e.input))) more.open = true; // a field under "More" cannot take focus while it is closed
          return showFormErrors(body, errors);
        }
        clearFieldErrors(body);
        const day = fixedDay ? date : dateIn.value;
        if (sameDayNow.length) {
          const choice = await sameDayChoice(sameDayNow, day);
          if (choice === 'back') { warn.querySelector('button')?.focus(); return false; }
          if (choice !== 'add') return (await saveAnswersOn(choice)) ? undefined : false;
        }
        const answers = q.values();
        const b = state.ref.branches.find((x) => x.id === answers.branch_id);
        try {
          const row = await state.data.addCheckup({
            ...answers, checkup_date: day, city: (b && cityName(b.city_id)) || null,
            details: details.value.trim() || null, day_status: 'completed',
            follow_up: fixedDay ? 'Not Contacted' : followUp.value, notes: notes.value.trim() || null,
          });
          done = true;
          onSaved?.(row);
          resolve(row);
        } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ], { onClose: () => { done = true; resolve(null); }, confirmDismiss: discardGuard(snapshot) });
  });
}

/**
 * "Fill in the checkup form" for a checkup already on the Aaj ki List (typed into the Google Sheet on arrival, or added before the form):
 * the nine questions, filled in with what the checkup has, every one required. The answers go on that checkup, which becomes Completed.
 * Resolves the saved row, false when the checkup is gone, or null when it was cancelled.
 */
export function checkupAnswersModal(row) {
  return new Promise((resolve) => {
    const q = checkupQuestions({ row, fill: true, branchId: row.branch_id, branchFixed: true });
    const body = h('div', {}, h('p', { class: 'muted' }, 'Ask the patient these questions after the checkup. The answers go on this checkup, also on the Checkups page.'), q.el);
    modal(`Checkup form: ${row.patient_name}`, body, [
      { label: 'Cancel' },
      { label: 'Save the answers', primary: true, onClick: async () => {
        const errors = q.errors();
        if (errors.length) return showFormErrors(body, errors);
        clearFieldErrors(body);
        const changes = Object.fromEntries(Object.entries({ ...q.values(), day_status: 'completed' }).filter(([k, v]) => k !== 'branch_id' && (v ?? null) !== (row[k] ?? null)));
        try {
          const saved = Object.keys(changes).length ? await state.data.updateCheckup(row.id, changes) : row;
          if (!saved) toast(`${row.patient_name} is no longer on the list.`, 'error');
          resolve(saved || false);
        } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ], { onClose: () => resolve(null), confirmDismiss: discardGuard(() => JSON.stringify(q.values())) });
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
