// A patient's portal login, made at the clinic with one button (the owner, 17 Oct 2026: "the patient user creation should be simple,
// and we keep the password, the patient can change it themselves later"). The login name is the patient's Mr#; the password is the
// patient's mobile number as on file (digits only), unless staff type another one; the patient is not made to change it, and can from
// the portal menu later. Reset = set it back to the phone number (or to a typed one). Staff then hand over, print or copy a short card.
// The phone number is never shown as a password here: the card says "your mobile number" (and the last digits, for families who share one).
import { h, modal, field, toast, friendlyError, showFormErrors, clearFieldErrors } from '../../ui/dom.js';
import { state } from '../../state.js';
import { CONFIG } from '../../config.js';
import { printSheet } from './invoice.js';
import { checkPhonePassword, checkPortalPassword, isMrLoginEmail, mrLoginEmail, phonePassword, isPatientLoginName, NO_USERNAME_MESSAGE, PASSWORD_MIN } from '../../lib/portal-login.js';

export const SITE_ADDRESS = 'www.dralirashid.com';

/** "ends with 4567": which phone it is, for a family that shares numbers, without printing the whole number as a password. */
export function phoneHint(phone) {
  const digits = phonePassword(phone);
  return digits.length >= 4 ? `ends with ${digits.slice(-4)}` : '';
}

/**
 * What the patient is told: the login name ("Mr# 50013" for a Mr# login, else the older username) and the password ("your mobile
 * number", or "the password the clinic typed" when staff chose one). For the card, the profile line and the Create menu.
 */
export function loginWords(patient, username, passwordKind = 'phone') {
  const mr = isMrLoginEmail(username, patient.mr_number, CONFIG.STAFF_EMAIL_DOMAIN);
  return {
    loginName: mr ? `Mr# ${patient.mr_number}` : String(username || '').split('@')[0],
    loginHint: mr ? 'Type only the number.' : 'The username the clinic gave you.',
    password: passwordKind === 'phone' ? `your mobile number${phoneHint(patient.phone) ? ` (${phoneHint(patient.phone)})` : ''}` : 'the password the clinic typed for you',
  };
}

/** The card handed to the patient: one small page (A6, the print rules of the login slip in app.css). */
export function loginCard(patient, username, passwordKind = 'phone') {
  const words = loginWords(patient, username, passwordKind);
  const row = (label, value) => h('div', { class: 'slip-row' }, h('span', { class: 'slip-label' }, label), h('strong', { class: 'slip-value' }, value));
  return h('div', { class: 'login-slip print-area' },
    h('p', { class: 'slip-clinic' }, CONFIG.CLINIC_NAME),
    h('h3', {}, 'Your patient account'),
    h('p', { class: 'slip-who' }, `${patient.full_name} · Mr# ${patient.mr_number}`),
    h('p', {}, 'Go to ', h('strong', {}, SITE_ADDRESS), ' and choose Patient login.'),
    row('Login name', words.loginName),
    row('Password', words.password),
    h('p', { class: 'slip-note' }, 'You can change the password from the menu after you log in.'));
}

/** The card as plain text, for the Copy button (a WhatsApp message to the patient). */
export function loginCardText(patient, username, passwordKind = 'phone') {
  const words = loginWords(patient, username, passwordKind);
  return [`${CONFIG.CLINIC_NAME}: your patient account`, `Go to ${SITE_ADDRESS} and choose Patient login.`, `Login name: ${words.loginName}`,
    `Password: ${words.password}`, 'You can change the password from the menu after you log in.'].join('\n');
}

/** The card in a dialog with Print and Copy. */
export function showLoginCard(patient, username, passwordKind = 'phone', title = 'Login ready') {
  const sheet = loginCard(patient, username, passwordKind);
  const copy = async () => {
    try { await navigator.clipboard.writeText(loginCardText(patient, username, passwordKind)); toast('Copied. Paste it in a message to the patient.', 'ok', 2000); } catch { toast('Copying is not allowed here. Print the card instead.', 'error'); }
    return false;
  };
  return modal(title, h('div', {},
    h('p', { class: 'muted' }, 'Tell the patient, or print or copy this card. The password is their own mobile number, so nothing secret is written here.'),
    sheet), [
    { label: 'Close' },
    { label: 'Copy', onClick: copy },
    { label: 'Print card', primary: true, onClick: () => { printSheet(sheet); return false; } },
  ]);
}

/**
 * The dialog to create a patient's login (mode 'create') or to set its password back (mode 'reset', with the login's username).
 * One primary button. The password is the phone on file; "Use another password" is there for a patient with no usable phone (then it
 * is required) or when staff prefer one. Saving closes it, calls onDone() to redraw the page, then shows the card.
 */
export function patientLoginModal(p, { mode, username = '', onDone } = {}) {
  const d = state.data;
  const reset = mode === 'reset';
  const made = mrLoginEmail(p.mr_number, CONFIG.STAFF_EMAIL_DOMAIN);
  const address = reset ? username : (isPatientLoginName(made, CONFIG.STAFF_EMAIL_DOMAIN) ? made : '');
  const phoneProblem = checkPhonePassword(p.phone);
  const words = loginWords(p, address, 'phone');
  const other = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'none', placeholder: phoneProblem ? 'Type a password' : 'Leave empty to use the mobile number', style: { fontFamily: 'monospace' } });
  const body = h('div', {},
    h('p', { class: 'muted' }, reset
      ? 'Use this when the patient has forgotten their password. The password goes back to their mobile number on file (or the one you type). Saving signs the patient out everywhere: the old password stops working at once, and a phone or computer that was logged in is signed out within the hour.'
      : 'The patient logs in on the website with their Mr# and their mobile number as the password. No email is sent, and they are not made to change the password; they can from the portal menu.'),
    field('Login name', h('strong', {}, words.loginName), reset ? null : 'The patient types only the number.'),
    field('Password', phoneProblem ? h('span', { class: 'status-bad' }, phoneProblem) : h('span', {}, `The patient's mobile number on file (${phoneHint(p.phone)}).`)),
    field('Use another password', other, `Optional. At least ${PASSWORD_MIN} characters. Say it to the patient yourself: it is not shown on the card.`, { required: !!phoneProblem }));

  const dlg = modal(reset ? `Reset login password · ${p.full_name}` : `Create login · ${p.full_name}`, body, [
    { label: 'Cancel' },
    { label: reset ? 'Reset password' : 'Create login', primary: true, onClick: async () => {
      clearFieldErrors(body);
      if (!address) { toast(NO_USERNAME_MESSAGE, 'error'); return false; }
      const typed = other.value.trim();
      if (typed) {
        const problem = checkPortalPassword(typed);
        if (problem) return showFormErrors(body, [{ input: other, message: problem }]);
      } else if (phoneProblem) return showFormErrors(body, [{ input: other, message: phoneProblem }]);
      let saved;
      try { saved = reset ? await d.resetPatientPassword(p.id, typed || null) : await d.createPatientLogin(p.id, typed || null); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      dlg.close();
      try { await onDone?.(); } catch (err) { console.error(err); toast('Saved, but the page could not refresh itself. Reload it to see the latest.', 'error'); }
      showLoginCard(p, saved?.username || address, typed ? 'typed' : 'phone', reset ? 'Password reset' : 'Login ready');
      return false; // the dialog is already closed
    } },
  ], { initialFocus: other });
  return dlg;
}
