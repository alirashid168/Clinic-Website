// "End the day" on the Aaj ki List (owner, 12 Oct 2026): a button that saves a copy of the day's list in the History of
// Aaj ki List, then opens the next day's list, so everyone sees that a new day has started; and a note on a day that was
// ended. Ending a day changes nothing on the list: every row can still be edited and the Google Sheet sync keeps working.
// sheet.js mounts the four pieces (button, the hint shown instead of it for "All branches", History link, note) and calls
// refresh() whenever it loads a list.
import { h, mount, modal, toast, localISO } from '../../ui/dom.js';
import { state, can, branchName } from '../../state.js';
import { countDayList, dayLabel, endedAt, endDayCounts, listAfterEnding, pastMidnight, FIRST_DAY } from '../../lib/day-list.js';

/** The History of Aaj ki List, for one branch (or all), or one day of one branch. */
export function dayHistoryHref(branchId = null, date = null) {
  const q = new URLSearchParams();
  if (branchId) q.set('branch', branchId);
  if (branchId && date) q.set('date', date);
  const query = q.toString();
  return `#/staff/day-history${query ? `?${query}` : ''}`;
}

// After "End the day" the next day's list stays open until midnight: a patient added there is booked for that day (Scheduled),
// not for tonight. On any later day's list the add panel and the toast say so.
/** What the add panel says on a later day's list. */
export const laterDayHint = (date) => `This is the list for ${dayLabel(date)}: patients added here are booked for that day. For a patient who is here now, press Today.`;
/** The toast after adding a patient to a later day's list. */
export const bookedFor = (name, date) => `${name} booked for ${dayLabel(date)}.`;

// How long the dialog's "End the day" stays switched off after the dialog opens: on a phone a quick double tap on the toolbar's
// "End the day" puts its second tap on the dialog's button whenever the two are in the same place on the screen.
const ARM_MS = 500;
// How long after the dialog has closed the note is written: the page behind an open dialog is hidden from screen readers, and a
// live region changed in the same moment the page comes back is not always read out (as announce() in ui/dom.js).
const NOTE_AFTER_DIALOG_MS = 60;

/**
 * getList() -> { branchId (0 = all branches), date, rows, pending, failed }: rows = the whole day's list as { kind, status }
 * (whatever the filters on screen show); pending / failed = typed changes still being saved / not saved. onEnded(date) opens
 * the list after the ended day (the next day's, or today's when that has gone by too) once the copy is saved.
 */
export function dayEndControls({ getList, onEnded }) {
  const d = state.data;
  const openedOn = localISO(); // the day this page was opened: the dialog warns when midnight has passed since (pastMidnight)
  let shown = { key: '', closing: null }; // the note for which list, and its saved copy
  let justEnded = null; // { key, from }: the list opened by "End the day", which says so
  let noteSig = null; // what the note says now (see showNote)
  let holdNote = false; // the dialog is open: the note is written once it has closed
  let seq = 0;
  const mayEnd = () => can('sheet.end_day') && typeof d.endDay === 'function';
  const endable = (date) => !!date && date >= FIRST_DAY && date <= localISO();
  const keyOf = (l) => `${l.branchId}|${l.date}`;

  const button = h('button', { type: 'button', class: 'btn', hidden: true, 'aria-haspopup': 'dialog', onclick: () => confirmEnd() }, 'End the day');
  // "All branches" has no button (each branch's day is ended on its own list); this says so where the button would be.
  const hint = h('span', { class: 'muted', hidden: true }, 'Choose one branch to end its day.');
  const historyLink = h('a', { class: 'btn', href: dayHistoryHref() }, 'History of Aaj ki List');
  // A polite live region that is always on the page and empty when there is nothing to say: a region that appears with its
  // text already in it is not read out. The box inside it is the note people see.
  const note = h('div', { class: 'day-end-live', role: 'status', 'aria-live': 'polite' });
  const box = h('div', { class: 'alert alert-info day-end-note' });

  function showNote(key, closing) {
    shown = { key, closing };
    if (holdNote) return;
    const [branchId, date] = key.split('|');
    const after = !closing && justEnded?.key === key ? justEnded.from : null;
    // Written only when the message changes: the note is a live region, so a screen reader would say it again each time it is
    // replaced, and refresh() runs on every reload of the list (every 20 seconds, and on every change anyone makes).
    const sig = [key, closing?.closed_at, closing?.closed_by_name, after, mayEnd()].join('|');
    if (sig === noteSig) return;
    noteSig = sig;
    if (closing) {
      mount(box,
        `This day was ended at ${endedAt(closing, date)}${closing.closed_by_name ? ` by ${closing.closed_by_name}` : ''}.${mayEnd() ? ' Ending it again updates the copy.' : ''} `,
        h('a', { href: dayHistoryHref(branchId, date) }, 'See the saved copy'));
    } else if (after) {
      // (Back: for a patient who is still being seen, or arrives late, after the day was ended)
      mount(box, `${dayLabel(after)} was ended and its list saved in History. This is the list for ${dayLabel(date)}. `,
        h('a', { href: dayHistoryHref(branchId, after) }, 'See the saved copy'), ' · ',
        h('a', { href: `#/staff/sheet?branch=${branchId}&date=${after}` }, `Back to ${dayLabel(after)}`));
    }
    mount(note, closing || after ? box : null);
  }

  // The button is for one branch and today or an earlier day (from FIRST_DAY); the note says whether this day was ended (and by whom).
  async function refresh() {
    const list = getList();
    const key = keyOf(list);
    const open = endable(list.date) && mayEnd();
    button.hidden = !list.branchId || !open;
    hint.hidden = !!list.branchId || !open;
    historyLink.href = dayHistoryHref(list.branchId || null);
    if (justEnded && justEnded.key !== key) justEnded = null; // "a new day has started" only on the day that was opened for it
    if (shown.key !== key) showNote(key, null); // another list: no note of the previous one while this one loads
    if (!list.branchId || typeof d.dayClosing !== 'function') return;
    const mine = ++seq;
    try {
      const closing = await d.dayClosing({ branchId: list.branchId, date: list.date });
      if (mine === seq && keyOf(getList()) === key) showNote(key, closing || null);
    } catch { /* the note is extra: the list works without it */ }
  }

  function confirmEnd() {
    const list = getList();
    if (!list.branchId || !endable(list.date)) return;
    // The copy is made from what the database has: typed changes still on their way (or kept on this device offline) would be missing.
    if (list.pending) { toast('Some typed changes are still being saved. End the day once the list says "All changes saved".', 'error', 8000); return; }
    const c = countDayList(list.rows);
    const busy = c.waiting + c.in_treatment;
    const today = localISO();
    const late = pastMidnight(list.date, openedOn, today); // the page was opened before midnight and it is past it now
    const before = shown.key === keyOf(list) ? shown.closing : null;
    holdNote = true;
    const { dialog } = modal(`End the day for ${branchName(list.branchId)}, ${dayLabel(list.date)}?`, h('div', {},
      late ? h('p', { class: 'alert alert-warning' }, late) : null,
      // The counts add up, and "patients" means what it means in the list's header (its patients, then its checkups).
      h('p', {}, c.total ? `${endDayCounts(c)} A copy of the list is saved in History.` : 'There is nobody on this list. End the day anyway?'),
      busy ? h('p', {}, `The ${busy === 1 ? 'patient' : `${busy} patients`} still waiting or in treatment stay as they are: ending the day changes nobody's status.`) : null,
      before ? h('p', {}, `This day was already ended at ${endedAt(before, list.date)}. The saved copy is replaced by the list as it is now.`) : null,
      list.failed ? h('p', { class: 'alert alert-stop' }, `${list.failed} typed change${list.failed === 1 ? ' is' : 's are'} not saved (see the top of the list), so ${list.failed === 1 ? 'it is' : 'they are'} not in the copy.`) : null,
      h('p', { class: 'muted' }, `After that the list for ${dayLabel(listAfterEnding(list.date, today))} opens.`)), [
      { label: 'Cancel' },
      // A refusal or a lost answer is shown and the dialog stays open (ending the day again is safe: it only replaces the copy).
      { label: 'End the day', primary: true, onClick: async () => {
        await d.endDay({ branchId: list.branchId, date: list.date });
        toast('Day ended. Copy saved in History.', 'ok', 6000);
        const next = listAfterEnding(list.date, localISO()); // (again: midnight may have passed while the dialog was open)
        justEnded = { key: keyOf({ branchId: list.branchId, date: next }), from: list.date };
        onEnded(next); // not awaited: the dialog closes now, the next list loads behind it
      } },
    // Starts on Cancel, so a second Enter (or a held key) does not end the day; the counts are read out as the description.
    // Once it has closed, the note says what it says by then (the next list's "... was ended", or nothing new after Cancel).
    ], { destructive: true, onClose: () => setTimeout(() => { holdNote = false; showNote(shown.key, shown.closing); }, NOTE_AFTER_DIALOG_MS) });
    // And a second tap of a quick double tap finds the dialog's "End the day" switched off (see ARM_MS).
    const endBtn = dialog.querySelector('.modal-actions .btn-primary');
    endBtn.disabled = true;
    setTimeout(() => { endBtn.disabled = false; }, ARM_MS);
  }

  return { button, hint, historyLink, note, refresh };
}
