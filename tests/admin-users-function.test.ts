// The admin-users Edge Function itself (supabase/functions/admin-users/index.ts), run in Node with a stand-in for Deno and for
// supabase-js, through its real request handler. What this pins down:
//   - create_staff by invitation refuses an address that already has a login (inviting an unconfirmed login hands back THAT login, so
//     a staff row would be attached to an account somebody else made, for example by a patient invitation), and a fresh address
//     still gets its invitation and its staff row;
//   - create_staff with a password, and the staff address guards, behave as before;
//   - invite_patient refuses a patient email at the clinic domain (the step that would plant such a login);
//   - the patient login actions are reached through the handler and make clinic logins with app_metadata;
//   - delete_staff and restore_staff are reached through the handler, the email of a deleted account is named when create_staff
//     or update_login is given it, and Switch on (unban_user) refuses a deleted account.
// (The actions themselves are tested in patient-login-actions.test.ts and staff-delete-actions.test.ts.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

type Row = Record<string, any>;

// ---- the world the function runs in: tables and logins in memory, the calls it made, the caller and what they may do
const world: {
  tables: Record<string, Row[]>;
  users: Map<string, Row>;
  calls: Array<[string, any]>;
  perms: Set<string>;
  nextId: number;
  records: Record<string, Row>; // what staff_records() answers, per staff id
} = { tables: {}, users: new Map(), calls: [], perms: new Set(), nextId: 1, records: {} };

function reset(seed: { patients?: Row[]; staff?: Row[]; users?: Row[]; perms?: string[]; records?: Record<string, Row> } = {}) {
  world.tables = { patients: seed.patients ?? [], staff: seed.staff ?? [], clinicians: [], audit_log: [] };
  world.users = new Map((seed.users ?? []).map((u) => [u.id, u]));
  world.calls = [];
  world.perms = new Set(seed.perms ?? []);
  world.nextId = 1;
  world.records = seed.records ?? {};
}

/** The service-role client: just the calls the function makes. A GoTrue-like login store, including its habit of handing back an unconfirmed login on a repeated invitation. */
function adminClient() {
  const from = (table: string) => {
    const rows = world.tables[table] as Row[];
    const filters: Array<[string, unknown]> = [];
    let patch: Row | null = null;
    let inserted: Row | null = null;
    const match = () => rows.filter((r) => filters.every(([c, v]) => (v === null ? r[c] == null : r[c] === v)));
    const b: any = {
      select() { return b; },
      eq(col: string, value: unknown) { filters.push([col, value]); return b; },
      neq() { return b; },
      is(col: string, value: null) { filters.push([col, value]); return b; },
      update(p: Row) { patch = p; return b; },
      insert(row: Row) { world.calls.push([`insert ${table}`, row]); rows.push(row); inserted = row; return b; },
      async maybeSingle() {
        if (inserted) return { data: inserted, error: null };
        const hit = match();
        if (patch) { world.calls.push([`update ${table}`, patch]); for (const r of hit) Object.assign(r, patch); return { data: hit[0] ? { id: hit[0].id } : null, error: null }; }
        return { data: hit[0] ? { ...hit[0] } : null, error: null };
      },
      async single() { const r = await b.maybeSingle(); return r.data ? r : { data: null, error: { message: 'no rows' } }; },
      then(resolve: any, reject: any) { return b.maybeSingle().then(resolve, reject); },
    };
    return b;
  };
  const admin = {
    from,
    auth: {
      admin: {
        async createUser(attrs: Row) {
          world.calls.push(['createUser', attrs]);
          if ([...world.users.values()].some((u) => u.email === attrs.email)) return { data: { user: null }, error: { message: 'A user with this email address has already been registered' } };
          const user = { id: `user-${world.nextId++}`, email: attrs.email, confirmed: !!attrs.email_confirm, user_metadata: attrs.user_metadata, app_metadata: attrs.app_metadata, created_at: new Date().toISOString() };
          world.users.set(user.id, user);
          return { data: { user }, error: null };
        },
        async inviteUserByEmail(email: string, opts: Row) {
          world.calls.push(['inviteUserByEmail', { email, ...opts }]);
          const existing = [...world.users.values()].find((u) => u.email === email);
          if (existing?.confirmed) return { data: { user: null }, error: { message: 'A user with this email address has already been registered' } };
          if (existing) return { data: { user: existing }, error: null }; // an unconfirmed login: GoTrue invites it again and returns the same one
          const user = { id: `user-${world.nextId++}`, email, confirmed: false, user_metadata: opts?.data, created_at: new Date().toISOString() };
          world.users.set(user.id, user);
          return { data: { user }, error: null };
        },
        async listUsers({ page, perPage }: { page: number; perPage: number }) {
          return { data: { users: [...world.users.values()].slice((page - 1) * perPage, page * perPage) }, error: null };
        },
        async getUserById(id: string) { const user = world.users.get(id); return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'not found' } }; },
        async updateUserById(id: string, attrs: Row) { world.calls.push(['updateUserById', { id, ...attrs }]); return { data: {}, error: null }; },
        async deleteUser(id: string) { world.calls.push(['deleteUser', id]); world.users.delete(id); return { data: null, error: null }; },
        async signOut() { return { data: null, error: null }; },
      },
    },
  };
  return admin;
}

/** The client that acts as the caller: who they are, and the database's has_perm() / is_admin(). */
function callerClient() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'caller-1' } } }) },
    rpc: async (name: string, args: Row) => {
      if (name === 'has_perm') return { data: world.perms.has(args.p_key), error: null };
      if (name === 'staff_records') { world.calls.push(['rpc staff_records', args]); return { data: world.records[args.p_staff] ?? { total: 0, parts: [] }, error: null }; }
      return { data: false, error: null };
    },
  };
}

// ---- Deno and supabase-js stand-ins, then the real function
const env: Record<string, string> = { SUPABASE_URL: 'http://localhost', SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'service-key', STAFF_EMAIL_DOMAIN: 'dralirashid.com', SITE_URL: 'https://www.dralirashid.com' };
let handler: (req: Request) => Promise<Response>;
(globalThis as any).Deno = { env: { get: (k: string) => env[k] }, serve: (h: typeof handler) => { handler = h; } };
(globalThis as any).__fakeCreateClient = (_url: string, key: string) => (key === 'service-key' ? adminClient() : callerClient());
registerHooks({
  resolve(spec, ctx, nextResolve) {
    if (spec.startsWith('npm:@supabase/supabase-js@2')) return { url: 'data:text/javascript,export const createClient = (...a) => globalThis.__fakeCreateClient(...a);', shortCircuit: true };
    return nextResolve(spec, ctx);
  },
});
await import('../supabase/functions/admin-users/index.ts');

async function call(body: Row) {
  const res = await handler(new Request('http://localhost/functions/v1/admin-users', {
    method: 'POST', headers: { Authorization: 'Bearer caller-token', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() as Row };
}
const names = () => world.calls.map(([k]) => k);
const newDoc = { action: 'create_staff', full_name: 'New Doc', email: 'newdoc@dralirashid.com', role: 'doctor', branch_ids: [1] };

// ---------------------------------------------------------------- create_staff
test('create_staff by invitation: an address that already has an unconfirmed login (planted by a patient invitation) is refused, and no staff row is attached to it', async () => {
  reset({ perms: ['users.manage'], users: [{ id: 'planted', email: 'newdoc@dralirashid.com', confirmed: false, user_metadata: { kind: 'patient' } }] });
  const res = await call(newDoc);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { error: 'That login email is already used. Pick another.' });
  assert.ok(!names().includes('inviteUserByEmail'), 'no invitation was sent to the existing login');
  assert.equal(world.tables.staff.length, 0, 'no staff row was attached to the login somebody else made');
  assert.equal(world.users.get('planted')?.user_metadata.kind, 'patient');
});

test('create_staff by invitation: a fresh address is invited and gets its staff row, as before', async () => {
  reset({ perms: ['users.manage'], users: [{ id: 'other', email: 'someone@elsewhere.com', confirmed: true }] });
  const res = await call(newDoc);
  assert.equal(res.status, 200);
  assert.equal(res.body.staff.id, 'user-1');
  assert.deepEqual(world.tables.staff.map((s) => [s.id, s.email, s.role]), [['user-1', 'newdoc@dralirashid.com', 'doctor']]);
  const invite = world.calls.find(([k]) => k === 'inviteUserByEmail')![1];
  assert.equal(invite.email, 'newdoc@dralirashid.com');
  assert.equal(invite.redirectTo, 'https://www.dralirashid.com/reset-password.html');
  assert.deepEqual(world.tables.audit_log.map((a) => a.action), ['CREATE_LOGIN']);
});

test('create_staff with a password: a fresh address works at once and sends no invitation; an address that already has a login is still refused', async () => {
  reset({ perms: ['users.manage'] });
  const made = await call({ ...newDoc, password: 'a-long-enough-pass' });
  assert.equal(made.body.staff.email, 'newdoc@dralirashid.com');
  assert.ok(!names().includes('inviteUserByEmail'));
  assert.equal(world.calls.find(([k]) => k === 'createUser')![1].email_confirm, true);

  reset({ perms: ['users.manage'], users: [{ id: 'planted', email: 'newdoc@dralirashid.com', confirmed: false }] });
  const refused = await call({ ...newDoc, password: 'a-long-enough-pass' });
  assert.deepEqual(refused.body, { error: 'That login email is already used. Pick another.' });
  assert.equal(world.tables.staff.length, 0);
});

test('create_staff keeps its other guards: permission, the clinic domain, the patient shape, a short password, a role', async () => {
  reset({ perms: [] });
  assert.equal((await call(newDoc)).status, 403);
  reset({ perms: ['users.manage'] });
  assert.match((await call({ ...newDoc, email: 'newdoc@gmail.com' })).body.error, /must end with @dralirashid\.com/);
  assert.match((await call({ ...newDoc, email: 'lookalike-1705@dralirashid.com' })).body.error, /shape of a patient login/);
  assert.match((await call({ ...newDoc, password: 'short' })).body.error, /at least 8 characters/);
  assert.match((await call({ ...newDoc, role: 'admin' })).body.error, /Choose a role/);
  assert.equal(world.calls.length, 0, 'nothing was made by any of them');
});

// ---------------------------------------------------------------- invite_patient
test('invite_patient: a patient email at the clinic domain is refused through the real handler (nothing invited, nothing linked)', async () => {
  reset({ perms: ['portal.invite'], patients: [{ id: 'pat-1', full_name: 'Ali Rashid', mr_number: '1705', email: 'newdoc@dralirashid.com', portal_user_id: null }] });
  const res = await call({ action: 'invite_patient', patient_id: 'pat-1' });
  assert.deepEqual(res, { status: 200, body: { error: 'Use Create portal login for clinic usernames.' } });
  assert.equal(world.calls.length, 0);
  assert.equal(world.tables.patients[0].portal_user_id, null);
  assert.equal(world.users.size, 0);
});

test('invite_patient: a real email is invited and linked; no permission is 403', async () => {
  reset({ perms: ['portal.invite'], patients: [{ id: 'pat-1', full_name: 'Ali Rashid', mr_number: '1705', email: 'ali@gmail.com', portal_user_id: null }] });
  assert.deepEqual((await call({ action: 'invite_patient', patient_id: 'pat-1' })).body, { ok: true });
  assert.equal(world.tables.patients[0].portal_user_id, 'user-1');
  reset({ perms: [], patients: [{ id: 'pat-1', email: 'ali@gmail.com', portal_user_id: null }] });
  assert.equal((await call({ action: 'invite_patient', patient_id: 'pat-1' })).status, 403);
});

// ---------------------------------------------------------------- the patient login actions through the handler
test('create_patient_login and reset_patient_password through the handler: the login is marked in app_metadata, and a reset of a staff login is refused', async () => {
  reset({ perms: ['portal.invite'], patients: [{ id: 'pat-1', full_name: 'Ali Rashid', mr_number: '1705', email: null, portal_user_id: null }] });
  const made = await call({ action: 'create_patient_login', patient_id: 'pat-1', password: 'sunny-grape-zebra-4827' });
  assert.deepEqual(made.body, { ok: true, username: 'alirashid-1705@dralirashid.com' });
  assert.deepEqual(world.users.get('user-1')!.app_metadata, { kind: 'patient', clinic_login: true });
  const again = await call({ action: 'reset_patient_password', patient_id: 'pat-1', password: 'peach-zebra-berry-5936' });
  assert.equal(again.body.ok, true);

  reset({
    perms: ['portal.invite'],
    patients: [{ id: 'pat-1', full_name: 'Ali Rashid', mr_number: '1705', portal_user_id: 'staff-user' }],
    staff: [{ id: 'staff-user', email: 'newdoc@dralirashid.com' }],
    users: [{ id: 'staff-user', email: 'newdoc@dralirashid.com', confirmed: true, user_metadata: { kind: 'patient' } }],
  });
  const refused = await call({ action: 'reset_patient_password', patient_id: 'pat-1', password: 'peach-zebra-berry-5936' });
  assert.match(refused.body.error, /own email address/);
  assert.ok(!names().includes('updateUserById'));
});

test('an unknown action is answered "Unknown action" (400), which the website turns into "Update the admin-users function first."', async () => {
  reset({ perms: ['portal.invite'] });
  assert.deepEqual(await call({ action: 'something_new' }), { status: 400, body: { error: 'Unknown action' } });
});

// ---------------------------------------------------------------- Delete and Bring back
const deskRow = (over: Row = {}) => ({ id: 'desk-1', full_name: 'Busy Desk', email: 'busy@dralirashid.com', role: 'front_desk', active: true,
  deactivated_at: null, deactivated_by: null, deleted_at: null, deleted_by: null, ...over });

test('delete_staff through the handler: an account with records is switched off and kept as deleted; Bring back takes the mark off, still switched off', async () => {
  reset({ perms: ['users.manage'], staff: [deskRow()], users: [{ id: 'desk-1', email: 'busy@dralirashid.com', confirmed: true }],
    records: { 'desk-1': { total: 3, parts: [{ label: 'visits', one: 'visit', count: 3 }] } } });
  const res = await call({ action: 'delete_staff', user_id: 'desk-1' });
  assert.deepEqual(res, { status: 200, body: { ok: true, result: 'archived', total: 3 } });
  const row = world.tables.staff[0];
  assert.ok(row.deleted_at && row.deleted_by === 'caller-1' && row.active === false, 'switched off and marked deleted by the caller');
  assert.deepEqual(world.calls.find(([k]) => k === 'updateUserById')![1], { id: 'desk-1', ban_duration: '876000h' });
  assert.ok(world.users.has('desk-1'), 'the login is kept');
  const back = await call({ action: 'restore_staff', user_id: 'desk-1' });
  assert.deepEqual(back, { status: 200, body: { ok: true } });
  assert.equal(row.deleted_at, null);
  assert.equal(row.active, false, 'still switched off');
  assert.deepEqual(world.tables.audit_log.map((a) => a.action), ['ARCHIVE_LOGIN', 'RESTORE_LOGIN']);
});

test('delete_staff and restore_staff through the handler: without users.manage both are 403 and nothing changes', async () => {
  reset({ perms: [], staff: [deskRow()] });
  assert.equal((await call({ action: 'delete_staff', user_id: 'desk-1' })).status, 403);
  assert.equal((await call({ action: 'restore_staff', user_id: 'desk-1' })).status, 403);
  assert.equal(world.calls.length, 0);
  assert.equal(world.tables.staff[0].active, true);
});

test('create_staff and update_login: the email of a deleted account says whose it is and that it can be brought back; nothing is made', async () => {
  reset({ perms: ['users.manage'], staff: [deskRow({ active: false, deleted_at: '2026-10-15T09:00:00.000Z' })] });
  const made = await call({ ...newDoc, email: 'busy@dralirashid.com', password: 'a-long-enough-pass' });
  assert.deepEqual(made.body, { error: 'That login email belongs to a deleted account (Busy Desk). Bring it back from Deleted accounts, or pick another email.' });
  assert.ok(!names().includes('createUser'), 'no login was made');
  assert.equal(world.tables.staff.length, 1);
});

test('unban_user (Switch on) refuses a deleted account: it is brought back first', async () => {
  reset({ perms: ['users.manage'], staff: [deskRow({ active: false, deleted_at: '2026-10-15T09:00:00.000Z' })] });
  const res = await call({ action: 'unban_user', user_id: 'desk-1' });
  assert.deepEqual(res.body, { error: 'Busy Desk is in Deleted accounts. Bring the account back first, then switch it on.' });
  assert.ok(!names().includes('updateUserById'), 'the login stays locked');
  assert.equal(world.tables.staff[0].active, false);
});
