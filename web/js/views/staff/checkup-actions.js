// Pieces shared by the Aaj ki List, the Checkups page and the Today page. A checkup patient has a date, a branch, a name, a phone
// and a treatment, but no Mr#: they get a patient file (and an Mr#) only when they start treatment.
import { h, mount, modal, field, select, toast, friendlyError, announce, showFormErrors, clearFieldErrors, localISO, shortDate, busy } from '../../ui/dom.js';
import { state, can, isAdmin, myBranches, branchName, cityName } from '../../state.js';
import { FOLLOW_UP_STATUSES, CHECKUP_FOR_CHOICES, PRICING_LABELS, checkupPhone, formComplete, hasFormAnswers, nameFits, nameNorm, splitChoices, joinChoices } from '../../lib/checkups.js';
import { matchClinician } from '../../lib/legacy.js';
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

// A row of the old list and an answer imported from the Google Form are removed by Dr. Ali only (the database's "remove checkups"
// policy): importing the Google Form's file again skips every answer it imported before, so a removed answer never comes back.
const ADMIN_REMOVES = ['archive', 'google_form'];
/** Only people who keep the list may remove a checkup; a row from the old list or the Google Form can be removed by Dr. Ali only. */
export const canRemoveCheckup = (row) => can('sheet.edit') && (isAdmin() || !ADMIN_REMOVES.includes(row.source));
/** Why someone who keeps the list is not offered Remove for this row (null: it is offered, or they do not keep the list). */
export function whyNoRemove(row) {
  if (!can('sheet.edit') || canRemoveCheckup(row)) return null;
  return row.source === 'google_form'
    ? 'Only Dr. Ali can remove an answer imported from the Google Form: importing the file again does not bring a removed answer back.'
    : 'Only Dr. Ali can remove a row from the old list.';
}

/** Registering links the checkup to the new patient file and moves its follow-up status, so (as in the database) it needs both rights. */
export const canRegisterCheckup = () => can('patients.create') && can('sheet.edit');

// ---------------------------------------------------------------- the checkup form ("Checkup Patient Form 2.0")
// The clinic's Google Form of the same name, now on the website (owner, 11 Oct 2026: "the checkup 2.0 form is good, and we are using
// that form now ... once entered, these details go into the checkup list"). The assistant asks the patient the nine questions after the
// checkup, in this order. Five of them have the columns checkups always had (name, branch, phone, doctors, checkup_for); the other four
// are the columns of migration 20261011000300.
const OTHER = '__other';
const YES_NO = [['yes', 'Yes'], ['no', 'No']];
const tooLong = (v) => Array.from(v || '').length > 300; // doctors and checkup_for hold at most 300 characters (the checkups table)
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

// A question answered with tick boxes, several at once, as on the Google Form ("Braces" and "Extraction"; two doctors): a fieldset whose
// legend is the question, one box per choice and "Other", which shows a text box for the rest. The answer is stored the Google Form's own
// way, the ticked choices joined with ", " and then the Other text, so an answer given here and one imported from the form look the same.
// Stored text opens as ticks (match finds the choice a part is; split says what separates the parts), and a part that is not a choice goes
// into Other. value() is the text to store, or null; a group left as it opened gives back the text it opened with, letter for letter.
// firstShown(): the first box in sight, the one an error marks (setFieldError); a tick anywhere in the group tells a marked box the error is
// fixed. labels (one per choice) and row let the doctors' question put some choices first and hide others; after: shown under the boxes.
function choiceChecks(question, choices, current, { otherLabel, required = false, match = null, split = /,/, after = null }) {
  const name = `cq-${++formSeq}`;
  const opened = String(current ?? '').trim();
  const start = splitChoices(opened, choices, { match, split });
  const boxes = choices.map((c) => h('input', { type: 'checkbox', name, value: c, checked: start.picked.includes(c) }));
  const otherBox = h('input', { type: 'checkbox', name, value: OTHER, checked: !!start.other });
  const other = h('input', { maxlength: 300, autocomplete: 'off', value: start.other });
  const otherField = field(otherLabel, other, 'Several are fine: separate them with commas.', { required: true });
  const labels = [...boxes, otherBox].map((b, i) => h('label', { class: 'choice' }, b, h('span', {}, i < choices.length ? choices[i] : 'Other')));
  const row = h('div', { class: 'choice-row' }, labels);
  const set = h('fieldset', { class: 'fieldset-plain choice-group choice-many' },
    h('legend', {}, question, required ? h('span', { class: 'req' }, ' (required)') : null), row, after);
  set.addEventListener('change', (e) => {
    for (const b of [...boxes, otherBox]) if (b !== e.target && b.getAttribute('aria-invalid') === 'true') b.dispatchEvent(new Event('change'));
  });
  const firstShown = () => [...row.querySelectorAll('input')].find((b) => !b.closest('label').hidden) || otherBox;
  const sync = () => { otherField.hidden = !otherBox.checked; };
  otherBox.addEventListener('change', sync);
  sync();
  const value = () => {
    const picked = boxes.filter((b) => b.checked).map((b) => b.value);
    const rest = otherBox.checked ? other.value.trim().replace(/\s+/g, ' ') : '';
    if (opened && picked.join('\n') === start.picked.join('\n') && rest === start.other) return opened;
    return joinChoices(picked, rest);
  };
  // (a whole line of the form's grid, the boxes in columns; the text box opens right under them)
  return { firstShown, boxes, labels: labels.slice(0, choices.length), row, otherBox, other, value,
    el: h('div', { class: 'checkup-form-wide' }, h('div', { class: 'field' }, set), otherField), ticked: () => boxes.some((b) => b.checked) || otherBox.checked };
}

// The doctors' city: the branch's city as clinicians.region writes it (Setup -> Clinicians: Karachi KHI, Lahore LHR, Islamabad ISB).
const REGION_OF_CITY = { karachi: 'KHI', lahore: 'LHR', islamabad: 'ISB' };
const regionOf = (branchId) => REGION_OF_CITY[cityName(state.ref.branches.find((b) => b.id === Number(branchId))?.city_id).toLowerCase()] || null;

/**
 * The nine questions of the form, in its order, as fields. "+ Add checkup patient" (row = null: a new checkup), "Fill in the checkup form"
 * on the Aaj ki List (row = a checkup on the list, fill = true) and Edit on the Checkups page (row = the checkup) use them. A new checkup
 * and the form filled in for a checkup on the list need every question. A checkup from before the form, from the sheet or from the old
 * list has no answers, and one answer may be added later (after a follow-up call), so Edit asks for the four new ones only when the form
 * was filled in for that checkup (all four answered when the dialog opened).
 * branchId: the branch to start with, else the person's home branch, else "Choose…" (a guessed branch would look answered);
 * branchFixed: shown, not asked (the branch's own Aaj ki List).
 * -> { el, name, phone, branch, values(), errors({ arrival }) }
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

  // The doctors: the website's list. A name in a stored answer is ticked when it is one of them as the sheet writes people ("Dr Hina",
  // "Hina", several joined with , / or &). The doctors of the branch's city come first, with those of no city (they work everywhere); the
  // others wait behind "Show doctors of other cities", so a Lahore assistant does not scroll past every Karachi doctor on a phone (the
  // clinic has 22 doctors). A ticked one stays in sight; the order follows the branch when it is changed.
  const doctorList = state.ref.clinicians.filter((c) => c.is_doctor && c.active !== false).map((c) => ({ displayName: c.display_name, aliases: c.aliases || [], region: c.region || null }));
  const doctors = doctorList.map((c) => c.displayName);
  const asDoctor = (part) => matchClinician(part, doctorList)?.displayName ?? null;
  let allDoctors = false;
  const moreDoctors = h('button', { type: 'button', class: 'btn btn-small choice-more', 'aria-expanded': 'false', hidden: true,
    onclick: () => { allDoctors = !allDoctors; arrangeDoctors(); } });
  const doctor = choiceChecks('Who did your checkup?', doctors, row?.doctors, { otherLabel: 'Other: who did the checkup?', required: !editing, match: asDoctor, split: /,|\/|&/, after: moreDoctors });
  function arrangeDoctors() {
    const region = regionOf(branchValue());
    const near = (i) => !region || !doctorList[i].region || doctorList[i].region === region;
    const order = doctorList.map((_, i) => i).sort((a, b) => Number(near(b)) - Number(near(a)) || a - b);
    const away = order.filter((i) => !near(i) && !doctor.boxes[i].checked);
    doctor.row.prepend(...order.map((i) => doctor.labels[i])); // ("Other" stays last)
    for (const i of away) doctor.labels[i].hidden = !allDoctors;
    for (const i of order) if (!away.includes(i)) doctor.labels[i].hidden = false;
    moreDoctors.hidden = !away.length;
    moreDoctors.textContent = allDoctors ? 'Hide doctors of other cities' : `Show doctors of other cities (${away.length})`;
    moreDoctors.setAttribute('aria-expanded', String(allDoctors));
  }
  arrangeDoctors();
  branch.addEventListener('change', arrangeDoctors);
  const ali = choiceQuestion('Did Dr. Ali recommend your treatment?', YES_NO, asYesNo(row?.ali_recommended), { required: needAnswers });
  // (the plain word "Checkup" that marks a checkup row in the sheet is no answer: filling in the form asks it. The spellings the import
  // reads as that word too, as private.aaj_is_checkup_text does: "Check up", "Chek up", "Check-up", "Checkups".)
  const forNow = fill && /^\s*ch[ea]{1,2}c?k?[- ]?ups?\s*$/i.test(String(row.checkup_for ?? '')) ? null : row?.checkup_for;
  const checkupFor = choiceChecks('What was your checkup for?', CHECKUP_FOR_CHOICES, forNow, { otherLabel: 'Other: what was the checkup for?', required: !editing });
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
  // arrival: the patient is put on today's list as they come in (checkupFormModal); only the name and the phone are needed then, the
  // other questions are asked after the checkup ("Fill in the checkup form").
  const errors = ({ arrival = false } = {}) => {
    const out = [];
    const ask = needAnswers && !arrival;
    if (editing ? !name.value.trim() : name.value.trim().length < 2) out.push({ input: name, message: 'Write the patient name.' });
    if (!editing && !branchValue()) out.push({ input: branch, message: 'Choose the branch.' });
    if (!editing && digitsOf(phone.value).length < 10) out.push({ input: phone, message: PHONE_HINT });
    if (!editing && !arrival && !doctor.ticked()) out.push({ input: doctor.firstShown(), message: 'Choose who did the checkup.' });
    // (on arrival these two questions wait for the form: an Other ticked but left empty is no answer then, and is left out)
    if (!arrival && doctor.otherBox.checked && !doctor.other.value.trim()) out.push({ input: doctor.other, message: 'Write who did the checkup.' });
    else if (tooLong(doctor.value())) out.push({ input: doctor.otherBox.checked ? doctor.other : doctor.firstShown(), message: 'Too long: the ticked doctors and the Other text together can have at most 300 characters.' });
    if (ask && ali.value() === null) out.push({ input: ali.first, message: 'Choose whether Dr. Ali recommended the treatment.' });
    if (!editing && !arrival && !checkupFor.ticked()) out.push({ input: checkupFor.firstShown(), message: 'Choose what the checkup was for.' });
    if (!arrival && checkupFor.otherBox.checked && !checkupFor.other.value.trim()) out.push({ input: checkupFor.other, message: 'Write what the checkup was for.' });
    else if (tooLong(checkupFor.value())) out.push({ input: checkupFor.otherBox.checked ? checkupFor.other : checkupFor.firstShown(), message: 'Too long: the ticked choices and the Other text together can have at most 300 characters.' });
    if (ask && !pricing.value()) out.push({ input: pricing.first, message: 'Choose whether the pricing was understood.' });
    if (ask && wants.value() === null) out.push({ input: wants.first, message: 'Choose whether they want to start the treatment.' });
    if (ask && !plan.value.trim()) out.push({ input: plan, message: 'Write when they want to start, or why not.' });
    else if (Array.from(plan.value.trim()).length > 500) out.push({ input: plan, message: 'Write at most 500 characters.' });
    return out;
  };
  return { el, name, phone, branch, values, errors };
}

// The form is a whole interview, filled in on phones all day, and the patient may have left by the time it is lost: every way of leaving
// it (Cancel, Escape, the ×, a tap on the strip around the dialog, Back, a link, a reload or closing the tab) asks before the answers are
// thrown away, with "Keep filling in" focused. snapshot() is what the form holds; nothing is asked while it holds what it opened with, or
// once it is saved (saved()). Edit on the Checkups page uses it too. -> the modal's { unsaved, confirmDismiss } (dom.js).
export function discardGuard(snapshot, saved = () => false) {
  const start = snapshot();
  const unsaved = () => !saved() && snapshot() !== start;
  const confirmDismiss = () => !unsaved() || new Promise((resolve) => {
    let discard = false;
    modal('Discard this checkup form?', h('p', {}, 'Your answers are not saved.'), [
      { label: 'Keep filling in' },
      { label: 'Discard', danger: true, onClick: () => { discard = true; } },
    ], { destructive: true, onClose: () => resolve(discard) });
  });
  return { unsaved, confirmDismiss };
}

// Is the name typed in the form the person of checkup c, which has the same phone? The phone alone is not enough: a parent's phone is often
// given for two children (in the owner's Google Form file 11 days have two names on one phone). The names must fit as the import compares
// them (nameFits, the rule of private.aaj_name_fits); a name nobody can read (Urdu script) on either side, or none typed yet, goes by the phone.
const sameName = (typed, c) => !nameNorm(typed) || !nameNorm(c.patient_name) || nameFits(typed, c.patient_name);
// Is checkup c, found by its name alone, the person typed? Someone typed into the Google Sheet on arrival often has no phone there, and the
// phone may not be typed in the form yet: then the names must fit (nameFits), and both must be readable.
const nameMatch = (typed, c) => !!nameNorm(typed) && !!nameNorm(c.patient_name) && nameFits(typed, c.patient_name);
// A checkup as the warning names it: the name, and the phone or that it has none.
const listedAs = (c) => `${c.patient_name} (${c.phone || 'no phone'})`;
// What saving the answers on c would do to answers it already has.
const answeredText = (c) => `${formComplete(c) ? 'Its checkup form is already filled in' : 'It already has answers from the checkup form'}: saving these answers on it would replace them.`;

// Text typed under "More" for a checkup that already has some is added after it (cut to the column's 2,000 characters); undefined leaves it.
function addedText(had, typed) {
  const t = typed.trim();
  if (!t || (had && had.includes(t))) return undefined;
  return had ? Array.from(`${had}\n${t}`).slice(0, 2000).join('') : t;
}

/**
 * "+ Add checkup patient": the form for one checkup patient. Resolves the saved row; { updated } (the row) when the same person was already
 * on that day's list (found by the phone, or by the name when that checkup has no phone or none is typed yet) and the answers went on that
 * checkup; { patient } when staff chose the existing patient file of the same person instead (Aaj ki List only); or null when it was cancelled.
 * fixedDay: the date and branch come from the list on screen and are not asked. Otherwise the checkup is for today at the person's
 * branch; another day (and the follow-up status) can be chosen under "More (optional)".
 * The answers are given after the checkup, so the checkup is saved as Completed (also on the Aaj ki List and the Google Sheet, where a
 * deleted row then does not take the checkup and its answers with it).
 * On today's Aaj ki List a patient can also be put on the list as they arrive, before the checkup: "Add as Waiting (form later)" needs only
 * the name and the phone and saves them as Waiting, as "+ Checkup patient" did before the form; "Fill in the checkup form" (Options on their
 * row) then asks the questions after the checkup.
 */
export function checkupFormModal({ branchId, date, fixedDay = false, onSaved } = {}) {
  return new Promise((resolve) => {
    const today = localISO();
    const arrival = fixedDay && date === today;   // today's list: the patient may be added on arrival (only name and phone)
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
    // the checkups the warning names, on that day's list at that branch: the same phone, or the same name when the checkup has no phone or
    // none is typed yet (someone typed into the Google Sheet on arrival without a phone)
    let sameDayNow = [];
    let sameDayKey = null; // what sameDayNow was looked up for (dupKey()), once that check has come back
    let dupRun = null; // the latest check: { key, run }
    const dupKey = () => JSON.stringify([checkupPhone(phone.value), nameNorm(name.value), q.values().branch_id, fixedDay ? date : dateIn.value]);
    // c was found by the phone typed now (else by the name alone)
    const byPhone = (c) => { const k = checkupPhone(phone.value); return !!k && checkupPhone(c.phone) === k; };

    // The same person already on that day's list (typed into the Google Sheet on arrival, or added at the desk): the answers go on that
    // checkup instead of a second one. Its name and phone stay as they are; a checkup typed in without a phone gets the one typed here.
    // -> true once saved (the dialog is then closed).
    const saveAnswersOn = async (c) => {
      const errors = q.errors();
      if (errors.length) return showFormErrors(body, errors);
      clearFieldErrors(body);
      const a = q.values();
      // still that person: the same phone, or (no phone on that checkup) a name that fits; at that branch on that day
      const samePerson = checkupPhone(a.phone) === checkupPhone(c.phone) || (!checkupPhone(c.phone) && nameMatch(a.patient_name, c));
      if (!samePerson || a.branch_id !== c.branch_id || (fixedDay ? date : dateIn.value) !== c.checkup_date) { checkDupes(); return false; }
      const row = await state.data.updateCheckup(c.id, {
        doctors: a.doctors, checkup_for: a.checkup_for, ali_recommended: a.ali_recommended, pricing_understood: a.pricing_understood,
        wants_treatment: a.wants_treatment, treatment_plan: a.treatment_plan, day_status: 'completed',
        details: addedText(c.details, details.value), notes: addedText(c.notes, notes.value),
        follow_up: !fixedDay && followUp.value !== 'Not Contacted' ? followUp.value : undefined,
        phone: c.phone ? undefined : a.phone,
      });
      if (!row) { toast(`${c.patient_name} is no longer on the list.`, 'error'); checkDupes(); return false; }
      done = true;
      onSaved?.(row);
      resolve({ updated: row });
      dialog?.close();
      return true;
    };
    // "Add checkup patient" pressed while the warning is there (above the questions, so out of sight on a phone by then): asked once more.
    // -> 'back', 'add' (a different person with the same phone or name) or the checkup to save the answers on. Saving on that checkup is the
    // highlighted choice (it has focus) only when the names fit and it has no answers yet, and, for a checkup found by its name alone, when
    // the name is the same letter for letter (two people can share a first name); otherwise both people are named, and "Add as a different
    // person" is: Enter must never write one person's answers over another's.
    // onArrival ("Add as Waiting"): nothing is saved on that checkup; the same person is simply on the list already, so nothing is highlighted.
    const sameDayChoice = (matches, day, { onArrival = false } = {}) => new Promise((answer) => {
      const typed = name.value.trim().replace(/\s+/g, ' ');
      const fitting = matches.filter((c) => sameName(typed, c));
      const one = matches.length === 1 ? matches[0] : fitting.length === 1 ? fitting[0] : null;     // the checkup the answers could go on
      const byName = !!one && !byPhone(one);
      const safe = !!one && sameName(typed, one) && (onArrival || !hasFormAnswers(one)) && (!byName || nameNorm(typed) === nameNorm(one.patient_name));
      const phoneOnly = matches.every(byPhone);
      const listed = matches.map(listedAs).join(', ');
      const fill = byName ? `Fill in the answers for ${one.patient_name} on the list` : 'Save the answers on that checkup';
      const twoNamed = byName ? h('p', {}, 'Two people with the same name? Press "Add as a different person".') : null;
      let choice = 'back';
      modal(`Already on the list for ${shortDate(day)}`, h('div', {},
        safe
          ? [h('p', {}, `${listed} ${matches.length === 1 ? 'is' : 'are'} already on the list for ${shortDate(day)}${phoneOnly ? ' with this phone number' : ''}.`),
            h('p', {}, `Same person${matches.length > 1 ? ` as ${one.patient_name}` : ''}? ${onArrival ? 'They are on the list already: go back and press Cancel.' : `${fill}, so they are not on the list twice.`}`),
            twoNamed]
          : [h('p', {}, `You typed ${typed}; the list for ${shortDate(day)} has ${listed}${phoneOnly ? ' on this phone number' : ''}.`),
            (!one || !sameName(typed, one)) && matches.some(byPhone) ? h('p', {}, 'Another person on the same phone (often a family member) is added as a checkup of their own.') : null,
            byName && !(!onArrival && hasFormAnswers(one)) ? [h('p', {}, `Same person? ${onArrival ? 'They are on the list already: go back and press Cancel.' : `${fill}.`}`), twoNamed] : null,
            !onArrival && one && hasFormAnswers(one) ? h('p', {}, `${one.patient_name}: ${answeredText(one)}`) : null,
            !one ? h('p', {}, onArrival ? 'The same person? They are on the list already: go back and press Cancel.' : 'The same person? Go back and save the answers on their checkup.') : null]), [
        { label: 'Go back' },
        { label: 'Add as a different person', primary: !safe, onClick: () => { choice = 'add'; } },
        ...(one && !onArrival ? [{ label: hasFormAnswers(one) ? 'Replace the answers on that checkup' : fill, primary: safe, onClick: () => { choice = one; } }] : []),
      ], { onClose: () => answer(choice) });
    });

    const checkDupes = () => {
      const key = dupKey();
      dupRun = { key, run: findDupes(key) };
      return dupRun.run;
    };
    const findDupes = async (key) => {
      const mine = ++dupSeq;
      const day = fixedDay ? date : dateIn.value;
      const bId = q.values().branch_id;
      const phoneKey = checkupPhone(phone.value);
      const typedName = name.value.trim().replace(/\s+/g, ' ');
      const byNameToo = !!bId && !!nameNorm(typedName);   // (the name is looked for at a chosen branch only)
      const [rows, sameDay] = await Promise.all([
        state.data.findDuplicates(name.value, phone.value).catch(() => []),
        // The same phone number on the same day's list at the same branch: almost always one person typed twice. And the same name there
        // when that checkup has no phone or none is typed yet: someone typed into the Google Sheet on arrival without a phone.
        (phoneKey || byNameToo) && day && state.data.listDayCheckups
          ? state.data.listDayCheckups({ branchId: bId, date: day }).then((list) => list.filter((c) => (phoneKey && checkupPhone(c.phone) === phoneKey)
            || (byNameToo && Number(c.branch_id) === bId && (!phoneKey || !checkupPhone(c.phone)) && nameMatch(typedName, c)))).catch(() => [])
          : [],
      ]);
      if (mine !== dupSeq || done) return;
      // the checkups whose name fits the typed one first, then those of the same phone; another name, or answers already given, are said
      // (and the button says "Replace"), all for the name the list was searched for
      const typed = typedName;
      sameDayNow = [...sameDay].sort((a, b) => Number(sameName(typed, b)) - Number(sameName(typed, a)) || Number(byPhone(b)) - Number(byPhone(a)));
      sameDayKey = key;
      const phoneDigits = digitsOf(phone.value);
      const sorted = [...rows].sort((a, b) => Number(digitsOf(b.phone) === phoneDigits && phoneDigits.length >= 7) - Number(digitsOf(a.phone) === phoneDigits && phoneDigits.length >= 7)).slice(0, 3);
      mount(warn,
        sameDayNow.length ? h('div', { class: 'alert alert-warning', role: 'status' }, sameDayNow.slice(0, 3).map((c) => {
          const fits = sameName(typed, c);       // (always, for a checkup found by its name)
          const viaPhone = byPhone(c);
          const action = hasFormAnswers(c) ? 'Replace the answers on this checkup' : viaPhone ? 'Save the answers on this checkup' : `Fill in the answers for ${c.patient_name} on the list`;
          return h('div', { class: 'dup-line' },
            h('span', {}, h('strong', {}, `Already on the list for ${shortDate(day)}: `), `${listedAs(c)}. `,
              fits ? '' : `You typed ${typed}: another person on the same phone (often a family member) is added as a checkup of their own. `,
              hasFormAnswers(c) ? answeredText(c) : !fits ? ''
                : viaPhone ? 'Same person? Save the answers on this checkup, so they are not on the list twice.'
                  : 'Same person? Fill in the answers on the list, so they are not on the list twice. Two people with the same name? Press "Add checkup patient", then "Add as a different person".'),
            h('button', { type: 'button', class: 'btn btn-small', 'aria-label': viaPhone || hasFormAnswers(c) ? `${action}: ${c.patient_name}` : action, onclick: busy(() => saveAnswersOn(c)) }, action));
        })) : null,
        sorted.length ? h('div', { class: 'alert alert-warning', role: 'status' }, sorted.map((p) => {
          const samePhone = phoneDigits.length >= 7 && digitsOf(p.phone) === phoneDigits;
          return h('div', { class: 'dup-line' },
            h('span', {}, h('strong', {}, samePhone ? 'This person already has a patient file: ' : 'A patient file with the same name exists: '), mrLine(p), samePhone ? '.' : '. Same person?'),
            fixedDay
              ? h('button', { type: 'button', class: 'btn btn-small', onclick: async () => {
                // (the name and phone are in the patient file already: asked only when an answer of the form would be thrown away)
                if (!dialog || !(await dialog.mayLeave(answersGuard.confirmDismiss))) return;
                done = true;
                resolve({ patient: p });
                dialog.close();
              } }, `Add Mr# ${p.mr_number} to the list instead`)
              : h('a', { class: 'btn btn-small', href: `#/staff/patient/${p.id}` }, 'Open the patient file'));
        })) : null);
    };
    let typing;
    name.addEventListener('change', checkDupes);
    phone.addEventListener('change', checkDupes);
    phone.addEventListener('input', () => { clearTimeout(typing); if (digitsOf(phone.value).length >= 7) typing = setTimeout(checkDupes, 500); });
    dateIn?.addEventListener('change', checkDupes);
    branch.addEventListener('change', checkDupes);
    // A save pressed before the check of what is typed now has come back (on arrival the phone is the last thing typed, and the check waits
    // for a pause in the typing and then for the server) waits for it: the one under way, or a new one. So someone already on the list is
    // never added a second time on a slow line. Nothing waits when the last check was for this phone, name, branch and day.
    const sameDayChecked = async () => {
      clearTimeout(typing);
      for (let i = 0; i < 3 && sameDayKey !== dupKey(); i++) await (dupRun?.key === dupKey() ? dupRun.run : checkDupes());
    };

    body = h('div', {},
      h('p', { class: 'muted' }, 'Ask the patient these questions after the checkup. ', fixedDay
        ? `Goes on the list for ${branchName(branchId)} on ${shortDate(date)} and on the Checkups page. A checkup patient has no Mr#; they get one when they start treatment.`
        : "Goes on the Checkups page, and on that branch's Aaj ki List for today (another day can be chosen under More). A checkup patient has no Mr#; they get one when they start treatment."),
      arrival ? h('p', { class: 'alert alert-info' }, h('strong', {}, 'Just arrived? '),
        'Write the name and mobile number, then press "Add as Waiting (form later)". After the checkup, press Options on their row, then "Fill in the checkup form".') : null,
      warn,
      q.el,
      more);

    // "Add as Waiting (form later)": on the list as they come in, as Waiting, with what is typed so far (the name and phone at least; the
    // treatment is "Checkup" until the form says what it was for). The questions are asked after the checkup ("Fill in the checkup form").
    const addOnArrival = async () => {
      const errors = q.errors({ arrival: true });
      if (errors.length) {
        if (errors.some((e) => more.contains(e.input))) more.open = true;
        return showFormErrors(body, errors);
      }
      clearFieldErrors(body);
      await sameDayChecked();
      if (sameDayNow.length && (await sameDayChoice(sameDayNow, date, { onArrival: true })) !== 'add') { name.focus(); return false; }
      const answers = q.values();
      const b = state.ref.branches.find((x) => x.id === answers.branch_id);
      try {
        const row = await state.data.addCheckup({
          ...answers, checkup_for: answers.checkup_for || 'Checkup', checkup_date: date, city: (b && cityName(b.city_id)) || null,
          details: details.value.trim() || null, day_status: 'waiting', follow_up: 'Not Contacted', notes: notes.value.trim() || null,
        });
        done = true;
        onSaved?.(row);
        resolve(row);
      } catch (e) { toast(friendlyError(e), 'error'); return false; }
    };

    const snapshot = () => JSON.stringify([q.values(), dateIn?.value, followUp?.value, details.value, notes.value]);
    const guard = discardGuard(snapshot, () => done);
    const answersGuard = discardGuard(() => JSON.stringify([{ ...q.values(), patient_name: '', phone: '' }, details.value, notes.value]), () => done);
    dialog = modal('Add a checkup patient', body, [
      { label: 'Cancel', dismiss: true },
      ...(arrival ? [{ label: 'Add as Waiting (form later)', onClick: addOnArrival }] : []),
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
        await sameDayChecked();
        if (sameDayNow.length) {
          const choice = await sameDayChoice(sameDayNow, day);
          if (choice === 'back') {
            // back at the warning's button when it only saves; when it would replace answers or the name is another, at the name instead
            const first = sameDayNow[0];
            (first && sameName(name.value, first) && !hasFormAnswers(first) ? warn.querySelector('button') : name)?.focus();
            return false;
          }
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
    ], { onClose: () => { done = true; resolve(null); }, ...guard });
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
    let done = false;
    modal(`Checkup form: ${row.patient_name}`, body, [
      { label: 'Cancel', dismiss: true },
      { label: 'Save the answers', primary: true, onClick: async () => {
        const errors = q.errors();
        if (errors.length) return showFormErrors(body, errors);
        clearFieldErrors(body);
        const changes = Object.fromEntries(Object.entries({ ...q.values(), day_status: 'completed' }).filter(([k, v]) => k !== 'branch_id' && (v ?? null) !== (row[k] ?? null)));
        try {
          const saved = Object.keys(changes).length ? await state.data.updateCheckup(row.id, changes) : row;
          if (!saved) toast(`${row.patient_name} is no longer on the list.`, 'error');
          done = true;
          resolve(saved || false);
        } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ], { onClose: () => resolve(null), ...discardGuard(() => JSON.stringify(q.values()), () => done) });
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
    h('p', {}, row.source === 'google_form'
      ? `Remove ${row.patient_name}'s answers imported from the Google Form? Importing the file again does not bring them back.`
      : `Remove ${row.patient_name} from the list? Use this for a wrong entry or someone who did not come. It is removed from the checkup list too.`), [
      { label: 'Keep it' },
      { label: 'Remove', danger: true, onClick: async () => {
        await state.data.deleteCheckup(row.id);
        toast(`${row.patient_name} removed.`, 'ok');
        onDone?.(row);
      } },
    ], { destructive: true });
}
