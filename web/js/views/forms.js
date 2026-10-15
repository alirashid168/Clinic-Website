// The two forms behind the homepage buttons (owner, 11 Oct 2026): "Join our team" (#/join) and "Complaints & suggestions"
// (#/feedback). Their own addresses, so the clinic can share the links. Most visitors are on a phone: one column, large
// controls, the right keyboard for numbers. Every field is checked here first (lib/public-forms.js) and again by the database.
//
// An error is shown under its field and focus moves to the first one; a refusal from the database is shown the same way.
// After sending, the form is replaced by a thank-you that repeats nothing the visitor typed. A hidden box catches bots
// (people never see it, screen readers and the Tab key skip it, and no autofill fills it in).
import { h, mount, field, select, showFormErrors, clearFieldErrors, setFieldError, announce, friendlyError } from '../ui/dom.js';
import { state } from '../state.js';
import { header, footer, waLink } from './public.js';
import {
  POSITIONS, QUALIFICATIONS, FEEDBACK_KINDS, FEEDBACK_TOPICS, CV_ACCEPT, LIMITS, HONEYPOT,
  checkJobApplication, checkFeedback, cvFileInfo, normalizePhone, normalizeCnic, formatPhone, submitProblem,
} from '../lib/public-forms.js';

const JOIN_PRIVACY = 'Only Dr. Ali Rashid and the people he chooses for hiring see your details and CV. The clinic keeps them to contact you about jobs and never shares them.';
const FEEDBACK_PRIVACY = 'Dr. Ali Rashid and the clinic coordinator read every message. It is used only to improve the clinic and, if you ask, to contact you. Your name and number are optional.';
// When the website is too busy for the form (FORM_BUSY, FORM_BUSY_DAY), or the CV cannot be sent (too large, another type): the
// message the WhatsApp chat starts with, and the link's words.
const WHATSAPP_INSTEAD = {
  job: ['Hi, I would like to apply for a job at the clinic. I am sending my CV here.', 'Send your CV on WhatsApp'],
  feedback: ['Hi, I would like to share a complaint or suggestion about the clinic.', 'Message the clinic on WhatsApp'],
};

// ---------------------------------------------------------------- pieces
let seq = 0;
const newId = (name) => `pf-${name}-${++seq}`;

function page(root, title, intro, privacy, body) {
  const wrap = h('div', { class: 'form-wrap' },
    h('p', { class: 'form-back' }, h('a', { href: '#/' }, '← Back to the homepage')),
    h('h1', { tabindex: '-1' }, title), // focusable: "Send another message" moves focus here (no route change to do it)
    h('p', { class: 'form-intro' }, intro),
    h('p', { class: 'form-privacy' }, privacy),
    body);
  mount(root, header(true), h('main', { id: 'main', class: 'public-main form-page' }, wrap), footer());
  return wrap;
}

/**
 * The hidden box only bots fill in. Its name and id are ones no browser or password manager fills in by itself (not
 * "website", "url" or "homepage"), so a person's form is never dropped because an autofill wrote in it.
 */
function honeypot() {
  const id = newId('trap');
  const input = h('input', { type: 'text', id, name: HONEYPOT, tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
  return { input, el: h('div', { class: 'hp-field', 'aria-hidden': 'true' }, h('label', { for: id }, 'Leave this box empty'), input) };
}

/** The branches the clinic has open, in its order, plus the extra choice ("Any branch" / "Not about one branch"). */
function branchSelect(extraValue, extraLabel) {
  const branches = state.ref.branches.filter((b) => b.active !== false);
  return select([{ value: '', label: 'Choose a branch' }, ...branches.map((b) => ({ value: b.id, label: b.name })), { value: extraValue, label: extraLabel }], '');
}

/** A tick box with its words beside it, inside a .field so an error lands under it. */
function checkLine(input, text, { required = false } = {}) {
  if (required) { input.required = true; input.setAttribute('aria-required', 'true'); }
  return h('div', { class: 'field' }, h('label', { class: 'check-line' }, input, h('span', {}, text, required ? h('span', { class: 'req' }, ' (required)') : null)));
}

/** The message above the form for a problem that is not about one field (no connection, too many forms right now), with a link below it if given. */
function alertBox() {
  const el = h('div', { class: 'alert alert-stop form-alert', role: 'alert', tabindex: '-1', hidden: true });
  return {
    el,
    show(text, link = null) { mount(el, text, link ? h('span', { class: 'form-alert-action' }, link) : null); el.hidden = false; el.focus(); },
    hide() { el.hidden = true; el.textContent = ''; },
  };
}

/** Shows the checks' errors under their fields: focus goes to the first, and the count is spoken. */
function showErrors(form, inputs, errors) {
  return showFormErrors(form, errors.map((e) => ({ input: inputs[e.field] || null, message: e.message })));
}

/**
 * A refusal from the database (or the upload): under its field when it names one, otherwise above the form. `kind` is
 * 'job' or 'feedback'; when the website is too busy (today or this minute), a WhatsApp button follows the message.
 */
function showProblem(form, inputs, alert, err, kind) {
  const problem = submitProblem(err, { form: kind });
  if (problem?.field && inputs[problem.field]) return showFormErrors(form, [{ input: inputs[problem.field], message: problem.message }]);
  alert.show(problem?.message || friendlyError(err, { audience: 'public' }), problem?.busy ? waLink(...WHATSAPP_INSTEAD[kind], 'btn') : null);
  return false;
}

/** The send button while sending: disabled, says what is happening (busy() is not used: its errors would be staff wording). */
function sending(button, on, busyText, idleText) {
  button.disabled = on;
  button.setAttribute('aria-busy', on ? 'true' : 'false');
  button.textContent = on ? busyText : idleText;
}

/** The thank-you that replaces the form. It repeats nothing the visitor typed. */
function thanks(wrap, title, lines, actions) {
  const heading = h('h1', { tabindex: '-1' }, title);
  mount(wrap, h('div', { class: 'form-thanks' },
    h('span', { class: 'form-thanks-mark', 'aria-hidden': 'true' }, '✓'),
    heading,
    lines.map((t) => h('p', {}, t)),
    h('p', { class: 'form-thanks-actions' }, actions)));
  window.scrollTo(0, 0);
  heading.focus();
}

// Phone and CNIC are shown in their usual shape once the visitor leaves the box (nothing changes while typing).
function tidyOnBlur(input, normalize, show = (v) => v) {
  input.addEventListener('blur', () => { const v = normalize(input.value); if (v) input.value = show(v); });
}

// ---------------------------------------------------------------- "Join our team"
export async function renderJoin(root) {
  const trap = honeypot();
  const alert = alertBox();
  const inputs = {
    full_name: h('input', { type: 'text', autocomplete: 'name', maxlength: 120 }),
    phone: h('input', { type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '0300 1234567', maxlength: 20 }),
    email: h('input', { type: 'email', autocomplete: 'email', inputmode: 'email', maxlength: LIMITS.email + 20 }),
    cnic: h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: '12345-1234567-1', maxlength: 20 }),
    position: select([{ value: '', label: 'Choose a job' }, ...POSITIONS], ''),
    qualification: select([{ value: '', label: 'Choose your degree' }, ...QUALIFICATIONS], ''),
    qualification_other: h('input', { type: 'text', autocomplete: 'off', maxlength: LIMITS.qualification + 20 }),
    graduation_year: h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: 4, placeholder: 'For example 2021' }),
    experience: h('input', { type: 'text', autocomplete: 'off', maxlength: LIMITS.experience + 20, placeholder: 'For example: 2 years at a clinic' }),
    branch: branchSelect('any', 'Any branch'),
    cv: h('input', { type: 'file', accept: CV_ACCEPT }),
    message: h('textarea', { rows: 4, maxlength: LIMITS.jobMessage + 50 }),
    consent: h('input', { type: 'checkbox' }),
  };
  // "Other" in the degree list opens a box for the degree itself, right under the list: the word "Other" is never sent.
  const otherDegree = field('Your degree or qualification', inputs.qualification_other, 'For example BA, BSc, BCom or MBA.', { required: true });
  const otherChosen = () => inputs.qualification.value === 'Other';
  const showOtherDegree = () => { otherDegree.hidden = !otherChosen(); };
  showOtherDegree();
  inputs.qualification.addEventListener('change', showOtherDegree);
  // An error about the degree belongs in the box the visitor types it in, once "Other" is chosen (also the database's answer).
  const fieldInputs = () => ({ ...inputs, qualification: otherChosen() ? inputs.qualification_other : inputs.qualification });
  tidyOnBlur(inputs.phone, normalizePhone, formatPhone);
  tidyOnBlur(inputs.cnic, normalizeCnic);
  // A CV the form cannot take (over 5 MB, another type): a phone cannot make a photo smaller or turn it into a PDF, so the
  // WhatsApp way is offered right under the error, like the busy messages do.
  const cvWhatsapp = h('p', { class: 'form-cv-whatsapp', hidden: true }, 'No other file on your phone? ', waLink(...WHATSAPP_INSTEAD.job, 'btn btn-small'));
  const cvTrouble = (on) => { cvWhatsapp.hidden = !on; };
  const cvCannotGo = () => { const file = inputs.cv.files[0]; return Boolean(file && cvFileInfo(file).error); };
  // A file that cannot be sent is said at once, not only after pressing Send.
  inputs.cv.addEventListener('change', () => {
    const file = inputs.cv.files[0];
    const info = file ? cvFileInfo(file) : null;
    if (info?.error) setFieldError(inputs.cv, info.error);
    cvTrouble(Boolean(info?.error));
  });

  const cvField = field('CV file', inputs.cv, 'A PDF, Word (.doc or .docx), JPG or PNG file, at most 5 MB. A photo of a printed CV is fine.', { required: true });
  cvField.querySelector('.field-hint').before(cvWhatsapp); // under the error (which comes straight after the input), above the hint

  const button = h('button', { type: 'submit', class: 'btn btn-primary btn-lg form-send' }, 'Send my application');
  const form = h('form', { class: 'public-form', novalidate: true, 'aria-label': 'Job application' },
    alert.el,
    h('fieldset', { class: 'form-group' }, h('legend', {}, 'About you'),
      field('Full name', inputs.full_name, null, { required: true }),
      field('Mobile number', inputs.phone, 'A Pakistani mobile number. The clinic calls or messages you on it.', { required: true }),
      field('Email', inputs.email, 'Optional.'),
      field('CNIC number', inputs.cnic, '13 digits, with or without dashes.', { required: true })),
    h('fieldset', { class: 'form-group' }, h('legend', {}, 'The job'),
      field('Job you are applying for', inputs.position, null, { required: true }),
      field('Degree or qualification', inputs.qualification, 'Choose "Other" to type another degree.', { required: true }),
      otherDegree,
      field('Graduation year', inputs.graduation_year, 'Optional. The year you finished, or expect to finish.'),
      field('Experience', inputs.experience, `Optional, in a few words (up to ${LIMITS.experience} characters).`),
      field('Preferred branch', inputs.branch, null, { required: true })),
    h('fieldset', { class: 'form-group' }, h('legend', {}, 'Your CV'),
      cvField,
      field('Message', inputs.message, `Optional, up to ${LIMITS.jobMessage.toLocaleString('en-PK')} characters.`)),
    checkLine(inputs.consent, "Dr. Ali Rashid's clinic may keep these details to contact me about jobs.", { required: true }),
    trap.el,
    h('div', { class: 'form-actions' }, button));

  const wrap = page(root, 'Join our team',
    'Dentists, orthodontists, hygienists, assistants, coordinators, front desk and social media: tell us about yourself and attach your CV. It takes about three minutes.',
    JOIN_PRIVACY, form);

  // The CV is uploaded once; pressing Send again after a refusal about another field sends the same file without uploading it again.
  let uploaded = null;
  let busyNow = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busyNow) return;
    alert.hide();
    clearFieldErrors(form);
    const file = inputs.cv.files[0] || null;
    const values = {
      full_name: inputs.full_name.value, phone: inputs.phone.value, email: inputs.email.value, cnic: inputs.cnic.value,
      position: inputs.position.value, qualification: inputs.qualification.value, qualification_other: inputs.qualification_other.value,
      graduation_year: inputs.graduation_year.value, experience: inputs.experience.value, branch: inputs.branch.value, message: inputs.message.value,
      consent: inputs.consent.checked, [HONEYPOT]: trap.input.value,
    };
    const { errors } = checkJobApplication(values, { cv: file });
    cvTrouble(cvCannotGo());
    if (errors.length) return showErrors(form, fieldInputs(), errors);
    busyNow = true;
    sending(button, true, 'Sending…', 'Send my application');
    announce('Sending your application…');
    try {
      if (uploaded?.file !== file) uploaded = { file, path: await state.data.uploadJobCv(file) };
      await state.data.submitJobApplication(checkJobApplication({ ...values, cv_path: uploaded.path }).data);
      thanks(wrap, 'Thank you, your application has been sent', [
        'The clinic reads every application. If your profile fits a job, someone from the clinic will call or message you.',
        'You do not need to send it again.',
      ], [h('a', { class: 'btn btn-primary', href: '#/' }, 'Back to the homepage')]);
    } catch (err) {
      if (!submitProblem(err)) console.error(err); // a refusal of the form itself is not a fault
      if (submitProblem(err)?.field === 'cv') { uploaded = null; cvTrouble(true); } // that file is not usable: choose or upload it again
      showProblem(form, fieldInputs(), alert, err, 'job');
    } finally {
      busyNow = false;
      if (button.isConnected) sending(button, false, 'Sending…', 'Send my application');
    }
  });
}

// ---------------------------------------------------------------- "Complaints & suggestions"
export async function renderFeedback(root) {
  const trap = honeypot();
  const alert = alertBox();
  const kindName = newId('kind');
  const kinds = FEEDBACK_KINDS.map((k) => h('input', { type: 'radio', name: kindName, value: k.value, required: true }));
  const kindHints = { complaint: 'Something went wrong', suggestion: 'An idea to make the clinic better', appreciation: 'Say thank you to someone' };
  const inputs = {
    kind: kinds[0],
    topic: select([{ value: '', label: 'Choose a topic' }, ...FEEDBACK_TOPICS], ''),
    branch: branchSelect('none', 'Not about one branch'),
    message: h('textarea', { rows: 6, maxlength: LIMITS.feedbackMax + 50 }),
    name: h('input', { type: 'text', autocomplete: 'name', maxlength: LIMITS.contactName + 20 }),
    phone: h('input', { type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '0300 1234567', maxlength: 20 }),
    mr: h('input', { type: 'text', autocomplete: 'off', maxlength: 24, placeholder: 'If you are a patient' }),
    contact_me: h('input', { type: 'checkbox' }),
  };
  tidyOnBlur(inputs.phone, normalizePhone, formatPhone);
  const kindGroup = h('div', { class: 'field' },
    h('fieldset', { class: 'choice-group' },
      h('legend', { class: 'field-label' }, 'Is it a complaint, a suggestion or appreciation?', h('span', { class: 'req' }, ' (required)')),
      FEEDBACK_KINDS.map((k, i) => h('label', { class: 'choice' }, kinds[i], h('span', {}, h('strong', {}, k.label), h('small', {}, kindHints[k.value]))))));
  // Choosing any of the three clears the error that sits on the group.
  for (const k of kinds) k.addEventListener('change', () => clearFieldErrors(kindGroup));

  const button = h('button', { type: 'submit', class: 'btn btn-primary btn-lg form-send' }, 'Send');
  const form = h('form', { class: 'public-form', novalidate: true, 'aria-label': 'Complaint or suggestion' },
    alert.el,
    h('fieldset', { class: 'form-group' }, h('legend', {}, 'Your message'),
      kindGroup,
      field('What is it about?', inputs.topic, null, { required: true }),
      field('Branch', inputs.branch, null, { required: true }),
      field('Message', inputs.message, `${LIMITS.feedbackMin} to ${LIMITS.feedbackMax.toLocaleString('en-PK')} characters. Please do not write card or bank details here.`, { required: true })),
    h('fieldset', { class: 'form-group' }, h('legend', {}, 'Your details (optional)'),
      h('p', { class: 'muted form-group-note' }, 'You can send this without your name. Give a number only if you would like an answer.'),
      field('Name', inputs.name),
      field('Mobile number', inputs.phone),
      field('Mr# (patient number)', inputs.mr, 'It is on your invoice or login slip.'),
      checkLine(inputs.contact_me, 'Please contact me about this (then a mobile number is needed).')),
    trap.el,
    h('div', { class: 'form-actions' }, button));

  const wrap = page(root, 'Complaints & suggestions',
    'Tell us what went wrong, what we could do better, or who deserves a thank-you. Every message helps us make the clinic better.',
    FEEDBACK_PRIVACY, form);

  let busyNow = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busyNow) return;
    alert.hide();
    clearFieldErrors(form);
    const values = {
      kind: kinds.find((k) => k.checked)?.value || '', topic: inputs.topic.value, branch: inputs.branch.value, message: inputs.message.value,
      name: inputs.name.value, phone: inputs.phone.value, mr: inputs.mr.value, contact_me: inputs.contact_me.checked, [HONEYPOT]: trap.input.value,
    };
    const { errors, data } = checkFeedback(values);
    if (errors.length) return showErrors(form, inputs, errors);
    busyNow = true;
    sending(button, true, 'Sending…', 'Send');
    announce('Sending your message…');
    try {
      await state.data.submitFeedback(data);
      thanks(wrap, 'Thank you for telling us', [
        'Your message has reached Dr. Ali Rashid and the clinic coordinator.',
        data.contact_me ? 'You asked to be contacted: someone from the clinic will call or message you on the number you gave.' : 'Messages are read every working day.',
      ], [
        h('a', { class: 'btn btn-primary', href: '#/' }, 'Back to the homepage'),
        h('button', { type: 'button', class: 'btn', onclick: () => renderFeedback(root).then(() => root.querySelector('h1')?.focus()) }, 'Send another message'),
      ]);
    } catch (err) {
      if (!submitProblem(err)) console.error(err); // a refusal of the form itself is not a fault
      showProblem(form, inputs, alert, err, 'feedback');
    } finally {
      busyNow = false;
      if (button.isConnected) sending(button, false, 'Sending…', 'Send');
    }
  });
}
