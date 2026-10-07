// Smaller staff screens: today dashboard, queue board, billing desk,
// Dr. Ali review list, complaints inbox, doctor daily log.
import { h, mount, rupees, shortDate, timeOf, toast, friendlyError, modal, field, select, empty, todayISO } from '../../ui/dom.js';
import { state, can, isAdmin, branchName, myBranches, defaultBranchId, clinicianName } from '../../state.js';
import { duesBadge, aliBadge, STATUS_LABELS } from './common.js';
import { printReceipt } from './invoice.js';

// ---------------------------------------------------------------- today
export async function renderDashboard(root) {
  const d = state.data;
  const s = state.session.staff;
  const day = todayISO();
  const [rows, totalDues, review, complaints] = await Promise.all([
    d.dashboard(day).catch(() => []),
    can('finance.view') ? d.totalDues().catch(() => null) : null,
    isAdmin() || can('complaints.view') ? d.reviewList().catch(() => []) : [],
    can('complaints.view') ? d.complaints().catch(() => []) : [],
  ]);
  const visible = rows.filter((r) => myBranches().some((b) => b.id === r.branch.id));
  const sum = (k) => visible.reduce((t, r) => t + (r[k] || 0), 0);
  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, `Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${s.full_name.split(' ')[0] === 'Dr.' ? s.full_name : s.full_name.split(' ')[0]}`), h('p', {}, shortDate(day)))),
    h('div', { class: 'stat-row' },
      h('div', { class: 'stat' }, h('strong', {}, sum('patients')), h('span', {}, 'Patients on today\'s lists')),
      h('div', { class: 'stat' }, h('strong', {}, sum('waiting')), h('span', {}, 'Waiting now')),
      h('div', { class: 'stat' }, h('strong', {}, sum('completed')), h('span', {}, 'Completed')),
      can('finance.view') || can('billing.view') ? h('div', { class: 'stat' }, h('strong', {}, rupees(sum('received'))), h('span', {}, 'Received today')) : null,
      totalDues !== null ? h('div', { class: 'stat' }, h('strong', {}, rupees(totalDues)), h('span', {}, 'Total pending dues')) : null,
      review.length ? h('a', { class: 'stat', href: '#/staff/review', style: { textDecoration: 'none', color: 'inherit' } }, h('strong', {}, review.length), h('span', {}, 'On Dr. Ali\'s list')) : null,
      complaints.filter((c) => c.status === 'new').length ? h('a', { class: 'stat', href: '#/staff/complaints', style: { textDecoration: 'none', color: 'inherit' } }, h('strong', {}, complaints.filter((c) => c.status === 'new').length), h('span', {}, 'New complaints')) : null),
    h('section', { class: 'panel', style: { marginTop: '16px' } },
      h('h2', {}, 'Branches today'),
      h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Branch'), h('th', { class: 'right' }, 'Patients'), h('th', { class: 'right' }, 'Waiting'), h('th', { class: 'right' }, 'Completed'),
          can('billing.view') ? h('th', { class: 'right' }, 'Received') : null, can('dues.view') ? h('th', { class: 'right' }, "Dues on today's list") : null,
          can('complaints.view') ? h('th', { class: 'right' }, 'New complaints') : null, h('th', {}, 'Cash closing'), h('th', {}))),
        h('tbody', {}, visible.map((r) => h('tr', {},
          h('td', {}, h('strong', {}, r.branch.name)), h('td', { class: 'right' }, r.patients), h('td', { class: 'right' }, r.waiting), h('td', { class: 'right' }, r.completed),
          can('billing.view') ? h('td', { class: 'right' }, rupees(r.received)) : null,
          can('dues.view') ? h('td', { class: 'right', style: { color: r.dues > 0 ? 'var(--stop)' : '' } }, r.dues > 0 ? `${rupees(r.dues)} (${r.dues_patients})` : '–') : null,
          can('complaints.view') ? h('td', { class: 'right' }, r.new_complaints ? h('a', { href: '#/staff/complaints' }, r.new_complaints) : '–') : null,
          h('td', {}, r.closing ? h('span', { class: ['badge', Number(r.closing.difference) === 0 ? 'badge-ok' : 'badge-dues'] }, Number(r.closing.difference) === 0 ? 'Closed, matches' : `Closed, off by ${rupees(r.closing.difference)}`) : h('span', { class: 'badge badge-muted' }, 'Not closed')),
          h('td', { class: 'right' }, h('a', { class: 'btn btn-small', href: `#/staff/sheet?branch=${r.branch.id}&date=${day}` }, 'Open list')))))))));
}

// ---------------------------------------------------------------- queue
export async function renderQueue(root, params) {
  const d = state.data;
  let branchId = Number(params.get('branch')) || defaultBranchId();
  const board = h('div', { class: 'queue' });
  const branchSel = select(myBranches().map((b) => ({ value: b.id, label: b.name })), branchId, { onchange: (e) => { branchId = Number(e.target.value); load(); } });
  async function load() {
    const rows = await d.listVisits({ branchId, date: todayISO() }).catch((e) => { toast(friendlyError(e), 'error'); return []; });
    const col = (status, title) => {
      const items = rows.filter((r) => r.status === status);
      return h('div', { class: 'queue-col' }, h('h3', {}, title, h('span', { class: 'muted' }, items.length)),
        items.map((r) => h('div', { class: 'q-card' },
          h('div', { class: 'inline', style: { justifyContent: 'space-between' } }, h('span', { class: 'token' }, r.token_no ?? '–'), h('span', { class: 'muted' }, r.checked_in_at ? timeOf(r.checked_in_at) : '')),
          h('strong', {}, r.patient.full_name),
          h('span', { class: 'muted' }, [r.treatment_label, r.braces_month ? `Month ${r.braces_month}` : null].filter(Boolean).join(' · ')),
          h('div', { class: 'inline' }, duesBadge(r.dues), aliBadge(r.see_dr_ali), r.photo_required && !r.photos_uploaded ? h('span', { class: 'badge badge-photo' }, '📸 Photo month') : null),
          r.staff.length ? h('span', { class: 'muted' }, r.staff.map((s) => s.name).join(', ')) : null)));
    };
    mount(board, col('waiting', 'Waiting'), col('in_treatment', 'In treatment'), col('completed', 'Completed'));
  }
  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Queue'), h('p', {}, d.subscribeVisits ? 'Updates by itself as the list changes' : 'Updates every 15 seconds')), branchSel),
    board);
  await load();
  // Live: redraw the moment a visit at this branch changes; a 15-second check is the safety net.
  let stopLive = null; let liveTimer = null;
  const listen = () => { stopLive?.(); stopLive = d.subscribeVisits ? d.subscribeVisits(branchId, () => { clearTimeout(liveTimer); liveTimer = setTimeout(load, 300); }) : null; };
  branchSel.addEventListener('change', listen);
  listen();
  const t = setInterval(() => { if (!document.body.contains(board)) { clearInterval(t); stopLive?.(); } else load(); }, 15000);
}

// ---------------------------------------------------------------- billing desk
export async function renderBilling(root) {
  const d = state.data;
  const branchId = can('finance.view') ? null : defaultBranchId();
  const [payments, requests] = await Promise.all([
    d.todaysPayments(branchId).catch(() => []),
    can('discount.approve') ? d.discountRequests().catch(() => []) : [],
  ]);
  const total = payments.reduce((s, p) => s + Number(p.amount), 0);
  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Billing'), h('p', {}, 'To bill a patient, open them from Aaj ki List or Patients.'))),
    requests.length ? h('section', { class: 'panel' },
      h('h2', {}, 'Discounts waiting for approval'),
      h('table', { class: 'list' }, h('tbody', {}, requests.map((r) => h('tr', {},
        h('td', {}, h('strong', {}, r.patient?.full_name), h('div', { class: 'muted' }, `${r.invoice?.invoice_no} · requested by ${r.requested_by_name || r.requested_by || ''}`)),
        h('td', {}, r.reason || ''),
        h('td', { class: 'right nowrap' }, `${rupees(r.discount_amount)} off ${rupees(r.invoice?.subtotal)}`),
        h('td', { class: 'right nowrap' },
          h('button', { class: 'btn btn-small btn-primary', onclick: async () => { try { await d.decideDiscount(r.id, true); toast('Discount approved.', 'ok'); renderBilling(root); } catch (e) { toast(friendlyError(e), 'error'); } } }, 'Approve'), ' ',
          h('button', { class: 'btn btn-small', onclick: async () => { try { await d.decideDiscount(r.id, false); toast('Discount rejected. Invoice issued at full price.', 'ok'); renderBilling(root); } catch (e) { toast(friendlyError(e), 'error'); } } }, 'Reject'))))))) : null,
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Payments today'), h('strong', {}, rupees(total))),
      payments.length ? h('table', { class: 'list' }, h('tbody', {}, payments.map((p) => h('tr', {},
        h('td', { class: 'nowrap' }, timeOf(p.received_at)),
        h('td', {}, p.patient ? h('a', { href: `#/staff/patient/${p.patient_id}` }, p.patient.full_name) : ''),
        h('td', {}, branchName(p.branch_id)), h('td', {}, p.method.replace('_', ' ')),
        h('td', { class: 'right' }, rupees(p.amount)),
        h('td', { class: 'right' }, h('button', { class: 'btn btn-small', onclick: () => printReceipt(p, p.patient, null) }, 'Receipt'))))))
        : empty('No payments yet today.')));
}

// ---------------------------------------------------------------- Dr. Ali review list
export async function renderReview(root) {
  const d = state.data;
  const rows = await d.reviewList().catch((e) => { toast(friendlyError(e), 'error'); return []; });
  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, "Dr. Ali's list"), h('p', {}, 'Patients flagged by staff, new braces cases waiting for your treatment plan (Month 1), and cases running past their end month.'))),
    h('section', { class: 'panel' }, rows.length ? h('table', { class: 'list' }, h('tbody', {}, rows.map((r) => h('tr', {},
      h('td', {}, h('a', { href: `#/staff/patient/${r.patient?.id || r.patient_id}` }, r.patient?.full_name || 'Patient'), h('div', { class: 'muted' }, r.patient ? `Mr# ${r.patient.mr_number}${r.patient.phone ? ' · ' + r.patient.phone : ''}` : '')),
      h('td', {}, h('span', { class: ['badge', r.source === 'flag' ? 'badge-ali' : r.source === 'plan' ? 'badge-photo' : 'badge-warn'] }, r.source === 'flag' ? 'Flagged' : r.source === 'plan' ? 'Plan needed' : 'Overrun')),
      h('td', {}, r.reason),
      h('td', { class: 'nowrap muted' }, shortDate(String(r.since).slice(0, 10))),
      h('td', { class: 'right' }, r.flag_id && can('flags.clear') ? h('button', { class: 'btn btn-small', onclick: async () => { await d.clearFlag(r.flag_id, 'Seen by Dr. Ali'); toast('Flag cleared.', 'ok'); renderReview(root); } }, 'Seen, clear flag') : null)))))
      : empty('Nobody is waiting for Dr. Ali right now.')));
}

// ---------------------------------------------------------------- complaints
export async function renderComplaints(root) {
  const d = state.data;
  const rows = await d.complaints().catch((e) => { toast(friendlyError(e), 'error'); return []; });
  const open = (c) => {
    const reply = h('textarea', { placeholder: 'Reply to the patient, or write an internal note' });
    const internal = h('input', { type: 'checkbox' });
    modal(c.subject, h('div', {},
      h('p', {}, h('strong', {}, c.patient?.full_name), ` · Mr# ${c.patient?.mr_number || ''}${c.patient?.phone ? ' · ' + c.patient.phone : ''}`),
      h('p', { class: 'muted' }, `${shortDate(c.created_at.slice(0, 10))} · ${branchName(c.branch_id)}`),
      h('div', { class: 'panel', style: { background: 'var(--porcelain)' } }, c.body),
      (c.messages || []).map((m) => h('div', { class: ['alert', m.internal_note ? 'alert-warning' : 'alert-info'], style: { marginTop: '8px' } },
        h('strong', {}, m.internal_note ? 'Internal note' : 'Reply'), m.author ? ` · ${m.author}` : '', h('div', {}, m.body))),
      h('div', { style: { marginTop: '12px' } }, field('Reply', reply), h('label', { class: 'inline' }, internal, 'Internal note (patient does not see it)'))), [
      { label: 'Mark resolved', onClick: async () => { await d.setComplaintStatus(c.id, 'resolved'); toast('Marked resolved.', 'ok'); renderComplaints(root); } },
      { label: 'Send', primary: true, onClick: async () => {
        if (!reply.value.trim()) { toast('Write a reply first.'); return false; }
        try { await d.replyComplaint(c.id, reply.value.trim(), internal.checked); toast('Saved.', 'ok'); renderComplaints(root); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ]);
  };
  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Complaints'), h('p', {}, 'Sent by patients from their accounts. Dr. Ali and the clinic coordinator both see these.'))),
    h('section', { class: 'panel' }, rows.length ? h('table', { class: 'list' }, h('tbody', {}, rows.map((c) => h('tr', {},
      h('td', {}, h('button', { class: 'link-btn', onclick: () => open(c) }, c.subject), h('div', { class: 'muted' }, c.body.slice(0, 120))),
      h('td', {}, c.patient?.full_name || ''),
      h('td', {}, branchName(c.branch_id)),
      h('td', { class: 'nowrap' }, shortDate(c.created_at.slice(0, 10))),
      h('td', {}, h('span', { class: ['badge', c.status === 'resolved' ? 'badge-ok' : c.status === 'new' ? 'badge-dues' : 'badge-warn'] }, c.status.replace('_', ' '))))))) : empty('No complaints.')));
}

// ---------------------------------------------------------------- doctor log
export async function renderDoctorLog(root, params) {
  const d = state.data;
  const mine = await d.myClinicianId();
  let clinicianId = params.get('doctor') || mine;
  const from = h('input', { type: 'date', value: params.get('from') || todayISO().slice(0, 8) + '01' });
  const to = h('input', { type: 'date', value: params.get('to') || todayISO() });
  const doctors = state.ref.clinicians.filter((c) => c.is_doctor);
  const who = can('doctor_log.view_all') ? select(doctors.map((c) => ({ value: c.id, label: c.display_name })), clinicianId, { onchange: (e) => { clinicianId = e.target.value; load(); } }) : null;
  const out = h('div', {});
  async function load() {
    if (!clinicianId) { mount(out, empty('Your login is not linked to a doctor yet. Ask Dr. Ali to link it.')); return; }
    try {
      const rows = await d.doctorLog({ clinicianId, from: from.value, to: to.value });
      const days = [...new Set(rows.map((r) => r.visit_date))];
      mount(out,
        h('div', { class: 'stat-row', style: { marginBottom: '16px' } },
          h('div', { class: 'stat' }, h('strong', {}, rows.filter((r) => r.role === 'doctor').length), h('span', {}, 'Patients treated')),
          h('div', { class: 'stat' }, h('strong', {}, rows.filter((r) => r.role === 'checker').length), h('span', {}, 'Visits checked')),
          h('div', { class: 'stat' }, h('strong', {}, days.length), h('span', {}, 'Working days'))),
        rows.length ? h('section', { class: 'panel' }, h('table', { class: 'list' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Patient'), h('th', {}, 'Branch'), h('th', {}, 'Treatment'), h('th', {}, 'Role'), h('th', {}, 'Details'))),
          h('tbody', {}, rows.map((r) => h('tr', {},
            h('td', { class: 'nowrap' }, shortDate(r.visit_date)), h('td', {}, r.patient.full_name, h('div', { class: 'muted' }, `Mr# ${r.patient.mr_number}`)),
            h('td', {}, branchName(r.branch_id)), h('td', {}, [r.treatment_label, r.braces_month ? `M${r.braces_month}` : null].filter(Boolean).join(' · ')),
            h('td', {}, r.role === 'checker' ? 'Checked' : r.role === 'assistant' ? 'Assisted' : 'Treated'), h('td', {}, r.details_text || '')))))) : empty('No completed visits in this period.'));
    } catch (e) { mount(out, empty(friendlyError(e))); }
  }
  from.addEventListener('change', load);
  to.addEventListener('change', load);
  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Doctor daily log'), h('p', {}, clinicianName(clinicianId) || '')),
      h('div', { class: 'inline' }, who, from, to)),
    out);
  load();
}
