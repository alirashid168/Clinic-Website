// A patient's portal login, made at the clinic: staff create the login (or set a new password), hand the patient a
// username and password on a printed slip, and the patient chooses their own password the first time they log in.
// The password is shown only in these dialogs and on the slip. It is never kept in the page, a list or the audit log.
import { h, modal, field, toast, friendlyError, showFormErrors, clearFieldErrors } from '../../ui/dom.js';
import { state } from '../../state.js';
import { CONFIG } from '../../config.js';
import { printSheet } from './invoice.js';
import { checkPortalPassword, generatePortalPassword, portalLoginEmail, PASSWORD_MIN } from '../../lib/portal-login.js';

export const SITE_ADDRESS = 'www.dralirashid.com';

/** The slip handed to the patient: one small page (A6, see the print rules in app.css). */
export function loginSlip(patient, username, password) {
  const short = username.split('@')[0];
  const row = (label, value) => h('div', { class: 'slip-row' }, h('span', { class: 'slip-label' }, label), h('strong', { class: 'slip-value' }, value));
  return h('div', { class: 'login-slip print-area' },
    h('p', { class: 'slip-clinic' }, CONFIG.CLINIC_NAME),
    h('h3', {}, 'Your patient account'),
    h('p', { class: 'slip-who' }, `${patient.full_name} · Mr# ${patient.mr_number}`),
    h('p', {}, 'Log in at ', h('strong', {}, SITE_ADDRESS), ' and choose Patient.'),
    row('Username', username),
    h('p', { class: 'slip-hint' }, `At login you can type just ${short}`),
    row('Password', password),
    h('p', { class: 'slip-note' }, 'You will be asked to choose your own password the first time you log in.'));
}

/** The slip in a dialog with a Print button (the printSheet pattern of receipts and invoices). */
export function showLoginSlip(patient, username, password, title = 'Login slip') {
  const sheet = loginSlip(patient, username, password);
  return modal(title, h('div', {},
    h('p', { class: 'muted' }, 'Give the patient this slip. The password is shown only here and is not saved anywhere. If it is lost, use "Reset portal password" to make a new one.'),
    sheet), [
    { label: 'Close' },
    { label: 'Print login slip', primary: true, onClick: () => { printSheet(sheet); return false; } },
  ]);
}

/** A password box with a fresh readable password in it, and buttons for another one and for copying. */
function passwordField() {
  const input = h('input', { type: 'text', value: generatePortalPassword(), autocomplete: 'off', spellcheck: 'false', autocapitalize: 'none', style: { fontFamily: 'monospace' } });
  const again = h('button', { type: 'button', class: 'btn btn-small', onclick: () => { input.value = generatePortalPassword(); } }, 'New one');
  const copy = h('button', { type: 'button', class: 'btn btn-small', onclick: async () => { try { await navigator.clipboard.writeText(input.value); toast('Password copied.', 'ok', 1500); } catch { input.select(); } } }, 'Copy');
  return { input, row: h('div', { class: 'inline' }, input, again, copy) };
}

/**
 * The dialog to create a patient's portal login (mode 'create') or to set a new password for one made at the clinic
 * (mode 'reset', with its username). Saving closes it, calls onDone() to redraw the page, then opens the slip.
 */
export function portalLoginModal(p, { mode, username = '', onDone } = {}) {
  const d = state.data;
  const reset = mode === 'reset';
  const address = reset ? username : portalLoginEmail(p.full_name, p.mr_number, CONFIG.STAFF_EMAIL_DOMAIN);
  const pw = passwordField();
  const shown = h('input', { type: 'text', value: address, readonly: true, spellcheck: 'false', 'aria-label': 'Username', style: { fontFamily: 'monospace' } });
  const copyName = h('button', { type: 'button', class: 'btn btn-small', onclick: async () => { try { await navigator.clipboard.writeText(address); toast('Username copied.', 'ok', 1500); } catch { shown.select(); } } }, 'Copy');
  const body = h('div', {},
    h('p', { class: 'muted' }, reset
      ? 'Use this when the patient has forgotten their password. The old password stops working as soon as you save, and the patient chooses a new one at their next login.'
      : 'The patient logs in with this username and password. No email is sent. They choose their own password the first time they log in.'),
    field('Username', h('div', { class: 'inline' }, shown, copyName), reset
      ? 'The username does not change.'
      : "Made from the patient's name and Mr#. The patient can type just the part before the @."),
    field('Password', pw.row, `At least ${PASSWORD_MIN} characters. Change it if you like, then give it to the patient. It is shown only here and on the slip.`, { required: true }));

  const dlg = modal(reset ? `Reset portal password · ${p.full_name}` : `Create portal login · ${p.full_name}`, body, [
    { label: 'Cancel' },
    { label: reset ? 'Reset password' : 'Create login', primary: true, onClick: async () => {
      clearFieldErrors(body);
      if (!address) { toast('This patient has no usable Mr#, so a username cannot be made.', 'error'); return false; }
      const password = pw.input.value.trim();
      const problem = checkPortalPassword(password);
      if (problem) return showFormErrors(body, [{ input: pw.input, message: problem }]);
      let saved;
      try { saved = reset ? await d.resetPatientPassword(p.id, password) : await d.createPatientLogin(p.id, password); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      dlg.close();
      try { await onDone?.(); } catch (err) { console.error(err); toast('Saved, but the page could not refresh itself. Reload it to see the latest.', 'error'); }
      showLoginSlip(p, saved?.username || address, password, reset ? 'New password ready' : 'Login ready');
      return false; // the dialog is already closed
    } },
  ], { initialFocus: pw.input });
  return dlg;
}
