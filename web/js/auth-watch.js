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
//   - the data layer naming a different person than this tab shows (someone else signed in from another tab).
// An error, or "nobody" on any other event, changes nothing on screen: the next event looks again.

const personOf = (s) => s?.staff?.id || s?.patient?.id || null;

/**
 * Returns the function to hand to data.onAuthChange(fn). The data layer must call it as fn(eventName).
 * @param {object} deps
 * @param {{ getSession: () => Promise<object | null> }} deps.data
 * @param {() => object | null} deps.current  the login this tab shows (state.session)
 * @param {() => boolean} deps.busy           true while this tab is logging out by itself (its own events are not news)
 * @param {(session: object) => void} deps.accept  a (re)confirmed login: keep it
 * @param {() => void} deps.ended             the login is gone: leave the screen the way a logout does
 */
export function authChangeHandler({ data, current, busy, accept, ended }) {
  let signedOuts = 0;
  return async function onAuthChange(event) {
    if (event === 'SIGNED_OUT') {
      signedOuts += 1; // an answer still on its way, from before this (also before this tab's own logout), must not put the login back
      if (!busy() && current()) ended();
      return;
    }
    if (busy()) return;
    const before = signedOuts;
    let session;
    try { session = await data.getSession(); } catch (e) { console.error(e); return; } // a hiccup (offline?) is not a logout
    if (busy() || signedOuts !== before) return;
    if (!session) return; // not proof (see above): keep what is on screen
    const was = current();
    if (was && personOf(session) !== personOf(was)) { ended(); return; }
    accept(session);
  };
}
