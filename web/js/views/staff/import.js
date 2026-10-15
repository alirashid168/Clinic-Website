// Admin → Import. Dr. Ali exports from Healthwire (emailed Excel files and the
// expenses PDF), from the Aaj ki List sheet, from the checkup list and from the
// Retainer Record sheet, and drops the files here; the page reads them in the browser, shows what it found, and
// writes through the import functions in batches (a Retainer Record tab in one call: each city is copied once). Running the same file twice
// adds nothing. Nothing from the files leaves the browser except these batches.
import { h, mount, toast, friendlyError, rupees, field, todayISO, select, downloadCSV, shortDate, busy, modal, isLostAnswer } from '../../ui/dom.js';
import { state, branchName } from '../../state.js';
import { loadSheetJS } from '../../lib/sheetjs.js';

// The Healthwire and Aaj ki List readers (with the old-sheet helpers they use) are large and only
// needed once a file is dropped, so they load then, not when the page opens.
let hwLib = null;
let aajLib = null;
let checkupsLib = null;
let formLib = null;
const healthwire = async () => (hwLib ||= await import('../../lib/healthwire.js'));
const aaj = async () => (aajLib ||= await import('../../lib/aaj.js'));
const checkupMapping = async () => (checkupsLib ||= await import('../../lib/checkups.js'));
const checkupForm = async () => (formLib ||= await import('../../lib/checkup-form.js'));

const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const PDF_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
const BATCH = 150;

async function fileToRows(file) {
  if (/\.csv$/i.test(file.name)) return (await healthwire()).parseCSV(await file.text());
  const XLSX = await loadSheetJS();
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
  const XLSX = await loadSheetJS();
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
  // The box is emptied once the file is in hand: choosing the very same file again (to check that nothing doubles, as the page
  // promises) must fire `change` again, and a browser stays silent when the chosen file is the one already in the box.
  const input = h('input', { type: 'file', accept, onchange: () => { const file = input.files[0]; if (!file) return; input.value = ''; onFile(file); } });
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
      const [{ BRANCH_ID, chunk }, { readTab, buildImport, splitCheckupRows, tabBranch, FIELD_LABELS }] = await Promise.all([healthwire(), aaj()]);
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
        built = buildImport(tabs, state.ref.clinicians, state.ref.treatments.filter((t) => !t.price_list), todayISO()); // visit types only, never the price list
        // a row without an Mr# whose Treatment says checkup is a checkup patient: never a visit (owner, 9 Oct 2026). It is not sent at all.
        const split = splitCheckupRows(built.rows);
        built.visitRows = split.visits; built.checkupRows = split.checkups;
        const s = built.summary;
        const nVisits = built.visitRows.length;
        const people = Object.entries(s.unmatchedPeople).sort((a, b) => b[1] - a[1]);
        btn.textContent = `Import ${nVisits} visit${nVisits === 1 ? '' : 's'}`;
        btn.disabled = !nVisits;
        mount(summaryBox,
          h('div', { class: 'stat-row', style: { margin: '12px 0' } },
            stat(nVisits, s.from ? `Visits ${shortDate(s.from)} → ${shortDate(s.to)}` : 'Visits'), stat(s.days, 'Days'), stat(tabs.filter((t) => t.branchId).length, 'Branch tabs'),
            stat(s.withMr, 'Rows with an Mr#'), stat(s.noId, 'Rows with no Mr# and no phone')),
          built.checkupRows.length ? h('div', { class: 'alert alert-info' },
            `${built.checkupRows.length} row${built.checkupRows.length === 1 ? ' has' : 's have'} no Mr# and a Treatment that says checkup: checkup patients, not visits. They are not imported here. To put them on the website's checkup list, use "5. Checkup list" below with the "Checkup karwaliya" file.`) : null,
          s.future ? h('p', { class: 'muted' }, `${s.future} rows are dated today or later: they belong to the live Aaj ki List and are not imported.`) : null,
          s.undated ? h('p', { class: 'muted' }, `${s.undated} rows have no date and are skipped.`) : null,
          people.length ? h('div', { class: 'alert alert-warning' },
            h('div', {}, h('strong', {}, `${people.length} names in the Doctor's Name column are not on the doctor list: `),
              people.slice(0, 30).map(([n, c]) => `${n} (${c})`).join(', '), people.length > 30 ? ', …' : ''),
            h('div', { class: 'muted', style: { marginTop: '4px' } }, 'They are kept in the visit notes. To link them properly, add the spelling as an alias on ', h('a', { href: '#/staff/admin?tab=setup' }, 'Clinic setup → Doctors and assistants'), ' and drop the file again.')) : null,
          h('p', { class: 'muted' }, 'Rows are matched to patients by Mr#, when the name in the row fits that patient without doubt (the same first name, or an everyday spelling of it, and no other surname; Muhammad, Syed or Hafiz count as part of the name). A row whose name only partly matches the patient of its Mr# (another surname, another first name, or only the phone) is never filed on that patient: it is listed afterwards with the reason. A row without an Mr# is matched only by its phone and first name, never by a name alone; a row whose Mr# the website does not have, or whose Mr# belongs to somebody else, is never put on another patient\'s file: those rows are listed afterwards. A visit already on the website for that day (from Healthwire) is completed with the sheet\'s doctors, details, token and braces month; otherwise the visit is added. Patients with braces months but no braces case get one from the history. Dropping the file again adds nothing.'));
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
            h('thead', {}, h('tr', {}, ['Date', 'Mr#', 'Name', 'Month', 'Treatment', 'Token', "Doctor's name", 'Details'].map((x) => h('th', { scope: 'col' }, x)))),
            h('tbody', {}, preview.map((row) => h('tr', {}, h('td', { class: 'nowrap' }, row.date ? shortDate(row.date) : '—'), h('td', {}, row.mr || ''), h('td', {}, row.name), h('td', {}, row.month || ''),
              h('td', {}, row.treatment || ''), h('td', {}, row.token || ''), h('td', {}, row.people.join(', ')), h('td', {}, row.details || '')))))) : null);
      };
      const draw = () => mount(cards, tabs.map(tabCard));

      btn.onclick = async () => {
        btn.disabled = true;
        try {
          const parts = chunk(built.visitRows, 200);
          const total = { future: 0, patients_created: 0, visits_inserted: 0, visits_updated: 0, staff_added: 0, cases_created: 0, tokens: 0, rows_unmatched: 0, checkups_skipped: built.checkupRows.length, cases: {}, unmatched: {} };
          const add = (r) => {
            for (const k of ['future', 'patients_created', 'visits_inserted', 'visits_updated', 'staff_added', 'cases_created', 'tokens', 'rows_unmatched', 'checkups_skipped']) total[k] += Number(r?.[k] || 0);
            for (const [k, v] of Object.entries(r?.cases || {})) total.cases[k] = (total.cases[k] || 0) + Number(v);
            for (const u of r?.unmatched || []) { const k = `${u.name}|${u.mr || ''}|${u.phone || ''}`; const cur = total.unmatched[k] || { ...u, rows: 0 }; cur.rows += Number(u.rows || 0); cur.last = u.last > (cur.last || '') ? u.last : cur.last; total.unmatched[k] = cur; }
          };
          for (let i = 0; i < parts.length; i++) {
            progress.textContent = `Importing: ${Math.min((i + 1) * 200, built.visitRows.length)} of ${built.visitRows.length} visits…`;
            document.dispatchEvent(new Event('app:activity'));
            // A row without an Mr# (an existing patient whose Mr# was forgotten) is matched by its phone and first name to a patient file that
            // already exists, but never gets a new one.
            const withMr = parts[i].filter((row) => row[2]);
            const withoutMr = parts[i].filter((row) => !row[2]);
            if (withMr.length) add(await d.importAajSheet(withMr, createBox.checked));
            if (withoutMr.length) add(await d.importAajSheet(withoutMr, false));
          }
          progress.textContent = '';
          const un = Object.values(total.unmatched).sort((a, b) => b.rows - a.rows);
          const caseNote = Object.entries(total.cases).map(([k, v]) => `${v} ${k}`).join(', ');
          mount(result, h('div', { class: 'alert alert-info' },
            h('div', {}, `Visits: ${total.visits_inserted} added, ${total.visits_updated} already there and completed from the sheet. Doctors and assistants added to ${total.staff_added} visit slots; ${total.tokens} token numbers.`),
            h('div', {}, `Patients: ${total.patients_created} added from the sheet. Braces cases created from the history: ${total.cases_created}${caseNote ? ` (${caseNote})` : ''}.`),
            total.checkups_skipped ? h('div', {}, `Checkup patients not imported as visits: ${total.checkups_skipped} (use "5. Checkup list" for them).`) : null,
            un.length ? h('div', { style: { marginTop: '6px' } }, h('strong', {}, `${un.length} names could not be matched to a patient (${total.rows_unmatched} rows). `),
              'Add them from the Patients page or put the Mr# or phone on the sheet, then drop the file again. ',
              h('button', { class: 'btn btn-small', onclick: () => downloadCSV(`aaj-ki-list-unmatched-${todayISO()}.csv`, un.map((u) => ({ name: u.name, mr: u.mr || '', phone: u.phone || '', rows: u.rows, first: u.first, last: u.last, tab: u.tab, why: u.why || '' }))) }, 'Download the list')) : null,
            h('div', { style: { marginTop: '6px' } }, h('a', { href: '#/staff/patients' }, 'Open Patients →'), ' · ', h('a', { href: '#/staff/reports?group=financial' }, 'Reports →'))),
            un.length ? h('div', { class: 'table-scroll', style: { marginTop: '8px' } }, h('table', { class: 'list' },
              h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Name on the sheet'), h('th', { scope: 'col' }, 'Mr#'), h('th', { scope: 'col' }, 'Phone'), h('th', { scope: 'col', class: 'right' }, 'Rows'), h('th', { scope: 'col' }, 'First'), h('th', { scope: 'col' }, 'Last'), h('th', { scope: 'col' }, 'Tab'), h('th', { scope: 'col' }, 'Why'))),
              h('tbody', {}, un.slice(0, 50).map((u) => h('tr', {}, h('td', {}, u.name), h('td', {}, u.mr || ''), h('td', {}, u.phone || ''), h('td', { class: 'right' }, u.rows), h('td', { class: 'nowrap' }, shortDate(u.first)), h('td', { class: 'nowrap' }, shortDate(u.last)), h('td', {}, u.tab || ''), h('td', {}, u.why || '')))))) : null);
          toast('Aaj ki List imported.', 'ok');
        } catch (e) { btn.disabled = false; progress.textContent = ''; toast(friendlyError(e), 'error', 8000); }
      };

      mount(aajOut, cards, summaryBox,
        h('label', { class: 'inline', style: { margin: '8px 0' } }, createBox, ' Add patient records for rows with a Healthwire Mr# (below 50000) that is not on the website yet, up to 100 above the highest Healthwire Mr# the website has (a higher number is not given by Healthwire yet: probably a typo; import the Healthwire patients first). An Mr# of 50000 or more that the website does not have is a typing mistake and is never added. Rows without an Mr# never get a patient file, and a patient the website already has (the same name and phone under another Mr#, or an old Mr# of that patient) never gets a second one: those rows are listed with the reason.'),
        h('div', { style: { marginTop: '8px' } }, btn), progress, result);
      draw(); rebuild();
    } catch (e) { mount(aajOut, h('div', { class: 'alert alert-stop' }, friendlyError(e))); }
  });

  // ------------------------------------------------------------ 5. checkup list
  // The old "Checkup karwaliya" list: people who came for a checkup (no Mr#), with their follow-up status and notes.
  // A row is matched by phone + name + month, so the same file again adds nothing.
  const number = (n) => Number(n || 0).toLocaleString('en-PK');
  const count = (n, one, many) => `${number(n)} ${n === 1 ? one : many}`;
  const ckOut = h('div', {});
  const ckInput = filePicker('.xlsx,.xls,.csv', async (file) => {
    mount(ckOut, h('p', { class: 'muted' }, `Reading ${file.name}…`));
    try {
      const { findCheckupSheet, readCheckupList, IMPORT_BATCH, CLINIC_BRANCH, monthLabel } = await checkupMapping();
      const tab = findCheckupSheet(await fileToTabs(file));
      if (!tab) throw new Error('No checkup list found in this file: it needs a header row with Patient Name and Phone.');
      const read = readCheckupList(tab.rows);
      if (read.missing?.length) throw new Error(`The checkup list needs a column called ${read.missing.map((x) => `"${x}"`).join(' and ')}. Check the header row.`);
      const s = read.summary;
      const branchOfClinic = (text) => {
        const code = CLINIC_BRANCH[String(text).toLowerCase().replace(/\s+/g, ' ').trim()];
        return state.ref.branches.find((b) => b.code === code)?.name || null;
      };
      const listOf = (obj) => { const e = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]); return e.slice(0, 12).map(([t, n]) => `${t} (${n})`).join(', ') + (e.length > 12 ? ', …' : ''); };
      const unknownClinics = Object.keys(s.unknownClinics || {}).length;
      const unknownStatuses = Object.keys(s.unknownStatuses || {}).length;
      const progress = h('p', { class: 'muted', 'aria-live': 'polite' });
      const result = h('div', {});
      const overwriteBox = h('input', { type: 'checkbox' });
      const btn = h('button', { class: 'btn btn-primary', disabled: !read.rows.length }, `Import ${number(read.rows.length)} checkups`);
      btn.onclick = async () => {
        btn.disabled = true;
        const total = { inserted: 0, updated: 0, unchanged: 0, kept: 0, skipped: 0 };
        let sent = 0;
        try {
          for (let i = 0; i < read.rows.length; i += IMPORT_BATCH) {
            const part = read.rows.slice(i, i + IMPORT_BATCH);
            progress.textContent = `Checkups: ${number(Math.min(i + IMPORT_BATCH, read.rows.length))} of ${number(read.rows.length)}…`;
            document.dispatchEvent(new Event('app:activity')); // a long import counts as activity (no idle logout half-way)
            const r = await d.importCheckups(part, { overwrite: overwriteBox.checked });
            for (const k of ['inserted', 'updated', 'unchanged', 'kept']) total[k] += Number(r?.[k] || 0);
            // skipped_count counts every skipped row; the skipped list shows at most 100 of them.
            total.skipped += Number(r?.skipped_count ?? (Array.isArray(r?.skipped) ? r.skipped.length : r?.skipped) ?? 0);
            sent = i + part.length;
          }
          progress.textContent = '';
          mount(result, h('div', { class: 'alert alert-info' },
            h('div', {}, `Checkup list: ${number(total.inserted)} added, ${number(total.updated)} updated, ${number(total.unchanged)} already there, ${number(total.kept)} kept${total.kept ? " (the website has a different status or notes; tick the box above to use the file's)" : ''}, ${number(read.skipped.length + total.skipped)} skipped.`),
            h('div', { style: { marginTop: '6px' } }, h('a', { href: '#/staff/checkups' }, 'Open the checkup list →'))));
          toast('Checkup list imported.', 'ok');
        } catch (e) {
          btn.disabled = false; progress.textContent = '';
          if (sent) mount(result, h('div', { class: 'alert alert-warning' }, `${number(sent)} of ${number(read.rows.length)} checkups were sent before the error. Import the same file again: rows that are already on the website are not added twice.`));
          toast(friendlyError(e), 'error', 8000);
        }
      };
      mount(ckOut,
        h('div', { class: 'stat-row', style: { margin: '12px 0' } },
          stat(number(s.ready), 'ready to import'),
          stat(s.from ? `${monthLabel(`${s.from}-01`)} to ${monthLabel(`${s.to}-01`)}` : 'No months', 'months in the file'),
          stat(number(s.noMonth), 'without a month'), stat(number(s.withFee), 'with a fee'), stat(number(s.skipped), 'skipped')),
        h('div', { class: 'inline', style: { alignItems: 'flex-start', gap: '24px' } },
          h('div', { class: 'table-scroll' }, h('table', { class: 'list', style: { maxWidth: '520px' } },
            h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Clinic in the file'), h('th', { scope: 'col' }, 'Branch on the website'), h('th', { scope: 'col', class: 'right' }, 'Rows'))),
            h('tbody', {}, Object.entries(s.perClinic || {}).sort((a, b) => b[1] - a[1]).map(([clinic, n]) => {
              const b = branchOfClinic(clinic);
              return h('tr', {}, h('td', {}, clinic), h('td', {}, b || h('span', { class: 'muted' }, 'No branch')), h('td', { class: 'right' }, number(n)));
            })))),
          h('div', { class: 'table-scroll' }, h('table', { class: 'list', style: { maxWidth: '360px' } },
            h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Status'), h('th', { scope: 'col', class: 'right' }, 'Rows'))),
            h('tbody', {}, Object.entries(s.perStatus || {}).sort((a, b) => b[1] - a[1]).map(([status, n]) => h('tr', {}, h('td', {}, status), h('td', { class: 'right' }, number(n)))))))),
        unknownClinics ? h('div', { class: 'alert alert-warning' }, `${count(unknownClinics, 'clinic name is', 'clinic names are')} not one of our branches: ${listOf(s.unknownClinics)}. ${unknownClinics === 1 ? 'Its rows are' : 'Their rows are'} imported without a branch.`) : null,
        unknownStatuses ? h('div', { class: 'alert alert-warning' }, `${count(unknownStatuses, 'status is', 'statuses are')} not in the usual list: ${listOf(s.unknownStatuses)}. ${unknownStatuses === 1 ? 'It is' : 'They are'} kept as written.`) : null,
        s.badMonth ? h('div', { class: 'alert alert-warning' }, `${count(s.badMonth, 'row has', 'rows have')} a month that could not be read. ${s.badMonth === 1 ? 'It is' : 'They are'} imported without a month.`) : null,
        s.cut ? h('div', { class: 'alert alert-warning' }, `${count(s.cut, 'cell is', 'cells are')} longer than the website allows and ${s.cut === 1 ? 'is' : 'are'} cut short.`) : null,
        read.skipped.length ? h('details', { style: { margin: '8px 0' } }, h('summary', {}, `${count(read.skipped.length, 'row is', 'rows are')} skipped`),
          h('div', { class: 'table-scroll' }, h('table', { class: 'list', style: { maxWidth: '520px' } },
            h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Row in the file'), h('th', { scope: 'col' }, 'Why'))),
            h('tbody', {}, read.skipped.slice(0, 20).map((x) => h('tr', {}, h('td', {}, x.row), h('td', {}, x.reason))))),
          read.skipped.length > 20 ? h('p', { class: 'muted' }, `…and ${number(read.skipped.length - 20)} more.`) : null)) : null,
        h('label', { class: 'inline', style: { margin: '8px 0' } }, overwriteBox, " The file is newer than the website: replace follow-up status and notes on the website with the file's"),
        h('div', { style: { marginTop: '8px' } }, btn), progress, result);
    } catch (e) { mount(ckOut, h('div', { class: 'alert alert-stop' }, friendlyError(e))); }
  });

  // ------------------------------------------------------------ 6. the checkup form's old answers
  // The Google Form "Checkup Patient Form 2.0" (Aug to Oct 2026, before the form was on the website). An answer goes onto the checkup of
  // that person on that day, or onto the old list's row of that month, when the website has one; otherwise it becomes a checkup "From the
  // Google Form". The preview asks the database what it would do (it does it and undoes it). The same file again changes nothing.
  const cfOut = h('div', {});
  const cfInput = filePicker('.csv,.xlsx,.xls', async (file) => {
    mount(cfOut, h('p', { class: 'muted' }, `Reading ${file.name}…`));
    try {
      const { findFormHeader, readFormResponses, formBranch, FORM_IMPORT_BATCH } = await checkupForm();
      const tabs = await fileToTabs(file);
      const tab = tabs.find((t) => /form responses/i.test(t.name) && findFormHeader(t.rows) >= 0) || tabs.find((t) => findFormHeader(t.rows) >= 0);
      if (!tab) throw new Error('No answers of the checkup form found in this file: it needs a header row with Timestamp and Patient Full Name. Download the "Form Responses 2" tab.');
      const read = readFormResponses(tab.rows, { clinicians: state.ref.clinicians });
      if (read.missing?.length) throw new Error(`The checkup form's answers need a column called ${read.missing.map((x) => `"${x}"`).join(' and ')}. Check the header row.`);
      const s = read.summary;
      const progress = h('p', { class: 'muted', 'aria-live': 'polite' });
      const result = h('div', {});
      const listOf = (obj) => { const e = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]); return e.slice(0, 12).map(([t, n]) => `${t} (${n})`).join(', ') + (e.length > 12 ? ', …' : ''); };
      const branchNameOf = (text) => state.ref.branches.find((b) => b.code === formBranch(text))?.name || null;

      // Every batch through import_checkup_form; the counts added up. onPart(sentSoFar) before each batch.
      const send = async (dryRun, onPart) => {
        const total = { inserted: 0, filled_day: 0, filled_month: 0, already: 0, same: 0, skipped_count: 0, other_name: 0, other_answers: 0, follow_up_noted: 0, skipped: [] };
        for (let i = 0; i < read.rows.length; i += FORM_IMPORT_BATCH) {
          onPart?.(i);
          document.dispatchEvent(new Event('app:activity'));   // a long import counts as activity (no idle logout half-way)
          const r = await d.importCheckupForm(read.rows.slice(i, i + FORM_IMPORT_BATCH), { dryRun });
          for (const k of ['inserted', 'filled_day', 'filled_month', 'already', 'same', 'skipped_count', 'other_name', 'other_answers', 'follow_up_noted']) total[k] += Number(r?.[k] || 0);
          if (Array.isArray(r?.skipped)) total.skipped.push(...r.skipped);
        }
        return total;
      };
      let plan = null;
      let planError = null;
      if (read.rows.length) {
        mount(cfOut, h('p', { class: 'muted' }, `Checking ${number(read.rows.length)} answers against the website…`));
        try { plan = await send(true); } catch (e) { planError = e; }
      }
      const skippedRows = [...read.skipped, ...(plan?.skipped || [])].sort((a, b) => a.row - b.row);
      const skippedCount = read.skipped.length + Number(plan?.skipped_count || 0);

      const btn = h('button', { class: 'btn btn-primary', disabled: !read.rows.length || !plan }, `Import ${count(read.rows.length, 'answer', 'answers')}`);
      btn.onclick = async () => {
        btn.disabled = true;
        let sent = 0;
        try {
          const done = await send(false, (i) => { sent = i; progress.textContent = `Answers: ${number(Math.min(i + FORM_IMPORT_BATCH, read.rows.length))} of ${number(read.rows.length)}…`; });
          progress.textContent = '';
          mount(result, h('div', { class: 'alert alert-info' },
            h('div', {}, `Checkup Form 2.0: ${number(done.inserted)} added, ${number(done.filled_day + done.filled_month)} put on a checkup already on the list, ${number(done.already)} already imported, ${number(done.same)} already had these answers, ${number(read.skipped.length + done.skipped_count)} skipped.`,
              done.follow_up_noted ? ` ${count(done.follow_up_noted, 'follow-up status from REMINDERS was', 'follow-up statuses from REMINDERS were')} added to the notes instead.` : ''),
            h('div', { style: { marginTop: '6px' } }, h('a', { href: '#/staff/checkups?source=google_form' }, 'Open the checkups from the Google Form →'))));
          toast('Checkup form answers imported.', 'ok');
        } catch (e) {
          btn.disabled = false; progress.textContent = '';
          if (sent) mount(result, h('div', { class: 'alert alert-warning' }, `${number(sent)} of ${number(read.rows.length)} answers were sent before the error. Import the same file again: answers already imported are not added twice.`));
          toast(friendlyError(e), 'error', 8000);
        }
      };

      const reminderLabel = { empty: 'Empty: Not Contacted', other: 'No status (the text is kept in the notes)' };
      mount(cfOut,
        h('div', { class: 'stat-row', style: { margin: '12px 0' } },
          stat(number(s.ready), s.from ? `answers, ${shortDate(s.from)} to ${shortDate(s.to)}` : 'answers'),
          plan ? stat(number(plan.inserted), 'new checkups') : null,
          plan ? stat(number(plan.filled_day + plan.filled_month), 'put on a checkup already on the list') : null,
          plan ? stat(number(plan.already + plan.same), 'already on the website') : null,
          stat(number(skippedCount), 'skipped')),
        planError ? h('div', { class: 'alert alert-stop' }, `The website could not check the file: ${friendlyError(planError)}`) : null,
        plan && (plan.filled_day || plan.filled_month) ? h('p', { class: 'muted' },
          `${count(plan.filled_day, 'answer goes', 'answers go')} onto a checkup of the same person at the same branch on the same day (from the website or the Google Sheet), ${count(plan.filled_month, 'answer goes', 'answers go')} onto the old list's row of that person and month (its follow-up status stays). Only empty answers are filled in; nothing is overwritten. What the form says about the doctor, the checkup or the branch that the checkup already has another text for is added to its notes.`) : null,
        plan && (plan.already || plan.same) ? h('p', { class: 'muted' }, `${count(plan.already, 'answer was', 'answers were')} imported before, and ${count(plan.same, 'checkup already has', 'checkups already have')} the answers: nothing changes for them.`) : null,
        // a second answer of one person that says otherwise (a second visit, or the form sent again with an answer changed): never dropped
        plan?.other_answers ? h('p', { class: 'muted' }, `${count(plan.other_answers, 'answer is', 'answers are')} a second answer of someone whose checkup already holds other answers (a second visit, or the form sent again with an answer changed): ${plan.other_answers === 1 ? 'it becomes a checkup of its own' : 'each becomes a checkup of its own'}, so no answer is lost.`) : null,
        // a follow-up status from REMINDERS that the checkup does not take: in its notes, never lost
        plan?.follow_up_noted ? h('p', { class: 'muted' }, `${count(plan.follow_up_noted, 'answer has', 'answers have')} a follow-up status from REMINDERS that the checkup does not take (it has another status, or it is the old list's row): ${plan.follow_up_noted === 1 ? 'it is' : 'they are'} added to its notes, e.g. "Reminder (Google Form): Follow-up Sent".`) : null,
        // two people on one phone (a parent's phone for two children): each is a checkup of their own, never put on the other's row
        plan?.other_name ? h('p', { class: 'muted' }, `${count(plan.other_name, 'answer has', 'answers have')} the phone of another person on that day's list at that branch, with another name (often a parent's phone for two children): ${plan.other_name === 1 ? 'it becomes a checkup of its own' : 'each becomes a checkup of its own'}, not part of the other person's.`) : null,
        h('div', { class: 'inline', style: { alignItems: 'flex-start', gap: '24px' } },
          h('div', { class: 'table-scroll' }, h('table', { class: 'list', style: { maxWidth: '520px' } },
            h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Branch on the form'), h('th', { scope: 'col' }, 'Branch on the website'), h('th', { scope: 'col', class: 'right' }, 'Answers'))),
            h('tbody', {}, Object.entries(s.perBranchText || {}).sort((a, b) => b[1] - a[1]).map(([text, n]) => {
              const b = text === '(empty)' ? null : branchNameOf(text);
              return h('tr', {}, h('td', {}, text), h('td', {}, b || h('span', { class: 'muted' }, 'No branch')), h('td', { class: 'right' }, number(n)));
            })))),
          h('div', { class: 'table-scroll' }, h('table', { class: 'list', style: { maxWidth: '420px' } },
            h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Follow-up status from REMINDERS'), h('th', { scope: 'col', class: 'right' }, 'Answers'))),
            h('tbody', {}, Object.entries(s.perReminder || {}).sort((a, b) => b[1] - a[1]).map(([kind, n]) => h('tr', {}, h('td', {}, reminderLabel[kind] || kind), h('td', { class: 'right' }, number(n)))))))),
        h('p', { class: 'muted' }, 'What REMINDERS says stays in the notes ("Reminder: ..."), except a plain "done" or a status written as it is. A checkup already on the list takes the status only while it still says Not Contacted; the old list\'s row keeps its own. A plain "done" or a status written as it is that the checkup does not take is added to its notes ("Reminder (Google Form): Follow-up Sent").'),
        s.wrongColumn.length ? h('div', { class: 'alert alert-warning' },
          `${count(s.wrongColumn.length, 'row has', 'rows have')} an answer in the wrong place: ${s.wrongColumn.slice(0, 10).map((w) => `row ${w.row} (${w.questions.join('; ')})`).join(', ')}${s.wrongColumn.length > 10 ? ', …' : ''}. ${s.wrongColumn.length === 1 ? 'It is' : 'They are'} imported with those answers empty; what was written there is kept in the notes.`) : null,
        Object.keys(s.unknownBranches).length ? h('div', { class: 'alert alert-warning' },
          `${count(Object.keys(s.unknownBranches).length, 'branch name is', 'branch names are')} not one of ours: ${listOf(s.unknownBranches)}. Those answers are imported without a branch; the name is kept in the notes.`) : null,
        s.noBranch ? h('p', { class: 'muted' }, `${count(s.noBranch, 'answer has', 'answers have')} no branch and ${s.noBranch === 1 ? 'is' : 'are'} imported without one.`) : null,
        s.badDate ? h('div', { class: 'alert alert-warning' }, `${count(s.badDate, 'row has a date', 'rows have a date')} that could not be read and ${s.badDate === 1 ? 'is' : 'are'} skipped (see below).`) : null,
        Object.keys(s.doctorsNotListed).length ? h('p', { class: 'muted' },
          `${count(Object.keys(s.doctorsNotListed).length, 'name', 'names')} given for "Who did your checkup?" ${Object.keys(s.doctorsNotListed).length === 1 ? 'is' : 'are'} not on the website's doctor list and ${Object.keys(s.doctorsNotListed).length === 1 ? 'is' : 'are'} kept as written: ${listOf(s.doctorsNotListed)}.`) : null,
        s.cut ? h('div', { class: 'alert alert-warning' }, `${count(s.cut, 'cell is', 'cells are')} longer than the website allows and ${s.cut === 1 ? 'is' : 'are'} cut short.`) : null,
        skippedRows.length ? h('details', { style: { margin: '8px 0' } }, h('summary', {}, `${count(skippedCount, 'row is', 'rows are')} skipped`),
          h('div', { class: 'table-scroll' }, h('table', { class: 'list', style: { maxWidth: '640px' } },
            h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Row in the file'), h('th', { scope: 'col' }, 'Why'))),
            h('tbody', {}, skippedRows.slice(0, 20).map((x) => h('tr', {}, h('td', {}, x.row), h('td', {}, x.reason))))),
          skippedCount > 20 ? h('p', { class: 'muted' }, `…and ${number(skippedCount - 20)} more.`) : null)) : null,
        h('div', { style: { marginTop: '8px' } }, btn), progress, result);
    } catch (e) { mount(cfOut, h('div', { class: 'alert alert-stop' }, friendlyError(e))); }
  });

  // ------------------------------------------------------------ 7. Retainer Record (one Google Sheet tab as CSV)
  // Each city's tab is copied ONCE (owner, 12 Oct 2026: "the retainer sheet can be copied, its complete"); after the copy the website is
  // the Retainer Record. The tab is read in the browser (lib/retainers-import.js: columns by heading, the Karachi tab's Mr# and name by
  // position, hand-typed dates), shown, checked by a dry run of the copy, then sent whole in one call (public.import_retainer_records), so a
  // copy is all in or not at all. A second copy of a city is refused in plain words; "Undo the copy for <city>" takes back the copied rows
  // nobody changed on the website, so a corrected tab can be copied. The city is taken from the file's name ("Retainer Record -
  // Lahore.csv") or its columns, and a city that disagrees stops the copy. Rows with an Mr# are checked against the patient files first
  // (public.retainer_mr_check: linked only when the name fits).
  const rtOut = h('div', {});
  const rtCopiesOut = h('div', { 'aria-live': 'polite' });
  const rtCities = state.ref.cities.filter((c) => state.ref.branches.some((b) => b.city_id === c.id));
  const rtCity = select(rtCities.map((c) => ({ value: c.id, label: c.name })), rtCities[0]?.id ?? '');
  let rtFile = null;
  let rtYear = null;          // "Year of the first row", once Dr. Ali changed it
  let rtCityByHand = false;   // the city was chosen by hand after the file was dropped (it is then never changed for him)
  let rtSeq = 0;              // (a reading that a newer one overtook draws nothing)
  let rtCopies = [];          // the cities with a copy (public.retainer_copies)
  // "Undo the copy for <city>": asks first, with the numbers the undo would give (a dry run), then takes the untouched rows back.
  const undoCopy = (cityId, cityLabel) => busy(async () => {
    const q = await d.undoRetainerCopy(cityId, { dryRun: true });
    modal(`Undo the copy for ${cityLabel}?`, h('div', {},
      h('p', {}, `${count(q.removed, 'copied retainer', 'copied retainers')} that nobody changed on the website will be taken off the ${cityLabel} tab of the Retainer Record.`),
      q.stayed ? h('p', {}, `${count(q.stayed, 'retainer was', 'retainers were')} changed on the website (edited, linked to a patient file, a payment set …): ${q.stayed === 1 ? 'it stays' : 'they stay'}, and a new copy leaves out ${q.stayed === 1 ? 'its row' : 'their rows'} of the sheet.`) : null,
      h('p', {}, 'Then the corrected tab can be copied. The removed rows cannot be brought back, except by copying the tab again.')), [
      { label: 'Keep the copy' },
      { label: `Undo the copy for ${cityLabel}`, danger: true, onClick: async () => {
        try {
          const r = await d.undoRetainerCopy(cityId);
          toast(`The copy for ${r.city} is undone: ${count(r.removed, 'retainer', 'retainers')} taken off.${r.stayed ? ` ${count(r.stayed, 'retainer stayed because it was', 'retainers stayed because they were')} changed on the website.` : ''}`, 'ok', 9000);
          await rtLoadCopies();
          if (rtFile) rtRead();
        } catch (e) { toast(friendlyError(e), 'error', 9000); return false; }
      } },
    ], { destructive: true });
  });
  // Which cities are copied, each with its "Undo the copy" button.
  const rtLoadCopies = async () => {
    try { rtCopies = await d.retainerCopies(); } catch (e) {
      if (e?.code === 'RECORDS_MISSING') { mount(rtCopiesOut, h('p', { class: 'muted' }, 'The Retainer Record is not switched on yet: the copy can be made once the database update has been run.')); return; }
      mount(rtCopiesOut, h('div', { class: 'alert alert-warning' }, `Which cities are copied could not be checked (${friendlyError(e)}).`)); return;
    }
    const copied = rtCopies.filter((c) => c.retainers > 0);
    const keptOnly = rtCopies.filter((c) => !c.retainers && c.kept);
    mount(rtCopiesOut,
      copied.length ? h('ul', { class: 'rt-copies' }, copied.map((c) => h('li', {},
        h('span', {}, h('strong', {}, c.city), `: copied on ${shortDate(c.copied_on)}, ${count(c.retainers, 'retainer', 'retainers')}`,
          c.changed ? ` (${number(c.changed)} changed on the website since)` : '', '.'),
        h('button', { type: 'button', class: 'btn btn-small btn-danger', onclick: undoCopy(c.city_id, c.city) }, `Undo the copy for ${c.city}`)))) : h('p', { class: 'muted' }, 'No city is copied yet.'),
      keptOnly.map((c) => h('p', { class: 'muted' }, `${c.city}: the copy was undone; ${count(c.kept, 'row that was changed on the website stays', 'rows that were changed on the website stay')}. The corrected tab can be copied.`)));
  };
  const rtRead = async () => {
    const mine = ++rtSeq;
    const file = rtFile;
    if (!file) return;
    mount(rtOut, h('p', { class: 'muted' }, `Reading ${file.name}…`));
    try {
      const [{ readRetainerTab, tabCityHint, RETAINER_COPY_MAX, FIELD_LABELS }, { retainerStatuses, monthName, colourClass }] = await Promise.all([import('../../lib/retainers-import.js'), import('../../lib/records.js')]);
      const tabs = await fileToTabs(file);
      const cityOf = () => rtCities.find((c) => String(c.id) === rtCity.value)?.name || '';
      // An Excel file: the tab named after the city, else the first tab. A CSV is one tab.
      const readTab = () => {
        const t = tabs.find((x) => x.name.trim().toLowerCase() === cityOf().toLowerCase()) || tabs[0];
        return { tab: t, read: readRetainerTab(t.rows, { statuses: retainerStatuses(state.ref.settings), startYear: rtYear, today: todayISO() }) };
      };
      // The city of the file: from its name, else from its columns; chosen for Dr. Ali unless he chose one himself.
      const fileHint = tabCityHint({ name: file.name }, rtCities);
      let chosenFor = null;
      if (!rtCityByHand && fileHint && String(fileHint.cityId) !== rtCity.value) { rtCity.value = String(fileHint.cityId); chosenFor = fileHint; }
      let { tab, read } = readTab();
      if (read.missing?.length) throw new Error(`No Retainer Record found in ${tab.name}: it needs a header row with ${read.missing.map((x) => `"${x}"`).join(' and ')}.`);
      const shapeHint = tabCityHint({ columns: read.columns }, rtCities);
      if (!rtCityByHand && !fileHint && shapeHint && String(shapeHint.cityId) !== rtCity.value) { rtCity.value = String(shapeHint.cityId); chosenFor = shapeHint; ({ tab, read } = readTab()); }
      const hint = fileHint || (tabs.length > 1 ? tabCityHint({ name: tab.name }, rtCities) : null) || shapeHint;
      const cityId = Number(rtCity.value);
      const cityName = cityOf();
      const clash = hint && String(hint.cityId) !== rtCity.value ? hint : null;
      const tooMany = read.rows.length > RETAINER_COPY_MAX;
      let team = [];
      try { team = await d.retainerTeam(); } catch (e) { if (e?.code === 'RECORDS_MISSING') throw e; }
      const known = new Set(team.map((m) => m.name.toLowerCase()));
      const fresh = [...new Set([...Object.keys(read.summary.models), ...Object.keys(read.summary.makers)])].filter((n) => !known.has(n.toLowerCase())).sort();
      const s = read.summary;
      // Which rows the copy will link to their patient file by Mr# (the database's own rule; nothing is written).
      const withMr = read.rows.filter((r) => r.mr).map((r) => ({ row: r.row, mr: r.mr, name: r.name }));
      let mrCheck = null;
      if (withMr.length && !clash && !tooMany) { try { mrCheck = await d.retainerMrCheck(withMr); } catch (e) { if (e?.code === 'RECORDS_MISSING') throw e; mrCheck = { error: friendlyError(e) }; } }
      const label = (fld) => FIELD_LABELS[fld] || fld;
      const fmt = (iso) => (iso ? shortDate(iso) : '');
      const firstYear = Number((read.rows.find((r) => r.impression_date)?.impression_date || '').slice(0, 4)) || new Date().getFullYear();
      const yearBox = h('input', { type: 'number', min: '2020', max: '2035', value: rtYear || firstYear, style: { maxWidth: '8rem' } });
      yearBox.addEventListener('change', () => { const y = Number(yearBox.value); if (y >= 2020 && y <= 2035) { rtYear = y; rtRead(); } });
      const progress = h('p', { class: 'muted', 'aria-live': 'polite' });
      const result = h('div', {});
      const btn = h('button', { class: 'btn btn-primary', disabled: true }, `Copy ${number(read.rows.length)} retainers into ${cityName}`);
      const chip = (c) => h('span', { class: ['pill', colourClass(c.colour)] }, c.name);
      const colourLine = (list) => (list?.length ? h('div', { class: 'rt-colours' }, 'Colours: ', list.map((c) => [chip(c), c.top ? ' (one of the most active)' : '', ' '])) : null);
      // ---- the dry run: what the copy would do now
      const dryOut = h('div', { 'aria-live': 'polite' });
      let checking = false;
      let refused = false;
      const canCopy = () => !!read.rows.length && !clash && !tooMany && !checking && !refused;
      const refreshBtn = () => { btn.disabled = !canCopy(); };
      const dryRun = async () => {
        if (clash || tooMany || !read.rows.length) { mount(dryOut); refreshBtn(); return; }
        checking = true; refreshBtn();
        mount(dryOut, h('p', { class: 'muted' }, 'Checking what the copy would do…'));
        try {
          const t = await d.importRetainerRecords(cityId, read.rows, { dryRun: true });
          refused = false;
          mount(dryOut,
            h('p', { class: 'import-check' }, h('strong', {}, 'If you copy now: '), `${count(t.inserted, 'retainer', 'retainers')} added to the ${cityName} tab`,
              t.skipped_count ? `, ${count(t.skipped_count, 'row', 'rows')} of the file left out` : '', '.'),
            t.kept ? h('div', { class: 'alert alert-info' }, `${count(t.kept, 'row of the sheet is', 'rows of the sheet are')} left out: ${t.kept === 1 ? 'its row' : 'their rows'} stayed on the website when the earlier copy was undone (changed on the website).`) : null,
            t.kept_other?.length ? h('details', { style: { margin: '8px 0' } }, h('summary', {}, `${count(t.kept_other.length, 'row that stayed from the earlier copy finds', 'rows that stayed from the earlier copy find')} no sheet row of the same name: ${t.kept_other.length === 1 ? 'it stays' : 'they stay'} on the website, check ${t.kept_other.length === 1 ? 'it' : 'them'} on the Retainer Record`),
              dateTable(t.kept_other, [['Row in the earlier copy', (x) => x.row], ['On that row now', (x) => x.name || 'Nobody'], ['Kept on the website', (x) => x.kept_name]])) : null,
            t.kept_date_differs?.length ? h('details', { style: { margin: '8px 0' } }, h('summary', {}, `${count(t.kept_date_differs.length, 'row that stayed from the earlier copy has', 'rows that stayed from the earlier copy have')} another impression date on the sheet now: the website keeps ${t.kept_date_differs.length === 1 ? 'its own date' : 'their own dates'}, change ${t.kept_date_differs.length === 1 ? 'it' : 'them'} on the Retainer Record if the sheet is right`),
              dateTable(t.kept_date_differs, [['Sheet row', (x) => x.row], ['Name', (x) => x.name], ['On the website', (x) => fmt(x.kept_date) || 'No date'], ['On the sheet', (x) => fmt(x.sheet_date)]])) : null,
            colourLine(t.team_colours),
            t.team_featured?.length ? h('p', {}, `In the Retainer Lab banner: ${t.team_featured.join(', ')}.`) : null);
        } catch (e) {
          if (e?.code === 'RECORDS_MISSING') throw e;
          refused = /ALREADY_COPIED/.test(e?.message || '');
          mount(dryOut, refused
            ? h('div', { class: 'alert alert-stop', role: 'alert' }, h('div', {}, friendlyError(e)),
              h('div', { class: 'inline', style: { marginTop: '6px' } }, h('a', { href: `#/staff/retainers?city=${cityId}` }, `Open the ${cityName} tab of the Retainer Record →`), ' ',
                h('button', { type: 'button', class: 'btn btn-small btn-danger', onclick: undoCopy(cityId, cityName) }, `Undo the copy for ${cityName}`)))
            : h('div', { class: 'alert alert-warning' }, `The check before copying could not run (${friendlyError(e)}).`));
        } finally { checking = false; refreshBtn(); }
      };
      btn.onclick = async () => {
        if (!canCopy()) return;
        btn.disabled = true;
        progress.textContent = `Copying ${count(read.rows.length, 'retainer', 'retainers')} into ${cityName}…`;
        document.dispatchEvent(new Event('app:activity')); // a long copy counts as activity (no idle logout half-way)
        try {
          const t = await d.importRetainerRecords(cityId, read.rows);
          progress.textContent = '';
          refused = true; // (copied now: the button stays off)
          mount(dryOut);
          mount(result, h('div', { class: 'alert alert-info' },
            h('div', {}, `${cityName}: ${count(t.inserted, 'retainer', 'retainers')} copied${read.skipped.length + t.skipped_count ? `, ${number(read.skipped.length + t.skipped_count)} rows of the file left out` : ''}. The website is the Retainer Record of ${cityName} from now on.`),
            t.team_added.length ? h('div', {}, `Added to the retainer team: ${t.team_added.join(', ')}.`) : null,
            colourLine(t.team_colours),
            t.mr_given ? h('div', {}, `Mr#: ${count(t.linked, 'row', 'rows')} linked to the patient file, ${number(t.not_linked)} with an Mr# not linked (the Mr# is kept on the row).`) : null,
            t.team_featured.length ? h('div', {}, `In the Retainer Lab banner now: ${t.team_featured.join(', ')}. Change who is there, and the colours, in Clinic setup → Retainer team.`) : null,
            h('div', { style: { marginTop: '6px' } }, h('a', { href: `#/staff/retainers?city=${cityId}` }, 'Open the Retainer Record →'))));
          toast(`${cityName} is copied.`, 'ok');
        } catch (e) {
          progress.textContent = '';
          refreshBtn();
          toast(isLostAnswer(e)
            ? `The server did not answer, so the copy may or may not have gone in. Reload the page: if ${cityName} shows as copied, it is in; if not, copy again.`
            : friendlyError(e), 'error', 12000);
        }
        await rtLoadCopies();
      };
      const dateTable = (list, cols) => h('div', { class: 'table-scroll' }, h('table', { class: 'list', style: { maxWidth: '560px' } },
        h('thead', {}, h('tr', {}, cols.map(([t]) => h('th', { scope: 'col' }, t)))),
        h('tbody', {}, list.slice(0, 30).map((x) => h('tr', {}, cols.map(([, get]) => h('td', {}, get(x))))))));
      const why = { name_differs: 'the name does not fit that patient file', not_found: 'no patient file has this Mr#', not_an_mr: 'not an Mr#' };
      if (mine !== rtSeq) return;
      mount(rtOut,
        h('p', { class: 'muted' }, `Tab: ${tab.name}. Columns found: ${Object.entries(read.columns).sort((a, b) => a[1] - b[1]).map(([k]) => label(k)).join(', ')}.`),
        chosenFor ? h('p', { class: 'muted' }, `City: ${chosenFor.city}, because ${chosenFor.why}. Change it above if that is wrong.`) : null,
        clash ? h('div', { class: 'alert alert-stop', role: 'alert' },
          `This file looks like the ${clash.city} tab (${clash.why}), but the city chosen is ${cityName}. Choose ${clash.city} above. If it really is the ${cityName} tab, rename the file so its name ends in "- ${cityName}" and drop it again.`) : null,
        tooMany ? h('div', { class: 'alert alert-stop', role: 'alert' }, `This tab has ${number(read.rows.length)} rows: a copy takes at most ${number(RETAINER_COPY_MAX)}. Check that it is one tab of the Retainer Record.`) : null,
        read.byPosition ? h('div', { class: 'alert alert-info' }, 'The first two columns of this tab have no headings: column A is read as the Mr# and column B as the patient name.') : null,
        h('div', { class: 'stat-row', style: { margin: '12px 0' } },
          stat(number(s.ready), 'ready to copy'),
          stat(s.from ? `${monthName(s.from)} to ${monthName(s.to)}` : 'No dates', 'months on the tab'),
          stat(number(read.unreadable.length), 'dates that could not be read'),
          stat(number(read.guessed.length), 'dates read from the rows around them'),
          stat(number(fresh.length), 'new team names'),
          s.mr.given ? stat(mrCheck && !mrCheck.error ? `${number(mrCheck.linked)} of ${number(s.mr.given)}` : number(s.mr.given), mrCheck && !mrCheck.error ? 'Mr# that link to their patient file' : 'rows with an Mr#') : null),
        mrCheck?.error ? h('div', { class: 'alert alert-warning' }, `The Mr# could not be checked against the patient files (${mrCheck.error}). The copy still links a row only when the Mr# and the name fit.`) : null,
        mrCheck && !mrCheck.error && mrCheck.given > mrCheck.linked ? h('details', { style: { margin: '8px 0' } },
          h('summary', {}, `${count(mrCheck.given - mrCheck.linked, 'row with an Mr# stays', 'rows with an Mr# stay')} unlinked: ${['name_differs', 'not_found', 'not_an_mr'].filter((k) => mrCheck[k]).map((k) => `${number(mrCheck[k])} ${why[k]}`).join(', ')}. The Mr# is kept on the row.`),
          dateTable(mrCheck.rows.filter((x) => x.outcome !== 'linked').map((x) => ({ ...x, mr: withMr.find((w) => w.row === x.row)?.mr })), [['Row', (x) => x.row], ['Mr#', (x) => x.mr], ['Why', (x) => why[x.outcome] || x.outcome]])) : null,
        fresh.length ? h('div', { class: 'alert alert-info' }, `These names are not on the retainer team yet and will be added: ${fresh.join(', ')}. The most active makers get the strongest colours; change any colour in Clinic setup → Retainer team.`) : null,
        Object.keys(s.unknownStatuses).length ? h('div', { class: 'alert alert-warning' }, `Statuses not in the Status list, kept as written: ${Object.entries(s.unknownStatuses).map(([t, n]) => `${t} (${n})`).join(', ')}.`) : null,
        read.statusNotes.length ? h('details', { style: { margin: '8px 0' } }, h('summary', {}, `${count(read.statusNotes.length, 'Status cell reads', 'Status cells read')} like a note, not a status: copied with no status and the text in Notes`),
          dateTable(read.statusNotes, [['Row', (x) => x.row], ['Typed in Status', (x) => x.text]])) : null,
        read.unreadable.length ? h('details', { style: { margin: '8px 0' }, open: true }, h('summary', {}, `${count(read.unreadable.length, 'date', 'dates')} could not be read: the typed text is kept and shown on the row`),
          dateTable(read.unreadable, [['Row', (x) => x.row], ['Column', (x) => label(x.field)], ['Typed', (x) => x.text]])) : null,
        read.guessed.length ? h('details', { style: { margin: '8px 0' } }, h('summary', {}, `${count(read.guessed.length, 'date was', 'dates were')} read from the rows around them (no year, a slip in the year, or day and month both 12 or less): check a few`),
          dateTable(read.guessed, [['Row', (x) => x.row], ['Column', (x) => label(x.field)], ['Typed', (x) => x.text], ['Read as', (x) => fmt(x.iso)]])) : null,
        read.future.length ? h('div', { class: 'alert alert-warning' }, `${count(read.future.length, 'date is', 'dates are')} after today: ${read.future.slice(0, 10).map((x) => `row ${x.row} (${fmt(x.iso)})`).join(', ')}. Check them on the sheet.`) : null,
        read.far.length ? h('div', { class: 'alert alert-warning' }, `${count(read.far.length, 'date is', 'dates are')} more than half a year away from the rows around them (a slip in the year?): ${read.far.slice(0, 10).map((x) => `row ${x.row} (${fmt(x.iso)})`).join(', ')}${read.far.length > 10 ? ' …' : ''}. They are copied as read; check them on the sheet.`) : null,
        read.skipped.length ? h('details', { style: { margin: '8px 0' } }, h('summary', {}, `${count(read.skipped.length, 'row is', 'rows are')} skipped`),
          dateTable(read.skipped, [['Row', (x) => x.row], ['Why', (x) => x.reason]])) : null,
        field('Year of the first row', yearBox, 'For dates written without a year (Lahore: "20- November"). Change it only if the dates above came out in the wrong year.'),
        dryOut,
        h('div', { style: { marginTop: '8px' } }, btn), progress, result);
      await dryRun();
    } catch (e) { if (mine === rtSeq) mount(rtOut, h('div', { class: 'alert alert-stop' }, friendlyError(e))); }
  };
  const rtInput = filePicker('.csv,.xlsx,.xls', (file) => { rtFile = file; rtYear = null; rtCityByHand = false; rtRead(); });
  rtCity.addEventListener('change', () => { rtCityByHand = true; rtRead(); });

  // ------------------------------------------------------------ check a month
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
        h('li', {}, h('strong', {}, 'Aaj ki List: '), 'open the Google Sheet → File → Download → Microsoft Excel (.xlsx). Every branch tab comes in the one file.'),
        h('li', {}, h('strong', {}, 'Checkup list: '), 'the Excel file with the columns Month, Patient Name, Phone, City, Clinic, Doctor, Treatment / Checkup For, Est. Fee (Rs), Status, Notes, Source Tab.'),
        h('li', {}, h('strong', {}, 'Checkup Form 2.0 answers: '), 'open "Checkup karwaliya", go to the "Form Responses 2" tab → File → Download → Comma-separated values (.csv). Only that tab is downloaded.')),
      h('p', { class: 'muted', style: { marginTop: '8px' } }, 'Any date range works — a month to test, or the whole history in one file. Dropping a file twice changes nothing.')),
    h('section', { class: 'panel' }, h('h2', {}, '1. Payments and invoices'), field('Transactions Report (.xlsx)', txInput, 'The Excel attachment from the "Email excel" message in your Gmail — not a PDF.'), txOut),
    h('section', { class: 'panel' }, h('h2', {}, '2. Expenses'), field('Expenses Report (.pdf)', exInput), exOut),
    h('section', { class: 'panel' }, h('h2', {}, '3. Patient details (optional)'), field('Patients list (.xlsx)', ptInput), ptOut),
    h('section', { class: 'panel' }, h('h2', {}, '4. Aaj ki List history'), field('Aaj ki List (.xlsx, all tabs)', aajInput, 'Doctors, assistants, wires and details, tokens and braces months for every day on the sheet. Payments come from Healthwire, so nothing here changes the money.'), aajOut),
    h('section', { class: 'panel' }, h('h2', {}, '5. Checkup list'), field('Checkup list (.xlsx or .csv)', ckInput, 'Rows already on the website are not added again.'), ckOut),
    h('section', { class: 'panel' }, h('h2', {}, '6. Checkup Form 2.0 answers'),
      field('Checkup Form 2.0 answers (CSV downloaded from the Form Responses tab)', cfInput,
        'The answers given on the Google Form "Checkup Patient Form 2.0" before the form was on the website. You see what will happen before anything is imported; answers already on the website are not added again.'), cfOut),
    h('section', { class: 'panel' }, h('h2', {}, '7. Retainer Record (Google Sheet tab as CSV)'),
      h('p', { class: 'muted' }, 'Each city\'s tab is copied once. After the copy the website is the Retainer Record: add and change retainers there, not on the sheet. Open the Retainer Record sheet, choose the tab (Karachi or Lahore), then File → Download → Comma-separated values (.csv), and drop it here; the city is chosen from the file\'s name. Before you copy, the page shows what the copy would do.'),
      rtCopiesOut,
      h('div', { class: 'form-grid' }, field('City of this tab', rtCity), field('Retainer Record tab (.csv)', rtInput)), rtOut),
    h('section', { class: 'panel' }, h('h2', {}, 'Check a month'), field('Month', monthInput), checkOut));
  await Promise.all([check(), rtLoadCopies()]);
}
