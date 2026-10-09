// "Change password" dialog for the person who is logged in, asking for their current password first. Built for the staff menu and
// reusable as it is by the patient portal (openChangePassword({ who: 'patient' }): only the sentences a patient is told differ).
// The work is state.data.changeOwnPassword(current, new) (data/supabase.js, data/demo.js); the rules and words are in password-rules.js.
import { h, modal, field, showFormErrors, clearFieldErrors, toast, friendlyError, announce } from './dom.js';
import { state } from '../state.js';
import { passwordProblems } from '../password-rules.js';

const DONE = 'Password changed. Use the new password next time you log in.';

// A failure whose sentence belongs under one field (the password layers word them: see PASSWORD_MESSAGES) ...
const FIELD_OF_CODE = { WRONG_PASSWORD: 'current', SAME_PASSWORD: 'next', WEAK_PASSWORD: 'next' };
// ... and the other failures they word themselves, shown as a message. Anything else is a connection or server problem for friendlyError().
const WORDED_CODES = new Set([...Object.keys(FIELD_OF_CODE), 'RATE_LIMITED', 'REAUTH_NEEDED', 'NOT_LOGGED_IN', 'LOGIN_CHANGED', 'PASSWORD_RULE', 'ACCOUNT_OFF', 'ACCOUNT_GONE']);
// What a patient is told instead of the staff wording (those sentences send the person to Dr. Ali or to the staff admin page).
const PATIENT_WORDS = {
  REAUTH_NEEDED: 'For safety, log out and choose "Forgot password?" on the login page to set a new password, or contact the clinic.',
  ACCOUNT_OFF: 'This account is switched off. Please contact the clinic.',
  ACCOUNT_GONE: 'This login no longer belongs to an account here. Please contact the clinic.',
};
// Changing a password also ends the login on every other computer and phone (the login server does that), so the person is told before.
const OTHER_DEVICES = {
  staff: 'If this login is also used on other computers or phones, they will be logged out and need the new password.',
  patient: 'If you are logged in on other devices, they will be logged out and need the new password.',
};

let onScreen = null; // the dialog that is open, if any: asking again (a second tap while the code was still loading) shows that one

/**
 * Opens the dialog. The person stays logged in; on success it closes, says so in a toast and calls onDone(). While the change is
 * being sent it cannot be closed (it would go through anyway, and the person would think they had cancelled).
 * `username`: the login name of the person (the email), given to password managers in a hidden field so they update the saved
 * login instead of saving a second one. It is never shown or sent anywhere.
 * @param {{ who?: 'staff' | 'patient', username?: string, onDone?: () => void }} [opts]
 * @returns {{ close: () => void, dialog: HTMLElement }}  the dialog's handle (see modal() in dom.js)
 */
export function openChangePassword({ who = 'staff', username, onDone } = {}) {
  if (onScreen?.dialog.isConnected) return onScreen;
  const patient = who === 'patient';
  const make = (autocomplete) => h('input', { type: 'password', autocomplete, spellcheck: 'false', autocapitalize: 'none', autocorrect: 'off' });
  const inputs = { current: make('current-password'), next: make('new-password'), again: make('new-password') };
  // Shows the two NEW passwords only. The current one stays hidden: a browser may fill in a saved password there by itself, and on a
  // computer someone left logged in, ticking this box must not put that saved password on the screen.
  const show = h('input', { type: 'checkbox', onchange: () => { for (const input of [inputs.next, inputs.again]) input.type = show.checked ? 'text' : 'password'; } });
  // Not display:none (password managers skip those), not focusable and not read out.
  const login = username ? h('input', { type: 'text', class: 'sr-only', readonly: true, tabindex: '-1', 'aria-hidden': 'true', autocomplete: 'username', value: username }) : null;
  const body = h('form', { onsubmit: (e) => e.preventDefault() }, // (the keydown handler below sends it; no button inside, so the browser never submits)
    h('p', { class: 'muted' }, 'Choose a new password for your own login. You stay logged in.'),
    h('p', { class: 'muted' }, OTHER_DEVICES[who] || OTHER_DEVICES.staff),
    login,
    field('Current password', inputs.current),
    field('New password', inputs.next, 'At least 8 characters'),
    field('Type the new password again', inputs.again),
    h('label', { class: 'inline show-passwords' }, show, 'Show the new password'));

  // Always returns false: the dialog stays open, so the person can correct and try again.
  function failed(e) {
    const code = e?.code;
    let text;
    if (patient && PATIENT_WORDS[code]) text = PATIENT_WORDS[code];
    else if (WORDED_CODES.has(code)) text = e.message;
    else { console.error(e); text = friendlyError(e, { audience: patient ? 'public' : 'staff' }); }
    const target = FIELD_OF_CODE[code];
    if (target) {
      showFormErrors(body, [{ input: inputs[target], message: text }]);
      inputs[target].select();
    } else toast(text, 'error');
    return false;
  }

  const handle = modal('Change password', body, [
    { label: 'Cancel' },
    { label: 'Change password', primary: true, onClick: async () => {
      clearFieldErrors(body);
      const typed = { current: inputs.current.value, next: inputs.next.value, again: inputs.again.value };
      const problems = passwordProblems(typed).map((p) => ({ input: inputs[p.field], message: p.message }));
      if (problems.length) return showFormErrors(body, problems);
      // Sending takes two requests, so say so: on the button, and to screen readers (the buttons are greyed out meanwhile).
      const button = handle.dialog.querySelector('.btn-primary');
      const label = button.textContent;
      button.textContent = 'Changing…';
      handle.dialog.setAttribute('aria-busy', 'true');
      announce('Changing your password…');
      try {
        await state.data.changeOwnPassword(typed.current, typed.next);
      } catch (e) {
        return failed(e);
      } finally {
        button.textContent = label;
        handle.dialog.removeAttribute('aria-busy');
      }
      toast(DONE, 'ok', 8000);
      onDone?.();
      return undefined; // closes the dialog
    } },
  ], {
    initialFocus: inputs.current, // not the hidden login name, which comes first in the form
    lockWhileWorking: true,
    onClose: () => { onScreen = null; for (const input of Object.values(inputs)) input.value = ''; }, // nothing typed stays in the page
  });
  onScreen = handle;
  // Enter in a field does what the main button does (the dialog itself ignores a second press while it is working).
  body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || !Object.values(inputs).includes(e.target)) return;
    e.preventDefault();
    handle.dialog.querySelector('.btn-primary')?.click();
  });
  return handle;
}
