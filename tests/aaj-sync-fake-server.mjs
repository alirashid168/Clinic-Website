// A small in-memory copy of the website's side of the Aaj ki List sync: public.aaj_sync(p_secret, p_payload),
// written from section 2 and 3 of .omc/handoffs/aaj-sync-design.md and its "Changes during build" sections (the owner's rules of
// 9 Oct 2026: a row with no Mr# and a "checkup" Treatment is a checkup patient (any other Treatment needs the Mr# added), Mr# 50000 and
// above is a typo, a deleted row removes the visit safely, a Completed row completes). It lets tests/aaj-sync-script.test.mjs run the Google Apps Script against the CONTRACT without a
// database. The real SQL has its own tests (supabase/tests/25_aaj_sync_test.sql) and the script was also run against it; this
// file is only as faithful as the tests need.
//
// Usage: const server = createServer({ now: () => clock.ms });
//        env.fetchHandler = server.handler;           // see tests/apps-script-mock.mjs
//        server.addPatient({ mr: '9700', name: 'Sadia Khan', phone: '03001234567' });
//        server.addVisit({ branch: 'GUL', date: '2026-10-09', mr: '9700', status: 'waiting' });
//        server.addCheckup({ branch: 'GUL', date: '2026-10-09', name: 'Walk In' });
import crypto from 'node:crypto';

export const DEFAULT_CLINICIANS = [
  { id: 'c-ali', display_name: 'Dr. Ali Rashid', aliases: ['Dr Ali Rashid'], is_doctor: true },
  { id: 'c-haniya', display_name: 'Dr. Haniya Siddiqui', aliases: ['Dr Haniya', 'Dr. Haniya'], is_doctor: true },
  { id: 'c-samrah', display_name: 'Dr. Samrah Khan', aliases: ['Dr. Samrah'], is_doctor: true },
  { id: 'c-zunash', display_name: 'Dr. Zunash Suhail', aliases: [], is_doctor: true },
  { id: 'c-warda', display_name: 'Dr. Warda Javed', aliases: ['Dr Verda', 'Dr. Verda Javed'], is_doctor: true },
  { id: 'c-hira', display_name: 'Hira Anis', aliases: [], is_doctor: false },
];

const STATUS_LABEL = { scheduled: 'Scheduled', waiting: 'Waiting', in_treatment: 'Treatment', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No show' };
const KEY_RE = /^(S-[0-9a-f]{12}|W-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const STOP = new Set('m mr mrs ms miss dr md muhammad mohammad muhammed mohammed mohd syed syeda sayed hafiz haji baby master kid'.split(' '));
const OVERRIDE = 'Completed in the Google Sheet (owner rule, 9 Oct 2026)';

const normName = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const givenName = (t) => {
  const tk = normName(t).split(' ').filter(Boolean);
  let i = 0;
  while (i < tk.length && STOP.has(tk[i])) i++;
  return i < tk.length ? tk[i] : (tk.length ? tk[tk.length - 1] : '');
};
const lev = (a, b) => {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) { const tmp = prev[j]; prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1)); last = tmp; }
  }
  return prev[b.length];
};
const nameClose = (a, b) => {
  const ga = givenName(a), gb = givenName(b);
  if (!ga || !gb || ga === gb) return true;
  if (normName(b).split(' ').includes(ga) || normName(a).split(' ').includes(gb)) return true;
  const m = Math.min(ga.length, gb.length);
  return lev(ga, gb) <= (m >= 6 ? 2 : m === 5 ? 1 : 0);
};
const normPhone = (t) => {
  let d = String(t ?? '').replace(/\D/g, '');
  if (d.length === 10 && d[0] === '3') d = '0' + d;
  if (d.length === 12 && d.startsWith('92')) d = '0' + d.slice(2);
  return d.length >= 7 ? d : null;
};
const isCheckupText = (t) => /ch[ea]{1,2}c?k/i.test(String(t ?? ''));
const doctorKey = (t) => String(t ?? '').toLowerCase().replace(/\bdr\.?\s*/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
const peopleKey = (t) => [...new Set(String(t ?? '').split(/,|\/|&|\band\b/i).map(doctorKey).filter(Boolean))].sort().join('|');
const pkDate = (ms) => new Date(ms + 5 * 3600000).toISOString().slice(0, 10);
const pkTime = (ms) => new Date(ms + 5 * 3600000).toISOString().slice(11, 16);
const dayBefore = (iso) => new Date(Date.parse(iso + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fail = (code, status, message) => ({ code: status, body: JSON.stringify({ code, message }) });
const TAB_OF = { GUL: 'Gulshan KHI', NN: 'North Nazimabad', DHA: 'DHA KHI', LHR: 'Gulberg Lhr', ISB: 'Islamabad' };

export function createServer({ now, secret = 'sync-secret', clinicians = DEFAULT_CLINICIANS, branches = ['GUL', 'NN', 'DHA', 'LHR', 'ISB'], photoMonths = [], sequenceStart = 50013 } = {}) {
  const S = {
    patients: [], visits: [], checkups: [], audit: [], calls: [], log: [], removedLog: [], lookups: 0, removedToday: {}, nextMr: sequenceStart, nextId: 1, seq: 0,
    secret, clinicians, branches, photoMonths, admin: 'admin',
    // faults a test can switch on
    faults: { timeoutOverRows: 0, busy: false, lostAnswers: 0, down: 0, status500: 0, rateLimit: 0 },
    createdByBranch: {}, checkupsByBranch: {},
  };

  const clinicianById = (id) => clinicians.find((c) => c.id === id);
  function matchClinician(raw) {
    const key = doctorKey(raw);
    if (!key) return null;
    const list = clinicians.slice().sort((a, b) => a.display_name.localeCompare(b.display_name));
    for (const c of list) if ([c.display_name, ...c.aliases].map(doctorKey).includes(key)) return c;
    if (key.split(' ').length === 1) {
      const first = list.filter((c) => doctorKey(c.display_name).split(' ')[0] === key);
      if (first.length === 1) return first[0];
    }
    return null;
  }
  const patientByMr = (mr) => S.patients.find((p) => p.mr === String(mr));

  // ---------- canon (section 2.3) ----------
  function visitKey(v) { return v.sheet_key || 'W-' + v.id; }
  function dues(p) { return p.dues || 0; }
  function canon(v) {
    const p = patientByMr(v.mr);
    const c = v.cells || {};
    const lossy = (f, val, formatted) => (c[f] && String(c[f].v ?? '') === String(val ?? '') ? c[f].t : formatted);
    const ids = v.doctors.slice().sort();
    let doctors;
    if (c.doctors && c.doctors.t != null && JSON.stringify((c.doctors.ids || []).slice().sort()) === JSON.stringify(ids)) doctors = c.doctors.t;
    else {
      const docs = v.doctors.map(clinicianById).filter((x) => x && x.is_doctor).sort((a, b) => a.display_name.localeCompare(b.display_name)).map((x) => x.display_name);
      const asst = v.doctors.map(clinicianById).filter((x) => x && !x.is_doctor).sort((a, b) => a.display_name.localeCompare(b.display_name)).map((x) => x.display_name);
      doctors = [...docs, ...asst, ...((c.doctors && c.doctors.unmatched) || [])].join(', ');
    }
    return {
      key: visitKey(v), id: v.id, kind: 'visit', mr: p.mr, name: p.name, phone: p.phone && p.phone !== '0000000' ? p.phone : '',
      month: lossy('month', v.braces_month, v.braces_month ? `${v.braces_month}${v.photo_required ? ' Photo' : ''}` : ''),
      treatment: v.treatment_label || '', token: lossy('token', v.token, v.token ? String(v.token) : ''),
      status: STATUS_LABEL[v.status], group: lossy('group', v.group, v.group ? `Group ${v.group}` : ''),
      doctors, details: v.details || '', pp: dues(p) > 0 ? Math.round(dues(p)).toLocaleString('en-US') : '',
      removed: false, updated_at: new Date(v.updated_at).toISOString(),
    };
  }
  const checkupKey = (c) => c.sheet_key || 'W-' + c.id;
  function canonCheckup(c) {
    const p = c.patient_mr ? patientByMr(c.patient_mr) : null;
    return {
      key: checkupKey(c), id: c.id, kind: 'checkup', mr: p ? p.mr : '', name: c.name, phone: c.phone || '', month: '', treatment: c.checkup_for || '',
      token: c.token || '', status: c.day_status ? STATUS_LABEL[c.day_status] : '', group: '', doctors: c.doctors || '', details: c.details || '', pp: '',
      removed: false, updated_at: new Date(c.updated_at).toISOString(),
    };
  }
  function dayList(branch, date) {
    const visits = S.visits.filter((v) => v.branch === branch && v.date === date)
      .sort((a, b) => (a.token == null) - (b.token == null) || (a.token ?? 0) - (b.token ?? 0) || a.seq - b.seq).map(canon);
    const checks = S.checkups.filter((c) => c.branch === branch && c.date === date).sort((a, b) => a.seq - b.seq).map(canonCheckup);
    return [...visits, ...checks];
  }

  // ---------- the Mr# on a row (section 3.2 as built) ----------
  function checkMr(branch, date, mr, nameIn, phoneIn) {
    const nn = normName(nameIn), given = givenName(nameIn), ph = normPhone(phoneIn);
    const seen = (p) => S.visits.some((v) => v.mr === p.mr && v.branch === branch) || p.first_branch === branch;
    const p = patientByMr(mr);
    if (p) {
      const onPhone = (q) => ph && (normPhone(q.phone) === ph || normPhone(q.phone_alt) === ph);
      const own = onPhone(p) && !S.patients.some((o) => o !== p && given && givenName(o.name) === given && onPhone(o));
      if ((given && givenName(p.name) && nameClose(nameIn, p.name)) || own) return { outcome: 'mr', patient: p, name_differs: !!given && givenName(p.name) !== given };
      return { outcome: given ? 'mr_name' : 'mr_noname', patient: p, seen: seen(p) };
    }
    if (ph && nn) {
      const o = S.patients.find((q) => (normPhone(q.phone) === ph || normPhone(q.phone_alt) === ph) && normName(q.name) === nn);
      if (o) return { outcome: 'mr_other', patient: o, seen: seen(o) };
    }
    if (/^\d{1,15}$/.test(mr) && Number(mr) >= 50000) return { outcome: 'mr_typo' };
    if (!/^[1-9]\d{0,4}$/.test(mr)) return { outcome: 'mr_bad' };
    return { outcome: 'mr_new' };
  }

  // ---------- fixtures a test uses to act as "the website" ----------
  function addPatient({ mr, name, phone = null, phone_alt = null, dues: d = 0, first_branch = null }) {
    const p = { mr: mr ? String(mr) : String(S.nextMr++), name, phone, phone_alt, dues: d, first_branch };
    S.patients.push(p);
    return p;
  }
  function addVisit({ branch, date, mr, status = 'waiting', treatment = '', details = '', token = null, braces_month = null, group = null, doctors = [] }) {
    const id = uuid(S.nextId++);
    const v = { id, seq: ++S.seq, sheet_key: null, branch, date, mr: String(mr), status, treatment_label: treatment || null, details, token, braces_month,
      photo_required: braces_month != null && photoMonths.includes(braces_month), group, doctors: doctors.slice(), cells: null, notes: '', updated_at: now(), override: false, created_by: 'website', attached: false, started: false };
    S.visits.push(v);
    return v;
  }
  function addCheckup({ branch, date, name, phone = '', checkup_for = '', doctors = '', details = '', token = '', day_status = 'waiting', source = 'website', patient_mr = null, follow_up = 'Not Contacted' }) {
    const id = uuid(900000 + S.nextId++);
    const c = { id, seq: ++S.seq, sheet_key: null, branch, date, name, phone, checkup_for, doctors, details, token, day_status, source, patient_mr, follow_up, updated_at: now() };
    S.checkups.push(c);
    return c;
  }
  function editVisit(id, patch) {
    const v = S.visits.find((x) => x.id === id);
    Object.assign(v, patch);
    v.updated_at = now();
    return v;
  }
  function editCheckup(id, patch) {
    const c = S.checkups.find((x) => x.id === id);
    Object.assign(c, patch);
    c.updated_at = now();
    return c;
  }
  const visitById = (id) => S.visits.find((x) => x.id === id);
  const visitByKey = (key) => S.visits.find((v) => visitKey(v) === key);
  const checkupById = (id) => S.checkups.find((x) => x.id === id);
  const checkupByKey = (key) => S.checkups.find((c) => checkupKey(c) === key);
  const visitsOf = (branch, date) => S.visits.filter((v) => v.branch === branch && v.date === date);
  const checkupsOf = (branch, date) => S.checkups.filter((c) => c.branch === branch && c.date === date);
  function removeVisit(id) { S.visits = S.visits.filter((v) => v.id !== id); }
  function removeCheckup(id) { S.checkups = S.checkups.filter((c) => c.id !== id); }

  // ---------- the RPC ----------
  function dateOk(date) {
    const t = now();
    const today = pkDate(t);
    return date === today || (date === dayBefore(today) && pkTime(t) < '03:00');
  }
  function tooLong(set) {
    const lim = { mr: 20, name: 120, legacy_name: 120, phone: 40, treatment: 120, details: 500, pp: 120, healthwire: 120, reminder: 120 };
    for (const [f, n] of Object.entries(lim)) if (typeof set[f] === 'string' && set[f].length > n) return `Too long: ${f} (max ${n} letters).`;
    for (const f of ['month', 'token', 'status', 'group', 'doctors']) if (set[f] && set[f].t && set[f].t.length > 300) return `Too long: ${f} (max 300 letters).`;
    if (set.doctors && set.doctors.v) {
      if (set.doctors.v.length > 10) return 'Too long: doctors (max 10 names).';
      for (const d of set.doctors.v) if (d.length > 60) return 'Too long: a doctor name (max 60 letters).';
    }
    return null;
  }

  function createVisit(tab, p, set, res, key, date) {
    const st = set.status && set.status.v ? set.status.v : 'waiting';
    const v = addVisit({ branch: tab.branch, date, mr: p.mr, status: 'waiting' });
    v.sheet_key = key; v.created_by = 'sync'; v.cells = { tab: TAB_OF[tab.branch] }; v.status = st; v.updated_at = now();
    // token numbering for waiting / in-treatment visits, like the visit trigger
    return v;
  }

  function applyFields(v, tab, set, base, editedAt, res, force, adopted) {
    const nowMs = now();
    const c = canon(v);
    let edited = editedAt || 0;
    if (edited > nowMs + 300000) edited = nowMs;
    const sheetNewer = !adopted && edited > v.updated_at;          // an adopted visit keeps the website's state
    v.cells = v.cells || { tab: TAB_OF[tab.branch] };
    const kept = [], changed = [];
    const warns = [];
    const textOf = { month: set.month && set.month.t, treatment: set.treatment, token: set.token && set.token.t, status: set.status && set.status.t, group: set.group && set.group.t, details: set.details };
    const take = {};
    for (const f of ['month', 'treatment', 'token', 'status', 'group', 'details']) {
      if (set[f] === undefined) continue;
      const txt = textOf[f] ?? '';
      let apply;
      if (base) apply = c[f] === (base[f] ?? '') || sheetNewer;
      else apply = c[f] === '' || c[f] === txt || sheetNewer;
      if (c[f] === txt || force) apply = true;
      if (f === 'status' && set.status.v == null) { warns.push(`Status "${txt}" not understood. Use Waiting, Treatment, Completed, Scheduled, Cancelled or No show.`); continue; }
      if (apply) take[f] = true; else kept.push(f);
    }
    const before = JSON.stringify([v.status, v.treatment_label, v.token, v.braces_month, v.group, v.details, v.cells, v.doctors]);
    if (take.month) {
      v.cells.month = { t: set.month.t, v: set.month.v };
      if (set.month.v >= 1 && set.month.v <= 60) { v.braces_month = set.month.v; v.photo_required = photoMonths.includes(set.month.v); }
      else if (set.month.v == null && !set.month.t) { v.braces_month = null; v.photo_required = false; }
    }
    if (take.treatment) v.treatment_label = (set.treatment || '').trim() || null;
    if (take.token) {
      v.cells.token = { t: set.token.t, v: set.token.v };
      if (set.token.v >= 1 && set.token.v <= 999) {
        const other = S.visits.find((x) => x !== v && x.branch === v.branch && x.date === v.date && x.token === set.token.v);
        if (other) warns.push(`Token ${set.token.v} is already used by ${patientByMr(other.mr).name}. Token not changed on the website.`);
        else v.token = set.token.v;
      } else if (!set.token.t) v.token = null;
    }
    if (take.token && !set.token.t && v.token == null && (v.status === 'waiting' || v.status === 'in_treatment')) {
      const used = S.visits.filter((x) => x.branch === v.branch && x.date === v.date && x.token != null).map((x) => x.token);
      v.token = (used.length ? Math.max(...used) : 0) + 1;     // the visit trigger numbers a visit again
    }
    if (take.status) {
      const st = set.status.v;
      if (st === 'completed' && v.braces_month && S.photoMonths.includes(v.braces_month) && !v.override) {
        v.override = OVERRIDE;
        warns.push("Completed from the sheet. The website's photo step was skipped (owner rule).");
      }
      v.status = st;
    }
    if (take.group) { v.cells.group = { t: set.group.t, v: set.group.v }; v.group = set.group.v >= 1 && set.group.v <= 3 ? set.group.v : null; }
    if (take.details) v.details = (set.details || '').trim();
    if (set.pp !== undefined || set.healthwire !== undefined || set.reminder !== undefined) {
      v.texts = v.texts || {};
      for (const f of ['pp', 'healthwire', 'reminder']) if (set[f] !== undefined) v.texts[f] = set[f];      // staff-only text, apart from the visit row
    }
    // doctors (3.6)
    if (set.doctors) {
      const el = (name) => { const m = matchClinician(name); return m ? m.id : 'raw:' + doctorKey(name); };
      const sheetSet = (set.doctors.v || []).map(el);
      const baseSet = base && base.doctors ? base.doctors.map(el) : null;
      const webSet = [...v.doctors, ...(((v.cells.doctors || {}).unmatched) || []).map((n) => 'raw:' + doctorKey(n))];
      let result;
      if (baseSet) result = [...new Set([...webSet, ...sheetSet.filter((x) => !baseSet.includes(x))])].filter((x) => !(baseSet.includes(x) && !sheetSet.includes(x)));
      else result = [...new Set([...webSet, ...sheetSet])];
      const ids = result.filter((x) => !x.startsWith('raw:'));
      const unmatched = [];
      for (const raw of set.doctors.v || []) { const m = matchClinician(raw); if (!m && result.includes('raw:' + doctorKey(raw))) unmatched.push(raw); }
      v.doctors = ids;
      const same = result.length === sheetSet.length && result.every((x) => sheetSet.includes(x));
      v.cells.doctors = { t: same ? set.doctors.t : null, ids: ids.slice().sort(), unmatched };
      if (unmatched.length) warns.push(`Not on the website's doctor list: ${unmatched.join(', ')}. Add them in Clinic setup or fix the spelling.`);
    }
    // linked-row identity fields
    if (set.phone) { const p = patientByMr(v.mr); if (!p.phone && normPhone(set.phone)) p.phone = normPhone(set.phone); }
    if (set.name && base) {
      const p = patientByMr(v.mr);
      if (givenName(p.name) !== givenName(set.name)) warns.push(`Mr# ${p.mr} is "${p.name}" on the website. Check the Mr#.`);
    }
    if (set.mr !== undefined && base) {
      const p = patientByMr(v.mr);
      if (set.mr === '' || set.mr === 'NEW') kept.push('mr');
      else if (set.mr !== p.mr) res.error = "The Mr# in this row is not this visit's patient. Clear the row and type the patient again.";
    }
    const after = JSON.stringify([v.status, v.treatment_label, v.token, v.braces_month, v.group, v.details, v.cells, v.doctors]);
    if (before !== after) { v.updated_at = nowMs; changed.push('x'); }
    res.kept_website = kept.filter((f) => f !== 'mr').concat(kept.includes('mr') ? ['mr'] : []);
    return { changed: changed.length > 0, warns };
  }

  // a checkup row: the same per-field merge, plain text columns
  function applyCheckup(c, tab, set, base, editedAt, res) {
    const nowMs = now();
    const cn = canonCheckup(c);
    let edited = editedAt || 0;
    if (edited > nowMs + 300000) edited = nowMs;
    const newer = edited > c.updated_at;
    const kept = [], warns = [];
    const before = JSON.stringify([c.name, c.phone, c.checkup_for, c.token, c.day_status, c.doctors, c.details]);
    const sheetText = (f) => (['token', 'status', 'doctors'].includes(f) ? (set[f].t ?? '') : f === 'phone' ? (normPhone(set.phone) || '') : String(set[f] ?? '').trim());
    for (const f of ['name', 'phone', 'treatment', 'token', 'status', 'doctors', 'details']) {
      if (set[f] === undefined) continue;
      let s = sheetText(f), w = cn[f], b = base ? (f === 'doctors' ? (base.doctors || []).join(',') : (base[f] ?? '')) : null;
      if (f === 'status') { s = s.toLowerCase(); w = w.toLowerCase(); b = b === null ? null : b.toLowerCase(); }
      if (f === 'doctors') { s = peopleKey(s); w = peopleKey(w); b = b === null ? null : peopleKey(b); }
      const apply = w === s ? null : (base ? (w === b || newer) : (w === '' || newer));
      if (w === s) continue;
      if (!apply) { kept.push(f); continue; }
      if (f === 'name') { if (String(set.name).trim().length >= 2) c.name = String(set.name).trim(); else { warns.push('Patient name is too short. Name not changed on the website.'); } }
      else if (f === 'phone') c.phone = normPhone(set.phone) || '';
      else if (f === 'treatment') c.checkup_for = String(set.treatment).trim();
      else if (f === 'token') c.token = set.token.t.trim().slice(0, 40);
      else if (f === 'doctors') c.doctors = set.doctors.t.trim().slice(0, 300);
      else if (f === 'details') c.details = String(set.details).trim();
      else if (f === 'status') {
        const sv = set.status.v;
        if (!sv) warns.push(`Status "${set.status.t}" not understood. Use Waiting, Treatment, Completed, Cancelled or No show.`);
        else if (sv === 'scheduled') { c.day_status = 'waiting'; warns.push('A checkup cannot be Scheduled. Saved as Waiting.'); kept.push('status'); }
        else c.day_status = sv;
      }
    }
    if (set.mr !== undefined && set.mr !== '' && set.mr !== 'NEW' && !(c.patient_mr && c.patient_mr === set.mr)) res.error = "The Mr# in this row is not this checkup's. Clear the row and type the patient again.";
    const after = JSON.stringify([c.name, c.phone, c.checkup_for, c.token, c.day_status, c.doctors, c.details]);
    if (before !== after) c.updated_at = nowMs;
    res.kept_website = kept;
    return { changed: before !== after, warns };
  }

  function finish(res, warns) {
    if (res.error) { res.outcome = 'error'; res.level = 'error'; res.message = res.error; delete res.error; return res; }
    if (warns.length) { res.level = 'warn'; res.message = warns.join(' '); }
    return res;
  }

  function lookupRefused(res, tab, key, mr, text, textUnseen, seen, only) {
    const k = key + '|' + res.outcome;
    S.lookupKeys = S.lookupKeys || new Set();
    if (!S.lookupKeys.has(k)) {
      if (S.lookups >= 200) { res.message = 'Too many rows the website could not place today. Fix them on the website.'; return res; }
      S.lookupKeys.add(k); S.lookups++;
    }
    res.message = only || (seen ? text : textUnseen);
    return res;
  }

  function processRow(tab, row, date, present) {
    const res = { key: row.key, outcome: 'unchanged', visit_id: null, level: 'ok', message: null, kept_website: [], duplicate_of: null, patient_created: null };
    if (!KEY_RE.test(row.key || '')) { res.outcome = 'error'; res.level = 'error'; res.message = 'Bad row key.'; return res; }
    const long = tooLong(row.set || {});
    if (long) { res.outcome = 'error'; res.level = 'error'; res.message = long; return res; }
    const set = row.set || {};
    let v = row.key.startsWith('W-') ? visitById(row.key.slice(2)) : S.visits.find((x) => x.sheet_key === row.key);
    if (!v) {
      const ck = row.key.startsWith('W-') ? checkupById(row.key.slice(2)) : S.checkups.find((x) => x.sheet_key === row.key);
      if (ck) {
        if (row.key.startsWith('W-') && ck.sheet_key && ck.sheet_key !== row.key) { res.outcome = 'superseded'; res.level = 'warn'; res.message = 'This row was replaced by another row for the same visit.'; return res; }
        if (ck.branch !== tab.branch || ck.date !== date) { res.outcome = 'other_list'; res.level = 'warn'; res.message = 'This row belongs to another branch or day.'; return res; }
        if (row.key.startsWith('W-') && !ck.sheet_key) ck.sheet_key = row.key;
        const { changed, warns } = applyCheckup(ck, tab, set, row.base || null, row.edited_at, res);
        res.visit_id = ck.id; res.outcome = changed ? 'updated' : 'unchanged';
        return finish(res, warns);
      }
    }
    if (v && row.key.startsWith('W-') && v.sheet_key && v.sheet_key !== row.key) { res.outcome = 'superseded'; res.level = 'warn'; res.message = 'This row was replaced by another row for the same visit.'; return res; }
    if (v && (v.branch !== tab.branch || v.date !== date)) { res.outcome = 'other_list'; res.level = 'warn'; res.message = 'This row belongs to another branch or day.'; return res; }
    if (v) {
      if (row.key.startsWith('W-') && !v.sheet_key) v.sheet_key = row.key;
      const { changed, warns } = applyFields(v, tab, set, row.base || null, row.edited_at, res);
      res.visit_id = v.id; res.outcome = changed ? 'updated' : 'unchanged';
      return finish(res, warns);
    }
    if (!row.new || row.key.startsWith('W-')) { res.outcome = 'gone'; res.level = 'error'; res.message = 'This visit was deleted on the website. Delete this row.'; return res; }
    // a new row: no Mr# is a checkup patient
    const name = set.name || '';
    const mrIn = String(set.mr ?? '').trim();
    if (mrIn === '' || mrIn.toUpperCase() === 'NEW') {
      // owner, 9 Oct 2026 (13:20): only a Treatment that says checkup makes a row without an Mr# a checkup; any other is an existing patient whose Mr# was forgotten
      if (!isCheckupText(set.treatment)) {
        res.outcome = 'needs_patient'; res.level = 'error';
        res.message = 'Needs attention: add the Mr#. A row with no Mr# is a checkup only when its Treatment says checkup. Look the Mr# up in Healthwire.';
        return res;
      }
      if (String(name).trim().length < 2) { res.outcome = 'needs_patient'; res.level = 'error'; res.message = 'Patient name is too short.'; return res; }
      // the same person already on the website's list (same name and phone, that checkup's row not in the sheet): adopted, not made twice
      const ph = normPhone(set.phone);
      const twin = ph ? S.checkups.find((c) => c.branch === tab.branch && c.date === date && c.source !== 'archive' && c.phone === ph && normName(c.name) === normName(name)
        && checkupKey(c) !== row.key && !present.includes(checkupKey(c))) : null;
      if (twin) {
        twin.sheet_key = row.key;
        const { warns } = applyCheckup(twin, tab, set, null, 0, res);      // an adopted checkup keeps the website's state
        res.outcome = 'linked'; res.visit_id = twin.id;
        return finish(res, warns);
      }
      if ((S.checkupsByBranch[tab.branch] || 0) >= 150) { res.outcome = 'needs_patient'; res.level = 'error'; res.message = 'Too many new checkups from the sheet today. Add this one on the website.'; return res; }
      const st = set.status && set.status.v ? set.status.v : 'waiting';
      const ck = addCheckup({ branch: tab.branch, date, name: String(name).trim(), phone: normPhone(set.phone) || '', checkup_for: String(set.treatment ?? '').trim(),
        doctors: set.doctors ? set.doctors.t : '', details: String(set.details ?? '').trim(), token: set.token ? String(set.token.t).slice(0, 40) : '', day_status: st === 'scheduled' ? 'waiting' : st, source: 'google_sheet' });
      ck.sheet_key = row.key;
      S.checkupsByBranch[tab.branch] = (S.checkupsByBranch[tab.branch] || 0) + 1;
      res.outcome = 'created'; res.visit_id = ck.id; res.level = st === 'scheduled' ? 'warn' : 'ok';
      if (st === 'scheduled') res.kept_website = ['status'];
      res.message = (st === 'scheduled' ? 'A checkup cannot be Scheduled. Saved as Waiting. ' : '') + 'Checkup patient: no Mr#, no patient file.';
      return res;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(mrIn) || !/\d/.test(mrIn)) { res.outcome = 'needs_patient'; res.level = 'error'; res.message = `"${mrIn.slice(0, 30)}" is not a Mr#. Type the number only, or leave it empty for a checkup patient.`; return res; }
    const fp = checkMr(tab.branch, date, mrIn, name, set.phone);
    let p = null, warn = null;
    if (fp.outcome === 'mr') {
      p = fp.patient;
      if (fp.name_differs) warn = `Mr# ${p.mr} is "${p.name}" on the website. Check the Mr#.`;
    } else if (fp.outcome === 'mr_new') {
      if (normName(name).length < 2) { res.outcome = 'needs_patient'; res.level = 'error'; res.message = 'Patient name is too short.'; return res; }
      if ((S.createdByBranch[tab.branch] || 0) >= 60) { res.outcome = 'needs_patient'; res.level = 'error'; res.message = 'Too many new patients from the sheet today. Add this one on the website.'; return res; }
      p = addPatient({ mr: mrIn, name, phone: normPhone(set.phone), first_branch: tab.branch });
      S.createdByBranch[tab.branch] = (S.createdByBranch[tab.branch] || 0) + 1;
      res.patient_created = p.mr;
      warn = `New patient added with Healthwire Mr# ${p.mr}. Check the name and phone on the website.`;
    } else {
      res.outcome = 'needs_patient'; res.level = 'error';
      if (fp.outcome === 'mr_name') lookupRefused(res, tab, row.key, mrIn, `Mr# ${mrIn} is "${fp.patient.name}" on the website, not "${String(name).slice(0, 60)}". Check the Mr#.`, `Mr# ${mrIn} belongs to another patient. Check the Mr#.`, fp.seen);
      else if (fp.outcome === 'mr_other') lookupRefused(res, tab, row.key, mrIn, `Mr# ${mrIn} is not on the website, but ${fp.patient.name} with this phone is Mr# ${fp.patient.mr}. Use ${fp.patient.mr}.`,
        `Mr# ${mrIn} is not on the website, and this name and phone are filed under another Mr#. Check the number.`, fp.seen);
      else if (fp.outcome === 'mr_noname') lookupRefused(res, tab, row.key, mrIn, '', '', true, `Mr# ${mrIn}: the name in this row cannot be read. Type the patient's name in English letters, or the phone number that is theirs.`);
      else lookupRefused(res, tab, row.key, mrIn, `Mr# ${mrIn} is not on the website. Check the number.`, `Mr# ${mrIn} is not on the website. Check the number.`, true);
      return res;
    }
    const e = S.visits.filter((x) => x.mr === p.mr && x.branch === tab.branch && x.date === date)
      .sort((a, b) => (b.status !== 'cancelled') - (a.status !== 'cancelled') || a.seq - b.seq)[0];
    if (e) {
      const ek = visitKey(e);
      if (present.includes(ek) && ek !== row.key) {
        res.outcome = 'duplicate'; res.level = 'error'; res.duplicate_of = ek;
        res.message = `Already on this list in another row (Mr# ${p.mr}). Put both treatments in one row and delete this one.`;
        return res;
      }
      e.sheet_key = row.key;
      const { warns } = applyFields(e, tab, set, null, row.edited_at, res, false, true);
      res.outcome = 'linked'; res.visit_id = e.id;
      return finish(res, warn ? [warn, ...warns] : warns);
    }
    const v2 = createVisit(tab, p, set, res, row.key, date);
    v2.status = 'waiting';
    const { warns } = applyFields(v2, tab, set, null, row.edited_at, res, true);
    if (v2.token == null && v2.status !== 'scheduled') {
      const used = S.visits.filter((x) => x.branch === v2.branch && x.date === v2.date && x.token != null).map((x) => x.token);
      v2.token = (used.length ? Math.max(...used) : 0) + 1;
    }
    res.outcome = 'created'; res.visit_id = v2.id;
    return finish(res, warn ? [warn, ...warns] : warns);
  }

  // Rows that left the sheet (owner rule: the visit / checkup is removed, unless something real hangs on it)
  function removals(tab, date, present) {
    const out = [];
    const vcands = S.visits.filter((v) => v.branch === tab.branch && v.date === date && v.sheet_key && !present.includes(v.sheet_key) && v.status !== 'cancelled');
    const ccands = S.checkups.filter((c) => c.branch === tab.branch && c.date === date && c.sheet_key && !present.includes(c.sheet_key) && c.day_status !== 'cancelled');
    const n = vcands.length + ccands.length;
    if (!n) return out;
    const total = S.visits.filter((v) => v.branch === tab.branch && v.date === date && v.sheet_key && v.status !== 'cancelled').length
      + S.checkups.filter((c) => c.branch === tab.branch && c.date === date && c.sheet_key && c.day_status !== 'cancelled').length;
    const done = S.removedToday[tab.branch] || 0;
    const hold = n > 3 || (n >= 2 && (present.length === 0 || n * 4 >= total)) || done + n > 15;
    const why = done + n > 15 && n <= 3
      ? 'Needs attention: too many rows were deleted from this tab today, so nothing was removed from the website. Delete wrong entries on the website.'
      : `Needs attention: ${n} rows disappeared at once, so nothing was removed from the website. Delete wrong entries on the website, or delete fewer rows at a time.`;
    for (const v of vcands) {
      if (hold) { out.push({ key: v.sheet_key, action: 'restore', message: why }); continue; }
      const plain = (v.status === 'scheduled' || v.status === 'waiting') && !v.attached && !v.started;
      if (plain) {
        S.removedLog.push({ kind: 'visit', branch: tab.branch, date, key: v.sheet_key, snapshot: JSON.parse(JSON.stringify(v)) });
        S.visits = S.visits.filter((x) => x !== v);
        S.removedToday[tab.branch] = (S.removedToday[tab.branch] || 0) + 1;
        out.push({ key: v.sheet_key, action: 'deleted', name: patientByMr(v.mr).name, message: 'Row deleted in the sheet: the visit is removed from the website too. Put the row back to undo.' });
      } else if (v.status === 'scheduled' || v.status === 'waiting') {
        v.status = 'cancelled'; v.updated_at = now();
        S.removedToday[tab.branch] = (S.removedToday[tab.branch] || 0) + 1;
        out.push({ key: v.sheet_key, action: 'kept', name: patientByMr(v.mr).name, message: `Kept on the website and marked Cancelled: ${v.attached ? 'it has an attached record (invoices)' : 'treatment was recorded on it'}.` });
      } else out.push({ key: v.sheet_key, action: 'restore', message: `Not removed: this visit is ${STATUS_LABEL[v.status]} on the website. To take a patient off, set Status to Cancelled.` });
    }
    for (const c of ccands) {
      if (hold) { out.push({ key: c.sheet_key, action: 'restore', message: why }); continue; }
      if (!c.patient_mr && c.follow_up === 'Not Contacted') {
        S.removedLog.push({ kind: 'checkup', branch: tab.branch, date, key: c.sheet_key, snapshot: JSON.parse(JSON.stringify(c)) });
        S.checkups = S.checkups.filter((x) => x !== c);
        S.removedToday[tab.branch] = (S.removedToday[tab.branch] || 0) + 1;
        out.push({ key: c.sheet_key, action: 'deleted', name: c.name, message: 'Row deleted in the sheet: the checkup is removed from the website too. Put the row back to undo.' });
      } else out.push({ key: c.sheet_key, action: 'restore', message: 'Not removed: this checkup is already a patient, or has follow-up notes on the website.' });
    }
    return out;
  }

  // a deleted row that came back in the sheet: the visit / checkup it removed is put back under its key
  function restoreRemoved(tab, date, present) {
    for (const r of S.removedLog) {
      if (r.restored || r.branch !== tab.branch || r.date !== date || !present.includes(r.key)) continue;
      r.restored = true;
      if (r.kind === 'visit') {
        if (S.visits.some((v) => v.id === r.snapshot.id)) continue;
        S.visits.push({ ...r.snapshot, updated_at: now() });
      } else {
        if (S.checkups.some((c) => c.id === r.snapshot.id)) continue;
        S.checkups.push({ ...r.snapshot, updated_at: now() });
      }
    }
  }

  function aajSync(secretIn, payload) {
    if (secretIn == null || secretIn !== S.secret) return fail('42501', 403, 'Not allowed');
    if (S.faults.busy) return fail('55P03', 503, 'BUSY');
    if (S.faults.rateLimit > 0) { S.faults.rateLimit--; return fail('54000', 400, 'RATE_LIMIT: too many calls in a minute'); }
    if (!payload || typeof payload !== 'object' || !payload.date || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date) || !Array.isArray(payload.tabs)) return fail('22023', 400, 'BAD_PAYLOAD: date or tabs missing');
    if (JSON.stringify(payload).length > 300000) return fail('22023', 400, 'PAYLOAD_TOO_LARGE: more than 300 KB');
    if (!dateOk(payload.date)) return fail('22023', 400, 'DATE_NOT_ALLOWED');
    const tabs = payload.tabs;
    const seenBranch = new Set();
    let rowCount = 0;
    for (const t of tabs) {
      if (seenBranch.has(t.branch)) return fail('22023', 400, 'PAYLOAD_TOO_LARGE: a branch twice');
      seenBranch.add(t.branch);
      if (!S.branches.includes(t.branch) || !TAB_OF[t.branch]) return fail('22023', 400, `UNKNOWN_BRANCH: ${t.branch}`);
      if ((t.present || []).length > 400) return fail('22023', 400, 'PAYLOAD_TOO_LARGE: more than 400 present keys');
      rowCount += (t.rows || []).length;
    }
    if (tabs.length > 5 || rowCount > 25) return fail('22023', 400, 'PAYLOAD_TOO_LARGE: more than 25 rows');
    if (S.faults.timeoutOverRows && rowCount > S.faults.timeoutOverRows) return fail('57014', 500, 'canceling statement due to statement timeout');
    const out = { ok: true, date: payload.date, server_time: new Date(now()).toISOString(), tabs: [] };
    for (const t of tabs) {
      const hasPresent = Array.isArray(t.present);
      const present = hasPresent ? t.present : [];
      for (const k of present) {
        if (k.startsWith('W-')) {
          const v = visitById(k.slice(2));
          if (v && v.branch === t.branch && v.date === payload.date && !v.sheet_key) v.sheet_key = k;
          const c = checkupById(k.slice(2));
          if (c && c.branch === t.branch && c.date === payload.date && !c.sheet_key) c.sheet_key = k;
        }
      }
      if (hasPresent && present.length) restoreRemoved(t, payload.date, present);
      const results = [];
      for (const row of t.rows || []) results.push(processRow(t, row, payload.date, present));
      const removed = payload.check_removed && payload.date === pkDate(now()) && hasPresent ? removals(t, payload.date, present) : [];
      const list = dayList(t.branch, payload.date);
      const hash = crypto.createHash('md5').update(JSON.stringify(list)).digest('hex');
      const unchanged = !(t.rows || []).length && t.hash === hash && !removed.length;
      const tabOut = { branch: t.branch, hash, unchanged, results, removed };
      if (!unchanged) tabOut.visits = list;
      out.tabs.push(tabOut);
    }
    return { code: 200, body: JSON.stringify(out) };
  }

  // The function the mock's UrlFetchApp calls.
  function handler(req) {
    const body = JSON.parse(req.body);
    const entry = { at: now(), url: req.url, secret: body.p_secret, payload: body.p_payload, response: null, lost: false };
    S.calls.push(entry);
    if (S.faults.down > 0) { S.faults.down--; entry.response = 'down'; throw new Error('Exception: Address unavailable: ' + req.url); }
    if (S.faults.status500 > 0) { S.faults.status500--; entry.response = '500'; return { code: 500, body: '<html>Internal server error</html>' }; }
    const r = aajSync(body.p_secret, body.p_payload);
    entry.response = r;
    if (S.faults.lostAnswers > 0) { S.faults.lostAnswers--; entry.lost = true; throw new Error('Exception: Timeout: ' + req.url); }
    return r;
  }

  return { state: S, handler, aajSync, addPatient, addVisit, addCheckup, editVisit, editCheckup, removeVisit, removeCheckup, visitById, visitByKey, checkupById, checkupByKey, visitsOf, checkupsOf,
    canon, canonCheckup, dayList, checkMr, matchClinician, patientByMr, get calls() { return S.calls; }, faults: S.faults };
}
