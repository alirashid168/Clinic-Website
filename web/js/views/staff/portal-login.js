// A patient's portal login, made at the clinic: staff create the login (or set a new password), hand the patient a
// username and password on a printed slip, and the patient chooses their own password the first time they log in.
// The password is shown only in these dialogs and on the slip. It is never kept in the page, a list or the audit log.
import { h, modal, field, toast, friendlyError, showFormErrors, clearFieldErrors } from '../../ui/dom.js';
import { state } from '../../state.js';
import { CONFIG } from '../../config.js';
import { printSheet } from './invoice.js';
import { checkSlipPassword, generatePortalPassword, isPatientLoginName, portalLoginEmail, NO_USERNAME_MESSAGE, SLIP_PASSWORD_MIN } from '../../lib/portal-login.js';

export const SITE_ADDRESS = 'www.dralirashid.com';

/**
 * How the username is set on the slip: in one piece before the @ (so the dash and the Mr# can never be split over two lines),
 * with the only place a line may break right before the @, and in a smaller type when it is long, so that even the longest
 * username that can be made (24 letters, a dash and a 30 character Mr#) fits the width of the A6 page.
 */
export function slipUsernameParts(username) {
  const at = username.lastIndexOf('@');
  const local = at < 0 ? username : username.slice(0, at);
  const domain = at < 0 ? '' : username.slice(at);
  const size = local.length > 42 ? 'xs' : local.length > 33 ? 'sm' : local.length > 26 ? 'md' : 'lg';
  return { size, parts: [h('span', { class: 'slip-nowrap' }, local), h('wbr'), domain ? h('span', { class: 'slip-nowrap' }, domain) : null] };
}

/** The slip handed to the patient: one small page (A6, see the print rules in app.css). */
export function loginSlip(patient, username, password) {
  const short = username.split('@')[0];
  const row = (label, value, cls) => h('div', { class: 'slip-row' }, h('span', { class: 'slip-label' }, label), h('strong', { class: ['slip-value', cls] }, value));
  const user = slipUsernameParts(username);
  return h('div', { class: 'login-slip print-area' },
    h('p', { class: 'slip-clinic' }, CONFIG.CLINIC_NAME),
    h('h3', {}, 'Your patient account'),
    h('p', { class: 'slip-who' }, `${patient.full_name} · Mr# ${patient.mr_number}`),
    h('p', {}, 'Log in at ', h('strong', {}, SITE_ADDRESS), ' and choose Patient.'),
    row('Username', user.parts, `slip-user slip-user-${user.size}`),
    // The same piece, kept whole, in the same smaller type when it is long.
    h('p', { class: 'slip-hint' }, 'At login you can type just ', h('span', { class: ['slip-nowrap', (user.size === 'sm' || user.size === 'xs') && `slip-user-${user.size}`] }, short)),
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

/**
 * A password box with a fresh readable password in it and a button for another one. There is deliberately no Copy button: the
 * slip is how the password is handed over, and a copied password would stay in the clipboard history of the front desk computer.
 */
function passwordField() {
  const input = h('input', { type: 'text', value: generatePortalPassword(), autocomplete: 'off', spellcheck: 'false', autocapitalize: 'none', style: { fontFamily: 'monospace' } });
  const again = h('button', { type: 'button', class: 'btn btn-small', onclick: () => { input.value = generatePortalPassword(); } }, 'New one');
  return { input, row: h('div', { class: 'inline' }, input, again) };
}

/**
 * The dialog to create a patient's portal login (mode 'create') or to set a new password for one made at the clinic
 * (mode 'reset', with its username). Saving closes it, calls onDone() to redraw the page, then opens the slip.
 */
export function portalLoginModal(p, { mode, username = '', onDone } = {}) {
  const d = state.data;
  const reset = mode === 'reset';
  // Only a username of the reserved patient shape can be made (the server checks it too); a Mr# without a number gives none.
  const made = portalLoginEmail(p.full_name, p.mr_number, CONFIG.STAFF_EMAIL_DOMAIN);
  const address = reset ? username : (isPatientLoginName(made, CONFIG.STAFF_EMAIL_DOMAIN) ? made : '');
  const pw = passwordField();
  const shown = h('input', { type: 'text', value: address, readonly: true, spellcheck: 'false', 'aria-label': 'Username', style: { fontFamily: 'monospace' } });
  const copyName = h('button', { type: 'button', class: 'btn btn-small', onclick: async () => { try { await navigator.clipboard.writeText(address); toast('Username copied.', 'ok', 1500); } catch { shown.select(); } } }, 'Copy');
  const body = h('div', {},
    h('p', { class: 'muted' }, reset
      ? 'Use this when the patient has forgotten their password or lost a phone. Saving signs the patient out everywhere: the old password stops working at once, and a phone or computer that was logged in is signed out within the hour. The patient chooses a new password at their next login.'
      : 'The patient logs in with this username and password. No email is sent. They choose their own password the first time they log in.'),
    field('Username', h('div', { class: 'inline' }, shown, copyName), reset
      ? 'The username does not change.'
      : "Made from the patient's name and Mr#. The patient can type just the part before the @."),
    field('Password', pw.row, `At least ${SLIP_PASSWORD_MIN} characters, not only digits. Change it if you like, then give it to the patient. It is shown only here and on the slip.`, { required: true }));

  const dlg = modal(reset ? `Reset portal password · ${p.full_name}` : `Create portal login · ${p.full_name}`, body, [
    { label: 'Cancel' },
    { label: reset ? 'Reset password' : 'Create login', primary: true, onClick: async () => {
      clearFieldErrors(body);
      if (!address) { toast(NO_USERNAME_MESSAGE, 'error'); return false; }
      const password = pw.input.value.trim();
      const problem = checkSlipPassword(password);
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
