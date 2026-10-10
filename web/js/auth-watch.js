// What a change of the login means for the screen that is open (used by main.js; a separate file so a test can
// drive it without a browser).
//
// The data layer calls the function below with the name of every login event supabase-js reports: SIGNED_IN
// (also each time the tab is focused again), TOKEN_REFRESHED, USER_UPDATED, SIGNED_OUT ... and then asks who is
// logged in. That answer "nobody" is NOT proof the login ended: a network blip, a token refresh still in flight
// or the library's own lock make it say "nobody" too, while the stored login is perfectly valid. Logging out
// on that guess threw away open dialogs and unsaved forms of a person whose login was fine.
//
// So the login counts as ended only on a definitive signal:
//   - the SIGNED_OUT event: this browser's login was removed (logged out in another tab, or the server refused
//     to refresh it and the library cleared it), or
//   - the data layer naming a different person than this tab shows (someone else signed in from another tab), or
//   - the data layer saying the account itself is gone: switched off by Dr. Ali, deleted, or no longer linked to
//     a staff or patient record (getSession() fails with ACCOUNT_OFF / ACCOUNT_GONE; it has ended the login by then).
// Any other error, or "nobody" on any other event, changes nothing on screen: the next event looks again.
// USER_UPDATED is one of those other events. It comes when the logged-in person changes their own password (data.changeOwnPassword)
// or details, in this tab and in the other tabs of the browser: the same person, so it is looked up like TOKEN_REFRESHED, ends
// nothing, and the open dialogs, forms and queued Aaj ki List edits stay as they are.
//
// An answer that comes back after the screen has changed (another logout or login happened while it was being
// fetched) is dropped: it describes a login that is no longer the one on screen and must not put anyone back. An answer that a
// newer lookup has overtaken is not allowed to put anybody on screen either (only the newest lookup counts for that), but it may
// still end the screen: "somebody else is logged in now" stays true even if the newer lookup then failed (a network blip), and
// would otherwise leave the previous person's name, permissions and queued saves on screen over another person's login.
//
// Events only come when the login or the tab changes. startRecheck() below asks again every 4 minutes while the tab is
// visible, so a switched-off, banned or deleted account ends within minutes even in a tab that nobody refocuses.

const personOf = (s) => s?.staff?.id || s?.patient?.id || null;

// The error codes of a getSession() that ended the login because of the account, and the reason each one gives main.js.
const ACCOUNT_ENDINGS = { ACCOUNT_OFF: 'switched_off', ACCOUNT_GONE: 'account_gone' };

/** The reason ('switched_off' / 'account_gone') that an ACCOUNT_OFF / ACCOUNT_GONE error stands for, or null for any other error. */
export const accountEnding = (e) => ACCOUNT_ENDINGS[e?.code] || null;

// A lookup that failed with one of these found no proof either way (the login changed under it, or could not be confirmed just
// now): not news, and not worth an error in the console.
const NOT_NEWS = new Set(['LOGIN_CHANGED', 'LOGIN_UNCONFIRMED']);

/** The event name the periodic re-check hands to the handler (none of the data layer's own events). */
export const RECHECK_EVENT = 'RECHECK';
export const RECHECK_EVERY_MS = 4 * 60 * 1000;
const RECHECK_LIMIT_MS = 2 * 60 * 1000; // a look that has not answered by then no longer holds back the next one

/**
 * What the person is told after a logout they did not ask for. reason is the one SIGNED_OUT came with: 'switched_off' (Dr. Ali switched
 * the account off), 'account_gone' (deleted, or no longer linked to a record), 'idle' (the inactivity logout of another tab);
 * without one, the login ended in another tab or on the server, or it expired.
 * @param {string | null} reason
 * @param {{ patient?: boolean, idleMinutes?: number }} [who]  patient: a patient is told to call the clinic, not Dr. Ali
 */
export function endedNotice(reason, { patient = false, idleMinutes = 30 } = {}) {
  const contact = patient ? 'Please contact the clinic.' : 'Contact Dr. Ali.';
  if (reason === 'switched_off') return `You were logged out because this account was switched off. ${contact}`;
  if (reason === 'account_gone') return `You were logged out because this account no longer exists. ${contact}`;
  if (reason === 'idle') return `You were logged out because there was no activity for ${idleMinutes} minute${idleMinutes === 1 ? '' : 's'}.`;
  return 'You were logged out. Your login ended in another tab or window, or it expired. Please log in again.';
}

/**
 * Returns the function to hand to data.onAuthChange(fn). The data layer must call it as fn(eventName, reason): the reason
 * only comes with SIGNED_OUT ('switched_off', 'account_gone', 'idle', or nothing when it is not known).
 * @param {object} deps
 * @param {{ getSession: (options?: { strict?: boolean, fresh?: boolean }) => Promise<object | null> }} deps.data
 * @param {() => object | null} deps.current  the login this tab shows (state.session)
 * @param {() => boolean} deps.busy           true while this tab is logging out by itself (its own events are not news)
 * @param {(session: object) => void} deps.accept  a (re)confirmed login: keep it
 * @param {(reason: string | null) => void} deps.ended  the login is gone: leave the screen the way a logout does, saying why
 */
export function authChangeHandler({ data, current, busy, accept, ended }) {
  let epoch = 0; // counts every way the login on screen has ended; an answer asked for before that is stale
  let latest = 0; // numbers the lookups; an answer that a newer lookup has overtaken may not put anybody on screen (it may still end it)
  const end = (reason) => { epoch += 1; ended(reason || null); };
  return async function onAuthChange(event, reason = null) {
    if (event === 'SIGNED_OUT') {
      epoch += 1; // an answer still on its way, from before this (also before this tab's own logout), must not put the login back
      if (!busy() && current()) ended(reason || null);
      return;
    }
    if (busy()) return;
    const asked = epoch;
    const mine = (latest += 1);
    const shown = personOf(current());
    const stale = () => busy() || epoch !== asked || personOf(current()) !== shown; // the screen or the login moved on since this lookup began
    // The periodic re-check also reads the account's record again (an event does not: the data layer remembers it until the next one).
    const options = event === RECHECK_EVENT ? { strict: true, fresh: true } : { strict: true };
    let session;
    try {
      session = await data.getSession(options);
    } catch (e) {
      const why = accountEnding(e);
      if (!why) { if (!NOT_NEWS.has(e?.code)) console.error(e); return; } // a hiccup (offline?) is not a logout; a changed login is not news
      // The data layer has already ended the login, which sends SIGNED_OUT (handled above, and then this tab is busy). Only when
      // that event never came (the server's logout hung) is it up to this answer to end the screen.
      if (!stale() && current()) end(why);
      return;
    }
    if (stale()) return;
    if (!session) return; // not proof (see above): keep what is on screen
    const was = current();
    if (was && personOf(session) !== personOf(was)) { end(null); return; }
    if (mine !== latest) return; // a newer lookup is on its way (or has failed): it decides who may be put on screen
    accept(session);
  };
}

/**
 * Asks about the login again from time to time, so that an account switched off, banned or deleted is ended within minutes even
 * in a tab that nobody refocuses and that saves nothing. It looks `every` ms after the last look, only while the tab is visible and
 * somebody is signed in; when the tab is hidden or the person has gone, nothing is scheduled at all. The look is the handler's
 * own (same strict, transient-safe rules: a failed or slow answer never logs anyone out). It also looks at once when the
 * connection comes back ('online'), because a check that failed offline said nothing.
 * @param {object} deps
 * @param {() => Promise<void> | void} deps.fire  runs one look (main.js: the handler called with RECHECK_EVENT)
 * @param {() => boolean} deps.active  true while somebody is signed in and this tab is not logging out
 * @param {number} [deps.every]
 * @param {{ visibilityState?: string, addEventListener?: Function, removeEventListener?: Function }} [deps.doc]
 * @param {{ addEventListener?: Function, removeEventListener?: Function }} [deps.win]
 * @returns {{ poke: () => void, stop: () => void }}  poke(): the signed-in state changed, start or stop looking accordingly
 */
export function startRecheck({ fire, active, every = RECHECK_EVERY_MS, doc = globalThis.document, win = globalThis.window }) {
  let timer = null;
  let looking = false;
  const wanted = () => doc?.visibilityState === 'visible' && !!active();
  const clear = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  const sync = () => {
    if (!wanted()) clear();
    else if (timer === null && !looking) timer = setTimeout(look, every);
  };
  async function look() {
    timer = null;
    if (looking || !wanted()) { sync(); return; }
    looking = true;
    let cap;
    const limit = new Promise((resolve) => { cap = setTimeout(resolve, RECHECK_LIMIT_MS); });
    try { await Promise.race([fire(), limit]); } catch (e) { console.error(e); } finally { clearTimeout(cap); looking = false; }
    sync();
  }
  const onOnline = () => { if (wanted() && !looking) { clear(); look(); } };
  doc?.addEventListener?.('visibilitychange', sync);
  win?.addEventListener?.('online', onOnline);
  return {
    poke: sync,
    stop() {
      clear();
      doc?.removeEventListener?.('visibilitychange', sync);
      win?.removeEventListener?.('online', onOnline);
    },
  };
}
