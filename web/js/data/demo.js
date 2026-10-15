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
import { todayISO, localISO } from '../ui/dom.js';
import { CONFIG } from '../config.js';
import { passwordProblems, passwordError } from '../password-rules.js';
import { checkPortalPassword, checkSlipPassword, portalLoginEmail, normalizeLoginInput, isPatientLoginName, NO_USERNAME_MESSAGE } from '../lib/portal-login.js';
import { summarizePayments, summarizeVisits, thumbPathFor, checkupPatch } from './supabase.js';
import { FOLLOW_UP_STATUSES, DAY_STATUSES, PRICING_LABELS, checkupKey, checkupPhone, cleanText, monthLabel, nameFits, nameNorm, dayListCheckups } from '../lib/checkups.js';
import { seedRecords, recordsDemo } from './demo-records.js';
import { orderDayList, countDayList, FIRST_DAY } from '../lib/day-list.js';
import { checkJobApplication, checkFeedback, cvFileInfo, cleanLine, cleanBlock, feedbackSubject, JOB_STATUS_LABELS, LIMITS, CV_UPLOAD_LIMITS, HONEYPOT } from '../lib/public-forms.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2));
const clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
// Calendar maths on the Karachi date in UTC (noon), so the result never slips a day.
const daysAgo = (n) => {
  const d = new Date(todayISO() + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const fail = (msg) => { throw new Error(msg); };
/** A refused homepage form, the way the database says it: "FORM_INVALID: ..." (or FORM_CV) with the field it is about. */
const formError = (field, message, code = 'FORM_INVALID') => Object.assign(new Error(`${code}: ${message}`), { code, field });
// Same wording as the admin-users Edge Function: a staff login name never has the shape of a patient username.
const PATIENT_SHAPE_ERROR = 'That login name has the shape of a patient login (a name, a dash and a number). Choose a staff name such as reception@' + CONFIG.STAFF_EMAIL_DOMAIN + '.';
// A labelled placeholder "progress photo" (a drawn smile, not a real picture) for the sample patient.
function samplePhoto(label, bg) {
  const teeth = [-84, -60, -36, -12, 12, 36, 60].map((x, i) => `<rect x="${200 + x - 10}" y="${150 + Math.abs(i - 3) * 6}" width="22" height="${30 - Math.abs(i - 3) * 4}" rx="6" fill="#fffdf7" stroke="#d9cbb8"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><rect width="400" height="300" fill="${bg}"/>` +
    `<path d="M70 130 Q200 90 330 130 Q320 230 200 240 Q80 230 70 130Z" fill="#c9686f"/><path d="M90 136 Q200 110 310 136 Q300 200 200 206 Q100 200 90 136Z" fill="#7a2f3a"/>${teeth}` +
    `<text x="200" y="278" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="18" fill="#5b5048">${label} · sample photo</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// A checkup row (the columns of public.checkups) with the database's defaults.
function chk(over) {
  const now = new Date().toISOString();
  return { id: uid(), checkup_date: null, date_is_month: false, branch_id: null, patient_name: '', phone: null, city: null, doctors: null, checkup_for: null,
    details: null, token: null, day_status: null, est_fee: null, follow_up: 'Not Contacted', notes: null, source: 'website', source_tab: null, sheet_key: null,
    patient_id: null, created_by: null, created_at: now, updated_at: now,
    ali_recommended: null, pricing_understood: null, wants_treatment: null, treatment_plan: null, form_submitted_at: null, ...over };
}
// The limits of the checkups table (its check constraints), so the demo refuses what the database refuses.
const CHECKUP_LIMITS = { patient_name: [1, 200], phone: [0, 40], city: [0, 80], doctors: [0, 300], checkup_for: [0, 300], details: [0, 2000], token: [0, 40], notes: [0, 2000], follow_up: [1, 60],
  treatment_plan: [0, 500] };
function checkValid(c) {
  for (const [col, [min, max]] of Object.entries(CHECKUP_LIMITS)) {
    const v = c[col];
    if (v === null || v === undefined) { if (col === 'patient_name' || col === 'follow_up') fail(`null value in column "${col}" of relation "checkups" violates not-null constraint`); continue; }
    const n = String(col === 'patient_name' ? String(v).trim() : v).length;
    if (n < min || n > max) fail(`new row for relation "checkups" violates check constraint "checkups_${col}_check"`);
  }
  if (c.est_fee !== null && c.est_fee !== undefined && !(c.est_fee >= 0)) fail('new row for relation "checkups" violates check constraint "checkups_est_fee_check"');
  if (c.day_status !== null && c.day_status !== undefined && !DAY_STATUSES.includes(c.day_status)) fail('new row for relation "checkups" violates check constraint "checkups_day_status_check"');
  // the answers of the Checkup Patient Form 2.0 (migration 20261011000300)
  if (c.pricing_understood !== null && c.pricing_understood !== undefined && !Object.keys(PRICING_LABELS).includes(c.pricing_understood)) fail('new row for relation "checkups" violates check constraint "checkups_pricing_understood_check"');
  for (const col of ['ali_recommended', 'wants_treatment']) if (c[col] !== null && c[col] !== undefined && typeof c[col] !== 'boolean') fail(`invalid input syntax for type boolean: "${c[col]}"`);
}
/** 'YYYY-MM' -> the first day of the month after it. */
const monthAfter = (ym) => (ym.slice(5, 7) === '12' ? `${Number(ym.slice(0, 4)) + 1}-01-01` : `${ym.slice(0, 4)}-${String(Number(ym.slice(5, 7)) + 1).padStart(2, '0')}-01`);

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
  // Fixed ids, not uid(), so each sample clinician is the same person on every load. On the Aaj ki List each of them has
  // a Doctor Name colour of their own (lib/tones.js: eleven people, fourteen colours).
  const doc = (n, name, group, region, is_doctor = true) => ({ id: `00000000-0000-4000-8000-0000000c${n}`, display_name: name, doctor_group_id: group, region, is_doctor, aliases: [], staff_id: null, active: true });
  // Fictional clinicians: one or two per braces group and region, enough to try every rule.
  db.clinicians = [
    doc('0104', 'Dr. Ali Rashid', null, null),
    doc('0205', 'Dr. Amna (sample)', 1, 'KHI'), doc('0306', 'Dr. Bushra (sample)', 1, 'KHI'),
    doc('0403', 'Dr. Hina (sample)', 2, 'KHI'), doc('0503', 'Dr. Iqra (sample)', 2, null),
    doc('0605', 'Dr. Nida (sample)', 3, 'KHI'), doc('0700', 'Dr. Rabia (sample)', 3, 'KHI'), doc('0806', 'Dr. Saba (sample)', 3, 'LHR'),
    doc('0905', 'Dr. Tania (sample)', null, 'ISB'),
    doc('1006', 'Assistant Uzma (sample)', null, 'KHI', false), doc('1102', 'Assistant Zara (sample)', null, 'KHI', false),
  ];
  const cl = (name) => db.clinicians.find((c) => c.display_name === name).id;
  db.doctor_groups = [{ id: 1, name: 'Group 1', description: 'Senior: photo months, extraction decisions' }, { id: 2, name: 'Group 2', description: 'Checks Group 3 months' }, { id: 3, name: 'Group 3', description: 'Routine monthly visits' }];

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
  db.mr_next = 50000; // the website gives its own numbers from 50000; Healthwire (the demo patients above) keeps counting in the 9800s

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
      doctor_group_id: month && protocolFor(month).treatingGroups.length === 1 ? protocolFor(month).treatingGroups[0] : null,
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
  // Retainer Record and Lab Work (team, rows on every tab, lab work at every branch): data/demo-records.js
  seedRecords(db, { uid, daysAgo });
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
  // The homepage forms (20261011000200_public_forms.sql): two made-up job applications and two website forms in the Complaints inbox.
  // job_cvs stands in for the private bucket job-cvs: { path, type, size, file, created_at } (file is the browser File of an upload made on this page).
  db.job_cvs = [
    { path: 'incoming/00000000-0000-4000-8000-000000000001.pdf', type: 'application/pdf', size: 84000, file: null, created_at: daysAgo(2) + 'T11:00:00.000Z' },
    { path: 'incoming/00000000-0000-4000-8000-000000000002.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 42000, file: null, created_at: daysAgo(5) + 'T09:30:00.000Z' },
    { path: 'incoming/00000000-0000-4000-8000-000000000003.pdf', type: 'application/pdf', size: 51000, file: null, created_at: daysAgo(4) + 'T16:00:00.000Z' }, // never sent with a form
  ];
  db.job_applications = [
    { id: uid(), full_name: 'Sana Example', phone: '03005550411', email: 'sana.example@example.com', position: 'dental_assistant', qualification: 'Diploma',
      graduation_year: 2022, experience: 'One year at a dental clinic (sample)', branch_id: 2, cnic: '12345-0000001-1', cv_path: db.job_cvs[0].path,
      cv_type: db.job_cvs[0].type, cv_size: db.job_cvs[0].size, message: 'I can work evenings. (Made-up sample.)', consent_at: daysAgo(2) + 'T11:01:00.000Z',
      status: 'new', updated_by: null, updated_at: null, created_at: daysAgo(2) + 'T11:01:00.000Z' },
    { id: uid(), full_name: 'Omar Sample', phone: '03005550412', email: null, position: 'dentist', qualification: 'BDS', graduation_year: 2019,
      experience: 'Four years (sample)', branch_id: null, cnic: '12345-0000002-2', cv_path: db.job_cvs[1].path, cv_type: db.job_cvs[1].type,
      cv_size: db.job_cvs[1].size, message: null, consent_at: daysAgo(5) + 'T09:31:00.000Z', status: 'contacted', updated_by: 's-admin',
      updated_at: daysAgo(4) + 'T10:00:00.000Z', created_at: daysAgo(5) + 'T09:31:00.000Z' },
  ];
  db.form_log = []; // private.public_form_log: every form sent on this page that passed its checks (the samples above came before)
  db.job_events = [
    { id: uid(), application_id: db.job_applications[1].id, kind: 'status', status: 'contacted', body: null, by_staff: 's-admin', by_name: 'Dr. Ali Rashid', created_at: daysAgo(4) + 'T10:00:00.000Z' },
    { id: uid(), application_id: db.job_applications[1].id, kind: 'note', status: null, body: 'Called, will come on Saturday. (Sample note.)', by_staff: 's-admin', by_name: 'Dr. Ali Rashid', created_at: daysAgo(4) + 'T10:01:00.000Z' },
  ];
  const website = (over) => ({ id: uid(), patient_id: null, clinician_id: null, status: 'new', source: 'website', contact_name: null, contact_phone: null,
    contact_mr: null, contact_me: false, ...over, subject: feedbackSubject(over.kind, over.topic) });
  db.complaints.push(
    website({ kind: 'suggestion', topic: 'cleanliness', branch_id: 1, body: 'The washroom could be cleaned more often in the evening. (Made-up sample.)', created_at: daysAgo(1) + 'T18:40:00' }),
    website({ kind: 'complaint', topic: 'front_desk', branch_id: 2, body: 'Nobody answered the phone on Sunday. (Made-up sample.)', contact_name: 'Hira Sample',
      contact_phone: '03005550433', contact_mr: '9815', contact_me: true, created_at: daysAgo(3) + 'T12:05:00' }));
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
  // Checkup patients (no patient file, no Mr#): 64 rows of an old follow-up list (months over the last 14, every status, a few without a
  // month) and today's checkups. All made up: names from a fixed pool, phones 0300-555xxxx.
  const firstNames = ['Hoor', 'Wajiha', 'Sabeen', 'Komal', 'Areej', 'Tuba', 'Mubeen', 'Yusra', 'Haris', 'Arham', 'Zohaib', 'Fahad', 'Noman', 'Salman', 'Danish'];
  const lastNames = ['Anwar', 'Saeed', 'Bukhari', 'Lodhi', 'Memon', 'Pasha', 'Raza', 'Sheikh'];
  const monthStart = (back) => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - back); return d.toISOString().slice(0, 10); };
  const cityOf = (branchId) => db.cities.find((c) => c.id === db.branches.find((b) => b.id === branchId)?.city_id)?.name || null;
  db.checkups = [];
  for (let i = 0; i < 64; i++) {
    const branch = [1, 2, 3, 4, 5, null][i % 6];
    db.checkups.push(chk({
      checkup_date: [10, 30, 50].includes(i) ? null : monthStart(i % 14), date_is_month: true, branch_id: branch,
      patient_name: `${firstNames[i % 15]} ${lastNames[Math.floor(i / 8) % 8]}`, phone: '0300-555' + (1000 + i), city: branch ? cityOf(branch) : null,
      doctors: i % 3 === 0 ? 'Dr. Hina (sample)' : null, checkup_for: ['Checkup', 'Scaling', 'Braces checkup', 'Whitening'][i % 4],
      est_fee: i % 9 === 0 ? 8000 + i * 1000 : null, follow_up: FOLLOW_UP_STATUSES[i % 11], notes: i % 4 === 0 ? 'Called, will let us know' : null,
      source: 'archive', source_tab: 'Sample tab ' + 'ABC'[i % 3], created_at: daysAgo(3) + 'T10:00:00.000Z' }));
  }
  db.checkups[4].patient_id = db.patients[2].id;   // one old-list row already has a patient file
  db.checkups[4].follow_up = 'Started';
  const at = (n) => new Date(Date.now() + n).toISOString();
  db.checkups.push(
    chk({ checkup_date: today, branch_id: 2, patient_name: 'Bareera Khalid', phone: '0300-5550701', city: 'Karachi', doctors: 'Dr. Rabia (sample)', checkup_for: 'Braces',
      day_status: 'waiting', source: 'website', created_at: at(1),
      ali_recommended: true, pricing_understood: 'needs_explanation', wants_treatment: true, treatment_plan: 'Next month, after her exams' }),
    chk({ checkup_date: today, branch_id: 2, patient_name: 'Salma Nadeem', phone: '0300-5550702', city: 'Karachi', doctors: 'Dr. Hina (sample)', checkup_for: 'Scaling',
      details: 'Scaling advised', token: '7', day_status: 'completed', source: 'google_sheet', sheet_key: 'S-demo00000001', created_at: at(2) }),
    chk({ checkup_date: today, branch_id: 1, patient_name: 'Imtiaz Gill', phone: '0300-5550703', city: 'Karachi', doctors: 'Dr. Amna (sample)', checkup_for: 'Scaling and polishing',
      day_status: 'waiting', source: 'website', created_at: at(3),
      ali_recommended: false, pricing_understood: 'yes', wants_treatment: false, treatment_plan: 'Wants to compare prices first' }));
  db.audit = [];
  // The demo's stand-in for the login server: logins the clinic made for patients ({ patient_id, email, password, must_change }).
  // Kept apart from every patient row, and never returned by any method, like the real login server's passwords.
  db.portal_logins = [];
  return db;
}

// ---------------------------------------------------------------- adapter
export function createDemoAdapter() {
  let db = seed();
  let session = null; // { staff } | { patient, login? }  (login: the portal login row that signed in)
  const ownPasswords = new Map(); // account id -> the password that account chose in changeOwnPassword() on this page (demo accounts have no real one)
  const saved = new Map(); // idempotency key -> what that save produced (a retried save returns it instead of saving twice)
  const formKeys = new Map(); // the answers of the Google Form imported so far (private.checkup_form_imports): key -> checkup id

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
      dues: dues(v.patient_id), see_dr_ali: !!activeFlag(v.patient_id),
      // As in the database: invoices are seen with billing.view only, so without it no visit has one.
      has_invoice: can('billing.view') && db.invoices.some((i) => i.visit_id === v.id && i.status !== 'void') };
  };

  // Checkups (patients without a patient file): which rows this person may see, how a row is shown, and the Checkups page's filters.
  const checkupBranchOk = (c) => c.branch_id === null || c.branch_id === undefined || branchOk(c.branch_id);
  const checkupVisible = (c) => (can('sheet.view') || can('patients.view')) && checkupBranchOk(c);
  const checkupView = (c) => ({ ...clone(c), phone_key: checkupPhone(c.phone), mr_number: c.patient_id && can('patients.view') ? patient(c.patient_id)?.mr_number ?? null : null });
  const monthText = (iso, withDay) => (withDay ? iso.slice(8, 10) + ' ' : '') + monthLabel(iso);
  function checkupMatches({ q = '', branchId = null, from = null, to = null, followUp = '', source = '', registered = '', wants = '' } = {}) {
    const text = String(q || '').replace(/[%,()*\\"]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const digits = text.replace(/[^0-9]/g, '');
    const keys = [];
    if (digits.length >= 4) keys.push(digits);
    if (digits.startsWith('92') && digits.length - 2 >= 4) keys.push(digits.slice(2));
    const month = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
    return db.checkups.filter((c) => checkupVisible(c)
      && (!text || c.patient_name.toLowerCase().includes(text) || keys.some((k) => (checkupPhone(c.phone) || '').includes(k)))
      && (branchId === 'none' ? c.branch_id === null : branchId === null || branchId === undefined || branchId === '' || c.branch_id === Number(branchId))
      && (!month.test(from || '') || (c.checkup_date !== null && c.checkup_date >= from + '-01'))
      && (!month.test(to || '') || (c.checkup_date !== null && c.checkup_date < monthAfter(to)))
      && (!followUp || c.follow_up === followUp)
      && (!['website', 'google_sheet', 'google_form', 'archive'].includes(source) || c.source === source)
      && (registered !== 'yes' || c.patient_id) && (registered !== 'no' || !c.patient_id)
      && (wants !== 'yes' || c.wants_treatment === true) && (wants !== 'no' || c.wants_treatment === false))
      .sort((a, b) => (a.checkup_date === b.checkup_date ? 0 : a.checkup_date === null ? 1 : b.checkup_date === null ? -1 : a.checkup_date < b.checkup_date ? 1 : -1)
        || (a.created_at === b.created_at ? 0 : a.created_at < b.created_at ? 1 : -1) || (a.id < b.id ? -1 : 1));
  }

  // One branch's list for one day as the database's private.day_list_rows builds it (20261012000100_day_list_history.sql): every visit,
  // the checkup patients shown on that list, in the Aaj ki List's order, with the patients' dues at this moment.
  const STAFF_ROLE_ORDER = { doctor: 0, assistant: 1, checker: 2 };
  function dayRows(branchId, date) {
    const visits = db.visits.filter((v) => v.branch_id === branchId && v.visit_date === date);
    const checkups = dayListCheckups(db.checkups.filter((c) => c.branch_id === branchId && c.checkup_date === date), visits);
    const doctorsOf = (v) => db.visit_staff.filter((x) => x.visit_id === v.id)
      .map((x) => ({ ...x, name: clinician(x.clinician_id)?.display_name || '' }))
      .sort((a, b) => STAFF_ROLE_ORDER[a.role] - STAFF_ROLE_ORDER[b.role] || a.name.localeCompare(b.name))
      .map((x) => (x.role === 'checker' ? '✓ ' : '') + x.name + (x.role === 'assistant' ? ' (assistant)' : '')).join(', ') || null;
    return orderDayList([
      ...visits.map((v) => {
        const p = patient(v.patient_id);
        return { kind: 'patient', id: v.id, patient_id: v.patient_id, mr: p.mr_number, name: p.full_name, month: v.braces_month ?? null,
          treatment: v.treatment_label || null, token: v.token_no == null ? null : String(v.token_no), status: v.status,
          group: v.doctor_group_id ? `Group ${v.doctor_group_id}` : null, doctors: doctorsOf(v), details: v.details_text || null, notes: v.notes || null,
          dues: dues(v.patient_id),
          has_invoice: db.invoices.some((i) => i.status === 'issued' && (i.visit_id === v.id || (i.patient_id === v.patient_id && i.branch_id === v.branch_id && i.issue_date === v.visit_date))),
          phone: p.phone && p.phone !== '0000000' ? p.phone : null, created_at: v.created_at };
      }),
      ...checkups.map((c) => ({ kind: 'checkup', id: c.id, patient_id: c.patient_id, mr: c.patient_id ? patient(c.patient_id)?.mr_number ?? null : null,
        name: c.patient_name, month: null, treatment: c.checkup_for, token: c.token, status: c.day_status, group: null, doctors: c.doctors,
        details: c.details, notes: c.notes, dues: null, has_invoice: false, phone: c.phone, created_at: c.created_at })),
    ]);
  }
  const closingOf = (branchId, date) => db.day_closings.find((x) => x.branch_id === Number(branchId) && x.list_date === date) || null;
  // One day already ended, for the History: North Nazimabad five days ago, ended at 21:05 (Pakistan time) by its front desk.
  function seedDayClosing() {
    const day = daysAgo(5);
    const rows = dayRows(2, day);
    db.day_closings = [{ id: uid(), branch_id: 2, list_date: day, closed_at: day + 'T16:05:00.000Z', closed_by: 's-fd-nn',
      closed_by_name: 'Front desk (North Nazimabad)', snapshot: rows, counts: countDayList(rows), times_updated: 0 }];
  }
  seedDayClosing(); // (here: it needs patient(), dues() and clinician() above)

  function applyVisitRules(v, prev) {
    if (v.braces_month && (!prev || prev.braces_month !== v.braces_month)) {
      const rule = protocolFor(v.braces_month);
      v.photo_required = rule.photoRequired && v.braces_month <= LAST_DEFINED_MONTH;
      v.checker_required = rule.checkerGroup !== null;
      // The database's default: a month treated by one group only gets that group.
      if (v.doctor_group_id == null && rule.treatingGroups.length === 1) v.doctor_group_id = rule.treatingGroups[0];
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
    // Staff and the sample patient sign in from the list of demo accounts; a login a staff member made for a patient also works here.
    async signIn(email, password) {
      const address = normalizeLoginInput(email, CONFIG.STAFF_EMAIL_DOMAIN);
      const login = db.portal_logins.find((l) => l.email === address && l.password === String(password));
      const p = login && patient(login.patient_id);
      if (!p) fail('Invalid login credentials');
      session = { patient: p, login };
      db.login_events ||= [];
      db.login_events.unshift({ at: new Date().toISOString(), kind: 'patient', name: p.full_name, role: null, user_agent: 'This browser' });
      return this.getSession();
    },
    isPortalLoginName(email) { return isPatientLoginName(email, CONFIG.STAFF_EMAIL_DOMAIN); },
    async sendPasswordReset(email) {
      if (this.isPortalLoginName(email)) throw Object.assign(new Error('Ask the clinic to reset your password.'), { code: 'CLINIC_RESET' });
      fail('Password reset emails are not sent in the demo.');
    },
    /**
     * Same rules and the same failures as the live adapter. A demo account has no real password, so the first time any non-empty
     * current password is accepted; the new one is remembered in memory (until the page is reloaded or the demo is reset), and from
     * then on the current password must match it.
     */
    async changeOwnPassword(currentPassword, newPassword) {
      const id = session?.staff?.id || (session?.patient ? 'p-demo' : null);
      if (!id) throw passwordError('NOT_LOGGED_IN');
      const problem = passwordProblems({ current: currentPassword, next: newPassword })[0];
      if (problem) throw passwordError('PASSWORD_RULE', problem.message);
      if (ownPasswords.has(id) && ownPasswords.get(id) !== currentPassword) throw passwordError('WRONG_PASSWORD');
      ownPasswords.set(id, newPassword);
    },
    /** The logged-in patient chooses their own password (clears the "must change" flag of a login the clinic made). */
    async changePassword(password) {
      if (!session?.patient) fail('Please log in again.');
      const problem = checkPortalPassword(password);
      if (problem) fail(problem);
      if (session.login) {
        if (session.login.password === password) fail('New password should be different from the old password.');
        session.login.password = password;
        session.login.must_change = false;
      }
    },
    async signOut() { session = null; return true; },
    // The demo has one login in one page: no other tab or computer can end it and it never expires, so no login event ever
    // arrives. Same call as the live adapter (fn(eventName, reason)); returns the function that stops listening.
    onAuthChange() { return () => {}; },
    async getSession() {
      if (!session) return null;
      if (session.patient) return { kind: 'patient', patient: clone(session.patient), perms: new Set(), mustChangePassword: !!session.login?.must_change };
      const s = db.staff.find((x) => x.id === session.staff.id);
      if (!s?.active) { session = null; return null; }
      return { kind: 'staff', staff: clone(s), perms: permsFor(s) };
    },
    async resetDemo() { db = seed(); seedDayClosing(); session = null; ownPasswords.clear(); },

    // ------------------------------------------------------------ reference
    async branches() { return clone(db.branches.filter((b) => b.active)); },
    async cities() { return clone(db.cities); },
    async clinicians() { return clone(db.clinicians.filter((c) => c.active)); },
    async doctorGroups() { return clone(db.doctor_groups); },
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
      if (String(p.email).trim().toLowerCase().endsWith('@' + CONFIG.STAFF_EMAIL_DOMAIN)) fail('Use Create portal login for clinic usernames.');
      p.portal_user_id = 'p-' + id;
    },
    /** Staff make the patient's portal login at the clinic. Resolves { username }. */
    async createPatientLogin(id, password) {
      need('portal.invite');
      const p = patient(id);
      if (!p) fail('Patient not found.');
      if (p.portal_user_id) fail('This patient already has a portal login.');
      const problem = checkSlipPassword(password);
      if (problem) fail(problem);
      const email = portalLoginEmail(p.full_name, p.mr_number, CONFIG.STAFF_EMAIL_DOMAIN);
      if (!email || !isPatientLoginName(email, CONFIG.STAFF_EMAIL_DOMAIN)) fail(NO_USERNAME_MESSAGE);
      if (db.portal_logins.some((l) => l.email === email) || db.staff.some((x) => x.email === email)) fail('That username is already used by another login.');
      db.portal_logins.push({ patient_id: id, email, password: String(password), must_change: true });
      p.portal_user_id = 'p-' + id;
      audit('patients', 'PORTAL_LOGIN_CREATED', p);
      return { username: email };
    },
    /** Staff set a new password for a login made that way; the patient must choose their own again. Resolves { username }. */
    async resetPatientPassword(id, password) {
      need('portal.invite');
      const p = patient(id);
      if (!p) fail('Patient not found.');
      if (!p.portal_user_id) fail('This patient has no portal login yet. Create one first.');
      const problem = checkSlipPassword(password);
      if (problem) fail(problem);
      const login = db.portal_logins.find((l) => l.patient_id === id);
      if (!login) fail('This patient logs in with their own email address. They can set a new password with "Forgot password" on the login page.');
      login.password = String(password);
      login.must_change = true;
      audit('patients', 'PORTAL_PASSWORD_RESET', p);
      return { username: login.email };
    },
    /** { has_login, clinic_login, username } */
    async portalLoginInfo(id) {
      need('portal.invite');
      const p = patient(id);
      if (!p) fail('Patient not found.');
      const login = db.portal_logins.find((l) => l.patient_id === id);
      return { has_login: !!p.portal_user_id, clinic_login: !!login, username: login?.email || null };
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
    // By token, then by when the row was added and by its id, as the live adapter asks the database (rows with no token and one
    // created_at, such as an imported day's, keep the order the History's copy has: lib/day-list.js orderDayList).
    // (patientId: that patient's visits of the day only, as the live adapter)
    async listVisits({ branchId, date, patientId }) {
      need('sheet.view');
      return db.visits.filter((v) => (!branchId || v.branch_id === Number(branchId)) && v.visit_date === date && (!patientId || v.patient_id === patientId) && branchOk(v.branch_id))
        .sort((a, b) => (a.token_no ?? 999) - (b.token_no ?? 999) || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0)
          || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(enrichVisit);
    },
    subscribeVisits() { return () => {}; },
    // A busy day to try the Aaj ki List with (the list's "?demo=busy", demo only): 120 more made-up patients on one branch's
    // list for the day, in every state of a day half done. Names "Sample Patient 001" to "120", Mr# from 7001, phones
    // 0300 555 3001 onwards; once per branch and day. (Sample Patient 111 has all three flags: medical history, Dr. Ali, a note.)
    async fillBusyDay({ branchId, date = todayISO() }) {
      need('sheet.view');
      const branch = Number(branchId);
      db.busy_days ||= [];
      if (!db.branches.some((b) => b.id === branch) || !branchOk(branch) || db.busy_days.includes(`${branch}|${date}`)) return 0;
      const base = 7000 + 200 * db.busy_days.length;
      db.busy_days.push(`${branch}|${date}`);
      const doctorsIn = (g) => db.clinicians.filter((c) => c.is_doctor && c.doctor_group_id === g);
      const anyDoctor = db.clinicians.filter((c) => c.is_doctor);
      const assistants = db.clinicians.filter((c) => !c.is_doctor);
      const other = ['Retainer Pick', 'Checkup', 'Scaling', 'RCT', 'Bracket Fix', 'Followup', 'Filling', 'Extraction', 'Hygiene Appointment'];
      const otherDetails = ['Scaling done', 'RCT 2nd sitting', 'Filling UR6', 'Retainer given', 'X-ray advised', 'Bracket rebond LL3'];
      const wire = (m) => (m < 3 ? '012' : m < 4 ? '014' : m < 8 ? '016' : '018');
      const invoice = (patientId, visitId, amount, issued, paid) => {
        const inv = { id: uid(), invoice_no: 'INV-' + date.slice(0, 4) + '-' + String(db.invoices.length + 1).padStart(6, '0'), patient_id: patientId, branch_id: branch,
          visit_id: visitId, issue_date: issued, subtotal: amount, discount_amount: 0, total: amount, status: 'issued', template_key: 'classic',
          items: [{ description: visitId ? 'Visit (sample)' : 'Braces instalment (sample)', quantity: 1, unit_price: amount }] };
        db.invoices.push(inv);
        if (paid) db.payments.push({ id: uid(), patient_id: patientId, invoice_id: inv.id, branch_id: branch, amount: paid, method: 'cash', received_at: issued + 'T15:00:00' });
      };
      let token = Math.max(0, ...db.visits.filter((v) => v.branch_id === branch && v.visit_date === date && v.token_no).map((v) => v.token_no));
      for (let i = 1; i <= 120; i++) {
        const p = { id: uid(), mr_number: String(base + i), full_name: `Sample Patient ${String(i).padStart(3, '0')}`, phone: '0300555' + String(3000 + base - 7000 + i),
          email: null, first_branch_id: branch, referral_source: 'Walk-in', photo_consent_public: false, created_at: daysAgo(200), notes: null, portal_user_id: null,
          medical_history: i % 23 === 0 || i === 111 ? { conditions: ['Diabetes'], allergies: i % 2 ? 'Penicillin' : '' } : {} };
        db.patients.push(p);
        const status = i <= 70 ? 'completed' : i <= 80 ? 'in_treatment' : i <= 112 ? 'waiting' : 'scheduled';
        const done = status === 'completed';
        const month = i % 3 ? ((i * 7) % 18) + 1 : null;
        const rule = month ? protocolFor(month) : null;
        let bc = null;
        if (month) {
          bc = { id: uid(), patient_id: p.id, start_date: daysAgo(month * 30), extraction_plan: ['undecided', 'extraction', 'non_extraction'][i % 3],
            extractions_done: false, kit_name: 'Sample kit A', total_fee: 60000, status: 'active', treatment_plan_by_dr_ali: 'Standard plan' };
          db.braces_cases.push(bc);
        }
        const group = rule ? rule.treatingGroups[i % rule.treatingGroups.length] : [1, 2, 3, null][i % 4];
        const v = { id: uid(), patient_id: p.id, branch_id: branch, visit_date: date, token_no: status === 'scheduled' ? null : ++token, status,
          treatment_label: month ? 'Monthly' : other[i % other.length], braces_case_id: bc?.id ?? null, braces_month: month, doctor_group_id: group,
          details_text: done ? (month ? `U L ${wire(month)} PC refresh` : otherDetails[i % otherDetails.length]) : '',
          photo_required: !!rule?.photoRequired, photos_uploaded: done && !!rule?.photoRequired, checker_required: rule ? rule.checkerGroup !== null : false, checked_by: null,
          checked_in_at: status === 'scheduled' ? null : `${date}T${String(12 + Math.floor(i / 20)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}:00`,
          created_at: new Date().toISOString(), notes: i % 29 === 0 || i === 111 ? 'Wants an evening slot next time' : null };
        // Sample Patient 099 came from the Google Sheet with "Group 4", a group Clinic setup does not have: the sync keeps the
        // visit in no group and the sheet's words in sheet_cells (as the live database does).
        if (i === 99) v.sheet_cells = { group: { t: 'Group 4', v: null } };
        db.visits.push(v);
        if (done || status === 'in_treatment' || i % 9 === 0) {
          const pool = group ? doctorsIn(group) : anyDoctor;
          db.visit_staff.push({ visit_id: v.id, clinician_id: pool[i % pool.length].id, role: 'doctor' });
          if (i % 5 === 0) db.visit_staff.push({ visit_id: v.id, clinician_id: assistants[i % assistants.length].id, role: 'assistant' });
        }
        if (done && rule?.checkerGroup) {
          const checker = doctorsIn(rule.checkerGroup)[i % doctorsIn(rule.checkerGroup).length];
          v.checked_by = checker.id;
          db.visit_staff.push({ visit_id: v.id, clinician_id: checker.id, role: 'checker' });
        }
        // Dues on some patients (an older instalment part paid), and an invoice for most of today's finished visits.
        const owe = i % 7 === 0 ? 11500 : i % 11 === 0 ? 20000 : i % 13 === 0 ? 500 : 0;
        if (owe) invoice(p.id, null, owe + 5000, daysAgo(40), 5000);
        if ((done || status === 'in_treatment') && i % 6) invoice(p.id, v.id, 3000, date, 3000);
        if (i % 37 === 0) db.patient_flags.push({ id: uid(), patient_id: p.id, kind: 'see_dr_ali', reason: 'Sample: check the bite', raised_by: 's-asst', raised_at: daysAgo(1) + 'T16:00:00', cleared_at: null });
      }
      return 120;
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

    // ------------------------------------------------------------ Aaj ki List: "End the day" and its History (as 20261012000100_day_list_history.sql)
    async endDay({ branchId, date }) {
      if (!can('sheet.end_day')) fail('NOT_ALLOWED: ending the day needs "End the day on the Aaj ki List" in the access list.');
      const b = Number(branchId);
      if (!db.branches.some((x) => x.id === b) || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) fail('BAD_REQUEST: choose one branch and a day to end.');
      if (!branchOk(b)) fail('NOT_ALLOWED: you can end the day only at the branches you work at.');
      if (date > todayISO()) fail('FUTURE_DAY: that day has not come yet, so it cannot be ended.');
      if (date < FIRST_DAY) fail('TOO_FAR_BACK: That date is too far back.');
      const rows = dayRows(b, date);
      const now = new Date().toISOString();
      const fields = { closed_at: now, closed_by: me().id, closed_by_name: me().full_name, snapshot: rows, counts: countDayList(rows) };
      let row = closingOf(b, date);
      if (row) Object.assign(row, fields, { times_updated: row.times_updated + 1 });
      else { row = { id: uid(), branch_id: b, list_date: date, ...fields, times_updated: 0 }; db.day_closings.push(row); }
      audit('day_list_closings', 'END_DAY', row);
      return { ...clone(row.counts), branch_id: b, list_date: date, closed_at: row.closed_at, closed_by_name: row.closed_by_name, times_updated: row.times_updated };
    },
    async dayClosing({ branchId, date }) {
      if (!can('sheet.view') || !branchOk(branchId)) return null;
      const c = closingOf(branchId, date);
      return c ? { id: c.id, branch_id: c.branch_id, list_date: c.list_date, closed_at: c.closed_at, closed_by_name: c.closed_by_name, times_updated: c.times_updated, counts: clone(c.counts) } : null;
    },
    async dayListHistory({ branchId = null, from = null, to = null, limit = 60, offset = 0 } = {}) {
      if (!can('sheet.view')) fail('NOT_ALLOWED: the History of Aaj ki List needs "View Aaj ki List / queue" in the access list.');
      if (branchId && !branchOk(branchId)) fail('NOT_ALLOWED: you can see the lists of the branches you work at only.');
      const today = todayISO();
      const top = to && to < today ? to : today;
      const branches = db.branches.filter((b) => (!branchId || b.id === Number(branchId)) && branchOk(b.id)).map((b) => b.id);
      const days = new Map();
      const add = (b, day) => { if (day && (!from || day >= from) && day <= top && branches.includes(b)) days.set(`${day}|${b}`, { b, day }); };
      for (const v of db.visits) add(v.branch_id, v.visit_date);
      for (const c of db.checkups) if (!c.date_is_month && c.source !== 'google_form') add(c.branch_id, c.checkup_date); // (as dayListCheckups)
      for (const x of db.day_closings) add(x.branch_id, x.list_date);
      const all = [...days.values()].sort((x, y) => (x.day === y.day ? x.b - y.b : x.day < y.day ? 1 : -1));
      const size = Math.min(Math.max(Math.trunc(Number(limit)) || 1, 1), 200);
      const first = Math.max(Math.trunc(Number(offset)) || 0, 0);
      const rows = all.slice(first, first + size).map(({ b, day }) => {
        const c = closingOf(b, day);
        return { list_date: day, branch_id: b, branch_name: db.branches.find((x) => x.id === b)?.name || '', ended: !!c, closed_at: c?.closed_at ?? null,
          closed_by_name: c?.closed_by_name ?? null, times_updated: c?.times_updated ?? null, counts: c ? clone(c.counts) : countDayList(dayRows(b, day)), total_count: all.length };
      });
      return { rows, total: rows.length ? all.length : 0 };
    },
    async dayListCopy({ branchId, date }) {
      if (!can('sheet.view')) fail('NOT_ALLOWED: the History of Aaj ki List needs "View Aaj ki List / queue" in the access list.');
      const b = Number(branchId);
      if (!db.branches.some((x) => x.id === b) || !date) fail('BAD_REQUEST: choose one branch and a day.');
      if (!branchOk(b)) fail('NOT_ALLOWED: you can see the lists of the branches you work at only.');
      const c = closingOf(b, date);
      // Without "See $$ pending dues flag" no dues, without "View patient profiles" no patients' phones (the database leaves them out too).
      const rows = clone(c ? c.snapshot : dayRows(b, date)).map((r) => {
        const out = { ...r };
        if (!can('dues.view')) delete out.dues;
        if (!can('patients.view') && out.kind === 'patient') delete out.phone;
        return out;
      });
      return { branch_id: b, branch_name: db.branches.find((x) => x.id === b)?.name || '', list_date: date, ended: !!c, closed_at: c?.closed_at ?? null,
        closed_by_name: c?.closed_by_name ?? null, times_updated: c?.times_updated ?? null, counts: c ? clone(c.counts) : countDayList(rows), rows };
    },

    // ------------------------------------------------------------ checkups (patients without a patient file / Mr#)
    // The same rules as the database: read = sheet.view or patients.view; add and change = sheet.edit; all within the person's branches
    // (a row with no branch is open to everyone who may read); delete = admin, or sheet.edit on a row that is not from the old list.
    async listCheckups({ q = '', branchId = null, from = null, to = null, followUp = '', source = '', registered = '', wants = '', page = 0, pageSize = 50 } = {}) {
      const rows = checkupMatches({ q, branchId, from, to, followUp, source, registered, wants });
      const first = Math.max(0, Number(page) || 0) * pageSize;
      return { rows: rows.slice(first, first + pageSize).map(checkupView), total: rows.length };
    },
    async exportCheckups(filters = {}) {
      const rows = checkupMatches(filters);
      const out = rows.slice(0, 20000).map(checkupView);
      if (rows.length > 20000) { out.truncated = true; out.cap = 20000; }
      return out;
    },
    // (an answer imported from the Google Form is on the Checkups page, never on a day's list: that day's list did not have it)
    async listDayCheckups({ branchId = null, date }) {
      return db.checkups.filter((c) => c.checkup_date === date && !c.date_is_month && c.source !== 'google_form' && (!branchId || c.branch_id === Number(branchId)) && checkupVisible(c))
        .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(checkupView);
    },
    subscribeCheckups() { return () => {}; },
    async addCheckup(row) {
      need('sheet.edit');
      const c = chk({ checkup_date: row.checkup_date || todayISO(), source: 'website', created_by: me().id, ...checkupPatch(row), est_fee: null });
      if (!c.follow_up) c.follow_up = 'Not Contacted';
      if (!checkupBranchOk(c)) fail('new row violates row-level security policy (branch)');
      checkValid(c);
      db.checkups.push(c); audit('checkups', 'INSERT', c);
      return checkupView(c);
    },
    async updateCheckup(id, changes) {
      const c = db.checkups.find((x) => x.id === id);
      if (!c || !checkupVisible(c) || !can('sheet.edit') || !checkupBranchOk(c)) return null;   // as in the database: the update reaches no row
      const next = { ...c, ...checkupPatch(changes), updated_at: new Date().toISOString() };
      if (!checkupBranchOk(next)) fail('new row violates row-level security policy (branch)');
      checkValid(next);
      Object.assign(c, next); audit('checkups', 'UPDATE', c);
      return checkupView(c);
    },
    async deleteCheckup(id) {
      const c = db.checkups.find((x) => x.id === id);
      if (!c || !checkupVisible(c) || !(me()?.role === 'admin' || (can('sheet.edit') && checkupBranchOk(c) && c.source !== 'archive' && c.source !== 'google_form'))) {
        fail('NOT_REMOVED: this checkup could not be removed (rows from the old list or the Google Form can only be removed by Dr. Ali).');
      }
      db.checkups = db.checkups.filter((x) => x.id !== id); audit('checkups', 'DELETE', c);
    },
    async registerCheckupAsPatient(id) {
      // Registering also links the checkup and moves its follow-up status, which is editing the list: both rights are needed (as in the database).
      if (!(can('patients.create') && can('sheet.edit'))) fail('NOT_ALLOWED: registering a patient needs "Register new patients" and "Add and edit Aaj ki List entries" in the access list.');
      const c = db.checkups.find((x) => x.id === id);
      if (!c || !checkupVisible(c)) fail('NOT_FOUND: this checkup is not on your list.');
      const name = c.patient_name.trim().replace(/\s+/g, ' ');
      if (c.patient_id) fail(`ALREADY_REGISTERED: ${name} already has a patient file (Mr# ${patient(c.patient_id)?.mr_number ?? '?'}).`);
      if (name.length < 2) fail('NAME_TOO_SHORT: write the full name on the checkup first.');
      const phone = (c.phone || '').replace(/[^0-9+]/g, '');
      const branch = db.branches.find((b) => b.id === c.branch_id);
      const city = db.cities.find((x) => x.name.toLowerCase() === (c.city || '').trim().toLowerCase()) || db.cities.find((x) => x.id === branch?.city_id) || null;
      const when = !c.checkup_date ? 'date not recorded' : c.date_is_month ? monthText(c.checkup_date, false) : monthText(c.checkup_date, true);
      while (db.patients.some((p) => p.mr_number === String(db.mr_next))) db.mr_next++;
      const p = { id: uid(), mr_number: String(db.mr_next++), full_name: name, phone: phone.length >= 7 ? phone : null, email: null, gender: null, date_of_birth: null,
        first_branch_id: c.branch_id, city_id: city?.id ?? null, referral_source: null, photo_consent_public: false,
        notes: 'From the checkup list: checkup ' + when + (branch ? ' at ' + branch.name : '') + (c.checkup_for ? ', for ' + c.checkup_for : ''), created_at: new Date().toISOString() };
      db.patients.push(p); audit('patients', 'INSERT', p);
      c.patient_id = p.id;
      if (!['Started', 'Completed'].includes(c.follow_up)) c.follow_up = 'Started';
      c.updated_at = new Date().toISOString(); audit('checkups', 'UPDATE', c);
      return { patient_id: p.id, mr_number: p.mr_number, full_name: p.full_name };
    },
    async linkCheckupToPatient(id, patientId) {
      if (!(can('sheet.edit') && can('patients.view'))) fail('NOT_ALLOWED: linking a checkup to a patient file needs "Add and edit Aaj ki List entries" and "View patient profiles" in the access list.');
      const c = db.checkups.find((x) => x.id === id);
      if (!c || !checkupVisible(c)) fail('NOT_FOUND: this checkup is not on your list.');
      const p = patient(patientId);
      if (!p) fail('NOT_FOUND: that patient file does not exist.');
      if (c.patient_id && c.patient_id !== p.id) {
        fail(`ALREADY_REGISTERED: ${c.patient_name.trim().replace(/\s+/g, ' ')} already has a patient file (Mr# ${patient(c.patient_id)?.mr_number ?? '?'}).`);
      }
      if (!c.patient_id) {
        c.patient_id = p.id;
        if (!['Started', 'Completed'].includes(c.follow_up)) c.follow_up = 'Started';
        c.updated_at = new Date().toISOString(); audit('checkups', 'UPDATE', c);
      }
      return { patient_id: p.id, mr_number: p.mr_number, full_name: p.full_name };
    },
    // Admin: the old checkup list, with the database's rules (same key, fill or overwrite, the same counts).
    async importCheckups(rows, { overwrite = false } = {}) {
      if (me()?.role !== 'admin') fail('NOT_ALLOWED: only Dr. Ali can import the checkup list.');
      if (!Array.isArray(rows)) fail('BAD_ROWS: send the rows as a list.');
      if (rows.length > 500) fail('TOO_MANY_ROWS: send at most 500 rows at a time.');
      const out = { given: rows.length, inserted: 0, updated: 0, unchanged: 0, kept: 0, skipped: [], skipped_count: 0 };
      const skip = (row, reason) => { out.skipped_count++; if (out.skipped.length < 100) out.skipped.push({ row, reason }); };
      const text = (v, max) => cleanText(v === undefined ? null : v, max).value;
      const archiveKey = (c) => checkupKey({ phone: c.phone, name: c.patient_name, month: c.checkup_date });
      const existing = new Map(db.checkups.filter((c) => c.source === 'archive').map((c) => [archiveKey(c), c]));
      const firstRow = new Map();
      rows.forEach((raw, n) => {
        const w = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        const rowNo = /^[0-9]{1,9}$/.test(String(w.row ?? '')) ? Number(w.row) : n + 1;
        const name = text(w.name, 200);
        if (name === null) return skip(rowNo, 'No patient name');
        const month = typeof w.month === 'string' && /^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}$/.test(w.month) && !w.month.startsWith('0000') ? w.month.slice(0, 7) + '-01' : null;
        const phone = text(w.phone, 40);
        const key = checkupKey({ phone, name, month });
        if (firstRow.has(key)) return skip(rowNo, `Same person and month as row ${firstRow.get(key)}`);
        firstRow.set(key, rowNo);
        const status = text(w.follow_up, 60) ?? 'Not Contacted';
        const notes = text(w.notes, 2000);
        const hit = existing.get(key);
        if (hit) {
          const nextStatus = overwrite ? status : hit.follow_up === 'Not Contacted' ? status : hit.follow_up;
          const nextNotes = overwrite || !(hit.notes || '').trim() ? notes ?? hit.notes : hit.notes;
          if (nextStatus !== hit.follow_up || nextNotes !== hit.notes) {
            hit.follow_up = nextStatus; hit.notes = nextNotes; hit.updated_at = new Date().toISOString(); audit('checkups', 'UPDATE', hit); out.updated++;
          } else if (status !== hit.follow_up || (notes !== null && notes !== hit.notes)) out.kept++;
          else out.unchanged++;
          return;
        }
        const fee = typeof w.est_fee === 'number' && Number.isFinite(w.est_fee) ? Math.round(w.est_fee * 100) / 100 : null;
        const branchCode = String(w.branch ?? '').trim().toUpperCase();
        const c = chk({ checkup_date: month, date_is_month: true, branch_id: db.branches.find((b) => b.code.toUpperCase() === branchCode)?.id ?? null, patient_name: name, phone,
          city: text(w.city, 80), doctors: text(w.doctors, 300), checkup_for: text(w.checkup_for, 300), est_fee: fee !== null && fee >= 0 && fee <= 9999999999.99 ? fee : null,
          follow_up: status, notes, source: 'archive', source_tab: text(w.source_tab, 120), created_by: me().id });
        db.checkups.push(c); existing.set(key, c); audit('checkups', 'INSERT', c); out.inserted++;
      });
      return out;
    },

    // Admin: the old answers of the Google Form "Checkup Patient Form 2.0", with the database's rules (import_checkup_form, migration
    // 20261011000300): the same keys, the same order of places an answer goes to, the same counts. dryRun works on a copy (the preview).
    async importCheckupForm(rows, { dryRun = false } = {}) {
      if (me()?.role !== 'admin') fail('NOT_ALLOWED: only Dr. Ali can import the answers of the checkup form.');
      if (!Array.isArray(rows)) fail('BAD_ROWS: send the rows as a list.');
      if (rows.length > 500) fail('TOO_MANY_ROWS: send at most 500 rows at a time.');
      const list = dryRun ? clone(db.checkups) : db.checkups;
      const keys = dryRun ? new Map(formKeys) : formKeys;
      const out = { given: rows.length, inserted: 0, filled_day: 0, filled_month: 0, already: 0, same: 0, skipped: [], skipped_count: 0, other_name: 0, other_answers: 0,
        follow_up_noted: 0, dry_run: !!dryRun };
      const skip = (row, reason) => { out.skipped_count++; if (out.skipped.length < 100) out.skipped.push({ row, reason }); };
      const text = (v, max) => cleanText(typeof v === 'string' ? v : null, max).value;
      const karachi = (ms) => new Date(ms + 5 * 3600000).toISOString();     // Karachi's wall clock (+05:00 all year), as YYYY-MM-DDTHH:MM:SS
      const today = karachi(Date.now()).slice(0, 10);
      const open = karachi(Date.now() - 3 * 3600000).slice(0, 10);
      const nameKey = (t) => String(t).replace(/\s+/g, ' ').trim().toLowerCase();
      rows.forEach((raw, n) => {
        const w = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        const rowNo = /^[0-9]{1,9}$/.test(String(w.row ?? '')) ? Number(w.row) : n + 1;
        const name = text(typeof w.name === 'string' ? w.name.replace(/\s+/g, ' ') : null, 200);
        // a time of this century with its offset, on a day its month has (the browser would roll 30 Feb over to March)
        const t = typeof w.submitted_at === 'string' ? /^(20[0-9]{2})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?(Z|[+-](0[0-9]|1[0-4]):?[0-5][0-9])$/.exec(w.submitted_at) : null;
        const ms = t && new Date(Date.UTC(Number(t[1]), Number(t[2]) - 1, Number(t[3]))).getUTCDate() === Number(t[3]) ? Date.parse(w.submitted_at) : NaN;
        const local = Number.isNaN(ms) ? null : karachi(ms);
        const date = local ? local.slice(0, 10) : null;
        if (name === null) return skip(rowNo, 'No patient name');
        if (!date) return skip(rowNo, 'The date could not be read');
        if (date > today) return skip(rowNo, 'The date is in the future');
        if (date >= open) return skip(rowNo, "Given today: today's list is still kept in the Google Sheet. Import the file again tomorrow.");
        const phone = text(w.phone, 40);
        const pk = checkupPhone(phone);
        const key = `${date} ${local.slice(11, 19)}|${pk ?? ''}|${name.toLowerCase()}`;
        if (keys.has(key)) { out.already++; return; }
        const branch = db.branches.find((b) => b.code.toUpperCase() === String(w.branch ?? '').trim().toUpperCase())?.id ?? null;
        const ali = typeof w.ali_recommended === 'boolean' ? w.ali_recommended : null;
        const wants = typeof w.wants_treatment === 'boolean' ? w.wants_treatment : null;
        const pricing = Object.keys(PRICING_LABELS).includes(w.pricing_understood) ? w.pricing_understood : null;
        const plan = text(w.treatment_plan, 500), doctors = text(w.doctors, 300), checkupFor = text(w.checkup_for, 300), follow = text(w.follow_up, 60), notes = text(w.notes, 2000);
        // the checkup of that person on that day at that branch: the same phone and name (private.aaj_name_fits; another name on the same
        // phone is another person, e.g. two children on a parent's phone), or the same name without a phone; the same name letter for letter
        // first, then the oldest; the first whose answers agree (private.checkup_form_agrees). Else, when that person is not on that day's
        // list, the old list's row of that person and month, when its answers agree. A checkup holding other answers is never filled in.
        let kind = 'filled_day';
        let second = false;
        const agrees = (x) => (ali === null || (x.ali_recommended ?? null) === null || x.ali_recommended === ali)
          && (pricing === null || (x.pricing_understood ?? null) === null || x.pricing_understood === pricing)
          && (wants === null || (x.wants_treatment ?? null) === null || x.wants_treatment === wants)
          && (plan === null || (x.treatment_plan ?? null) === null || x.treatment_plan.toLowerCase() === plan.toLowerCase());
        const day = list.filter((x) => x.checkup_date === date && !x.date_is_month && x.source !== 'archive' && (x.branch_id ?? null) === branch);
        const samePhone = pk ? day.filter((x) => checkupPhone(x.phone) === pk) : [];
        const person = day.filter((x) => (samePhone.includes(x) && (!nameNorm(name) || !nameNorm(x.patient_name) || nameFits(name, x.patient_name)))
          || ((!pk || !checkupPhone(x.phone)) && nameKey(x.patient_name) === name.toLowerCase()))
          .sort((a, b) => (Number(nameKey(b.patient_name) === name.toLowerCase()) - Number(nameKey(a.patient_name) === name.toLowerCase()))
            || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));
        let c = person.find(agrees);
        if (!c && person.length) second = true;               // that person's checkup of that day holds other answers
        else if (!c && samePhone.length) out.other_name++;
        if (!c && !second) {
          kind = 'filled_month';
          const arch = list.find((x) => x.source === 'archive' && checkupKey({ phone: x.phone, name: x.patient_name, month: x.checkup_date }) === checkupKey({ phone, name, month: date }));
          if (arch && agrees(arch)) c = arch; else second = !!arch;
        }
        if (c) {
          // the plain word in the spellings the sync reads as a checkup is no answer; what the checkup keeps its own text for goes into its notes
          const nextFor = (c.checkup_for ?? null) === null || /^\s*ch[ea]{1,2}c?k?[- ]?ups?\s*$/i.test(c.checkup_for) ? checkupFor ?? c.checkup_for ?? null : c.checkup_for;
          const nextDoctors = c.doctors ?? doctors;
          const nextBranch = c.branch_id ?? branch;
          const nextFollow = kind === 'filled_day' && c.follow_up === 'Not Contacted' && follow !== null ? follow : c.follow_up;
          // the follow-up status from REMINDERS that the checkup does not take (it has another, or it is the old list's row): kept in the notes,
          // unless the answer's notes already have what REMINDERS said ("Reminder: ...", lib/checkup-form.js)
          const remind = follow !== null && String(nextFollow ?? '').toLowerCase() !== follow.toLowerCase() && !/(^|; )Reminder: /.test(notes ?? '')
            ? `Reminder (Google Form): ${follow}` : null;
          let nextNotes = c.notes ?? null;
          for (const part of [notes, remind,
            doctors !== null && nextDoctors.toLowerCase() !== doctors.toLowerCase() ? `On the Google Form: "Who did your checkup?" ${doctors}` : null,
            checkupFor !== null && nextFor.toLowerCase() !== checkupFor.toLowerCase() ? `On the Google Form: "What was your checkup for?" ${checkupFor}` : null,
            branch !== null && nextBranch !== branch ? `On the Google Form: "Which branch did you visit?" ${db.branches.find((b) => b.id === branch)?.name}` : null]) {
            if (part !== null && !(nextNotes || '').includes(part)) nextNotes = !(nextNotes || '').trim() ? part : (nextNotes + '; ' + part).slice(0, 2000);
          }
          const next = {
            ali_recommended: c.ali_recommended ?? ali, pricing_understood: c.pricing_understood ?? pricing, wants_treatment: c.wants_treatment ?? wants,
            treatment_plan: c.treatment_plan ?? plan, doctors: nextDoctors, checkup_for: nextFor, phone: c.phone ?? phone, branch_id: nextBranch,
            follow_up: nextFollow,
            notes: nextNotes,
          };
          if (Object.keys(next).some((k) => (next[k] ?? null) !== (c[k] ?? null))) {
            if (remind !== null && !(c.notes || '').includes(remind) && (nextNotes || '').includes(remind)) out.follow_up_noted++;
            Object.assign(c, next, { form_submitted_at: c.form_submitted_at ?? new Date(ms).toISOString(), updated_at: new Date().toISOString() });
            if (!dryRun) audit('checkups', 'UPDATE', c);
            out[kind]++;
          } else out.same++;
          keys.set(key, c.id);
          return;
        }
        const at = new Date(ms).toISOString();
        const fresh = chk({ checkup_date: date, branch_id: branch, patient_name: name, phone, doctors, checkup_for: checkupFor, day_status: 'completed',
          follow_up: follow ?? 'Not Contacted', notes, source: 'google_form', source_tab: 'Checkup Form 2.0', ali_recommended: ali, pricing_understood: pricing,
          wants_treatment: wants, treatment_plan: plan, form_submitted_at: at, created_at: at, created_by: me().id });
        checkValid(fresh);
        list.push(fresh);
        if (!dryRun) audit('checkups', 'INSERT', fresh);
        keys.set(key, fresh.id);
        out.inserted++;
        if (second) out.other_answers++;
      });
      return out;
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
    // Like the live inbox: open complaints always, resolved ones for 90 days; from 'portal' or 'website' narrows it by where it came from.
    async complaints({ from = '' } = {}) {
      need('complaints.view');
      const since = daysAgo(90);
      return db.complaints
        .filter((c) => (!from || (c.source || 'portal') === from)
          && (c.status !== 'resolved' || String(c.resolved_at || '').slice(0, 10) >= since || c.created_at.slice(0, 10) >= since))
        .map((c) => ({ ...clone(c), patient: clone(patient(c.patient_id)), messages: clone(db.complaint_messages.filter((m) => m.complaint_id === c.id)) }))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
    async deleteComplaint(id) {
      const c = db.complaints.find((x) => x.id === id);
      if (!c || c.source !== 'website' || c.patient_id || me()?.role !== 'admin') fail('NOT_REMOVED: only Dr. Ali (admin) can delete a website form, and a patient\'s complaint is never deleted.');
      db.complaints = db.complaints.filter((x) => x.id !== id);
      db.complaint_messages = db.complaint_messages.filter((m) => m.complaint_id !== id);
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
        // only complaints: a website suggestion or thank-you linked to a doctor is not a complaint about their work (a patient's has no kind)
        complaints: db.complaints.filter((c) => c.clinician_id === clinicianId && (c.kind || 'complaint') === 'complaint' && inRange(c.created_at.slice(0, 10))).map((c) => ({ id: c.id, subject: c.subject, status: c.status, created_at: c.created_at, branch_id: c.branch_id, patient_name: patient(c.patient_id)?.full_name, mr_number: patient(c.patient_id)?.mr_number, source: c.source || 'portal' })),
        rule: rule ? { percent: rule.percent, basis: rule.basis, notes: rule.notes } : null, share: rule ? Math.round(base * rule.percent) / 100 : null };
    },

    // ------------------------------------------------------------ Retainer Record and Lab Work (data/demo-records.js)
    ...recordsDemo({ db: () => db, me, can, need, branchOk, clone, fail, uid, audit, patient }),

    // ------------------------------------------------------------ the homepage forms (visitors, no login)
    // The same rules as the database functions (submit_job_application, submit_feedback): every field checked again, the honeypot
    // and the per-phone / per-CNIC limits answer { ok: true } without storing, the whole-website limits ask to try again later
    // (or tomorrow, once the day is full). db.form_log stands in for private.public_form_log: every form that passed its checks,
    // stored or dropped; the whole-website limits count it and a CV in it is used, so a dropped form leaves the same traces.
    async uploadJobCv(file) {
      const info = cvFileInfo(file);
      if (info.error) throw formError('cv', info.error, 'FORM_CV');
      // the database's upload limits (CV_UPLOAD_LIMITS), in the words the live data layer gives them (it asks job_cv_upload_busy which one)
      const uploads = (ms) => db.job_cvs.filter((x) => Date.parse(x.created_at) > Date.now() - ms);
      const bytes = (list) => list.reduce((t, x) => t + (x.size || 0), 0);
      // a CV sent with a form is used, stored or dropped (the log has both), as job_cv_upload_problem counts it
      const unsent = db.job_cvs.filter((x) => !db.job_applications.some((a) => a.cv_path === x.path) && !db.form_log.some((l) => l.cv_path === x.path));
      if (uploads(86400000).length >= CV_UPLOAD_LIMITS.perDay || bytes(uploads(86400000)) + file.size > CV_UPLOAD_LIMITS.bytesPerDay
        || bytes(unsent) + file.size > CV_UPLOAD_LIMITS.unsentBytes) fail('FORM_BUSY_DAY: many CVs have arrived today. Please try again tomorrow.');
      if (uploads(60000).length >= CV_UPLOAD_LIMITS.perMinute) fail('FORM_BUSY: many CVs are arriving right now. Please try again later.');
      const path = `incoming/${crypto.randomUUID ? crypto.randomUUID() : uid()}.${info.ext}`;
      db.job_cvs.push({ path, type: info.type, size: file.size, file, created_at: new Date().toISOString() });
      return path;
    },
    async submitJobApplication(form) {
      const ok = { ok: true };
      if (cleanLine(form?.[HONEYPOT])) return ok;
      const { errors, data } = checkJobApplication(form);
      if (errors.length) throw formError(errors[0].field, errors[0].message);
      if (data.branch !== 'any' && !db.branches.some((b) => b.active && b.id === data.branch)) throw formError('branch', 'Please choose a branch, or "Any branch".');
      if (!/^incoming\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|doc|docx|jpg|png)$/.test(String(data.cv_path || ''))) throw formError('cv', 'Please attach your CV again.', 'FORM_CV');
      const logged = (ms) => db.form_log.filter((x) => x.form === 'job' && Date.parse(x.created_at) > Date.now() - ms).length;
      if (logged(86400000) >= 200) fail('FORM_BUSY_DAY: the clinic has received many job applications today. Please try again tomorrow.');
      if (logged(60000) >= 5) fail('FORM_BUSY: many job applications are arriving right now. Please try again later.');
      // a CV already sent (stored or dropped) gets one answer first, whether or not its file is still there
      if (db.form_log.some((x) => x.cv_path === data.cv_path) || db.job_applications.some((a) => a.cv_path === data.cv_path)) throw formError('cv', 'Please choose your CV again.', 'FORM_CV');
      const cv = db.job_cvs.find((x) => x.path === data.cv_path);
      if (!cv) throw formError('cv', 'Your CV did not finish uploading. Please choose it again.', 'FORM_CV');
      if (Date.parse(cv.created_at) < Date.now() - 86400000) throw formError('cv', 'Please choose your CV again.', 'FORM_CV');
      db.form_log.push({ form: 'job', cv_path: cv.path, created_at: new Date().toISOString() });
      // after every other check and the log, like the database: nothing depends on whether the phone or CNIC was used before
      const since = (ms) => db.job_applications.filter((a) => Date.parse(a.created_at) > Date.now() - ms);
      if (since(86400000).filter((a) => a.phone === data.phone).length >= 2 || since(86400000).filter((a) => a.cnic === data.cnic).length >= 2) return ok;
      const now = new Date().toISOString();
      db.job_applications.unshift({ id: uid(), full_name: data.full_name, phone: data.phone, email: data.email, position: data.position, qualification: data.qualification,
        graduation_year: data.graduation_year, experience: data.experience, branch_id: data.branch === 'any' ? null : data.branch, cnic: data.cnic, cv_path: cv.path,
        cv_type: cv.type, cv_size: cv.size, message: data.message, consent_at: now, status: 'new', updated_by: null, updated_at: null, created_at: now });
      return ok;
    },
    async submitFeedback(form) {
      const ok = { ok: true };
      if (cleanLine(form?.[HONEYPOT])) return ok;
      const { errors, data } = checkFeedback(form);
      if (errors.length) throw formError(errors[0].field, errors[0].message);
      if (data.branch !== 'none' && !db.branches.some((b) => b.active && b.id === data.branch)) throw formError('branch', 'Please choose a branch, or "Not about one branch".');
      const logged = (ms) => db.form_log.filter((x) => x.form === 'feedback' && Date.parse(x.created_at) > Date.now() - ms).length;
      if (logged(86400000) >= 200) fail('FORM_BUSY_DAY: the clinic has received many messages today. Please try again tomorrow.');
      if (logged(60000) >= 10) fail('FORM_BUSY: many forms are arriving right now. Please try again later.');
      db.form_log.push({ form: 'feedback', cv_path: null, created_at: new Date().toISOString() });
      const web = (ms) => db.complaints.filter((c) => c.source === 'website' && Date.parse(c.created_at) > Date.now() - ms);
      if (data.phone && web(86400000).filter((c) => c.contact_phone === data.phone).length >= 5) return ok;
      db.complaints.push({ id: uid(), patient_id: null, branch_id: data.branch === 'none' ? null : data.branch, clinician_id: null, subject: feedbackSubject(data.kind, data.topic),
        body: data.message, status: 'new', created_at: new Date().toISOString(), source: 'website', kind: data.kind, topic: data.topic,
        contact_name: data.name, contact_phone: data.phone, contact_mr: data.mr, contact_me: data.contact_me });
      return ok;
    },

    // ------------------------------------------------------------ job applications (staff with jobs.view)
    async jobApplications({ status = '', position = '', branch = '' } = {}) {
      need('jobs.view');
      return db.job_applications
        .filter((a) => (!status || a.status === status) && (!position || a.position === position)
          && (!branch || (branch === 'any' ? a.branch_id === null : a.branch_id === Number(branch))))
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .map((a) => ({ ...clone(a), events: clone(db.job_events.filter((e) => e.application_id === a.id).sort((x, y) => (x.created_at < y.created_at ? -1 : 1))) }));
    },
    /** How many applications are New (the Today page). */
    async newJobApplications() {
      need('jobs.view');
      return db.job_applications.filter((a) => a.status === 'new').length;
    },
    async updateJobApplication(id, { status = null, note = null } = {}) {
      need('jobs.view');
      const a = db.job_applications.find((x) => x.id === id);
      if (!a) fail('NOT_FOUND: this application does not exist.');
      if (status && !JOB_STATUS_LABELS[status]) fail('INVALID: unknown status ' + status);
      const text = cleanBlock(note);
      if (text.length > LIMITS.note) fail('INVALID: a note can have at most 2,000 characters.');
      const by = { by_staff: me().id, by_name: me().full_name, created_at: new Date().toISOString() };
      const changed = !!status && status !== a.status;
      if (changed) { a.status = status; db.job_events.push({ id: uid(), application_id: id, kind: 'status', status, body: null, ...by }); }
      if (text) db.job_events.push({ id: uid(), application_id: id, kind: 'note', status: null, body: text, ...by });
      if (changed || text) { a.updated_by = me().id; a.updated_at = by.created_at; }
      return clone(a);
    },
    /** A short-lived link to open the CV: here a link to the file in this browser (a made-up sample has a short text instead); it stops working after a minute. */
    async jobCvUrl(path) {
      need('jobs.view');
      const cv = db.job_cvs.find((x) => x.path === path);
      if (!cv) fail('The CV file was not found.');
      const url = URL.createObjectURL(cv.file || new Blob(['A made-up CV for the demo. Nothing here is real.'], { type: 'text/plain' }));
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return url;
    },
    async jobCvOrphans() {
      need('jobs.view');
      return db.job_cvs.filter((x) => Date.parse(x.created_at) < Date.now() - 86400000 && !db.job_applications.some((a) => a.cv_path === x.path))
        .map((x) => ({ path: x.path, uploaded_at: x.created_at, size_bytes: x.size }));
    },
    async removeJobCvOrphans(paths) {
      need('jobs.view');
      const gone = new Set((await this.jobCvOrphans()).map((x) => x.path).filter((p) => (paths || []).includes(p)));
      db.job_cvs = db.job_cvs.filter((x) => !gone.has(x.path));
      return gone.size;
    },

    // ------------------------------------------------------------ coordinator
    // Like the live list, this leaves out what is finished: done or cancelled reminders.
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
      if (isPatientLoginName(row.email, CONFIG.STAFF_EMAIL_DOMAIN)) fail(PATIENT_SHAPE_ERROR);
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
        if (isPatientLoginName(e, CONFIG.STAFF_EMAIL_DOMAIN)) fail(PATIENT_SHAPE_ERROR);
        if (db.staff.some((x) => x.email === e && x.id !== id)) fail('That login email is already used. Pick another.');
        s.email = e; audit('staff', 'UPDATE', s);
      }
      if (password != null && password !== '' && String(password).length < 8) fail('The password needs at least 8 characters.');
    },
    async updateStaffBranches(id, branchIds) {
      need('users.manage');
      const s = db.staff.find((x) => x.id === id);
      if (!s) fail('Staff account not found.');
      // The database trigger's rules: only an admin may change an admin account, or their own branches.
      if (me().role !== 'admin' && s.role === 'admin') fail('Only admin can change an admin account');
      if (me().role !== 'admin' && s.id === me().id) fail('You cannot change your own role, branches or active flag');
      const ids = [...new Set((branchIds || []).map(Number))];
      const home = s.home_branch_id ?? null;
      Object.assign(s, { branch_ids: ids, restrict_to_branches: ids.length > 0, home_branch_id: ids.length && !ids.includes(home) ? ids[0] : home });
      audit('staff', 'UPDATE', s);
    },
    async updateStaffRole(id, role, fromRole) {
      need('users.manage');
      const s = db.staff.find((x) => x.id === id);
      if (!s) fail('Staff account not found.');
      // Same as the live adapter: only if the row still has the role the dialog showed; a doctor's braces group goes with the doctor role.
      if (fromRole && s.role !== fromRole) fail('The role was not saved: it may have been changed meanwhile. Reload the page and try again.');
      if (role !== 'doctor' && role !== 'admin') s.doctor_group_id = null;
      if (!ROLES.includes(role)) fail(`invalid input value for enum staff_role: "${role}"`);
      // The database trigger's rules: only an admin may create or promote an admin, change an admin account, or change their own role.
      if (me().role !== 'admin' && role === 'admin') fail('Only admin can create or promote admin accounts');
      if (me().role !== 'admin' && s.role === 'admin') fail('Only admin can change an admin account');
      if (me().role !== 'admin' && s.id === me().id && role !== s.role) fail('You cannot change your own role, branches or active flag');
      s.role = role;
      audit('staff', 'UPDATE', s);
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
      const out = { given: rows.length, future: 0, patients_created: 0, visits_inserted: 0, visits_updated: 0, staff_added: 0, cases_created: 0, tokens: 0, rows_unmatched: 0, checkups_skipped: 0, cases: {}, unmatched: [] };
      // nothing is guessed: an Mr# is that patient (never somebody else on the same phone or name); a row without an Mr# is matched only by
      // its phone and first name (exactly one patient), never by a name alone; a row without an Mr# whose Treatment says checkup is skipped
      const digits = (t) => { let x = String(t || '').replace(/\D/g, ''); if (x.length === 10 && x[0] === '3') x = '0' + x; if (x.length === 12 && x.startsWith('92')) x = '0' + x.slice(2); return x.length >= 7 ? x : null; };
      const first = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().split(/\s+/).find((w) => !/^(m|mr|mrs|ms|miss|dr|md|muhammad|mohammad|muhammed|mohammed|mohd|syed|syeda|sayed|hafiz|haji|baby|master|kid)$/.test(w)) || '';
      // an Mr# is that patient only when the row's name fits them without doubt (the sync's check, private.aaj_check_mr): a row typed with
      // another patient's Mr# is reported back, never filed on that patient
      const words =(t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().split(/\s+/).filter((w) => w && !/^(m|mr|mrs|ms|miss|dr|md|muhammad|mohammad|muhammed|mohammed|mohd|syed|syeda|sayed|hafiz|haji|baby|master|kid)$/.test(w));
      const lev = (a, b) => { let prev = Array.from({ length: b.length + 1 }, (_, j) => j); for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))); prev = cur; } return prev[b.length]; };
      // private.aaj_name_sound: an everyday spelling of a first name ("Umar" / "Umer", "Aisha" / "Ayesha", "Nur" / "Noor") sounds the same
      const sound = (t) => (t ? ({ o: 'u', e: 'i' }[t[0]] || t[0]) + t.slice(1).replace(/[aeiouyh]/g, '').replace(/[qzv]/g, (c) => ({ q: 'k', z: 's', v: 'w' }[c])).replace(/(.)\1+/g, '$1') : '');
      const close = (a, b) => {           // private.aaj_name_close
        const wa = words(a), wb = words(b), ga = first(a), gb = first(b);
        if (!ga || !gb || wa.length > 4) return false;
        if (ga === gb || (wa.length <= 2 && wa.includes(gb)) || (wb.length >= 2 && wa.length <= wb.length + 1 && wb.every((w) => wa.includes(w)))) return true;
        if (wa[0] === ga && wb[0] === gb && (wa.length === 1 || (wa.length === wb.length && wa.slice(1).join(' ') === wb.slice(1).join(' ')))
            && sound(ga) === sound(gb) && Math.abs(ga.length - gb.length) <= 1 && lev(ga, gb) <= 2) return true;
        const m = Math.min(ga.length, gb.length);
        return lev(ga, gb) <= (m >= 6 ? 2 : m === 5 ? 1 : 0);
      };
      const conflict = (a, b) => { const wa = words(a), wb = words(b); return wa.length >= 2 && wb.length >= 2 && !(wa.every((w) => wb.includes(w)) || wb.every((w) => wa.includes(w))); };
      // private.aaj_name_spelling: one word without the everyday ways of writing it in English letters (Ayesha / Aisha, Noor / Nur, Umer / Umar)
      const spell = (t) => {
        let s = String(t || '').toLowerCase().replace(/[^a-z]/g, '').replace(/[qv]/g, (c) => ({ q: 'k', v: 'w' }[c]));
        s = s.replace(/([aeiou])ye/g, '$1i').replace(/(.)y(?![aeiou])/g, '$1i').replace(/([^aeiou])y(?=[aeiou])/g, '$1i');
        s = s.replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/ou/g, 'u').replace(/^e/, 'i').replace(/[oe]/g, (c) => ({ o: 'u', e: 'a' }[c]));
        return s.replace(/(.)\1+/g, '$1').replace(/([aiu])h$/, '$1');
      };
      // private.aaj_name_fits (11 Oct 2026): an Mr# is that patient only when the row's name fits them WITHOUT DOUBT: the same first name (or
      // an everyday spelling of it) and no other surname. A name that is only close (another surname, a slip, another first name), or only the
      // patient's phone with another name, is reported back with why, never filed on that patient
      const fits = (r, p) => {
        if (String(r[3]).trim().toLowerCase().replace(/\s+/g, ' ') === String(p.full_name || '').trim().toLowerCase().replace(/\s+/g, ' ')) return true;
        const wa = words(r[3]), wb = words(p.full_name);
        if (!wa.length || !wb.length || wa.length > 4) return false;
        const ka = wa.map(spell), kb = wb.map(spell);
        if (!ka[0] || ka[0] !== kb[0] || !(ka.every((w) => kb.includes(w)) || kb.every((w) => ka.includes(w)))) return false;
        // Muhammad (M, Md, Mohd ...), Syed, Hafiz, Baby ... count as words when both names have two or more: "Muhammad Usman" is not "Usman Tariq"
        const raw = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().split(/\s+/).filter((w) => w && !/^(mr|mrs|ms|miss|dr)$/.test(w))
          .map((w) => (/^(m|md|mohd|mohammad|muhammed|mohammed)$/.test(w) ? 'muhammad' : w === 'sayed' ? 'syed' : w)).map(spell);
        const ra = raw(r[3]), rb = raw(p.full_name);
        return ra.length < 2 || rb.length < 2 || ra.every((w) => rb.includes(w)) || rb.every((w) => ra.includes(w));
      };
      const doubtWhy = (r) => {
        const p = r[2] ? db.patients.find((x) => x.mr_number === r[2]) : null;
        if (!p || fits(r, p) || !((first(r[3]) && close(r[3], p.full_name)) || (digits(r[5]) && digits(r[5]) === digits(p.phone)))) return null;
        return `the name only partly matches Mr# ${p.mr_number} (${p.full_name}): another surname, another first name or only the phone. Check the Mr# or the name`;
      };
      // an old Mr# is that patient only with their whole name (no other surname), or with their phone and first name (private.aaj_check_mr)
      const movedFits = (r, p) => (close(r[3], p.full_name) && !conflict(r[3], p.full_name))
        || (!!digits(r[5]) && digits(r[5]) === digits(p.phone) && (!first(r[3]) || close(r[3], p.full_name)));
      // a row without an Mr#: the one patient on its phone with its whole name, or else with its first name when the surnames do not conflict
      // ("Ali Raza" is not his brother "Ali Hamza" on the family phone: reported back with why, like private.aaj_find_patient in the import)
      const phoneWhy = {};
      const find = (r) => {
        if (r[2]) { const p = db.patients.find((x) => x.mr_number === r[2]) || null; return p && fits(r, p) ? p : null; }
        const ph = digits(r[5]);
        if (!ph || !first(r[3])) return null;
        const exact = db.patients.filter((p) => digits(p.phone) === ph && normN(p.full_name) === normN(r[3]));
        if (exact.length) return exact.length === 1 ? exact[0] : null;
        const same = db.patients.filter((p) => digits(p.phone) === ph && first(p.full_name) === first(r[3]));
        if (same.length !== 1) return null;
        if (conflict(r[3], same[0].full_name)) { phoneWhy[r[3] + '|' + ph] = 'add the Mr# (another person with this first name is on this phone)'; return null; }
        return same[0];
      };
      // an Mr# the website does not have is never a second file for a patient it has: the same name and phone under another Mr# (mr_other), or
      // an old Mr# of that patient (renumbered to 50000+, or merged away; the notes say so) with their whole name (mr_moved). The other rows
      // of that Mr# are held back with it.
      const normN = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      const refusedWhy = (r) => {
        if (!r[2] || db.patients.some((x) => x.mr_number === r[2])) return null;
        const ph = digits(r[5]);
        const o = ph && normN(r[3]) ? db.patients.find((x) => digits(x.phone) === ph && normN(x.full_name) === normN(r[3])) : null;
        if (o) return 'this name and phone are Mr# ' + o.mr_number;
        if (!/^\d{1,15}$/.test(String(r[2]))) return null;
        const was = `Mr# was ${r[2]} until `, merged = `Merged with Mr# ${r[2]} (`;
        const m = db.patients.find((x) => (String(x.notes || '').includes(was) || String(x.notes || '').includes(merged)) && movedFits(r, x));
        if (m) return (String(m.notes || '').includes(was) ? 'Mr# was renumbered to ' : 'Mr# was merged into ') + m.mr_number;
        if (Number(r[2]) >= 50000) return 'an Mr# of 50000 or more that the website never gave (a typo)';
        // a Healthwire number above the limit: Healthwire has not given it yet (private.aaj_hw_limit, M-HW-SQUAT)
        if (/^[1-9]\d{0,4}$/.test(String(r[2])) && Number(r[2]) > hwLimit) return `an Mr# above the newest Healthwire number the website takes (${hwLimit}): probably a typo. Check the Mr#, or import the Healthwire patients first`;
        return null;
      };
      // the highest Healthwire number the website has (files made from typed sheet text do not count), taken before anything is made, plus 100,
      // plus 10 a day since that patient was registered (at most 180 days): private.aaj_hw_limit
      const hwTop = db.patients.reduce((m, p) => (p.legacy_source !== 'aaj_sheet_sync' && p.legacy_source !== 'aaj_ki_list' && /^[1-9]\d{0,4}$/.test(String(p.mr_number))
        && Number(p.mr_number) < 50000 ? Math.max(m, Number(p.mr_number)) : m), 0);
      const hwTopAt = (db.patients.find((p) => p.mr_number === String(hwTop)) || {}).created_at;
      // (the day it was registered in Pakistan time, as the SQL does: a UTC date counted one day too many between 00:00 and 05:00)
      const hwDays = hwTopAt ? Math.max(0, Math.min(180, Math.round((Date.parse(today) - Date.parse(localISO(new Date(hwTopAt)))) / 86400000))) : 0;
      const hwLimit = hwTop + 100 + 10 * hwDays;
      const heldWhy = {};
      for (const r of rows) { if (r[3] && r[2] && r[0] < today && !heldWhy[r[2]]) { const w = refusedWhy(r); if (w) heldWhy[r[2]] = w; } }
      const seenUnmatched = {};
      for (const r of rows) {
        if (!r[3]) continue;
        if (r[0] >= today) { out.future++; continue; }
        if (!r[2] && /\bch[ea]{1,2}c?k?[- ]?ups?\b/i.test(String(r[7] || ''))) { out.checkups_skipped++; continue; }
        let p = find(r);
        const why = p ? null : (refusedWhy(r) || (r[2] && heldWhy[r[2]] ? `held back with the other row of this Mr# (${heldWhy[r[2]]})` : null) || phoneWhy[r[3] + '|' + digits(r[5])] || null);
        // only a Healthwire Mr# (1 to 49999) becomes a new patient file: never a row without an Mr#, never a typo of 50000 or more (owner rules 3 and 4)
        if (!p && !why && createPatients && /^[1-9]\d{0,4}$/.test(String(r[2] || '')) && Number(r[2]) < 50000 && !db.patients.some((x) => x.mr_number === r[2])) {
          p = { id: uid(), mr_number: r[2], full_name: r[3], phone: r[5], email: null, first_branch_id: r[1], referral_source: null, photo_consent_public: false,
            created_at: r[0], notes: `Added from the Aaj ki List (${r[16]}, first seen ${r[0]})`, portal_user_id: null, legacy_source: 'aaj_ki_list' };
          db.patients.push(p); out.patients_created++;
        }
        if (!p) { const k = `${r[3]}|${r[2] || ''}|${r[5] || ''}`; if (!seenUnmatched[k]) { seenUnmatched[k] = { name: r[3], mr: r[2], phone: r[5], rows: 0, first: r[0], last: r[0], tab: r[16], why: doubtWhy(r) || (r[2] && db.patients.some((x) => x.mr_number === r[2]) ? 'Mr# belongs to another patient' : why) }; out.unmatched.push(seenUnmatched[k]); } seenUnmatched[k].rows++; seenUnmatched[k].last = r[0]; out.rows_unmatched++; continue; }
        // a row without an Mr# filed by its phone and first name only (not its whole name) never starts or joins a braces case: its Month stays
        // in the visit's notes (the database's import_aaj_sheet, abuse-privacy M1). A row with an Mr# is here only when its name fits without doubt.
        const differs = !r[2] && !!first(r[3]) && normN(r[3]) !== normN(p.full_name);
        let bc = r[6] && !differs ? (activeCase(p.id) || db.braces_cases.find((b) => b.patient_id === p.id)) : null;
        if (r[6] && !bc && !differs) {
          const start = new Date(r[0] + 'T12:00:00Z'); start.setUTCDate(start.getUTCDate() - (r[6] - 1) * 30);
          bc = { id: uid(), patient_id: p.id, start_date: start.toISOString().slice(0, 10), extraction_plan: 'undecided', extractions_done: false, kit_name: null, total_fee: null,
            status: 'active', treatment_plan_by_dr_ali: null, notes: `From the Aaj ki List history: month rows from ${r[0]}` };
          db.braces_cases.push(bc); out.cases_created++; out.cases.active = (out.cases.active || 0) + 1;
        }
        let v = db.visits.find((x) => x.patient_id === p.id && x.visit_date === r[0]);
        const note = [`Aaj ki List (${r[16]})`, r[6] && !bc ? 'Month ' + r[6] : null, r[13].length ? 'Also: ' + r[13].join(', ') : null, r[15] ? 'Reminder: ' + r[15] : null, differs ? `Sheet name: ${r[3]} (check the Mr#)` : null].filter(Boolean).join(' · ');
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
