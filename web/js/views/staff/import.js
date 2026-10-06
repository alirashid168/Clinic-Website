// Admin → Import from Healthwire. Dr. Ali exports from Healthwire (emailed
// Excel files and the expenses PDF) and drops the files here; the page reads
// them in the browser, shows what it found, and writes through the
// import_healthwire() function in batches. Running the same file twice adds
// nothing. Nothing from the files leaves the browser except these batches.
import { h, mount, toast, friendlyError, rupees, field, todayISO } from '../../ui/dom.js';
import { state, branchName } from '../../state.js';
import { parseCSV, readTransactions, buildFromTransactions, readPatients, readExpensesPdf, buildExpenses, chunk, BRANCH_LABEL, BRANCH_ID } from '../../lib/healthwire.js';

const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/xlsx.mjs';
const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const PDF_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
const BATCH = 150;

async function fileToRows(file) {
  if (/\.csv$/i.test(file.name)) return parseCSV(await file.text());
  const XLSX = await import(/* @vite-ignore */ XLSX_URL);
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  // Healthwire's Excel writer declares the sheet narrower than it is (12 columns while rows hold 16),
  // so take the real extent from the cells themselves or the last columns vanish.
  let maxC = 0, maxR = 0;
  for (const k of Object.keys(ws)) { if (k[0] === '!') continue; const a = XLSX.utils.decode_cell(k); if (a.c > maxC) maxC = a.c; if (a.r > maxR) maxR = a.r; }
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
}

async function fileToPdfPages(file) {
  const pdfjs = await import(/* @vite-ignore */ PDFJS_URL);
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    pages.push({ items: tc.items.map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5] })) });
  }
  return pages;
}

const codeOf = Object.fromEntries(Object.entries(BRANCH_ID).map(([k, v]) => [v, k]));
const stat = (value, label) => h('div', { class: 'stat' }, h('strong', {}, value), h('span', {}, label));
const branchTable = (perBranch, label = 'Received') => h('table', { class: 'list', style: { maxWidth: '420px' } },
  h('thead', {}, h('tr', {}, h('th', {}, 'Branch'), h('th', { class: 'right' }, label))),
  h('tbody', {}, Object.entries(perBranch).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
    h('tr', {}, h('td', {}, k === 'none' ? h('span', { class: 'muted' }, 'No branch (personal / home / not stated)') : branchName(k) || BRANCH_LABEL[codeOf[k]] || k), h('td', { class: 'right' }, rupees(v))))));

/** Writes rows in batches, reporting progress; returns the summed result. */
async function runImport(kind, rows, progress, label) {
  const total = { given: 0, inserted: 0, updated: 0, items: 0, missing: 0 };
  const parts = chunk(rows, BATCH);
  for (let i = 0; i < parts.length; i++) {
    progress(`${label}: ${Math.min((i + 1) * BATCH, rows.length)} of ${rows.length}…`);
    const r = await state.data.importHealthwire(kind, parts[i]);
    for (const k of Object.keys(total)) total[k] += Number(r?.[k] || 0);
  }
  return total;
}

function filePicker(accept, onFile) {
  const input = h('input', { type: 'file', accept, onchange: () => { if (input.files[0]) onFile(input.files[0]); } });
  return input;
}

export async function renderImport(root) {
  const d = state.data;

  // ------------------------------------------------------------ 1. transactions
  const txOut = h('div', {});
  const txInput = filePicker('.xlsx,.xls,.csv', async (file) => {
    mount(txOut, h('p', { class: 'muted' }, `Reading ${file.name}…`));
    try {
      const rows = await fileToRows(file);
      const { tx, columns } = readTransactions(rows);
      const built = buildFromTransactions(tx);
      const s = built.summary;
      const mrs = built.patients.map((p) => p[0]);
      const known = new Set((await d.patientsByMr(mrs)).map((p) => p.mr_number));
      const newPatients = built.patients.filter((p) => !known.has(p[0]));
      const progress = h('p', { class: 'muted', 'aria-live': 'polite' });
      const result = h('div', {});
      const btn = h('button', { class: 'btn btn-primary' }, `Import this file: ${built.patients.length} patients, ${s.invoices} invoices, ${s.payments} payments, ${s.visits} visits`);
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          const p = (t) => { progress.textContent = t; };
          const pt = await runImport('patients', built.patients, p, 'Patients');
          const inv = await runImport('invoices', built.invoices, p, 'Invoices');
          const pay = await runImport('payments_tx', built.payments, p, 'Payments');
          const vis = await runImport('visits', built.visits, p, 'Visits');
          progress.textContent = '';
          mount(result, h('div', { class: 'alert alert-info' },
            h('div', {}, `Patients: ${pt.inserted} added, ${pt.updated} already on the website (empty phone or branch filled in, nothing overwritten).`),
            h('div', {}, `Invoices: ${inv.inserted} added (${inv.given - inv.inserted} already there${inv.missing ? `, ${inv.missing} skipped — patient missing` : ''}).`),
            h('div', {}, `Payments: ${pay.inserted} added (${pay.given - pay.inserted} already there${pay.missing ? `, ${pay.missing} without an invoice` : ''}).`),
            h('div', {}, `Visits: ${vis.inserted} added (${vis.given - vis.inserted} already there). `, h('a', { href: '#/staff/accounts?tab=pnl' }, 'Check the month in Accounts →'))));
          toast('File imported.', 'ok');
        } catch (e) { btn.disabled = false; progress.textContent = ''; toast(friendlyError(e), 'error'); }
      };
      mount(txOut,
        h('div', { class: 'stat-row', style: { margin: '12px 0' } },
          stat(rupees(s.paid), `Received ${s.from} → ${s.to}`), stat(s.invoices, 'Invoices'), stat(s.payments, 'Payments'), stat(s.visits, 'Visits (patient-days)'), stat(built.patients.length, `Patients (${newPatients.length} not on the website yet)`)),
        h('div', { class: 'inline', style: { alignItems: 'flex-start', gap: '24px' } },
          branchTable(s.perBranch),
          h('div', {},
            h('p', { class: 'muted' }, `Columns read: ${columns.join(', ')}.`),
            s.unknownBranch.length ? h('div', { class: 'alert alert-warning' }, `${s.unknownBranch.length} invoices have no branch clue on Healthwire (entered by accounts) — they will be put under Gulshan with a note.`) : null,
            s.otherPeriods.length ? h('div', { class: 'alert alert-info' }, `${s.otherPeriods.length} invoices also have payments outside this file's dates (earlier or later months). Their dues will look right once those months are imported too.`) : null,
            s.zeroRows ? h('p', { class: 'muted' }, `${s.zeroRows} rows carry no payment (invoice only).`) : null)),
        h('div', { style: { marginTop: '12px' } }, btn), progress, result);
    } catch (e) { mount(txOut, h('div', { class: 'alert alert-stop' }, friendlyError(e))); }
  });

  // ------------------------------------------------------------ 2. expenses PDF
  const exOut = h('div', {});
  const exInput = filePicker('.pdf', async (file) => {
    mount(exOut, h('p', { class: 'muted' }, `Reading ${file.name}…`));
    try {
      const pages = await fileToPdfPages(file);
      const read = readExpensesPdf(pages);
      if (!read.rows.length) throw new Error('No expense rows found. Use Healthwire → Expenses → Print (the "Expenses Report.pdf" file).');
      const built = buildExpenses(read.rows);
      const s = built.summary;
      const progress = h('p', { class: 'muted', 'aria-live': 'polite' });
      const result = h('div', {});
      const btn = h('button', { class: 'btn btn-primary' }, `Import ${s.rows} expenses`);
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await d.importHealthwire('categories', built.categories);
          const r = await runImport('expenses', built.expenses, (t) => { progress.textContent = t; }, 'Expenses');
          progress.textContent = '';
          mount(result, h('div', { class: 'alert alert-info' }, `Expenses: ${r.inserted} added (${r.given - r.inserted} already there). `, h('a', { href: '#/staff/accounts?tab=expenses' }, 'Open Accounts → Expenses →')));
          toast('Expenses imported.', 'ok');
        } catch (e) { btn.disabled = false; progress.textContent = ''; toast(friendlyError(e), 'error'); }
      };
      const mismatch = read.printedTotal !== null && Math.abs(read.printedTotal - s.total) > 1;
      mount(exOut,
        h('div', { class: 'stat-row', style: { margin: '12px 0' } },
          stat(rupees(s.total), 'Total expenses in the file'), stat(s.rows, 'Expense entries'), stat(Object.keys(s.perCategory).length, 'Categories'), stat(s.noBranch, 'Without a branch')),
        mismatch ? h('div', { class: 'alert alert-warning' }, `The PDF's own total is ${rupees(read.printedTotal)} but the rows read add up to ${rupees(s.total)} — ${read.dropped} rows could not be read. Check the PDF before importing.`) : null,
        h('div', { class: 'inline', style: { alignItems: 'flex-start', gap: '24px' } },
          branchTable(s.perBranch, 'Expenses'),
          h('table', { class: 'list', style: { maxWidth: '420px' } }, h('thead', {}, h('tr', {}, h('th', {}, 'Category (website name)'), h('th', { class: 'right' }, 'Amount'))),
            h('tbody', {}, Object.entries(s.perCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', { class: 'right' }, rupees(v))))))),
        h('p', { class: 'muted' }, 'Branch is read from the description (e.g. "lhr", "N.N", "Rj"). Home, personal, loan and tax entries are never given a branch.'),
        h('div', { style: { marginTop: '12px' } }, btn), progress, result);
    } catch (e) { mount(exOut, h('div', { class: 'alert alert-stop' }, friendlyError(e))); }
  });

  // ------------------------------------------------------------ 3. patients list (optional)
  const ptOut = h('div', {});
  const ptInput = filePicker('.xlsx,.xls,.csv', async (file) => {
    mount(ptOut, h('p', { class: 'muted' }, `Reading ${file.name}…`));
    try {
      const rows = await fileToRows(file);
      const { patients, columns } = readPatients(rows);
      const known = new Set((await d.patientsByMr(patients.map((p) => p[0]))).map((p) => p.mr_number));
      const fresh = patients.filter((p) => !known.has(p[0])).length;
      const progress = h('p', { class: 'muted', 'aria-live': 'polite' });
      const result = h('div', {});
      const btn = h('button', { class: 'btn btn-primary' }, `Import ${patients.length} patients (${fresh} new)`);
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          const r = await runImport('patients', patients, (t) => { progress.textContent = t; }, 'Patients');
          progress.textContent = '';
          mount(result, h('div', { class: 'alert alert-info' }, `Patients: ${r.inserted} added, ${r.updated} already on the website (empty details filled in, nothing overwritten).`));
          toast('Patients imported.', 'ok');
        } catch (e) { btn.disabled = false; progress.textContent = ''; toast(friendlyError(e), 'error'); }
      };
      mount(ptOut,
        h('div', { class: 'stat-row', style: { margin: '12px 0' } }, stat(patients.length, 'Patients in the file'), stat(fresh, 'Not on the website yet'),
          stat(patients.filter((p) => p[3]).length, 'With a phone number'), stat(patients.filter((p) => p[7]).length, 'With a date of birth')),
        h('p', { class: 'muted' }, `Columns read: ${columns.join(', ')}.`),
        btn, progress, result);
    } catch (e) { mount(ptOut, h('div', { class: 'alert alert-stop' }, friendlyError(e))); }
  });

  // ------------------------------------------------------------ 4. check a month
  const monthInput = h('input', { type: 'month', value: todayISO().slice(0, 7) });
  const checkOut = h('div', {});
  const check = async () => {
    try {
      const rows = await d.branchPnl(monthInput.value);
      const income = rows.reduce((s, r) => s + r.income, 0), expenses = rows.reduce((s, r) => s + r.expenses, 0);
      mount(checkOut, h('div', { class: 'stat-row', style: { marginTop: '12px' } }, stat(rupees(income), 'Income on the website'), stat(rupees(expenses), 'Expenses on the website'), stat(rupees(income - expenses), income - expenses < 0 ? 'Loss' : 'Profit')),
        h('p', { class: 'muted' }, 'Compare with Healthwire → Reports → Financial for the same dates. ', h('a', { href: '#/staff/accounts?tab=pnl' }, 'Branch by branch →')));
    } catch (e) { mount(checkOut, h('div', { class: 'alert alert-stop' }, friendlyError(e))); }
  };
  monthInput.addEventListener('change', check);

  mount(root,
    h('section', { class: 'panel' },
      h('h2', {}, 'How to export from Healthwire'),
      h('ol', { style: { margin: '8px 0 0 18px', lineHeight: 1.6 } },
        h('li', {}, h('strong', {}, 'Payments: '), 'Reports → Financial → set the dates → Email → Excel. The file "Transactions Report.xlsx" arrives in your Gmail.'),
        h('li', {}, h('strong', {}, 'Expenses: '), 'Expenses → set the dates → Print. Save the "Expenses Report.pdf".'),
        h('li', {}, h('strong', {}, 'Patients (optional): '), 'Patients → Excel → emailed to you. Adds gender, date of birth and address; names, phones and branches already come with the payments file.')),
      h('p', { class: 'muted', style: { marginTop: '8px' } }, 'Any date range works — a month to test, or the whole history in one file. Dropping a file twice changes nothing.')),
    h('section', { class: 'panel' }, h('h2', {}, '1. Payments and invoices'), field('Transactions Report (.xlsx)', txInput, 'The Excel attachment from the "Email excel" message in your Gmail — not a PDF.'), txOut),
    h('section', { class: 'panel' }, h('h2', {}, '2. Expenses'), field('Expenses Report (.pdf)', exInput), exOut),
    h('section', { class: 'panel' }, h('h2', {}, '3. Patient details (optional)'), field('Patients list (.xlsx)', ptInput), ptOut),
    h('section', { class: 'panel' }, h('h2', {}, 'Check a month'), field('Month', monthInput), checkOut));
  await check();
}
