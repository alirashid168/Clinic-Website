// Aaj ki List: the daily sheet, laid out like the clinic's Google Sheet ("Aj ki List"): one line per patient, the
// sheet's columns in the sheet's order, its coloured chips, a header row that stays put and Mr#/name columns that stay
// at the left, so about 20 patients are seen at a glance on a laptop. Typed cells (treatment, details, notes and the
// checkup rows) save by themselves; if the internet drops, those typed changes wait on this device and are sent when it
// comes back. Status, group, doctor and new-patient changes need the connection, and say so when they fail.
import { h, mount, toast, friendlyError, isLostAnswer, rupees, modal, select, field, timeOf, downloadCSV, $$, announce, localISO, srOnly, busy, capFirst } from '../../ui/dom.js';
import { state, can, myBranches, defaultBranchId, branchName } from '../../state.js';
import { AutosaveQueue, PermanentSaveError } from '../../lib/autosave.js';
import { protocolFor, canTreat, canCheck, guidance as protocolGuidance } from '../../lib/protocol.js';
import { STATUS_LABELS, patientSearch, newPatientModal, flagForAliModal, photoUploadModal, guidancePanel, commitOnFinish } from './common.js';
import { newInvoiceModal, paymentModal } from './invoice.js';
import { dayListCheckups, hasFormAnswers, formComplete, yesNo, PRICING_LABELS } from '../../lib/checkups.js';
import { personTones, personTone } from '../../lib/tones.js';
import { splitPeople, matchClinician } from '../../lib/legacy.js';
import { checkupFormModal, quickCheckupModal, checkupAnswersModal, registerCheckupModal, removeCheckupModal, canRemoveCheckup, canRegisterCheckup, followUpSelect, registeredMr } from './checkup-actions.js';
import { dayEndControls, laterDayHint, bookedFor } from './day-end.js';
import { FIRST_DAY } from '../../lib/day-list.js';

const QUEUE_KEY = 'aaj-ki-list-pending-v1';
const FIELD_NAMES = {
  treatment_label: 'Treatment', details_text: 'Treatment details', notes: 'Notes',
  // checkup patients (the rows without an Mr#)
  patient_name: 'Name', phone: 'Phone', checkup_for: 'Treatment', doctors: "Doctor's name", details: 'Treatment details', token: 'Token',
};
// What a checkup patient's day status can be (the database has no "Scheduled" for them), plus "Not set" for a row that has none.
const DAY_STATUSES = ['waiting', 'in_treatment', 'completed', 'cancelled', 'no_show'];

// Whether a request's answer was lost (the connection dropped, it timed out, or a gateway gave up) is decided by
// isLostAnswer() in ui/dom.js, the one test shared with invoice.js and friendlyError(); there is no list to keep in
// step here. A database "statement timeout" is not lost: the server refused a slow query, and retrying never helps.
//
// Wording: only a browser that reports itself offline is "no internet connection". A gateway, a 503 or 429, or a
// time-out while the connection works is the server not answering, and the write may still have been committed.
const noAnswer = (e) => isLostAnswer(e) || !navigator.onLine;
// Status, doctor and new-patient changes are not queued offline, so they say plainly that they were not sent.
const notSaved = (e, still) => {
  if (!navigator.onLine) return `Not saved: no internet connection. ${still} Try again once you are back online.`;
  if (isLostAnswer(e)) return 'The server did not answer, so this may not have been saved. Reload the page to check, then try again.';
  return friendlyError(e);
};

// Checkup rows among themselves (the day's download): by branch (all-branches view), then by the token written on the
// sheet when it is a number, then by when they were added.
const tokenNo = (c) => (/^\d+$/.test(String(c.token ?? '').trim()) ? Number(c.token) : Infinity);
const byNumber = (x, y) => (x === y ? 0 : x < y ? -1 : 1);
const byToken = (a, b) => (a.branch_id ?? 0) - (b.branch_id ?? 0)
  || byNumber(tokenNo(a), tokenNo(b))
  || String(a.created_at || '').localeCompare(String(b.created_at || ''));

// The order of the list, as the clinic's Google Sheet is sorted (owner, 11 Oct 2026): Waiting at the top, then In treatment,
// then Scheduled and checkups with no status yet, then Completed, then Cancelled and No show. Checkup patients take part by
// their own day status. Inside one status the patients come first by token (no token last), then the checkup patients by
// theirs (tokens are numbered per kind of treatment, so the two series are not mixed), then by when they were added.
// (All branches view: by branch first.) Each item is { row, checkup, rank, token }: draw() works out the rank and token.
const STATUS_RANK = { waiting: 0, in_treatment: 1, scheduled: 2, '': 3, completed: 4, cancelled: 5, no_show: 6 };
const rankOf = (item) => STATUS_RANK[(item.checkup ? item.row.day_status : item.row.status) || ''] ?? 3;
const tokenOf = (item) => (item.checkup ? tokenNo(item.row) : item.row.token_no ?? Infinity);
const listOrder = (a, b) => (a.row.branch_id ?? 0) - (b.row.branch_id ?? 0)
  || a.rank - b.rank
  || Number(a.checkup) - Number(b.checkup)
  || byNumber(a.token, b.token)
  || String(a.row.created_at || '').localeCompare(String(b.row.created_at || ''));
// The "#" column numbers the rows 1..n down the list as shown, like the sheet's row numbers (owner, 11 Oct 2026: "a serial
// number by the left side, so we can see how many patients we have actually done"); the Completed count above the list
// says how many are done. true: the Completed rows count 1..N on their own instead, so their last number is the patients
// done, and the other rows keep one running number (an open question to the owner).
const COMPLETED_OWN_COUNT = false;
// No flags on the list (owner, 11 Oct 2026): See Dr. Ali, medical history, dues and the visit note are on the patient's
// profile (patients.js), and in the row's dialog; dues are in the P.P column. true puts the "Med" marker back beside the
// name of a patient with a medical history, for the doctors at the chair.
const SHOW_MEDICAL_ON_LIST = false;
// A row of the list as a key, the same for every copy of it the list draws (visits and checkups are told apart).
const keyOf = (item) => `${item.checkup ? 'c' : 'v'}:${item.row.id}`;
// Whether a row is no longer where it was sorted (was: its { rank, token } when the list was last drawn).
const movedFrom = (item, was) => rankOf(item) !== was.rank || tokenOf(item) !== was.token;

// ---------------------------------------------------------------- the sheet's chip colours
// The chip colours of the clinic's Google Sheet (app.css .gs-*). A chip always carries its text too, so colour is never the only cue.
const STATUS_TONE = { completed: 'yellow', in_treatment: 'green', scheduled: 'blue', waiting: 'orange', cancelled: 'grey', no_show: 'red' };
const GROUP_TONE = { 1: 'blue', 2: 'green', 3: 'purple', 4: 'darkred' };
export const statusTone = (status) => STATUS_TONE[status] || 'grey';
export const groupTone = (group) => GROUP_TONE[group] || 'grey';
// One colour per doctor, as the clinic's sheet has them: worked out once for the clinic's whole list of clinicians
// (lib/tones.js), so the people who can be on one list get different colours, and each keeps theirs on every row and day.
let tones = { of: null, map: null };
export function doctorTone(id, name) {
  if (tones.of !== state.ref.clinicians) tones = { of: state.ref.clinicians, map: personTones(state.ref.clinicians) };
  return personTone(tones.map, id, name);
}
// The names typed in a checkup row's Doctor Name cell as the chips of the other rows (owner, 11 Oct 2026: a colour per
// doctor): split as the sheet's cells are, each in the colour of the clinician it names (by name or other spelling, as
// Clinic setup has them), or grey when it names nobody on the clinic's list. "Dr." is left out, as on the other chips.
let named = { of: null, list: [] };
function writtenPeople(text) {
  if (named.of !== state.ref.clinicians) named = { of: state.ref.clinicians, list: state.ref.clinicians.map((c) => ({ id: c.id, displayName: c.display_name, aliases: c.aliases || [] })) };
  return splitPeople(String(text || '')).map((name) => {
    const c = matchClinician(name, named.list);
    return h('span', { class: ['person', `gs-${c ? doctorTone(c.id, c.displayName) : 'grey'}`] },
      h('span', { class: 'person-name' }, name.replace(/^dr\b\.?\s*(?=\S)/i, '')));
  });
}
// P.P (pending dues) written the sheet's way: 0, 500, 11.5k, 20k.
export function shortRupees(n) {
  const v = Math.round(Number(n) || 0);
  return Math.abs(v) < 1000 ? String(v) : `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
}
// A braces month that needs photos: the protocol says so, or the visit was marked.
const photoMonth = (row) => !!row.photo_required || (Number.isInteger(row.braces_month) && row.braces_month > 0 && protocolFor(row.braces_month).photoRequired);
const chipSelect = (tone) => `chip chip-select gs-${tone}`;
// The text of a plain cell (Mr#, contact, branch), cut with an ellipsis by the span: the cells themselves do not clip, as
// clipping every cell of a 120-row list made each key typed in a cell several times slower to draw.
const cellText = (...content) => h('span', { class: 'cell-text' }, content);
// A typed cell's field sits in a box that is walled off from the rest of the table while it is typed in (app.css
// .cell-box), so a key lays out that box alone: laying out the whole 120-row table on every key made typing lag.
const typedCell = (input) => h('div', { class: 'cell-box' }, input);
// What a patient's medical history says, on one line (the row's dialog, and the flag beside the name if SHOW_MEDICAL_ON_LIST).
function medicalText(p) {
  const mh = p?.medical_history || {};
  return [...(mh.conditions || []), mh.allergies ? `Allergies: ${mh.allergies}` : null, mh.medications ? `Medicines: ${mh.medications}` : null, mh.notes].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- offline queue
// One queue per signed-in staff member: autosave.js stores their typed edits under a key that
// includes their user id, so they are never sent under someone else's account on a shared
// computer. Logout stops the queue (autosave.clearForUser); the next render starts a fresh one.
let queue = null;
let queueUser = null;
let saveUI = null; // the save-status display of the Aaj ki List on screen, if any
let hadProblem = false;
// Typed changes the server has confirmed: a reload whose answer comes back after one of them may have read the list before
// it was saved, so its answer is not used (renderSheet's load).
let typedSaved = 0;

const currentUser = () => state.session?.staff?.id || null;
const failedEdits = () => (Array.isArray(queue?.failed) ? queue.failed : []);
// Why a typed change is on the "not saved" list (autosave keeps only the message). A change whose answer was lost is
// kept on this device either way; the list has Try again and Discard.
const errorText = (error) => {
  const msg = typeof error === 'string' ? error : error?.message;
  if (!msg) return '';
  if (isLostAnswer({ message: msg })) return `${navigator.onLine ? 'The server did not answer.' : 'No internet connection.'} Your change is kept on this device.`;
  return friendlyError({ message: msg });
};

function describeEdit(edit) {
  if (!edit) return 'a change';
  const name = saveUI?.nameOf(edit.rowId) || 'a patient';
  const what = Object.entries(edit.changes || {}).map(([f, v]) => `${FIELD_NAMES[f] || f} "${String(v ?? '').slice(0, 60)}"`).join(', ');
  return `${name}, ${what}`;
}

function showSaveState(s, pending) {
  if (s === 'error' || s === 'offline') hadProblem = true;
  else if (s === 'saved' && hadProblem) { hadProblem = false; announce('All changes on the Aaj ki List are saved.'); }
  saveUI?.update(s, pending, failedEdits());
}

function getQueue() {
  const uid = currentUser();
  if (queue && queueUser === uid && !queue.disposed) return queue;
  // Signed out (the queue was stopped) or someone else signed in: start this person's own queue.
  // The previous person's unsent edits stay on the device under their own key.
  if (queue && !queue.disposed) queue.dispose();
  let store;
  try { store = window.localStorage; store.getItem('x'); } catch { store = { getItem: () => null, setItem: () => {}, removeItem: () => {} }; }
  const q = new AutosaveQueue({
    store,
    storageKey: QUEUE_KEY,
    userId: uid,
    send: async (edit) => {
      // Signed out, or someone else signed in: stop, keep the edit for its owner and send nothing.
      if (currentUser() !== uid) { q.dispose(); throw new Error('Signed out: the change is kept on this device.'); }
      try {
        if (edit.table === 'checkups') {
          // null = the checkup was removed meanwhile (or is not visible any more): nothing is left to save, the list is refreshed.
          if ((await state.data.updateCheckup(edit.rowId, edit.changes)) === null) document.dispatchEvent(new CustomEvent('sheet-reload'));
        } else await state.data.updateVisit(edit.rowId, edit.changes);
        typedSaved++;
      } catch (e) {
        // Lost connection or no answer: the queue retries quietly (with backoff, and gives up after a few tries).
        // Anything else is the server's "no".
        if (isLostAnswer(e)) throw e;
        document.dispatchEvent(new CustomEvent('sheet-reload'));
        throw new PermanentSaveError(e?.message || String(e));
      }
    },
    onState: (s, pending) => { if (queue === q) showSaveState(s, pending); },
    // Say which patient and cell could not be saved; the list at the top has Try again and Discard.
    onFailed: (detail) => {
      // Not after logout (a send still in flight must not toast a patient's note on the home page). q.disposed is
      // no use here: it is also true for the deliberate "signed out" note for an edit typed on a stale list.
      if (queue !== q || currentUser() !== uid) return;
      toast(`Not saved: ${describeEdit(detail.edit)}. ${errorText(detail.error)} Use "Try again" at the top of the Aaj ki List.`, 'error', 12000);
    },
  });
  queue = q;
  queueUser = uid;
  hadProblem = false;
  return q;
}

window.addEventListener('online', () => { if (queue && queueUser === currentUser()) queue.setOnline(true); });
window.addEventListener('offline', () => queue?.setOnline(false));
window.addEventListener('beforeunload', (e) => { if (queue?.pendingCount && !queue.disposed && queueUser === currentUser()) { e.preventDefault(); e.returnValue = ''; } });

let stopPrevious = null; // live updates of the previous Aaj ki List render

export async function renderSheet(root, params, signal) {
  stopPrevious?.();
  if (signal?.aborted) return;
  const d = state.data;
  const q = getQueue();
  const life = new AbortController();
  const branches = myBranches();
  let branchId = Number(params.get('branch')) || defaultBranchId();
  let date = params.get('date') || localISO();
  // "?demo=busy" (the demo only): today's list at this branch gets 120 made-up patients, to try a busy day. The live data
  // layer has no such thing, so on the real site it does nothing.
  const busyDemo = params.get('demo') === 'busy' && d.mode === 'demo' && typeof d.fillBusyDay === 'function';
  let rows = [];
  let checkups = []; // the day's checkup patients (no Mr#); see lib/checkups.js dayListCheckups for which of them are shown
  let checkupsMissing = false; // the database update for checkups has not been run yet: no checkup rows, no "+ Add checkup patient"
  let checkupsWarn = ''; // why the checkups could not be loaded (the visits still show)
  let checkupsKey = ''; // branch and day the `checkups` above belong to
  let filter = ''; // a status (the Filters panel, or a status count above the list)
  let checkupsOnly = false; // the "Checkups" count was clicked

  const tableBody = h('tbody', {});
  // The whole table (header row and rows): see "When the rows move", below. (Filled where the page is put together.)
  const sheetTable = h('table', { class: 'sheet' });
  // Typed text that is not saved yet: Treatment, and a checkup patient's name, token and phone, save when the cell is left
  // (the other typed cells save as they are typed). It is only ever in the cell with the cursor, so the list is not drawn
  // meanwhile (waitMs), and a row drawn again after a save keeps that cell as it is (replaceRow). A cell left with the text
  // it had fires no change, so unsavedCell can stay set after it is left.
  const SAVED_ON_LEAVE = new Set(['treatment_label', 'patient_name', 'token', 'phone']);
  let unsavedCell = null;
  // Every change made to the list on this screen (a patient added or removed, a cell typed, a status, group or doctor
  // saved) counts up listVersion: a reload asked for before it does not have it, so its answer is not used (see load).
  let listVersion = 0;
  // Treatment Details is often longer than its cell: the whole text is in the cell's tooltip (title), kept up to date here.
  const LONG_TEXT = new Set(['details_text', 'details']);
  tableBody.addEventListener('input', (e) => {
    if (SAVED_ON_LEAVE.has(e.target.dataset.field)) unsavedCell = e.target;
    if (LONG_TEXT.has(e.target.dataset.field)) e.target.title = e.target.value;
  });
  tableBody.addEventListener('change', (e) => { if (e.target === unsavedCell) unsavedCell = null; });

  // ---- When the rows move (owner, 11 Oct 2026: a row must never jump away under the cursor).
  // Only draw() sorts the list; a save in one row draws that row alone, in its place, with its number (redrawRow). draw()
  // never runs by itself while the person is working in the table: a key, a press (mouse, pen or finger) or the mouse
  // wheel in the list (its scroll bar too) was less than QUIET_MS ago, the cursor (focus) is in it, or a dialog is open. A
  // mouse that only rests on the rows is not working in it. The cursor left resting in the table holds the list for
  // IDLE_MS after the last key or press (so the list is sorted when the person has stopped, as the owner wants it), unless
  // it is in typed text that is not saved yet or a status or group chosen and not saved yet: those hold it until they are
  // saved. A reload meanwhile (a live update, the 20-second check, a dialog's change) keeps what it brought: a row
  // changed on another computer is drawn again where it is (not the row with the cursor; that one is drawn again at the
  // first reload after the cursor has left it, drawnData), a new row and a row whose status changed wait (a short note
  // says how many rows wait, newRowsNote), and the whole list is drawn and sorted as soon as the person is done: whenFree
  // looks again when the cursor leaves the table and when the quiet time is over. A redraw never scrolls the list or the
  // page, and the cursor stays on the same control (draw).
  // (The person's own changes to what the list shows, a filter, another day or branch, or a patient they remove, draw it at
  // once: they are at the toolbar or a dialog then. A patient they add is drawn at once from the add line, and waits like a
  // new row from elsewhere if they have gone back into the table meanwhile: drawAdded.)
  // Nothing above the list changes its height by itself on a laptop either: the Undo bar, a warning, the changes not saved
  // and no connection come on the line of the counts (app.css .sheet-slot), so they never move the rows.
  const QUIET_MS = 5000;
  const IDLE_MS = 15000;
  let lastTouch = 0; // the last key, press or wheel in the list (the listeners are on .sheet-wrap, where the page is put together)
  const touched = () => { lastTouch = Date.now(); };
  let drawHeld = false; // the list waits to be drawn and sorted again
  let reloadHeld = false; // a reload in the background came back older than a change made here: asked again when the person is done
  let freeTimer = null;
  // The status and group chips of the rows on screen (commitOnFinish of each): a choice made with the arrow keys is not
  // saved until Enter or leaving the chip.
  const choices = new WeakMap();
  const choosing = (el) => !!choices.get(el)?.pending();
  // How long until the person is done with the table (0: done now).
  function waitMs() {
    if (document.querySelector('.modal')) return 1000;
    const quiet = Date.now() - lastTouch;
    const el = document.activeElement;
    if (!sheetTable.contains(el)) return Math.max(0, QUIET_MS - quiet);
    if (el === unsavedCell || choosing(el)) return 1000;
    return Math.max(0, IDLE_MS - quiet);
  }
  function whenFree() {
    clearTimeout(freeTimer);
    if (life.signal.aborted || !(drawHeld || reloadHeld)) return;
    const wait = waitMs();
    if (wait) { freeTimer = setTimeout(whenFree, wait); return; }
    if (reloadHeld) { reloadHeld = false; reloadQuietly(); return; } // (its answer draws the list)
    draw();
  }
  const requestDraw = () => { drawHeld = true; whenFree(); };
  // A patient the person has just added (the add line, a dialog such as "Put Mr# N on this list"): drawn at once while the
  // cursor is not in the table, so it can go to the new row (goToRow); if they have gone back into the table meanwhile (an
  // add can take a few seconds on a slow connection), the row waits like a new row from another computer, and the note
  // counts it.
  function drawAdded() {
    if (sheetTable.contains(document.activeElement)) { requestDraw(); noteWaiting(); } else draw();
  }

  // Where each row was sorted when the list was last drawn (keyOf -> { rank, token }, see draw), the data each row on screen
  // was drawn from (keyOf -> JSON: draw, replaceRow; a reload draws again the rows whose data is not that any more) and
  // their order (drawnOrder), which day and branch the rows on screen are for (drawnKey; rowsKey: the ones in `rows`), and
  // the row the add line last put the cursor in (keyOf; onKey).
  let placed = new Map();
  let drawnData = new Map();
  let drawnOrder = '';
  let drawnKey = '';
  let rowsKey = '';
  let fromAddLine = null;
  const rowKey = (el) => {
    const tr = el && tableBody.contains(el) ? el.closest('tr[data-id]') : null;
    return tr ? `${tr.dataset.kind === 'checkup' ? 'c' : 'v'}:${tr.dataset.id}` : null;
  };
  // A row drawn again after a save whose status (or the token that came with it) changed, or that no longer matches the
  // filters, goes to its new place at the next draw, once the person is done.
  function settle(item) {
    const was = placed.get(keyOf(item));
    if (was && (movedFrom(item, was) || !(item.checkup ? checkupMatches(item.row) : matches(item.row)))) requestDraw();
  }
  // The cursor has left a row (looked at a moment later, once it is in its new place): a row left for another row is no
  // longer the add line's (onKey), and the cursor leaving the table lets a waiting draw run after the quiet time.
  sheetTable.addEventListener('focusout', (e) => {
    const key = rowKey(e.target);
    setTimeout(() => {
      const now = rowKey(document.activeElement);
      if (key && now && now !== key && key === fromAddLine) fromAddLine = null;
      whenFree();
    });
  });

  // ---- save status, the list of changes that could not be saved, and undo for removals.
  const saveStatus = h('span', { class: 'save-status save-state', tabindex: '-1', dataset: { state: 'saved' } }, 'All changes saved');
  // The changes that could not be saved: one line above the list (how many, Try again, Show), and the list of them, with
  // Try again and Discard for each, once "Show" is pressed. The line never covers the list. On a laptop it is on the line of
  // the counts, in the save status's place (it says what the save status would), and the list opens over the rows, like the
  // Filters panel (a click elsewhere or Escape closes it), so neither moves the rows; on a phone both are in the page's
  // flow, under the save status.
  const failList = h('ul', { class: 'sheet-fails-list', id: 'sheet-save-failures-list', hidden: true });
  const failSummary = h('span', { class: 'sheet-fails-summary' });
  const retryAll = h('button', { type: 'button', class: 'btn btn-small', onclick: () => { q.retryFailed(); announce('Trying the unsaved changes again.'); } }, 'Try all again');
  const retryAllHost = h('span', { class: 'sheet-fails-retry' });
  const failToggle = h('button', { type: 'button', class: 'btn btn-small', 'aria-expanded': 'false', 'aria-controls': failList.id, onclick: () => showFails(failList.hidden) });
  const failBox = h('div', { class: 'alert alert-stop sheet-fails', id: 'sheet-save-failures', hidden: true },
    h('div', { class: 'sheet-fails-line' }, failSummary, retryAllHost, failToggle), failList);
  function showFails(open) {
    failList.hidden = !open;
    failToggle.setAttribute('aria-expanded', String(open));
    failToggle.textContent = open ? 'Hide' : 'Show';
    failToggle.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} the changes that are not saved`);
  }
  showFails(false);
  failBox.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !failList.hidden) { e.preventDefault(); e.stopPropagation(); showFails(false); failToggle.focus(); } });
  // It closes when the person goes on elsewhere: a click outside it, or Tab out of it (it would cover the control Tab goes
  // to), but not for its Discard dialog. (Only where the list opens over the rows: on a phone it is in the page's flow, and
  // closing it would move what was tapped.)
  const goneFromFails = (el) => !failList.hidden && getComputedStyle(failList).position === 'absolute' && !failBox.contains(el) && !el.closest?.('.modal-backdrop');
  document.addEventListener('pointerdown', (e) => { if (goneFromFails(e.target)) showFails(false); }, { signal: life.signal });
  failBox.addEventListener('focusout', (e) => { if (e.relatedTarget && goneFromFails(e.relatedTarget)) showFails(false); });
  const discard = (f) => modal('Discard this change?', h('p', {}, `${describeEdit(f.edit)} will not be saved. This cannot be undone.`), [
    { label: 'Keep it' },
    { label: 'Discard', danger: true, onClick: () => { q.discardFailed(f.key); announce('Change discarded.'); } },
  ], { destructive: true });
  function markInvalid() {
    const bad = new Set(failedEdits().flatMap((f) => Object.keys(f.edit?.changes || {}).map((k) => `${f.edit.rowId}|${k}`)));
    for (const el of tableBody.querySelectorAll('[data-field]')) {
      if (bad.has(`${el.closest('tr').dataset.id}|${el.dataset.field}`)) { el.setAttribute('aria-invalid', 'true'); el.setAttribute('aria-describedby', failBox.id); }
      else if (el.hasAttribute('aria-invalid')) { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); }
    }
  }
  const ui = {
    nameOf: (id) => rows.find((r) => String(r.id) === String(id))?.patient.full_name || checkups.find((c) => String(c.id) === String(id))?.patient_name,
    update(s, pending, failed) {
      saveStatus.dataset.state = s;
      saveStatus.classList.toggle('is-error', s === 'error');
      saveStatus.textContent = s === 'saved' ? 'All changes saved' : s === 'saving' ? `Saving ${pending || ''}…`
        : s === 'offline' ? `Offline: ${pending} typed change${pending === 1 ? '' : 's'} kept on this device`
          : `${failed.length || 'Some'} change${failed.length === 1 ? ' is' : 's are'} not saved`;
      const hadFocus = failBox.contains(document.activeElement);
      failBox.hidden = s !== 'error';
      if (failBox.hidden) showFails(false);
      failSummary.textContent = failed.length === 1 ? `Not saved yet: ${describeEdit(failed[0].edit)}.` : `${failed.length || 'Some'} changes are not saved yet.`;
      failSummary.title = failSummary.textContent;
      retryAll.textContent = failed.length > 1 ? 'Try all again' : 'Try again';
      mount(retryAllHost, failed.length ? retryAll : null);
      mount(failList, failed.map((f) => {
        const what = describeEdit(f.edit);
        return h('li', {}, what, f.error ? h('span', { class: 'muted' }, ` (${errorText(f.error)})`) : null, ' ',
          h('button', { type: 'button', class: 'btn btn-small', 'aria-label': `Try again: ${what}`, onclick: () => { q.retryFailed(f.key); announce('Trying this change again.'); } }, 'Try again'), ' ',
          h('button', { type: 'button', class: 'btn btn-small btn-danger', 'aria-label': `Discard: ${what}`, onclick: () => discard(f) }, 'Discard'));
      }));
      // The button that had focus was redrawn or hidden: keep focus in the box, or on the status.
      if (hadFocus && !failBox.contains(document.activeElement)) (failBox.hidden ? saveStatus : [...failBox.querySelectorAll('button')].find((b) => b.getClientRects().length) || saveStatus).focus();
      markInvalid();
      fit();
    },
  };
  saveUI = ui;

  const undoText = h('span', {});
  let undoFn = null;
  let undoTimer = null;
  // The Undo stays 10 seconds, and then until the person is done with the table (as for the list's redraws, "When the rows
  // move"): never pulled away from someone who is on it, still working in the list, or in a dialog (the people dialog has
  // its own Undo).
  const hideUndo = () => {
    clearTimeout(undoTimer);
    const wait = undoBox.contains(document.activeElement) ? 3000 : waitMs();
    if (wait) { undoTimer = setTimeout(hideUndo, wait); return; }
    undoFn = null; undoBox.hidden = true;
  };
  // The Undo of the bar above the list, and of the people dialog (the same undo).
  async function runUndo() {
    const fn = undoFn;
    undoFn = null;
    clearTimeout(undoTimer);
    if (fn) await fn(); // the bar (and focus on Undo) stays until the undo has run
    // (the save status, or the line of the changes not saved that stands in its place on a laptop: app.css)
    if (undoBox.contains(document.activeElement)) (saveStatus.getClientRects().length ? saveStatus : failToggle).focus();
    undoBox.hidden = true;
  }
  const undoBox = h('div', { class: 'alert alert-info', hidden: true }, undoText, ' ',
    h('button', { type: 'button', class: 'btn btn-small', onclick: runUndo }, 'Undo'));
  function offerUndo(message, fn, where = 'above the list') {
    clearTimeout(undoTimer);
    undoFn = fn;
    undoText.textContent = message;
    undoBox.hidden = false;
    announce(`${message} Undo is ${where}.`);
    undoTimer = setTimeout(hideUndo, 10000);
  }

  // "All branches" (people who work across branches): read-only overview, add patients from a single branch.
  const allBranches = branches.length > 1;
  if (params.get('branch') === 'all' && allBranches) branchId = 0;
  const branchSel = select([...(allBranches ? [{ value: 0, label: 'All branches' }] : []), ...branches.map((b) => ({ value: b.id, label: b.name }))], branchId, {
    'aria-label': 'Branch', onchange: (e) => { branchId = Number(e.target.value); setURL(); draw(); load(NEW_LIST); },
  });
  // (the date picker starts at FIRST_DAY, the first day that can be ended: day-end.js)
  const dateInput = h('input', { type: 'date', value: date, min: FIRST_DAY, 'aria-label': 'Date', onchange: (e) => { date = e.target.value; setURL(); load(NEW_LIST); } });
  const filterSel = select([{ value: '', label: 'All statuses' }, ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))], '', {
    'aria-label': 'Filter by status', onchange: (e) => { filter = e.target.value; checkupsOnly = false; draw(); },
  });
  // More filters (blueprint 11.1): by doctor, dues, braces month and a quick name search.
  let doctorFilter = ''; let duesOnly = false; let bracesOnly = false; let textFilter = '';
  const doctorSel = select([{ value: '', label: 'Any doctor' }, ...state.ref.clinicians.filter((c) => c.is_doctor).map((c) => ({ value: c.id, label: c.display_name }))], '', {
    'aria-label': 'Filter by doctor', onchange: (e) => { doctorFilter = e.target.value; draw(); },
  });
  let groupFilter = '';
  // The doctor groups of Clinic setup, by the names given there (the sheet's Group 4 is one once it is added there; the
  // protocol's three until they have loaded), and any other group a doctor is in. The Group cell of a row keeps the row's
  // own group too, and shows a group the Google Sheet names that Clinic setup does not have (rowEl).
  const groupIds = [...new Set([...(state.ref.groups?.length ? state.ref.groups.map((g) => Number(g.id)) : [1, 2, 3]),
    ...state.ref.clinicians.map((c) => c.doctor_group_id).filter(Boolean)])].sort((a, b) => a - b);
  const groupName = (g) => state.ref.groups?.find((x) => Number(x.id) === Number(g))?.name || `Group ${g}`;
  const groupSel = select([{ value: '', label: 'Any group' }, ...groupIds.map((g) => ({ value: String(g), label: groupName(g) }))], '', {
    'aria-label': 'Filter by doctor group', onchange: (e) => { groupFilter = e.target.value; draw(); },
  });
  const groupOf = (id) => state.ref.clinicians.find((c) => c.id === id)?.doctor_group_id;
  const duesBox = h('input', { type: 'checkbox', onchange: (e) => { duesOnly = e.target.checked; draw(); } });
  const bracesBox = h('input', { type: 'checkbox', onchange: (e) => { bracesOnly = e.target.checked; draw(); } });
  const findBox = h('input', { type: 'search', placeholder: 'Find on this list', 'aria-label': 'Find on this list', oninput: (e) => { textFilter = e.target.value.trim().toLowerCase(); draw(); } });
  const matches = (r) => !checkupsOnly && (!filter || r.status === filter)
    && (!doctorFilter || r.staff.some((x) => x.clinician_id === doctorFilter))
    && (!groupFilter || String(r.doctor_group_id || '') === groupFilter || r.staff.some((x) => String(groupOf(x.clinician_id) || '') === groupFilter))
    && (!duesOnly || r.dues > 0) && (!bracesOnly || !!r.braces_month)
    && (!textFilter || `${r.patient.full_name} ${r.patient.mr_number} ${r.patient.phone || ''} ${r.treatment_label || ''}`.toLowerCase().includes(textFilter));
  // The same filters for the checkup rows: the status filter means the day status, the doctor filter looks for the name in
  // the doctors written on the row, and the filters that need a patient file (group, dues, braces) hide them.
  const checkupMatches = (c) => {
    const doctor = doctorFilter ? (state.ref.clinicians.find((x) => x.id === doctorFilter)?.display_name || '').toLowerCase() : '';
    return (!filter || (c.day_status || '') === filter)
      && (!doctorFilter || (!!doctor && String(c.doctors || '').toLowerCase().includes(doctor)))
      && !groupFilter && !duesOnly && !bracesOnly
      && (!textFilter || `${c.patient_name} ${c.phone || ''} ${c.checkup_for || ''} checkup`.toLowerCase().includes(textFilter));
  };
  const shownCheckups = () => dayListCheckups(checkups, rows).filter(checkupMatches).sort(byToken);
  const setURL = () => history.replaceState(null, '', `#/staff/sheet?branch=${branchId || 'all'}&date=${date}${busyDemo ? '&demo=busy' : ''}`);

  // The less-used filters sit behind "Filters", a small panel over the list (the ▾ in a column heading opens it too); the
  // status counts above the list filter by status with one click.
  function clearFilters() {
    filter = ''; checkupsOnly = false; doctorFilter = ''; groupFilter = ''; duesOnly = false; bracesOnly = false;
    filterSel.value = ''; doctorSel.value = ''; groupSel.value = ''; duesBox.checked = false; bracesBox.checked = false;
    draw();
  }
  const filterPanel = h('div', { class: 'sheet-filter-panel', id: 'sheet-filter-panel', role: 'group', 'aria-label': 'Filters', hidden: true },
    h('label', { class: 'filter-field' }, h('span', { class: 'filter-label' }, 'Status'), filterSel),
    h('label', { class: 'filter-field' }, h('span', { class: 'filter-label' }, 'Doctor'), doctorSel),
    h('label', { class: 'filter-field' }, h('span', { class: 'filter-label' }, 'Group'), groupSel),
    h('label', { class: 'inline' }, duesBox, 'With dues'),
    h('label', { class: 'inline' }, bracesBox, 'Braces only'),
    h('button', { type: 'button', class: 'btn btn-small', onclick: clearFilters }, 'Clear filters'));
  const filterBtn = h('button', { type: 'button', class: 'btn btn-small', 'aria-expanded': 'false', 'aria-controls': filterPanel.id, onclick: () => showFilters(filterPanel.hidden) }, 'Filters');
  const filterWrap = h('div', { class: 'sheet-filter' }, filterBtn, filterPanel);
  function showFilters(open, focusOn = filterSel) {
    filterPanel.hidden = !open;
    filterBtn.setAttribute('aria-expanded', String(open));
    if (!open) return;
    // It opens under the button; on a phone the button can be near the right edge, so the panel moves left to stay on the screen.
    filterPanel.style.left = '';
    const over = filterPanel.getBoundingClientRect().right - (document.documentElement.clientWidth - 16);
    if (over > 0) filterPanel.style.left = `${-over}px`;
    focusOn.focus();
  }
  filterPanel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); showFilters(false); filterBtn.focus(); } });
  // It closes when the person goes on elsewhere: a click outside it, or Tab out of it (a click on a label inside keeps it open).
  const fromHeading = (el) => !!el?.closest?.('.th-filter');
  document.addEventListener('pointerdown', (e) => { if (!filterPanel.hidden && !filterWrap.contains(e.target) && !fromHeading(e.target)) showFilters(false); }, { signal: life.signal });
  filterWrap.addEventListener('focusout', (e) => { if (e.relatedTarget && !filterWrap.contains(e.relatedTarget) && !fromHeading(e.relatedTarget)) showFilters(false); });

  // The status counts above the list are quick filters: one click shows only those rows, a second click shows all again.
  const countsBox = h('div', { class: 'sheet-counts', role: 'group', 'aria-label': 'Show only' });
  function quickFilter(key) {
    const same = (checkupsOnly ? 'checkups' : filter) === key;
    checkupsOnly = !same && key === 'checkups';
    filter = same || key === 'checkups' ? '' : key;
    filterSel.value = filter;
    draw();
  }

  // The checkup patients of the day. They never hide the visits: a failure (other than "not switched on yet") shows a small
  // warning and the visits carry on. When it fails, the checkups already on screen stay if they are for this same list.
  async function loadCheckups() {
    const key = `${branchId}|${date}`;
    if (!d.listDayCheckups) { checkupsMissing = true; checkupsWarn = ''; return []; }
    try {
      const list = await d.listDayCheckups({ branchId: branchId || null, date });
      checkupsMissing = !!list.missing;
      checkupsWarn = '';
      checkupsKey = key;
      return list;
    } catch (e) {
      checkupsWarn = friendlyError(e);
      return key === checkupsKey ? checkups : [];
    }
  }

  // How the list is asked for (load): NEW_LIST for another day or branch, and the first time, drawn at once; { quiet: true }
  // for a reload in the background (reloadQuietly); anything else (load is also the onDone of dialogs, which pass it
  // whatever they saved) after a change the person made in a dialog. Unless it is a new list, the answer waits to be drawn
  // while the person is working in the table ("When the rows move", at the top). An answer for another day or branch than
  // the rows on screen (drawnKey) is a new list whatever asked for it: a reload in the background asked while another day
  // was on its way takes the place of that load (below), and its answer must not leave the old day's rows on screen.
  // An answer is the list as it was when it was asked for. Only the last one asked for is used (the day or branch may have
  // changed meanwhile), and not one asked for before a change made on this screen (listVersion) or that comes back after a
  // typed change was saved (typedSaved: it may have read the list before that save reached it): it would take that change
  // off the screen again (a patient just added by Mr#, with the cursor in their row; a cell typed and saved), so the list is
  // asked for again (a reload in the background: once the person is done). Typed changes still on their way to the server
  // are put on the rows that come back.
  const NEW_LIST = { newList: true };
  let loadSeq = 0;
  async function load(how) {
    dayEnd.refresh(); // "End the day" for this branch and day, and the note when it was ended (day-end.js)
    const quiet = how?.quiet === true;
    const seq = ++loadSeq;
    const version = listVersion;
    const saved = typedSaved;
    const key = `${branchId}|${date}`;
    try {
      const [visitRows, checkupRows] = await Promise.all([d.listVisits({ branchId: branchId || null, date }), loadCheckups()]);
      if (seq !== loadSeq) return;
      const newList = how === NEW_LIST || key !== drawnKey;
      if (version !== listVersion || saved !== typedSaved) {
        if (quiet && !newList) { reloadHeld = true; whenFree(); } else await load(newList ? NEW_LIST : how);
        return;
      }
      for (const r of visitRows) Object.assign(r, q.unsentChanges('visits', r.id));
      for (const c of checkupRows) Object.assign(c, q.unsentChanges('checkups', c.id));
      rows = visitRows;
      checkups = checkupRows;
      rowsKey = key;
      if (!branchId) rows.sort((a, b) => a.branch_id - b.branch_id || (a.token_no ?? 999) - (b.token_no ?? 999));
      if (newList || !waitMs()) draw();
      else { refreshInPlace(); requestDraw(); }
    } catch (e) { if (seq === loadSeq) toast(friendlyError(e), 'error'); }
  }
  // The person is working in the table and a reload has come: the rows whose data is not what they were drawn from any more
  // (another computer or a dialog changed them) are drawn again where they are, with their numbers, but not the row with
  // the cursor (it is drawn again at the first reload after the cursor has left it); rows that are new on the list wait
  // for the next draw (newRowsNote says how many), and rows that have gone stay until then.
  function refreshInPlace() {
    const now = new Map([...rows.map((r) => [`v:${r.id}`, r]), ...checkups.map((c) => [`c:${c.id}`, c])]);
    const here = rowKey(document.activeElement);
    for (const tr of [...tableBody.children]) {
      const key = rowKey(tr);
      const row = key && key !== here ? now.get(key) : null;
      if (row && JSON.stringify(row) !== drawnData.get(key)) replaceRow(row, key.startsWith('c:') ? checkupRowEl : rowEl);
    }
    noteWaiting();
    drawWarning();
    drawCounts();
    markInvalid();
  }
  // How many rows the filters show that are not on screen yet (the list was not drawn since they came): all of them, not
  // only the ones the last reload brought; and how many rows on screen are not in their place any more (a new status, here
  // or on another computer, or no longer shown by the filters).
  function noteWaiting() {
    let fresh = 0;
    let moved = 0;
    for (const item of [...rows.map((row) => ({ row, checkup: false })), ...dayListCheckups(checkups, rows).map((row) => ({ row, checkup: true }))]) {
      const shown = item.checkup ? checkupMatches(item.row) : matches(item.row);
      const was = placed.get(keyOf(item));
      if (!was) fresh += shown ? 1 : 0;
      else if (!shown || movedFrom(item, was)) moved++;
    }
    noteNewRows(fresh, moved);
  }

  // The day's list as a spreadsheet file (for the clinic cloud or printing). Checkup patients are added after the
  // patients, marked in the "type" column (all of the day's checkups, whatever the filters on screen: the patient rows are unfiltered too).
  function download() {
    const name = (branchId ? branchName(branchId) : 'all-branches').replace(/\W+/g, '-');
    const patientRows = rows.map((r) => ({
      token: r.token_no ?? '', patient: r.patient.full_name, mr_number: r.patient.mr_number, branch: branchName(r.branch_id),
      braces_month: r.braces_month ?? '', treatment: r.treatment_label || '', status: STATUS_LABELS[r.status],
      doctors: r.staff.map((x) => (x.role === 'checker' ? '✓ ' : '') + x.name).join(', '), details: r.details_text || '',
      dues: can('dues.view') ? r.dues : '', notes: r.notes || '', phone: r.patient.phone || '', type: 'Patient',
    }));
    const checkupRows = dayListCheckups(checkups, rows).sort(byToken).map((c) => ({
      token: c.token || '', patient: c.patient_name, mr_number: '', branch: branchName(c.branch_id),
      braces_month: '', treatment: c.checkup_for || '', status: c.day_status ? STATUS_LABELS[c.day_status] : '',
      doctors: c.doctors || '', details: c.details || '', dues: '', notes: c.notes || '', phone: c.phone || '', type: 'Checkup',
    }));
    downloadCSV(`aaj-ki-list_${name}_${date}.csv`, [...patientRows, ...checkupRows]);
  }

  // ---------------------------------------------------------------- cells
  const canEdit = can('sheet.edit');
  const canTreatment = can('treatment.enter') || canEdit;
  // The Invoice column is for the people who see invoices; without them (doctors, assistants) Treatment Details gets its room.
  const canBill = can('billing.view');

  // (A typed change goes on the copy of the row the list has now too: a reload while the person types puts in new copies,
  //  and the list is drawn from those once they are done.)
  function save(row, fieldName, value) {
    for (const r of new Set([row, rows.find((x) => x.id === row.id) || row])) r[fieldName] = value;
    listVersion++;
    q.edit('visits', row.id, fieldName, value);
  }
  // A status, group or doctor change answers with the visit as the server has it. Its typed cells (Treatment, Treatment
  // Details, Notes) stay as this screen has them: the answer can be older than what was typed (read before a typed save that
  // was sent later, or is still on its way, had reached the database), and drawn into the row it would put the old text back
  // in the cell being typed in, and the next key would save over the good text. A typed cell gets what the server has from
  // the list's reloads only (another computer's change), which never draw a list asked for before a change made here
  // (listVersion, see load). The answer goes on the row the list has now too (a reload meanwhile put in a new copy of it):
  // that copy is the one returned, to be drawn.
  const TYPED_FIELDS = ['treatment_label', 'details_text', 'notes'];
  const merge = (row, updated) => {
    listVersion++;
    const answer = { ...updated };
    for (const f of TYPED_FIELDS) delete answer[f];
    const now = rows.find((r) => r.id === row.id) || row;
    for (const r of new Set([row, now])) Object.assign(r, answer, q.unsentChanges('visits', row.id));
    return now;
  };

  // ---- checkup patients (rows without an Mr#). Typed cells go through the same queue as the visits.
  function saveCheckup(c, fieldName, value) {
    for (const x of new Set([c, checkups.find((y) => y.id === c.id) || c])) x[fieldName] = value;
    listVersion++;
    q.edit('checkups', c.id, fieldName, typeof value === 'string' && value.trim() === '' ? null : value);
  }

  async function changeCheckupStatus(c, value, ctl) {
    const before = c.day_status || '';
    const who = c.patient_name;
    try {
      if ((await d.updateCheckup(c.id, { day_status: value || null })) === null) { toast(`${who} is no longer on the list.`, 'error'); load(); return; }
      // (the status alone: the row is drawn from the copy the list has now, with what has been typed in it meanwhile, as merge)
      const now = checkups.find((x) => x.id === c.id) || c;
      for (const x of new Set([c, now])) x.day_status = value || null;
      redrawRow(now, checkupRowEl);
      announce(`Saved: ${who} is ${STATUS_LABELS[c.day_status] || 'not set'}.`);
    } catch (e) {
      ctl.set(before);
      toast(notSaved(e, `${who} is still "${STATUS_LABELS[before] || 'Not set'}".`), 'error', 10000);
    }
  }

  // "Fill in form" on a checkup row, and in its Options: the checkup form after the checkup (a patient put on the list as they came in,
  // here, on the Today page or in the Google Sheet). The answers make the checkup Completed; the row's button is gone then, so the cursor
  // goes to its Options button rather than to the top of the page.
  async function fillCheckupForm(c) {
    const saved = await checkupAnswersModal(checkups.find((x) => x.id === c.id) || c);
    if (saved === false) load(); // it is gone: read the list again
    if (!saved) return;
    checkups = checkups.map((x) => (x.id === saved.id ? saved : x));
    listVersion++;
    draw();
    toast(`Answers saved on ${saved.patient_name}'s checkup.`, 'ok');
    setTimeout(() => { const a = document.activeElement; if (!a || a === document.body || a.matches('h1')) focusCell(saved.id, 'options'); });
  }

  // The dialog behind ⋮ on a checkup row ("Checkup options"): the checkup form, follow-up status, notes, patient file, the
  // checkup list, remove.
  function checkupOptions(c) {
    const who = c.patient_name;
    const mr = registeredMr(c);
    let dialog = null;
    const follow = followUpSelect(c, async (value, ctl, previous) => {
      try {
        if ((await d.updateCheckup(c.id, { follow_up: value })) === null) { toast(`${who} is no longer on the list.`, 'error'); load(); return; }
        c.follow_up = value;
        announce(`Saved: ${who} is "${value}".`);
      } catch (e) { ctl.set(previous); toast(notSaved(e, `${who} is still "${previous}".`), 'error', 8000); }
    }, { disabled: !canEdit });
    // Notes save by themselves through the same queue as the cells (the sheet has no Notes column, so they live here).
    const notes = h('input', { value: c.notes || '', disabled: !canEdit, autocomplete: 'off', maxlength: 2000, oninput: (e) => saveCheckup(c, 'notes', e.target.value) });
    const digits = String(c.phone || '').replace(/\D/g, '');
    const inCheckupList = `#/staff/checkups?q=${encodeURIComponent(digits.length >= 4 ? digits : who)}`;
    const actions = [
      // a checkup typed in on arrival (here or in the Google Sheet): the assistant fills in the form for it after the checkup
      canEdit && !formComplete(c) ? h('button', { type: 'button', class: 'btn', 'aria-haspopup': 'dialog', onclick: () => { dialog?.close(); fillCheckupForm(c); } }, 'Fill in the checkup form') : null,
      c.patient_id
        ? h('a', { class: 'btn', href: `#/staff/patient/${c.patient_id}` }, mr ? `Mr# ${mr} - Open patient file` : 'Open patient file')
        : canRegisterCheckup() ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { dialog?.close(); registerCheckupModal(c, { onDone: load, list: registerList(c) }); } }, 'Register as patient') : null,
      // Registered: Bill (for their row on this list when they are on it, else for the patient file at this checkup's branch).
      c.patient_id && can('billing.create') ? h('button', { type: 'button', class: 'btn', 'aria-haspopup': 'dialog', onclick: () => { dialog?.close(); billCheckup(c); } }, 'Bill') : null,
      h('a', { class: 'btn', href: inCheckupList }, 'Open in the checkup list'),
      canRemoveCheckup(c) ? h('button', { type: 'button', class: 'btn btn-danger', onclick: () => { dialog?.close(); removeCheckupModal(c, { onDone: () => { checkups = checkups.filter((x) => x.id !== c.id); listVersion++; draw(); } }); } }, 'Remove from the list') : null,
    ];
    const shown = (label, value) => h('div', { class: 'field' }, h('div', { class: 'field-label' }, label), h('div', {}, value || '–'));
    dialog = modal(`${who} · Checkup patient`, h('div', {},
      h('p', { class: 'muted' }, c.patient_id ? 'Has a patient file now.' : 'No Mr# yet. A checkup patient gets a patient file when they start treatment.'),
      h('div', { class: 'form-grid' },
        shown('Name', who),
        shown('Phone', c.phone),
        field('Follow-up status', follow),
        field('Notes', notes, 'Saved by itself, like the cells of the list.'),
        // the answers of the checkup form, when it was filled in (not for a checkup from the sheet or from before the form)
        hasFormAnswers(c) ? [shown('Dr. Ali recommended', yesNo(c.ali_recommended)), shown('Understood pricing', PRICING_LABELS[c.pricing_understood]),
          shown('Wants to start', yesNo(c.wants_treatment)), shown('When / why not', c.treatment_plan)] : null),
      h('div', { class: 'inline', style: { marginTop: '10px' } }, actions)), [{ label: 'Done', primary: true }]);
  }

  async function changeStatus(row, value, ctl) {
    const before = row.status;
    const who = row.patient.full_name;
    try {
      const updated = await d.updateVisit(row.id, { status: value });
      redrawRow(merge(row, updated));
      announce(`Saved: ${who} is ${STATUS_LABELS[row.status] || row.status}.`);
      if (value === 'in_treatment' && updated.dues > 0 && can('dues.view')) {
        toast(`Clear dues first: ${rupees(updated.dues)} pending.`, 'error', 6000);
      }
    } catch (e) {
      ctl.set(before);
      if (noAnswer(e)) { toast(notSaved(e, `${who} is still "${STATUS_LABELS[before]}".`), 'error', 10000); return; }
      const msg = friendlyError(e);
      if (/dues/i.test(e.message) && can('dues.override')) {
        modal('Pending dues', h('p', {}, msg), [
          { label: 'Cancel' },
          { label: 'Override and start treatment', danger: true, onClick: async () => {
            try { redrawRow(merge(row, await d.updateVisit(row.id, { status: value, dues_override_by: true, dues_override_reason: 'Override from Aaj ki List' }))); } catch (err) { toast(notSaved(err, `${who} is still "${STATUS_LABELS[before]}".`), 'error', 8000); }
          } },
        ], { destructive: true });
      } else toast(msg, 'error', 7000);
    }
  }

  // The Group chip: which braces group sees the patient today, as on the sheet. Saved at once, like the status.
  const groupWords = (g) => (g ? groupName(g) : 'in no group');
  async function changeGroup(row, value, ctl) {
    const before = row.doctor_group_id ? String(row.doctor_group_id) : '';
    const who = row.patient.full_name;
    try {
      redrawRow(merge(row, await d.updateVisit(row.id, { doctor_group_id: value ? Number(value) : null })));
      announce(`Saved: ${who} is ${groupWords(row.doctor_group_id)}.`);
    } catch (e) {
      ctl.set(before);
      toast(notSaved(e, `${who} is still ${groupWords(before)}.`), 'error', 8000);
    }
  }

  // One request per chip at a time (a double tap must not send two). The button is not disabled,
  // so focus stays on it until the row is redrawn and focus moves to "+".
  // (inDialog: removed from the people dialog, which shows the Undo itself; inDialog('removed' | 'back', s) redraws it and
  //  returns true while the dialog is open.)
  const inFlight = new Set();
  async function removePerson(row, s, inDialog) {
    const who = row.patient.full_name;
    const name = s.name || 'Unknown';
    const key = `${row.id}|${s.clinician_id}|${s.role}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      redrawRow(merge(row, await d.setVisitStaff(row.id, s.clinician_id, s.role, false)));
      offerUndo(`${name} removed from ${who}.`, async () => {
        try {
          redrawRow(merge(row, await d.setVisitStaff(row.id, s.clinician_id, s.role, true)));
          // Continue from the chip that came back, rather than from the Undo bar that is closing.
          if (!inDialog?.('back', s) && (!document.activeElement || document.activeElement === document.body || undoBox.contains(document.activeElement))) {
            // (or from the "+", when the chip came back out of sight)
            const els = [...tableBody.querySelectorAll(`tr[data-id="${row.id}"] [data-focus]`)];
            const x = els.find((el) => el.dataset.focus === `remove-${s.clinician_id}-${s.role}`);
            (x && x.tabIndex >= 0 ? x : els.find((el) => el.dataset.focus === 'add-person'))?.focus();
          }
          announce(`${name} is back on ${who}.`);
        } catch (e) { toast(notSaved(e, `${name} is still removed from ${who}.`), 'error', 8000); }
      }, inDialog ? 'in this dialog' : undefined);
      inDialog?.('removed', s);
    } catch (e) { toast(notSaved(e, `${name} is still on ${who}.`), 'error', 8000); }
    finally { inFlight.delete(key); }
  }

  const ROLE_WORDS = { doctor: 'Doctor', assistant: 'Assistant', checker: 'Checked by' };
  const removeLabel = (s, who) => `Remove ${s.name || 'Unknown'}${s.role === 'doctor' ? '' : ` (${s.role})`} from ${who}`;
  const ADD_PEOPLE = 'Add or remove a doctor, assistant or checker';
  function peopleCell(row) {
    const who = row.patient.full_name;
    const rule = row.braces_month ? protocolFor(row.braces_month) : null;
    // Doctor, assistant and checker chips differ in text too, not only colour; each person keeps one colour on every row.
    // The chip leaves out "Dr." (the column is Doctor Name), so two names fit a laptop's cell; it is still read out, and the
    // whole name is in the chip's tooltip and the "+" dialog. On a laptop the first chip shows its name whole, the next ones
    // at least a few letters, a chip with no room for that drops out of sight whole and the "+" counts it ("+2",
    // countHiddenPeople), and a chip's × shows over its end while the mouse is on it or it has the keyboard, so it takes no
    // room (one click removes, with Undo; a chip out of sight is removed in the "+" dialog); on a touch screen each chip
    // shows its ×.
    const chips = row.staff.map((s) => {
      const name = s.name || 'Unknown';
      const dr = /^dr\b\.?\s*(?=\S)/i.exec(name)?.[0] || '';
      return h('span', {
        class: ['person', s.role, `gs-${doctorTone(s.clinician_id, s.name)}`],
        title: `${name}${s.role === 'checker' ? ' (checked)' : s.role === 'assistant' ? ' (assistant)' : ''}`,
      },
      s.role === 'checker' ? h('span', { class: 'person-mark', 'aria-hidden': 'true' }, '✓') : null,
      h('span', { class: 'person-name' }, s.role === 'checker' ? srOnly('Checked by ') : null, dr ? srOnly(dr) : null, name.slice(dr.length),
        s.role === 'assistant' ? [h('span', { 'aria-hidden': 'true' }, ' (asst.)'), srOnly(' (assistant)')] : null),
      canTreatment ? h('button', {
        type: 'button', class: 'chip-remove', dataset: { focus: `remove-${s.clinician_id}-${s.role}` },
        // (the second click of a double click removes nobody: the next chip of the cell can have come under the mouse)
        'aria-label': removeLabel(s, who), onclick: (e) => { if (e.detail < 2) removePerson(row, s); },
      }, h('span', { 'aria-hidden': 'true' }, '×')) : null);
    });
    // (the count of chips out of sight is written in .people-count; without "+" it gets a slot of its own)
    const add = canTreatment
      ? h('button', { type: 'button', class: 'add-person chip-add', dataset: { focus: 'add-person', title: ADD_PEOPLE }, 'aria-label': `Add or remove doctor, assistant or checker for ${who}`, title: ADD_PEOPLE, onclick: () => pickPeople(row) },
        h('span', { class: 'people-count', 'aria-hidden': 'true', dataset: { plain: '+' } }, '+'))
      : row.staff.length > 1 ? h('span', { class: 'people-count people-more', 'aria-hidden': 'true', dataset: { plain: '', title: '' } }) : null;
    // The braces rule for the month (who treats, who checks), after the chips while there is room (it gives way first).
    const ruleText = rule ? `G${rule.treatingGroups.join('/')}${rule.checkerGroup ? ` · check G${rule.checkerGroup}` : ''}` : '';
    const hint = rule ? h('span', { class: 'field-hint', title: `Braces month ${row.braces_month}: ${ruleText}` },
      h('span', { 'aria-hidden': 'true' }, ruleText),
      srOnly(`Treated by group ${rule.treatingGroups.join(' or ')}${rule.checkerGroup ? `, checked by group ${rule.checkerGroup}` : ''}`)) : null;
    return h('div', { class: 'people' }, h('div', { class: 'people-chips' }, chips), hint, add);
  }

  // After a dialog opened from a row, modal() puts focus back on the button that opened it, or on its twin (the same name)
  // when the list was drawn again meanwhile. There is no twin when that control changed with the redraw (a Pending chip
  // that turned Done is no button), and focus would go to the page heading: it goes back to that control of the row
  // (key), or to the name.
  function backToRow(id, key) {
    const el = document.activeElement;
    if (document.querySelector('.modal') || (el && el !== document.body && !el.matches('h1'))) return;
    const els = [...tableBody.querySelectorAll(`tr[data-id="${id}"] [data-focus]`)];
    (els.find((x) => x.dataset.focus === key) || els.find((x) => x.dataset.focus === 'patient'))?.focus();
  }

  // The "+" of the Doctor Name cell: who is on the visit, each with Remove (and Undo; a chip out of sight is listed here
  // too), and the people to add.
  function pickPeople(row) {
    const month = row.braces_month;
    const who = row.patient.full_name;
    let open = true;
    let removed = ''; // the last person removed here, while their Undo lasts
    const role = select([{ value: 'doctor', label: 'Doctor' }, { value: 'assistant', label: 'Assistant / hygienist' }, { value: 'checker', label: 'Checked by' }], 'doctor');
    const onHost = h('div', { class: 'people-on' });
    const drawOn = () => {
      if (removed && !undoFn) removed = '';
      mount(onHost,
        h('div', { class: 'field-label' }, 'On this visit'),
        row.staff.length ? h('ul', { class: 'people-on-list' }, row.staff.map((s) => h('li', {},
          h('span', {}, `${ROLE_WORDS[s.role] || s.role}: ${s.name || 'Unknown'}`),
          h('button', { type: 'button', class: 'btn btn-small', 'aria-label': removeLabel(s, who), dataset: { key: `${s.clinician_id}-${s.role}` }, onclick: () => removePerson(row, s, inDialog) }, 'Remove'))))
          : h('p', { class: 'muted' }, 'Nobody yet.'),
        removed ? h('p', { class: 'people-on-undo' }, `${removed} removed. `, h('button', { type: 'button', class: 'btn btn-small', dataset: { key: 'undo' }, onclick: runUndo }, 'Undo')) : null);
    };
    const focusOn = (key) => [...onHost.querySelectorAll('button')].find((b) => b.dataset.key === key)?.focus();
    function inDialog(what, s) {
      if (!open) return false;
      removed = what === 'removed' ? s.name || 'Unknown' : '';
      drawOn();
      focusOn(what === 'removed' ? 'undo' : `${s.clinician_id}-${s.role}`);
      return true;
    }
    const listHost = h('div', { class: 'stack', style: { maxHeight: '50vh', overflow: 'auto' } });
    const drawList = () => {
      const r = role.value;
      const people = state.ref.clinicians.filter((c) => (r === 'assistant' ? !c.is_doctor : c.is_doctor));
      const isAli = (c) => c.display_name === 'Dr. Ali Rashid';
      mount(listHost, h('div', { class: 'inline' }, people.map((c) => {
        const allowed = !month || !c.is_doctor || (r === 'doctor' ? canTreat(month, c.doctor_group_id, isAli(c)) : r === 'checker' ? canCheck(month, c.doctor_group_id, isAli(c)) : true);
        return h('button', {
          type: 'button', class: ['btn btn-small', !allowed && 'btn-danger'], title: allowed ? null : 'Not in the group for this braces month',
          onclick: busy(async () => {
            try { redrawRow(merge(row, await d.setVisitStaff(row.id, c.id, r, true))); if (open) drawOn(); toast(`${c.display_name} added to ${who}.`, 'ok'); } catch (e) { toast(notSaved(e, `${c.display_name} was not added.`), 'error', 8000); }
          }),
        }, c.display_name, c.doctor_group_id ? h('span', { class: 'muted' }, ` G${c.doctor_group_id}`) : '', allowed ? '' : h('span', {}, ' · not allowed this month'));
      })));
    };
    role.addEventListener('change', drawList);
    drawOn();
    drawList();
    modal(`Who treated ${who}?`, h('div', {},
      month ? h('p', { class: 'muted' }, `Braces month ${month}: treated by Group ${protocolFor(month).treatingGroups.join(' or ')}${protocolFor(month).checkerGroup ? `, checked by Group ${protocolFor(month).checkerGroup}` : ''}. Names marked "not allowed this month" are outside the protocol for this month.`) : null,
      onHost, field('Add as', role), listHost), [{ label: 'Done', primary: true }], {
      onClose: () => {
        open = false;
        // An Undo made here stays on the bar above the list for its 10 seconds.
        if (undoFn) { clearTimeout(undoTimer); undoTimer = setTimeout(hideUndo, 10000); }
        // The "+" that opened this was redrawn with the row: continue from the new one.
        backToRow(row.id, 'add-person');
      },
    });
  }

  // The row's actions (a click on the name, or its ⋮): guidance, photos, invoice, payment, Dr. Ali, profile, and the notes.
  async function openRow(row) {
    let g = row.braces_month ? await d.bracesGuidance(row.patient_id).catch(() => null) : null;
    // Guidance is for this row's month (a completed visit is no longer the "next" month).
    if (g?.has_active_case && g.month !== row.braces_month) {
      const local = protocolGuidance({ month: row.braces_month, extractionPlan: g.extraction_plan || 'undecided',
        extractionsDone: !!g.extractions_done, hasDrAliPlan: !!g.has_dr_ali_plan, dues: row.dues });
      g = { ...g, month: row.braces_month, treating_groups: local.rule.treatingGroups, checker_group: local.rule.checkerGroup,
        planned_wire: local.rule.plannedWire, photo_required: local.rule.photoRequired && !local.beyondProtocol,
        rule_confirmed: local.rule.confirmed && !local.beyondProtocol, alerts: local.alerts };
    }
    let dialog = null;
    // (Both data adapters put the patient's photo_consent_public on every visit row, so the dialog needs no extra fetch.)
    const uploadPhotos = () => photoUploadModal(row.patient, { visitId: row.id, branchId: row.branch_id, onDone: load });
    const actions = [
      // Bill: the invoice with the payment and the printed bill (the same as the Bill button on the row).
      can('billing.create') ? h('button', { class: 'btn btn-primary', 'aria-haspopup': 'dialog', onclick: () => billRow(row) }, 'Bill') : null,
      can('photos.upload') ? h('button', { class: 'btn', onclick: uploadPhotos }, 'Upload photos') : null,
      can('billing.create') ? h('button', { class: 'btn', onclick: () => paymentModal(row.patient, { branchId: row.branch_id, dues: row.dues, onDone: load }) }, 'Take payment') : null,
      can('flags.raise') && !row.see_dr_ali ? h('button', { class: 'btn', onclick: () => flagForAliModal(row.patient, load) }, 'Next appointment with Dr. Ali') : null,
      // Close this dialog first, so the profile is not left underneath it.
      h('button', { type: 'button', class: 'btn', onclick: () => { dialog?.close(); location.hash = `#/staff/patient/${row.patient_id}`; } }, 'Open profile'),
    ];
    const medical = medicalText(row.patient);
    // Notes save by themselves through the same queue as the cells (the sheet has no Notes column, so they live here; the
    // latest one is shown on the patient's profile too).
    const notesBefore = row.notes || '';
    const notes = h('input', { value: notesBefore, disabled: !canEdit, autocomplete: 'off', oninput: (e) => save(row, 'notes', e.target.value) });
    const from = tableBody.contains(document.activeElement) ? document.activeElement.dataset.focus : null; // (the name or the month chip)
    dialog = modal(`${row.patient.full_name} · Mr# ${row.patient.mr_number}`, h('div', {},
      medical ? h('div', { class: 'alert alert-warning' }, h('strong', {}, 'Medical history: '), medical) : null,
      row.dues > 0 && can('dues.view') ? h('div', { class: 'alert alert-stop' }, `Pending dues ${rupees(row.dues)}. Clear dues before treatment.`) : null,
      row.see_dr_ali ? h('div', { class: 'alert alert-warning' }, 'Flagged: next appointment should be with Dr. Ali Rashid.') : null,
      g ? guidancePanel(g) : null,
      h('div', { class: 'inline', style: { marginTop: '10px' } }, actions),
      h('div', { style: { marginTop: '14px' } }, field('Notes', notes, 'Saved by itself, like the cells of the list.'))), [], {
      // The buttons above reload the list when they are done (a payment, an invoice, Dr. Ali, photos), which puts new rows
      // in it: the row is redrawn from the one in the list now, with the note typed here, not from this dialog's old copy.
      // Focus then goes back to the control of the row that opened this.
      onClose: () => {
        const now = (row.notes || '') !== notesBefore && rows.find((r) => r.id === row.id);
        if (now) { now.notes = row.notes; redrawRow(now); }
        backToRow(row.id, from);
      },
    });
    // Start on the heading, as before the notes were here (the first field would otherwise take focus).
    dialog.dialog.querySelector('h2')?.focus();
  }

  // Bill (owner, 15 Oct 2026: "the add invoice button should be on the aaj ki list ... and payment could be taken and an invoice bill
  // printout provided for the patient"): the invoice form for this patient at the list's branch, for this visit, with the row's
  // treatment on its first line when it is on the price list and the visit's doctor as "Performed by". It is drawn from the row the
  // list has now (a reload may have put in a new copy). Saved, the list is read again, and once the bill shown then is closed the
  // cursor goes back to the row's control (focus: its data-focus key; the patient's name when that control is gone).
  function billRow(row, focus = 'bill') {
    const now = rows.find((r) => r.id === row.id) || row;
    newInvoiceModal(now.patient, {
      branchId: now.branch_id, visitId: now.id, visitStaff: now.staff, treatment: now.treatment_label,
      onDone: () => load(),
      afterBill: () => setTimeout(() => backToRow(now.id, focus)),
    });
  }
  // Bill for a checkup patient who has a patient file (registered, or p: the file just made for them): for their row on this list when
  // they are on it, else for the patient file at this checkup's branch. Afterwards the cursor goes back to the checkup row's Bill.
  function billCheckup(c, p = null) {
    const id = p?.id || c.patient_id;
    const there = rows.find((r) => r.patient_id === id && r.branch_id === c.branch_id);
    if (there) { billRow(there); return; }
    newInvoiceModal({ id, full_name: p?.full_name || c.patient_name, mr_number: p?.mr_number || registeredMr(c) || null, phone: c.phone || null }, {
      branchId: c.branch_id, treatment: c.checkup_for, onDone: load, afterBill: () => setTimeout(() => backToRow(c.id, 'bill')),
    });
  }
  // "Register as patient" opened from the list: "Put Mr# N on this list", and Bill for whoever makes invoices (owner, 15 Oct 2026: a
  // checkup patient "wants to start the treatment, ready to pay").
  const registerList = (c) => ({ add: addPatient, bill: can('billing.create') ? (p) => billCheckup(c, p) : null });

  // The Invoice column (the sheet's "Healthwire" column: billing is done on the website now). Done when this visit has an
  // invoice; Pending (dark red) once the patient is being treated or done and has none. A patient not seen yet (waiting,
  // booked) has an empty grey chip, like a row of the sheet that is not done yet: no invoice is due, so it says nothing
  // (screen readers hear "No invoice yet"). Pending and the empty chip open a new invoice.
  function invoiceCell(row) {
    const who = row.patient.full_name;
    if (row.has_invoice) return h('span', { class: 'chip chip-fill gs-green', title: 'This visit has an invoice' }, 'Done');
    if (row.status === 'cancelled' || row.status === 'no_show') return h('span', { class: 'chip chip-fill gs-grey' }, srOnly('No invoice'));
    const due = row.status === 'in_treatment' || row.status === 'completed';
    const cls = ['chip', 'chip-fill', due ? 'gs-darkred invoice-pending' : 'gs-grey invoice-none'];
    const words = due ? 'Pending' : srOnly('No invoice yet');
    // Saved: the list is drawn again with this chip as Done, which is no button, so focus goes back to the row's name once the
    // bill shown after saving is closed (billRow).
    return can('billing.create')
      ? h('button', {
        type: 'button', class: cls, 'aria-haspopup': 'dialog', 'aria-label': `${due ? 'Invoice pending' : 'No invoice yet'} for ${who}: make a new invoice`,
        title: 'New invoice', dataset: { focus: 'invoice' }, onclick: () => billRow(row, 'invoice'),
      }, words)
      : h('span', { class: cls }, words);
  }

  // Reminder Status: the empty chip of the sheet's last column (see columns, below), on every row as on the sheet. It says
  // nothing to a screen reader: the cell is empty.
  const reminderCell = () => h('span', { class: 'chip chip-fill gs-grey', 'aria-hidden': 'true' });

  function rowEl(row, n) {
    const who = row.patient.full_name;
    // Status and group save once the person has finished choosing (Enter, leaving the select, or a pick
    // from the open list), not on every arrow key.
    const status = h('select', {
      class: chipSelect(statusTone(row.status)), 'aria-label': `Status for ${who}`, 'aria-describedby': canEdit ? 'sheet-status-hint' : null,
      disabled: !canEdit, dataset: { focus: 'status' },
    }, Object.entries(STATUS_LABELS).map(([value, label]) => h('option', { value, selected: value === row.status }, label)));
    const ctl = commitOnFinish(status, (value) => changeStatus(row, value, ctl), (value) => { status.className = chipSelect(statusTone(value)); });
    const groupNo = row.doctor_group_id ? String(row.doctor_group_id) : '';
    // A group the Google Sheet names that Clinic setup does not have (the sheet says "Group 4", Clinic setup has Groups 1 to
    // 3): the sync leaves the visit in no group and keeps the sheet's words (sheet_cells.group: t the words, v the group,
    // none here). The cell shows those words greyed, first in the list and not to be picked, until the group is added in
    // Clinic setup; "No group" next to it saves nothing (the visit is in no group already).
    const sheetGroup = !groupNo && row.sheet_cells?.group && row.sheet_cells.group.v == null ? String(row.sheet_cells.group.t ?? '').trim() : '';
    const group = h('select', { class: chipSelect(groupTone(groupNo)), 'aria-label': `Doctor group for ${who}`, disabled: !canEdit, dataset: { focus: 'group' } },
      sheetGroup ? h('option', { value: '', selected: true, disabled: true, dataset: { sheet: 'yes' } }, sheetGroup) : null,
      [['', 'No group'], ...[...new Set([...groupIds, ...(groupNo ? [Number(groupNo)] : [])])].map((g) => [String(g), groupName(g)])]
        .map(([value, label]) => h('option', { value, selected: !sheetGroup && value === groupNo }, label)));
    const unknownGroup = () => {
      const unknown = !!group.selectedOptions[0]?.dataset.sheet;
      group.classList.toggle('group-unknown', unknown);
      group.title = unknown ? 'Add this group in Clinic setup' : '';
    };
    const groupCtl = commitOnFinish(group, (value) => changeGroup(row, value, groupCtl), (value) => { group.className = chipSelect(groupTone(value)); unknownGroup(); });
    unknownGroup();
    choices.set(status, ctl).set(group, groupCtl);

    const treatment = h('input', {
      class: 'cell-input center', value: capFirst(row.treatment_label), list: 'sheet-treatments', disabled: !canEdit, 'aria-label': `Treatment for ${who}`,
      dataset: { focus: 'treatment', field: 'treatment_label' }, onchange: (e) => save(row, 'treatment_label', e.target.value),
    });
    const details = h('input', {
      class: 'cell-input', value: row.details_text || '', title: row.details_text || null, disabled: !canTreatment, placeholder: 'e.g. U L 018 PC refresh', 'aria-label': `Treatment details for ${who}`,
      dataset: { focus: 'details', field: 'details_text' }, oninput: (e) => save(row, 'details_text', e.target.value),
    });
    // Quick-tap chips (blueprint 11.2): arch, wire size, power chain, o-rings, rebond, extraction, elastics.
    const quickTap = canTreatment ? h('button', { class: 'quick-tap', type: 'button', title: 'Quick-tap treatment details', 'aria-label': `Add treatment details for ${who}`, dataset: { focus: 'quick' }, onclick: () => {
      const groups = [
        ['Arch', ['U', 'L', 'U L']],
        ['Wire', ['012', '014', '016', '018', '020', '17x25', '19x25']],
        ['Done', ['PC', 'O-rings', 'Refresh', 'Rebond', 'Ligature', 'Elastics', 'Cross arch', 'Ext', 'IPR', 'Bite blocks']],
      ];
      // The row can be drawn again while this is open (a reload, the echo of a tap's own save), so a tap adds to the text the
      // list has for the row now (save keeps it up to date) and writes it in the cell the row has on screen now; closing
      // draws the row from the list, as the row's dialog does for the note.
      let tapped = false;
      const add = (t) => {
        const now = rows.find((r) => r.id === row.id) || row;
        const text = (now.details_text ? now.details_text.replace(/\s+$/, '') + ' ' : '') + t;
        save(row, 'details_text', text);
        tapped = true;
        const cell = tableBody.querySelector(`tr[data-id="${row.id}"]:not([data-kind]) [data-focus="details"]`);
        if (cell) { cell.value = text; cell.title = text; }
      };
      modal(`Treatment details · ${who}`, h('div', {},
        groups.map(([name, items]) => h('div', { style: { marginBottom: '10px' } }, h('div', { class: 'field-label' }, name),
          h('div', { class: 'inline' }, items.map((t) => h('button', { type: 'button', class: 'btn btn-small', onclick: () => add(t) }, t))))),
        h('p', { class: 'muted' }, 'Tap to add to the details; type anything else in the cell itself.')), [{ label: 'Done', primary: true }], {
        onClose: () => { const now = tapped && rows.find((r) => r.id === row.id); if (now) redrawRow(now); },
      });
    } }, h('span', { 'aria-hidden': 'true' }, '+')) : null;
    // The braces month as the sheet writes it ("07", "10 Photo"): green when the month needs photos, purple otherwise.
    const monthNo = String(row.braces_month || '').padStart(2, '0');
    const photo = !!row.braces_month && photoMonth(row);
    const photoText = photo ? (row.photos_uploaded ? ', photos uploaded' : ', photos needed') : '';
    const month = row.braces_month
      ? h('button', {
        type: 'button', class: ['chip', 'chip-fill', 'month-pill', `gs-${photo ? 'green' : 'purple'}`, photo && !row.photos_uploaded && 'photo-due'], 'aria-haspopup': 'dialog',
        'aria-label': `Braces month ${monthNo} guidance for ${who}${photoText}`, title: 'Braces guidance for this month', dataset: { focus: 'month' }, onclick: () => openRow(row),
      }, monthNo, photo ? ` Photo${row.photos_uploaded ? ' ✓' : ''}` : '')
      : h('span', { class: 'chip chip-fill gs-grey' }, srOnly('Not braces'));
    const arrived = row.checked_in_at ? timeOf(row.checked_in_at) : '';
    const pp = !can('dues.view') ? null : row.dues > 0
      ? h('span', { class: 'pp-due', title: `Pending dues ${rupees(row.dues)}` }, shortRupees(row.dues), srOnly(` pending dues, ${rupees(row.dues)}`))
      : h('span', { class: 'pp-zero', title: 'No pending dues' }, '0', srOnly(' pending dues'));
    // No flags beside the name (SHOW_MEDICAL_ON_LIST, at the top): only the medical one can be switched back on. It is short
    // so the name keeps most of the cell, always whole (the name gives way); the full words are read out and in its tooltip.
    const medical = SHOW_MEDICAL_ON_LIST ? medicalText(row.patient) : '';
    const medicalFlag = medical ? h('span', { class: 'name-flags' }, h('span', { class: 'badge badge-warn', title: `Medical history: ${medical}` },
      h('span', { 'aria-hidden': 'true' }, 'Med'), srOnly('Medical'))) : null;
    const nameBtn = h('button', {
      type: 'button', class: 'link-btn name-btn', 'aria-haspopup': 'dialog', dataset: { focus: 'patient' }, onclick: () => openRow(row),
      title: `${who}: actions, braces guidance and notes`,
    },
    h('span', { class: 'name-text' }, who),
    medicalFlag,
    h('span', { class: 'kebab', 'aria-hidden': 'true' }, '⋮'));
    // Bill, beside the name: in the name column, which stays in sight at the left edge on a laptop and on a phone alike.
    const bill = can('billing.create') ? h('button', {
      type: 'button', class: 'bill-btn', 'aria-haspopup': 'dialog', 'aria-label': `Bill ${who}`, title: 'Bill: invoice, payment and the printed bill',
      dataset: { focus: 'bill' }, onclick: () => billRow(row),
    }, 'Bill') : null;

    return h('tr', { dataset: { id: row.id, n } },
      !branchId ? h('td', { class: 'branch-cell' }, cellText(branchName(row.branch_id))) : null,
      h('td', { class: 'rownum' }, n),
      h('td', { class: 'mr-cell frozen' }, cellText(srOnly('Mr# '), row.patient.mr_number)),
      // The patient cell is the row's header (th scope=row). A click on the name opens the row's actions, with the patient's
      // flags (medical history, see Dr. Ali, dues) and the note.
      h('th', { scope: 'row', class: 'frozen row-head name-col' }, bill ? h('div', { class: 'name-cell has-bill' }, nameBtn, bill) : nameBtn),
      h('td', {}, month),
      h('td', {}, typedCell(treatment)),
      h('td', { class: 'center' }, h('span', { class: 'token', title: arrived ? `Arrived ${arrived}` : null }, srOnly('Token '), row.token_no ?? srOnly('none'), arrived ? srOnly(`, arrived ${arrived}`) : null)),
      h('td', {}, status),
      h('td', {}, group),
      h('td', {}, peopleCell(row)),
      h('td', {}, h('div', { class: 'details-cell' }, details, quickTap)),
      h('td', { class: 'pp' }, pp),
      canBill ? h('td', {}, invoiceCell(row)) : null,
      h('td', { class: 'contact' }, cellText(row.patient.phone || '')),
      h('td', {}, reminderCell()));
  }

  // A checkup patient: the same columns as a visit row (so the arrow keys keep working), but no Mr#, no braces month,
  // no group, no doctor chips, no dues. Every cell saves through the queue or, for the status, at once.
  function checkupRowEl(c, n) {
    const who = c.patient_name;
    const mr = registeredMr(c);
    const nameIn = h('input', {
      class: 'cell-input', value: who, disabled: !canEdit, maxlength: 200, autocomplete: 'off', 'aria-label': `Name of checkup patient ${who}`,
      dataset: { focus: 'name', field: 'patient_name' },
      onchange: (e) => {
        const v = e.target.value.trim().replace(/\s+/g, ' ');
        if (!v) { e.target.value = c.patient_name; toast('A checkup patient needs a name. The old name is back.', 'error'); return; }
        if (v === c.patient_name) return;
        e.target.value = v;
        e.target.setAttribute('aria-label', `Name of checkup patient ${v}`);
        saveCheckup(c, 'patient_name', v);
      },
    });
    // The token of a checkup is free text: the sheet's checkups keep the number written there, a website checkup has none until
    // someone types one (patients get their number from the list, so two people could otherwise be called with the same number).
    const tokenIn = h('input', {
      class: 'cell-input token-input center', value: c.token || '', disabled: !canEdit, maxlength: 40, autocomplete: 'off', placeholder: '–', 'aria-label': `Token of checkup patient ${who}`,
      dataset: { focus: 'token', field: 'token' },
      onchange: (e) => { const v = e.target.value.trim(); e.target.value = v; if (v !== (c.token || '')) saveCheckup(c, 'token', v); },
    });
    const status = h('select', {
      class: chipSelect(statusTone(c.day_status)), 'aria-label': `Status for ${who}`, 'aria-describedby': canEdit ? 'sheet-status-hint' : null,
      disabled: !canEdit, dataset: { focus: 'status' },
    }, (c.day_status ? DAY_STATUSES : ['', ...DAY_STATUSES]).map((value) => h('option', { value, selected: value === (c.day_status || '') }, value ? STATUS_LABELS[value] : 'Not set')));
    const ctl = commitOnFinish(status, (value) => changeCheckupStatus(c, value, ctl), (value) => { status.className = chipSelect(statusTone(value)); });
    choices.set(status, ctl);
    const text = (fieldName, label, props = {}) => h('input', {
      class: 'cell-input', value: fieldName === 'checkup_for' ? capFirst(c[fieldName]) : c[fieldName] || '', disabled: !canEdit, 'aria-label': `${label} for ${who}`, autocomplete: 'off',
      dataset: { focus: fieldName, field: fieldName }, oninput: (e) => saveCheckup(c, fieldName, e.target.value), ...props,
    });
    // Doctor Name is typed here (a checkup has no visit to put people on), and shown with the chips of the other rows while
    // the cell does not have the cursor (writtenPeople); a click goes through the chips to the cell (app.css .doctors-box).
    const doctors = text('doctors', "Doctor's name", { list: 'sheet-doctors' });
    const doctorChips = h('span', { class: 'written-people', 'aria-hidden': 'true' });
    const doctorsBox = h('div', { class: 'cell-box doctors-box' }, doctors, doctorChips);
    const drawDoctors = () => {
      const chips = writtenPeople(doctors.value);
      mount(doctorChips, chips);
      doctorsBox.classList.toggle('has-people', chips.length > 0);
    };
    doctors.addEventListener('change', drawDoctors);
    drawDoctors();
    // After the checkup the assistant fills in the checkup form from the row itself (owner, 15 Oct 2026: "once the checkup is done, the
    // assistant should have options to enter all the details"; it is in Options too). It sits in the Month cell, which a checkup leaves
    // empty: next to the name, so it is in sight on a phone as well. Gone once the form is filled in (Options shows the answers then).
    const formBtn = canEdit && !formComplete(c) ? h('button', {
      type: 'button', class: 'chip chip-fill form-later', 'aria-haspopup': 'dialog', 'aria-label': `Fill in form for ${who}`,
      title: 'Fill in the checkup form, after the checkup', dataset: { focus: 'form' }, onclick: () => fillCheckupForm(c),
    }, 'Fill in form') : null;
    // No "Checkup" badge (owner, 11 Oct 2026: no flags on the list): as on the sheet, the row without an Mr# is the checkup
    // patient ("no Mr#" in the MR # cell), with a thin left edge here; a screen reader hears it with the name.
    return h('tr', { class: 'is-checkup', dataset: { id: c.id, kind: 'checkup', n } },
      !branchId ? h('td', { class: 'branch-cell' }, cellText(branchName(c.branch_id))) : null,
      h('td', { class: 'rownum' }, n),
      h('td', { class: 'mr-cell frozen' }, cellText(c.patient_id
        ? h('a', { class: 'mr', href: `#/staff/patient/${c.patient_id}`, title: 'Open the patient file' }, mr ? [srOnly('Mr# '), mr] : 'File')
        : h('span', { class: 'muted' }, 'no Mr#'))),
      h('th', { scope: 'row', class: 'frozen row-head name-col' }, h('div', { class: ['name-cell', c.patient_id && can('billing.create') && 'has-bill'] },
        nameIn,
        srOnly('Checkup patient'),
        // Registered (a patient file): Bill beside the name, as on a patient's row.
        c.patient_id && can('billing.create') ? h('button', {
          type: 'button', class: 'bill-btn', 'aria-haspopup': 'dialog', 'aria-label': `Bill ${who}`, title: 'Bill: invoice, payment and the printed bill',
          dataset: { focus: 'bill' }, onclick: () => billCheckup(c),
        }, 'Bill') : null,
        h('button', { type: 'button', class: 'kebab-btn', 'aria-haspopup': 'dialog', 'aria-label': `Checkup options for ${who}`, title: 'Options: checkup form, follow-up, notes, register, remove', dataset: { focus: 'options' }, onclick: () => checkupOptions(c) },
          h('span', { 'aria-hidden': 'true' }, '⋮')))),
      h('td', {}, formBtn || h('span', { class: 'chip chip-fill gs-grey' }, srOnly('Not braces'))),
      h('td', {}, typedCell(text('checkup_for', 'Treatment', { list: 'sheet-treatments', class: 'cell-input center' }))),
      h('td', {}, typedCell(tokenIn)),
      h('td', {}, status),
      // (a checkup patient sees no braces group: a dash, not an empty cell that looks forgotten)
      h('td', { class: 'center' }, h('span', { class: 'no-group', title: 'Checkup patients have no group' }, h('span', { 'aria-hidden': 'true' }, '—'), srOnly('Checkup patients have no group'))),
      h('td', {}, doctorsBox),
      h('td', {}, typedCell(text('details', 'Treatment details', { placeholder: 'e.g. Scaling advised', title: c.details || null }))),
      h('td', { class: 'pp' }),
      canBill ? h('td', {}) : null,
      h('td', {}, typedCell(text('phone', 'Phone', { type: 'tel', onchange: (e) => saveCheckup(c, 'phone', e.target.value), oninput: null }))),
      h('td', {}, reminderCell()));
  }

  // A row's button that had the cursor is drawn new (replaceRow), and so can be any control when the person's own change
  // draws the list (a patient added from a dialog, say), so remember the focused control (row + data-focus key + caret, and
  // typed text the cell has not saved yet) and put focus back on the same control in the new row, or on "+" when a removed
  // chip had it. A new cell is drawn from the row's data, which does not have that typed text yet: it is put back in, and
  // the cell saves it.
  function rememberFocus() {
    const el = document.activeElement;
    if (!el || !tableBody.contains(el)) return null;
    let caret = null;
    try { if (typeof el.selectionStart === 'number') caret = [el.selectionStart, el.selectionEnd]; } catch { /* not a text field */ }
    const tr = el.closest('tr');
    return { rowId: tr?.dataset.id, kind: tr?.dataset.kind || '', key: el.dataset.focus, caret, typed: el === unsavedCell ? el.value : null };
  }
  function restoreFocus(saved) {
    const tr = saved && [...tableBody.querySelectorAll('tr[data-id]')].find((t) => t.dataset.id === saved.rowId && (t.dataset.kind || '') === saved.kind);
    if (!tr) return;
    const target = (saved.key && [...tr.querySelectorAll('[data-focus]')].find((el) => el.dataset.focus === saved.key))
      || tr.querySelector('[data-focus="add-person"]') || tr.querySelector('[data-focus="patient"]') || tr.querySelector('[data-focus="name"]');
    target?.focus({ preventScroll: true });
    if (saved.typed !== null) {
      unsavedCell = null; // (the cell that had it is gone)
      if (target?.dataset.focus === saved.key && target.value !== saved.typed) {
        target.value = saved.typed;
        target.dispatchEvent(new Event('change', { bubbles: true })); // (saved through the cell's own handler, as on leaving it)
      }
    }
    if (saved.caret && target?.setSelectionRange) { try { target.setSelectionRange(saved.caret[0], saved.caret[1]); } catch { /* not a text field */ } }
  }
  // A click on a cell with no control in it (Token, #, P.P, an empty Month) leaves the cursor on no control, and the next
  // Tab starts from the place clicked (the browser keeps it, with the caret of the selection there). A row drawn new loses
  // that place, and the next Tab would go to the first row and scroll the list there: the place is put back in the same
  // cell of the new row. (Chrome starts the next Tab after the element that last had the focus, so the cell has it for a
  // moment, without scrolling; the caret goes back there too.)
  function tabPlace() {
    if (document.activeElement && document.activeElement !== document.body) return null;
    const node = window.getSelection()?.anchorNode;
    const cell = node && tableBody.contains(node) ? (node.nodeType === 1 ? node : node.parentElement).closest('td, th') : null;
    const key = cell && rowKey(cell);
    return key ? { key, col: [...cell.parentElement.children].indexOf(cell) } : null;
  }
  function putTabPlace(place) {
    const cell = place && [...tableBody.children].find((tr) => rowKey(tr) === place.key)?.children[place.col];
    const sel = window.getSelection();
    if (!cell || cell.contains(sel.anchorNode) || (document.activeElement && document.activeElement !== document.body)) return;
    cell.tabIndex = -1;
    cell.focus({ preventScroll: true });
    cell.blur();
    cell.removeAttribute('tabindex');
    sel.collapse(cell, 0);
  }

  // Draw one row again after a save (make = rowEl for a visit, checkupRowEl for a checkup patient): it keeps its place and
  // its row number, whatever its status is now (only draw sorts the list; settle asks for that once the person is done).
  function redrawRow(row, make = rowEl) {
    listVersion++; // (a change made here: a reload asked for before it would take it off the screen, see load)
    replaceRow(row, make);
    settle({ row, checkup: make === checkupRowEl });
    noteWaiting();
    drawCounts();
    markInvalid();
  }
  // The row with the cursor is never taken out of the table: its other cells are drawn new around the cell with the cursor,
  // which stays as it is when the cursor is in a field (typed text not saved yet, the caret, a status or group chosen with
  // the arrow keys and not saved yet: only Enter or leaving the field saves that, and Escape undoes it). A button with the
  // cursor (a chip's ×, the name, "+") is drawn new with its cell, and the cursor goes to the new one (or to "+").
  function replaceRow(row, make) {
    const checkup = make === checkupRowEl;
    const old = [...tableBody.querySelectorAll('tr[data-id]')].find((t) => t.dataset.id === String(row.id) && (t.dataset.kind === 'checkup') === checkup);
    if (!old) return;
    drawnData.set(`${checkup ? 'c' : 'v'}:${row.id}`, JSON.stringify(row));
    const tr = make(row, Number(old.dataset.n) || old.sectionRowIndex + 1);
    const focused = old.contains(document.activeElement) ? document.activeElement : null;
    if (focused && old.children.length === tr.children.length) {
      const keep = focused.matches('input, select, textarea') ? [...old.children].find((cell) => cell.contains(focused)) : null;
      const saved = keep ? null : rememberFocus();
      const cells = [...old.children];
      [...tr.children].forEach((cell, i) => { if (cells[i] !== keep) cells[i].replaceWith(cell); });
      old.className = tr.className;
      restoreFocus(saved);
      countHiddenPeople(old);
    } else {
      const saved = focused ? rememberFocus() : null;
      const place = tabPlace();
      old.replaceWith(tr);
      restoreFocus(saved);
      putTabPlace(place);
      countHiddenPeople(tr);
    }
  }

  // On a laptop the Doctor Name chips that do not fit drop out of sight whole (app.css): the cell's "+" then says how many
  // ("+2") and its tooltip who, and their × is out of the Tab order (it cannot be seen; the "+" dialog removes them).
  // (All the reads first, then the writes: one layout for the whole list.)
  function countHiddenPeople(scope = tableBody) {
    const cells = [...scope.querySelectorAll('.people')].map((cell) => {
      const chips = [...cell.querySelectorAll('.person')];
      return [cell.querySelector('.people-count'), chips.filter((c) => c.offsetTop > chips[0].offsetTop), chips];
    });
    for (const [count, hidden, chips] of cells) {
      for (const chip of chips) {
        const x = chip.querySelector('.chip-remove');
        const tab = hidden.includes(chip) ? -1 : 0;
        if (x && x.tabIndex !== tab) x.tabIndex = tab;
      }
      if (!count) continue;
      const host = count.closest('button') || count;
      const text = hidden.length ? `+${hidden.length}` : count.dataset.plain;
      if (count.textContent !== text) count.textContent = text;
      host.title = [hidden.length ? `Also on this visit: ${hidden.map((c) => c.title).join(', ')}.` : '', host.dataset.title].filter(Boolean).join(' ');
    }
  }

  function drawCounts() {
    const checks = checkupsMissing ? [] : dayListCheckups(checkups, rows);
    const count = (s) => rows.filter((r) => r.status === s).length + checks.filter((c) => c.day_status === s).length;
    const current = checkupsOnly ? 'checkups' : filter;
    // Waiting, In treatment and Completed always; Scheduled, Cancelled and No show when there are any.
    const statuses = ['waiting', 'in_treatment', 'completed', 'scheduled', 'cancelled', 'no_show']
      .filter((s, i) => i < 3 || count(s) || s === current).map((s) => [s, STATUS_LABELS[s], count(s)]);
    const items = [['', 'All', rows.length + checks.length], ...statuses, ...(checkupsMissing ? [] : [['checkups', 'Checkups', checks.length]])];
    const focused = countsBox.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    mount(countsBox, items.map(([key, label, n]) => h('button', {
      type: 'button', class: 'count-chip', 'aria-pressed': String(current === key), dataset: { key }, onclick: () => quickFilter(key),
    }, key && key !== 'checkups' ? h('span', { class: `count-dot gs-${statusTone(key)}`, 'aria-hidden': 'true' }) : null, h('span', {}, label, ' ', h('strong', {}, n)))));
    if (focused !== null) [...countsBox.children].find((b) => b.dataset.key === focused)?.focus();
  }

  // The sheet's columns in the sheet's order (owner, 11 Oct 2026: "the columns of google sheet should be same here too").
  // "Reminder Status", the sheet's last column, is empty on every tab of the sheet, so it is an empty chip on every row
  // here too (reminderCell). What it is to hold waits for the clinic to start using it: the Google Sheet sync already keeps
  // the sheet's reminder text (private.aaj_visit_text.reminder), and the coordinator has the patients' reminders.
  const colgroup = h('colgroup', {});
  const columns = () => [!branchId && 'branch', 'num', 'mr', 'name', 'month', 'treatment', 'token', 'status', 'group', 'doctor', 'details', 'pp', canBill && 'invoice', 'contact', 'reminder']
    .filter(Boolean).map((k) => h('col', { class: `c-${k}` }));

  // The whole list, sorted like the sheet (listOrder): only here do rows move. It runs at once for the person's own changes
  // to what the list shows (a filter, another day or branch, a patient they add or remove), and otherwise only once they
  // are not working in the table ("When the rows move", at the top). Every row is numbered 1..n in the order shown, like
  // the sheet's row numbers (owner, 11 Oct 2026; COMPLETED_OWN_COUNT, at the top); that is not the token, which repeats
  // from one kind of treatment to another. The list and the page stay scrolled where they were.
  function draw() {
    drawHeld = false;
    branchHead.hidden = !!branchId;
    mount(colgroup, columns());
    addPanel.hidden = !branchId || !search;
    // "+ Add checkup patient" only where checkups exist (the database update has been run) and for today or an earlier day.
    checkupBtn.hidden = checkupsMissing || date > localISO() || !can('sheet.edit');
    // (a later day, such as the one "End the day" opens: patients added there are booked for that day, day-end.js)
    addHint.textContent = date > localISO() ? laterDayHint(date) : checkupBtn.hidden ? ADD_HINT_PLAIN : ADD_HINT_CHECKUP;
    drawWarning();
    const inUse = [filter && !checkupsOnly, doctorFilter, groupFilter, duesOnly, bracesOnly].filter(Boolean).length;
    filterBtn.textContent = inUse ? `Filters (${inUse})` : 'Filters';
    const items = [...rows.filter(matches).map((row) => ({ row, checkup: false })), ...shownCheckups().map((row) => ({ row, checkup: true }))]
      .map((item) => ({ ...item, rank: rankOf(item), token: tokenOf(item) })).sort(listOrder);
    placed = new Map(items.map((item) => [keyOf(item), { rank: item.rank, token: item.token }]));
    drawnKey = rowsKey;
    // Nothing to draw when the rows on screen are these, in this order, drawn from this data (the 20-second check of a quiet
    // list, say): the rows stay as they are, with the person's place in them.
    const order = [branchId, ...items.map(keyOf)].join(' ');
    const json = items.map((item) => JSON.stringify(item.row));
    if (order !== drawnOrder || items.some((item, i) => drawnData.get(keyOf(item)) !== json[i])) {
      drawnOrder = order;
      drawnData = new Map(items.map((item, i) => [keyOf(item), json[i]]));
      const saved = rememberFocus();
      const place = tabPlace();
      const wrap = tableBody.closest('.sheet-wrap');
      const scrolled = [wrap?.scrollTop, wrap?.scrollLeft, window.scrollX, window.scrollY];
      let n = 0;
      let done = 0;
      const serial = (item) => (COMPLETED_OWN_COUNT && item.rank === STATUS_RANK.completed ? ++done : ++n);
      mount(tableBody, items.length ? items.map((item) => (item.checkup ? checkupRowEl(item.row, serial(item)) : rowEl(item.row, serial(item))))
        : h('tr', {}, h('td', { class: 'empty-cell', colspan: colgroup.children.length }, h('div', { class: 'empty' }, branchId ? `No patients or checkups on the list for ${branchName(branchId)} on this day yet. Use "Add a patient" to add them.` : 'No patients or checkups on any list for this day.'))));
      restoreFocus(saved);
      putTabPlace(place);
      countHiddenPeople();
      fit();
      if (wrap) { wrap.scrollTop = scrolled[0]; wrap.scrollLeft = scrolled[1]; }
      if (window.scrollX !== scrolled[2] || window.scrollY !== scrolled[3]) window.scrollTo(scrolled[2], scrolled[3]);
    } else fit();
    noteNewRows(0);
    drawCounts();
    markInvalid();
  }

  // Arrow keys / Enter move between cells like a spreadsheet (Enter keeps what was typed: leaving the cell saves it), to the
  // nearest row above or below with a typing cell in this column: rows are sorted by status, so a checkup patient's name or
  // token (typing cells) can have a patient row (a name button, a token number) next to it; that row is passed over.
  // In the patient the add line has just put the cursor in (an Mr# and Enter: its Treatment cell), and in the last row,
  // Enter goes to the add box, the sheet's next empty row, so the next Mr# is typed there and not over the row below (a
  // checkup row's cells save as they are typed); Arrow Down still goes on down.
  function onKey(e) {
    if (!['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key) || !e.target.classList.contains('cell-input')) return;
    const td = e.target.closest('td, th'); // (the name of a checkup patient sits in the row header)
    const tr = td.parentElement;
    const col = [...tr.children].indexOf(td);
    const step = (t) => (e.key === 'ArrowUp' ? t.previousElementSibling : t.nextElementSibling);
    let target = step(tr);
    while (target && !target.children[col]?.querySelector('.cell-input')) target = step(target);
    if (e.key === 'Enter' && (!target || rowKey(tr) === fromAddLine)) {
      const box = search?.querySelector('input');
      // (leaving the cell saves it, as a click elsewhere would; without the add line, all branches, the cursor stays)
      if (box && !addPanel.hidden) { e.preventDefault(); box.focus(); }
      return;
    }
    const next = target?.children[col]?.querySelector('.cell-input');
    if (next) { e.preventDefault(); next.focus(); next.select?.(); }
  }

  const focusCell = (id, key) => {
    const el = [...tableBody.querySelectorAll(`tr[data-id="${id}"] [data-focus]`)].find((x) => x.dataset.focus === key);
    if (el) { el.focus(); el.select?.(); }
  };

  // A patient who is on this branch's list for the day already: their row.
  const onList = (p) => (branchId ? rows.find((r) => r.patient_id === p.id && r.branch_id === branchId) : null);
  // The same, asked of the server too when they are not among the rows on screen: those can be a little behind on a busy
  // day (a reload waits while someone types in the list), and another computer or the Google Sheet sync may have just put
  // the patient on the list; the Mr# must not give them a second row. Their row is put on this list then. (One small read:
  // that patient's visits of the day.)
  async function onListNow(p) {
    if (!branchId || onList(p)) return onList(p);
    const theirs = (await d.listVisits({ branchId, date, patientId: p.id }))
      .filter((r) => r.patient_id === p.id && r.branch_id === branchId && !rows.some((x) => x.id === r.id));
    if (theirs.length) { rows.push(...theirs); listVersion++; drawAdded(); }
    return onList(p);
  }
  const onListText = (r) => `${r.patient.full_name} is already on the list${r.token_no ? ` (token ${r.token_no})` : ''}`;
  // The cursor from the add line to a row's cell (the filters are cleared when they hide the row); Enter in that row goes
  // back to the add box (onKey).
  function goToRow(row, key) {
    if (!tableBody.querySelector(`tr[data-id="${row.id}"]`)) { findBox.value = ''; textFilter = ''; clearFilters(); }
    fromAddLine = keyOf({ row, checkup: false });
    focusCell(row.id, key);
  }
  // Picked from the matches but already on the list: go to their row, or (a second visit on the same day) add another row.
  function addAgain(there) {
    let again = false;
    return new Promise((resolve) => modal(onListText(there), h('p', {},
      `${STATUS_LABELS[there.status] || there.status}. Add another row only for a second visit on the same day.`), [
      { label: 'Go to the row', primary: true },
      { label: 'Add another row', onClick: () => { again = true; } },
    ], { onClose: () => { if (!again) goToRow(there, 'status'); resolve(again); } }));
  }

  // (treatment: what a person who was a checkup patient came for, when they are put on the list as a patient.
  //  fast: added by typing the Mr# and Enter (addByMr has checked the list): no guidance dialog.)
  async function addPatient(p, treatment, { fast = false } = {}) {
    try {
      const there = fast ? null : await onListNow(p);
      if (there && !(await addAgain(there))) return null;
      const braces = !!p.braces_active;
      const row = await d.addVisit({ patient_id: p.id, branch_id: branchId, visit_date: date, treatment_label: braces ? 'Monthly' : (treatment || 'Checkup'), braces, status: date === localISO() ? 'waiting' : 'scheduled' });
      // (by its id: a reload that read the list after the insert, or the live echo of it, can have brought this visit already)
      rows = [...rows.filter((r) => r.id !== row.id), row];
      listVersion++;
      drawAdded();
      toast(row.visit_date > localISO() ? bookedFor(p.full_name, row.visit_date) : `${p.full_name} added${row.token_no ? ` with token ${row.token_no}` : ''}.`, 'ok');
      if (!fast && row.braces_month) openRow(row);
      return row;
    } catch (e) { toast(notSaved(e, `${p.full_name} was not added to the list.`), 'error', 8000); return null; }
  }

  // After an Mr# and Enter the cursor moves to the patient's row, unless the person has gone on meanwhile: pressed Enter in
  // the add box again since (an add that comes back after the next Enter finds the box empty, but the cursor must stay for
  // the Mr# being typed), started typing there, or is working elsewhere. (ticket: the enterSeq of this Enter. One task is
  // let by first, so keys typed while the list was being drawn reach the box before it is looked at.)
  let enterSeq = 0;
  const cursorFree = async (ticket) => {
    await new Promise((r) => setTimeout(r));
    const box = search?.querySelector('input');
    return ticket === enterSeq && (!document.activeElement || document.activeElement === document.body || (document.activeElement === box && !box.value.trim()));
  };
  // An Mr# typed for a patient who is on the list already: no second row, the cursor goes to theirs. A booked patient
  // (Scheduled on today's list) has come, so is marked Waiting and gets a token, as the front desk would do next.
  async function arrived(there, ticket) {
    const who = there.patient.full_name;
    if (there.status === 'scheduled' && date === localISO()) {
      try {
        redrawRow(merge(there, await d.updateVisit(there.id, { status: 'waiting' })));
        toast(`${who} was booked: now Waiting${there.token_no ? ` with token ${there.token_no}` : ''}.`, 'ok');
        if (await cursorFree(ticket)) goToRow(there, 'treatment');
      } catch (e) {
        toast(notSaved(e, `${who} is still "Scheduled".`), 'error', 8000);
        if (await cursorFree(ticket)) goToRow(there, 'status');
      }
      return;
    }
    toast(`${onListText(there)}.`, 'info', 6000);
    if (await cursorFree(ticket)) goToRow(there, 'status');
  }

  // A busy day: typing an exact Mr# and pressing Enter adds that patient at once, when exactly one patient has that Mr#.
  // Anything else (a name, a phone, an Mr# that is not unique) shows the matches to choose from, as before.
  const addingMr = new Set(); // Mr#s on their way: the same Mr# typed again meanwhile must not add the patient twice
  async function addByMr(text) {
    const ticket = ++enterSeq; // (any Enter in the add box counts, a name too)
    if (!/^\d{1,9}$/.test(text)) return false;
    if (addingMr.has(text)) return true;
    addingMr.add(text);
    try {
      let found;
      try { found = (await d.searchPatients(text)).filter((p) => String(p.mr_number) === text); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      if (found.length !== 1) return false;
      let there;
      try { there = await onListNow(found[0]); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      if (there) { await arrived(there, ticket); return true; }
      const row = await addPatient(found[0], undefined, { fast: true });
      if (!row) return false; // (not added: the Mr# comes back in the box to try again)
      if (await cursorFree(ticket)) goToRow(row, 'treatment'); // (a filter that hides the new row is cleared)
      return true;
    } finally { addingMr.delete(text); }
  }

  const search = canEdit ? patientSearch({
    placeholder: 'Name, Mr# or phone',
    label: 'Add a patient to this list: search name, Mr# or phone. An exact Mr# and Enter adds the patient at once.',
    onPick: addPatient,
    onNew: async (text) => { const p = await newPatientModal(text, branchId); if (p) addPatient(p); },
    onEnter: addByMr,
  }) : null;

  const branchHead = h('th', { scope: 'col', class: 'branch-cell', hidden: true }, 'Branch');
  // A person who only comes for a checkup gets no Mr#: "+ Add checkup patient" puts them on this list and on the Checkups page. On today's
  // list only the name and the mobile number are asked (owner, 15 Oct 2026), as Waiting; "Fill in form" on their row asks the checkup form
  // after the checkup. An earlier day's list asks the whole form (nobody arrives there: it is filled in afterwards).
  // A patient who starts treatment and is new gets an Mr# with "+ New walk-in".
  const ADD_HINT_PLAIN = 'Search by name, Mr# or phone. New walk-in? Register them here. To book an appointment, pick that date above first.';
  const ADD_HINT_CHECKUP = 'New and starting treatment? Use "+ New walk-in" (gets an Mr#). Only a checkup? Use "+ Add checkup patient" (no Mr#).';
  const addHint = h('span', { class: 'muted' }, ADD_HINT_PLAIN);
  const checkupBtn = h('button', { class: 'btn btn-small', type: 'button', hidden: true, 'aria-haspopup': 'dialog', onclick: async () => {
    const today = date === localISO();
    const res = await (today ? quickCheckupModal({ branchId, branchFixed: true, fileAction: 'add' }) : checkupFormModal({ branchId, date, fixedDay: true }));
    if (!res) return;
    if (res.patient) { addPatient(res.patient); return; } // the person already has a patient file: put that file on the list instead
    if (res.updated) { // the person was on this list already: the answers went on that checkup
      checkups = checkups.map((c) => (c.id === res.updated.id ? res.updated : c));
      listVersion++;
      draw();
      toast(`Answers saved on ${res.updated.patient_name}'s checkup.`, 'ok');
      return;
    }
    checkups = [...checkups.filter((c) => c.id !== res.id), res]; // (by its id, as addPatient)
    listVersion++;
    drawAdded();
    // (today: Waiting, the form is filled in after the checkup with "Fill in form" on the row)
    toast(today ? `${res.patient_name} added to today's list for ${branchName(res.branch_id)}.` : `${res.patient_name} added as a checkup patient.`, 'ok');
  } }, '+ Add checkup patient');
  // The add line. It comes before the list in the page, so the keyboard reaches it from the toolbar in a few Tabs; on a
  // laptop app.css shows it under the list like the sheet's next empty row, in sight at the bottom on a long day. On a phone
  // it stays above the list: the page scrolls there, and the end of a 120-patient list is far down.
  const addPanel = search ? h('div', { class: 'add-panel' },
    h('span', { class: 'add-label' }, 'Add a patient'),
    search,
    can('patients.create') ? h('button', { class: 'btn btn-small btn-primary', type: 'button', onclick: async () => { const p = await newPatientModal('', branchId); if (p) addPatient(p); } }, '+ New walk-in') : null,
    checkupBtn,
    h('div', { class: 'add-panel-text' }, addHint)) : h('div', { hidden: true });
  const warnBox = h('div', { class: 'alert alert-warning', role: 'status', hidden: true });
  function drawWarning() {
    const text = checkupsWarn ? `Checkup patients could not be loaded: ${checkupsWarn}` : '';
    if (warnBox.textContent === text && warnBox.hidden === !text) return;
    warnBox.hidden = !text;
    warnBox.textContent = text;
    warnBox.title = text; // (one line: the whole text is in the tooltip, and read out)
  }
  // No internet connection (load-shedding). On a laptop the staff pages' banner above the top bar would push the list down
  // at any moment, so app.css hides it on this page and the line of the counts says it instead (the staff pages announce
  // it too). On a phone the banner stays and this line is not shown.
  const OFFLINE_TEXT = 'No internet connection: typing in the cells is kept on this device. Status, group, doctor and new-patient changes need the connection.';
  const offlineBox = h('div', { class: 'alert alert-warning sheet-offline', title: OFFLINE_TEXT, hidden: navigator.onLine }, OFFLINE_TEXT);
  for (const ev of ['online', 'offline']) window.addEventListener(ev, () => { offlineBox.hidden = navigator.onLine; }, { signal: life.signal });
  // Rows another computer (or the Google Sheet, or an add that came back late) has put on the list while the person works in
  // the table, and rows whose status changed meanwhile: they come in at (or go to) their place in the order once the
  // person is done ("When the rows move", at the top), that is once the cursor has left the list or rested there a while.
  // Said quietly, in a few words, for as long as they wait (noteWaiting).
  const newRowsNote = h('span', { class: 'sheet-new-rows', role: 'status' });
  function noteNewRows(fresh = 0, moved = 0) {
    const several = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const text = fresh && moved ? `${several(fresh, 'new row')} and ${several(moved, 'row')} with a new status: they go to their place when you leave the list`
      : fresh ? `${fresh} new row${fresh === 1 ? ', it appears' : 's, they appear'} when you leave the list`
        : moved ? `${several(moved, 'row')} with a new status ${moved === 1 ? 'goes to its' : 'go to their'} place when you leave the list` : '';
    if (newRowsNote.textContent !== text) { newRowsNote.textContent = text; newRowsNote.title = text; } // (cut short on a narrow line: whole in the tooltip)
  }
  // A reload in the background: live updates, the 20-second check, a save the server refused. What it brings waits to be
  // drawn while the person is working in the table (load); a hidden tab reloads when it comes back.
  function reloadQuietly() {
    if (life.signal.aborted || document.hidden) return;
    load({ quiet: true });
  }
  document.addEventListener('sheet-reload', reloadQuietly, { signal: life.signal });
  // Live: reload the moment anyone changes this branch's list.
  let liveTimer = null;
  let stopLive = null;
  let stopLiveCheckups = null; // the Google Sheet sync (and other staff) add and change checkup rows too
  const onLive = () => { clearTimeout(liveTimer); liveTimer = setTimeout(reloadQuietly, 300); };
  const listen = () => {
    stopLive?.(); stopLiveCheckups?.();
    stopLive = d.subscribeVisits ? d.subscribeVisits(branchId || null, onLive) : null;
    stopLiveCheckups = d.subscribeCheckups && !checkupsMissing ? d.subscribeCheckups(branchId || null, onLive) : null;
  };
  branchSel.addEventListener('change', listen);
  document.addEventListener('visibilitychange', reloadQuietly, { signal: life.signal });
  // Safety net: also check every 20 seconds while the tab is visible.
  const poll = setInterval(() => {
    if (!document.body.contains(tableBody)) { stop(); return; }
    reloadQuietly();
  }, 20000);
  function stop() {
    life.abort();
    clearInterval(poll);
    clearTimeout(liveTimer);
    clearTimeout(freeTimer);
    clearTimeout(undoTimer);
    stopLive?.();
    stopLive = null;
    stopLiveCheckups?.();
    stopLiveCheckups = null;
    if (saveUI === ui) saveUI = null;
    if (stopPrevious === stop) stopPrevious = null;
  }
  stopPrevious = stop;
  signal?.addEventListener('abort', stop, { once: true });

  const statusHint = srOnly('Choose a status with the arrow keys, then press Enter or move to the next cell to save it. Escape undoes a status that is not saved yet.');
  statusHint.id = 'sheet-status-hint';
  // A ▾ in a column heading opens the filter for that column, like the filter buttons of the sheet.
  const heading = (label, props = {}) => h('th', { scope: 'col', ...props }, label);
  const filterHeading = (label, control, what, props = {}) => h('th', { scope: 'col', ...props }, h('span', { class: 'th-label' }, label),
    h('button', { type: 'button', class: 'th-filter', 'aria-label': what, title: what, onclick: () => showFilters(true, control) }, h('span', { 'aria-hidden': 'true' }, '▾')));
  // "End the day" (owner, 12 Oct 2026): a copy of the whole day's list (whatever the filters show) goes to the History of
  // Aaj ki List, then the next day's list opens (today's, when an earlier day was ended). Nothing on this day's list is changed or locked.
  const dayEnd = dayEndControls({
    getList: () => ({ branchId, date, pending: q.pendingCount || 0, failed: failedEdits().length,
      rows: [...rows.map((r) => ({ kind: 'patient', status: r.status })), ...dayListCheckups(checkups, rows).map((c) => ({ kind: 'checkup', status: c.day_status || null }))] }),
    onEnded: async (next) => { date = next; dateInput.value = date; setURL(); await load(NEW_LIST); dateInput.focus(); },
  });
  // (small, as the other buttons of the page head)
  for (const el of [dayEnd.historyLink, dayEnd.button]) el.classList.add('btn-small');
  const page = h('div', { class: 'sheet-page' },
    h('div', { class: 'sheet-head' },
      h('h1', {}, 'Aaj ki List'),
      h('div', { class: 'sheet-toolbar' }, branchSel, dateInput,
        h('button', { type: 'button', class: 'btn btn-small', onclick: () => { date = localISO(); dateInput.value = date; setURL(); load(NEW_LIST); } }, 'Today'),
        findBox, filterWrap),
      h('div', { class: 'sheet-tools' },
        h('a', { class: 'btn btn-small', href: `#/staff/queue?branch=${branchId || ''}` }, 'Queue board'),
        dayEnd.historyLink, dayEnd.button, dayEnd.hint,
        can('export.data') || can('finance.view') ? h('button', { type: 'button', class: 'btn btn-small', onclick: download }, 'Download') : null)),
    // The bars that come and go (the changes not saved, the Undo of a removal, a warning, no connection) never cover the
    // list or the save status. On a laptop they are on the line of the counts, in the room between the counts and the save
    // status, with the note of new rows (app.css .sheet-slot): one line that never changes its height, so they never move
    // the rows (the changes not saved take the save status's place there). On a phone they are on lines of their own under
    // the counts, in the page's flow. The note of an ended day is under the list on a laptop, above the add line.
    h('div', { class: 'sheet-subhead' }, countsBox, h('div', { class: 'sheet-slot' }, newRowsNote, h('div', { class: 'sheet-bars' }, failBox, undoBox, warnBox, offlineBox)), saveStatus),
    dayEnd.note,
    statusHint,
    // The visit types (the price list is for invoices: treatments.price_list).
    h('datalist', { id: 'sheet-treatments' }, state.ref.treatments.filter((t) => !t.price_list).map((t) => h('option', { value: t.name }))),
    h('datalist', { id: 'sheet-doctors' }, state.ref.clinicians.filter((c) => c.is_doctor).map((c) => h('option', { value: c.display_name }))),
    addPanel,
    h('div', { class: 'sheet-wrap', onkeydown: onKey },
      mount(sheetTable,
        colgroup,
        h('thead', {}, h('tr', {},
          branchHead,
          heading('#', { class: 'rownum', title: 'Row number' }),
          heading('MR #', { class: 'frozen mr-cell' }),
          heading('Patient Name', { class: 'frozen name-col' }),
          filterHeading('Month', bracesBox, 'Show only braces patients'),
          heading('Treatment', { class: 'center' }),
          heading('Token', { class: 'center' }),
          filterHeading('Status', filterSel, 'Filter by status'),
          filterHeading('Group', groupSel, 'Filter by doctor group'),
          filterHeading('Doctor Name', doctorSel, 'Filter by doctor'),
          heading('Treatment Details'),
          can('dues.view') ? filterHeading('P.P', duesBox, 'Show only patients with dues', { class: 'pp pp-head', title: 'Pending dues' }) : heading('P.P', { class: 'pp pp-head', title: 'Pending dues' }),
          canBill ? heading('Invoice') : null,
          heading('Contact No'),
          heading('Reminder Status', { title: 'Reminder Status: empty on the sheet too, until the clinic starts using it' }))),
        tableBody)));
  // Working in the list ("When the rows move", at the top): a key, a press or the mouse wheel anywhere in its box, which
  // holds its scroll bar too (scrolling to the next patient is working in it).
  for (const ev of ['keydown', 'pointerdown', 'input', 'wheel']) sheetTable.parentElement.addEventListener(ev, touched, { passive: true });
  // On a laptop or bigger screen the list fills the window to its bottom edge, so the header row stays at the top and the
  // add line at the bottom while the rows scroll; app.css sizes .sheet-page from where it starts (--sheet-top).
  function fit() {
    if (page.isConnected) page.style.setProperty('--sheet-top', `${Math.max(0, Math.round(page.getBoundingClientRect().top + window.scrollY))}px`);
  }
  for (const ev of ['resize', 'online', 'offline']) window.addEventListener(ev, fit, { signal: life.signal });
  let recount = 0; // (a wider or narrower window fits more or fewer Doctor Name chips)
  window.addEventListener('resize', () => { cancelAnimationFrame(recount); recount = requestAnimationFrame(() => countHiddenPeople()); }, { signal: life.signal });
  mount(root, page);
  fit();

  if (busyDemo) {
    try { await d.fillBusyDay({ branchId: branchId || defaultBranchId(), date: localISO() }); } catch (e) { toast(friendlyError(e), 'error'); }
  }
  await load(NEW_LIST);
  if (!signal?.aborted) listen(); // after the first load, which tells whether checkups exist at all
  q.setOnline(navigator.onLine);
  $$('.cell-input', root)[0]?.blur();
}
