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
import { dayListCheckups } from '../../lib/checkups.js';
import { checkupFormModal, registerCheckupModal, removeCheckupModal, canRemoveCheckup, canRegisterCheckup, followUpSelect, registeredMr } from './checkup-actions.js';

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
// (All branches view: by branch first.) Each item is { row, checkup, rank }: draw() works out the rank (see there).
const STATUS_RANK = { waiting: 0, in_treatment: 1, scheduled: 2, '': 3, completed: 4, cancelled: 5, no_show: 6 };
const rankOf = (item) => STATUS_RANK[(item.checkup ? item.row.day_status : item.row.status) || ''] ?? 3;
const tokenOf = (item) => (item.checkup ? tokenNo(item.row) : item.row.token_no ?? Infinity);
const listOrder = (a, b) => (a.row.branch_id ?? 0) - (b.row.branch_id ?? 0)
  || a.rank - b.rank
  || Number(a.checkup) - Number(b.checkup)
  || byNumber(tokenOf(a), tokenOf(b))
  || String(a.row.created_at || '').localeCompare(String(b.row.created_at || ''));
// A row of the list as a key, the same for every copy of it the list draws (visits and checkups are told apart).
const keyOf = (item) => `${item.checkup ? 'c' : 'v'}:${item.row.id}`;

// ---------------------------------------------------------------- the sheet's chip colours
// The chip colours of the clinic's Google Sheet (app.css .gs-*). A chip always carries its text too, so colour is never the only cue.
const STATUS_TONE = { completed: 'yellow', in_treatment: 'green', scheduled: 'blue', waiting: 'orange', cancelled: 'grey', no_show: 'red' };
const GROUP_TONE = { 1: 'blue', 2: 'green', 3: 'purple', 4: 'darkred' };
export const statusTone = (status) => STATUS_TONE[status] || 'grey';
export const groupTone = (group) => GROUP_TONE[group] || 'grey';
// One colour per doctor, as the clinic's sheet has them (matched on the name without "Dr."). Anyone else gets a colour
// picked from their id, so it is the same on every row and every day.
const DOCTOR_TONES = [['hameeda', 'green'], ['komal rubab', 'red'], ['mirha', 'orange'], ['haniya', 'brown'], ['ali ahmed', 'darkred'],
  ['mehwish saleem', 'blue'], ['aimon aslam', 'purple'], ['anousha khan', 'teal']];
const OTHER_TONES = ['green', 'red', 'orange', 'blue', 'purple', 'teal', 'yellow'];
export function doctorTone(id, name) {
  const key = String(name || '').toLowerCase().replace(/^dr\b\.?/, '').replace(/[^a-z]+/g, ' ').trim();
  const known = DOCTOR_TONES.find(([k]) => key === k || key.startsWith(`${k} `));
  if (known) return known[1];
  let hash = 0;
  for (const ch of String(id || name || '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return OTHER_TONES[hash % OTHER_TONES.length];
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
// What a patient's medical history says, on one line (the flag beside the name, and the row's dialog).
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
  let checkupsMissing = false; // the database update for checkups has not been run yet: no checkup rows, no "+ Checkup patient"
  let checkupsWarn = ''; // why the checkups could not be loaded (the visits still show)
  let checkupsKey = ''; // branch and day the `checkups` above belong to
  let filter = ''; // a status (the Filters panel, or a status count above the list)
  let checkupsOnly = false; // the "Checkups" count was clicked

  const tableBody = h('tbody', {});
  // Typed text that is not saved yet: Treatment, and a checkup patient's name, token and phone, save when the cell is left
  // (the other typed cells save as they are typed). A redraw of the row keeps it (restoreFocus), and a reload in the
  // background waits for it while that cell has the cursor, and for a few seconds after the last key or tap in the list
  // (userIsBusy). A cell left with the text it had fires no change, so unsavedCell can stay set after it is left.
  const SAVED_ON_LEAVE = new Set(['treatment_label', 'patient_name', 'token', 'phone']);
  let unsavedCell = null;
  let lastTouch = 0;
  tableBody.addEventListener('input', (e) => { if (SAVED_ON_LEAVE.has(e.target.dataset.field)) unsavedCell = e.target; });
  tableBody.addEventListener('change', (e) => { if (e.target === unsavedCell) unsavedCell = null; });
  for (const ev of ['keydown', 'pointerdown', 'input']) tableBody.addEventListener(ev, () => { lastTouch = Date.now(); });

  // Where each row was sorted when the list was last drawn (keyOf -> its status rank, see draw), and the row the add line
  // last put the cursor in (keyOf; onKey).
  let placed = new Map();
  let fromAddLine = null;
  const rowKey = (el) => {
    const tr = el && tableBody.contains(el) ? el.closest('tr[data-id]') : null;
    return tr ? `${tr.dataset.kind === 'checkup' ? 'c' : 'v'}:${tr.dataset.id}` : null;
  };
  const itemOf = (key) => {
    const checkup = key.startsWith('c:');
    const row = (checkup ? checkups : rows).find((r) => String(r.id) === key.slice(2));
    return row ? { row, checkup } : null;
  };
  // The cursor has left a row (looked at a moment later: a row drawn again by redrawRow puts it back in the new copy).
  // A row that kept its place for the cursor (its status changed since the list was drawn) now goes where it belongs: a
  // quiet reload draws the list again once nobody is typing or clicking in it (reloadQuietly waits for that), so a click
  // on another row is never moved from under the mouse. A row left for another row is no longer the add line's (onKey).
  tableBody.addEventListener('focusout', (e) => {
    const key = rowKey(e.target);
    if (!key) return;
    setTimeout(() => {
      const now = rowKey(document.activeElement);
      if (now === key) return;
      if (now && key === fromAddLine) fromAddLine = null;
      const item = placed.has(key) ? itemOf(key) : null;
      if (item && rankOf(item) !== placed.get(key)) reloadQuietly();
    });
  });

  // ---- save status, the list of changes that could not be saved, and undo for removals.
  const saveStatus = h('span', { class: 'save-status save-state', tabindex: '-1', dataset: { state: 'saved' } }, 'All changes saved');
  const failList = h('ul', {});
  // (.btn sets display, which beats the hidden attribute, so the button is mounted only when needed.)
  const retryAll = h('button', { type: 'button', class: 'btn btn-small', onclick: () => { q.retryFailed(); announce('Trying the unsaved changes again.'); } }, 'Try all again');
  const retryAllHost = h('div', {});
  const failBox = h('div', { class: 'alert alert-stop', id: 'sheet-save-failures', hidden: true },
    h('strong', {}, 'These changes are not saved yet:'), failList, retryAllHost);
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
      mount(retryAllHost, failed.length > 1 ? retryAll : null);
      mount(failList, failed.map((f) => {
        const what = describeEdit(f.edit);
        return h('li', {}, what, f.error ? h('span', { class: 'muted' }, ` (${errorText(f.error)})`) : null, ' ',
          h('button', { type: 'button', class: 'btn btn-small', 'aria-label': `Try again: ${what}`, onclick: () => { q.retryFailed(f.key); announce('Trying this change again.'); } }, 'Try again'), ' ',
          h('button', { type: 'button', class: 'btn btn-small btn-danger', 'aria-label': `Discard: ${what}`, onclick: () => discard(f) }, 'Discard'));
      }));
      // The button that had focus was redrawn or hidden: keep focus in the box, or on the status.
      if (hadFocus && !failBox.contains(document.activeElement)) (failBox.hidden ? saveStatus : failBox.querySelector('button:not([hidden])') || saveStatus).focus();
      markInvalid();
      fit();
    },
  };
  saveUI = ui;

  const undoText = h('span', {});
  let undoFn = null;
  let undoTimer = null;
  const hideUndo = () => {
    clearTimeout(undoTimer);
    // Never pull the button away from someone who is on it, or while a dialog covers it (the people dialog has its own Undo).
    if (undoBox.contains(document.activeElement) || document.querySelector('.modal')) { undoTimer = setTimeout(hideUndo, 3000); return; }
    undoFn = null; undoBox.hidden = true;
  };
  // The Undo of the bar above the list, and of the people dialog (the same undo).
  async function runUndo() {
    const fn = undoFn;
    undoFn = null;
    clearTimeout(undoTimer);
    if (fn) await fn(); // the bar (and focus on Undo) stays until the undo has run
    if (undoBox.contains(document.activeElement)) saveStatus.focus();
    undoBox.hidden = true;
  }
  const undoBox = h('div', { class: 'alert alert-info', hidden: true }, undoText, ' ',
    h('button', { type: 'button', class: 'btn btn-small', onclick: runUndo }, 'Undo'));
  function offerUndo(message, fn, where = 'at the top of the list for 10 seconds') {
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
    'aria-label': 'Branch', onchange: (e) => { branchId = Number(e.target.value); setURL(); draw(); load(); },
  });
  const dateInput = h('input', { type: 'date', value: date, 'aria-label': 'Date', onchange: (e) => { date = e.target.value; setURL(); load(); } });
  const filterSel = select([{ value: '', label: 'All statuses' }, ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))], '', {
    'aria-label': 'Filter by status', onchange: (e) => { filter = e.target.value; checkupsOnly = false; draw(); },
  });
  // More filters (blueprint 11.1): by doctor, dues, braces month and a quick name search.
  let doctorFilter = ''; let duesOnly = false; let bracesOnly = false; let textFilter = '';
  const doctorSel = select([{ value: '', label: 'Any doctor' }, ...state.ref.clinicians.filter((c) => c.is_doctor).map((c) => ({ value: c.id, label: c.display_name }))], '', {
    'aria-label': 'Filter by doctor', onchange: (e) => { doctorFilter = e.target.value; draw(); },
  });
  let groupFilter = '';
  // The braces groups: the protocol's three, and any other group a doctor is in.
  const groupIds = [...new Set([1, 2, 3, ...state.ref.clinicians.map((c) => c.doctor_group_id).filter(Boolean)])].sort((a, b) => a - b);
  const groupSel = select([{ value: '', label: 'Any group' }, ...groupIds.map((g) => ({ value: String(g), label: `Group ${g}` }))], '', {
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

  // (how.quiet: a reload in the background, see reloadQuietly. Its answer is not drawn when the person has started typing
  //  or opened a dialog meanwhile: the redrawn rows would wipe what they just typed. It is tried again a little later.
  //  load is also the onDone of dialogs, which pass it whatever they saved: only { quiet: true } is quiet.)
  async function load(how) {
    const quiet = how?.quiet === true;
    try {
      const [visitRows, checkupRows] = await Promise.all([d.listVisits({ branchId: branchId || null, date }), loadCheckups()]);
      if (quiet && userIsBusy()) { reloadQuietly(); return; }
      rows = visitRows;
      checkups = checkupRows;
      if (!branchId) rows.sort((a, b) => a.branch_id - b.branch_id || (a.token_no ?? 999) - (b.token_no ?? 999));
      draw();
    } catch (e) { toast(friendlyError(e), 'error'); }
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

  function save(row, fieldName, value) {
    row[fieldName] = value;
    q.edit('visits', row.id, fieldName, value);
  }
  // A status, group or doctor change answers with the visit as the server has it, which may not have a cell typed just
  // before yet (it waits in the autosave queue): the typed changes go back on top, so the redrawn row keeps them.
  const merge = (row, updated) => Object.assign(row, updated, q.unsentChanges('visits', row.id));

  // ---- checkup patients (rows without an Mr#). Typed cells go through the same queue as the visits.
  function saveCheckup(c, fieldName, value) {
    c[fieldName] = value;
    q.edit('checkups', c.id, fieldName, typeof value === 'string' && value.trim() === '' ? null : value);
  }

  async function changeCheckupStatus(c, value, ctl) {
    const before = c.day_status || '';
    const who = c.patient_name;
    try {
      if ((await d.updateCheckup(c.id, { day_status: value || null })) === null) { toast(`${who} is no longer on the list.`, 'error'); load(); return; }
      c.day_status = value || null;
      redrawRow(c, checkupRowEl);
      announce(`Saved: ${who} is ${STATUS_LABELS[c.day_status] || 'not set'}.`);
    } catch (e) {
      ctl.set(before);
      toast(notSaved(e, `${who} is still "${STATUS_LABELS[before] || 'Not set'}".`), 'error', 10000);
    }
  }

  // The dialog behind ⋮ on a checkup row ("Checkup options"): follow-up status, notes, patient file, the checkup list, remove.
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
      c.patient_id
        ? h('a', { class: 'btn', href: `#/staff/patient/${c.patient_id}` }, mr ? `Mr# ${mr} - Open patient file` : 'Open patient file')
        : canRegisterCheckup() ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { dialog?.close(); registerCheckupModal(c, { onDone: load, list: { add: addPatient } }); } }, 'Register as patient') : null,
      h('a', { class: 'btn', href: inCheckupList }, 'Open in the checkup list'),
      canRemoveCheckup(c) ? h('button', { type: 'button', class: 'btn btn-danger', onclick: () => { dialog?.close(); removeCheckupModal(c, { onDone: () => { checkups = checkups.filter((x) => x.id !== c.id); draw(); } }); } }, 'Remove from the list') : null,
    ];
    dialog = modal(`${who} · Checkup patient`, h('div', {},
      h('p', { class: 'muted' }, c.patient_id ? 'Has a patient file now.' : 'No Mr# yet. A checkup patient gets a patient file when they start treatment.'),
      h('div', { class: 'form-grid' },
        h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Name'), h('div', {}, who)),
        h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Phone'), h('div', {}, c.phone || '–')),
        field('Follow-up status', follow),
        field('Notes', notes, 'Saved by itself, like the cells of the list.')),
      h('div', { class: 'inline', style: { marginTop: '10px' } }, actions)), [{ label: 'Done', primary: true }]);
  }

  async function changeStatus(row, value, ctl) {
    const before = row.status;
    const who = row.patient.full_name;
    try {
      const updated = await d.updateVisit(row.id, { status: value });
      merge(row, updated);
      redrawRow(row);
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
            try { merge(row, await d.updateVisit(row.id, { status: value, dues_override_by: true, dues_override_reason: 'Override from Aaj ki List' })); redrawRow(row); } catch (err) { toast(notSaved(err, `${who} is still "${STATUS_LABELS[before]}".`), 'error', 8000); }
          } },
        ], { destructive: true });
      } else toast(msg, 'error', 7000);
    }
  }

  // The Group chip: which braces group sees the patient today, as on the sheet. Saved at once, like the status.
  const groupWords = (g) => (g ? `Group ${g}` : 'in no group');
  async function changeGroup(row, value, ctl) {
    const before = row.doctor_group_id ? String(row.doctor_group_id) : '';
    const who = row.patient.full_name;
    try {
      merge(row, await d.updateVisit(row.id, { doctor_group_id: value ? Number(value) : null }));
      redrawRow(row);
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
      merge(row, await d.setVisitStaff(row.id, s.clinician_id, s.role, false));
      redrawRow(row);
      offerUndo(`${name} removed from ${who}.`, async () => {
        try {
          merge(row, await d.setVisitStaff(row.id, s.clinician_id, s.role, true));
          redrawRow(row);
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
        'aria-label': removeLabel(s, who), onclick: () => removePerson(row, s),
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
  // when the list was drawn again meanwhile. There is no twin when the row's flags, note or invoice changed with that
  // redraw, and focus would go to the page heading: it goes back to that control of the row (key), or to the name.
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
            try { merge(row, await d.setVisitStaff(row.id, c.id, r, true)); redrawRow(row); if (open) drawOn(); toast(`${c.display_name} added to ${who}.`, 'ok'); } catch (e) { toast(notSaved(e, `${c.display_name} was not added.`), 'error', 8000); }
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
      can('photos.upload') ? h('button', { class: 'btn', onclick: uploadPhotos }, 'Upload photos') : null,
      can('billing.create') ? h('button', { class: 'btn', onclick: () => newInvoiceModal(row.patient, { branchId: row.branch_id, visitId: row.id, onDone: load }) }, 'New invoice') : null,
      can('billing.create') ? h('button', { class: 'btn', onclick: () => paymentModal(row.patient, { branchId: row.branch_id, dues: row.dues, onDone: load }) }, 'Take payment') : null,
      can('flags.raise') && !row.see_dr_ali ? h('button', { class: 'btn', onclick: () => flagForAliModal(row.patient, load) }, 'Next appointment with Dr. Ali') : null,
      // Close this dialog first, so the profile is not left underneath it.
      h('button', { type: 'button', class: 'btn', onclick: () => { dialog?.close(); location.hash = `#/staff/patient/${row.patient_id}`; } }, 'Open profile'),
    ];
    const medical = medicalText(row.patient);
    // Notes save by themselves through the same queue as the cells (the sheet has no Notes column, so they live here);
    // the row shows a "Note" flag once there is one.
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
      // Focus then goes back to the control of the row that opened this (a flag or note just added changes the name's words).
      onClose: () => {
        const now = (row.notes || '') !== notesBefore && rows.find((r) => r.id === row.id);
        if (now) { now.notes = row.notes; redrawRow(now); }
        backToRow(row.id, from);
      },
    });
    // Start on the heading, as before the notes were here (the first field would otherwise take focus).
    dialog.dialog.querySelector('h2')?.focus();
  }

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
    // Saved: the list is drawn again with this chip as Done, which is no button, so focus goes back to the row's name
    // (backToRow). The dialog closes once onDone is over: the next task finds it closed.
    const onDone = async () => { await load(); setTimeout(() => backToRow(row.id, 'invoice')); };
    return can('billing.create')
      ? h('button', {
        type: 'button', class: cls, 'aria-haspopup': 'dialog', 'aria-label': `${due ? 'Invoice pending' : 'No invoice yet'} for ${who}: make a new invoice`,
        title: 'New invoice', dataset: { focus: 'invoice' }, onclick: () => newInvoiceModal(row.patient, { branchId: row.branch_id, visitId: row.id, onDone }),
      }, words)
      : h('span', { class: cls }, words);
  }

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
    const group = h('select', { class: chipSelect(groupTone(groupNo)), 'aria-label': `Doctor group for ${who}`, disabled: !canEdit, dataset: { focus: 'group' } },
      [['', 'No group'], ...[...new Set([...groupIds, ...(groupNo ? [Number(groupNo)] : [])])].map((g) => [String(g), `Group ${g}`])]
        .map(([value, label]) => h('option', { value, selected: value === groupNo }, label)));
    const groupCtl = commitOnFinish(group, (value) => changeGroup(row, value, groupCtl), (value) => { group.className = chipSelect(groupTone(value)); });

    const treatment = h('input', {
      class: 'cell-input center', value: capFirst(row.treatment_label), list: 'sheet-treatments', disabled: !canEdit, 'aria-label': `Treatment for ${who}`,
      dataset: { focus: 'treatment', field: 'treatment_label' }, onchange: (e) => save(row, 'treatment_label', e.target.value),
    });
    const details = h('input', {
      class: 'cell-input', value: row.details_text || '', disabled: !canTreatment, placeholder: 'e.g. U L 018 PC refresh', 'aria-label': `Treatment details for ${who}`,
      dataset: { focus: 'details', field: 'details_text' }, oninput: (e) => save(row, 'details_text', e.target.value),
    });
    // Quick-tap chips (blueprint 11.2): arch, wire size, power chain, o-rings, rebond, extraction, elastics.
    const quickTap = canTreatment ? h('button', { class: 'quick-tap', type: 'button', title: 'Quick-tap treatment details', 'aria-label': `Add treatment details for ${who}`, dataset: { focus: 'quick' }, onclick: () => {
      const groups = [
        ['Arch', ['U', 'L', 'U L']],
        ['Wire', ['012', '014', '016', '018', '020', '17x25', '19x25']],
        ['Done', ['PC', 'O-rings', 'Refresh', 'Rebond', 'Ligature', 'Elastics', 'Cross arch', 'Ext', 'IPR', 'Bite blocks']],
      ];
      const add = (t) => { details.value = (details.value ? details.value.replace(/\s+$/, '') + ' ' : '') + t; save(row, 'details_text', details.value); };
      modal(`Treatment details · ${who}`, h('div', {},
        groups.map(([name, items]) => h('div', { style: { marginBottom: '10px' } }, h('div', { class: 'field-label' }, name),
          h('div', { class: 'inline' }, items.map((t) => h('button', { type: 'button', class: 'btn btn-small', onclick: () => add(t) }, t))))),
        h('p', { class: 'muted' }, 'Tap to add to the details; type anything else in the cell itself.')), [{ label: 'Done', primary: true }]);
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
    const medical = medicalText(row.patient);
    const pp = !can('dues.view') ? null : row.dues > 0
      ? h('span', { class: 'pp-due', title: `Pending dues ${rupees(row.dues)}` }, shortRupees(row.dues), srOnly(` pending dues, ${rupees(row.dues)}`))
      : h('span', { class: 'pp-zero', title: 'No pending dues' }, '0', srOnly(' pending dues'));
    // The flags beside the name, short so the name keeps most of the cell (the full words are read out, and are in the
    // tooltip and the row's dialog). Medical history first: it is the one that matters at the chair. Both are always whole
    // (the name gives way); a note is the sheet's note mark, a small triangle in the cell's corner that takes no room.
    const flag = (short, words, cls, title) => h('span', { class: ['badge', cls], title }, [h('span', { 'aria-hidden': 'true' }, short), srOnly(words)]);
    const flags = [
      medical ? flag('Med', 'Medical', 'badge-warn', `Medical history: ${medical}`) : null,
      row.see_dr_ali ? flag('Ali', 'See Dr. Ali', 'badge-ali', 'Next appointment with Dr. Ali Rashid') : null,
    ].filter(Boolean);

    return h('tr', { dataset: { id: row.id, n } },
      !branchId ? h('td', { class: 'branch-cell' }, cellText(branchName(row.branch_id))) : null,
      h('td', { class: 'rownum' }, n),
      h('td', { class: 'mr-cell frozen' }, cellText(srOnly('Mr# '), row.patient.mr_number)),
      // The patient cell is the row's header (th scope=row). A click on the name opens the row's actions; the flags beside it
      // (medical history, see Dr. Ali, a note) are shown in full there.
      h('th', { scope: 'row', class: 'frozen row-head name-col' },
        h('button', {
          type: 'button', class: 'link-btn name-btn', 'aria-haspopup': 'dialog', dataset: { focus: 'patient' }, onclick: () => openRow(row),
          title: `${who}: actions, braces guidance and notes${row.notes ? `. Note: ${row.notes}` : ''}`,
        },
        h('span', { class: 'name-text' }, who),
        flags.length ? h('span', { class: 'name-flags' }, flags) : null,
        row.notes ? h('span', { class: 'note-mark', title: `Note: ${row.notes}` }, srOnly('Note')) : null,
        h('span', { class: 'kebab', 'aria-hidden': 'true' }, '⋮'))),
      h('td', {}, month),
      h('td', {}, typedCell(treatment)),
      h('td', { class: 'center' }, h('span', { class: 'token', title: arrived ? `Arrived ${arrived}` : null }, srOnly('Token '), row.token_no ?? srOnly('none'), arrived ? srOnly(`, arrived ${arrived}`) : null)),
      h('td', {}, status),
      h('td', {}, group),
      h('td', {}, peopleCell(row)),
      h('td', {}, h('div', { class: 'details-cell' }, details, quickTap)),
      h('td', { class: 'pp' }, pp),
      canBill ? h('td', {}, invoiceCell(row)) : null,
      h('td', { class: 'contact' }, cellText(row.patient.phone || '')));
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
    const text = (fieldName, label, props = {}) => h('input', {
      class: 'cell-input', value: fieldName === 'checkup_for' ? capFirst(c[fieldName]) : c[fieldName] || '', disabled: !canEdit, 'aria-label': `${label} for ${who}`, autocomplete: 'off',
      dataset: { focus: fieldName, field: fieldName }, oninput: (e) => saveCheckup(c, fieldName, e.target.value), ...props,
    });
    return h('tr', { class: 'is-checkup', dataset: { id: c.id, kind: 'checkup', n } },
      !branchId ? h('td', { class: 'branch-cell' }, cellText(branchName(c.branch_id))) : null,
      h('td', { class: 'rownum' }, n),
      h('td', { class: 'mr-cell frozen' }, cellText(c.patient_id
        ? h('a', { class: 'mr', href: `#/staff/patient/${c.patient_id}`, title: 'Open the patient file' }, mr ? [srOnly('Mr# '), mr] : 'File')
        : h('span', { class: 'muted' }, 'no Mr#'))),
      h('th', { scope: 'row', class: 'frozen row-head name-col' }, h('div', { class: 'name-cell' },
        nameIn,
        h('span', { class: 'badge badge-checkup' }, 'Checkup'),
        h('button', { type: 'button', class: 'kebab-btn', 'aria-haspopup': 'dialog', 'aria-label': `Checkup options for ${who}`, title: 'Options: follow-up, notes, register, remove', dataset: { focus: 'options' }, onclick: () => checkupOptions(c) },
          h('span', { 'aria-hidden': 'true' }, '⋮')))),
      h('td', {}, h('span', { class: 'chip chip-fill gs-grey' }, srOnly('Not braces'))),
      h('td', {}, typedCell(text('checkup_for', 'Treatment', { list: 'sheet-treatments', class: 'cell-input center' }))),
      h('td', {}, typedCell(tokenIn)),
      h('td', {}, status),
      h('td', {}),
      h('td', {}, typedCell(text('doctors', "Doctor's name", { list: 'sheet-doctors' }))),
      h('td', {}, typedCell(text('details', 'Treatment details', { placeholder: 'e.g. Scaling advised' }))),
      h('td', { class: 'pp' }),
      canBill ? h('td', {}) : null,
      h('td', {}, typedCell(text('phone', 'Phone', { type: 'tel', onchange: (e) => saveCheckup(c, 'phone', e.target.value), oninput: null }))));
  }

  // Redraws replace rows, so remember the focused control (row id + data-focus key + caret, and typed text the cell has not
  // saved yet) and put focus back on the same control in the new row, or on "+" when a removed chip had it. The new cell is
  // drawn from the row's data, which does not have that typed text yet: it is put back in, and the cell saves it.
  function rememberFocus() {
    const el = document.activeElement;
    if (!el || !tableBody.contains(el)) return null;
    let caret = null;
    try { if (typeof el.selectionStart === 'number') caret = [el.selectionStart, el.selectionEnd]; } catch { /* not a text field */ }
    return { rowId: el.closest('tr')?.dataset.id, key: el.dataset.focus, caret, typed: el === unsavedCell ? el.value : null };
  }
  function restoreFocus(saved) {
    const tr = saved && [...tableBody.querySelectorAll('tr[data-id]')].find((t) => t.dataset.id === saved.rowId);
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

  // Replace one row after a save (make = rowEl for a visit, checkupRowEl for a checkup patient); it keeps its place and its
  // row number, whatever its status is now (only draw sorts the list, see there).
  function redrawRow(row, make = rowEl) {
    const old = tableBody.querySelector(`tr[data-id="${row.id}"]`);
    if (old) {
      const saved = old.contains(document.activeElement) ? rememberFocus() : null;
      const tr = make(row, Number(old.dataset.n) || old.sectionRowIndex + 1);
      old.replaceWith(tr);
      restoreFocus(saved);
      countHiddenPeople(tr);
    }
    drawCounts();
    markInvalid();
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

  // The sheet's columns in the sheet's order. "Reminder Status", the sheet's last column, is left out while it is empty on
  // every tab; when the clinic starts using it, it goes after Contact No (a <col>, a heading and a cell in both row kinds).
  const colgroup = h('colgroup', {});
  const columns = () => [!branchId && 'branch', 'num', 'mr', 'name', 'month', 'treatment', 'token', 'status', 'group', 'doctor', 'details', 'pp', canBill && 'invoice', 'contact']
    .filter(Boolean).map((k) => h('col', { class: `c-${k}` }));

  function draw() {
    const shown = rows.filter(matches);
    const shownChecks = shownCheckups();
    branchHead.hidden = !!branchId;
    mount(colgroup, columns());
    addPanel.hidden = !branchId || !search;
    // "+ Checkup patient" only where checkups exist (the database update has been run) and for today or an earlier day.
    checkupBtn.hidden = checkupsMissing || date > localISO() || !can('sheet.edit');
    addHint.textContent = checkupBtn.hidden ? ADD_HINT_PLAIN : ADD_HINT_CHECKUP;
    warnBox.hidden = !checkupsWarn;
    warnBox.textContent = checkupsWarn ? `Checkup patients could not be loaded: ${checkupsWarn}` : '';
    const inUse = [filter && !checkupsOnly, doctorFilter, groupFilter, duesOnly, bracesOnly].filter(Boolean).length;
    filterBtn.textContent = inUse ? `Filters (${inUse})` : 'Filters';
    const saved = rememberFocus();
    // Sorted like the sheet (listOrder) here only. A row never jumps away under the cursor: a save in one row (a status
    // picked, say) draws that row alone in its place, with its number (redrawRow), and here the row with the cursor in it
    // (and so any text typed in it and not saved yet) is sorted by the status it was drawn with last time. It moves to its
    // new place at the first redraw after the cursor has left it: leaving it asks for a quiet reload, which waits until
    // nobody is typing or clicking in the list (the focusout listener at the top), and the live updates, the 20-second
    // check and any other redraw move it too. Every row is numbered 1..n in the order shown, like the sheet's row numbers
    // (owner, 11 Oct 2026); that is not the token, which repeats from one kind of treatment to another.
    const here = rowKey(document.activeElement);
    const items = [...shown.map((row) => ({ row, checkup: false })), ...shownChecks.map((row) => ({ row, checkup: true }))].map((item) => {
      const key = keyOf(item);
      return { ...item, key, rank: key === here && placed.has(key) ? placed.get(key) : rankOf(item) };
    }).sort(listOrder);
    placed = new Map(items.map((item) => [item.key, item.rank]));
    mount(tableBody, items.length ? items.map((item, i) => (item.checkup ? checkupRowEl(item.row, i + 1) : rowEl(item.row, i + 1)))
      : h('tr', {}, h('td', { class: 'empty-cell', colspan: colgroup.children.length }, h('div', { class: 'empty' }, branchId ? `No patients or checkups on the list for ${branchName(branchId)} on this day yet. Use "Add a patient" to add them.` : 'No patients or checkups on any list for this day.'))));
    restoreFocus(saved);
    drawCounts();
    markInvalid();
    countHiddenPeople();
    fit();
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
    const there = fast ? null : onList(p);
    if (there && !(await addAgain(there))) return null;
    try {
      const braces = !!p.braces_active;
      const row = await d.addVisit({ patient_id: p.id, branch_id: branchId, visit_date: date, treatment_label: braces ? 'Monthly' : (treatment || 'Checkup'), braces, status: date === localISO() ? 'waiting' : 'scheduled' });
      rows.push(row);
      draw();
      toast(`${p.full_name} added${row.token_no ? ` with token ${row.token_no}` : ''}.`, 'ok');
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
        merge(there, await d.updateVisit(there.id, { status: 'waiting' }));
        redrawRow(there);
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
      const there = onList(found[0]);
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
  // A person who only comes for a checkup gets no Mr#: "+ Checkup patient" puts them on this list (and on the Checkups page).
  // A patient who starts treatment and is new gets an Mr# with "+ New walk-in".
  const ADD_HINT_PLAIN = 'Search by name, Mr# or phone. New walk-in? Register them here. To book an appointment, pick that date above first.';
  const ADD_HINT_CHECKUP = 'New and starting treatment? Use "+ New walk-in" (gets an Mr#). Only a checkup? Use "+ Checkup patient" (no Mr#).';
  const addHint = h('span', { class: 'muted' }, ADD_HINT_PLAIN);
  const checkupBtn = h('button', { class: 'btn btn-small', type: 'button', hidden: true, 'aria-haspopup': 'dialog', onclick: async () => {
    const res = await checkupFormModal({ branchId, date, fixedDay: true });
    if (!res) return;
    if (res.patient) { addPatient(res.patient); return; } // the person already has a patient file: put that file on the list instead
    checkups = [...checkups, res];
    draw();
    toast(`${res.patient_name} added as a checkup patient.`, 'ok');
  } }, '+ Checkup patient');
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
  // (Only typing holds it up, not the cursor sitting in a cell: after an Mr# and Enter the cursor waits in the new row's
  //  Treatment cell, often with nothing to type, and the list must keep showing what the other computers do. A cell typed
  //  in counts only while it has the cursor: one left with the text it had saves nothing and must not stop the reloads for
  //  good. Another window taking the focus leaves the cursor in the cell, so its unsaved text still holds them up.)
  const userIsBusy = () => q.pendingCount || (unsavedCell?.isConnected && unsavedCell === document.activeElement)
    || Date.now() - lastTouch < 5000 || document.querySelector('.modal');
  // A reload in the background (live updates, the 20-second check, a save the server refused) waits while this person is
  // typing (unsaved text in the cell with the cursor, or a key or tap in the list in the last 5 seconds) or has a dialog open,
  // and tries again every few seconds until they are done; a hidden tab reloads when it comes back. The cell with the
  // cursor is drawn again with the rest, and the cursor stays in it.
  let retryTimer = null;
  function reloadQuietly() {
    clearTimeout(retryTimer);
    if (life.signal.aborted || document.hidden) return;
    if (userIsBusy()) { retryTimer = setTimeout(reloadQuietly, 3000); return; }
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
    clearTimeout(retryTimer);
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
  const page = h('div', { class: 'sheet-page' },
    h('div', { class: 'sheet-head' },
      h('h1', {}, 'Aaj ki List'),
      h('div', { class: 'sheet-toolbar' }, branchSel, dateInput,
        h('button', { type: 'button', class: 'btn btn-small', onclick: () => { date = localISO(); dateInput.value = date; setURL(); load(); } }, 'Today'),
        findBox, filterWrap),
      h('div', { class: 'sheet-tools' },
        h('a', { class: 'btn btn-small', href: `#/staff/queue?branch=${branchId || ''}` }, 'Queue board'),
        can('export.data') || can('finance.view') ? h('button', { type: 'button', class: 'btn btn-small', onclick: download }, 'Download') : null)),
    h('div', { class: 'sheet-subhead' }, countsBox, saveStatus),
    failBox,
    undoBox,
    warnBox,
    statusHint,
    h('datalist', { id: 'sheet-treatments' }, state.ref.treatments.map((t) => h('option', { value: t.name }))),
    h('datalist', { id: 'sheet-doctors' }, state.ref.clinicians.filter((c) => c.is_doctor).map((c) => h('option', { value: c.display_name }))),
    addPanel,
    h('div', { class: 'sheet-wrap', onkeydown: onKey },
      h('table', { class: 'sheet' },
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
          heading('Contact No'))),
        tableBody)));
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
  await load();
  if (!signal?.aborted) listen(); // after the first load, which tells whether checkups exist at all
  q.setOnline(navigator.onLine);
  $$('.cell-input', root)[0]?.blur();
}
