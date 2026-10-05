// Router: #/ (home), #/visitor, #/login/staff, #/login/patient, #/patient
// (portal), #/staff/<page>. Hash routing keeps the site a set of static files.
import { h, mount, toast, friendlyError, empty } from './ui/dom.js';
import { state, init } from './state.js';
import { renderHome, renderVisitor } from './views/public.js';
import { renderLogin } from './views/login.js';
import { renderPortal } from './views/portal.js';
import { renderStaff } from './views/staff/shell.js';

const root = document.getElementById('app');
let idleTimer;

async function signOut() {
  await state.data.signOut();
  state.session = null;
  location.hash = '#/';
}

// Staff are logged out after a period of no activity (shared clinic computers).
function armIdleLogout() {
  clearTimeout(idleTimer);
  if (state.session?.kind !== 'staff' || state.data.mode === 'demo') return;
  const minutes = Number(state.ref.settings?.session_timeout_minutes) || 30;
  idleTimer = setTimeout(async () => { await signOut(); toast('Logged out after a period of no activity.'); }, minutes * 60 * 1000);
}
['click', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, armIdleLogout, { passive: true }));

async function route() {
  const hash = location.hash.replace(/^#\/?/, '') || '';
  const [pathPart, query = ''] = hash.split('?');
  const params = new URLSearchParams(query);
  const parts = pathPart.split('/').filter(Boolean);
  const s = state.session;
  window.scrollTo(0, 0);

  try {
    if (parts[0] === 'visitor') return await renderVisitor(root);
    if (parts[0] === 'login') {
      const who = parts[1] === 'patient' ? 'patient' : 'staff';
      if (s?.kind === 'staff' && who === 'staff') { location.hash = '#/staff/today'; return; }
      if (s?.kind === 'patient' && who === 'patient') { location.hash = '#/patient'; return; }
      return await renderLogin(root, who, () => { location.hash = state.session.kind === 'staff' ? '#/staff/today' : '#/patient'; armIdleLogout(); });
    }
    if (parts[0] === 'patient') {
      if (s?.kind !== 'patient') { location.hash = '#/login/patient'; return; }
      return await renderPortal(root, signOut);
    }
    if (parts[0] === 'staff') {
      if (s?.kind !== 'staff') { location.hash = '#/login/staff'; return; }
      return await renderStaff(root, parts.slice(1).join('/') || 'today', params, signOut);
    }
    return await renderHome(root);
  } catch (e) {
    console.error(e);
    mount(root, h('div', { class: 'public-main' }, empty(friendlyError(e), h('a', { class: 'btn', href: '#/' }, 'Go to the homepage'))));
  }
}

(async () => {
  try {
    await init();
  } catch (e) {
    mount(root, h('div', { class: 'public-main' }, empty('The clinic system could not start: ' + friendlyError(e))));
    return;
  }
  state.data.onAuthChange?.(async () => { state.session = await state.data.getSession().catch(() => null); });
  window.addEventListener('hashchange', route);
  armIdleLogout();
  route();
})();
