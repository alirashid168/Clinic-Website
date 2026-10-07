// Invoices: printable templates, new invoice form, payment form.
import { h, mount, rupees, shortDate, modal, field, select, toast, friendlyError } from '../../ui/dom.js';
import { state, branchName, can, myBranches, defaultBranchId } from '../../state.js';
import { CONFIG } from '../../config.js';

export const TEMPLATES = {
  classic: { name: 'Classic', accent: '#3e2464' },
  minimal: { name: 'Minimal', accent: '#1f1a2b' },
  premium: { name: 'Premium', accent: '#b08d57' },
  thermal: { name: 'Thermal receipt (80mm)', accent: '#000000' },
};

export function invoiceSheet(inv, patient, templateKey) {
  const t = TEMPLATES[templateKey || inv.template_key] || TEMPLATES.classic;
  const thermal = (templateKey || inv.template_key) === 'thermal';
  const branch = state.ref.branches.find((b) => b.id === inv.branch_id);
  const items = inv.items || [];
  return h('div', { class: ['invoice-sheet', 'print-area', thermal && 'thermal'], style: { '--inv-accent': t.accent } },
    h('header', {},
      h('div', {}, h('strong', { style: { fontSize: thermal ? '14px' : '20px', color: t.accent } }, CONFIG.CLINIC_NAME),
        h('div', { class: 'muted' }, branch?.name || ''), h('div', { class: 'muted' }, branch?.address || '')),
      h('div', { class: 'right' }, h('strong', {}, inv.status === 'void' ? 'VOID' : 'Invoice'), h('div', {}, inv.invoice_no), h('div', { class: 'muted' }, shortDate(inv.issue_date)))),
    h('p', {}, h('strong', {}, patient?.full_name || ''), patient ? ` · Mr# ${patient.mr_number}` : ''),
    h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Treatment'), h('th', { class: 'right' }, 'Qty'), h('th', { class: 'right' }, 'Amount'))),
      h('tbody', {},
        items.map((it) => h('tr', {}, h('td', {}, it.description), h('td', { class: 'right' }, it.quantity), h('td', { class: 'right' }, rupees(it.quantity * it.unit_price)))),
        h('tr', {}, h('td', { colspan: 2 }, 'Subtotal'), h('td', { class: 'right' }, rupees(inv.subtotal))),
        Number(inv.discount_amount) ? h('tr', {}, h('td', { colspan: 2 }, 'Discount'), h('td', { class: 'right' }, '-' + rupees(inv.discount_amount))) : null,
        h('tr', {}, h('td', { colspan: 2 }, h('strong', {}, 'Total')), h('td', { class: 'right' }, h('strong', {}, rupees(inv.total ?? inv.subtotal - inv.discount_amount)))))),
    h('p', { class: 'muted', style: { marginTop: '16px', fontSize: '12px' } }, 'Thank you for choosing us. Keep this invoice for your records.'));
}

export function printInvoice(inv, patient) {
  let key = inv.template_key || 'classic';
  const holder = h('div', {});
  const draw = () => mount(holder, invoiceSheet(inv, patient, key));
  draw();
  const picker = select(Object.entries(TEMPLATES).map(([value, t]) => ({ value, label: t.name })), key, { onchange: (e) => { key = e.target.value; draw(); } });
  modal(`Invoice ${inv.invoice_no}`, h('div', {}, field('Template', picker), holder), [
    { label: 'Close' },
    { label: 'Print', primary: true, onClick: () => { window.print(); return false; } },
  ]);
}

/** New invoice for a patient. Calls onDone(invoice) after saving. */
export function newInvoiceModal(patient, { branchId, visitId, onDone } = {}) {
  const branchSel = select(myBranches().map((b) => ({ value: b.id, label: b.name })), branchId || defaultBranchId());
  const lines = [];
  const linesHost = h('div', {});
  const totalEl = h('strong', {});
  const discount = h('input', { type: 'number', min: 0, step: 100, value: 0, oninput: () => recalc() });
  const reason = h('input', { placeholder: 'Reason (needed for discounts)' });
  const treatmentOptions = [{ value: '', label: 'Choose treatment…' }, ...state.ref.treatments.map((t) => ({ value: t.name, label: t.name }))];

  function addLine(desc = '', price = '') {
    const line = { desc: h('input', { value: desc, placeholder: 'Description', list: 'treatment-list' }), qty: h('input', { type: 'number', min: 1, value: 1, style: { width: '70px' }, oninput: () => recalc() }), price: h('input', { type: 'number', min: 0, step: 100, value: price, placeholder: 'Rs', oninput: () => recalc() }) };
    lines.push(line);
    linesHost.append(h('div', { class: 'inline', style: { marginBottom: '8px' } }, line.desc, line.qty, line.price));
    recalc();
  }
  function recalc() {
    const sub = lines.reduce((s, l) => s + Number(l.qty.value || 1) * Number(l.price.value || 0), 0);
    totalEl.textContent = `Subtotal ${rupees(sub)} · Total ${rupees(Math.max(0, sub - Number(discount.value || 0)))}`;
  }
  const quick = select(treatmentOptions, '', { onchange: (e) => { if (e.target.value) { addLine(e.target.value); e.target.value = ''; } } });
  addLine();

  modal(`New invoice · ${patient.full_name}`, h('div', {},
    h('datalist', { id: 'treatment-list' }, state.ref.treatments.map((t) => h('option', { value: t.name }))),
    field('Branch', branchSel),
    field('Add a treatment', quick),
    linesHost,
    h('button', { class: 'btn btn-small', type: 'button', onclick: () => addLine() }, 'Add line'),
    h('div', { class: 'form-grid', style: { marginTop: '12px' } },
      can('discount.give') ? field('Discount (Rs)', discount, 'Above your limit, it goes to the accountant or Dr. Ali for approval.') : null,
      can('discount.give') ? field('Discount reason', reason) : null),
    h('p', {}, totalEl)), [
    { label: 'Cancel' },
    { label: 'Save invoice', primary: true, onClick: async () => {
      const items = lines.filter((l) => l.desc.value.trim() && Number(l.price.value) >= 0 && l.price.value !== '')
        .map((l) => ({ description: l.desc.value.trim(), quantity: Number(l.qty.value || 1), unit_price: Number(l.price.value) }));
      if (!items.length) { toast('Add at least one treatment with a price.'); return false; }
      if (Number(discount.value) > 0 && !reason.value.trim()) { toast('Write a reason for the discount.'); return false; }
      try {
        const inv = await state.data.createInvoice({ patient_id: patient.id, branch_id: Number(branchSel.value), items, discount_amount: Number(discount.value || 0), discount_reason: reason.value.trim() || null, visit_id: visitId || null });
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
  modal(`Take payment · ${patient.full_name}`, h('div', {},
    h('p', { class: 'muted' }, `Pending dues: ${rupees(Math.max(0, dues || 0))}`),
    h('div', { class: 'form-grid' }, field('Amount (Rs)', amount), field('Method', method), field('Branch', branchSel)),
    field('For invoice', invoiceSel, open.length ? 'Pick the invoice this money is for. The unpaid amount fills in by itself.' : 'No unpaid invoice. An advance counts towards the next invoice.'),
    field('Notes', notes),
    refund ? h('label', { class: 'inline' }, refund, 'This is a refund (money given back)') : null), [
    { label: 'Cancel' },
    { label: 'Save payment', primary: true, onClick: async () => {
      const value = Number(amount.value);
      if (!(value > 0)) { toast('Enter an amount.'); return false; }
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
  return h('div', { class: 'invoice-sheet print-area', style: { '--inv-accent': TEMPLATES.classic.accent } },
    h('header', {},
      h('div', {}, h('strong', { style: { fontSize: '20px', color: TEMPLATES.classic.accent } }, CONFIG.CLINIC_NAME),
        h('div', { class: 'muted' }, branch?.name || ''), h('div', { class: 'muted' }, branch?.address || '')),
      h('div', { class: 'right' }, h('strong', {}, Number(payment.amount) < 0 ? 'Refund' : 'Payment receipt'), h('div', {}, shortDate(String(payment.received_at).slice(0, 10))),
        h('div', { class: 'muted' }, `No. ${String(payment.id || '').slice(0, 8).toUpperCase()}`))),
    h('p', {}, h('strong', {}, patient?.full_name || ''), patient ? ` · Mr# ${patient.mr_number}` : ''),
    h('table', { class: 'list' }, h('tbody', {},
      h('tr', {}, h('td', {}, Number(payment.amount) < 0 ? 'Refunded' : 'Received'), h('td', { class: 'right' }, h('strong', {}, rupees(Math.abs(Number(payment.amount)))))),
      h('tr', {}, h('td', {}, 'By'), h('td', { class: 'right' }, method)),
      invoice ? h('tr', {}, h('td', {}, 'For invoice'), h('td', { class: 'right' }, `${invoice.invoice_no} · ${shortDate(invoice.issue_date)} · ${rupees(invoice.total ?? invoice.subtotal - invoice.discount_amount)}`)) : null,
      remainingDues !== undefined && remainingDues !== null ? h('tr', {}, h('td', {}, 'Still to pay'), h('td', { class: 'right' }, rupees(Math.max(0, remainingDues)))) : null,
      payment.notes ? h('tr', {}, h('td', {}, 'Notes'), h('td', { class: 'right' }, payment.notes)) : null)),
    h('p', { class: 'muted', style: { marginTop: '16px', fontSize: '12px' } }, 'Thank you. Keep this receipt for your records.'));
}

export function printReceipt(payment, patient, invoice, remainingDues) {
  modal('Payment receipt', receiptSheet(payment, patient, invoice, remainingDues), [
    { label: 'Close' },
    { label: 'Print', primary: true, onClick: () => { window.print(); return false; } },
  ]);
}

const PLAN_STATUS = { paid: ['badge-ok', 'Paid'], overdue: ['badge-dues', 'Overdue'], due_soon: ['badge-warn', 'Due soon'], upcoming: ['badge-muted', 'Upcoming'] };

/** Where each installment of a plan stands: payments since the plan started are applied to installments in order. */
export function planProgress(plan, payments) {
  const paid = (payments || []).filter((p) => p.received_at.slice(0, 10) >= plan.starts_on).reduce((s, p) => s + Number(p.amount), 0);
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
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
    h('table', { class: 'list' }, h('tbody', {}, prog.rows.map((r) => h('tr', {},
      h('td', { class: 'nowrap' }, shortDate(r.due_date)), h('td', {}, r.note || ''), h('td', { class: 'right' }, rupees(r.amount)),
      h('td', {}, h('span', { class: ['badge', PLAN_STATUS[r.status][0]] }, PLAN_STATUS[r.status][1])))))));
}

/** Set up an installment plan: total split into equal parts from a first due date. */
export function installmentPlanModal(patient, { totalFee, bracesCaseId, onDone } = {}) {
  const total = h('input', { type: 'number', min: 1, step: 1000, value: totalFee || '' });
  const count = h('input', { type: 'number', min: 1, max: 36, value: 6 });
  const firstDue = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
  const every = select([{ value: 1, label: 'Every month' }, { value: 2, label: 'Every 2 months' }, { value: 3, label: 'Every 3 months' }], 1);
  const startsOn = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
  const notes = h('input', { placeholder: 'e.g. 70k braces kit, Rs 10,000 at bonding then monthly' });
  const preview = h('div', {});
  let rows = [];
  const build = () => {
    const t = Number(total.value) || 0; const n = Math.max(1, Math.min(36, Number(count.value) || 1));
    const base = Math.floor(t / n / 100) * 100;
    rows = Array.from({ length: n }, (_, k) => {
      const d = new Date(firstDue.value + 'T00:00:00'); d.setMonth(d.getMonth() + k * Number(every.value));
      return { due_date: d.toISOString().slice(0, 10), amount: k === n - 1 ? t - base * (n - 1) : base, note: `Installment ${k + 1} of ${n}` };
    });
    mount(preview, t > 0 ? h('table', { class: 'list' }, h('tbody', {}, rows.map((r, k) => h('tr', {},
      h('td', { class: 'nowrap' }, shortDate(r.due_date)), h('td', {}, r.note),
      h('td', { class: 'right' }, h('input', { type: 'number', min: 0, step: 100, value: r.amount, style: { width: '110px' }, 'aria-label': `Amount ${k + 1}`, oninput: (e) => { rows[k].amount = Number(e.target.value) || 0; } })))))) : null);
  };
  [total, count, firstDue, every].forEach((el) => el.addEventListener('change', build));
  build();
  modal(`Installment plan · ${patient.full_name}`, h('div', {},
    h('p', { class: 'muted' }, 'Payments taken from the start date are counted towards the installments in order, so the coordinator sees who is behind.'),
    h('div', { class: 'form-grid' }, field('Total to pay (Rs)', total), field('Number of installments', count), field('First installment due', firstDue), field('Then', every), field('Count payments from', startsOn, 'Usually the bonding date.')),
    field('Notes', notes),
    preview), [
    { label: 'Cancel' },
    { label: 'Save plan', primary: true, onClick: async () => {
      const t = Number(total.value);
      if (!(t > 0)) { toast('Enter the total.'); return false; }
      const sum = rows.reduce((s, r) => s + Number(r.amount), 0);
      if (Math.round(sum) !== Math.round(t)) { toast(`The installments add up to ${rupees(sum)}, not ${rupees(t)}.`); return false; }
      if (rows.some((r) => !(r.amount > 0))) { toast('Every installment needs an amount.'); return false; }
      try {
        await state.data.savePaymentPlan({ patient_id: patient.id, braces_case_id: bracesCaseId || null, total_fee: t, starts_on: startsOn.value, notes: notes.value.trim() || null, installments: rows });
        toast('Installment plan saved.', 'ok');
        onDone?.();
      } catch (e) { toast(friendlyError(e), 'error'); return false; }
    } },
  ]);
}

export { branchName };
