// The Photo inbox (owner, 17 Oct 2026: "i just want to upload all those pictures in one place, and you see the pictures, and see the
// time they are taken, and match them with the patient time at the clinic from the website, and then edit and upload it in the
// patient's file"). Pure functions, no DOM, no storage, so every rule can be tested in Node (tests/photo-intake.test.ts):
//   - reading a photo's capture time and camera from its EXIF (readExif, captureTime), its file counter (fileSeq), its type (sniffType);
//   - grouping a day's photos into sets, one patient's sitting each (groupItems);
//   - matching the WHOLE day's sets to the city's visits of that day, keeping time order, and deciding which sets are filed by
//     themselves and which wait on "Which patient?" (visitFacts, scorePair, assignDay, planDay, planUnchanged);
//   - names and labels (viewName, viewLabel, downloadName, uniqueNames) and the edit geometry and pixel maths (editPlan, adjustPixels).
// The browser glue is web/js/ui/photo-edit.js; the pages are web/js/views/staff/photo-inbox.js and photo-library.js. The rules are in
// .omc/handoffs/photo-intake-time-spec.md (sections 5-10) and docs/PHOTO-INTAKE.md. Times are Asia/Karachi (+05:00, no summer time).

// ---------------------------------------------------------------- constants (first guesses: tune after the first real days)
export const GAP_SEC = 180; // a pause longer than this starts a new set (a sitting's shots are seconds to 2 minutes apart)
export const SPAN_SEC = 900; // a set never runs longer than this from its first photo
export const SEQ_JUMP = 30; // the camera's file counter jumping more than this (or going back) starts a new set
export const MAX_AUTO_PHOTOS = 20; // more photos than this in one set is never filed by itself
export const MIN_PAIR = 60; // a set and a patient are paired by the day's assignment only from this score up
export const MATCHER_VERSION = 1;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const THUMB_EDGE = 320; // px, long edge of every small copy
export const THUMB_QUALITY = 0.8;
export const AI_EDGE = 1024; // px, long edge of the copy Claude sees
export const AI_QUALITY = 0.8;
export const EDIT_EDGE = 2048; // px, long edge of the edited copy (never enlarged)
export const EDIT_QUALITY = 0.85;
export const EDIT_VERSION = 1;
const MIN = 60 * 1000;
const KARACHI_OFFSET_MIN = 300;

// The views Claude names (same list as supabase/functions/photo-ai/core.ts; a Node test compares them) and their display names, used in
// labels ("Month 6 · Front") and download names.
export const VIEW_KEYS = ['intra_front', 'intra_right', 'intra_left', 'intra_upper', 'intra_lower', 'intra_overjet', 'intra_closeup',
  'face_front', 'face_smile', 'face_profile_right', 'face_profile_left', 'face_oblique', 'xray', 'document', 'other'];
export const VIEW_NAMES = {
  intra_front: 'Front', intra_right: 'Right side', intra_left: 'Left side', intra_upper: 'Upper arch', intra_lower: 'Lower arch',
  intra_overjet: 'Overjet', intra_closeup: 'Close-up', face_front: 'Face front', face_smile: 'Face smile', face_profile_right: 'Profile right',
  face_profile_left: 'Profile left', face_oblique: 'Face three-quarter', xray: 'X-ray', document: 'Document', other: 'Other',
};
export const KINDS = ['intraoral', 'extraoral', 'xray', 'document', 'not_clinical'];
export const viewName = (key) => (key && VIEW_NAMES[key]) || null;

// ---------------------------------------------------------------- Karachi time
/** 'YYYY-MM-DD' of a moment (ms or ISO) in Karachi. */
export function karachiDate(t) {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + KARACHI_OFFSET_MIN * MIN).toISOString().slice(0, 10);
}
/** Minutes after Karachi midnight. */
export function karachiMinutes(t) {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + KARACHI_OFFSET_MIN * MIN);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
/** "6:35 PM" in Karachi. */
export function karachiClock(t) {
  const m = karachiMinutes(t);
  if (m === null) return '';
  const h = Math.floor(m / 60);
  return `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'YYYY-MM-DD' -> "Thu 16 Oct". */
export function dayLabel(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return String(iso || '');
  const d = new Date(`${iso}T12:00:00Z`);
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
}

// ---------------------------------------------------------------- EXIF
const ASCII = 2;
const SHORT = 3;
const LONG = 4;
const IFD0_TAGS = { 0x010F: 'make', 0x0110: 'model', 0x0112: 'orientation', 0x0131: 'software', 0x0132: 'dateTime', 0x8769: 'exifIfd' };
const EXIF_TAGS = { 0x9003: 'dateTimeOriginal', 0x9004: 'dateTimeDigitized', 0x9010: 'offsetTime', 0x9011: 'offsetTimeOriginal', 0x9012: 'offsetTimeDigitized', 0x9291: 'subSecTimeOriginal' };

function isExifHeader(b, p) {
  return p + 6 <= b.length && b[p] === 0x45 && b[p + 1] === 0x78 && b[p + 2] === 0x69 && b[p + 3] === 0x66 && b[p + 4] === 0 && b[p + 5] === 0;
}
function isTiffHeader(b, p) {
  return p + 4 <= b.length && ((b[p] === 0x49 && b[p + 1] === 0x49 && b[p + 2] === 0x2A && b[p + 3] === 0)
    || (b[p] === 0x4D && b[p + 1] === 0x4D && b[p + 2] === 0 && b[p + 3] === 0x2A));
}

/**
 * The capture details of a photo from the first bytes of its file (pass file.slice(0, 262144)): { make, model, orientation, software,
 * dateTime, dateTimeOriginal, dateTimeDigitized, offsetTime, offsetTimeOriginal, offsetTimeDigitized, subSecTimeOriginal } (only the
 * tags found), or null. JPEG: the APP1 "Exif" segment; HEIC and others: the first "Exif\0\0" followed by a TIFF header. Little- and
 * big-endian. Every read is bounds-checked: a damaged or cut-off file gives null or fewer tags, never an exception.
 */
export function readExif(input) {
  try {
    const b = input instanceof Uint8Array ? input : new Uint8Array(input || []);
    let tiff = -1;
    if (b.length > 4 && b[0] === 0xFF && b[1] === 0xD8) {
      let p = 2;
      while (p + 4 <= b.length && b[p] === 0xFF) {
        const marker = b[p + 1];
        if (marker === 0xFF) { p += 1; continue; }
        if (marker === 0xD9 || marker === 0xDA) break;
        if ((marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { p += 2; continue; }
        const len = (b[p + 2] << 8) | b[p + 3];
        if (len < 2) break;
        if (marker === 0xE1 && isExifHeader(b, p + 4) && isTiffHeader(b, p + 10)) { tiff = p + 10; break; }
        p += 2 + len;
      }
    }
    if (tiff < 0) {
      for (let p = 0; p + 10 <= b.length; p++) {
        if (b[p] === 0x45 && isExifHeader(b, p) && isTiffHeader(b, p + 6)) { tiff = p + 6; break; }
      }
    }
    if (tiff < 0) return null;
    return parseTiff(b, tiff);
  } catch { return null; }
}

function parseTiff(b, start) {
  const le = b[start] === 0x49;
  const u16 = (o) => { if (o < 0 || o + 2 > b.length) throw new RangeError('exif'); return le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]; };
  const u32 = (o) => { if (o < 0 || o + 4 > b.length) throw new RangeError('exif'); return le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; };
  const out = {};
  const readIfd = (offset, names) => {
    const at = start + offset;
    const count = u16(at);
    if (count > 500) throw new RangeError('exif');
    for (let i = 0; i < count; i++) {
      const e = at + 2 + i * 12;
      let tag;
      try { tag = u16(e); } catch { return; }
      const name = names[tag];
      if (!name) continue;
      try {
        const type = u16(e + 2);
        const n = u32(e + 4);
        if (type === ASCII) {
          if (n > 256) continue;
          const from = n <= 4 ? e + 8 : start + u32(e + 8);
          if (from < 0 || from + n > b.length) continue;
          let s = '';
          for (let k = 0; k < n; k++) { const c = b[from + k]; if (c === 0) break; s += String.fromCharCode(c); }
          s = s.trim();
          if (s) out[name] = s;
        } else if (type === SHORT) out[name] = u16(e + 8);
        else if (type === LONG) out[name] = u32(e + 8);
      } catch { /* this tag points outside the bytes read: skip it */ }
    }
  };
  if (u16(start + 2) !== 42) return null;
  readIfd(u32(start + 4), IFD0_TAGS);
  if (typeof out.exifIfd === 'number') {
    try { readIfd(out.exifIfd, EXIF_TAGS); } catch { /* the Exif block is past the bytes read: keep what IFD0 had */ }
  }
  delete out.exifIfd;
  if (typeof out.orientation === 'number' && (out.orientation < 1 || out.orientation > 8)) delete out.orientation;
  return Object.keys(out).length ? out : null;
}

/**
 * JPEG bytes with an EXIF block (APP1) put in after the start marker: for tests and demo photos only.
 * fields: { make, model, orientation, software, dateTime, dateTimeOriginal, dateTimeDigitized, offsetTimeOriginal, subSecTimeOriginal }.
 */
export function withExif(jpeg, fields = {}, { bigEndian = false } = {}) {
  const src = jpeg instanceof Uint8Array ? jpeg : new Uint8Array(jpeg);
  const ifd0 = [];
  const exif = [];
  const str = (tag, v, list) => { if (v !== undefined && v !== null) list.push({ tag, type: ASCII, value: String(v) }); };
  str(0x010F, fields.make, ifd0);
  str(0x0110, fields.model, ifd0);
  if (fields.orientation) ifd0.push({ tag: 0x0112, type: SHORT, value: fields.orientation });
  str(0x0131, fields.software, ifd0);
  str(0x0132, fields.dateTime, ifd0);
  str(0x9003, fields.dateTimeOriginal, exif);
  str(0x9004, fields.dateTimeDigitized, exif);
  str(0x9011, fields.offsetTimeOriginal, exif);
  str(0x9291, fields.subSecTimeOriginal, exif);
  if (exif.length) ifd0.push({ tag: 0x8769, type: LONG, value: 0 });
  const ifdSize = (list) => 2 + list.length * 12 + 4;
  const ifd0At = 8;
  const exifAt = ifd0At + ifdSize(ifd0);
  let dataAt = exifAt + (exif.length ? ifdSize(exif) : 0);
  const extra = [];
  const place = (e) => {
    if (e.type !== ASCII) return;
    const bytes = [...e.value].map((c) => c.charCodeAt(0) & 0xFF).concat(0);
    e.count = bytes.length;
    if (bytes.length <= 4) { e.inline = bytes; return; }
    e.offset = dataAt;
    extra.push({ at: dataAt, bytes });
    dataAt += bytes.length + (bytes.length % 2);
  };
  ifd0.forEach(place);
  exif.forEach(place);
  const ptr = ifd0.find((e) => e.tag === 0x8769);
  if (ptr) ptr.value = exifAt;
  const t = new Uint8Array(dataAt);
  const w16 = (o, v) => { if (bigEndian) { t[o] = (v >> 8) & 0xFF; t[o + 1] = v & 0xFF; } else { t[o] = v & 0xFF; t[o + 1] = (v >> 8) & 0xFF; } };
  const w32 = (o, v) => { if (bigEndian) { t[o] = (v >>> 24) & 0xFF; t[o + 1] = (v >>> 16) & 0xFF; t[o + 2] = (v >>> 8) & 0xFF; t[o + 3] = v & 0xFF; } else { t[o] = v & 0xFF; t[o + 1] = (v >>> 8) & 0xFF; t[o + 2] = (v >>> 16) & 0xFF; t[o + 3] = (v >>> 24) & 0xFF; } };
  if (bigEndian) { t[0] = 0x4D; t[1] = 0x4D; } else { t[0] = 0x49; t[1] = 0x49; }
  w16(2, 42);
  w32(4, ifd0At);
  const writeIfd = (at, list) => {
    w16(at, list.length);
    list.forEach((e, i) => {
      const o = at + 2 + i * 12;
      w16(o, e.tag); w16(o + 2, e.type);
      if (e.type === ASCII) {
        w32(o + 4, e.count);
        if (e.inline) e.inline.forEach((c, k) => { t[o + 8 + k] = c; }); else w32(o + 8, e.offset);
      } else if (e.type === SHORT) { w32(o + 4, 1); w16(o + 8, e.value); } else { w32(o + 4, 1); w32(o + 8, e.value); }
    });
    w32(at + 2 + list.length * 12, 0);
  };
  writeIfd(ifd0At, ifd0);
  if (exif.length) writeIfd(exifAt, exif);
  for (const x of extra) t.set(x.bytes, x.at);
  const segLen = 2 + 6 + t.length;
  const app1 = new Uint8Array(2 + segLen);
  app1[0] = 0xFF; app1[1] = 0xE1; app1[2] = (segLen >> 8) & 0xFF; app1[3] = segLen & 0xFF;
  app1.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
  app1.set(t, 10);
  const out = new Uint8Array(src.length + app1.length);
  out.set(src.subarray(0, 2), 0);
  out.set(app1, 2);
  out.set(src.subarray(2), 2 + app1.length);
  return out;
}

/** "YYYY:MM:DD HH:MM:SS" (+ "+HH:MM" offset, sub-seconds) -> ms, read as Karachi wall time when there is no offset; null when it is not a date. */
export function parseExifDate(s, offset, subsec) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || '').trim());
  if (!m) return null;
  const [y, mo, d, hh, mi, ss] = m.slice(1).map(Number);
  if (y < 1990 || mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 60) return null;
  let off = KARACHI_OFFSET_MIN;
  const o = /^([+-])(\d{2}):?(\d{2})$/.exec(String(offset || '').trim());
  if (o) off = (o[1] === '-' ? -1 : 1) * (Number(o[2]) * 60 + Number(o[3]));
  const frac = /^\d+$/.test(String(subsec || '')) ? Math.round(Number(`0.${subsec}`) * 1000) : 0;
  const ms = Date.UTC(y, mo - 1, d, hh, mi, ss) - off * MIN + frac;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * When a photo was taken: { taken_at (ISO or null), time_source, clock_ok, time_ok, photo_day, camera, orientation }.
 *   'exif'          DateTimeOriginal (else DateTimeDigitized): the camera's own time;
 *   'exif_modified' only IFD0 DateTime: an app saved the photo again, so it is treated like a file date;
 *   'file_date'     no EXIF time: the file's date (File.lastModified), unless that is within 10 minutes of choosing the photo ('none').
 * clock_ok: the time is within the last 7 days (an upload the next morning) and at most 15 minutes ahead of the upload. Only 'exif' with
 * clock_ok is a usable time (time_ok). photo_day: the Karachi date of a usable time, else the upload day.
 */
export function captureTime({ exif = null, lastModified = null, pickedAt = Date.now(), uploadedAt = pickedAt } = {}) {
  let taken = null;
  let source = 'none';
  if (exif?.dateTimeOriginal && (taken = parseExifDate(exif.dateTimeOriginal, exif.offsetTimeOriginal, exif.subSecTimeOriginal)) !== null) source = 'exif';
  else if (exif?.dateTimeDigitized && (taken = parseExifDate(exif.dateTimeDigitized, exif.offsetTimeDigitized || exif.offsetTime)) !== null) source = 'exif';
  else if (exif?.dateTime && (taken = parseExifDate(exif.dateTime, exif.offsetTime)) !== null) source = 'exif_modified';
  if (taken === null && Number.isFinite(lastModified) && lastModified > 0) {
    if (Math.abs(pickedAt - lastModified) > 10 * MIN) { taken = lastModified; source = 'file_date'; }
  }
  const clockOk = taken !== null && taken >= uploadedAt - 7 * 24 * 60 * MIN && taken <= uploadedAt + 15 * MIN;
  const timeOk = source === 'exif' && clockOk;
  return {
    taken_at: taken === null ? null : new Date(taken).toISOString(),
    time_source: source,
    clock_ok: clockOk,
    time_ok: timeOk,
    photo_day: karachiDate(timeOk ? taken : uploadedAt),
    camera: cameraKey(exif?.make, exif?.model),
    orientation: exif?.orientation || null,
  };
}

/** 'make|model', lower case, spaces collapsed; 'unknown' without either. */
export function cameraKey(make, model) {
  const clean = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const k = `${clean(make)}|${clean(model)}`;
  return k === '|' ? 'unknown' : k;
}

/** The camera's file counter in a file name: IMG_1234 -> { prefix: 'IMG_', seq: 1234 }; null for names made of a date and time. */
export function fileSeq(name) {
  const base = String(name || '').replace(/\.[^./]*$/, '');
  if (/\d{8}[_\-T ]?\d{6}/.test(base) || /\d{4}[-_]\d{2}[-_]\d{2}/.test(base)) return null;
  const m = /^(.*?)(\d{3,6})([^0-9]*)$/.exec(base);
  return m ? { prefix: m[1], seq: Number(m[2]) } : null;
}

const RAW_EXT = /\.(dng|cr2|cr3|nef|arw|raf|orf|rw2)$/i;
const HEIC_BRANDS = { heic: 'heic', heix: 'heic', hevc: 'heic', heim: 'heic', heis: 'heic', hevm: 'heic', hevs: 'heic', mif1: 'heif', msf1: 'heif' };
/**
 * Whether a picked file is a photo the inbox takes, from its first 12 bytes, name and size: { ok: true, ext, mime } or { ok: false, reason }.
 * JPEG, PNG, WebP and HEIC/HEIF (the canonical extension is used in the stored name).
 */
export function sniffType(head, name = '', size = 1, type = '') {
  if (RAW_EXT.test(name)) return { ok: false, reason: 'RAW camera file: choose the JPEG' };
  if (/^video\//.test(type) || /\.(mov|mp4|m4v|avi|3gp|mkv|webm)$/i.test(name)) return { ok: false, reason: 'Not a photo' };
  if (!size) return { ok: false, reason: 'Empty file' };
  if (size > MAX_FILE_BYTES) return { ok: false, reason: 'Larger than 50 MB' };
  const b = head instanceof Uint8Array ? head : new Uint8Array(head || []);
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return { ok: true, ext: 'jpg', mime: 'image/jpeg' };
  if (b.length >= 8 && [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A].every((v, i) => b[i] === v)) return { ok: true, ext: 'png', mime: 'image/png' };
  const ascii = (from, to) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { ok: true, ext: 'webp', mime: 'image/webp' };
  if (b.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = HEIC_BRANDS[ascii(8, 12)];
    if (brand) return { ok: true, ext: brand, mime: `image/${brand}` };
  }
  if (/^image\//.test(type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(name)) return { ok: false, reason: 'Damaged or not a photo' };
  return { ok: false, reason: 'Not a photo' };
}

/** The storage paths of a photo of the inbox (the original keeps its own type; the edited copy and the small copies are JPEG). */
export function inboxPaths({ citySlug, day, sha, ext }) {
  const base = `inbox/${citySlug}/${day}`;
  return { path: `${base}/${sha}.${ext}`, thumb: `${base}/thumbs/${sha}.jpg`, edited: `${base}/edited/${sha}.jpg`, editedThumb: `${base}/edited/thumbs/${sha}.jpg` };
}
/** The city's folder name: lower case, anything else than letters and digits a dash (karachi, lahore, islamabad). Same as the database. */
export const citySlug = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// ---------------------------------------------------------------- grouping
const ms = (t) => (t ? Date.parse(t) : NaN);
const usableTime = (it) => it.time_source === 'exif' && Number.isFinite(ms(it.taken_at)); // clock right or wrong: consistent within one camera
const itemTimeOk = (it) => usableTime(it) && !!it.clock_ok;
const byPhotoOrder = (a, b) => (ms(a.taken_at) - ms(b.taken_at)) || ((a.file_seq ?? Infinity) - (b.file_seq ?? Infinity))
  || String(a.file_name || '').localeCompare(String(b.file_name || '')) || String(a.sha256 || a.item_id).localeCompare(String(b.sha256 || b.item_id));
const counterBreaks = (prev, it) => prev.file_seq_prefix != null && it.file_seq_prefix === prev.file_seq_prefix && prev.file_seq != null && it.file_seq != null
  && (it.file_seq < prev.file_seq || it.file_seq - prev.file_seq > SEQ_JUMP);
const streamKey = (it) => `${it.camera || 'unknown'}|${it.branch_hint ?? 'any'}`;

/**
 * The day's regroupable photos as sets, one patient's sitting each: [{ item_ids (in photo order), join_set_id }].
 *   - photos without a usable time are each a set of their own (nobody can tell which sitting they belong to);
 *   - the others are split by camera and branch hint ("streams"), and a new set starts after a pause of more than GAP_SEC, more than
 *     SPAN_SEC after the set's first photo, or when the file counter goes back or jumps (a second phone of the same model, a break);
 *   - a set that carries on right after (or right before) a filed set of the same stream, within GAP_SEC, joins it (join_set_id): the
 *     rest of a sitting uploaded later. Only photos with a usable time join, never a set a person changed (manual), and the joined set
 *     stays within SPAN_SEC.
 * filedSets: [{ set_id, camera, branch_hint, manual, status, items: [...] }].
 */
export function groupItems(items, filedSets = []) {
  const groups = [];
  const streams = new Map();
  for (const it of items) {
    if (!usableTime(it)) { groups.push([it]); continue; }
    const k = streamKey(it);
    if (!streams.has(k)) streams.set(k, []);
    streams.get(k).push(it);
  }
  for (const list of streams.values()) {
    list.sort(byPhotoOrder);
    let cur = null;
    for (const it of list) {
      const t = ms(it.taken_at);
      if (cur) {
        const prev = cur[cur.length - 1];
        if (t - ms(prev.taken_at) > GAP_SEC * 1000 || t - ms(cur[0].taken_at) > SPAN_SEC * 1000 || counterBreaks(prev, it)) cur = null;
      }
      if (!cur) { cur = []; groups.push(cur); }
      cur.push(it);
    }
  }
  const filed = filedSets.filter((s) => s.status === 'filed' && !s.manual && s.items?.length).map((s) => {
    const its = s.items.filter(usableTime).sort(byPhotoOrder);
    return { s, its, key: `${s.camera || 'unknown'}|${s.branch_hint ?? 'any'}` };
  }).filter((f) => f.its.length);
  const out = groups.map((g) => {
    let join = null;
    if (g.every(itemTimeOk)) {
      const first = g[0];
      const last = g[g.length - 1];
      const key = streamKey(first);
      for (const f of filed) {
        if (f.key !== key) continue;
        const fFirst = f.its[0];
        const fLast = f.its[f.its.length - 1];
        const span = Math.max(ms(last.taken_at), ms(fLast.taken_at)) - Math.min(ms(first.taken_at), ms(fFirst.taken_at));
        if (span > SPAN_SEC * 1000) continue;
        const after = ms(first.taken_at) - ms(fLast.taken_at);
        const before = ms(fFirst.taken_at) - ms(last.taken_at);
        if ((after >= 0 && after <= GAP_SEC * 1000 && !counterBreaks(fLast, first)) || (before >= 0 && before <= GAP_SEC * 1000 && !counterBreaks(last, fFirst))) {
          join = f.s.set_id;
          break;
        }
      }
    }
    return { item_ids: g.map((it) => it.item_id), join_set_id: join, first: usableTime(g[0]) ? ms(g[0].taken_at) : Infinity, name: String(g[0].file_name || '') };
  });
  out.sort((a, b) => (a.first - b.first) || a.name.localeCompare(b.name) || String(a.item_ids[0]).localeCompare(String(b.item_ids[0])));
  return out.map(({ item_ids, join_set_id }) => ({ item_ids, join_set_id }));
}

// ---------------------------------------------------------------- matching
const PHOTO_LIKELY = /(bond|braces off|debond|record|smile|veneer|aligner|consult)/i;
const CANDIDATE_STATUSES = ['waiting', 'in_treatment', 'completed'];
const TIME_FIELDS = ['checked_in_at', 'started_at', 'completed_at', 'created_at'];

/**
 * What the day's list says about each visit's time at the clinic, and how far it can be trusted. One entry per visit:
 *   real(t): the time is filled, the row is not imported (Healthwire), it is on the visit's own day, between 7:00 and 23:59;
 *   bulk:    3 or more visits of the same branch have that time within one 120-second window (marked in one go): not trusted;
 *   entered_late: completed within 60 s of being typed in, with no check-in and no start: the patient was there before it was typed;
 *   anchor:  the start, else the check-in (real and not bulk); end: the completion (real, not bulk, not before the anchor), or the
 *            moment it was typed in for an entered-late row; quality 'good' (an anchor), 'late_entry' or 'none'.
 */
export function visitFacts(visits) {
  const realOf = (v, f) => {
    const t = ms(v[f]);
    if (!Number.isFinite(t) || v.legacy) return null;
    if (karachiDate(t) !== v.visit_date) return null;
    return karachiMinutes(t) >= 7 * 60 ? t : null;
  };
  const bulk = new Map(); // `${visit_id}|${field}` -> true
  const byBranch = new Map();
  for (const v of visits) {
    if (!byBranch.has(v.branch_id)) byBranch.set(v.branch_id, []);
    byBranch.get(v.branch_id).push(v);
  }
  for (const list of byBranch.values()) {
    for (const f of ['checked_in_at', 'started_at', 'completed_at']) {
      const times = list.map((v) => ({ id: v.visit_id, t: realOf(v, f) })).filter((x) => x.t !== null).sort((a, b) => a.t - b.t);
      for (let i = 0, j = 0; i < times.length; i++) {
        if (j < i) j = i;
        while (j + 1 < times.length && times[j + 1].t - times[i].t <= 120 * 1000) j++;
        if (j - i + 1 >= 3) for (let k = i; k <= j; k++) bulk.set(`${times[k].id}|${f}`, true);
      }
    }
  }
  return visits.map((v) => {
    const real = Object.fromEntries(TIME_FIELDS.map((f) => [f, realOf(v, f)]));
    const trusted = (f) => (real[f] !== null && !bulk.get(`${v.visit_id}|${f}`) ? real[f] : null);
    const start = trusted('started_at');
    const checkin = trusted('checked_in_at');
    const anchor = start ?? checkin;
    const created = ms(v.created_at);
    const enteredLate = !v.legacy && !v.checked_in_at && !v.started_at && Number.isFinite(ms(v.completed_at)) && Number.isFinite(created)
      && Math.abs(ms(v.completed_at) - created) <= 60 * 1000;
    let end = trusted('completed_at');
    if (end !== null && anchor !== null && end < anchor) end = null;
    if (enteredLate && anchor === null) end = real.created_at;
    const quality = anchor !== null ? 'good' : enteredLate && real.created_at !== null ? 'late_entry' : 'none';
    return {
      ...v,
      anchor, anchor_kind: start !== null ? 'start' : checkin !== null ? 'checkin' : null, end, quality,
      arrive: real.checked_in_at, created: Number.isFinite(created) ? created : null,
      occasion: v.photo_required ? 'photo_month' : PHOTO_LIKELY.test(String(v.treatment_label || '')) ? 'photo_likely' : 'other',
      has_photos: !!v.photos_uploaded || Number(v.photo_count) > 0 || (v.filed_set_ids || []).length > 0,
      bulk_fields: ['checked_in_at', 'started_at', 'completed_at'].filter((f) => bulk.get(`${v.visit_id}|${f}`)),
    };
  });
}

/** One candidate per patient (several rows of one patient that day: not imported first, then with times, then the earliest), with the others as `also`. */
export function dayCandidates(visits) {
  const facts = visitFacts(visits).filter((v) => CANDIDATE_STATUSES.includes(v.status));
  const byPatient = new Map();
  for (const v of facts) {
    if (!byPatient.has(v.patient_id)) byPatient.set(v.patient_id, []);
    byPatient.get(v.patient_id).push(v);
  }
  const out = [];
  for (const list of byPatient.values()) {
    list.sort((a, b) => (Number(!!a.legacy) - Number(!!b.legacy)) || (Number(a.anchor === null) - Number(b.anchor === null))
      || ((a.anchor ?? a.created ?? Infinity) - (b.anchor ?? b.created ?? Infinity)) || String(a.visit_id).localeCompare(String(b.visit_id)));
    out.push({ ...list[0], also: list.slice(1).map((v) => ({ visit_id: v.visit_id, branch_id: v.branch_id })) });
  }
  return out;
}

const overlaps = (u, w) => u.first <= w[1] && u.last >= w[0];
/** The window of a candidate wide enough to say "this patient may have been in the chair then". */
export function wideWindow(c) {
  if (c.quality === 'good') return [c.anchor - 30 * MIN, (c.end ?? c.anchor + 180 * MIN) + 15 * MIN];
  if (c.quality === 'late_entry') return [c.created - 240 * MIN, c.created + 15 * MIN];
  return [-Infinity, Infinity];
}
const fitsTightly = (u, c) => c.anchor !== null && u.first >= c.anchor - 10 * MIN && u.first <= c.anchor + 120 * MIN && (c.end === null || u.last <= c.end + 10 * MIN);

/**
 * How well a set fits a candidate (section 7.4): the time (flat from 10 minutes before the start to 40 after, since start times are
 * marked by hand), plus the occasion (photo month +60, bonding / braces off ... +35), minus 15 for a patient still waiting, 40 for one who
 * already has photos, 30 for another branch than the one chosen. A set without a usable time scores on the rest only.
 * Returns { score, d } (d = minutes from the anchor to the set's first photo, null without either).
 */
export function scorePair(u, c) {
  let T = 0;
  let d = null;
  if (u.time_ok) {
    if (c.quality === 'good') {
      d = (u.first - c.anchor) / MIN;
      if (d >= -10 && d <= 40) T = 100;
      else if (d >= -30 && d < -10) T = 100 - 4.5 * (-10 - d);
      else if (d > 40 && d <= 160) T = 100 - 0.6 * (d - 40);
      else if (d >= -60) T = 10;
      else T = 0;
      if (c.end !== null && u.first > c.end + 15 * MIN) T = Math.min(T, 5);
    } else if (c.quality === 'late_entry') T = u.last <= c.created + 15 * MIN ? 50 : 5;
    else T = 30;
  }
  const O = c.occasion === 'photo_month' ? 60 : c.occasion === 'photo_likely' ? 35 : 0;
  const score = T + O + (c.status === 'waiting' ? -15 : 0) + (c.has_photos ? -40 : 0) + (u.hint && c.branch_id !== u.hint ? -30 : 0);
  return { score: Math.round(score * 10) / 10, d: d === null ? null : Math.round(d * 10) / 10 };
}

/**
 * The day's assignment (section 7.5): sets with a usable time in photo order, candidates with an anchor in clinic order, each set paired
 * with at most one patient and each patient with at most one set, keeping the order on both sides (photos follow patients). A pair needs
 * MIN_PAIR and, when the set has a branch hint, that branch. Maximises the sum of scores (minus |d| / 1000, so the closer start wins a tie).
 * Returns Map(unit key -> candidate visit_id).
 */
export function assignDay(units, cands) {
  const S = units.filter((u) => u.time_ok).sort((a, b) => (a.first - b.first) || String(a.key).localeCompare(String(b.key)));
  const V = cands.filter((c) => c.anchor !== null).sort((a, b) => (a.anchor - b.anchor) || ((a.arrive ?? Infinity) - (b.arrive ?? Infinity))
    || ((a.created ?? Infinity) - (b.created ?? Infinity)) || ((a.token_no ?? Infinity) - (b.token_no ?? Infinity)) || String(a.visit_id).localeCompare(String(b.visit_id)));
  const n = S.length;
  const m = V.length;
  const f = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const w = (i, j) => {
    const u = S[i - 1];
    const c = V[j - 1];
    if (u.hint && c.branch_id !== u.hint) return null;
    const { score, d } = scorePair(u, c);
    return score >= MIN_PAIR ? score - Math.abs(d ?? 0) / 1000 : null;
  };
  const W = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      W[i][j] = w(i, j);
      const pair = W[i][j] === null ? -Infinity : f[i - 1][j - 1] + W[i][j];
      f[i][j] = Math.max(f[i - 1][j], f[i][j - 1], pair);
    }
  }
  const out = new Map();
  const EPS = 1e-9;
  for (let i = n, j = m; i > 0 && j > 0;) {
    if (W[i][j] !== null && Math.abs(f[i][j] - (f[i - 1][j - 1] + W[i][j])) < EPS) { out.set(S[i - 1].key, V[j - 1].visit_id); i--; j--; }
    else if (Math.abs(f[i][j] - f[i - 1][j]) < EPS) i--;
    else j--;
  }
  return out;
}

// The sentence on a card for each reason a set waits (section 7.7).
const WAIT_SENTENCES = {
  NO_TIME: () => 'No camera time (WhatsApp, edited in an app, or a screenshot). Choose the patient.',
  CLOCK: (c) => `The camera's date is wrong (${c.date || 'not today'}). Choose the patient; set the phone to automatic date and time.`,
  NO_VISIT_DAY: (c) => `Nobody is on the ${c.city || ''} Aaj ki List for ${c.day || 'that day'}. Add the patient there and press Check again, or choose the patient with "Search all patients".`.replace('the  Aaj', 'the Aaj'),
  MANUAL: () => 'Split or put back: choose the patient.',
  UNDONE: () => 'The filing was undone: choose the patient.',
  MIXED: () => 'Claude thinks these photos show more than one patient. Split the set if needed.',
  NOT_CLINICAL: () => 'Claude thinks a photo here is not a patient photo (floor, ceiling, an accidental shot). Split it off, or choose the patient.',
  LONG_SET: () => 'Many photos over a long time: maybe more than one patient.',
  WEAK_TIMES: () => 'The list has no real check-in or treatment times at that time (statuses were marked late or in one go), so the system cannot tell who it was.',
  BEFORE_ARRIVAL: () => 'Taken before the patient was checked in.',
  AFTER_LEAVING: () => 'Taken after the patient was marked Completed.',
  AMBIGUOUS: () => 'More than one photo-month (or bonding / braces-off) patient was in the chair then.',
  TWO_SETS: () => 'Another set of photos points to the same patient.',
  HAS_PHOTOS: () => 'This patient already has photos for this visit.',
  NO_PHOTO_MONTH: () => 'No photo-month patient was in the chair then.',
  OTHER_BRANCH: () => 'The likely patient was at another branch than the one chosen.',
  SERVER_CHECK: () => 'The automatic filing was stopped by a final check: choose the patient.',
};
export const WAIT_REASONS = Object.keys(WAIT_SENTENCES);
export function waitSentence(code, ctx = {}) {
  const f = WAIT_SENTENCES[code];
  return f ? f(ctx) : 'Choose the patient.';
}

/** The facts of a set (a group of the plan, or a set a person changed): first and last capture, count, usable time, camera, hint. */
function unitFacts(key, its, extra = {}) {
  const timed = its.filter(usableTime).map((it) => ms(it.taken_at));
  const first = timed.length ? Math.min(...timed) : null;
  const last = timed.length ? Math.max(...timed) : null;
  const hints = [...new Set(its.map((it) => it.branch_hint ?? null))];
  return {
    key, item_ids: its.map((it) => it.item_id), first, last, count: its.length,
    time_ok: its.length > 0 && its.every(itemTimeOk),
    no_time: its.some((it) => !usableTime(it)),
    bad_clock: its.some((it) => usableTime(it) && !it.clock_ok),
    clock_shown: (its.find((it) => usableTime(it) && !it.clock_ok) || {}).taken_at || null,
    span: first === null ? 0 : (last - first) / 1000,
    camera: its[0]?.camera || 'unknown',
    hint: hints.length === 1 ? hints[0] : null,
    manual: false, ai_flag: null, prev_reason: null, join: null,
    ...extra,
  };
}

const autoA1 = (u) => u.time_ok && !u.manual && !u.ai_flag && u.count <= MAX_AUTO_PHOTOS && u.span <= SPAN_SEC;
const autoA2 = (u, v) => v.occasion === 'photo_month' && v.quality === 'good' && (v.status === 'in_treatment' || v.status === 'completed')
  && !v.has_photos && (!u.hint || v.branch_id === u.hint);
const autoA4 = (u, v, cands) => !cands.some((c) => c.visit_id !== v.visit_id && (c.occasion === 'photo_month' || c.occasion === 'photo_likely')
  && !c.has_photos && (!u.hint || c.branch_id === u.hint) && overlaps(u, wideWindow(c)));
const passesA1toA4 = (u, v, cands) => autoA1(u) && autoA2(u, v) && fitsTightly(u, v) && autoA4(u, v, cands);

const canon = (x) => (Array.isArray(x) ? `[${x.map(canon).join(',')}]`
  : x && typeof x === 'object' ? `{${Object.keys(x).filter((k) => x[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(x[k])}`).join(',')}}`
    : JSON.stringify(x ?? null));

/**
 * The plan for one city and day (section 7.9), from photo_inbox_day's answer: the regroupable photos grouped again, each set matched
 * against the city's visits of that day as ONE order-keeping assignment, the sets that are clear marked to be filed by themselves
 * (`auto`, re-checked by the server), the others with their likely patients (`candidates`) and why they wait (`wait_reason`).
 * Sets a person changed (split, put back, undone) keep their photos and get fresh candidates (`fixed_updates`).
 */
export function planDay(day) {
  const items = day.items || [];
  const sets = day.sets || [];
  const setById = new Map(sets.map((s) => [s.set_id, s]));
  const itemById = new Map(items.map((it) => [it.item_id, it]));
  const isRegroupable = (it) => !it.set_id || (setById.get(it.set_id)?.status === 'waiting' && !setById.get(it.set_id)?.manual);
  const regItems = items.filter(isRegroupable);
  const filedSets = sets.filter((s) => s.status === 'filed').map((s) => ({ ...s, items: items.filter((it) => it.set_id === s.set_id) }));
  const groups = groupItems(regItems, filedSets);
  const reused = new Set();
  for (const g of groups) {
    if (g.join_set_id) continue;
    const old = setById.get(itemById.get(g.item_ids[0])?.set_id);
    if (old && old.status === 'waiting' && !old.manual && !reused.has(old.set_id)) { g.reuse_set_id = old.set_id; reused.add(old.set_id); }
  }
  const units = groups.map((g, i) => unitFacts(`g${i}`, g.item_ids.map((id) => itemById.get(id)), {
    ai_flag: setById.get(g.reuse_set_id)?.ai_flag ?? null, join: g.join_set_id, group: g,
  }));
  const manualSets = sets.filter((s) => s.status === 'waiting' && s.manual);
  for (const s of manualSets) {
    const its = items.filter((it) => it.set_id === s.set_id).sort(byPhotoOrder);
    units.push(unitFacts(`s${s.set_id}`, its, { manual: true, ai_flag: s.ai_flag ?? null, prev_reason: s.wait_reason, set: s }));
  }
  const cands = dayCandidates(day.visits || []);
  const candById = new Map(cands.map((c) => [c.visit_id, c]));
  const branchCode = (id) => (day.branches || []).find((b) => b.id === id)?.code || '';
  const assigned = assignDay(units.filter((u) => !u.join), cands);
  const open = units.filter((u) => !u.join);

  const ranked = (u, proposalId) => cands.map((c) => ({ c, ...scorePair(u, c) })).sort((a, b) =>
    (Number(b.c.visit_id === proposalId) - Number(a.c.visit_id === proposalId)) || (b.score - a.score)
    || (Math.abs(a.d ?? Infinity) - Math.abs(b.d ?? Infinity))
    || ((a.c.anchor ?? a.c.created ?? Infinity) - (b.c.anchor ?? b.c.created ?? Infinity))
    || String(a.c.full_name || '').localeCompare(String(b.c.full_name || '')) || String(a.c.visit_id).localeCompare(String(b.c.visit_id)));
  const reasonsFor = (u, c, proposal) => {
    const r = [];
    if (c.anchor_kind === 'start') r.push('IN_CHAIR'); else if (c.anchor_kind === 'checkin') r.push('CHECKED_IN');
    else if (c.quality === 'late_entry') r.push('LATE_ENTRY'); else r.push('NO_TIMES');
    if (c.occasion === 'photo_month') r.push('PHOTO_MONTH'); else if (c.occasion === 'photo_likely') r.push('PHOTO_LIKELY');
    if (u.time_ok && c.end !== null && u.first > c.end + 15 * MIN) r.push('LEFT');
    if (u.time_ok && c.anchor !== null && u.first < c.anchor - 10 * MIN) r.push('BEFORE_ARRIVAL');
    if (c.has_photos) r.push('HAS_PHOTOS');
    if (u.hint && c.branch_id !== u.hint) r.push('OTHER_BRANCH');
    if (c.status === 'waiting') r.push('WAITING');
    if (proposal) r.push('ORDER');
    return r;
  };

  const decide = (u) => {
    const proposalId = u.join ? null : assigned.get(u.key) ?? null;
    const list = ranked(u, proposalId);
    const candidates = list.slice(0, 5).map((x, i) => ({
      visit_id: x.c.visit_id, patient_id: x.c.patient_id, rank: i + 1, score: x.score, d: x.d,
      proposal: x.c.visit_id === proposalId, reasons: reasonsFor(u, x.c, x.c.visit_id === proposalId),
    }));
    const v = proposalId ? candById.get(proposalId) : null;
    const others = open.filter((w) => w !== u);
    if (v && autoA1(u) && passesA1toA4(u, v, cands)
      && !others.some((w) => (!w.manual && passesA1toA4(w, v, cands)) || (w.manual && w.time_ok && fitsTightly(w, v)))) {
      return { candidates, wait_reason: null, auto: { visit_id: v.visit_id, patient_id: v.patient_id,
        rule: `Automatic: the only photo-month patient in the chair at ${karachiClock(u.first)} (${branchCode(v.branch_id)})` } };
    }
    const f = v || list[0]?.c || null;
    let reason;
    if (!u.time_ok) reason = u.no_time ? 'NO_TIME' : 'CLOCK';
    else if (!cands.length) reason = 'NO_VISIT_DAY';
    else if (u.manual) reason = u.prev_reason === 'UNDONE' ? 'UNDONE' : 'MANUAL';
    else if (u.ai_flag === 'mixed_people') reason = 'MIXED';
    else if (u.ai_flag === 'not_clinical') reason = 'NOT_CLINICAL';
    else if (u.count > MAX_AUTO_PHOTOS || u.span > SPAN_SEC) reason = 'LONG_SET';
    else if (!f || f.quality !== 'good' || f.status === 'waiting') reason = 'WEAK_TIMES';
    else if (u.first < f.anchor - 10 * MIN) reason = 'BEFORE_ARRIVAL';
    else if (u.first > f.anchor + 120 * MIN || (f.end !== null && u.last > f.end + 10 * MIN)) reason = 'AFTER_LEAVING';
    else if (!autoA4(u, f, cands)) reason = 'AMBIGUOUS';
    else if (others.some((w) => (!w.manual && passesA1toA4(w, f, cands)) || (w.manual && w.time_ok && fitsTightly(w, f)))) reason = 'TWO_SETS';
    else if (f.has_photos) reason = 'HAS_PHOTOS';
    else if (f.occasion !== 'photo_month') reason = 'NO_PHOTO_MONTH';
    else if (u.hint && f.branch_id !== u.hint) reason = 'OTHER_BRANCH';
    else reason = 'TWO_SETS'; // the day's order gave this patient to another set
    return { candidates, wait_reason: reason, auto: null };
  };

  const plan = { matcher_version: MATCHER_VERSION, regroup_item_ids: regItems.map((it) => it.item_id).sort(), groups: [], fixed_updates: [] };
  for (const u of units) {
    const r = decide(u);
    if (u.manual) plan.fixed_updates.push({ set_id: u.set.set_id, wait_reason: r.wait_reason, candidates: r.candidates });
    else plan.groups.push({ item_ids: u.group.item_ids, join_set_id: u.group.join_set_id, reuse_set_id: u.group.reuse_set_id || null,
      auto: u.join ? null : r.auto, wait_reason: r.auto ? null : r.wait_reason, candidates: r.candidates });
  }
  return plan;
}

/** True when applying the plan would change nothing but the time it was matched (same sets, photos, candidates and reasons; nothing to file). */
export function planUnchanged(plan, day) {
  const items = day.items || [];
  const sets = day.sets || [];
  const setById = new Map(sets.map((s) => [s.set_id, s]));
  const regroupableSets = sets.filter((s) => s.status === 'waiting' && !s.manual);
  if (items.some((it) => !it.set_id)) return false;
  if (plan.groups.length !== regroupableSets.length) return false;
  for (const g of plan.groups) {
    if (g.join_set_id || g.auto || !g.reuse_set_id) return false;
    const s = setById.get(g.reuse_set_id);
    if (!s || s.status !== 'waiting' || s.manual) return false;
    const members = items.filter((it) => it.set_id === s.set_id).map((it) => it.item_id).sort();
    if (canon(members) !== canon([...g.item_ids].sort())) return false;
    if ((s.wait_reason ?? null) !== (g.wait_reason ?? null) || canon(s.candidates || []) !== canon(g.candidates || [])) return false;
  }
  for (const f of plan.fixed_updates) {
    const s = setById.get(f.set_id);
    if (!s || (s.wait_reason ?? null) !== (f.wait_reason ?? null) || canon(s.candidates || []) !== canon(f.candidates || [])) return false;
  }
  return true;
}

// ---------------------------------------------------------------- names and labels
/** 'Month 6' for a braces month, else the treatment ('Scaling'), else null. Same as private.photo_inbox_occasion in the database. */
export function occasionLabel(visit) {
  if (!visit) return null;
  if (visit.braces_month) return `Month ${visit.braces_month}`;
  const t = String(visit.treatment_label || '').trim().slice(0, 40);
  return t || null;
}
/** "Month 6 · Front", "Scaling · Upper arch", "Month 6 · Photo 3" (before Claude names the view), "Front" (no occasion). */
export function viewLabel(occasion, viewKey, position) {
  return [occasion || null, viewName(viewKey) || `Photo ${position || 1}`].filter(Boolean).join(' · ');
}
const DD_MM_YYYY = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(String(iso || '')) ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : '');
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The name a photo is downloaded under: "Ayesha Khan - Mr# 50013 - Month 6 - Front - 17-10-2026.jpg". The occasion part is left out
 * when there is none; before Claude names the view it is "Photo 3"; an original keeps its own type and ends " - original". Characters
 * a file name cannot hold are taken out, and the name is cut at 150 characters before the extension.
 * row: { full_name, mr_number, occasion, view_key, view_label, taken_on, kind, storage_path }, position: the photo's number in its set.
 */
export function downloadName(row, { position = 1 } = {}) {
  const occasion = row.occasion || null;
  let view = viewName(row.view_key);
  if (!view && row.view_label) {
    const lbl = String(row.view_label);
    view = occasion && lbl.startsWith(`${occasion} · `) ? lbl.slice(occasion.length + 3) : lbl;
  }
  if (!view) view = `Photo ${position}`;
  const original = row.kind === 'raw';
  const ext = original ? (String(row.storage_path || '').split('.').pop() || 'jpg').toLowerCase() : 'jpg';
  const parts = [row.full_name, row.mr_number ? `Mr# ${row.mr_number}` : null, occasion, view, DD_MM_YYYY(row.taken_on), original ? 'original' : null];
  let base = cleanName(parts.filter(Boolean).map(cleanName).filter(Boolean).join(' - '));
  if (base.length > 150) base = base.slice(0, 150).trim();
  return `${base || 'photo'}.${/^[a-z0-9]{2,5}$/.test(ext) ? ext : 'jpg'}`;
}
/** The same names with " (2)", " (3)" ... added to repeats (inside one zip). */
export function uniqueNames(names) {
  const seen = new Map();
  return names.map((n) => {
    const key = n.toLowerCase();
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    if (count === 1) return n;
    const dot = n.lastIndexOf('.');
    let candidate = dot > 0 ? `${n.slice(0, dot)} (${count})${n.slice(dot)}` : `${n} (${count})`;
    while (seen.has(candidate.toLowerCase())) candidate = dot > 0 ? `${n.slice(0, dot)} (${seen.get(key) + 1})${n.slice(dot)}` : `${n} (${seen.get(key) + 1})`;
    seen.set(candidate.toLowerCase(), 1);
    return candidate;
  });
}

// ---------------------------------------------------------------- the edit
/**
 * The geometry and pixel settings of the edited copy (section 9.6), from Claude's numbers (ai: the normalized result, or null for a
 * basic edit: the whole photo as decoded, levels only). The source frame is the decoded original with its EXIF rotation applied.
 * Returns { sx, sy, sw, sh, angle (radians, clockwise), flip, outW, outH, scale, wb, gammaFloor }.
 */
export function editPlan(ai, srcW, srcH) {
  let sx = 0;
  let sy = 0;
  let sw = srcW;
  let sh = srcH;
  let rotate = 0;
  let straighten = 0;
  let flip = false;
  if (ai) {
    const c = ai.crop || { left: 0, top: 0, right: 1, bottom: 1 };
    const padX = 0.02 * srcW;
    const padY = 0.02 * srcH;
    const x0 = Math.max(0, Math.floor(c.left * srcW - padX));
    const y0 = Math.max(0, Math.floor(c.top * srcH - padY));
    const x1 = Math.min(srcW, Math.ceil(c.right * srcW + padX));
    const y1 = Math.min(srcH, Math.ceil(c.bottom * srcH + padY));
    if (x1 - x0 >= 2 && y1 - y0 >= 2) { sx = x0; sy = y0; sw = x1 - x0; sh = y1 - y0; }
    rotate = [0, 90, 180, 270].includes(ai.rotate) ? ai.rotate : 0;
    straighten = Number(ai.straighten) || 0;
    flip = !!ai.mirror;
  }
  const quarter = rotate === 90 || rotate === 270;
  const rw = quarter ? sh : sw;
  const rh = quarter ? sw : sh;
  let k = 1;
  if (straighten) {
    const a = Math.abs(straighten) * Math.PI / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    k = Math.min(rw / (rw * c + rh * s), rh / (rw * s + rh * c));
  }
  const vw = rw * k;
  const vh = rh * k;
  const r = Math.min(1, EDIT_EDGE / Math.max(vw, vh));
  const colour = ai && ai.color_cast && ai.color_cast !== 'none' && (ai.kind === 'intraoral' || ai.kind === 'extraoral');
  return {
    sx, sy, sw, sh, angle: (rotate + straighten) * Math.PI / 180, flip,
    outW: Math.max(1, Math.round(vw * r)), outH: Math.max(1, Math.round(vh * r)), scale: r, inner: k,
    wb: !!colour, gammaFloor: ai && ai.exposure === 'dark' ? 0.7 : 0.8,
  };
}

/**
 * Gentle colour and brightness on RGBA pixels (in place): white balance only when asked (from neutral pixels, each channel's gain kept
 * within 0.92-1.08 so teeth are never whitened and before/after photos stay comparable; skipped when under 1 % of the pixels are neutral),
 * then levels (0.5th and 99.5th percentile, never past 20 / 235) and, for a dark photo (median under 110), a brightening gamma (never
 * below gammaFloor, never above 1: it never darkens). The histogram reads every 2nd pixel each way.
 * Returns { gains, low, high, gamma, neutralShare }.
 */
export function adjustPixels(data, { width, height, wb = false, gammaFloor = 0.8 } = {}) {
  const W = width || Math.floor(Math.sqrt(data.length / 4));
  const H = height || Math.floor(data.length / 4 / W);
  const idx = [];
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) idx.push((y * W + x) * 4);
  const gains = [1, 1, 1];
  let neutralShare = 0;
  if (wb && idx.length) {
    let n = 0; let sr = 0; let sg = 0; let sb = 0;
    for (const i of idx) {
      const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
      const mx = Math.max(r, g, b); const mn = Math.min(r, g, b);
      if (mx < 250 && mn > 30 && (mx - mn) / mx <= 0.12) { n++; sr += r; sg += g; sb += b; }
    }
    neutralShare = n / idx.length;
    if (neutralShare >= 0.01) {
      const means = [sr / n, sg / n, sb / n];
      const m = (means[0] + means[1] + means[2]) / 3;
      for (let c = 0; c < 3; c++) gains[c] = Math.min(1.08, Math.max(0.92, m / means[c]));
    }
  }
  const hist = new Uint32Array(256);
  for (const i of idx) {
    const y = Math.round((299 * Math.min(255, data[i] * gains[0]) + 587 * Math.min(255, data[i + 1] * gains[1]) + 114 * Math.min(255, data[i + 2] * gains[2])) / 1000);
    hist[Math.min(255, y)]++;
  }
  const total = idx.length || 1;
  const pct = (p) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= p * total) return v; } return 255; };
  const low = Math.min(pct(0.005), 20);
  const high = Math.max(pct(0.995), 235);
  const stretch = high - low >= 1 ? (v) => ((v - low) * 255) / (high - low) : (v) => v;
  const median = stretch(pct(0.5));
  let gamma = 1;
  if (median < 110) gamma = median <= 0 ? gammaFloor : Math.min(1, Math.max(gammaFloor, Math.log(110 / 255) / Math.log(median / 255)));
  const luts = gains.map((g) => {
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      const s = Math.max(0, Math.min(255, stretch(Math.min(255, v * g))));
      lut[v] = Math.round(255 * Math.pow(s / 255, gamma));
    }
    return lut;
  });
  for (let i = 0; i < data.length; i += 4) {
    data[i] = luts[0][data[i]];
    data[i + 1] = luts[1][data[i + 1]];
    data[i + 2] = luts[2][data[i + 2]];
  }
  return { gains, low, high, gamma, neutralShare };
}
