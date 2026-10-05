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

export function paymentModal(patient, { branchId, dues, onDone } = {}) {
  const amount = h('input', { type: 'number', min: 1, step: 100, value: dues > 0 ? dues : '' });
  const method = select([{ value: 'cash', label: 'Cash' }, { value: 'bank_transfer', label: 'Bank transfer' }, { value: 'card', label: 'Card' }, { value: 'cheque', label: 'Cheque' }, { value: 'other', label: 'Other' }], 'cash');
  const branchSel = select(myBranches().map((b) => ({ value: b.id, label: b.name })), branchId || defaultBranchId());
  const notes = h('input', { placeholder: 'Optional' });
  const refund = can('billing.refund') ? h('input', { type: 'checkbox' }) : null;
  modal(`Take payment · ${patient.full_name}`, h('div', {},
    h('p', { class: 'muted' }, `Pending dues: ${rupees(Math.max(0, dues || 0))}`),
    h('div', { class: 'form-grid' }, field('Amount (Rs)', amount), field('Method', method), field('Branch', branchSel)),
    field('Notes', notes),
    refund ? h('label', { class: 'inline' }, refund, 'This is a refund (money given back)') : null), [
    { label: 'Cancel' },
    { label: 'Save payment', primary: true, onClick: async () => {
      const value = Number(amount.value);
      if (!(value > 0)) { toast('Enter an amount.'); return false; }
      try {
        await state.data.recordPayment({ patient_id: patient.id, branch_id: Number(branchSel.value), amount: refund?.checked ? -value : value, method: method.value, notes: notes.value || null });
        toast(refund?.checked ? 'Refund recorded.' : `Payment of ${rupees(value)} saved.`, 'ok');
        onDone?.();
      } catch (e) { toast(friendlyError(e), 'error'); return false; }
    } },
  ]);
}

export { branchName };
