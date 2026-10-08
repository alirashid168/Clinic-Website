// Reports: report families (Financial, Patients, OPD, Inventory, Accounts, HR)
// each with a strip of report tabs, a filter bar (dates, branch, payment mode,
// search) and a Download / Print on every table — the layout the team knows
// from Healthwire's Financial Report screen.
import { h, mount, rupees, shortDate, timeOf, toast, friendlyError, select, empty, todayISO, downloadCSV, localISO, addDaysISO } from '../../ui/dom.js';
import { state, can, isAdmin, branchName, myBranches } from '../../state.js';
import { ROLE_LABELS } from '../../lib/permissions.js';
import { tabbed } from './accounts.js';
import { printSheet } from './invoice.js';

const GROUPS = [
  ['financial', 'Financial', () => can('finance.view')],
  ['patients', 'Patients', () => can('patients.view')],
  ['opd', 'OPD', () => can('sheet.view')],
  ['inventory', 'Inventory', () => can('inventory.manage')],
  ['accounts', 'Accounts', () => can('finance.view') || can('cash.verify')],
  ['hr', 'HR', () => can('doctor_log.view_all') || isAdmin()],
];
const TABS = {
  financial: [['transactions', 'Transactions'], ['summary', 'Summary'], ['methods', 'Payment mode'], ['procedures', 'Procedures'], ['income', 'Income statement'], ['doctors', 'Doctors share'],
    ['pending', 'Pending payments'], ['advance', 'Advance payments'], ['void', 'Void invoices'], ['refunds', 'Refunds'], ['discounts', 'Discounts'], ['statistics', 'Statistics'], ['cost', 'Cost per patient']],
  patients: [['new', 'New patients'], ['referrals', 'Referral sources'], ['braces', 'Braces'], ['photos', 'Photo months'], ['dues', 'Highest dues']],
  opd: [['daily', 'Daily'], ['monthly', 'Monthly'], ['wait', 'Waiting time']],
  inventory: [['stock', 'Stock levels'], ['low', 'Low stock']],
  accounts: [['expenses', 'Expenses by category'], ['cash', 'Cash closings'], ['lab', 'Lab and retainer costs']],
  hr: [['doctors', 'Doctors'], ['logins', 'Logins']],
};
// Reports that take a search box, a payment-mode filter, or no period at all (they show the position today).
const SEARCHABLE = ['financial/transactions', 'financial/summary', 'financial/methods', 'financial/procedures', 'financial/doctors', 'financial/pending', 'financial/advance', 'financial/void', 'financial/refunds', 'financial/discounts', 'patients/dues', 'hr/doctors'];
const BY_MODE = ['financial/transactions', 'financial/summary'];
const AS_OF_TODAY = ['financial/pending', 'financial/advance', 'patients/dues'];
const METHOD_LABEL = { cash: 'Cash', card: 'Card', bank_transfer: 'Bank transfer', cheque: 'Cheque', other: 'Other' };
const monthLabel = (m) => (m ? new Date(m + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : '');
const num = (v) => Number(v || 0).toLocaleString('en-PK');
/** The Karachi calendar day of a date or timestamp (a timestamp's UTC day is a day behind before 5 AM PKT). */
const dayOf = (v) => { const s = String(v); return s.length > 10 ? localISO(new Date(s)) : s; };
/**
 * A capped fetch says so on the report, so a partial total is never shown as complete.
 * totalsComplete: the figures above the table were added up by the database for the whole period.
 */
const capNote = (rows, totalsComplete = false) => {
  if (!rows?.truncated) return null;
  const n = num(rows.cap ?? rows.length);
  return totalsComplete
    ? h('div', { class: 'alert alert-info', role: 'status' }, `The table shows the first ${n} rows; the totals above cover the whole period.`)
    : h('div', { class: 'alert alert-warning', role: 'status' }, h('strong', {}, 'Incomplete report. '), `Showing the first ${n} rows; totals may be incomplete. Pick a shorter date range or one branch to see everything.`);
};
/** A period summary whose totals were added up from a capped set of rows. */
const summaryNote = (sum) => (sum?.truncated ? capNote({ truncated: true, cap: 20000 }) : null);
const avgWait = (min) => (min === null || min === undefined ? '' : `${Math.round(Number(min))} min`);
const sumBy = (rows, keys, fields) => {
  const out = {};
  for (const r of rows) {
    const k = keys.map((x) => r[x] ?? '').join('|');
    out[k] ||= Object.fromEntries([...keys.map((x) => [x, r[x]]), ...fields.map((f) => [f, 0])]);
    for (const f of fields) out[k][f] += Number(r[f] || 0);
  }
  return Object.values(out);
};

export async function renderReports(root, params) {
  const d = state.data;
  const groups = GROUPS.filter((g) => g[2]());
  if (!groups.length) { mount(root, empty('No reports are available for your account.')); return; }
  let group = groups.some((g) => g[0] === params.get('group')) ? params.get('group') : groups[0][0];
  let tab = (TABS[group].find((t) => t[0] === params.get('tab')) || TABS[group][0])[0];
  const today = todayISO();
  const defaults = { financial: today.slice(0, 8) + '01', accounts: today.slice(0, 8) + '01', patients: `${Number(today.slice(0, 4)) - 1}${today.slice(4, 8)}01`, opd: addDaysISO(today, -29), hr: today.slice(0, 8) + '01', inventory: today };

  const from = h('input', { type: 'date', value: params.get('from') || defaults[group], 'aria-label': 'From' });
  const to = h('input', { type: 'date', value: params.get('to') || today, 'aria-label': 'To' });
  const branch = select([{ value: '', label: 'All branches' }, ...myBranches().map((b) => ({ value: b.id, label: b.name }))], params.get('branch') || '', { 'aria-label': 'Branch' });
  const method = select([{ value: '', label: 'All payment modes' }, ...Object.entries(METHOD_LABEL).map(([value, label]) => ({ value, label }))], '', { 'aria-label': 'Payment mode' });
  const search = h('input', { type: 'search', placeholder: 'Invoice#, Mr# or name', 'aria-label': 'Search in this report', style: { maxWidth: '220px' } });
  const filters = h('div', { class: 'report-filters inline' });
  const body = h('div', { class: 'report-body' });

  const money = (v) => h('td', { class: ['right', Number(v) < 0 && 'status-bad'] }, rupees(v));
  const cell = (r, key, kind) => {
    if (kind === 'money') return money(r[key]);
    if (kind === 'num') return h('td', { class: 'right' }, num(r[key]));
    if (kind === 'branch') return h('td', {}, r[key] === null || r[key] === undefined || r[key] === '' ? h('span', { class: 'muted' }, 'No branch') : branchName(r[key]) || `Branch ${r[key]}`);
    if (kind === 'month') return h('td', { class: 'nowrap' }, monthLabel(r[key]));
    if (kind === 'date') return h('td', { class: 'nowrap' }, r[key] ? shortDate(dayOf(r[key])) : '');
    if (kind === 'datetime') return h('td', { class: 'nowrap' }, r[key] ? `${shortDate(dayOf(r[key]))} ${timeOf(r[key])}` : '');
    if (kind === 'patient') return h('td', {}, r.patient_id ? h('a', { href: `#/staff/patient/${r.patient_id}` }, r[key]) : (r[key] ?? ''));
    if (kind === 'method') return h('td', {}, METHOD_LABEL[r[key]] || r[key] || '');
    return h('td', {}, r[key] ?? '');
  };
  /** One report table: columns = [label, key, kind]; kind = money | num | text | branch | month | date | datetime | patient | method. */
  const table = (title, help, rows, columns, csvName, totals) => h('section', { class: 'panel report-table' },
    h('div', { class: 'panel-head' }, h('h2', {}, title), h('div', { class: 'inline' },
      rows.length ? h('button', { class: 'btn btn-small', onclick: () => downloadCSV(`${csvName}_${from.value}_${to.value}.csv`, rows.map((r) => Object.fromEntries(columns.map(([label, key, kind]) => [label, kind === 'branch' ? (branchName(r[key]) || '') : kind === 'method' ? (METHOD_LABEL[r[key]] || r[key]) : r[key]])))) }, 'Download') : null,
      h('button', { class: 'btn btn-small', onclick: () => printSheet(body) }, 'Print'))),
    help ? h('p', { class: 'muted' }, help) : null,
    rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, columns.map(([label, , kind]) => h('th', { scope: 'col', class: kind === 'money' || kind === 'num' ? 'right' : '' }, label)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, columns.map(([, key, kind]) => cell(r, key, kind))))),
      totals ? h('tfoot', {}, h('tr', {}, columns.map(([, key, kind], i) => i === 0 ? h('td', {}, h('strong', {}, 'Total')) : (kind === 'money' || kind === 'num') && totals[key] !== undefined ? h('td', { class: 'right' }, h('strong', {}, kind === 'money' ? rupees(totals[key]) : num(totals[key]))) : h('td', {})))) : null)) : empty('Nothing in this period.'));
  /** tone 'bad' | 'ok' colours the figure through the status classes; the label always says what it is. */
  const stat = (value, label, tone) => h('div', { class: 'stat' }, h('strong', { class: tone ? `status-${tone}` : null }, value), h('span', {}, label));
  const stats = (...items) => h('div', { class: 'stat-row', style: { marginBottom: '16px' } }, items);
  const total = (rows, k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);
  const q = () => search.value.trim().toLowerCase();
  const matches = (r) => { const t = q(); if (!t) return true; return [r.invoice_no, r.patient?.mr_number, r.patient?.full_name, r.patient?.phone, r.full_name, r.mr_number].some((x) => String(x || '').toLowerCase().includes(t)); };
  const range = () => ({ from: from.value, to: to.value, branchId: branch.value ? Number(branch.value) : null });
  const byBranch = (rows) => (branch.value ? rows.filter((r) => String(r.branch_id) === branch.value) : rows);
  const report = async (kind) => { try { return await d.report(kind, from.value, to.value); } catch (e) { toast(`${kind}: ${friendlyError(e)}`, 'error'); return []; } };
  const pname = (r) => (r.patient ? `${r.patient.full_name} (Mr# ${r.patient.mr_number})` : '');
  const withPatient = (rows) => rows.map((r) => ({ ...r, patient_name: pname(r), mr_number: r.patient?.mr_number, phone: r.patient?.phone }));

  // ------------------------------------------------------------ loaders (one per tab)
  const loaders = {
    // Payment totals come from the database for the whole period (paymentsSummary). Only a search,
    // which matches patient names in the browser, makes them add up the rows that were fetched.
    'financial/transactions': async () => {
      const args = { ...range(), method: method.value || null };
      const [raw, sum] = await Promise.all([d.paymentsReport(args), q() ? null : d.paymentsSummary(args)]);
      const rows = withPatient(raw.filter(matches));
      const received = rows.filter((r) => Number(r.amount) > 0), refunds = rows.filter((r) => Number(r.amount) < 0);
      const t = sum?.totals || { received: total(received, 'amount'), cash: total(received.filter((r) => r.method === 'cash'), 'amount'), card: total(received.filter((r) => r.method !== 'cash'), 'amount'), bank: 0,
        refunds: -total(refunds, 'amount'), net: total(rows, 'amount'), count: rows.length };
      return [summaryNote(sum) || capNote(raw, !!sum), stats(stat(rupees(t.received), 'Received'), stat(rupees(t.cash), 'Cash'),
          stat(rupees(Number(t.card) + Number(t.bank)), 'Card / bank / cheque'), stat(rupees(t.refunds), 'Refunded', Number(t.refunds) ? 'bad' : ''),
          stat(rupees(t.net), 'Net'), stat(num(t.count), 'Payments')),
        table('Transactions', 'Every payment in the period, newest first. Refunds are negative.', rows,
          [['Date', 'received_at', 'datetime'], ['Invoice', 'invoice_no', 'text'], ['Patient', 'patient_name', 'patient'], ['Branch', 'branch_id', 'branch'], ['Mode', 'method', 'method'], ['Received by', 'received_by_name', 'text'], ['Reference', 'reference', 'text'], ['Amount', 'amount', 'money']], 'transactions', raw.truncated ? null : { amount: total(rows, 'amount') })];
    },
    'financial/summary': async () => {
      const args = { ...range(), method: method.value || null };
      const fields = ['received', 'cash', 'card', 'bank', 'refunds', 'net', 'count'];
      let days; let note;
      if (!q()) {
        const sum = await d.paymentsSummary(args);
        days = sum.byDay;
        note = summaryNote(sum);
      } else {
        const raw = await d.paymentsReport(args);
        const rows = raw.filter(matches).map((r) => ({ day: dayOf(r.received_at), branch_id: r.branch_id,
          received: Math.max(0, Number(r.amount)), cash: r.method === 'cash' && Number(r.amount) > 0 ? Number(r.amount) : 0, card: r.method === 'card' && Number(r.amount) > 0 ? Number(r.amount) : 0,
          bank: !['cash', 'card'].includes(r.method) && Number(r.amount) > 0 ? Number(r.amount) : 0, refunds: Math.max(0, -Number(r.amount)), net: Number(r.amount), count: 1 }));
        days = sumBy(rows, branch.value ? ['day'] : ['day', 'branch_id'], fields).sort((a, b) => b.day.localeCompare(a.day) || (a.branch_id || 0) - (b.branch_id || 0));
        note = capNote(raw);
      }
      const cols = [['Day', 'day', 'date'], ...(branch.value ? [] : [['Branch', 'branch_id', 'branch']]), ['Received', 'received', 'money'], ['Cash', 'cash', 'money'], ['Card', 'card', 'money'], ['Bank / cheque / other', 'bank', 'money'], ['Refunds', 'refunds', 'money'], ['Net', 'net', 'money'], ['Payments', 'count', 'num']];
      return [note, stats(stat(rupees(total(days, 'received')), 'Received'), stat(rupees(total(days, 'refunds')), 'Refunded'), stat(rupees(total(days, 'net')), 'Net'), stat(num(days.length), branch.value ? 'Days' : 'Branch-days')),
        table('Summary by day', 'Totals per day' + (branch.value ? '' : ' and branch') + ' for the period.', days, cols, 'summary', Object.fromEntries(fields.map((k) => [k, total(days, k)])))];
    },
    'financial/methods': async () => {
      let rows; let note;
      if (!q()) {
        const sum = await d.paymentsSummary(range());
        rows = sum.byMethod;
        note = summaryNote(sum);
      } else {
        const raw = await d.paymentsReport(range());
        rows = raw.filter(matches).map((r) => ({ method: r.method, amount: Number(r.amount) > 0 ? Number(r.amount) : 0, refunds: Number(r.amount) < 0 ? -Number(r.amount) : 0, count: 1 }));
        note = capNote(raw);
      }
      const grand = total(rows, 'amount');
      const by = sumBy(rows, ['method'], ['amount', 'refunds', 'count']).map((r) => ({ ...r, share: grand ? Math.round((100 * r.amount) / grand) + '%' : '' })).sort((a, b) => b.amount - a.amount);
      return [note, table('Payment mode', 'How money came in during the period.', by, [['Mode', 'method', 'method'], ['Received', 'amount', 'money'], ['Share', 'share', 'text'], ['Refunds', 'refunds', 'money'], ['Payments', 'count', 'num']], 'payment_mode', { amount: grand, refunds: total(by, 'refunds'), count: total(by, 'count') })];
    },
    'financial/procedures': async () => {
      const rows = (await report('treatments')).filter((r) => !q() || String(r.treatment || '').toLowerCase().includes(q()));
      return [table('Procedures', 'Invoice lines in the period, biggest first.', rows, [['Treatment', 'treatment', 'text'], ['Times', 'count', 'num'], ['Amount', 'amount', 'money']], 'procedures', { count: total(rows, 'count'), amount: total(rows, 'amount') })];
    },
    'financial/income': async () => {
      const got = await report('pnl_trend');
      const pnl = sumBy(byBranch(got), ['month'], ['income', 'expenses']).map((r) => ({ ...r, profit: r.income - r.expenses })).sort((x, y) => x.month.localeCompare(y.month));
      const pnlBranch = sumBy(got.filter((r) => r.branch_id !== null), ['branch_id'], ['income', 'expenses']).map((r) => ({ ...r, profit: r.income - r.expenses })).sort((x, y) => y.income - x.income);
      const unassigned = got.filter((r) => r.branch_id === null).reduce((s, r) => s + Number(r.expenses), 0);
      const net = total(pnl, 'profit');
      return [stats(stat(rupees(total(pnl, 'income')), 'Income (received)'), stat(rupees(total(pnl, 'expenses')), 'Expenses'), stat(rupees(net), net < 0 ? 'Loss' : 'Profit', net < 0 ? 'bad' : 'ok')),
        table('Income statement by month', branch.value ? 'Income at this branch and expenses tagged to it.' : `All branches.${unassigned > 0 ? ` ${rupees(unassigned)} of expenses were recorded against a city only (rent, salaries, ads) and are included.` : ''}`,
          pnl, [['Month', 'month', 'month'], ['Income', 'income', 'money'], ['Expenses', 'expenses', 'money'], ['Profit', 'profit', 'money']], 'income_statement', { income: total(pnl, 'income'), expenses: total(pnl, 'expenses'), profit: net }),
        branch.value ? null : table('By branch (whole period)', 'Expenses with no branch are not in this table.', pnlBranch, [['Branch', 'branch_id', 'branch'], ['Income', 'income', 'money'], ['Expenses', 'expenses', 'money'], ['Profit', 'profit', 'money']], 'income_by_branch')];
    },
    'financial/doctors': async () => {
      const [got, rules] = await Promise.all([report('doctors'), d.commissionRules().catch(() => [])]);
      const rows = got.map((r) => {
        const rule = rules.find((x) => x.clinician_id === r.clinician_id) || rules.find((x) => !x.clinician_id);
        if (!rule) return { ...r, share: null, rule: '' };
        const base = rule.basis === 'treated' ? Number(r.billed) : rule.basis === 'referred' ? Number(r.referred_paid || 0) : Number(r.billed) + Number(r.referred_paid || 0);
        return { ...r, share: base * Number(rule.percent) / 100, rule: `${Number(rule.percent)}% of ${rule.basis === 'referred' ? 'own patients paid' : rule.basis === 'treated' ? 'billed' : 'both'}` };
      }).filter((r) => !q() || String(r.name).toLowerCase().includes(q()));
      return [stats(stat(rupees(total(rows, 'share')), 'Doctor share to pay'), stat(rupees(total(rows, 'referred_paid')), 'Own patients paid'), stat(num(total(rows, 'treated')), 'Visits treated')),
        table('Doctors share', '"Own patients" are patients marked "brought in by" that doctor; what they paid in the period is the base for the 60/40 rule (Admin → Clinic setup). "Billed" counts invoices made from visits the doctor treated.',
          rows, [['Doctor', 'name', 'text'], ['Treated', 'treated', 'num'], ['Checked', 'checked', 'num'], ['Days', 'days', 'num'], ['Own patients', 'referred_patients', 'num'], ['Own patients paid', 'referred_paid', 'money'], ['Billed (treated)', 'billed', 'money'], ['Rule', 'rule', 'text'], ['Share', 'share', 'money']], 'doctors_share', { share: total(rows, 'share'), referred_paid: total(rows, 'referred_paid'), billed: total(rows, 'billed') })];
    },
    'financial/pending': async () => {
      const [byB, top] = await Promise.all([report('dues_by_branch'), report('top_dues')]);
      const rows = top.map((r) => ({ ...r, name: `${r.full_name} (Mr# ${r.mr_number})` })).filter(matches).filter((r) => !branch.value || String(r.branch_id) === branch.value);
      return [stats(stat(rupees(total(byB, 'dues')), 'Pending dues today (all time)', 'bad'), stat(num(total(byB, 'patients')), 'Patients with dues')),
        table('Pending payments by branch', 'Dues today, by the branch each patient first came to.', byBranch(byB), [['Branch', 'branch_id', 'branch'], ['Patients with dues', 'patients', 'num'], ['Dues', 'dues', 'money']], 'pending_by_branch', { patients: total(byBranch(byB), 'patients'), dues: total(byBranch(byB), 'dues') }),
        table('Patients with the highest dues', 'Top 100.', rows, [['Patient', 'name', 'patient'], ['Phone', 'phone', 'text'], ['Branch', 'branch_id', 'branch'], ['Dues', 'dues', 'money'], ['Last payment', 'last_payment', 'text']], 'pending_patients')];
    },
    'financial/advance': async () => {
      const raw = await d.advances();
      const rows = withPatient(raw).filter(matches);
      return [capNote(raw), stats(stat(rupees(total(rows, 'advance')), 'Advance held'), stat(num(rows.length), 'Patients in credit')),
        table('Advance payments', 'Patients who have paid more than they have been invoiced (money held against future treatment).', rows, [['Patient', 'patient_name', 'patient'], ['Phone', 'phone', 'text'], ['Invoiced', 'billed', 'money'], ['Paid', 'paid', 'money'], ['Advance', 'advance', 'money']], 'advances', { advance: total(rows, 'advance') })];
    },
    'financial/void': async () => {
      const raw = await d.invoicesReport({ ...range(), status: 'void' });
      const rows = withPatient(raw).filter(matches);
      return [capNote(raw), stats(stat(num(rows.length), 'Void invoices'), stat(rupees(total(rows, 'total')), 'Amount voided')),
        table('Void invoices', 'Invoices cancelled in the period, with the reason. Every void is in the audit log.', rows, [['Invoice', 'invoice_no', 'text'], ['Date', 'issue_date', 'date'], ['Patient', 'patient_name', 'patient'], ['Branch', 'branch_id', 'branch'], ['Amount', 'total', 'money'], ['Reason', 'void_reason', 'text'], ['Made by', 'created_by_name', 'text']], 'void_invoices', { total: total(rows, 'total') })];
    },
    'financial/refunds': async () => {
      const raw = await d.paymentsReport(range());
      const rows = withPatient(raw.filter((r) => Number(r.amount) < 0).filter(matches)).map((r) => ({ ...r, refund: -Number(r.amount) }));
      return [capNote(raw), stats(stat(rupees(total(rows, 'refund')), 'Refunded', rows.length ? 'bad' : ''), stat(num(rows.length), 'Refunds')),
        table('Refunds', 'Money given back in the period.', rows, [['Date', 'received_at', 'datetime'], ['Invoice', 'invoice_no', 'text'], ['Patient', 'patient_name', 'patient'], ['Branch', 'branch_id', 'branch'], ['Mode', 'method', 'method'], ['By', 'received_by_name', 'text'], ['Notes', 'notes', 'text'], ['Refund', 'refund', 'money']], 'refunds', { refund: total(rows, 'refund') })];
    },
    'financial/discounts': async () => {
      const raw = await d.invoicesReport({ ...range(), discounted: true });
      const rows = withPatient(raw).filter(matches).map((r) => ({ ...r, pct: Number(r.subtotal) ? Math.round((100 * Number(r.discount_amount)) / Number(r.subtotal)) + '%' : '' }));
      return [capNote(raw), stats(stat(rupees(total(rows, 'discount_amount')), 'Discount given'), stat(rupees(total(rows, 'subtotal')), 'Before discount'), stat(num(rows.length), 'Discounted invoices')),
        table('Discounts', 'Invoices with a discount in the period. Discounts above the front-desk cap needed approval (Billing → Approvals).', rows, [['Invoice', 'invoice_no', 'text'], ['Date', 'issue_date', 'date'], ['Patient', 'patient_name', 'patient'], ['Branch', 'branch_id', 'branch'], ['Before', 'subtotal', 'money'], ['Discount', 'discount_amount', 'money'], ['%', 'pct', 'text'], ['After', 'total', 'money'], ['Reason', 'discount_reason', 'text'], ['Status', 'status', 'text']], 'discounts', { subtotal: total(rows, 'subtotal'), discount_amount: total(rows, 'discount_amount'), total: total(rows, 'total') })];
    },
    'financial/statistics': async () => {
      const got = byBranch(await report('visits'));
      const rows = sumBy(got, ['month'], ['visits', 'patients', 'new_patients', 'no_shows']).map((r) => {
        const src = got.filter((x) => x.month === r.month && x.avg_wait_min !== null && x.avg_wait_min !== undefined);
        return { ...r, avg_wait: src.length ? Math.round(src.reduce((s, x) => s + Number(x.avg_wait_min) * Number(x.visits || 1), 0) / Math.max(1, src.reduce((s, x) => s + Number(x.visits || 1), 0))) + ' min' : '' };
      }).sort((x, y) => x.month.localeCompare(y.month));
      return [stats(stat(num(total(rows, 'visits')), 'Completed visits'), stat(num(total(rows, 'patients')), 'Patient-months'), stat(num(total(rows, 'new_patients')), 'New patients'), stat(num(total(rows, 'no_shows')), 'No-shows')),
        table('Statistics by month', 'A new patient is someone whose first ever completed visit falls in that month. Waiting time = check-in to treatment start, for visits run on the website.', rows, [['Month', 'month', 'month'], ['Visits', 'visits', 'num'], ['Patients seen', 'patients', 'num'], ['New patients', 'new_patients', 'num'], ['No-shows', 'no_shows', 'num'], ['Avg wait', 'avg_wait', 'text']], 'statistics', { visits: total(rows, 'visits'), patients: total(rows, 'patients'), new_patients: total(rows, 'new_patients'), no_shows: total(rows, 'no_shows') })];
    },
    'financial/cost': async () => {
      const [pnl, visits] = await Promise.all([report('pnl_trend'), report('visits')]);
      const keys = branch.value ? ['month'] : ['month', 'branch_id'];
      const exp = sumBy(byBranch(pnl).filter((r) => branch.value || r.branch_id !== null), keys, ['expenses', 'income']);
      const vis = sumBy(byBranch(visits), keys, ['visits', 'patients']);
      const rows = exp.map((e) => { const v = vis.find((x) => keys.every((k) => String(x[k]) === String(e[k]))) || { visits: 0, patients: 0 };
        return { ...e, visits: v.visits, patients: v.patients, per_patient: v.patients ? e.expenses / v.patients : null, per_visit: v.visits ? e.expenses / v.visits : null, income_per_patient: v.patients ? e.income / v.patients : null }; })
        .sort((a, b) => a.month.localeCompare(b.month) || (a.branch_id || 0) - (b.branch_id || 0));
      return [table('Cost per patient', 'Expenses tagged to the branch divided by patients seen that month; "income per patient" is what was received divided by patients seen. City-level expenses (rent, salaries recorded without a branch) are not included.',
        rows, [['Month', 'month', 'month'], ...(branch.value ? [] : [['Branch', 'branch_id', 'branch']]), ['Expenses', 'expenses', 'money'], ['Patients seen', 'patients', 'num'], ['Visits', 'visits', 'num'], ['Cost per patient', 'per_patient', 'money'], ['Cost per visit', 'per_visit', 'money'], ['Income per patient', 'income_per_patient', 'money']], 'cost_per_patient')];
    },

    'patients/new': async () => {
      const got = byBranch(await report('visits'));
      const rows = sumBy(got, branch.value ? ['month'] : ['month', 'branch_id'], ['new_patients', 'patients', 'visits']).sort((a, b) => a.month.localeCompare(b.month) || (a.branch_id || 0) - (b.branch_id || 0));
      return [stats(stat(num(total(rows, 'new_patients')), 'New patients in the period')),
        table('New patients by month', 'First ever completed visit in that month.', rows, [['Month', 'month', 'month'], ...(branch.value ? [] : [['Branch', 'branch_id', 'branch']]), ['New patients', 'new_patients', 'num'], ['Patients seen', 'patients', 'num'], ['Visits', 'visits', 'num']], 'new_patients', { new_patients: total(rows, 'new_patients'), patients: total(rows, 'patients'), visits: total(rows, 'visits') })];
    },
    'patients/referrals': async () => {
      const rows = byBranch(await report('referrals')).sort((a, b) => b.patients - a.patients);
      return [table('Where patients heard about us', 'From the "How did they hear about us?" box when a patient is registered (patients registered in the period).', rows, [['Source', 'source', 'text'], ['Branch', 'branch_id', 'branch'], ['Patients', 'patients', 'num']], 'referral_sources', { patients: total(rows, 'patients') })];
    },
    'patients/braces': async () => {
      const rows = sumBy(byBranch(await report('braces')), branch.value ? ['month'] : ['month', 'branch_id'], ['bondings', 'braces_off', 'cases_started']).sort((a, b) => a.month.localeCompare(b.month) || (a.branch_id || 0) - (b.branch_id || 0));
      return [table('Braces by month', 'Bondings and braces-off visits from Aaj ki List (including imported history), and cases started on the website.', rows, [['Month', 'month', 'month'], ...(branch.value ? [] : [['Branch', 'branch_id', 'branch']]), ['Bondings', 'bondings', 'num'], ['Braces off', 'braces_off', 'num'], ['Cases started', 'cases_started', 'num']], 'braces', { bondings: total(rows, 'bondings'), braces_off: total(rows, 'braces_off'), cases_started: total(rows, 'cases_started') })];
    },
    'patients/photos': async () => {
      const rows = sumBy(byBranch(await report('photo_compliance')), ['month'], ['photo_months', 'uploaded']).map((r) => ({ ...r, missing: r.photo_months - r.uploaded, pct: r.photo_months ? Math.round((100 * r.uploaded) / r.photo_months) + '%' : '' })).sort((x, y) => x.month.localeCompare(y.month));
      return [table('Photo months', 'Braces photo months and how many had photos uploaded.', rows, [['Month', 'month', 'month'], ['Photo months', 'photo_months', 'num'], ['Photos uploaded', 'uploaded', 'num'], ['Missing', 'missing', 'num'], ['Done', 'pct', 'text']], 'photo_months', { photo_months: total(rows, 'photo_months'), uploaded: total(rows, 'uploaded'), missing: total(rows, 'missing') })];
    },
    'patients/dues': loadersAlias('financial/pending'),

    // OPD counts come from the database for the whole period (opdSummary), not from a capped list of visits.
    'opd/daily': async () => {
      const sum = await d.opdSummary(range());
      const rows = sum.byDay.map((r) => ({ ...r, avg_wait: avgWait(r.avg_wait_min) }));
      const t = sum.totals;
      return [summaryNote(sum), stats(stat(num(t.visits), 'Visits'), stat(num(t.completed), 'Completed'), stat(num(t.no_shows), 'No-shows'), stat(num(t.patients), 'Different patients')),
        table('OPD by day', 'Every row on the Aaj ki List in the period (visits in all states).', rows, [['Day', 'day', 'date'], ...(branch.value ? [] : [['Branch', 'branch_id', 'branch']]), ['Visits', 'visits', 'num'], ['Completed', 'completed', 'num'], ['No-shows', 'no_shows', 'num'], ['Cancelled', 'cancelled', 'num'], ['Avg wait', 'avg_wait', 'text']], 'opd_daily', { visits: t.visits, completed: t.completed, no_shows: t.no_shows, cancelled: t.cancelled })];
    },
    'opd/monthly': loadersAlias('financial/statistics'),
    'opd/wait': async () => {
      const sum = await d.opdSummary(range());
      const rows = sum.waitByBranch.filter((r) => Number(r.waited) > 0)
        .map((r) => ({ ...r, avg_wait: avgWait(r.avg_wait_min), long_pct: Math.round((100 * Number(r.long)) / Number(r.waited)) + '%' })).sort((a, b) => b.waited - a.waited);
      return [summaryNote(sum), table('Waiting time by branch', 'Check-in to treatment start, for visits run on the website in the period (imported history has no times).', rows, [['Branch', 'branch_id', 'branch'], ['Visits timed', 'waited', 'num'], ['Average wait', 'avg_wait', 'text'], ['Waited over 45 min', 'long', 'num'], ['Share over 45 min', 'long_pct', 'text']], 'waiting_time')];
    },

    'inventory/stock': async () => {
      const branches = branch.value ? myBranches().filter((b) => String(b.id) === branch.value) : myBranches();
      const rows = [];
      for (const b of branches) { const inv = await d.inventory(b.id).catch(() => null); if (!inv) continue; for (const it of inv.items) { const s = inv.stock.find((x) => x.item_id === it.id); rows.push({ branch_id: b.id, item: it.name, category: it.category, supplier: it.supplier || '', quantity: Number(s?.quantity || 0), unit: it.unit, reorder_level: Number(s?.reorder_level || 0), low: s && Number(s.reorder_level) > 0 && Number(s.quantity) <= Number(s.reorder_level) ? 'Low' : '' }); } }
      return [table('Stock levels', 'Current quantity per item and branch.', rows, [['Branch', 'branch_id', 'branch'], ['Item', 'item', 'text'], ['Category', 'category', 'text'], ['Supplier', 'supplier', 'text'], ['In stock', 'quantity', 'num'], ['Unit', 'unit', 'text'], ['Reorder at', 'reorder_level', 'num'], ['Stock alert', 'low', 'text']], 'stock_levels')];
    },
    'inventory/low': async () => {
      const branches = branch.value ? myBranches().filter((b) => String(b.id) === branch.value) : myBranches();
      const low = [];
      for (const b of branches) { const inv = await d.inventory(b.id).catch(() => null); if (!inv) continue; for (const it of inv.items) { const s = inv.stock.find((x) => x.item_id === it.id); if (s && Number(s.reorder_level) > 0 && Number(s.quantity) <= Number(s.reorder_level)) low.push({ branch_id: b.id, item: it.name, supplier: it.supplier || 'No supplier set', quantity: Number(s.quantity), reorder_level: Number(s.reorder_level), order: Math.max(1, Number(s.reorder_level) * 2 - Number(s.quantity)), unit: it.unit }); } }
      return [table('Low stock', 'Items at or below their reorder level, with the quantity to order to get back to twice the reorder level.', low, [['Branch', 'branch_id', 'branch'], ['Item', 'item', 'text'], ['Supplier', 'supplier', 'text'], ['In stock', 'quantity', 'num'], ['Reorder at', 'reorder_level', 'num'], ['Order', 'order', 'num'], ['Unit', 'unit', 'text']], 'low_stock')];
    },

    'accounts/expenses': async () => {
      const cats = state.ref.categories || [];
      const raw = await d.expenses({ from: from.value, to: to.value });
      const rows = byBranch(raw.map((e) => ({ ...e, category: cats.find((c) => c.id === e.category_id)?.name || `Category ${e.category_id}` })));
      const byCat = sumBy(rows.map((r) => ({ category: r.category, amount: Number(r.amount), count: 1 })), ['category'], ['amount', 'count']).sort((a, b) => b.amount - a.amount);
      const byCatBranch = sumBy(rows.map((r) => ({ category: r.category, branch_id: r.branch_id, amount: Number(r.amount), count: 1 })), ['category', 'branch_id'], ['amount', 'count']).sort((a, b) => a.category.localeCompare(b.category) || b.amount - a.amount);
      return [capNote(raw), stats(stat(rupees(total(byCat, 'amount')), 'Expenses in the period'), stat(num(rows.length), 'Entries')),
        table('Expenses by category', null, byCat, [['Category', 'category', 'text'], ['Amount', 'amount', 'money'], ['Entries', 'count', 'num']], 'expenses_by_category', { amount: total(byCat, 'amount'), count: total(byCat, 'count') }),
        branch.value ? null : table('By category and branch', 'Expenses recorded without a branch show as "No branch" (city-level: rent, salaries, ads).', byCatBranch, [['Category', 'category', 'text'], ['Branch', 'branch_id', 'branch'], ['Amount', 'amount', 'money'], ['Entries', 'count', 'num']], 'expenses_by_category_branch')];
    },
    'accounts/cash': async () => {
      const raw = await d.cashClosings();
      const rows = byBranch(raw.filter((c) => c.closing_date >= from.value && c.closing_date <= to.value)).map((c) => ({ ...c, status: c.verified_at || c.verified_by ? 'Verified' : 'Waiting', diff: Number(c.difference) }));
      const off = rows.filter((r) => r.diff !== 0);
      return [capNote(raw), stats(stat(num(rows.length), 'Closings'), stat(num(off.length), 'Did not match', off.length ? 'bad' : ''), stat(rupees(total(off, 'diff')), 'Net difference'), stat(num(rows.filter((r) => r.status !== 'Verified').length), 'Waiting for the accountant')),
        table('Cash closings', 'Front desk closes the day; the accountant verifies. Differences are flagged on Dr. Ali\'s Today page.', rows, [['Date', 'closing_date', 'date'], ['Branch', 'branch_id', 'branch'], ['Expected', 'expected_cash', 'money'], ['Counted', 'counted_cash', 'money'], ['Difference', 'diff', 'money'], ['Notes', 'notes', 'text'], ['Status', 'status', 'text']], 'cash_closings', { expected_cash: total(rows, 'expected_cash'), counted_cash: total(rows, 'counted_cash'), diff: total(rows, 'diff') })];
    },
    'accounts/lab': async () => {
      const rows = sumBy(byBranch(await report('lab_costs')), branch.value ? ['month'] : ['month', 'branch_id'], ['cases', 'cost']).sort((a, b) => a.month.localeCompare(b.month));
      return [table('Lab and retainer costs', 'From Coordinator → Lab work and Retainers. Add these as expenses if they are not already paid through Accounts.', rows, [['Month', 'month', 'month'], ...(branch.value ? [] : [['Branch', 'branch_id', 'branch']]), ['Cases', 'cases', 'num'], ['Cost', 'cost', 'money']], 'lab_costs', { cases: total(rows, 'cases'), cost: total(rows, 'cost') })];
    },

    'hr/doctors': async () => {
      const rows = (await report('doctors')).filter((r) => !q() || String(r.name).toLowerCase().includes(q())).map((r) => ({ ...r, group: r.group ? `Group ${r.group}` : '' }));
      return [table('Doctors', 'Completed visits in the period: treated, checked (as the checker group) and assisted, and the days each doctor worked. Open a doctor\'s own log under More → Doctor log.', rows, [['Doctor', 'name', 'text'], ['Group', 'group', 'text'], ['Treated', 'treated', 'num'], ['Checked', 'checked', 'num'], ['Assisted', 'assisted', 'num'], ['Days', 'days', 'num'], ['Billed (treated)', 'billed', 'money']], 'doctors', { treated: total(rows, 'treated'), checked: total(rows, 'checked'), assisted: total(rows, 'assisted'), billed: total(rows, 'billed') })];
    },
    'hr/logins': async () => {
      if (!isAdmin()) return [empty('Only Dr. Ali can see the login log.')];
      const got = await d.staffLogins().catch((e) => { toast(friendlyError(e), 'error'); return { staff: [], events: [] }; });
      const staff = got.staff.map((s) => ({ ...s, role_label: ROLE_LABELS[s.role] || s.role, status: s.active ? 'On' : 'Off' }));
      const events = got.events.filter((e) => dayOf(e.at) >= from.value && dayOf(e.at) <= to.value).map((e) => ({ ...e, who: e.name || '', role_label: e.role ? ROLE_LABELS[e.role] || e.role : e.kind === 'patient' ? 'Patient' : '' }));
      return [table('Staff accounts', 'Last sign-in comes from the login system itself.', staff, [['Name', 'full_name', 'text'], ['Login', 'email', 'text'], ['Role', 'role_label', 'text'], ['Account', 'status', 'text'], ['Last sign-in', 'last_sign_in_at', 'datetime'], ['Sign-ins (30 days)', 'sign_ins_30d', 'num']], 'staff_logins'),
        table('Sign-ins in the period', null, events, [['When', 'at', 'datetime'], ['Who', 'who', 'text'], ['Role', 'role_label', 'text'], ['Device', 'user_agent', 'text']], 'sign_ins')];
    },
  };
  function loadersAlias(key) { return (...a) => loaders[key](...a); }

  // ------------------------------------------------------------ drawing
  /**
   * What the report covers, as the first line inside the report body: that is what Print prints, so a paper copy
   * always says which period, branch, payment mode and search its totals belong to.
   */
  const caption = () => {
    const key = `${group}/${tab}`;
    const when = group === 'inventory' || AS_OF_TODAY.includes(key) ? `as of ${shortDate(today)}` : `${shortDate(from.value)} – ${shortDate(to.value)}`;
    const parts = [groups.find((g) => g[0] === group)?.[1], TABS[group].find((t) => t[0] === tab)?.[1], when, branch.value ? branchName(Number(branch.value)) : 'All branches'];
    if (BY_MODE.includes(key) && method.value) parts.push(METHOD_LABEL[method.value]);
    if (SEARCHABLE.includes(key) && q()) parts.push(`Search: "${search.value.trim()}"`);
    return h('p', { class: 'report-caption print-only' }, parts.filter(Boolean).join(' · '));
  };
  const go = () => { history.replaceState(null, '', `#/staff/reports?group=${group}&tab=${tab}&from=${from.value}&to=${to.value}${branch.value ? `&branch=${branch.value}` : ''}`); };
  let loading = 0;
  async function load() {
    go();
    const n = ++loading;
    mount(body, h('p', { class: 'muted' }, 'Loading…'));
    try {
      const parts = await loaders[`${group}/${tab}`]();
      if (n === loading) mount(body, caption(), parts.filter(Boolean));
    } catch (e) { if (n === loading) mount(body, empty(friendlyError(e))); }
  }
  // Two tab strips: the report family, then the report. A strip updates in place when a tab is
  // picked, so keyboard focus stays on it; only the report strip is rebuilt, when the family changes.
  const groupTabs = tabbed('Report family', groups.map(([key, label]) => [key, label]), group, (key) => {
    group = key; tab = TABS[group][0][0]; from.value = defaults[group]; to.value = today;
    drawReportTabs(); drawFilters(); load();
  });
  groupTabs.el.classList.add('report-groups');
  function drawReportTabs() {
    const reportTabs = tabbed('Report', TABS[group], tab, (key) => { tab = key; drawFilters(); load(); });
    reportTabs.el.classList.add('report-tabs');
    reportTabs.panel.append(filters, body);
    mount(groupTabs.panel, reportTabs.el, reportTabs.panel);
  }
  function drawFilters() {
    const noDates = group === 'inventory';
    mount(filters,
      noDates ? null : h('label', { class: 'inline' }, 'From ', from), noDates ? null : h('label', { class: 'inline' }, 'To ', to),
      branch,
      BY_MODE.includes(`${group}/${tab}`) ? method : null,
      SEARCHABLE.includes(`${group}/${tab}`) ? search : null,
      h('button', { class: 'btn btn-small btn-primary', onclick: load }, 'Search'));
  }
  [from, to, branch, method].forEach((el) => el.addEventListener('change', load));
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
  let timer; search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 350); });

  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Reports'), h('p', {}, 'Pick a report family, then a report. Every table can be downloaded or printed.'))),
    groupTabs.el, groupTabs.panel);
  drawReportTabs();
  drawFilters();
  await load();
}
