// Reading Healthwire's export files and turning them into rows for the
// website's import_healthwire() function. Pure functions, no DOM, so the
// rules can be tested in Node (tests/healthwire.test.mjs).
//
//   Transactions Report.xlsx  one row per payment: Invoice#, MR#, Patient Name, Patient Phone#, Location,
//                             Description, Total, Paid, Discount, Dues, Advance, Mode of Payment, Created By, Updated By, Payment Date
//   Patients.xlsx             one row per patient (columns vary; matched by name)
//   Expenses Report.pdf       table: Sr#, Voucher#, Description, Date, Category, Amount, Payment Mode, Created At, Created By
//
// Branch codes: GUL Gulshan (RJ Mall) · NN North Nazimabad · DHA · LHR Lahore Gulberg · ISB Islamabad.

export const BRANCH_ID = { GUL: 1, NN: 2, DHA: 3, LHR: 4, ISB: 5 };
export const CITY_OF_BRANCH = { 1: 1, 2: 1, 3: 1, 4: 2, 5: 3 };
export const BRANCH_LABEL = { GUL: 'Gulshan (RJ Mall)', NN: 'North Nazimabad', DHA: 'DHA', LHR: 'Lahore Gulberg', ISB: 'Islamabad' };

// Healthwire logins are one per branch; "Sadia Azam" (accounts) and the doctors are not tied to a branch.
const LOGIN_BRANCH = { 'rj mall clinic': 'GUL', 'north nazimabad clinic': 'NN', 'dha clinic': 'DHA', 'lahore gulberg clinic': 'LHR', 'islamabad clinic': 'ISB' };
const NN_OPEN_WEEKDAYS = new Set([1, 4]); // Monday, Thursday (JS getUTCDay: 0 = Sunday)

export const num = (s) => { const n = parseFloat(String(s ?? '').replace(/,/g, '').trim()); return Number.isFinite(n) ? n : 0; };
export const money = (n) => Math.round(n * 100) / 100;

/** "dd/mm/yyyy[ - hh:mmAM]" or "dd-mm-yyyy" or "yyyy-mm-dd" or an Excel serial -> "yyyy-mm-dd" (null if unreadable). */
export function isoDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'number') { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86400000)); return d.toISOString().slice(0, 10); }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/** "dd/mm/yyyy - hh:mmAM" (or with a space before AM, or 24h) -> "yyyy-mm-dd HH:MM" Pakistan time. Noon when no time. */
export function isoMinute(v) {
  const d = isoDate(v);
  if (!d) return null;
  if (typeof v === 'number') { const t = Math.round((v % 1) * 1440); return `${d} ${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; }
  const m = String(v).match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i);
  if (!m) return `${d} 12:00`;
  let hh = Number(m[1]) % 12; const mm = m[2];
  if (m[3]) { if (m[3].toUpperCase() === 'PM') hh += 12; } else hh = Number(m[1]);
  return `${d} ${String(hh).padStart(2, '0')}:${mm}`;
}

const weekday = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay();

/** Branch from the Healthwire login that recorded the row. The North Nazimabad login is also used at Gulshan on days NN is closed. */
export function branchOfLogin(login, iso) {
  const b = LOGIN_BRANCH[String(login || '').trim().toLowerCase()];
  if (b === 'NN' && iso && !NN_OPEN_WEEKDAYS.has(weekday(iso))) return { branch: 'GUL', swapped: true };
  return { branch: b || null, swapped: false };
}

const TAG = { lhr: 'LHR', lahore: 'LHR', gulberg: 'LHR', isb: 'ISB', islamabad: 'ISB', dha: 'DHA', nn: 'NN', nazimabad: 'NN', rj: 'GUL', gulshan: 'GUL', khi: 'GUL', karachi: 'GUL' };
const SUFFIX = /[\s,.-]*\b(lhr|lahore|isb|islamabad|dha|n\.?\s?n|nn|nazimabad|rj|r\.j|gulshan|khi|karachi)\b\.?\s*$/i;

/** "Sana lhr" -> { name: "Sana", tag: "lhr" }. Also tidies ALL CAPS names. */
export function cleanName(raw) {
  let n = String(raw || '').replace(/\s+/g, ' ').trim();
  let tag = null;
  for (let i = 0; i < 3; i++) {
    const m = n.match(SUFFIX);
    if (!m) break;
    tag = m[1].toLowerCase().replace(/[.\s]/g, '');
    n = n.slice(0, m.index).replace(/[\s,.-]+$/, '');
  }
  if (n && (n === n.toUpperCase() || n === n.toLowerCase())) n = n.split(' ').map((w) => (w.startsWith('(') ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(' ');
  return { name: n || 'Unknown', tag };
}
export const tagBranch = (tag) => (tag ? TAG[String(tag).toLowerCase().replace(/[.\s]/g, '')] || null : null);

/** Branch mentioned anywhere in free text (a Location column, an expense description). */
export function branchInText(text) {
  const d = ' ' + String(text || '').toLowerCase() + ' ';
  if (/\b(lhr|lahore|gulberg)\b/.test(d)) return 'LHR';
  if (/\b(isb|islamabad)\b/.test(d)) return 'ISB';
  if (/\bdha\b/.test(d)) return 'DHA';
  if (/\b(n\.?n|nn|nazimabad)\b/.test(d) || d.includes(' n.n ')) return 'NN';
  if (/\b(rj|r\.j|gulshan)\b/.test(d)) return 'GUL';
  return null;
}

export function phoneOf(p) {
  let d = String(p ?? '').replace(/\D/g, '');
  if (/^\d+e\+\d+$/i.test(String(p))) d = String(Number(p)).replace(/\D/g, '');
  if (d.length === 10 && d[0] === '3') d = '0' + d;
  if (d.length === 12 && d.startsWith('92')) d = '0' + d.slice(2);
  return d.length >= 7 ? d : null;
}

/** Healthwire procedure name -> [treatment_id or null, label]. */
export function treatmentFor(name) {
  const n = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (n.includes('monthly')) return [1, 'Monthly'];
  if (n.includes('first payment') || n.includes('braces kit') || n === 'brackets' || n.includes('braces start')) return [4, 'Bonding'];
  if (n.includes('bracket fix') || n.includes('free bracket') || n.includes('bracket')) return [7, 'Bracket Fix'];
  if (n.includes('braces off') || n.includes('bracess off') || n.includes('braces removal') || n.includes('braces remove') || n.includes('glue removal')) return [10, 'Braces Off'];
  if (n.includes('retainer')) return [12, 'Retainer Pick'];
  if (n.includes('hygiene')) return [26, 'Hygiene Appointment'];
  if (n.includes('scaling') || n.includes('polishing')) return [16, 'Scaling'];
  if (n.includes('root canal') || n.startsWith('rct')) return [18, 'RCT'];
  if (n.includes('filling')) return [17, 'Filling'];
  if (n.includes('extraction')) return [19, 'Extraction'];
  if (n.includes('veneer') || n.includes('smile makeover')) return [24, 'Smile Makeover'];
  if (n.includes('crown') || n.includes('zirconia') || n.includes('pfm') || n.includes('e-max') || n.includes('bridge')) return [21, 'Crown Insertion'];
  if (n.includes('shape modification')) return [25, 'Shape Modification'];
  if (n.includes('consultation') || n.includes('checkup') || n.includes('check up')) return [14, 'Checkup'];
  if (n.includes('implant')) return [27, 'Implant Check'];
  if (n.includes('x-ray') || n.includes('opg')) return [20, 'X-Ray / OPG'];
  return [null, String(name || '').trim()];
}

export const CATEGORY_MAP = {
  'Clinic Rent': 'Rent', 'Salary Staff': 'Salaries', Payrolls: 'Salaries', "Doctor's Share": 'Doctor percentage', Advertisement: 'Marketing and ads',
  Machinery: 'Equipment', 'Renovation/Maintenance': 'Maintenance and repairs', 'Food Refreshments Outing Snacks': 'Staff food and refreshments',
  'Income Tax': 'Taxes', Miscellaneous: 'Miscellaneous', 'Lab Works Payment': 'Lab charges', 'Lab Payment': 'Lab charges', 'Laboratory Outsourced Tests Payment': 'Lab charges',
  Material: 'Dental supplies', 'Stock Bill Payment': 'Dental supplies', 'Supplier Opening Balance': 'Dental supplies',
  'Office Supplies': 'Office supplies', 'Clinic Bills': 'Clinic bills (utilities, internet)', 'Home Rent': 'Home rent (Dr. Ali)', 'Home Bills': 'Home bills (Dr. Ali)',
  'Personal Dr. Ali Rashid': 'Personal (Dr. Ali)', 'Travelling Dr. Ali': 'Travel (Dr. Ali)', 'Traveling Staff': 'Travel (staff)', 'Nasir Feroze': 'Nasir Feroze (supplies)',
  'HBL Loan Payment': 'HBL loan', 'Procedure Expenses': 'Procedure expenses', 'Referral Payment': 'Referral payments',
};
export const websiteCategory = (hw) => CATEGORY_MAP[String(hw || '').trim()] || String(hw || '').trim() || 'Miscellaneous';

// Personal and home spending has no branch even when the text mentions one ("sent to Lahore flat").
const NO_BRANCH_CATEGORIES = new Set(['Home Rent', 'Home Bills', 'Personal Dr. Ali Rashid', 'Travelling Dr. Ali', 'HBL Loan Payment', 'Income Tax']);
export function expenseBranch(desc, hwCategory) {
  if (NO_BRANCH_CATEGORIES.has(String(hwCategory || '').trim())) return null;
  return branchInText(desc);
}

// ----------------------------------------------------------------- column matching
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const TX_COLUMNS = {
  inv: ['invoice', 'invoice no', 'invoice number'], mr: ['mr', 'mr no', 'mr number'], name: ['patient name', 'name', 'patient'], phone: ['patient phone', 'phone', 'phone no', 'contact'],
  location: ['location', 'branch'], desc: ['description', 'procedure', 'procedures', 'treatment'], qty: ['quantity', 'qty'], total: ['total', 'total amount', 'amount'],
  paid: ['paid', 'paid amount', 'received', 'cash'], disc: ['discount'], dues: ['dues', 'due', 'balance', 'remaining'], adv: ['advance'], mode: ['mode of payment', 'payment mode', 'mode', 'payment method'],
  createdBy: ['created by'], updatedBy: ['updated by', 'received by', 'user'], date: ['payment date', 'date', 'paid on', 'created at'], serial: ['serial no', 'serial', 'sr'],
};
const PT_COLUMNS = {
  mr: ['mr', 'mr no', 'mr number', 'patient mr'], name: ['patient name', 'name', 'full name'], phone: ['phone', 'phone no', 'mobile', 'contact', 'cell'], phone2: ['phone 2', 'alternate phone', 'other phone', 'secondary phone', 'contact 2'],
  email: ['email'], gender: ['gender', 'sex'], dob: ['dob', 'date of birth', 'birth date'], age: ['age'], address: ['address'], city: ['city'], reg: ['registration date', 'registered on', 'created at', 'reg date', 'date'],
  location: ['location', 'branch'], referred: ['referred by', 'reference'],
};

/** Finds which header belongs to which field. Exact normalised match first, then "starts with". Returns { field: headerIndex }. */
export function matchColumns(headers, spec) {
  const H = headers.map(norm);
  const out = {};
  for (const [field, names] of Object.entries(spec)) {
    let i = -1;
    for (const n of names) { i = H.findIndex((x, k) => x === n && !Object.values(out).includes(k)); if (i >= 0) break; }
    if (i < 0) for (const n of names) { i = H.findIndex((x, k) => x.startsWith(n + ' ') && !Object.values(out).includes(k)); if (i >= 0) break; }
    if (i >= 0) out[field] = i;
  }
  return out;
}

/** Finds the header row (the one holding "Invoice" and "MR" or "Patient") in a sheet given as rows of cells. */
export function findHeaderRow(rows, mustHave) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const H = (rows[i] || []).map(norm);
    if (mustHave.every((group) => group.some((g) => H.some((x) => x === g || x.startsWith(g + ' '))))) return i;
  }
  return -1;
}

const rowsToObjects = (rows, headerAt, map) => rows.slice(headerAt + 1)
  .filter((r) => r && r.some((c) => c !== null && c !== undefined && String(c).trim() !== ''))
  .map((r) => Object.fromEntries(Object.entries(map).map(([f, i]) => [f, r[i] === undefined || r[i] === null ? '' : (typeof r[i] === 'string' ? r[i].trim() : r[i])])));

// ----------------------------------------------------------------- transactions
/** Rows of cells from the Transactions Report -> { tx, columns, missing, headerAt }. */
export function readTransactions(rows) {
  const headerAt = findHeaderRow(rows, [['invoice'], ['mr', 'patient name', 'patient']]);
  if (headerAt < 0) throw new Error('This does not look like a Healthwire Transactions Report: no "Invoice#" / "MR#" header row.');
  const map = matchColumns(rows[headerAt].map(String), TX_COLUMNS);
  const missing = ['inv', 'mr', 'paid', 'date'].filter((f) => !(f in map));
  if (missing.length) throw new Error(`Columns missing from the Transactions Report: ${missing.join(', ')}. In Healthwire, open Financial report → customise columns and tick them.`);
  const tx = rowsToObjects(rows, headerAt, map)
    .filter((r) => /\d/.test(String(r.inv)) && isoDate(r.date))
    .map((r) => ({
      inv: String(r.inv).replace(/\.0$/, '').trim(), mr: String(r.mr).replace(/\.0$/, '').trim(), name: String(r.name || ''), phone: phoneOf(r.phone),
      location: String(r.location || ''), desc: String(r.desc || ''), qty: String(r.qty ?? ''), total: num(r.total), paid: num(r.paid), disc: num(r.disc), dues: num(r.dues), adv: num(r.adv),
      mode: String(r.mode || 'Cash').trim(), createdBy: String(r.createdBy || ''), updatedBy: String(r.updatedBy || ''), at: isoMinute(r.date), date: isoDate(r.date),
    }));
  return { tx, columns: Object.keys(map), headerAt };
}

export const splitProcedures = (desc) => String(desc || '').split(/\s,\s|,(?=\S)/).map((s) => s.trim()).filter(Boolean);

/** Branch of one transaction row: Location column, else the login that created/updated it, else the patient-name tag. */
export function txBranch(t) {
  const loc = branchInText(t.location) || LOGIN_BRANCH[norm(t.location)];
  if (loc) return { branch: loc, how: 'location', swapped: false };
  for (const login of [t.updatedBy, t.createdBy]) {
    const r = branchOfLogin(login, t.date);
    if (r.branch) return { branch: r.branch, how: 'login', swapped: r.swapped };
  }
  const tag = tagBranch(cleanName(t.name).tag);
  if (tag) return { branch: tag, how: 'name', swapped: false };
  return { branch: null, how: 'none', swapped: false };
}

/**
 * Transactions -> rows for import_healthwire(): patients, invoices, payments_tx, visits, plus a summary.
 */
export function buildFromTransactions(tx) {
  const byInv = new Map();
  for (const t of tx) { if (!byInv.has(t.inv)) byInv.set(t.inv, []); byInv.get(t.inv).push(t); }
  const pidBranches = new Map(); // mr -> Map(branch -> votes)
  const vote = (mr, b) => { if (!b) return; const m = pidBranches.get(mr) || new Map(); m.set(b, (m.get(b) || 0) + 1); pidBranches.set(mr, m); };
  const top = (m) => (m ? [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] : null);

  const invoices = [], payments = [], unknownBranch = [], otherPeriods = [];
  const visitsByKey = new Map();
  // Pass 1: branch from each invoice's own rows (login / location / name tag); these also vote for the patient's usual branch.
  const invBranch = new Map(), invHow = new Map();
  for (const [inv, rows] of byInv) {
    rows.sort((a, b) => a.at.localeCompare(b.at));
    const votes = new Map(); let swapped = false, how = 'none';
    for (const t of rows) { const r = txBranch(t); if (r.branch) { votes.set(r.branch, (votes.get(r.branch) || 0) + 1); how = r.how; swapped ||= r.swapped; } }
    const b = top(votes);
    if (b) { invBranch.set(inv, b); invHow.set(inv, swapped ? 'swapped' : how); vote(rows[0].mr, b); }
  }
  // Pass 2: invoices entered by accounts (no clue) take the patient's usual branch, else Gulshan.
  for (const [inv, rows] of byInv) {
    const first = rows[0];
    let b = invBranch.get(inv), note = 0;
    if (!b) {
      b = top(pidBranches.get(first.mr));
      if (b) note = 3; else { b = 'GUL'; note = 4; unknownBranch.push(inv); }
      invBranch.set(inv, b);
    } else if (invHow.get(inv) === 'swapped') note = 1;
    else if (invHow.get(inv) === 'name') note = 2;
    const total = money(Math.max(...rows.map((t) => t.total)));
    const disc = money(Math.max(...rows.map((t) => t.disc)));
    const paidHere = money(rows.reduce((s, t) => s + t.paid, 0));
    const duesHw = first.dues;
    // Total − discount − dues per Healthwire = everything ever paid; if that is more than this file holds, older payments exist.
    const paidElsewhere = money(total - disc - duesHw - paidHere);
    if (paidElsewhere > 0.5) { note = note || 5; otherPeriods.push({ inv, paidElsewhere }); }

    // Items: Healthwire joins several procedures with "," (no space; " , " on screen). A comma followed by a space is part of a name ("Extraction 16, 14, 36").
    const names = splitProcedures(first.desc);
    const qtys = String(first.qty).split(/\s*,\s*/).map((q) => num(q));
    let items;
    if (names.length <= 1) {
      const q = qtys[0] > 0 ? qtys[0] : 1;
      const [tid] = treatmentFor(names[0] || 'Treatment');
      items = [[tid, names[0] || 'Treatment', q, money(total / q)]];
    } else {
      const label = names.map((n, i) => (qtys[i] > 1 ? `${n} (×${qtys[i]})` : n)).join(', ');
      items = [[treatmentFor(names.find((n) => treatmentFor(n)[0]) || names[0])[0], label, 1, total]];
    }
    invoices.push([inv, first.mr, BRANCH_ID[b], first.date, total, disc, note, items]);

    for (const t of rows) {
      if (!t.paid) continue;
      const tb = txBranch(t).branch || b;
      payments.push([inv, t.mr, BRANCH_ID[tb], money(t.paid), t.mode, t.at]);
    }
    const labels = []; let tid = null;
    for (const n of names) { const [id, label] = treatmentFor(n); if (tid === null && id) tid = id; if (!labels.includes(label)) labels.push(label); }
    for (const t of rows) {
      const key = `${t.mr}|${t.date}`;
      const cur = visitsByKey.get(key);
      const tb = txBranch(t).branch || b;
      if (cur) { for (const l of labels) if (!cur.labels.includes(l)) cur.labels.push(l); if (!cur.refs.includes(inv)) cur.refs.push(inv); if (first.desc && !cur.details.includes(first.desc)) cur.details += ' · ' + first.desc; }
      else visitsByKey.set(key, { mr: t.mr, d: t.date, branch: BRANCH_ID[tb], tid, labels: [...labels], details: first.desc, refs: [inv] });
    }
  }
  const visits = [...visitsByKey.values()].sort((a, b) => a.d.localeCompare(b.d) || a.mr.localeCompare(b.mr))
    .map((v) => [v.mr, v.d, v.branch, v.tid, v.labels.join(' / ').slice(0, 120), v.details.slice(0, 400), v.refs.map(Number)]);

  // Patients as far as this file knows them (name, phone, first branch); the Patients export adds the rest.
  const seen = new Map();
  for (const t of tx) {
    if (seen.has(t.mr)) { const p = seen.get(t.mr); if (!p[3] && t.phone) p[3] = t.phone; continue; }
    const { name, tag } = cleanName(t.name);
    const fb = tagBranch(tag) || top(pidBranches.get(t.mr)) || invBranch.get(t.inv);
    seen.set(t.mr, [t.mr, name, t.name.trim() !== name ? t.name.trim() : null, t.phone, null, null, null, null, null, fb ? BRANCH_ID[fb] : null, null]);
  }
  const patients = [...seen.values()].sort((a, b) => Number(a[0]) - Number(b[0]));
  invoices.sort((a, b) => a[3].localeCompare(b[3]) || Number(a[0]) - Number(b[0]));
  payments.sort((a, b) => a[5].localeCompare(b[5]));

  const perBranch = {};
  for (const p of payments) { const k = p[2]; perBranch[k] = money((perBranch[k] || 0) + p[3]); }
  const dates = tx.map((t) => t.date).sort();
  return {
    patients, invoices, payments, visits,
    summary: {
      rows: tx.length, invoices: invoices.length, payments: payments.length, paid: money(payments.reduce((s, p) => s + p[3], 0)), visits: visits.length, patients: patients.length,
      from: dates[0], to: dates[dates.length - 1], perBranch, unknownBranch, otherPeriods, zeroRows: tx.filter((t) => !t.paid).length,
    },
  };
}

// ----------------------------------------------------------------- patients file
export function readPatients(rows) {
  const headerAt = findHeaderRow(rows, [['mr'], ['name', 'patient name', 'full name']]);
  if (headerAt < 0) throw new Error('This does not look like the Healthwire patients list: no "MR" / "Name" header row.');
  const map = matchColumns(rows[headerAt].map(String), PT_COLUMNS);
  const list = rowsToObjects(rows, headerAt, map).filter((r) => /\d/.test(String(r.mr)) && String(r.name || '').trim());
  const patients = list.map((r) => {
    const { name, tag } = cleanName(r.name);
    const ph = phoneOf(r.phone), ph2 = phoneOf(r.phone2);
    const g = String(r.gender || '').toLowerCase();
    const gender = g.startsWith('f') ? 'female' : g.startsWith('m') ? 'male' : g ? 'other' : null;
    const fb = tagBranch(tag) || branchInText(r.location) || null;
    return [String(r.mr).replace(/\.0$/, '').trim(), name, String(r.name).trim() !== name ? String(r.name).trim() : null, ph, ph2 && ph2 !== ph ? ph2 : null,
      String(r.email || '').trim() || null, gender, isoDate(r.dob), String(r.address || '').trim() || null, fb ? BRANCH_ID[fb] : null, isoDate(r.reg)];
  });
  return { patients, columns: Object.keys(map), headerAt };
}

// ----------------------------------------------------------------- expenses PDF
const PDF_COLS = [['sr', 0, 85], ['voucher', 85, 140], ['desc', 140, 200], ['date', 200, 255], ['category', 255, 345], ['amount', 345, 400], ['mode', 400, 455], ['createdAt', 455, 512], ['createdBy', 512, 700]];

/**
 * pages: [{ items: [{ s, x, y }] }] from pdf.js getTextContent (x, y in PDF points, y up).
 * Returns { rows: [{ voucher, desc, date, category, amount, mode, createdAt, createdBy }], total, printedTotal }.
 */
export function readExpensesPdf(pages) {
  const rows = []; let printedTotal = null;
  for (const page of pages) {
    const items = page.items.filter((i) => i.s.trim());
    const hdr = items.find((i) => i.s === 'Sr#');
    if (!hdr) continue;
    const totalItem = items.find((i) => i.s === 'Total' && i.x < 90);
    const body = items.filter((i) => i.y < hdr.y - 5 && i.y > 45 && (!totalItem || i.y > totalItem.y + 2));
    if (totalItem) { const t = items.filter((i) => Math.abs(i.y - totalItem.y) < 3).map((i) => i.s).join(' ').match(/([\d,]+\.?\d*)/g); if (t) printedTotal = num(t[t.length - 1]); }
    const anchors = body.filter((i) => i.x < 85 && /^\d+$/.test(i.s)).map((i) => i.y).sort((a, b) => b - a);
    anchors.forEach((y, k) => {
      const top = y + 6, bottom = k + 1 < anchors.length ? anchors[k + 1] + 6 : -1;
      const cells = {};
      for (const [name, x0, x1] of PDF_COLS) {
        const parts = body.filter((i) => i.y <= top && i.y > bottom && i.x >= x0 && i.x < x1).sort((a, b) => (b.y - a.y) || (a.x - b.x));
        cells[name] = parts.map((i) => i.s).join(' ').replace(/\s+([,.\/])\s*/g, '$1').replace(/\s+/g, ' ').trim();
      }
      rows.push({ voucher: cells.voucher, desc: cells.desc, date: isoDate(cells.date), category: cells.category, amount: num(cells.amount), mode: cells.mode, createdAt: isoMinute(cells.createdAt.replace(/^(\d{2})\/(\d{2})\/(\d{4})/, '$2/$1/$3')), createdBy: cells.createdBy });
    });
  }
  const good = rows.filter((r) => r.date && r.amount > 0 && /^\d+$/.test(r.voucher));
  return { rows: good, dropped: rows.length - good.length, total: money(good.reduce((s, r) => s + r.amount, 0)), printedTotal };
}

/** Expense rows -> { categories, expenses } for import_healthwire(). */
export function buildExpenses(rows) {
  const expenses = rows.map((r) => {
    const b = expenseBranch(r.desc, r.category);
    const bid = b ? BRANCH_ID[b] : null;
    const city = bid ? CITY_OF_BRANCH[bid] : (branchInText(r.desc) === 'LHR' ? 2 : branchInText(r.desc) === 'ISB' ? 3 : 1);
    return [r.date, bid, city, websiteCategory(r.category), money(r.amount), r.mode || 'Cash', r.desc, Number(r.voucher), r.category, r.createdBy || '', r.createdAt];
  }).sort((a, b) => a[0].localeCompare(b[0]) || a[7] - b[7]);
  const categories = [...new Set(expenses.map((e) => e[3]))].sort();
  const perBranch = {}, perCategory = {};
  for (const e of expenses) { perBranch[e[1] ?? 'none'] = money((perBranch[e[1] ?? 'none'] || 0) + e[4]); perCategory[e[3]] = money((perCategory[e[3]] || 0) + e[4]); }
  return { categories, expenses, summary: { rows: expenses.length, total: money(expenses.reduce((s, e) => s + e[4], 0)), perBranch, perCategory, noBranch: expenses.filter((e) => e[1] === null).length } };
}

/** Minimal CSV reader (quotes, commas, CRLF) -> rows of strings. Used for .csv files and in tests. */
export function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.replace(/^﻿/, '')));
}

export const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
