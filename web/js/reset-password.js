// Set-password page for invitation and password-reset links.
import { CONFIG, DEMO_MODE } from './config.js';
const msg = document.getElementById('msg');
const form = document.getElementById('form');
if (DEMO_MODE) {
  msg.textContent = 'The live database is not connected yet, so there is no password to set.';
} else {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, { auth: { detectSessionInUrl: true } });
  const { data } = await sb.auth.getSession();
  if (!data.session) {
    msg.textContent = 'This link has expired or was already used. Ask the clinic for a new one, or use "Forgot password" on the login page.';
  } else {
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
}
