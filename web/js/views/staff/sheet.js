// Aaj ki List: the daily sheet, Google Sheets style. Typed cells (treatment,
// details, notes) save by themselves; if the internet drops, those typed
// changes wait on this device and are sent when it comes back. Status, doctor
// and new-patient changes need the connection, and say so when they fail.
import { h, mount, toast, friendlyError, isLostAnswer, rupees, modal, select, field, timeOf, downloadCSV, $$, announce, localISO, srOnly, busy } from '../../ui/dom.js';
import { state, can, myBranches, defaultBranchId, branchName } from '../../state.js';
import { AutosaveQueue, PermanentSaveError } from '../../lib/autosave.js';
import { protocolFor, canTreat, canCheck, guidance as protocolGuidance } from '../../lib/protocol.js';
import { STATUS_LABELS, duesBadge, aliBadge, patientSearch, newPatientModal, flagForAliModal, photoUploadModal, guidancePanel, commitOnFinish } from './common.js';
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

// Checkup rows go after the visit rows: by branch (all-branches view), then by the token written on the sheet when it is
// a number, then by when they were added.
const tokenNo = (c) => (/^\d+$/.test(String(c.token ?? '').trim()) ? Number(c.token) : Infinity);
const byToken = (a, b) => (a.branch_id ?? 0) - (b.branch_id ?? 0)
  || (tokenNo(a) === tokenNo(b) ? 0 : tokenNo(a) < tokenNo(b) ? -1 : 1)
  || String(a.created_at || '').localeCompare(String(b.created_at || ''));

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
  let rows = [];
  let checkups = []; // the day's checkup patients (no Mr#); see lib/checkups.js dayListCheckups for which of them are shown
  let checkupsMissing = false; // the database update for checkups has not been run yet: no checkup rows, no "+ Checkup patient"
  let checkupsWarn = ''; // why the checkups could not be loaded (the visits still show)
  let checkupsKey = ''; // branch and day the `checkups` above belong to
  let filter = '';

  const tableBody = h('tbody', {});
  const counts = h('span', { class: 'muted' });

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
    },
  };
  saveUI = ui;

  const undoText = h('span', {});
  let undoFn = null;
  let undoTimer = null;
  const hideUndo = () => {
    clearTimeout(undoTimer);
    // Never pull the button away from someone who is on it.
    if (undoBox.contains(document.activeElement)) { undoTimer = setTimeout(hideUndo, 3000); return; }
    undoFn = null; undoBox.hidden = true;
  };
  const undoBox = h('div', { class: 'alert alert-info', hidden: true }, undoText, ' ',
    h('button', { type: 'button', class: 'btn btn-small', onclick: async () => {
      const fn = undoFn;
      undoFn = null;
      clearTimeout(undoTimer);
      if (fn) await fn(); // the bar (and focus on Undo) stays until the undo has run
      if (undoBox.contains(document.activeElement)) saveStatus.focus();
      undoBox.hidden = true;
    } }, 'Undo'));
  function offerUndo(message, fn) {
    clearTimeout(undoTimer);
    undoFn = fn;
    undoText.textContent = message;
    undoBox.hidden = false;
    announce(`${message} Undo is at the top of the list for 10 seconds.`);
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
    'aria-label': 'Filter by status', onchange: (e) => { filter = e.target.value; draw(); },
  });
  // More filters (blueprint 11.1): by doctor, dues, braces month and a quick name search.
  let doctorFilter = ''; let duesOnly = false; let bracesOnly = false; let textFilter = '';
  const doctorSel = select([{ value: '', label: 'Any doctor' }, ...state.ref.clinicians.filter((c) => c.is_doctor).map((c) => ({ value: c.id, label: c.display_name }))], '', {
    'aria-label': 'Filter by doctor', onchange: (e) => { doctorFilter = e.target.value; draw(); },
  });
  let groupFilter = '';
  const groupSel = select([{ value: '', label: 'Any group' }, { value: '1', label: 'Group 1' }, { value: '2', label: 'Group 2' }, { value: '3', label: 'Group 3' }], '', {
    'aria-label': 'Filter by doctor group', onchange: (e) => { groupFilter = e.target.value; draw(); },
  });
  const groupOf = (id) => state.ref.clinicians.find((c) => c.id === id)?.doctor_group_id;
  const duesBox = h('input', { type: 'checkbox', onchange: (e) => { duesOnly = e.target.checked; draw(); } });
  const bracesBox = h('input', { type: 'checkbox', onchange: (e) => { bracesOnly = e.target.checked; draw(); } });
  const findBox = h('input', { type: 'search', placeholder: 'Find on this list', 'aria-label': 'Find on this list', oninput: (e) => { textFilter = e.target.value.trim().toLowerCase(); draw(); } });
  const matches = (r) => (!filter || r.status === filter)
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
  const setURL = () => history.replaceState(null, '', `#/staff/sheet?branch=${branchId || 'all'}&date=${date}`);

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

  async function load() {
    try {
      const [visitRows, checkupRows] = await Promise.all([d.listVisits({ branchId: branchId || null, date }), loadCheckups()]);
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

  function save(row, fieldName, value) {
    row[fieldName] = value;
    q.edit('visits', row.id, fieldName, value);
  }

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

  // The dialog behind "Options" on a checkup row: follow-up status, patient file, the checkup list, remove.
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
        field('Follow-up status', follow)),
      h('div', { class: 'inline', style: { marginTop: '10px' } }, actions)), [{ label: 'Done', primary: true }]);
  }

  async function changeStatus(row, value, ctl) {
    const before = row.status;
    const who = row.patient.full_name;
    try {
      const updated = await d.updateVisit(row.id, { status: value });
      Object.assign(row, updated);
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
            try { Object.assign(row, await d.updateVisit(row.id, { status: value, dues_override_by: true, dues_override_reason: 'Override from Aaj ki List' })); redrawRow(row); } catch (err) { toast(notSaved(err, `${who} is still "${STATUS_LABELS[before]}".`), 'error', 8000); }
          } },
        ], { destructive: true });
      } else toast(msg, 'error', 7000);
    }
  }

  // One request per chip at a time (a double tap must not send two). The button is not disabled,
  // so focus stays on it until the row is redrawn and focus moves to "+ add".
  const inFlight = new Set();
  async function removePerson(row, s) {
    const who = row.patient.full_name;
    const name = s.name || 'Unknown';
    const key = `${row.id}|${s.clinician_id}|${s.role}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      Object.assign(row, await d.setVisitStaff(row.id, s.clinician_id, s.role, false));
      redrawRow(row);
      offerUndo(`${name} removed from ${who}.`, async () => {
        try {
          Object.assign(row, await d.setVisitStaff(row.id, s.clinician_id, s.role, true));
          redrawRow(row);
          // Continue from the chip that came back, rather than from the Undo bar that is closing.
          if (!document.activeElement || document.activeElement === document.body || undoBox.contains(document.activeElement)) {
            [...tableBody.querySelectorAll(`tr[data-id="${row.id}"] [data-focus]`)].find((el) => el.dataset.focus === `remove-${s.clinician_id}-${s.role}`)?.focus();
          }
          announce(`${name} is back on ${who}.`);
        } catch (e) { toast(notSaved(e, `${name} is still removed from ${who}.`), 'error', 8000); }
      });
    } catch (e) { toast(notSaved(e, `${name} is still on ${who}.`), 'error', 8000); }
    finally { inFlight.delete(key); }
  }

  function peopleCell(row) {
    const who = row.patient.full_name;
    const rule = row.braces_month ? protocolFor(row.braces_month) : null;
    // Doctor, assistant and checker chips differ in text too, not only colour.
    const chips = row.staff.map((s) => h('span', { class: ['person', s.role] },
      s.role === 'checker' ? [h('span', { 'aria-hidden': 'true' }, '✓ '), srOnly('Checked by ')] : null,
      s.name || 'Unknown',
      s.role === 'assistant' ? h('span', {}, ' (assistant)') : null,
      canTreatment ? h('button', {
        type: 'button', class: 'chip-remove', dataset: { focus: `remove-${s.clinician_id}-${s.role}` },
        'aria-label': `Remove ${s.name || 'Unknown'}${s.role === 'doctor' ? '' : ` (${s.role})`} from ${who}`, onclick: () => removePerson(row, s),
      }, h('span', { 'aria-hidden': 'true' }, '×')) : null));
    const add = canTreatment ? h('button', { type: 'button', class: 'add-person chip-add', dataset: { focus: 'add-person' }, 'aria-label': `Add doctor or assistant for ${who}`, onclick: () => pickPeople(row) }, '+ add') : null;
    const hint = rule ? h('span', { class: 'field-hint' },
      h('span', { 'aria-hidden': 'true' }, `G${rule.treatingGroups.join('/')}${rule.checkerGroup ? ` · check G${rule.checkerGroup}` : ''}`),
      srOnly(`Treated by group ${rule.treatingGroups.join(' or ')}${rule.checkerGroup ? `, checked by group ${rule.checkerGroup}` : ''}`)) : null;
    return h('div', { class: 'people' }, chips, add, hint);
  }

  function pickPeople(row) {
    const month = row.braces_month;
    const role = select([{ value: 'doctor', label: 'Doctor' }, { value: 'assistant', label: 'Assistant / hygienist' }, { value: 'checker', label: 'Checked by' }], 'doctor');
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
            try { Object.assign(row, await d.setVisitStaff(row.id, c.id, r, true)); redrawRow(row); toast(`${c.display_name} added to ${row.patient.full_name}.`, 'ok'); } catch (e) { toast(notSaved(e, `${c.display_name} was not added.`), 'error', 8000); }
          }),
        }, c.display_name, c.doctor_group_id ? h('span', { class: 'muted' }, ` G${c.doctor_group_id}`) : '', allowed ? '' : h('span', {}, ' · not allowed this month'));
      })));
    };
    role.addEventListener('change', drawList);
    drawList();
    modal(`Who treated ${row.patient.full_name}?`, h('div', {},
      month ? h('p', { class: 'muted' }, `Braces month ${month}: treated by Group ${protocolFor(month).treatingGroups.join(' or ')}${protocolFor(month).checkerGroup ? `, checked by Group ${protocolFor(month).checkerGroup}` : ''}. Names marked "not allowed this month" are outside the protocol for this month.`) : null,
      field('Role', role), listHost), [{ label: 'Done', primary: true }], {
      // The "+ add" that opened this was redrawn with the row: continue from the new one.
      onClose: () => {
        const again = tableBody.querySelector(`tr[data-id="${row.id}"] [data-focus="add-person"]`);
        if (again?.isConnected && !document.querySelector('.modal') && (!document.activeElement || document.activeElement === document.body || document.activeElement.matches('h1'))) again.focus();
      },
    });
  }

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
    const mh = row.patient.medical_history || {};
    const medical = [...(mh.conditions || []), mh.allergies ? `Allergies: ${mh.allergies}` : null, mh.medications ? `Medicines: ${mh.medications}` : null, mh.notes].filter(Boolean).join(' · ');
    dialog = modal(`${row.patient.full_name} · Mr# ${row.patient.mr_number}`, h('div', {},
      medical ? h('div', { class: 'alert alert-warning' }, h('strong', {}, 'Medical history: '), medical) : null,
      row.dues > 0 && can('dues.view') ? h('div', { class: 'alert alert-stop' }, `Pending dues ${rupees(row.dues)}. Clear dues before treatment.`) : null,
      row.see_dr_ali ? h('div', { class: 'alert alert-warning' }, 'Flagged: next appointment should be with Dr. Ali Rashid.') : null,
      g ? guidancePanel(g) : null,
      h('div', { class: 'inline', style: { marginTop: '10px' } }, actions)), []);
  }

  function rowEl(row) {
    const who = row.patient.full_name;
    // Status saves once the person has finished choosing (Enter, leaving the select, or a pick
    // from the open list), not on every arrow key.
    const status = h('select', {
      class: `status-chip status-${row.status}`, 'aria-label': `Status for ${who}`, 'aria-describedby': canEdit ? 'sheet-status-hint' : null,
      disabled: !canEdit, dataset: { focus: 'status' },
    }, Object.entries(STATUS_LABELS).map(([value, label]) => h('option', { value, selected: value === row.status }, label)));
    const ctl = commitOnFinish(status, (value) => changeStatus(row, value, ctl), (value) => { status.className = `status-chip status-${value}`; });

    const treatment = h('input', {
      class: 'cell-input', value: row.treatment_label || '', list: 'sheet-treatments', disabled: !canEdit, 'aria-label': `Treatment for ${who}`,
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
    const notes = h('input', {
      class: 'cell-input', value: row.notes || '', disabled: !canEdit, 'aria-label': `Notes for ${who}`,
      dataset: { focus: 'notes', field: 'notes' }, oninput: (e) => save(row, 'notes', e.target.value),
    });
    const monthNo = String(row.braces_month || '').padStart(2, '0');
    const photoText = row.photo_required ? (row.photos_uploaded ? ', photos uploaded' : ', photos needed') : '';
    const month = row.braces_month
      ? h('button', { type: 'button', class: 'link-btn month-pill', 'aria-haspopup': 'dialog', 'aria-label': `Braces month ${monthNo} guidance for ${who}${photoText}`, title: 'Braces guidance for this month', dataset: { focus: 'month' }, onclick: () => openRow(row) },
        monthNo, row.photo_required ? h('span', { class: ['badge', row.photos_uploaded ? 'badge-ok' : 'badge-photo'], style: { marginLeft: '4px' } }, row.photos_uploaded ? 'Photo ✓' : '📸 Photo') : null)
      : h('span', { class: 'muted' }, h('span', { 'aria-hidden': 'true' }, '–'), srOnly('Not braces'));
    const arrived = row.checked_in_at ? timeOf(row.checked_in_at) : '';

    return h('tr', { dataset: { id: row.id } },
      !branchId ? h('td', {}, h('div', { class: 'cell muted nowrap' }, branchName(row.branch_id))) : null,
      // The patient cell is the row's header (th scope=row); app.css styles .row-head.
      h('th', { scope: 'row', class: 'frozen row-head' }, h('div', { class: 'cell' },
        h('span', { class: 'token', title: arrived ? `Arrived ${arrived}` : null }, srOnly('Token '), row.token_no ?? '–', arrived ? srOnly(`, arrived ${arrived}`) : null),
        h('button', { type: 'button', class: 'link-btn', 'aria-haspopup': 'dialog', dataset: { focus: 'patient' }, style: { textDecoration: 'none', textAlign: 'left' }, onclick: () => openRow(row) },
          h('div', {}, who), h('div', { class: 'muted field-hint', style: { fontWeight: 500 } }, `Mr# ${row.patient.mr_number}`)))),
      h('td', {}, h('div', { class: 'cell row-flags' }, duesBadge(row.dues), aliBadge(row.see_dr_ali))),
      h('td', {}, h('div', { class: 'cell' }, month)),
      h('td', { style: { minWidth: '150px' } }, treatment),
      h('td', {}, h('div', { class: 'cell' }, status)),
      h('td', { style: { minWidth: '250px' } }, peopleCell(row)),
      h('td', { style: { minWidth: '230px' } }, h('div', { class: 'cell details-cell' }, details, quickTap)),
      h('td', { class: 'right' }, h('div', { class: ['cell', row.dues > 0 ? 'status-bad' : 'muted'], style: { justifyContent: 'flex-end', fontWeight: 700 } }, can('dues.view') ? (row.dues > 0 ? rupees(row.dues) : '0') : '')),
      h('td', { style: { minWidth: '160px' } }, notes),
      h('td', {}, h('div', { class: 'cell muted nowrap' }, row.patient.phone)));
  }

  // A checkup patient: the same columns as a visit row (so the arrow keys keep working), but no Mr#, no braces month,
  // no doctor chips, no dues. Every cell saves through the queue or, for the status, at once.
  function checkupRowEl(c) {
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
      class: 'token-input', value: c.token || '', disabled: !canEdit, maxlength: 40, autocomplete: 'off', placeholder: '\u2013', 'aria-label': `Token of checkup patient ${who}`,
      dataset: { focus: 'token', field: 'token' },
      onchange: (e) => { const v = e.target.value.trim(); e.target.value = v; if (v !== (c.token || '')) saveCheckup(c, 'token', v); },
    });
    const hint = c.patient_id
      ? (mr ? h('a', { class: 'mr', href: `#/staff/patient/${c.patient_id}` }, `Mr# ${mr}`) : h('span', {}, 'Has a patient file'))
      : h('span', {}, 'Checkup · no Mr#');
    const status = h('select', {
      class: `status-chip status-${c.day_status || 'unset'}`, 'aria-label': `Status for ${who}`, 'aria-describedby': canEdit ? 'sheet-status-hint' : null,
      disabled: !canEdit, dataset: { focus: 'status' },
    }, (c.day_status ? DAY_STATUSES : ['', ...DAY_STATUSES]).map((value) => h('option', { value, selected: value === (c.day_status || '') }, value ? STATUS_LABELS[value] : 'Not set')));
    const ctl = commitOnFinish(status, (value) => changeCheckupStatus(c, value, ctl), (value) => { status.className = `status-chip status-${value || 'unset'}`; });
    const text = (fieldName, label, props = {}) => h('input', {
      class: 'cell-input', value: c[fieldName] || '', disabled: !canEdit, 'aria-label': `${label} for ${who}`, autocomplete: 'off',
      dataset: { focus: fieldName, field: fieldName }, oninput: (e) => saveCheckup(c, fieldName, e.target.value), ...props,
    });
    return h('tr', { class: 'is-checkup', dataset: { id: c.id, kind: 'checkup' } },
      !branchId ? h('td', {}, h('div', { class: 'cell muted nowrap' }, branchName(c.branch_id))) : null,
      h('th', { scope: 'row', class: 'frozen row-head' }, h('div', { class: 'cell' },
        tokenIn,
        h('div', { class: 'checkup-name' }, nameIn, h('div', { class: 'muted field-hint' }, hint)))),
      h('td', {}, h('div', { class: 'cell row-flags' },
        h('span', { class: 'badge badge-checkup' }, 'Checkup'),
        h('button', { type: 'button', class: 'btn btn-small', 'aria-haspopup': 'dialog', 'aria-label': `Checkup options for ${who}`, dataset: { focus: 'options' }, onclick: () => checkupOptions(c) }, 'Options'))),
      h('td', {}, h('div', { class: 'cell' }, h('span', { class: 'muted' }, h('span', { 'aria-hidden': 'true' }, '–'), srOnly('Not braces')))),
      h('td', { style: { minWidth: '150px' } }, text('checkup_for', 'Treatment', { list: 'sheet-treatments' })),
      h('td', {}, h('div', { class: 'cell' }, status)),
      h('td', { style: { minWidth: '250px' } }, text('doctors', "Doctor's name", { list: 'sheet-doctors' })),
      h('td', { style: { minWidth: '230px' } }, h('div', { class: 'cell details-cell' }, text('details', 'Treatment details', { placeholder: 'e.g. Scaling advised' }))),
      h('td', { class: 'right' }, h('div', { class: 'cell' }, '')),
      h('td', { style: { minWidth: '160px' } }, text('notes', 'Notes')),
      h('td', {}, text('phone', 'Phone', { type: 'tel', onchange: (e) => saveCheckup(c, 'phone', e.target.value), oninput: null })));
  }

  // Redraws replace rows, so remember the focused control (row id + data-focus key + caret) and
  // put focus back on the same control in the new row, or on "+ add" when a removed chip had it.
  function rememberFocus() {
    const el = document.activeElement;
    if (!el || !tableBody.contains(el)) return null;
    let caret = null;
    try { if (typeof el.selectionStart === 'number') caret = [el.selectionStart, el.selectionEnd]; } catch { /* not a text field */ }
    return { rowId: el.closest('tr')?.dataset.id, key: el.dataset.focus, caret };
  }
  function restoreFocus(saved) {
    const tr = saved && [...tableBody.querySelectorAll('tr[data-id]')].find((t) => t.dataset.id === saved.rowId);
    if (!tr) return;
    const target = (saved.key && [...tr.querySelectorAll('[data-focus]')].find((el) => el.dataset.focus === saved.key))
      || tr.querySelector('[data-focus="add-person"]') || tr.querySelector('[data-focus="patient"]') || tr.querySelector('[data-focus="name"]');
    target?.focus({ preventScroll: true });
    if (saved.caret && target?.setSelectionRange) { try { target.setSelectionRange(saved.caret[0], saved.caret[1]); } catch { /* not a text field */ } }
  }

  // Replace one row after a save (make = rowEl for a visit, checkupRowEl for a checkup patient).
  function redrawRow(row, make = rowEl) {
    const old = tableBody.querySelector(`tr[data-id="${row.id}"]`);
    if (old) {
      const saved = old.contains(document.activeElement) ? rememberFocus() : null;
      old.replaceWith(make(row));
      restoreFocus(saved);
    }
    drawCounts();
    markInvalid();
  }

  function drawCounts() {
    const by = (s) => rows.filter((r) => r.status === s).length;
    const people = checkupsMissing ? '' : ` · ${shownCheckups().length} checkups`;
    counts.textContent = `${rows.length} patients · ${by('waiting')} waiting · ${by('in_treatment')} in treatment · ${by('completed')} completed${people}`;
  }

  function draw() {
    const shown = rows.filter(matches);
    const shownChecks = shownCheckups();
    branchHead.hidden = !!branchId;
    addPanel.hidden = !branchId || !search;
    // "+ Checkup patient" only where checkups exist (the database update has been run) and for today or an earlier day.
    checkupBtn.hidden = checkupsMissing || date > localISO() || !can('sheet.edit');
    addHint.textContent = checkupBtn.hidden ? ADD_HINT_PLAIN : ADD_HINT_CHECKUP;
    warnBox.hidden = !checkupsWarn;
    warnBox.textContent = checkupsWarn ? `Checkup patients could not be loaded: ${checkupsWarn}` : '';
    const saved = rememberFocus();
    mount(tableBody, shown.length || shownChecks.length ? [...shown.map(rowEl), ...shownChecks.map(checkupRowEl)]
      : h('tr', {}, h('td', { colspan: 11 }, h('div', { class: 'empty' }, branchId ? `No patients or checkups on the list for ${branchName(branchId)} on this day yet. Use "Add a patient" above to add them.` : 'No patients or checkups on any list for this day.'))));
    restoreFocus(saved);
    drawCounts();
    markInvalid();
  }

  // Arrow keys / Enter move between cells like a spreadsheet.
  function onKey(e) {
    if (!['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key) || !e.target.classList.contains('cell-input')) return;
    const td = e.target.closest('td, th'); // (the name of a checkup patient sits in the row header)
    const tr = td.parentElement;
    const col = [...tr.children].indexOf(td);
    const target = e.key === 'ArrowUp' ? tr.previousElementSibling : tr.nextElementSibling;
    const next = target?.children[col]?.querySelector('.cell-input');
    if (next) { e.preventDefault(); next.focus(); next.select?.(); }
  }

  // (treatment: what a person who was a checkup patient came for, when they are put on the list as a patient)
  async function addPatient(p, treatment) {
    try {
      const braces = !!p.braces_active;
      const row = await d.addVisit({ patient_id: p.id, branch_id: branchId, visit_date: date, treatment_label: braces ? 'Monthly' : (treatment || 'Checkup'), braces, status: date === localISO() ? 'waiting' : 'scheduled' });
      rows.push(row);
      draw();
      toast(`${p.full_name} added${row.token_no ? ` with token ${row.token_no}` : ''}.`, 'ok');
      if (row.braces_month) openRow(row);
    } catch (e) { toast(notSaved(e, `${p.full_name} was not added to the list.`), 'error', 8000); }
  }

  const search = canEdit ? patientSearch({
    placeholder: 'Add patient: search name, Mr# or phone',
    label: 'Add a patient to this list: search name, Mr# or phone',
    onPick: addPatient,
    onNew: async (text) => { const p = await newPatientModal(text, branchId); if (p) addPatient(p); },
  }) : null;

  const branchHead = h('th', { scope: 'col', hidden: true }, 'Branch');
  // A person who only comes for a checkup gets no Mr#: "+ Checkup patient" puts them on this list (and on the Checkups page).
  // A patient who starts treatment and is new gets an Mr# with "+ New walk-in".
  const ADD_HINT_PLAIN = 'Search by name, Mr# or phone. New walk-in? Register them here. To book an appointment, pick that date above first.';
  const ADD_HINT_CHECKUP = 'New and starting treatment? Use "+ New walk-in" (gets an Mr#). Only a checkup? Use "+ Checkup patient" (no Mr#).';
  const addHint = h('span', { class: 'muted' }, ADD_HINT_PLAIN);
  const checkupBtn = h('button', { class: 'btn', type: 'button', hidden: true, 'aria-haspopup': 'dialog', onclick: async () => {
    const res = await checkupFormModal({ branchId, date, fixedDay: true });
    if (!res) return;
    if (res.patient) { addPatient(res.patient); return; } // the person already has a patient file: put that file on the list instead
    checkups = [...checkups, res];
    draw();
    toast(`${res.patient_name} added as a checkup patient.`, 'ok');
  } }, '+ Checkup patient');
  const addPanel = search ? h('div', { class: 'add-panel' },
    h('div', { class: 'add-panel-text' },
      h('strong', {}, 'Add a patient to this list'),
      addHint),
    search,
    can('patients.create') ? h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => { const p = await newPatientModal('', branchId); if (p) addPatient(p); } }, '+ New walk-in') : null,
    checkupBtn) : h('div', { hidden: true });
  const warnBox = h('div', { class: 'alert alert-warning', role: 'status', hidden: true });
  document.addEventListener('sheet-reload', () => load(), { signal: life.signal });
  const userIsBusy = () => q.pendingCount || tableBody.contains(document.activeElement) || document.querySelector('.modal');
  // Live: reload the moment anyone changes this branch's list (unless this person is typing,
  // or the tab is hidden; then the next check, or coming back to the tab, picks it up).
  let liveTimer = null;
  let stopLive = null;
  let stopLiveCheckups = null; // the Google Sheet sync (and other staff) add and change checkup rows too
  const onLive = () => { clearTimeout(liveTimer); liveTimer = setTimeout(() => { if (!document.hidden && !userIsBusy()) load(); }, 300); };
  const listen = () => {
    stopLive?.(); stopLiveCheckups?.();
    stopLive = d.subscribeVisits ? d.subscribeVisits(branchId || null, onLive) : null;
    stopLiveCheckups = d.subscribeCheckups && !checkupsMissing ? d.subscribeCheckups(branchId || null, onLive) : null;
  };
  branchSel.addEventListener('change', listen);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !userIsBusy()) load(); }, { signal: life.signal });
  // Safety net: also check every 20 seconds while the tab is visible and nobody is typing.
  const poll = setInterval(() => {
    if (!document.body.contains(tableBody)) { stop(); return; }
    if (!document.hidden && !userIsBusy()) load();
  }, 20000);
  function stop() {
    life.abort();
    clearInterval(poll);
    clearTimeout(liveTimer);
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
  mount(root,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Aaj ki List'), h('p', {}, counts)),
      saveStatus),
    failBox,
    undoBox,
    warnBox,
    statusHint,
    h('div', { class: 'sheet-toolbar' }, branchSel, dateInput, filterSel, doctorSel, groupSel, findBox,
      h('label', { class: 'inline', style: { gap: '4px' } }, duesBox, 'With dues'), h('label', { class: 'inline', style: { gap: '4px' } }, bracesBox, 'Braces only'),
      h('button', { class: 'btn', onclick: () => { date = localISO(); dateInput.value = date; setURL(); load(); } }, 'Today'),
      h('a', { class: 'btn', href: `#/staff/queue?branch=${branchId || ''}` }, 'Queue board'),
      can('export.data') || can('finance.view') ? h('button', { class: 'btn', onclick: download }, 'Download') : null),
    addPanel,
    h('datalist', { id: 'sheet-treatments' }, state.ref.treatments.map((t) => h('option', { value: t.name }))),
    h('datalist', { id: 'sheet-doctors' }, state.ref.clinicians.filter((c) => c.is_doctor).map((c) => h('option', { value: c.display_name }))),
    h('div', { class: 'sheet-wrap', onkeydown: onKey },
      h('table', { class: 'sheet' },
        h('thead', {}, h('tr', {},
          branchHead,
          h('th', { scope: 'col', class: 'frozen', style: { minWidth: '210px' } }, 'Token · Patient'), h('th', { scope: 'col' }, 'Flags'), h('th', { scope: 'col' }, 'Month'), h('th', { scope: 'col' }, 'Treatment'),
          h('th', { scope: 'col' }, 'Status'), h('th', { scope: 'col' }, "Doctor's name"), h('th', { scope: 'col' }, 'Treatment details'), h('th', { scope: 'col', class: 'right' }, 'Dues'),
          h('th', { scope: 'col' }, 'Notes'), h('th', { scope: 'col' }, 'Contact'))),
        tableBody)));

  await load();
  if (!signal?.aborted) listen(); // after the first load, which tells whether checkups exist at all
  q.setOnline(navigator.onLine);
  $$('.cell-input', root)[0]?.blur();
}
