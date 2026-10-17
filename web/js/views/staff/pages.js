// Smaller staff screens: today dashboard, queue board, billing desk,
// Dr. Ali review list, complaints inbox, doctor daily log.
import { h, mount, rupees, shortDate, timeOf, toast, friendlyError, modal, field, select, empty, todayISO, localISO, srOnly, showFormErrors, capFirst, phoneLink } from '../../ui/dom.js';
import { state, can, isAdmin, branchName, myBranches, defaultBranchId, clinicianName } from '../../state.js';
import { duesBadge, aliBadge, capNote, STATUS_LABELS } from './common.js';
import { printReceipt } from './invoice.js';
import { FEEDBACK_KIND_LABELS, FEEDBACK_TOPIC_LABELS, formatPhone } from '../../lib/public-forms.js';
import { deskNameFor } from '../../lib/desk-name.js';

/** The Karachi calendar day of a timestamp (not the UTC day, which is a day behind before 5 AM). */
const dayOf = (ts) => (ts ? localISO(new Date(ts)) : '');

// ---------------------------------------------------------------- today
// CVs no application uses (uploaded more than a day ago: never sent, or sent with a dropped form) are removed by themselves, once per
// opening of the staff pages, when someone who sees job applications (Dr. Ali) opens Today: they take storage, and unsent ones count
// toward the CV upload limits.
let cvSweep = null;

// The first page after login. Whoever keeps the Aaj ki List finds "+ Add checkup patient" at the top: the name and the mobile number only
// (owner, 15 Oct 2026), and the person is on today's Aaj ki List of their branch, as Waiting; the checkup form is filled in after the checkup,
// from their row there.
export async function renderDashboard(root) {
  const d = state.data;
  const s = state.session.staff;
  const day = todayISO();
  if (can('jobs.view')) cvSweep ??= import('./jobs.js').then((m) => m.removeUnsentCvs()).catch(() => 0);
  const [rows, totalDues, review, complaints, newJobs, todaysCheckups, dayPayments, inbox] = await Promise.all([
    d.dashboard(day).catch(() => []),
    can('finance.view') ? d.totalDues().catch(() => null) : null,
    isAdmin() || can('complaints.view') ? d.reviewList().catch(() => []) : [],
    can('complaints.view') ? d.complaints().catch(() => []) : [],
    // Job applications still marked New, for those who see them (none shown before the database update has been run).
    can('jobs.view') ? d.newJobApplications().catch(() => 0) : 0,
    // today's checkups of every branch the person may see: how many there are, and whether the checkup list is switched on at all
    can('sheet.edit') && d.listDayCheckups ? d.listDayCheckups({ branchId: null, date: day }).catch(() => null) : Object.assign([], { missing: true }),
    // today's payments one by one, for whoever may see them without seeing invoices and payments (the front desk)
    dayPaymentsShown() ? loadDayPayments() : null,
    // the Photo inbox's sets waiting on "Which patient?" (and filed sets Claude flagged), for whoever uses the inbox
    can('photos.intake') && can('photos.view_raw') && d.photoInboxCounts ? d.photoInboxCounts().catch(() => null) : null,
  ]);
  const inboxWaiting = inbox ? Number(inbox.waiting || 0) + Number(inbox.check || 0) : 0;
  let checkupCount = Array.isArray(todaysCheckups) ? todaysCheckups.length : null;
  const countText = () => (checkupCount === null ? '' : ` ${checkupCount} checkup patient${checkupCount === 1 ? '' : 's'} on today's lists so far.`);
  const countEl = h('span', {}, countText());
  const addCheckup = async () => {
    let form;
    try { form = await import('./checkup-actions.js'); } catch (e) { toast(friendlyError(e), 'error'); return; }
    const row = await form.quickCheckupModal(); // at the person's only or home branch, else they choose it
    if (!row) return;
    if (checkupCount !== null) { checkupCount += 1; countEl.textContent = countText(); }
    toast(`${row.patient_name} added to today's list for ${branchName(row.branch_id)}.`, 'ok');
  };
  const checkupPanel = todaysCheckups?.missing ? null : h('section', { class: 'add-panel today-checkup', 'aria-label': 'Checkup patient' },
    h('div', { class: 'add-panel-text' },
      h('strong', {}, 'Checkup patient?'),
      h('span', { class: 'muted' }, "Write the name and mobile number: the name goes on today's Aaj ki List. After the checkup, the checkup form is filled in from their row there (\"Fill in form\", or Options).", countEl)),
    h('button', { type: 'button', class: 'btn btn-primary', 'aria-haspopup': 'dialog', onclick: addCheckup }, '+ Add checkup patient'),
    can('sheet.view') ? h('a', { class: 'btn', href: '#/staff/checkups' }, 'Open the Checkups page') : null);
  // totalDues is a number; a capped fallback may mark itself truncated.
  const duesTotal = totalDues === null ? null : Number(typeof totalDues === 'object' ? totalDues.total ?? totalDues : totalDues);
  const duesPartial = !!totalDues?.truncated;
  const visible = rows.filter((r) => myBranches().some((b) => b.id === r.branch.id));
  const sum = (k) => visible.reduce((t, r) => t + (r[k] || 0), 0);
  // A shared login is greeted with the name typed at its desk (desk-name.js), not with the first word of the login ("Front").
  const greet = s.shared_login ? deskNameFor(s.id) : s.full_name.split(' ')[0] === 'Dr.' ? s.full_name : s.full_name.split(' ')[0];
  // Money (owner, 15 Oct 2026): the dues added up per branch only for who may see totals (finance.view, billing.view); the cash
  // closing's "off by Rs ..." only for who may see the money (also cash.verify). The front desk's cash count is blind.
  const seesTotals = can('finance.view') || can('billing.view');
  const seesCash = seesTotals || can('cash.verify');
  const seesClosings = seesCash || can('cash.close');
  const closingBadge = (c) => (!c ? h('span', { class: 'badge badge-muted' }, 'Not closed')
    : !seesCash || c.difference === null || c.difference === undefined ? h('span', { class: 'badge badge-ok' }, 'Closed')
    : Number(c.difference) === 0 ? h('span', { class: 'badge badge-ok' }, 'Closed, matches') : h('span', { class: 'badge badge-dues' }, `Closed, off by ${rupees(c.difference)}`));
  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, `Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}${greet ? `, ${greet}` : ''}`), h('p', {}, shortDate(day)))),
    inboxWaiting ? h('div', { class: 'alert alert-warning inline today-inbox' },
      h('span', {}, `${inboxWaiting} photo set${inboxWaiting === 1 ? '' : 's'} ${inboxWaiting === 1 ? 'waits' : 'wait'} for "Which patient?".`),
      h('a', { href: '#/staff/photo-inbox?tab=which' }, 'Open the Photo inbox')) : null,
    checkupPanel,
    h('div', { class: 'stat-row' },
      h('div', { class: 'stat' }, h('strong', {}, sum('patients')), h('span', {}, 'Patients on today\'s lists')),
      h('div', { class: 'stat' }, h('strong', {}, sum('waiting')), h('span', {}, 'Waiting now')),
      h('div', { class: 'stat' }, h('strong', {}, sum('completed')), h('span', {}, 'Completed')),
      can('finance.view') || can('billing.view') ? h('div', { class: 'stat' }, h('strong', {}, rupees(sum('received'))), h('span', {}, 'Received today')) : null,
      duesTotal !== null ? h('div', { class: 'stat' }, h('strong', {}, duesPartial ? `${rupees(duesTotal)}+` : rupees(duesTotal)), h('span', {}, duesPartial ? 'Total pending dues (incomplete: not every patient was counted)' : 'Total pending dues')) : null,
      review.length ? h('a', { class: 'stat', href: '#/staff/review', style: { textDecoration: 'none', color: 'inherit' } }, h('strong', {}, review.length), h('span', {}, 'On Dr. Ali\'s list')) : null,
      complaints.filter((c) => c.status === 'new').length ? h('a', { class: 'stat', href: '#/staff/complaints', style: { textDecoration: 'none', color: 'inherit' } }, h('strong', {}, complaints.filter((c) => c.status === 'new').length), h('span', {}, 'New complaints & suggestions')) : null,
      newJobs ? h('a', { class: 'stat', href: '#/staff/jobs?status=new', style: { textDecoration: 'none', color: 'inherit' } }, h('strong', {}, newJobs), h('span', {}, 'New job applications')) : null),
    h('section', { class: 'panel', style: { marginTop: '16px' } },
      h('h2', {}, 'Branches today'),
      h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Branch'), h('th', { scope: 'col', class: 'right' }, 'Patients'), h('th', { scope: 'col', class: 'right' }, 'Waiting'), h('th', { scope: 'col', class: 'right' }, 'Completed'),
          can('billing.view') ? h('th', { scope: 'col', class: 'right' }, 'Received') : null,
          can('dues.view') ? h('th', { scope: 'col', class: 'right' }, seesTotals ? "Dues on today's list" : 'Patients with dues') : null,
          can('complaints.view') ? h('th', { scope: 'col', class: 'right' }, 'New complaints & suggestions') : null, seesClosings ? h('th', { scope: 'col' }, 'Cash closing') : null,
          h('th', { scope: 'col' }, srOnly('Actions')))),
        h('tbody', {}, visible.map((r) => h('tr', {},
          h('td', {}, h('strong', {}, r.branch.name)), h('td', { class: 'right' }, r.patients), h('td', { class: 'right' }, r.waiting), h('td', { class: 'right' }, r.completed),
          can('billing.view') ? h('td', { class: 'right' }, rupees(r.received)) : null,
          can('dues.view') ? (seesTotals ? h('td', { class: ['right', r.dues > 0 && 'status-bad'] }, r.dues > 0 ? `${rupees(r.dues)} (${r.dues_patients})` : '–')
            : h('td', { class: ['right', r.dues_patients > 0 && 'status-bad'] }, r.dues_patients || '–')) : null,
          can('complaints.view') ? h('td', { class: 'right' }, r.new_complaints ? h('a', { href: '#/staff/complaints' }, r.new_complaints) : '–') : null,
          seesClosings ? h('td', {}, closingBadge(r.closing)) : null,
          h('td', { class: 'right' }, h('a', { class: 'btn btn-small', href: `#/staff/sheet?branch=${r.branch.id}&date=${day}`, 'aria-label': `Open list, ${r.branch.name}` }, 'Open list')))))))),
    dayPayments ? dayPaymentsPanel(dayPayments) : null);
}

// ---------------------------------------------------------------- today's payments, one by one
// The owner (15 Oct 2026): "only front desk can see the daily payments with each payment along with patient name. but not the full
// amount". "Today's payments, one by one (no totals)" shows each payment taken today at the person's branches, newest first, with no
// total, sum or count of rupees anywhere (the database gives the rows only: payments_today). Whoever sees invoices and payments
// (billing.view) has the same list, with its total, on the Billing page instead.
const METHOD_LABELS = { cash: 'Cash', card: 'Card', bank_transfer: 'Bank transfer', cheque: 'Cheque', other: 'Other' };
const dayPaymentsShown = () => can('payments.day_list') && !can('billing.view') && !!state.data.paymentsToday;
const loadDayPayments = () => state.data.paymentsToday().catch((e) => Object.assign([], { failed: friendlyError(e) }));

function dayPaymentsPanel(first) {
  const body = h('div', {});
  const draw = (rows) => mount(body,
    rows.missing ? empty("Today's payments show here once the database update has been run.")
      : rows.failed ? empty(rows.failed)
        : rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list day-payments' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Time'), h('th', { scope: 'col' }, 'Patient'), h('th', { scope: 'col', class: 'right' }, 'Amount'),
            h('th', { scope: 'col' }, 'Method'), h('th', { scope: 'col' }, 'Branch'), h('th', { scope: 'col' }, 'Taken by'))),
          h('tbody', {}, rows.map((p) => h('tr', {},
            h('td', { class: 'nowrap' }, timeOf(p.received_at)),
            h('td', {}, can('patients.view') ? h('a', { href: `#/staff/patient/${p.patient_id}` }, p.patient_name) : p.patient_name, h('div', { class: 'muted' }, `Mr# ${p.mr_number}`)),
            h('td', { class: ['right', 'nowrap', Number(p.amount) < 0 && 'status-bad'] }, Number(p.amount) < 0 ? `Refund ${rupees(-Number(p.amount))}` : rupees(p.amount)),
            h('td', {}, METHOD_LABELS[p.method] || p.method),
            h('td', {}, branchName(p.branch_id)),
            h('td', {}, p.received_by_name || h('span', { class: 'muted' }, 'Not recorded')))))))
          : empty('No payments yet today.'));
  draw(first);
  const refresh = h('button', { type: 'button', class: 'btn btn-small', onclick: async () => draw(await loadDayPayments()) }, 'Refresh');
  return h('section', { class: 'panel day-payments-panel', style: { marginTop: '16px' } },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Payments today'), refresh),
    h('p', { class: 'muted' }, `Each payment taken today at your ${myBranches().length > 1 ? 'branches' : 'branch'}, newest first. The totals are with accounts.`),
    body);
}

// ---------------------------------------------------------------- queue
export async function renderQueue(root, params, signal) {
  const d = state.data;
  let branchId = Number(params.get('branch')) || defaultBranchId();
  const board = h('div', { class: 'queue' });
  const branchSel = select(myBranches().map((b) => ({ value: b.id, label: b.name })), branchId, { onchange: (e) => { branchId = Number(e.target.value); load(); } });
  let newest = 0;
  async function load() {
    const mine = ++newest; // a slow answer for the branch just left must not overwrite the one on screen
    const rows = await d.listVisits({ branchId, date: todayISO() }).catch((e) => { toast(friendlyError(e), 'error'); return []; });
    if (mine !== newest || signal?.aborted) return;
    const col = (status, title) => {
      const items = rows.filter((r) => r.status === status);
      return h('div', { class: 'queue-col' }, h('h3', {}, title, h('span', { class: 'muted' }, items.length)),
        items.map((r) => h('div', { class: 'q-card' },
          h('div', { class: 'inline', style: { justifyContent: 'space-between' } }, h('span', { class: 'token' }, r.token_no ?? '–'), h('span', { class: 'muted' }, r.checked_in_at ? timeOf(r.checked_in_at) : '')),
          h('strong', {}, r.patient.full_name),
          h('span', { class: 'muted' }, [capFirst(r.treatment_label), r.braces_month ? `Month ${r.braces_month}` : null].filter(Boolean).join(' · ')),
          h('div', { class: 'inline' }, duesBadge(r.dues), aliBadge(r.see_dr_ali), r.photo_required && !r.photos_uploaded ? h('span', { class: 'badge badge-photo' }, '📸 Photo month') : null),
          r.staff.length ? h('span', { class: 'muted' }, r.staff.map((s) => s.name).join(', ')) : null)));
    };
    mount(board, col('waiting', 'Waiting'), col('in_treatment', 'In treatment'), col('completed', 'Completed'));
  }
  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Queue'), h('p', {}, d.subscribeVisits ? 'Updates by itself as the list changes' : 'Updates every 15 seconds')),
      h('label', { class: 'inline' }, 'Branch ', branchSel)),
    board);
  await load();
  if (signal?.aborted) return;
  // Live: redraw the moment a visit at this branch changes. The timed check is only a safety net:
  // every 15 s without live updates, every minute with them, and never while the tab is hidden.
  // Leaving the page (the shell aborts `signal`) stops the timer and the realtime subscription.
  let stopLive = null; let liveTimer = null; let t = null;
  const listen = () => { stopLive?.(); stopLive = d.subscribeVisits ? d.subscribeVisits(branchId, () => { clearTimeout(liveTimer); liveTimer = setTimeout(() => { if (!document.hidden) load(); }, 300); }) : null; };
  const stop = () => { clearInterval(t); clearTimeout(liveTimer); stopLive?.(); stopLive = null; document.removeEventListener('visibilitychange', onVisible); };
  const refresh = () => { if (signal?.aborted || !board.isConnected) stop(); else if (!document.hidden) load(); };
  const onVisible = refresh; // coming back to the tab redraws at once
  branchSel.addEventListener('change', listen);
  document.addEventListener('visibilitychange', onVisible);
  signal?.addEventListener('abort', stop, { once: true });
  listen();
  t = setInterval(refresh, d.subscribeVisits ? 60000 : 15000);
}

// ---------------------------------------------------------------- billing desk
export async function renderBilling(root) {
  const d = state.data;
  const branchId = can('finance.view') ? null : defaultBranchId();
  const [payments, requests] = await Promise.all([
    can('billing.view') ? d.todaysPayments(branchId).catch(() => []) : [],
    can('discount.approve') ? d.discountRequests().catch(() => []) : [],
  ]);
  const total = payments.reduce((s, p) => s + Number(p.amount), 0);
  const what = (r) => `${rupees(r.discount_amount)} discount for ${r.patient?.full_name || 'this patient'}${r.invoice?.invoice_no ? `, invoice ${r.invoice.invoice_no}` : ''}`;
  // Approving or rejecting changes what the patient owes, so it takes a second, deliberate step.
  const decide = (r, approve) => modal(approve ? 'Approve this discount?' : 'Reject this discount?',
    h('p', {}, approve ? `${what(r)}. The invoice is issued with the discount.` : `${what(r)}. The invoice is issued at the full price of ${rupees(r.invoice?.subtotal)}.`), [
      { label: 'Cancel' },
      { label: approve ? 'Approve discount' : 'Reject discount', primary: approve, danger: !approve, onClick: async () => {
        try { await d.decideDiscount(r.id, approve); toast(approve ? 'Discount approved.' : 'Discount rejected. Invoice issued at full price.', 'ok'); } catch (e) { toast(friendlyError(e), 'error'); return false; }
        await renderBilling(root); // redrawn before this dialog closes, so focus can return to the page
      } },
    ], { destructive: !approve });
  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Billing'), h('p', {}, 'To bill a patient, open them from Aaj ki List or Patients.'))),
    requests.length ? h('section', { class: 'panel' },
      h('h2', {}, 'Discounts waiting for approval'),
      h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Patient'), h('th', { scope: 'col' }, 'Reason'), h('th', { scope: 'col', class: 'right' }, 'Discount'), h('th', { scope: 'col' }, srOnly('Actions')))),
        h('tbody', {}, requests.map((r) => h('tr', {},
          h('td', {}, h('strong', {}, r.patient?.full_name), h('div', { class: 'muted' }, `${r.invoice?.invoice_no} · requested by ${r.requested_by_name || r.requested_by || ''}`)),
          h('td', {}, r.reason || ''),
          h('td', { class: 'right nowrap' }, `${rupees(r.discount_amount)} off ${rupees(r.invoice?.subtotal)}`),
          h('td', { class: 'right nowrap' },
            h('button', { class: 'btn btn-small btn-primary', 'aria-label': `Approve ${what(r)}`, onclick: () => decide(r, true) }, 'Approve'), ' ',
            h('button', { class: 'btn btn-small', 'aria-label': `Reject ${what(r)}`, onclick: () => decide(r, false) }, 'Reject')))))))) : null,
    can('billing.view') ? h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Payments today'), h('strong', {}, rupees(total))),
      capNote(payments, 'payments'),
      payments.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Time'), h('th', { scope: 'col' }, 'Patient'), h('th', { scope: 'col' }, 'Branch'), h('th', { scope: 'col' }, 'Method'), h('th', { scope: 'col', class: 'right' }, 'Amount'), h('th', { scope: 'col' }, srOnly('Receipt')))),
        h('tbody', {}, payments.map((p) => h('tr', {},
          h('td', { class: 'nowrap' }, timeOf(p.received_at)),
          h('td', {}, p.patient ? h('a', { href: `#/staff/patient/${p.patient_id}` }, p.patient.full_name) : ''),
          h('td', {}, branchName(p.branch_id)), h('td', {}, p.method.replace('_', ' ')),
          h('td', { class: 'right' }, rupees(p.amount)),
          h('td', { class: 'right' }, h('button', { class: 'btn btn-small', 'aria-label': `Receipt, ${p.patient?.full_name || 'payment'} ${rupees(p.amount)}`, onclick: () => printReceipt(p, p.patient, null) }, 'Receipt')))))))
        : empty('No payments yet today.')) : null);
}

// ---------------------------------------------------------------- Dr. Ali review list
export async function renderReview(root) {
  const d = state.data;
  const rows = await d.reviewList().catch((e) => { toast(friendlyError(e), 'error'); return []; });
  const clear = (r) => {
    const who = r.patient?.full_name || 'this patient';
    modal('Clear this flag?', h('p', {}, `${who} leaves Dr. Ali's list. Staff can flag them again at any time.`), [
      { label: 'Cancel' },
      { label: 'Clear flag', primary: true, onClick: async () => {
        try { await d.clearFlag(r.flag_id, 'Seen by Dr. Ali'); toast('Flag cleared.', 'ok'); } catch (e) { toast(friendlyError(e), 'error'); return false; }
        await renderReview(root); // redrawn before this dialog closes, so focus can return to the page
      } },
    ]);
  };
  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, "Dr. Ali's list"), h('p', {}, 'Patients flagged by staff, new braces cases waiting for your treatment plan (Month 1), and cases running past their end month.'))),
    h('section', { class: 'panel' }, capNote(rows, 'patients'), rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Patient'), h('th', { scope: 'col' }, 'Why'), h('th', { scope: 'col' }, 'Details'), h('th', { scope: 'col' }, 'Since'), h('th', { scope: 'col' }, srOnly('Actions')))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', {}, h('a', { href: `#/staff/patient/${r.patient?.id || r.patient_id}` }, r.patient?.full_name || 'Patient'), h('div', { class: 'muted' }, r.patient ? `Mr# ${r.patient.mr_number}${r.patient.phone ? ' · ' + r.patient.phone : ''}` : '')),
        h('td', {}, h('span', { class: ['badge', r.source === 'flag' ? 'badge-ali' : r.source === 'plan' ? 'badge-photo' : 'badge-warn'] }, r.source === 'flag' ? 'Flagged' : r.source === 'plan' ? 'Plan needed' : 'Overrun')),
        h('td', {}, r.reason),
        h('td', { class: 'nowrap muted' }, shortDate(dayOf(r.since))),
        h('td', { class: 'right' }, r.flag_id && can('flags.clear') ? h('button', { class: 'btn btn-small', 'aria-label': `Seen, clear flag for ${r.patient?.full_name || 'this patient'}`, onclick: () => clear(r) }, 'Seen, clear flag') : null))))))
      : empty('Nobody is waiting for Dr. Ali right now.')));
}

// ---------------------------------------------------------------- complaints
// Two kinds arrive here: a patient's complaint from their account (source 'portal'), and the website's "Complaints &
// suggestions" form (source 'website', 20261011000200), which may be anonymous and has a type, a topic and optional contact
// details. A website form has no account to reply to, so its dialog takes internal notes only. Visitors' words are text, never HTML.
const isWebsite = (c) => c.source === 'website';
const statusBadge = (c) => h('span', { class: ['badge', c.status === 'resolved' ? 'badge-ok' : c.status === 'new' ? 'badge-dues' : 'badge-warn'] }, c.status.replace('_', ' '));

/** Who sent it, for the list: the patient, or the website form's name (or "Anonymous") with its number. */
function senderCell(c) {
  if (!isWebsite(c)) return c.patient?.full_name || '';
  return [c.contact_name || h('span', { class: 'muted' }, c.contact_phone || c.contact_mr ? 'No name given' : 'Anonymous'),
    c.contact_phone ? h('div', { class: 'muted nowrap' }, formatPhone(c.contact_phone)) : null,
    c.contact_me ? h('div', {}, h('span', { class: 'badge badge-warn' }, 'Wants to be contacted')) : null];
}

export async function renderComplaints(root, params) {
  const d = state.data;
  let from = ['portal', 'website'].includes(params?.get('from')) ? params.get('from') : '';
  const list = h('div', {});
  let newest = 0;
  // The list is asked again for the chosen source (the database filters it, so a flood of website forms cannot push a patient's
  // complaint off "Patients' accounts"), and after every change.
  async function load() {
    const mine = ++newest; // a slow answer for the choice just left must not overwrite the one on screen
    const rows = await d.complaints({ from }).catch((e) => { toast(friendlyError(e), 'error'); return []; });
    if (mine !== newest) return;
    drawTable(rows);
  }
  const open = (c) => {
    const web = isWebsite(c);
    const reply = h('textarea', { placeholder: web ? 'Write an internal note: what was done, who called back' : 'Reply to the patient, or write an internal note' });
    const internal = h('input', { type: 'checkbox' });
    const doctorSel = select([{ value: '', label: 'Not about a doctor' }, ...state.ref.clinicians.filter((x) => x.is_doctor).map((x) => ({ value: x.id, label: x.display_name }))], c.clinician_id || '', { 'aria-label': 'About which doctor' });
    doctorSel.onchange = async () => { try { await d.linkComplaintDoctor(c.id, doctorSel.value || null); c.clinician_id = doctorSel.value || null; toast('Saved.', 'ok'); } catch (e) { toast(friendlyError(e), 'error'); } };
    const who = web
      ? h('div', { class: 'complaint-contact' },
        h('p', {}, h('span', { class: 'badge badge-photo' }, 'Website form'), ' ', [FEEDBACK_KIND_LABELS[c.kind], FEEDBACK_TOPIC_LABELS[c.topic]].filter(Boolean).join(' · ')),
        c.contact_name || c.contact_phone || c.contact_mr
          ? h('p', {}, c.contact_name ? h('strong', {}, c.contact_name) : 'No name given',
            c.contact_phone ? [' · ', phoneLink(formatPhone(c.contact_phone))] : null,
            c.contact_mr ? [' · Mr# given: ', can('patients.view') ? h('a', { href: `#/staff/patients?q=${encodeURIComponent(c.contact_mr)}` }, c.contact_mr) : c.contact_mr] : null)
          : h('p', { class: 'muted' }, 'Sent without a name or number.'),
        c.contact_me ? h('p', {}, h('span', { class: 'badge badge-warn' }, 'Wants to be contacted'), ' Please call or message them on the number above.') : null)
      : h('p', {}, h('strong', {}, c.patient?.full_name), ` · Mr# ${c.patient?.mr_number || ''}${c.patient?.phone ? ' · ' + c.patient.phone : ''}`);
    const body = h('div', {},
      who,
      h('p', { class: 'muted' }, `${shortDate(dayOf(c.created_at))} · ${c.branch_id ? branchName(c.branch_id) : 'Not about one branch'}`),
      h('div', { class: 'panel pre-wrap', style: { background: 'var(--porcelain)' } }, c.body),
      (c.messages || []).map((m) => h('div', { class: ['alert', m.internal_note ? 'alert-warning' : 'alert-info'], style: { marginTop: '8px' } },
        h('strong', {}, m.internal_note ? 'Internal note' : 'Reply'), m.author ? ` · ${m.author}` : '', h('div', { class: 'pre-wrap' }, m.body))),
      h('div', { style: { marginTop: '12px' } }, web
        ? [field('Internal note', reply, 'This came from the website form: nobody outside the clinic sees what is written here.', { required: true })]
        : [field('Reply', reply, null, { required: true }), h('label', { class: 'inline' }, internal, 'Internal note (patient does not see it)')]),
      // Only a complaint is linked to a doctor: a website suggestion or thank-you is not a complaint about their work.
      !web || c.kind === 'complaint' ? h('div', { style: { marginTop: '12px' } }, field('About which doctor?', doctorSel, 'Linked complaints count on that doctor\'s daily log and dashboard.')) : null);
    // Closing a complaint tells the patient it is done, so it asks first; the complaint dialog stays open underneath until that is confirmed.
    const confirmResolve = () => {
      modal('Mark this complaint resolved?', h('p', {}, web
        ? 'It came from the website form, so nobody is told by itself. You can reopen it afterwards.'
        : `${c.patient?.full_name || 'The patient'} will see it as resolved. You can reopen it afterwards.`), [
        { label: 'Cancel' },
        { label: 'Mark resolved', primary: true, onClick: async () => {
          try { await d.setComplaintStatus(c.id, 'resolved'); } catch (e) { toast(friendlyError(e), 'error'); return false; }
          toast('Marked resolved.', 'ok');
          dlg.close();
          await load(); // the list is redrawn before this dialog closes, so focus can return to the page
        } },
      ]);
      return false;
    };
    // A resolved complaint offers Reopen instead: Mark resolved again would only overwrite who resolved it and when.
    const reopen = async () => {
      try { await d.setComplaintStatus(c.id, 'in_progress'); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      toast('Reopened.', 'ok');
      await load();
    };
    // Anyone can send the website form, so junk can arrive: an admin may delete a website form. A patient's complaint is never deleted.
    const confirmDelete = () => {
      modal('Delete this website form?', h('p', {}, 'It is removed for good, with its notes. Use this only for junk or spam; mark a real complaint resolved instead.'), [
        { label: 'Keep it' },
        { label: 'Delete', danger: true, onClick: async () => {
          try { await d.deleteComplaint(c.id); } catch (e) { toast(friendlyError(e), 'error'); return false; }
          toast('Deleted.', 'ok');
          dlg.close();
          await load();
        } },
      ], { destructive: true });
      return false;
    };
    const dlg = modal(c.subject, body, [
      web && isAdmin() ? { label: 'Delete', danger: true, onClick: confirmDelete } : null,
      c.status === 'resolved' ? { label: 'Reopen', onClick: reopen } : { label: 'Mark resolved', onClick: confirmResolve },
      { label: web ? 'Save note' : 'Send', primary: true, onClick: async () => {
        if (!reply.value.trim()) return showFormErrors(body, [{ input: reply, message: web ? 'Write a note first.' : 'Write a reply first.' }]);
        try { await d.replyComplaint(c.id, reply.value.trim(), web || internal.checked); toast('Saved.', 'ok'); await load(); } catch (e) { toast(friendlyError(e), 'error'); return false; }
      } },
    ].filter(Boolean));
  };
  const drawTable = (shown) => {
    mount(list, capNote(shown, 'complaints (newest first)', 'older ones are not listed'), shown.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list complaints-table' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Complaint'), h('th', { scope: 'col' }, 'From'), h('th', { scope: 'col' }, 'Branch'), h('th', { scope: 'col' }, 'Received'), h('th', { scope: 'col' }, 'Status'))),
      h('tbody', {}, shown.map((c) => h('tr', {},
        h('td', {}, h('button', { class: 'link-btn', onclick: () => open(c) }, c.subject),
          isWebsite(c) ? h('div', {}, h('span', { class: 'badge badge-photo' }, 'Website form')) : null,
          h('div', { class: 'muted' }, c.body.slice(0, 120))),
        h('td', {}, senderCell(c)),
        h('td', {}, c.branch_id ? branchName(c.branch_id) : (isWebsite(c) ? h('span', { class: 'muted' }, 'Not about one branch') : ''), c.clinician_id ? h('div', { class: 'muted' }, clinicianName(c.clinician_id)) : null),
        h('td', { class: 'nowrap' }, shortDate(dayOf(c.created_at))),
        h('td', {}, statusBadge(c)))))))
      : empty(from ? 'Nothing from here yet.' : 'No complaints.'));
  };
  const fromSel = select([{ value: '', label: 'Everything' }, { value: 'portal', label: "Patients' accounts" }, { value: 'website', label: 'Website form' }], from, {
    onchange: (e) => { from = e.target.value; history.replaceState(null, '', `#/staff/complaints${from ? '?from=' + from : ''}`); load(); },
  });
  mount(root,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Complaints'), h('p', {}, 'Sent by patients from their accounts, and by visitors with the "Complaints & suggestions" form on the website. Dr. Ali and the clinic coordinator both see these. Resolved ones stay listed for 90 days.')),
      h('label', { class: 'inline complaints-from' }, 'Show ', fromSel)),
    h('section', { class: 'panel' }, list));
  await load();
}

// ---------------------------------------------------------------- doctor log
export async function renderDoctorLog(root, params) {
  const d = state.data;
  const mine = await d.myClinicianId();
  const doctors = state.ref.clinicians.filter((c) => c.is_doctor);
  const viewAll = can('doctor_log.view_all');
  // The rupees (billed, own patients paid, the share) only for accounts and Dr. Ali (finance.view), or for a doctor on their own log with
  // "See own doctor percentage" (owner, 15 Oct 2026). A coordinator or a shared login sees the treatments and counts; the database
  // leaves the money out for them as well (doctor_summary).
  const showMoney = (id) => can('finance.view') || (!!id && id === mine && can('commission.view_own'));
  // Someone who may see every doctor but has no clinician record of their own starts on the first doctor, not on an error.
  let clinicianId = params.get('doctor') || mine || (viewAll ? doctors[0]?.id : null) || null;
  const from = h('input', { type: 'date', value: params.get('from') || todayISO().slice(0, 8) + '01' });
  const to = h('input', { type: 'date', value: params.get('to') || todayISO() });
  const subtitle = h('p', {}, clinicianName(clinicianId) || '');
  const who = viewAll ? select(doctors.map((c) => ({ value: c.id, label: c.display_name })), clinicianId, { onchange: (e) => { clinicianId = e.target.value; subtitle.textContent = clinicianName(clinicianId) || ''; load(); } }) : null;
  const out = h('div', {});
  let newest = 0;
  async function load() {
    const seq = ++newest; // a slow answer for the doctor just left must not overwrite the one on screen
    if (!clinicianId) { mount(out, empty(viewAll ? 'No doctors set up yet.' : 'Your login is not linked to a doctor yet. Ask Dr. Ali to link it.')); return; }
    try {
      const [rows, sum] = await Promise.all([d.doctorLog({ clinicianId, from: from.value, to: to.value }), d.doctorSummary(clinicianId, from.value, to.value).catch(() => null)]);
      if (seq !== newest) return;
      const days = [...new Set(rows.map((r) => r.visit_date))];
      const complaints = sum?.complaints || [];
      const money = !!sum && showMoney(clinicianId) && sum.billed !== null && sum.billed !== undefined;
      mount(out,
        capNote(rows, 'visits'),
        h('div', { class: 'stat-row', style: { marginBottom: '16px' } },
          h('div', { class: 'stat' }, h('strong', {}, rows.filter((r) => r.role === 'doctor').length), h('span', {}, 'Patients treated')),
          h('div', { class: 'stat' }, h('strong', {}, rows.filter((r) => r.role === 'checker').length), h('span', {}, 'Visits checked')),
          h('div', { class: 'stat' }, h('strong', {}, days.length), h('span', {}, 'Working days')),
          money ? h('div', { class: 'stat' }, h('strong', {}, rupees(sum.billed || 0)), h('span', {}, 'Billed from treated visits')) : null,
          sum ? h('div', { class: 'stat' }, h('strong', {}, sum.referred_patients || 0), h('span', {}, 'Own patients (brought in)')) : null,
          money ? h('div', { class: 'stat' }, h('strong', {}, rupees(sum.referred_paid || 0)), h('span', {}, 'Own patients paid')) : null,
          money && sum.rule ? h('div', { class: 'stat' }, h('strong', {}, rupees(sum.share || 0)), h('span', {}, `Your share (${Number(sum.rule.percent)}% of ${sum.rule.basis === 'referred' ? 'own patients paid' : sum.rule.basis === 'treated' ? 'billed' : 'both'})`)) : null,
          sum ? h('div', { class: 'stat' }, h('strong', { class: complaints.length ? 'status-bad' : null }, complaints.length), h('span', {}, 'Complaints about your work')) : null),
        complaints.length ? h('section', { class: 'panel' }, h('h2', {}, 'Complaints linked to you'),
          h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
            h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Received'), h('th', { scope: 'col' }, 'Subject'), h('th', { scope: 'col' }, 'Patient'), h('th', { scope: 'col' }, 'Branch'), h('th', { scope: 'col' }, 'Status'))),
            h('tbody', {}, complaints.map((c) => h('tr', {},
              h('td', { class: 'nowrap' }, shortDate(dayOf(c.created_at))), h('td', {}, c.subject), h('td', {}, c.patient_name ? `${c.patient_name} · Mr# ${c.mr_number || ''}` : c.source === 'website' ? 'Website form' : ''),
              h('td', {}, branchName(c.branch_id)),
              h('td', {}, h('span', { class: ['badge', c.status === 'resolved' ? 'badge-ok' : c.status === 'new' ? 'badge-dues' : 'badge-warn'] }, String(c.status).replace('_', ' '))))))))) : null,
        rows.length ? h('section', { class: 'panel' }, h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Date'), h('th', { scope: 'col' }, 'Patient'), h('th', { scope: 'col' }, 'Branch'), h('th', { scope: 'col' }, 'Treatment'), h('th', { scope: 'col' }, 'Role'), h('th', { scope: 'col' }, 'Details'))),
          h('tbody', {}, rows.map((r) => h('tr', {},
            h('td', { class: 'nowrap' }, shortDate(r.visit_date)), h('td', {}, r.patient.full_name, h('div', { class: 'muted' }, `Mr# ${r.patient.mr_number}`)),
            h('td', {}, branchName(r.branch_id)), h('td', {}, [capFirst(r.treatment_label), r.braces_month ? `M${r.braces_month}` : null].filter(Boolean).join(' · ')),
            h('td', {}, r.role === 'checker' ? 'Checked' : r.role === 'assistant' ? 'Assisted' : 'Treated'), h('td', {}, r.details_text || ''))))))) : empty('No completed visits in this period.'));
    } catch (e) { if (seq === newest) mount(out, empty(friendlyError(e))); }
  }
  from.addEventListener('change', load);
  to.addEventListener('change', load);
  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Doctor daily log'), subtitle),
      h('div', { class: 'inline' }, who ? h('label', { class: 'inline' }, 'Doctor ', who) : null, h('label', { class: 'inline' }, 'From ', from), h('label', { class: 'inline' }, 'To ', to))),
    out);
  load();
}
