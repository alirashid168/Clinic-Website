// Staff and patient login. Problems are written under the form (and spoken),
// so they stay until the next try instead of vanishing with a toast.
import { h, mount, field, friendlyError, announce, busy, showFormErrors, clearFieldErrors, extLink } from '../ui/dom.js';
import { state } from '../state.js';
import { ROLE_LABELS } from '../lib/permissions.js';
import { normalizeLoginInput } from '../lib/portal-login.js';
import { CONFIG } from '../config.js';
import { CONTACT } from '../content.js';

function loginProblem(err, isStaff) {
  const msg = err?.message || '';
  if (msg === 'NOT_LINKED') {
    return isStaff ? 'This login is not linked to a staff account yet. Ask Dr. Ali or an admin.' : 'This login is not linked to a patient record yet. Please contact the clinic.';
  }
  if (/invalid login credentials/i.test(msg)) return isStaff ? 'That email and password do not match. Check both and try again.' : 'That username (or email) and password do not match. Check both and try again.';
  if (/email not confirmed/i.test(msg)) return 'Your email address is not confirmed yet. Open the link in the email we sent you, then log in.';
  if (/rate limit|too many/i.test(msg)) return 'Too many tries. Wait a minute, then try again.';
  return friendlyError(err, isStaff ? undefined : { audience: 'public' });
}

/** A link that opens a WhatsApp chat with the clinic (the number set in staff Settings, else the one in content.js), or nothing without a number. */
function clinicWhatsApp(label) {
  let number = String(state.ref?.settings?.whatsapp_number || '').replace(/\D/g, '') || String(CONTACT.whatsapp || '').replace(/\D/g, '');
  if (number.startsWith('0')) number = '92' + number.slice(1);
  if (number.length < 7) return null;
  return extLink(`https://wa.me/${number}?text=${encodeURIComponent('Hello, I need my patient account password reset.')}`, label);
}

export async function renderLogin(root, who, onSignedIn) {
  const d = state.data;
  const isStaff = who !== 'patient';
  const title = isStaff ? 'Staff login' : 'Patient login';

  // Staff type their whole email. A patient types the username from the clinic's slip (the part before the @ is enough) or their own email.
  const email = isStaff
    ? h('input', { type: 'email', name: 'email', autocomplete: 'username', required: true, placeholder: 'name@dralirashid.com' })
    : h('input', { type: 'text', name: 'username', autocomplete: 'username', required: true, inputmode: 'email', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', placeholder: 'For example alirashid-1705' });
  const typedAddress = () => (isStaff ? email.value.trim() : normalizeLoginInput(email.value, CONFIG.STAFF_EMAIL_DOMAIN));
  const password = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit', style: { width: '100%' } }, 'Log in');
  // A problem with the login as a whole (wrong password, no connection). Field problems go under their field.
  const problem = h('p', { class: 'field-error', id: `${who}-login-problem`, hidden: true });
  const note = h('p', { class: 'muted', hidden: true });
  const showNote = (...parts) => {
    note.replaceChildren(...parts.filter((x) => x !== null && x !== undefined));
    note.hidden = false;
    announce(note.textContent);
  };

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
          const address = typedAddress();
          if (!address) return showFormErrors(form, [{ input: email, message: 'Type your username or email address first, then choose "Forgot password" again.' }]);
          // A username made at the clinic has no inbox: no email is sent, the clinic sets a new password.
          if (address.endsWith('@' + CONFIG.STAFF_EMAIL_DOMAIN)) {
            const wa = clinicWhatsApp('message the clinic on WhatsApp');
            showNote('Ask the clinic to reset your password. The front desk can give you a new one, in person or by phone', ...(wa ? [', or you can ', wa, '.'] : ['.']));
            return undefined;
          }
          try {
            await d.sendPasswordReset(address);
            // A patient whose login the clinic made also has their real email on file, but no link ever arrives for it: say where to go.
            const wa = clinicWhatsApp('message the clinic on WhatsApp');
            showNote('If this email has a patient account, a link to set a new password is on its way. Check your inbox (and spam folder). ',
              'If the clinic gave you a username on a slip, no link will come: use that username here instead, ', ...(wa ? ['or ', wa] : ['or contact the clinic']), ' and ask for a new password.');
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
      const address = typedAddress();
      const errors = [];
      if (!address) errors.push({ input: email, message: isStaff ? 'Type your email address.' : 'Type your username or email address.' });
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) errors.push({ input: email, message: isStaff ? 'Type the whole email address, for example name@example.com.' : 'Type your username exactly as on your slip, for example alirashid-1705, or the whole email address.' });
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
  isStaff ? field('Email', email) : field('Username or email', email, 'Use the username on the slip the clinic gave you. Patients who were invited by email use that email address.'),
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
      h('p', {}, h('a', { class: 'login-link', href: '#/' }, h('span', { 'aria-hidden': 'true' }, '← '), "Dr. Ali Rashid's Dental Clinic")),
      h('h1', {}, title),
      // The demo's patient page also takes a login a staff member made, so the whole first-login path can be tried.
      isStaff ? (demo || form) : h('div', {}, demo, demo ? h('h2', { style: { fontSize: 'var(--fs-lg)', margin: 'var(--space-4) 0 var(--space-2)' } }, 'Or log in with a username and password') : null, form),
      !isStaff && !demo ? h('div', { class: 'login-demo' },
        h('p', { class: 'muted' }, 'Not sure what your account shows? Your visits, invoices and dues, progress photos and X-rays, your next appointment and a direct line to Dr. Ali.'),
        h('a', { class: 'btn', href: '#/patient/demo', style: { width: '100%' } }, 'See a sample patient account')) : null,
      h('p', { class: 'muted', style: { fontSize: '13px', marginTop: '16px' } },
        isStaff ? h('a', { class: 'login-link', href: '#/login/patient' }, 'Are you a patient? Patient login') : h('a', { class: 'login-link', href: '#/login/staff' }, 'Clinic staff? Staff login')))));
}
