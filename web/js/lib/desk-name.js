// Shared logins: the name of the person at the desk (the owner, 15 Oct 2026). One front desk login and one assistants login per
// branch and one doctors login are used by several people, so after each sign-in to such a login (staff.shared_login) the website
// asks "Please enter your name" (views/staff/desk-name.js), and that name goes with everything done until logout or "Change name":
// it is shown next to the login at the top right, saved in public.desk_names, and sent with every database request in the
// x-desk-name header, where the audit log picks it up (supabase/migrations/20261015000300_desk_names.sql).
//
// The rules (a name is 2 to 60 characters of any language, trimmed; how it travels in a header) are pure functions, tested in
// Node (tests/desk-name.test.ts). The storage helpers below never throw: a browser that blocks storage keeps the name in memory.

export const DESK_NAME_MIN = 2;
export const DESK_NAME_MAX = 60;
export const DESK_NAME_HEADER = 'x-desk-name';
// A header longer than this is not a name (60 characters of 4 bytes each, percent-encoded, is 720). Same limit as the database.
const HEADER_MAX = 800;
// What encodeURIComponent() writes: these characters as they are, everything else as %XX. The database accepts only this.
const HEADER_SHAPE = /^(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-Fa-f]{2})+$/;
// Control characters, and the ones that turn the direction of the text around (they could make a name read as another one).
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
export const SUGGESTIONS_KEPT = 12;

/** The length the database counts (characters, not UTF-16 units: an emoji is one). */
const count = (text) => [...text].length;

/** The name as it is kept: runs of spaces made one, trimmed, control characters dropped. -> { name } or { error } (plain words). */
export function cleanDeskName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').replace(CONTROL, '').replace(/ {2,}/g, ' ').trim();
  if (count(name) < DESK_NAME_MIN) return { error: `Write your name (at least ${DESK_NAME_MIN} letters).` };
  if (count(name) > DESK_NAME_MAX) return { error: `Write at most ${DESK_NAME_MAX} letters.` };
  return { name };
}

/** The header value: percent-encoded UTF-8, so an Urdu name survives (a header may carry plain ASCII only). */
export const encodeDeskName = (name) => encodeURIComponent(name);

/** The header value read back the way the database reads it (private.request_desk_name()): a clean name, or null for anything else. */
export function decodeDeskName(value) {
  if (typeof value !== 'string' || value.length > HEADER_MAX || !HEADER_SHAPE.test(value)) return null;
  let text;
  try { text = decodeURIComponent(value); } catch { return null; } // bytes that are not UTF-8
  const name = text.replace(/\s+/g, ' ').trim();
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return null;
  return count(name) >= DESK_NAME_MIN && count(name) <= DESK_NAME_MAX ? name : null;
}

/** "Front desk Islamabad (Ayesha)" wherever a change is put down to a login; the login alone when no name was given. */
export const withDeskName = (login, desk) => (desk ? `${login} (${desk})` : login);
/** The name menu at the top right: "Front desk Islamabad · Ayesha". */
export const deskLabel = (login, desk) => (desk ? `${login} · ${desk}` : login);

/** The suggestions with `name` put first: the same name in other capitals once only, at most SUGGESTIONS_KEPT. */
export function withSuggestion(list, name) {
  const same = (a) => a.toLocaleLowerCase() === name.toLocaleLowerCase();
  return [name, ...(Array.isArray(list) ? list : []).filter((n) => typeof n === 'string' && !same(n))].slice(0, SUGGESTIONS_KEPT);
}

// ---- where the name is kept
// This tab, until logout or the next sign-in (sessionStorage: a reload keeps it, a new tab or a new login asks again). It is
// tied to the login it was given for, so it can never be put on another login's work. Also kept in memory, for a browser that
// blocks storage (the name then lasts until the page is reloaded). With the time it was last used: a browser that brings the tab
// back after a power cut or a restart ("Restore pages") brings its sessionStorage back too, and the next person must not carry
// on under the name of the one before (see dropStaleDeskName).
const SESSION_KEY = 'desk-name';
// Names typed before on this computer, per login: offered as suggestions in the popup. A convenience of this computer only.
const SUGGEST_KEY = 'desk-names:';
// The latest name given on this computer, per login: the other tabs of that login see it change ('storage') and ask too.
const NOW_KEY = 'desk-name-now';
const TOUCH_EVERY_MS = 60 * 1000; // how often the time of last use is written while the person works
let inMemory = null; // { staffId, name, at }

// How long a name holds without use. With an idle logout (Admin -> Settings, in minutes) that time: the logout ends the name
// anyway. Without one (0 = never log out, 20261015000700_never_logout.sql; a missing or broken setting is the same)
// 12 hours: the next shift is asked again, while a reload or the next page within the shift never asks.
export const DESK_NAME_UNUSED_MS = 12 * 60 * 60 * 1000;
const positive = (n) => Number.isFinite(n) && n > 0;
/** True when the idle logout setting (minutes) logs anyone out at all: a positive number. 0, missing or broken: never. */
export const idleLogoutOn = (timeoutMinutes) => positive(Number(timeoutMinutes));
/** How long a desk name holds without use, for the idle logout setting in minutes: that time when it is on, otherwise 12 hours. */
export const deskNameMaxAgeMs = (timeoutMinutes) => (idleLogoutOn(timeoutMinutes) ? Number(timeoutMinutes) * 60 * 1000 : DESK_NAME_UNUSED_MS);
// A time limit that is not a positive number of ms (0 would drop the name at every reload) counts as the 12 hours.
const limitOf = (maxAgeMs) => (positive(maxAgeMs) ? maxAgeMs : DESK_NAME_UNUSED_MS);

/** The name kept by this tab (or by an earlier page of it) for the login staffId: { name, at }, or null. */
function kept(staffId) {
  try {
    const k = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    const name = k?.staffId === staffId ? cleanDeskName(k.name).name : null;
    return name ? { name, at: Number(k.at) || 0 } : null;
  } catch { return null; }
}

/** The name given in this tab for the login `staffId`, or null. */
export function deskNameFor(staffId) {
  if (!staffId) return null;
  if (inMemory?.staffId === staffId) return inMemory.name;
  const k = kept(staffId);
  if (k) inMemory = { staffId, ...k };
  return k?.name || null;
}

export function keepDeskName(staffId, name) {
  inMemory = { staffId, name, at: Date.now() };
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(inMemory)); } catch { /* storage blocked: kept in memory only */ }
  try { localStorage.setItem(NOW_KEY, JSON.stringify(inMemory)); } catch { /* storage blocked: the other tabs are not told */ }
}

/** At logout, at the next sign-in and on "Change name". */
export function forgetDeskName() {
  inMemory = null;
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* storage blocked */ }
}

/** The person is working: the name stays good (written at most once a minute). */
export function touchDeskName(now = Date.now()) {
  if (!inMemory || now - inMemory.at < TOUCH_EVERY_MS) return;
  inMemory.at = now;
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(inMemory)); } catch { /* storage blocked */ }
}

/**
 * When a page starts with a name kept by an earlier page of the tab (a reload, or a tab the browser restored): that name holds only
 * if it was used within maxAgeMs (deskNameMaxAgeMs: the clinic's idle logout time, or 12 hours when there is none), otherwise it is
 * forgotten and the popup asks again. A name this page holds already is never dropped here (the idle logout ends it; with no idle
 * logout, deskNameUnused below).
 */
export function dropStaleDeskName(staffId, maxAgeMs, now = Date.now()) {
  if (!staffId || inMemory?.staffId === staffId) return;
  const k = kept(staffId);
  if (k && !(now - k.at <= limitOf(maxAgeMs))) forgetDeskName();
}

/**
 * With no idle logout nothing ends a name in a page that stays open (a computer left on overnight would carry the evening's name
 * into the morning). True when the name this page holds for staffId was not used for maxAgeMs: shell.js then asks again.
 */
export function deskNameUnused(staffId, maxAgeMs, now = Date.now()) {
  return !!staffId && inMemory?.staffId === staffId && !(now - inMemory.at <= limitOf(maxAgeMs));
}

/** In how many ms the name this page holds for staffId stops holding if it is not used (0: it has already), or null for no name. */
export function deskNameExpiresIn(staffId, maxAgeMs, now = Date.now()) {
  if (!staffId || inMemory?.staffId !== staffId) return null;
  return Math.max(0, inMemory.at + limitOf(maxAgeMs) - now);
}

/**
 * From a 'storage' event: the name just given in another tab of this browser for the login staffId, when this tab has a different
 * one (the next person at this computer chose "Change name" there); null otherwise.
 */
export function deskNameFromOtherTab(event, staffId) {
  if (event?.key !== NOW_KEY || !staffId) return null;
  const mine = deskNameFor(staffId);
  if (!mine) return null; // this tab is asking already
  try {
    const now = JSON.parse(event.newValue || 'null');
    const name = now?.staffId === staffId ? cleanDeskName(now.name).name : null;
    return name && name.toLocaleLowerCase() !== mine.toLocaleLowerCase() ? name : null;
  } catch { return null; }
}

/**
 * Whose typed edits an offline queue holds (lib/autosave.js keeps them on this computer under this key and sends them only while
 * the same owner is signed in): the login; on a shared login, the login and the name typed at its desk (any capitals), so the next
 * person never sends the previous person's waiting edits under their own name. Those wait for that same name on that login.
 */
export function editOwner(staff) {
  if (!staff?.id) return null;
  if (!staff.shared_login) return staff.id;
  const name = deskNameFor(staff.id);
  return `${staff.id}~${name ? encodeURIComponent(name.toLocaleLowerCase()) : ''}`;
}

export function deskNameSuggestions(staffId) {
  try {
    const list = JSON.parse(localStorage.getItem(SUGGEST_KEY + staffId) || '[]');
    return (Array.isArray(list) ? list : []).map((n) => cleanDeskName(n).name).filter(Boolean).slice(0, SUGGESTIONS_KEPT);
  } catch { return []; }
}

export function rememberDeskName(staffId, name) {
  try { localStorage.setItem(SUGGEST_KEY + staffId, JSON.stringify(withSuggestion(deskNameSuggestions(staffId), name))); } catch { /* storage blocked or full */ }
}
