// Set-password page for invitation and password-reset links.
import { CONFIG, DEMO_MODE } from './config.js';
const msg = document.getElementById('msg');
const form = document.getElementById('form');
// The same exact release as js/data/supabase.js (SDK_VERSION there): change both together, after testing.
const SDK_VERSION = '2.117.2';

async function start() {
  if (DEMO_MODE) {
    msg.textContent = 'The live database is not connected yet, so there is no password to set.';
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
  if (!data.session) {
    msg.textContent = 'This link has expired or was already used. Ask the clinic for a new one, or use "Forgot password" on the login page.';
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
