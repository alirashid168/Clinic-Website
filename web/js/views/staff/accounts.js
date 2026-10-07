// Accounts: expenses by city and branch, branch income vs expenses, daily
// cash closing, and the reports page (trends, dues, referrals, doctors).
import { h, mount, rupees, shortDate, toast, friendlyError, field, select, empty, todayISO, downloadCSV } from '../../ui/dom.js';
import { state, can, branchName, cityName, myBranches, defaultBranchId } from '../../state.js';

function tabs(items, current, onPick) {
  return h('div', { class: 'tabs', role: 'tablist' }, items.map(([key, label]) =>
    h('button', { class: 'tab', role: 'tab', 'aria-selected': String(key === current), onclick: () => onPick(key) }, label)));
}
export { tabs };

export async function renderAccounts(root, params) {
  const available = [
    can('finance.view') && ['pnl', 'Branch income vs expenses'],
    can('finance.view') && ['expenses', 'Expenses'],
    can('finance.view') && ['reports', 'Reports'],
    (can('cash.close') || can('cash.verify')) && ['cash', 'Cash closing'],
  ].filter(Boolean);
  let tab = params.get('tab') || available[0]?.[0];
  const body = h('div', {});
  const pick = (k) => { tab = k; history.replaceState(null, '', `#/staff/accounts?tab=${k}`); draw(); };
  const head = h('div', {});
  async function draw() {
    mount(head, tabs(available, tab, pick));
    if (tab === 'pnl') await pnl(body);
    else if (tab === 'expenses') await expenses(body);
    else if (tab === 'reports') await reports(body);
    else await cash(body);
  }
  mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'Accounts')), head, body);
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
    const money = (v) => h('td', { class: 'right', style: { color: v < 0 ? 'var(--stop)' : '' } }, rupees(v));
    mount(out,
      h('div', { class: 'stat-row', style: { marginBottom: '16px' } },
        h('div', { class: 'stat' }, h('strong', {}, rupees(total(rows, 'income'))), h('span', {}, 'Income (payments received)')),
        h('div', { class: 'stat' }, h('strong', {}, rupees(total(rows, 'expenses'))), h('span', {}, 'All expenses')),
        h('div', { class: 'stat' }, h('strong', { style: { color: net < 0 ? 'var(--stop)' : 'var(--ok)' } }, rupees(net)), h('span', {}, net < 0 ? 'Loss' : 'Profit')),
        h('div', { class: 'stat' }, h('strong', {}, rupees(total(branchOnly, 'expenses'))), h('span', {}, 'Expenses tagged to a branch'))),
      h('section', { class: 'panel' }, h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Branch'), h('th', { class: 'right' }, 'Income'), h('th', { class: 'right' }, 'Expenses'), h('th', { class: 'right' }, 'Difference'))),
        h('tbody', {}, cities.map((cid) => {
          const list = rows.filter((r) => r.city_id === cid);
          return [
            ...list.map((r) => h('tr', { class: r.branch_id == null ? 'muted' : null },
              h('td', {}, r.branch_id == null ? `${cityName(cid)} — not assigned to a branch` : r.branch), money(r.income), money(r.expenses), money(r.profit))),
            list.length > 1 ? h('tr', {}, h('td', {}, h('strong', {}, `${cityName(cid)} total`)), h('td', { class: 'right' }, h('strong', {}, rupees(total(list, 'income')))),
              h('td', { class: 'right' }, h('strong', {}, rupees(total(list, 'expenses')))), h('td', { class: 'right' }, h('strong', { style: { color: total(list, 'profit') < 0 ? 'var(--stop)' : '' } }, rupees(total(list, 'profit'))))) : null,
          ];
        }),
        h('tr', {}, h('td', {}, h('strong', {}, 'All branches')), h('td', { class: 'right' }, h('strong', {}, rupees(total(rows, 'income')))),
          h('td', { class: 'right' }, h('strong', {}, rupees(total(rows, 'expenses')))), h('td', { class: 'right' }, h('strong', { style: { color: net < 0 ? 'var(--stop)' : '' } }, rupees(net)))))))),
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
  const cityField = field('City', city, 'Only used when no branch is chosen.');
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
      rows.length ? h('div', {},
        h('p', { class: 'muted' }, Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${rupees(v)}`).join(' · ')),
        h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Branch / city'), h('th', {}, 'Category'), h('th', {}, 'Paid to'), h('th', {}, 'Notes'), h('th', { class: 'right' }, 'Amount'))),
          h('tbody', {}, rows.map((r) => h('tr', {},
            h('td', { class: 'nowrap' }, shortDate(r.expense_date)), h('td', {}, r.branch_id ? branchName(r.branch_id) : `${cityName(r.city_id)} (city)`),
            h('td', {}, catName(r.category_id)), h('td', {}, r.paid_to || ''), h('td', {}, r.notes || ''), h('td', { class: 'right' }, rupees(r.amount))))))))
        : empty('No expenses this month.'));
  }

  const form = can('expenses.manage') ? h('section', { class: 'panel' },
    h('h2', {}, 'Add expense'),
    h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        if (!category.value) return toast('Choose a category.');
        if (!(Number(amount.value) > 0)) return toast('Enter the amount.');
        try {
          await d.addExpense({ expense_date: date.value, branch_id: branch.value || null, city_id: Number(city.value), category_id: Number(category.value), amount: Number(amount.value), paid_to: paidTo.value, method: method.value, notes: notes.value });
          toast(`Expense of ${rupees(amount.value)} saved.`, 'ok');
          amount.value = ''; paidTo.value = ''; notes.value = '';
          load();
        } catch (err) { toast(friendlyError(err), 'error'); }
      },
    },
    h('div', { class: 'form-grid' }, field('Date', date), field('Branch', branch), cityField, field('Category', category), field('Amount (Rs)', amount), field('Paid to', paidTo), field('Paid by', method), field('Notes', notes)),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save expense'))) : null;

  monthInput.addEventListener('change', load);
  mount(root, form,
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Expenses'),
        h('div', { class: 'inline' }, monthInput, can('export.data') ? h('button', { class: 'btn btn-small', onclick: () => downloadCSV(`expenses_${monthInput.value}.csv`, rows.map((r) => ({ date: r.expense_date, branch: branchName(r.branch_id), city: cityName(r.city_id), category: cats.find((c) => c.id === r.category_id)?.name, amount: r.amount, paid_to: r.paid_to, method: r.method, notes: r.notes }))) }, 'Download') : null)),
      list));
  await load();
}

// ---------------------------------------------------------------- cash closing
async function cash(root) {
  const d = state.data;
  const branches = myBranches();
  const out = h('div', {});
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
      return h('section', { class: 'panel' },
        h('h2', {}, `Close today's cash · ${shortDate(today)}`),
        h('p', {}, 'Cash payments recorded today: ', expected),
        h('div', { class: 'form-grid' }, field('Branch', branch), field('Cash counted', counted), field('Notes', notes)),
        h('button', { class: 'btn btn-primary', onclick: async () => {
          if (counted.value === '') return toast('Enter the cash you counted.');
          try {
            const c = await d.closeCash(branch.value, today, Number(counted.value), notes.value);
            toast(Number(c.difference) === 0 ? 'Cash closed. It matches.' : `Cash closed. Difference ${rupees(c.difference)} sent to the accountant.`, Number(c.difference) === 0 ? 'ok' : 'error', 6000);
            load();
          } catch (e) { toast(friendlyError(e), 'error'); }
        } }, 'Close cash for today'));
    })() : null;
    mount(out, closeForm,
      h('section', { class: 'panel' },
        h('h2', {}, 'Recent closings'),
        closings.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Branch'), h('th', { class: 'right' }, 'Expected'), h('th', { class: 'right' }, 'Counted'), h('th', { class: 'right' }, 'Difference'), h('th', {}, 'Notes'), h('th', {}, 'Verified'))),
          h('tbody', {}, closings.map((c) => h('tr', {},
            h('td', { class: 'nowrap' }, shortDate(c.closing_date)), h('td', {}, branchName(c.branch_id)),
            h('td', { class: 'right' }, rupees(c.expected_cash)), h('td', { class: 'right' }, rupees(c.counted_cash)),
            h('td', { class: 'right', style: { color: Number(c.difference) ? 'var(--stop)' : 'var(--ok)', fontWeight: 700 } }, rupees(c.difference)),
            h('td', {}, c.notes || ''),
            h('td', {}, c.verified_at || c.verified_by ? h('span', { class: 'badge badge-ok' }, 'Verified')
              : can('cash.verify') ? h('button', { class: 'btn btn-small', onclick: async () => { await d.verifyClosing(c.id); toast('Verified.', 'ok'); load(); } }, 'Verify') : h('span', { class: 'badge badge-muted' }, 'Waiting'))))))) : empty('No cash closings yet.')));
  }
  mount(root, out);
  await load();
}

// ---------------------------------------------------------------- reports
const monthLabel = (m) => (m ? new Date(m + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : '');
const sumBy = (rows, keys, fields) => {
  const out = {};
  for (const r of rows) {
    const k = keys.map((x) => r[x] ?? '').join('|');
    out[k] ||= Object.fromEntries([...keys.map((x) => [x, r[x]]), ...fields.map((f) => [f, 0])]);
    for (const f of fields) out[k][f] += Number(r[f] || 0);
  }
  return Object.values(out);
};

async function reports(root) {
  const d = state.data;
  const today = todayISO();
  const from = h('input', { type: 'date', value: `${Number(today.slice(0, 4)) - 1}${today.slice(4, 8)}01` });
  const to = h('input', { type: 'date', value: today });
  const branch = select([{ value: '', label: 'All branches' }, ...state.ref.branches.map((b) => ({ value: b.id, label: b.name }))], '', { 'aria-label': 'Branch', style: { maxWidth: '260px' } });
  const out = h('div', {});
  const bname = (id) => (id === null || id === undefined || id === '' ? h('span', { class: 'muted' }, 'No branch') : branchName(id) || `Branch ${id}`);
  const money = (v) => h('td', { class: 'right', style: { color: Number(v) < 0 ? 'var(--stop)' : '' } }, rupees(v));
  const num = (v) => h('td', { class: 'right' }, Number(v || 0).toLocaleString('en-PK'));

  // One table per report: columns = [label, key, kind] where kind is money | num | text | branch | month.
  const section = (title, help, rows, columns, csvName) => h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, title), can('export.data') && rows.length ? h('button', { class: 'btn btn-small', onclick: () => downloadCSV(`${csvName}_${from.value}_${to.value}.csv`, rows.map((r) => Object.fromEntries(columns.map(([label, key, kind]) => [label, kind === 'branch' ? (branchName(r[key]) || '') : r[key]])))) }, 'Download') : null),
    help ? h('p', { class: 'muted' }, help) : null,
    rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, columns.map(([label, , kind]) => h('th', { class: kind === 'money' || kind === 'num' ? 'right' : '' }, label)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, columns.map(([, key, kind]) =>
        kind === 'money' ? money(r[key]) : kind === 'num' ? num(r[key]) : kind === 'branch' ? h('td', {}, bname(r[key])) : kind === 'month' ? h('td', { class: 'nowrap' }, monthLabel(r[key])) : kind === 'patient' ? h('td', {}, h('a', { href: `#/staff/patient/${r.patient_id}` }, r[key])) : h('td', {}, r[key] ?? ''))))))) : empty('Nothing in this period.'));

  async function load() {
    mount(out, h('p', { class: 'muted' }, 'Loading reports…'));
    const kinds = ['pnl_trend', 'payment_methods', 'visits', 'braces', 'dues_by_branch', 'top_dues', 'referrals', 'photo_compliance', 'lab_costs', 'doctors', 'treatments'];
    const got = {};
    let rules = [];
    await Promise.all([...kinds.map(async (k) => { try { got[k] = await d.report(k, from.value, to.value); } catch (e) { got[k] = []; toast(`${k}: ${friendlyError(e)}`, 'error'); } }),
      (async () => { try { rules = await d.commissionRules(); } catch { rules = []; } })()]);
    // Doctor share: their own rule first, otherwise the rule for every doctor. "referred" = on the doctor's
    // own patients (brought in by them); "treated" = on invoices from visits they treated; "both" = the two added.
    const doctors = got.doctors.map((r) => {
      const rule = rules.find((x) => x.clinician_id === r.clinician_id) || rules.find((x) => !x.clinician_id);
      if (!rule) return { ...r, share: null, rule: '' };
      const base = (rule.basis === 'treated' ? Number(r.billed) : 0) + (rule.basis === 'referred' ? Number(r.referred_paid || 0) : 0)
        + (rule.basis === 'both' ? Number(r.billed) + Number(r.referred_paid || 0) : 0);
      return { ...r, share: base * Number(rule.percent) / 100, rule: `${Number(rule.percent)}% of ${rule.basis === 'referred' ? 'own patients' : rule.basis === 'treated' ? 'treated' : 'both'}` };
    });
    const b = branch.value;
    const byBranch = (rows) => (b ? rows.filter((r) => String(r.branch_id) === b) : rows);

    const pnl = sumBy(byBranch(got.pnl_trend), ['month'], ['income', 'expenses']).map((r) => ({ ...r, profit: r.income - r.expenses })).sort((x, y) => x.month.localeCompare(y.month));
    const pnlBranch = sumBy(got.pnl_trend.filter((r) => r.branch_id !== null), ['branch_id'], ['income', 'expenses']).map((r) => ({ ...r, profit: r.income - r.expenses })).sort((x, y) => y.income - x.income);
    const unassigned = got.pnl_trend.filter((r) => r.branch_id === null).reduce((s, r) => s + Number(r.expenses), 0);
    const methods = sumBy(got.payment_methods, ['month', 'method'], ['amount', 'count']).sort((x, y) => x.month.localeCompare(y.month) || y.amount - x.amount);
    const visits = sumBy(byBranch(got.visits), ['month'], ['visits', 'patients', 'new_patients', 'no_shows']).map((r) => {
      const src = byBranch(got.visits).filter((x) => x.month === r.month && x.avg_wait_min !== null && x.avg_wait_min !== undefined);
      return { ...r, avg_wait: src.length ? Math.round(src.reduce((s, x) => s + Number(x.avg_wait_min) * Number(x.visits || 1), 0) / Math.max(1, src.reduce((s, x) => s + Number(x.visits || 1), 0))) + ' min' : '' };
    }).sort((x, y) => x.month.localeCompare(y.month));
    const braces = sumBy(byBranch(got.braces), ['month'], ['bondings', 'braces_off', 'cases_started']).sort((x, y) => x.month.localeCompare(y.month));
    const photos = sumBy(byBranch(got.photo_compliance), ['month'], ['photo_months', 'uploaded']).map((r) => ({ ...r, missing: r.photo_months - r.uploaded, pct: r.photo_months ? Math.round((100 * r.uploaded) / r.photo_months) + '%' : '' })).sort((x, y) => x.month.localeCompare(y.month));
    const lab = sumBy(byBranch(got.lab_costs), ['month'], ['cases', 'cost']).sort((x, y) => x.month.localeCompare(y.month));
    const totalDues = got.dues_by_branch.reduce((s, r) => s + Number(r.dues), 0);

    mount(out,
      h('div', { class: 'stat-row', style: { marginBottom: '16px' } },
        h('div', { class: 'stat' }, h('strong', {}, rupees(pnl.reduce((s, r) => s + r.income, 0))), h('span', {}, 'Received in this period')),
        h('div', { class: 'stat' }, h('strong', {}, rupees(pnl.reduce((s, r) => s + r.expenses, 0))), h('span', {}, 'Expenses in this period')),
        h('div', { class: 'stat' }, h('strong', {}, visits.reduce((s, r) => s + r.visits, 0).toLocaleString('en-PK')), h('span', {}, 'Completed visits')),
        h('div', { class: 'stat' }, h('strong', {}, visits.reduce((s, r) => s + r.new_patients, 0).toLocaleString('en-PK')), h('span', {}, 'New patients (first visit)')),
        h('div', { class: 'stat' }, h('strong', { style: { color: 'var(--stop)' } }, rupees(totalDues)), h('span', {}, 'Pending dues today (all time)'))),
      section('Income and expenses by month', b ? 'Income at this branch and expenses tagged to it.' : `All branches. ${unassigned > 0 ? rupees(unassigned) + ' of expenses were recorded against a city only (rent, salaries, ads) and are included.' : ''}`,
        pnl, [['Month', 'month', 'month'], ['Income', 'income', 'money'], ['Expenses', 'expenses', 'money'], ['Profit', 'profit', 'money']], 'income_expenses'),
      b ? null : section('Income and expenses by branch (whole period)', 'Expenses with no branch are not in this table.', pnlBranch, [['Branch', 'branch_id', 'branch'], ['Income', 'income', 'money'], ['Expenses', 'expenses', 'money'], ['Profit', 'profit', 'money']], 'branches'),
      section('Visits by month', 'A new patient is someone whose first ever completed visit falls in that month. Waiting time = check-in to treatment start, for visits run on the website.', visits, [['Month', 'month', 'month'], ['Visits', 'visits', 'num'], ['Patients seen', 'patients', 'num'], ['New patients', 'new_patients', 'num'], ['No-shows', 'no_shows', 'num'], ['Avg wait', 'avg_wait', 'text']], 'visits'),
      section('Pending dues by branch', 'Dues today, grouped by the branch each patient first came to. The top 100 are listed below.', got.dues_by_branch, [['Branch', 'branch_id', 'branch'], ['Patients with dues', 'patients', 'num'], ['Dues', 'dues', 'money']], 'dues_by_branch'),
      section('Patients with the highest dues', null, got.top_dues.map((r) => ({ ...r, name: `${r.full_name} (Mr# ${r.mr_number})` })), [['Patient', 'name', 'patient'], ['Phone', 'phone', 'text'], ['Branch', 'branch_id', 'branch'], ['Dues', 'dues', 'money'], ['Last payment', 'last_payment', 'text']], 'top_dues'),
      section('Braces by month', 'Bondings and braces-off visits from Aaj ki List (including imported history), and cases started on the website.', braces, [['Month', 'month', 'month'], ['Bondings', 'bondings', 'num'], ['Braces off', 'braces_off', 'num'], ['Cases started', 'cases_started', 'num']], 'braces'),
      section('Payments by method', null, methods, [['Month', 'month', 'month'], ['Method', 'method', 'text'], ['Amount', 'amount', 'money'], ['Payments', 'count', 'num']], 'payment_methods'),
      section('Where new patients heard about us', 'From the "How did they hear about us?" box when a patient is registered.', byBranch(got.referrals), [['Source', 'source', 'text'], ['Branch', 'branch_id', 'branch'], ['Patients', 'patients', 'num']], 'referrals'),
      section('Photo months', 'Braces photo months and how many had photos uploaded.', photos, [['Month', 'month', 'month'], ['Photo months', 'photo_months', 'num'], ['Photos uploaded', 'uploaded', 'num'], ['Missing', 'missing', 'num'], ['Done', 'pct', 'text']], 'photo_months'),
      section('Lab and retainer costs', 'From Coordinator → Lab work and Retainers. Add these as expenses if they are not already paid through Accounts.', lab, [['Month', 'month', 'month'], ['Cases', 'cases', 'num'], ['Cost', 'cost', 'money']], 'lab_costs'),
      section('Doctors', 'Completed visits in the period. "Own patients" are patients marked "brought in by" that doctor: what they paid in the period is the base for the 60/40 rule (Admin → Clinic setup). "Billed" counts invoices made from a visit on Aaj ki List.', doctors, [['Doctor', 'name', 'text'], ['Treated', 'treated', 'num'], ['Checked', 'checked', 'num'], ['Days', 'days', 'num'], ['Own patients', 'referred_patients', 'num'], ['Own patients paid', 'referred_paid', 'money'], ['Billed (treated)', 'billed', 'money'], ['Rule', 'rule', 'text'], ['Doctor share', 'share', 'money']], 'doctors'),
      section('Treatments invoiced', 'Invoice lines in the period, biggest first.', got.treatments, [['Treatment', 'treatment', 'text'], ['Times', 'count', 'num'], ['Amount', 'amount', 'money']], 'treatments'));
  }
  [from, to, branch].forEach((el) => el.addEventListener('change', load));
  mount(root, h('div', { class: 'inline', style: { marginBottom: '12px' } }, h('label', { class: 'inline' }, 'From ', from), h('label', { class: 'inline' }, 'To ', to), branch), out);
  await load();
}
