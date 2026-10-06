// Patients: search list and full patient profile.
import { h, mount, rupees, shortDate, toast, friendlyError, modal, field, select, empty } from '../../ui/dom.js';
import { state, can, branchName, isAdmin } from '../../state.js';
import { duesBadge, aliBadge, newPatientModal, flagForAliModal, photoUploadModal, documentUploadModal, DOCUMENT_KINDS, guidancePanel, STATUS_LABELS } from './common.js';
import { newInvoiceModal, paymentModal, printInvoice } from './invoice.js';

export async function renderPatients(root) {
  const d = state.data;
  const input = h('input', { type: 'search', placeholder: 'Search name, Mr# or phone', 'aria-label': 'Search patients' });
  const results = h('div', {});
  let timer;
  const run = async () => {
    try {
      const rows = await d.searchPatients(input.value);
      mount(results, rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Mr#'), h('th', {}, 'Name'), h('th', {}, 'Phone'), h('th', {}, 'Branch'), h('th', {}, ''), h('th', { class: 'right' }, 'Dues'))),
        h('tbody', {}, rows.map((p) => h('tr', {},
          h('td', { class: 'mr' }, p.mr_number),
          h('td', {}, h('a', { href: `#/staff/patient/${p.id}` }, p.full_name)),
          h('td', { class: 'nowrap' }, p.phone),
          h('td', {}, branchName(p.first_branch_id)),
          h('td', {}, h('span', { class: 'inline' }, p.braces_active ? h('span', { class: 'badge badge-muted' }, 'Braces') : null, duesBadge(p.dues), aliBadge(p.see_dr_ali))),
          h('td', { class: 'right' }, can('dues.view') && p.dues > 0 ? rupees(p.dues) : '')))))) : empty('No patients match this search.'));
    } catch (e) { toast(friendlyError(e), 'error'); }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
  mount(root,
    h('div', { class: 'page-head' }, h('h1', {}, 'Patients'),
      can('patients.create') ? h('button', { class: 'btn btn-primary', onclick: async () => { const p = await newPatientModal(''); if (p) location.hash = `#/staff/patient/${p.id}`; } }, 'New patient') : null),
    h('div', { class: 'panel' }, input, h('div', { style: { marginTop: '12px' } }, results)));
  run();
}

export async function renderPatient(root, id) {
  const d = state.data;
  const reload = () => renderPatient(root, id);
  let p;
  try { p = await d.getPatient(id); } catch (e) { mount(root, empty(friendlyError(e))); return; }
  const g = p.braces_case ? await d.bracesGuidance(id).catch(() => null) : null;
  const bc = p.braces_case;

  const editBraces = () => {
    const plan = select([{ value: 'undecided', label: 'Not decided yet' }, { value: 'extraction', label: 'Extraction case' }, { value: 'non_extraction', label: 'Non-extraction case' }], bc.extraction_plan);
    const done = h('input', { type: 'checkbox', checked: bc.extractions_done });
    const aliPlan = h('textarea', { value: bc.treatment_plan_by_dr_ali || '', placeholder: "Dr. Ali's treatment plan (Month 1)" });
    const kit = h('input', { value: bc.kit_name || '' });
    modal('Braces case', h('div', {}, field('Extraction plan', plan), h('label', { class: 'inline' }, done, 'All planned extractions are done'),
      field("Dr. Ali's treatment plan", aliPlan), field('Kit', kit)), [
      { label: 'Cancel' },
      { label: 'Save', primary: true, onClick: async () => {
        try {
          await d.updateBracesCase(bc.id, { extraction_plan: plan.value, extractions_done: done.checked, treatment_plan_by_dr_ali: aliPlan.value || null, kit_name: kit.value || null,
            extraction_decided_at: plan.value !== 'undecided' && bc.extraction_plan === 'undecided' ? new Date().toISOString().slice(0, 10) : bc.extraction_decided_at || null });
          toast('Braces case saved.', 'ok'); reload();
        } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  };

  const startBraces = () => {
    const start = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    const kit = select(['55k kit', '70k kit', '80k kit', '120k kit', 'Other'], '70k kit');
    const fee = h('input', { type: 'number', step: 1000, placeholder: 'Total fee (Rs)' });
    modal('Start braces case', h('div', {}, field('Bonding date', start), field('Kit', kit), field('Total fee', fee)), [
      { label: 'Cancel' },
      { label: 'Start case', primary: true, onClick: async () => {
        try { await d.startBracesCase(id, { start_date: start.value, kit_name: kit.value, total_fee: fee.value }); toast('Braces case started. Month 1 is next.', 'ok'); reload(); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  };

  const editPatient = () => {
    const name = h('input', { value: p.full_name });
    const phone = h('input', { type: 'tel', value: p.phone || '', placeholder: 'No number yet' });
    const email = h('input', { value: p.email || '' });
    const consent = h('input', { type: 'checkbox', checked: p.photo_consent_public });
    const notes = h('textarea', { value: p.notes || '' });
    const mr = isAdmin() ? h('input', { value: p.mr_number }) : null;
    modal('Edit patient', h('div', {}, mr ? field('Mr# (admin only)', mr) : null, field('Name', name), field('Phone', phone), field('Email', email),
      h('label', { class: 'inline', style: { marginBottom: '12px' } }, consent, 'Before/after photos may be shown publicly'), field('Notes', notes)), [
      { label: 'Cancel' },
      { label: 'Save', primary: true, onClick: async () => {
        const changes = { full_name: name.value.trim(), phone: phone.value.trim() || null, email: email.value.trim() || null, photo_consent_public: consent.checked, notes: notes.value || null };
        if (consent.checked && !p.photo_consent_public) changes.photo_consent_at = new Date().toISOString();
        if (mr && mr.value.trim() !== p.mr_number) changes.mr_number = mr.value.trim();
        try { await d.updatePatient(id, changes); toast('Saved.', 'ok'); reload(); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  };

  mount(root,
    h('p', {}, h('a', { href: '#/staff/patients' }, '← Patients')),
    h('div', { class: 'profile-head page-head' },
      h('div', {},
        h('h1', {}, p.full_name),
        h('p', {}, h('span', { class: 'mr' }, `Mr# ${p.mr_number}`), p.phone ? ` · ${p.phone}` : ' · No phone number', p.email ? ` · ${p.email}` : '', p.first_branch_id ? ` · ${branchName(p.first_branch_id)}` : ''),
        h('div', { class: 'inline', style: { marginTop: '6px' } }, duesBadge(p.dues), aliBadge(!!p.flag),
          p.photo_consent_public ? h('span', { class: 'badge badge-ok' }, 'Photo consent') : h('span', { class: 'badge badge-muted' }, 'No public photo consent'))),
      h('div', { class: 'inline' },
        can('patients.edit') ? h('button', { class: 'btn', onclick: editPatient }, 'Edit') : null,
        can('portal.invite') && !p.portal_user_id ? h('button', { class: 'btn', onclick: async () => {
          if (!p.email) return toast("Add the patient's email first (Edit), then invite them.");
          try { await d.invitePatient(id); toast(`Invitation sent to ${p.email}. They set their own password.`, 'ok'); reload(); } catch (e) { toast(friendlyError(e), 'error'); }
        } }, 'Invite to patient portal') : null,
        can('photos.upload') ? h('button', { class: 'btn', onclick: () => photoUploadModal(p, { onDone: reload }) }, 'Upload photos') : null,
        can('billing.create') ? h('button', { class: 'btn', onclick: () => newInvoiceModal(p, { onDone: reload }) }, 'New invoice') : null,
        can('billing.create') ? h('button', { class: 'btn btn-primary', onclick: () => paymentModal(p, { dues: p.dues, onDone: reload }) }, 'Take payment') : null)),
    p.flag ? h('div', { class: 'alert alert-warning inline', style: { justifyContent: 'space-between' } },
      h('span', {}, h('strong', {}, 'Next appointment with Dr. Ali Rashid. '), p.flag.reason),
      can('flags.clear') ? h('button', { class: 'btn btn-small', onclick: async () => { await d.clearFlag(p.flag.id, 'Seen by Dr. Ali'); toast('Flag cleared.', 'ok'); reload(); } }, 'Clear flag') : null)
      : can('flags.raise') ? h('p', {}, h('button', { class: 'link-btn', onclick: () => flagForAliModal(p, reload) }, 'Flag: next appointment with Dr. Ali Rashid')) : null,
    h('div', { class: 'grid-2' },
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', {}, 'Braces'),
          bc && can('braces.manage') ? h('button', { class: 'btn btn-small', onclick: editBraces }, 'Edit case') : null,
          !bc && can('braces.manage') ? h('button', { class: 'btn btn-small', onclick: startBraces }, 'Start braces case') : null),
        bc ? h('div', {},
          h('p', { class: 'muted' }, `Started ${shortDate(bc.start_date)} · ${bc.kit_name || 'kit not set'} · ${bc.extraction_plan.replace('_', '-')}${bc.extraction_plan === 'extraction' ? (bc.extractions_done ? ' (extractions done)' : ' (extractions pending)') : ''}`),
          guidancePanel(g)) : h('p', { class: 'muted' }, 'No active braces case.')),
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', {}, 'Money'), can('dues.view') ? h('strong', { style: { color: p.dues > 0 ? 'var(--stop)' : 'var(--ok)' } }, p.dues > 0 ? `${rupees(p.dues)} pending` : 'No dues') : null),
        p.invoices.length ? h('table', { class: 'list' }, h('tbody', {}, p.invoices.map((i) => h('tr', {},
          h('td', {}, h('button', { class: 'link-btn', onclick: () => printInvoice(i, p) }, i.invoice_no), h('div', { class: 'muted' }, shortDate(i.issue_date))),
          h('td', {}, i.status !== 'issued' ? h('span', { class: 'badge badge-warn' }, i.status.replace('_', ' ')) : null),
          h('td', { class: 'right' }, rupees(i.total ?? i.subtotal - i.discount_amount)),
          can('billing.edit') && i.status === 'issued' ? h('td', { class: 'right' }, h('button', { class: 'btn btn-small btn-danger', onclick: () => {
            const reason = h('input', { placeholder: 'Why is this invoice being voided?' });
            modal('Void invoice', field('Reason', reason), [{ label: 'Cancel' }, { label: 'Void invoice', primary: true, onClick: async () => {
              try { await d.voidInvoice(i.id, reason.value.trim()); toast('Invoice voided.', 'ok'); reload(); } catch (e) { toast(friendlyError(e), 'error'); return false; }
            } }]);
          } }, 'Void')) : h('td', {}))))) : h('p', { class: 'muted' }, 'No invoices.'),
        p.payments.length ? h('p', { class: 'muted', style: { marginTop: '10px' } }, `${p.payments.length} payments · ${rupees(p.payments.reduce((s, x) => s + Number(x.amount), 0))} received`) : null)),
    h('section', { class: 'panel' },
      h('h2', {}, 'Visits'),
      p.visits.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Branch'), h('th', {}, 'Treatment'), h('th', {}, 'Month'), h('th', {}, 'Doctors'), h('th', {}, 'Details'), h('th', {}, 'Status'))),
        h('tbody', {}, p.visits.map((v) => h('tr', {},
          h('td', { class: 'nowrap' }, shortDate(v.visit_date)), h('td', {}, branchName(v.branch_id)), h('td', {}, v.treatment_label || ''),
          h('td', {}, v.braces_month || ''), h('td', {}, v.staff.map((s) => s.role === 'checker' ? `✓ ${s.name}` : s.name).join(', ')),
          h('td', {}, v.details_text || ''), h('td', {}, STATUS_LABELS[v.status])))))) : empty('No visits yet.')),
    h('section', { class: 'panel' },
      h('h2', {}, 'Photos and X-rays'),
      p.photos.length ? h('div', { class: 'photo-grid' }, p.photos.map((ph) => h('figure', {},
        h('a', { href: ph.url || '#', target: '_blank', rel: 'noopener' }, h('img', { src: ph.url || '', alt: ph.view_label || 'Photo', loading: 'lazy' })),
        h('figcaption', {}, [shortDate(ph.taken_on), ph.view_label, ph.kind === 'raw' ? 'raw' : 'edited'].filter(Boolean).join(' · '))))) : empty('No photos yet.')),
    h('section', { class: 'panel' },
      h('div', { class: 'inline', style: { justifyContent: 'space-between', marginBottom: '8px' } }, h('h2', { style: { margin: 0 } }, 'Documents'),
        can('patients.edit') || can('photos.upload') ? h('button', { class: 'btn btn-small', onclick: () => documentUploadModal(p, { onDone: reload }) }, 'Add document') : null),
      (p.documents || []).length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Type'), h('th', {}, 'Title'), h('th', {}))),
        h('tbody', {}, p.documents.map((doc) => h('tr', {},
          h('td', { class: 'nowrap' }, shortDate(doc.added_on)), h('td', {}, DOCUMENT_KINDS[doc.kind] || doc.kind), h('td', {}, doc.title),
          h('td', { class: 'right' }, doc.url ? h('a', { class: 'btn btn-small', href: doc.url, target: '_blank', rel: 'noopener' }, 'Open') : h('span', { class: 'muted' }, 'Not available'))))))) : empty('No documents yet. Signed consent forms and ID copies go here.')),
    p.retainers.length ? h('section', { class: 'panel' }, h('h2', {}, 'Retainers'),
      h('table', { class: 'list' }, h('tbody', {}, p.retainers.map((r) => h('tr', {}, h('td', {}, r.arch), h('td', {}, r.stage.replace('_', ' ')), h('td', {}, shortDate(r.impression_date))))))) : null);
}
