// Admin → Clinic setup: branches, doctors and assistants, doctor groups,
// treatment list and expense categories, editable without touching the database.
import { h, mount, toast, friendlyError, modal, field, select, empty, rupees } from '../../ui/dom.js';
import { state, loadPublicRef, loadStaffRef } from '../../state.js';

const REGIONS = [{ value: '', label: 'Any city' }, { value: 'KHI', label: 'Karachi' }, { value: 'LHR', label: 'Lahore' }, { value: 'ISB', label: 'Islamabad' }];
const TREATMENT_CATEGORIES = ['braces', 'retainer', 'general', 'cosmetic', 'surgery', 'diagnostic'];

/**
 * A small table editor: one row per record, an "Edit" button per row and an
 * "Add" button. `columns` describe the form fields; `show` renders the cell.
 */
function editor({ title, help, rows, columns, onSave, addLabel = 'Add', fixedId = false }) {
  const form = (row) => {
    const inputs = {};
    for (const c of columns) {
      const v = row?.[c.key];
      if (c.type === 'select') inputs[c.key] = select(c.options(), v ?? c.default ?? '');
      else if (c.type === 'check') inputs[c.key] = h('input', { type: 'checkbox', checked: row ? !!v : c.default !== false });
      else if (c.type === 'list') inputs[c.key] = h('input', { value: (v || []).join(', '), placeholder: c.placeholder || '' });
      else inputs[c.key] = h('input', { type: c.type || 'text', value: v ?? c.default ?? '', placeholder: c.placeholder || '', step: c.step, min: c.min, disabled: !!(row && c.lockOnEdit) });
    }
    modal(row ? `Edit · ${title}` : `${addLabel} · ${title}`, h('div', { class: 'form-grid' },
      columns.map((c) => c.type === 'check' ? h('label', { class: 'inline', style: { alignSelf: 'end', paddingBottom: '8px' } }, inputs[c.key], c.label) : field(c.label, inputs[c.key], c.help))), [
      { label: 'Cancel' },
      { label: 'Save', primary: true, onClick: async () => {
        const out = row ? { id: row.id } : {};
        for (const c of columns) {
          const el = inputs[c.key];
          let v = c.type === 'check' ? el.checked : c.type === 'list' ? el.value.split(',').map((s) => s.trim()).filter(Boolean) : el.value;
          if (c.type === 'number') v = el.value === '' ? null : Number(el.value);
          if (c.type === 'select' && v === '') v = null;
          if (typeof v === 'string') v = v.trim() || null;
          if (c.required && (v === null || v === '' || v === undefined)) { toast(`${c.label} is needed.`); return false; }
          if (row && c.lockOnEdit) continue;
          out[c.key] = v;
        }
        if (fixedId && !row) out.id = Number(out.id);
        try { await onSave(out); toast('Saved.', 'ok'); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  };
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, title), h('button', { class: 'btn btn-primary btn-small', onclick: () => form(null) }, addLabel)),
    help ? h('p', { class: 'muted' }, help) : null,
    rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, columns.filter((c) => !c.hideInTable).map((c) => h('th', { class: c.type === 'number' ? 'right' : '' }, c.label)), h('th', {}))),
      h('tbody', {}, rows.map((r) => h('tr', { style: { opacity: r.active === false ? .55 : 1 } },
        columns.filter((c) => !c.hideInTable).map((c) => h('td', { class: c.type === 'number' ? 'right' : '' }, c.show ? c.show(r) : c.type === 'check' ? (r[c.key] ? 'Yes' : 'No') : c.type === 'list' ? (r[c.key] || []).join(', ') : (r[c.key] ?? ''))),
        h('td', { class: 'right' }, h('button', { class: 'btn btn-small', onclick: () => form(r) }, 'Edit'))))))) : empty(`Nothing here yet. Use "${addLabel}".`));
}

export async function renderSetup(root) {
  const d = state.data;
  const lists = await d.setupLists();
  const refresh = async () => { await Promise.all([loadPublicRef(), loadStaffRef()]); renderSetup(root); };
  const save = (table) => async (row) => { await d.saveSetupRow(table, row); await refresh(); };
  const cityName = (id) => lists.cities.find((c) => c.id === id)?.name || '';
  const groupName = (id) => lists.groups.find((g) => g.id === id)?.name || '';
  const staffName = (id) => lists.staff.find((s) => s.id === id)?.full_name || '';
  const doctorStaff = () => [{ value: '', label: 'No login yet' }, ...lists.staff.filter((s) => s.role === 'doctor' || s.role === 'admin').map((s) => ({ value: s.id, label: s.full_name }))];

  mount(root,
    h('p', { class: 'muted' }, 'Changes here apply everywhere straight away: the website, Aaj ki List dropdowns, invoices and reports. Switching something off keeps its history and hides it from new entries.'),
    editor({
      title: 'Branches', addLabel: 'New branch', rows: lists.branches,
      help: 'A branch that is switched off disappears from the website and from dropdowns; its old visits and payments stay.',
      onSave: save('branches'),
      columns: [
        { key: 'name', label: 'Name', required: true, placeholder: 'e.g. Gulshan (RJ Mall)' },
        { key: 'code', label: 'Short code', required: true, placeholder: 'GUL', help: 'Used in file names and reports.' },
        { key: 'city_id', label: 'City', type: 'select', required: true, options: () => lists.cities.map((c) => ({ value: c.id, label: c.name })), show: (r) => cityName(r.city_id) },
        { key: 'address', label: 'Address', hideInTable: true },
        { key: 'phone', label: 'Phone', hideInTable: true },
        { key: 'opened_on', label: 'Opened on', type: 'date', help: 'Expenses dated before this day are never put under this branch.' },
        { key: 'sort_order', label: 'Order', type: 'number', default: 10, hideInTable: true },
        { key: 'active', label: 'Open (shown on the website)', type: 'check', show: (r) => (r.active ? 'Open' : 'Switched off') },
      ],
    }),
    editor({
      title: 'Doctors and assistants', addLabel: 'New doctor / assistant', rows: lists.clinicians,
      help: 'Everyone who can be written on a visit. A doctor\'s group decides which braces months they may treat or check. Link a doctor to their login so their visits show in their daily log.',
      onSave: save('clinicians'),
      columns: [
        { key: 'display_name', label: 'Name as shown', required: true, placeholder: 'Dr. First Last' },
        { key: 'is_doctor', label: 'Doctor (untick for assistant / hygienist)', type: 'check', show: (r) => (r.is_doctor ? 'Doctor' : 'Assistant') },
        { key: 'doctor_group_id', label: 'Braces group', type: 'select', options: () => [{ value: '', label: 'No group (general / Dr. Ali)' }, ...lists.groups.map((g) => ({ value: g.id, label: g.name }))], show: (r) => groupName(r.doctor_group_id) },
        { key: 'region', label: 'City', type: 'select', options: () => REGIONS, show: (r) => REGIONS.find((x) => x.value === (r.region || ''))?.label || r.region },
        { key: 'staff_id', label: 'Login', type: 'select', options: doctorStaff, show: (r) => staffName(r.staff_id) || h('span', { class: 'muted' }, 'No login') },
        { key: 'aliases', label: 'Other spellings', type: 'list', hideInTable: true, placeholder: 'Samrah, Dr Samra', help: 'Names used on old sheets, separated by commas.' },
        { key: 'active', label: 'Active', type: 'check', show: (r) => (r.active ? 'Active' : 'Left') },
      ],
    }),
    editor({
      title: 'Doctor groups (braces protocol)', addLabel: 'New group', rows: lists.groups, fixedId: true,
      help: 'The braces protocol names groups by number (Group 1 treats photo months, Group 2 checks Group 3, and so on). Add a group only if the protocol changes.',
      onSave: save('doctor_groups'),
      columns: [
        { key: 'id', label: 'Group number', type: 'number', required: true, min: 1, lockOnEdit: true },
        { key: 'name', label: 'Name', required: true, placeholder: 'Group 4' },
        { key: 'description', label: 'What this group does' },
      ],
    }),
    editor({
      title: 'Treatments', addLabel: 'New treatment', rows: lists.treatments,
      help: 'The dropdown on Aaj ki List and on invoices. A default price fills the invoice line automatically.',
      onSave: save('treatments'),
      columns: [
        { key: 'name', label: 'Name', required: true },
        { key: 'category', label: 'Category', type: 'select', required: true, default: 'general', options: () => TREATMENT_CATEGORIES.map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1) })) },
        { key: 'default_price', label: 'Default price (Rs)', type: 'number', min: 0, show: (r) => (r.default_price ? rupees(r.default_price) : '') },
        { key: 'is_braces_monthly', label: 'Counts as a braces monthly visit', type: 'check', show: (r) => (r.is_braces_monthly ? 'Monthly' : '') },
        { key: 'sort_order', label: 'Order', type: 'number', default: 50, hideInTable: true },
        { key: 'active', label: 'In the dropdown', type: 'check', show: (r) => (r.active ? 'Yes' : 'Hidden') },
      ],
    }),
    editor({
      title: 'Doctor percentage rules', addLabel: 'New rule', rows: lists.commission_rules || [],
      help: 'The share a doctor earns on what they treat. Leave the doctor empty for a rule that applies to every doctor; leave the category empty for all treatments. Shown as an estimate on Accounts → Reports → Doctors (only invoices made from a visit on the website count).',
      onSave: save('doctor_commission_rules'),
      columns: [
        { key: 'clinician_id', label: 'Doctor', type: 'select', options: () => [{ value: '', label: 'Every doctor' }, ...lists.clinicians.filter((c) => c.is_doctor).map((c) => ({ value: c.id, label: c.display_name }))], show: (r) => lists.clinicians.find((c) => c.id === r.clinician_id)?.display_name || 'Every doctor' },
        { key: 'basis', label: 'Paid on', type: 'select', required: true, default: 'treated', options: () => [{ value: 'treated', label: 'Patients they treated' }, { value: 'referred', label: 'Patients they referred' }, { value: 'both', label: 'Treated and referred' }] },
        { key: 'percent', label: 'Percent', type: 'number', required: true, min: 0, step: 0.5, show: (r) => `${Number(r.percent)}%` },
        { key: 'treatment_category', label: 'Treatment category', type: 'select', options: () => [{ value: '', label: 'All treatments' }, ...['braces', 'retainer', 'general', 'cosmetic', 'surgery', 'diagnostic'].map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1) }))], show: (r) => r.treatment_category || 'All' },
        { key: 'notes', label: 'Notes', hideInTable: true },
        { key: 'active', label: 'Active', type: 'check', show: (r) => (r.active ? 'Active' : 'Off') },
      ],
    }),
    editor({
      title: 'Expense categories', addLabel: 'New category', rows: lists.categories,
      help: 'Categories for the Accounts → Expenses form. Imported Healthwire categories appear here too.',
      onSave: save('expense_categories'),
      columns: [
        { key: 'name', label: 'Name', required: true },
        { key: 'sort_order', label: 'Order', type: 'number', default: 50 },
        { key: 'active', label: 'In the dropdown', type: 'check', show: (r) => (r.active ? 'Yes' : 'Hidden') },
      ],
    }));
}
