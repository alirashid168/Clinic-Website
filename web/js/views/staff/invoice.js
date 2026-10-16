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

function billSheet(inv, patient, t, payments, credit = 0) {
  const branch = state.ref.branches.find((b) => b.id === inv.branch_id);
  const items = inv.items || [];
  const total = Number(inv.total ?? inv.subtotal - inv.discount_amount);
  const mine = (payments || []).filter((p) => p.invoice_id === inv.id);
  // credit: money the patient paid ahead (an advance, or more than an earlier invoice) that goes towards this one (invoiceBalances).
  const ahead = Math.max(0, Math.min(Number(credit) || 0, total - mine.reduce((s, p) => s + Number(p.amount), 0)));
  const paid = mine.reduce((s, p) => s + Number(p.amount), 0) + ahead;
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
      h('p', { class: 'bill-mode' }, h('strong', {}, 'Payment Mode: '), [...modes, ahead ? 'Advance paid earlier' : ''].filter(Boolean).join(', ') || 'Not paid yet'),
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

/**
 * The invoice as printed: the A4 bill (payments: this invoice's, for Paid, Due and Payment Mode; credit: an advance paid earlier that
 * goes towards it), or the 80mm thermal receipt as before.
 */
export function invoiceSheet(inv, patient, templateKey, { payments, credit = 0 } = {}) {
  const t = TEMPLATES[templateKey || inv.template_key] || TEMPLATES.classic;
  const thermal = (templateKey || inv.template_key) === 'thermal';
  if (!thermal) return billSheet(inv, patient, t, payments ?? patient?.payments, credit);
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
 * credit: an advance paid earlier that goes towards this invoice (invoiceBalances' credit_used).
 */
export function printInvoice(inv, patient, { patientView = state.session?.kind !== 'staff', payments = patient?.payments, credit = 0, receipt = null, autoPrint = false, saved = '', onClose } = {}) {
  let key = inv.template_key || 'classic';
  const holder = h('div', {});
  const draw = () => mount(holder, invoiceSheet(inv, patient, key, { payments, credit }));
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
 * What an invoice line can be (owner, 15 Oct 2026: "braces kit should be given separate amounts as they are different. please take all
 * payments from the treatment price from healthwire"): the price list first (treatments.price_list: a name and its price), then the
 * Aaj ki List's visit types that have a price. A visit type without a price is not something to bill.
 */
export function billableItems() {
  const all = (state.ref.treatments || []).filter((t) => t.active !== false);
  const priced = (t) => t.default_price !== null && t.default_price !== undefined && t.default_price !== '';
  return [...all.filter((t) => t.price_list), ...all.filter((t) => !t.price_list && priced(t))];
}

const nameKey = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
let formNo = 0; // each form's own price-list id, so two forms never share one

/**
 * The lines, the discounts and the note of an invoice, as Healthwire's "Create Invoice" (owner, 15 Oct 2026: "quantity, price,
 * description, discount and the total given below"): a line per treatment with Treatment (the price list, searchable: its price fills
 * the rate), Description, Rate, Qty, Amount, Discount (Rs or %), Performed by (a doctor) and ×; "+ Add item"; the discount on the
 * total (Rs or %) with its reason; the sub-total, the discount and the grand total; the invoice note. Used by the new invoice and by Edit.
 *
 * items: the lines of an invoice being changed; treatment: the first line's treatment (when it is on the list); doctorId: the doctor a
 * new line starts with; discount (the invoice's whole discount), reason, notes: an invoice being changed. onChange(totals) on every change.
 * read() gives { errors, items, discount, reason, notes, total } as save_invoice and edit_invoice take them: the invoice's discount is
 * the lines' discounts plus the discount on the total, and each line keeps its own (invoice_items.discount_amount).
 */
function invoiceEditor({ items = null, treatment = '', doctorId = '', discount = 0, reason = '', notes = '', onChange } = {}) {
  const listId = `price-list-${++formNo}`;
  const priceList = billableItems();
  const byName = new Map(priceList.map((t) => [nameKey(t.name), t]));
  const allById = new Map((state.ref.treatments || []).map((t) => [Number(t.id), t]));
  const doctors = (state.ref.clinicians || []).filter((c) => c.is_doctor && c.active !== false);
  // Giving a discount is for "Give discounts within cap"; someone without it (the coordinator changing an invoice) keeps the discounts as they are.
  const mayDiscount = can('discount.give');
  const lines = [];
  const linesBox = h('div', { class: ['bill-lines', !mayDiscount && !items && 'no-discount'], role: 'group', 'aria-label': 'Invoice lines' },
    h('div', { class: 'bill-line bill-line-head', 'aria-hidden': 'true' },
      h('span', {}, 'Treatment'), h('span', {}, 'Description'), h('span', {}, 'Rate (Rs)'), h('span', {}, 'Qty'), h('span', { class: 'right' }, 'Amount'),
      h('span', { class: 'bill-disc-head' }, 'Discount'), h('span', {}, 'Performed by'), h('span', {})));
  const totalsEl = h('div', { class: 'bill-totals', 'aria-live': 'polite' });
  // The lines' discounts are a part of the invoice's. Lines saying more than the invoice (a discount rejected before the database took
  // the lines' discounts off with it, 20261015000900) show none: the invoice's own discount is what was given.
  const linesSay = (items || []).reduce((s, it) => s + Number(it.discount_amount || 0), 0);
  const lineDiscounts = linesSay <= Number(discount || 0);
  const lineOffBefore = lineDiscounts ? linesSay : 0;
  const totalOff = h('input', { type: 'number', min: 0, step: 100, inputmode: 'decimal', value: Math.max(0, Number(discount || 0) - lineOffBefore) || 0, 'aria-label': 'Total discount', disabled: !mayDiscount, oninput: () => recalc() });
  const totalKind = select([{ value: 'rs', label: 'Rs' }, { value: 'pct', label: '%' }], 'rs', { 'aria-label': 'Total discount in Rs or %', disabled: !mayDiscount, onchange: () => recalc() });
  const reasonIn = h('input', { value: reason || '', maxlength: 300, placeholder: 'Reason (needed for discounts)', disabled: !mayDiscount });
  const noteIn = h('textarea', { rows: 2, maxlength: 1000, placeholder: 'Optional. Printed on the bill.' }, notes || '');

  // An empty quantity means 1; a typed 0 or a negative number is an error (see read), never a line that counts backwards.
  const qtyOf = (l) => (l.qty.value.trim() === '' ? 1 : Number(l.qty.value));
  const amountOf = (l) => Math.max(0, qtyOf(l)) * Math.max(0, Number(l.price.value || 0));
  // A discount typed as a % is turned into whole rupees of what it is a % of.
  const offOf = (input, kind, of) => {
    const v = Number(input.value || 0);
    return kind.value === 'pct' ? Math.round((of * v) / 100) : v;
  };
  const lineOff = (l) => offOf(l.off, l.offKind, amountOf(l));
  function totals() {
    const sub = lines.reduce((s, l) => s + amountOf(l), 0);
    const onLines = lines.reduce((s, l) => s + Math.max(0, lineOff(l)), 0);
    const onTotal = Math.max(0, offOf(totalOff, totalKind, Math.max(0, sub - onLines)));
    const off = onLines + onTotal;
    return { sub, onLines, onTotal, off, total: Math.max(0, sub - off) };
  }
  function recalc() {
    for (const l of lines) l.amount.textContent = rupees(amountOf(l));
    const t = totals();
    totalsEl.replaceChildren(
      h('span', {}, `Sub-total ${rupees(t.sub)}`),
      t.off ? h('span', {}, `Discount ${rupees(t.off)}`) : '',
      h('strong', {}, `Grand total ${rupees(t.total)}`));
    onChange?.(t);
  }
  // The price list's rate goes in when an item from it is chosen, unless a rate was typed for this line by hand. A rate that came from
  // the list goes again once the treatment no longer names that item (changed to something not on the list, misspelt, or cleared):
  // the line then asks for a rate instead of billing the earlier item's price.
  function fillRate(line) {
    const t = byName.get(nameKey(line.treat.value));
    if (t && (line.auto || line.price.value === '')) {
      line.price.value = String(Number(t.default_price ?? 0));
      line.auto = true;
    } else if (!t && line.auto) {
      line.price.value = '';
      line.auto = false;
    }
    recalc();
  }
  const addBtn = h('button', { class: 'btn btn-small', type: 'button', onclick: () => addLine().treat.focus() }, '+ Add item');
  function addLine(it = null) {
    const n = lines.length + 1;
    const line = { auto: false };
    // A line being changed shows its price-list item by name (the description after it), and keeps the item it points at while that
    // name is not changed (also an item since switched off, which is no longer on the list).
    const known = it?.treatment_id ? allById.get(Number(it.treatment_id)) : null;
    const desc = String(it?.description || '');
    const treatName = known ? known.name : it ? desc : (byName.get(nameKey(treatment))?.name || '');
    // A saved line keeps its description as it is unless this form changes the treatment or the description: an imported line (the
    // visit type "Bonding" with "Braces Kit (Made in China), Monthly (x2)" from Healthwire) or a line whose price-list item was renamed
    // since would otherwise be saved as the bare item name. The Description box shows what follows the item's name, or all of the
    // description when it does not start with that name.
    const rest = !known ? '' : nameKey(desc).startsWith(nameKey(known.name)) ? desc.slice(known.name.length).replace(/^\s*-\s*/, '') : desc;
    line.keep = it?.treatment_id ? { id: Number(it.treatment_id), name: treatName } : null;
    line.saved = it ? { treat: treatName, desc: rest, description: desc } : null;
    line.treat = h('input', { value: treatName, list: listId, autocomplete: 'off', placeholder: 'Search the price list', 'aria-label': `Treatment, line ${n}`, oninput: () => fillRate(line), onchange: () => fillRate(line) });
    line.desc = h('input', { value: rest, autocomplete: 'off', placeholder: 'Description', maxlength: 300, 'aria-label': `Description, line ${n}` });
    line.price = h('input', { type: 'number', min: 0, step: 100, inputmode: 'decimal', placeholder: 'Rate', value: it ? Number(it.unit_price) : '', 'aria-label': `Rate (Rs), line ${n}`, oninput: () => { line.auto = false; recalc(); } });
    line.qty = h('input', { type: 'number', min: 1, value: it ? Number(it.quantity) : 1, inputmode: 'numeric', 'aria-label': `Qty, line ${n}`, oninput: () => recalc() });
    line.amount = h('output', { class: 'right bill-amount', 'aria-label': `Amount, line ${n}` });
    line.off = h('input', { type: 'number', min: 0, step: 100, inputmode: 'decimal', value: (lineDiscounts && Number(it?.discount_amount || 0)) || '', placeholder: 'Discount', disabled: !mayDiscount, 'aria-label': `Discount, line ${n}`, oninput: () => recalc() });
    line.offKind = select([{ value: 'rs', label: 'Rs' }, { value: 'pct', label: '%' }], 'rs', { 'aria-label': `Discount in Rs or %, line ${n}`, disabled: !mayDiscount, onchange: () => recalc() });
    const doc = it ? it.clinician_id || '' : doctorId || '';
    const gone = doc && !doctors.some((c) => c.id === doc) ? [{ value: doc, label: 'A doctor no longer listed' }] : [];
    line.doctor = select([{ value: '', label: 'Doctor not set' }, ...doctors.map((c) => ({ value: c.id, label: c.display_name })), ...gone], doc, { 'aria-label': `Performed by, line ${n}` });
    // Each box with its name above it, seen only where the column names are not (narrower than a laptop: app.css .bill-cell-label);
    // a screen reader hears each box's own label.
    const cell = (label, control, cls = null) => h('div', { class: ['bill-cell', cls] }, h('span', { class: 'bill-cell-label', 'aria-hidden': 'true' }, label), control);
    line.row = h('div', { class: 'bill-line' },
      cell('Treatment', line.treat), cell('Description', line.desc), cell('Rate (Rs)', line.price), cell('Qty', line.qty), cell('Amount', line.amount, 'bill-amount-cell'),
      cell('Discount', h('div', { class: 'bill-disc' }, line.off, line.offKind), 'bill-disc-cell'), cell('Performed by', line.doctor, 'bill-doc-cell'),
      h('button', { type: 'button', class: 'icon-btn bill-remove', 'aria-label': `Remove line ${n}`, title: 'Remove this line', onclick: () => {
        if (lines.length === 1) {
          for (const k of ['treat', 'desc', 'price', 'off']) line[k].value = '';
          line.qty.value = 1; line.auto = false; line.keep = null; line.saved = null; recalc(); line.treat.focus(); return;
        }
        lines.splice(lines.indexOf(line), 1);
        line.row.remove();
        recalc();
        addBtn.focus();
      } }, h('span', { 'aria-hidden': 'true' }, '×')));
    lines.push(line);
    linesBox.append(line.row);
    if (!it && treatName) fillRate(line); else recalc();
    return line;
  }
  if (items?.length) for (const it of items) addLine(it); else addLine();

  const el = h('div', { class: 'bill-editor' },
    h('datalist', { id: listId }, priceList.map((t) => h('option', { value: t.name, label: rupees(t.default_price ?? 0) }))),
    linesBox,
    addBtn,
    mayDiscount || Number(discount) > 0 ? h('div', { class: 'form-grid', style: { marginTop: '12px' } },
      field('Discount on the total', h('div', { class: 'bill-discount' }, totalOff, totalKind),
        mayDiscount ? 'Above your limit, it goes to the accountant or Dr. Ali for approval.' : 'Only staff who give discounts change them.'),
      field('Discount reason', reasonIn, 'Needed when there is a discount.')) : null,
    totalsEl);
  // The note is placed by the form (after the payment in a new invoice, so the payment and what stays due are in sight above it).
  const noteField = field('Invoice note', noteIn);
  recalc();

  function read() {
    const errors = [];
    const filled = lines.filter((l) => l.treat.value.trim() || l.desc.value.trim());
    for (const l of filled) {
      if (l.price.value === '') errors.push({ input: l.price, message: 'Enter a rate for this treatment.' });
      else if (!(Number(l.price.value) >= 0)) errors.push({ input: l.price, message: 'The rate cannot be negative.' });
      if (!(qtyOf(l) > 0)) errors.push({ input: l.qty, message: 'The quantity must be more than 0.' });
      const off = lineOff(l);
      if (off < 0) errors.push({ input: l.off, message: 'The discount cannot be negative.' });
      else if (l.offKind.value === 'pct' && Number(l.off.value) > 100) errors.push({ input: l.off, message: 'The discount cannot be more than 100%.' });
      else if (off > amountOf(l)) errors.push({ input: l.off, message: `The discount cannot be more than this line's amount (${rupees(amountOf(l))}).` });
    }
    if (!filled.length) errors.push({ input: lines[0].treat, message: 'Add at least one treatment with a rate.' });
    const t = totals();
    const typed = offOf(totalOff, totalKind, Math.max(0, t.sub - t.onLines));
    // A Rs 0 invoice is allowed (owner, 2026-10-08): complimentary treatment is recorded that way.
    if (typed < 0) errors.push({ input: totalOff, message: 'The discount cannot be negative.' });
    else if (totalKind.value === 'pct' && Number(totalOff.value) > 100) errors.push({ input: totalOff, message: 'The discount cannot be more than 100%.' });
    else if (!errors.length && t.off > t.sub) errors.push({ input: totalOff, message: `The discount cannot be more than the sub-total (${rupees(t.sub)}).` });
    if (t.off > 0 && mayDiscount && !reasonIn.value.trim()) errors.push({ input: reasonIn, message: 'Write a reason for the discount.' });
    const out = filled.map((l) => {
      const hit = byName.get(nameKey(l.treat.value));
      const treatmentId = hit ? Number(hit.id) : l.keep && nameKey(l.keep.name) === nameKey(l.treat.value) ? l.keep.id : null;
      const untouched = l.saved && l.treat.value === l.saved.treat && l.desc.value === l.saved.desc;
      return {
        description: untouched ? l.saved.description : [l.treat.value.trim(), l.desc.value.trim()].filter(Boolean).join(' - '), quantity: qtyOf(l), unit_price: Number(l.price.value),
        discount_amount: Math.max(0, lineOff(l)), treatment_id: treatmentId, clinician_id: l.doctor.value || null,
      };
    });
    return { errors, items: out, discount: t.off, reason: t.off > 0 ? reasonIn.value.trim() || null : null, notes: noteIn.value.trim() || null, total: t.total };
  }
  const lock = () => { for (const x of [...el.querySelectorAll('input, select, textarea, button'), noteIn]) x.disabled = true; };
  return { el, noteField, read, totals, lock, first: () => lines[0].treat };
}

/**
 * New invoice for a patient, with the payment taken in the same dialog (owner, 15 Oct 2026, as Healthwire's "Create Invoice"):
 * the lines (invoiceEditor: the price list fills the rate; a discount and "Performed by" per line), the discount on the total, the
 * money received now with what stays due (or is paid ahead), a note for the bill, then "Save" or "Save & Print". After saving, the
 * bill is shown with Print and, when money was taken, Print receipt; "Save & Print" prints it at once.
 *
 * options: branchId, visitId (the Aaj ki List row it is for), visitStaff (that visit's people: its doctor starts every line's
 * "Performed by"), treatment (the row's treatment: the first line when it is on the price list), onDone(invoice) after saving,
 * afterBill() once the bill shown after saving is closed (or the form, when only the invoice was saved).
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
  const dueEl = h('div', { class: 'bill-due', 'aria-live': 'polite' });
  const method = select(PAY_METHODS, 'cash');
  let paidTyped = false; // the amount follows the total until it is typed in
  let total = 0;
  const showDue = () => {
    const paid = Math.max(0, Number(paidNow.value || 0));
    dueEl.textContent = paid < total ? `Due ${rupees(total - paid)}` : paid > total ? `Advance ${rupees(paid - total)} (counts towards the next invoice)` : 'Paid in full';
    dueEl.className = ['bill-due', paid < total ? 'status-bad' : 'status-ok'].join(' ');
  };
  const paidNow = h('input', { type: 'number', min: 0, step: 100, inputmode: 'numeric', oninput: () => { paidTyped = true; showDue(); } });
  const editor = invoiceEditor({
    treatment, doctorId: (visitStaff || []).find((s) => s.role === 'doctor')?.clinician_id || '',
    onChange: (t) => { total = t.total; if (!paidTyped) paidNow.value = String(total); showDue(); },
  });
  const invoicePart = h('div', {}, h('div', { class: 'form-grid' }, field('Branch', branchSel)), editor.el);
  const savedLine = h('p', { class: 'alert alert-info', hidden: true, role: 'status' });
  const body = h('div', { class: 'bill-form' },
    savedLine,
    invoicePart,
    h('fieldset', { class: 'bill-pay' }, h('legend', {}, 'Payment now'),
      h('div', { class: 'form-grid' }, field('Payment method', method), field('Payment (Rs)', paidNow, 'What the patient pays now. Less is fine; 0 when nothing is paid now.')),
      dueEl),
    editor.noteField);
  showDue();

  let stuck = null; // the message of an IDEMPOTENCY_MISMATCH: this form's key is used up, so Save is refused until a new form is opened
  let inv = null; // the saved invoice: Save again only finishes the payment
  let pay = null; // the saved payment
  let paySent = null; // the payment as it was last sent (a lost answer: what may have been saved)
  let payUnsure = false; // a payment was sent and its answer was lost: it may be saved
  let credit = 0; // an advance the patient paid earlier that goes towards this invoice (shown on the bill)
  let finished = false;
  let print = false;
  let savedWords = '';
  const lockInvoice = () => {
    editor.lock();
    branchSel.disabled = true;
    savedLine.textContent = `Invoice ${inv.invoice_no} is saved. Only the payment is left: press Save again, or Cancel and use Take payment later.`;
    savedLine.hidden = false;
  };

  async function save(andPrint) {
    if (stuck) { toast(stuck, 'error', 10000); return false; }
    clearFieldErrors(body);
    const paidText = paidNow.value.trim();
    const paid = paidText === '' ? 0 : Number(paidText);
    const form = inv ? null : editor.read();
    const errors = form ? [...form.errors] : [];
    if (!(paid >= 0)) errors.push({ input: paidNow, message: 'The payment cannot be negative. Write 0 when nothing is paid now.' });
    if (errors.length) { showFormErrors(body, errors); return false; }

    if (!inv) {
      try {
        const payload = { patient_id: patient.id, branch_id: Number(branchSel.value), items: form.items, discount_amount: form.discount, discount_reason: form.reason, visit_id: visitId || null, notes: form.notes };
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
    if (paid > 0 && !pay) {
      try {
        // The earlier try may have been saved: this invoice is new, so a payment on it can only be that one. The look-up reads a few of
        // its columns (the live patientBilling: id, invoice, amount, time), so the rest (method, branch) are those of the try that was
        // sent, for the bill's Payment Mode and the receipt.
        if (payUnsure) {
          const found = (await d.patientBilling(patient.id)).payments?.find((x) => x.invoice_id === inv.id);
          if (found) pay = { ...paySent, ...found };
        }
        if (!pay) {
          paySent = { patient_id: patient.id, branch_id: inv.branch_id, amount: paid, method: method.value, invoice_id: inv.id, notes: null };
          pay = await d.recordPayment(paySent);
        }
      } catch (e) {
        payUnsure = payUnsure || isLostAnswer(e);
        // (a lost answer: the payment may be saved, so the error's own words, "did not go through", are not said)
        toast(`Invoice ${inv.invoice_no} is saved. ${payUnsure ? `The payment may or may not have been saved: ${navigator.onLine ? 'the server did not answer' : 'the connection dropped'}.` : `The payment was not saved: ${friendlyError(e)}`} Press Save again to ${payUnsure ? 'check and finish' : 'try again'}.`, 'error', 12000);
        return false;
      }
    }
    finished = true;
    print = andPrint;
    // Said on the bill that opens next (a toast would lie over its buttons).
    const words = inv.status === 'pending_approval' ? 'Invoice saved. The discount is waiting for approval.' : `Invoice ${inv.invoice_no} saved.`;
    savedWords = pay ? `${words} Payment of ${rupees(pay.amount)} saved.` : words;
    announce(savedWords);
    await Promise.all([details, afterSave(onDone, inv), creditFor()]);
    return undefined;
  }
  // What stays due on the bill counts an advance paid earlier (invoiceBalances). Only asked when something stays due; without an answer
  // the bill shows this invoice's own payments, as before.
  async function creditFor() {
    const due = Number(inv.total ?? inv.subtotal - inv.discount_amount) - Number(pay?.amount || 0);
    if (!(due > 0)) return;
    try {
      const { invoices, payments } = await d.patientBilling(patient.id);
      credit = invoiceBalances(invoices, payments).find((i) => i.id === inv.id)?.credit_used || 0;
    } catch { credit = 0; }
  }

  modal(`New invoice · ${patient.full_name}`, body, [
    { label: 'Cancel' },
    { label: 'Save', onClick: () => save(false) },
    { label: 'Save & Print', primary: true, onClick: () => save(true) },
  ], {
    initialFocus: editor.first(),
    onClose: () => {
      // Saved: the bill, with Print (and Print receipt for the money taken); "Save & Print" prints it at once.
      if (finished) {
        const due = Number(inv.total ?? inv.subtotal - inv.discount_amount);
        printInvoice(inv, who, { payments: pay ? [pay] : [], credit, receipt: pay ? { payment: pay, due: Math.max(0, due - Number(pay.amount) - credit) } : null, autoPrint: print, saved: savedWords, onClose: afterBill });
      } else if (inv) afterSave(onDone, inv).then(() => afterBill?.()); // the invoice was saved, the payment was not: the page still shows the new invoice
    },
  });
}

/**
 * Edit an issued invoice (owner, 15 Oct 2026: "admin and accounts should have edit button ... and also clinic coordinator should have
 * this option to edit the invoice"): its lines, discounts and note, for "Edit or void invoices" (billing.edit). One database call
 * (edit_invoice) changes it all or nothing; the discount limits and their approval apply as for a new invoice (a discount made bigger
 * than the person's limit waits for approval), and the change is in the audit log. The payments on it stay as they are.
 */
export function editInvoiceModal(inv, patient, { onDone } = {}) {
  const editor = invoiceEditor({ items: inv.items || [], discount: inv.discount_amount, reason: inv.discount_reason, notes: inv.notes });
  const body = h('div', { class: 'bill-form' },
    h('p', { class: 'muted' }, `${patient?.full_name || ''}${patient?.mr_number ? ` · Mr# ${patient.mr_number}` : ''} · ${branchName(inv.branch_id) || ''} · ${shortDate(inv.issue_date)}. Payments on this invoice stay as they are. The change is kept in the audit log.`),
    editor.el,
    editor.noteField);
  modal(`Edit invoice ${inv.invoice_no}`, body, [
    { label: 'Cancel' },
    { label: 'Save changes', primary: true, onClick: async () => {
      clearFieldErrors(body);
      const form = editor.read();
      if (form.errors.length) { showFormErrors(body, form.errors); return false; }
      let out;
      try {
        out = await state.data.editInvoice(inv.id, { items: form.items, discount_amount: form.discount, discount_reason: form.reason, notes: form.notes });
      } catch (e) { toast(saveFailure(e, 'invoices').text, 'error', 10000); return false; }
      toast(out?.status === 'pending_approval' ? `Invoice ${inv.invoice_no} saved. The discount is waiting for approval.` : `Invoice ${inv.invoice_no} saved.`, 'ok');
      await afterSave(onDone, out);
      return undefined;
    } },
  ], { initialFocus: editor.first() });
}

// A payment's time as the form shows it (Karachi, to the minute) and back: "2026-10-15T17:02" <-> an ISO timestamp.
function karachiInput(ts) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ts))) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
const fromKarachiInput = (v) => new Date(`${v}:00+05:00`).toISOString();

/**
 * Edit a payment (owner, 15 Oct 2026: "if we enter cash payment as card or vice versa, it creates a problem. so edit option should be
 * given"): its method, amount, date and time, and note, for "Edit or void invoices" (billing.edit). Only what was changed is sent; the
 * change is in the audit log. A refund stays a refund (its amount is changed as what was given back, by staff who give refunds; anyone
 * with Edit corrects its method or note). A change to the cash of a day whose cash is already closed asks once more first: that day's
 * closing counted the payment as it was, so its expected cash and difference stay as they were (the accountant is told to check it).
 */
export function editPaymentModal(pay, patient, { onDone } = {}) {
  const refund = Number(pay.amount) < 0;
  const known = PAY_METHODS.some((m) => m.value === pay.method);
  const method = select(known ? PAY_METHODS : [...PAY_METHODS, { value: pay.method, label: METHOD_WORDS[pay.method] || pay.method }], pay.method);
  const amount = h('input', { type: 'number', min: 1, step: 100, inputmode: 'decimal', value: Math.abs(Number(pay.amount)), disabled: refund && !can('billing.refund') });
  const closedNote = h('p', { class: 'alert alert-warning', role: 'alert', hidden: true });
  let warned = '';
  const startedAt = pay.received_at ? karachiInput(pay.received_at) : '';
  const when = h('input', { type: 'datetime-local', value: startedAt, step: 60 });
  const notes = h('input', { value: pay.notes || '', maxlength: 500, placeholder: 'Optional' });
  const body = h('div', {},
    h('p', { class: 'muted' }, `${patient?.full_name || ''}${patient?.mr_number ? ` · Mr# ${patient.mr_number}` : ''}. The change is kept in the audit log.`),
    h('div', { class: 'form-grid' },
      field('Method', method),
      field(refund ? 'Amount given back (Rs)' : 'Amount (Rs)', amount, refund && amount.disabled ? 'The amount of a refund is changed by staff who give refunds.' : null, { required: true }),
      field('Date and time', when, 'Karachi time.'),
      field('Note', notes)),
    closedNote);
  modal(`Edit ${refund ? 'refund' : 'payment'} · ${rupees(Math.abs(Number(pay.amount)))} ${METHOD_WORDS[pay.method] || pay.method}`, body, [
    { label: 'Cancel' },
    { label: 'Save changes', primary: true, onClick: async () => {
      clearFieldErrors(body);
      const value = Number(amount.value);
      const errors = [];
      if (!(value > 0)) errors.push({ input: amount, message: 'Enter an amount above zero.' });
      if (!when.value) errors.push({ input: when, message: 'Choose the date and time the money was received.' });
      if (errors.length) { showFormErrors(body, errors); return false; }
      const changes = {};
      if (method.value !== pay.method) changes.method = method.value;
      const signed = refund ? -value : value;
      if (signed !== Number(pay.amount)) changes.amount = signed;
      if (when.value !== startedAt) changes.received_at = fromKarachiInput(when.value);
      if ((notes.value.trim() || null) !== (pay.notes || null)) changes.notes = notes.value.trim() || null;
      if (!Object.keys(changes).length) { toast('Nothing was changed.'); return undefined; }
      // The cash of a day changes when a cash payment's amount or day changes, or a payment becomes cash or stops being cash.
      const wasCash = pay.method === 'cash';
      const nowCash = method.value === 'cash';
      const days = [...new Set([
        wasCash && (changes.method || changes.amount !== undefined || changes.received_at) ? dayOf(pay.received_at) : '',
        nowCash && (changes.method || changes.amount !== undefined || changes.received_at) ? dayOf(changes.received_at || pay.received_at) : '',
      ].filter(Boolean))];
      const closed = [];
      for (const day of days) {
        try { if (await state.data.cashDayClosed(pay.branch_id, day)) closed.push(day); } catch { /* not known: no warning */ }
      }
      const key = JSON.stringify([changes, closed]);
      if (closed.length && warned !== key) {
        warned = key;
        closedNote.textContent = `The cash of ${closed.map((x) => shortDate(x)).join(' and ')} at ${branchName(pay.branch_id) || 'this branch'} is already closed. That closing counted this payment as it was, so after this change its expected cash will not match. Tell the accountant to check that day's closing. Press Save changes again to save.`;
        closedNote.hidden = false;
        closedNote.scrollIntoView?.({ block: 'nearest' });
        return false;
      }
      try { await state.data.updatePayment(pay.id, changes); } catch (e) { toast(friendlyError(e), 'error', 10000); return false; }
      toast(changes.method ? `Payment saved as ${METHOD_WORDS[changes.method] || changes.method}.` : 'Payment saved.', 'ok');
      await afterSave(onDone);
      return undefined;
    } },
  ], { initialFocus: method });
}

/**
 * Issued invoices with what is still unpaid on each. Payments are matched to invoices when taken. Money paid ahead (a payment on no
 * invoice, one on an invoice since voided, or more than its invoice's total) goes towards the patient's other issued invoices, oldest
 * first (credit_used), as the patient's dues count it: every payment against every issued invoice. So an advance never leaves the
 * next invoice looking unpaid, to be collected again. A payment on an invoice waiting for its discount's approval stays with it.
 */
export function invoiceBalances(invoices, payments) {
  const list = invoices || [];
  const byId = new Map(list.map((i) => [i.id, i]));
  const totalOf = (i) => Number(i.total ?? i.subtotal - i.discount_amount);
  const paid = {};
  let ahead = 0;
  for (const p of payments || []) {
    const inv = p.invoice_id ? byId.get(p.invoice_id) : null;
    if (inv && inv.status !== 'void') paid[inv.id] = (paid[inv.id] || 0) + Number(p.amount);
    else if (!p.invoice_id || inv) ahead += Number(p.amount); // (a payment on an invoice not in the list is left out)
  }
  const issued = list.filter((i) => i.status === 'issued');
  for (const i of issued) ahead += Math.max(0, (paid[i.id] || 0) - totalOf(i));
  ahead = Math.max(0, ahead);
  const order = [...issued].sort((a, b) => String(a.issue_date || '').localeCompare(String(b.issue_date || '')) || String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.invoice_no || '').localeCompare(String(b.invoice_no || '')));
  const used = {};
  for (const i of order) {
    if (ahead <= 0) break;
    const open = Math.max(0, totalOf(i) - (paid[i.id] || 0));
    used[i.id] = Math.min(open, ahead);
    ahead -= used[i.id];
  }
  return issued.map((i) => {
    const own = paid[i.id] || 0;
    const credit = used[i.id] || 0;
    return { ...i, paid_amount: own + credit, credit_used: credit, remaining: Math.max(0, totalOf(i) - own - credit) };
  });
}

export async function paymentModal(patient, { branchId, dues, invoices, payments, onDone } = {}) {
  // Payments are taken against an invoice so each invoice shows what is still unpaid.
  let balances = [];
  try {
    if (!invoices) {
      let now;
      ({ invoices, payments, dues: now } = await state.data.patientBilling(patient.id));
      if (Number.isFinite(now)) dues = now; // (the row's dues may be from before an invoice made in the same dialog)
    }
    balances = invoiceBalances(invoices, payments).sort((a, b) => a.issue_date.localeCompare(b.issue_date));
  } catch { balances = []; }
  const open = balances.filter((i) => i.remaining > 0);
  const first = open[0];
  // A branch-restricted front desk reads only its own branches' payments (20261015000500): one taken at another branch leaves
  // its invoice looking unpaid here, while the dues count every branch. So the amount filled in is never more than the dues.
  const cap = can('dues.view') && Number.isFinite(dues) ? Math.max(0, dues) : Infinity;
  const fill = (i) => Math.min(i.remaining, cap) || '';
  const amount = h('input', { type: 'number', min: 1, step: 100, value: first ? fill(first) : dues > 0 ? dues : '' });
  const method = select([{ value: 'cash', label: 'Cash' }, { value: 'bank_transfer', label: 'Bank transfer' }, { value: 'card', label: 'Card' }, { value: 'cheque', label: 'Cheque' }, { value: 'other', label: 'Other' }], 'cash');
  const branchSel = select(myBranches().map((b) => ({ value: b.id, label: b.name })), branchId || defaultBranchId());
  const invoiceSel = select([
    ...open.map((i) => ({ value: i.id, label: `${i.invoice_no} · ${shortDate(i.issue_date)} · ${rupees(i.remaining)} unpaid` })),
    ...balances.filter((i) => i.remaining <= 0).map((i) => ({ value: i.id, label: `${i.invoice_no} · ${shortDate(i.issue_date)} · paid` })),
    { value: '', label: 'Not for a particular invoice (advance)' },
  ], first?.id || '', { onchange: (e) => { const i = open.find((x) => x.id === e.target.value); if (i && !refund?.checked) amount.value = fill(i); } });
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

/**
 * Where each installment of a plan stands: payments since the plan started are applied to installments in order. plan.paid, when the
 * data layer has it (installment_status: the patient's payments at every branch, 20261016000100), is used; else the payments given.
 */
export function planProgress(plan, payments) {
  const paid = Number.isFinite(plan.paid) ? plan.paid
    : (payments || []).filter((p) => dayOf(p.received_at) >= plan.starts_on).reduce((s, p) => s + Number(p.amount), 0);
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
