// Set-password page for invitation and password-reset links.
import { CONFIG, DEMO_MODE } from './config.js';
const msg = document.getElementById('msg');
const form = document.getElementById('form');
// The same exact release as js/data/supabase.js (SDK_VERSION there): change both together, after testing.
const SDK_VERSION = '2.117.2';

// The page's client uses the same storage as the clinic app, so getSession() would also return the login of whoever is using this
// computer. That login must never be allowed to set a password here without the current one (it would make "Change password" in the
// account menu, which asks for the current password, pointless): only the session that THIS link brought counts. The link's access
// token is read from the address before the library clears it, and the session found later must be that very token. (Junk in the
// address does not help either: the library refuses it, keeps the stored login, and that login's token is not the one in the address.)
// This site uses the library's default flow, which puts the token in the address after "#".
const fromAddress = new URLSearchParams(location.hash.replace(/^#/, ''));
const linkToken = fromAddress.get('access_token');
const EXPIRED = 'This link has expired or was already used. Ask the clinic for a new one, or use "Forgot password" on the login page.';

async function start() {
  if (DEMO_MODE) {
    msg.textContent = 'The live database is not connected yet, so there is no password to set.';
    return;
  }
  if (!linkToken) {
    // An address that carries an error is a link that did not work (GoTrue sends "#error=access_denied&error_code=otp_expired ...").
    msg.textContent = fromAddress.has('error')
      ? EXPIRED
      : 'Open this page from the link in your email. To change the password you use now, log in and choose "Change password" from the menu.';
    return;
  }
  let sb;
  try {
    const { createClient } = await import(`https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${SDK_VERSION}/+esm`);
    sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, { auth: { detectSessionInUrl: true } });
  } catch (e) {
    console.error(e);
    msg.textContent = 'This page could not load. Check the internet connection, then open the link again.';
    return;
  }
  const { data } = await sb.auth.getSession();
  if (!data.session || data.session.access_token !== linkToken) {
    msg.textContent = EXPIRED;
    return;
  }
  form.hidden = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const p1 = document.getElementById('p1').value, p2 = document.getElementById('p2').value;
    if (p1 !== p2) { msg.textContent = 'The two passwords are different. Type them again.'; return; }
    const { error } = await sb.auth.updateUser({ password: p1 });
    if (error) { msg.textContent = error.message; return; }
    const { data: staff } = await sb.from('staff').select('id').eq('id', data.session.user.id).maybeSingle();
    location.href = staff ? '/#/staff/today' : '/#/patient';
  });
}
start();
