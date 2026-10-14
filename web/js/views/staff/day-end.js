// "End the day" on the Aaj ki List (owner, 12 Oct 2026): a button that saves a copy of the day's list in the History of
// Aaj ki List, then opens the next day's list, so everyone sees that a new day has started; and a note on a day that was
// ended. Ending a day changes nothing on the list: every row can still be edited and the Google Sheet sync keeps working.
// sheet.js mounts the three pieces (button, History link, note) and calls refresh() whenever it loads a list.
import { h, mount, modal, toast, localISO, addDaysISO } from '../../ui/dom.js';
import { state, can, branchName } from '../../state.js';
import { countDayList, dayLabel, endedAt } from '../../lib/day-list.js';

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

/**
 * getList() -> { branchId (0 = all branches), date, rows, pending, failed }: rows = the whole day's list as { kind, status }
 * (whatever the filters on screen show); pending / failed = typed changes still being saved / not saved. onEnded(nextDate)
 * opens the next day's list once the copy is saved.
 */
export function dayEndControls({ getList, onEnded }) {
  const d = state.data;
  let shown = { key: '', closing: null }; // the note on screen: for which list, and its saved copy
  let justEnded = null; // { key, from }: the next day's list opened by "End the day", which says so
  let noteSig = null; // what the note says now (see showNote)
  let seq = 0;
  const mayEnd = () => can('sheet.end_day') && typeof d.endDay === 'function';
  const keyOf = (l) => `${l.branchId}|${l.date}`;

  const button = h('button', { type: 'button', class: 'btn', hidden: true, 'aria-haspopup': 'dialog', onclick: () => confirmEnd() }, 'End the day');
  const historyLink = h('a', { class: 'btn', href: dayHistoryHref() }, 'History of Aaj ki List');
  const note = h('div', { class: 'alert alert-info day-end-note', role: 'status', hidden: true });

  function showNote(key, closing) {
    shown = { key, closing };
    const [branchId, date] = key.split('|');
    const after = !closing && justEnded?.key === key ? justEnded.from : null;
    // Written only when the message changes: the note is a live region, so a screen reader would say it again each time it is
    // replaced, and refresh() runs on every reload of the list (every 20 seconds, and on every change anyone makes).
    const sig = [key, closing?.closed_at, closing?.closed_by_name, after, mayEnd()].join('|');
    if (sig === noteSig) return;
    noteSig = sig;
    note.hidden = !closing && !after;
    if (closing) {
      mount(note,
        `This day was ended at ${endedAt(closing, date)}${closing.closed_by_name ? ` by ${closing.closed_by_name}` : ''}.${mayEnd() ? ' Ending it again updates the copy.' : ''} `,
        h('a', { href: dayHistoryHref(branchId, date) }, 'See the saved copy'));
    } else if (after) {
      // (Back: for a patient who is still being seen, or arrives late, after the day was ended)
      mount(note, `${dayLabel(after)} was ended and its list saved in History. This is the list for ${dayLabel(date)}. `,
        h('a', { href: dayHistoryHref(branchId, after) }, 'See the saved copy'), ' · ',
        h('a', { href: `#/staff/sheet?branch=${branchId}&date=${after}` }, `Back to ${dayLabel(after)}`));
    } else mount(note);
  }

  // The button is for one branch and today or an earlier day; the note says whether this day was ended (and by whom).
  async function refresh() {
    const list = getList();
    const key = keyOf(list);
    button.hidden = !list.branchId || !list.date || list.date > localISO() || !mayEnd();
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
    if (!list.branchId || list.date > localISO()) return;
    // The copy is made from what the database has: typed changes still on their way (or kept on this device offline) would be missing.
    if (list.pending) { toast('Some typed changes are still being saved. End the day once the list says "All changes saved".', 'error', 8000); return; }
    const c = countDayList(list.rows);
    const busy = c.waiting + c.in_treatment;
    const next = addDaysISO(list.date, 1);
    const before = shown.key === keyOf(list) ? shown.closing : null;
    const { dialog } = modal(`End the day for ${branchName(list.branchId)}, ${dayLabel(list.date)}?`, h('div', {},
      h('p', {}, `${c.total} patient${c.total === 1 ? '' : 's'}${c.checkups ? ` (${c.checkups === c.total ? 'all' : c.checkups} of them checkup patients)` : ''}: `
        + `${c.completed} completed, ${busy} still waiting or in treatment. A copy of the list is saved in History.`),
      busy ? h('p', {}, `The ${busy === 1 ? 'patient' : `${busy} patients`} still waiting or in treatment stay as they are: ending the day changes nobody's status.`) : null,
      before ? h('p', {}, `This day was already ended at ${endedAt(before, list.date)}. The saved copy is replaced by the list as it is now.`) : null,
      list.failed ? h('p', { class: 'alert alert-stop' }, `${list.failed} typed change${list.failed === 1 ? ' is' : 's are'} not saved (see the top of the list), so ${list.failed === 1 ? 'it is' : 'they are'} not in the copy.`) : null,
      h('p', { class: 'muted' }, `After that the list for ${dayLabel(next)} opens.`)), [
      { label: 'Cancel' },
      // A refusal or a lost answer is shown and the dialog stays open (ending the day again is safe: it only replaces the copy).
      { label: 'End the day', primary: true, onClick: async () => {
        await d.endDay({ branchId: list.branchId, date: list.date });
        toast('Day ended. Copy saved in History.', 'ok', 6000);
        justEnded = { key: keyOf({ branchId: list.branchId, date: next }), from: list.date };
        onEnded(next); // not awaited: the dialog closes now, the next day's list loads behind it
      } },
    // Starts on Cancel, so a second Enter (or a held key) does not end the day; the counts are read out as the description.
    ], { destructive: true });
    // And a second tap of a quick double tap finds the dialog's "End the day" switched off (see ARM_MS).
    const endBtn = dialog.querySelector('.modal-actions .btn-primary');
    endBtn.disabled = true;
    setTimeout(() => { endBtn.disabled = false; }, ARM_MS);
  }

  return { button, historyLink, note, refresh };
}
