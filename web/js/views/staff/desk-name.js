// Shared logins (the owner, 15 Oct 2026): "instead of name picker, just give a popup saying please enter your name. because
// sometimes islamabad branch has a different front desk person at different visits, so they can just put in their names."
// The rules and where the name is kept are in ../../lib/desk-name.js. This file has the popup (shell.js opens it after a sign-in to
// a shared login, and again from "Change name" in the name menu), and the two dialogs of Admin -> Staff accounts: "Shared login"
// (switch it on or off for an account) and "Names used" (the names typed on a shared login, newest first).
import { h, modal, toast, friendlyError, field, setFieldError, announce, empty, shortDate, timeOf, localISO } from '../../ui/dom.js';
import { state } from '../../state.js';
import { cleanDeskName, deskNameFor, keepDeskName, forgetDeskName, deskNameSuggestions, rememberDeskName, DESK_NAME_MAX } from '../../lib/desk-name.js';

// The popup waits this long for the name to be saved in the list of names (public.desk_names), then lets the person carry on anyway.
const SAVE_WAIT_MS = 8000;
const NAMES_DAYS = 60; // "Names used" lists this many days back
let asking = null; // the popup on screen (one at a time)

/** Tells the data layer which name goes with this login's requests: the name given in this tab, for a shared login only. */
export function syncDeskName(staff) {
  state.data?.setDeskName?.(staff?.id ?? null, staff?.shared_login ? deskNameFor(staff.id) : null);
}

/** True when this login must say who is at the desk before anything else. */
export const needsDeskName = (staff) => !!staff?.shared_login && !deskNameFor(staff.id);

/**
 * "Please enter your name". It cannot be closed without a name: there is no × and no Cancel, and Escape and a click outside do
 * nothing; "Log out" is there for someone who signed in to the wrong login. Every page change closes it (main.js closes all dialogs),
 * and the next page asks again, since there is still no name. onName(name) runs once the name is kept; onGone() when the popup
 * closed without one (a page change, a logout). A popup already open is closed first (its onGone runs): one at a time.
 */
export function askDeskName({ staff, signOut, onName, onGone }) {
  asking?.close();
  let named = false;
  const suggestions = deskNameSuggestions(staff.id);
  const listId = 'desk-name-suggestions';
  const input = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', dir: 'auto', maxlength: String(DESK_NAME_MAX + 20), list: suggestions.length ? listId : null });
  const body = h('div', {},
    h('p', {}, `Several people use the login "${staff.full_name}". Write your own name, so the clinic knows who did what.`),
    field('Your name', input, suggestions.length ? 'Any language. Names used on this computer before are offered as you type.' : 'Any language.', { required: true }),
    suggestions.length ? h('datalist', { id: listId }, suggestions.map((n) => h('option', { value: n }))) : null,
    h('p', { class: 'muted' }, 'Your name is shown with the login in the name menu and is kept with what you do until you log out. When someone else takes over, they choose "Change name" there.'));
  const dlg = modal('Please enter your name', body, [
    { label: 'Log out', onClick: () => { signOut(); } },
    { label: 'Continue', primary: true, onClick: async () => {
      const { name, error } = cleanDeskName(input.value);
      if (error) { setFieldError(input, error); input.focus(); announce(error); return false; }
      keepDeskName(staff.id, name);
      rememberDeskName(staff.id, name);
      state.data?.setDeskName?.(staff.id, name);
      // The list of names on Staff accounts ("Names used"). It never holds the person up: a slow answer is not waited for, and a
      // failed save is only logged (the name still goes with every change they make).
      const saved = Promise.resolve().then(() => state.data?.saveDeskName?.(name)).catch((e) => console.error(e));
      let timer;
      await Promise.race([saved, new Promise((resolve) => { timer = setTimeout(resolve, SAVE_WAIT_MS); })]);
      clearTimeout(timer);
      named = true;
      onName?.(name);
      announce(`Thank you, ${name}.`);
    } },
  ], { locked: true, onClose: () => { if (asking === dlg) asking = null; if (!named) onGone?.(); } });
  asking = dlg;
  // Enter in the box is Continue (not while an Urdu or other input method is still composing a word).
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    dlg.dialog.querySelector('.modal-actions .btn-primary')?.click();
  });
}

/**
 * "Change name" (a new person at the desk): the name given so far stops at once, and the popup asks for the new one, over the page
 * that is on screen (it stays as it is, and cannot be used until a name is given).
 */
export function changeDeskName({ staff, signOut, onName }) {
  forgetDeskName();
  state.data?.setDeskName?.(staff.id, null);
  onName?.(null);
  askDeskName({ staff, signOut, onName });
}

// ---------------------------------------------------------------- Admin -> Staff accounts
const SHARED_LOGIN_TEXT = 'Shared login — several people use it; it asks for their name when they sign in';

/** Switches "Shared login" on or off for one account (not for an admin, nor your own: the row has no button then). */
export function openSharedLogin(s, { onSaved } = {}) {
  const box = h('input', { type: 'checkbox', checked: !!s.shared_login });
  const body = h('div', {},
    h('p', { class: 'muted' }, `For a login that several people use, such as a branch's front desk. After every sign-in it asks "Please enter your name", and that name is kept with what they do: in the audit log, in the History of Aaj ki List and under "Names used".`),
    h('label', { class: 'inline' }, box, SHARED_LOGIN_TEXT));
  modal(`Shared login · ${s.full_name}`, body, [
    { label: 'Cancel' },
    { label: 'Save', primary: true, onClick: async () => {
      if (box.checked === !!s.shared_login) { toast('Nothing changed.'); return false; }
      try {
        await state.data.setStaffShared(s.id, box.checked);
        toast(box.checked ? `Saved. ${s.full_name} asks for a name at every sign-in.` : `Saved. ${s.full_name} is a personal login again.`, 'ok');
        await onSaved?.();
      } catch (e) { toast(friendlyError(e), 'error'); return false; }
    } },
  ]);
}

const when = (ts) => `${shortDate(localISO(new Date(ts)))} ${timeOf(ts)}`;

/** The names typed on one shared login in the last 60 days, newest first, with how often each name was given. */
export async function openNamesUsed(s) {
  const rows = await state.data.deskNamesOf(s.id, { days: NAMES_DAYS });
  const counts = new Map();
  for (const r of rows) counts.set(r.name, (counts.get(r.name) || 0) + 1);
  const body = rows.missing
    ? empty('The list of names needs the database update (20261015000300_desk_names.sql).')
    : !rows.length
      ? empty(`Nobody has entered a name on this login in the last ${NAMES_DAYS} days.`)
      : h('div', {},
        h('p', {}, `${counts.size} name${counts.size === 1 ? '' : 's'} in the last ${NAMES_DAYS} days: `,
          [...counts].map(([name, n], i) => [i ? ', ' : '', h('strong', {}, h('bdi', {}, name)), ` (${n})`])),
        rows.truncated ? h('p', { class: 'muted' }, `Showing the latest ${rows.cap}.`) : null,
        h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'When'), h('th', { scope: 'col' }, 'Name'))),
          h('tbody', {}, rows.map((r) => h('tr', {}, h('td', { class: 'nowrap' }, when(r.entered_at)), h('td', {}, h('bdi', {}, r.name))))))));
  modal(`Names used · ${s.full_name}`, body, [{ label: 'Done', primary: true }], { startOnTitle: true });
}
