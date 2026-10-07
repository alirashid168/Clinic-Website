// Admin → Duplicates: patients sharing a phone number, with a merge that moves
// everything (visits, invoices, payments, photos, documents, cases) onto one
// record and keeps the old Mr# in the notes.
import { h, mount, toast, friendlyError, modal, rupees, shortDate, empty, showFormErrors, clearFieldErrors } from '../../ui/dom.js';
import { state, branchName } from '../../state.js';

export async function renderDuplicates(root) {
  const d = state.data;
  let groups;
  try { groups = await d.patientDuplicates(); } catch (e) { mount(root, empty(friendlyError(e))); return; }
  const q = h('input', { type: 'search', placeholder: 'Filter by name, Mr# or phone', 'aria-label': 'Filter duplicates', style: { maxWidth: '360px' } });
  const list = h('div', {});

  const mergeGroup = (g, keep) => {
    const others = g.patients.filter((p) => p.id !== keep.id);
    // An irreversible merge: focus starts on Cancel, the confirm is styled as dangerous,
    // and it only runs once the person confirms they compared the records.
    const compared = h('input', { type: 'checkbox' });
    const body = h('div', {},
      h('p', {}, h('strong', {}, `Keep Mr# ${keep.mr_number} · ${keep.full_name}`), '. The following will be moved onto it and then removed:'),
      h('ul', {}, others.map((p) => h('li', {}, `Mr# ${p.mr_number} · ${p.full_name} — ${p.visits} visits, ${p.invoices} invoices${p.dues > 0 ? `, dues ${rupees(p.dues)}` : ''}`))),
      h('p', { class: 'muted' }, 'Visits, invoices, payments, photos, documents, braces and retainer cases, plans, reminders and complaints all move across; dues add up. Blank details (email, gender, date of birth, address) are filled from the removed record. The removed Mr# stays in the notes. This cannot be undone.'),
      h('label', { class: 'inline' }, compared, 'I have compared these records and they are the same person'));
    modal('Merge these records?', body, [
      { label: 'Cancel' },
      { label: `Merge ${others.length} into Mr# ${keep.mr_number}`, danger: true, onClick: async () => {
        if (!compared.checked) { showFormErrors(body, [{ input: compared, message: 'Tick this box once you have compared the records. Merging cannot be undone.' }]); return false; }
        clearFieldErrors(body);
        try {
          let visits = 0, invoices = 0, payments = 0;
          for (const p of others) { const r = await d.mergePatients(keep.id, p.id); visits += Number(r.visits || 0); invoices += Number(r.invoices || 0); payments += Number(r.payments || 0); }
          toast(`Merged: ${visits} visits, ${invoices} invoices and ${payments} payments now under Mr# ${keep.mr_number}.`, 'ok', 7000);
          renderDuplicates(root);
        } catch (e) { toast(friendlyError(e), 'error', 8000); return false; }
      } },
    ], { destructive: true });
  };

  const card = (g) => {
    let keepId = g.patients[0].id;
    const radios = g.patients.map((p) => h('input', { type: 'radio', name: `keep-${g.phone}`, value: p.id, checked: p.id === keepId, 'aria-label': `Keep Mr# ${p.mr_number}`, onchange: () => { keepId = p.id; } }));
    return h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, `${g.phone} · ${g.members} records`),
        h('button', { class: 'btn btn-small btn-primary', onclick: () => mergeGroup(g, g.patients.find((p) => p.id === keepId)) }, 'Merge into the ticked one')),
      h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Keep'), h('th', {}, 'Mr#'), h('th', {}, 'Name'), h('th', {}, 'Registered'), h('th', {}, 'Branch'), h('th', { class: 'right' }, 'Visits'), h('th', { class: 'right' }, 'Invoices'), h('th', { class: 'right' }, 'Dues'), h('th', {}, 'Last visit'))),
        h('tbody', {}, g.patients.map((p, i) => h('tr', {},
          h('td', {}, radios[i]),
          h('td', { class: 'mr' }, p.mr_number),
          h('td', {}, h('a', { href: `#/staff/patient/${p.id}`, target: '_blank' }, p.full_name)),
          h('td', { class: 'nowrap' }, shortDate(String(p.created_at || '').slice(0, 10))),
          h('td', {}, branchName(p.first_branch_id)),
          h('td', { class: 'right' }, p.visits), h('td', { class: 'right' }, p.invoices),
          h('td', { class: 'right', style: { color: Number(p.dues) > 0 ? 'var(--stop)' : '' } }, Number(p.dues) ? rupees(p.dues) : ''),
          h('td', { class: 'nowrap' }, shortDate(p.last_visit))))))));
  };

  const draw = () => {
    const t = q.value.trim().toLowerCase();
    const shown = t ? groups.filter((g) => g.phone.includes(t) || g.patients.some((p) => p.full_name.toLowerCase().includes(t) || String(p.mr_number).includes(t))) : groups;
    mount(list, shown.length ? shown.slice(0, 60).map(card) : empty(groups.length ? 'No group matches the filter.' : 'No two patients share a phone number.'),
      shown.length > 60 ? h('p', { class: 'muted' }, `Showing 60 of ${shown.length} groups. Use the filter to find a specific one.`) : null);
  };
  q.addEventListener('input', draw);
  mount(root,
    h('p', { class: 'muted' }, `${groups.length} phone numbers are shared by more than one patient record. Families often share one number, so merge only when it is clearly the same person (same name, dates that follow on). Open each name in a new tab to compare before merging.`),
    h('div', { style: { margin: '10px 0' } }, q),
    list);
  draw();
}
