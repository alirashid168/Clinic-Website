// Stock: brackets, wires, elastics and consumables per branch. Every change
// is a "move" (received, used, adjustment) so the quantity is always explained.
import { h, mount, toast, friendlyError, modal, field, select, empty, shortDate, timeOf } from '../../ui/dom.js';
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
    modal('New stock item', h('div', { class: 'form-grid' }, field('Name', name), field('Category', category), field('Unit', unit), field('Supplier', supplier)), [
      { label: 'Cancel' },
      { label: 'Add item', primary: true, onClick: async () => {
        if (name.value.trim().length < 2) { toast('Write the item name.'); return false; }
        try { await d.saveInventoryItem({ name: name.value.trim(), category: category.value, unit: unit.value.trim() || 'pcs', supplier: supplier.value.trim() || null }); toast('Item added.', 'ok'); load(); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  };

  const move = (item, stock, reason) => {
    const qty = h('input', { type: 'number', min: 1, step: 1, value: 1 });
    const why = select(Object.entries(REASONS).map(([value, label]) => ({ value, label })), reason);
    const note = h('input', { placeholder: 'Optional note (batch, patient, reason)' });
    modal(`${item.name} · ${branchName(branchId)}`, h('div', {},
      h('p', { class: 'muted' }, `In stock now: ${Number(stock?.quantity || 0)} ${item.unit}`),
      h('div', { class: 'form-grid' }, field('What happened', why), field(`Quantity (${item.unit})`, qty)), field('Note', note)), [
      { label: 'Cancel' },
      { label: 'Save', primary: true, onClick: async () => {
        const n = Number(qty.value);
        if (!(n > 0)) { toast('Enter the quantity.'); return false; }
        const change = why.value === 'received' ? n : why.value === 'adjustment' ? n - Number(stock?.quantity || 0) : -n;
        if (change === 0) { toast('The count is already that.'); return false; }
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
    mount(out,
      low.length ? h('div', { class: 'alert alert-warning' }, h('strong', {}, `${low.length} item${low.length > 1 ? 's' : ''} at or below the reorder level: `), low.map((it) => it.name).join(', ')) : null,
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', {}, `Stock · ${branchName(branchId)}`), can('inventory.manage') ? h('button', { class: 'btn btn-primary btn-small', onclick: newItem }, 'New item') : null),
        items.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', {}, 'Category'), h('th', { class: 'right' }, 'In stock'), h('th', { class: 'right' }, 'Reorder at'), h('th', {}))),
          h('tbody', {}, items.map((it) => {
            const s = stockOf(it.id);
            const isLow = s && Number(s.reorder_level) > 0 && Number(s.quantity) <= Number(s.reorder_level);
            return h('tr', { style: { opacity: it.active ? 1 : .55 } },
              h('td', {}, h('strong', {}, it.name), it.supplier ? h('div', { class: 'muted' }, it.supplier) : null),
              h('td', {}, it.category),
              h('td', { class: 'right', style: { color: isLow ? 'var(--stop)' : '', fontWeight: isLow ? 700 : 400 } }, `${Number(s?.quantity || 0)} ${it.unit}`),
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
        moves.length ? h('table', { class: 'list' }, h('tbody', {}, moves.map((m) => h('tr', {},
          h('td', { class: 'nowrap muted' }, `${shortDate(m.created_at.slice(0, 10))} ${timeOf(m.created_at)}`),
          h('td', {}, itemName(m.item_id)),
          h('td', { class: 'right', style: { color: Number(m.change) < 0 ? 'var(--stop)' : 'var(--ok)', fontWeight: 700 } }, (Number(m.change) > 0 ? '+' : '') + Number(m.change)),
          h('td', {}, m.reason))))) : empty('No stock moves yet.')));
  }

  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Stock'), h('p', {}, 'Per branch. Record what comes in and what is used; the list warns when something runs low.')), branchSel),
    out);
  await load();
}
