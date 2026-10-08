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
//
// An answer that comes back after the screen has changed (another logout or login happened while it was being
// fetched) is dropped: it describes a login that is no longer the one on screen and must not put anyone back.

const personOf = (s) => s?.staff?.id || s?.patient?.id || null;

// The error codes of a getSession() that ended the login because of the account, and the reason each one gives main.js.
const ACCOUNT_ENDINGS = { ACCOUNT_OFF: 'switched_off', ACCOUNT_GONE: 'account_gone' };

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
 * @param {{ getSession: (options?: { strict?: boolean }) => Promise<object | null> }} deps.data
 * @param {() => object | null} deps.current  the login this tab shows (state.session)
 * @param {() => boolean} deps.busy           true while this tab is logging out by itself (its own events are not news)
 * @param {(session: object) => void} deps.accept  a (re)confirmed login: keep it
 * @param {(reason: string | null) => void} deps.ended  the login is gone: leave the screen the way a logout does, saying why
 */
export function authChangeHandler({ data, current, busy, accept, ended }) {
  let epoch = 0; // counts every way the login on screen has ended; an answer asked for before that is stale
  const end = (reason) => { epoch += 1; ended(reason || null); };
  return async function onAuthChange(event, reason = null) {
    if (event === 'SIGNED_OUT') {
      epoch += 1; // an answer still on its way, from before this (also before this tab's own logout), must not put the login back
      if (!busy() && current()) ended(reason || null);
      return;
    }
    if (busy()) return;
    const asked = epoch;
    const shown = personOf(current());
    const stale = () => busy() || epoch !== asked || personOf(current()) !== shown;
    let session;
    try {
      session = await data.getSession({ strict: true });
    } catch (e) {
      const why = ACCOUNT_ENDINGS[e?.code];
      if (!why) { console.error(e); return; } // a hiccup (offline?) is not a logout
      // The data layer has already ended the login, which sends SIGNED_OUT (handled above, and then this tab is busy). Only when
      // that event never came (the server's logout hung) is it up to this answer to end the screen.
      if (!stale() && current()) end(why);
      return;
    }
    if (stale()) return;
    if (!session) return; // not proof (see above): keep what is on screen
    const was = current();
    if (was && personOf(session) !== personOf(was)) { end(null); return; }
    accept(session);
  };
}
