// The set-password page for invitation and reset links (web/js/reset-password.js), driven with a stand-in page and a stand-in for supabase-js.
// Its client keeps the login in the same storage as the clinic app, so a person who is logged in on the computer has a stored login there.
// What it pins down: that stored login never gets to set a password on this page (no link, no current password: it would make "Change
// password" in the account menu, which asks for the current password, pointless); only the login that THIS link brought does, also
// when the address is made up to look like a link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setImmediate as tick } from 'node:timers/promises';

registerHooks({
  resolve(spec, ctx, nextResolve) {
    if (spec.startsWith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@')) {
      return { url: 'data:text/javascript,export const createClient = (...a) => globalThis.__fakeCreateClient(...a);', shortCircuit: true };
    }
    return nextResolve(spec, ctx);
  },
});

const EXPIRED = /expired or was already used/;
const OPEN_FROM_LINK = /Open this page from the link in your email/;
let loads = 0;

/**
 * Opens the page the way a browser would: `hash` is the address after "#". The computer has Ali's ordinary login stored. Like the
 * library, the client replaces it with the login of a link in the address when that link's token is good, and keeps the stored login
 * when the address holds anything else (made up, expired).
 */
async function openPage(hash: string, goodTokens: string[] = []) {
  const els: Record<string, any> = {};
  const el = (id: string) => (els[id] ||= { id, hidden: id === 'form', value: '', textContent: '', listeners: {} as Record<string, Function>, addEventListener(type: string, fn: Function) { this.listeners[type] = fn; } });
  (globalThis as any).document = { getElementById: el };
  (globalThis as any).location = { href: 'https://dralirashid.com/reset-password.html', hash, search: '' };
  const seen = { clients: [] as any[], updates: [] as string[][] };
  (globalThis as any).__fakeCreateClient = (_url: string, _key: string, options: any) => {
    seen.clients.push(options);
    let stored: any = { access_token: 'AT-ali', user: { id: 'ali' } };
    const token = new URLSearchParams(hash.replace(/^#/, '')).get('access_token');
    if (options?.auth?.detectSessionInUrl && token && goodTokens.includes(token)) stored = { access_token: token, user: { id: 'sara' } };
    return {
      auth: {
        async getSession() { return { data: { session: stored }, error: null }; },
        async updateUser(attrs: object) { seen.updates.push(Object.keys(attrs)); return { data: { user: stored.user }, error: null }; },
      },
      from() { const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: { id: stored.user.id } }) }; return b; },
    };
  };
  await import(`../web/js/reset-password.js?load=${++loads}`);
  for (let i = 0; i < 20; i++) await tick();
  const submit = async (p1: string, p2: string) => {
    el('p1').value = p1; el('p2').value = p2;
    await els.form.listeners.submit?.({ preventDefault() {} });
    for (let i = 0; i < 20; i++) await tick();
  };
  return { els, seen, submit, formShown: () => els.form.hidden === false, message: () => els.msg.textContent as string, where: () => (globalThis as any).location.href as string };
}

test('opened by hand while somebody is logged in (no link): no form, and the stored login is never even looked at', async () => {
  const page = await openPage('');
  assert.equal(page.formShown(), false);
  assert.match(page.message(), OPEN_FROM_LINK);
  assert.match(page.message(), /Change password/);
  assert.equal(page.seen.clients.length, 0, 'no client, so no stored login to pick up');
  assert.equal(page.els.form.listeners.submit, undefined, 'nothing to submit');
  await page.submit('Attacker-Chosen-1', 'Attacker-Chosen-1');
  assert.deepEqual(page.seen.updates, []);
});

test('an address made up to look like a link (a token the login server does not know): the stored login still does not count', async () => {
  const page = await openPage('#access_token=made-up&refresh_token=x&expires_in=3600&token_type=bearer&type=recovery');
  assert.equal(page.formShown(), false);
  assert.match(page.message(), EXPIRED);
  assert.equal(page.els.form.listeners.submit, undefined);
  await page.submit('Attacker-Chosen-1', 'Attacker-Chosen-1');
  assert.deepEqual(page.seen.updates, [], 'the stored login\'s password was not set');
});

test('a link the login server answers for: the form is shown, and sets the password of the login the link brought', async () => {
  const page = await openPage('#access_token=AT-link&refresh_token=r&expires_in=3600&token_type=bearer&type=recovery', ['AT-link']);
  assert.equal(page.formShown(), true);
  assert.deepEqual(page.seen.clients.map((o) => o.auth), [{ detectSessionInUrl: true }]);
  await page.submit('One-Password-1', 'Other-Password-2');
  assert.match(page.message(), /different/);
  assert.deepEqual(page.seen.updates, [], 'two different passwords are not sent');
  await page.submit('One-Password-1', 'One-Password-1');
  assert.deepEqual(page.seen.updates, [['password']]);
  assert.equal(page.where(), '/#/staff/today');
});

test('a link that has expired or was already used (the address says so): expired wording, no client', async () => {
  const page = await openPage('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  assert.equal(page.formShown(), false);
  assert.match(page.message(), EXPIRED);
  assert.equal(page.seen.clients.length, 0);
});
