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
// blocks storage (the name then lasts until the page is reloaded).
const SESSION_KEY = 'desk-name';
// Names typed before on this computer, per login: offered as suggestions in the popup. A convenience of this computer only.
const SUGGEST_KEY = 'desk-names:';
let inMemory = null;

/** The name given in this tab for the login `staffId`, or null. */
export function deskNameFor(staffId) {
  if (!staffId) return null;
  if (inMemory?.staffId === staffId) return inMemory.name;
  try {
    const kept = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    const name = kept?.staffId === staffId ? cleanDeskName(kept.name).name : null;
    if (name) inMemory = { staffId, name };
    return name || null;
  } catch { return null; }
}

export function keepDeskName(staffId, name) {
  inMemory = { staffId, name };
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(inMemory)); } catch { /* storage blocked: kept in memory only */ }
}

/** At logout, at the next sign-in and on "Change name". */
export function forgetDeskName() {
  inMemory = null;
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* storage blocked */ }
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
