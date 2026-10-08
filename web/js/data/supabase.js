// LIVE data layer: talks to the clinic's Supabase database. Every request runs
// as the logged-in person, so the database's row-level security decides what
// they can see and change. Same methods (and same return shapes) as demo.js.
//
// Capped lists keep returning arrays; when a cap is reached the array carries
// `truncated = true` and `cap = N` so the screen can say "showing the first N".
// Report totals come from SQL functions (supabase/migrations/20261007002000_audit_fixes.sql)
// and fall back to adding up rows in the browser while that file is not applied.

import { CONFIG } from '../config.js';
import { todayISO, addDaysISO } from '../ui/dom.js';
import { PERMISSIONS } from '../lib/permissions.js';

// supabase-js pinned to one exact release (bump on purpose, after testing). Only cdn.jsdelivr.net
// is allowed by the site's Content-Security-Policy (script-src and connect-src), so there is no
// second CDN: a slow or failed load is tried once more, then reported.
const SDK_VERSION = '2.117.2';
const SDK_URL = `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${SDK_VERSION}/+esm`;
const SDK_TIMEOUT_MS = 8000; // per attempt
const READ_TIMEOUT_MS = 20000; // any read (GET) from the database or storage
// Supabase image transformations need a paid plan. Until CONFIG.IMAGE_TRANSFORMS is
// set to true, thumbnails and gallery images are the original files.
const IMAGE_TRANSFORMS = !!CONFIG.IMAGE_TRANSFORMS;
const SIGNED_URL_TTL = 3600; // seconds
const PAGE = 1000; // Supabase's default "max rows" per request
const ID_CHUNK = 100; // ids per ".in()" request, so URLs stay short
const CACHE_MS = 5 * 60 * 1000; // public schedule and gallery
const FINISHED_LISTED_DAYS = 90; // coordinator lists: finished lab cases stay listed this long after their last change

const plainError = (message, code) => Object.assign(new Error(message), code ? { code } : {});
/** The error of save_invoice / save_installment_plan when a retried key carries different details (same wording, for the fallback path). */
const mismatchError = (what, undo) => plainError(`IDEMPOTENCY_MISMATCH: an earlier attempt already saved ${what} with different details. Refresh the patient record and check it (${undo} if it is wrong) before saving again.`, 'IDEMPOTENCY_MISMATCH');

function check(res) {
  const { data, error } = res;
  if (error) {
    const e = new Error(error.message || String(error));
    if (error.code) e.code = error.code;
    if (res.status) e.status = res.status;
    throw e;
  }
  return data;
}

/** Keeps a capped list's notice when the list is copied with map(). */
function keepFlags(from, to) {
  if (from?.truncated) { to.truncated = true; to.cap = from.cap; }
  return to;
}
/** Rows fetched with one row more than the cap: trim to the cap and say so. */
function capped(rows, cap) {
  if (rows.length > cap) { rows.length = cap; rows.truncated = true; rows.cap = cap; }
  return rows;
}

// ------------------------------------------------------------ loading the SDK
function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(plainError('Timed out', 'TIMEOUT')), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}
async function loadSdk() {
  const first = import(SDK_URL);
  first.catch(() => {});
  try {
    return await withTimeout(first, SDK_TIMEOUT_MS);
  } catch {
    // Failed or slow: ask once more (a browser remembers a failed module URL, a changed query string gets past that)
    // and still take the first if it finishes before.
    const second = import(`${SDK_URL}?retry=1`);
    second.catch(() => {});
    try {
      return await withTimeout(Promise.any([first, second]), SDK_TIMEOUT_MS);
    } catch {
      // "did not respond" lets friendlyError() treat it as a connection problem for visitors and staff alike.
      throw plainError("The clinic's online services did not respond. Check the internet connection and try again.", 'SDK_LOAD_FAILED');
    }
  }
}
let sdkPromise = null;
function getSdk() {
  if (!sdkPromise) sdkPromise = loadSdk().catch((e) => { sdkPromise = null; throw e; });
  return sdkPromise;
}

/**
 * What a read that took too long ends with. The "TIMEOUT:" prefix postgrest-js puts in front of the name keeps friendlyError()
 * showing only the sentence and the sheet's retry treating it as a network problem. code = 'ABORT_ERR' tells postgrest-js
 * this is an abort: it does not retry it (a retried timeout would keep the screen loading for another minute or more).
 */
function timeoutError() {
  const err = new Error('The clinic server took too long to answer. Check the internet connection and try again.');
  err.name = 'TIMEOUT';
  err.code = 'ABORT_ERR';
  return err;
}

// The token refresh is the one request whose answer can end a login by itself: when the access token has run out, auth-js
// deletes the stored login on any answer it does not know to be "try again later". A rate limit (429), a timeout (408) or an
// error page from a proxy, firewall or captive portal (not JSON) says nothing about the login, so those are thrown like a
// failed fetch: auth-js then keeps the login and asks again. Only a JSON answer from the login server itself counts (refresh
// token not found or used up, session gone, account switched off or deleted): a JSON answer without a login-server error code
// ({"message":"Invalid API key"} from an API gateway, a WAF) is a proxy's, not the login server's, so it is kept the same way.
const REFRESH_URL = /\/auth\/v1\/token\?(?:[^#]*&)?grant_type=refresh_token(?:[&#]|$)/;
const LOGOUT_URL = /\/auth\/v1\/logout(?:[?#]|$)/;
const USER_URL = /\/auth\/v1\/user(?:[?#]|$)/;
async function refreshFetch(input, init, hooks = {}) {
  const asked = hooks.storedUser?.() ?? null; // whose stored login this refresh is for (the answer may come after somebody else has logged in)
  const res = await fetch(input, init);
  if (res.ok) return res;
  // Any 5xx counts as "no answer" too: auth-js only retries some of them, and Supabase's own 544 (upstream timeout)
  // or a 507 would otherwise end a login whose refresh token is still good. A 409 ("conflict") is GoTrue giving up on its row lock
  // after too many refreshes of one session at once (two windows waking together, a slow database): "try again", not "this login is over".
  if (res.status >= 500 || res.status === 429 || res.status === 408 || res.status === 409 || !/json/i.test(res.headers.get('content-type') || '')) {
    throw new TypeError(`The login server gave no usable answer (${res.status}); the login is kept.`);
  }
  let code = null;
  let fromLoginServer = false;
  try {
    const body = await res.clone().json();
    code = typeof body?.code === 'string' ? body.code : body?.error_code; // the answer names the error as "code" (API version 2024-01-01) or "error_code"
    fromLoginServer = (typeof code === 'string' && code !== '') || typeof body?.error_description === 'string'; // (the OAuth-style body of older GoTrue)
  } catch { /* not readable: not a login server's answer */ }
  if (!fromLoginServer) throw new TypeError(`The login server gave no usable answer (${res.status}); the login is kept.`);
  // The server's final word about the account is the reason for the SIGNED_OUT that auth-js sends next. A deleted account's refresh is
  // refused as refresh_token_not_found (its sessions and tokens went with it), which is also what an ended or expired login looks like:
  // that answer alone keeps the generic wording, but onNotFound lets the adapter ask the login server about the access token, which
  // while it is still valid tells the two apart (see askAfterRefusal()).
  if (code === 'user_banned') hooks.onRefused?.('switched_off', asked);
  else if (code === 'user_not_found') hooks.onRefused?.('account_gone', asked);
  else if (code === 'refresh_token_not_found') hooks.onNotFound?.(asked);
  return res;
}

/** Reads give up after READ_TIMEOUT_MS instead of hanging; uploads and saves are left alone. */
function timedFetch(input, init = {}, hooks = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const url = String(input?.url ?? input);
  if (method === 'POST' && REFRESH_URL.test(url)) return refreshFetch(input, init, hooks);
  if (method === 'POST' && LOGOUT_URL.test(url) && hooks.logout) return hooks.logout(input, init);
  if (method !== 'GET' && method !== 'HEAD') return fetch(input, init);
  let request;
  if (init.signal || typeof AbortController === 'undefined') request = fetch(input, init);
  else {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(timeoutError()), READ_TIMEOUT_MS);
    request = fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  }
  return method === 'GET' && hooks.vetUser && USER_URL.test(url) ? request.then((res) => hooks.vetUser(init, res)) : request;
}

// Database functions that only read. They are sent as POST, which timedFetch leaves alone, so callRpc gives them
// the same time limit as a GET. Saving functions (save_invoice, close_cash, merge_patients, imports ...) have none.
const READ_RPCS = new Set(['payments_summary', 'opd_summary', 'total_dues', 'clinic_report', 'doctor_summary', 'dues_for',
  'find_possible_duplicates', 'next_braces_month', 'braces_guidance', 'patient_duplicates', 'staff_logins']);
// How long to wait for the server to confirm a logout before ending it on this computer alone.
const SIGNOUT_TIMEOUT_MS = 4000;

// Why a login ended, so the screen can tell the person (the adapter's onAuthChange(fn) calls fn('SIGNED_OUT', reason); main.js words it):
//   'switched_off' = Dr. Ali switched the account off     'account_gone' = the account was deleted or no longer has a staff or patient record
//   'idle'         = this computer's inactivity logout    no reason      = logged out in another tab or on the server, or the login expired
// A definitive answer of the login server ends the login at once; a failed or slow answer never does (see userId()).
const ACCOUNT_ERRORS = {
  switched_off: { code: 'ACCOUNT_OFF', message: 'This account is switched off. Contact Dr. Ali.' },
  account_gone: { code: 'ACCOUNT_GONE', message: 'This login no longer belongs to an account here. Contact Dr. Ali.' },
};
const REASON_KEY = 'clinic-logout-reason'; // in localStorage, so the other tabs of this browser, which only see SIGNED_OUT, can say the same
// How long a note stays good. A tab that was frozen in the background (a browser's memory or energy saver) hears the SIGNED_OUT
// when it thaws, which can be minutes later. The note is also tied to one person and used once per tab, and goes with the next
// sign-in or logout (see noteReason()), so a longer life cannot label a later logout.
const REASON_TTL_MS = 5 * 60 * 1000;

// ------------------------------------------------------------ report totals (pure; also used by demo.js)
const KARACHI_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.TIMEZONE || 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' });
function karachiDay(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts || '').slice(0, 10) : KARACHI_DAY.format(d);
}
const byDayThenBranch = (a, b) => b.day.localeCompare(a.day) || (a.branch_id ?? 0) - (b.branch_id ?? 0);

/**
 * Payment rows -> { totals, byDay, byMethod }. Same shape as the payments_summary() SQL function.
 * totals/byDay[i]: { received, cash, card, bank, refunds, net, count } (byDay adds day, branch_id; bank = everything not cash or card).
 * byMethod[i]: { method, amount, refunds, count }.
 */
export function summarizePayments(rows) {
  const blank = () => ({ received: 0, cash: 0, card: 0, bank: 0, refunds: 0, net: 0, count: 0 });
  const totals = blank();
  const days = new Map();
  const methods = new Map();
  for (const r of rows) {
    const amount = Number(r.amount) || 0;
    const method = r.method || 'other';
    const day = karachiDay(r.received_at);
    const k = `${day}|${r.branch_id ?? ''}`;
    if (!days.has(k)) days.set(k, { day, branch_id: r.branch_id ?? null, ...blank() });
    if (!methods.has(method)) methods.set(method, { method, amount: 0, refunds: 0, count: 0 });
    for (const o of [totals, days.get(k)]) {
      o.count += 1;
      o.net += amount;
      if (amount > 0) {
        o.received += amount;
        if (method === 'cash') o.cash += amount; else if (method === 'card') o.card += amount; else o.bank += amount;
      } else if (amount < 0) o.refunds -= amount;
    }
    const m = methods.get(method);
    m.count += 1;
    if (amount > 0) m.amount += amount; else if (amount < 0) m.refunds -= amount;
  }
  return { totals, byDay: [...days.values()].sort(byDayThenBranch), byMethod: [...methods.values()].sort((a, b) => b.amount - a.amount) };
}

/**
 * Visit rows (visit_date, branch_id, status, checked_in_at, started_at, patient_id) -> { totals, byDay, waitByBranch }.
 * Same shape as the opd_summary() SQL function. Waits are check-in to treatment start, in minutes. A visit that started before
 * it checked in (back-filled or edited times) has no wait and is left out of the wait figures, as clinic_report() leaves it out.
 * totals: { visits, completed, no_shows, cancelled, waited, wait_min_total, avg_wait_min, patients }.
 * byDay[i]: totals without patients, plus day and branch_id. waitByBranch[i]: { branch_id, waited, wait_min_total, avg_wait_min, long } (long = over 45 min).
 */
export function summarizeVisits(rows) {
  const blank = () => ({ visits: 0, completed: 0, no_shows: 0, cancelled: 0, waited: 0, wait_min_total: 0, avg_wait_min: null });
  const totals = { ...blank(), patients: 0 };
  const days = new Map();
  const waits = new Map();
  const patients = new Set();
  for (const v of rows) {
    const k = `${v.visit_date}|${v.branch_id ?? ''}`;
    if (!days.has(k)) days.set(k, { day: v.visit_date, branch_id: v.branch_id ?? null, ...blank() });
    // Only a start after the check-in is a wait: same rule as opd_summary() and clinic_report() (started_at > checked_in_at).
    const gap = v.checked_in_at && v.started_at ? (new Date(v.started_at) - new Date(v.checked_in_at)) / 60000 : null;
    const wait = gap > 0 ? gap : null;
    for (const o of [totals, days.get(k)]) {
      o.visits += 1;
      if (v.status === 'completed') o.completed += 1;
      if (v.status === 'no_show') o.no_shows += 1;
      if (v.status === 'cancelled') o.cancelled += 1;
      if (wait !== null) { o.waited += 1; o.wait_min_total += wait; }
    }
    if (wait !== null) {
      const b = v.branch_id ?? null;
      if (!waits.has(b)) waits.set(b, { branch_id: b, waited: 0, wait_min_total: 0, avg_wait_min: null, long: 0 });
      const w = waits.get(b);
      w.waited += 1; w.wait_min_total += wait; if (wait > 45) w.long += 1;
    }
    if (v.patient_id) patients.add(v.patient_id);
  }
  totals.patients = patients.size;
  const avg = (o) => { o.avg_wait_min = o.waited ? Math.round(o.wait_min_total / o.waited) : null; return o; };
  return { totals: avg(totals), byDay: [...days.values()].map(avg).sort(byDayThenBranch), waitByBranch: [...waits.values()].map(avg).sort((a, b) => b.waited - a.waited) };
}

const STOP_WORDS = ['PHOTO MONTH', 'Overrun', 'Dues checkpoint', 'past Month 7'];
const alertLevel = (text) => (STOP_WORDS.some((w) => text.includes(w)) ? 'stop' : text.startsWith('Remind') || text.startsWith('Target') ? 'info' : 'warning');

export async function createSupabaseAdapter() {
  const { createClient } = await getSdk();
  let cachedSession = null;
  let endReason = null; // this tab's own note (see noteReason): only used when localStorage is blocked
  let usedNoteId = null; // the note this tab has already put on a SIGNED_OUT
  const hungLogouts = new Set(); // gives up each logout request still in flight (see logoutFetch, endSession)
  let askedAfterRefusalAt = 0;
  let startChecked = false; // getSession() looks for what this page's start-up found out only the first time
  const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
    global: {
      fetch: (input, init) => timedFetch(input, init, {
        storedUser: storedUserId,
        // An answer about the login that was stored when the request went out. If that login is not the stored one any more (it
        // was ended, and somebody else signed in), the answer is nobody's business: it must not label the next person's logout.
        onRefused: (reason, asked) => { if (asked !== storedUserId()) return; noteReason(reason, asked); askAfterRefusal(); },
        onNotFound: (asked) => { if (asked === storedUserId()) askAfterRefusal(); },
        logout: logoutFetch,
        vetUser,
      }),
    },
  });
  // The person whose login was stored when this page opened, i.e. the one its start-up refresh and first look are about.
  const startUid = storedUserId();

  /** Who the stored login belongs to, read from the stored session itself (best effort: null when there is none or it cannot be read). */
  function storedUserId() {
    try { return JSON.parse(localStorage.getItem(sb.auth.storageKey) || 'null')?.user?.id || null; } catch { return null; }
  }
  /** The claims of a JWT (the part between the dots), or null. */
  function claimsOf(jwt) {
    try { return JSON.parse(atob(String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; }
  }
  /**
   * The login server's answer about an access token (GET /user), before auth-js sees it. auth-js answers "session_not_found" by deleting
   * whatever login is stored when the answer arrives, not the one the question was about: a slow answer for Ali's old token, arriving
   * after Ali logged out and Sara logged in (on this tab or another one), would delete Sara's login, which stays valid on the
   * server, and send every tab to the login page. So an answer about a session that is not the stored one any more (or when nobody is
   * stored) is dropped like a lost connection: nothing is deleted, and the caller sees that the login changed (see confirmedLogin()).
   * When the session cannot be told apart (storage blocked, a token without a session id) the answer goes through as it came.
   */
  async function vetUser(init, res) {
    if (res.ok || res.status < 400 || res.status >= 500) return res;
    let code;
    try {
      const body = await res.clone().json();
      code = typeof body?.code === 'string' ? body.code : body?.error_code;
    } catch { return res; }
    if (code !== 'session_not_found') return res;
    const headers = init?.headers;
    const authorization = typeof headers?.get === 'function' ? headers.get('authorization') : headers && Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
    const asked = claimsOf(String(authorization || '').replace(/^Bearer /i, ''))?.session_id;
    let raw;
    try { raw = localStorage.getItem(sb.auth.storageKey); } catch { return res; }
    let stored = null;
    if (raw) {
      try { stored = JSON.parse(raw); } catch { return res; }
      if (typeof claimsOf(stored?.access_token)?.session_id !== 'string') return res;
    }
    if (typeof asked !== 'string') return res;
    if (stored && claimsOf(stored.access_token).session_id === asked) return res;
    throw new TypeError('The login server answered about a login that is not the stored one any more; the answer is dropped.');
  }
  /**
   * Remembers why the login is ending, in localStorage so the other tabs of this browser, which only see SIGNED_OUT, can say the same.
   * A note is about ONE login: it names the person (when known), is put on one SIGNED_OUT per tab, and goes when somebody
   * else signs in (on any tab), at the next sign-in here, at the next logout, or after REASON_TTL_MS, so it can never label a later logout.
   */
  function noteReason(reason, uid = storedUserId()) {
    endReason = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, reason, at: Date.now(), uid };
    try { localStorage.setItem(REASON_KEY, JSON.stringify(endReason)); } catch { /* storage blocked: only this tab hears it */ }
  }
  function forgetReason() {
    endReason = null;
    try { localStorage.removeItem(REASON_KEY); } catch { /* storage blocked */ }
  }
  /** The note every tab shares (another tab's sign-in removes it for all of them); this tab's own one when storage is blocked. */
  function readNote() {
    let raw;
    try { raw = localStorage.getItem(REASON_KEY); } catch { return endReason; }
    try { return JSON.parse(raw || 'null'); } catch { return null; }
  }
  /** The reason of a note made in the last REASON_TTL_MS that this tab has not used yet, or null. Using it marks it used. */
  function currentReason() {
    const note = readNote();
    if (typeof note?.reason !== 'string' || !Number.isFinite(note.at) || note.id === usedNoteId) return null;
    const age = Date.now() - note.at;
    if (age < 0 || age >= REASON_TTL_MS) return null;
    usedNoteId = note.id;
    return note.reason;
  }
  /**
   * `uid` is logged in now (an event of this tab, or one that another tab sent): a note that is not about this very person is no
   * longer anybody's business, and must not label a later logout of theirs. (A note without a name goes too: it cannot be shown to be theirs.)
   */
  function forgetNoteOfOtherPerson(uid) {
    const note = readNote();
    if (note && (!note.uid || note.uid !== uid)) forgetReason();
  }
  /** The reason ('switched_off' / 'account_gone') of a fresh note about `uid`'s login, or null. Reading it does not use it up. */
  function freshNoteAbout(uid) {
    const note = readNote();
    const age = Date.now() - note?.at;
    return uid && note?.uid === uid && typeof note.reason === 'string' && age >= 0 && age < REASON_TTL_MS ? note.reason : null;
  }
  const endedJustNow = (reason, uid) => freshNoteAbout(uid) === reason;

  /**
   * The logout request, which can be given up on: auth-js waits for it while holding its lock and, when it finally ends, removes
   * whatever login is stored then (a later person's included), so one that never answers must not be left hanging. Every request in
   * flight is kept (two logouts can overlap), and endSession() gives them all up together.
   */
  function logoutFetch(input, init = {}) {
    if (init.signal || typeof AbortController === 'undefined') return fetch(input, init);
    const ctrl = new AbortController();
    let drop = () => {};
    const dropped = new Promise((_, reject) => { drop = () => { ctrl.abort(); reject(new TypeError('The logout was given up: the login server did not answer in time.')); }; });
    dropped.catch(() => {}); // only the race below hands the rejection to auth-js
    const request = fetch(input, { ...init, signal: ctrl.signal });
    hungLogouts.add(drop);
    const done = () => { hungLogouts.delete(drop); };
    request.then(done, done);
    return Promise.race([request, dropped]);
  }

  /**
   * A token refresh was refused for a reason about the account (banned, deleted, or "refresh token not found", which is how a deleted
   * account is refused too). auth-js only ends the login by itself when the access token has run out; a refresh that fires early (its 90 s
   * margin) while the access token still works is refused and the login is kept, so nothing would notice until the token ran out. While
   * the access token works, the login server tells the cases apart (403 user_banned / user_not_found), so ask it once, from outside
   * auth-js's own lock, with the same strict rules as any other check (userId() ends only the login that is stored, only on such an
   * answer). Once is enough: asking again would learn nothing new. If the login is already gone there is nothing to ask about.
   */
  function askAfterRefusal() {
    if (Date.now() - askedAfterRefusalAt < 30000) return;
    askedAfterRefusalAt = Date.now();
    setTimeout(() => { userId().catch(() => { /* ended by userId() itself, or nothing to confirm: the next check looks again */ }); }, 0);
  }
  // Saves made with an idempotency key while the database functions are not installed:
  // key -> what the earlier attempt already wrote, so pressing Save again finishes that record instead of starting a new one.
  const partial = new Map();
  const missingRpcs = new Set();
  const cache = new Map();

  /** sb.rpc(), with the read time limit for the functions in READ_RPCS. A timeout comes back as res.error ("TIMEOUT: ..."). */
  async function callRpc(name, args) {
    if (!READ_RPCS.has(name) || typeof AbortController === 'undefined') return sb.rpc(name, args);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(timeoutError()), READ_TIMEOUT_MS);
    try {
      return await sb.rpc(name, args).abortSignal(ctrl.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Calls a database function; { missing: true } when it is not installed yet (PostgREST PGRST202 / 404). A timeout is an error, never "missing". */
  async function rpc(name, args) {
    if (missingRpcs.has(name)) return { missing: true };
    const res = await callRpc(name, args);
    if (res.error && (res.error.code === 'PGRST202' || res.status === 404)) { missingRpcs.add(name); return { missing: true }; }
    return { missing: false, data: check(res) };
  }

  /** Pages through a query (build() must return it with a stable order) until a short page or one row past the cap. */
  async function fetchPaged(build, cap) {
    const out = [];
    for (let from = 0; from <= cap; from += PAGE) {
      const to = Math.min(from + PAGE, cap + 1) - 1;
      const rows = check(await build().range(from, to));
      out.push(...rows);
      if (rows.length < to - from + 1) break;
    }
    return capped(out, cap);
  }

  /** Runs one request per ID_CHUNK ids (four at a time) and joins the rows. */
  async function byIdChunks(ids, fetchChunk) {
    const chunks = [];
    for (let i = 0; i < ids.length; i += ID_CHUNK) chunks.push(ids.slice(i, i + ID_CHUNK));
    const out = [];
    for (let i = 0; i < chunks.length; i += 4) {
      for (const rows of await Promise.all(chunks.slice(i, i + 4).map(fetchChunk))) out.push(...rows);
    }
    return out;
  }

  /** In-memory cache with a short life; a stale value is answered at once while a fresh one loads. */
  function cached(name, load, fresh = false) {
    const hit = cache.get(name);
    if (hit && !fresh && Date.now() - hit.at < CACHE_MS) return hit.promise;
    const next = { at: Date.now(), promise: load() };
    next.promise.then((value) => { next.value = value; }, () => {
      if (cache.get(name) !== next) return;
      if (hit?.value !== undefined) cache.set(name, hit); else cache.delete(name);
    });
    cache.set(name, next);
    return hit && !fresh && hit.value !== undefined ? Promise.resolve(hit.value) : next.promise;
  }
  const forget = (prefix) => { for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k); };

  /** Map(path -> signed url) for private files, signed in one request (thumbnails: see IMAGE_TRANSFORMS). */
  async function signedUrls(paths, { width, bucket = 'clinic-photos', expiresIn = SIGNED_URL_TTL } = {}) {
    let list = [...new Set((paths || []).filter(Boolean))];
    const out = new Map();
    if (!list.length) return out;
    const store = sb.storage.from(bucket);
    if (width && IMAGE_TRANSFORMS) {
      // A batch signature cannot carry an image transform, so thumbnails are signed in parallel, six at a time.
      for (let i = 0; i < list.length; i += 6) {
        await Promise.all(list.slice(i, i + 6).map(async (path) => {
          const { data } = await store.createSignedUrl(path, expiresIn, { transform: { width, quality: 70 } });
          if (data?.signedUrl) out.set(path, data.signedUrl);
        }));
      }
      list = list.filter((p) => !out.has(p));
      if (!list.length) return out;
    }
    const rows = check(await store.createSignedUrls(list, expiresIn));
    for (const r of rows || []) if (r?.signedUrl && !r.error) out.set(r.path, r.signedUrl);
    return out;
  }

  /**
   * Ends the stored login. The "local" scope of sb.auth.signOut goes through the same request, so it cannot rescue a hung one.
   * `reason` ('idle', ...) is passed on with the SIGNED_OUT event, here and in the other tabs of this browser.
   */
  async function endSession({ scope = 'global', reason = null, uid } = {}) {
    cachedSession = null;
    partial.clear();
    if (reason) noteReason(reason, uid); else forgetReason(); // a logout without a reason must not inherit the note of an earlier one
    let confirmed = false;
    try { confirmed = !(await withTimeout(sb.auth.signOut({ scope }), SIGNOUT_TIMEOUT_MS))?.error; } catch { /* timed out, or no connection */ }
    if (!confirmed) {
      // Requests that never answered are given up now (all of them, not only the latest): they would otherwise end whatever login is
      // stored when they finally do.
      for (const drop of [...hungLogouts]) drop();
      // Without this the tokens stay in localStorage, and a reload or a new tab is still signed in.
      Promise.resolve(sb.auth.stopAutoRefresh?.()).catch(() => {});
      const key = sb.auth.storageKey;
      if (key) for (const k of [key, `${key}-user`, `${key}-code-verifier`]) { try { localStorage.removeItem(k); } catch { /* storage blocked */ } }
    }
    return confirmed;
  }

  /** True for an answer that says there is no usable login (as opposed to one that says nothing: no connection, a 5xx, a rate limit, a timeout). */
  const isRefusal = (error) => error.name === 'AuthSessionMissingError' || (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429);

  /**
   * The stored login as { uid, jwt }, or null when there is none or the library's refresh of an expired token was refused. A refresh
   * that failed for a reason that says nothing about the login (offline, 5xx, 429) throws instead, like any failed read.
   */
  async function storedLogin() {
    const { data, error } = await sb.auth.getSession();
    const session = data?.session;
    if (session?.access_token && session.user?.id) return { uid: session.user.id, jwt: session.access_token };
    if (error && !isRefusal(error)) check({ error, status: error.status });
    return null;
  }

  /**
   * The login server (or the staff record) said this account is switched off or gone: end the login on this computer (the
   * server decides about other computers) with the reason, then fail with the same words. Never called for a failed or
   * slow answer. `uid` is the person the answer was about: an answer that arrives late, after somebody else has logged in (or
   * nobody is any more), is about a login that is already gone and must not end the stored one (nor label it), so then nothing is ended.
   * One exception: nobody is stored any more, and a note of the last few minutes says this very login was ended for this very reason
   * (another tab of this browser got there first): the answer is the same, so it is given as such (a page that was reloading then
   * still learns why), and nothing is ended or noted again.
   */
  async function endLogin(reason, uid) {
    let now;
    try { now = (await storedLogin())?.uid ?? null; } catch { now = undefined; } // undefined: could not be told just now
    if (now !== uid) {
      if (now === null && endedJustNow(reason, uid)) throw plainError(ACCOUNT_ERRORS[reason].message, ACCOUNT_ERRORS[reason].code);
      throw plainError('The login changed while it was being checked. Please try again.', 'LOGIN_CHANGED');
    }
    await endSession({ scope: 'local', reason, uid });
    throw plainError(ACCOUNT_ERRORS[reason].message, ACCOUNT_ERRORS[reason].code);
  }

  /**
   * The stored login as { uid, jwt } once the login server has confirmed that token, or null when the server confirms there is no
   * login (no session, or a token it refuses with a 4xx). A network failure, a 5xx or a rate limit is NOT "no login": it throws, so
   * getSession() never reports a valid login as gone and created_by / received_by / uploaded_by are never written as null
   * because one GET /user failed. The two final answers about the account end the login (and throw ACCOUNT_OFF / ACCOUNT_GONE):
   * GoTrue refuses even a still valid token of a switched-off account with 403 user_banned, and one of a deleted account with
   * 403 user_not_found. The question is asked with the stored token itself (not with whatever the library holds when the request
   * goes out), so the answer belongs to that person and only ever ends that person's login (see endLogin()).
   */
  async function confirmedLogin() {
    const login = await storedLogin();
    if (!login) return null;
    const { data, error } = await sb.auth.getUser(login.jwt);
    if (error) {
      if (error.code === 'user_banned') await endLogin('switched_off', login.uid);
      if (error.code === 'user_not_found') await endLogin('account_gone', login.uid);
      if (!isRefusal(error)) {
        // A failed answer (a dropped one too, see vetUser()) about a login that is not the stored one any more is no news either.
        const now = await storedLogin().then((l) => l?.uid ?? null, () => undefined);
        if (now !== undefined && now !== login.uid) throw plainError('The login changed while it was being checked. Please try again.', 'LOGIN_CHANGED');
        check({ error, status: error.status });
      }
    }
    return data?.user?.id ? { uid: data.user.id, jwt: login.jwt } : null;
  }
  async function userId() { return (await confirmedLogin())?.uid ?? null; }

  async function duesFor(ids) {
    if (!ids.length) return {};
    const rows = check(await callRpc('dues_for', { p_patients: ids }));
    return Object.fromEntries(rows.map((r) => [r.patient_id, Number(r.dues)]));
  }
  async function flagsFor(ids) {
    if (!ids.length) return {};
    const rows = await byIdChunks(ids, (part) => sb.from('patient_flags').select('*').in('patient_id', part).is('cleared_at', null).then(check));
    return Object.fromEntries(rows.map((r) => [r.patient_id, r]));
  }

  const VISIT_SELECT = '*, patient:patients(id,mr_number,full_name,phone,medical_history,photo_consent_public), visit_staff(clinician_id, role, clinician:clinicians(display_name))';
  async function enrichVisits(rows) {
    const ids = [...new Set(rows.map((r) => r.patient_id))];
    const [dues, flags] = await Promise.all([duesFor(ids), flagsFor(ids)]);
    return rows.map((v) => ({
      ...v,
      staff: (v.visit_staff || []).map((s) => ({ clinician_id: s.clinician_id, role: s.role, name: s.clinician?.display_name })),
      dues: dues[v.patient_id] ?? 0,
      see_dr_ali: !!flags[v.patient_id],
    }));
  }
  async function visitById(id) {
    const row = check(await sb.from('visits').select(VISIT_SELECT).eq('id', id).single());
    return (await enrichVisits([row]))[0];
  }
  async function staffNames() {
    const rows = check(await sb.from('staff').select('id,full_name'));
    return Object.fromEntries(rows.map((r) => [r.id, r.full_name]));
  }
  // Patients for a list of rows, fetched in short chunks (a long id list in one URL fails with 414).
  async function attachPatients(rows, key = 'patient_id') {
    const ids = [...new Set(rows.map((r) => r[key]).filter(Boolean))];
    if (!ids.length) return rows;
    const pats = await byIdChunks(ids, (part) => sb.from('patients').select('id,mr_number,full_name,phone,email').in('id', part).then(check));
    const byId = Object.fromEntries(pats.map((p) => [p.id, p]));
    return keepFlags(rows, rows.map((r) => ({ ...r, patient: byId[r[key]] || null })));
  }

  // Report queries share their filters; ordered newest first with the id as tie-break so pages never overlap.
  function paymentsQuery(columns, { from, to, branchId, method } = {}) {
    let q = sb.from('payments').select(columns).order('received_at', { ascending: false }).order('id', { ascending: false });
    if (from) q = q.gte('received_at', new Date(from + 'T00:00:00+05:00').toISOString());
    if (to) q = q.lt('received_at', new Date(new Date(to + 'T00:00:00+05:00').getTime() + 86400000).toISOString());
    if (branchId) q = q.eq('branch_id', Number(branchId));
    if (method) q = q.eq('method', method);
    return q;
  }
  function visitsQuery({ from, to, branchId } = {}) {
    let q = sb.from('visits').select('visit_date, branch_id, status, checked_in_at, started_at, patient_id').gte('visit_date', from).lte('visit_date', to)
      .order('visit_date', { ascending: false }).order('id', { ascending: true });
    if (branchId) q = q.eq('branch_id', Number(branchId));
    return q;
  }

  /**
   * The staff or patient record of the login `uid` (whose token is `jwt`), or null when it has none. A switched-off staff account
   * ends the login. Every read is sent with exactly that token, never with whatever the library holds when the request goes out:
   * a refresh in flight, or one that failed, makes it send the anonymous key, and an anonymous read comes back empty for a
   * person who does have a record.
   */
  async function loadProfile(uid, jwt) {
    const as = (query) => query.setHeader('Authorization', `Bearer ${jwt}`);
    const staff = check(await as(sb.from('staff').select('*').eq('id', uid)).maybeSingle());
    if (staff) {
      if (!staff.active) await endLogin('switched_off', uid);
      let perms;
      if (staff.role === 'admin') perms = new Set(PERMISSIONS.map((p) => p.key));
      else {
        const [grid, overrides] = await Promise.all([
          as(sb.from('role_permissions').select('permission_key,allowed').eq('role', staff.role)).then(check),
          as(sb.from('staff_permission_overrides').select('permission_key,allowed').eq('staff_id', uid)).then(check),
        ]);
        const map = Object.fromEntries(grid.map((g) => [g.permission_key, g.allowed]));
        for (const o of overrides) map[o.permission_key] = o.allowed;
        perms = new Set(Object.keys(map).filter((k) => map[k]));
      }
      return { kind: 'staff', staff, perms };
    }
    const patient = check(await as(sb.from('patients').select('*').eq('portal_user_id', uid)).maybeSingle());
    return patient ? { kind: 'patient', patient, perms: new Set() } : null;
  }

  return {
    mode: 'live',

    // ------------------------------------------------------------ auth
    async demoAccounts() { return []; },
    async signInDemo() { throw new Error('Demo accounts are not available on the live system.'); },
    async signIn(email, password) {
      forgetReason(); // a reason left by the last logout must not label a later one
      const res = await sb.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
      // A switched-off account is refused here with 400 user_banned: say it the way the rest of the app does.
      if (res.error?.code === 'user_banned') throw plainError(ACCOUNT_ERRORS.switched_off.message, ACCOUNT_ERRORS.switched_off.code);
      check(res);
      cachedSession = null;
      const session = await this.getSession();
      // Login log (security plan): the account records its own sign-in; Dr. Ali reads the log.
      try { if (session) await sb.from('login_events').insert({ user_id: await userId(), kind: session.kind, user_agent: navigator.userAgent.slice(0, 300) }); } catch { /* the log never blocks a login */ }
      return session;
    },
    /** True for staff login names (@STAFF_EMAIL_DOMAIN). They need no real inbox, so they get no reset emails. */
    isStaffEmail(email) {
      const domain = String(CONFIG.STAFF_EMAIL_DOMAIN || '').toLowerCase();
      return !!domain && String(email || '').trim().toLowerCase().endsWith('@' + domain);
    },
    async sendPasswordReset(email) {
      // Staff login emails do not need a real inbox: sending would bounce, and the person would wait for nothing.
      if (this.isStaffEmail(email)) throw plainError('Staff passwords are not reset by email. Ask Dr. Ali to set a new one under Admin → Staff accounts.', 'STAFF_RESET');
      check(await sb.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo: location.origin + '/reset-password.html' }));
    },
    async updatePassword(password) { check(await sb.auth.updateUser({ password })); },
    /**
     * Always ends the login on this computer, even with no connection: the server gets SIGNOUT_TIMEOUT_MS to confirm
     * (scope 'global' ends every session of this login, 'local' only this browser's), then the stored login is removed
     * by hand. Resolves true when the server confirmed, false when only this computer was signed out.
     */
    async signOut(opts) { return endSession(opts); },
    /**
     * Who is logged in: { kind: 'staff', staff, perms } or { kind: 'patient', patient, perms }, or null when nobody is, or when the
     * server cannot be asked right now (a failed request throws instead). A switched-off or deleted account ends the login
     * and throws ACCOUNT_OFF / ACCOUNT_GONE. { strict: true } (the login watcher) also treats a login that the server knows but
     * that has neither a staff nor a patient record any more as that final answer: asked twice, then checked once more.
     * { fresh: true } reads the record again instead of answering from the one remembered since the last login event.
     * The answer is about the login the server confirmed: if another person is logged in by the time it is complete, the
     * lookup fails with LOGIN_CHANGED instead of reporting the earlier person. A lookup that finds the login in motion (its token was
     * replaced while the empty answers came in) fails with LOGIN_UNCONFIRMED: no proof either way, the next event looks again.
     * The first look of a page (state.js, while loading) that finds nobody stored also reports an account that was switched off or
     * deleted: the login this page opened with was just ended for that reason (the page's own start-up refresh was refused as banned,
     * or another tab got there first), which is the same ACCOUNT_OFF / ACCOUNT_GONE failure as when the look itself ends the login.
     */
    async getSession({ strict = false, fresh = false } = {}) {
      const first = !startChecked;
      startChecked = true;
      const login = await confirmedLogin();
      if (!login) {
        const why = first ? freshNoteAbout(startUid) : null;
        if (ACCOUNT_ERRORS[why]) throw plainError(ACCOUNT_ERRORS[why].message, ACCOUNT_ERRORS[why].code);
        return null;
      }
      const { uid, jwt } = login;
      if (!fresh && cachedSession?.uid === uid && (cachedSession.value || !strict)) return cachedSession.value;
      let value = await loadProfile(uid, jwt);
      if (!value && strict) {
        value = await loadProfile(uid, jwt);
        if (!value) {
          // The empty answers were sent with this one token (see loadProfile()), so the server judged them as this person. They are proof
          // only if the login server still confirms the CURRENT stored login as this person's, on this same token: a refresh that landed
          // meanwhile, or another person's login, means these answers describe a login that is no longer the stored one.
          const now = await confirmedLogin();
          if (now?.uid === uid && now.jwt === jwt) await endLogin('account_gone', uid);
          throw plainError('The login could not be confirmed just now.', 'LOGIN_UNCONFIRMED');
        }
      }
      if ((await storedLogin().catch(() => null))?.uid !== uid) throw plainError('The login changed while it was being checked. Please try again.', 'LOGIN_CHANGED');
      cachedSession = { uid, value };
      return value;
    },
    // fn(eventName, reason) runs after every login event (SIGNED_IN, TOKEN_REFRESHED, SIGNED_OUT ...); reason comes with SIGNED_OUT only
    // (see ACCOUNT_ERRORS). Its result is deliberately not returned: auth-js waits for this callback before it carries on, so handing
    // back fn's promise would make it wait for the app's own network calls (and deadlock when a lock is held and fn asks for the session).
    // Returns the function that stops listening.
    onAuthChange(fn) {
      const { data } = sb.auth.onAuthStateChange((event, session) => {
        cachedSession = null;
        if (session?.user?.id) forgetNoteOfOtherPerson(session.user.id); // somebody is logged in: a note about anybody else is over
        fn(event, event === 'SIGNED_OUT' ? currentReason() : null);
      });
      // A tab that logs out without a connection (or whose logout request hangs) removes the stored login by hand, and then sends
      // the other tabs no event at all. That removal arrives here as a storage event (only in the other tabs, never the one doing it).
      const onStorage = (e) => {
        if (e.key !== null && e.key !== sb.auth.storageKey) return;
        let stored;
        try { stored = localStorage.getItem(sb.auth.storageKey); } catch { return; }
        if (!stored) { cachedSession = null; fn('SIGNED_OUT', currentReason()); }
      };
      window.addEventListener('storage', onStorage);
      return () => { data.subscription.unsubscribe(); window.removeEventListener('storage', onStorage); };
    },

    // ------------------------------------------------------------ reference
    async branches() { return check(await sb.from('branches').select('*').eq('active', true).order('sort_order')); },
    async cities() { return check(await sb.from('cities').select('*').order('id')); },
    async clinicians() { return check(await sb.from('clinicians').select('*').eq('active', true).order('display_name')); },
    async treatments() { return check(await sb.from('treatments').select('*').eq('active', true).order('sort_order')); },
    async expenseCategories() { return check(await sb.from('expense_categories').select('*').eq('active', true).order('sort_order')); },
    async settings() {
      const rows = check(await sb.from('app_settings').select('key,value'));
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },
    // Public schedule and gallery are cached for a few minutes (route changes reuse them); { fresh: true } skips the cache.
    async schedule({ fresh = false } = {}) {
      return (await cached('schedule', async () => check(await sb.from('dr_ali_schedule').select('*')), fresh)).slice();
    },
    /** Gallery images: url (640px wide when IMAGE_TRANSFORMS is on, else the original), full_url, srcset (or null), view_label. */
    async publicCases({ limit = 60, fresh = false } = {}) {
      const rows = await cached(`publicCases:${limit}`, async () => {
        const bucket = sb.storage.from('public-cases');
        const files = check(await bucket.list('', { limit, sortBy: { column: 'created_at', order: 'desc' } }));
        const url = (name, width) => bucket.getPublicUrl(name, width ? { transform: { width, quality: 70 } } : undefined).data.publicUrl;
        return files.filter((f) => f.name && !f.name.startsWith('.')).map((f) => ({
          id: f.id,
          url: IMAGE_TRANSFORMS ? url(f.name, 640) : url(f.name),
          full_url: url(f.name),
          srcset: IMAGE_TRANSFORMS ? [320, 640, 960].map((w) => `${url(f.name, w)} ${w}w`).join(', ') : null,
          view_label: f.name,
        }));
      }, fresh);
      return rows.slice();
    },
    signedUrls,

    // ------------------------------------------------------------ patients
    async searchPatients(q) {
      const t = (q || '').trim();
      let query = sb.from('patients').select('*').order('created_at', { ascending: false }).limit(51);
      if (t) {
        const digits = t.replace(/\D/g, '');
        const ors = [`full_name.ilike.%${t.replace(/[%,()]/g, '')}%`, `mr_number.eq.${t.replace(/[,()]/g, '')}`];
        if (digits.length >= 4) ors.push(`phone.ilike.%${digits}%`);
        query = query.or(ors.join(','));
      }
      const rows = capped(check(await query), 50);
      const ids = rows.map((r) => r.id);
      const [dues, flags, cases] = await Promise.all([duesFor(ids), flagsFor(ids),
        ids.length ? sb.from('braces_cases').select('patient_id').in('patient_id', ids).eq('status', 'active').then(check) : []]);
      const active = new Set(cases.map((c) => c.patient_id));
      return keepFlags(rows, rows.map((p) => ({ ...p, dues: dues[p.id] ?? 0, see_dr_ali: !!flags[p.id], braces_active: active.has(p.id) })));
    },
    async findDuplicates(name, phone) {
      return check(await callRpc('find_possible_duplicates', { p_name: name || '', p_phone: phone || '' }));
    },
    async createPatient(row) {
      const clean = { ...row, first_branch_id: row.first_branch_id ? Number(row.first_branch_id) : null };
      if (!clean.mr_number) delete clean.mr_number;
      return check(await sb.from('patients').insert(clean).select().single());
    },
    async updatePatient(id, changes) {
      return check(await sb.from('patients').update(changes).eq('id', id).select().single());
    },
    async invitePatient(id) {
      const { data, error } = await sb.functions.invoke('admin-users', { body: { action: 'invite_patient', patient_id: id } });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
    },
    /**
     * Everything on a patient's record, fetched in parallel. Photos carry url (original), thumb_url (240px when
     * IMAGE_TRANSFORMS is on, else the original) and url_expires_at (ms); documents carry url and url_expires_at. Signed in one batch per bucket.
     * Re-sign an expired link with signedUrls([storage_path]) (documents: { bucket: 'patient-documents' }).
     */
    async getPatient(id) {
      const signed = (rows, opts) => signedUrls(rows.map((r) => r.storage_path), opts).catch(() => new Map());
      const [p, visits, invoices, payments, photos, retainers, complaints, braces_case, dues, flags, documents, plans] = await Promise.all([
        sb.from('patients').select('*').eq('id', id).single().then(check),
        sb.from('visits').select(VISIT_SELECT).eq('patient_id', id).order('visit_date', { ascending: false }).then(check).then(enrichVisits),
        sb.from('invoices').select('*, items:invoice_items(*)').eq('patient_id', id).order('issue_date', { ascending: false }).then(check),
        sb.from('payments').select('*').eq('patient_id', id).order('received_at', { ascending: false }).then(check),
        sb.from('photos').select('*').eq('patient_id', id).order('taken_on', { ascending: false }).then(check).then(async (rows) => {
          const [full, thumbs] = await Promise.all([signed(rows), IMAGE_TRANSFORMS ? signed(rows, { width: 240 }) : null]);
          const expires = Date.now() + SIGNED_URL_TTL * 1000;
          for (const ph of rows) {
            ph.url = full.get(ph.storage_path) || null;
            ph.thumb_url = thumbs?.get(ph.storage_path) || ph.url;
            ph.url_expires_at = expires;
          }
          return rows;
        }),
        sb.from('retainer_cases').select('*').eq('patient_id', id).then(check),
        sb.from('complaints').select('*, messages:complaint_messages(*)').eq('patient_id', id).order('created_at', { ascending: false }).then(check),
        sb.from('braces_cases').select('*').eq('patient_id', id).eq('status', 'active').then(check).then(async (cases) => {
          if (!cases[0]) return null;
          const next = check(await callRpc('next_braces_month', { p_case: cases[0].id }));
          return { ...cases[0], next_month: next };
        }),
        duesFor([id]), flagsFor([id]),
        sb.from('patient_documents').select('*').eq('patient_id', id).order('added_on', { ascending: false }).then(check).then(async (rows) => {
          const urls = await signed(rows, { bucket: 'patient-documents' });
          const expires = Date.now() + SIGNED_URL_TTL * 1000;
          for (const doc of rows) { doc.url = urls.get(doc.storage_path) || null; doc.url_expires_at = expires; }
          return rows;
        }),
        this.paymentPlans(id).catch(() => []),
      ]);
      return { ...p, dues: dues[id] ?? 0, flag: flags[id] || null, braces_case, visits, invoices, payments, photos, documents: documents || [], plans: plans || [], retainers, complaints };
    },

    // ------------------------------------------------------------ braces
    async bracesGuidance(patientId) {
      const g = check(await callRpc('braces_guidance', { p_patient: patientId }));
      if (g?.alerts) g.alerts = g.alerts.map((text) => ({ level: alertLevel(text), text }));
      return g;
    },
    async startBracesCase(patientId, fields) {
      return check(await sb.from('braces_cases').insert({
        patient_id: patientId, start_date: fields.start_date || todayISO(), kit_name: fields.kit_name || null,
        total_fee: fields.total_fee ? Number(fields.total_fee) : null, created_by: await userId(),
      }).select().single());
    },
    async updateBracesCase(id, changes) {
      return check(await sb.from('braces_cases').update(changes).eq('id', id).select().single());
    },

    // ------------------------------------------------------------ visits
    async listVisits({ branchId, date }) {
      let q = sb.from('visits').select(VISIT_SELECT).eq('visit_date', date).order('token_no', { ascending: true, nullsFirst: false });
      if (branchId) q = q.eq('branch_id', Number(branchId));
      return enrichVisits(check(await q));
    },
    // Live updates: calls onChange the moment any visit at this branch (or a
    // visit's doctor list) changes. Returns a function that stops listening.
    subscribeVisits(branchId, onChange) {
      const ch = sb.channel(`visits-${branchId || 'all'}-${Math.random().toString(36).slice(2)}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'visits', ...(branchId ? { filter: `branch_id=eq.${Number(branchId)}` } : {}) }, onChange)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'visit_staff' }, onChange)
        .subscribe();
      return () => { sb.removeChannel(ch); };
    },
    async addVisit(row) {
      const insert = { patient_id: row.patient_id, branch_id: Number(row.branch_id), visit_date: row.visit_date || todayISO(),
        status: row.status || 'waiting', treatment_label: row.treatment_label || null, details_text: row.details_text || null, notes: row.notes || null };
      if (row.braces || /monthly/i.test(row.treatment_label || '')) {
        const cases = check(await sb.from('braces_cases').select('id').eq('patient_id', row.patient_id).eq('status', 'active'));
        if (cases[0]) { insert.braces_case_id = cases[0].id; if (row.braces_month) insert.braces_month = row.braces_month; }
      }
      const created = check(await sb.from('visits').insert(insert).select('id').single());
      return visitById(created.id);
    },
    async updateVisit(id, changes) {
      const patch = { ...changes };
      // Only an override stamps who made it; any other change must not depend on a request to the login server.
      if (patch.dues_override_by === true || patch.protocol_override_by === true) {
        const uid = await userId();
        if (patch.dues_override_by === true) patch.dues_override_by = uid;
        if (patch.protocol_override_by === true) patch.protocol_override_by = uid;
      }
      delete patch.patient; delete patch.staff; delete patch.dues; delete patch.see_dr_ali; delete patch.visit_staff;
      check(await sb.from('visits').update(patch).eq('id', id));
      return visitById(id);
    },
    async setVisitStaff(visitId, clinicianId, role, add = true) {
      if (add) check(await sb.from('visit_staff').insert({ visit_id: visitId, clinician_id: clinicianId, role }));
      else {
        check(await sb.from('visit_staff').delete().match({ visit_id: visitId, clinician_id: clinicianId, role }));
        if (role === 'checker') check(await sb.from('visits').update({ checked_by: null, checked_at: null }).eq('id', visitId).eq('checked_by', clinicianId));
      }
      return visitById(visitId);
    },

    // ------------------------------------------------------------ photos
    /**
     * Pass { idempotencyKey } (one crypto.randomUUID() per file, kept across retries): the file then has a fixed
     * storage path, so pressing Save again after a failure neither uploads it twice nor records it twice.
     */
    async uploadPhoto({ patientId, visitId, file, viewLabel, branchId, kind = 'raw', publicOk = false, idempotencyKey = null }, opts = {}) {
      const key = opts.idempotencyKey || idempotencyKey || null;
      const prior = key ? partial.get('photo:' + key) : null;
      if (prior?.row) return prior.row;
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
      const folder = kind === 'edited' ? 'edited' : 'raw';
      const path = prior?.path || `${patientId}/${folder}/${todayISO()}_${(viewLabel || 'photo').replace(/\W+/g, '-')}_${(key || crypto.randomUUID()).slice(0, 8)}.${ext}`;
      if (!prior?.uploaded) {
        const { error } = await sb.storage.from('clinic-photos').upload(path, file, { contentType: file.type, upsert: false });
        // Same key, same path: "already exists" means an earlier attempt uploaded it.
        const duplicate = error && key && (String(error.statusCode || error.status) === '409' || /already exists|duplicate/i.test(error.message || ''));
        if (error && !duplicate) check({ error });
        if (key) partial.set('photo:' + key, { path, uploaded: true });
        if (duplicate) {
          const existing = check(await sb.from('photos').select('*').eq('storage_path', path).maybeSingle());
          if (existing) { partial.set('photo:' + key, { path, uploaded: true, row: existing }); return existing; }
        }
      }
      const row = check(await sb.from('photos').insert({
        patient_id: patientId, visit_id: visitId || null, branch_id: branchId || null, view_label: viewLabel || null,
        storage_path: path, kind, public_ok: kind === 'edited' && !!publicOk, uploaded_by: await userId(),
      }).select().single());
      if (key) partial.set('photo:' + key, { path, uploaded: true, row });
      return row;
    },
    // Admin puts a consented, edited before/after photo on the public website gallery.
    async publishPhoto(photo) {
      if (!photo.public_ok) throw new Error('This photo is not marked as allowed on the website.');
      const name = `${photo.taken_on}_${(photo.view_label || 'case').replace(/\W+/g, '-')}_${photo.id.slice(0, 8)}.${photo.storage_path.split('.').pop()}`;
      check(await sb.storage.from('clinic-photos').copy(photo.storage_path, name, { destinationBucket: 'public-cases' }));
      forget('publicCases');
      return sb.storage.from('public-cases').getPublicUrl(name).data.publicUrl;
    },
    // Consent forms, ID copies, reports: private "patient-documents" bucket, one folder per patient.
    async uploadDocument({ patientId, file, kind = 'other', title, addedOn }) {
      const ext = (file.name.split('.').pop() || 'pdf').toLowerCase();
      const slug = (title || file.name.replace(/\.[^.]+$/, '')).replace(/\W+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'document';
      const path = `${patientId}/${addedOn || todayISO()}_${slug}_${crypto.randomUUID().slice(0, 8)}.${ext}`;
      check(await sb.storage.from('patient-documents').upload(path, file, { contentType: file.type || undefined, upsert: false }));
      return check(await sb.from('patient_documents').insert({
        patient_id: patientId, kind, title: title || file.name, storage_path: path, added_on: addedOn || todayISO(), uploaded_by: await userId(),
      }).select().single());
    },

    // ------------------------------------------------------------ billing
    /**
     * One database call (save_invoice: invoice + lines + issue, all or nothing). Pass { idempotencyKey } (a
     * crypto.randomUUID() made when the form opens) so a retried Save returns the same invoice instead of a second one.
     * The same key with different details is refused (IDEMPOTENCY_MISMATCH): the first save did go through.
     * Without the migration it falls back to the old three steps. A retry finishes the same draft: with the lines the
     * form has NOW (an earlier attempt that stopped half way is rewritten), or returns the invoice if it was issued.
     */
    async createInvoice({ patient_id, branch_id, items, discount_amount = 0, discount_reason = null, visit_id = null, idempotencyKey = null }, opts = {}) {
      const key = opts.idempotencyKey || idempotencyKey || null;
      const lines = items.map((it) => ({ description: it.description, quantity: Number(it.quantity || 1), unit_price: Number(it.unit_price) }));
      const header = { patient_id, branch_id: Number(branch_id), visit_id, discount_amount: Number(discount_amount) || 0, discount_reason };
      const viaRpc = await rpc('save_invoice', { p_idempotency_key: key, p_invoice: header, p_items: lines });
      if (!viaRpc.missing) return viaRpc.data;

      const subtotal = items.reduce((s, it) => s + Number(it.quantity || 1) * Number(it.unit_price || 0), 0);
      const sig = JSON.stringify([header, lines]); // what this attempt was asked to save
      const full = async (id) => check(await sb.from('invoices').select('*, items:invoice_items(*)').eq('id', id).single());
      const earlier = key ? partial.get('invoice:' + key) : null;
      let inv = earlier ? check(await sb.from('invoices').select('*, items:invoice_items(id)').eq('id', earlier.id).maybeSingle()) : null;
      if (inv?.status === 'void') inv = null; // voided since: this is a new invoice
      // The one half-finished state that is not a draft: the header went in over the person's discount limit, so the database
      // made it "pending approval" at once, and the lines insert never happened (the connection dropped between the two).
      const waitingNoLines = inv?.status === 'pending_approval' && !inv.items?.length;
      if (inv && inv.status !== 'draft') {
        // An earlier attempt got as far as issuing it (or sending it for discount approval): the same save again, or a mismatch.
        // The approval request was raised for the discount that attempt asked for and cannot be changed from here, so a
        // changed form is a mismatch even while the lines are missing (editing the discount now would get a bigger one approved).
        if (earlier.sig !== sig) throw mismatchError(`invoice ${inv.invoice_no}`, 'void it');
        // Not yet complete: carry on below, which adds the lines to this invoice. Never issue it: only an approver can.
        if (!waitingNoLines) return full(inv.id);
      }
      // Saved as a draft first so its lines can be added, then issued. Discounts above
      // the person's limit stay "pending approval" (the database decides).
      let status = inv?.status;
      const edited = !!inv && earlier.sig !== sig; // a draft left by an attempt that stopped half way, and the form was changed since
      if (!inv) {
        inv = check(await sb.from('invoices').insert({
          patient_id, branch_id: header.branch_id, visit_id, subtotal, discount_amount: header.discount_amount,
          discount_reason, status: 'draft',
        }).select().single());
        inv.items = [];
        status = inv.status;
        if (key) partial.set('invoice:' + key, { id: inv.id, sig });
      } else if (edited) {
        // Nobody can delete a draft invoice, so the one left over is rewritten with the lines the form has now. The order
        // matters: the discount rules re-check on every change, and an invoice with no lines counts as 100% off. So clear the
        // discount, swap the lines, then set the discount again against the real subtotal (like a first save does).
        check(await sb.from('invoices').update({ branch_id: header.branch_id, visit_id, discount_amount: 0, discount_reason: null }).eq('id', inv.id));
        if (inv.items?.length) check(await sb.from('invoice_items').delete().eq('invoice_id', inv.id));
        inv.items = [];
        partial.set('invoice:' + key, { id: inv.id, sig });
      }
      if (!inv.items?.length) check(await sb.from('invoice_items').insert(lines.map((it) => ({ invoice_id: inv.id, ...it }))));
      if (edited) status = check(await sb.from('invoices').update({ discount_amount: header.discount_amount, discount_reason }).eq('id', inv.id).select('status').single()).status;
      if (status === 'draft') check(await sb.from('invoices').update({ status: 'issued' }).eq('id', inv.id));
      return full(inv.id);
    },
    async recordPayment({ patient_id, branch_id, amount, method = 'cash', invoice_id = null, notes = null }) {
      return check(await sb.from('payments').insert({ patient_id, branch_id: Number(branch_id), amount: Number(amount), method, invoice_id, notes, received_by: await userId() }).select().single());
    },
    async voidInvoice(id, reason) {
      // A blank reason goes to the database as NULL, which its void rule refuses ("A reason is required to void an invoice").
      check(await sb.from('invoices').update({ status: 'void', void_reason: reason?.trim() || null }).eq('id', id));
    },
    // Invoices and payments only (no photos): what the payment form needs to match money to invoices.
    async patientBilling(patientId) {
      const [invoices, payments] = await Promise.all([
        sb.from('invoices').select('id,invoice_no,issue_date,subtotal,discount_amount,total,status').eq('patient_id', patientId).order('issue_date').then(check),
        sb.from('payments').select('id,invoice_id,amount,received_at').eq('patient_id', patientId).then(check),
      ]);
      return { invoices, payments };
    },
    // ------------------------------------------------------------ installment plans
    async paymentPlans(patientId) {
      return check(await sb.from('payment_plans').select('*, installments:plan_installments(*)').eq('patient_id', patientId).order('created_at', { ascending: false }));
    },
    /** One database call (save_installment_plan: plan + installments together). { idempotencyKey } and the retry rules as for createInvoice. */
    async savePaymentPlan({ patient_id, braces_case_id = null, total_fee, starts_on, notes = null, installments, idempotencyKey = null }, opts = {}) {
      const key = opts.idempotencyKey || idempotencyKey || null;
      const head = { patient_id, braces_case_id, total_fee: Number(total_fee), starts_on: starts_on || todayISO(), notes };
      const rows = installments.map((i) => ({ due_date: i.due_date, amount: Number(i.amount), note: i.note || null }));
      const viaRpc = await rpc('save_installment_plan', { p_idempotency_key: key, p_plan: head, p_installments: rows });
      if (!viaRpc.missing) return viaRpc.data;

      const sig = JSON.stringify([head, rows]); // what this attempt was asked to save
      const earlier = key ? partial.get('plan:' + key) : null;
      let plan = earlier ? check(await sb.from('payment_plans').select('*, installments:plan_installments(id)').eq('id', earlier.id).maybeSingle()) : null;
      // The installments go in with one insert, so a plan that has any has all of them: an earlier attempt that completed.
      if (plan?.installments?.length && earlier.sig !== sig) throw mismatchError('this payment plan', 'delete the plan');
      if (!plan) {
        plan = check(await sb.from('payment_plans').insert({ ...head, created_by: await userId() }).select().single());
        plan.installments = [];
        if (key) partial.set('plan:' + key, { id: plan.id, sig });
      } else if (!plan.installments?.length && earlier.sig !== sig) {
        // The earlier attempt stopped after the plan row and the form was edited since: the plan takes the edited details.
        const { patient_id: _same, ...edits } = head;
        plan = { ...check(await sb.from('payment_plans').update(edits).eq('id', plan.id).select().single()), installments: [] };
        partial.set('plan:' + key, { id: plan.id, sig });
      }
      if (!plan.installments?.length) check(await sb.from('plan_installments').insert(rows.map((i) => ({ plan_id: plan.id, ...i }))));
      const { installments: _done, ...row } = plan;
      return row;
    },
    async deletePaymentPlan(id) { check(await sb.from('payment_plans').delete().eq('id', id)); },
    // Installments that are overdue or due within a week, for the coordinator's call list.
    async installmentsDue() {
      const rows = check(await sb.from('installment_status').select('*').in('status', ['overdue', 'due_soon']).order('due_date'));
      return attachPatients(rows);
    },
    async discountRequests() {
      const rows = check(await sb.from('discount_requests').select('*, invoice:invoices(*)').eq('status', 'pending').order('created_at'));
      const names = await staffNames();
      return attachPatients(rows.map((r) => ({ ...r, patient_id: r.invoice?.patient_id, requested_by_name: names[r.requested_by] })));
    },
    async decideDiscount(id, approve) { check(await sb.rpc('decide_discount', { p_request: id, p_approve: approve })); },

    // ------------------------------------------------------------ flags & complaints
    async raiseFlag(patientId, reason) {
      check(await sb.from('patient_flags').insert({ patient_id: patientId, reason, raised_by: await userId() }));
    },
    async clearFlag(flagId, note) {
      check(await sb.from('patient_flags').update({ cleared_at: new Date().toISOString(), cleared_by: await userId(), cleared_note: note || null }).eq('id', flagId));
    },
    async reviewList() {
      const rows = check(await sb.from('dr_ali_review_list').select('*').order('since', { ascending: false }));
      const flags = check(await sb.from('patient_flags').select('id,patient_id').is('cleared_at', null));
      const flagId = Object.fromEntries(flags.map((f) => [f.patient_id, f.id]));
      return (await attachPatients(rows)).map((r) => ({ ...r, flag_id: r.source === 'flag' ? flagId[r.patient_id] : null }));
    },
    async complaints() {
      const rows = check(await sb.from('complaints').select('*, messages:complaint_messages(*)').order('created_at', { ascending: false }));
      return attachPatients(rows);
    },
    async fileComplaint({ subject, body }) {
      const s = await this.getSession();
      return check(await sb.from('complaints').insert({ patient_id: s.patient.id, branch_id: s.patient.first_branch_id, subject, body }).select().single());
    },
    async replyComplaint(id, body, internal = false) {
      check(await sb.from('complaint_messages').insert({ complaint_id: id, author_staff: await userId(), body, internal_note: internal }));
      check(await sb.from('complaints').update({ status: 'in_progress' }).eq('id', id).eq('status', 'new'));
    },
    async setComplaintStatus(id, status) {
      const patch = { status };
      // Resolving stamps who and when; moving it to any other status (Reopen) clears the stamp so the old date does not linger.
      if (status === 'resolved') { patch.resolved_at = new Date().toISOString(); patch.resolved_by = await userId(); }
      else { patch.resolved_at = null; patch.resolved_by = null; }
      check(await sb.from('complaints').update(patch).eq('id', id));
    },
    async linkComplaintDoctor(id, clinicianId) { check(await sb.from('complaints').update({ clinician_id: clinicianId || null }).eq('id', id)); },

    // ------------------------------------------------------------ coordinator (capped lists: .truncated / .cap)
    // The three lists below leave out what is finished (old ones), so the cap is rarely reached.
    // Lab work: open statuses (sent, received, returned to the lab) always; fitted or cancelled only while recently changed.
    async labCases() {
      const since = addDaysISO(todayISO(), -FINISHED_LISTED_DAYS);
      return attachPatients(capped(check(await sb.from('lab_cases').select('*').or(`status.in.(sent,received,returned),updated_at.gte.${since}`).order('sent_date', { ascending: false }).limit(301)), 300));
    },
    async saveLabCase(row) {
      const { patient, ...data } = row;
      if (data.id) check(await sb.from('lab_cases').update(data).eq('id', data.id));
      else check(await sb.from('lab_cases').insert({ ...data, created_by: await userId() }));
    },
    async retainerCases() { return attachPatients(capped(check(await sb.from('retainer_cases').select('*').neq('stage', 'closed').order('created_at', { ascending: false }).limit(301)), 300)); },
    async saveRetainerCase(row) {
      const { patient, ...data } = row;
      if (data.id) check(await sb.from('retainer_cases').update(data).eq('id', data.id));
      else check(await sb.from('retainer_cases').insert({ ...data, created_by: await userId() }));
    },
    async reminders() { return attachPatients(capped(check(await sb.from('reminders').select('*').not('status', 'in', '(done,cancelled)').order('due_date').limit(501)), 500)); },
    async saveReminder(row) {
      const { patient, ...data } = row;
      if (data.id) check(await sb.from('reminders').update(data).eq('id', data.id));
      else check(await sb.from('reminders').insert({ ...data, created_by: await userId() }));
    },
    async dropoffs() { return attachPatients(check(await sb.from('braces_dropoffs').select('*').order('last_visit', { ascending: true, nullsFirst: true }))); },
    async lowRatings() {
      const settings = await this.settings();
      return attachPatients(check(await sb.from('visit_ratings').select('*').lte('stars', Number(settings.low_rating_threshold ?? 3)).is('followed_up_at', null).order('created_at', { ascending: false })));
    },
    async followUpRating(visitId) {
      check(await sb.from('visit_ratings').update({ followed_up_by: await userId(), followed_up_at: new Date().toISOString() }).eq('visit_id', visitId));
    },

    // ------------------------------------------------------------ stock
    async inventory(branchId) {
      const [items, stock, moves] = await Promise.all([
        sb.from('inventory_items').select('*').order('category').order('name').then(check),
        sb.from('inventory_stock').select('*').eq('branch_id', Number(branchId)).then(check),
        sb.from('inventory_moves').select('*').eq('branch_id', Number(branchId)).order('created_at', { ascending: false }).limit(50).then(check).catch(() => []),
      ]);
      return { items, stock, moves };
    },
    async saveInventoryItem(row) {
      const { id, ...data } = row;
      if (id) check(await sb.from('inventory_items').update(data).eq('id', id)); else check(await sb.from('inventory_items').insert(data));
    },
    async moveStock({ branch_id, item_id, change, reason, visit_id = null }) {
      check(await sb.from('inventory_moves').insert({ branch_id: Number(branch_id), item_id: Number(item_id), change: Number(change), reason, visit_id, created_by: await userId() }));
    },
    async setReorderLevel({ branch_id, item_id, reorder_level }) {
      check(await sb.from('inventory_stock').upsert({ branch_id: Number(branch_id), item_id: Number(item_id), reorder_level: Number(reorder_level) }, { onConflict: 'branch_id,item_id' }));
    },

    // ------------------------------------------------------------ accounts
    async expenses({ from, to } = {}) {
      return fetchPaged(() => {
        let q = sb.from('expenses').select('*').order('expense_date', { ascending: false }).order('id', { ascending: false });
        if (from) q = q.gte('expense_date', from);
        if (to) q = q.lte('expense_date', to);
        return q;
      }, 5000);
    },
    async addExpense(row) {
      const branches = await this.branches();
      const branch = branches.find((b) => b.id === Number(row.branch_id));
      return check(await sb.from('expenses').insert({
        expense_date: row.expense_date, branch_id: branch ? branch.id : null, city_id: branch ? branch.city_id : Number(row.city_id),
        category_id: Number(row.category_id), amount: Number(row.amount), paid_to: row.paid_to || null, method: row.method || 'cash',
        notes: row.notes || null, created_by: await userId(),
      }).select().single());
    },
    // Receipt photo or PDF for an expense: private "receipts" bucket, <expense id>.<ext>.
    async uploadReceipt(expenseId, file) {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const path = `${expenseId}.${ext}`;
      check(await sb.storage.from('receipts').upload(path, file, { contentType: file.type || undefined, upsert: true }));
      check(await sb.from('expenses').update({ receipt_path: path }).eq('id', expenseId));
      return path;
    },
    async receiptUrl(path) {
      const { data, error } = await sb.storage.from('receipts').createSignedUrl(path, 600);
      if (error) throw error;
      return data.signedUrl;
    },
    async branchPnl(month) {
      const first = month + '-01';
      const [rows, branches] = await Promise.all([sb.from('branch_monthly_pnl').select('*').eq('month', first).then(check), this.branches()]);
      // One row per branch, then one row per city for expenses recorded without a branch (branch_id null).
      return [
        ...branches.map((b) => {
          const r = rows.find((x) => x.branch_id === b.id) || {};
          return { branch_id: b.id, branch: b.name, city_id: b.city_id, income: Number(r.income || 0), expenses: Number(r.expenses || 0), profit: Number(r.profit || 0) };
        }),
        ...rows.filter((x) => x.branch_id == null && Number(x.expenses) > 0).map((x) => ({
          branch_id: null, branch: null, city_id: x.city_id, income: 0, expenses: Number(x.expenses), profit: -Number(x.expenses),
        })),
      ];
    },
    async expectedCash(branchId, date) {
      const start = new Date(date + 'T00:00:00+05:00').toISOString();
      const end = new Date(date + 'T23:59:59.999+05:00').toISOString();
      const rows = check(await sb.from('payments').select('amount').eq('branch_id', Number(branchId)).eq('method', 'cash').gte('received_at', start).lte('received_at', end));
      return rows.reduce((s, r) => s + Number(r.amount), 0);
    },
    async closeCash(branchId, date, counted, notes) {
      return check(await sb.rpc('close_cash', { p_branch: Number(branchId), p_date: date, p_counted: Number(counted), p_notes: notes || null }));
    },
    async cashClosings() { return capped(check(await sb.from('cash_closings').select('*').order('closing_date', { ascending: false }).limit(201)), 200); },
    async verifyClosing(id) { check(await sb.from('cash_closings').update({ verified_by: await userId(), verified_at: new Date().toISOString() }).eq('id', id)); },
    // ---- report queries (Reports page): payments, invoices, advances, daily visits in a date range.
    // Lists page through every row up to the cap (then .truncated); totals should come from paymentsSummary / opdSummary.
    async paymentsReport({ from, to, branchId, method } = {}) {
      const [rows, names] = await Promise.all([fetchPaged(() => paymentsQuery('*, invoice:invoices(invoice_no)', { from, to, branchId, method }), 5000), staffNames()]);
      return attachPatients(keepFlags(rows, rows.map((r) => ({ ...r, invoice_no: r.invoice?.invoice_no || null, received_by_name: names[r.received_by] || null }))));
    },
    async invoicesReport({ from, to, branchId, status, discounted } = {}) {
      const build = () => {
        let q = sb.from('invoices').select('*').order('issue_date', { ascending: false }).order('id', { ascending: false });
        if (from) q = q.gte('issue_date', from);
        if (to) q = q.lte('issue_date', to);
        if (branchId) q = q.eq('branch_id', Number(branchId));
        if (status) q = q.eq('status', status);
        if (discounted) q = q.gt('discount_amount', 0);
        return q;
      };
      const [rows, names] = await Promise.all([fetchPaged(build, 5000), staffNames()]);
      return attachPatients(keepFlags(rows, rows.map((r) => ({ ...r, created_by_name: names[r.created_by] || null }))));
    },
    async advances() {
      const rows = capped(check(await sb.from('patient_balances').select('patient_id, billed, paid, dues').lt('dues', 0).order('dues', { ascending: true }).order('patient_id').limit(501)), 500);
      return attachPatients(keepFlags(rows, rows.map((r) => ({ ...r, advance: -Number(r.dues) }))));
    },
    async visitsDaily({ from, to, branchId } = {}) {
      return fetchPaged(() => visitsQuery({ from, to, branchId }), 20000);
    },
    /**
     * Payment totals for a period, added up in the database (payments_summary). Returns
     * { totals, byDay, byMethod, source: 'server' | 'rows', truncated } — see summarizePayments() for the fields.
     * Before the migration it adds up the rows here (up to 20,000; truncated = true beyond that).
     */
    async paymentsSummary({ from, to, branchId, method } = {}) {
      const r = await rpc('payments_summary', { p_from: from || null, p_to: to || null, p_branch: branchId ? Number(branchId) : null, p_method: method || null });
      if (!r.missing) return { totals: r.data?.totals || summarizePayments([]).totals, byDay: r.data?.byDay || [], byMethod: r.data?.byMethod || [], source: 'server', truncated: false };
      const rows = await fetchPaged(() => paymentsQuery('id, amount, method, branch_id, received_at', { from, to, branchId, method }), 20000);
      return { ...summarizePayments(rows), source: 'rows', truncated: !!rows.truncated };
    },
    /** OPD totals for a period (opd_summary): { totals, byDay, waitByBranch, source, truncated } — see summarizeVisits(). */
    async opdSummary({ from, to, branchId } = {}) {
      const r = await rpc('opd_summary', { p_from: from || null, p_to: to || null, p_branch: branchId ? Number(branchId) : null });
      if (!r.missing) return { totals: r.data?.totals || summarizeVisits([]).totals, byDay: r.data?.byDay || [], waitByBranch: r.data?.waitByBranch || [], source: 'server', truncated: false };
      const rows = await fetchPaged(() => visitsQuery({ from, to, branchId }), 20000);
      return { ...summarizeVisits(rows), source: 'rows', truncated: !!rows.truncated };
    },
    async todaysPayments(branchId) {
      const d = todayISO();
      let q = sb.from('payments').select('*').gte('received_at', new Date(d + 'T00:00:00+05:00').toISOString()).order('received_at', { ascending: false });
      if (branchId) q = q.eq('branch_id', Number(branchId));
      return attachPatients(check(await q));
    },

    // ------------------------------------------------------------ doctor log
    async doctorLog({ clinicianId, from, to }) {
      // A doctor sees only their own log unless allowed to see everyone's (same rule as demo mode).
      const session = await this.getSession();
      const mayViewAll = session?.staff?.role === 'admin' || session?.perms?.has('doctor_log.view_all');
      if (!mayViewAll && clinicianId !== await this.myClinicianId()) throw new Error('You can only see your own daily log.');
      const rows = check(await sb.from('visit_staff').select('role, visit:visits!inner(' + VISIT_SELECT + ')')
        .eq('clinician_id', clinicianId).eq('visit.status', 'completed').gte('visit.visit_date', from).lte('visit.visit_date', to));
      const visits = await enrichVisits(rows.map((r) => r.visit));
      return visits.map((v, i) => ({ role: rows[i].role, ...v })).sort((a, b) => b.visit_date.localeCompare(a.visit_date));
    },
    async doctorSummary(clinicianId, from, to) { return check(await callRpc('doctor_summary', { p_clinician: clinicianId, p_from: from, p_to: to })); },
    async myClinicianId() {
      const uid = await userId();
      const row = check(await sb.from('clinicians').select('id').eq('staff_id', uid).maybeSingle());
      return row?.id || null;
    },

    // ------------------------------------------------------------ admin
    async permissionGrid() {
      const [perms, grid, overrides] = await Promise.all([
        sb.from('permissions').select('*').order('sort_order').then(check),
        sb.from('role_permissions').select('*').then(check),
        sb.from('staff_permission_overrides').select('*').then(check),
      ]);
      const roles = ['front_desk', 'assistant', 'doctor', 'coordinator', 'accountant', 'admin'];
      const g = Object.fromEntries(roles.map((r) => [r, {}]));
      for (const row of grid) g[row.role][row.permission_key] = row.allowed;
      for (const p of perms) g.admin[p.key] = true;
      const o = {};
      for (const row of overrides) (o[row.staff_id] ||= {})[row.permission_key] = row.allowed;
      return { permissions: perms, roles, grid: g, overrides: o };
    },
    async setRolePermission(role, key, allowed) {
      check(await sb.from('role_permissions').upsert({ role, permission_key: key, allowed }));
    },
    async setOverride(staffId, key, allowed) {
      if (allowed === null) check(await sb.from('staff_permission_overrides').delete().match({ staff_id: staffId, permission_key: key }));
      else check(await sb.from('staff_permission_overrides').upsert({ staff_id: staffId, permission_key: key, allowed }));
    },
    async staffList() { return check(await sb.from('staff').select('*').order('full_name')); },
    async createStaff(row) {
      // Creating a login needs the server key, so it goes through an Edge Function.
      const { data, error } = await sb.functions.invoke('admin-users', { body: { action: 'create_staff', ...row } });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      return data.staff;
    },
    async updateStaffLogin(id, { email, password }) {
      const { data, error } = await sb.functions.invoke('admin-users', { body: { action: 'update_login', user_id: id, email, password } });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
    },
    async deactivateStaff(id) {
      check(await sb.rpc('deactivate_staff', { p_staff: id }));
      await sb.functions.invoke('admin-users', { body: { action: 'ban_user', user_id: id } });
    },
    async reactivateStaff(id) {
      check(await sb.from('staff').update({ active: true, deactivated_at: null }).eq('id', id));
      await sb.functions.invoke('admin-users', { body: { action: 'unban_user', user_id: id } });
    },
    async setSetting(key, value) { check(await sb.from('app_settings').update({ value, updated_at: new Date().toISOString() }).eq('key', key)); },
    async discountCaps() {
      const rows = check(await sb.from('discount_caps').select('*'));
      return Object.fromEntries(rows.map((r) => [r.role, { maxPercent: r.max_percent === null ? null : Number(r.max_percent), maxAmount: r.max_amount === null ? null : Number(r.max_amount) }]));
    },
    async setDiscountCap(role, maxPercent, maxAmount) {
      check(await sb.from('discount_caps').upsert({ role, max_percent: maxPercent === '' ? null : maxPercent, max_amount: maxAmount === '' ? null : maxAmount }));
    },
    async saveScheduleRow(row) {
      if (row.id) check(await sb.from('dr_ali_schedule').update(row).eq('id', row.id));
      else check(await sb.from('dr_ali_schedule').insert(row));
      forget('schedule');
    },
    async deleteScheduleRow(id) { check(await sb.from('dr_ali_schedule').delete().eq('id', id)); forget('schedule'); },
    async staffLogins() { return check(await callRpc('staff_logins', { p_limit: 200 })); },
    async auditLog() {
      const [rows, names] = await Promise.all([sb.from('audit_log').select('*').order('at', { ascending: false }).limit(201).then(check), staffNames()]);
      const list = capped(rows, 200);
      return keepFlags(list, list.map((r) => ({ ...r, actor_name: names[r.actor] || null })));
    },
    async dashboard(date) {
      const day = date || todayISO();
      const [branches, visits, closings] = await Promise.all([
        this.branches(),
        sb.from('visits').select('branch_id,status,patient_id').eq('visit_date', day).then(check),
        sb.from('cash_closings').select('*').eq('closing_date', day).then(check),
      ]);
      let income = []; let complaints = []; let dues = {};
      try { income = check(await sb.from('branch_daily_income').select('*').eq('day', day)); } catch { income = []; }
      try { complaints = check(await sb.from('complaints').select('branch_id').eq('status', 'new')); } catch { complaints = []; }
      try { dues = await duesFor([...new Set(visits.map((v) => v.patient_id))]); } catch { dues = {}; }
      return branches.map((b) => {
        const vs = visits.filter((v) => v.branch_id === b.id);
        const withDues = [...new Set(vs.map((v) => v.patient_id))].filter((pid) => (dues[pid] || 0) > 0);
        return { branch: b, patients: vs.length, completed: vs.filter((v) => v.status === 'completed').length,
          waiting: vs.filter((v) => v.status === 'waiting').length,
          received: Number(income.find((i) => i.branch_id === b.id)?.net || 0),
          dues_patients: withDues.length, dues: withDues.reduce((s, pid) => s + dues[pid], 0),
          new_complaints: complaints.filter((c) => c.branch_id === b.id).length,
          closing: closings.find((c) => c.branch_id === b.id) || null };
      });
    },
    /** All pending dues: summed in the database (total_dues); before the migration, every balance row is paged and added here. */
    async totalDues() {
      const r = await rpc('total_dues', {});
      if (!r.missing) return Number(r.data) || 0;
      const rows = await fetchPaged(() => sb.from('patient_balances').select('patient_id, dues').gt('dues', 0).order('patient_id'), 500000);
      return rows.reduce((t, x) => t + Number(x.dues), 0);
    },
    async commissionRules() { return check(await sb.from('doctor_commission_rules').select('*').eq('active', true)); },
    async report(kind, from, to) { return check(await callRpc('clinic_report', { p_kind: kind, p_from: from, p_to: to })) || []; },

    // ------------------------------------------------------------ clinic setup (admin)
    async setupLists() {
      const [branches, cities, clinicians, groups, treatments, categories, staff, rules] = await Promise.all([
        sb.from('branches').select('*').order('sort_order').order('id').then(check),
        this.cities(),
        sb.from('clinicians').select('*').order('is_doctor', { ascending: false }).order('display_name').then(check),
        sb.from('doctor_groups').select('*').order('id').then(check),
        sb.from('treatments').select('*').order('sort_order').order('name').then(check),
        sb.from('expense_categories').select('*').order('sort_order').order('name').then(check),
        sb.from('staff').select('id,full_name,role,active').order('full_name').then(check),
        sb.from('doctor_commission_rules').select('*').order('percent', { ascending: false }).then(check).catch(() => []),
      ]);
      return { branches, cities, clinicians, groups, treatments, categories, staff: staff.filter((s) => s.active), commission_rules: rules };
    },
    async saveSetupRow(table, row) {
      const tables = ['branches', 'clinicians', 'doctor_groups', 'treatments', 'expense_categories', 'doctor_commission_rules'];
      if (!tables.includes(table)) throw new Error('Unknown list ' + table);
      const { id, ...data } = row;
      if (table === 'doctor_groups' && !(await sb.from('doctor_groups').select('id').eq('id', id).then(check)).length) check(await sb.from(table).insert({ id, ...data }));
      else if (id !== undefined && id !== null && id !== '') check(await sb.from(table).update(data).eq('id', id));
      else check(await sb.from(table).insert(data));
    },

    // ------------------------------------------------------------ duplicates (admin)
    async patientDuplicates() { return check(await callRpc('patient_duplicates')) || []; },
    async mergePatients(keepId, removeId) { return check(await sb.rpc('merge_patients', { p_keep: keepId, p_remove: removeId })); },

    // ------------------------------------------------------------ import from Healthwire (admin)
    async importHealthwire(kind, rows) { return check(await sb.rpc('import_healthwire', { p_kind: kind, p_rows: rows })); },
    async importAajSheet(rows, createPatients = false) { return check(await sb.rpc('import_aaj_sheet', { p_rows: rows, p_create_patients: !!createPatients })); },
    async patientsByMr(mrs) {
      const out = [];
      for (let i = 0; i < mrs.length; i += 200) out.push(...check(await sb.from('patients').select('mr_number').in('mr_number', mrs.slice(i, i + 200))));
      return out;
    },

    // ------------------------------------------------------------ export
    // Ordered by primary key, so pages neither repeat nor skip rows while the clinic keeps working.
    async exportTable(name) {
      const allowed = ['patients', 'visits', 'invoices', 'payments', 'expenses', 'cash_closings'];
      if (!allowed.includes(name)) return [];
      const out = [];
      for (let from = 0; ; from += PAGE) {
        const rows = check(await sb.from(name).select('*').order('id', { ascending: true }).range(from, from + PAGE - 1));
        out.push(...rows);
        if (rows.length < PAGE) break;
      }
      return out;
    },

    // ------------------------------------------------------------ patient portal
    async rateVisit(visitId, stars, comment) {
      const s = await this.getSession();
      check(await sb.from('visit_ratings').insert({ visit_id: visitId, patient_id: s.patient.id, stars: Number(stars), comment: comment || null }));
    },
    async myRatings() { return check(await sb.from('visit_ratings').select('*')); },
  };
}
