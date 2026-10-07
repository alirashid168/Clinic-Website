// Staff and patient login. Problems are written under the form (and spoken),
// so they stay until the next try instead of vanishing with a toast.
import { h, mount, field, friendlyError, announce, busy, showFormErrors, clearFieldErrors } from '../ui/dom.js';
import { state } from '../state.js';
import { ROLE_LABELS } from '../lib/permissions.js';

function loginProblem(err, isStaff) {
  const msg = err?.message || '';
  if (msg === 'NOT_LINKED') {
    return isStaff ? 'This login is not linked to a staff account yet. Ask Dr. Ali or an admin.' : 'This login is not linked to a patient record yet. Please contact the clinic.';
  }
  if (/invalid login credentials/i.test(msg)) return 'That email and password do not match. Check both and try again.';
  if (/email not confirmed/i.test(msg)) return 'Your email address is not confirmed yet. Open the link in the email we sent you, then log in.';
  if (/rate limit|too many/i.test(msg)) return 'Too many tries. Wait a minute, then try again.';
  return friendlyError(err, isStaff ? undefined : { audience: 'public' });
}

export async function renderLogin(root, who, onSignedIn) {
  const d = state.data;
  const isStaff = who !== 'patient';
  const title = isStaff ? 'Staff login' : 'Patient login';

  const email = h('input', { type: 'email', name: 'email', autocomplete: 'username', required: true, placeholder: isStaff ? 'name@dralirashid.com' : 'Your email address' });
  const password = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit', style: { width: '100%' } }, 'Log in');
  // A problem with the login as a whole (wrong password, no connection). Field problems go under their field.
  const problem = h('p', { class: 'field-error', id: `${who}-login-problem`, hidden: true });
  const note = h('p', { class: 'muted', hidden: true });

  const showProblem = (message) => {
    problem.textContent = message;
    problem.hidden = false;
    password.setAttribute('aria-describedby', problem.id);
    announce(message, { assertive: true });
    password.focus();
    password.select();
  };
  const clearProblems = () => {
    problem.hidden = true;
    problem.textContent = '';
    password.removeAttribute('aria-describedby');
    note.hidden = true;
    clearFieldErrors(form);
  };

  const forgot = isStaff
    // Staff login emails do not need a real inbox, so a reset email may never arrive.
    ? h('p', { class: 'muted', style: { marginTop: '12px', fontSize: '14px' } }, 'Forgot your password? Ask Dr. Ali or an admin to set a new password (Admin → Staff accounts → Login and password).')
    : h('p', { style: { marginTop: '12px', fontSize: '14px' } },
      h('button', {
        type: 'button', class: 'link-btn',
        onclick: busy(async () => {
          clearProblems();
          if (!email.value.trim()) return showFormErrors(form, [{ input: email, message: 'Type your email address first, then choose "Forgot password" again.' }]);
          try {
            await d.sendPasswordReset(email.value);
            note.textContent = 'If this email has a patient account, a link to set a new password is on its way. Check your inbox (and spam folder).';
            note.hidden = false;
            announce(note.textContent);
          } catch (err) {
            // A staff email typed here: the data layer explains that staff passwords are reset by an admin.
            showProblem(err?.code === 'STAFF_RESET' ? err.message : friendlyError(err, { audience: 'public' }));
          }
          return undefined;
        }),
      }, 'Forgot password?'));

  const form = h('form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      if (submit.disabled) return;
      clearProblems();
      const address = email.value.trim();
      const errors = [];
      if (!address) errors.push({ input: email, message: 'Type your email address.' });
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) errors.push({ input: email, message: 'Type the whole email address, for example name@example.com.' });
      if (!password.value) errors.push({ input: password, message: 'Type your password.' });
      if (errors.length) { showFormErrors(form, errors); return; }
      submit.disabled = true;
      try {
        const s = await d.signIn(address, password.value);
        if (!s) throw new Error('NOT_LINKED');
        state.session = s;
        onSignedIn();
      } catch (err) {
        showProblem(loginProblem(err, isStaff));
      } finally {
        submit.disabled = false;
      }
    },
  },
  field('Email', email),
  field('Password', password),
  problem,
  submit,
  note,
  forgot);

  let demo = null;
  if (d.mode === 'demo') {
    const accounts = (await d.demoAccounts()).filter((a) => (isStaff ? a.kind === 'staff' : a.kind === 'patient'));
    demo = h('div', {},
      h('div', { class: 'demo-note' }, 'Demo mode: the database is not connected yet, so this is made-up sample data. Pick an account to see what that person sees.'),
      h('div', { class: 'demo-accounts' }, accounts.map((a) => h('button', {
        type: 'button', class: 'btn', onclick: busy(async () => {
          state.session = await d.signInDemo(a.id);
          onSignedIn();
        }),
      }, h('span', {}, a.label), h('span', { class: 'muted' }, a.kind === 'staff' ? ROLE_LABELS[a.role] : 'Patient portal')))));
  }

  mount(root, h('div', { class: 'login-wrap' },
    h('main', { class: 'login-card' },
      h('p', {}, h('a', { href: '#/' }, h('span', { 'aria-hidden': 'true' }, '← '), "Dr. Ali Rashid's Dental Clinic")),
      h('h1', {}, title),
      demo || form,
      !isStaff && !demo ? h('div', { class: 'login-demo' },
        h('p', { class: 'muted' }, 'Not sure what your account shows? Your visits, invoices and dues, progress photos and X-rays, your next appointment and a direct line to Dr. Ali.'),
        h('a', { class: 'btn', href: '#/patient/demo', style: { width: '100%' } }, 'See a sample patient account')) : null,
      h('p', { class: 'muted', style: { fontSize: '13px', marginTop: '16px' } },
        isStaff ? h('a', { href: '#/login/patient' }, 'Are you a patient? Patient login') : h('a', { href: '#/login/staff' }, 'Clinic staff? Staff login')))));
}
