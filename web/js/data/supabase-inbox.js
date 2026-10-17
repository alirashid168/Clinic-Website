// LIVE data layer for the Photo inbox and the Photo library (supabase/migrations/20261017000200_photo_intake.sql; the photo-ai Edge
// Function). supabase.js spreads these methods into its adapter; data/demo-inbox.js has the same methods with the same answers.
// Every request runs as the signed-in person: the database functions check "Use the Photo inbox", "View raw clinic photos folder" and
// the city, and the storage rules decide which files they may store and read.
//
// While the migration is not applied PostgREST answers PGRST202 (or Postgres 42883): every method then throws one error with the code
// PHOTO_INBOX_MISSING and the page shows only that. Errors from the functions keep their code word (PHOTO_STALE, PHOTO_STALE_PLAN, ...)
// at the start of the message and in e.photoCode.
import { inboxPaths } from '../lib/photo-intake.js';

const MISSING_CODES = new Set(['PGRST202', '42883', 'PGRST205', '42P01']);
export const PHOTO_INBOX_MISSING_TEXT = 'PHOTO_INBOX_MISSING: The Photo inbox needs the database update of 17 Oct (20261017000200_photo_intake.sql). Ask Dr. Ali to apply it.';
/** The note box and old photos (20261017000600_photo_inbox_notes.sql) before that update is applied. */
export const PHOTO_NOTES_MISSING_TEXT = 'PHOTO_NOTES_MISSING: The note box and old photos need the database update of 17 Oct (20261017000600_photo_inbox_notes.sql). Ask Dr. Ali to apply it.';
/** The text box with each photo (20261017000800_photo_item_notes.sql) before that update is applied. */
export const PHOTO_ITEM_NOTES_MISSING_TEXT = 'PHOTO_ITEM_NOTES_MISSING: A note with each photo needs the database update of 17 Oct (20261017000800_photo_item_notes.sql). Ask Dr. Ali to apply it.';
const CODE_WORD = /^(PHOTO_[A-Z_]+|NOT_ALLOWED|STORAGE_FULL|TOO_LARGE|NETWORK):/;

/**
 * What Storage's answer to an upload means: already there, too large, storage full, not allowed, a connection problem, or something else.
 * The status code decides first (a rate limit or a gateway error whose message says "exceeded" is a connection problem to retry, not a
 * full storage); the words only when there is no telling status.
 */
export function storageProblem(error) {
  if (!error) return null;
  const status = Number(error.status || error.statusCode || error.originalError?.status || 0);
  const msg = String(error.message || error.error || '');
  if (status === 409 || /already exists|duplicate/i.test(msg)) return 'ALREADY';
  if (status === 413 || /maximum allowed size|payload too large|object too large|exceeded the maximum allowed size/i.test(msg)) return 'TOO_LARGE';
  if (status === 402) return 'STORAGE_FULL';
  if (status === 401 || status === 403) return 'NOT_ALLOWED';
  if (status === 429 || status === 408 || status >= 500) return 'NETWORK';
  if (/storage quota|quota exceeded|exceed(ed)? (the |your )?(storage )?quota|insufficient storage|storage limit|spend cap|payment required/i.test(msg)) return 'STORAGE_FULL';
  if (/row-level security|unauthori[sz]ed|not allowed|permission/i.test(msg)) return 'NOT_ALLOWED';
  if (!status || /fetch|network|timed? ?out|load failed|rate limit/i.test(msg) || error.name === 'StorageUnknownError') return 'NETWORK';
  return 'OTHER';
}
const STORAGE_TEXT = {
  TOO_LARGE: 'TOO_LARGE: Larger than the storage allows (50 MB).',
  STORAGE_FULL: 'STORAGE_FULL: The clinic\'s photo storage is full, so nothing more can be uploaded now. The photos already uploaded are safe. Dr. Ali: Supabase dashboard -> Billing (turn off the spend cap or add space), then press Try again.',
  NOT_ALLOWED: 'NOT_ALLOWED: Your login cannot upload into the Photo inbox (needs "Use the Photo inbox").',
  NETWORK: 'NETWORK: The upload did not get through (connection). It is tried again.',
};

export function inboxLive({ sb, callRpc, check, plainError, signedUrls }) {
  const store = () => sb.storage.from('clinic-photos');
  const missing = (e) => !!e && (MISSING_CODES.has(e.code) || e.status === 404);
  /** A Photo inbox database function; "not installed" is one error (PHOTO_INBOX_MISSING); a code word is kept in e.photoCode. */
  async function rpc(name, args) {
    const res = await callRpc(name, args);
    if (res.error && missing({ code: res.error.code, status: res.status })) throw plainError(PHOTO_INBOX_MISSING_TEXT, 'PHOTO_INBOX_MISSING');
    try { return check(res); } catch (e) {
      const m = CODE_WORD.exec(e.message || '');
      if (m) e.photoCode = m[1];
      throw e;
    }
  }
  /** Stores one file (never replaces one: "already exists" means an earlier attempt stored it). Returns true when it was there already. */
  async function put(path, blob, contentType) {
    const { error } = await store().upload(path, blob, { contentType: contentType || blob.type || 'application/octet-stream', upsert: false });
    const problem = storageProblem(error);
    if (!problem) return false;
    if (problem === 'ALREADY') return true;
    if (STORAGE_TEXT[problem]) throw Object.assign(new Error(STORAGE_TEXT[problem]), { code: problem, photoCode: problem });
    throw Object.assign(new Error(error.message || 'The upload failed.'), { code: 'OTHER' });
  }
  /** Calls the photo-ai Edge Function; its own answer is read out of a refused call too ({ ok: false, code }). */
  async function photoAi(body) {
    const { data, error } = await sb.functions.invoke('photo-ai', { body });
    if (!error) return data;
    const status = error.context?.status;
    let sent = null;
    try { sent = await error.context?.json?.(); } catch { /* no readable body */ }
    if (sent && typeof sent === 'object' && 'ok' in sent) return sent;
    if (status === 404) return { ok: false, code: 'NOT_DEPLOYED' };
    if (error.name === 'FunctionsFetchError' || error.name === 'FunctionsRelayError' || !status || status >= 500) return { ok: false, code: 'NETWORK' };
    return { ok: false, code: 'SERVER', status };
  }
  const chunks = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

  return {
    async photoInboxCities() { return (await rpc('photo_inbox_cities', {})) || []; },
    async photoInboxKnown(hashes) {
      const out = [];
      for (const part of chunks([...new Set(hashes)], 500)) out.push(...((await rpc('photo_inbox_known', { p_hashes: part })) || []));
      return out;
    },
    /** The original (and its small copy, best effort) into the inbox: { path, thumbPath, already }. Throws STORAGE_FULL / TOO_LARGE / NETWORK / NOT_ALLOWED. */
    async photoInboxUpload({ citySlug, day, sha, ext, file, thumb, mime }) {
      const p = inboxPaths({ citySlug, day, sha, ext });
      const already = await put(p.path, file, mime || file.type);
      let thumbPath = null;
      if (thumb) {
        try { await put(p.thumb, thumb, 'image/jpeg'); thumbPath = p.thumb; } catch (e) { if (e.code === 'STORAGE_FULL') throw e; }
      }
      return { path: p.path, thumbPath, already };
    },
    /**
     * An upload starts (before its photos are registered): its city folder, kind ('day': today's photos; 'old': old photos, already edited)
     * and the note typed with it. Before the update of the notes: PHOTO_NOTES_MISSING (the page then uploads today's photos without a note
     * as before).
     */
    async photoInboxStartBatch({ batchId, cityId, kind = 'day', note = null }) {
      try {
        return await rpc('photo_inbox_start_batch', { p_batch: batchId, p_city: Number(cityId), p_kind: kind, p_note: note || null });
      } catch (e) {
        if (e.code === 'PHOTO_INBOX_MISSING') throw plainError(PHOTO_NOTES_MISSING_TEXT, 'PHOTO_NOTES_MISSING');
        throw e;
      }
    },
    /**
     * The note of one photo, typed after it was registered: { item_id, note, changed }. Before the update of the photo notes:
     * PHOTO_ITEM_NOTES_MISSING (the page then says so next to the box).
     */
    async photoInboxItemNote(itemId, note) {
      try {
        return await rpc('photo_inbox_item_note', { p_item: itemId, p_note: note || null });
      } catch (e) {
        if (e.code === 'PHOTO_INBOX_MISSING') throw plainError(PHOTO_ITEM_NOTES_MISSING_TEXT, 'PHOTO_ITEM_NOTES_MISSING');
        throw e;
      }
    },
    /** Registers stored photos ({ ..., note }: a note typed with a photo comes with it); answers [{ sha256, item_id, state, city_id, photo_day, note }]. */
    async photoInboxAddItems(items) {
      const out = [];
      for (const part of chunks(items, 20)) out.push(...((await rpc('photo_inbox_add_items', { p_items: part })) || []));
      return out;
    },
    async photoInboxOverview(cityId) { return rpc('photo_inbox_overview', { p_city: Number(cityId) }); },
    async photoInboxDay(cityId, day) { return rpc('photo_inbox_day', { p_city: Number(cityId), p_day: day }); },
    async photoInboxApply(cityId, day, plan) { return rpc('photo_inbox_apply', { p_city: Number(cityId), p_day: day, p_plan: plan }); },
    async photoInboxFileSet(setId, { visitId = null, patientId = null, version }) {
      return rpc('photo_inbox_file_set', { p_set: setId, p_visit: visitId, p_patient: patientId, p_version: version });
    },
    async photoInboxSetAside(setId, version) { return rpc('photo_inbox_set_aside', { p_set: setId, p_version: version }); },
    async photoInboxPutBack(setId) { return rpc('photo_inbox_put_back', { p_set: setId }); },
    async photoInboxSplitSet(setId, firstItemId, version) { return rpc('photo_inbox_split_set', { p_set: setId, p_first_item: firstItemId, p_version: version }); },
    async photoInboxMoveCity(setId, cityId, version) { return rpc('photo_inbox_move_city', { p_set: setId, p_city: Number(cityId), p_version: version }); },
    async photoInboxUnfileSet(setId) { return rpc('photo_inbox_unfile_set', { p_set: setId }); },
    async photoInboxMoveSet(setId, { visitId = null, patientId = null }) { return rpc('photo_inbox_move_set', { p_set: setId, p_visit: visitId, p_patient: patientId }); },
    async photoInboxTakeOut(itemId) { return rpc('photo_inbox_take_out', { p_item: itemId }); },
    async photoInboxHideSet(setId, hidden) { return rpc('photo_inbox_hide_set', { p_set: setId, p_hidden: !!hidden }); },
    async photoInboxResolveFlag(setId) { return rpc('photo_inbox_resolve_flag', { p_set: setId }); },
    /** The badge: { waiting, check }; zeros on any problem (it must never stop a page). */
    async photoInboxCounts() {
      try { const r = await rpc('photo_inbox_counts', {}); return { waiting: Number(r?.waiting) || 0, check: Number(r?.check) || 0 }; } catch { return { waiting: 0, check: 0 }; }
    },
    /** Photos of one set to edit, held for this page (lease: a token of the page) for 10 minutes. */
    async photoInboxClaimEdits(limit = 8, canHeic = false, lease = null) { return (await rpc('photo_inbox_claim_edits', { p_limit: limit, p_can_heic: !!canHeic, p_lease: lease })) || []; },
    async photoInboxRenewEdits(itemIds, lease) { return rpc('photo_inbox_renew_edits', { p_items: itemIds, p_lease: lease }); },
    async photoInboxSaveEdit({ itemId, editedPath, editedThumbPath = null, editVersion, basic = false, lease = null }) {
      return rpc('photo_inbox_save_edit', { p_item: itemId, p_edited_path: editedPath, p_edited_thumb_path: editedThumbPath, p_edit_version: editVersion, p_basic: !!basic, p_lease: lease });
    },
    async photoInboxEditFailed(itemId, code, lease = null) { return rpc('photo_inbox_edit_failed', { p_item: itemId, p_code: code, p_lease: lease }); },
    /** "Try Claude again": the set's basic edits (and photos whose editing failed) go back to Claude. */
    async photoInboxRedoEdits(setId) { return rpc('photo_inbox_redo_edits', { p_set: setId }); },
    /** The edited copy and its small copy (already there = an earlier attempt stored them). */
    async photoInboxUploadEdit({ path, thumbPath = null, blob, thumb = null }) {
      await put(path, blob, 'image/jpeg');
      let stored = null;
      if (thumb && thumbPath) { try { await put(thumbPath, thumb, 'image/jpeg'); stored = thumbPath; } catch (e) { if (e.code === 'STORAGE_FULL') throw e; } }
      return { path, thumbPath: stored };
    },
    /**
     * Whether Claude editing is set up: { key: true | false }; { key: false, code: 'NOT_DEPLOYED' } when the function is not there; and
     * { key: null, code } when it could not be asked just now (connection, login): not known, asked again later.
     */
    async photoAiStatus() {
      const r = await photoAi({ action: 'status' });
      if (r?.ok) return { key: !!r.key, model: r.model };
      if (r?.code === 'NOT_DEPLOYED') return { key: false, missing: true, code: r.code };
      return { key: null, code: r?.code || 'NETWORK' };
    },
    async photoAiAnalyze(setId, items) { return photoAi({ action: 'analyze', set_id: setId, items }); },
    /** A stored photo as a Blob (a signed link, then the file). */
    async photoBlob(path) {
      const url = (await signedUrls([path], { expiresIn: 600 })).get(path);
      if (!url) throw Object.assign(new Error('NOT_ALLOWED: this photo cannot be opened from your login.'), { code: 'NOT_ALLOWED' });
      const res = await fetch(url);
      if (!res.ok) throw Object.assign(new Error(`NETWORK: the photo could not be downloaded (${res.status}).`), { code: 'NETWORK' });
      return res.blob();
    },
    /** A 10-minute link that saves the photo under its proper name. */
    async photoDownloadUrl(path, name) {
      const { data, error } = await store().createSignedUrl(path, 600, { download: name || true });
      if (error) check({ error });
      return data?.signedUrl || null;
    },
    async photoLibrary({ q = '', cityId = null, branchId = null, month = null, view = '', from = null, to = null, kind = 'edited', patientId = null, limit = 120, offset = 0 } = {}) {
      const r = await rpc('photo_library', {
        p_query: String(q || '').trim() || null, p_city: cityId ? Number(cityId) : null, p_branch: branchId ? Number(branchId) : null,
        p_month: month ? Number(month) : null, p_view: view || null, p_from: from || null, p_to: to || null, p_kind: kind === 'raw' ? 'raw' : 'edited',
        p_patient: patientId || null, p_limit: limit, p_offset: offset,
      });
      return { total: Number(r?.total) || 0, rows: r?.rows || [] };
    },
    async photoAiCosts(months = 12) { return (await rpc('photo_ai_costs', { p_months: months })) || []; },
  };
}
