// Admin → Import from Healthwire. Dr. Ali exports from Healthwire (emailed
// Excel files and the expenses PDF) and drops the files here; the page reads
// them in the browser, shows what it found, and writes through the
// import_healthwire() function in batches. Running the same file twice adds
// nothing. Nothing from the files leaves the browser except these batches.
import { h, mount, toast, friendlyError, rupees, field, todayISO, select, downloadCSV, shortDate } from '../../ui/dom.js';
import { state, branchName } from '../../state.js';

// The Healthwire and Aaj ki List readers (with the old-sheet helpers they use) are large and only
// needed once a file is dropped, so they load then, not when the page opens.
let hwLib = null;
let aajLib = null;
const healthwire = async () => (hwLib ||= await import('../../lib/healthwire.js'));
const aaj = async () => (aajLib ||= await import('../../lib/aaj.js'));

const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/xlsx.mjs';
const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const PDF_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
const BATCH = 150;

async function fileToRows(file) {
  if (/\.csv$/i.test(file.name)) return (await healthwire()).parseCSV(await file.text());
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

/** Every tab of a workbook (or a CSV as one tab) -> [{ name, rows }]. */
async function fileToTabs(file) {
  if (/\.csv$/i.test(file.name)) return [{ name: file.name.replace(/\.csv$/i, ''), rows: (await healthwire()).parseCSV(await file.text()) }];
  const XLSX = await import(/* @vite-ignore */ XLSX_URL);
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    let maxC = 0, maxR = 0;
    for (const k of Object.keys(ws)) { if (k[0] === '!') continue; const a = XLSX.utils.decode_cell(k); if (a.c > maxC) maxC = a.c; if (a.r > maxR) maxR = a.r; }
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
    return { name, rows: XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }) };
  });
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

const stat = (value, label) => h('div', { class: 'stat' }, h('strong', {}, value), h('span', {}, label));
/** Per-branch totals; only drawn after a file was read, so the Healthwire module is loaded by then. */
const branchTable = (perBranch, label = 'Received') => {
  const { BRANCH_ID, BRANCH_LABEL } = hwLib;
  const codeOf = Object.fromEntries(Object.entries(BRANCH_ID).map(([k, v]) => [v, k]));
  return h('div', { class: 'table-scroll' }, h('table', { class: 'list', style: { maxWidth: '420px' } },
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Branch'), h('th', { scope: 'col', class: 'right' }, label))),
    h('tbody', {}, Object.entries(perBranch).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
      h('tr', {}, h('td', {}, k === 'none' ? h('span', { class: 'muted' }, 'No branch (personal / home / not stated)') : branchName(k) || BRANCH_LABEL[codeOf[k]] || k), h('td', { class: 'right' }, rupees(v)))))));
};

/** Writes rows in batches, reporting progress; returns the summed result. */
async function runImport(kind, rows, progress, label) {
  const total = { given: 0, inserted: 0, updated: 0, items: 0, missing: 0 };
  const parts = (await healthwire()).chunk(rows, BATCH);
  for (let i = 0; i < parts.length; i++) {
    progress(`${label}: ${Math.min((i + 1) * BATCH, rows.length)} of ${rows.length}…`);
    document.dispatchEvent(new Event('app:activity')); // a long import counts as activity (no idle logout half-way)
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
      const { readTransactions, buildFromTransactions } = await healthwire();
      const rows = await fileToRows(file);
      const { tx, columns } = readTransactions(rows);
      const built = buildFromTransactions(tx, { clinicTimings: state.ref.settings?.clinic_timings });
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
      const { readExpensesPdf, buildExpenses } = await healthwire();
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
          h('div', { class: 'table-scroll' }, h('table', { class: 'list', style: { maxWidth: '420px' } }, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Category (website name)'), h('th', { scope: 'col', class: 'right' }, 'Amount'))),
            h('tbody', {}, Object.entries(s.perCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', { class: 'right' }, rupees(v)))))))),
        h('p', { class: 'muted' }, 'Branch is read from the description (e.g. "lhr", "N.N", "Rj"). Home, personal, loan and tax entries are never given a branch.'),
        h('div', { style: { marginTop: '12px' } }, btn), progress, result);
    } catch (e) { mount(exOut, h('div', { class: 'alert alert-stop' }, friendlyError(e))); }
  });

  // ------------------------------------------------------------ 3. patients list (optional)
  const ptOut = h('div', {});
  const ptInput = filePicker('.xlsx,.xls,.csv', async (file) => {
    mount(ptOut, h('p', { class: 'muted' }, `Reading ${file.name}…`));
    try {
      const { readPatients } = await healthwire();
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

  // ------------------------------------------------------------ 4. Aaj ki List history
  const aajOut = h('div', {});
  const aajInput = filePicker('.xlsx,.xls,.csv', async (file) => {
    mount(aajOut, h('p', { class: 'muted' }, `Reading ${file.name}…`));
    try {
      const [{ BRANCH_ID, chunk }, { readTab, buildImport, tabBranch, FIELD_LABELS }] = await Promise.all([healthwire(), aaj()]);
      const sheets = await fileToTabs(file);
      const tabs = sheets.map((t) => ({ name: t.name, rows: t.rows, branchId: BRANCH_ID[tabBranch(t.name)] || null, fixedDate: null, columns: null, read: readTab(t.rows) }))
        .filter((t) => t.read.headerAt >= 0 || t.rows.length > 3);
      if (!tabs.length) throw new Error('No tabs with patient rows found in this file.');
      const cards = h('div', {});
      const summaryBox = h('div', {});
      const progress = h('p', { class: 'muted', 'aria-live': 'polite' });
      const result = h('div', {});
      const createBox = h('input', { type: 'checkbox', checked: true });
      const btn = h('button', { class: 'btn btn-primary' }, 'Import');
      let built = null;

      const rebuild = () => {
        for (const t of tabs) t.read = readTab(t.rows, { fixedDate: t.fixedDate, columns: t.columns });
        built = buildImport(tabs, state.ref.clinicians, state.ref.treatments, todayISO());
        const s = built.summary;
        const people = Object.entries(s.unmatchedPeople).sort((a, b) => b[1] - a[1]);
        btn.textContent = `Import ${s.rows} visits`;
        btn.disabled = !s.rows;
        mount(summaryBox,
          h('div', { class: 'stat-row', style: { margin: '12px 0' } },
            stat(s.rows, s.from ? `Visits ${shortDate(s.from)} → ${shortDate(s.to)}` : 'Visits'), stat(s.days, 'Days'), stat(tabs.filter((t) => t.branchId).length, 'Branch tabs'),
            stat(s.withMr, 'Rows with an Mr#'), stat(s.noId, 'Rows with no Mr# and no phone')),
          s.future ? h('p', { class: 'muted' }, `${s.future} rows are dated today or later: they belong to the live Aaj ki List and are not imported.`) : null,
          s.undated ? h('p', { class: 'muted' }, `${s.undated} rows have no date and are skipped.`) : null,
          people.length ? h('div', { class: 'alert alert-warning' },
            h('div', {}, h('strong', {}, `${people.length} names in the Doctor's Name column are not on the doctor list: `),
              people.slice(0, 30).map(([n, c]) => `${n} (${c})`).join(', '), people.length > 30 ? ', …' : ''),
            h('div', { class: 'muted', style: { marginTop: '4px' } }, 'They are kept in the visit notes. To link them properly, add the spelling as an alias on ', h('a', { href: '#/staff/admin?tab=setup' }, 'Clinic setup → Doctors and assistants'), ' and drop the file again.')) : null,
          h('p', { class: 'muted' }, 'Rows are matched to patients by Mr#, then phone, then a name only one patient has. A visit already on the website for that day (from Healthwire) is completed with the sheet\'s doctors, details, token and braces month; otherwise the visit is added. Patients with braces months but no braces case get one from the history. Dropping the file again adds nothing.'));
      };

      const tabCard = (t) => {
        const r = t.read;
        const branchSel = select([{ value: '', label: 'Skip this tab' }, ...state.ref.branches.map((b) => ({ value: b.id, label: b.name }))], t.branchId || '', { 'aria-label': `Branch for ${t.name}` });
        branchSel.onchange = () => { t.branchId = Number(branchSel.value) || null; rebuild(); };
        const dateIn = h('input', { type: 'date', value: t.fixedDate || '', 'aria-label': `Date for ${t.name}` });
        dateIn.onchange = () => { t.fixedDate = dateIn.value || null; rebuild(); draw(); };
        const cols = r.columns || {};
        const colSelects = r.headers.map((hd, i) => {
          const current = Object.entries(cols).find(([, idx]) => idx === i)?.[0] || 'ignore';
          const sel = select(Object.entries(FIELD_LABELS).map(([value, label]) => ({ value, label })), current, { 'aria-label': `Column ${hd || i + 1}` });
          sel.onchange = () => {
            const next = { ...(t.columns || cols) };
            for (const [f, idx] of Object.entries(next)) if (idx === i) delete next[f];
            if (sel.value !== 'ignore') next[sel.value] = i;
            t.columns = next; rebuild(); draw();
          };
          return h('label', { class: 'inline', style: { gap: '6px' } }, h('span', { class: 'muted', style: { minWidth: '120px' } }, hd || `Column ${i + 1}`), sel);
        });
        const preview = r.rows.slice(0, 5);
        return h('section', { class: 'panel', 'data-tab': t.name },
          h('div', { class: 'panel-head' }, h('h3', {}, t.name), h('div', { class: 'inline' }, h('span', { class: 'muted' }, 'Branch'), branchSel)),
          h('p', { class: 'muted' }, r.headerAt < 0 ? 'No header row found.' : `${r.rows.length} patient rows` + (r.days.length ? ` on ${r.days.length} days (${shortDate(r.days[0])} → ${shortDate(r.days[r.days.length - 1])})` : '') + '.'),
          r.issues.map((i) => h('div', { class: 'alert alert-warning inline' }, i)),
          r.dateMode === 'none' || r.dateMode === 'fixed' ? field('These rows are for', dateIn, 'The tab carries no dates: it is today\'s list, so tell the import which day it is for.') : null,
          r.headers.length ? h('details', { style: { marginTop: '8px' } }, h('summary', {}, 'Columns read'), h('div', { class: 'stack', style: { gap: '4px', marginTop: '6px' } }, colSelects)) : null,
          preview.length ? h('div', { class: 'table-scroll', style: { marginTop: '8px' } }, h('table', { class: 'list' },
            h('thead', {}, h('tr', {}, ['Date', 'Mr#', 'Name', 'Month', 'Treatment', 'Token', "Doctor's name", 'Details'].map((x) => h('th', {}, x)))),
            h('tbody', {}, preview.map((row) => h('tr', {}, h('td', { class: 'nowrap' }, row.date ? shortDate(row.date) : '—'), h('td', {}, row.mr || ''), h('td', {}, row.name), h('td', {}, row.month || ''),
              h('td', {}, row.treatment || ''), h('td', {}, row.token || ''), h('td', {}, row.people.join(', ')), h('td', {}, row.details || '')))))) : null);
      };
      const draw = () => mount(cards, tabs.map(tabCard));

      btn.onclick = async () => {
        btn.disabled = true;
        try {
          const parts = chunk(built.rows, 200);
          const total = { future: 0, patients_created: 0, visits_inserted: 0, visits_updated: 0, staff_added: 0, cases_created: 0, tokens: 0, rows_unmatched: 0, cases: {}, unmatched: {} };
          for (let i = 0; i < parts.length; i++) {
            progress.textContent = `Importing: ${Math.min((i + 1) * 200, built.rows.length)} of ${built.rows.length} visits…`;
            document.dispatchEvent(new Event('app:activity'));
            const r = await d.importAajSheet(parts[i], createBox.checked);
            for (const k of ['future', 'patients_created', 'visits_inserted', 'visits_updated', 'staff_added', 'cases_created', 'tokens', 'rows_unmatched']) total[k] += Number(r?.[k] || 0);
            for (const [k, v] of Object.entries(r?.cases || {})) total.cases[k] = (total.cases[k] || 0) + Number(v);
            for (const u of r?.unmatched || []) { const k = `${u.name}|${u.mr || ''}|${u.phone || ''}`; const cur = total.unmatched[k] || { ...u, rows: 0 }; cur.rows += Number(u.rows || 0); cur.last = u.last > (cur.last || '') ? u.last : cur.last; total.unmatched[k] = cur; }
          }
          progress.textContent = '';
          const un = Object.values(total.unmatched).sort((a, b) => b.rows - a.rows);
          const caseNote = Object.entries(total.cases).map(([k, v]) => `${v} ${k}`).join(', ');
          mount(result, h('div', { class: 'alert alert-info' },
            h('div', {}, `Visits: ${total.visits_inserted} added, ${total.visits_updated} already there and completed from the sheet. Doctors and assistants added to ${total.staff_added} visit slots; ${total.tokens} token numbers.`),
            h('div', {}, `Patients: ${total.patients_created} added from the sheet. Braces cases created from the history: ${total.cases_created}${caseNote ? ` (${caseNote})` : ''}.`),
            un.length ? h('div', { style: { marginTop: '6px' } }, h('strong', {}, `${un.length} names could not be matched to a patient (${total.rows_unmatched} rows). `),
              'Add them from the Patients page or put the Mr# or phone on the sheet, then drop the file again. ',
              h('button', { class: 'btn btn-small', onclick: () => downloadCSV(`aaj-ki-list-unmatched-${todayISO()}.csv`, un.map((u) => ({ name: u.name, mr: u.mr || '', phone: u.phone || '', rows: u.rows, first: u.first, last: u.last, tab: u.tab }))) }, 'Download the list')) : null,
            h('div', { style: { marginTop: '6px' } }, h('a', { href: '#/staff/patients' }, 'Open Patients →'), ' · ', h('a', { href: '#/staff/reports?group=financial' }, 'Reports →'))),
            un.length ? h('div', { class: 'table-scroll', style: { marginTop: '8px' } }, h('table', { class: 'list' },
              h('thead', {}, h('tr', {}, h('th', {}, 'Name on the sheet'), h('th', {}, 'Mr#'), h('th', {}, 'Phone'), h('th', { class: 'right' }, 'Rows'), h('th', {}, 'First'), h('th', {}, 'Last'), h('th', {}, 'Tab'))),
              h('tbody', {}, un.slice(0, 50).map((u) => h('tr', {}, h('td', {}, u.name), h('td', {}, u.mr || ''), h('td', {}, u.phone || ''), h('td', { class: 'right' }, u.rows), h('td', { class: 'nowrap' }, shortDate(u.first)), h('td', { class: 'nowrap' }, shortDate(u.last)), h('td', {}, u.tab || '')))))) : null);
          toast('Aaj ki List imported.', 'ok');
        } catch (e) { btn.disabled = false; progress.textContent = ''; toast(friendlyError(e), 'error', 8000); }
      };

      mount(aajOut, cards, summaryBox,
        h('label', { class: 'inline', style: { margin: '8px 0' } }, createBox, ' Add patient records for names not on the website yet (only rows that carry an Mr# or a phone number)'),
        h('div', { style: { marginTop: '8px' } }, btn), progress, result);
      draw(); rebuild();
    } catch (e) { mount(aajOut, h('div', { class: 'alert alert-stop' }, friendlyError(e))); }
  });

  // ------------------------------------------------------------ 5. check a month
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
        h('li', {}, h('strong', {}, 'Patients (optional): '), 'Patients → Excel → emailed to you. Adds gender, date of birth and address; names, phones and branches already come with the payments file.'),
        h('li', {}, h('strong', {}, 'Aaj ki List: '), 'open the Google Sheet → File → Download → Microsoft Excel (.xlsx). Every branch tab comes in the one file.')),
      h('p', { class: 'muted', style: { marginTop: '8px' } }, 'Any date range works — a month to test, or the whole history in one file. Dropping a file twice changes nothing.')),
    h('section', { class: 'panel' }, h('h2', {}, '1. Payments and invoices'), field('Transactions Report (.xlsx)', txInput, 'The Excel attachment from the "Email excel" message in your Gmail — not a PDF.'), txOut),
    h('section', { class: 'panel' }, h('h2', {}, '2. Expenses'), field('Expenses Report (.pdf)', exInput), exOut),
    h('section', { class: 'panel' }, h('h2', {}, '3. Patient details (optional)'), field('Patients list (.xlsx)', ptInput), ptOut),
    h('section', { class: 'panel' }, h('h2', {}, '4. Aaj ki List history'), field('Aaj ki List (.xlsx, all tabs)', aajInput, 'Doctors, assistants, wires and details, tokens and braces months for every day on the sheet. Payments come from Healthwire, so nothing here changes the money.'), aajOut),
    h('section', { class: 'panel' }, h('h2', {}, 'Check a month'), field('Month', monthInput), checkOut));
  await check();
}
