// DEMO data layer for the Photo inbox and the Photo library: the same methods and answers as data/supabase-inbox.js, in memory, following
// the database's rules (supabase/migrations/20261017000200_photo_intake.sql): who may (photos.intake + photos.view_raw + the city), the
// exact paths, the plan's checks and the automatic filing's re-checks, the patient's 24-hour window, the visit's "photos uploaded" tick.
// Files live in a Map (path -> Blob) and are shown through object URLs. Claude is a deterministic stand-in (no network): the view cycles
// through front, right, left, upper, lower, face front, face smile, profile right; the right side and the occlusal views are mirror shots
// (the right side straightened 4 degrees), the left side is turned a quarter. localStorage 'demo-photo-ai' plays the other answers:
// 'off' (no key), 'refused', 'invalid', and the error codes 'RATE_LIMIT', 'API_DOWN', 'BAD_REQUEST', 'BILLING', 'BAD_KEY', 'CONFIG'.
// The demo's day of the Photo inbox (made-up visits of YESTERDAY at DHA, Gulshan and North Nazimabad; none in Lahore) is added the first
// time the Photo inbox is opened on a page, so no other screen's sample numbers change. Made-up people only.
import { inboxPaths, citySlug, karachiDate, viewName, MAX_AUTO_PHOTOS, EDIT_VERSION } from '../lib/photo-intake.js';
import { todayISO } from '../ui/dom.js';

const MIN = 60 * 1000;
const DOT = ' · ';
const files = new WeakMap(); // db -> Map(path -> { blob, url, owner })
const FAKE_VIEWS = ['intra_front', 'intra_right', 'intra_left', 'intra_upper', 'intra_lower', 'face_front', 'face_smile', 'face_profile_right'];
const NOT_ALLOWED = 'NOT_ALLOWED: the Photo inbox needs "Use the Photo inbox" and "View raw clinic photos folder" in the access list, and a branch in this city.';

/** The demo's Photo inbox day: yesterday at DHA (three photo months, one other month), Gulshan and North Nazimabad (no photo month). */
function seedInboxDay(db, uid) {
  if (db.inboxSeeded) return;
  db.inboxSeeded = true;
  const today = todayISO();
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  const day = d.toISOString().slice(0, 10);
  const at = (hm) => new Date(`${day}T${hm}:00+05:00`).toISOString();
  const caseOf = (i) => db.braces_cases.find((b) => b.patient_id === db.patients[i].id) || null;
  const add = (i, branch, o) => {
    const bc = o.braces_month ? caseOf(i) : null;
    db.visits.push({ id: uid(), patient_id: db.patients[i].id, branch_id: branch, visit_date: day, token_no: o.token, status: 'completed',
      treatment_label: o.label, braces_case_id: bc?.id || null, braces_month: bc ? o.braces_month : null, details_text: '', photo_required: !!o.photo,
      photos_uploaded: false, checker_required: false, checked_by: null, checked_in_at: o.checkin || null, started_at: o.start || null,
      completed_at: o.done || null, created_at: at('16:00'), notes: null, inbox_fixture: o.key });
  };
  add(9, 3, { key: 'V1', token: 11, label: 'Monthly', braces_month: 10, photo: true, checkin: at('18:20'), start: at('18:31'), done: at('18:52') });
  add(4, 3, { key: 'V2', token: 12, label: 'Monthly', braces_month: 7, photo: true, start: at('19:10'), done: at('19:45') });
  add(7, 3, { key: 'V3', token: 13, label: 'Monthly', braces_month: 4, photo: true, start: at('19:12'), done: at('19:40') });
  add(10, 3, { key: 'V4', token: 14, label: 'Monthly', braces_month: 5, photo: false, start: at('18:10'), done: at('18:25') });
  add(20, 1, { key: 'G1', token: 21, label: 'Scaling', start: at('18:50'), done: at('19:10') });
  add(21, 2, { key: 'N1', token: 31, label: 'Checkup', start: at('19:00'), done: at('19:20') });
}

export function inboxDemo({ db, me, can, fail, uid, clone, audit, patient }) {
  const store = () => { const D = db(); if (!files.has(D)) files.set(D, new Map()); return files.get(D); };
  const inbox = () => { const D = db(); if (!D.inbox) D.inbox = { items: [], sets: [], calls: [] }; return D.inbox; };
  // The demo's day of the Photo inbox comes with the Photo inbox page itself (its city list, overview, day, uploads), never with the
  // badge every page asks for, so no other screen's sample numbers change.
  const openInbox = () => { seedInboxDay(db(), uid); return inbox(); };
  const nowIso = () => new Date().toISOString();
  const hold = () => { const v = Number(db().settings.photo_inbox_hold_hours ?? 24); return Math.min(168, Math.max(0, Number.isFinite(v) ? v : 24)) * 60 * MIN; };
  const city = (id) => db().cities.find((c) => c.id === Number(id));
  const branch = (id) => db().branches.find((b) => b.id === Number(id));
  const cityOk = (cityId) => {
    const s = me();
    return !!s && s.active && (can('photos.intake') || s.role === 'admin' || !s.restrict_to_branches || s.branch_ids.some((b) => branch(b)?.city_id === Number(cityId)));
  };
  const allowed = () => !!me() && can('photos.intake') && can('photos.view_raw');
  const require = (cityId) => { if (!allowed() || (cityId != null && (!city(cityId) || !cityOk(cityId)))) fail(NOT_ALLOWED); };
  const requireDelete = () => { if (!can('photos.delete')) fail('NOT_ALLOWED: moving or undoing a filing needs "Delete clinic photos and X-rays" in the access list.'); };
  const setById = (id) => inbox().sets.find((s) => s.id === id);
  const itemsOf = (setId) => inbox().items.filter((i) => i.set_id === setId);
  const urlOf = (path) => store().get(path)?.url || null;
  const timeOk = (i) => i.time_source === 'exif' && i.clock_ok && !!i.taken_at;
  const occasionOf = (v) => (!v ? null : v.braces_month ? `Month ${v.braces_month}` : (String(v.treatment_label || '').trim().slice(0, 40) || null));
  const label = (occasion, key, pos) => [occasion, viewName(key) || `Photo ${pos || 1}`].filter(Boolean).join(DOT);
  const viewKeyOf = (i) => (i.ai_status === 'done' && viewName(i.ai_result?.view) ? i.ai_result.view : null);
  const touch = (s) => { s.version += 1; audit('photo_inbox_sets', 'UPDATE', s); };
  const stale = (s, version) => { if (s.version !== version) fail('PHOTO_STALE: someone changed these photos a moment ago. The list is reloaded.'); };
  const getSet = (id) => { const s = setById(id); if (!s) { require(null); fail('PHOTO_SET_STATE: these photos are not there any more. The list is reloaded.'); } require(s.city_id); return s; };
  const newSet = (cityId, day, o = {}) => {
    const s = { id: uid(), city_id: Number(cityId), photo_day: day, status: 'waiting', manual: false, first_at: null, last_at: null, photo_count: 0, time_ok: false,
      camera: null, branch_hint: null, candidates: [], wait_reason: null, matched_at: null, patient_id: null, visit_id: null, branch_id: null, occasion: null,
      filed_how: null, filed_rule: null, filed_by: null, filed_at: null, release_after: null, hidden: false, ai_flag: null, set_aside_reason: null, version: 0,
      created_at: nowIso(), ...o };
    inbox().sets.push(s);
    audit('photo_inbox_sets', 'INSERT', s);
    return s;
  };
  /** A set's times, count, camera, hint and numbering again; answers whether the set changed. */
  const refresh = (s) => {
    const before = JSON.stringify([s.first_at, s.last_at, s.photo_count, s.time_ok, s.camera, s.branch_hint]);
    const its = itemsOf(s.id).sort((a, b) => ((a.taken_at ? Date.parse(a.taken_at) : Infinity) - (b.taken_at ? Date.parse(b.taken_at) : Infinity))
      || ((a.file_seq ?? Infinity) - (b.file_seq ?? Infinity)) || String(a.file_name).localeCompare(String(b.file_name)) || a.sha256.localeCompare(b.sha256));
    its.forEach((it, i) => { it.position = i + 1; });
    const timed = its.filter((i) => i.time_source === 'exif' && i.taken_at).map((i) => Date.parse(i.taken_at));
    s.first_at = timed.length ? new Date(Math.min(...timed)).toISOString() : null;
    s.last_at = timed.length ? new Date(Math.max(...timed)).toISOString() : null;
    s.photo_count = its.length;
    s.time_ok = its.length > 0 && its.every(timeOk);
    const cams = [...new Set(its.map((i) => i.camera))];
    s.camera = cams.length === 1 ? cams[0] : its.length ? 'mixed' : null;
    const hints = [...new Set(its.map((i) => i.branch_hint ?? null))];
    s.branch_hint = hints.length === 1 ? hints[0] : null;
    return before !== JSON.stringify([s.first_at, s.last_at, s.photo_count, s.time_ok, s.camera, s.branch_hint]);
  };
  // Whether a visit's patient may have been in the chair between two moments (private.photo_inbox_was_there).
  const wasThere = (u, first, last, tight) => {
    const t = (x) => (x ? Date.parse(x) : null);
    const st = t(u.started_at); const ci = t(u.checked_in_at); const co = t(u.completed_at);
    if (u.legacy_source || (st === null && ci === null)) return true;
    const known = [st, ci].filter((x) => x !== null);
    const lo = Math.min(...known); const hi = Math.max(...known);
    const end = Math.max(co !== null && co >= lo ? co : -Infinity, hi + (tight ? 120 : 180) * MIN) + (tight ? 10 : 15) * MIN;
    return first <= end && last >= lo - (tight ? 10 : 30) * MIN;
  };
  const PHOTO_LIKELY = /(bond|braces off|debond|record|smile|veneer|aligner|consult)/i;
  const IN_LIST = ['waiting', 'in_treatment', 'completed'];
  const visitTick = (visitId) => { const v = db().visits.find((x) => x.id === visitId); if (v && !v.photos_uploaded) v.photos_uploaded = true; };
  const untick = (visitId) => {
    if (!visitId || db().photos.some((p) => p.visit_id === visitId)) return false;
    const v = db().visits.find((x) => x.id === visitId);
    if (!v?.photos_uploaded) return false;
    v.photos_uploaded = false;
    return true;
  };
  const takenOn = (it, fallback) => (timeOk(it) ? karachiDate(it.taken_at) : fallback || it.photo_day);
  /** The patient's photo rows of a filed set (raw, and the edited copy once edited). */
  const fileRows = (s) => {
    if (s.status !== 'filed' || !s.patient_id) return 0;
    const v = db().visits.find((x) => x.id === s.visit_id) || null;
    // an edited copy made after the filing gets its own window from now
    const release = new Date(Math.max(s.release_after ? Date.parse(s.release_after) : Date.now(), Date.now() + hold())).toISOString();
    let n = 0;
    for (const it of itemsOf(s.id).sort((a, b) => a.position - b.position)) {
      const key = viewKeyOf(it);
      const base = { patient_id: s.patient_id, visit_id: s.visit_id, branch_id: s.branch_id, taken_on: takenOn(it, v?.visit_date), view_key: key,
        view_label: label(s.occasion, key, it.position), braces_month: v?.braces_month ?? null, occasion: s.occasion, public_ok: false, uploaded_by: me()?.id || null,
        intake_item_id: it.id, intake_set_id: s.id, created_at: nowIso() };
      if (!it.raw_photo_id) {
        const raw = { id: uid(), ...base, kind: 'raw', storage_path: it.storage_path, thumb_path: it.thumb_path, edited_from: null,
          url: urlOf(it.storage_path), thumb_url: urlOf(it.thumb_path) || urlOf(it.storage_path), release_after: null, held_back: false };
        db().photos.push(raw);
        audit('photos', 'INSERT', raw);
        it.raw_photo_id = raw.id;
        n++;
        if (s.visit_id) visitTick(s.visit_id);
      }
      if (it.edit_status === 'done' && it.edited_path && !it.edited_photo_id) {
        const ed = { id: uid(), ...base, kind: 'edited', storage_path: it.edited_path, thumb_path: it.edited_thumb_path, edited_from: it.raw_photo_id,
          url: urlOf(it.edited_path), thumb_url: urlOf(it.edited_thumb_path) || urlOf(it.edited_path), release_after: release,
          held_back: !!s.hidden || s.ai_flag === 'mixed_people' };
        db().photos.push(ed);
        audit('photos', 'INSERT', ed);
        it.edited_photo_id = ed.id;
        n++;
      } else if (it.edit_status === 'done' && it.edited_path) {
        // edited again: the row points at the new copy, with a new window
        const ed = db().photos.find((x) => x.id === it.edited_photo_id);
        if (ed && ed.storage_path !== it.edited_path) {
          Object.assign(ed, { storage_path: it.edited_path, thumb_path: it.edited_thumb_path, url: urlOf(it.edited_path), thumb_url: urlOf(it.edited_thumb_path) || urlOf(it.edited_path),
            view_key: key, view_label: label(s.occasion, key, it.position), release_after: release });
          audit('photos', 'UPDATE', ed);
          n++;
        }
      }
    }
    return n;
  };
  const target = (s, visitId, patientId) => {
    let v = null;
    if (visitId) {
      v = db().visits.find((x) => x.id === visitId);
      const diff = v ? Math.abs(Date.parse(`${v.visit_date}T12:00:00Z`) - Date.parse(`${s.photo_day}T12:00:00Z`)) / (24 * 60 * MIN) : Infinity;
      if (!v || branch(v.branch_id)?.city_id !== s.city_id || ['cancelled', 'no_show'].includes(v.status) || (s.time_ok ? v.visit_date !== s.photo_day : diff > 14)) {
        fail('PHOTO_VISIT_INVALID: that visit is not on this city\'s list for that day.');
      }
    } else if (patientId) {
      if (!patient(patientId)) fail('PHOTO_BAD_INPUT: no such patient.');
      const theirs = db().visits.filter((x) => x.patient_id === patientId && x.visit_date === s.photo_day && branch(x.branch_id)?.city_id === s.city_id && !['cancelled', 'no_show'].includes(x.status));
      v = theirs.length === 1 ? theirs[0] : null;
    } else fail('PHOTO_BAD_INPUT: choose the patient.');
    return { visit: v, patientId: v?.patient_id || patientId, branchId: v?.branch_id ?? null, occasion: occasionOf(v) };
  };
  const doFile = (s, t, how, rule) => {
    Object.assign(s, { status: 'filed', patient_id: t.patientId, visit_id: t.visit?.id || null, branch_id: t.branchId ?? s.branch_hint, occasion: t.occasion,
      filed_how: how, filed_rule: how === 'auto' ? String(rule || '').slice(0, 200) : null, filed_by: me()?.id || null, filed_at: nowIso(),
      release_after: new Date(Date.now() + hold()).toISOString(), wait_reason: null, set_aside_reason: null });
    touch(s);
    const n = fileRows(s);
    audit('photo_inbox_sets', 'PHOTO_FILED', { id: s.id, patient_id: s.patient_id, visit_id: s.visit_id, how, rule, photos: n });
    return { filed: true, photos: n, visit_ticked: !!t.visit?.photos_uploaded };
  };
  const removeRows = (pred) => {
    const gone = db().photos.filter(pred);
    db().photos = db().photos.filter((p) => !gone.includes(p));
    for (const p of gone) audit('photos', 'DELETE', p, { before: p });
    return gone.length;
  };
  const dayView = (cityId, day) => {
    const branches = db().branches.filter((b) => b.city_id === Number(cityId));
    const ids = new Set(branches.map((b) => b.id));
    const visits = db().visits.filter((v) => ids.has(v.branch_id) && v.visit_date === day).map((v) => {
      const p = patient(v.patient_id);
      return { visit_id: v.id, patient_id: v.patient_id, full_name: p?.full_name || '', mr_number: p?.mr_number || '', branch_id: v.branch_id, visit_date: v.visit_date,
        token_no: v.token_no ?? null, status: v.status, created_at: v.created_at, checked_in_at: v.checked_in_at || null, started_at: v.started_at || null,
        completed_at: v.completed_at || null, legacy: !!v.legacy_source, photo_required: !!v.photo_required, braces_month: v.braces_month ?? null,
        treatment_label: v.treatment_label || null, photos_uploaded: !!v.photos_uploaded, photo_count: db().photos.filter((ph) => ph.visit_id === v.id).length,
        filed_set_ids: inbox().sets.filter((s) => s.visit_id === v.id && s.status === 'filed').map((s) => s.id) };
    }).sort((a, b) => String(a.started_at || a.checked_in_at || a.created_at).localeCompare(String(b.started_at || b.checked_in_at || b.created_at)));
    const sets = inbox().sets.filter((s) => s.city_id === Number(cityId) && s.photo_day === day).map((s) => {
      const p = s.patient_id ? patient(s.patient_id) : null;
      return { set_id: s.id, status: s.status, manual: s.manual, first_at: s.first_at, last_at: s.last_at, photo_count: s.photo_count, time_ok: s.time_ok, camera: s.camera,
        branch_hint: s.branch_hint, candidates: clone(s.candidates), wait_reason: s.wait_reason, patient_id: s.patient_id, visit_id: s.visit_id, branch_id: s.branch_id,
        occasion: s.occasion, filed_how: s.filed_how, filed_rule: s.filed_rule, filed_by_name: db().staff.find((x) => x.id === s.filed_by)?.full_name || null,
        filed_at: s.filed_at, hidden: s.hidden, ai_flag: s.ai_flag, set_aside_reason: s.set_aside_reason, version: s.version,
        release_after: [s.release_after, ...db().photos.filter((ph) => ph.intake_set_id === s.id && ph.kind === 'edited').map((ph) => ph.release_after)].filter(Boolean).sort().pop() || null,
        full_name: p?.full_name || null, mr_number: p?.mr_number || null };
    });
    const items = inbox().items.filter((i) => i.city_id === Number(cityId) && i.photo_day === day).map((i) => ({
      item_id: i.id, set_id: i.set_id, position: i.position, sha256: i.sha256, storage_path: i.storage_path, thumb_path: i.thumb_path, edited_path: i.edited_path,
      edited_thumb_path: i.edited_thumb_path, file_name: i.file_name, mime_type: i.mime_type, width: i.width, height: i.height, taken_at: i.taken_at,
      time_source: i.time_source, clock_ok: i.clock_ok, camera: i.camera, file_seq_prefix: i.file_seq_prefix, file_seq: i.file_seq, branch_hint: i.branch_hint,
      uploaded_by: i.uploaded_by, uploaded_at: i.uploaded_at, upload_batch: i.upload_batch, edit_round: i.edit_round, ai_status: i.ai_status, ai_kind: i.ai_result?.kind || null, ai_view: i.ai_result?.view || null,
      ai_issues: i.ai_result?.issues || [], edit_status: i.edit_status, edit_basic: i.edit_basic, raw_photo_id: i.raw_photo_id, edited_photo_id: i.edited_photo_id,
    }));
    const c = city(cityId);
    return { city: { id: c.id, name: c.name, slug: citySlug(c.name) }, day, hold_hours: hold() / (60 * MIN), branches: branches.map((b) => ({ id: b.id, code: b.code, name: b.name })),
      visits, sets, items };
  };
  const claimable = (i, canHeic, lease) => (i.edit_status === 'pending' || (i.edit_status === 'failed' && i.edit_attempts < 3) || (canHeic && i.edit_status === 'needs_safari' && i.edit_attempts < 3))
    && (!i.edit_lease_until || Date.parse(i.edit_lease_until) < Date.now() || i.edit_lease_by === lease);
  const leaseFree = (i, lease) => !i.edit_lease_by || i.edit_lease_by === lease || !i.edit_lease_until || Date.parse(i.edit_lease_until) < Date.now();
  const blobUrl = (blob) => (typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(blob) : null);
  const putFile = (path, blob) => {
    if (store().has(path)) return true;
    store().set(path, { blob, url: blobUrl(blob), owner: me()?.id || null });
    return false;
  };
  const folderOk = (path) => {
    const [root, slug, day, rest] = String(path).split('/');
    return root === 'inbox' && !!rest && /^\d{4}-\d{2}-\d{2}$/.test(day) && db().cities.some((c) => citySlug(c.name) === slug && cityOk(c.id));
  };
  const aiMode = () => { try { return localStorage.getItem('demo-photo-ai') || ''; } catch { return ''; } };
  const aiStatus = () => ({ key: aiMode() !== 'off', model: 'claude-opus-5-5' });
  const record = (call, results) => {
    const row = { id: inbox().calls.length + 1, created_at: nowIso(), called_by: me()?.id || null, ...call };
    inbox().calls.push(row);
    const s = setById(call.set_id);
    if (!s) return row;
    const mine = (id) => { const it = inbox().items.find((x) => x.id === id); return it && it.set_id === s.id ? it : null; };
    if (call.status === 'ok') {
      for (const r of results) {
        const it = mine(r.item_id);
        if (!it) continue;
        Object.assign(it, { ai_status: 'done', ai_result: r.result, ai_call_id: row.id, ai_attempts: it.ai_attempts + 1 });
        if (r.result.kind === 'not_clinical') { if (it.edit_status !== 'done') it.edit_status = 'skipped'; s.ai_flag = s.ai_flag || 'not_clinical'; touch(s); }
      }
      if (call.one_sitting === 'no') {
        s.ai_flag = 'mixed_people';
        touch(s);
        for (const p of db().photos) if (p.intake_set_id === s.id && p.kind === 'edited') p.held_back = true;
      }
    } else if (call.status === 'refused') {
      for (const id of call.item_ids) { const it = mine(id); if (it && it.ai_status === 'pending') Object.assign(it, { ai_status: 'refused', ai_call_id: row.id, ai_attempts: it.ai_attempts + 1 }); }
    } else if (['invalid', 'truncated'].includes(call.status) || (call.status === 'error' && call.error_code === 'BAD_REQUEST')) {
      // (only an answer that could not be used for these photos counts; rate limits, Anthropic down, credit, key: nothing)
      for (const id of call.item_ids) {
        const it = mine(id);
        if (it && it.ai_status === 'pending') Object.assign(it, { ai_attempts: it.ai_attempts + 1, ai_call_id: row.id, ai_status: it.ai_attempts + 1 >= 3 ? 'failed' : 'pending' });
      }
    }
    return row;
  };

  return {
    async photoInboxCities() {
      if (!allowed()) return [];
      openInbox();
      return db().cities.filter((c) => cityOk(c.id) && db().branches.some((b) => b.city_id === c.id && b.active)).map((c) => ({
        id: c.id, name: c.name, slug: citySlug(c.name), branches: db().branches.filter((b) => b.city_id === c.id && b.active).map((b) => ({ id: b.id, code: b.code, name: b.name })),
      }));
    },
    async photoInboxKnown(hashes) {
      require(null);
      const want = new Set((hashes || []).map((h) => String(h).toLowerCase()));
      return inbox().items.filter((i) => want.has(i.sha256)).map((i) => ({ sha256: i.sha256, item_id: i.id, city_id: i.city_id, city_name: city(i.city_id)?.name,
        photo_day: i.photo_day, set_status: setById(i.set_id)?.status || null }));
    },
    async photoInboxUpload({ citySlug: slug, day, sha, ext, file, thumb }) {
      const p = inboxPaths({ citySlug: slug, day, sha, ext });
      if (!can('photos.intake') || !folderOk(p.path)) {
        throw Object.assign(new Error('NOT_ALLOWED: Your login cannot upload into the Photo inbox (needs "Use the Photo inbox").'), { code: 'NOT_ALLOWED', photoCode: 'NOT_ALLOWED' });
      }
      const already = putFile(p.path, file);
      if (thumb) putFile(p.thumb, thumb);
      return { path: p.path, thumbPath: thumb ? p.thumb : null, already };
    },
    async photoInboxAddItems(list) {
      require(null);
      openInbox();
      const out = [];
      const today = todayISO();
      const dayNum = (iso) => Date.parse(`${iso}T12:00:00Z`) / (24 * 60 * MIN);
      for (const x of list) {
        require(x.city_id);
        const sha = String(x.sha256 || '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(sha)) fail('PHOTO_BAD_INPUT: a photo\'s fingerprint is not right.');
        const existing = inbox().items.find((i) => i.sha256 === sha);
        if (existing) { out.push({ sha256: sha, item_id: existing.id, state: 'duplicate', city_id: existing.city_id, photo_day: existing.photo_day }); continue; }
        if (!['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp'].includes(x.ext) || !['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'].includes(x.mime_type)) {
          fail('PHOTO_BAD_INPUT: only JPEG, PNG, HEIC and WebP photos go into the Photo inbox.');
        }
        if (x.branch_hint != null && branch(x.branch_hint)?.city_id !== Number(x.city_id)) fail('PHOTO_BAD_INPUT: that branch is not in this city.');
        const clockOk = !!x.clock_ok && !!x.taken_at;
        if (!x.photo_day || dayNum(x.photo_day) < dayNum(today) - 8 || dayNum(x.photo_day) > dayNum(today) + 1) fail('PHOTO_BAD_INPUT: a photo\'s day must be within the last week.');
        if (x.time_source === 'exif' && clockOk && karachiDate(x.taken_at) !== x.photo_day) fail('PHOTO_BAD_INPUT: a photo\'s day is not the day its camera time says.');
        const path = inboxPaths({ citySlug: citySlug(city(x.city_id).name), day: x.photo_day, sha, ext: x.ext }).path;
        const f = store().get(path);
        if (!f || (f.blob?.size && Number(x.byte_size) !== f.blob.size)) fail('PHOTO_FILE_MISSING: the photo did not finish uploading. Choose it again.');
        const thumbPath = inboxPaths({ citySlug: citySlug(city(x.city_id).name), day: x.photo_day, sha, ext: x.ext }).thumb;
        const it = { id: uid(), sha256: sha, city_id: Number(x.city_id), photo_day: x.photo_day, storage_path: path, thumb_path: x.thumb && store().has(thumbPath) ? thumbPath : null,
          edited_path: null, edited_thumb_path: null, file_name: String(x.file_name || 'photo').slice(0, 200), mime_type: x.mime_type, byte_size: Number(x.byte_size),
          width: x.width || null, height: x.height || null, taken_at: x.taken_at || null, time_source: x.time_source || 'none', clock_ok: clockOk,
          camera: String(x.camera || 'unknown').slice(0, 120), orientation: x.orientation || null, file_seq_prefix: x.file_seq_prefix || null, file_seq: x.file_seq ?? null,
          branch_hint: x.branch_hint ?? null, uploaded_by: me().id, uploaded_at: nowIso(), upload_batch: x.upload_batch || null, set_id: null, position: null,
          raw_photo_id: null, edited_photo_id: null, ai_status: 'pending', ai_result: null, ai_attempts: 0, ai_call_id: null, edit_status: 'pending', edit_basic: false,
          edit_version: null, edit_attempts: 0, edit_round: 1, edit_lease_until: null, edit_lease_by: null };
        inbox().items.push(it);
        out.push({ sha256: sha, item_id: it.id, state: 'added', city_id: it.city_id, photo_day: it.photo_day });
      }
      return out;
    },
    async photoInboxOverview(cityId) {
      require(cityId);
      openInbox();
      const c = city(cityId);
      const its = inbox().items.filter((i) => i.city_id === Number(cityId));
      const sets = inbox().sets.filter((s) => s.city_id === Number(cityId));
      const days = [...new Set([...its.map((i) => i.photo_day), ...sets.map((s) => s.photo_day)])].sort().reverse().map((day) => ({
        day, items: its.filter((i) => i.photo_day === day).length,
        waiting: sets.filter((s) => s.photo_day === day && s.status === 'waiting').length,
        filed: sets.filter((s) => s.photo_day === day && s.status === 'filed').length,
        set_aside: sets.filter((s) => s.photo_day === day && s.status === 'set_aside').length,
        flagged: sets.filter((s) => s.photo_day === day && s.status === 'filed' && (s.ai_flag || !s.patient_id)).length,
        unedited: its.filter((i) => i.photo_day === day && !['done', 'skipped'].includes(i.edit_status)).length,
      }));
      const count = (f) => its.filter(f).length;
      return {
        city: { id: c.id, name: c.name, slug: citySlug(c.name) }, hold_hours: hold() / (60 * MIN), days,
        ai: { pending: count((i) => i.ai_status === 'pending'), done: count((i) => i.ai_status === 'done'), refused: count((i) => i.ai_status === 'refused'),
          failed: count((i) => i.ai_status === 'failed'), needs_safari: count((i) => i.edit_status === 'needs_safari'), unedited: count((i) => ['pending', 'failed'].includes(i.edit_status)) },
        waiting_days: [...new Set([...sets.filter((s) => s.status === 'waiting').map((s) => s.photo_day), ...its.filter((i) => !i.set_id).map((i) => i.photo_day)])].sort(),
        check_days: [...new Set(sets.filter((s) => s.status === 'filed' && (s.ai_flag || !s.patient_id)).map((s) => s.photo_day))].sort(),
      };
    },
    async photoInboxDay(cityId, day) { require(cityId); openInbox(); return dayView(cityId, day); },
    async photoInboxApply(cityId, day, plan) {
      require(cityId);
      const regroupable = inbox().items.filter((i) => i.city_id === Number(cityId) && i.photo_day === day && (!i.set_id || (setById(i.set_id)?.status === 'waiting' && !setById(i.set_id)?.manual)));
      const cur = regroupable.map((i) => i.id).sort();
      const planIds = [...new Set(plan.regroup_item_ids || [])].sort();
      const groupIds = (plan.groups || []).flatMap((g) => g.item_ids || []).sort();
      if (JSON.stringify(cur) !== JSON.stringify(planIds) || JSON.stringify(groupIds) !== JSON.stringify(cur)) fail('PHOTO_STALE_PLAN: the photos changed while matching; it is tried again.');
      const out = { sets: [], filed: 0, joined: 0, waiting: 0, server_refused: [] };
      const touched = new Set(regroupable.map((i) => i.set_id).filter(Boolean));
      const reused = new Set();
      const targets = [];
      // 2. where each group goes (a join is checked again: same camera, branch chosen and uploader, inside or within 3 minutes, 15 minutes and 20 photos at most)
      for (const g of plan.groups || []) {
        const ids = g.item_ids || [];
        if (!ids.length) { targets.push(null); continue; }
        const its = ids.map((id) => inbox().items.find((i) => i.id === id));
        const join = g.join_set_id ? setById(g.join_set_id) : null;
        let ok = false;
        if (join && join.status === 'filed' && !join.manual && join.city_id === Number(cityId) && join.photo_day === day) {
          const fits = itemsOf(join.id);
          const ft = fits.filter((i) => i.time_source === 'exif' && i.taken_at).map((i) => Date.parse(i.taken_at));
          const gt = its.filter((i) => i.taken_at).map((i) => Date.parse(i.taken_at));
          const fa = Math.min(...ft); const fl = Math.max(...ft); const ga = Math.min(...gt); const gl = Math.max(...gt);
          ok = ft.length > 0 && gt.length > 0 && its.every(timeOk)
            && its.every((i) => fits.every((f) => f.camera === i.camera && (f.branch_hint ?? 0) === (i.branch_hint ?? 0) && f.uploaded_by === i.uploaded_by))
            && fits.length + its.length <= MAX_AUTO_PHOTOS && Math.max(fl, gl) - Math.min(fa, ga) <= 900 * 1000
            && ((ga >= fa && gl <= fl) || (ga >= fl && ga - fl <= 180 * 1000) || (gl <= fa && fa - gl <= 180 * 1000));
        }
        let s;
        if (ok) s = join;
        else {
          const old = setById(its[0].set_id);
          s = old && old.status === 'waiting' && !old.manual && !reused.has(old.id) ? old : newSet(cityId, day);
          reused.add(s.id);
        }
        let moved = 0;
        for (const it of its) if (it.set_id !== s.id) { it.set_id = s.id; moved++; }
        targets.push({ g, s, ids, join: ok, moved });
      }
      // every set that gained or lost photos, worked out again
      const changed = new Set();
      for (const id of new Set([...touched, ...targets.filter(Boolean).map((t) => t.s.id)])) { const s = setById(id); if (s && refresh(s)) changed.add(id); }
      const multi = db().branches.filter((b) => b.city_id === Number(cityId)).length > 1;
      const inCity = (u) => u.visit_date === day && branch(u.branch_id)?.city_id === Number(cityId) && IN_LIST.includes(u.status);
      const autoVisits = new Set();
      for (const t of targets) {
        if (!t) continue;
        const { g, s, ids } = t;
        if (t.join) {
          fileRows(s);
          touch(s);
          audit('photo_inbox_sets', 'PHOTO_JOINED', { id: s.id, item_ids: ids, patient_id: s.patient_id, visit_id: s.visit_id });
          out.joined++;
          out.sets.push({ set_id: s.id, item_ids: ids, status: 'filed' });
          continue;
        }
        const cands = Array.isArray(g.candidates) ? g.candidates : [];
        let reason = g.wait_reason ? String(g.wait_reason).slice(0, 40) : null;
        if (g.auto && Number(plan.matcher_version) >= 1) {
          const v = db().visits.find((x) => x.id === g.auto.visit_id);
          const at = (x) => (x ? Date.parse(x) : null);
          const given = g.auto.anchor_at ? Date.parse(g.auto.anchor_at) : null;
          const anchor = !v ? null : given !== null && v.checked_in_at && Math.abs(given - at(v.checked_in_at)) <= 1000 ? at(v.checked_in_at)
            : given !== null && v.started_at && Math.abs(given - at(v.started_at)) <= 1000 ? at(v.started_at) : at(v.started_at || v.checked_in_at);
          const first = s.first_at ? Date.parse(s.first_at) : NaN;
          const last = s.last_at ? Date.parse(s.last_at) : NaN;
          const why = !v ? 'no such visit'
            : !s.time_ok || s.manual || s.ai_flag || s.photo_count > MAX_AUTO_PHOTOS ? 'the photos are not clear enough'
              : v.visit_date !== day || branch(v.branch_id)?.city_id !== Number(cityId) ? 'the visit is not of this city and day'
                : s.branch_hint && v.branch_id !== s.branch_hint ? 'the visit is at another branch'
                  : v.legacy_source || !['in_treatment', 'completed'].includes(v.status) ? 'the visit is not in treatment or completed'
                    : !v.photo_required ? 'not a photo month'
                      : v.photos_uploaded || db().photos.some((p) => p.visit_id === v.id) || inbox().sets.some((x) => x.visit_id === v.id && x.status === 'filed') ? 'the visit has photos already'
                        : anchor === null || first < anchor - 10 * MIN || first > anchor + 120 * MIN ? 'the photos do not fit the visit\'s times'
                          : db().visits.some((u) => u.patient_id !== v.patient_id && inCity(u) && (!s.branch_hint || u.branch_id === s.branch_hint)
                            && (u.photo_required || PHOTO_LIKELY.test(String(u.treatment_label || ''))) && wasThere(u, first, last, false)) ? 'another photo patient may have been in the chair then'
                            : !s.branch_hint && multi && db().visits.some((u) => u.patient_id !== v.patient_id && u.branch_id !== v.branch_id && inCity(u) && wasThere(u, first, last, true))
                              ? 'no branch was chosen and another branch had a patient in the chair then'
                              : autoVisits.has(v.id) ? 'two sets for one visit' : null;
          if (!why) {
            doFile(s, { visit: v, patientId: v.patient_id, branchId: v.branch_id, occasion: occasionOf(v) }, 'auto', g.auto.rule);
            Object.assign(s, { candidates: clone(cands), matched_at: nowIso() });
            autoVisits.add(v.id);
            out.filed++;
            out.sets.push({ set_id: s.id, item_ids: ids, status: 'filed' });
            continue;
          }
          reason = 'SERVER_CHECK';
          out.server_refused.push({ set_id: s.id, why });
        }
        // (written only when something changed)
        if (changed.has(s.id) || t.moved > 0 || s.status !== 'waiting' || JSON.stringify(s.candidates) !== JSON.stringify(cands) || (s.wait_reason ?? null) !== reason) {
          Object.assign(s, { status: 'waiting', candidates: clone(cands), wait_reason: reason, matched_at: nowIso() });
          touch(s);
        }
        out.waiting++;
        out.sets.push({ set_id: s.id, item_ids: ids, status: 'waiting' });
      }
      for (const f of plan.fixed_updates || []) {
        const s = setById(f.set_id);
        if (!s || s.city_id !== Number(cityId) || s.photo_day !== day || s.status !== 'waiting' || !s.manual) continue;
        const cands = Array.isArray(f.candidates) ? f.candidates : s.candidates;
        const reason = f.wait_reason ? String(f.wait_reason).slice(0, 40) : s.wait_reason;
        if (JSON.stringify(cands) === JSON.stringify(s.candidates) && reason === s.wait_reason) continue;
        Object.assign(s, { candidates: clone(cands), wait_reason: reason, matched_at: nowIso() });
        touch(s);
      }
      const D = inbox();
      D.sets = D.sets.filter((s) => !(s.city_id === Number(cityId) && s.photo_day === day && s.status === 'waiting' && !s.manual && !D.items.some((i) => i.set_id === s.id)));
      return out;
    },
    async photoInboxFileSet(setId, { visitId = null, patientId = null, version }) {
      const s = getSet(setId);
      if (s.status !== 'waiting') fail('PHOTO_SET_STATE: these photos were already filed or set aside. The list is reloaded.');
      stale(s, version);
      return doFile(s, target(s, visitId, patientId), 'confirmed', null);
    },
    async photoInboxSetAside(setId, version) {
      const s = getSet(setId);
      if (s.status !== 'waiting') fail('PHOTO_SET_STATE: these photos were already filed or set aside. The list is reloaded.');
      stale(s, version);
      Object.assign(s, { status: 'set_aside', set_aside_reason: 'not_patient', manual: true, wait_reason: null });
      touch(s);
      return { set_aside: true };
    },
    async photoInboxPutBack(setId) {
      const s = getSet(setId);
      if (s.status !== 'set_aside') fail('PHOTO_SET_STATE: these photos are not set aside. The list is reloaded.');
      Object.assign(s, { status: 'waiting', set_aside_reason: null, manual: true, wait_reason: 'MANUAL' });
      touch(s);
      return { waiting: true };
    },
    async photoInboxSplitSet(setId, firstItemId, version) {
      const s = getSet(setId);
      if (s.status !== 'waiting') fail('PHOTO_SET_STATE: only photos waiting on "Which patient?" are split. The list is reloaded.');
      stale(s, version);
      const first = itemsOf(s.id).find((i) => i.id === firstItemId);
      if (!first || first.position <= 1) fail('PHOTO_BAD_INPUT: choose the first photo of the next patient (not the first photo of the set).');
      const b = newSet(s.city_id, s.photo_day, { manual: true, wait_reason: 'MANUAL' });
      for (const it of itemsOf(s.id)) if (it.position >= first.position) it.set_id = b.id;
      refresh(s); refresh(b);
      for (const x of [s, b]) { Object.assign(x, { manual: true, wait_reason: 'MANUAL', candidates: [] }); touch(x); }
      return { set_a: s.id, set_b: b.id };
    },
    async photoInboxMoveCity(setId, cityId, version) {
      const s = getSet(setId);
      require(cityId);
      if (s.status !== 'waiting') fail('PHOTO_SET_STATE: only photos waiting on "Which patient?" are moved to another city. The list is reloaded.');
      stale(s, version);
      if (Number(cityId) === s.city_id) return { set_id: s.id };
      for (const it of itemsOf(s.id)) { it.city_id = Number(cityId); it.branch_hint = null; }
      Object.assign(s, { city_id: Number(cityId), branch_hint: null, manual: true, wait_reason: 'MANUAL', candidates: [] });
      touch(s);
      return { set_id: s.id };
    },
    async photoInboxUnfileSet(setId) {
      const s = getSet(setId);
      requireDelete();
      if (s.status !== 'filed') fail('PHOTO_SET_STATE: these photos are not filed. The list is reloaded.');
      const n = removeRows((p) => p.intake_set_id === s.id && p.kind === 'edited') + removeRows((p) => p.intake_set_id === s.id);
      for (const it of itemsOf(s.id)) { it.raw_photo_id = null; it.edited_photo_id = null; }
      const unticked = untick(s.visit_id);
      audit('photo_inbox_sets', 'PHOTO_UNFILED', { id: s.id, patient_id: s.patient_id, visit_id: s.visit_id, removed_photos: n });
      Object.assign(s, { status: 'waiting', manual: true, wait_reason: 'UNDONE', patient_id: null, visit_id: null, branch_id: null, occasion: null, filed_how: null,
        filed_rule: null, filed_by: null, filed_at: null, release_after: null, hidden: false });
      touch(s);
      return { removed_photos: n, visit_unticked: unticked };
    },
    async photoInboxMoveSet(setId, { visitId = null, patientId = null }) {
      const s = getSet(setId);
      requireDelete();
      if (s.status !== 'filed') fail('PHOTO_SET_STATE: these photos are not filed. The list is reloaded.');
      const t = target(s, visitId, patientId);
      const release = new Date(Date.now() + hold()).toISOString();
      let n = 0;
      for (const p of db().photos.filter((x) => x.intake_set_id === s.id)) {
        const it = inbox().items.find((i) => i.id === p.intake_item_id);
        Object.assign(p, { patient_id: t.patientId, visit_id: t.visit?.id || null, branch_id: t.branchId ?? s.branch_hint, braces_month: t.visit?.braces_month ?? null,
          occasion: t.occasion, view_label: label(t.occasion, p.view_key, it?.position), taken_on: it ? takenOn(it, t.visit?.visit_date) : p.taken_on,
          release_after: p.kind === 'edited' ? release : p.release_after });
        audit('photos', 'UPDATE', p);
        n++;
      }
      if (t.visit?.id) visitTick(t.visit.id);
      if (s.visit_id !== (t.visit?.id || null)) untick(s.visit_id);
      audit('photo_inbox_sets', 'PHOTO_MOVED', { id: s.id, from: s.patient_id, to: t.patientId, photos: n });
      Object.assign(s, { patient_id: t.patientId, visit_id: t.visit?.id || null, branch_id: t.branchId ?? s.branch_hint, occasion: t.occasion, release_after: release,
        filed_by: me()?.id || null, filed_at: nowIso() });
      touch(s);
      // (a set left without a patient: its rows are made for the new patient)
      return { moved_photos: n + fileRows(s) };
    },
    async photoInboxTakeOut(itemId) {
      const it = inbox().items.find((i) => i.id === itemId);
      if (!it?.set_id) { require(null); fail('PHOTO_SET_STATE: that photo is not in a filed set. The list is reloaded.'); }
      const s = getSet(it.set_id);
      requireDelete();
      if (s.status !== 'filed') fail('PHOTO_SET_STATE: that photo is not in a filed set. The list is reloaded.');
      removeRows((p) => p.intake_item_id === it.id && p.kind === 'edited');
      removeRows((p) => p.intake_item_id === it.id);
      const b = newSet(s.city_id, s.photo_day, { status: 'set_aside', set_aside_reason: 'taken_out', manual: true });
      Object.assign(it, { set_id: b.id, raw_photo_id: null, edited_photo_id: null });
      refresh(s); refresh(b); untick(s.visit_id); touch(s);
      return { set_id: b.id };
    },
    async photoInboxHideSet(setId, hidden) {
      const s = getSet(setId);
      if (s.status !== 'filed') fail('PHOTO_SET_STATE: these photos are not filed. The list is reloaded.');
      s.hidden = !!hidden;
      touch(s);
      let n = 0;
      for (const p of db().photos) if (p.intake_set_id === s.id && p.kind === 'edited') { p.held_back = !!hidden || s.ai_flag === 'mixed_people'; n++; }
      return { photos: n };
    },
    async photoInboxResolveFlag(setId) {
      const s = getSet(setId);
      s.ai_flag = null;
      touch(s);
      for (const p of db().photos) if (p.intake_set_id === s.id && p.kind === 'edited') p.held_back = !!s.hidden;
      return { ok: true };
    },
    async photoInboxCounts() {
      if (!allowed()) return { waiting: 0, check: 0 };
      const mine = inbox().sets.filter((s) => cityOk(s.city_id));
      return { waiting: mine.filter((s) => s.status === 'waiting').length, check: mine.filter((s) => s.status === 'filed' && (s.ai_flag || !s.patient_id)).length };
    },
    async photoInboxClaimEdits(limit = 8, canHeic = false, lease = null) {
      require(null);
      const token = lease || me()?.id;
      const cand = inbox().items.filter((i) => i.set_id && setById(i.set_id)?.status !== 'set_aside' && cityOk(i.city_id) && claimable(i, canHeic, token));
      if (!cand.length) return [];
      const sets = [...new Set(cand.map((i) => i.set_id))].map(setById).sort((a, b) => (Number(b.status === 'filed') - Number(a.status === 'filed'))
        || a.photo_day.localeCompare(b.photo_day) || String(a.first_at || '~').localeCompare(String(b.first_at || '~')));
      const s = sets[0];
      const picked = cand.filter((i) => i.set_id === s.id).sort((a, b) => (a.position ?? 99) - (b.position ?? 99)).slice(0, Math.min(10, Math.max(1, limit)));
      const until = new Date(Date.now() + 10 * MIN).toISOString();
      for (const i of picked) { i.edit_lease_until = until; i.edit_lease_by = token; }
      // the set's reference photo for Claude: one it already answered, just before these
      const firstPending = Math.min(...picked.filter((i) => i.ai_status === 'pending').map((i) => i.position ?? 99), 32767);
      const ref = itemsOf(s.id).filter((i) => i.ai_status === 'done' && i.ai_result?.kind !== 'not_clinical')
        .sort((a, b) => (Number((b.position ?? 0) < firstPending) - Number((a.position ?? 0) < firstPending)) || (Math.abs((a.position ?? 0) - firstPending) - Math.abs((b.position ?? 0) - firstPending)))[0] || null;
      return picked.map((i) => ({ item_id: i.id, set_id: i.set_id, set_status: s.status, city_slug: citySlug(city(i.city_id).name), photo_day: i.photo_day, sha256: i.sha256,
        storage_path: i.storage_path, mime_type: i.mime_type, orientation: i.orientation, width: i.width, height: i.height, position: i.position,
        ai_status: i.ai_status, ai_result: clone(i.ai_result), edit_status: i.edit_status, edit_round: i.edit_round,
        ref_item_id: ref?.id || null, ref_storage_path: ref?.storage_path || null, ref_mime_type: ref?.mime_type || null }));
    },
    async photoInboxRenewEdits(itemIds, lease) {
      require(null);
      const until = new Date(Date.now() + 10 * MIN).toISOString();
      let n = 0;
      for (const i of inbox().items) if (itemIds.includes(i.id) && i.edit_lease_by === lease && i.edit_status !== 'done') { i.edit_lease_until = until; n++; }
      return n;
    },
    async photoInboxSaveEdit({ itemId, editedPath, editedThumbPath = null, editVersion = EDIT_VERSION, basic = false, lease = null }) {
      const it = inbox().items.find((i) => i.id === itemId);
      if (!it) { require(null); fail('PHOTO_SET_STATE: that photo is not there any more.'); }
      require(it.city_id);
      if (!leaseFree(it, lease || me()?.id)) fail('PHOTO_SET_STATE: another page is editing this photo.');
      const dir = it.storage_path.slice(0, it.storage_path.lastIndexOf('/') + 1);
      const round = it.edit_round > 1 ? `-r${it.edit_round}` : '';
      const want = `${dir}edited/${it.sha256}${round}.jpg`;
      if (editedPath !== want || (editedThumbPath && editedThumbPath !== `${dir}edited/thumbs/${it.sha256}${round}.jpg`)) fail('PHOTO_BAD_INPUT: the edited copy is not where it belongs.');
      if (!store().has(want)) fail('PHOTO_FILE_MISSING: the edited photo did not finish uploading.');
      Object.assign(it, { edited_path: want, edited_thumb_path: editedThumbPath && store().has(editedThumbPath) ? editedThumbPath : null, edit_status: 'done',
        edit_basic: !!basic, edit_version: editVersion, edit_lease_until: null, edit_lease_by: null });
      const s = setById(it.set_id);
      if (s?.status === 'filed' && it.raw_photo_id) {
        const raw = db().photos.find((p) => p.id === it.raw_photo_id);
        const key = viewKeyOf(it);
        if (raw) { raw.view_key = key; raw.view_label = label(s.occasion, key, it.position); }
        fileRows(s);
      }
      return { edited_photo_id: it.edited_photo_id };
    },
    async photoInboxEditFailed(itemId, code, lease = null) {
      const it = inbox().items.find((i) => i.id === itemId);
      if (!it) { require(null); fail('PHOTO_SET_STATE: that photo is not there any more.'); }
      require(it.city_id);
      if (!['HEIC_DECODE', 'DECODE', 'UPLOAD', 'OTHER'].includes(code)) fail('PHOTO_BAD_INPUT: unknown problem code.');
      if (it.edit_status !== 'done' && leaseFree(it, lease || me()?.id)) {
        Object.assign(it, { edit_status: code === 'HEIC_DECODE' ? 'needs_safari' : 'failed', edit_attempts: Math.min(99, it.edit_attempts + 1), edit_lease_until: null, edit_lease_by: null });
      }
      return { edit_status: it.edit_status };
    },
    async photoInboxRedoEdits(setId) {
      const s = getSet(setId);
      let n = 0;
      for (const i of itemsOf(s.id)) {
        if (!((i.edit_status === 'done' && i.edit_basic) || (i.edit_status === 'failed' && i.edit_attempts >= 3) || (i.edit_status === 'needs_safari' && i.edit_attempts >= 3))) continue;
        const again = ['failed', 'refused'].includes(i.ai_status) || (i.edit_status === 'done' && i.edit_basic);
        Object.assign(i, { ai_status: again ? 'pending' : i.ai_status, ai_attempts: again ? 0 : i.ai_attempts, edit_round: i.edit_status === 'done' ? i.edit_round + 1 : i.edit_round,
          edit_status: ['done', 'failed'].includes(i.edit_status) ? 'pending' : i.edit_status, edit_attempts: 0, edit_lease_until: null, edit_lease_by: null });
        n++;
      }
      return { photos: n };
    },
    async photoInboxUploadEdit({ path, thumbPath = null, blob, thumb = null }) {
      if (!can('photos.intake') || !folderOk(path)) throw Object.assign(new Error('NOT_ALLOWED: Your login cannot upload into the Photo inbox (needs "Use the Photo inbox").'), { code: 'NOT_ALLOWED' });
      putFile(path, blob);
      if (thumb && thumbPath) putFile(thumbPath, thumb);
      return { path, thumbPath: thumb && thumbPath ? thumbPath : null };
    },
    async photoAiStatus() { return aiStatus(); },
    async photoAiAnalyze(setId, items) {
      if (!allowed()) return { ok: false, code: 'NOT_ALLOWED' };
      const mode = aiMode();
      if (mode === 'off') return { ok: false, code: 'NO_KEY' };
      const s = setById(setId);
      if (!s) return { ok: false, code: 'NOT_ALLOWED' };
      // each photo of that set; the ones to answer still wait for Claude; a reference photo only for the one-sitting check
      const list = items.filter((x) => { const it = inbox().items.find((i) => i.id === x.item_id); return it && it.set_id === s.id && (x.reference || it.ai_status === 'pending'); });
      const answer = list.filter((x) => !x.reference);
      if (!answer.length) return { ok: true, status: 'skipped', results: [], cost_usd: 0, served_model: null };
      const call = { set_id: setId, item_ids: answer.map((x) => x.item_id), photo_count: list.length, model: 'claude-opus-5-5', served_model: 'claude-opus-5-5', fallback_used: false,
        stop_reason: 'end_turn', error_code: null, input_tokens: 1200 * list.length, output_tokens: 250 * list.length, cache_creation_input_tokens: 0, cache_read_input_tokens: 1500,
        cost_usd: 0.01, one_sitting: 'yes', duration_ms: 5, request_id: 'demo' };
      const ERRORS = { RATE_LIMIT: { retry_after: 5 }, API_DOWN: {}, BAD_REQUEST: {}, BILLING: {}, BAD_KEY: {}, CONFIG: {} };
      if (ERRORS[mode]) {
        record({ ...call, status: 'error', error_code: mode, stop_reason: null, output_tokens: 0, cost_usd: 0 }, []);
        return { ok: false, code: mode, ...ERRORS[mode] };
      }
      if (mode === 'refused' || mode === 'invalid') {
        record({ ...call, status: mode, stop_reason: mode === 'refused' ? 'refusal' : 'end_turn', one_sitting: null }, []);
        return { ok: true, status: mode, results: [], cost_usd: 0.01, served_model: 'claude-opus-5-5' };
      }
      const offset = list.length - answer.length; // the reference photo is Photo 1
      const results = answer.map((x) => {
        const it = inbox().items.find((i) => i.id === x.item_id);
        const view = FAKE_VIEWS[((it.position || 1) - 1) % FAKE_VIEWS.length];
        return { item_id: x.item_id, result: { index: list.indexOf(x) + 1, kind: view.startsWith('face_') ? 'extraoral' : 'intraoral', view, confidence: 'high',
          rotate: view === 'intra_left' ? 90 : 0, mirror: ['intra_right', 'intra_upper', 'intra_lower'].includes(view), straighten: view === 'intra_right' ? 4 : 0,
          crop: { left: 0.05, top: 0.05, right: 0.95, bottom: 0.95 }, exposure: 'ok', color_cast: view === 'intra_front' ? 'warm' : 'none', issues: [] } };
      });
      record({ ...call, status: 'ok', reference_photos: offset }, results);
      return { ok: true, status: 'ok', results, cost_usd: 0.01, served_model: 'claude-opus-5-5' };
    },
    async photoBlob(path) {
      const f = store().get(path);
      if (f) return f.blob;
      const row = db().photos.find((p) => p.storage_path === path);
      if (row?.url) return (await fetch(row.url)).blob();
      throw Object.assign(new Error('NOT_ALLOWED: this photo cannot be opened from your login.'), { code: 'NOT_ALLOWED' });
    },
    async photoDownloadUrl(path) {
      return urlOf(path) || db().photos.find((p) => p.storage_path === path)?.url || null;
    },
    async photoLibrary({ q = '', cityId = null, branchId = null, month = null, view = '', from = null, to = null, kind = 'edited', patientId = null, limit = 120, offset = 0 } = {}) {
      const s = me();
      if (!s || !can('patients.view')) return { total: 0, rows: [] };
      const want = kind === 'raw' ? 'raw' : 'edited';
      const sees = (ph) => (ph.kind === 'edited' && can('patients.view')) || can('photos.view_raw') || (!!ph.uploaded_by && ph.uploaded_by === s.id && can('photos.upload'));
      const text = String(q || '').trim();
      const hits = db().photos.filter((ph) => ph.kind === want && ph.patient_id && sees(ph)).map((ph) => ({ ph, p: patient(ph.patient_id) })).filter(({ ph, p }) => p
        && (!patientId || ph.patient_id === patientId) && (!cityId || branch(ph.branch_id)?.city_id === Number(cityId)) && (!branchId || ph.branch_id === Number(branchId))
        && (!month || ph.braces_month === Number(month)) && (!view || ph.view_key === view) && (!from || ph.taken_on >= from) && (!to || ph.taken_on <= to)
        && (!text || p.mr_number.toUpperCase().startsWith(text.toUpperCase()) || p.full_name.toLowerCase().includes(text.toLowerCase())))
        .sort((a, b) => String(b.ph.taken_on).localeCompare(String(a.ph.taken_on)) || String(b.ph.created_at || '').localeCompare(String(a.ph.created_at || '')));
      const lim = Math.min(300, Math.max(1, limit));
      return { total: hits.length, rows: hits.slice(offset, offset + lim).map(({ ph, p }) => ({
        id: ph.id, patient_id: ph.patient_id, mr_number: p.mr_number, full_name: p.full_name, kind: ph.kind, taken_on: ph.taken_on, braces_month: ph.braces_month ?? null,
        occasion: ph.occasion ?? null, view_key: ph.view_key ?? null, view_label: ph.view_label ?? null, storage_path: ph.storage_path, thumb_path: ph.thumb_path ?? null,
        branch_id: ph.branch_id ?? null, visit_id: ph.visit_id ?? null, intake_item_id: ph.intake_item_id ?? null, edited_from: ph.edited_from ?? null, created_at: ph.created_at ?? null })) };
    },
    async photoAiCosts() {
      if (!(me()?.role === 'admin' || can('finance.view'))) fail('NOT_ALLOWED: the cost of Claude editing is for Dr. Ali and accounts.');
      const months = new Map();
      for (const c of inbox().calls) {
        const m = karachiDate(c.created_at).slice(0, 7);
        const row = months.get(m) || { month: m, calls: 0, photos: 0, refused: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0 };
        row.calls++; if (c.status === 'ok') row.photos += c.photo_count; if (c.status === 'refused') row.refused++;
        row.input_tokens += c.input_tokens; row.output_tokens += c.output_tokens; row.cache_read_tokens += c.cache_read_input_tokens;
        row.cost_usd = Math.round((row.cost_usd + Number(c.cost_usd)) * 100000) / 100000;
        months.set(m, row);
      }
      return [...months.values()].sort((a, b) => b.month.localeCompare(a.month));
    },
    /**
     * For the demo's profile Delete (private.photo_inbox_photo_gone): an inbox photo names no file (the original stays in the inbox); its
     * other row goes too and the photo is taken out of its filed set and set aside, so it never comes back by itself.
     */
    inboxPhotoDeleted(photo) {
      const it = inbox().items.find((i) => i.id === photo.intake_item_id);
      if (!it) return;
      removeRows((p) => p.intake_item_id === it.id && p.id !== photo.id);
      const s = setById(it.set_id);
      if (s?.status === 'filed') {
        const b = newSet(s.city_id, s.photo_day, { status: 'set_aside', set_aside_reason: 'taken_out', manual: true });
        Object.assign(it, { set_id: b.id, raw_photo_id: null, edited_photo_id: null });
        refresh(s); refresh(b); touch(s);
        audit('photo_inbox_sets', 'PHOTO_TAKEN_OUT', { id: s.id, item_id: it.id, set_id: b.id, via: 'Delete on the patient profile' });
        if (!itemsOf(s.id).length) inbox().sets = inbox().sets.filter((x) => x !== s);
      } else Object.assign(it, { raw_photo_id: null, edited_photo_id: null });
    },
    /** For the demo's merge of two patients: the Photo inbox sets follow the photo rows (private.photo_inbox_photo_moved). */
    inboxPatientMerged(keepId, removeId) {
      for (const s of inbox().sets) if (s.patient_id === removeId) { s.patient_id = keepId; touch(s); }
    },
    inboxUrl: urlOf,
  };
}
