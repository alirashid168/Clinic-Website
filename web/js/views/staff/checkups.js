// Checkups: the list of people who came for a checkup and have no patient file (no Mr#). The new ones from the
// daily list (website or Google Sheet) land here by themselves; the old "Checkup karwaliya" list is imported by Dr. Ali.
// Staff set the follow-up status and write notes here, and register someone as a patient (with an Mr#) when they
// start treatment. Notes save by themselves and wait on this device if the internet drops; the follow-up status and
// everything else needs the connection and says so when it fails.
import { h, mount, toast, friendlyError, isLostAnswer, empty, modal, field, select, localISO, announce, shortDate, phoneLink, showFormErrors, clearFieldErrors, busy, srOnly } from '../../ui/dom.js';
import { state, can, isAdmin, myBranches, branchName } from '../../state.js';
import { AutosaveQueue, PermanentSaveError } from '../../lib/autosave.js';
import { FOLLOW_UP_STATUSES, SOURCE_LABELS, monthLabel, checkupsToSheet } from '../../lib/checkups.js';
import { loadSheetJS } from '../../lib/sheetjs.js';
import { followUpSelect, registerCheckupModal, removeCheckupModal, checkupFormModal, canRemoveCheckup, canRegisterCheckup, registeredMr } from './checkup-actions.js';

const QUEUE_KEY = 'checkups-pending-v1';
const PAGE_SIZE = 50;
const FIELD_NAMES = { notes: 'Notes' };
const MISSING_TEXT = 'The checkup list is not switched on yet. It appears here once the database update has been run.';
const SOURCES = ['website', 'google_sheet', 'archive'];

// Same wording rules as the Aaj ki List: only a browser that reports itself offline is "no internet connection".
const notSaved = (e, still) => {
  if (!navigator.onLine) return `Not saved: no internet connection. ${still} Try again once you are back online.`;
  if (isLostAnswer(e)) return 'The server did not answer, so this may not have been saved. Reload the page to check, then try again.';
  return friendlyError(e);
};
const errorText = (error) => {
  const msg = typeof error === 'string' ? error : error?.message;
  if (!msg) return '';
  if (isLostAnswer({ message: msg })) return `${navigator.onLine ? 'The server did not answer.' : 'No internet connection.'} Your change is kept on this device.`;
  return friendlyError({ message: msg });
};

// ---------------------------------------------------------------- offline queue for the notes
// One queue per signed-in staff member (autosave.js keeps their edits under a key with their user id),
// so a note typed offline is never sent under someone else's login on a shared computer.
let queue = null;
let queueUser = null;
let saveUI = null; // the save-status display of the Checkups page on screen, if any
let hadProblem = false;

const currentUser = () => state.session?.staff?.id || null;
const failedEdits = () => (Array.isArray(queue?.failed) ? queue.failed : []);

function describeEdit(edit) {
  if (!edit) return 'a change';
  const name = saveUI?.nameOf(edit.rowId) || 'a checkup patient';
  const what = Object.entries(edit.changes || {}).map(([f, v]) => `${FIELD_NAMES[f] || f} "${String(v ?? '').slice(0, 60)}"`).join(', ');
  return `${name}, ${what}`;
}

function showSaveState(s, pending) {
  if (s === 'error' || s === 'offline') hadProblem = true;
  else if (s === 'saved' && hadProblem) { hadProblem = false; announce('All changes on the Checkups page are saved.'); }
  saveUI?.update(s, pending, failedEdits());
}

function getQueue() {
  const uid = currentUser();
  if (queue && queueUser === uid && !queue.disposed) return queue;
  if (queue && !queue.disposed) queue.dispose();
  let store;
  try { store = window.localStorage; store.getItem('x'); } catch { store = { getItem: () => null, setItem: () => {}, removeItem: () => {} }; }
  const q = new AutosaveQueue({
    store,
    storageKey: QUEUE_KEY,
    userId: uid,
    send: async (edit) => {
      if (currentUser() !== uid) { q.dispose(); throw new Error('Signed out: the change is kept on this device.'); }
      try {
        // null = the checkup was removed meanwhile (or is not visible any more): nothing left to save, the list is refreshed.
        if ((await state.data.updateCheckup(edit.rowId, edit.changes)) === null) document.dispatchEvent(new CustomEvent('checkups-reload'));
      } catch (e) {
        if (isLostAnswer(e)) throw e; // the queue retries quietly; anything else is the server's "no"
        document.dispatchEvent(new CustomEvent('checkups-reload'));
        throw new PermanentSaveError(e?.message || String(e));
      }
    },
    onState: (s, pending) => { if (queue === q) showSaveState(s, pending); },
    onFailed: (detail) => {
      if (queue !== q || currentUser() !== uid) return;
      toast(`Not saved: ${describeEdit(detail.edit)}. ${errorText(detail.error)} Use "Try again" at the top of the Checkups page.`, 'error', 12000);
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

const whenText = (c) => (!c.checkup_date ? 'Not recorded' : c.date_is_month ? monthLabel(c.checkup_date) : shortDate(c.checkup_date));
const sourceText = (c) => (c.source === 'archive' ? `${SOURCE_LABELS.archive}${c.source_tab ? `: ${c.source_tab}` : ''}` : SOURCE_LABELS[c.source] || c.source || '');
const number = (n) => Number(n || 0).toLocaleString('en-PK');
// Only digits (a piece of a phone number) and fewer than 4 of them: the search cannot use that for a phone, so the empty list says why.
const shortPhoneFragment = (q) => { const t = String(q || '').trim(); const n = t.replace(/\D/g, '').length; return n > 0 && n < 4 && !/[^\d\s+()-]/.test(t); };

let stopPrevious = null;

export async function renderCheckups(root, params, signal) {
  stopPrevious?.();
  if (signal?.aborted) return;
  const d = state.data;
  const q = getQueue();
  const life = new AbortController();
  const canEdit = can('sheet.edit');
  const branches = myBranches();

  // ---- what is asked for (kept in the address, so a link or a reload shows the same list)
  const branchOk = (v) => v === 'none' || branches.some((b) => String(b.id) === v);
  const f = {
    q: (params.get('q') || '').slice(0, 100),
    branch: branchOk(params.get('branch') || '') ? params.get('branch') : '',
    from: /^\d{4}-\d{2}$/.test(params.get('from') || '') ? params.get('from') : '',
    to: /^\d{4}-\d{2}$/.test(params.get('to') || '') ? params.get('to') : '',
    status: (params.get('status') || '').slice(0, 60),
    source: SOURCES.includes(params.get('source')) ? params.get('source') : '',
    file: ['yes', 'no'].includes(params.get('file')) ? params.get('file') : '',
    page: Math.max(0, (parseInt(params.get('page'), 10) || 1) - 1),
  };
  const args = () => ({
    q: f.q.trim(), branchId: f.branch === 'none' ? 'none' : f.branch ? Number(f.branch) : null, from: f.from || null, to: f.to || null,
    followUp: f.status, source: f.source, registered: f.file,
  });
  const filtered = () => !!(f.q.trim() || f.branch || f.from || f.to || f.status || f.source || f.file);
  const setURL = () => {
    const p = new URLSearchParams();
    for (const [k, v] of [['q', f.q.trim()], ['branch', f.branch], ['from', f.from], ['to', f.to], ['status', f.status], ['source', f.source], ['file', f.file]]) if (v) p.set(k, v);
    if (f.page > 0) p.set('page', String(f.page + 1));
    const text = p.toString();
    history.replaceState(null, '', `#/staff/checkups${text ? `?${text}` : ''}`);
  };

  let rows = [];
  let total = 0;
  let seq = 0;

  const summary = h('p', {}, 'Loading…');
  const tbody = h('tbody', {});
  const actionsHost = h('div', { class: 'inline' });

  // ---- save status, and the list of notes that could not be saved
  const saveStatus = h('span', { class: 'save-status save-state', tabindex: '-1', dataset: { state: 'saved' } }, 'All changes saved');
  const failList = h('ul', {});
  const retryAll = h('button', { type: 'button', class: 'btn btn-small', onclick: () => { q.retryFailed(); announce('Trying the unsaved changes again.'); } }, 'Try all again');
  const retryAllHost = h('div', {});
  const failBox = h('div', { class: 'alert alert-stop', id: 'checkups-save-failures', hidden: true },
    h('strong', {}, 'These changes are not saved yet:'), failList, retryAllHost);
  const discard = (fl) => modal('Discard this change?', h('p', {}, `${describeEdit(fl.edit)} will not be saved. This cannot be undone.`), [
    { label: 'Keep it' },
    { label: 'Discard', danger: true, onClick: () => { q.discardFailed(fl.key); announce('Change discarded.'); } },
  ], { destructive: true });
  const ui = {
    nameOf: (id) => rows.find((r) => String(r.id) === String(id))?.patient_name,
    update(s, pending, failed) {
      saveStatus.dataset.state = s;
      saveStatus.classList.toggle('is-error', s === 'error');
      saveStatus.textContent = s === 'saved' ? 'All changes saved' : s === 'saving' ? `Saving ${pending || ''}…`
        : s === 'offline' ? `Offline: ${pending} typed change${pending === 1 ? '' : 's'} kept on this device`
          : `${failed.length || 'Some'} change${failed.length === 1 ? ' is' : 's are'} not saved`;
      const hadFocus = failBox.contains(document.activeElement);
      failBox.hidden = s !== 'error';
      mount(retryAllHost, failed.length > 1 ? retryAll : null);
      mount(failList, failed.map((fl) => {
        const what = describeEdit(fl.edit);
        return h('li', {}, what, fl.error ? h('span', { class: 'muted' }, ` (${errorText(fl.error)})`) : null, ' ',
          h('button', { type: 'button', class: 'btn btn-small', 'aria-label': `Try again: ${what}`, onclick: () => { q.retryFailed(fl.key); announce('Trying this change again.'); } }, 'Try again'), ' ',
          h('button', { type: 'button', class: 'btn btn-small btn-danger', 'aria-label': `Discard: ${what}`, onclick: () => discard(fl) }, 'Discard'));
      }));
      if (hadFocus && !failBox.contains(document.activeElement)) (failBox.hidden ? saveStatus : failBox.querySelector('button:not([hidden])') || saveStatus).focus();
      const bad = new Set(failed.flatMap((fl) => Object.keys(fl.edit?.changes || {}).map((k) => `${fl.edit.rowId}|${k}`)));
      for (const el of tbody.querySelectorAll('[data-field]')) {
        if (bad.has(`${el.closest('tr').dataset.id}|${el.dataset.field}`)) { el.setAttribute('aria-invalid', 'true'); el.setAttribute('aria-describedby', failBox.id); }
        else if (el.hasAttribute('aria-invalid')) { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); }
      }
    },
  };
  saveUI = ui;

  // ---- one row
  function saveNote(c, value) {
    c.notes = value;
    q.edit('checkups', c.id, 'notes', value.trim() === '' ? null : value);
  }

  function rowEl(c) {
    const who = c.patient_name;
    const mr = registeredMr(c);
    // The screen reader hears the announcement; this mark is for the eyes (the chip colour alone is easy to miss).
    const savedMark = h('span', { class: 'saved-mark', 'aria-hidden': 'true', hidden: true }, '\u2713 Saved');
    let markTimer;
    const follow = followUpSelect(c, async (value, ctl, previous) => {
      try {
        const saved = await d.updateCheckup(c.id, { follow_up: value });
        if (saved === null) { toast(`${who} is no longer on the list.`, 'error'); load(); return; }
        c.follow_up = value;
        announce(`Saved: ${who} is "${value}".`);
        savedMark.hidden = false;
        clearTimeout(markTimer);
        markTimer = setTimeout(() => { savedMark.hidden = true; }, 2500);
      } catch (e) {
        ctl.set(previous);
        toast(notSaved(e, `${who} is still "${previous}".`), 'error', 8000);
      }
    }, { disabled: !canEdit });
    const notes = h('input', {
      class: 'cell-input', value: c.notes || '', disabled: !canEdit, maxlength: 2000, 'aria-label': `Notes for ${who}`,
      dataset: { focus: 'notes', field: 'notes' }, oninput: (e) => saveNote(c, e.target.value),
    });
    return h('tr', { dataset: { id: c.id } },
      h('td', { class: 'nowrap' }, whenText(c)),
      h('th', { scope: 'row', class: 'checkup-who' },
        h('div', { class: 'checkup-name-text' }, who),
        c.phone ? h('div', { class: 'field-hint' }, phoneLink(c.phone)) : null,
        c.patient_id ? (mr ? h('a', { class: 'mr', href: `#/staff/patient/${c.patient_id}` }, `Mr# ${mr}`) : h('span', { class: 'badge badge-ok' }, 'Has a patient file')) : null),
      h('td', {}, c.branch_id ? branchName(c.branch_id) : h('span', { class: 'muted' }, 'No branch')),
      h('td', {}, c.checkup_for || h('span', { class: 'muted' }, '–'), c.doctors ? h('div', { class: 'muted field-hint' }, c.doctors) : null),
      h('td', {}, h('div', { class: 'cell' }, follow, savedMark)),
      h('td', { class: 'cell-td' }, notes),
      h('td', { class: 'muted' }, sourceText(c)),
      h('td', {}, h('div', { class: 'row-actions' },
        !c.patient_id && canRegisterCheckup()
          ? h('button', { type: 'button', class: 'btn btn-small', 'aria-haspopup': 'dialog', 'aria-label': `Register ${who} as a patient`, dataset: { focus: 'register' }, onclick: () => registerCheckupModal(c, { onDone: () => load() }) }, 'Register') : null,
        canEdit ? h('button', { type: 'button', class: 'btn btn-small', 'aria-haspopup': 'dialog', 'aria-label': `Edit ${who}`, dataset: { focus: 'edit' }, onclick: () => editModal(c) }, 'Edit') : null)));
  }

  function editModal(c) {
    const stamp = Math.random().toString(36).slice(2, 7);
    const name = h('input', { value: c.patient_name, maxlength: 200, autocomplete: 'off' });
    const phone = h('input', { type: 'tel', value: c.phone || '', maxlength: 40 });
    const city = h('input', { value: c.city || '', maxlength: 80 });
    const branchChoices = [{ value: '', label: 'No branch' }, ...branches.map((b) => ({ value: b.id, label: b.name }))];
    if (c.branch_id && !branchChoices.some((b) => String(b.value) === String(c.branch_id))) branchChoices.push({ value: c.branch_id, label: branchName(c.branch_id) || `Branch ${c.branch_id}` });
    const branch = select(branchChoices, c.branch_id ?? '');
    const doctors = h('input', { value: c.doctors || '', maxlength: 300, list: `ce-doctors-${stamp}`, autocomplete: 'off' });
    const checkupFor = h('input', { value: c.checkup_for || '', maxlength: 300, list: `ce-treatments-${stamp}`, autocomplete: 'off' });
    const details = h('textarea', { rows: 2, maxlength: 2000, value: c.details || '' });
    const fee = h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', value: c.est_fee ?? '' });
    const body = h('div', {},
      c.source === 'archive' && isAdmin() ? h('p', { class: 'muted' }, 'This row came from the old list. If you change the name or phone, importing that file again adds this person a second time.') : null,
      h('div', { class: 'form-grid' },
        field('Name', name, null, { required: true }), field('Phone number', phone), field('City', city), field('Branch', branch),
        field("Doctor's name", doctors), field('Treatment', checkupFor), field('Treatment details', details), field('Estimated fee (Rs)', fee, 'Optional.')),
      h('datalist', { id: `ce-doctors-${stamp}` }, state.ref.clinicians.filter((x) => x.is_doctor).map((x) => h('option', { value: x.display_name }))),
      h('datalist', { id: `ce-treatments-${stamp}` }, state.ref.treatments.map((t) => h('option', { value: t.name }))));
    modal(`Edit ${c.patient_name}`, body, [
      { label: 'Cancel' },
      ...(canRemoveCheckup(c) ? [{ label: 'Remove', danger: true, onClick: () => { removeCheckupModal(c, { onDone: () => load() }); } }] : []),
      { label: 'Save', primary: true, onClick: async () => {
        const errors = [];
        if (!name.value.trim()) errors.push({ input: name, message: 'Write the patient name.' });
        const feeNumber = fee.value === '' ? null : Number(fee.value);
        if (feeNumber !== null && (!Number.isFinite(feeNumber) || feeNumber < 0)) errors.push({ input: fee, message: 'Write the fee as a number, or leave it empty.' });
        if (errors.length) return showFormErrors(body, errors);
        clearFieldErrors(body);
        const next = {
          patient_name: name.value.trim().replace(/\s+/g, ' '), phone: phone.value.trim() || null, city: city.value.trim() || null,
          branch_id: branch.value ? Number(branch.value) : null, doctors: doctors.value.trim() || null, checkup_for: checkupFor.value.trim() || null,
          details: details.value.trim() || null, est_fee: feeNumber,
        };
        const changes = Object.fromEntries(Object.entries(next).filter(([k, v]) => (k === 'est_fee' ? (v ?? null) !== (c[k] === null || c[k] === undefined ? null : Number(c[k])) : (v ?? null) !== (c[k] ?? null))));
        if (!Object.keys(changes).length) { toast('Nothing was changed.'); return; }
        try {
          if ((await d.updateCheckup(c.id, changes)) === null) toast(`${c.patient_name} is no longer on the list.`, 'error');
          else toast(`${next.patient_name} saved.`, 'ok');
        } catch (e) { toast(notSaved(e, `${c.patient_name} was not changed.`), 'error', 8000); return false; }
        await load(); // redrawn before this dialog closes, so focus can return to the page
      } },
    ]);
  }

  // ---- the table, the paging bar and the filters
  const info = h('span', { class: 'pager-info', role: 'status' });
  const go = (delta) => () => {
    if ((delta < 0 && f.page === 0) || (delta > 0 && (f.page + 1) * PAGE_SIZE >= total)) return;
    f.page += delta;
    setURL();
    load();
    tableWrap.scrollIntoView?.({ block: 'start' });
  };
  // aria-disabled, not disabled: the button that was pressed keeps focus, also on the last page.
  const prev = h('button', { type: 'button', class: 'btn', onclick: go(-1) }, 'Previous');
  const next = h('button', { type: 'button', class: 'btn', onclick: go(1) }, 'Next');
  const pager = h('div', { class: 'pager', hidden: true }, info, h('div', { class: 'inline' }, prev, next));

  const head = (label) => h('th', { scope: 'col' }, label);
  const tableWrap = h('div', { class: 'table-scroll checkup-table-wrap' },
    h('table', { class: 'list checkup-table' },
      h('thead', {}, h('tr', {}, head('Date'), h('th', { scope: 'col', class: 'checkup-who' }, 'Patient'), head('Branch'), head('Treatment'), head('Follow-up'), head('Notes'), head('Source'), h('th', { scope: 'col' }, srOnly('Actions')))),
      tbody));

  const searchBox = h('input', { type: 'search', value: f.q, maxlength: 100, autocomplete: 'off', placeholder: 'Name or phone', 'aria-label': 'Name or phone', 'aria-describedby': 'checkup-search-hint' });
  const branchSel = select([{ value: '', label: 'All branches' }, ...branches.map((b) => ({ value: b.id, label: b.name })), { value: 'none', label: 'No branch' }], f.branch);
  const fromIn = h('input', { type: 'month', value: f.from, placeholder: 'YYYY-MM' });
  const toIn = h('input', { type: 'month', value: f.to, placeholder: 'YYYY-MM' });
  const statusChoices = [{ value: '', label: 'Any' }, ...FOLLOW_UP_STATUSES.map((s) => ({ value: s, label: s }))];
  if (f.status && !FOLLOW_UP_STATUSES.includes(f.status)) statusChoices.push({ value: f.status, label: f.status });
  const statusSel = select(statusChoices, f.status);
  const sourceSel = select([{ value: '', label: 'Any' }, ...SOURCES.map((s) => ({ value: s, label: SOURCE_LABELS[s] }))], f.source);
  const fileSel = select([{ value: '', label: 'Any' }, { value: 'yes', label: 'Has a patient file' }, { value: 'no', label: 'No patient file' }], f.file);
  const clearBtn = h('button', { type: 'button', class: 'btn', onclick: () => {
    Object.assign(f, { q: '', branch: '', from: '', to: '', status: '', source: '', file: '', page: 0 });
    searchBox.value = ''; branchSel.value = ''; fromIn.value = ''; toIn.value = ''; statusSel.value = ''; sourceSel.value = ''; fileSel.value = '';
    setURL(); load(); searchBox.focus();
  } }, 'Clear filters');

  const changed = () => { f.page = 0; setURL(); load(); };
  let typing;
  searchBox.addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(() => { f.q = searchBox.value; changed(); }, 300); });
  searchBox.addEventListener('search', () => { clearTimeout(typing); if (f.q !== searchBox.value) { f.q = searchBox.value; changed(); } });
  searchBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(typing); f.q = searchBox.value; changed(); } });
  for (const [el, key] of [[branchSel, 'branch'], [fromIn, 'from'], [toIn, 'to'], [statusSel, 'status'], [sourceSel, 'source'], [fileSel, 'file']]) {
    el.addEventListener('change', () => { f[key] = el.value; changed(); });
  }
  const ff = (label, control, cls, hint) => h('label', { class: ['filter-field', cls] }, h('span', { class: 'filter-label' }, label), control, hint || null);
  // Name or phone and Follow-up are what people use all day; the rest sits behind "More filters" (open when one of them is in use).
  const moreCount = () => [f.branch, f.from, f.to, f.source, f.file].filter(Boolean).length;
  const moreSummary = h('summary', {}, 'More filters');
  const more = h('details', { class: 'checkup-more', open: moreCount() > 0 },
    moreSummary,
    h('div', { class: 'checkup-more-grid' }, ff('Branch', branchSel), ff('Month from', fromIn), ff('Month to', toIn), ff('Source', sourceSel), ff('Patient file', fileSel)));
  const toolbar = h('div', { class: 'checkup-filters' },
    ff('Name or phone', searchBox, 'filter-wide', h('span', { class: 'filter-hint', id: 'checkup-search-hint' }, 'Part of the name, or at least 4 digits of the phone.')),
    ff('Follow-up', statusSel), h('div', { class: 'filter-clear' }, clearBtn), more);

  function draw() {
    const first = f.page * PAGE_SIZE + 1;
    const people = `${number(total)} checkup patient${total === 1 ? '' : 's'}`;
    summary.textContent = filtered() ? `${people} ${total === 1 ? 'matches' : 'match'} these filters` : people;
    moreSummary.textContent = moreCount() ? `More filters (${moreCount()} in use)` : 'More filters';
    const active = document.activeElement;
    const focusKey = active && tbody.contains(active) ? { id: active.closest('tr')?.dataset.id, key: active.dataset.focus, caret: typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null } : null;
    mount(tbody, rows.length ? rows.map(rowEl)
      : h('tr', {}, h('td', { colspan: 8 }, h('div', { class: 'empty' }, filtered() ? `No checkups match these filters.${shortPhoneFragment(f.q) ? ' To search by phone, type at least 4 digits.' : ''}` : 'No checkups on the list yet.'))));
    if (focusKey) {
      const tr = [...tbody.querySelectorAll('tr[data-id]')].find((t) => t.dataset.id === focusKey.id);
      const el = tr && [...tr.querySelectorAll('[data-focus]')].find((x) => x.dataset.focus === focusKey.key);
      el?.focus({ preventScroll: true });
      if (el && focusKey.caret && el.setSelectionRange) { try { el.setSelectionRange(focusKey.caret[0], focusKey.caret[1]); } catch { /* not a text field */ } }
    }
    pager.hidden = !rows.length && total === 0;
    info.textContent = rows.length ? `Showing ${number(first)}-${number(first + rows.length - 1)} of ${number(total)}` : `Showing 0 of ${number(total)}`;
    const atStart = f.page === 0;
    const atEnd = (f.page + 1) * PAGE_SIZE >= total;
    prev.setAttribute('aria-disabled', String(atStart));
    next.setAttribute('aria-disabled', String(atEnd));
    clearBtn.disabled = !filtered();
    tableWrap.setAttribute('aria-busy', 'false');
  }

  function buildActions() {
    mount(actionsHost,
      canEdit ? h('button', { type: 'button', class: 'btn btn-primary', 'aria-haspopup': 'dialog', onclick: () => checkupFormModal({ branchId: f.branch && f.branch !== 'none' ? Number(f.branch) : null, onSaved: () => load() }) }, '+ Add checkup') : null,
      can('export.data') ? h('button', { type: 'button', class: 'btn', onclick: busy(download) }, 'Download Excel') : null);
  }

  function showMissing() {
    life.abort();
    mount(root, h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Checkups'))), empty(MISSING_TEXT));
  }

  async function load() {
    const mine = ++seq;
    tableWrap.setAttribute('aria-busy', 'true');
    let res;
    try {
      res = await d.listCheckups({ ...args(), page: f.page, pageSize: PAGE_SIZE });
    } catch (e) {
      if (mine !== seq || signal?.aborted) return;
      if (e?.code === 'CHECKUPS_MISSING') { showMissing(); return; }
      tableWrap.setAttribute('aria-busy', 'false');
      toast(friendlyError(e), 'error');
      return;
    }
    if (mine !== seq || signal?.aborted) return; // the filters changed meanwhile: this answer is out of date
    rows = res.rows || [];
    total = Number(res.total ?? rows.length);
    if (!rows.length && total > 0 && f.page > 0) { f.page = Math.ceil(total / PAGE_SIZE) - 1; setURL(); await load(); return; } // the last page emptied out
    draw();
  }

  // Everything for the current filters, as a real Excel file (phones keep their leading 0).
  async function download() {
    announce('Preparing the Excel file…');
    const list = await d.exportCheckups(args());
    if (!list.length) { toast('Nothing to download yet.'); return; }
    let XLSX;
    try { XLSX = await loadSheetJS(); } catch { toast('The Excel library could not load. Check the internet connection and try again.', 'error'); return; }
    const aoa = checkupsToSheet(list, state.ref.branches);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // Phones, months and dates stay text (a phone like 0300-5550142 must not turn into a number or a date).
    const textColumns = ['Month', 'Phone', 'Date', 'Added on', 'Mr#'].map((x) => aoa[0].indexOf(x)).filter((i) => i >= 0 && i < 26);
    for (let r = 1; r < aoa.length; r += 1) {
      for (const c of textColumns) {
        const cell = ws[`${String.fromCharCode(65 + c)}${r + 1}`];
        if (cell && cell.t !== 's') { cell.t = 's'; cell.v = String(cell.v); delete cell.w; }
      }
    }
    ws['!cols'] = aoa[0].map((label) => ({ wch: /name|treatment|notes|source|doctor/i.test(label) ? 28 : 14 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Checkups');
    const code = f.branch === 'none' ? 'NONE' : f.branch ? state.ref.branches.find((b) => b.id === Number(f.branch))?.code || 'BRANCH' : 'ALL';
    XLSX.writeFile(wb, `checkups_${code}_${localISO()}.xlsx`);
    if (list.truncated) toast('Only the first 20,000 rows were downloaded. Narrow the filters to get the rest.', 'error', 10000);
    else toast(`${number(list.length)} checkups downloaded.`, 'ok');
  }

  document.addEventListener('checkups-reload', () => load(), { signal: life.signal });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !q.pendingCount && !tbody.contains(document.activeElement) && !document.querySelector('.modal')) load(); }, { signal: life.signal });
  function stop() {
    life.abort();
    clearTimeout(typing);
    if (saveUI === ui) saveUI = null;
    if (stopPrevious === stop) stopPrevious = null;
  }
  stopPrevious = stop;
  signal?.addEventListener('abort', stop, { once: true });

  buildActions();
  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Checkups'), summary), h('div', { class: 'inline page-head-actions' }, saveStatus, actionsHost)),
    failBox,
    toolbar,
    tableWrap,
    pager);
  await load();
}
