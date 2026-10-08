// DEMO data layer: an in-memory clinic with made-up patients, so every screen
// can be tried before the real database is connected. It follows the same
// rules as the database (Mr#, tokens, braces groups, photo months, checker
// sign-off, dues hold, discount caps, permissions). Nothing here is real.
//
// This file is public (the sample patient account on the homepage loads it), so
// every person, login, amount and rule in the seed is a clearly fictional
// placeholder: "(sample)" clinicians, @example.com demo logins and round
// illustrative numbers. Do not copy real staff, prices or policies into it.

import { protocolFor, guidance as protocolGuidance, LAST_DEFINED_MONTH } from '../lib/protocol.js';
import { PERMISSIONS, ROLES, defaultGrid, hasPermission, discountNeedsApproval } from '../lib/permissions.js';
import { todayISO } from '../ui/dom.js';
import { CONFIG } from '../config.js';
import { summarizePayments, summarizeVisits, thumbPathFor } from './supabase.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2));
const clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
// Calendar maths on the Karachi date in UTC (noon), so the result never slips a day.
const daysAgo = (n) => {
  const d = new Date(todayISO() + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const fail = (msg) => { throw new Error(msg); };
// A labelled placeholder "progress photo" (a drawn smile, not a real picture) for the sample patient.
function samplePhoto(label, bg) {
  const teeth = [-84, -60, -36, -12, 12, 36, 60].map((x, i) => `<rect x="${200 + x - 10}" y="${150 + Math.abs(i - 3) * 6}" width="22" height="${30 - Math.abs(i - 3) * 4}" rx="6" fill="#fffdf7" stroke="#d9cbb8"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><rect width="400" height="300" fill="${bg}"/>` +
    `<path d="M70 130 Q200 90 330 130 Q320 230 200 240 Q80 230 70 130Z" fill="#c9686f"/><path d="M90 136 Q200 110 310 136 Q300 200 200 206 Q100 200 90 136Z" fill="#7a2f3a"/>${teeth}` +
    `<text x="200" y="278" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="18" fill="#5b5048">${label} · sample photo</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

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
    { id: 1, code: 'GUL', name: 'Gulshan (RJ Mall)', city_id: 1, address: 'RJ Mall, 3rd Floor, Gulshan-e-Iqbal, Karachi', active: true, opened_on: '2019-12-30' },
    { id: 2, code: 'NN', name: 'North Nazimabad', city_id: 1, address: 'Block M, North Nazimabad, Karachi', active: true, opened_on: '2024-06-29' },
    { id: 3, code: 'DHA', name: 'DHA Karachi', city_id: 1, address: 'Bukhari Commercial, DHA Phase 6, Karachi', active: true, opened_on: '2024-02-03' },
    { id: 4, code: 'LHR', name: 'Gulberg Lahore', city_id: 2, address: 'Al Hafeez Business Avenue, Gulberg 3, Lahore', active: true, opened_on: '2021-11-03' },
    { id: 5, code: 'ISB', name: 'Islamabad', city_id: 3, address: 'Giga Downtown, DHA Phase II, Islamabad', active: true, opened_on: '2025-11-25' },
  ];
  const doc = (name, group, region, is_doctor = true) => ({ id: uid(), display_name: name, doctor_group_id: group, region, is_doctor, aliases: [], staff_id: null, active: true });
  // Fictional clinicians: one or two per braces group and region, enough to try every rule.
  db.clinicians = [
    doc('Dr. Ali Rashid', null, null),
    doc('Dr. Amna (sample)', 1, 'KHI'), doc('Dr. Bushra (sample)', 1, 'KHI'),
    doc('Dr. Hina (sample)', 2, 'KHI'), doc('Dr. Iqra (sample)', 2, null),
    doc('Dr. Nida (sample)', 3, 'KHI'), doc('Dr. Rabia (sample)', 3, 'KHI'), doc('Dr. Saba (sample)', 3, 'LHR'),
    doc('Dr. Tania (sample)', null, 'ISB'),
    doc('Assistant Uzma (sample)', null, 'KHI', false), doc('Assistant Zara (sample)', null, 'KHI', false),
  ];
  const cl = (name) => db.clinicians.find((c) => c.display_name === name).id;

  db.treatments = ['Monthly', 'Bonding', 'Upper Bonding', 'Lower Bonding', 'Bracket Fix', 'Braces Checkup', 'Braces Scaling', 'Braces Off',
    'Retainer Impression', 'Retainer Pick', 'Retainer Followup', 'Checkup', 'Followup', 'Scaling', 'Filling', 'RCT', 'Extraction',
    'X-Ray / OPG', 'Crown Insertion', 'Veneers Insertion', 'Smile Makeover', 'Shape Modification', 'Hygiene Appointment', 'Pain / Emergency']
    .map((name, i) => ({ id: i + 1, name, category: i < 8 ? 'braces' : i < 11 ? 'retainer' : 'general', is_braces_monthly: name === 'Monthly', active: true }));

  db.expense_categories = ['Rent', 'Salaries', 'Doctor percentage', 'Dental supplies', 'Lab charges', 'Utilities (electricity, gas, water)',
    'Internet and phone', 'Maintenance and repairs', 'Marketing and ads', 'Taxes', 'Travel', 'Staff food and refreshments', 'Miscellaneous']
    .map((name, i) => ({ id: i + 1, name, active: true }));

  // Illustrative caps only (not the clinic's real limits): enough to show the approval flow.
  db.discount_caps = { front_desk: { maxPercent: 5, maxAmount: 1000 }, accountant: { maxPercent: null, maxAmount: null } };
  db.grid = defaultGrid();
  db.overrides = {};

  // One demo login per role. Placeholder @example.com addresses, never real staff logins.
  db.staff = [
    { id: 's-admin', full_name: 'Dr. Ali Rashid', email: 'demo.admin@example.com', role: 'admin', active: true, branch_ids: [], restrict_to_branches: false },
    { id: 's-fd-nn', full_name: 'Front desk (North Nazimabad)', email: 'demo.frontdesk1@example.com', role: 'front_desk', active: true, branch_ids: [2], restrict_to_branches: true, home_branch_id: 2 },
    { id: 's-fd-gul', full_name: 'Front desk (Gulshan)', email: 'demo.frontdesk2@example.com', role: 'front_desk', active: true, branch_ids: [1], restrict_to_branches: true, home_branch_id: 1 },
    { id: 's-asst', full_name: 'Assistant (sample)', email: 'demo.assistant@example.com', role: 'assistant', active: true, branch_ids: [], restrict_to_branches: false },
    { id: 's-doc', full_name: 'Dr. Bushra (sample)', email: 'demo.doctor@example.com', role: 'doctor', active: true, branch_ids: [], restrict_to_branches: false, clinician_id: cl('Dr. Bushra (sample)') },
    { id: 's-coord', full_name: 'Clinic coordinator (sample)', email: 'demo.coordinator@example.com', role: 'coordinator', active: true, branch_ids: [], restrict_to_branches: false },
    { id: 's-acct', full_name: 'Accountant (sample)', email: 'demo.accounts@example.com', role: 'accountant', active: true, branch_ids: [], restrict_to_branches: false },
  ];
  db.clinicians.find((c) => c.display_name === 'Dr. Bushra (sample)').staff_id = 's-doc';
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
      extractions_done: plan === 'extraction' && monthsDone >= 6, kit_name: ['Sample kit A', 'Sample kit B', 'Sample kit C'][pi % 3],
      total_fee: [50000, 60000, 75000][pi % 3], status: 'active', treatment_plan_by_dr_ali: monthsDone >= 1 ? 'Standard plan' : null };
    db.braces_cases.push(bc);
    for (let m = 1; m <= monthsDone; m++) {
      db.visits.push({ id: uid(), patient_id: p.id, branch_id: p.first_branch_id, visit_date: daysAgo((monthsDone - m) * 30 + 5),
        token_no: 1 + (m % 9), status: 'completed', treatment_label: m === 1 ? 'Bonding' : 'Monthly', braces_case_id: bc.id, braces_month: m,
        details_text: m === 1 ? 'Bonding' : `U L 0${m < 3 ? 12 : m < 4 ? 14 : m < 8 ? 16 : 18} PC refresh`, photo_required: protocolFor(m).photoRequired,
        photos_uploaded: true, checker_required: protocolFor(m).checkerGroup !== null, checked_by: cl('Dr. Amna (sample)'), created_at: daysAgo(1), notes: null });
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
    [0, 2, 'Monthly', 'completed', ['Dr. Hina (sample)', 'Assistant Uzma (sample)'], 'U L 016 Pc refresh'],
    [1, 2, 'Monthly', 'in_treatment', ['Dr. Nida (sample)'], ''],
    [13, 2, 'Checkup', 'completed', ['Dr. Rabia (sample)'], 'Scaling advised'],
    [6, 2, 'Monthly', 'waiting', [], ''],
    [14, 2, 'Crown Insertion', 'waiting', [], ''],
    [10, 2, 'Monthly', 'waiting', [], ''],
    [3, 1, 'Monthly', 'completed', ['Dr. Amna (sample)'], 'U L 012'],
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
      checker_required: month ? protocolFor(month).checkerGroup !== null : false, checked_by: status === 'completed' ? cl('Dr. Bushra (sample)') : null,
      checked_in_at: today + 'T13:' + String(10 + db.visits.length % 40).padStart(2, '0') + ':00', created_at: new Date().toISOString(), notes: null };
    db.visits.push(v);
    for (const d of docs) db.visit_staff.push({ visit_id: v.id, clinician_id: cl(d), role: d.startsWith('Dr') ? 'doctor' : 'assistant' });
  }

  db.patient_flags = [{ id: uid(), patient_id: db.patients[4].id, kind: 'see_dr_ali', reason: 'Wire poking, relapse in lower anterior', raised_by: 's-asst', raised_at: daysAgo(2) + 'T16:00:00', cleared_at: null }];
  db.complaints = [{ id: uid(), patient_id: db.patients[7].id, branch_id: 1, clinician_id: cl('Dr. Bushra (sample)'), subject: 'Waiting time', body: 'I waited almost two hours on Saturday even with a token.', status: 'new', created_at: daysAgo(1) + 'T20:15:00' }];
  // A sample doctor-percentage rule with an illustrative number (not the clinic's real rule). Dr. Bushra brought in two sample patients.
  db.doctor_commission_rules = [{ id: uid(), clinician_id: null, basis: 'referred', percent: 30, treatment_category: null, active: true, notes: 'Sample rule for the demo: a share of what their own patients pay' }];
  db.patients[3].referred_by_clinician = cl('Dr. Bushra (sample)');
  db.patients[9].referred_by_clinician = cl('Dr. Bushra (sample)');
  db.complaint_messages = [];
  db.discount_requests = [];
  db.expenses = [
    { id: uid(), expense_date: daysAgo(3), branch_id: 2, city_id: 1, category_id: 1, amount: 100000, paid_to: 'Sample landlord', method: 'bank_transfer', notes: 'Rent (sample figure)' },
    { id: uid(), expense_date: daysAgo(2), branch_id: 1, city_id: 1, category_id: 4, amount: 20000, paid_to: 'Sample supplier', method: 'cash', notes: 'Brackets and wires (sample figure)' },
    { id: uid(), expense_date: daysAgo(1), branch_id: 4, city_id: 2, category_id: 6, amount: 10000, paid_to: 'Electricity company', method: 'bank_transfer', notes: 'Sample figure' },
    { id: uid(), expense_date: daysAgo(1), branch_id: 2, city_id: 1, category_id: 12, amount: 2000, paid_to: 'Staff lunch', method: 'cash', notes: 'Sample figure' },
  ];
  db.cash_closings = [];
  db.lab_cases = [
    { id: uid(), patient_id: db.patients[14].id, branch_id: 2, lab_name: 'In-house lab', work_type: 'Crown', sent_date: daysAgo(6), due_date: daysAgo(-1), status: 'received', cost: 5000 },
    { id: uid(), patient_id: db.patients[17].id, branch_id: 1, lab_name: 'Sample lab', work_type: 'Veneers (6 units)', sent_date: daysAgo(10), due_date: daysAgo(2), status: 'sent', cost: 30000 },
  ];
  db.retainer_cases = [
    { id: uid(), patient_id: db.patients[7].id, arch: 'both', stage: 'fabrication', impression_date: daysAgo(4), lab_cost: 2000, price: 10000 },
  ];
  db.reminders = [
    { id: uid(), patient_id: db.patients[5].id, kind: 'dues', due_date: daysAgo(0), note: 'Month 8 dues checkpoint', status: 'open' },
    { id: uid(), patient_id: db.patients[11].id, kind: 'appointment', due_date: daysAgo(-2), note: 'Monthly due', status: 'open' },
    { id: uid(), patient_id: db.patients[18].id, kind: 'followup', due_date: daysAgo(1), note: 'Post-RCT check', status: 'contacted' },
  ];
  db.visit_ratings = [{ visit_id: db.visits[0].id, patient_id: db.patients[0].id, stars: 2, comment: 'Long wait', created_at: daysAgo(3) }];
  // The first patient is the sample account shown by the "See a sample patient account" button:
  // a next appointment, two labelled progress photos and a message that got a reply.
  const sample = db.patients[0];
  db.visits.push({ id: uid(), patient_id: sample.id, branch_id: 2, visit_date: daysAgo(-24), token_no: null, status: 'scheduled', treatment_label: 'Monthly',
    braces_case_id: db.braces_cases[0].id, braces_month: 4, details_text: '', photo_required: true, photos_uploaded: false, checker_required: true, checked_by: null, created_at: new Date().toISOString(), notes: null });
  db.photos = [
    { id: uid(), patient_id: sample.id, visit_id: null, branch_id: 2, taken_on: daysAgo(100), kind: 'edited', view_label: 'Before · front', url: samplePhoto('Before', '#f3e7d8'), storage_path: 'demo/sample-1', public_ok: false, created_at: daysAgo(100) },
    { id: uid(), patient_id: sample.id, visit_id: null, branch_id: 2, taken_on: daysAgo(5), kind: 'edited', view_label: 'Month 3 · front', url: samplePhoto('Month 3', '#e3eef6'), storage_path: 'demo/sample-2', public_ok: false, created_at: daysAgo(5) },
  ];
  const sampleComplaint = { id: uid(), patient_id: sample.id, branch_id: 2, subject: 'Wire poking', body: 'The lower wire has been poking my cheek since my last visit.', status: 'resolved', created_at: daysAgo(12) + 'T19:10:00', resolved_at: daysAgo(11) + 'T11:00:00' };
  db.complaints.push(sampleComplaint);
  db.complaint_messages = [{ id: uid(), complaint_id: sampleComplaint.id, author: 'Dr. Ali Rashid', body: 'Sorry about that. Come in any day this week and the assistant will trim the wire; no token needed.', internal_note: false, created_at: daysAgo(11) + 'T10:30:00' }];
  db.documents = [];
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
  const saved = new Map(); // idempotency key -> what that save produced (a retried save returns it instead of saving twice)

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
    return { ...clone(v), patient: { id: p.id, mr_number: p.mr_number, full_name: p.full_name, phone: p.phone, medical_history: clone(p.medical_history) || {}, photo_consent_public: !!p.photo_consent_public },
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
        s.last_sign_in_at = new Date().toISOString();
      }
      db.login_events ||= [];
      db.login_events.unshift({ at: new Date().toISOString(), kind: session.patient ? 'patient' : 'staff', name: session.patient ? session.patient.full_name : session.staff.full_name, role: session.staff?.role || null, user_agent: 'This browser' });
      return this.getSession();
    },
    async staffLogins() {
      if (me()?.role !== 'admin') fail('Only Dr. Ali can see the login log');
      return { staff: db.staff.map((s) => ({ id: s.id, full_name: s.full_name, email: s.email, role: s.role, active: s.active, last_sign_in_at: s.last_sign_in_at || null,
          sign_ins_30d: (db.login_events || []).filter((e) => e.name === s.full_name).length })), events: clone(db.login_events || []) };
    },
    async signIn() { fail('In demo mode, pick an account from the list.'); },
    async sendPasswordReset() { fail('Password reset emails are not sent in the demo.'); },
    async signOut() { session = null; return true; },
    // The demo has one login in one page: no other tab or computer can end it and it never expires, so no login event ever
    // arrives. Same call as the live adapter (fn(eventName, reason)); returns the function that stops listening.
    onAuthChange() { return () => {}; },
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
    async publicCases({ limit = 60 } = {}) { return clone(db.photos.filter((p) => p.public_ok && p.kind === 'edited').slice(0, limit).map((p) => ({ ...p, full_url: p.url, srcset: null }))); },
    // Same shape as the live adapter: Map(storage path -> url). Demo files carry their url already (a photo's thumb_path: its thumb_url).
    async signedUrls(paths) {
      const out = new Map();
      for (const path of paths || []) {
        const small = path && db.photos.find((x) => x.thumb_path === path);
        const row = small ? { url: small.thumb_url } : db.photos.find((x) => x.storage_path === path) || db.documents.find((x) => x.storage_path === path);
        if (row?.url) out.set(path, row.url);
      }
      return out;
    },

    // ------------------------------------------------------------ patients
    async searchPatients(q) {
      need('patients.view');
      const t = (q || '').trim().toLowerCase();
      const rows = db.patients.filter((p) => !t || p.full_name.toLowerCase().includes(t) || p.mr_number.includes(t) || (p.phone || '').replace(/\D/g, '').includes(t.replace(/\D/g, '') || '~'));
      const out = rows.slice(0, 50).map((p) => ({ ...clone(p), dues: dues(p.id), see_dr_ali: !!activeFlag(p.id), braces_active: !!activeCase(p.id) }));
      if (rows.length > 50) { out.truncated = true; out.cap = 50; }
      return out;
    },
    async findDuplicates(name, phone) {
      const n = (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const ph = (phone || '').replace(/\D/g, '');
      return clone(db.patients.filter((p) => (n && p.full_name.toLowerCase() === n) || (ph.length >= 7 && (p.phone || '').replace(/\D/g, '') === ph)));
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
        documents: clone(db.documents.filter((x) => x.patient_id === id)),
        plans: clone((db.payment_plans || []).filter((x) => x.patient_id === id)),
        retainers: clone(db.retainer_cases.filter((r) => r.patient_id === id)),
        complaints: db.complaints.filter((c) => c.patient_id === id).map((c) => ({ ...clone(c), messages: clone(db.complaint_messages.filter((m) => m.complaint_id === c.id && (s?.kind === 'staff' || !m.internal_note))) })),
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
    subscribeVisits() { return () => {}; },
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
    async uploadPhoto({ patientId, visitId, file, viewLabel, branchId, kind = 'raw', publicOk = false, thumb = null, idempotencyKey = null }, opts = {}) {
      need('photos.upload');
      const key = opts.idempotencyKey || idempotencyKey;
      const prior = key && db.photos.find((x) => x.id === saved.get('photo:' + key));
      if (prior) return clone(prior);
      const readUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
      const dataUrl = await readUrl(file);
      const thumbUrl = thumb ? await readUrl(thumb).catch(() => null) : null; // the small copy, as the live site stores one beside the photo
      const storagePath = `demo/${uid()}`;
      const ph = { id: uid(), patient_id: patientId, visit_id: visitId || null, branch_id: branchId || null, taken_on: todayISO(), kind,
        view_label: viewLabel || null, url: dataUrl, storage_path: storagePath, thumb_path: thumbUrl ? thumbPathFor(storagePath) : null, thumb_url: thumbUrl,
        public_ok: kind === 'edited' && !!publicOk, created_at: new Date().toISOString() };
      db.photos.push(ph);
      if (key) saved.set('photo:' + key, ph.id);
      if (visitId) { const v = db.visits.find((x) => x.id === visitId); if (v) v.photos_uploaded = true; }
      return clone(ph);
    },
    async publishPhoto(photo) { if (me()?.role !== 'admin') fail('Only Dr. Ali can publish photos'); const ph = db.photos.find((x) => x.id === photo.id); if (ph) ph.published = true; return ph?.url; },
    async uploadDocument({ patientId, file, kind = 'other', title, addedOn }) {
      if (!can('patients.edit') && !can('photos.upload')) fail('row-level security policy (patients.edit)');
      const url = URL.createObjectURL(file);
      const doc = { id: uid(), patient_id: patientId, kind, title: title || file.name, storage_path: `demo/${uid()}`, added_on: addedOn || todayISO(), url, created_at: new Date().toISOString() };
      db.documents.push(doc);
      return clone(doc);
    },

    // ------------------------------------------------------------ billing
    async createInvoice({ patient_id, branch_id, items, discount_amount = 0, discount_reason = null, visit_id = null, idempotencyKey = null }, opts = {}) {
      need('billing.create');
      // The database refuses these (invoice_items.quantity > 0, invoices.discount_amount >= 0); an empty quantity still means 1.
      if (items.some((it) => it.quantity != null && it.quantity !== '' && !(Number(it.quantity) > 0))) fail('new row for relation "invoice_items" violates check constraint "invoice_items_quantity_check"');
      if (Number(discount_amount) < 0) fail('new row for relation "invoices" violates check constraint "invoices_discount_amount_check"');
      const key = opts.idempotencyKey || idempotencyKey;
      const sig = JSON.stringify([patient_id, Number(branch_id), visit_id, Number(discount_amount) || 0, discount_reason, items.map((it) => [it.description, Number(it.quantity || 1), Number(it.unit_price)])]);
      const prior = key && db.invoices.find((i) => i.id === saved.get('invoice:' + key)?.id);
      if (prior) {
        if (saved.get('invoice:' + key).sig !== sig) fail(`IDEMPOTENCY_MISMATCH: an earlier attempt already saved invoice ${prior.invoice_no} with different details. Refresh the patient record and check it (void it if it is wrong) before saving again.`);
        return clone(prior);
      }
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
      if (key) saved.set('invoice:' + key, { id: inv.id, sig });
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
    async patientBilling(patientId) {
      need('billing.view');
      return { invoices: clone(db.invoices.filter((i) => i.patient_id === patientId)), payments: clone(db.payments.filter((x) => x.patient_id === patientId)) };
    },
    // ------------------------------------------------------------ installment plans
    async paymentPlans(patientId) { return clone((db.payment_plans || []).filter((x) => x.patient_id === patientId)); },
    async savePaymentPlan({ patient_id, braces_case_id = null, total_fee, starts_on, notes = null, installments, idempotencyKey = null }, opts = {}) {
      need('billing.create');
      db.payment_plans ||= [];
      const key = opts.idempotencyKey || idempotencyKey;
      const sig = JSON.stringify([patient_id, braces_case_id, Number(total_fee), starts_on || todayISO(), notes, installments.map((i) => [i.due_date, Number(i.amount), i.note || null])]);
      const again = key && db.payment_plans.find((p) => p.id === saved.get('plan:' + key)?.id);
      if (again) {
        if (saved.get('plan:' + key).sig !== sig) fail('IDEMPOTENCY_MISMATCH: an earlier attempt already saved this payment plan with different details. Refresh the patient record and check it (delete the plan if it is wrong) before saving again.');
        return clone(again);
      }
      const plan = { id: uid(), patient_id, braces_case_id, total_fee: Number(total_fee), starts_on: starts_on || todayISO(), notes, created_at: new Date().toISOString(),
        installments: installments.map((i) => ({ id: uid(), due_date: i.due_date, amount: Number(i.amount), note: i.note || null })) };
      db.payment_plans.push(plan);
      if (key) saved.set('plan:' + key, { id: plan.id, sig });
      return clone(plan);
    },
    async deletePaymentPlan(id) { need('billing.create'); db.payment_plans = (db.payment_plans || []).filter((p) => p.id !== id); },
    async installmentsDue() {
      if (!can('billing.view')) return [];
      const today = todayISO(); const soon = daysAgo(-7);
      const out = [];
      for (const plan of db.payment_plans || []) {
        const paid = db.payments.filter((x) => x.patient_id === plan.patient_id && x.received_at.slice(0, 10) >= plan.starts_on).reduce((s, x) => s + x.amount, 0);
        let cum = 0;
        for (const i of [...plan.installments].sort((a, b) => a.due_date.localeCompare(b.due_date))) {
          cum += i.amount;
          const status = paid >= cum ? 'paid' : i.due_date < today ? 'overdue' : i.due_date <= soon ? 'due_soon' : 'upcoming';
          if (status === 'overdue' || status === 'due_soon') out.push({ ...clone(i), plan_id: plan.id, patient_id: plan.patient_id, status, paid, remaining: cum - paid, patient: clone(patient(plan.patient_id)) });
        }
      }
      return out.sort((a, b) => a.due_date.localeCompare(b.due_date));
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
      const plans = db.braces_cases.filter((b) => b.status === 'active' && !b.treatment_plan_by_dr_ali && nextMonth(b.id) <= 3)
        .map((b) => ({ source: 'plan', patient: clone(patient(b.patient_id)), reason: `Braces started ${b.start_date}: treatment plan needed (month ${nextMonth(b.id)})`, since: b.start_date }));
      return [...flags, ...overruns, ...plans];
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
      c.status = status; c.resolved_at = status === 'resolved' ? new Date().toISOString() : null; // Reopen clears the old date
    },
    async linkComplaintDoctor(id, clinicianId) { need('complaints.view'); const c = db.complaints.find((x) => x.id === id); if (c) c.clinician_id = clinicianId || null; },
    async doctorSummary(clinicianId, from, to) {
      const s = me();
      const mine = db.clinicians.find((c) => c.staff_id === s?.id)?.id;
      if (!can('doctor_log.view_all') && mine !== clinicianId) fail('You can only see your own summary');
      const inRange = (d) => d >= from && d <= to;
      const vs = db.visit_staff.filter((x) => x.clinician_id === clinicianId).map((x) => ({ ...x, visit: db.visits.find((v) => v.id === x.visit_id) })).filter((x) => x.visit && x.visit.status === 'completed' && inRange(x.visit.visit_date));
      const treatedVisits = vs.filter((x) => x.role === 'doctor').map((x) => x.visit.id);
      const own = db.patients.filter((p) => p.referred_by_clinician === clinicianId);
      const paid = db.payments.filter((y) => own.some((p) => p.id === y.patient_id) && inRange(String(y.received_at).slice(0, 10))).reduce((t, y) => t + Number(y.amount), 0);
      const billed = db.invoices.filter((i) => i.status === 'issued' && treatedVisits.includes(i.visit_id)).reduce((t, i) => t + Number(i.total), 0);
      const rule = (db.doctor_commission_rules || []).find((r) => r.active && r.clinician_id === clinicianId) || (db.doctor_commission_rules || []).find((r) => r.active && !r.clinician_id) || null;
      const base = rule ? (rule.basis === 'treated' ? billed : rule.basis === 'referred' ? paid : billed + paid) : 0;
      return { treated: treatedVisits.length, checked: vs.filter((x) => x.role === 'checker').length, assisted: vs.filter((x) => x.role === 'assistant').length,
        days: new Set(vs.map((x) => x.visit.visit_date)).size, billed, branches: [...new Set(vs.map((x) => x.visit.branch_id))],
        referred_patients: own.length, referred_paid: paid,
        complaints: db.complaints.filter((c) => c.clinician_id === clinicianId && inRange(c.created_at.slice(0, 10))).map((c) => ({ id: c.id, subject: c.subject, status: c.status, created_at: c.created_at, branch_id: c.branch_id, patient_name: patient(c.patient_id)?.full_name, mr_number: patient(c.patient_id)?.mr_number })),
        rule: rule ? { percent: rule.percent, basis: rule.basis, notes: rule.notes } : null, share: rule ? Math.round(base * rule.percent) / 100 : null };
    },

    // ------------------------------------------------------------ coordinator
    // Like the live lists, these leave out what is finished: lab work that is fitted or cancelled (once 90 days old), closed retainers, done or cancelled reminders.
    async labCases() {
      if (!can('lab.manage') && !can('patients.view')) return [];
      const since = daysAgo(90);
      return db.lab_cases.filter((l) => ['sent', 'received', 'returned'].includes(l.status) || String(l.updated_at || l.sent_date).slice(0, 10) >= since)
        .map((l) => ({ ...clone(l), patient: clone(patient(l.patient_id)) }));
    },
    async saveLabCase(row) {
      need('lab.manage');
      if (row.id) Object.assign(db.lab_cases.find((l) => l.id === row.id), row, { updated_at: new Date().toISOString() });
      else db.lab_cases.push({ ...row, id: uid(), sent_date: row.sent_date || todayISO(), status: row.status || 'sent' });
    },
    async retainerCases() { return db.retainer_cases.filter((r) => r.stage !== 'closed').map((r) => ({ ...clone(r), patient: clone(patient(r.patient_id)) })); },
    async saveRetainerCase(row) {
      need('retainers.manage');
      if (row.id) Object.assign(db.retainer_cases.find((r) => r.id === row.id), row);
      else db.retainer_cases.push({ ...row, id: uid(), stage: row.stage || 'impression', impression_date: row.impression_date || todayISO() });
    },
    async reminders() { need('reminders.manage'); return db.reminders.filter((r) => r.status !== 'done' && r.status !== 'cancelled').map((r) => ({ ...clone(r), patient: clone(patient(r.patient_id)) })).sort((a, b) => a.due_date.localeCompare(b.due_date)); },
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
      return db.visit_ratings.filter((r) => r.stars <= db.settings.low_rating_threshold && !r.followed_up_at).map((r) => ({ ...clone(r), patient: clone(patient(r.patient_id)) }));
    },
    async followUpRating(visitId) {
      need('reminders.manage');
      const r = db.visit_ratings.find((x) => x.visit_id === visitId);
      if (r) { r.followed_up_by = me().id; r.followed_up_at = new Date().toISOString(); }
    },

    // ------------------------------------------------------------ stock
    async inventory(branchId) {
      db.inventory_items ||= [{ id: 1, name: '022 MBT brackets (upper)', category: 'brackets', unit: 'set', supplier: 'Sample supplier', active: true }, { id: 2, name: '014 NiTi wire', category: 'wires', unit: 'pcs', supplier: null, active: true }, { id: 3, name: 'Elastic ligatures', category: 'elastics', unit: 'pack', supplier: null, active: true }];
      db.inventory_stock ||= [{ branch_id: 1, item_id: 1, quantity: 12, reorder_level: 5 }, { branch_id: 1, item_id: 2, quantity: 3, reorder_level: 10 }];
      db.inventory_moves ||= [];
      return clone({ items: db.inventory_items, stock: db.inventory_stock.filter((s) => s.branch_id === Number(branchId)), moves: db.inventory_moves.filter((m) => m.branch_id === Number(branchId)).slice(-50).reverse() });
    },
    async saveInventoryItem(row) {
      need('inventory.manage');
      db.inventory_items ||= [];
      if (row.id) Object.assign(db.inventory_items.find((x) => x.id === row.id), row);
      else db.inventory_items.push({ active: true, ...row, id: Math.max(0, ...db.inventory_items.map((x) => x.id)) + 1 });
    },
    async moveStock({ branch_id, item_id, change, reason }) {
      need('inventory.manage');
      db.inventory_moves ||= []; db.inventory_stock ||= [];
      db.inventory_moves.push({ id: uid(), branch_id: Number(branch_id), item_id: Number(item_id), change: Number(change), reason, created_at: new Date().toISOString() });
      let s = db.inventory_stock.find((x) => x.branch_id === Number(branch_id) && x.item_id === Number(item_id));
      if (!s) { s = { branch_id: Number(branch_id), item_id: Number(item_id), quantity: 0, reorder_level: 0 }; db.inventory_stock.push(s); }
      s.quantity += Number(change);
    },
    async setReorderLevel({ branch_id, item_id, reorder_level }) {
      need('inventory.manage');
      db.inventory_stock ||= [];
      let s = db.inventory_stock.find((x) => x.branch_id === Number(branch_id) && x.item_id === Number(item_id));
      if (!s) { s = { branch_id: Number(branch_id), item_id: Number(item_id), quantity: 0, reorder_level: 0 }; db.inventory_stock.push(s); }
      s.reorder_level = Number(reorder_level);
    },

    // ------------------------------------------------------------ accounts
    async expenses({ from, to } = {}) {
      need('finance.view');
      return clone(db.expenses.filter((e) => (!from || e.expense_date >= from) && (!to || e.expense_date <= to))).sort((a, b) => b.expense_date.localeCompare(a.expense_date));
    },
    async uploadReceipt(expenseId, file) {
      need('expenses.manage');
      const e = db.expenses.find((x) => x.id === expenseId); if (!e) fail('Expense not found');
      e.receipt_path = `${expenseId}.${(file.name.split('.').pop() || 'jpg').toLowerCase()}`;
      e._receipt_url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
      return e.receipt_path;
    },
    async receiptUrl(path) { const e = db.expenses.find((x) => x.receipt_path === path); return e?._receipt_url || ''; },
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
      const rows = db.branches.map((b) => {
        const income = db.payments.filter((p) => p.branch_id === b.id && p.received_at.slice(0, 7) === month).reduce((s, p) => s + p.amount, 0);
        const expenses = db.expenses.filter((e) => e.branch_id === b.id && e.expense_date.slice(0, 7) === month).reduce((s, e) => s + e.amount, 0);
        return { branch_id: b.id, branch: b.name, city_id: b.city_id, income, expenses, profit: income - expenses };
      });
      // Expenses recorded against a city only (no branch): one row per city.
      for (const c of db.cities) {
        const expenses = db.expenses.filter((e) => e.branch_id == null && e.city_id === c.id && e.expense_date.slice(0, 7) === month).reduce((s, e) => s + e.amount, 0);
        if (expenses > 0) rows.push({ branch_id: null, branch: null, city_id: c.id, income: 0, expenses, profit: -expenses });
      }
      return rows;
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
    async paymentsReport({ from, to, branchId, method } = {}) {
      if (!can('finance.view') && !can('billing.view')) fail('row-level security policy (finance.view)');
      return db.payments.filter((p) => (!from || p.received_at.slice(0, 10) >= from) && (!to || p.received_at.slice(0, 10) <= to) && (!branchId || p.branch_id === Number(branchId)) && (!method || p.method === method) && branchOk(p.branch_id))
        .sort((a, b) => b.received_at.localeCompare(a.received_at))
        .map((p) => ({ ...clone(p), is_refund: p.amount < 0, patient: clone(patient(p.patient_id)), invoice_no: db.invoices.find((i) => i.id === p.invoice_id)?.invoice_no || null, received_by_name: p.received_by_name || 'Front desk' }));
    },
    async invoicesReport({ from, to, branchId, status, discounted } = {}) {
      if (!can('finance.view') && !can('billing.view')) fail('row-level security policy (finance.view)');
      return db.invoices.filter((i) => (!from || i.issue_date >= from) && (!to || i.issue_date <= to) && (!branchId || i.branch_id === Number(branchId)) && (!status || i.status === status) && (!discounted || Number(i.discount_amount) > 0))
        .sort((a, b) => b.issue_date.localeCompare(a.issue_date)).map((i) => ({ ...clone(i), patient: clone(patient(i.patient_id)), created_by_name: 'Front desk' }));
    },
    async advances() {
      need('finance.view');
      return db.patients.map((p) => ({ patient_id: p.id, dues: dues(p.id) })).filter((r) => r.dues < 0).map((r) => ({ ...r, advance: -r.dues, patient: clone(patient(r.patient_id)) }));
    },
    async visitsDaily({ from, to, branchId } = {}) {
      need('sheet.view');
      return db.visits.filter((v) => v.visit_date >= from && v.visit_date <= to && (!branchId || v.branch_id === Number(branchId))).map((v) => ({ visit_date: v.visit_date, branch_id: v.branch_id, status: v.status, checked_in_at: v.checked_in_at || null, started_at: v.started_at || null, patient_id: v.patient_id }));
    },
    // Report totals: same shapes as the live adapter (which gets them from SQL), computed here from the sample rows.
    async paymentsSummary(args = {}) { return { ...summarizePayments(await this.paymentsReport(args)), source: 'rows', truncated: false }; },
    async opdSummary(args = {}) { return { ...summarizeVisits(await this.visitsDaily(args)), source: 'rows', truncated: false }; },
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
      if (!row.email?.endsWith('@' + CONFIG.STAFF_EMAIL_DOMAIN)) fail('Staff emails must end with @' + CONFIG.STAFF_EMAIL_DOMAIN);
      if (db.staff.some((s) => s.email === row.email)) fail('A staff account with this email already exists.');
      const { password, ...rest } = row;
      if (password != null && String(password).length < 8) fail('The password needs at least 8 characters.');
      const s = { id: uid(), active: true, restrict_to_branches: !!row.branch_ids?.length, branch_ids: (row.branch_ids || []).map(Number), ...rest };
      db.staff.push(s); audit('staff', 'INSERT', s);
      return clone(s);
    },
    async deactivateStaff(id) {
      need('users.manage');
      if (id === me().id) fail('You cannot switch off your own account.');
      const s = db.staff.find((x) => x.id === id); s.active = false; s.deactivated_at = new Date().toISOString(); audit('staff', 'UPDATE', s);
    },
    async updateStaffLogin(id, { email, password }) {
      need('users.manage');
      const s = db.staff.find((x) => x.id === id);
      if (!s) fail('Staff account not found.');
      const e = (email || '').trim().toLowerCase();
      if (e && e !== s.email) {
        if (!e.endsWith('@' + CONFIG.STAFF_EMAIL_DOMAIN)) fail('Staff emails must end with @' + CONFIG.STAFF_EMAIL_DOMAIN);
        if (db.staff.some((x) => x.email === e && x.id !== id)) fail('That login email is already used. Pick another.');
        s.email = e; audit('staff', 'UPDATE', s);
      }
      if (password != null && password !== '' && String(password).length < 8) fail('The password needs at least 8 characters.');
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
    async auditLog() {
      need('audit.view');
      const rows = clone(db.audit.slice(0, 200));
      if (db.audit.length > 200) { rows.truncated = true; rows.cap = 200; } // same notice as the live list
      return rows;
    },
    async dashboard(date) {
      const day = date || todayISO();
      return db.branches.map((b) => {
        const visits = db.visits.filter((v) => v.branch_id === b.id && v.visit_date === day);
        const received = db.payments.filter((p) => p.branch_id === b.id && p.received_at.slice(0, 10) === day).reduce((s, p) => s + p.amount, 0);
        const closing = db.cash_closings.find((c) => c.branch_id === b.id && c.closing_date === day) || null;
        const withDues = [...new Set(visits.map((v) => v.patient_id))].filter((pid) => dues(pid) > 0);
        return { branch: clone(b), patients: visits.length, completed: visits.filter((v) => v.status === 'completed').length,
          waiting: visits.filter((v) => v.status === 'waiting').length, received, closing: clone(closing),
          dues_patients: withDues.length, dues: withDues.reduce((s, pid) => s + dues(pid), 0),
          new_complaints: can('complaints.view') ? db.complaints.filter((c) => c.branch_id === b.id && c.status === 'new').length : 0 };
      });
    },
    async totalDues() { return db.patients.reduce((s, p) => s + Math.max(0, dues(p.id)), 0); },
    async commissionRules() { return clone((db.doctor_commission_rules || []).filter((r) => r.active !== false)); },
    // Reports (a few of the real ones, from the demo data).
    async report(kind, from, to) {
      need('finance.view');
      const inRange = (d) => d >= from && d <= to;
      const month = (d) => d.slice(0, 7);
      const group = (rows, keyOf, add) => {
        const out = {};
        for (const r of rows) { const k = keyOf(r); out[k] ||= { ...JSON.parse(k), ...add.init() }; add.fold(out[k], r); }
        return Object.values(out);
      };
      if (kind === 'pnl_trend') return group([
        ...db.payments.filter((p) => inRange(p.received_at.slice(0, 10))).map((p) => ({ month: month(p.received_at), branch_id: p.branch_id, city_id: null, income: p.amount, expenses: 0 })),
        ...db.expenses.filter((e) => inRange(e.expense_date)).map((e) => ({ month: month(e.expense_date), branch_id: e.branch_id || null, city_id: e.branch_id ? null : e.city_id, income: 0, expenses: e.amount })),
      ], (r) => JSON.stringify({ month: r.month, branch_id: r.branch_id, city_id: r.city_id }), { init: () => ({ income: 0, expenses: 0 }), fold: (o, r) => { o.income += r.income; o.expenses += r.expenses; } });
      if (kind === 'payment_methods') return group(db.payments.filter((p) => inRange(p.received_at.slice(0, 10))), (p) => JSON.stringify({ month: month(p.received_at), method: p.method }), { init: () => ({ amount: 0, count: 0 }), fold: (o, p) => { o.amount += p.amount; o.count++; } });
      if (kind === 'visits') {
        const first = {};
        for (const v of db.visits) if (v.status === 'completed' && (!first[v.patient_id] || v.visit_date < first[v.patient_id])) first[v.patient_id] = v.visit_date;
        return group(db.visits.filter((v) => inRange(v.visit_date)), (v) => JSON.stringify({ month: month(v.visit_date), branch_id: v.branch_id }), { init: () => ({ visits: 0, patients: 0, no_shows: 0, new_patients: 0, _p: {} }), fold: (o, v) => { if (v.status === 'completed') { o.visits++; if (!o._p[v.patient_id]) { o._p[v.patient_id] = 1; o.patients++; } if (first[v.patient_id] === v.visit_date) o.new_patients++; } if (v.status === 'no_show') o.no_shows++; } }).map(({ _p, ...r }) => r);
      }
      if (kind === 'referrals') return group(db.patients.filter((p) => inRange(p.created_at.slice(0, 10))), (p) => JSON.stringify({ source: p.referral_source || 'Not recorded', branch_id: p.first_branch_id }), { init: () => ({ patients: 0 }), fold: (o) => { o.patients++; } });
      if (kind === 'dues_by_branch') return group(db.patients.filter((p) => dues(p.id) > 0), (p) => JSON.stringify({ branch_id: p.first_branch_id }), { init: () => ({ patients: 0, dues: 0 }), fold: (o, p) => { o.patients++; o.dues += dues(p.id); } });
      if (kind === 'top_dues') return db.patients.filter((p) => dues(p.id) > 0).map((p) => ({ patient_id: p.id, mr_number: p.mr_number, full_name: p.full_name, phone: p.phone, branch_id: p.first_branch_id, dues: dues(p.id), last_payment: null })).sort((a, b) => b.dues - a.dues).slice(0, 100);
      if (kind === 'braces') return group(db.braces_cases.filter((b) => inRange(b.start_date)), (b) => JSON.stringify({ month: month(b.start_date), branch_id: b.bonding_branch_id || null }), { init: () => ({ bondings: 0, braces_off: 0, cases_started: 0 }), fold: (o) => { o.cases_started++; } });
      return [];
    },

    // ------------------------------------------------------------ clinic setup (admin)
    async setupLists() {
      if (me()?.role !== 'admin') fail('Only Dr. Ali can change the clinic setup');
      db.doctor_groups ||= [{ id: 1, name: 'Group 1', description: 'Senior: photo months, extraction decisions' }, { id: 2, name: 'Group 2', description: 'Checks Group 3 months' }, { id: 3, name: 'Group 3', description: 'Routine monthly visits' }];
      db.doctor_commission_rules ||= [];
      return clone({ branches: db.branches, cities: db.cities, clinicians: db.clinicians, groups: db.doctor_groups, treatments: db.treatments, categories: db.expense_categories, staff: db.staff.filter((s) => s.active), commission_rules: db.doctor_commission_rules });
    },
    async saveSetupRow(table, row) {
      if (me()?.role !== 'admin') fail('Only Dr. Ali can change the clinic setup');
      db.doctor_commission_rules ||= [];
      const list = { branches: db.branches, clinicians: db.clinicians, doctor_groups: db.doctor_groups, treatments: db.treatments, expense_categories: db.expense_categories, doctor_commission_rules: db.doctor_commission_rules }[table];
      if (!list) fail('Unknown list ' + table);
      const found = row.id !== undefined && row.id !== null && row.id !== '' ? list.find((x) => String(x.id) === String(row.id)) : null;
      if (found) Object.assign(found, row);
      else list.push({ active: true, ...row, id: row.id ?? (table === 'clinicians' || table === 'doctor_commission_rules' ? uid() : Math.max(0, ...list.map((x) => Number(x.id) || 0)) + 1) });
    },

    // ------------------------------------------------------------ duplicates (admin)
    async patientDuplicates() {
      if (me()?.role !== 'admin') fail('Only Dr. Ali can review duplicates');
      const groups = {};
      for (const p of db.patients) if (p.phone) (groups[p.phone] ||= []).push(p);
      return Object.entries(groups).filter(([, l]) => l.length > 1).map(([phone, l]) => ({ phone, members: l.length,
        patients: l.map((p) => ({ id: p.id, mr_number: p.mr_number, full_name: p.full_name, created_at: p.created_at, first_branch_id: p.first_branch_id,
          visits: db.visits.filter((v) => v.patient_id === p.id).length, invoices: db.invoices.filter((i) => i.patient_id === p.id).length, dues: dues(p.id),
          last_visit: db.visits.filter((v) => v.patient_id === p.id).map((v) => v.visit_date).sort().pop() || null })) }));
    },
    async mergePatients(keepId, removeId) {
      if (me()?.role !== 'admin') fail('Only Dr. Ali can merge patients');
      const keep = patient(keepId); const rem = patient(removeId);
      if (!keep || !rem || keepId === removeId) fail('Choose two different patients');
      let visits = 0, invoices = 0, payments = 0;
      for (const list of [db.visits, db.invoices, db.payments, db.braces_cases, db.retainer_cases, db.photos, db.reminders, db.complaints, db.patient_flags, db.visit_ratings, db.documents, db.payment_plans || []]) {
        for (const row of list) if (row.patient_id === removeId) { row.patient_id = keepId; if (list === db.visits) visits++; if (list === db.invoices) invoices++; if (list === db.payments) payments++; }
      }
      for (const k of ['email', 'gender', 'date_of_birth', 'address', 'first_branch_id']) if (!keep[k] && rem[k]) keep[k] = rem[k];
      keep.notes = [keep.notes, `Merged with Mr# ${rem.mr_number} (${rem.full_name})`].filter(Boolean).join(' · ');
      db.patients = db.patients.filter((p) => p.id !== removeId);
      return { kept: keepId, removed_mr: rem.mr_number, visits, invoices, payments };
    },

    // ------------------------------------------------------------ import from Healthwire (admin)
    async importHealthwire(kind, rows) {
      if (me()?.role !== 'admin') fail('Only Dr. Ali can import Healthwire data');
      // Demo keeps nothing: it only reports what a real import would do.
      const existing = kind === 'patients' ? rows.filter((r) => db.patients.some((p) => p.mr_number === r[0])).length : 0;
      return { kind, given: rows.length, inserted: rows.length - existing, updated: existing, items: kind === 'invoices' ? rows.reduce((s, r) => s + r[7].length, 0) : 0, missing: 0 };
    },
    async patientsByMr(mrs) { return db.patients.filter((p) => mrs.includes(p.mr_number)).map((p) => ({ mr_number: p.mr_number })); },
    // Aaj ki List history: the demo really writes the visits (in memory), following the same rules as the database function.
    async importAajSheet(rows, createPatients = false) {
      if (me()?.role !== 'admin') fail('Only Dr. Ali can import the Aaj ki List');
      const today = todayISO();
      const out = { given: rows.length, future: 0, patients_created: 0, visits_inserted: 0, visits_updated: 0, staff_added: 0, cases_created: 0, tokens: 0, rows_unmatched: 0, cases: {}, unmatched: [] };
      const find = (r) => db.patients.find((p) => r[2] && p.mr_number === r[2]) || (r[5] && db.patients.find((p) => p.phone === r[5]))
        || (() => { const same = db.patients.filter((p) => p.full_name.toLowerCase() === String(r[3]).toLowerCase()); return same.length === 1 ? same[0] : null; })();
      const seenUnmatched = {};
      for (const r of rows) {
        if (!r[3]) continue;
        if (r[0] >= today) { out.future++; continue; }
        let p = find(r);
        if (!p && createPatients && (r[2] || r[5])) {
          p = { id: uid(), mr_number: r[2] || String(db.mr_next++), full_name: r[3], phone: r[5], email: null, first_branch_id: r[1], referral_source: null, photo_consent_public: false,
            created_at: r[0], notes: `Added from the Aaj ki List (${r[16]}, first seen ${r[0]})`, portal_user_id: null, legacy_source: 'aaj_ki_list' };
          db.patients.push(p); out.patients_created++;
        }
        if (!p) { const k = `${r[3]}|${r[2] || ''}|${r[5] || ''}`; if (!seenUnmatched[k]) { seenUnmatched[k] = { name: r[3], mr: r[2], phone: r[5], rows: 0, first: r[0], last: r[0], tab: r[16] }; out.unmatched.push(seenUnmatched[k]); } seenUnmatched[k].rows++; seenUnmatched[k].last = r[0]; out.rows_unmatched++; continue; }
        let bc = r[6] ? (activeCase(p.id) || db.braces_cases.find((b) => b.patient_id === p.id)) : null;
        if (r[6] && !bc) {
          const start = new Date(r[0] + 'T12:00:00Z'); start.setUTCDate(start.getUTCDate() - (r[6] - 1) * 30);
          bc = { id: uid(), patient_id: p.id, start_date: start.toISOString().slice(0, 10), extraction_plan: 'undecided', extractions_done: false, kit_name: null, total_fee: null,
            status: 'active', treatment_plan_by_dr_ali: null, notes: `From the Aaj ki List history: month rows from ${r[0]}` };
          db.braces_cases.push(bc); out.cases_created++; out.cases.active = (out.cases.active || 0) + 1;
        }
        let v = db.visits.find((x) => x.patient_id === p.id && x.visit_date === r[0]);
        const note = [`Aaj ki List (${r[16]})`, r[13].length ? 'Also: ' + r[13].join(', ') : null, r[15] ? 'Reminder: ' + r[15] : null].filter(Boolean).join(' · ');
        if (v) {
          if (!(v.notes || '').includes('Aaj ki List (')) {
            v.treatment_label ||= r[7]; v.details_text ||= r[14]; v.braces_case_id ||= bc?.id || null; v.braces_month ||= bc ? r[6] : null;
            v.notes = [v.notes, note].filter(Boolean).join(' · '); v.protocol_override_by ||= me().id; out.visits_updated++;
          }
        } else {
          v = { id: uid(), patient_id: p.id, branch_id: r[1], visit_date: r[0], token_no: null, status: r[9] || 'completed', treatment_label: r[7], braces_case_id: bc?.id || null,
            braces_month: bc ? r[6] : null, details_text: r[14], photo_required: false, photos_uploaded: false, checker_required: false, checked_by: null, notes: note,
            legacy_source: 'aaj_ki_list', protocol_override_by: me().id, created_at: r[0] + 'T20:00:00', completed_at: r[9] === 'completed' ? r[0] + 'T20:00:00' : null };
          db.visits.push(v); out.visits_inserted++;
        }
        if (r[8] && v.token_no == null && !db.visits.some((x) => x.branch_id === v.branch_id && x.visit_date === v.visit_date && x.token_no === r[8])) { v.token_no = r[8]; out.tokens++; }
        for (const [ids, role] of [[r[11], 'doctor'], [r[12], 'assistant']]) {
          for (const id of ids) if (clinician(id) && !db.visit_staff.some((s) => s.visit_id === v.id && s.clinician_id === id && s.role === role)) { db.visit_staff.push({ visit_id: v.id, clinician_id: id, role }); out.staff_added++; }
        }
      }
      return out;
    },

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
