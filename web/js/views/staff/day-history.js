// History of Aaj ki List (owner, 12 Oct 2026): every day's list of every branch, newest first. Each line says the day, the
// branch, how many patients and how many were completed, and whether the day was ended ("End the day" on the Aaj ki List),
// with when and by whom. A line opens that day's list read only: the copy saved when the day was ended, or, for a day that
// was not ended, the list as it is stored now. Both come from the database in the Aaj ki List's columns and order
// (public.day_list_history and public.day_list_copy in 20261012000100_day_list_history.sql).
import { h, mount, toast, friendlyError, empty, select, downloadCSV, rupees, srOnly, capFirst, addDaysISO, addMonthsISO } from '../../ui/dom.js';
import { state, can, myBranches, branchName } from '../../state.js';
import { STATUS_LABELS, duesBadge } from './common.js';
import { dayLabel, endedAt } from '../../lib/day-list.js';
import { dayHistoryHref } from './day-end.js';

const PAGE_SIZE = 60;
const MISSING_TEXT = 'The History of Aaj ki List is not switched on yet. It appears once Dr. Ali has run the database update (20261012000100_day_list_history.sql).';
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const number = (n) => Number(n || 0).toLocaleString('en-PK');
const patients = (n) => `${number(n)} patient${Number(n) === 1 ? '' : 's'}`;
let lastList = null; // the list as last shown (its filters and page), for the way back from one day

export async function renderDayHistory(root, params, signal) {
  const branch = Number(params.get('branch')) || null;
  const date = params.get('date');
  if (branch && DAY.test(date || '')) return renderDay(root, branch, date, signal);
  return renderList(root, params, signal);
}

// ---------------------------------------------------------------- the list of days
async function renderList(root, params, signal) {
  const d = state.data;
  const branches = myBranches();
  const f = {
    branch: branches.some((b) => b.id === Number(params.get('branch'))) ? String(Number(params.get('branch'))) : '',
    month: MONTH.test(params.get('month') || '') ? params.get('month') : '',
    page: Math.max(0, (Number(params.get('page')) || 1) - 1),
  };
  let rows = [];
  let total = 0;
  let seq = 0;

  const setURL = () => {
    const q = new URLSearchParams();
    if (f.branch) q.set('branch', f.branch);
    if (f.month) q.set('month', f.month);
    if (f.page) q.set('page', String(f.page + 1));
    lastList = `#/staff/day-history${q.toString() ? `?${q}` : ''}`;
    history.replaceState(null, '', lastList);
  };
  const filtered = () => !!(f.branch || f.month);

  const summary = h('p', {});
  const list = h('ul', { class: 'day-history-list' });
  const listWrap = h('section', { class: 'panel', 'aria-label': 'Days' }, list);
  const info = h('span', { class: 'pager-info', role: 'status' });
  const go = (delta) => () => {
    if ((delta < 0 && f.page === 0) || (delta > 0 && (f.page + 1) * PAGE_SIZE >= total)) return;
    f.page += delta;
    setURL();
    load();
    listWrap.scrollIntoView?.({ block: 'start' });
  };
  // aria-disabled, not disabled: the button that was pressed keeps focus, also on the last page.
  const prev = h('button', { type: 'button', class: 'btn', onclick: go(-1) }, 'Previous');
  const next = h('button', { type: 'button', class: 'btn', onclick: go(1) }, 'Next');
  const pager = h('div', { class: 'pager', hidden: true }, info, h('div', { class: 'inline' }, prev, next));

  const branchSel = select([...(branches.length > 1 ? [{ value: '', label: 'All branches' }] : []), ...branches.map((b) => ({ value: b.id, label: b.name }))],
    f.branch || (branches.length > 1 ? '' : branches[0]?.id), { 'aria-label': 'Branch' });
  if (branches.length === 1) f.branch = String(branches[0].id);
  const monthIn = h('input', { type: 'month', value: f.month, placeholder: 'YYYY-MM', 'aria-label': 'Month' });
  const clearBtn = h('button', { type: 'button', class: 'btn', onclick: () => {
    f.month = ''; monthIn.value = '';
    if (branches.length > 1) { f.branch = ''; branchSel.value = ''; }
    f.page = 0; setURL(); load(); monthIn.focus();
  } }, 'Clear filters');
  const changed = () => { f.page = 0; setURL(); load(); };
  branchSel.addEventListener('change', () => { f.branch = branchSel.value; changed(); });
  monthIn.addEventListener('change', () => { f.month = MONTH.test(monthIn.value) ? monthIn.value : ''; changed(); });
  const ff = (label, control) => h('label', { class: 'filter-field' }, h('span', { class: 'filter-label' }, label), control);
  const filters = h('div', { class: 'checkup-filters day-history-filters' }, ff('Branch', branchSel), ff('Month', monthIn), h('div', { class: 'filter-clear' }, clearBtn));

  const line = (r) => {
    const c = r.counts || {};
    const status = r.ended
      ? h('span', { class: 'badge badge-ok' }, `Ended ${endedAt(r, r.list_date)}${r.closed_by_name ? ` by ${r.closed_by_name}` : ''}`)
      : h('span', { class: 'badge badge-muted' }, 'Not ended');
    return h('li', {}, h('a', { class: 'day-history-line', href: dayHistoryHref(r.branch_id, r.list_date) },
      h('span', { class: 'day-history-text' }, h('strong', {}, dayLabel(r.list_date)), ` – ${r.branch_name || branchName(r.branch_id)} – ${patients(c.total)} (${number(c.completed)} completed)`),
      status));
  };

  function draw() {
    const first = f.page * PAGE_SIZE + 1;
    // Every branch: one line per list, and a day can have one list per branch. One branch: one line per day.
    const lines = !f.branch && branches.length > 1 ? `${number(total)} list${total === 1 ? '' : 's'}` : `${number(total)} day${total === 1 ? '' : 's'}`;
    summary.textContent = filtered() && branches.length > 1 ? `${lines} ${total === 1 ? 'matches' : 'match'} these filters`
      : f.branch ? `${lines} with a list` : lines;
    mount(list, rows.length ? rows.map(line)
      : h('li', {}, empty(filtered() ? 'No lists match these filters.' : 'No lists yet. A day shows here once it has patients on the Aaj ki List.')));
    pager.hidden = total <= PAGE_SIZE && f.page === 0; // everything fits on one page
    info.textContent = rows.length ? `Showing ${number(first)}-${number(first + rows.length - 1)} of ${number(total)}` : `Showing 0 of ${number(total)}`;
    prev.setAttribute('aria-disabled', String(f.page === 0));
    next.setAttribute('aria-disabled', String((f.page + 1) * PAGE_SIZE >= total));
    clearBtn.disabled = !(f.month || (branches.length > 1 && f.branch));
    listWrap.setAttribute('aria-busy', 'false');
  }

  async function load() {
    const mine = ++seq;
    listWrap.setAttribute('aria-busy', 'true');
    const from = f.month ? `${f.month}-01` : null;
    const to = f.month ? addDaysISO(addMonthsISO(`${f.month}-01`, 1), -1) : null;
    let res;
    try {
      res = await d.dayListHistory({ branchId: f.branch ? Number(f.branch) : null, from, to, limit: PAGE_SIZE, offset: f.page * PAGE_SIZE });
    } catch (e) {
      if (mine !== seq || signal?.aborted) return;
      listWrap.setAttribute('aria-busy', 'false');
      toast(friendlyError(e), 'error');
      return;
    }
    if (mine !== seq || signal?.aborted) return; // the filters changed meanwhile: this answer is out of date
    if (res.missing) { mount(root, head(), empty(MISSING_TEXT)); return; }
    rows = res.rows || [];
    total = Number(res.total ?? rows.length);
    if (!rows.length && f.page > 0) { f.page = 0; setURL(); await load(); return; } // past the last page (lines went away meanwhile)
    draw();
  }

  const head = () => h('div', { class: 'page-head' },
    h('div', {}, h('h1', {}, 'History of Aaj ki List'), summary),
    h('a', { class: 'btn', href: `#/staff/sheet${f.branch ? `?branch=${f.branch}` : ''}` }, 'Back to the Aaj ki List'));
  setURL();
  mount(root, head(), filters, listWrap, pager);
  await load();
}

// ---------------------------------------------------------------- one day, read only
async function renderDay(root, branchId, date, signal) {
  const d = state.data;
  const back = h('p', { class: 'back-line' }, h('a', { href: lastList || dayHistoryHref(branchId) }, '← History of Aaj ki List'));
  const heading = h('h1', {}, `${dayLabel(date)} – ${branchName(branchId) || 'Branch'}`);
  let copy;
  try {
    copy = await d.dayListCopy({ branchId, date });
  } catch (e) {
    if (signal?.aborted) return;
    mount(root, back, h('div', { class: 'page-head' }, h('div', {}, heading)), empty(friendlyError(e)));
    return;
  }
  if (signal?.aborted) return;
  if (copy.missing) { mount(root, back, h('div', { class: 'page-head' }, h('div', {}, heading)), empty(MISSING_TEXT)); return; }
  if (copy.branch_name) heading.textContent = `${dayLabel(date)} – ${copy.branch_name}`;

  const rows = copy.rows || [];
  const c = copy.counts || {};
  const showDues = can('dues.view') && rows.some((r) => 'dues' in r);
  const counts = [patients(c.total), `${number(c.completed)} completed`, `${number(c.waiting)} waiting`, `${number(c.in_treatment)} in treatment`,
    c.scheduled ? `${number(c.scheduled)} scheduled` : null, c.cancelled ? `${number(c.cancelled)} cancelled` : null, c.no_show ? `${number(c.no_show)} no show` : null,
    `${number(c.checkups)} checkups`].filter(Boolean).join(' · ');
  const note = copy.ended
    ? h('div', { class: 'alert alert-info', role: 'status' }, `Saved copy from ${endedAt(copy, date)}${copy.closed_by_name ? `, when ${copy.closed_by_name} ended the day` : ''}.`,
      copy.times_updated ? ` The day was ended ${copy.times_updated + 1} times; this is the latest copy.` : '')
    : h('div', { class: 'alert alert-warning', role: 'status' }, 'Not ended; this is the list as stored now.');

  function download() {
    downloadCSV(`aaj-ki-list_${(copy.branch_name || branchName(branchId)).replace(/\W+/g, '-')}_${date}${copy.ended ? '_saved' : ''}.csv`, rows.map((r) => ({
      serial: r.n, token: r.token ?? '', patient: r.name, mr_number: r.mr || '', type: r.kind === 'checkup' ? 'Checkup' : 'Patient',
      braces_month: r.month ?? '', treatment: r.treatment || '', status: r.status ? STATUS_LABELS[r.status] || r.status : '', group: r.group || '',
      doctors: r.doctors || '', details: r.details || '', dues: showDues && r.dues != null ? r.dues : '', invoice: r.has_invoice ? 'Yes' : '',
      notes: r.notes || '', phone: r.phone || '',
    })));
  }

  const cell = (...children) => h('div', { class: 'cell' }, ...children);
  const rowEl = (r) => {
    const checkup = r.kind === 'checkup';
    const name = !checkup && r.patient_id && can('patients.view') ? h('a', { href: `#/staff/patient/${r.patient_id}` }, r.name) : h('span', {}, r.name);
    const hint = r.mr ? `Mr# ${r.mr}` : checkup ? 'Checkup · no Mr#' : '';
    const month = r.month ? String(r.month).padStart(2, '0') : null;
    const hasToken = r.token != null && String(r.token).trim() !== ''; // (a checkup patient from the website has none until someone types one)
    return h('tr', { class: checkup ? 'is-checkup' : null, dataset: { kind: r.kind } },
      h('th', { scope: 'row', class: 'frozen row-head' }, cell(h('span', { class: 'serial' }, srOnly('Row '), String(r.n)),
        h('div', {}, h('div', { class: 'day-copy-name' }, name), hint ? h('div', { class: 'muted field-hint' }, hint) : null))),
      h('td', {}, h('div', { class: 'cell row-flags' }, checkup ? h('span', { class: 'badge badge-checkup' }, 'Checkup') : null,
        showDues ? duesBadge(r.dues) : null, r.has_invoice ? h('span', { class: 'badge badge-ok' }, 'Invoice') : null)),
      h('td', {}, cell(month ? h('span', { class: 'month-pill' }, month) : h('span', { class: 'muted' }, h('span', { 'aria-hidden': 'true' }, '–'), srOnly('Not braces')))),
      h('td', {}, cell(capFirst(r.treatment || ''))),
      h('td', {}, h('div', { class: 'cell token-cell' }, hasToken ? h('span', { class: 'token' }, srOnly('Token '), r.token)
        : h('span', { class: 'muted' }, h('span', { 'aria-hidden': 'true' }, '–'), srOnly('No token')))),
      h('td', {}, cell(h('span', { class: `status-chip status-${r.status || 'unset'}` }, r.status ? STATUS_LABELS[r.status] || r.status : 'Not set'))),
      h('td', {}, cell(r.doctors || '', r.group ? h('span', { class: 'muted field-hint' }, ` ${r.group}`) : null)),
      h('td', {}, cell(r.details || '')),
      h('td', { class: 'right' }, h('div', { class: ['cell', showDues && r.dues > 0 ? 'status-bad' : 'muted'], style: { justifyContent: 'flex-end', fontWeight: 700 } },
        showDues && r.dues != null ? (r.dues > 0 ? rupees(r.dues) : '0') : '')),
      h('td', {}, cell(r.notes || '')),
      h('td', {}, h('div', { class: 'cell muted nowrap' }, r.phone || '')));
  };

  mount(root,
    back,
    h('div', { class: 'page-head' },
      h('div', {}, heading, h('p', {}, counts)),
      h('div', { class: 'inline' },
        h('a', { class: 'btn', href: `#/staff/sheet?branch=${branchId}&date=${date}` }, 'Open this day on the Aaj ki List'),
        can('export.data') || can('finance.view') ? h('button', { type: 'button', class: 'btn', onclick: download }, 'Download (CSV)') : null)),
    note,
    h('div', { class: 'sheet-wrap day-copy' },
      h('table', { class: 'sheet' },
        h('caption', { class: 'sr-only' }, `${copy.ended ? 'Saved copy of the' : 'The'} Aaj ki List of ${copy.branch_name || branchName(branchId)} on ${dayLabel(date)}, read only`),
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col', class: 'frozen', style: { minWidth: '210px' } }, '# · Patient'), h('th', { scope: 'col' }, 'Flags'), h('th', { scope: 'col' }, 'Month'), h('th', { scope: 'col' }, 'Treatment'),
          h('th', { scope: 'col', class: 'center' }, 'Token'), h('th', { scope: 'col' }, 'Status'), h('th', { scope: 'col' }, "Doctor's name"), h('th', { scope: 'col' }, 'Treatment details'),
          h('th', { scope: 'col', class: 'right' }, 'Dues'), h('th', { scope: 'col' }, 'Notes'), h('th', { scope: 'col' }, 'Contact'))),
        h('tbody', {}, rows.length ? rows.map(rowEl) : h('tr', {}, h('td', { colspan: 11 }, h('div', { class: 'empty' }, 'No patients or checkups on this list.')))))));
}
