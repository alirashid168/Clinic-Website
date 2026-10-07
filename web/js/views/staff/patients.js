// Patients: search list and full patient profile.
import { h, mount, rupees, shortDate, toast, friendlyError, modal, field, select, empty, phoneLink, busy, srOnly, localISO, addMonthsISO } from '../../ui/dom.js';
import { state, can, branchName, isAdmin, clinicianName } from '../../state.js';
import { duesBadge, aliBadge, newPatientModal, flagForAliModal, photoUploadModal, documentUploadModal, DOCUMENT_KINDS, guidancePanel, STATUS_LABELS } from './common.js';
import { newInvoiceModal, paymentModal, printInvoice, invoiceBalances, installmentPlanModal, planTable, planProgress, printReceipt } from './invoice.js';

export const MEDICAL_CONDITIONS = ['Diabetes', 'High blood pressure', 'Heart condition', 'Bleeding disorder', 'Pregnancy', 'Asthma', 'Epilepsy', 'Thyroid', 'Hepatitis / HIV', 'Kidney disease'];

/** The Karachi calendar day of a timestamp (its UTC day is a day behind before 5 AM PKT). */
const dayOf = (ts) => (ts ? localISO(new Date(ts)) : '');
const THUMB_WIDTH = 240;

export async function renderPatients(root, params) {
  const d = state.data;
  const input = h('input', { type: 'search', placeholder: 'Search name, Mr# or phone', 'aria-label': 'Search patients', value: params?.get('q') || '' });
  const results = h('div', {});
  let timer;
  const run = async () => {
    try {
      const rows = await d.searchPatients(input.value);
      mount(results, rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Mr#'), h('th', { scope: 'col' }, 'Name'), h('th', { scope: 'col' }, 'Phone'), h('th', { scope: 'col' }, 'Branch'), h('th', { scope: 'col' }, 'Flags'), h('th', { scope: 'col', class: 'right' }, 'Dues'))),
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
  if (params?.get('new') && can('patients.create')) { history.replaceState(null, '', '#/staff/patients'); const p = await newPatientModal(''); if (p) location.hash = `#/staff/patient/${p.id}`; }
}

export async function renderPatient(root, id) {
  const d = state.data;
  const reload = () => renderPatient(root, id);
  let p;
  try { p = await d.getPatient(id); } catch (e) { mount(root, empty(friendlyError(e))); return; }
  const g = p.braces_case ? await d.bracesGuidance(id).catch(() => null) : null;
  const bc = p.braces_case;
  const balances = Object.fromEntries(invoiceBalances(p.invoices, p.payments).map((i) => [i.id, i]));
  const today = localISO();

  const editBraces = () => {
    const plan = select([{ value: 'undecided', label: 'Not decided yet' }, { value: 'extraction', label: 'Extraction case' }, { value: 'non_extraction', label: 'Non-extraction case' }], bc.extraction_plan);
    const done = h('input', { type: 'checkbox', checked: bc.extractions_done });
    const aliPlan = h('textarea', { value: bc.treatment_plan_by_dr_ali || '', placeholder: "Dr. Ali's treatment plan (Month 1)" });
    const kit = h('input', { value: bc.kit_name || '' });
    const fee = h('input', { type: 'number', step: 1000, value: bc.total_fee || '' });
    const off = select([{ value: 'active', label: 'Braces still on' }, { value: 'debonded', label: 'Braces removed (case finished)' }, { value: 'discontinued', label: 'Stopped before finishing' }], 'active');
    const offDate = h('input', { type: 'date', value: localISO() });
    const offWrap = field('Date braces came off', offDate);
    offWrap.style.display = 'none';
    off.addEventListener('change', () => { offWrap.style.display = off.value === 'active' ? 'none' : ''; });
    modal('Braces case', h('div', {}, field('Extraction plan', plan), h('label', { class: 'inline' }, done, 'All planned extractions are done'),
      field("Dr. Ali's treatment plan", aliPlan), h('div', { class: 'form-grid' }, field('Kit', kit), field('Total fee (Rs)', fee)),
      h('div', { class: 'form-grid', style: { marginTop: '8px' } }, field('Case status', off), offWrap)), [
      { label: 'Cancel' },
      { label: 'Save', primary: true, onClick: async () => {
        try {
          const changes = { extraction_plan: plan.value, extractions_done: done.checked, treatment_plan_by_dr_ali: aliPlan.value || null, kit_name: kit.value || null,
            total_fee: fee.value ? Number(fee.value) : null,
            extraction_decided_at: plan.value !== 'undecided' && bc.extraction_plan === 'undecided' ? localISO() : bc.extraction_decided_at || null };
          if (off.value !== 'active') { changes.status = off.value; changes.debond_date = offDate.value || localISO(); }
          await d.updateBracesCase(bc.id, changes);
          toast('Braces case saved.', 'ok');
          if (off.value === 'debonded') startRetainerAfterBraces(bc, changes.debond_date);
          else reload();
        } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  };

  // Braces off → retainers next: offer to open the retainer case straight away.
  const startRetainerAfterBraces = (braces, offDate) => {
    const arch = select([{ value: 'both', label: 'Upper and lower' }, { value: 'upper', label: 'Upper' }, { value: 'lower', label: 'Lower' }], 'both');
    // One calendar month after the braces came off, worked out on the date itself (never a day early in Pakistan).
    const nextCheck = h('input', { type: 'date', value: offDate ? addMonthsISO(offDate, 1) : '' });
    modal('Braces are off — start the retainer case?', h('div', {},
      h('p', {}, 'Retainers are made in-house. The case starts at the impression stage and appears on the Coordinator → Retainers list, with a reminder for the first check.'),
      h('div', { class: 'form-grid' }, field('Arch', arch), field('First retainer check', nextCheck))), [
      { label: 'Not now', onClick: () => reload() },
      { label: 'Start retainer case', primary: true, onClick: async () => {
        try {
          await d.saveRetainerCase({ patient_id: id, braces_case_id: braces.id, branch_id: p.first_branch_id || null, arch: arch.value, stage: 'impression', impression_date: offDate, next_check_date: nextCheck.value || null });
          toast('Retainer case started.', 'ok'); reload();
        } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  };

  const startBraces = () => {
    const start = h('input', { type: 'date', value: localISO() });
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
    const mh = p.medical_history || {};
    const condBoxes = MEDICAL_CONDITIONS.map((c) => ({ c, box: h('input', { type: 'checkbox', checked: (mh.conditions || []).includes(c) }) }));
    const allergies = h('input', { value: mh.allergies || '', placeholder: 'e.g. penicillin, latex' });
    const medications = h('input', { value: mh.medications || '', placeholder: 'Regular medicines' });
    const mhNotes = h('input', { value: mh.notes || '', placeholder: 'Anything else the doctor should know' });
    const treatConsent = h('input', { type: 'checkbox', checked: !!p.treatment_consent_at });
    const ownDoctor = select([{ value: '', label: "Clinic's patient (Dr. Ali)" }, ...state.ref.clinicians.filter((c) => c.is_doctor && c.display_name !== 'Dr. Ali Rashid').map((c) => ({ value: c.id, label: c.display_name }))], p.referred_by_clinician || '');
    modal('Edit patient', h('div', {}, mr ? field('Mr# (admin only)', mr) : null, field('Name', name), field('Phone', phone), field('Email', email),
      field('Brought in by doctor', ownDoctor, "A doctor's own patient: their percentage (Admin → Clinic setup) is counted on this patient's bills."),
      h('label', { class: 'inline', style: { marginBottom: '12px' } }, consent, 'Before/after photos may be shown publicly'),
      h('h3', {}, 'Medical history'),
      h('div', { class: 'inline', style: { marginBottom: '8px' } }, condBoxes.map(({ c, box }) => h('label', { class: 'inline' }, box, c))),
      h('div', { class: 'form-grid' }, field('Allergies', allergies), field('Medications', medications), field('Other', mhNotes)),
      h('label', { class: 'inline', style: { margin: '10px 0' } }, treatConsent, p.treatment_consent_at ? `Treatment consent signed (${shortDate(dayOf(p.treatment_consent_at))})` : 'Treatment consent form signed'),
      field('Notes', notes)), [
      { label: 'Cancel' },
      { label: 'Save', primary: true, onClick: async () => {
        const changes = { full_name: name.value.trim(), phone: phone.value.trim() || null, email: email.value.trim() || null, photo_consent_public: consent.checked, notes: notes.value || null, referred_by_clinician: ownDoctor.value || null,
          medical_history: { conditions: condBoxes.filter((x) => x.box.checked).map((x) => x.c), allergies: allergies.value.trim() || null, medications: medications.value.trim() || null, notes: mhNotes.value.trim() || null, updated_at: localISO() } };
        if (consent.checked && !p.photo_consent_public) changes.photo_consent_at = new Date().toISOString();
        if (treatConsent.checked && !p.treatment_consent_at) changes.treatment_consent_at = new Date().toISOString();
        if (!treatConsent.checked && p.treatment_consent_at) changes.treatment_consent_at = null;
        if (mr && mr.value.trim() !== p.mr_number) changes.mr_number = mr.value.trim();
        try { await d.updatePatient(id, changes); toast('Saved.', 'ok'); reload(); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  };

  // Clearing the flag takes the patient off Dr. Ali's list, so it asks first.
  const clearFlag = () => modal('Clear this flag?', h('p', {}, `${p.full_name} will no longer be marked for their next appointment with Dr. Ali Rashid. Staff can flag them again at any time.`), [
    { label: 'Cancel' },
    { label: 'Clear flag', primary: true, onClick: async () => {
      try { await d.clearFlag(p.flag.id, 'Seen by Dr. Ali'); toast('Flag cleared.', 'ok'); reload(); } catch (e) { toast(friendlyError(e), 'error'); return false; }
    } },
  ]);

  const voidInvoice = (i) => {
    const reason = h('input', { placeholder: 'Why is this invoice being voided?' });
    modal(`Void invoice ${i.invoice_no}?`, h('div', {},
      h('p', {}, `The invoice for ${rupees(i.total ?? i.subtotal - i.discount_amount)} stays on record, marked VOID, with your reason.`),
      field('Reason', reason)), [
      { label: 'Cancel' },
      { label: 'Void invoice', danger: true, onClick: async () => {
        try { await d.voidInvoice(i.id, reason.value.trim()); toast('Invoice voided.', 'ok'); reload(); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ], { destructive: true, initialFocus: reason });
  };

  const removePlan = (plan) => modal('Remove this plan?', h('p', {}, 'The payments stay; only the schedule is removed.'), [
    { label: 'Keep' },
    { label: 'Remove plan', danger: true, onClick: async () => { try { await d.deletePaymentPlan(plan.id); toast('Plan removed.', 'ok'); reload(); } catch (e) { toast(friendlyError(e), 'error'); return false; } } },
  ], { destructive: true });

  // Photos: thumbnails in the grid instead of full-size camera originals, signed in one request.
  // A signed link expires after an hour, so an image that fails to load is signed again once.
  const photoItems = p.photos.map((ph) => {
    const img = h('img', { alt: ph.view_label || 'Photo', loading: 'lazy', decoding: 'async' });
    const link = h('a', { href: ph.url || '#', target: '_blank', rel: 'noopener' }, img);
    img.addEventListener('error', async () => {
      if (img.dataset.resigned || !d.signedUrls) return;
      img.dataset.resigned = '1';
      try {
        const [thumb, full] = await Promise.all([d.signedUrls([ph.storage_path], { width: THUMB_WIDTH }), d.signedUrls([ph.storage_path])]);
        const t = thumb?.get?.(ph.storage_path); const f = full?.get?.(ph.storage_path);
        if (f) link.href = f;
        if (t || f) img.src = t || f;
      } catch { /* the broken image stays; reloading the page signs everything again */ }
    });
    return { ph, img, link };
  });
  const loadThumbs = async () => {
    if (!photoItems.length) return;
    const paths = (list) => list.map((x) => x.ph.storage_path);
    const unsigned = photoItems.filter((x) => !x.ph.url);
    const [thumbs, full] = d.signedUrls ? await Promise.all([
      d.signedUrls(paths(photoItems), { width: THUMB_WIDTH }).catch(() => null),
      unsigned.length ? d.signedUrls(paths(unsigned)).catch(() => null) : null,
    ]) : [null, null];
    for (const x of photoItems) {
      const f = x.ph.url || full?.get?.(x.ph.storage_path);
      if (f) x.link.href = f;
      const src = thumbs?.get?.(x.ph.storage_path) || f;
      if (src) x.img.src = src;
    }
  };

  const mh = p.medical_history || {};
  const medicalLine = [...(mh.conditions || []), mh.allergies ? `Allergies: ${mh.allergies}` : null, mh.medications ? `Medicines: ${mh.medications}` : null, mh.notes].filter(Boolean).join(' · ');

  mount(root,
    h('p', {}, h('a', { href: '#/staff/patients' }, '← Patients')),
    h('div', { class: 'profile-head page-head' },
      h('div', {},
        h('h1', {}, p.full_name),
        h('p', {}, h('span', { class: 'mr' }, `Mr# ${p.mr_number}`), ' · ', p.phone ? phoneLink(p.phone, `Assalam o Alaikum ${p.full_name.split(' ')[0]}, this is Dr. Ali Rashid's Dental Clinic. `) : 'No phone number', p.email ? ` · ${p.email}` : '', p.first_branch_id ? ` · ${branchName(p.first_branch_id)}` : '',
          p.referred_by_clinician ? ` · brought in by ${clinicianName(p.referred_by_clinician) || 'a doctor'}` : ''),
        (() => { const seen = [...new Set(p.visits.filter((v) => v.status === 'completed').map((v) => v.branch_id))].map(branchName).filter(Boolean); return seen.length > 1 ? h('p', { class: 'muted' }, `Visited: ${seen.join(', ')}`) : null; })(),
        h('div', { class: 'inline', style: { marginTop: '6px' } }, duesBadge(p.dues), aliBadge(!!p.flag),
          p.photo_consent_public ? h('span', { class: 'badge badge-ok' }, 'Photo consent') : h('span', { class: 'badge badge-muted' }, 'No public photo consent'),
          p.treatment_consent_at ? h('span', { class: 'badge badge-ok' }, 'Consent signed') : h('span', { class: 'badge badge-muted' }, 'No treatment consent on file'),
          medicalLine ? h('span', { class: 'badge badge-warn', title: medicalLine }, '⚕ Medical history') : null),
        medicalLine ? h('p', { class: 'status-bad', style: { marginTop: '6px' } }, h('strong', {}, 'Medical: '), medicalLine) : null),
      h('div', { class: 'inline' },
        can('patients.edit') ? h('button', { class: 'btn', onclick: editPatient }, 'Edit') : null,
        h('a', { class: 'btn', href: `#/staff/patient/${id}/portal`, title: 'See this record the way the patient sees it in their account' }, 'View as patient'),
        can('portal.invite') && !p.portal_user_id ? h('button', { class: 'btn', onclick: busy(async () => {
          if (!p.email) { toast("Add the patient's email first (Edit), then invite them."); return; }
          await d.invitePatient(id); toast(`Invitation sent to ${p.email}. They set their own password.`, 'ok'); reload();
        }) }, 'Invite to patient portal') : null,
        can('photos.upload') ? h('button', { class: 'btn', onclick: () => photoUploadModal(p, { onDone: reload }) }, 'Upload photos') : null,
        can('billing.create') ? h('button', { class: 'btn', onclick: () => newInvoiceModal(p, { onDone: reload }) }, 'New invoice') : null,
        can('billing.create') ? h('button', { class: 'btn btn-primary', onclick: () => paymentModal(p, { dues: p.dues, invoices: p.invoices, payments: p.payments, onDone: reload }) }, 'Take payment') : null)),
    p.flag ? h('div', { class: 'alert alert-warning inline', style: { justifyContent: 'space-between' } },
      h('span', {}, h('strong', {}, 'Next appointment with Dr. Ali Rashid. '), p.flag.reason),
      can('flags.clear') ? h('button', { class: 'btn btn-small', 'aria-label': `Clear flag for ${p.full_name}`, onclick: clearFlag }, 'Clear flag') : null)
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
        h('div', { class: 'panel-head' }, h('h2', {}, 'Money'), can('dues.view') ? h('strong', { class: p.dues > 0 ? 'status-bad' : 'status-ok' }, p.dues > 0 ? `${rupees(p.dues)} pending` : 'No dues') : null),
        p.invoices.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Invoice'), h('th', { scope: 'col' }, 'Status'), h('th', { scope: 'col', class: 'right' }, 'Amount'), h('th', { scope: 'col' }, srOnly('Actions')))),
          h('tbody', {}, p.invoices.map((i) => {
            const bal = balances[i.id];
            return h('tr', {},
              h('td', {}, h('button', { class: 'link-btn', onclick: () => printInvoice(i, p) }, i.invoice_no), h('div', { class: 'muted' }, shortDate(i.issue_date))),
              h('td', {}, i.status !== 'issued' ? h('span', { class: 'badge badge-warn' }, i.status.replace('_', ' ')) : bal ? h('span', { class: ['badge', bal.remaining > 0 ? 'badge-dues' : 'badge-ok'] }, bal.remaining > 0 ? `${rupees(bal.remaining)} unpaid` : 'Paid') : null),
              h('td', { class: 'right' }, rupees(i.total ?? i.subtotal - i.discount_amount)),
              can('billing.edit') && i.status === 'issued' ? h('td', { class: 'right' }, h('button', { class: 'btn btn-small btn-danger', 'aria-label': `Void invoice ${i.invoice_no}`, onclick: () => voidInvoice(i) }, 'Void')) : h('td', {}));
          })))) : h('p', { class: 'muted' }, 'No invoices.'),
        p.payments.length ? h('details', { style: { marginTop: '10px' } },
          h('summary', { class: 'muted', style: { cursor: 'pointer' } }, `${p.payments.length} payments · ${rupees(p.payments.reduce((s, x) => s + Number(x.amount), 0))} received`),
          h('div', { class: 'table-scroll' }, h('table', { class: 'list', style: { marginTop: '6px' } },
            h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Date'), h('th', { scope: 'col' }, 'Method'), h('th', { scope: 'col', class: 'right' }, 'Amount'), h('th', { scope: 'col' }, srOnly('Receipt')))),
            h('tbody', {}, [...p.payments].sort((a, b) => String(b.received_at).localeCompare(String(a.received_at))).slice(0, 30).map((pay) => h('tr', {},
              h('td', { class: 'nowrap' }, shortDate(dayOf(pay.received_at))),
              h('td', {}, pay.method.replace('_', ' '), pay.invoice_id ? h('div', { class: 'muted' }, p.invoices.find((i) => i.id === pay.invoice_id)?.invoice_no || '') : null),
              h('td', { class: ['right', Number(pay.amount) < 0 && 'status-bad'] }, rupees(pay.amount)),
              h('td', { class: 'right' }, h('button', { class: 'btn btn-small', 'aria-label': `Receipt, ${shortDate(dayOf(pay.received_at))} ${rupees(pay.amount)}`, onclick: () => printReceipt(pay, p, p.invoices.find((i) => i.id === pay.invoice_id), p.dues) }, 'Receipt')))))))) : null,
        h('div', { class: 'inline', style: { justifyContent: 'space-between', marginTop: '14px' } }, h('h3', { style: { margin: 0 } }, 'Installment plan'),
          can('billing.create') ? h('button', { class: 'btn btn-small', onclick: () => installmentPlanModal(p, { totalFee: bc?.total_fee || (p.dues > 0 ? p.dues : ''), bracesCaseId: bc?.id, onDone: reload }) }, (p.plans || []).length ? 'New plan' : 'Set up a plan') : null),
        (p.plans || []).length ? (p.plans || []).map((plan) => h('div', { style: { marginTop: '8px' } },
          planTable(plan, p.payments),
          can('billing.create') && planProgress(plan, p.payments).remaining > 0 ? h('button', { class: 'link-btn muted', style: { fontSize: '12px' }, 'aria-label': `Remove plan from ${shortDate(plan.starts_on)}`, onclick: () => removePlan(plan) }, 'Remove plan') : null))
          : h('p', { class: 'muted' }, 'No installment plan. For braces fees paid monthly, set one up so the coordinator sees who falls behind.'))),
    h('section', { class: 'panel' },
      h('h2', {}, 'Visits'),
      p.visits.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Date'), h('th', { scope: 'col' }, 'Branch'), h('th', { scope: 'col' }, 'Treatment'), h('th', { scope: 'col' }, 'Month'), h('th', { scope: 'col' }, 'Doctors'), h('th', { scope: 'col' }, 'Details'), h('th', { scope: 'col' }, 'Status'))),
        h('tbody', {}, p.visits.map((v) => h('tr', {},
          h('td', { class: 'nowrap' }, shortDate(v.visit_date)), h('td', {}, branchName(v.branch_id)), h('td', {}, v.treatment_label || ''),
          h('td', {}, v.braces_month || ''), h('td', {}, v.staff.map((s) => s.role === 'checker' ? `✓ ${s.name}` : s.name).join(', ')),
          h('td', {}, v.details_text || '', v.notes ? h('div', { class: 'muted', style: { fontSize: '12px' } }, v.notes) : null), h('td', {}, STATUS_LABELS[v.status])))))) : empty('No visits yet.')),
    h('section', { class: 'panel' },
      h('h2', {}, 'Photos and X-rays'),
      photoItems.length ? h('div', { class: 'photo-grid' }, photoItems.map(({ ph, link }) => h('figure', {},
        link,
        h('figcaption', {}, [shortDate(ph.taken_on), ph.view_label, ph.kind === 'raw' ? 'raw (staff only)' : 'edited (patient sees it)', ph.public_ok ? 'website ok' : null].filter(Boolean).join(' · '),
          isAdmin() && ph.kind === 'edited' && ph.public_ok ? h('div', {}, h('button', { class: 'link-btn', style: { fontSize: '12px' }, onclick: busy(async () => {
            await d.publishPhoto(ph); toast('Added to the website gallery.', 'ok');
          }) }, 'Publish on website')) : null)))) : empty('No photos yet.')),
    h('section', { class: 'panel' },
      h('div', { class: 'inline', style: { justifyContent: 'space-between', marginBottom: '8px' } }, h('h2', { style: { margin: 0 } }, 'Documents'),
        can('patients.edit') || can('photos.upload') ? h('button', { class: 'btn btn-small', onclick: () => documentUploadModal(p, { onDone: reload }) }, 'Add document') : null),
      (p.documents || []).length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Date'), h('th', { scope: 'col' }, 'Type'), h('th', { scope: 'col' }, 'Title'), h('th', { scope: 'col' }, srOnly('Open')))),
        h('tbody', {}, p.documents.map((doc) => h('tr', {},
          h('td', { class: 'nowrap' }, shortDate(doc.added_on)), h('td', {}, DOCUMENT_KINDS[doc.kind] || doc.kind), h('td', {}, doc.title),
          h('td', { class: 'right' }, doc.url ? h('a', { class: 'btn btn-small', href: doc.url, target: '_blank', rel: 'noopener' }, 'Open') : h('span', { class: 'muted' }, 'Not available'))))))) : empty('No documents yet. Signed consent forms and ID copies go here.')),
    p.retainers.length ? h('section', { class: 'panel' }, h('h2', {}, 'Retainers'),
      h('div', { class: 'table-scroll' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Arch'), h('th', { scope: 'col' }, 'Stage'), h('th', { scope: 'col' }, 'Impression'), h('th', { scope: 'col' }, 'Next check'))),
        h('tbody', {}, p.retainers.map((r) => {
          // Overdue says so in words; the badge colour only repeats it.
          const overdue = r.next_check_date && r.next_check_date < today && r.stage !== 'closed';
          return h('tr', {}, h('td', {}, r.arch), h('td', {}, r.stage.replace('_', ' ')), h('td', {}, shortDate(r.impression_date)),
            h('td', {}, shortDate(r.next_check_date), overdue ? [' ', h('span', { class: 'badge badge-dues badge-overdue' }, 'Overdue')] : null));
        }))))) : null);
  loadThumbs();
}
