// Invoices: printable templates, new invoice form, payment form.
import { h, mount, rupees, shortDate, modal, field, select, toast, friendlyError, isLostAnswer, showFormErrors, clearFieldErrors, localISO, addMonthsISO, addDaysISO, capFirst, announce } from '../../ui/dom.js';
import { state, branchName, can, myBranches, defaultBranchId } from '../../state.js';
import { CONFIG } from '../../config.js';

// Accents come from the CSS tokens so a brand colour change is made in one place.
export const TEMPLATES = {
  classic: { name: 'Classic', accent: 'var(--aubergine)' },
  minimal: { name: 'Minimal', accent: 'var(--ink)' },
  premium: { name: 'Premium', accent: 'var(--champagne)' },
  thermal: { name: 'Thermal receipt (80mm)', accent: '#000000' },
};

/** The Karachi calendar day of a timestamp (a payment at 1 AM PKT belongs to that day, not the UTC day before). */
const dayOf = (ts) => (ts ? localISO(new Date(ts)) : '');

// A save is one request. When the connection drops, it times out or a gateway gives up, the request may still have
// been committed: it is the answer that was lost. isLostAnswer() in dom.js is the one test for that (it is also what
// the Aaj ki List uses), so there is no list of patterns to keep in step here.
const isMismatch = (e) => e?.code === 'IDEMPOTENCY_MISMATCH' || /IDEMPOTENCY_MISMATCH/.test(e?.message || '');

/**
 * What to tell staff when saving an invoice or a plan fails (`what` is "invoices" or "plans"). { stuck: true } means
 * this form's key is used up: the earlier attempt saved something different, and Save would keep refusing.
 */
function saveFailure(e, what) {
  if (isMismatch(e)) {
    const said = friendlyError(e);
    return { stuck: true, text: `${said.charAt(0).toUpperCase()}${said.slice(1)} Close this form, check the patient record, then start again.` };
  }
  if (isLostAnswer(e)) return { text: `${navigator.onLine ? 'The server did not answer.' : 'No internet connection.'} This may or may not have been saved. Check the patient's ${what} before saving again.` };
  return { text: friendlyError(e) };
}

/**
 * Runs the caller's refresh after a save and waits for it, so the dialog closes onto the redrawn page. The save has
 * happened, so a refresh that fails must not leave the form open to be saved a second time.
 */
async function afterSave(onDone, ...args) {
  try { await onDone?.(...args); } catch (err) { console.error(err); toast('Saved, but the page could not refresh itself. Reload it to see the latest.', 'error'); }
}

/**
 * Prints one sheet. body.printing tells the print stylesheet to print only the
 * .print-area; the class comes off again after the print dialog closes.
 */
export function printSheet(el) {
  if (!el) return;
  const added = !el.classList.contains('print-area');
  el.classList.add('print-area');
  document.body.classList.add('printing');
  window.addEventListener('afterprint', () => {
    document.body.classList.remove('printing');
    if (added) el.classList.remove('print-area');
  }, { once: true });
  window.print();
}

// Payment methods as the form offers them (payments.method). "Online" is a bank transfer or a mobile wallet sent to the clinic's account.
const PAY_METHODS = [
  { value: 'cash', label: 'Cash' }, { value: 'card', label: 'Card' }, { value: 'bank_transfer', label: 'Online (bank transfer)' },
  { value: 'cheque', label: 'Cheque' }, { value: 'other', label: 'Other' },
];
const METHOD_WORDS = { cash: 'Cash', card: 'Card', bank_transfer: 'Online', cheque: 'Cheque', other: 'Other' };

/**
 * The patient as the printed bill needs them (phone, gender, date of birth). A row of the Aaj ki List carries only a few of the
 * patient's details, so the rest are read once with the patient search (by Mr#). Never fails: without an answer the bill leaves out
 * what is not known.
 */
async function billPatient(p) {
  if (!p || ('gender' in p && 'date_of_birth' in p && 'phone' in p)) return p;
  try {
    const found = (await state.data.searchPatients(String(p.mr_number || p.full_name || ''))).find((x) => x.id === p.id);
    return found ? { ...found, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== null && v !== undefined)) } : p;
  } catch { return p; }
}


// ---- The printed bill (A4), laid out like the bill the clinic gave on Healthwire (owner, 15 Oct 2026: "this is the patient bill invoice
// that we give him at the end of treatment"): the clinic's name centred at the top, a rule, the patient on the left and the date and
// invoice number on the right, a rule, the boxed lines, then the totals on the right with the payment mode on their left.
const billNumber = (n) => Number(n || 0).toLocaleString('en-PK', { maximumFractionDigits: 2 });
const billRupees = (n) => `Rs. ${Math.round(Number(n) || 0).toLocaleString('en-PK')}`;

/** "15/10/2026 - 05:02 PM", Karachi time, from when the invoice was made; only the date when the time is not known. */
function billDate(inv) {
  if (inv.created_at) {
    const parts = {};
    for (const p of new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
      .formatToParts(new Date(inv.created_at))) parts[p.type] = p.value;
    return `${parts.day}/${parts.month}/${parts.year} - ${parts.hour}:${parts.minute} ${String(parts.dayPeriod || '').toUpperCase()}`;
  }
  const [y, m, d] = String(inv.issue_date || '').split('-');
  return y && m && d ? `${d}/${m}/${y}` : '';
}

/** Whole years from a date of birth to today (Karachi), or null when it is not known. */
function ageOn(dob, today = localISO()) {
  const [y, m, d] = String(dob || '').slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  const [ty, tm, td] = today.split('-').map(Number);
  const age = ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
  return age >= 0 && age < 130 ? age : null;
}

function billSheet(inv, patient, t, payments) {
  const branch = state.ref.branches.find((b) => b.id === inv.branch_id);
  const items = inv.items || [];
  const total = Number(inv.total ?? inv.subtotal - inv.discount_amount);
  const mine = (payments || []).filter((p) => p.invoice_id === inv.id);
  const paid = mine.reduce((s, p) => s + Number(p.amount), 0);
  const modes = [...new Set(mine.filter((p) => Number(p.amount) > 0).map((p) => METHOD_WORDS[p.method] || p.method))];
  const age = ageOn(patient?.date_of_birth);
  const ageGender = [age === null ? '' : `${age} Y`, patient?.gender ? capFirst(patient.gender) : ''].filter(Boolean).join(' / ');
  const line = (label, value) => (value || value === 0 ? h('div', { class: 'bill-field' }, h('strong', {}, `${label}: `), String(value)) : null);
  const sum = (label, value, grand = false) => h('tr', { class: grand ? 'bill-grand' : null }, h('th', { scope: 'row' }, label), h('td', {}, value));
  const sheet = h('div', { class: ['invoice-sheet', 'bill-sheet', 'print-area'] },
    h('div', { class: 'bill-head' },
      h('span', { class: 'bill-logo', 'aria-hidden': 'true' }),
      h('div', { class: 'bill-wordmark' },
        h('div', { class: 'bill-name' }, "Dr. Ali Rashid's"),
        h('div', { class: 'bill-clinic' }, 'Dental Clinic'),
        h('div', { class: 'bill-cities' }, 'Karachi · Lahore · Islamabad'))),
    branch ? h('p', { class: 'bill-branch' }, [branch.name, branch.address].filter(Boolean).join(' · ')) : null,
    h('div', { class: 'bill-who' },
      h('div', {}, line('Name', patient?.full_name), line('MR#', patient?.mr_number), line('Phone', patient?.phone), line('Age/Gender', ageGender)),
      h('div', {}, line('Date', billDate(inv)), line('Invoice#', inv.invoice_no))),
    inv.status === 'void' ? h('p', { class: 'bill-status' }, 'VOID') : inv.status === 'pending_approval' ? h('p', { class: 'bill-status' }, 'Discount waiting for approval') : null,
    h('table', { class: 'bill-items' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Description'), h('th', { scope: 'col' }, 'Rate'), h('th', { scope: 'col' }, 'Quantity'), h('th', { scope: 'col' }, 'Amount'))),
      h('tbody', {}, items.map((it) => h('tr', {},
        h('td', {}, it.description), h('td', {}, billNumber(it.unit_price)), h('td', {}, billNumber(it.quantity)), h('td', {}, billNumber(Number(it.quantity) * Number(it.unit_price))))))),
    h('div', { class: 'bill-foot' },
      h('p', { class: 'bill-mode' }, h('strong', {}, 'Payment Mode: '), modes.length ? modes.join(', ') : 'Not paid yet'),
      h('table', { class: 'bill-sums' }, h('tbody', {},
        sum('Sub-Total', billRupees(inv.subtotal)),
        Number(inv.discount_amount) ? sum('Discount', `- ${billRupees(inv.discount_amount)}`) : null,
        sum('Grand Total', billRupees(total), true),
        sum('Paid Amount', billRupees(Math.max(0, paid))),
        sum('Due Amount', billRupees(Math.max(0, total - paid))),
        paid > total ? sum('Advance', billRupees(paid - total)) : null))),
    inv.notes ? h('p', { class: 'bill-note' }, h('strong', {}, 'Note: '), inv.notes) : null,
    h('p', { class: 'bill-thanks' }, 'Thank you for choosing us. Keep this invoice for your records.'));
  sheet.style.setProperty('--inv-accent', t.accent);
  return sheet;
}

/** The invoice as printed: the A4 bill (payments: this invoice's, for Paid, Due and Payment Mode), or the 80mm thermal receipt as before. */
export function invoiceSheet(inv, patient, templateKey, { payments } = {}) {
  const t = TEMPLATES[templateKey || inv.template_key] || TEMPLATES.classic;
  const thermal = (templateKey || inv.template_key) === 'thermal';
  if (!thermal) return billSheet(inv, patient, t, payments ?? patient?.payments);
  const branch = state.ref.branches.find((b) => b.id === inv.branch_id);
  const items = inv.items || [];
  const sheet = h('div', { class: ['invoice-sheet', 'print-area', thermal && 'thermal', thermal && 'print-thermal'] },
    h('header', {},
      h('div', {}, h('strong', { style: { fontSize: thermal ? 'var(--fs-sm, 0.875rem)' : 'var(--fs-xl, 1.25rem)', color: 'var(--inv-accent)' } }, CONFIG.CLINIC_NAME),
        h('div', { class: 'muted' }, branch?.name || ''), h('div', { class: 'muted' }, branch?.address || '')),
      h('div', { class: 'right' }, h('strong', {}, inv.status === 'void' ? 'VOID' : 'Invoice'), h('div', {}, inv.invoice_no), h('div', { class: 'muted' }, shortDate(inv.issue_date)))),
    h('p', {}, h('strong', {}, patient?.full_name || ''), patient ? ` · Mr# ${patient.mr_number}` : ''),
    h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Treatment'), h('th', { scope: 'col', class: 'right' }, 'Qty'), h('th', { scope: 'col', class: 'right' }, 'Amount'))),
      h('tbody', {},
        items.map((it) => h('tr', {}, h('td', {}, it.description), h('td', { class: 'right' }, it.quantity), h('td', { class: 'right' }, rupees(it.quantity * it.unit_price)))),
        h('tr', {}, h('td', { colspan: 2 }, 'Subtotal'), h('td', { class: 'right' }, rupees(inv.subtotal))),
        Number(inv.discount_amount) ? h('tr', {}, h('td', { colspan: 2 }, 'Discount'), h('td', { class: 'right' }, '-' + rupees(inv.discount_amount))) : null,
        h('tr', {}, h('td', { colspan: 2 }, h('strong', {}, 'Total')), h('td', { class: 'right' }, h('strong', {}, rupees(inv.total ?? inv.subtotal - inv.discount_amount))))))),
    h('p', { class: 'muted', style: { marginTop: 'var(--space-4, 16px)', fontSize: 'var(--fs-xs, 0.75rem)' } }, 'Thank you for choosing us. Keep this invoice for your records.'));
  // A custom property must go through setProperty: Object.assign(el.style, ...) silently drops it.
  sheet.style.setProperty('--inv-accent', t.accent);
  return sheet;
}

/**
 * Shows an invoice with a Print button. Staff also get the template picker;
 * patients (and staff passing { patientView: true }) see the invoice's saved template only.
 * payments: the payments the bill counts (those on this invoice); a patient record's own payments by default.
 * receipt: { payment, due } adds "Print receipt" for the money just taken. autoPrint: print at once ("Save & Print").
 * saved: a line above the bill saying what was just saved. onClose: runs once the dialog (or the receipt after it) has closed.
 */
export function printInvoice(inv, patient, { patientView = state.session?.kind !== 'staff', payments = patient?.payments, receipt = null, autoPrint = false, saved = '', onClose } = {}) {
  let key = inv.template_key || 'classic';
  const holder = h('div', {});
  const draw = () => mount(holder, invoiceSheet(inv, patient, key, { payments }));
  draw();
  const picker = patientView ? null : select(Object.entries(TEMPLATES).map(([value, t]) => ({ value, label: t.name })), key, { onchange: (e) => { key = e.target.value; draw(); } });
  // The receipt opens once this dialog has closed, so only one sheet is on screen (and on paper) at a time.
  let thenReceipt = false;
  const dialog = modal(`Invoice ${inv.invoice_no}`, h('div', {}, saved ? h('p', { class: 'alert alert-info', role: 'status' }, saved) : null, picker ? field('Template', picker) : null, holder), [
    { label: 'Close' },
    receipt ? { label: 'Print receipt', onClick: () => { thenReceipt = true; } } : null,
    { label: 'Print', primary: true, onClick: () => { printSheet(holder.firstElementChild); return false; } },
  ].filter(Boolean), { onClose: () => { if (thenReceipt) printReceipt(receipt.payment, patient, inv, receipt.due, { onClose }); else onClose?.(); } });
  // Opened by Save in the form: the second click of a double click on Save lands on this dialog's buttons, where Save was, and is let go.
  const opened = performance.now();
  if (saved) dialog.dialog.addEventListener('click', (e) => { if (e.detail > 1 && performance.now() - opened < 1500 && e.target.closest?.('.modal-actions')) { e.stopPropagation(); e.preventDefault(); } }, true);
  if (autoPrint) printSheet(holder.firstElementChild);
  return dialog;
}

/**
 * New invoice for a patient, with the payment taken in the same dialog (owner, 15 Oct 2026, as Healthwire's "Create Invoice"):
 * lines picked from the clinic's treatments (the price list fills the rate), the discount, who did the treatment (a visit's doctor),
 * the money received now with what stays due (or is paid ahead), a note for the bill, then "Save" or "Save & Print". After saving,
 * the bill is shown with Print and, when money was taken, Print receipt; "Save & Print" prints it at once.
 *
 * options: branchId, visitId (the Aaj ki List row it is for), visitStaff (that visit's people: its doctor is "Performed by"),
 * treatment (the row's treatment: the first line when it is on the price list), onDone(invoice) after saving, afterBill() once the
 * bill shown after saving is closed (or the form, when only the invoice was saved).
 *
 * A slow line or a double click never makes a second invoice or a second payment: the invoice has one idempotency key per opened
 * form (save_invoice); once it is saved the form keeps it and only the payment is left to save, and a payment whose answer was lost
 * is looked up on that invoice before it is sent again.
 */
export function newInvoiceModal(patient, { branchId, visitId, visitStaff, treatment, onDone, afterBill } = {}) {
  // One key per opened form: pressing Save again after a failure cannot create a second invoice.
  const idempotencyKey = crypto.randomUUID();
  const d = state.data;
  let who = patient;
  const details = billPatient(patient).then((p) => { who = p || patient; });
  const branchSel = select(myBranches().map((b) => ({ value: b.id, label: b.name })), branchId || defaultBranchId());
  const treatments = state.ref.treatments || [];
  const byName = new Map(treatments.map((t) => [String(t.name).trim().toLowerCase(), t]));
  const lines = [];
  const linesBox = h('div', { class: 'bill-lines', role: 'group', 'aria-label': 'Invoice lines' },
    h('div', { class: 'bill-line bill-line-head', 'aria-hidden': 'true' },
      h('span', {}, 'Treatment'), h('span', {}, 'Description'), h('span', {}, 'Qty'), h('span', {}, 'Rate (Rs)'), h('span', { class: 'right' }, 'Amount'), h('span', {})));
  const totalsEl = h('div', { class: 'bill-totals', 'aria-live': 'polite' });
  const dueEl = h('div', { class: 'bill-due', 'aria-live': 'polite' });
  const discount = h('input', { type: 'number', min: 0, step: 100, value: 0, 'aria-label': 'Discount', oninput: () => recalc() });
  const discountKind = select([{ value: 'rs', label: 'Rs' }, { value: 'pct', label: '%' }], 'rs', { 'aria-label': 'Discount in Rs or %', onchange: () => recalc() });
  const reason = h('input', { placeholder: 'Reason (needed for discounts)' });
  const doctors = (state.ref.clinicians || []).filter((c) => c.is_doctor);
  const onVisit = (id) => (visitStaff || []).some((s) => s.role === 'doctor' && s.clinician_id === id);
  // "Performed by": the invoice has no place for a doctor, the visit has (its Doctor Name on the Aaj ki List), so it shows only for a visit.
  const performer = visitId && doctors.length
    ? select([{ value: '', label: 'Not set' }, ...doctors.map((c) => ({ value: c.id, label: c.display_name }))], (visitStaff || []).find((s) => s.role === 'doctor')?.clinician_id || '')
    : null;
  const method = select(PAY_METHODS, 'cash');
  let paidTyped = false; // the amount follows the total until it is typed in
  const paidNow = h('input', { type: 'number', min: 0, step: 100, inputmode: 'numeric', oninput: () => { paidTyped = true; recalc(); } });
  const note = h('textarea', { rows: 2, maxlength: 1000, placeholder: 'Optional. Printed on the bill.' });

  // An empty quantity means 1; a typed 0 or a negative number is an error (see Save), never a line that counts backwards.
  const qtyOf = (l) => (l.qty.value.trim() === '' ? 1 : Number(l.qty.value));
  const amountOf = (l) => Math.max(0, qtyOf(l)) * Math.max(0, Number(l.price.value || 0));
  const subtotalOf = () => lines.reduce((s, l) => s + amountOf(l), 0);
  const discountOf = (sub) => {
    if (!can('discount.give')) return 0;
    const v = Number(discount.value || 0);
    return discountKind.value === 'pct' ? Math.round((sub * v) / 100) : v;
  };
  function recalc() {
    for (const l of lines) l.amount.textContent = rupees(amountOf(l));
    const sub = subtotalOf();
    const off = Math.max(0, discountOf(sub));
    const total = Math.max(0, sub - off);
    if (!paidTyped) paidNow.value = String(total);
    totalsEl.replaceChildren(
      h('span', {}, `Sub-total ${rupees(sub)}`),
      off ? h('span', {}, `Discount ${rupees(off)}`) : '',
      h('strong', {}, `Total ${rupees(total)}`));
    const paid = Math.max(0, Number(paidNow.value || 0));
    dueEl.textContent = paid < total ? `Due ${rupees(total - paid)}` : paid > total ? `Advance ${rupees(paid - total)} (counts towards the next invoice)` : 'Paid in full';
    dueEl.className = ['bill-due', paid < total ? 'status-bad' : 'status-ok'].join(' ');
  }
  // The price list's rate goes in when a treatment from it is chosen, unless a rate was typed for this line by hand.
  function fillRate(line) {
    const t = byName.get(line.treat.value.trim().toLowerCase());
    if (t && t.default_price !== null && t.default_price !== undefined && (line.auto || line.price.value === '')) {
      line.price.value = String(Number(t.default_price));
      line.auto = true;
    }
    recalc();
  }
  const addBtn = h('button', { class: 'btn btn-small', type: 'button', onclick: () => addLine().treat.focus() }, '+ Add item');
  function addLine(name = '') {
    const n = lines.length + 1;
    const line = { auto: false };
    line.treat = h('input', { value: name, list: 'treatment-list', autocomplete: 'off', placeholder: 'Search treatment', 'aria-label': `Treatment, line ${n}`, oninput: () => fillRate(line), onchange: () => fillRate(line) });
    line.desc = h('input', { autocomplete: 'off', placeholder: 'Description', maxlength: 300, 'aria-label': `Description, line ${n}` });
    line.qty = h('input', { type: 'number', min: 1, value: 1, inputmode: 'numeric', 'aria-label': `Qty, line ${n}`, oninput: () => recalc() });
    line.price = h('input', { type: 'number', min: 0, step: 100, inputmode: 'numeric', placeholder: 'Rate', 'aria-label': `Rate (Rs), line ${n}`, oninput: () => { line.auto = false; recalc(); } });
    line.amount = h('output', { class: 'right', 'aria-label': `Amount, line ${n}` });
    line.row = h('div', { class: 'bill-line' }, line.treat, line.desc, line.qty, line.price, line.amount,
      h('button', { type: 'button', class: 'icon-btn bill-remove', 'aria-label': `Remove line ${n}`, title: 'Remove this line', onclick: () => {
        if (lines.length === 1) { for (const k of ['treat', 'desc', 'price']) line[k].value = ''; line.qty.value = 1; line.auto = false; recalc(); line.treat.focus(); return; }
        lines.splice(lines.indexOf(line), 1);
        line.row.remove();
        recalc();
        addBtn.focus();
      } }, h('span', { 'aria-hidden': 'true' }, '×')));
    lines.push(line);
    linesBox.append(line.row);
    if (name) fillRate(line); else recalc();
    return line;
  }
  // The row's treatment starts the first line when it is on the price list (its name as the price list writes it).
  addLine(byName.get(String(treatment || '').trim().toLowerCase())?.name || '');

  const invoicePart = h('div', {},
    h('datalist', { id: 'treatment-list' }, treatments.map((t) => h('option', { value: t.name }))),
    h('div', { class: 'form-grid' }, field('Branch', branchSel),
      performer ? field('Performed by', performer, 'Put on this visit as its doctor (Doctor Name on the Aaj ki List).') : null),
    linesBox,
    addBtn,
    can('discount.give') ? h('div', { class: 'form-grid', style: { marginTop: '12px' } },
      field('Discount', h('div', { class: 'bill-discount' }, discount, discountKind), 'Above your limit, it goes to the accountant or Dr. Ali for approval.'),
      field('Discount reason', reason, 'Needed when there is a discount.')) : null,
    totalsEl,
    field('Invoice note', note));
  const savedLine = h('p', { class: 'alert alert-info', hidden: true, role: 'status' });
  const body = h('div', { class: 'bill-form' },
    savedLine,
    invoicePart,
    h('fieldset', { class: 'bill-pay' }, h('legend', {}, 'Payment now'),
      h('div', { class: 'form-grid' }, field('Payment method', method), field('Payment (Rs)', paidNow, 'What the patient pays now. Less is fine; 0 when nothing is paid now.')),
      dueEl));
  recalc();

  let stuck = null; // the message of an IDEMPOTENCY_MISMATCH: this form's key is used up, so Save is refused until a new form is opened
  let inv = null; // the saved invoice: Save again only finishes the payment
  let pay = null; // the saved payment
  let payUnsure = false; // a payment was sent and its answer was lost: it may be saved
  let doctorDone = false;
  let finished = false;
  let print = false;
  let savedWords = '';
  const lockInvoice = () => {
    for (const el of invoicePart.querySelectorAll('input, select, textarea, button')) el.disabled = true;
    savedLine.textContent = `Invoice ${inv.invoice_no} is saved. Only the payment is left: press Save again, or Cancel and use Take payment later.`;
    savedLine.hidden = false;
  };

  async function save(andPrint) {
    if (stuck) { toast(stuck, 'error', 10000); return false; }
    clearFieldErrors(body);
    const errors = [];
    const paidText = paidNow.value.trim();
    const paid = paidText === '' ? 0 : Number(paidText);
    const filled = lines.filter((l) => l.treat.value.trim() || l.desc.value.trim());
    if (!inv) {
      for (const l of filled) {
        if (l.price.value === '') errors.push({ input: l.price, message: 'Enter a rate for this treatment.' });
        else if (!(Number(l.price.value) >= 0)) errors.push({ input: l.price, message: 'The rate cannot be negative.' });
        if (!(qtyOf(l) > 0)) errors.push({ input: l.qty, message: 'The quantity must be more than 0.' });
      }
      if (!filled.length) errors.push({ input: lines[0].treat, message: 'Add at least one treatment with a rate.' });
      const sub = subtotalOf();
      const off = discountOf(sub);
      // A Rs 0 invoice is allowed (owner, 2026-10-08): complimentary treatment is recorded that way. Prices and
      // quantities still cannot be negative or zero-quantity, and the database requires subtotal >= 0.
      if (off < 0) errors.push({ input: discount, message: 'The discount cannot be negative.' });
      else if (discountKind.value === 'pct' && Number(discount.value) > 100) errors.push({ input: discount, message: 'The discount cannot be more than 100%.' });
      else if (!errors.length && off > sub) errors.push({ input: discount, message: `The discount cannot be more than the subtotal (${rupees(sub)}).` });
      if (off > 0 && !reason.value.trim()) errors.push({ input: reason, message: 'Write a reason for the discount.' });
    }
    if (!(paid >= 0)) errors.push({ input: paidNow, message: 'The payment cannot be negative. Write 0 when nothing is paid now.' });
    if (errors.length) { showFormErrors(body, errors); return false; }

    if (!inv) {
      const items = filled.map((l) => ({ description: [l.treat.value.trim(), l.desc.value.trim()].filter(Boolean).join(' - '), quantity: qtyOf(l), unit_price: Number(l.price.value) }));
      try {
        const payload = { patient_id: patient.id, branch_id: Number(branchSel.value), items, discount_amount: discountOf(subtotalOf()), discount_reason: reason.value.trim() || null, visit_id: visitId || null, notes: note.value.trim() || null };
        // The key goes in the options argument (data contract); it is also on the payload for adapters that read it there.
        inv = await d.createInvoice({ ...payload, idempotencyKey }, { idempotencyKey });
      } catch (e) {
        const { text, stuck: spent } = saveFailure(e, 'invoices');
        if (spent) stuck = text;
        toast(text, 'error', 10000);
        return false;
      }
      lockInvoice();
    }
    // Who did the treatment goes on the visit (once; nothing is added when that doctor is on it already).
    if (performer?.value && !doctorDone) {
      doctorDone = true;
      if (!onVisit(performer.value)) {
        try { await d.setVisitStaff(visitId, performer.value, 'doctor'); } catch (e) { toast(`Invoice ${inv.invoice_no} is saved, but the doctor was not put on the visit: ${friendlyError(e)}`, 'error', 10000); }
      }
    }
    if (paid > 0 && !pay) {
      try {
        // The earlier try may have been saved: this invoice is new, so a payment on it can only be that one.
        if (payUnsure) pay = (await d.patientBilling(patient.id)).payments?.find((x) => x.invoice_id === inv.id) || null;
        if (!pay) pay = await d.recordPayment({ patient_id: patient.id, branch_id: inv.branch_id, amount: paid, method: method.value, invoice_id: inv.id, notes: null });
      } catch (e) {
        payUnsure = payUnsure || isLostAnswer(e);
        toast(`Invoice ${inv.invoice_no} is saved. The payment ${payUnsure ? 'may or may not have been saved' : 'was not saved'}: ${friendlyError(e)} Press Save again to ${payUnsure ? 'check and finish' : 'try again'}.`, 'error', 12000);
        return false;
      }
    }
    finished = true;
    print = andPrint;
    // Said on the bill that opens next (a toast would lie over its buttons).
    const words = inv.status === 'pending_approval' ? 'Invoice saved. The discount is waiting for approval.' : `Invoice ${inv.invoice_no} saved.`;
    savedWords = pay ? `${words} Payment of ${rupees(pay.amount)} saved.` : words;
    announce(savedWords);
    await details;
    await afterSave(onDone, inv);
    return undefined;
  }

  modal(`New invoice · ${patient.full_name}`, body, [
    { label: 'Cancel' },
    { label: 'Save', onClick: () => save(false) },
    { label: 'Save & Print', primary: true, onClick: () => save(true) },
  ], {
    initialFocus: lines[0].treat,
    onClose: () => {
      // Saved: the bill, with Print (and Print receipt for the money taken); "Save & Print" prints it at once.
      if (finished) {
        const total = Number(inv.total ?? inv.subtotal - inv.discount_amount);
        printInvoice(inv, who, { payments: pay ? [pay] : [], receipt: pay ? { payment: pay, due: Math.max(0, total - Number(pay.amount)) } : null, autoPrint: print, saved: savedWords, onClose: afterBill });
      } else if (inv) afterSave(onDone, inv).then(() => afterBill?.()); // the invoice was saved, the payment was not: the page still shows the new invoice
    },
  });
}

/** Issued invoices with what is still unpaid on each (payments are matched to invoices when taken). */
export function invoiceBalances(invoices, payments) {
  const paid = {};
  for (const p of payments || []) if (p.invoice_id) paid[p.invoice_id] = (paid[p.invoice_id] || 0) + Number(p.amount);
  return (invoices || []).filter((i) => i.status === 'issued').map((i) => {
    const total = Number(i.total ?? i.subtotal - i.discount_amount);
    return { ...i, paid_amount: paid[i.id] || 0, remaining: Math.max(0, total - (paid[i.id] || 0)) };
  });
}

export async function paymentModal(patient, { branchId, dues, invoices, payments, onDone } = {}) {
  // Payments are taken against an invoice so each invoice shows what is still unpaid.
  let balances = [];
  try {
    if (!invoices) ({ invoices, payments } = await state.data.patientBilling(patient.id));
    balances = invoiceBalances(invoices, payments).sort((a, b) => a.issue_date.localeCompare(b.issue_date));
  } catch { balances = []; }
  const open = balances.filter((i) => i.remaining > 0);
  const first = open[0];
  const amount = h('input', { type: 'number', min: 1, step: 100, value: first ? first.remaining : dues > 0 ? dues : '' });
  const method = select([{ value: 'cash', label: 'Cash' }, { value: 'bank_transfer', label: 'Bank transfer' }, { value: 'card', label: 'Card' }, { value: 'cheque', label: 'Cheque' }, { value: 'other', label: 'Other' }], 'cash');
  const branchSel = select(myBranches().map((b) => ({ value: b.id, label: b.name })), branchId || defaultBranchId());
  const invoiceSel = select([
    ...open.map((i) => ({ value: i.id, label: `${i.invoice_no} · ${shortDate(i.issue_date)} · ${rupees(i.remaining)} unpaid` })),
    ...balances.filter((i) => i.remaining <= 0).map((i) => ({ value: i.id, label: `${i.invoice_no} · ${shortDate(i.issue_date)} · paid` })),
    { value: '', label: 'Not for a particular invoice (advance)' },
  ], first?.id || '', { onchange: (e) => { const i = open.find((x) => x.id === e.target.value); if (i && !refund?.checked) amount.value = i.remaining; } });
  const notes = h('input', { placeholder: 'Optional' });
  const refund = can('billing.refund') ? h('input', { type: 'checkbox' }) : null;
  const body = h('div', {},
    h('p', { class: 'muted' }, `Pending dues: ${rupees(Math.max(0, dues || 0))}`),
    h('div', { class: 'form-grid' }, field('Amount (Rs)', amount, null, { required: true }), field('Method', method), field('Branch', branchSel)),
    field('For invoice', invoiceSel, open.length ? 'Pick the invoice this money is for. The unpaid amount fills in by itself.' : 'No unpaid invoice. An advance counts towards the next invoice.'),
    field('Notes', notes),
    refund ? h('label', { class: 'inline' }, refund, 'This is a refund (money given back)') : null);
  modal(`Take payment · ${patient.full_name}`, body, [
    { label: 'Cancel' },
    { label: 'Save payment', primary: true, onClick: async () => {
      clearFieldErrors(body);
      const value = Number(amount.value);
      if (!(value > 0)) { showFormErrors(body, [{ input: amount, message: 'Enter an amount above zero.' }]); return false; }
      try {
        await state.data.recordPayment({ patient_id: patient.id, branch_id: Number(branchSel.value), amount: refund?.checked ? -value : value, method: method.value, invoice_id: invoiceSel.value || null, notes: notes.value || null });
      } catch (e) { toast(friendlyError(e), 'error'); return false; }
      toast(refund?.checked ? 'Refund recorded.' : `Payment of ${rupees(value)} saved.`, 'ok');
      await afterSave(onDone);
    } },
  ]);
}

/** A payment receipt (the money received, which invoice it was for, what is still unpaid). */
export function receiptSheet(payment, patient, invoice, remainingDues) {
  const branch = state.ref.branches.find((b) => b.id === payment.branch_id);
  const method = { cash: 'Cash', bank_transfer: 'Bank transfer', card: 'Card', cheque: 'Cheque', other: 'Other' }[payment.method] || payment.method;
  const row = (label, value) => h('tr', {}, h('td', {}, label), h('td', { class: 'right' }, value));
  const sheet = h('div', { class: 'invoice-sheet print-area' },
    h('header', {},
      h('div', {}, h('strong', { style: { fontSize: 'var(--fs-xl, 1.25rem)', color: 'var(--inv-accent)' } }, CONFIG.CLINIC_NAME),
        h('div', { class: 'muted' }, branch?.name || ''), h('div', { class: 'muted' }, branch?.address || '')),
      h('div', { class: 'right' }, h('strong', {}, Number(payment.amount) < 0 ? 'Refund' : 'Payment receipt'), h('div', {}, shortDate(dayOf(payment.received_at))),
        h('div', { class: 'muted' }, `No. ${String(payment.id || '').slice(0, 8).toUpperCase()}`))),
    h('p', {}, h('strong', {}, patient?.full_name || ''), patient ? ` · Mr# ${patient.mr_number}` : ''),
    h('div', { class: 'table-scroll' }, h('table', { class: 'list' }, h('tbody', {},
      row(Number(payment.amount) < 0 ? 'Refunded' : 'Received', h('strong', {}, rupees(Math.abs(Number(payment.amount))))),
      row('By', method),
      invoice ? row('For invoice', `${invoice.invoice_no} · ${shortDate(invoice.issue_date)} · ${rupees(invoice.total ?? invoice.subtotal - invoice.discount_amount)}`) : null,
      remainingDues !== undefined && remainingDues !== null ? row('Still to pay', rupees(Math.max(0, remainingDues))) : null,
      payment.notes ? row('Notes', payment.notes) : null))),
    h('p', { class: 'muted', style: { marginTop: 'var(--space-4, 16px)', fontSize: 'var(--fs-xs, 0.75rem)' } }, 'Thank you. Keep this receipt for your records.'));
  sheet.style.setProperty('--inv-accent', TEMPLATES.classic.accent);
  return sheet;
}

export function printReceipt(payment, patient, invoice, remainingDues, { onClose } = {}) {
  const sheet = receiptSheet(payment, patient, invoice, remainingDues);
  modal('Payment receipt', sheet, [
    { label: 'Close' },
    { label: 'Print', primary: true, onClick: () => { printSheet(sheet); return false; } },
  ], { onClose });
}

// Overdue always says "Overdue" in words; the colour only repeats it.
const PLAN_STATUS = { paid: ['badge-ok', 'Paid'], overdue: ['badge-dues badge-overdue', 'Overdue'], due_soon: ['badge-warn', 'Due soon'], upcoming: ['badge-muted', 'Upcoming'] };

/** Where each installment of a plan stands: payments since the plan started are applied to installments in order. */
export function planProgress(plan, payments) {
  const paid = (payments || []).filter((p) => dayOf(p.received_at) >= plan.starts_on).reduce((s, p) => s + Number(p.amount), 0);
  const today = localISO();
  const soon = addDaysISO(today, 7);
  let cum = 0;
  const rows = [...(plan.installments || [])].sort((a, b) => a.due_date.localeCompare(b.due_date)).map((i) => {
    cum += Number(i.amount);
    const status = paid >= cum - 0.5 ? 'paid' : i.due_date < today ? 'overdue' : i.due_date <= soon ? 'due_soon' : 'upcoming';
    return { ...i, status, remaining: Math.max(0, cum - paid) };
  });
  return { paid, rows, total: cum, remaining: Math.max(0, cum - paid), overdue: rows.filter((r) => r.status === 'overdue').length };
}

export function planTable(plan, payments) {
  const prog = planProgress(plan, payments);
  return h('div', {},
    h('p', { class: 'muted' }, `${rupees(prog.paid)} paid of ${rupees(prog.total)} since ${shortDate(plan.starts_on)} · ${rupees(prog.remaining)} to go${plan.notes ? ' · ' + plan.notes : ''}`),
    h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Due'), h('th', { scope: 'col' }, 'Installment'), h('th', { scope: 'col', class: 'right' }, 'Amount'), h('th', { scope: 'col' }, 'Status'))),
      h('tbody', {}, prog.rows.map((r) => h('tr', {},
        h('td', { class: 'nowrap' }, shortDate(r.due_date)), h('td', {}, r.note || ''), h('td', { class: 'right' }, rupees(r.amount)),
        h('td', {}, h('span', { class: ['badge', PLAN_STATUS[r.status][0]] }, PLAN_STATUS[r.status][1]))))))));
}

/** Set up an installment plan: total split into equal parts from a first due date. */
export function installmentPlanModal(patient, { totalFee, bracesCaseId, onDone } = {}) {
  // One key per opened form: pressing Save again after a failure cannot create a second plan.
  const idempotencyKey = crypto.randomUUID();
  const total = h('input', { type: 'number', min: 1, step: 1000, value: totalFee || '' });
  const count = h('input', { type: 'number', min: 1, max: 36, value: 6 });
  const firstDue = h('input', { type: 'date', value: localISO() });
  const every = select([{ value: 1, label: 'Every month' }, { value: 2, label: 'Every 2 months' }, { value: 3, label: 'Every 3 months' }], 1);
  const startsOn = h('input', { type: 'date', value: localISO() });
  const notes = h('input', { placeholder: 'e.g. 70k braces kit, Rs 10,000 at bonding then monthly' });
  const preview = h('div', {});
  let rows = [];
  let amountInputs = [];
  const build = () => {
    const t = Number(total.value) || 0; const n = Math.max(1, Math.min(36, Number(count.value) || 1));
    const base = Math.floor(t / n / 100) * 100;
    // Calendar maths on the date string: 31 Jan + 1 month = 28/29 Feb, never 2 or 3 Mar, and never a day early in Pakistan.
    rows = firstDue.value ? Array.from({ length: n }, (_, k) => ({
      due_date: addMonthsISO(firstDue.value, k * Number(every.value)),
      amount: k === n - 1 ? t - base * (n - 1) : base,
      note: `Installment ${k + 1} of ${n}`,
    })) : [];
    amountInputs = rows.map((r, k) => h('input', { type: 'number', min: 0, step: 100, value: r.amount, style: { width: '120px' }, 'aria-label': `Amount (Rs), installment ${k + 1}`, oninput: (e) => { rows[k].amount = Number(e.target.value) || 0; } }));
    mount(preview, t > 0 && rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Due'), h('th', { scope: 'col' }, 'Installment'), h('th', { scope: 'col', class: 'right' }, 'Amount (Rs)'))),
      h('tbody', {}, rows.map((r, k) => h('tr', {},
        h('td', { class: 'nowrap' }, shortDate(r.due_date)), h('td', {}, r.note),
        h('td', { class: 'right' }, amountInputs[k])))))) : null);
  };
  [total, count, firstDue, every].forEach((el) => el.addEventListener('change', build));
  build();
  const body = h('div', {},
    h('p', { class: 'muted' }, 'Payments taken from the start date are counted towards the installments in order, so the coordinator sees who is behind.'),
    h('div', { class: 'form-grid' }, field('Total to pay (Rs)', total, null, { required: true }), field('Number of installments', count), field('First installment due', firstDue, null, { required: true }), field('Then', every), field('Count payments from', startsOn, 'Usually the bonding date.')),
    field('Notes', notes),
    preview);
  let stuck = null; // the message of an IDEMPOTENCY_MISMATCH: this form's key is used up, so Save is refused until a new form is opened
  modal(`Installment plan · ${patient.full_name}`, body, [
    { label: 'Cancel' },
    { label: 'Save plan', primary: true, onClick: async () => {
      if (stuck) { toast(stuck, 'error', 10000); return false; }
      clearFieldErrors(body);
      const t = Number(total.value);
      const errors = [];
      if (!(t > 0)) errors.push({ input: total, message: 'Enter the total.' });
      if (!firstDue.value) errors.push({ input: firstDue, message: 'Choose the date the first installment is due.' });
      if (!errors.length) {
        const sum = rows.reduce((s, r) => s + Number(r.amount), 0);
        rows.forEach((r, k) => { if (!(r.amount > 0)) errors.push({ input: amountInputs[k], message: 'Every installment needs an amount.' }); });
        if (Math.round(sum) !== Math.round(t)) errors.push({ input: total, message: `The installments add up to ${rupees(sum)}, not ${rupees(t)}. Change an amount or the total.` });
      }
      if (errors.length) { showFormErrors(body, errors); return false; }
      try {
        const payload = { patient_id: patient.id, braces_case_id: bracesCaseId || null, total_fee: t, starts_on: startsOn.value, notes: notes.value.trim() || null, installments: rows };
        // The key goes in the options argument (data contract); it is also on the payload for adapters that read it there.
        await state.data.savePaymentPlan({ ...payload, idempotencyKey }, { idempotencyKey });
      } catch (e) {
        const { text, stuck: spent } = saveFailure(e, 'plans');
        if (spent) stuck = text;
        toast(text, 'error', 10000);
        return false;
      }
      toast('Installment plan saved.', 'ok');
      await afterSave(onDone);
    } },
  ]);
}

export { branchName };
