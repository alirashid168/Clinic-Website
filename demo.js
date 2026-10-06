// DEMO data layer: an in-memory clinic with made-up patients, so every screen
// can be tried before the real database is connected. It follows the same
// rules as the database (Mr#, tokens, braces groups, photo months, checker
// sign-off, dues hold, discount caps, permissions). Nothing here is real.

import { protocolFor, guidance as protocolGuidance, LAST_DEFINED_MONTH } from '../lib/protocol.js';
import { PERMISSIONS, ROLES, defaultGrid, hasPermission, discountNeedsApproval } from '../lib/permissions.js';
import { todayISO } from '../ui/dom.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2));
const clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const daysAgo = (n) => {
  const d = new Date(todayISO() + 'T00:00:00');
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};
const fail = (msg) => { throw new Error(msg); };

// ---------------------------------------------------------------- seed
function seed() {
  const db = {};
  db.settings = { dues_hold_mode: 'warn', dropoff_days: 42, low_rating_threshold: 3, whatsapp_number: '',
    clinic_timings: { branches: {
      1: { mode: 'weekly', days: { mon: '12:00-21:00', tue: '12:00-21:00', wed: '12:00-21:00', thu: '12:00-21:00', fri: '15:00-21:00', sat: '12:00-21:00' } },
      2: { mode: 'weekly', days: { mon: '16:00-21:00', thu: '16:00-21:00' } },
      3: { mode: 'weekly', days: { tue: '16:00-21:00' } },
      4: { mode: 'visits', hours: '12:00-21:00' },
      5: { mode: 'visits' },
    } } };
  db.cities = [{ id: 1, name: 'Karachi' }, { id: 2, name: 'Lahore' }, { id: 3, name: 'Islamabad' }];
  db.branches = [
    { id: 1, code: 'GUL', name: 'Gulshan (RJ Mall)', city_id: 1, address: 'RJ Mall, 3rd Floor, Gulshan-e-Iqbal, Karachi', active: true },
    { id: 2, code: 'NN', name: 'North Nazimabad', city_id: 1, address: 'Block M, North Nazimabad, Karachi', active: true },
    { id: 3, code: 'DHA', name: 'DHA Karachi', city_id: 1, address: 'Bukhari Commercial, DHA Phase 6, Karachi', active: true },
    { id: 4, code: 'LHR', name: 'Gulberg Lahore', city_id: 2, address: 'Al Hafeez Business Avenue, Gulberg 3, Lahore', active: true },
    { id: 5, code: 'ISB', name: 'Islamabad', city_id: 3, address: 'Giga Downtown, DHA Phase II, Islamabad', active: true },
  ];
  const doc = (name, group, region, is_doctor = true) => ({ id: uid(), display_name: name, doctor_group_id: group, region, is_doctor, aliases: [], staff_id: null, active: true });
  db.clinicians = [
    doc('Dr. Ali Rashid', null, null),
    doc('Dr. Komal Rubab', 1, 'KHI'), doc('Dr. Samrah Khan', 1, 'KHI'), doc('Dr. Warda Javed', 1, null),
    doc('Dr. Urooj Jawed', 2, 'KHI'), doc('Dr. Mehwish Saleem', 2, 'KHI'), doc('Dr. Maheen Fatima', 2, null), doc('Dr. Kainat Waheed', 2, null),
    doc('Dr. Hameeda Sharaf', 3, 'KHI'), doc('Dr. Haniya Siddiqui', 3, 'KHI'), doc('Dr. Mirha Siddiq', 3, 'KHI'), doc('Dr. Laiba Khan', 3, 'KHI'),
    doc('Dr. Vaneeza Khan', 3, 'LHR'), doc('Dr. Duaa Nusrat', 3, 'LHR'), doc('Dr. Zunash Suhail', 3, 'LHR'), doc('Dr. Rida Jameel', 3, 'LHR'),
    doc('Dr. Aimon Aslam', null, null), doc('Dr. Maham Waheed', null, 'ISB'), doc('Dr. Aqsa Nadeem', null, 'ISB'),
    doc('Hira Anis', null, 'KHI', false), doc('Anousha Khan', null, 'KHI', false),
  ];
  const cl = (name) => db.clinicians.find((c) => c.display_name === name).id;

  db.treatments = ['Monthly', 'Bonding', 'Upper Bonding', 'Lower Bonding', 'Bracket Fix', 'Braces Checkup', 'Braces Scaling', 'Braces Off',
    'Retainer Impression', 'Retainer Pick', 'Retainer Followup', 'Checkup', 'Followup', 'Scaling', 'Filling', 'RCT', 'Extraction',
    'X-Ray / OPG', 'Crown Insertion', 'Veneers Insertion', 'Smile Makeover', 'Shape Modification', 'Hygiene Appointment', 'Pain / Emergency']
    .map((name, i) => ({ id: i + 1, name, category: i < 8 ? 'braces' : i < 11 ? 'retainer' : 'general', is_braces_monthly: name === 'Monthly', active: true }));

  db.expense_categories = ['Rent', 'Salaries', 'Doctor percentage', 'Dental supplies', 'Lab charges', 'Utilities (electricity, gas, water)',
    'Internet and phone', 'Maintenance and repairs', 'Marketing and ads', 'Taxes', 'Travel', 'Staff food and refreshments', 'Miscellaneous']
    .map((name, i) => ({ id: i + 1, name, active: true }));

  db.discount_caps = { front_desk: { maxPercent: 10, maxAmount: 5000 }, accountant: { maxPercent: null, maxAmount: null } };
  db.grid = defaultGrid();
  db.overrides = {};

  db.staff = [
    { id: 's-admin', full_name: 'Dr. Ali Rashid', email: 'ali@dralirashid.com', role: 'admin', active: true, branch_ids: [], restrict_to_branches: false },
    { id: 's-fd-nn', full_name: 'Front desk (North Nazimabad)', email: 'frontdesk.nn@dralirashid.com', role: 'front_desk', active: true, branch_ids: [2], restrict_to_branches: true, home_branch_id: 2 },
    { id: 's-fd-gul', full_name: 'Front desk (Gulshan)', email: 'frontdesk.gulshan@dralirashid.com', role: 'front_desk', active: true, branch_ids: [1], restrict_to_branches: true, home_branch_id: 1 },
    { id: 's-asst', full_name: 'Assistant', email: 'assistant@dralirashid.com', role: 'assistant', active: true, branch_ids: [], restrict_to_branches: false },
    { id: 's-doc', full_name: 'Dr. Samrah Khan', email: 'samrah@dralirashid.com', role: 'doctor', active: true, branch_ids: [], restrict_to_branches: false, clinician_id: cl('Dr. Samrah Khan') },
    { id: 's-coord', full_name: 'Clinic coordinator', email: 'coordinator@dralirashid.com', role: 'coordinator', active: true, branch_ids: [], restrict_to_branches: false },
    { id: 's-acct', full_name: 'Accountant', email: 'accounts@dralirashid.com', role: 'accountant', active: true, branch_ids: [], restrict_to_branches: false },
  ];
  db.clinicians.find((c) => c.display_name === 'Dr. Samrah Khan').staff_id = 's-doc';
  db.clinicians.find((c) => c.display_name === 'Dr. Ali Rashid').staff_id = 's-admin';

  // Made-up patients
  const names = ['Areeba Siddiqui', 'Hamza Qureshi', 'Mahnoor Iqbal', 'Zainab Rizvi', 'Fatima Noor', 'Usman Tariq', 'Iqra Shahid', 'Ayesha Kamal',
    'Bilal Ahmed', 'Sana Farooq', 'Hira Javed', 'Rabia Hussain', 'Talha Saeed', 'Mariam Akhtar', 'Kinza Rauf', 'Saad Malik', 'Nimra Asif',
    'Hafsa Yousuf', 'Daniyal Aziz', 'Anum Waqar', 'Laraib Fatima', 'Emaan Khalid', 'Shayan Ali', 'Mehwish Arif', 'Zoya Haider', 'Ammar Shafiq',
    'Rimsha Nadeem', 'Faiza Imtiaz', 'Taha Mansoor', 'Huma Zafar'];
  db.patients = names.map((full_name, i) => ({
    id: uid(), mr_number: String(9811 + i), full_name,
    phone: '03' + String(10000000 + i * 734521).padStart(9, '0').slice(0, 9),
    email: i % 3 === 0 ? full_name.toLowerCase().replace(/[^a-z]/g, '.') + '@example.com' : null,
    first_branch_id: (i % 5) + 1, referral_source: ['Instagram', 'Referral', 'Walk-in', 'Google', 'Facebook'][i % 5],
    photo_consent_public: i % 4 === 0, created_at: daysAgo(400 - i * 10), notes: null, portal_user_id: null,
  }));
  db.patients[0].portal_user_id = 'p-demo';
  db.mr_next = 9841;

  // Braces cases with history
  db.braces_cases = [];
  db.visits = [];
  db.visit_staff = [];
  const braces = [
    [0, 3, 'undecided'], [1, 7, 'extraction'], [2, 11, 'non_extraction'], [3, 1, 'undecided'], [4, 14, 'non_extraction'],
    [5, 8, 'extraction'], [6, 5, 'non_extraction'], [7, 17, 'extraction'], [8, 2, 'undecided'], [9, 12, 'extraction'],
    [10, 9, 'non_extraction'], [11, 6, 'extraction'], [12, 0, 'undecided'],
  ];
  for (const [pi, monthsDone, plan] of braces) {
    const p = db.patients[pi];
    const bc = { id: uid(), patient_id: p.id, start_date: daysAgo(monthsDone * 30 + 10), extraction_plan: plan,
      extractions_done: plan === 'extraction' && monthsDone >= 6, kit_name: ['55k kit', '70k kit', '80k kit'][pi % 3],
      total_fee: [55000, 70000, 80000][pi % 3], status: 'active', treatment_plan_by_dr_ali: monthsDone >= 1 ? 'Standard plan' : null };
    db.braces_cases.push(bc);
    for (let m = 1; m <= monthsDone; m++) {
      db.visits.push({ id: uid(), patient_id: p.id, branch_id: p.first_branch_id, visit_date: daysAgo((monthsDone - m) * 30 + 5),
        token_no: 1 + (m % 9), status: 'completed', treatment_label: m === 1 ? 'Bonding' : 'Monthly', braces_case_id: bc.id, braces_month: m,
        details_text: m === 1 ? 'Bonding' : `U L 0${m < 3 ? 12 : m < 4 ? 14 : m < 8 ? 16 : 18} PC refresh`, photo_required: protocolFor(m).photoRequired,
        photos_uploaded: true, checker_required: protocolFor(m).checkerGroup !== null, checked_by: cl('Dr. Komal Rubab'), created_at: daysAgo(1), notes: null });
    }
    // fee invoice + partial payments
    db.invoices = db.invoices || [];
    db.payments = db.payments || [];
    const inv = { id: uid(), invoice_no: 'INV-2026-' + String(db.invoices.length + 1).padStart(6, '0'), patient_id: p.id, branch_id: p.first_branch_id,
      issue_date: bc.start_date, subtotal: bc.total_fee, discount_amount: 0, status: 'issued', template_key: 'classic',
      items: [{ description: `Braces ${bc.kit_name}`, quantity: 1, unit_price: bc.total_fee }] };
    inv.total = inv.subtotal - inv.discount_amount;
    db.invoices.push(inv);
    const paid = pi % 3 === 0 ? bc.total_fee : pi % 3 === 1 ? bc.total_fee - 15000 : bc.total_fee / 2;
    db.payments.push({ id: uid(), patient_id: p.id, invoice_id: inv.id, branch_id: p.first_branch_id, amount: paid, method: 'cash', received_at: bc.start_date + 'T15:00:00' });
  }

  // Today's Aaj ki List at North Nazimabad and Gulshan
  const today = todayISO();
  const todayRows = [
    [0, 2, 'Monthly', 'completed', ['Dr. Urooj Jawed', 'Hira Anis'], 'U L 016 Pc refresh'],
    [1, 2, 'Monthly', 'in_treatment', ['Dr. Hameeda Sharaf'], ''],
    [13, 2, 'Checkup', 'completed', ['Dr. Haniya Siddiqui'], 'Scaling advised'],
    [6, 2, 'Monthly', 'waiting', [], ''],
    [14, 2, 'Crown Insertion', 'waiting', [], ''],
    [10, 2, 'Monthly', 'waiting', [], ''],
    [3, 1, 'Monthly', 'completed', ['Dr. Komal Rubab'], 'U L 012'],
    [4, 1, 'Monthly', 'waiting', [], ''],
    [15, 1, 'Retainer Impression', 'waiting', [], ''],
    [16, 1, 'Pain / Emergency', 'scheduled', [], ''],
  ];
  const tokenCount = {};
  for (const [pi, branch, label, status, docs, details] of todayRows) {
    const p = db.patients[pi];
    const bc = db.braces_cases.find((b) => b.patient_id === p.id);
    const done = bc ? db.visits.filter((v) => v.braces_case_id === bc.id && v.status === 'completed').length : 0;
    const month = bc && label === 'Monthly' ? done + 1 : null;
    tokenCount[branch] = (tokenCount[branch] || 0) + (status === 'scheduled' ? 0 : 1);
    const v = { id: uid(), patient_id: p.id, branch_id: branch, visit_date: today, token_no: status === 'scheduled' ? null : tokenCount[branch],
      status, treatment_label: label, braces_case_id: month ? bc.id : null, braces_month: month, details_text: details,
      photo_required: month ? protocolFor(month).photoRequired : false, photos_uploaded: status === 'completed',
      checker_required: month ? protocolFor(month).checkerGroup !== null : false, checked_by: status === 'completed' ? cl('Dr. Samrah Khan') : null,
      checked_in_at: today + 'T13:' + String(10 + db.visits.length % 40).padStart(2, '0') + ':00', created_at: new Date().toISOString(), notes: null };
    db.visits.push(v);
    for (const d of docs) db.visit_staff.push({ visit_id: v.id, clinician_id: cl(d), role: d.startsWith('Dr') ? 'doctor' : 'assistant' });
  }

  db.patient_flags = [{ id: uid(), patient_id: db.patients[4].id, kind: 'see_dr_ali', reason: 'Wire poking, relapse in lower anterior', raised_by: 's-asst', raised_at: daysAgo(2) + 'T16:00:00', cleared_at: null }];
  db.complaints = [{ id: uid(), patient_id: db.patients[7].id, branch_id: 1, subject: 'Waiting time', body: 'I waited almost two hours on Saturday even with a token.', status: 'new', created_at: daysAgo(1) + 'T20:15:00' }];
  db.complaint_messages = [];
  db.discount_requests = [];
  db.expenses = [
    { id: uid(), expense_date: daysAgo(3), branch_id: 2, city_id: 1, category_id: 1, amount: 180000, paid_to: 'Landlord', method: 'bank_transfer', notes: 'Monthly rent' },
    { id: uid(), expense_date: daysAgo(2), branch_id: 1, city_id: 1, category_id: 4, amount: 46500, paid_to: 'Supplier', method: 'cash', notes: 'Brackets and wires' },
    { id: uid(), expense_date: daysAgo(1), branch_id: 4, city_id: 2, category_id: 6, amount: 38200, paid_to: 'LESCO', method: 'bank_transfer', notes: '' },
    { id: uid(), expense_date: daysAgo(1), branch_id: 2, city_id: 1, category_id: 12, amount: 3500, paid_to: 'Staff lunch', method: 'cash', notes: '' },
  ];
  db.cash_closings = [];
  db.lab_cases = [
    { id: uid(), patient_id: db.patients[14].id, branch_id: 2, lab_name: 'In-house lab', work_type: 'Crown', sent_date: daysAgo(6), due_date: daysAgo(-1), status: 'received', cost: 6000 },
    { id: uid(), patient_id: db.patients[17].id, branch_id: 1, lab_name: 'City Dental Lab', work_type: 'Veneers (6 units)', sent_date: daysAgo(10), due_date: daysAgo(2), status: 'sent', cost: 42000 },
  ];
  db.retainer_cases = [
    { id: uid(), patient_id: db.patients[7].id, arch: 'both', stage: 'fabrication', impression_date: daysAgo(4), lab_cost: 2500, price: 15000 },
  ];
  db.reminders = [
    { id: uid(), patient_id: db.patients[5].id, kind: 'dues', due_date: daysAgo(0), note: 'Month 8 dues checkpoint', status: 'open' },
    { id: uid(), patient_id: db.patients[11].id, kind: 'appointment', due_date: daysAgo(-2), note: 'Monthly due', status: 'open' },
    { id: uid(), patient_id: db.patients[18].id, kind: 'followup', due_date: daysAgo(1), note: 'Post-RCT check', status: 'contacted' },
  ];
  db.visit_ratings = [{ visit_id: db.visits[0].id, patient_id: db.patients[0].id, stars: 2, comment: 'Long wait', created_at: daysAgo(3) }];
  db.photos = [];
  db.schedule = [
    { id: uid(), branch_id: 1, weekday: 1, start_time: '12:00', end_time: '16:00' },
    { id: uid(), branch_id: 2, weekday: 1, start_time: '16:00', end_time: '21:00' },
    { id: uid(), branch_id: 1, weekday: 2, start_time: '12:00', end_time: '16:00' },
    { id: uid(), branch_id: 3, weekday: 2, start_time: '16:00', end_time: '21:00' },
    { id: uid(), branch_id: 1, weekday: 3, start_time: '12:00', end_time: '21:00' },
    { id: uid(), branch_id: 1, weekday: 4, start_time: '12:00', end_time: '16:00' },
    { id: uid(), branch_id: 2, weekday: 4, start_time: '16:00', end_time: '21:00' },
    { id: uid(), branch_id: 1, weekday: 5, start_time: '15:00', end_time: '21:00' },
    { id: uid(), branch_id: 1, weekday: 6, start_time: '12:00', end_time: '21:00' },
    { id: uid(), branch_id: 4, on_date: daysAgo(-2), start_time: '12:00', end_time: '21:00' },
    { id: uid(), branch_id: 4, on_date: daysAgo(-3), start_time: '12:00', end_time: '21:00' },
    { id: uid(), branch_id: 5, on_date: daysAgo(-9), start_time: '16:00', end_time: '22:00' },
  ];
  db.audit = [];
  return db;
}

// ---------------------------------------------------------------- adapter
export function createDemoAdapter() {
  let db = seed();
  let session = null; // { staff } | { patient }

  const me = () => session?.staff || null;
  const can = (key) => {
    const s = me();
    return !!s && s.active && hasPermission(s.role, key, db.grid, db.overrides[s.id] || {});
  };
  const need = (key) => { if (!can(key)) fail('new row violates row-level security policy (' + key + ')'); };
  const branchOk = (branchId) => { const s = me(); return !!s && (s.role === 'admin' || !s.restrict_to_branches || s.branch_ids.includes(Number(branchId))); };
  const audit = (table, action, row) => db.audit.unshift({ table_name: table, action, row_id: row?.id, actor: me()?.full_name || 'patient', at: new Date().toISOString() });
  const patient = (id) => db.patients.find((p) => p.id === id);
  const dues = (pid) => db.invoices.filter((i) => i.patient_id === pid && i.status === 'issued').reduce((s, i) => s + i.total, 0)
    - db.payments.filter((p) => p.patient_id === pid).reduce((s, p) => s + p.amount, 0);
  const activeFlag = (pid) => db.patient_flags.find((f) => f.patient_id === pid && !f.cleared_at) || null;
  const activeCase = (pid) => db.braces_cases.find((b) => b.patient_id === pid && b.status === 'active') || null;
  const nextMonth = (caseId) => 1 + Math.max(0, ...db.visits.filter((v) => v.braces_case_id === caseId && v.status === 'completed' && v.braces_month).map((v) => v.braces_month));
  const clinician = (id) => db.clinicians.find((c) => c.id === id);
  const permsFor = (s) => new Set(PERMISSIONS.map((p) => p.key).filter((k) => hasPermission(s.role, k, db.grid, db.overrides[s.id] || {})));

  const enrichVisit = (v) => {
    const p = patient(v.patient_id);
    return { ...clone(v), patient: { id: p.id, mr_number: p.mr_number, full_name: p.full_name, phone: p.phone },
      staff: db.visit_staff.filter((s) => s.visit_id === v.id).map((s) => ({ ...s, name: clinician(s.clinician_id)?.display_name })),
      dues: dues(v.patient_id), see_dr_ali: !!activeFlag(v.patient_id) };
  };

  function applyVisitRules(v, prev) {
    if (v.braces_month && (!prev || prev.braces_month !== v.braces_month)) {
      const rule = protocolFor(v.braces_month);
      v.photo_required = rule.photoRequired && v.braces_month <= LAST_DEFINED_MONTH;
      v.checker_required = rule.checkerGroup !== null;
    }
    if (!prev || prev.status !== v.status) {
      if (v.status === 'waiting' && !v.checked_in_at) v.checked_in_at = new Date().toISOString();
      if (v.token_no == null && (v.status === 'waiting' || v.status === 'in_treatment')) {
        v.token_no = 1 + Math.max(0, ...db.visits.filter((x) => x.branch_id === v.branch_id && x.visit_date === v.visit_date && x.token_no).map((x) => x.token_no));
      }
      if (v.status === 'in_treatment') {
        const d = dues(v.patient_id);
        v.dues_at_checkin = d;
        const mode = db.settings.dues_hold_mode;
        const checkpoint = v.braces_month && protocolFor(v.braces_month).duesCheckpoint;
        if (d > 0 && !v.dues_override_by && (mode === 'block' || (mode === 'block_at_checkpoints' && checkpoint))) {
          fail(`DUES_HOLD: patient has pending dues of Rs ${d.toLocaleString('en-PK')}. Clear dues first or get an override.`);
        }
      }
      if (v.status === 'completed' && !v.protocol_override_by) {
        if (v.photo_required && !v.photos_uploaded) fail('PHOTO_REQUIRED: this is a photo month. Upload photos before completing the visit.');
        const hasChecker = db.visit_staff.some((s) => s.visit_id === v.id && s.role === 'checker');
        if (v.checker_required && !v.checked_by && !hasChecker) fail('CHECK_REQUIRED: this visit must be checked by the checker group before completing.');
      }
    }
  }

  return {
    mode: 'demo',

    // ------------------------------------------------------------ auth
    async demoAccounts() {
      return [
        ...db.staff.filter((s) => s.active).map((s) => ({ kind: 'staff', id: s.id, label: s.full_name, role: s.role, email: s.email })),
        { kind: 'patient', id: 'p-demo', label: `Patient: ${db.patients[0].full_name}`, role: 'patient' },
      ];
    },
    async signInDemo(id) {
      if (id === 'p-demo') session = { patient: db.patients[0] };
      else {
        const s = db.staff.find((x) => x.id === id);
        if (!s || !s.active) fail('This account is switched off.');
        session = { staff: s };
      }
      return this.getSession();
    },
    async signIn() { fail('In demo mode, pick an account from the list.'); },
    async signOut() { session = null; },
    async getSession() {
      if (!session) return null;
      if (session.patient) return { kind: 'patient', patient: clone(session.patient), perms: new Set() };
      const s = db.staff.find((x) => x.id === session.staff.id);
      if (!s?.active) { session = null; return null; }
      return { kind: 'staff', staff: clone(s), perms: permsFor(s) };
    },
    async resetDemo() { db = seed(); session = null; },

    // ------------------------------------------------------------ reference
    async branches() { return clone(db.branches.filter((b) => b.active)); },
    async cities() { return clone(db.cities); },
    async clinicians() { return clone(db.clinicians.filter((c) => c.active)); },
    async treatments() { return clone(db.treatments.filter((t) => t.active)); },
    async expenseCategories() { return clone(db.expense_categories); },
    async settings() { return clone(db.settings); },
    async schedule() { return clone(db.schedule); },
    async publicCases() { return clone(db.photos.filter((p) => p.public_ok && p.kind === 'edited')); },

    // ------------------------------------------------------------ patients
    async searchPatients(q) {
      need('patients.view');
      const t = (q || '').trim().toLowerCase();
      const rows = db.patients.filter((p) => !t || p.full_name.toLowerCase().includes(t) || p.mr_number.includes(t) || p.phone.replace(/\D/g, '').includes(t.replace(/\D/g, '') || '~'));
      return rows.slice(0, 50).map((p) => ({ ...clone(p), dues: dues(p.id), see_dr_ali: !!activeFlag(p.id), braces_active: !!activeCase(p.id) }));
    },
    async findDuplicates(name, phone) {
      const n = (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const ph = (phone || '').replace(/\D/g, '');
      return clone(db.patients.filter((p) => (n && p.full_name.toLowerCase() === n) || (ph.length >= 7 && p.phone.replace(/\D/g, '') === ph)));
    },
    async createPatient(row) {
      need('patients.create');
      const phone = (row.phone || '').replace(/[^0-9+]/g, '');
      if (phone.length < 7) fail('Phone number is required.');
      if (!row.full_name || row.full_name.trim().length < 2) fail('Patient name is required.');
      let mr = row.mr_number?.trim();
      if (!mr) { while (db.patients.some((p) => p.mr_number === String(db.mr_next))) db.mr_next++; mr = String(db.mr_next++); }
      const p = { id: uid(), mr_number: mr, full_name: row.full_name.trim().replace(/\s+/g, ' '), phone, email: row.email || null,
        gender: row.gender || null, date_of_birth: row.date_of_birth || null, first_branch_id: Number(row.first_branch_id) || null,
        referral_source: row.referral_source || null, photo_consent_public: !!row.photo_consent_public, notes: row.notes || null,
        created_at: new Date().toISOString() };
      db.patients.push(p); audit('patients', 'INSERT', p);
      return clone(p);
    },
    async updatePatient(id, changes) {
      need('patients.edit');
      const p = patient(id);
      if ('mr_number' in changes && changes.mr_number !== p.mr_number && me().role !== 'admin') fail('Mr# cannot be changed (only admin can)');
      Object.assign(p, changes); audit('patients', 'UPDATE', p);
      return clone(p);
    },
    async invitePatient(id) {
      need('portal.invite');
      const p = patient(id);
      if (!p.email) fail("Add the patient's email first.");
      if (p.portal_user_id) fail('This patient already has a portal login.');
      p.portal_user_id = 'p-' + id;
    },
    async getPatient(id) {
      const s = await this.getSession();
      if (s?.kind === 'patient' && s.patient.id !== id) fail('not allowed');
      if (s?.kind === 'staff') need('patients.view');
      const p = patient(id);
      if (!p) fail('Patient not found');
      const bc = activeCase(id);
      return {
        ...clone(p), dues: dues(id), flag: clone(activeFlag(id)),
        braces_case: bc ? { ...clone(bc), next_month: nextMonth(bc.id) } : null,
        visits: db.visits.filter((v) => v.patient_id === id).sort((a, b) => b.visit_date.localeCompare(a.visit_date)).map(enrichVisit),
        invoices: clone(db.invoices.filter((i) => i.patient_id === id && (s?.kind === 'staff' || i.status === 'issued'))),
        payments: clone(db.payments.filter((x) => x.patient_id === id)),
        photos: clone(db.photos.filter((x) => x.patient_id === id && (s?.kind === 'staff' || x.kind === 'edited'))),
        retainers: clone(db.retainer_cases.filter((r) => r.patient_id === id)),
        complaints: clone(db.complaints.filter((c) => c.patient_id === id)),
      };
    },

    // ------------------------------------------------------------ braces
    async bracesGuidance(patientId) {
      const bc = activeCase(patientId);
      if (!bc) return { has_active_case: false };
      const month = nextMonth(bc.id);
      const g = protocolGuidance({ month, extractionPlan: bc.extraction_plan, extractionsDone: bc.extractions_done, hasDrAliPlan: !!bc.treatment_plan_by_dr_ali, dues: dues(patientId) });
      return { has_active_case: true, case_id: bc.id, month, treating_groups: g.rule.treatingGroups, checker_group: g.rule.checkerGroup,
        planned_wire: g.rule.plannedWire, photo_required: g.rule.photoRequired && !g.beyondProtocol, rule_confirmed: g.rule.confirmed && !g.beyondProtocol,
        alerts: g.alerts, dues: dues(patientId), extraction_plan: bc.extraction_plan, extractions_done: bc.extractions_done,
        has_dr_ali_plan: !!bc.treatment_plan_by_dr_ali };
    },
    async startBracesCase(patientId, fields) {
      need('braces.manage');
      if (activeCase(patientId)) fail('This patient already has an active braces case.');
      const bc = { id: uid(), patient_id: patientId, start_date: fields.start_date || todayISO(), extraction_plan: 'undecided', extractions_done: false,
        kit_name: fields.kit_name || null, total_fee: Number(fields.total_fee) || null, status: 'active', treatment_plan_by_dr_ali: null };
      db.braces_cases.push(bc); audit('braces_cases', 'INSERT', bc);
      return clone(bc);
    },
    async updateBracesCase(id, changes) {
      need('braces.manage');
      const bc = db.braces_cases.find((b) => b.id === id);
      Object.assign(bc, changes); audit('braces_cases', 'UPDATE', bc);
      return clone(bc);
    },

    // ------------------------------------------------------------ visits
    async listVisits({ branchId, date }) {
      need('sheet.view');
      return db.visits.filter((v) => (!branchId || v.branch_id === Number(branchId)) && v.visit_date === date && branchOk(v.branch_id))
        .sort((a, b) => (a.token_no ?? 999) - (b.token_no ?? 999)).map(enrichVisit);
    },
    async addVisit(row) {
      need('sheet.edit');
      if (!branchOk(row.branch_id)) fail('new row violates row-level security policy (branch)');
      const v = { id: uid(), patient_id: row.patient_id, branch_id: Number(row.branch_id), visit_date: row.visit_date || todayISO(),
        token_no: null, status: row.status || 'waiting', treatment_label: row.treatment_label || null, braces_case_id: null, braces_month: null,
        details_text: row.details_text || '', notes: row.notes || null, photo_required: false, photos_uploaded: false, checker_required: false,
        checked_by: null, created_at: new Date().toISOString() };
      const bc = activeCase(v.patient_id);
      if (bc && (row.braces || /monthly/i.test(v.treatment_label || ''))) { v.braces_case_id = bc.id; v.braces_month = row.braces_month || nextMonth(bc.id); }
      applyVisitRules(v, null);
      db.visits.push(v); audit('visits', 'INSERT', v);
      return enrichVisit(v);
    },
    async updateVisit(id, changes) {
      need('sheet.edit');
      const v = db.visits.find((x) => x.id === id);
      if (!v || !branchOk(v.branch_id)) fail('Visit not found');
      if ('dues_override_by' in changes && changes.dues_override_by && !can('dues.override')) fail('You are not allowed to override the dues hold');
      if ('protocol_override_by' in changes && changes.protocol_override_by && !can('braces.override')) fail('You are not allowed to override the braces protocol');
      const next = { ...v, ...changes };
      if (next.dues_override_by === true) next.dues_override_by = me().id;
      if (next.protocol_override_by === true) next.protocol_override_by = me().id;
      applyVisitRules(next, v);
      Object.assign(v, next); audit('visits', 'UPDATE', v);
      return enrichVisit(v);
    },
    async setVisitStaff(visitId, clinicianId, role, add = true) {
      if (!can('treatment.enter') && !can('sheet.edit')) fail('row-level security policy (treatment.enter)');
      const v = db.visits.find((x) => x.id === visitId);
      if (!add) {
        db.visit_staff = db.visit_staff.filter((s) => !(s.visit_id === visitId && s.clinician_id === clinicianId && s.role === role));
        if (role === 'checker' && v.checked_by === clinicianId) v.checked_by = null;
        return enrichVisit(v);
      }
      const c = clinician(clinicianId);
      const isAli = c.staff_id && db.staff.find((s) => s.id === c.staff_id)?.role === 'admin';
      if (v.braces_month && !v.protocol_override_by && c.is_doctor && !isAli) {
        const rule = protocolFor(v.braces_month);
        if (role === 'doctor' && !rule.treatingGroups.includes(c.doctor_group_id)) {
          fail(`GROUP_NOT_ALLOWED: Month ${v.braces_month} braces visits are for Group ${rule.treatingGroups.join(' / ')}. ${c.display_name} is in ${c.doctor_group_id ? 'Group ' + c.doctor_group_id : 'no group'}.`);
        }
        if (role === 'checker' && rule.checkerGroup !== null && c.doctor_group_id !== rule.checkerGroup) {
          fail(`CHECKER_NOT_ALLOWED: Month ${v.braces_month} must be checked by Group ${rule.checkerGroup}.`);
        }
      }
      if (!db.visit_staff.some((s) => s.visit_id === visitId && s.clinician_id === clinicianId && s.role === role)) {
        db.visit_staff.push({ visit_id: visitId, clinician_id: clinicianId, role });
      }
      if (role === 'checker') v.checked_by = clinicianId;
      return enrichVisit(v);
    },

    // ------------------------------------------------------------ photos
    async uploadPhoto({ patientId, visitId, file, viewLabel, branchId }) {
      need('photos.upload');
      const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
      const ph = { id: uid(), patient_id: patientId, visit_id: visitId || null, branch_id: branchId || null, taken_on: todayISO(), kind: 'raw',
        view_label: viewLabel || null, url: dataUrl, storage_path: `demo/${uid()}`, public_ok: false, created_at: new Date().toISOString() };
      db.photos.push(ph);
      if (visitId) { const v = db.visits.find((x) => x.id === visitId); if (v) v.photos_uploaded = true; }
      return clone(ph);
    },

    // ------------------------------------------------------------ billing
    async createInvoice({ patient_id, branch_id, items, discount_amount = 0, discount_reason = null, visit_id = null }) {
      need('billing.create');
      if (!branchOk(branch_id)) fail('new row violates row-level security policy (branch)');
      const subtotal = items.reduce((s, it) => s + Number(it.quantity || 1) * Number(it.unit_price || 0), 0);
      const role = me().role;
      const pending = discountNeedsApproval(role, subtotal, Number(discount_amount), db.discount_caps[role], can('discount.approve'));
      const inv = { id: uid(), invoice_no: 'INV-' + todayISO().slice(0, 4) + '-' + String(db.invoices.length + 1).padStart(6, '0'), patient_id,
        branch_id: Number(branch_id), visit_id, issue_date: todayISO(), subtotal, discount_amount: Number(discount_amount), discount_reason,
        total: Math.max(0, subtotal - Number(discount_amount)), status: pending ? 'pending_approval' : 'issued', template_key: 'classic',
        items: items.map((it) => ({ description: it.description, quantity: Number(it.quantity || 1), unit_price: Number(it.unit_price) })),
        created_by: me().id };
      db.invoices.push(inv); audit('invoices', 'INSERT', inv);
      if (pending) db.discount_requests.push({ id: uid(), invoice_id: inv.id, requested_by: me().full_name, discount_amount: inv.discount_amount, reason: discount_reason, status: 'pending', created_at: new Date().toISOString() });
      return clone(inv);
    },
    async recordPayment({ patient_id, branch_id, amount, method = 'cash', invoice_id = null, notes = null }) {
      need('billing.create');
      if (Number(amount) < 0) need('billing.refund');
      if (!branchOk(branch_id)) fail('new row violates row-level security policy (branch)');
      const pay = { id: uid(), patient_id, branch_id: Number(branch_id), amount: Number(amount), method, invoice_id, notes, received_at: new Date().toISOString(), received_by: me().full_name };
      db.payments.push(pay); audit('payments', 'INSERT', pay);
      return clone(pay);
    },
    async voidInvoice(id, reason) {
      need('billing.edit');
      if (!reason) fail('A reason is required to void an invoice');
      const inv = db.invoices.find((i) => i.id === id);
      inv.status = 'void'; inv.void_reason = reason; audit('invoices', 'UPDATE', inv);
    },
    async discountRequests() {
      if (!can('discount.approve')) return [];
      return db.discount_requests.filter((r) => r.status === 'pending').map((r) => {
        const inv = db.invoices.find((i) => i.id === r.invoice_id);
        return { ...clone(r), invoice: clone(inv), patient: clone(patient(inv.patient_id)) };
      });
    },
    async decideDiscount(id, approve) {
      need('discount.approve');
      const r = db.discount_requests.find((x) => x.id === id);
      const inv = db.invoices.find((i) => i.id === r.invoice_id);
      r.status = approve ? 'approved' : 'rejected';
      if (!approve) { inv.discount_amount = 0; inv.total = inv.subtotal; }
      inv.status = 'issued'; audit('discount_requests', 'UPDATE', r);
    },

    // ------------------------------------------------------------ flags & complaints
    async raiseFlag(patientId, reason) {
      need('flags.raise');
      if (activeFlag(patientId)) fail('This patient is already flagged for Dr. Ali.');
      db.patient_flags.push({ id: uid(), patient_id: patientId, kind: 'see_dr_ali', reason, raised_by: me().full_name, raised_at: new Date().toISOString(), cleared_at: null });
    },
    async clearFlag(flagId, note) {
      need('flags.clear');
      const f = db.patient_flags.find((x) => x.id === flagId);
      f.cleared_at = new Date().toISOString(); f.cleared_note = note || null;
    },
    async reviewList() {
      const flags = db.patient_flags.filter((f) => !f.cleared_at).map((f) => ({ source: 'flag', patient: clone(patient(f.patient_id)), reason: f.reason, since: f.raised_at, flag_id: f.id }));
      const overruns = db.braces_cases.filter((b) => b.status === 'active').map((b) => ({ b, done: nextMonth(b.id) - 1 }))
        .filter(({ b, done }) => (b.extraction_plan === 'non_extraction' && done > 12) || (b.extraction_plan === 'extraction' && done > 18))
        .map(({ b, done }) => ({ source: 'overrun', patient: clone(patient(b.patient_id)), reason: `${b.extraction_plan.replace('_', '-')} case at month ${done}`, since: b.start_date }));
      return [...flags, ...overruns];
    },
    async complaints() {
      need('complaints.view');
      return db.complaints.map((c) => ({ ...clone(c), patient: clone(patient(c.patient_id)), messages: clone(db.complaint_messages.filter((m) => m.complaint_id === c.id)) }))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
    async fileComplaint({ subject, body }) {
      const s = await this.getSession();
      if (s?.kind !== 'patient') fail('Only patients file complaints here.');
      const c = { id: uid(), patient_id: s.patient.id, branch_id: s.patient.first_branch_id, subject, body, status: 'new', created_at: new Date().toISOString() };
      db.complaints.push(c);
      return clone(c);
    },
    async replyComplaint(id, body, internal = false) {
      need('complaints.view');
      db.complaint_messages.push({ id: uid(), complaint_id: id, author: me().full_name, body, internal_note: internal, created_at: new Date().toISOString() });
      const c = db.complaints.find((x) => x.id === id); if (c.status === 'new') c.status = 'in_progress';
    },
    async setComplaintStatus(id, status) {
      need('complaints.view');
      const c = db.complaints.find((x) => x.id === id);
      c.status = status; if (status === 'resolved') c.resolved_at = new Date().toISOString();
    },

    // ------------------------------------------------------------ coordinator
    async labCases() { if (!can('lab.manage') && !can('patients.view')) return []; return db.lab_cases.map((l) => ({ ...clone(l), patient: clone(patient(l.patient_id)) })); },
    async saveLabCase(row) {
      need('lab.manage');
      if (row.id) Object.assign(db.lab_cases.find((l) => l.id === row.id), row);
      else db.lab_cases.push({ ...row, id: uid(), sent_date: row.sent_date || todayISO(), status: row.status || 'sent' });
    },
    async retainerCases() { return db.retainer_cases.map((r) => ({ ...clone(r), patient: clone(patient(r.patient_id)) })); },
    async saveRetainerCase(row) {
      need('retainers.manage');
      if (row.id) Object.assign(db.retainer_cases.find((r) => r.id === row.id), row);
      else db.retainer_cases.push({ ...row, id: uid(), stage: row.stage || 'impression', impression_date: row.impression_date || todayISO() });
    },
    async reminders() { need('reminders.manage'); return db.reminders.map((r) => ({ ...clone(r), patient: clone(patient(r.patient_id)) })).sort((a, b) => a.due_date.localeCompare(b.due_date)); },
    async saveReminder(row) {
      need('reminders.manage');
      if (row.id) Object.assign(db.reminders.find((r) => r.id === row.id), row);
      else db.reminders.push({ ...row, id: uid(), status: row.status || 'open' });
    },
    async dropoffs() {
      need('reminders.manage');
      const limit = db.settings.dropoff_days;
      return db.braces_cases.filter((b) => b.status === 'active').map((b) => {
        const last = db.visits.filter((v) => v.braces_case_id === b.id && v.status === 'completed').map((v) => v.visit_date).sort().pop() || null;
        const days = last ? Math.round((new Date(todayISO()) - new Date(last)) / 86400000) : null;
        return { patient: clone(patient(b.patient_id)), last_visit: last, days_since: days };
      }).filter((r) => r.days_since === null || r.days_since > limit);
    },
    async lowRatings() {
      if (!can('reminders.manage')) return [];
      return db.visit_ratings.filter((r) => r.stars <= db.settings.low_rating_threshold).map((r) => ({ ...clone(r), patient: clone(patient(r.patient_id)) }));
    },

    // ------------------------------------------------------------ accounts
    async expenses({ from, to } = {}) {
      need('finance.view');
      return clone(db.expenses.filter((e) => (!from || e.expense_date >= from) && (!to || e.expense_date <= to))).sort((a, b) => b.expense_date.localeCompare(a.expense_date));
    },
    async addExpense(row) {
      need('expenses.manage');
      if (!(Number(row.amount) > 0)) fail('Enter an amount greater than zero.');
      const branch = db.branches.find((b) => b.id === Number(row.branch_id));
      const e = { ...row, id: uid(), amount: Number(row.amount), branch_id: branch ? branch.id : null, city_id: branch ? branch.city_id : Number(row.city_id), category_id: Number(row.category_id) };
      db.expenses.push(e); audit('expenses', 'INSERT', e);
      return clone(e);
    },
    async branchPnl(month) {
      need('finance.view');
      return db.branches.map((b) => {
        const income = db.payments.filter((p) => p.branch_id === b.id && p.received_at.slice(0, 7) === month).reduce((s, p) => s + p.amount, 0);
        const expenses = db.expenses.filter((e) => e.branch_id === b.id && e.expense_date.slice(0, 7) === month).reduce((s, e) => s + e.amount, 0);
        return { branch_id: b.id, branch: b.name, city_id: b.city_id, income, expenses, profit: income - expenses };
      });
    },
    async expectedCash(branchId, date) {
      if (!can('cash.close') && !can('finance.view')) fail('row-level security policy (cash.close)');
      return db.payments.filter((p) => p.branch_id === Number(branchId) && p.method === 'cash' && p.received_at.slice(0, 10) === date).reduce((s, p) => s + p.amount, 0);
    },
    async closeCash(branchId, date, counted, notes) {
      need('cash.close');
      if (!branchOk(branchId)) fail('You are not allowed to close cash for this branch');
      if (db.cash_closings.some((c) => c.branch_id === Number(branchId) && c.closing_date === date)) fail('Cash for this branch and day is already closed.');
      const expected = await this.expectedCash(branchId, date);
      const c = { id: uid(), branch_id: Number(branchId), closing_date: date, expected_cash: expected, counted_cash: Number(counted), difference: Number(counted) - expected, closed_by: me().full_name, closed_at: new Date().toISOString(), notes, verified_by: null };
      db.cash_closings.push(c); audit('cash_closings', 'INSERT', c);
      return clone(c);
    },
    async cashClosings() { if (!can('finance.view') && !can('cash.close')) return []; return clone(db.cash_closings.filter((c) => branchOk(c.branch_id))).sort((a, b) => b.closing_date.localeCompare(a.closing_date)); },
    async verifyClosing(id) { need('cash.verify'); const c = db.cash_closings.find((x) => x.id === id); c.verified_by = me().full_name; c.verified_at = new Date().toISOString(); },
    async todaysPayments(branchId) {
      need('billing.view');
      return db.payments.filter((p) => (!branchId || p.branch_id === Number(branchId)) && p.received_at.slice(0, 10) === todayISO() && branchOk(p.branch_id))
        .map((p) => ({ ...clone(p), patient: clone(patient(p.patient_id)) }));
    },

    // ------------------------------------------------------------ doctor log
    async doctorLog({ clinicianId, from, to }) {
      const s = me();
      const mine = db.clinicians.find((c) => c.staff_id === s.id)?.id;
      if (!can('doctor_log.view_all') && clinicianId !== mine) fail('row-level security policy (doctor_log.view_all)');
      return db.visit_staff.filter((x) => x.clinician_id === clinicianId).map((x) => ({ ...x, visit: db.visits.find((v) => v.id === x.visit_id) }))
        .filter((x) => x.visit.status === 'completed' && x.visit.visit_date >= from && x.visit.visit_date <= to)
        .map((x) => ({ role: x.role, ...enrichVisit(x.visit) })).sort((a, b) => b.visit_date.localeCompare(a.visit_date));
    },
    async myClinicianId() { return db.clinicians.find((c) => c.staff_id === me()?.id)?.id || null; },

    // ------------------------------------------------------------ admin
    async permissionGrid() {
      need('users.manage');
      return { permissions: clone(PERMISSIONS), roles: [...ROLES], grid: clone(db.grid), overrides: clone(db.overrides) };
    },
    async setRolePermission(role, key, allowed) {
      need('users.manage');
      if (role === 'admin') fail('Admin always has full access.');
      db.grid[role][key] = allowed; audit('role_permissions', 'UPDATE', { id: `${role}:${key}` });
    },
    async setOverride(staffId, key, allowed) {
      need('users.manage');
      db.overrides[staffId] = db.overrides[staffId] || {};
      if (allowed === null) delete db.overrides[staffId][key]; else db.overrides[staffId][key] = allowed;
    },
    async staffList() { if (!can('users.manage') && !me()) return []; return clone(db.staff); },
    async createStaff(row) {
      need('users.manage');
      if (!row.email?.endsWith('@dralirashid.com')) fail('Staff emails must end with @dralirashid.com');
      if (db.staff.some((s) => s.email === row.email)) fail('A staff account with this email already exists.');
      const s = { id: uid(), active: true, restrict_to_branches: !!row.branch_ids?.length, branch_ids: (row.branch_ids || []).map(Number), ...row };
      db.staff.push(s); audit('staff', 'INSERT', s);
      return clone(s);
    },
    async deactivateStaff(id) {
      need('users.manage');
      if (id === me().id) fail('You cannot switch off your own account.');
      const s = db.staff.find((x) => x.id === id); s.active = false; s.deactivated_at = new Date().toISOString(); audit('staff', 'UPDATE', s);
    },
    async reactivateStaff(id) { need('users.manage'); db.staff.find((x) => x.id === id).active = true; },
    async setSetting(key, value) { if (me()?.role !== 'admin') fail('Only admin can change settings'); db.settings[key] = value; },
    async discountCaps() { return clone(db.discount_caps); },
    async setDiscountCap(role, maxPercent, maxAmount) {
      if (me()?.role !== 'admin') fail('Only admin can change discount caps');
      db.discount_caps[role] = { maxPercent: maxPercent === '' || maxPercent === null ? null : Number(maxPercent), maxAmount: maxAmount === '' || maxAmount === null ? null : Number(maxAmount) };
    },
    async saveScheduleRow(row) {
      need('schedule.manage');
      if (row.id) Object.assign(db.schedule.find((r) => r.id === row.id), row);
      else db.schedule.push({ ...row, id: uid() });
    },
    async deleteScheduleRow(id) { need('schedule.manage'); db.schedule = db.schedule.filter((r) => r.id !== id); },
    async auditLog() { need('audit.view'); return clone(db.audit.slice(0, 200)); },
    async dashboard(date) {
      const day = date || todayISO();
      return db.branches.map((b) => {
        const visits = db.visits.filter((v) => v.branch_id === b.id && v.visit_date === day);
        const received = db.payments.filter((p) => p.branch_id === b.id && p.received_at.slice(0, 10) === day).reduce((s, p) => s + p.amount, 0);
        const closing = db.cash_closings.find((c) => c.branch_id === b.id && c.closing_date === day) || null;
        return { branch: clone(b), patients: visits.length, completed: visits.filter((v) => v.status === 'completed').length,
          waiting: visits.filter((v) => v.status === 'waiting').length, received, closing: clone(closing) };
      });
    },
    async totalDues() { return db.patients.reduce((s, p) => s + Math.max(0, dues(p.id)), 0); },

    // ------------------------------------------------------------ export
    async exportTable(name) {
      need('export.data');
      const map = { patients: db.patients, visits: db.visits, invoices: db.invoices.map(({ items, ...r }) => r), payments: db.payments, expenses: db.expenses, cash_closings: db.cash_closings };
      return clone(map[name] || []);
    },

    // ------------------------------------------------------------ patient portal
    async rateVisit(visitId, stars, comment) {
      const s = await this.getSession();
      if (s?.kind !== 'patient') fail('Only patients can rate visits.');
      const v = db.visits.find((x) => x.id === visitId && x.patient_id === s.patient.id && x.status === 'completed');
      if (!v) fail('Visit not found');
      if (db.visit_ratings.some((r) => r.visit_id === visitId)) fail('You have already rated this visit.');
      db.visit_ratings.push({ visit_id: visitId, patient_id: s.patient.id, stars: Number(stars), comment, created_at: new Date().toISOString() });
    },
    async myRatings() { const s = await this.getSession(); return clone(db.visit_ratings.filter((r) => r.patient_id === s?.patient?.id)); },
  };
}
