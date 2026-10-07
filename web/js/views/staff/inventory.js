// Stock: brackets, wires, elastics and consumables per branch. Every change
// is a "move" (received, used, adjustment) so the quantity is always explained.
import { h, mount, toast, friendlyError, modal, field, select, empty, shortDate, timeOf, downloadCSV, todayISO, localISO, srOnly, showFormErrors, clearFieldErrors } from '../../ui/dom.js';
import { state, can, myBranches, defaultBranchId, branchName } from '../../state.js';

const CATEGORIES = ['brackets', 'wires', 'elastics', 'bonding', 'consumables', 'instruments', 'other'];
const REASONS = { received: 'Received (stock in)', used: 'Used in treatment', adjustment: 'Count correction', transfer: 'Sent to another branch' };

export async function renderInventory(root, params) {
  const d = state.data;
  let branchId = Number(params.get('branch')) || defaultBranchId();
  const branchSel = select(myBranches().map((b) => ({ value: b.id, label: b.name })), branchId, { 'aria-label': 'Branch', onchange: (e) => { branchId = Number(e.target.value); load(); } });
  const out = h('div', {});

  const newItem = () => {
    const name = h('input', { placeholder: 'e.g. 022 MBT brackets, upper' });
    const category = select(CATEGORIES.map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1) })), 'consumables');
    const unit = h('input', { value: 'pcs', placeholder: 'pcs, box, pack' });
    const supplier = h('input', { placeholder: 'Supplier (optional)' });
    const body = h('div', { class: 'form-grid' }, field('Name', name, null, { required: true }), field('Category', category), field('Unit', unit), field('Supplier', supplier));
    modal('New stock item', body, [
      { label: 'Cancel' },
      { label: 'Add item', primary: true, onClick: async () => {
        clearFieldErrors(body);
        if (name.value.trim().length < 2) { showFormErrors(body, [{ input: name, message: 'Write the item name.' }]); return false; }
        try { await d.saveInventoryItem({ name: name.value.trim(), category: category.value, unit: unit.value.trim() || 'pcs', supplier: supplier.value.trim() || null }); toast('Item added.', 'ok'); load(); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  };

  const move = (item, stock, reason) => {
    const qty = h('input', { type: 'number', min: 1, step: 1, value: 1 });
    const why = select(Object.entries(REASONS).map(([value, label]) => ({ value, label })), reason);
    const note = h('input', { placeholder: 'Optional note (batch, patient, reason)' });
    const body = h('div', {},
      h('p', { class: 'muted' }, `In stock now: ${Number(stock?.quantity || 0)} ${item.unit}`),
      h('div', { class: 'form-grid' }, field('What happened', why), field(`Quantity (${item.unit})`, qty, null, { required: true })), field('Note', note));
    modal(`${item.name} · ${branchName(branchId)}`, body, [
      { label: 'Cancel' },
      { label: 'Save', primary: true, onClick: async () => {
        clearFieldErrors(body);
        const n = Number(qty.value);
        if (!(n > 0)) { showFormErrors(body, [{ input: qty, message: 'Enter the quantity.' }]); return false; }
        const change = why.value === 'received' ? n : why.value === 'adjustment' ? n - Number(stock?.quantity || 0) : -n;
        if (change === 0) { showFormErrors(body, [{ input: qty, message: `The count is already ${n}.` }]); return false; }
        try { await d.moveStock({ branch_id: branchId, item_id: item.id, change, reason: note.value.trim() ? `${why.value}: ${note.value.trim()}` : why.value }); toast('Stock updated.', 'ok'); load(); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  };

  async function load() {
    let data;
    try { data = await d.inventory(branchId); } catch (e) { mount(out, empty(friendlyError(e))); return; }
    const { items, stock, moves } = data;
    const stockOf = (id) => stock.find((s) => s.item_id === id);
    const low = items.filter((it) => { const s = stockOf(it.id); return s && Number(s.reorder_level) > 0 && Number(s.quantity) <= Number(s.reorder_level); });
    const itemName = (id) => items.find((it) => it.id === id)?.name || '';
    // Reorder list for the supplier: what is low, grouped by supplier, with the quantity to bring stock back to twice the reorder level.
    const reorderRows = low.map((it) => { const s = stockOf(it.id); return { supplier: it.supplier || 'No supplier set', item: it.name, category: it.category, in_stock: Number(s.quantity), reorder_at: Number(s.reorder_level), order: Math.max(1, Number(s.reorder_level) * 2 - Number(s.quantity)), unit: it.unit }; })
      .sort((a, b) => a.supplier.localeCompare(b.supplier) || a.item.localeCompare(b.item));
    const bySupplier = reorderRows.reduce((m, r) => { (m[r.supplier] ||= []).push(r); return m; }, {});
    mount(out,
      low.length ? h('div', { class: 'alert alert-warning' }, h('strong', {}, `${low.length} item${low.length > 1 ? 's' : ''} at or below the reorder level: `), low.map((it) => it.name).join(', ')) : null,
      low.length ? h('section', { class: 'panel reorder-list' },
        h('div', { class: 'panel-head' }, h('h2', {}, `Reorder list · ${branchName(branchId)}`),
          h('button', { class: 'btn btn-small', onclick: () => downloadCSV(`reorder-list_${branchName(branchId).replace(/\W+/g, '-')}_${todayISO()}.csv`, reorderRows) }, 'Download for the supplier')),
        Object.entries(bySupplier).map(([sup, rows]) => h('div', { style: { marginBottom: '10px' } },
          h('h3', {}, sup),
          h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
            h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Item'), h('th', { scope: 'col', class: 'right' }, 'In stock'), h('th', { scope: 'col', class: 'right' }, 'Reorder at'), h('th', { scope: 'col', class: 'right' }, 'Order'))),
            h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.item), h('td', { class: 'right' }, `${r.in_stock} ${r.unit}`), h('td', { class: 'right' }, r.reorder_at), h('td', { class: 'right' }, h('strong', {}, `${r.order} ${r.unit}`)))))))))) : null,
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', {}, `Stock · ${branchName(branchId)}`), can('inventory.manage') ? h('button', { class: 'btn btn-primary btn-small', onclick: newItem }, 'New item') : null),
        items.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Item'), h('th', { scope: 'col' }, 'Category'), h('th', { scope: 'col', class: 'right' }, 'In stock'), h('th', { scope: 'col', class: 'right' }, 'Reorder at'), h('th', { scope: 'col' }, srOnly('Actions')))),
          h('tbody', {}, items.map((it) => {
            const s = stockOf(it.id);
            const isLow = s && Number(s.reorder_level) > 0 && Number(s.quantity) <= Number(s.reorder_level);
            // Inactive and low items say so in words; inactive rows are not dimmed, so they stay readable.
            return h('tr', { class: it.active ? null : 'is-inactive' },
              h('td', {}, h('strong', {}, it.name), it.active ? null : [' ', h('span', { class: 'badge badge-inactive' }, 'Inactive')], it.supplier ? h('div', { class: 'muted' }, it.supplier) : null),
              h('td', {}, it.category),
              h('td', { class: ['right', isLow && 'status-bad'] }, isLow ? h('strong', {}, `${Number(s?.quantity || 0)} ${it.unit}`) : `${Number(s?.quantity || 0)} ${it.unit}`, isLow ? [' ', h('span', { class: 'badge badge-warn' }, 'Low')] : null),
              h('td', { class: 'right' }, can('inventory.manage') ? h('input', { type: 'number', min: 0, value: s?.reorder_level ?? 0, style: { width: '80px' }, 'aria-label': `Reorder level for ${it.name}`,
                onchange: async (e) => { try { await d.setReorderLevel({ branch_id: branchId, item_id: it.id, reorder_level: Number(e.target.value) || 0 }); toast('Reorder level saved.', 'ok', 1500); } catch (err) { toast(friendlyError(err), 'error'); } } }) : (s?.reorder_level ?? 0)),
              h('td', { class: 'right nowrap' }, can('inventory.manage') ? [
                h('button', { class: 'btn btn-small', onclick: () => move(it, s, 'received') }, '+ Received'), ' ',
                h('button', { class: 'btn btn-small', onclick: () => move(it, s, 'used') }, '− Used'), ' ',
                h('button', { class: 'btn btn-small', onclick: () => move(it, s, 'adjustment') }, 'Count'),
              ] : null));
          }))))
          : empty('No stock items yet. Add brackets, wires, elastics and consumables with "New item".')),
      h('section', { class: 'panel' },
        h('h2', {}, 'Recent moves'),
        moves.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'When'), h('th', { scope: 'col' }, 'Item'), h('th', { scope: 'col', class: 'right' }, 'Change'), h('th', { scope: 'col' }, 'Reason'))),
          h('tbody', {}, moves.map((m) => h('tr', {},
            h('td', { class: 'nowrap muted' }, `${shortDate(localISO(new Date(m.created_at)))} ${timeOf(m.created_at)}`),
            h('td', {}, itemName(m.item_id)),
            h('td', { class: ['right', Number(m.change) < 0 ? 'status-bad' : 'status-ok'] }, h('strong', {}, (Number(m.change) > 0 ? '+' : '') + Number(m.change))),
            h('td', {}, m.reason)))))) : empty('No stock moves yet.')));
  }

  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Stock'), h('p', {}, 'Per branch. Record what comes in and what is used; the list warns when something runs low.')), branchSel),
    out);
  await load();
}
