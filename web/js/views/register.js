// A patient registers their own website login (the owner, 17 Oct 2026: "i also want patients to register themselves at our website
// using their name, mr # and mobile number. if they match our patient profile. it creates their id and awaits confirmation by our
// staff."). The form asks for the name, the Mr#, the mobile number and a password of the patient's choice. The clinic system (the
// admin-users function, no login needed) makes the login only when the Mr# and the mobile number match the patient's file and the name
// fits, and marks it as waiting; it answers the same sentence whether or not anything matched, so this page can never tell a stranger
// which Mr# or numbers exist. Until the clinic approves, the login opens only a waiting screen (views/portal.js).
import { h, mount, field, showFormErrors, clearFieldErrors, announce, friendlyError } from '../ui/dom.js';
import { state } from '../state.js';
import { header, footer } from './public.js';
import { checkPortalPassword, PASSWORD_MIN, phonePassword } from '../lib/portal-login.js';

export async function renderRegister(root) {
  const d = state.data;
  const inputs = {
    name: h('input', { type: 'text', autocomplete: 'name', maxlength: 120, placeholder: 'As the clinic wrote it' }),
    mr: h('input', { type: 'text', autocomplete: 'off', inputmode: 'numeric', maxlength: 24, placeholder: 'For example 50013' }),
    phone: h('input', { type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '0300 5551234', maxlength: 20 }),
    password: h('input', { type: 'password', autocomplete: 'new-password', maxlength: 72 }),
    again: h('input', { type: 'password', autocomplete: 'new-password', maxlength: 72 }),
  };
  const button = h('button', { type: 'submit', class: 'btn btn-primary btn-lg form-send' }, 'Register');
  const problem = h('p', { class: 'field-error', role: 'alert', hidden: true });
  const form = h('form', { class: 'public-form', novalidate: true, 'aria-label': 'Register for your patient account' },
    h('fieldset', { class: 'form-group' }, h('legend', {}, 'Who you are at the clinic'),
      field('Your name', inputs.name, null, { required: true }),
      field('Mr# (patient number)', inputs.mr, 'It is on your invoice or receipt. Type only the number.', { required: true }),
      field('Mobile number', inputs.phone, 'The number the clinic has for you.', { required: true })),
    h('fieldset', { class: 'form-group' }, h('legend', {}, 'Choose a password'),
      field('Password', inputs.password, `At least ${PASSWORD_MIN} characters. You can change it later from the menu.`, { required: true }),
      field('Type it again', inputs.again, null, { required: true })),
    problem,
    h('div', { class: 'form-actions' }, button));

  const wrap = h('div', { class: 'form-wrap' },
    h('p', { class: 'form-back' }, h('a', { href: '#/login/patient' }, '← Patient login')),
    h('h1', { tabindex: '-1' }, 'Register for your patient account'),
    h('p', { class: 'form-intro' }, 'For patients of the clinic. Your details must match what the clinic has on file; the clinic then approves your account, usually at your next visit or within a day.'),
    h('p', { class: 'form-privacy' }, 'Your name, Mr# and mobile number are only compared with your file at the clinic. Nothing is shown to anyone else.'),
    form);
  mount(root, header(true), h('main', { id: 'main', class: 'public-main form-page' }, wrap), footer());

  let busyNow = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busyNow) return;
    clearFieldErrors(form);
    problem.hidden = true;
    const errors = [];
    const name = inputs.name.value.trim();
    const mr = inputs.mr.value.trim().replace(/^mr\s*#?\s*/i, '');
    if (name.length < 2) errors.push({ input: inputs.name, message: 'Write your name as the clinic has it.' });
    if (!mr) errors.push({ input: inputs.mr, message: 'Type your Mr# (patient number).' });
    if (phonePassword(inputs.phone.value).length < 8) errors.push({ input: inputs.phone, message: 'Type your mobile number, for example 0300 5551234.' });
    const pw = checkPortalPassword(inputs.password.value);
    if (pw) errors.push({ input: inputs.password, message: pw });
    else if (inputs.again.value !== inputs.password.value) errors.push({ input: inputs.again, message: 'The two passwords are different. Type them again.' });
    if (errors.length) { showFormErrors(form, errors); return; }
    busyNow = true;
    button.disabled = true;
    try {
      const message = await d.selfRegister({ full_name: name, mr, phone: inputs.phone.value.trim(), password: inputs.password.value });
      mount(wrap,
        h('p', { class: 'form-back' }, h('a', { href: '#/login/patient' }, '← Patient login')),
        h('h1', { tabindex: '-1' }, 'Request sent'),
        h('div', { class: 'alert alert-info', role: 'status' }, message),
        h('p', {}, h('a', { class: 'btn btn-primary', href: '#/login/patient' }, 'Go to the patient login')));
      wrap.querySelector('h1')?.focus();
      announce(message);
    } catch (err) {
      problem.textContent = friendlyError(err, { audience: 'public' });
      problem.hidden = false;
      announce(problem.textContent, { assertive: true });
    } finally {
      busyNow = false;
      button.disabled = false;
    }
  });
}
