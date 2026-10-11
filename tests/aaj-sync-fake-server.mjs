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
const BUDGET_MSG = 'Too many rows the website could not place today. Add this patient on the website.';

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
const nameWords = (t) => normName(t).split(' ').filter((w) => w && !STOP.has(w));
// private.aaj_name_sound: the first letter (o / u and e / i count as one), then the consonants without a e i o u y h, q as k, z as s, v as w, doubles once
const nameSound = (t) => (t ? ({ o: 'u', e: 'i' }[t[0]] || t[0]) + t.slice(1).replace(/[aeiouyh]/g, '').replace(/[qzv]/g, (c) => ({ q: 'k', z: 's', v: 'w' }[c])).replace(/(.)\1+/g, '$1') : '');
// private.aaj_name_close: a typed "name" of more than four words fits nobody; the patient's first name counts as the other word of a two-word name only;
// a surname alone ("Qureshi" for "Zubaida Qureshi") fits nobody; the whole name with one word more ("Rana Asif Ali" for "Asif Ali") fits; an everyday
// spelling of the first name ("Umar" / "Umer", "Aisha" / "Ayesha") with the same rest of the name, or alone, fits (sheet-behaviour RS5-N1)
const nameClose = (a, b) => {
  const ga = givenName(a), gb = givenName(b), wa = nameWords(a), wb = nameWords(b);
  if (!ga || !gb) return false;
  if (wa.length > 4) return false;
  if (ga === gb) return true;
  if (wa.length <= 2 && wa.includes(gb)) return true;
  if (wb.length >= 2 && wa.length <= wb.length + 1 && wb.every((w) => wa.includes(w))) return true;
  if (wa.length >= 1 && wa[0] === ga && wb.length >= 1 && wb[0] === gb && (wa.length === 1 || (wa.length === wb.length && wa.slice(1).join(' ') === wb.slice(1).join(' ')))
      && nameSound(ga) === nameSound(gb) && Math.abs(ga.length - gb.length) <= 1 && lev(ga, gb) <= 2) return true;
  const m = Math.min(ga.length, gb.length);
  return lev(ga, gb) <= (m >= 6 ? 2 : m === 5 ? 1 : 0);
};
// private.aaj_adopt_status: a new row adopting a visit / checkup moves its status only forward, brings a Cancelled / No show one back, and only
// when the row was typed after the website's last change. newer null: the row has no edit time (Set up stamped it): the status still moves
// forward (a sheet Completed completes a Waiting visit, SB7-2), but nothing is cancelled or brought back
const RANK = ['scheduled', 'waiting', 'in_treatment', 'completed'];
const adoptStatus = (web, sheet, newer) => {
  if (web === sheet) return 'same';
  if (newer === false) return 'keep';
  if (newer && sheet == null) return 'apply';
  if (newer && (web === 'cancelled' || web === 'no_show')) return 'apply';
  if (newer && (sheet === 'cancelled' || sheet === 'no_show')) return web == null || web === 'scheduled' || web === 'waiting' ? 'apply' : 'keep';
  if (sheet == null || sheet === 'cancelled' || sheet === 'no_show' || web === 'cancelled' || web === 'no_show') return 'keep';
  return RANK.indexOf(sheet) + 1 > RANK.indexOf(web) + 1 ? 'apply' : 'keep';
};
const normPhone = (t) => {
  let d = String(t ?? '').replace(/\D/g, '');
  if (d.length === 10 && d[0] === '3') d = '0' + d;
  if (d.length === 12 && d.startsWith('92')) d = '0' + d.slice(2);
  return d.length >= 7 ? d : null;
};
// private.aaj_names_conflict: "Ayesha Rajpoot" / "Ayesha Khan": two names of two or more words where neither holds all the other's words
const namesConflict = (a, b) => {
  const wa = nameWords(a), wb = nameWords(b);
  return wa.length >= 2 && wb.length >= 2 && !(wa.every((w) => wb.includes(w)) || wb.every((w) => wa.includes(w)));
};
// private.aaj_name_spelling: one word without the everyday ways of writing it in English letters (Ayesha / Aisha, Noor / Nur, Umer / Umar)
const nameSpelling = (t) => {
  let s = String(t ?? '').toLowerCase().replace(/[^a-z]/g, '').replace(/[qv]/g, (c) => ({ q: 'k', v: 'w' }[c]));
  s = s.replace(/([aeiou])ye/g, '$1i').replace(/(.)y(?![aeiou])/g, '$1i').replace(/([^aeiou])y(?=[aeiou])/g, '$1i');
  s = s.replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/ou/g, 'u').replace(/^e/, 'i').replace(/[oe]/g, (c) => ({ o: 'u', e: 'a' }[c]));
  return s.replace(/(.)\1+/g, '$1').replace(/([aiu])h$/, '$1');
};
// private.aaj_name_fits (11 Oct 2026): the name fits the patient WITHOUT DOUBT: the same first name (letter for letter or spelt another
// everyday way) and no other surname. Anything else that is only close (another surname, a slip, another first name, a word in front) is refused.
// Muhammad (M, Md, Mohd ...), Syed, Hafiz, Baby ... count as words when both names have two or more: "Muhammad Usman" is not "Usman Tariq" (L2-residual)
const rawWords = (t) => normName(t).split(' ').filter((w) => w && !['mr', 'mrs', 'ms', 'miss', 'dr'].includes(w))
  .map((w) => (['m', 'md', 'mohd', 'mohammad', 'muhammed', 'mohammed'].includes(w) ? 'muhammad' : w === 'sayed' ? 'syed' : w)).map(nameSpelling);
const nameFits = (a, b) => {
  const wa = nameWords(a), wb = nameWords(b);
  if (wa.length && normName(a) === normName(b)) return true;      // the file's own name letter for letter, also with more than four words
  if (!wa.length || !wb.length || wa.length > 4) return false;
  const ka = wa.map(nameSpelling), kb = wb.map(nameSpelling);
  if (!ka[0] || ka[0] !== kb[0]) return false;
  if (!(ka.every((w) => kb.includes(w)) || kb.every((w) => ka.includes(w)))) return false;
  const ra = rawWords(a), rb = rawWords(b);
  return ra.length < 2 || rb.length < 2 || ra.every((w) => rb.includes(w)) || rb.every((w) => ra.includes(w));
};
const sameText = (a, b) => String(a ?? '').trim().replace(/\s+/g, ' ').toLowerCase() === String(b ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const isCheckupText = (t) => /\bch[ea]{1,2}c?k?[- ]?ups?\b/i.test(String(t ?? ''));
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
    patients: [], visits: [], checkups: [], audit: [], calls: [], log: [], removedLog: [], keptLog: [], letGo: [], lookups: 0, released: new Map(), removedToday: {}, nextMr: sequenceStart, nextId: 1, seq: 0,
    secret, clinicians, branches, photoMonths, admin: 'admin',
    // faults a test can switch on
    faults: { timeoutOverRows: 0, busy: false, lostAnswers: 0, down: 0, status500: 0, rateLimit: 0 },
    createdByBranch: {}, checkupsByBranch: {}, hwLimit: false,
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
      removed: S.released.has(v.id), claimed: !!v.sheet_key, updated_at: new Date(v.updated_at).toISOString(),
    };
  }
  const checkupKey = (c) => c.sheet_key || 'W-' + c.id;
  function canonCheckup(c) {
    const p = c.patient_mr ? patientByMr(c.patient_mr) : null;
    return {
      key: checkupKey(c), id: c.id, kind: 'checkup', mr: p ? p.mr : '', name: c.name, phone: c.phone || '', month: '', treatment: c.checkup_for || '',
      token: c.token || '', status: c.day_status ? STATUS_LABEL[c.day_status] : '', group: '', doctors: c.doctors || '', details: c.details || '', pp: '',
      removed: S.released.has(c.id), claimed: !!c.sheet_key, updated_at: new Date(c.updated_at).toISOString(),
    };
  }
  function dayList(branch, date) {
    const visits = S.visits.filter((v) => v.branch === branch && v.date === date)
      .sort((a, b) => (a.token == null) - (b.token == null) || (a.token ?? 0) - (b.token ?? 0) || a.seq - b.seq).map(canon);
    const checks = S.checkups.filter((c) => c.branch === branch && c.date === date).sort((a, b) => a.seq - b.seq).map(canonCheckup);
    return [...visits, ...checks];
  }

  // ---------- the Mr# on a row (section 3.2 as built) ----------
  const hwTop = () => S.patients.reduce((m, p) => (!p.sync_made && /^[1-9]\d{0,4}$/.test(String(p.mr)) && Number(p.mr) < 50000 ? Math.max(m, Number(p.mr)) : m), 0);
  // private.aaj_hw_limit: that number plus 100, plus 10 a day since that patient was registered (at most 180 days)
  const hwLimit = () => {
    const top = hwTop(), tp = patientByMr(String(top));
    const days = tp ? Math.round((Date.parse(pkDate(now())) - Date.parse(pkDate(tp.created))) / 86400000) : 0;
    return top + 100 + 10 * Math.min(180, Math.max(0, days));
  };
  function checkMr(branch, date, mr, nameIn, phoneIn, ignore = null) {
    const nn = normName(nameIn), given = givenName(nameIn), ph = normPhone(phoneIn);
    const seen = (p) => S.visits.some((v) => v.mr === p.mr && v.branch === branch) || p.first_branch === branch;
    const p = patientByMr(mr);
    if (p) {
      const onPhone = (q) => ph && (normPhone(q.phone) === ph || normPhone(q.phone_alt) === ph);
      // the name must fit WITHOUT DOUBT; the patient's own phone only lets an unreadable name that is the file's own, letter for letter, through.
      // A name that fits only with doubt is refused with the same outcome (and answer) as one that does not fit (11 Oct 2026)
      const own = onPhone(p) && !S.patients.some((o) => o !== p && (!given || givenName(o.name) === given) && onPhone(o));
      if (nameFits(nameIn, p.name) || (!given && own && sameText(nameIn, p.name))) return { outcome: 'mr', patient: p };
      return { outcome: given ? 'mr_name' : 'mr_noname', patient: p, seen: seen(p), doubt: (!!given && nameClose(nameIn, p.name)) || own };
    }
    if (ph && nn) {
      const o = S.patients.find((q) => q !== ignore && (normPhone(q.phone) === ph || normPhone(q.phone_alt) === ph) && normName(q.name) === nn);
      if (o) return { outcome: 'mr_other', patient: o, seen: seen(o) };
    }
    // a retired Mr# (renumbered to 50000+ by 20261009000400, or merged away) whose patient the row is: the whole name without another surname,
    // or that patient's phone with their first name (or a name nobody can read): told the Mr# now; any other name ("Ali Raza" for "Ali
    // Khanzada") is a Healthwire number (Healthwire will give 10000-10012 to new people)
    if (/^\d{1,15}$/.test(mr)) {
      const onPhone = (q) => ph && (normPhone(q.phone) === ph || normPhone(q.phone_alt) === ph);
      const r = S.patients.find((q) => (String(q.notes || '').includes(`Mr# was ${mr} until `) || String(q.notes || '').includes(`Merged with Mr# ${mr} (`))
        && ((nameClose(nameIn, q.name) && !namesConflict(nameIn, q.name))
            || (onPhone(q) && (!given || nameClose(nameIn, q.name)) && !S.patients.some((x) => x !== q && (!given || givenName(x.name) === given) && onPhone(x)))));
      if (r) return { outcome: 'mr_moved', patient: r };
    }
    if (/^\d{1,15}$/.test(mr) && Number(mr) >= 50000) return { outcome: 'mr_typo' };
    if (!/^[1-9]\d{0,4}$/.test(mr)) return { outcome: 'mr_bad' };
    // above private.aaj_hw_limit (the highest Healthwire number the website has, files the sync made not counted, plus 100 and 10 a day): not
    // given yet, a typo (S.hwLimit: off unless a test switches it on. The other tests' websites stand for a clinic whose Healthwire patients
    // are imported, so the Healthwire numbers they type are below that limit; the real rule is tested in supabase/tests/25_aaj_sync_test.sql)
    if (S.hwLimit && Number(mr) > hwLimit()) return { outcome: 'mr_ahead' };
    return { outcome: 'mr_new' };
  }

  // ---------- fixtures a test uses to act as "the website" ----------
  function addPatient({ mr, name, phone = null, phone_alt = null, dues: d = 0, first_branch = null, notes = null, created = null }) {
    // created: when the patient was registered (a Healthwire patient keeps Healthwire's date), ms
    const p = { mr: mr ? String(mr) : String(S.nextMr++), name, phone, phone_alt, dues: d, first_branch, notes, created: created === null ? now() : created };
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
  // a visit or checkup moved to another branch or day on the website lets go of its sheet key (private.aaj_release_sheet_claim, RS8-B1)
  function editVisit(id, patch) {
    const v = S.visits.find((x) => x.id === id);
    if ((patch.branch !== undefined && patch.branch !== v.branch) || (patch.date !== undefined && patch.date !== v.date)) v.sheet_key = null;
    Object.assign(v, patch);
    v.updated_at = now();
    return v;
  }
  function editPatient(mr, patch) {
    const p = S.patients.find((x) => x.mr === String(mr));
    Object.assign(p, patch);
    p.edited = true;                                       // changed on the website since it was made (private.aaj_removals keeps such a file)
    return p;
  }
  function editCheckup(id, patch) {
    const c = S.checkups.find((x) => x.id === id);
    if ((patch.branch !== undefined && patch.branch !== c.branch) || (patch.date !== undefined && patch.date !== c.date)) c.sheet_key = null;
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
    // an adopted visit: the newer edit wins, except on a visit already in treatment / completed (sheet-behaviour RS5-A1)
    const sheetNewer = edited > v.updated_at && !(adopted && (v.status === 'in_treatment' || v.status === 'completed'));
    v.cells = v.cells || { tab: TAB_OF[tab.branch] };
    const kept = [], changed = [];
    const warns = [];
    const textOf = { month: set.month && set.month.t, treatment: set.treatment, token: set.token && set.token.t, status: set.status && set.status.t, group: set.group && set.group.t, details: set.details };
    const take = {};
    for (const f of ['month', 'treatment', 'token', 'status', 'group', 'details']) {
      if (set[f] === undefined) continue;
      const txt = textOf[f] ?? '';
      let apply;
      if (adopted && f === 'status' && set.status.v !== v.status) { const d = adoptStatus(v.status, set.status.v || null, editedAt == null ? null : edited > v.updated_at); if (d === 'keep') { kept.push(f); continue; } if (d === 'apply' && set.status.v != null) { take[f] = true; continue; } }
      if (base) apply = c[f] === (base[f] ?? '') || sheetNewer;
      else apply = c[f] === '' || c[f] === txt || (sheetNewer && !(adopted && ['month', 'token', 'group'].includes(f)));      // an adopted visit keeps the website's Month, Token and Group
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
        warns.push({ ok: "Completed from the sheet (owner rule: the website's photo step is not needed)." });      // the owner's normal path: a tick (RS13-M1)
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
    // the patient's empty phone is filled only by the row that made this visit just now (force = a visit created by this row)
    if (set.phone && force && !adopted) { const p = patientByMr(v.mr); if (!p.phone && normPhone(set.phone)) p.phone = normPhone(set.phone); }
    if (set.mr !== undefined && base) {
      const p = patientByMr(v.mr);
      if (set.mr === '' || set.mr === 'NEW') kept.push('mr');
      else if (set.mr !== p.mr) {      // the name fits this visit's patient: the website's Mr# goes back into the cell (private.aaj_sync_row, RW8-1)
        kept.push('mr');
        if (res.slipHeld) warns.push(`Mr# ${p.mr} is put back: this visit has an attached record (${res.slipHeld}) on the website, so the row is not moved to Mr# ${set.mr}. If ${set.mr} is the right Mr#, correct the patient file on the website.`);
        else warns.push(`Mr# ${set.mr} is not this visit's patient, so Mr# ${p.mr} is put back. If this row is another patient, delete it and type that patient in a new row.`);
      }
    }
    const after = JSON.stringify([v.status, v.treatment_label, v.token, v.braces_month, v.group, v.details, v.cells, v.doctors]);
    if (before !== after) { v.updated_at = nowMs; changed.push('x'); }
    res.kept_website = kept.filter((f) => f !== 'mr').concat(kept.includes('mr') ? ['mr'] : []);
    return { changed: changed.length > 0, warns };
  }

  // a checkup row: the same per-field merge, plain text columns
  function applyCheckup(c, tab, set, base, editedAt, res, adopted) {
    const nowMs = now();
    // a Month typed into a checkup row: a braces patient, never a checkup. Nothing is applied and the row is let go ("rekey"); an unregistered
    // checkup is written down as let go (private.aaj_note_let_go): it goes whatever its status once its key has left the sheet (RV9-2)
    if (set.month && String(set.month.t ?? '').trim() !== '') {
      res.kept_website = [];
      if (c.patient_mr) res.rekey = `A row with a Month is a visit, not a checkup: this row is sent again as the visit of Mr# ${c.patient_mr}. The checkup stays as it is.`;
      else {
        S.letGo.push({ kind: 'checkup', id: c.id, key: res.key, at: now() });
        res.rekey = 'A row with a Month is a braces patient, never a checkup: this row is sent again as a visit.';
      }
      return { changed: false, warns: [] };
    }
    // a registered checkup whose name is changed to one that does not fit its patient without doubt: nothing is saved (private.aaj_sync_checkup_row)
    if (c.patient_mr && set.name !== undefined && normName(set.name) !== normName(c.name)) {
      const pp = patientByMr(c.patient_mr);
      if (pp && !nameFits(set.name, pp.name) && !sameText(set.name, pp.name)) {
        res.error = `Needs attention: the name in this row does not match Mr# ${pp.mr} on the website. Check the Mr# or the name: nothing in this row is saved until they match.`;
        res.kept_website = [];
        return { changed: false, warns: [] };
      }
    }
    const kept = [], warns = [];
    // an Mr# on a checkup row (private.aaj_sync_checkup_row, RW8-1): not registered yet, the row is let go when the website has that patient and
    // the name fits ("rekey", it then makes the patient's visit as a new row); anything else is refused and the checkup stays. Every such lookup
    // is audited and counted. Registered: another Mr# is refused, the registered one goes back into the cell.
    if (set.mr !== undefined && set.mr !== '' && set.mr !== 'NEW') {
      if (!c.patient_mr) {
        const refuse = (m) => { res.error = m; res.kept_website = []; return { changed: false, warns: [] }; };
        if (!/^[A-Za-z0-9_-]+$/.test(set.mr) || !/\d/.test(set.mr)) return refuse(`"${set.mr.slice(0, 30)}" is not a Mr#. Type the number only, or leave it empty for a checkup patient.`);
        if ((S.refusedThisCall || 0) >= 5) return refuse('Too many rows the website could not place at once. This row is tried again in a few minutes.');
        const nm = set.name !== undefined ? set.name : c.name, ph = set.phone !== undefined ? set.phone : c.phone;
        const fp = checkMr(c.branch, c.date, set.mr, nm, ph);
        if (!noteLookup(res.key, set.mr, fp.outcome, normName(nm) + '|' + (normPhone(ph) || ''))) return refuse(BUDGET_MSG);
        if (fp.outcome === 'mr') {
          S.letGo.push({ kind: 'checkup', id: c.id, key: res.key, at: now() });      // the checkup goes when its key has left the sheet (RV9-2)
          res.rekey = `Mr# ${set.mr} typed: this row is sent again as that patient's visit.`; res.kept_website = []; return { changed: false, warns: [] };
        }
        return refuse(`Needs attention: Mr# ${set.mr.slice(0, 20)} is not a patient on the website with this name, so this row stays a checkup. Clear the Mr# if this is a checkup patient (no Mr#), or check the number.`);
      }
      if (c.patient_mr !== set.mr) {
        kept.push('mr');
        warns.push(`Mr# ${set.mr} is not this checkup's patient, so Mr# ${c.patient_mr} is put back. If this row is another patient, delete it and type that patient in a new row.`);
      }
    }
    const cn = canonCheckup(c);
    let edited = editedAt || 0;
    if (edited > nowMs + 300000) edited = nowMs;
    const newer = edited > c.updated_at && !(adopted && (c.day_status === 'in_treatment' || c.day_status === 'completed'));
    const before = JSON.stringify([c.name, c.phone, c.checkup_for, c.token, c.day_status, c.doctors, c.details]);
    const sheetText = (f) => (['token', 'status', 'doctors'].includes(f) ? (set[f].t ?? '') : f === 'phone' ? (normPhone(set.phone) || '') : String(set[f] ?? '').trim());
    for (const f of ['name', 'phone', 'treatment', 'token', 'status', 'doctors', 'details']) {
      if (set[f] === undefined) continue;
      let s = sheetText(f), w = cn[f], b = base ? (f === 'doctors' ? (base.doctors || []).join(',') : (base[f] ?? '')) : null;
      if (f === 'status') { s = s.toLowerCase(); w = w.toLowerCase(); b = b === null ? null : b.toLowerCase(); }
      if (f === 'doctors') { s = peopleKey(s); w = peopleKey(w); b = b === null ? null : peopleKey(b); }
      if (f === 'phone') { w = normPhone(w) || w; b = b === null ? null : (normPhone(b) || b); }      // the number, not how it is written
      let apply = w === s ? null : (base ? (w === b || newer) : (w === '' || newer));
      if (adopted && f === 'status' && w !== s) apply = adoptStatus(c.day_status || null, set.status.v || null, editedAt == null ? null : edited > c.updated_at) === 'apply';
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
    const after = JSON.stringify([c.name, c.phone, c.checkup_for, c.token, c.day_status, c.doctors, c.details]);
    if (before !== after) c.updated_at = nowMs;
    res.kept_website = kept;
    return { changed: before !== after, warns };
  }

  function finish(res, warns) {
    if (res.error) { res.outcome = 'error'; res.level = 'error'; res.message = res.error; delete res.error; return res; }
    // a message given as { ok: text } is information, not a warning: alone it leaves the row a tick (private.aaj_sync_row, RS13-M1)
    if (warns.length) {
      res.level = warns.some((w) => typeof w === 'string') ? 'warn' : (res.level || 'ok');
      res.message = warns.map((w) => (typeof w === 'string' ? w : w.ok)).join(' ');
    }
    return res;
  }

  // private.aaj_checkup_twin: the checkup of today that a new row is (its row lost the hidden key, or the person was typed again): the same
  // name and phone (compared as numbers), or with no phone the oldest checkup of that full name today that has none either and whose row is
  // not on the sheet now (SB10-1: two walk-ins of one name whose rows lost their keys in a sort each find their own checkup again)
  function checkupTwin(tab, date, key, name, phoneIn, present) {
    const nn = normName(name), ph = normPhone(phoneIn);
    if (nn.length < 2) return null;
    const free = (c) => checkupKey(c) !== key && !present.includes(checkupKey(c));
    const today = S.checkups.filter((c) => c.branch === tab.branch && c.date === date && c.source !== 'archive' && normName(c.name) === nn)
      .sort((a, b) => a.seq - b.seq);
    if (ph) return today.find((c) => normPhone(c.phone) === ph && free(c)) || null;
    return today.find((c) => !normPhone(c.phone) && free(c)) || null;
  }
  // private.aaj_checkup_dup: a checkup of the same name and phone whose row IS on the sheet now (its key in present): the key of that row.
  // Never by a name alone (two walk-ins with no phone can share a name)
  function checkupDup(tab, date, key, name, phoneIn, present) {
    const nn = normName(name), ph = normPhone(phoneIn);
    if (nn.length < 2 || !ph) return null;
    const c = S.checkups.find((x) => x.branch === tab.branch && x.date === date && x.source !== 'archive' && normName(x.name) === nn && normPhone(x.phone) === ph
      && checkupKey(x) !== key && present.includes(checkupKey(x)));
    return c ? checkupKey(c) : null;
  }
  function adoptCheckup(c, tab, set, row, res) {
    // a row typed just now for a person whose checkup is Cancelled / No show, with no Status typed: Waiting again (sheet-behaviour RS5-A1)
    if ((c.day_status === 'cancelled' || c.day_status === 'no_show') && !set.status && (row.edited_at || 0) > c.updated_at) set = { ...set, status: { t: 'Waiting', v: 'waiting' } };
    c.sheet_key = row.key;
    const { warns } = applyCheckup(c, tab, set, null, row.edited_at, res, true);      // the newer edit wins, the status only moves forward
    res.outcome = 'linked'; res.visit_id = c.id;
    return finish(res, warns);
  }

  // private.aaj_note_lookup: audited and counted once per key, Mr#, typed name and phone, and outcome a day; false when the day's 200 are used up
  function noteLookup(key, mr, outcome, who) {
    const k = key + '|' + outcome + '|' + mr + '|' + who;
    S.lookupKeys = S.lookupKeys || new Set();
    if (S.lookupKeys.has(k)) return true;
    if (S.lookups >= 200) return false;
    S.lookupKeys.add(k); S.lookups++;
    S.refusedThisCall = (S.refusedThisCall || 0) + 1;
    return true;
  }

  function lookupRefused(res, tab, key, mr, text, textUnseen, seen, only, who) {
    const k = key + '|' + res.outcome + '|' + mr + '|' + who;          // once per key, Mr#, typed name and phone, and outcome a day
    S.lookupKeys = S.lookupKeys || new Set();
    if (!S.lookupKeys.has(k)) {
      if (S.lookups >= 200) { res.message = BUDGET_MSG; return res; }
      S.lookupKeys.add(k); S.lookups++;
      S.refusedThisCall = (S.refusedThisCall || 0) + 1;    // a new refusal counts for this call (a row refused earlier and sent again does not)
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
        if (ck.branch !== tab.branch || ck.date !== date) { res.outcome = 'other_list'; res.level = 'error'; res.message = 'This checkup was moved to another branch or day on the website. Delete this row.'; return res; }
        if (row.key.startsWith('W-') && !ck.sheet_key) ck.sheet_key = row.key;
        const { changed, warns } = applyCheckup(ck, tab, set, row.base || null, row.edited_at, res);
        res.visit_id = ck.id; res.outcome = changed ? 'updated' : 'unchanged';
        if (res.rekey) { res.outcome = 'rekey'; res.level = 'warn'; res.message = res.rekey; delete res.rekey; return res; }
        return finish(res, warns);
      }
    }
    if (v && row.key.startsWith('W-') && v.sheet_key && v.sheet_key !== row.key) { res.outcome = 'superseded'; res.level = 'warn'; res.message = 'This row was replaced by another row for the same visit.'; return res; }
    if (v && (v.branch !== tab.branch || v.date !== date)) { res.outcome = 'other_list'; res.level = 'error'; res.message = 'This visit was moved to another branch or day on the website. Delete this row.'; return res; }
    if (v) {
      // a linked row whose name is typed over with a name that does not fit the visit's patient without doubt: nothing is saved, every answer
      // says so (private.aaj_sync_row, sheet-behaviour L2-residual)
      if (set.name !== undefined) {
        const pv = patientByMr(v.mr);
        if (!nameFits(set.name, pv.name) && !sameText(set.name, pv.name)) {
          res.outcome = 'error'; res.level = 'error'; res.visit_id = v.id;
          res.message = `Needs attention: the name in this row does not match Mr# ${pv.mr} on the website. Check the Mr# or the name: nothing in this row is saved until they match.`;
          return res;
        }
      }
      // another Mr# on a linked row whose patient file the sync made from this very row today, that looks like the correction of a slip (a
      // Healthwire number at most two digits away): the row is let go and sent again as a new row (private.aaj_sync_row, RW8-1); any other
      // Mr# is written back (applyFields)
      if (set.mr !== undefined && set.mr !== '' && set.mr !== 'NEW') {
        const pv = patientByMr(v.mr);
        if (set.mr !== pv.mr && /^[1-9]\d{0,4}$/.test(set.mr) && Number(set.mr) < 50000 && lev(set.mr, pv.mr) <= 2
            && pv.sync_made === pkDate(now()) && !S.visits.some((x) => x !== v && x.mr === pv.mr)) {
          // let go only while nothing real hangs on the visit; it then goes whatever its status (RV9-2). Otherwise the Mr# is written back
          if (v.attached) res.slipHeld = 'invoices';
          else {
            S.letGo.push({ kind: 'visit', id: v.id, key: row.key, at: now() });
            res.outcome = 'rekey'; res.level = 'warn'; res.visit_id = v.id;
            res.message = `Mr# changed from ${pv.mr} to ${set.mr.slice(0, 20)}: this row is sent again with the new Mr#.`;
            return res;
          }
        }
      }
      if (row.key.startsWith('W-') && !v.sheet_key) v.sheet_key = row.key;
      const { changed, warns } = applyFields(v, tab, set, row.base || null, row.edited_at, res);
      res.visit_id = v.id; res.outcome = changed ? 'updated' : 'unchanged';
      return finish(res, warns);
    }
    if (!row.new || row.key.startsWith('W-')) { res.outcome = 'gone'; res.level = 'error'; res.message = 'This visit was deleted on the website. Delete this row.'; return res; }
    // a new row: no Mr# is a checkup patient
    const name = set.name || '';
    const mrIn = String(set.mr ?? '').trim();
    const hasMonth = !!(set.month && String(set.month.t ?? '').trim() !== '');
    if (mrIn === '' || mrIn.toUpperCase() === 'NEW') {
      // a checkup of today whose row lost its hidden key (or the same person typed again): that checkup, whatever the Treatment (private.aaj_checkup_twin);
      // never a row with a Month (a braces patient)
      const twin = hasMonth ? null : checkupTwin(tab, date, row.key, name, set.phone, present);
      if (twin) return adoptCheckup(twin, tab, set, row, res);
      // that person's checkup is in another row of the tab now: refused as a duplicate, never made twice (private.aaj_checkup_dup, RV-1)
      const dup = hasMonth ? null : checkupDup(tab, date, row.key, name, set.phone, present);
      if (dup) {
        res.outcome = 'duplicate'; res.level = 'error'; res.duplicate_of = dup;
        res.message = 'Already on this list in another row (the same checkup patient). Delete this row. If this is another person, correct the name or the phone.';
        return res;
      }
      // owner, 9 Oct 2026 (13:20): only a Treatment that says checkup makes a row without an Mr# a checkup; any other is an existing patient whose Mr# was forgotten
      if (!isCheckupText(set.treatment)) {
        res.outcome = 'needs_patient'; res.level = 'error';
        res.message = 'Needs attention: add the Mr#. A row with no Mr# is a checkup only when its Treatment says checkup. Look the Mr# up in Healthwire.';
        return res;
      }
      if (set.month && String(set.month.t ?? '').trim() !== '') {
        res.outcome = 'needs_patient'; res.level = 'error';
        res.message = 'Needs attention: add the Mr#. A row with a Month is a braces patient, never a checkup. Look the Mr# up in Healthwire.';
        return res;
      }
      if (String(name).trim().length < 2) { res.outcome = 'needs_patient'; res.level = 'error'; res.message = 'Patient name is too short.'; return res; }
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
    if (String(name).trim().length < 2) { res.outcome = 'needs_patient'; res.level = 'error'; res.message = 'Patient name is too short.'; return res; }
    if ((S.refusedThisCall || 0) >= 5) { res.outcome = 'needs_patient'; res.level = 'error'; res.message = 'Too many rows the website could not place at once. This row is tried again in a few minutes.'; return res; }
    let fp = checkMr(tab.branch, date, mrIn, name, set.phone);
    // the name and phone are a file the sync made today from a row that has left the sheet (a slip being corrected): looked at without it
    if (fp.outcome === 'mr_other' && fp.patient.sync_made === pkDate(now())) {
      const vs = S.visits.filter((x) => x.mr === fp.patient.mr);
      if (vs.length && vs.every((x) => x.branch === tab.branch && x.date === date && x.sheet_key && !present.includes(x.sheet_key))) fp = checkMr(tab.branch, date, mrIn, name, set.phone, fp.patient);
    }
    const who = normName(name) + '|' + (normPhone(set.phone) || '');
    // the day's 200 refused lookups are used up: every row that would make a visit or a patient gets the same answer, fit or not; it counts
    // for the call's five. A patient already on today's list, and a refused row sent again, go on.
    const onList = fp.outcome === 'mr' && (S.visits.some((x) => x.mr === fp.patient.mr && x.branch === tab.branch && x.date === date)
      || S.checkups.some((c) => c.patient_mr === fp.patient.mr && c.branch === tab.branch && c.date === date));
    if (!onList && S.lookups >= 200 && (fp.outcome === 'mr' || fp.outcome === 'mr_new' || !(S.lookupKeys && S.lookupKeys.has(row.key + '|' + fp.outcome + '|' + mrIn + '|' + who)))) {
      S.refusedThisCall = (S.refusedThisCall || 0) + 1;
      res.outcome = 'needs_patient'; res.level = 'error'; res.message = BUDGET_MSG;
      return res;
    }
    let p = null, warn = null;
    if (fp.outcome === 'mr') {
      p = fp.patient;                       // the name fits without doubt
    } else if (fp.outcome === 'mr_new') {
      if (normName(name).length < 2) { res.outcome = 'needs_patient'; res.level = 'error'; res.message = 'Patient name is too short.'; return res; }
      if ((S.createdByBranch[tab.branch] || 0) >= 30) {      // audited and counted like a refused lookup (private.aaj_sync_row, 'mr_cap')
        res.outcome = 'needs_patient'; res.level = 'error';
        lookupRefused(res, tab, row.key, mrIn + '|cap', '', '', true, 'Too many new patients from the sheet today. Add this one on the website.', who);
        return res;
      }
      p = addPatient({ mr: mrIn, name, phone: normPhone(set.phone), first_branch: tab.branch });
      p.sync_made = pkDate(now());          // made by the sync today: removed with its visit when the row goes (private.aaj_removals)
      S.createdByBranch[tab.branch] = (S.createdByBranch[tab.branch] || 0) + 1;
      res.patient_created = p.mr;
      warn = `New patient added with Healthwire Mr# ${p.mr}. Check the name and phone on the website.`;
      if (S.hwLimit && Number(mrIn) > hwLimit() - 20) warn += ' Healthwire numbers are close to the newest ones the website knows: ask Dr. Ali to import the latest Healthwire patients.';
    } else {
      res.outcome = 'needs_patient'; res.level = 'error';
      // a refusal never names the patient of the typed Mr#; the Mr# under which this very name and phone are filed is told when that patient was seen here
      if (fp.outcome === 'mr_name') lookupRefused(res, tab, row.key, mrIn, '', '', true, `Needs attention: the name in this row does not match Mr# ${mrIn} on the website. Check the Mr#, or type the name as the website has it.`, who);
      else if (fp.outcome === 'mr_other') lookupRefused(res, tab, row.key, mrIn, `Mr# ${mrIn} is not on the website, but ${String(name).trim().slice(0, 60)} with this phone is Mr# ${fp.patient.mr}. Use ${fp.patient.mr}.`,
        `Mr# ${mrIn} is not on the website, and this name and phone are filed under another Mr#. Check the number.`, fp.seen, null, who);
      else if (fp.outcome === 'mr_moved') lookupRefused(res, tab, row.key, mrIn, '', '', true, `Mr# ${mrIn} is no longer used. This patient's Mr# is now ${fp.patient.mr}. Use ${fp.patient.mr}.`, who);
      else if (fp.outcome === 'mr_ahead') lookupRefused(res, tab, row.key, mrIn, '', '', true, `Mr# ${mrIn} is not on the website and is higher than the newest Healthwire numbers it knows, so it looks like a typo. Check the Mr#. If it is right (a new Healthwire patient), ask Dr. Ali to import the latest Healthwire patients; this row is tried again every few minutes.`, who);
      else if (fp.outcome === 'mr_noname') lookupRefused(res, tab, row.key, mrIn, '', '', true, `Needs attention: Mr# ${mrIn}: the name in this row cannot be read. Type the patient's name in English letters, as the website has it.`, who);
      else lookupRefused(res, tab, row.key, mrIn, `Mr# ${mrIn} is not on the website. Check the number.`, `Mr# ${mrIn} is not on the website. Check the number.`, true, null, who);
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
      // a row typed just now for a patient whose visit is Cancelled / No show, with no Status typed: the patient is here, Waiting again
      const setA = (e.status === 'cancelled' || e.status === 'no_show') && !set.status && (row.edited_at || 0) > e.updated_at ? { ...set, status: { t: 'Waiting', v: 'waiting' } } : set;
      const { warns } = applyFields(e, tab, setA, null, row.edited_at, res, false, true);
      res.outcome = 'linked'; res.visit_id = e.id;
      return finish(res, warn ? [warn, ...warns] : warns);
    }
    if (fp.outcome === 'mr' && !hasMonth) {
      // no visit, but a checkup of today registered as this patient whose row is not on the sheet: that checkup (never turned into a visit;
      // a row with a Month is the patient's visit, never a checkup)
      const ck = S.checkups.find((c) => c.patient_mr === p.mr && c.branch === tab.branch && c.date === date && c.source !== 'archive'
        && checkupKey(c) !== row.key && !present.includes(checkupKey(c)));
      if (ck) return adoptCheckup(ck, tab, set, row, res);
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
  // private.aaj_let_go_seen: the website let this record's row go today, and the record was not changed since
  const letGoSeen = (kind, x) => S.letGo.some((l) => l.kind === kind && l.id === x.id && l.key === x.sheet_key && x.updated_at <= l.at && pkDate(l.at) === pkDate(now()));
  function removals(tab, date, present) {
    const out = [];
    const vcands = S.visits.filter((v) => v.branch === tab.branch && v.date === date && v.sheet_key && !present.includes(v.sheet_key) && v.status !== 'cancelled' && !S.released.has(v.id));
    const ccands = S.checkups.filter((c) => c.branch === tab.branch && c.date === date && c.sheet_key && !present.includes(c.sheet_key) && c.day_status !== 'cancelled' && !S.released.has(c.id));
    const n = vcands.length + ccands.length;
    if (!n) return out;
    const total = S.visits.filter((v) => v.branch === tab.branch && v.date === date && v.sheet_key && v.status !== 'cancelled' && !S.released.has(v.id)).length
      + S.checkups.filter((c) => c.branch === tab.branch && c.date === date && c.sheet_key && c.day_status !== 'cancelled' && !S.released.has(c.id)).length;
    const done = S.removedToday[tab.branch] || 0;
    const cap = Math.max(15, Math.ceil(0.35 * (total + done)));      // 35 in 100 of the day's rows, at least 15 (RS12-1)
    const hold = n > 3 || (n >= 2 && (present.length === 0 || n * 4 >= total)) || done + n > cap;
    const why = done + n > cap && n <= 3
      ? 'Needs attention: too many rows were deleted from this tab today, so nothing was removed from the website. Delete wrong entries on the website.'
      : `Needs attention: ${n} rows disappeared at once, so nothing was removed from the website. Delete wrong entries on the website, or delete fewer rows at a time.`;
    for (const v of vcands) {
      if (hold) { out.push({ key: v.sheet_key, action: 'restore', message: why }); continue; }
      // a visit whose row the website let go (the Mr# corrected on a row whose file the sync made from a slip) goes whatever its status (RV9-2)
      const letGo = letGoSeen('visit', v) && !v.attached;
      const plain = letGo || ((v.status === 'scheduled' || v.status === 'waiting' || v.status === 'no_show') && !v.attached && !v.started);
      if (plain) {
        const p = patientByMr(v.mr);
        // the patient file the sync made from this row today goes with the visit when nothing else is on it (a Healthwire Mr# typed with a slip)
        const ownFile = p.sync_made === pkDate(now()) && !S.visits.some((x) => x !== v && x.mr === v.mr) && !S.checkups.some((c) => c.patient_mr === v.mr);
        const dropPatient = ownFile && !p.edited;
        const keptFile = ownFile && p.edited;            // front desk saved details on it: kept (sheet-behaviour RSX-1)
        S.removedLog.push({ kind: 'visit', branch: tab.branch, date, key: v.sheet_key, snapshot: JSON.parse(JSON.stringify(v)), patient: dropPatient ? JSON.parse(JSON.stringify(p)) : null });
        S.visits = S.visits.filter((x) => x !== v);
        if (dropPatient) S.patients = S.patients.filter((x) => x !== p);
        S.removedToday[tab.branch] = (S.removedToday[tab.branch] || 0) + 1;
        out.push({ key: v.sheet_key, action: 'deleted', name: p.name, message: (letGo ? 'The Mr# in this row was corrected and the row was sent again: the visit under the old Mr# is removed from the website.'
            : 'Row deleted in the sheet: the visit is removed from the website too.')
          + (dropPatient ? ` So is the patient file made from this row (Mr# ${p.mr}).` : '')
          + (keptFile ? ` The patient file made from this row (Mr# ${p.mr}) is kept: details were saved on it on the website. Check it (if the Mr# was typed wrong, merge it into the right file).` : '')
          + (letGo ? ' Dr. Ali can undo it.' : ' Put the row back to undo.') });
      } else if (v.status === 'scheduled' || v.status === 'waiting') {
        S.keptLog.push({ branch: tab.branch, date, key: v.sheet_key, id: v.id, status: v.status, at: now() });     // undone by a Ctrl+Z ("doubled", RV-3)
        v.status = 'cancelled'; v.updated_at = now();
        S.removedToday[tab.branch] = (S.removedToday[tab.branch] || 0) + 1;
        out.push({ key: v.sheet_key, action: 'kept', name: patientByMr(v.mr).name, message: `Kept on the website and marked Cancelled: ${v.attached ? 'it has an attached record (invoices)' : 'treatment was recorded on it'}.` });
      } else if (v.status === 'no_show') {
        S.released.set(v.id, 'no_show');
        out.push({ key: v.sheet_key, action: 'released', name: patientByMr(v.mr).name, message: `Row deleted in the sheet: the visit stays on the website as No show (${v.attached ? 'it has an attached record (invoices)' : 'treatment was recorded on it'}). Its row is not put back.` });
      } else out.push({ key: v.sheet_key, action: 'restore', message: `Not removed: this visit is ${STATUS_LABEL[v.status]} on the website. To take a patient off, set Status to Cancelled.` });
    }
    for (const c of ccands) {
      if (hold) { out.push({ key: c.sheet_key, action: 'restore', message: why }); continue; }
      // a checkup in Treatment or Completed is never removed by its deleted row, like a Completed visit (sheet-behaviour RV-2), unless the
      // website let its row go (an Mr# of a patient it has, or a Month, typed into it): then it goes whatever its status (RV9-2)
      const letGo = letGoSeen('checkup', c);
      if (!c.patient_mr && c.follow_up === 'Not Contacted' && (['waiting', 'no_show'].includes(c.day_status || 'waiting') || letGo)) {
        S.removedLog.push({ kind: 'checkup', branch: tab.branch, date, key: c.sheet_key, snapshot: JSON.parse(JSON.stringify(c)) });
        S.checkups = S.checkups.filter((x) => x !== c);
        S.removedToday[tab.branch] = (S.removedToday[tab.branch] || 0) + 1;
        out.push({ key: c.sheet_key, action: 'deleted', name: c.name, message: letGo
          ? 'An Mr# or a Month was typed in this row, so it was sent again as a visit: the checkup is removed from the website and this person is not on the checkup list. Dr. Ali can undo it.'
          : 'Row deleted in the sheet: the checkup is removed from the website too. Put the row back to undo.' });
      } else if (c.day_status === 'no_show') {
        S.released.set(c.id, 'no_show');
        out.push({ key: c.sheet_key, action: 'released', name: c.name, message: 'Row deleted in the sheet: the checkup stays on the website as No show (it is already a patient, or has follow-up notes). Its row is not put back.' });
      } else if (c.day_status === 'in_treatment' || c.day_status === 'completed') {
        out.push({ key: c.sheet_key, action: 'restore', message: `Not removed: this checkup is ${STATUS_LABEL[c.day_status]} on the website. To take a patient off, set Status to Cancelled.` });
      } else out.push({ key: c.sheet_key, action: 'restore', message: 'Not removed: this checkup is already a patient, or has follow-up notes on the website.' });
    }
    return out;
  }

  // a deleted row that came back in the sheet: the visit / checkup it removed is put back under its key
  function restoreRemoved(tab, date, present) {
    let skipped = false;
    for (const r of S.removedLog) {
      if (r.restored || r.branch !== tab.branch || r.date !== date || !present.includes(r.key)) continue;
      r.restored = true;
      if (r.kind === 'visit') {
        // the patient has another visit on this list now (typed again in another row): not put back, now or later
        if (S.visits.some((v) => v.id === r.snapshot.id) || S.visits.some((v) => v.mr === r.snapshot.mr && v.branch === r.snapshot.branch && v.date === r.snapshot.date && v.status !== 'cancelled')) { skipped = true; continue; }
        if (r.patient && !patientByMr(r.patient.mr)) S.patients.push({ ...r.patient });
        if (!patientByMr(r.snapshot.mr)) { skipped = true; continue; }
        S.visits.push({ ...r.snapshot, updated_at: now() });
      } else {
        if (S.checkups.some((c) => c.id === r.snapshot.id)) { skipped = true; continue; }
        S.checkups.push({ ...r.snapshot, updated_at: now() });
      }
    }
    return skipped;
  }

  // private.aaj_restore_kept: a row whose visit was kept and marked Cancelled, brought back with Ctrl+Z after the sync had put it back (its key
  // on two rows: "doubled"): the visit gets its status back when it is still Cancelled and unchanged since; tried once (RV-3)
  function restoreKept(tab, date, doubled) {
    for (const k of S.keptLog) {
      if (k.done || k.branch !== tab.branch || k.date !== date || !doubled.includes(k.key)) continue;
      k.done = true;
      const v = visitById(k.id);
      if (v && v.status === 'cancelled' && v.updated_at <= k.at && v.sheet_key === k.key) { v.status = k.status; v.updated_at = now(); k.restored = true; }
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
    S.refusedThisCall = 0;                                  // refused lookups in this call: after 5 the call's other new Mr# rows wait
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
      const forceList = hasPresent && present.length ? restoreRemoved(t, payload.date, present) : false;
      if (hasPresent && present.length && Array.isArray(t.doubled)) restoreKept(t, payload.date, t.doubled.filter((k) => present.includes(k)));
      const results = [];
      for (const row of t.rows || []) results.push(processRow(t, row, payload.date, present));
      if (hasPresent && payload.date === pkDate(now())) {
        for (const v of S.visits) if (v.branch === t.branch && v.date === payload.date && v.sheet_key) {
          if (present.includes(v.sheet_key)) S.released.delete(v.id);
          else if (v.status === 'cancelled' && !S.released.has(v.id)) S.released.set(v.id, 'cancelled');
        }
        for (const c of S.checkups) if (c.branch === t.branch && c.date === payload.date && c.sheet_key) {
          if (present.includes(c.sheet_key)) S.released.delete(c.id);
          else if (c.day_status === 'cancelled' && !S.released.has(c.id)) S.released.set(c.id, 'cancelled');
        }
      }
      const removed = payload.check_removed && payload.date === pkDate(now()) && hasPresent ? removals(t, payload.date, present) : [];
      const list = dayList(t.branch, payload.date);
      const hash = crypto.createHash('md5').update(JSON.stringify(list)).digest('hex');
      const unchanged = !(t.rows || []).length && t.hash === hash && !removed.length && !forceList;
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

  return { state: S, handler, aajSync, addPatient, addVisit, addCheckup, editVisit, editCheckup, editPatient, removeVisit, removeCheckup, visitById, visitByKey, checkupById, checkupByKey, visitsOf, checkupsOf,
    canon, canonCheckup, dayList, checkMr, matchClinician, patientByMr, get calls() { return S.calls; }, faults: S.faults };
}
