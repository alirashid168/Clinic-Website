// Invoices: printable templates, new invoice form, payment form.
import { h, mount, rupees, shortDate, modal, field, select, toast, friendlyError, showFormErrors, clearFieldErrors, localISO, addMonthsISO, addDaysISO } from '../../ui/dom.js';
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

export function invoiceSheet(inv, patient, templateKey) {
  const t = TEMPLATES[templateKey || inv.template_key] || TEMPLATES.classic;
  const thermal = (templateKey || inv.template_key) === 'thermal';
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
 */
export function printInvoice(inv, patient, { patientView = state.session?.kind !== 'staff' } = {}) {
  let key = inv.template_key || 'classic';
  const holder = h('div', {});
  const draw = () => mount(holder, invoiceSheet(inv, patient, key));
  draw();
  const picker = patientView ? null : select(Object.entries(TEMPLATES).map(([value, t]) => ({ value, label: t.name })), key, { onchange: (e) => { key = e.target.value; draw(); } });
  modal(`Invoice ${inv.invoice_no}`, h('div', {}, picker ? field('Template', picker) : null, holder), [
    { label: 'Close' },
    { label: 'Print', primary: true, onClick: () => { printSheet(holder.firstElementChild); return false; } },
  ]);
}

/** New invoice for a patient. Calls onDone(invoice) after saving. */
export function newInvoiceModal(patient, { branchId, visitId, onDone } = {}) {
  // One key per opened form: pressing Save again after a failure cannot create a second invoice.
  const idempotencyKey = crypto.randomUUID();
  const branchSel = select(myBranches().map((b) => ({ value: b.id, label: b.name })), branchId || defaultBranchId());
  const lines = [];
  const linesBody = h('tbody', {});
  const totalEl = h('strong', {});
  const discount = h('input', { type: 'number', min: 0, step: 100, value: 0, oninput: () => recalc() });
  const reason = h('input', { placeholder: 'Reason (needed for discounts)' });
  const treatmentOptions = [{ value: '', label: 'Choose treatment…' }, ...state.ref.treatments.map((t) => ({ value: t.name, label: t.name }))];

  function addLine(desc = '', price = '') {
    const n = lines.length + 1;
    const line = {
      desc: h('input', { value: desc, list: 'treatment-list', 'aria-label': `Treatment, line ${n}` }),
      qty: h('input', { type: 'number', min: 1, value: 1, 'aria-label': `Qty, line ${n}`, oninput: () => recalc() }),
      price: h('input', { type: 'number', min: 0, step: 100, value: price, 'aria-label': `Price (Rs), line ${n}`, oninput: () => recalc() }),
    };
    lines.push(line);
    linesBody.append(h('tr', {}, h('td', {}, line.desc), h('td', {}, line.qty), h('td', {}, line.price)));
    recalc();
  }
  // An empty quantity means 1; a typed 0 or a negative number is an error (see Save), never a line that counts backwards.
  const qtyOf = (l) => (l.qty.value.trim() === '' ? 1 : Number(l.qty.value));
  const subtotalOf = () => lines.reduce((s, l) => s + Math.max(0, qtyOf(l)) * Math.max(0, Number(l.price.value || 0)), 0);
  function recalc() {
    const sub = subtotalOf();
    totalEl.textContent = `Subtotal ${rupees(sub)} · Total ${rupees(Math.max(0, sub - Math.max(0, Number(discount.value || 0))))}`;
  }
  const quick = select(treatmentOptions, '', { onchange: (e) => { if (e.target.value) { addLine(e.target.value); e.target.value = ''; } } });
  addLine();

  const body = h('div', {},
    h('datalist', { id: 'treatment-list' }, state.ref.treatments.map((t) => h('option', { value: t.name }))),
    field('Branch', branchSel),
    field('Add a treatment', quick),
    h('div', { class: 'table-scroll' }, h('table', { class: 'list invoice-lines' },
      h('caption', { class: 'sr-only' }, 'Invoice lines'),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Treatment'), h('th', { scope: 'col' }, 'Qty'), h('th', { scope: 'col' }, 'Price (Rs)'))),
      linesBody)),
    h('button', { class: 'btn btn-small', type: 'button', onclick: () => { addLine(); lines[lines.length - 1].desc.focus(); } }, 'Add line'),
    h('div', { class: 'form-grid', style: { marginTop: '12px' } },
      can('discount.give') ? field('Discount (Rs)', discount, 'Above your limit, it goes to the accountant or Dr. Ali for approval.') : null,
      can('discount.give') ? field('Discount reason', reason, 'Needed when there is a discount.') : null),
    h('p', {}, totalEl));

  modal(`New invoice · ${patient.full_name}`, body, [
    { label: 'Cancel' },
    { label: 'Save invoice', primary: true, onClick: async () => {
      clearFieldErrors(body);
      const errors = [];
      const filled = lines.filter((l) => l.desc.value.trim());
      for (const l of filled) {
        if (l.price.value === '') errors.push({ input: l.price, message: 'Enter a price for this treatment.' });
        else if (!(Number(l.price.value) >= 0)) errors.push({ input: l.price, message: 'The price cannot be negative.' });
        if (!(qtyOf(l) > 0)) errors.push({ input: l.qty, message: 'The quantity must be more than 0.' });
      }
      if (!filled.length) errors.push({ input: lines[0].desc, message: 'Add at least one treatment with a price.' });
      const sub = subtotalOf();
      const off = Number(discount.value || 0);
      if (!errors.length && !(sub > 0)) errors.push({ input: filled[0].price, message: 'The invoice total is Rs 0. Enter a price above zero.' });
      if (off < 0) errors.push({ input: discount, message: 'The discount cannot be negative.' });
      else if (!errors.length && off > sub) errors.push({ input: discount, message: `The discount cannot be more than the subtotal (${rupees(sub)}).` });
      if (off > 0 && !reason.value.trim()) errors.push({ input: reason, message: 'Write a reason for the discount.' });
      if (errors.length) { showFormErrors(body, errors); return false; }
      const items = filled.map((l) => ({ description: l.desc.value.trim(), quantity: qtyOf(l), unit_price: Number(l.price.value) }));
      try {
        const payload = { patient_id: patient.id, branch_id: Number(branchSel.value), items, discount_amount: off, discount_reason: reason.value.trim() || null, visit_id: visitId || null };
        // The key goes in the options argument (data contract); it is also on the payload for adapters that read it there.
        const inv = await state.data.createInvoice({ ...payload, idempotencyKey }, { idempotencyKey });
        toast(inv.status === 'pending_approval' ? 'Invoice saved. The discount is waiting for approval.' : `Invoice ${inv.invoice_no} saved.`, 'ok');
        onDone?.(inv);
      } catch (e) { toast(friendlyError(e), 'error'); return false; }
    } },
  ]);
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
        toast(refund?.checked ? 'Refund recorded.' : `Payment of ${rupees(value)} saved.`, 'ok');
        onDone?.();
      } catch (e) { toast(friendlyError(e), 'error'); return false; }
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

export function printReceipt(payment, patient, invoice, remainingDues) {
  const sheet = receiptSheet(payment, patient, invoice, remainingDues);
  modal('Payment receipt', sheet, [
    { label: 'Close' },
    { label: 'Print', primary: true, onClick: () => { printSheet(sheet); return false; } },
  ]);
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
  modal(`Installment plan · ${patient.full_name}`, body, [
    { label: 'Cancel' },
    { label: 'Save plan', primary: true, onClick: async () => {
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
        toast('Installment plan saved.', 'ok');
        onDone?.();
      } catch (e) { toast(friendlyError(e), 'error'); return false; }
    } },
  ]);
}

export { branchName };
