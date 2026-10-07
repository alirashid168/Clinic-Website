// Accounts: expenses by city and branch, branch income vs expenses, and the
// daily cash closing. The reports page lives in reports.js.
import { h, mount, rupees, shortDate, toast, friendlyError, field, select, empty, todayISO, downloadCSV, modal, busy, tabs as tabStrip, showFormErrors, clearFieldErrors } from '../../ui/dom.js';
import { state, can, branchName, cityName, myBranches, defaultBranchId } from '../../state.js';

/**
 * A tab strip (dom.js tabs()) and the tabpanel it controls, from [[key, label], ...].
 * Picking a tab updates the strip in place, so keyboard focus stays on it, then
 * calls onChange(key). Render the content into the returned `panel`.
 */
export function tabbed(label, items, current, onChange) {
  return tabStrip({ label, items: items.map(([id, text]) => ({ id, label: text })), current, onChange });
}

/** A list the server cut off says so, so a partial total never reads as complete. */
const capNote = (rows, what) => (rows?.truncated
  ? h('div', { class: 'alert alert-warning', role: 'status' }, h('strong', {}, 'Incomplete: '), `showing the first ${rows.cap ?? rows.length} ${what}; totals may be incomplete.`)
  : null);

export async function renderAccounts(root, params) {
  const available = [
    can('finance.view') && ['pnl', 'Branch income vs expenses'],
    can('finance.view') && ['expenses', 'Expenses'],
    can('finance.view') && ['reports', 'Reports →'],
    (can('cash.close') || can('cash.verify')) && ['cash', 'Cash closing'],
  ].filter(Boolean);
  let tab = params.get('tab') || available[0]?.[0];
  const strip = tabbed('Accounts sections', available, tab, (k) => { tab = k; history.replaceState(null, '', `#/staff/accounts?tab=${k}`); draw(); });
  const body = strip.panel;
  async function draw() {
    if (tab === 'pnl') await pnl(body);
    else if (tab === 'expenses') await expenses(body);
    else if (tab === 'reports') { location.hash = '#/staff/reports?group=financial'; return; }
    else await cash(body);
  }
  mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'Accounts')), strip.el, body);
  await draw();
}

// ---------------------------------------------------------------- P&L
async function pnl(root) {
  const d = state.data;
  const monthInput = h('input', { type: 'month', value: todayISO().slice(0, 7) });
  const out = h('div', {});
  async function load() {
    // Rows with a branch, plus one row per city for expenses recorded without a branch (branch null).
    const rows = await d.branchPnl(monthInput.value).catch((e) => { toast(friendlyError(e), 'error'); return []; });
    const cities = [...new Set(rows.map((r) => r.city_id))];
    const total = (list, k) => list.reduce((s, r) => s + r[k], 0);
    const branchOnly = rows.filter((r) => r.branch_id != null);
    const unassigned = total(rows, 'expenses') - total(branchOnly, 'expenses');
    const net = total(rows, 'profit');
    const money = (v) => h('td', { class: ['right', v < 0 && 'status-bad'] }, rupees(v));
    mount(out,
      h('div', { class: 'stat-row', style: { marginBottom: '16px' } },
        h('div', { class: 'stat' }, h('strong', {}, rupees(total(rows, 'income'))), h('span', {}, 'Income (payments received)')),
        h('div', { class: 'stat' }, h('strong', {}, rupees(total(rows, 'expenses'))), h('span', {}, 'All expenses')),
        h('div', { class: 'stat' }, h('strong', { class: net < 0 ? 'status-bad' : 'status-ok' }, rupees(net)), h('span', {}, net < 0 ? 'Loss' : 'Profit')),
        h('div', { class: 'stat' }, h('strong', {}, rupees(total(branchOnly, 'expenses'))), h('span', {}, 'Expenses tagged to a branch'))),
      h('section', { class: 'panel' }, h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Branch'), h('th', { scope: 'col', class: 'right' }, 'Income'), h('th', { scope: 'col', class: 'right' }, 'Expenses'), h('th', { scope: 'col', class: 'right' }, 'Difference'))),
        h('tbody', {}, cities.map((cid) => {
          const list = rows.filter((r) => r.city_id === cid);
          return [
            ...list.map((r) => h('tr', { class: r.branch_id == null ? 'muted' : null },
              h('td', {}, r.branch_id == null ? `${cityName(cid)} — not assigned to a branch` : r.branch), money(r.income), money(r.expenses), money(r.profit))),
            list.length > 1 ? h('tr', {}, h('td', {}, h('strong', {}, `${cityName(cid)} total`)), h('td', { class: 'right' }, h('strong', {}, rupees(total(list, 'income')))),
              h('td', { class: 'right' }, h('strong', {}, rupees(total(list, 'expenses')))), h('td', { class: 'right' }, h('strong', { class: total(list, 'profit') < 0 ? 'status-bad' : null }, rupees(total(list, 'profit'))))) : null,
          ];
        }),
        h('tr', {}, h('td', {}, h('strong', {}, 'All branches')), h('td', { class: 'right' }, h('strong', {}, rupees(total(rows, 'income')))),
          h('td', { class: 'right' }, h('strong', {}, rupees(total(rows, 'expenses')))), h('td', { class: 'right' }, h('strong', { class: net < 0 ? 'status-bad' : null }, rupees(net)))))))),
      h('p', { class: 'muted', style: { marginTop: '8px', fontSize: '13px' } },
        'Income is counted at the branch where each payment was taken. ',
        unassigned > 0 ? `${rupees(unassigned)} of this month's expenses (salaries, ads, lab bills and the like) were recorded against a city only, so they appear in the "not assigned to a branch" rows and in the totals, not under any one branch.` : 'Every expense this month is tagged to a branch.'));
  }
  monthInput.addEventListener('change', load);
  mount(root, h('div', { class: 'inline', style: { marginBottom: '12px' } }, h('label', { class: 'inline' }, 'Month ', monthInput)), out);
  await load();
}

// ---------------------------------------------------------------- expenses
async function expenses(root) {
  const d = state.data;
  const cats = state.ref.categories;
  const monthInput = h('input', { type: 'month', value: todayISO().slice(0, 7) });
  const list = h('div', {});

  const date = h('input', { type: 'date', value: todayISO() });
  const branch = select([{ value: '', label: 'No branch (city level)' }, ...state.ref.branches.map((b) => ({ value: b.id, label: `${b.name} (${cityName(b.city_id)})` }))], defaultBranchId() || '');
  const city = select(state.ref.cities.map((c) => ({ value: c.id, label: c.name })), state.ref.cities[0]?.id);
  const category = select([{ value: '', label: 'Choose category…' }, ...cats.map((c) => ({ value: c.id, label: c.name }))], '');
  const amount = h('input', { type: 'number', min: 1, step: 1, placeholder: 'Rs' });
  const paidTo = h('input', { placeholder: 'Paid to' });
  const method = select([{ value: 'cash', label: 'Cash' }, { value: 'bank_transfer', label: 'Bank transfer' }, { value: 'card', label: 'Card' }, { value: 'cheque', label: 'Cheque' }], 'cash');
  const notes = h('input', { placeholder: 'Notes' });
  const receipt = h('input', { type: 'file', accept: 'image/*,.pdf', 'aria-label': 'Receipt photo' });
  const cityField = field('City', city, 'Only used when no branch is chosen.');
  const hasReceipt = (r) => r.receipt_path && !/^hw-exp-/.test(r.receipt_path);
  const openReceipt = async (r) => { try { const url = await d.receiptUrl(r.receipt_path); if (url) window.open(url, '_blank', 'noopener'); } catch (e) { toast(friendlyError(e), 'error'); } };
  const attachReceipt = (r) => {
    const input = h('input', { type: 'file', accept: 'image/*,.pdf' });
    input.onchange = async () => { if (!input.files[0]) return; try { await d.uploadReceipt(r.id, input.files[0]); toast('Receipt attached.', 'ok'); load(); } catch (e) { toast(friendlyError(e), 'error'); } };
    input.click();
  };
  const syncCity = () => { cityField.hidden = !!branch.value; };
  branch.addEventListener('change', syncCity);
  syncCity();

  let rows = [];
  async function load() {
    const [y, m] = monthInput.value.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    rows = await d.expenses({ from: `${monthInput.value}-01`, to: `${monthInput.value}-${String(last).padStart(2, '0')}` }).catch((e) => { toast(friendlyError(e), 'error'); return []; });
    const catName = (id) => cats.find((c) => c.id === id)?.name || '';
    const byCat = {};
    for (const r of rows) byCat[catName(r.category_id)] = (byCat[catName(r.category_id)] || 0) + Number(r.amount);
    mount(list,
      capNote(rows, 'expenses'),
      rows.length ? h('div', {},
        h('p', { class: 'muted' }, Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${rupees(v)}`).join(' · ')),
        h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Date'), h('th', { scope: 'col' }, 'Branch / city'), h('th', { scope: 'col' }, 'Category'), h('th', { scope: 'col' }, 'Paid to'), h('th', { scope: 'col' }, 'Notes'), h('th', { scope: 'col', class: 'right' }, 'Amount'), h('th', { scope: 'col' }, 'Receipt'))),
          h('tbody', {}, rows.map((r) => h('tr', {},
            h('td', { class: 'nowrap' }, shortDate(r.expense_date)), h('td', {}, r.branch_id ? branchName(r.branch_id) : `${cityName(r.city_id)} (city)`),
            h('td', {}, catName(r.category_id)), h('td', {}, r.paid_to || ''), h('td', {}, r.notes || ''), h('td', { class: 'right' }, rupees(r.amount)),
            h('td', { class: 'nowrap' }, hasReceipt(r) ? h('button', { class: 'btn btn-small', onclick: () => openReceipt(r) }, 'View')
              : can('expenses.manage') ? h('button', { class: 'link-btn', onclick: () => attachReceipt(r) }, 'Attach') : '')))))))
        : empty('No expenses this month.'));
  }

  const saveBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save expense');
  const formEl = h('form', { novalidate: true },
    h('div', { class: 'form-grid' }, field('Date', date, null, { required: true }), field('Branch', branch), cityField, field('Category', category, null, { required: true }), field('Amount (Rs)', amount, null, { required: true }), field('Paid to', paidTo), field('Paid by', method), field('Notes', notes), field('Receipt photo (optional)', receipt, 'A photo or PDF of the bill, kept with the expense.')),
    saveBtn);
  // busy(): one save at a time (a double tap must not record the expense twice), and errors are shown.
  const saveExpense = busy(async () => {
    clearFieldErrors(formEl);
    const errors = [];
    if (!date.value) errors.push({ input: date, message: 'Choose the date.' });
    if (!category.value) errors.push({ input: category, message: 'Choose a category.' });
    if (!(Number(amount.value) > 0)) errors.push({ input: amount, message: 'Enter the amount.' });
    if (errors.length) { showFormErrors(formEl, errors); return; }
    saveBtn.disabled = true;
    try {
      const saved = await d.addExpense({ expense_date: date.value, branch_id: branch.value || null, city_id: Number(city.value), category_id: Number(category.value), amount: Number(amount.value), paid_to: paidTo.value, method: method.value, notes: notes.value });
      if (receipt.files[0] && saved?.id) { try { await d.uploadReceipt(saved.id, receipt.files[0]); } catch (err) { toast('Expense saved, but the receipt could not be uploaded: ' + friendlyError(err), 'error', 8000); } }
      toast(`Expense of ${rupees(amount.value)} saved.`, 'ok');
      amount.value = ''; paidTo.value = ''; notes.value = ''; receipt.value = '';
      load();
    } finally { saveBtn.disabled = false; }
  });
  formEl.addEventListener('submit', (e) => { e.preventDefault(); saveExpense(e); });
  const form = can('expenses.manage') ? h('section', { class: 'panel' }, h('h2', {}, 'Add expense'), formEl) : null;

  monthInput.addEventListener('change', load);
  mount(root, form,
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Expenses'),
        h('div', { class: 'inline' }, h('label', { class: 'inline' }, 'Month ', monthInput), can('export.data') ? h('button', { class: 'btn btn-small', onclick: () => downloadCSV(`expenses_${monthInput.value}.csv`, rows.map((r) => ({ date: r.expense_date, branch: branchName(r.branch_id), city: cityName(r.city_id), category: cats.find((c) => c.id === r.category_id)?.name, amount: r.amount, paid_to: r.paid_to, method: r.method, notes: r.notes }))) }, 'Download') : null)),
      list));
  await load();
}

// ---------------------------------------------------------------- cash closing
async function cash(root) {
  const d = state.data;
  const branches = myBranches();
  const out = h('div', {});
  const verify = (c) => modal('Verify this cash closing?',
    h('p', {}, `${branchName(c.branch_id)}, ${shortDate(c.closing_date)}: expected ${rupees(c.expected_cash)}, counted ${rupees(c.counted_cash)}${Number(c.difference) ? `, a difference of ${rupees(c.difference)}` : ', no difference'}.`), [
      { label: 'Cancel' },
      { label: 'Verify closing', primary: true, onClick: async () => {
        try { await d.verifyClosing(c.id); toast('Verified.', 'ok'); load(); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  async function load() {
    const closings = await d.cashClosings().catch(() => []);
    const today = todayISO();
    const closeForm = can('cash.close') ? await (async () => {
      const branch = select(branches.map((b) => ({ value: b.id, label: b.name })), defaultBranchId());
      const expected = h('strong', {});
      const counted = h('input', { type: 'number', min: 0, step: 1, placeholder: 'Cash counted in the drawer (Rs)' });
      const notes = h('input', { placeholder: 'Notes, if it does not match' });
      const refresh = async () => { try { expected.textContent = rupees(await d.expectedCash(branch.value, today)); } catch { expected.textContent = '–'; } };
      branch.addEventListener('change', refresh);
      await refresh();
      const panel = h('section', { class: 'panel' },
        h('h2', {}, `Close today's cash · ${shortDate(today)}`),
        h('p', {}, 'Cash payments recorded today: ', expected),
        h('div', { class: 'form-grid' }, field('Branch', branch), field('Cash counted', counted, null, { required: true }), field('Notes', notes)),
        h('button', { class: 'btn btn-primary', onclick: busy(async () => {
          clearFieldErrors(panel);
          if (counted.value === '') { showFormErrors(panel, [{ input: counted, message: 'Enter the cash you counted.' }]); return; }
          const c = await d.closeCash(branch.value, today, Number(counted.value), notes.value);
          toast(Number(c.difference) === 0 ? 'Cash closed. It matches.' : `Cash closed. Difference ${rupees(c.difference)} sent to the accountant.`, Number(c.difference) === 0 ? 'ok' : 'error', 6000);
          load();
        }) }, 'Close cash for today'));
      return panel;
    })() : null;
    mount(out, closeForm,
      h('section', { class: 'panel' },
        h('h2', {}, 'Recent closings'),
        capNote(closings, 'closings'),
        closings.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Date'), h('th', { scope: 'col' }, 'Branch'), h('th', { scope: 'col', class: 'right' }, 'Expected'), h('th', { scope: 'col', class: 'right' }, 'Counted'), h('th', { scope: 'col', class: 'right' }, 'Difference'), h('th', { scope: 'col' }, 'Notes'), h('th', { scope: 'col' }, 'Verified'))),
          h('tbody', {}, closings.map((c) => h('tr', {},
            h('td', { class: 'nowrap' }, shortDate(c.closing_date)), h('td', {}, branchName(c.branch_id)),
            h('td', { class: 'right' }, rupees(c.expected_cash)), h('td', { class: 'right' }, rupees(c.counted_cash)),
            h('td', { class: ['right', Number(c.difference) ? 'status-bad' : 'status-ok'] }, h('strong', {}, rupees(c.difference))),
            h('td', {}, c.notes || ''),
            h('td', {}, c.verified_at || c.verified_by ? h('span', { class: 'badge badge-ok' }, 'Verified')
              : can('cash.verify') ? h('button', { class: 'btn btn-small', 'aria-label': `Verify, ${branchName(c.branch_id)} ${shortDate(c.closing_date)}`, onclick: () => verify(c) }, 'Verify') : h('span', { class: 'badge badge-muted' }, 'Waiting'))))))) : empty('No cash closings yet.')));
  }
  mount(root, out);
  await load();
}
