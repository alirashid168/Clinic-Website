// The page the Retainer Record and Lab Work share, laid out like the clinic's Google Sheet: a coloured header row, a row
// number, one line per row, coloured drop-down chips, tabs (cities or branches), a search and filters, an add row at the bottom
// and a CSV download. retainers.js and lab.js give it their columns and rules.
//
// Saving works like the Aaj ki List: typed cells (name, contact, notes ...) save by themselves and wait on this device if the
// internet drops (the offline queue of lib/autosave.js, one per page and per signed-in person); drop-down chips and dates save
// at once and say so when they cannot (and go back to what they were).
import { h, mount, toast, friendlyError, isLostAnswer, select, announce, srOnly, empty, tabs, shortDate, downloadCSV, localISO, busy, modal } from '../../ui/dom.js';
import { state } from '../../state.js';
import { AutosaveQueue, PermanentSaveError } from '../../lib/autosave.js';
import { editOwner } from '../../lib/desk-name.js';
import { commitOnFinish } from './common.js';
import { colourClass, sheetOrder, newestFirst, rowMatches, rowMonth, monthName } from '../../lib/records.js';

const PAGE = 100; // rows drawn at first; "Show more" adds this many

// Same wording rules as the Aaj ki List: only a browser that reports itself offline is "no internet connection".
export const notSaved = (e, still) => {
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
/** The name a row goes by: the linked patient file's, else the name typed on the row. */
export const rowName = (row) => row.patient?.full_name || row.patient_name || 'this patient';

// ---------------------------------------------------------------- the offline queue of a page
/**
 * One queue per page and per signed-in staff member (autosave.js keeps the edits under a key with their user id), so a change
 * typed offline is never sent under someone else's login on a shared computer (nor, on a shared login, under the name of the next
 * person at the desk: editOwner). `send(rowId, changes)` resolves to the saved row,
 * or null when the row is gone.
 */
export function recordQueue({ storageKey, table, page, fieldNames, send }) {
  let queue = null;
  let queueUser = null;
  let ui = null; // the save-status display of this page while it is on screen
  let hadProblem = false;
  const currentUser = () => editOwner(state.session?.staff);
  const failed = () => (Array.isArray(queue?.failed) ? queue.failed : []);
  const describe = (edit) => {
    if (!edit) return 'a change';
    const name = ui?.nameOf(edit.rowId) || 'a row';
    const what = Object.entries(edit.changes || {}).map(([f, v]) => `${fieldNames[f] || f} "${String(v ?? '').slice(0, 60)}"`).join(', ');
    return `${name}, ${what}`;
  };
  function get() {
    const uid = currentUser();
    if (queue && queueUser === uid && !queue.disposed) return queue;
    if (queue && !queue.disposed) queue.dispose();
    let store;
    try { store = window.localStorage; store.getItem('x'); } catch { store = { getItem: () => null, setItem: () => {}, removeItem: () => {} }; }
    const q = new AutosaveQueue({
      store, storageKey, userId: uid,
      send: async (edit) => {
        if (currentUser() !== uid) { q.dispose(); throw new Error('Signed out: the change is kept on this device.'); }
        try {
          if ((await send(edit.rowId, edit.changes)) === null) document.dispatchEvent(new CustomEvent(`${table}-reload`));
        } catch (e) {
          if (isLostAnswer(e)) throw e; // the queue retries quietly; anything else is the server's "no"
          document.dispatchEvent(new CustomEvent(`${table}-reload`));
          throw new PermanentSaveError(e?.message || String(e));
        }
      },
      onState: (s, pending) => {
        if (queue !== q) return;
        if (s === 'error' || s === 'offline') hadProblem = true;
        else if (s === 'saved' && hadProblem) { hadProblem = false; announce(`All changes on the ${page} are saved.`); }
        ui?.update(s, pending, failed());
      },
      onFailed: (detail) => {
        if (queue !== q || currentUser() !== uid) return;
        toast(`Not saved: ${describe(detail.edit)}. ${errorText(detail.error)} Use "Try again" at the top of the ${page}.`, 'error', 12000);
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
  return { get, table, describe, failed, typedFields: Object.keys(fieldNames), setUI: (u) => { ui = u; }, clearUI: (u) => { if (ui === u) ui = null; } };
}

// ---------------------------------------------------------------- cells
/** A read-only chip. */
export const pill = (label, colour) => h('span', { class: ['pill', colourClass(colour)] }, label);

/**
 * A drop-down chip: a native select in the colour of what is chosen. options: [{ value, label, colour }]. A value that is not on
 * the list (a status typed on the sheet, a team member switched off) stays, as written, in grey. The empty choice is a blank grey
 * chip, like the sheet's. onCommit(next, previous, ctl) runs once the person has finished choosing (common.js commitOnFinish).
 */
export function pillSelect({ options, value, label, onCommit, allowEmpty = true, focus, field, other = null }) {
  const v = value === null || value === undefined ? '' : String(value);
  const list = options.map((o) => ({ ...o, value: String(o.value) }));
  if (v && !list.some((o) => o.value === v)) list.push({ value: v, label: other ? other(v) : v, colour: 'grey' });
  const all = allowEmpty ? [{ value: '', label: '', colour: 'grey' }, ...list] : list;
  const colourOf = (x) => all.find((o) => o.value === String(x))?.colour || 'grey';
  const sel = h('select', { class: ['pill', colourClass(colourOf(v))], 'aria-label': label, dataset: { focus, field } },
    all.map((o) => h('option', { value: o.value, selected: o.value === v }, o.label)));
  const paint = (x) => { sel.className = `pill ${colourClass(colourOf(x))}`; };
  const ctl = commitOnFinish(sel, (next, previous) => onCommit(next, previous, ctl), paint);
  return sel;
}

// ---------------------------------------------------------------- the page
/**
 * cfg = {
 *   page: 'Retainer Record', title, accent: 'purple' | 'teal', path: '#/staff/retainers', intro,
 *   tabs: [{ id, label }], tab, tabParam ('city' | 'branch'),
 *   queue: recordQueue(...), canEdit, canDownload, canAdd,
 *   columns: [{ key, label, kind: 'who' | 'mr' | 'text' | 'money' | 'date' | 'pill', width, max, textKey, options(row, tab), askValue, ask(row) }],
 *   whoNote(row, tab) -> a short text after the name (the branch, on an "All branches" tab),
 *   load(tab) -> rows, save(id, changes) -> row | null,
 *   filters: [{ key, label, always (in sight on a phone too), options(rows, tab) -> [{ value, label, colour }], test(row, value),
 *              other(value) -> the words for a value the tab has no option for (from an address: never the raw id) }], monthKeys,
 *   banner(ctx) -> { el, update() } | null, notice(ctx) -> { head (a line under the title), el (over the sheet), update() } | null,
 *   onSaved(row, changes, before), rowClass(row, today), decorate(col, row, today),
 *   add(tab) -> Promise<row | null>, addLabel, rowOptions(row, { tab, save(changes, what) -> row | null, removed(), reload() }),
 *   csv(rows, tab) -> { filename, rows }, words: ['retainer', 'retainers'], missingText, emptyText,
 * }
 * The banner and the notice get ctx = { rows, tab, today, filter(key), setFilter(key, value), open(row) (the row's "More" dialog) } and are
 * drawn again after a load, a change of a row and a change of a filter.
 */
export async function renderRecordSheet(root, params, signal, cfg) {
  const q = cfg.queue.get();
  const life = new AbortController();
  const today = localISO();
  let tab = cfg.tab;
  let rows = [];
  let shown = PAGE;
  let seq = 0;
  let freshId = null;
  let tabMoved = false; // another tab was opened: its first load takes off a filter value the tab has no option for
  const mrColumn = cfg.columns.some((c) => c.kind === 'mr'); // (then the Mr# is not repeated next to a linked name)
  const filterKeys = cfg.filters.map((x) => x.key);
  const f = { q: (params.get('q') || '').slice(0, 100), month: /^\d{4}-\d{2}$/.test(params.get('month') || '') ? params.get('month') : '', order: params.get('order') === 'sheet' ? 'sheet' : 'newest' };
  for (const k of filterKeys) f[k] = (params.get(k) || '').slice(0, 80);
  const filtered = () => !!(f.q.trim() || f.month || filterKeys.some((k) => f[k]));
  const setURL = () => {
    const p = new URLSearchParams();
    p.set(cfg.tabParam, String(tab));
    for (const [k, v] of [['q', f.q.trim()], ...filterKeys.map((k) => [k, f[k]]), ['month', f.month], ['order', f.order === 'sheet' ? 'sheet' : '']]) if (v) p.set(k, v);
    history.replaceState(null, '', `${cfg.path}?${p}`);
  };

  // ---- save status, and the list of typed changes that could not be saved
  const saveStatus = h('span', { class: 'save-status save-state', tabindex: '-1', dataset: { state: 'saved' } }, 'All changes saved');
  const failList = h('ul', {});
  const retryAll = h('button', { type: 'button', class: 'btn btn-small', onclick: () => { q.retryFailed(); announce('Trying the unsaved changes again.'); } }, 'Try all again');
  const retryAllHost = h('div', {});
  const failBox = h('div', { class: 'alert alert-stop', id: `${cfg.queue.table}-save-failures`, hidden: true }, h('strong', {}, 'These changes are not saved yet:'), failList, retryAllHost);
  const tbody = h('tbody', {});
  const discard = (fl) => modal('Discard this change?', h('p', {}, `${cfg.queue.describe(fl.edit)} will not be saved. This cannot be undone.`), [
    { label: 'Keep it' },
    { label: 'Discard', danger: true, onClick: () => { q.discardFailed(fl.key); announce('Change discarded.'); } },
  ], { destructive: true });
  const ui = {
    nameOf: (id) => { const r = rows.find((x) => String(x.id) === String(id)); return r ? rowName(r) : null; },
    update(s, pending, failed) {
      saveStatus.dataset.state = s;
      saveStatus.classList.toggle('is-error', s === 'error');
      saveStatus.textContent = s === 'saved' ? 'All changes saved' : s === 'saving' ? `Saving ${pending || ''}…`
        : s === 'offline' ? `Offline: ${pending} typed change${pending === 1 ? '' : 's'} kept on this device`
          : `${failed.length || 'Some'} change${failed.length === 1 ? ' is' : 's are'} not saved`;
      const hadFocus = failBox.contains(document.activeElement);
      if (failBox.hidden !== (s !== 'error')) { failBox.hidden = s !== 'error'; fitSoon(); }
      mount(retryAllHost, failed.length > 1 ? retryAll : null);
      mount(failList, failed.map((fl) => {
        const what = cfg.queue.describe(fl.edit);
        return h('li', {}, what, fl.error ? h('span', { class: 'muted' }, ` (${errorText(fl.error)})`) : null, ' ',
          h('button', { type: 'button', class: 'btn btn-small', 'aria-label': `Try again: ${what}`, onclick: () => { q.retryFailed(fl.key); announce('Trying this change again.'); } }, 'Try again'), ' ',
          h('button', { type: 'button', class: 'btn btn-small btn-danger', 'aria-label': `Discard: ${what}`, onclick: () => discard(fl) }, 'Discard'));
      }));
      if (hadFocus && !failBox.contains(document.activeElement)) (failBox.hidden ? saveStatus : failBox.querySelector('button') || saveStatus).focus();
      const bad = new Set(failed.flatMap((fl) => Object.keys(fl.edit?.changes || {}).map((k) => `${fl.edit.rowId}|${k}`)));
      for (const el of tbody.querySelectorAll('[data-field]')) {
        if (bad.has(`${el.closest('tr').dataset.id}|${el.dataset.field}`)) { el.setAttribute('aria-invalid', 'true'); el.setAttribute('aria-describedby', failBox.id); }
        else if (el.hasAttribute('aria-invalid')) { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); }
      }
    },
  };
  cfg.queue.setUI(ui);

  // ---- saving
  function typed(row, field, value) {
    row[field] = value;
    q.edit(cfg.queue.table, row.id, field, typeof value === 'string' && value.trim() === '' ? null : value);
  }
  async function saveNow(row, changes, { ctl = null, previous = null, what } = {}) {
    const before = { ...row };
    const who = rowName(row);
    try {
      const saved = await cfg.save(row.id, changes);
      if (saved === null) { toast(`${who} is no longer on the list.`, 'error'); load(); return null; }
      // The row comes back as the server has it. The typed cells (name, notes ...) belong to the offline queue, which may not have sent
      // them yet (waiting, on a slow line, or refused), so the row keeps what was typed there; the redraw must never empty a note.
      const typedHere = Object.fromEntries(cfg.queue.typedFields.filter((k) => !(k in changes) && k in row).map((k) => [k, row[k]]));
      Object.assign(row, saved, typedHere);
      redrawRow(row);
      announce(`Saved: ${what || 'the change'} for ${who}.`);
      cfg.onSaved?.(row, changes, before);
      afterChange();
      return row;
    } catch (e) {
      if (ctl) ctl.set(previous);
      toast(notSaved(e, `${who} was not changed.`), 'error', 9000);
      return null;
    }
  }

  // ---- one row
  function whoCell(row, n) {
    const who = rowName(row);
    let nameEl;
    if (row.patient_id && row.patient) {
      nameEl = h('span', { class: 'rs-name', title: who }, h('a', { href: `#/staff/patient/${row.patient_id}`, dataset: { focus: 'name' } }, row.patient.full_name),
        row.patient.mr_number && !mrColumn ? h('span', { class: 'mr' }, `Mr# ${row.patient.mr_number}`) : null);
    } else if (cfg.canEdit) {
      // (a name longer than the cell ends in "…"; the tooltip has it whole)
      nameEl = h('input', {
        class: 'cell-input', value: row.patient_name || '', title: row.patient_name || '', maxlength: 200, autocomplete: 'off', 'aria-label': `Patient name, row ${n}`,
        dataset: { focus: 'name', field: 'patient_name' },
        onchange: (e) => {
          const v = e.target.value.trim().replace(/\s+/g, ' ');
          if (!v) { e.target.value = row.patient_name || ''; toast('A row needs a name. The old name is back.', 'error'); return; }
          if (v === row.patient_name) return;
          e.target.value = v;
          e.target.title = v;
          typed(row, 'patient_name', v);
        },
      });
    } else nameEl = h('span', { class: 'rs-name', title: who }, row.patient_name || '');
    const more = h('button', { type: 'button', class: 'rs-more', 'aria-haspopup': 'dialog', 'aria-label': `More for ${who} (row ${n})`, title: 'More', dataset: { focus: 'more' },
      onclick: () => openRow(row) },
    h('span', { 'aria-hidden': 'true' }, '⋯'));
    const note = cfg.whoNote?.(row, tab);
    return h('th', { scope: 'row', class: 'rs-who' }, h('div', { class: 'rs-who-cell' }, h('span', { class: 'rs-num' }, srOnly('Row '), String(n)), nameEl,
      note ? h('span', { class: 'rs-note' }, note) : null, more));
  }

  // The row's "More" dialog (its ⋯ button, or its name in the notice over the sheet).
  function openRow(row) {
    cfg.rowOptions(row, {
      tab, save: (changes, what) => saveNow(row, changes, { what }),
      removed: () => { rows = rows.filter((r) => r !== row); draw(); afterChange(); }, reload: load,
    });
  }

  function cellEl(col, row) {
    const who = rowName(row);
    const label = `${col.label} for ${who}`;
    const value = row[col.key];
    const extra = cfg.decorate?.(col, row, today) || null;
    const td = (...kids) => h('td', { class: col.width ? `rs-col-${col.width}` : null }, ...kids, extra);
    if (col.kind === 'pill') {
      const options = col.options(row, tab);
      if (!cfg.canEdit) {
        const o = options.find((x) => String(x.value) === String(value ?? ''));
        return td(value === null || value === undefined || value === '' ? null : pill(o?.label ?? String(value), o?.colour || 'grey'));
      }
      return td(pillSelect({ options, value, label, focus: col.key, field: col.key, other: col.other, allowEmpty: col.allowEmpty !== false,
        onCommit: async (next, previous, ctl) => {
          let v = next;
          // A choice such as "Other (type a name)": the column asks for the value; nothing is saved when the person cancels.
          if (col.ask && next === col.askValue) {
            v = await col.ask(row);
            if (v === undefined || v === null || v === previous) { ctl.set(previous); return; }
          }
          saveNow(row, { [col.key]: v === '' ? null : v }, { ctl, previous, what: `${col.label} "${options.find((x) => String(x.value) === v)?.label || v || 'blank'}"` });
        } }));
    }
    if (col.kind === 'date') {
      const typedText = col.textKey ? row[col.textKey] : null;
      // A date the sheet's reader could not read keeps its typed text, shown next to the empty date.
      const typedBadge = !value && typedText ? h('span', { class: 'badge badge-warn rs-typed', title: 'Typed on the Google Sheet; the date could not be read' }, srOnly('Typed on the sheet: '), `“${typedText}”`) : null;
      if (!cfg.canEdit) return td(value ? h('span', { class: 'rs-ro' }, shortDate(value)) : null, typedBadge);
      // (an empty date shows blank, as on the sheet, instead of the browser's dd-mm-yyyy; app.css .is-empty)
      const input = h('input', { type: 'date', class: ['cell-input', !value && 'is-empty'], value: value || '', 'aria-label': label, dataset: { focus: col.key, field: col.key },
        oninput: (e) => e.target.classList.toggle('is-empty', !e.target.value) });
      const ctl = commitOnFinish(input, (next, previous) => {
        const changes = { [col.key]: next || null };
        if (col.textKey) changes[col.textKey] = null; // a date set by hand replaces what was typed on the sheet
        saveNow(row, changes, { ctl, previous, what: `${col.label} ${next ? shortDate(next) : 'cleared'}` });
      }, (v) => input.classList.toggle('is-empty', !v));
      // (the typed text sits inside the empty date, so it does not widen the column; it steps aside while a date is chosen)
      return td(typedBadge ? h('span', { class: 'rs-date' }, input, typedBadge) : input);
    }
    if (col.kind === 'mr') {
      // A linked row shows the Mr# of its patient file; any other row the Mr# typed on the sheet (or here), as text ("082").
      if (row.patient_id && row.patient?.mr_number) return td(h('span', { class: 'rs-ro rs-mr', title: 'The Mr# of the linked patient file' }, row.patient.mr_number));
      if (!cfg.canEdit) return td(value ? h('span', { class: 'rs-ro', title: 'Typed on the sheet; not linked to a patient file' }, String(value)) : null);
      return td(h('input', { class: 'cell-input', value: value || '', maxlength: col.max || 20, autocomplete: 'off', 'aria-label': label,
        dataset: { focus: col.key, field: col.key }, oninput: (e) => typed(row, col.key, e.target.value) }));
    }
    if (col.kind === 'money') {
      if (!cfg.canEdit) return td(value !== null && value !== undefined && value !== '' ? h('span', { class: 'rs-ro' }, Number(value).toLocaleString('en-PK')) : null);
      return td(h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', class: 'cell-input', value: value ?? '', 'aria-label': label,
        dataset: { focus: col.key, field: col.key }, onchange: (e) => {
          const v = e.target.value === '' ? null : Number(e.target.value);
          if (v !== null && (!Number.isFinite(v) || v < 0)) { e.target.value = value ?? ''; toast('Write the amount as a number from 0 up, or leave it empty.', 'error'); return; }
          typed(row, col.key, v);
        } }));
    }
    // text
    if (!cfg.canEdit) return td(value ? h('span', { class: 'rs-ro', title: String(value) }, String(value)) : null);
    return td(h('input', { class: 'cell-input', value: value || '', maxlength: col.max || 200, autocomplete: 'off', type: col.type || 'text', 'aria-label': label,
      dataset: { focus: col.key, field: col.key }, oninput: (e) => typed(row, col.key, e.target.value) }));
  }

  function rowEl(row, n) {
    return h('tr', { class: [cfg.rowClass?.(row, today), row.id === freshId && 'rs-fresh'], dataset: { id: row.id } },
      whoCell(row, n), cfg.columns.filter((c) => c.kind !== 'who').map((c) => cellEl(c, row)));
  }

  // Redraws replace rows, so the focused control (row id + data-focus key + caret) is put back in the new row.
  function rememberFocus() {
    const el = document.activeElement;
    if (!el || !tbody.contains(el)) return null;
    let caret = null;
    try { if (typeof el.selectionStart === 'number') caret = [el.selectionStart, el.selectionEnd]; } catch { /* not a text field */ }
    return { rowId: el.closest('tr')?.dataset.id, key: el.dataset.focus, caret };
  }
  function restoreFocus(saved) {
    const tr = saved && [...tbody.querySelectorAll('tr[data-id]')].find((t) => t.dataset.id === saved.rowId);
    if (!tr) return;
    const target = [...tr.querySelectorAll('[data-focus]')].find((el) => el.dataset.focus === saved.key) || tr.querySelector('[data-focus="more"]');
    target?.focus({ preventScroll: true });
    if (saved.caret && target?.setSelectionRange) { try { target.setSelectionRange(saved.caret[0], saved.caret[1]); } catch { /* not a text field */ } }
  }
  function redrawRow(row) {
    const old = tbody.querySelector(`tr[data-id="${row.id}"]`);
    if (!old) return;
    const saved = old.contains(document.activeElement) ? rememberFocus() : null;
    const n = old.querySelector('.rs-num')?.textContent.replace(/\D/g, '') || '';
    old.replaceWith(rowEl(row, n));
    restoreFocus(saved);
    ui.update(q.failedCount ? 'error' : q.pendingCount ? 'saving' : 'saved', q.pendingCount, cfg.queue.failed());
  }

  // ---- the toolbar
  const searchBox = h('input', { type: 'search', value: f.q, maxlength: 100, autocomplete: 'off', placeholder: 'Name, Mr# or phone', 'aria-label': 'Search by name, Mr# or phone' });
  const filterSels = {};
  const monthSel = select([{ value: '', label: 'Any month' }], f.month, { 'aria-label': 'Month' });
  const orderSel = select([{ value: 'newest', label: 'Newest first' }, { value: 'sheet', label: 'Sheet order (oldest first)' }], f.order, { 'aria-label': 'Order' });
  const clearBtn = h('button', { type: 'button', class: 'btn', onclick: () => {
    f.q = ''; f.month = ''; for (const k of filterKeys) f[k] = '';
    searchBox.value = ''; monthSel.value = ''; for (const k of filterKeys) filterSels[k].value = '';
    shown = PAGE; setURL(); draw({ say: true }); panels(); searchBox.focus();
  } }, 'Clear filters');
  // (the banner is drawn again after every change of a filter, so a name in it is pressed exactly while its filter is on)
  const changed = () => { shown = PAGE; setURL(); draw({ say: true }); panels(); };
  let typing;
  searchBox.addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(() => { f.q = searchBox.value; changed(); }, 250); });
  searchBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(typing); f.q = searchBox.value; changed(); } });
  monthSel.addEventListener('change', () => { f.month = monthSel.value; changed(); });
  orderSel.addEventListener('change', () => { f.order = orderSel.value; changed(); });
  const ff = (label, control, cls) => h('label', { class: ['filter-field', cls] }, h('span', { class: 'filter-label' }, label), control);
  const filterField = (x) => {
    const sel = select([{ value: '', label: 'Any' }], f[x.key], { 'aria-label': x.label });
    sel.addEventListener('change', () => { f[x.key] = sel.value; changed(); paintFilter(x, sel); });
    filterSels[x.key] = sel;
    return ff(x.label, sel);
  };
  // The search and the filters marked `always` (Status) are always in sight; on a phone the others sit behind "More filters", so the
  // first row of the sheet is on the first screen (as on the Checkups page). On a wider screen they are all in one line.
  const alwaysFields = cfg.filters.filter((x) => x.always).map(filterField);
  const moreFields = cfg.filters.filter((x) => !x.always).map(filterField);
  const moreInUse = () => [...cfg.filters.filter((x) => !x.always).map((x) => f[x.key]), f.month, f.order === 'sheet' ? 'sheet' : ''].filter(Boolean).length;
  const moreBox = h('div', { class: 'rs-more-filters', id: `${cfg.queue.table}-more-filters` });
  const moreBtn = h('button', { type: 'button', class: 'btn rs-more-btn', 'aria-controls': moreBox.id, 'aria-expanded': 'false', onclick: () => setMore(moreBtn.getAttribute('aria-expanded') !== 'true') });
  function setMore(open) {
    moreBox.classList.toggle('is-open', open);
    moreBtn.setAttribute('aria-expanded', String(open));
    fitSoon();
  }
  const moreLabel = () => { moreBtn.textContent = moreInUse() ? `More filters (${moreInUse()} in use)` : 'More filters'; };
  function paintFilter(x, sel) { const o = x.options(rows, tab).find((o2) => String(o2.value) === sel.value); sel.className = o?.colour ? `pill-filter ${colourClass(o.colour)}` : ''; }
  function fillFilters() {
    for (const x of cfg.filters) {
      const sel = filterSels[x.key];
      const opts = x.options(rows, tab);
      if (f[x.key] && !opts.some((o) => String(o.value) === f[x.key])) opts.push({ value: f[x.key], label: x.other ? x.other(f[x.key]) : f[x.key] });
      mount(sel, [{ value: '', label: 'Any' }, ...opts].map((o) => h('option', { value: o.value, selected: String(o.value) === f[x.key] }, o.label)));
    }
    const months = {};
    for (const r of rows) { const m = rowMonth(r, cfg.monthKeys); if (m) months[m] = (months[m] || 0) + 1; }
    if (f.month && !months[f.month]) months[f.month] = 0;
    mount(monthSel, [h('option', { value: '' }, 'Any month'), ...Object.keys(months).sort().reverse().map((m) => h('option', { value: m, selected: m === f.month }, `${monthName(m)} (${months[m]})`))]);
  }
  mount(moreBox, ...moreFields, ff('Month', monthSel), ff('Order', orderSel));
  const toolbar = h('div', { class: 'rs-toolbar' },
    ff('Search', searchBox, 'filter-wide'), ...alwaysFields, h('div', { class: 'filter-clear' }, clearBtn), moreBtn, moreBox);
  setMore(moreInUse() > 0);

  // ---- the table
  const words = cfg.words || ['row', 'rows'];
  // The count is a polite live region: a search, a filter, a name in the banner or another tab is read out as its new count.
  const summary = h('p', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, 'Loading…');
  const caption = h('caption', { class: 'sr-only' });
  const colHeads = cfg.columns.map((c) => h('th', { scope: 'col', class: c.kind === 'who' ? 'rs-who' : null }, c.kind === 'who' ? ['# · ', c.label] : c.label));
  const addRow = cfg.canAdd ? h('tfoot', {}, h('tr', { class: 'rs-add' }, h('td', { colspan: cfg.columns.length },
    h('button', { type: 'button', class: 'btn btn-small', 'aria-haspopup': 'dialog', onclick: () => addNew() }, cfg.addLabel)))) : null;
  const wrap = h('div', { class: 'rs-wrap', onkeydown: onKey },
    h('table', { class: 'rs-table' }, caption, h('thead', {}, h('tr', {}, colHeads)), tbody, addRow));
  const moreHost = h('div', { class: 'rs-more-rows' });
  let tabsEl = null; // the city or branch tabs above the frame (set below)
  // On a laptop or a bigger screen the frame is as tall as the window under the top bar and the tabs (less the bit of page under the
  // frame), so with the page scrolled down to the sheet it fills the window, the tabs and its sideways scrollbar in sight; it is never
  // shorter than 240px (the header row and four rows). (On a phone the page scrolls, and the frame keeps its height from app.css.)
  const barHeight = () => { const bar = document.querySelector('.topbar'); return bar && /sticky|fixed/.test(getComputedStyle(bar).position) ? bar.getBoundingClientRect().height : 0; };
  function fitWrap() {
    if (!wrap.isConnected) return;
    if (window.innerWidth <= 720) { wrap.style.maxHeight = ''; return; }
    const tabsH = tabsEl?.isConnected ? tabsEl.getBoundingClientRect().height : 0;
    const below = moreHost.getBoundingClientRect().bottom - wrap.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(wrap.closest('.main') || root).paddingBottom) || 0);
    wrap.style.maxHeight = `${Math.max(240, Math.floor(window.innerHeight - barHeight() - tabsH - below))}px`;
  }
  function fitSoon() { requestAnimationFrame(() => fitWrap()); }
  // A mouse wheel turned down over the sheet first scrolls the page until the sheet fills the window, then its rows (turned up, the
  // rows go back first, then the page, as the browser does it).
  function onWheel(e) {
    if (e.deltaY <= 0 || e.ctrlKey || window.innerWidth <= 720) return;
    const room = (tabsEl?.isConnected ? tabsEl : wrap).getBoundingClientRect().top - barHeight();
    const pageLeft = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
    if (room <= 1 || pageLeft <= 1) return;
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? window.innerHeight : e.deltaY;
    window.scrollBy({ top: Math.min(room, px), behavior: 'instant' });
  }
  wrap.addEventListener('wheel', onWheel, { passive: false, signal: life.signal });

  const visible = () => rows.filter((r) => rowMatches(r, f.q)
    && (!f.month || rowMonth(r, cfg.monthKeys) === f.month)
    && cfg.filters.every((x) => !f[x.key] || x.test(r, f[x.key]))).sort(f.order === 'sheet' ? sheetOrder : newestFirst);

  // { say: true } after a change of the search, a filter, the month or the order: the count is written to its live region, and when the
  // change gives the same words (another maker with as many rows, the order), they are said again (announce), so a change is never met
  // with silence. (Another tab writes "Loading…" first, so its count is always new words.)
  function draw({ say = false } = {}) {
    const list = visible();
    const total = rows.length;
    const tabLabel = cfg.tabs.find((t) => String(t.id) === String(tab))?.label || '';
    caption.textContent = `${cfg.page}, ${tabLabel}`;
    const count = (n) => `${n.toLocaleString('en-PK')} ${n === 1 ? words[0] : words[1]}`;
    const said = filtered() ? `${tabLabel}: ${count(list.length)} of ${total.toLocaleString('en-PK')} match these filters` : `${tabLabel}: ${count(total)}`;
    if (summary.textContent !== said) summary.textContent = said;
    else if (say) announce(said);
    const saved = rememberFocus();
    const part = list.slice(0, shown);
    mount(tbody, part.length ? part.map((r, i) => rowEl(r, i + 1))
      : h('tr', { class: 'rs-empty' }, h('td', { colspan: cfg.columns.length }, h('div', { class: 'empty' }, filtered() ? `No ${words[1]} match these filters.` : cfg.emptyText(tabLabel)))));
    restoreFocus(saved);
    const left = list.length - part.length;
    mount(moreHost, left > 0 ? h('button', { type: 'button', class: 'btn', onclick: showMore }, moreText(left)) : null);
    clearBtn.disabled = !filtered();
    moreLabel();
    fitSoon();
    wrap.setAttribute('aria-busy', 'false');
    ui.update(q.failedCount ? 'error' : q.pendingCount ? (navigator.onLine ? 'saving' : 'offline') : 'saved', q.pendingCount, cfg.queue.failed());
  }
  function moreText(left) { return `Show ${Math.min(PAGE, left)} more (${left.toLocaleString('en-PK')} not shown yet)`; }
  // "Show more" adds the next rows under the ones on screen and leaves those as they are (drawing them all again took seconds once a
  // tab had 600 rows). The rows to add are the ones of the list not on screen yet, in its order, so a row an edit moved is never added
  // twice or left out. The button keeps the focus while there are more; after the last ones, the first added row has it.
  function showMore(e) {
    const onScreen = new Set([...tbody.querySelectorAll('tr[data-id]')].map((t) => t.dataset.id));
    const rest = visible().filter((r) => !onScreen.has(String(r.id)));
    const added = rest.slice(0, PAGE).map((r, i) => rowEl(r, onScreen.size + i + 1));
    shown += PAGE;
    tbody.append(...added);
    const left = rest.length - added.length;
    if (left > 0) e.currentTarget.textContent = moreText(left);
    else { mount(moreHost); added[0]?.querySelector('[data-focus]')?.focus(); }
  }
  function afterChange() { panels(); fillFilters(); for (const x of cfg.filters) paintFilter(x, filterSels[x.key]); fitSoon(); }
  function panels() { banner?.update(); notice?.update(); }

  // Arrow keys (and Enter) move between typed cells of one column, like a spreadsheet.
  function onKey(e) {
    if (!['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key) || !e.target.classList?.contains('cell-input') || e.target.type === 'date' || e.target.type === 'number') return;
    const cellTd = e.target.closest('td, th');
    const tr = cellTd.parentElement;
    const col = [...tr.children].indexOf(cellTd);
    const step = (t) => (e.key === 'ArrowUp' ? t.previousElementSibling : t.nextElementSibling);
    let target = step(tr);
    while (target && !target.children[col]?.querySelector('.cell-input')) target = step(target);
    const next = target?.children[col]?.querySelector('.cell-input');
    if (next) { e.preventDefault(); next.focus(); next.select?.(); }
  }

  async function addNew() {
    const row = await cfg.add(tab);
    if (!row) return;
    rows.push(row);
    freshId = row.id;
    // The new row must be on screen: clear what would hide it.
    if (filtered() && !visible().includes(row)) clearBtn.click();
    const list = visible();
    const at = list.indexOf(row);
    if (at >= shown) shown = at + 1;
    draw();
    afterChange();
    const tr = tbody.querySelector(`tr[data-id="${row.id}"]`);
    tr?.scrollIntoView?.({ block: 'nearest' });
    announce(`Added ${rowName(row)} as row ${at + 1}.`);
    setTimeout(() => { if (freshId === row.id) freshId = null; }, 3000);
  }

  // ---- loading
  async function load() {
    const mine = ++seq;
    wrap.setAttribute('aria-busy', 'true');
    let list;
    try { list = await cfg.load(tab); } catch (e) {
      if (mine !== seq || signal?.aborted) return;
      if (e?.code === 'RECORDS_MISSING') { life.abort(); mount(root, h('div', { class: 'page-head' }, h('h1', {}, cfg.title)), empty(cfg.missingText)); return; }
      wrap.setAttribute('aria-busy', 'false');
      summary.textContent = 'The list could not load.';
      toast(friendlyError(e), 'error');
      return;
    }
    if (mine !== seq || signal?.aborted) return;
    rows = list;
    // Another tab: a filter it has no option for (a team member of the other city, chosen from the banner) is taken off, so the tab
    // does not open empty for a name it does not have; the address drops it too.
    if (tabMoved) {
      tabMoved = false;
      for (const x of cfg.filters) if (f[x.key] && !x.options(rows, tab).some((o) => String(o.value) === f[x.key])) f[x.key] = '';
      setURL();
    }
    fillFilters();
    for (const x of cfg.filters) paintFilter(x, filterSels[x.key]);
    draw();
    panels();
  }

  const ctx = {
    get rows() { return rows; }, get tab() { return tab; }, today,
    filter: (k) => f[k], setFilter: (k, v) => { f[k] = v; if (filterSels[k]) { filterSels[k].value = v; paintFilter(cfg.filters.find((x) => x.key === k), filterSels[k]); } changed(); },
    open: (row) => openRow(row),
  };
  const banner = cfg.banner?.(ctx) || null;
  const notice = cfg.notice?.(ctx) || null;

  const strip = cfg.tabs.length > 1 ? tabs({
    label: cfg.tabParam === 'city' ? 'Cities' : 'Branches', items: cfg.tabs, current: tab, class: 'rs-tabs', panel: h('div', {}),
    onChange: (id) => { tab = id; tabMoved = true; shown = PAGE; setURL(); rows = []; mount(tbody); summary.textContent = 'Loading…'; load(); },
  }) : null;
  if (strip) { strip.panel.append(wrap, moreHost); tabsEl = strip.el; }

  document.addEventListener(`${cfg.queue.table}-reload`, () => load(), { signal: life.signal });
  window.addEventListener('resize', fitSoon, { signal: life.signal });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !q.pendingCount && !wrap.contains(document.activeElement) && !document.querySelector('.modal')) load(); }, { signal: life.signal });
  const stop = () => { life.abort(); clearTimeout(typing); cfg.queue.clearUI(ui); };
  signal?.addEventListener('abort', stop, { once: true });

  // (the save status sits under the title, beside the count, so the two buttons share one line on a phone)
  const actions = h('div', { class: 'inline page-head-actions' },
    cfg.canAdd ? h('button', { type: 'button', class: 'btn btn-primary', 'aria-haspopup': 'dialog', onclick: () => addNew() }, cfg.addLabel) : null,
    cfg.canDownload ? h('button', { type: 'button', class: 'btn', onclick: busy(async () => {
      const out = cfg.csv(visible(), tab);
      if (!out.rows.length) { toast('Nothing to download yet.'); return; }
      downloadCSV(out.filename, out.rows);
      toast(`${out.rows.length.toLocaleString('en-PK')} ${out.rows.length === 1 ? words[0] : words[1]} downloaded.`, 'ok');
    }) }, 'Download CSV') : null);
  mount(root, h('div', { class: ['rs-page', `rs-${cfg.accent}`] },
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, cfg.title), h('div', { class: 'rs-sub' }, summary, cfg.canEdit ? saveStatus : null, notice?.head || null)), actions),
    cfg.intro ? h('p', { class: 'muted' }, cfg.intro) : null,
    banner?.el || null,
    notice?.el || null,
    failBox,
    toolbar,
    strip ? [strip.el, strip.panel] : [wrap, moreHost]));
  setURL();
  q.setOnline(navigator.onLine);
  await load();
}
