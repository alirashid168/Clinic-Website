// Admin → Clinic setup: branches, doctors and assistants, doctor groups,
// treatment list and expense categories, editable without touching the database.
// Also the Retainer Record's team and status list, and Lab work's team, labs and work types.
import { h, mount, toast, friendlyError, modal, field, select, empty, rupees, srOnly, showFormErrors, clearFieldErrors, capFirst } from '../../ui/dom.js';
import { state, loadPublicRef, loadStaffRef } from '../../state.js';
import { PALETTE, TEAM_ROLES, STATUS_MEANS, colourClass, retainerStatuses, labWorkTypes, optionKey, pickColour, teamNameKey } from '../../lib/records.js';

const REGIONS = [{ value: '', label: 'Any city' }, { value: 'KHI', label: 'Karachi' }, { value: 'LHR', label: 'Lahore' }, { value: 'ISB', label: 'Islamabad' }];
const TREATMENT_CATEGORIES = ['braces', 'retainer', 'general', 'cosmetic', 'surgery', 'diagnostic'];
/** A switched-off record says so in words (rows are no longer dimmed, which made them hard to read). */
const off = (text) => h('span', { class: 'badge badge-inactive' }, text);

/**
 * A small table editor: one row per record, an "Edit" button per row and an
 * "Add" button. `columns` describe the form fields; `show` renders the cell; `check(value, out, row)` gives a
 * message when a value cannot be saved, shown at its field (or { field, message } for another field). onSave may
 * throw an error with a `field` key: the message is then shown at that field too.
 */
function editor({ title, help, rows, columns, onSave, addLabel = 'Add', fixedId = false }) {
  const form = (row) => {
    const inputs = {};
    for (const c of columns) {
      const v = row?.[c.key];
      if (c.type === 'select') inputs[c.key] = select(c.options(row), v ?? c.default ?? '');
      else if (c.type === 'check') inputs[c.key] = h('input', { type: 'checkbox', checked: row ? !!v : c.default !== false });
      else if (c.type === 'list') inputs[c.key] = h('input', { value: (v || []).join(', '), placeholder: c.placeholder || '' });
      else inputs[c.key] = h('input', { type: c.type || 'text', value: v ?? c.default ?? '', placeholder: c.placeholder || '', step: c.step, min: c.min, disabled: !!(row && c.lockOnEdit) });
    }
    const body = h('div', { class: 'form-grid' },
      columns.map((c) => c.type === 'check' ? h('label', { class: 'inline', style: { alignSelf: 'end', paddingBottom: '8px' } }, inputs[c.key], c.label) : field(c.label, inputs[c.key], c.help, { required: !!c.required })));
    modal(row ? `Edit · ${title}` : `${addLabel} · ${title}`, body, [
      { label: 'Cancel' },
      { label: 'Save', primary: true, onClick: async () => {
        clearFieldErrors(body);
        const out = row ? { id: row.id } : {};
        const errors = [];
        for (const c of columns) {
          const el = inputs[c.key];
          let v = c.type === 'check' ? el.checked : c.type === 'list' ? el.value.split(',').map((s) => s.trim()).filter(Boolean) : el.value;
          if (c.type === 'number') v = el.value === '' ? null : Number(el.value);
          if (c.type === 'select' && v === '') v = null;
          if (typeof v === 'string') v = v.trim() || null;
          if (c.required && (v === null || v === '' || v === undefined)) { errors.push({ input: el, message: `${c.label} is needed.` }); continue; }
          if (c.check && !(row && c.lockOnEdit)) {
            const msg = c.check(v, out, row);
            if (msg) { errors.push({ input: inputs[msg.field] || el, message: msg.message || msg }); continue; }
          }
          if (row && c.lockOnEdit) continue;
          out[c.key] = v;
        }
        if (errors.length) { showFormErrors(body, errors); return false; }
        if (fixedId && !row) out.id = Number(out.id);
        try { const said = await onSave(out); toast(typeof said === 'string' ? said : 'Saved.', 'ok'); } catch (e) {
          if (e?.field && inputs[e.field]) { showFormErrors(body, [{ input: inputs[e.field], message: e.message }]); return false; }
          toast(friendlyError(e), 'error'); return false;
        }
      } },
    ]);
  };
  // A drop-down column shows the drop-down's own wording ("Braces", not the stored "braces"); other text starts with a capital.
  const optionLabel = (c, v) => c.options().find((o) => String(o.value) === String(v ?? ''))?.label;
  const cell = (c, r) => (c.show ? c.show(r) : c.type === 'check' ? (r[c.key] ? 'Yes' : 'No') : c.type === 'list' ? (r[c.key] || []).join(', ')
    : c.type === 'select' ? (optionLabel(c, r[c.key]) ?? capFirst(r[c.key])) : typeof r[c.key] === 'string' ? capFirst(r[c.key]) : (r[c.key] ?? ''));
  const text = (v) => (v instanceof Node ? v.textContent : String(v ?? ''));
  // The table's columns: a column marked tableFirst (an order number) comes first in the table only; the form keeps the
  // fields' own order, and the Edit button is named after the first other column (the name).
  const shown = columns.filter((c) => !c.hideInTable);
  const tableCols = [...shown.filter((c) => c.tableFirst), ...shown.filter((c) => !c.tableFirst)];
  const nameCol = shown.find((c) => !c.tableFirst) || shown[0];
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, title), h('button', { class: 'btn btn-primary btn-small', onclick: () => form(null) }, addLabel)),
    help ? h('p', { class: 'muted' }, help) : null,
    rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, tableCols.map((c) => h('th', { scope: 'col', class: c.type === 'number' ? 'right' : '' }, c.label)), h('th', { scope: 'col' }, srOnly('Actions')))),
      h('tbody', {}, rows.map((r) => h('tr', { class: r.active === false ? 'is-inactive' : null },
        tableCols.map((c) => h('td', { class: c.type === 'number' ? 'right' : '' }, cell(c, r))),
        h('td', { class: 'right' }, h('button', { class: 'btn btn-small', 'aria-label': `Edit ${text(cell(nameCol, r))}`, onclick: () => form(r) }, 'Edit'))))))) : empty(`Nothing here yet. Use "${addLabel}".`));
}

// A colour of the fixed palette (lib/records.js; white text only on the dark ones), as a chip in the table.
const COLOUR_OPTIONS = () => PALETTE.map((p) => ({ value: p.key, label: `${p.label}${p.dark ? ' (white text)' : ''}` }));
const colourChip = (key) => h('span', { class: ['pill', colourClass(key)] }, PALETTE.find((p) => p.key === key)?.label || 'Light grey');

/**
 * The Retainer Record and Lab work lists. The two teams are tables; the status list and the work types are settings
 * (app_settings), edited here as rows: each row's Order is its place in the drop-down.
 */
async function recordEditors(d, refresh) {
  let rTeam, lTeam;
  try { [rTeam, lTeam] = await Promise.all([d.retainerTeam(), d.labTeam()]); } catch (e) {
    if (e?.code !== 'RECORDS_MISSING') throw e;
    return [h('section', { class: 'panel' }, h('h2', {}, 'Retainer team and lab team'), h('p', { class: 'muted' }, 'These lists appear once the database update for the Retainer Record and Lab work has been run.'))];
  }
  const cities = state.ref.cities.filter((c) => state.ref.branches.some((b) => b.city_id === c.id));
  const asRows = (list) => list.map((x, i) => ({ ...x, id: i + 1, order: i + 1 }));
  const saveList = (key, list) => async (row) => {
    const rows = asRows(list);
    const at = row.id ? rows.findIndex((x) => x.id === row.id) : -1;
    if (rows.some((x, i) => i !== at && optionKey(x.label) === optionKey(row.label))) throw new Error(`"${row.label}" is on the list already.`);
    // New words for an item: the rows that have the old words take the new ones too (public.rename_record_option), or they would drop
    // off the list as "not on the list", and a status that means made or delivered would stop counting in the banner.
    const old = at >= 0 ? rows[at].label : null;
    const renamed = old !== null && row.label && row.label !== old ? await d.renameRecordOption(key, old, row.label) : 0;
    const next = { ...(at >= 0 ? rows[at] : {}), ...row, order: row.order ?? rows.length + 1 };
    if (at >= 0) rows[at] = next; else rows.push(next);
    // A row moved to an Order another row has goes in front of it; the list is numbered 1, 2, 3 ... again when it is shown.
    const sorted = rows.map((x, i) => ({ x, i })).sort((a, b) => (Number(a.x.order) || 0) - (Number(b.x.order) || 0) || (a.x === next ? -1 : b.x === next ? 1 : a.i - b.i)).map(({ x }) => x);
    await d.setSetting(key, sorted.map(({ id, order, means, colour, ...keep }) => ({ ...keep, colour: colour || 'grey', ...(means ? { means } : {}) })));
    await refresh();
    return renamed ? `Saved. ${renamed.toLocaleString('en-PK')} ${renamed === 1 ? 'row now says' : 'rows now say'} "${row.label}".` : undefined;
  };
  // A name already on the team, in any capitals and spacing (the database's unique name: lab_team per kind), says so in plain words,
  // before saving and when the database refuses it (somebody added the name a moment ago).
  const sameNameAs = (list, row, kind = null) => list.find((m) => m.id !== row?.id && teamNameKey(m.name) === teamNameKey(row?.name) && (!kind || (m.kind || 'person') === kind));
  const alreadyText = (name, kind) => `${String(name).trim().replace(/\s+/g, ' ')} is already on ${kind === 'lab' ? 'the list of labs' : 'the team'}.`;
  const saveTeam = (fn) => async (row) => {
    try { await d[fn](row); } catch (e) {
      if (e?.code === '23505' || /_name_idx|duplicate key/.test(e?.message || '')) throw Object.assign(new Error(alreadyText(row.name, row.kind)), { field: 'name' });
      throw e;
    }
    await refresh();
  };
  const statuses = retainerStatuses(state.ref.settings);
  const works = labWorkTypes(state.ref.settings);
  return [
    editor({
      title: 'Retainer team', addLabel: 'New team member', rows: rTeam,
      help: 'The people on the Retainer Record\'s drop-downs. Each keeps their colour on every chip, in the Retainer Lab banner and in the filter. Tick "In the banner" for the people who make the retainers or check the models now (copying a sheet tab ticks its most active makers while nobody of that city is ticked, and gives them the strongest colours). Someone who left: untick Active (their old rows keep the name).',
      onSave: saveTeam('saveRetainerTeamMember'),
      columns: [
        { key: 'name', label: 'Name', required: true, placeholder: 'As on the sheet', check: (v, out) => (sameNameAs(rTeam, { ...out, name: v }) ? alreadyText(v) : null) },
        { key: 'role', label: 'Does', type: 'select', required: true, default: 'maker', options: () => Object.entries(TEAM_ROLES).map(([value, label]) => ({ value, label })) },
        // (a new member starts with a strong colour nobody has: light grey is the blank chip and "someone not on the team")
        { key: 'colour', label: 'Colour', type: 'select', required: true, default: pickColour(rTeam, { top: true }), options: COLOUR_OPTIONS, show: (r) => colourChip(r.colour) },
        { key: 'city_id', label: 'City', type: 'select', options: () => [{ value: '', label: 'Every city' }, ...cities.map((c) => ({ value: c.id, label: c.name }))], show: (r) => cities.find((c) => c.id === r.city_id)?.name || 'Every city' },
        { key: 'featured', label: 'In the banner', type: 'check', default: false, show: (r) => (r.featured ? 'In the banner' : '') },
        { key: 'sort_order', label: 'Order', type: 'number', default: 50, hideInTable: true },
        { key: 'active', label: 'Active', type: 'check', show: (r) => (r.active ? 'Active' : off('Left')) },
      ],
    }),
    editor({
      title: 'Retainer statuses', addLabel: 'New status', rows: asRows(statuses),
      help: 'The Status drop-down of the Retainer Record, in this order. "Means" ties a status to what it does: Retainer made fills the retainer date; Delivered fills the dates, sets the first retainer check a month later and says "Delivered!"; Cancelled is left out of the banner\'s counts and has no check to miss. A status taken off the drop-down stays on the rows that have it. A status written in other words changes on every row that has it too.',
      onSave: saveList('retainer_statuses', statuses),
      columns: [
        { key: 'order', label: 'Order', type: 'number', min: 1, required: true, default: statuses.length + 1, tableFirst: true },
        { key: 'label', label: 'Status', required: true },
        { key: 'colour', label: 'Colour', type: 'select', required: true, default: 'grey', options: COLOUR_OPTIONS, show: (r) => colourChip(r.colour) },
        { key: 'means', label: 'Means', type: 'select', options: () => Object.entries(STATUS_MEANS).map(([value, label]) => ({ value, label })), show: (r) => (r.means ? STATUS_MEANS[r.means].split(':')[0] : '') },
        { key: 'active', label: 'In the drop-down', type: 'check', show: (r) => (r.active ? 'Yes' : off('Hidden')) },
      ],
    }),
    editor({
      title: 'Lab team and labs', addLabel: 'New person or lab', rows: lTeam,
      help: 'The "Handled by" and "Lab" drop-downs of Lab work. A name not on the list can still be typed on a row.',
      onSave: saveTeam('saveLabTeamMember'),
      columns: [
        { key: 'name', label: 'Name', required: true },
        { key: 'kind', label: 'Is', type: 'select', required: true, default: 'person', options: () => [{ value: 'person', label: 'A person who handles lab work' }, { value: 'lab', label: 'A lab' }],
          check: (v, out, row) => (sameNameAs(lTeam, { ...out, id: row?.id, kind: v }, v || 'person') ? { field: 'name', message: alreadyText(out.name, v) } : null) },
        { key: 'colour', label: 'Colour', type: 'select', required: true, default: 'grey', options: COLOUR_OPTIONS, show: (r) => colourChip(r.colour) },
        { key: 'active', label: 'Active', type: 'check', show: (r) => (r.active ? 'Active' : off('Off')) },
      ],
    }),
    editor({
      title: 'Lab work types', addLabel: 'New work type', rows: asRows(works),
      help: 'The Work drop-down of Lab work, in this order. A work type written in other words changes on every lab case that has it too.',
      onSave: saveList('lab_work_types', works),
      columns: [
        { key: 'order', label: 'Order', type: 'number', min: 1, required: true, default: works.length + 1, tableFirst: true },
        { key: 'label', label: 'Work', required: true },
        { key: 'colour', label: 'Colour', type: 'select', default: 'grey', options: COLOUR_OPTIONS, show: (r) => colourChip(r.colour) },
        { key: 'active', label: 'In the drop-down', type: 'check', show: (r) => (r.active ? 'Yes' : off('Hidden')) },
      ],
    }),
  ];
}

export async function renderSetup(root) {
  const d = state.data;
  const lists = await d.setupLists();
  const refresh = async () => { await Promise.all([loadPublicRef(), loadStaffRef()]); renderSetup(root); };
  const save = (table) => async (row) => { await d.saveSetupRow(table, row); await refresh(); };
  const cityName = (id) => lists.cities.find((c) => c.id === id)?.name || '';
  const groupName = (id) => lists.groups.find((g) => g.id === id)?.name || '';
  // The table names every login, also one that is switched off or deleted; the drop-down offers only logins that are on and not
  // deleted, plus the one the row has now (so saving the row never drops its login without being asked).
  const staffName = (id) => lists.staff.find((s) => s.id === id)?.full_name || '';
  const doctorStaff = (row) => [{ value: '', label: 'No login yet' }, ...lists.staff
    .filter((s) => (s.role === 'doctor' || s.role === 'admin') && ((s.active && !s.deleted_at) || s.id === row?.staff_id))
    .map((s) => ({ value: s.id, label: s.deleted_at ? `${s.full_name} (deleted)` : s.active ? s.full_name : `${s.full_name} (switched off)` }))];
  const records = await recordEditors(d, refresh);
  // The price list and the Aaj ki List's visit types are both rows of public.treatments (treatments.price_list tells them apart), and a
  // name is used once among all of them: a name already there says so at its field.
  const visitTypes = lists.treatments.filter((t) => !t.price_list);
  const priceList = lists.treatments.filter((t) => t.price_list);
  const nameTaken = (v, row) => {
    const key = String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
    const other = lists.treatments.find((t) => t.id !== row?.id && String(t.name).trim().replace(/\s+/g, ' ').toLowerCase() === key);
    return other ? `"${other.name}" is already ${other.price_list ? 'on the price list' : 'a visit type of the Aaj ki List'}.` : null;
  };

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
        { key: 'phone', label: 'Phone', type: 'tel', placeholder: '021 xxxxxxx', help: 'Shown on the branch card on the website as a call link, so patients can still reach the branch if WhatsApp is not working.' },
        { key: 'opened_on', label: 'Opened on', type: 'date', help: 'Used in reports. Expenses before this day count as the branch\'s setup costs; patients and payments before it are flagged for checking.' },
        { key: 'sort_order', label: 'Order', type: 'number', default: 10, hideInTable: true },
        { key: 'active', label: 'Open (shown on the website)', type: 'check', show: (r) => (r.active ? 'Open' : off('Switched off')) },
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
        { key: 'aliases', label: 'Other spellings', type: 'list', hideInTable: true, placeholder: 'Dr A. Khan, A Khan', help: 'Names used on old sheets, separated by commas.' },
        { key: 'active', label: 'Active', type: 'check', show: (r) => (r.active ? 'Active' : off('Left')) },
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
    // The price list (owner, 15 Oct 2026: "braces kit should be given separate amounts as they are different. please take all payments
    // from the treatment price from healthwire"): what the invoice form offers first, each with its own price.
    editor({
      title: 'Price list', addLabel: 'New price-list item', rows: priceList,
      help: 'What is billed and for how much: the invoice form offers these first (then the visit types below that have a price), and the price fills the line\'s rate (it can still be changed on the invoice). Switched off, an item leaves the invoice form; old invoices keep it.',
      onSave: (row) => save('treatments')({ ...row, price_list: true }),
      columns: [
        { key: 'sort_order', label: 'Order', type: 'number', default: Math.max(0, ...priceList.map((t) => Number(t.sort_order) || 0)) + 1, tableFirst: true },
        { key: 'name', label: 'Name', required: true, placeholder: 'e.g. Braces Kit (Metal)', check: (v, out, row) => nameTaken(v, row) },
        { key: 'default_price', label: 'Price (Rs)', type: 'number', min: 0, step: 100, required: true, show: (r) => rupees(r.default_price ?? 0) },
        { key: 'category', label: 'Category', type: 'select', required: true, default: 'braces', options: () => TREATMENT_CATEGORIES.map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1) })), help: 'For the reports and the doctor percentage rules.' },
        { key: 'active', label: 'On the invoice form', type: 'check', show: (r) => (r.active ? 'Yes' : off('Switched off')) },
      ],
    }),
    editor({
      title: 'Treatments', addLabel: 'New treatment', rows: visitTypes,
      help: 'The Treatment drop-down of the Aaj ki List (the visit types). A visit type with a default price is also offered on invoices, after the price list.',
      onSave: save('treatments'),
      columns: [
        { key: 'name', label: 'Name', required: true, check: (v, out, row) => nameTaken(v, row) },
        { key: 'category', label: 'Category', type: 'select', required: true, default: 'general', options: () => TREATMENT_CATEGORIES.map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1) })) },
        { key: 'default_price', label: 'Default price (Rs)', type: 'number', min: 0, show: (r) => (r.default_price ? rupees(r.default_price) : '') },
        { key: 'is_braces_monthly', label: 'Counts as a braces monthly visit', type: 'check', show: (r) => (r.is_braces_monthly ? 'Monthly' : '') },
        { key: 'sort_order', label: 'Order', type: 'number', default: 50, hideInTable: true },
        { key: 'active', label: 'In the dropdown', type: 'check', show: (r) => (r.active ? 'Yes' : off('Hidden')) },
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
        { key: 'active', label: 'Active', type: 'check', show: (r) => (r.active ? 'Active' : off('Off')) },
      ],
    }),
    editor({
      title: 'Expense categories', addLabel: 'New category', rows: lists.categories,
      help: 'Categories for the Accounts → Expenses form. Imported Healthwire categories appear here too.',
      onSave: save('expense_categories'),
      columns: [
        { key: 'name', label: 'Name', required: true },
        // a new category is numbered after the last one, so the Order column keeps counting 1, 2, 3 ... (owner, 11 Oct 2026)
        { key: 'sort_order', label: 'Order', type: 'number', default: Math.max(0, ...lists.categories.map((c) => Number(c.sort_order) || 0)) + 1, tableFirst: true },
        { key: 'active', label: 'In the dropdown', type: 'check', show: (r) => (r.active ? 'Yes' : off('Hidden')) },
      ],
    }),
    records);
}
