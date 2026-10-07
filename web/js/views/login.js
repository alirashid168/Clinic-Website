import { h, mount, field, toast, friendlyError } from '../ui/dom.js';
import { state } from '../state.js';
import { ROLE_LABELS } from '../lib/permissions.js';

export async function renderLogin(root, who, onSignedIn) {
  const d = state.data;
  const isStaff = who !== 'patient';
  const title = isStaff ? 'Staff login' : 'Patient login';

  const email = h('input', { type: 'email', autocomplete: 'username', required: true, placeholder: isStaff ? 'name@dralirashid.com' : 'Your email address' });
  const password = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit', style: { width: '100%' } }, 'Log in');

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        const s = await d.signIn(email.value, password.value);
        if (!s) throw new Error('This login is not linked to a staff or patient record yet. Contact the clinic.');
        state.session = s;
        onSignedIn();
      } catch (err) {
        toast(friendlyError(err), 'error');
      } finally {
        submit.disabled = false;
      }
    },
  },
  field('Email', email),
  field('Password', password),
  submit,
  h('p', { style: { marginTop: '12px', fontSize: '14px' } },
    h('button', {
      type: 'button', class: 'link-btn',
      onclick: async () => {
        if (!email.value) return toast('Type your email first, then tap "Forgot password".');
        try { await d.sendPasswordReset(email.value); toast('Check your email for a link to set a new password.', 'ok'); } catch (err) { toast(friendlyError(err), 'error'); }
      },
    }, 'Forgot password')));

  let demo = null;
  if (d.mode === 'demo') {
    const accounts = (await d.demoAccounts()).filter((a) => (isStaff ? a.kind === 'staff' : a.kind === 'patient'));
    demo = h('div', {},
      h('div', { class: 'demo-note' }, 'Demo mode: the database is not connected yet, so this is made-up sample data. Pick an account to see what that person sees.'),
      h('div', { class: 'demo-accounts' }, accounts.map((a) => h('button', {
        class: 'btn', onclick: async () => {
          state.session = await d.signInDemo(a.id);
          onSignedIn();
        },
      }, h('span', {}, a.label), h('span', { class: 'muted' }, a.kind === 'staff' ? ROLE_LABELS[a.role] : 'Patient portal')))));
  }

  mount(root, h('div', { class: 'login-wrap' },
    h('div', { class: 'login-card' },
      h('p', {}, h('a', { href: '#/' }, "← Dr. Ali Rashid's Dental Clinic")),
      h('h1', {}, title),
      demo || form,
      !isStaff && !demo ? h('div', { class: 'login-demo' },
        h('p', { class: 'muted' }, 'Not sure what your account shows? Your visits, invoices and dues, progress photos and X-rays, your next appointment and a direct line to Dr. Ali.'),
        h('a', { class: 'btn', href: '#/patient/demo', style: { width: '100%' } }, 'See a sample patient account')) : null,
      h('p', { class: 'muted', style: { fontSize: '13px', marginTop: '16px' } },
        isStaff ? h('a', { href: '#/login/patient' }, 'Are you a patient? Patient login') : h('a', { href: '#/login/staff' }, 'Clinic staff? Staff login')))));
}
