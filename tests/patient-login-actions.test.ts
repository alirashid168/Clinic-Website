// The patient portal login actions of the admin-users Edge Function, run in Node against a stand-in for the service-role
// client. What this pins down:
//   - create_patient_login derives the username from the patient's CURRENT name and Mr#, makes the login with email_confirm
//     (so no email is sent) and must_change_password, links it to the patient, audits it, and never lets the password
//     reach the audit log or the answer;
//   - it refuses a patient who already has a login, a short password, a caller without portal.invite, and undoes the login
//     it made when the link to the patient fails;
//   - reset_patient_password only works on clinic-domain patient logins, sets must_change_password again, audits without the password;
//   - nothing here lets an address pass for a staff login (and create_staff / update_login refuse the patient shape).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPatientLogin, resetPatientPassword, portalLoginInfo, isClinicPatientLogin } from '../supabase/functions/admin-users/patient-login-actions.ts';

const DOMAIN = 'dralirashid.com';

type Row = Record<string, any>;

/** A stand-in for supabase-js's service client: just the calls the actions make, over in-memory tables, recording every write. */
function fakeAdmin(seed: { patients?: Row[]; staff?: Row[]; users?: Row[] } = {}) {
  const f: any = {
    tables: { patients: seed.patients ?? [], staff: seed.staff ?? [], audit_log: [] as Row[] } as Record<string, Row[]>,
    users: new Map<string, Row>((seed.users ?? []).map((u) => [u.id, u])),
    calls: [] as Array<[string, any]>,
    failLink: false,
    createError: null as null | { message: string },
    nextId: 1,
  };
  f.from = (table: string) => {
    let rows = f.tables[table] as Row[];
    let patch: Row | null = null;
    const filters: Array<[string, unknown]> = [];
    const b: any = {
      select() { return b; },
      eq(col: string, value: unknown) { filters.push([col, value]); return b; },
      update(p: Row) { patch = p; return b; },
      insert(row: Row) { f.calls.push([`insert ${table}`, row]); rows.push(row); return Promise.resolve({ data: null, error: null }); },
      async maybeSingle() {
        const hit = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
        if (patch) {
          f.calls.push([`update ${table}`, patch]);
          if (table === 'patients' && f.failLink) return { data: null, error: { message: 'link failed' } };
          for (const r of hit) Object.assign(r, patch);
          return { data: hit[0] ? { id: hit[0].id } : null, error: null };
        }
        return { data: hit[0] ? { ...hit[0] } : null, error: null };
      },
    };
    return b;
  };
  f.auth = {
    admin: {
      async createUser(attrs: Row) {
        f.calls.push(['createUser', attrs]);
        if (f.createError) return { data: { user: null }, error: f.createError };
        if ([...f.users.values()].some((u) => u.email === attrs.email)) return { data: { user: null }, error: { message: 'A user with this email address has already been registered' } };
        const user = { id: `user-${f.nextId++}`, email: attrs.email, user_metadata: attrs.user_metadata };
        f.users.set(user.id, user);
        return { data: { user }, error: null };
      },
      async getUserById(id: string) {
        const user = f.users.get(id);
        return user ? { data: { user: { ...user } }, error: null } : { data: { user: null }, error: { message: 'User not found' } };
      },
      async updateUserById(id: string, attrs: Row) {
        f.calls.push(['updateUserById', { id, ...attrs }]);
        const user = f.users.get(id);
        if (!user) return { data: null, error: { message: 'User not found' } };
        Object.assign(user, { ...attrs, password: undefined }, { user_metadata: attrs.user_metadata ?? user.user_metadata });
        return { data: { user }, error: null };
      },
      async deleteUser(id: string) { f.calls.push(['deleteUser', id]); f.users.delete(id); return { data: null, error: null }; },
    },
  };
  return f;
}

const ali = () => ({ id: 'pat-1', full_name: 'Ali Rashid', mr_number: '1705', portal_user_id: null });
const deps = (admin: any, perms: string[] = ['portal.invite']) => ({ admin, can: async (k: string) => perms.includes(k), caller: 'staff-1', domain: DOMAIN });
const password = 'sunny-grape-4827';

// ---------------------------------------------------------------- create_patient_login
test('create: the username is the name and Mr# at the clinic domain; the login is confirmed, must change its password, and is linked', async () => {
  const admin = fakeAdmin({ patients: [ali()] });
  const res = await createPatientLogin(deps(admin), { patient_id: 'pat-1', password });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, username: 'alirashid-1705@dralirashid.com' });
  const [, attrs] = admin.calls.find(([k]: [string]) => k === 'createUser');
  assert.deepEqual(attrs, {
    email: 'alirashid-1705@dralirashid.com', password, email_confirm: true,
    user_metadata: { kind: 'patient', must_change_password: true },
  });
  assert.equal(admin.tables.patients[0].portal_user_id, 'user-1', 'linked to the patient');
});

test('create: no email is ever sent (a plain createUser with email_confirm, never an invitation or a magic link)', async () => {
  const admin = fakeAdmin({ patients: [ali()] });
  await createPatientLogin(deps(admin), { patient_id: 'pat-1', password });
  assert.deepEqual(admin.calls.map(([k]: [string]) => k), ['createUser', 'update patients', 'insert audit_log']);
  const source = readFileSync(new URL('../supabase/functions/admin-users/patient-login-actions.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /inviteUserByEmail|resetPasswordForEmail|generateLink|signInWithOtp/);
});

test('create: the audit log says PORTAL_LOGIN_CREATED with the username, and the password is nowhere in it, the answer or the calls to the patient table', async () => {
  const admin = fakeAdmin({ patients: [ali()] });
  const res = await createPatientLogin(deps(admin), { patient_id: 'pat-1', password });
  assert.deepEqual(admin.tables.audit_log, [{ table_name: 'patients', row_id: 'pat-1', action: 'PORTAL_LOGIN_CREATED', actor: 'staff-1', new_data: { username: 'alirashid-1705@dralirashid.com' } }]);
  assert.ok(!JSON.stringify(admin.tables.audit_log).includes(password));
  assert.ok(!JSON.stringify(res).includes(password));
  const outsideAuth = admin.calls.filter(([k]: [string]) => k !== 'createUser');
  assert.ok(!JSON.stringify(outsideAuth).includes(password), 'only the login server ever receives it');
});

test('create: uses the patient\'s current name (edited since registration) and a legacy Mr#', async () => {
  const admin = fakeAdmin({ patients: [{ id: 'pat-9', full_name: "Zoë O'Brien", mr_number: '347-1', portal_user_id: null }] });
  const res = await createPatientLogin(deps(admin), { patient_id: 'pat-9', password });
  assert.equal(res.body.username, 'zoeobrien-347-1@dralirashid.com');
});

test('create: an Urdu name still gets a username', async () => {
  const admin = fakeAdmin({ patients: [{ id: 'pat-8', full_name: 'علی رشید', mr_number: '1705', portal_user_id: null }] });
  const res = await createPatientLogin(deps(admin), { patient_id: 'pat-8', password });
  assert.equal(res.body.username, 'patient-1705@dralirashid.com');
});

test('create: a patient who already has a portal login is refused, and nothing is made', async () => {
  const admin = fakeAdmin({ patients: [{ ...ali(), portal_user_id: 'user-old' }] });
  const res = await createPatientLogin(deps(admin), { patient_id: 'pat-1', password });
  assert.deepEqual(res.body, { error: 'This patient already has a portal login.' });
  assert.equal(admin.calls.length, 0);
});

test('create: a password under 8 characters (or none) is refused before anything is made', async () => {
  for (const bad of ['short', '', undefined, null, '1234567']) {
    const admin = fakeAdmin({ patients: [ali()] });
    const res = await createPatientLogin(deps(admin), { patient_id: 'pat-1', password: bad });
    assert.match(String(res.body.error), /at least 8 characters/);
    assert.equal(res.status, 200, 'a problem the person can fix is a plain answer');
    assert.equal(admin.calls.length, 0);
  }
});

test('create: a caller without portal.invite is refused (403) before the patient is even looked up', async () => {
  const admin = fakeAdmin({ patients: [ali()] });
  const res = await createPatientLogin(deps(admin, ['patients.view']), { patient_id: 'pat-1', password });
  assert.equal(res.status, 403);
  assert.equal(admin.calls.length, 0);
  assert.equal(admin.tables.patients[0].portal_user_id, null);
});

test('create: an unknown patient, and a missing patient id', async () => {
  const admin = fakeAdmin({ patients: [ali()] });
  assert.deepEqual((await createPatientLogin(deps(admin), { patient_id: 'nope', password })).body, { error: 'Patient not found.' });
  assert.deepEqual((await createPatientLogin(deps(admin), { password })).body, { error: 'Patient not found.' });
  assert.equal(admin.calls.length, 0);
});

test('create: a patient with no usable Mr# gets no login (never "name-@")', async () => {
  const admin = fakeAdmin({ patients: [{ id: 'pat-7', full_name: 'Ali', mr_number: '///', portal_user_id: null }] });
  const res = await createPatientLogin(deps(admin), { patient_id: 'pat-7', password });
  assert.match(String(res.body.error), /Mr#/);
  assert.equal(admin.calls.length, 0);
});

test('create: a username that is already a login is refused in plain words', async () => {
  const admin = fakeAdmin({ patients: [ali()], users: [{ id: 'user-x', email: 'alirashid-1705@dralirashid.com' }] });
  const res = await createPatientLogin(deps(admin), { patient_id: 'pat-1', password });
  assert.deepEqual(res.body, { error: 'That username is already used by another login.' });
  assert.equal(admin.tables.patients[0].portal_user_id, null);
  assert.equal(admin.tables.audit_log.length, 0);
});

test('create: an address that is a staff login is never reused', async () => {
  const admin = fakeAdmin({ patients: [ali()], staff: [{ id: 's1', email: 'alirashid-1705@dralirashid.com' }] });
  const res = await createPatientLogin(deps(admin), { patient_id: 'pat-1', password });
  assert.match(String(res.body.error), /already used/);
  assert.ok(!admin.calls.some(([k]: [string]) => k === 'createUser'));
});

test('create: when the login cannot be linked to the patient, the login just made is removed again and nothing is audited', async () => {
  const admin = fakeAdmin({ patients: [ali()] });
  admin.failLink = true;
  const res = await createPatientLogin(deps(admin), { patient_id: 'pat-1', password });
  assert.equal(res.body.error, 'link failed');
  assert.deepEqual(admin.calls.filter(([k]: [string]) => k === 'deleteUser'), [['deleteUser', 'user-1']]);
  assert.equal(admin.users.size, 0, 'no orphan login');
  assert.equal(admin.tables.audit_log.length, 0);
});

test('create: any other error of the login server is passed on in its own words', async () => {
  const admin = fakeAdmin({ patients: [ali()] });
  admin.createError = { message: 'Password is known to be weak' };
  const res = await createPatientLogin(deps(admin), { patient_id: 'pat-1', password });
  assert.deepEqual(res.body, { error: 'Password is known to be weak' });
  assert.equal(admin.tables.patients[0].portal_user_id, null);
});

test('create: a second try for the same patient is refused (the login exists now)', async () => {
  const admin = fakeAdmin({ patients: [ali()] });
  assert.equal((await createPatientLogin(deps(admin), { patient_id: 'pat-1', password })).body.ok, true);
  const again = await createPatientLogin(deps(admin), { patient_id: 'pat-1', password: 'another-pass-2222' });
  assert.deepEqual(again.body, { error: 'This patient already has a portal login.' });
  assert.equal(admin.users.size, 1);
});

// ---------------------------------------------------------------- reset_patient_password
async function withLogin() {
  const admin = fakeAdmin({ patients: [ali()] });
  await createPatientLogin(deps(admin), { patient_id: 'pat-1', password });
  // The patient chose their own password at the first login: the flag is off.
  admin.users.get('user-1').user_metadata = { kind: 'patient', must_change_password: false };
  admin.calls.length = 0;
  admin.tables.audit_log.length = 0;
  return admin;
}

test('reset: sets the password, turns must_change_password back on, keeps the rest of the metadata, and audits without the password', async () => {
  const admin = await withLogin();
  const next = 'peach-zebra-5936';
  const res = await resetPatientPassword(deps(admin), { patient_id: 'pat-1', password: next });
  assert.deepEqual(res, { status: 200, body: { ok: true, username: 'alirashid-1705@dralirashid.com' } });
  const [, attrs] = admin.calls.find(([k]: [string]) => k === 'updateUserById');
  assert.deepEqual(attrs, { id: 'user-1', password: next, user_metadata: { kind: 'patient', must_change_password: true } });
  assert.deepEqual(admin.tables.audit_log, [{ table_name: 'patients', row_id: 'pat-1', action: 'PORTAL_PASSWORD_RESET', actor: 'staff-1', new_data: { username: 'alirashid-1705@dralirashid.com' } }]);
  assert.ok(!JSON.stringify(admin.tables.audit_log).includes(next));
  assert.ok(!JSON.stringify(res).includes(next));
});

test('reset: the username comes from the login itself, so a patient renamed since still gets the right one', async () => {
  const admin = await withLogin();
  admin.tables.patients[0].full_name = 'Alia Rashid Khan';
  const res = await resetPatientPassword(deps(admin), { patient_id: 'pat-1', password: 'peach-zebra-5936' });
  assert.equal(res.body.username, 'alirashid-1705@dralirashid.com');
});

test('reset: refused for a patient with no login, with a real-email login, and for a short password or a caller without portal.invite', async () => {
  const none = fakeAdmin({ patients: [ali()] });
  assert.match(String((await resetPatientPassword(deps(none), { patient_id: 'pat-1', password })).body.error), /no portal login yet/);

  const invited = fakeAdmin({
    patients: [{ ...ali(), portal_user_id: 'user-mail' }],
    users: [{ id: 'user-mail', email: 'ali@gmail.com', user_metadata: { kind: 'patient', full_name: 'Ali Rashid' } }],
  });
  const refused = await resetPatientPassword(deps(invited), { patient_id: 'pat-1', password });
  assert.match(String(refused.body.error), /own email address/);
  assert.ok(!invited.calls.some(([k]: [string]) => k === 'updateUserById'), 'the invited patient\'s password is never touched');

  const admin = await withLogin();
  assert.match(String((await resetPatientPassword(deps(admin), { patient_id: 'pat-1', password: 'abc' })).body.error), /at least 8/);
  assert.equal((await resetPatientPassword(deps(admin, []), { patient_id: 'pat-1', password })).status, 403);
  assert.equal(admin.calls.length, 0);
});

test('reset: never works on a staff login, even one at the clinic domain', async () => {
  const admin = fakeAdmin({
    patients: [{ ...ali(), portal_user_id: 'user-staff' }], // a bad link: the patient row points at a staff login
    users: [{ id: 'user-staff', email: 'reception@dralirashid.com', user_metadata: { full_name: 'Reception' } }],
  });
  const res = await resetPatientPassword(deps(admin), { patient_id: 'pat-1', password });
  assert.match(String(res.body.error), /own email address/);
  assert.ok(!admin.calls.some(([k]: [string]) => k === 'updateUserById'));
});

test('reset: a login that no longer exists is reported, not crashed on', async () => {
  const admin = fakeAdmin({ patients: [{ ...ali(), portal_user_id: 'user-gone' }] });
  assert.match(String((await resetPatientPassword(deps(admin), { patient_id: 'pat-1', password })).body.error), /could not be found/);
});

// ---------------------------------------------------------------- portal_login_info
test('info: no login, a clinic login (with its username), and a real-email login (no username)', async () => {
  const none = fakeAdmin({ patients: [ali()] });
  assert.deepEqual((await portalLoginInfo(deps(none), { patient_id: 'pat-1' })).body, { ok: true, has_login: false, clinic_login: false, username: null });

  const made = await withLogin();
  assert.deepEqual((await portalLoginInfo(deps(made), { patient_id: 'pat-1' })).body, { ok: true, has_login: true, clinic_login: true, username: 'alirashid-1705@dralirashid.com' });

  const invited = fakeAdmin({ patients: [{ ...ali(), portal_user_id: 'u' }], users: [{ id: 'u', email: 'ali@gmail.com', user_metadata: { kind: 'patient' } }] });
  assert.deepEqual((await portalLoginInfo(deps(invited), { patient_id: 'pat-1' })).body, { ok: true, has_login: true, clinic_login: false, username: null });

  assert.equal((await portalLoginInfo(deps(made, []), { patient_id: 'pat-1' })).status, 403);
});

test('isClinicPatientLogin: the clinic domain AND kind patient; a staff address or a real email never matches', () => {
  assert.equal(isClinicPatientLogin({ email: 'a-1@dralirashid.com', user_metadata: { kind: 'patient' } }, DOMAIN), true);
  assert.equal(isClinicPatientLogin({ email: 'A-1@DrAliRashid.com', user_metadata: { kind: 'patient' } }, DOMAIN), true);
  assert.equal(isClinicPatientLogin({ email: 'reception@dralirashid.com', user_metadata: { full_name: 'R' } }, DOMAIN), false);
  assert.equal(isClinicPatientLogin({ email: 'a-1@gmail.com', user_metadata: { kind: 'patient' } }, DOMAIN), false);
  assert.equal(isClinicPatientLogin(null, DOMAIN), false);
});

// ---------------------------------------------------------------- the function itself
test('index.ts routes the three actions and keeps the staff address guard on create_staff and update_login', () => {
  const index = readFileSync(new URL('../supabase/functions/admin-users/index.ts', import.meta.url), 'utf8');
  for (const action of ['create_patient_login', 'reset_patient_password', 'portal_login_info']) assert.match(index, new RegExp(`'${action}'`));
  assert.equal((index.match(/isPatientLoginName\(email, STAFF_DOMAIN\)/g) || []).length, 2, 'create_staff and update_login');
  // The existing actions are still there, unchanged in name.
  for (const action of ['create_staff', 'ban_user', 'unban_user', 'update_login', 'invite_patient']) assert.match(index, new RegExp(`'${action}'`));
  assert.match(index, /await run\(\{ admin, can, caller, domain: STAFF_DOMAIN \}, body\)/);
});
