// The patient portal login actions of the admin-users Edge Function, run in Node against a stand-in for the service-role
// client. What this pins down (the owner, 17 Oct 2026: a simple login, password = the phone on file, no forced change; patients may
// register themselves and wait for approval):
//   - create_patient_login makes the login "mr-<Mr#>@<domain>" with email_confirm (so no email is sent), the password = the patient's
//     mobile number as digits (or the one staff typed), must_change_password OFF, links it to the patient, audits it (with whether the
//     password was the phone or typed, never the password itself);
//   - it refuses a patient who already has a login, a patient with no usable phone when nothing was typed, a short typed password, a caller
//     without portal.invite, and undoes the login it made when the link to the patient fails;
//   - reset_patient_password only works on logins that create_patient_login made, decided from data a user cannot edit (the reserved
//     username shape, app_metadata, and not being in the staff table), sets the password back to the phone (or the typed one), keeps
//     must_change_password off, and audits without the password;
//   - the link to the patient is conditional, and a login made for a patient who was linked in the meantime is deleted again;
//   - self_register makes a pending login only when the Mr#, the mobile number and the name all fit, answers the same sentence either
//     way, writes one SELF_REGISTER audit row per call (outcome, Mr#, address, a hash of the number) and stops at its caps;
//   - reject_registration removes only a login that self_register made;
//   - invite_patient refuses an address at the clinic domain, or one that already has a login, links the patient only if the patient
//     still has no login (and says so when it did not), and audits the address the invitation went to;
//   - nothing here lets an address pass for a staff login (and create_staff / update_login refuse the patient shape).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createPatientLogin, resetPatientPassword, portalLoginInfo, invitePatient, findLoginByEmail, isClinicPatientLogin,
  selfRegister, rejectRegistration, nameFits, normalizePhone, REGISTERED_MESSAGE, REGISTER_CAPS,
} from '../supabase/functions/admin-users/patient-login-actions.ts';

const DOMAIN = 'dralirashid.com';

type Row = Record<string, any>;

/** A stand-in for supabase-js's service client: just the calls the actions make, over in-memory tables, recording every write. */
function fakeAdmin(seed: { patients?: Row[]; staff?: Row[]; users?: Row[]; audit_log?: Row[]; registrations?: Row[] } = {}) {
  const f: any = {
    tables: { patients: seed.patients ?? [], staff: seed.staff ?? [], audit_log: seed.audit_log ?? [], patient_registrations: seed.registrations ?? [] } as Record<string, Row[]>,
    users: new Map<string, Row>((seed.users ?? []).map((u) => [u.id, u])),
    calls: [] as Array<[string, any]>,
    failLink: false,
    failTable: null as null | string, // every read and write of this table fails
    beforeLink: null as null | (() => void), // runs just before the patient row is updated: another request getting in first
    createError: null as null | { message: string },
    nextId: 1,
  };
  // "new_data->>ip" reads the json column's key, as PostgREST does.
  const read = (r: Row, col: string) => (col.includes('->>') ? r[col.split('->>')[0]]?.[col.split('->>')[1]] : r[col]);
  f.from = (table: string) => {
    let rows = f.tables[table] as Row[];
    let patch: Row | null = null;
    let counting = false;
    const filters: Array<[string, string, unknown]> = [];
    const b: any = {
      select(_cols?: string, opts?: Row) { counting = !!opts?.count; return b; },
      eq(col: string, value: unknown) { filters.push(['eq', col, value]); return b; },
      gte(col: string, value: unknown) { filters.push(['gte', col, value]); return b; },
      is(col: string, value: null) { filters.push(['eq', col, value]); return b; }, // "is null": a missing value counts as null
      update(p: Row) { patch = p; return b; },
      then(resolve: any, reject: any) { return b.maybeSingle().then(resolve, reject); }, // awaited without maybeSingle (an update whose answer nobody reads, a count)
      insert(row: Row) {
        f.calls.push([`insert ${table}`, row]);
        if (f.failTable === table) return Promise.resolve({ data: null, error: { message: `${table} is down` } });
        rows.push({ at: new Date().toISOString(), ...row });
        return Promise.resolve({ data: null, error: null });
      },
      async maybeSingle() {
        if (f.failTable === table) return { data: null, error: { message: `${table} is down` }, count: null };
        if (patch && table === 'patients') f.beforeLink?.();
        const hit = rows.filter((r) => filters.every(([op, c, v]) => (op === 'gte' ? String(read(r, c)) >= String(v) : v === null ? read(r, c) == null : read(r, c) === v)));
        if (patch) {
          f.calls.push([`update ${table}`, patch]);
          if (table === 'patients' && f.failLink) return { data: null, error: { message: 'link failed' } };
          for (const r of hit) Object.assign(r, patch);
          return { data: hit[0] ? { id: hit[0].id } : null, error: null };
        }
        if (counting) return { data: null, error: null, count: hit.length };
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
        const user = { id: `user-${f.nextId++}`, email: attrs.email, user_metadata: attrs.user_metadata, app_metadata: attrs.app_metadata };
        f.users.set(user.id, user);
        return { data: { user }, error: null };
      },
      async inviteUserByEmail(email: string, opts: Row) {
        f.calls.push(['inviteUserByEmail', { email, ...opts }]);
        const user = { id: `user-${f.nextId++}`, email, user_metadata: opts?.data };
        f.users.set(user.id, user);
        return { data: { user }, error: null };
      },
      async listUsers({ page, perPage }: { page: number; perPage: number }) {
        f.calls.push(['listUsers', { page, perPage }]);
        const all = [...f.users.values()];
        return { data: { users: all.slice((page - 1) * perPage, page * perPage) }, error: null };
      },
      async getUserById(id: string) {
        const user = f.users.get(id);
        return user ? { data: { user: { ...user } }, error: null } : { data: { user: null }, error: { message: 'User not found' } };
      },
      async updateUserById(id: string, attrs: Row) {
        f.calls.push(['updateUserById', { id, ...attrs }]);
        const user = f.users.get(id);
        if (!user) return { data: null, error: { message: 'User not found' } };
        Object.assign(user, { ...attrs, password: undefined }, { user_metadata: attrs.user_metadata ?? user.user_metadata, app_metadata: user.app_metadata });
        return { data: { user }, error: null };
      },
      async deleteUser(id: string) { f.calls.push(['deleteUser', id]); f.users.delete(id); return { data: null, error: null }; },
    },
  };
  return f;
}

const ali = () => ({ id: 'pat-1', full_name: 'Ali Rashid', mr_number: '1705', phone: '0300-555 1234', portal_user_id: null });
const deps = (admin: any, perms: string[] = ['portal.invite']) => ({ admin, can: async (k: string) => perms.includes(k), caller: 'staff-1', domain: DOMAIN });
const PHONE = '03005551234'; // the password the phone on file becomes
const USERNAME = 'mr-1705@dralirashid.com';
const createCall = (admin: any) => admin.calls.find(([k]: [string]) => k === 'createUser')?.[1];

// ---------------------------------------------------------------- create_patient_login
test('create: the login name is the Mr# at the clinic domain, the password the phone on file as digits, no forced change, confirmed and linked', async () => {
  const admin = fakeAdmin({ patients: [ali()] });
  const res = await createPatientLogin(deps(admin), { patient_id: 'pat-1' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, username: USERNAME, password_kind: 'phone' });
  assert.deepEqual(createCall(admin), {
    email: USERNAME, password: PHONE, email_confirm: true,
    app_metadata: { kind: 'patient', clinic_login: true }, // only the server can write this: it is what marks a clinic login
    user_metadata: { kind: 'patient', must_change_password: false }, // the owner: no forced change at the first login
  });
  assert.equal(admin.tables.patients[0].portal_user_id, 'user-1', 'linked to the patient');
});

test('create: a password staff typed is used instead of the phone (8 to 72 characters, digits allowed), and the audit log says so', async () => {
  const admin = fakeAdmin({ patients: [ali()] });
  const res = await createPatientLogin(deps(admin), { patient_id: 'pat-1', password: 'their-own-1' });
  assert.deepEqual(res.body, { ok: true, username: USERNAME, password_kind: 'typed' });
  assert.equal(createCall(admin).password, 'their-own-1');
  assert.equal(admin.tables.audit_log[0].new_data.password_kind, 'typed');
  for (const bad of ['short', '1234567', 'x'.repeat(73)]) {
    const a = fakeAdmin({ patients: [ali()] });
    const r = await createPatientLogin(deps(a), { patient_id: 'pat-1', password: bad });
    assert.match(String(r.body.error), /at least 8|at most 72/, bad);
    assert.equal(a.calls.length, 0, 'checked before anything is looked up');
  }
  const digits = fakeAdmin({ patients: [ali()] });
  assert.equal((await createPatientLogin(deps(digits), { patient_id: 'pat-1', password: '12345678' })).body.ok, true, 'a typed password may be digits only: the normal password is a phone number');
});

test('create: no usable phone (none, or fewer than 8 digits) and nothing typed is refused with a plain message, and nothing is made', async () => {
  for (const phone of [null, '', '0300', '03-00-55']) {
    const admin = fakeAdmin({ patients: [{ ...ali(), phone }] });
    const res = await createPatientLogin(deps(admin), { patient_id: 'pat-1' });
    assert.match(String(res.body.error), /no mobile number on file with at least 8 digits/, String(phone));
    assert.ok(!admin.calls.some(([k]: [string]) => k === 'createUser'));
    assert.equal(admin.tables.patients[0].portal_user_id, null);
  }
  const typed = fakeAdmin({ patients: [{ ...ali(), phone: null }] });
  assert.equal((await createPatientLogin(deps(typed), { patient_id: 'pat-1', password: 'typed-pass-1' })).body.ok, true, 'a typed password gets round a missing phone');
});

test('create: the phone becomes digits only, whatever way it was written', async () => {
  for (const phone of ['0300 555 1234', '0300-5551234', '(0300) 5551234', '0300.555.1234']) {
    const admin = fakeAdmin({ patients: [{ ...ali(), phone }] });
    await createPatientLogin(deps(admin), { patient_id: 'pat-1' });
    assert.equal(createCall(admin).password, PHONE, phone);
  }
});

test('create: the flag that forces a new password is off, and said so where it is set', async () => {
  const admin = fakeAdmin({ patients: [ali()] });
  await createPatientLogin(deps(admin), { patient_id: 'pat-1' });
  const user = admin.users.get('user-1');
  assert.equal(user.user_metadata.must_change_password, false);
  assert.ok(!('must_change_password' in user.app_metadata));
  const source = readFileSync(new URL('../supabase/functions/admin-users/patient-login-actions.ts', import.meta.url), 'utf8');
  assert.match(source, /No forced change: the owner chose none/, 'said in a comment where it is set');
  assert.doesNotMatch(source, /must_change_password: true/, 'never set on');
});

test('create: no email is ever sent (a plain createUser with email_confirm, never an invitation or a magic link)', async () => {
  const admin = fakeAdmin({ patients: [ali()] });
  await createPatientLogin(deps(admin), { patient_id: 'pat-1' });
  assert.deepEqual(admin.calls.map(([k]: [string]) => k), ['createUser', 'update patients', 'insert audit_log']);
  const source = readFileSync(new URL('../supabase/functions/admin-users/patient-login-actions.ts', import.meta.url), 'utf8');
  // (invite_patient, further down, is the one action that sends an invitation, to a real address)
  const mine = source.slice(source.indexOf('export async function createPatientLogin'), source.indexOf('export async function invitePatient'));
  assert.ok(mine.length > 500 && mine.includes('resetPatientPassword') && mine.includes('portalLoginInfo') && mine.includes('selfRegister'), 'the login actions were found');
  assert.doesNotMatch(mine, /inviteUserByEmail|resetPasswordForEmail|generateLink|signInWithOtp/);
});

test('create: the audit log says PORTAL_LOGIN_CREATED with the username and that the password was the phone; the password is nowhere in it, the answer or the calls to the patient table', async () => {
  const admin = fakeAdmin({ patients: [ali()] });
  const res = await createPatientLogin(deps(admin), { patient_id: 'pat-1' });
  assert.deepEqual(admin.tables.audit_log.map(({ at, ...r }: Row) => r), [{ table_name: 'patients', row_id: 'pat-1', action: 'PORTAL_LOGIN_CREATED', actor: 'staff-1', new_data: { username: USERNAME, password_kind: 'phone' } }]);
  assert.ok(!JSON.stringify(admin.tables.audit_log).includes(PHONE));
  assert.ok(!JSON.stringify(res).includes(PHONE));
  const outsideAuth = admin.calls.filter(([k]: [string]) => k !== 'createUser');
  assert.ok(!JSON.stringify(outsideAuth).includes(PHONE), 'only the login server ever receives it');
});

test('create: a legacy Mr# keeps its dash; the name plays no part in the login name any more', async () => {
  const admin = fakeAdmin({ patients: [{ id: 'pat-9', full_name: "Zoë O'Brien", mr_number: '347-1', phone: PHONE, portal_user_id: null }] });
  const res = await createPatientLogin(deps(admin), { patient_id: 'pat-9' });
  assert.equal(res.body.username, 'mr-347-1@dralirashid.com');
  const urdu = fakeAdmin({ patients: [{ id: 'pat-8', full_name: 'علی رشید', mr_number: '1705', phone: PHONE, portal_user_id: null }] });
  assert.equal((await createPatientLogin(deps(urdu), { patient_id: 'pat-8' })).body.username, USERNAME);
});

test('create: a patient who already has a portal login is refused, and nothing is made', async () => {
  const admin = fakeAdmin({ patients: [{ ...ali(), portal_user_id: 'user-old' }] });
  const res = await createPatientLogin(deps(admin), { patient_id: 'pat-1' });
  assert.deepEqual(res.body, { error: 'This patient already has a portal login.' });
  assert.equal(admin.calls.length, 0);
});

test('create: a caller without portal.invite is refused (403) before the patient is even looked up', async () => {
  const admin = fakeAdmin({ patients: [ali()] });
  const res = await createPatientLogin(deps(admin, ['patients.view']), { patient_id: 'pat-1' });
  assert.equal(res.status, 403);
  assert.equal(admin.calls.length, 0);
  assert.equal(admin.tables.patients[0].portal_user_id, null);
});

test('create: an unknown patient, and a missing patient id', async () => {
  const admin = fakeAdmin({ patients: [ali()] });
  assert.deepEqual((await createPatientLogin(deps(admin), { patient_id: 'nope' })).body, { error: 'Patient not found.' });
  assert.deepEqual((await createPatientLogin(deps(admin), {})).body, { error: 'Patient not found.' });
  assert.equal(admin.calls.length, 0);
});

test('create: a patient with no usable Mr# (none, or no digit in it) gets no login, with a clear message', async () => {
  for (const mr of ['///', 'abc', 'A-B', 'x', '']) {
    const admin = fakeAdmin({ patients: [{ id: 'pat-7', full_name: 'Ali', mr_number: mr, phone: PHONE, portal_user_id: null }] });
    const res = await createPatientLogin(deps(admin), { patient_id: 'pat-7' });
    assert.deepEqual(res.body, { error: 'This patient has no usable Mr# (it needs a number in it), so a username cannot be made.' }, mr);
    assert.equal(admin.calls.length, 0, 'no login made, nothing linked');
  }
});

test('create: a username that is already a login is refused in plain words', async () => {
  const admin = fakeAdmin({ patients: [ali()], users: [{ id: 'user-x', email: USERNAME }] });
  const res = await createPatientLogin(deps(admin), { patient_id: 'pat-1' });
  assert.deepEqual(res.body, { error: 'That username is already used by another login.' });
  assert.equal(admin.tables.patients[0].portal_user_id, null);
  assert.equal(admin.tables.audit_log.length, 0);
});

test('create: an address that is a staff login is never reused', async () => {
  const admin = fakeAdmin({ patients: [ali()], staff: [{ id: 's1', email: USERNAME }] });
  const res = await createPatientLogin(deps(admin), { patient_id: 'pat-1' });
  assert.match(String(res.body.error), /already used/);
  assert.ok(!admin.calls.some(([k]: [string]) => k === 'createUser'));
});

test('create: when the login cannot be linked to the patient, the login just made is removed again and nothing is audited', async () => {
  const admin = fakeAdmin({ patients: [ali()] });
  admin.failLink = true;
  const res = await createPatientLogin(deps(admin), { patient_id: 'pat-1' });
  assert.equal(res.body.error, 'link failed');
  assert.deepEqual(admin.calls.filter(([k]: [string]) => k === 'deleteUser'), [['deleteUser', 'user-1']]);
  assert.equal(admin.users.size, 0, 'no orphan login');
  assert.equal(admin.tables.audit_log.length, 0);
});

test('create: the link to the patient is conditional (update ... where portal_user_id is null)', async () => {
  const source = readFileSync(new URL('../supabase/functions/admin-users/patient-login-actions.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/\.update\(\{ portal_user_id: userId \}\)\.eq\('id', patient\.id\)\.is\('portal_user_id', null\)/g) || []).length, 2, 'create and self_register');
});

test('create: when another request linked the patient between the check and the link, the login just made is deleted, the other link stays, and the staff member is told to reload', async () => {
  const admin = fakeAdmin({ patients: [ali()] });
  admin.beforeLink = () => { admin.tables.patients[0].portal_user_id = 'user-from-the-other-request'; };
  const res = await createPatientLogin(deps(admin), { patient_id: 'pat-1' });
  assert.deepEqual(res.body, { error: 'This patient was just given a login. Reload the page and use Reset portal password if you need a new one.' });
  assert.equal(admin.tables.patients[0].portal_user_id, 'user-from-the-other-request', 'never overwritten');
  assert.deepEqual(admin.calls.filter(([k]: [string]) => k === 'deleteUser'), [['deleteUser', 'user-1']], 'the login made just now is removed again');
  assert.equal(admin.users.size, 0, 'no orphan login');
  assert.equal(admin.tables.audit_log.length, 0);
});

test('create: any other error of the login server is passed on in its own words', async () => {
  const admin = fakeAdmin({ patients: [ali()] });
  admin.createError = { message: 'Password is known to be weak' };
  const res = await createPatientLogin(deps(admin), { patient_id: 'pat-1' });
  assert.deepEqual(res.body, { error: 'Password is known to be weak' });
  assert.equal(admin.tables.patients[0].portal_user_id, null);
});

// ---------------------------------------------------------------- reset_patient_password
async function withLogin() {
  const admin = fakeAdmin({ patients: [ali()] });
  await createPatientLogin(deps(admin), { patient_id: 'pat-1' });
  // The patient changed their password from the portal menu since.
  admin.users.get('user-1').user_metadata = { kind: 'patient', must_change_password: false };
  admin.calls.length = 0;
  admin.tables.audit_log.length = 0;
  return admin;
}

test('reset: sets the password back to the phone on file (digits), keeps the forced change off and the rest of the metadata, and audits without the password', async () => {
  const admin = await withLogin();
  admin.tables.patients[0].phone = '0300 555 9999'; // the number changed since the login was made: the new one counts
  const res = await resetPatientPassword(deps(admin), { patient_id: 'pat-1' });
  assert.deepEqual(res, { status: 200, body: { ok: true, username: USERNAME, password_kind: 'phone' } });
  const [, attrs] = admin.calls.find(([k]: [string]) => k === 'updateUserById');
  assert.deepEqual(attrs, { id: 'user-1', password: '03005559999', user_metadata: { kind: 'patient', must_change_password: false } });
  assert.deepEqual(admin.tables.audit_log.map(({ at, ...r }: Row) => r), [{ table_name: 'patients', row_id: 'pat-1', action: 'PORTAL_PASSWORD_RESET', actor: 'staff-1', new_data: { username: USERNAME, password_kind: 'phone' } }]);
  assert.ok(!JSON.stringify(admin.tables.audit_log).includes('03005559999'));
  assert.ok(!JSON.stringify(res).includes('03005559999'));
});

test('reset: a typed password is used instead; an older login still prompted for a new password is no longer prompted', async () => {
  const admin = await withLogin();
  admin.users.get('user-1').user_metadata = { kind: 'patient', must_change_password: true };
  const res = await resetPatientPassword(deps(admin), { patient_id: 'pat-1', password: 'peach-zebra-5936' });
  assert.equal(res.body.password_kind, 'typed');
  const [, attrs] = admin.calls.find(([k]: [string]) => k === 'updateUserById');
  assert.deepEqual(attrs, { id: 'user-1', password: 'peach-zebra-5936', user_metadata: { kind: 'patient', must_change_password: false } });
});

test('reset: the username comes from the login itself (an older name-Mr# login keeps it)', async () => {
  const admin = fakeAdmin({
    patients: [{ ...ali(), portal_user_id: 'u-old' }],
    users: [{ id: 'u-old', email: 'alirashid-1705@dralirashid.com', app_metadata: { kind: 'patient', clinic_login: true }, user_metadata: { kind: 'patient' } }],
  });
  const res = await resetPatientPassword(deps(admin), { patient_id: 'pat-1' });
  assert.equal(res.body.username, 'alirashid-1705@dralirashid.com');
});

test('reset: refused for a patient with no login, with a real-email login, with no usable phone and nothing typed, for a short typed password, or a caller without portal.invite', async () => {
  const none = fakeAdmin({ patients: [ali()] });
  assert.match(String((await resetPatientPassword(deps(none), { patient_id: 'pat-1' })).body.error), /no portal login yet/);

  const invited = fakeAdmin({
    patients: [{ ...ali(), portal_user_id: 'user-mail' }],
    users: [{ id: 'user-mail', email: 'ali@gmail.com', user_metadata: { kind: 'patient', full_name: 'Ali Rashid' } }],
  });
  const refused = await resetPatientPassword(deps(invited), { patient_id: 'pat-1' });
  assert.match(String(refused.body.error), /own email address/);
  assert.ok(!invited.calls.some(([k]: [string]) => k === 'updateUserById'), 'the invited patient\'s password is never touched');

  const admin = await withLogin();
  admin.tables.patients[0].phone = null;
  assert.match(String((await resetPatientPassword(deps(admin), { patient_id: 'pat-1' })).body.error), /no mobile number on file/);
  assert.match(String((await resetPatientPassword(deps(admin), { patient_id: 'pat-1', password: 'abc' })).body.error), /at least 8/);
  assert.equal((await resetPatientPassword(deps(admin, []), { patient_id: 'pat-1' })).status, 403);
  assert.equal(admin.calls.length, 0);
});

test('reset: never works on a staff login, even one at the clinic domain', async () => {
  const admin = fakeAdmin({
    patients: [{ ...ali(), portal_user_id: 'user-staff' }], // a bad link: the patient row points at a staff login
    users: [{ id: 'user-staff', email: 'reception@dralirashid.com', user_metadata: { full_name: 'Reception' } }],
  });
  const res = await resetPatientPassword(deps(admin), { patient_id: 'pat-1' });
  assert.match(String(res.body.error), /own email address/);
  assert.ok(!admin.calls.some(([k]: [string]) => k === 'updateUserById'));
});

test('reset: a staff user whose own user_metadata says kind "patient", linked to a patient, is refused (user_metadata is the user\'s to edit, it proves nothing)', async () => {
  const admin = fakeAdmin({
    patients: [{ ...ali(), portal_user_id: 'user-staff' }],
    staff: [{ id: 'user-staff', email: 'newdoc@dralirashid.com' }],
    users: [{ id: 'user-staff', email: 'newdoc@dralirashid.com', user_metadata: { kind: 'patient', must_change_password: false } }],
  });
  const res = await resetPatientPassword(deps(admin), { patient_id: 'pat-1' });
  assert.match(String(res.body.error), /own email address/);
  assert.ok(!admin.calls.some(([k]: [string]) => k === 'updateUserById'), 'the staff member\'s password is never touched');
  assert.equal(admin.tables.audit_log.length, 0);
  assert.deepEqual((await portalLoginInfo(deps(admin), { patient_id: 'pat-1' })).body, { ok: true, has_login: true, clinic_login: false, username: null, pending: false });
});

test('reset: each check alone refuses: the username shape, app_metadata, and the staff table', async () => {
  const user = (over: Row) => ({ id: 'u-x', email: USERNAME, app_metadata: { kind: 'patient', clinic_login: true }, user_metadata: { kind: 'patient' }, ...over });
  const attempt = async (u: Row, staff: Row[] = []) => {
    const admin = fakeAdmin({ patients: [{ ...ali(), portal_user_id: 'u-x' }], staff, users: [u] });
    return { res: await resetPatientPassword(deps(admin), { patient_id: 'pat-1' }), admin };
  };
  const good = await attempt(user({}));
  assert.equal(good.res.body.ok, true, 'all three hold: allowed');
  const wrongShape = await attempt(user({ email: 'reception@dralirashid.com' }));
  const noAppMetadata = await attempt(user({ app_metadata: undefined }));
  const wrongKind = await attempt(user({ app_metadata: { kind: 'staff', clinic_login: true } }));
  const notFlagged = await attempt(user({ app_metadata: { kind: 'patient' } }));
  const inStaffTable = await attempt(user({}), [{ id: 'u-x', email: USERNAME }]);
  for (const [name, r] of Object.entries({ wrongShape, noAppMetadata, wrongKind, notFlagged, inStaffTable })) {
    assert.match(String(r.res.body.error), /own email address/, name);
    assert.ok(!r.admin.calls.some(([k]: [string]) => k === 'updateUserById'), name);
  }
});

test('reset: a login that no longer exists is reported, not crashed on', async () => {
  const admin = fakeAdmin({ patients: [{ ...ali(), portal_user_id: 'user-gone' }] });
  assert.match(String((await resetPatientPassword(deps(admin), { patient_id: 'pat-1' })).body.error), /could not be found/);
});

// ---------------------------------------------------------------- portal_login_info
test('info: no login, a clinic login (with its username), a real-email login (no username), and a registration waiting for approval', async () => {
  const none = fakeAdmin({ patients: [ali()] });
  assert.deepEqual((await portalLoginInfo(deps(none), { patient_id: 'pat-1' })).body, { ok: true, has_login: false, clinic_login: false, username: null, pending: false });

  const made = await withLogin();
  assert.deepEqual((await portalLoginInfo(deps(made), { patient_id: 'pat-1' })).body, { ok: true, has_login: true, clinic_login: true, username: USERNAME, pending: false });

  const invited = fakeAdmin({ patients: [{ ...ali(), portal_user_id: 'u' }], users: [{ id: 'u', email: 'ali@gmail.com', user_metadata: { kind: 'patient' } }] });
  assert.deepEqual((await portalLoginInfo(deps(invited), { patient_id: 'pat-1' })).body, { ok: true, has_login: true, clinic_login: false, username: null, pending: false });

  made.tables.patient_registrations.push({ id: 'r1', patient_id: 'pat-1', user_id: 'user-1', status: 'pending' });
  assert.equal((await portalLoginInfo(deps(made), { patient_id: 'pat-1' })).body.pending, true);

  assert.equal((await portalLoginInfo(deps(made, []), { patient_id: 'pat-1' })).status, 403);
});

test('isClinicPatientLogin: the patient shape at the clinic domain, app_metadata set by the function, and not in the staff table; user_metadata proves nothing', async () => {
  const admin = fakeAdmin();
  const mine = { id: 'u1', app_metadata: { kind: 'patient', clinic_login: true } };
  assert.equal(await isClinicPatientLogin(admin, { ...mine, email: 'mr-1@dralirashid.com' }, DOMAIN), true);
  assert.equal(await isClinicPatientLogin(admin, { ...mine, email: 'a-1@dralirashid.com' }, DOMAIN), true, 'an older name-Mr# login');
  assert.equal(await isClinicPatientLogin(admin, { ...mine, email: 'MR-1@DrAliRashid.com' }, DOMAIN), true);
  assert.equal(await isClinicPatientLogin(admin, { ...mine, email: 'reception@dralirashid.com' }, DOMAIN), false);
  assert.equal(await isClinicPatientLogin(admin, { ...mine, email: 'mr-1@gmail.com' }, DOMAIN), false);
  assert.equal(await isClinicPatientLogin(admin, { id: 'u1', email: 'mr-1@dralirashid.com', user_metadata: { kind: 'patient' } }, DOMAIN), false, 'user_metadata alone');
  assert.equal(await isClinicPatientLogin(admin, { email: 'mr-1@dralirashid.com', app_metadata: mine.app_metadata }, DOMAIN), false, 'no id');
  assert.equal(await isClinicPatientLogin(admin, null, DOMAIN), false);
  // A failed look at the staff table is "no" (it fails closed).
  const broken = fakeAdmin();
  broken.from = () => { const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: null, error: { message: 'down' } }) }; return b; };
  assert.equal(await isClinicPatientLogin(broken, { ...mine, email: 'mr-1@dralirashid.com' }, DOMAIN), false);
});

// ---------------------------------------------------------------- self_register
const reg = (admin: any, body: Row, ip = '203.0.113.5') => selfRegister({ admin, domain: DOMAIN }, body, { ip });
const good = () => ({ full_name: 'Ali Rashid', mr: '1705', phone: '+92 300 5551234', password: 'my-own-pass-8' });
const registerRows = (admin: any) => admin.tables.audit_log.filter((r: Row) => r.action === 'SELF_REGISTER');

test('self_register: Mr#, phone and name match: a pending login with the chosen password, linked, one registration row, one SELF_REGISTER audit row, the neutral answer', async () => {
  const admin = fakeAdmin({ patients: [ali()] });
  const res = await reg(admin, good());
  assert.deepEqual(res, { status: 200, body: { ok: true, message: REGISTERED_MESSAGE } });
  assert.deepEqual(createCall(admin), {
    email: USERNAME, password: 'my-own-pass-8', email_confirm: true,
    app_metadata: { kind: 'patient', clinic_login: true, self_registered: true },
    user_metadata: { kind: 'patient', must_change_password: false },
  });
  assert.equal(admin.tables.patients[0].portal_user_id, 'user-1');
  const [row] = admin.tables.patient_registrations;
  assert.deepEqual({ ...row, at: undefined }, { patient_id: 'pat-1', user_id: 'user-1', typed_name: 'Ali Rashid', typed_phone: PHONE, status: 'pending', at: undefined });
  const notes = registerRows(admin);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].new_data.outcome, 'registered');
  assert.equal(notes[0].new_data.mr, '1705');
  assert.equal(notes[0].new_data.ip, '203.0.113.5');
  assert.match(notes[0].new_data.who, /^[0-9a-f]{16}$/, 'a hash of the number, not the number');
  assert.ok(!JSON.stringify(admin.tables.audit_log).includes(PHONE) && !JSON.stringify(admin.tables.audit_log).includes('my-own-pass-8'));
});

test('self_register: no such Mr#, a wrong number, a wrong name, or a patient who already has a login: the SAME answer, nothing made, the outcome in the audit log', async () => {
  const cases: Array<[string, Row, Row]> = [
    ['no such Mr#', ali(), { ...good(), mr: '1706' }],
    ['wrong number', ali(), { ...good(), phone: '0300 5559999' }],
    ['wrong name', ali(), { ...good(), full_name: 'Sara Khan' }],
    ['has a login', { ...ali(), portal_user_id: 'user-old' }, good()],
  ];
  for (const [name, patient, body] of cases) {
    const admin = fakeAdmin({ patients: [patient] });
    const res = await reg(admin, body);
    assert.deepEqual(res.body, { ok: true, message: REGISTERED_MESSAGE }, name);
    assert.ok(!admin.calls.some(([k]: [string]) => k === 'createUser'), name);
    assert.equal(admin.tables.patient_registrations.length, 0, name);
    assert.match(registerRows(admin)[0].new_data.outcome, /no_match|has_login/, name);
  }
});

test('self_register: bad input is the one thing said plainly, before anything is looked up or logged', async () => {
  const admin = fakeAdmin({ patients: [ali()] });
  assert.match(String((await reg(admin, { ...good(), full_name: 'A' })).body.error), /your name/);
  assert.match(String((await reg(admin, { ...good(), mr: '' })).body.error), /Mr#/);
  assert.match(String((await reg(admin, { ...good(), phone: '0300' })).body.error), /mobile number/);
  assert.match(String((await reg(admin, { ...good(), password: 'short' })).body.error), /at least 8/);
  assert.equal(admin.calls.length, 0);
  assert.equal(admin.tables.audit_log.length, 0);
});

test('self_register: the caps: 3 tries per number a day, 10 per address an hour, 200 a day in all; beyond them the same answer and nothing made (also when the log cannot be read)', async () => {
  assert.deepEqual(REGISTER_CAPS, { perPhoneDay: 3, perIpHour: 10, perDay: 200 });
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
  const tries = (n: number, data: Row, at = now) => Array.from({ length: n }, () => ({ action: 'SELF_REGISTER', at, new_data: data }));
  // The number: three earlier tries today (two of them with another Mr#) use up the number's three.
  const byPhone = fakeAdmin({ patients: [ali()] });
  await reg(byPhone, { ...good(), mr: '1' }); await reg(byPhone, { ...good(), mr: '2' }); await reg(byPhone, { ...good(), mr: '3' });
  assert.equal(registerRows(byPhone).length, 3);
  const capped = await reg(byPhone, good());
  assert.deepEqual(capped.body, { ok: true, message: REGISTERED_MESSAGE });
  assert.ok(!byPhone.calls.some(([k]: [string]) => k === 'createUser'), 'the fourth try with the right details makes nothing');
  assert.equal(registerRows(byPhone).at(-1).new_data.outcome, 'capped');
  // Yesterday's tries do not count.
  const yesterday = fakeAdmin({ patients: [ali()], audit_log: tries(5, { who: 'x', ip: '203.0.113.5' }, old) });
  assert.ok((await reg(yesterday, good())).body.ok && yesterday.calls.some(([k]: [string]) => k === 'createUser'));
  // The address: ten tries this hour from it, any numbers.
  const byIp = fakeAdmin({ patients: [ali()], audit_log: tries(10, { who: 'other', ip: '203.0.113.5' }) });
  await reg(byIp, good());
  assert.ok(!byIp.calls.some(([k]: [string]) => k === 'createUser'));
  assert.equal(registerRows(byIp).at(-1).new_data.outcome, 'capped');
  const otherIp = fakeAdmin({ patients: [ali()], audit_log: tries(10, { who: 'other', ip: '198.51.100.9' }) });
  await reg(otherIp, good());
  assert.ok(otherIp.calls.some(([k]: [string]) => k === 'createUser'), 'another address is not held back by it');
  // The day: 200 in all.
  const day = fakeAdmin({ patients: [ali()], audit_log: tries(200, { who: 'many', ip: '198.51.100.1' }) });
  await reg(day, good());
  assert.ok(!day.calls.some(([k]: [string]) => k === 'createUser'));
  // The log cannot be read: capped (fails closed), still the same answer.
  const blind = fakeAdmin({ patients: [ali()] });
  blind.failTable = 'audit_log';
  assert.deepEqual((await reg(blind, good())).body, { ok: true, message: REGISTERED_MESSAGE });
  assert.ok(!blind.calls.some(([k]: [string]) => k === 'createUser'));
});

test('self_register: a login that appears meanwhile (the username exists) gets the neutral answer; a failed link or registration row undoes the login', async () => {
  const taken = fakeAdmin({ patients: [ali()], users: [{ id: 'u-x', email: USERNAME }] });
  assert.deepEqual((await reg(taken, good())).body, { ok: true, message: REGISTERED_MESSAGE });
  assert.equal(registerRows(taken)[0].new_data.outcome, 'has_login');
  assert.equal(taken.tables.patients[0].portal_user_id, null);

  const raced = fakeAdmin({ patients: [ali()] });
  raced.beforeLink = () => { raced.tables.patients[0].portal_user_id = 'other-login'; };
  assert.deepEqual((await reg(raced, good())).body, { ok: true, message: REGISTERED_MESSAGE });
  assert.equal(raced.tables.patients[0].portal_user_id, 'other-login', 'never overwritten');
  assert.equal(raced.users.size, 0, 'the login made just now is removed again');
  assert.equal(raced.tables.patient_registrations.length, 0);

  const noRow = fakeAdmin({ patients: [ali()] });
  noRow.failTable = 'patient_registrations';
  assert.deepEqual((await reg(noRow, good())).body, { ok: true, message: REGISTERED_MESSAGE });
  assert.equal(noRow.users.size, 0, 'without the pending row the login would open the whole record: it is removed');
  assert.equal(noRow.tables.patients[0].portal_user_id, null, 'and unlinked');
  assert.equal(registerRows(noRow)[0].new_data.outcome, 'failed');
});

test('normalizePhone and nameFits: the ways a number and a name are written', () => {
  for (const p of ['0300 5551234', '+92 300 5551234', '0092-300-5551234', '923005551234', '3005551234', '0300-555-1234']) assert.equal(normalizePhone(p), PHONE, p);
  assert.equal(normalizePhone(''), '');
  assert.equal(normalizePhone('021 34567890'), '02134567890', 'a landline stays as typed');
  assert.equal(nameFits('Ali Rashid', 'Ali Rashid'), true);
  assert.equal(nameFits('ali', 'Ali Rashid'), true, 'the first name alone');
  assert.equal(nameFits('Mr. Ali', 'Dr Ali Rashid'), true, 'titles do not count');
  assert.equal(nameFits('Rashid Ali', 'Ali Rashid'), true, 'the words in another order');
  assert.equal(nameFits('AliRashid', 'Ali Rashid'), true, 'spaces do not matter');
  assert.equal(nameFits('Zoë', "Zoe O'Brien"), true, 'accents do not matter');
  assert.equal(nameFits('Sara Khan', 'Ali Rashid'), false);
  assert.equal(nameFits('Rashid', 'Ali Rashid'), true, 'a family name on its own fits (the Mr# and the number already matched)');
  assert.equal(nameFits('Hamza Rashid', 'Ali Rashid'), false, 'another member of the family does not');
  assert.equal(nameFits('', 'Ali Rashid'), false);
  assert.equal(nameFits('علی', 'Ali Rashid'), false, 'no Latin letters: no fit (register at the clinic instead)');
});

// ---------------------------------------------------------------- reject_registration
test('reject: the database function decides (as the caller) and answers the login id; the patient is unlinked, and the login removed only when self_register made it', async () => {
  const selfMade = { id: 'u-self', email: USERNAME, app_metadata: { kind: 'patient', clinic_login: true, self_registered: true } };
  const rpc = (answer: Row) => ({ rpc: async (name: string, args: Row) => { calls.push([name, args]); return answer; } });
  let calls: Array<[string, Row]> = [];
  const admin = fakeAdmin({ patients: [{ ...ali(), portal_user_id: 'u-self' }], users: [selfMade] });
  const res = await rejectRegistration({ admin, asCaller: rpc({ data: 'u-self', error: null }), can: async () => true }, { patient_id: 'pat-1', reason: 'not this family' });
  assert.deepEqual(res.body, { ok: true, removed: true });
  assert.deepEqual(calls, [['reject_registration', { p_patient: 'pat-1', p_reason: 'not this family' }]]);
  assert.equal(admin.tables.patients[0].portal_user_id, null, 'unlinked with the service role (the link is guarded against staff changes)');
  assert.equal(admin.users.size, 0);
  // A login staff made (not self_registered), a staff login, or no login: nothing is deleted.
  for (const user of [{ id: 'u-staffmade', email: USERNAME, app_metadata: { kind: 'patient', clinic_login: true } }, { id: 'u-s', email: 'reception@dralirashid.com', app_metadata: {} }]) {
    calls = [];
    const a = fakeAdmin({ users: [user], staff: user.id === 'u-s' ? [{ id: 'u-s' }] : [] });
    const r = await rejectRegistration({ admin: a, asCaller: rpc({ data: user.id, error: null }), can: async () => true }, { patient_id: 'pat-1' });
    assert.deepEqual(r.body, { ok: true, removed: false }, user.id);
    assert.equal(a.users.size, 1, user.id);
  }
  // The database refuses (already decided, or no permission): its words, nothing deleted.
  const a2 = fakeAdmin({ users: [selfMade] });
  const refused = await rejectRegistration({ admin: a2, asCaller: rpc({ data: null, error: { message: 'This registration was already decided. Reload the list.' } }), can: async () => true }, { patient_id: 'pat-1' });
  assert.match(String(refused.body.error), /already decided/);
  assert.equal(a2.users.size, 1);
  assert.equal((await rejectRegistration({ admin: a2, asCaller: rpc({ data: 'u-self', error: null }), can: async () => false }, { patient_id: 'pat-1' })).status, 403);
});

// ---------------------------------------------------------------- invite_patient (the step that plants a login)
test('invite: a patient email at the clinic domain is refused, and no invitation is sent or linked', async () => {
  for (const email of ['newdoc@dralirashid.com', 'NewDoc@DrAliRashid.com', ' reception@dralirashid.com ']) {
    const admin = fakeAdmin({ patients: [{ ...ali(), email }] });
    const res = await invitePatient({ ...deps(admin), siteUrl: 'https://www.dralirashid.com' }, { patient_id: 'pat-1' });
    assert.deepEqual(res.body, { error: 'Use Create portal login for clinic usernames.' }, email);
    assert.equal(admin.calls.length, 0, 'nothing was invited');
    assert.equal(admin.tables.patients[0].portal_user_id, null);
  }
});

test('invite: a real email still gets the invitation, linked and audited as before', async () => {
  const admin = fakeAdmin({ patients: [{ ...ali(), email: 'Ali@Gmail.com' }] });
  const res = await invitePatient({ ...deps(admin), siteUrl: 'https://www.dralirashid.com' }, { patient_id: 'pat-1' });
  assert.deepEqual(res, { status: 200, body: { ok: true } });
  const [, sent] = admin.calls.find(([k]: [string]) => k === 'inviteUserByEmail');
  assert.deepEqual(sent, { email: 'ali@gmail.com', redirectTo: 'https://www.dralirashid.com/reset-password.html', data: { full_name: 'Ali Rashid', kind: 'patient' } });
  assert.equal(admin.tables.patients[0].portal_user_id, 'user-1');
  assert.deepEqual(admin.tables.audit_log.map(({ at, ...r }: Row) => r), [{ table_name: 'patients', row_id: 'pat-1', action: 'PORTAL_INVITE', actor: 'staff-1', new_data: { email: 'ali@gmail.com' } }]);
  // an invited login is never a clinic login: its password is reset by email
  assert.equal((await portalLoginInfo(deps(admin), { patient_id: 'pat-1' })).body.clinic_login, false);
});

test('invite: an address that already has a login (a pending invitation of another patient, say) is refused before anything is sent', async () => {
  for (const existing of ['ali@gmail.com', 'ALI@Gmail.com']) {
    const admin = fakeAdmin({ patients: [{ ...ali(), email: 'ali@gmail.com' }, { id: 'pat-2', full_name: 'Sara', mr_number: '1706', portal_user_id: 'user-x', email: existing }], users: [{ id: 'user-x', email: existing }] });
    const res = await invitePatient({ ...deps(admin), siteUrl: 'https://www.dralirashid.com' }, { patient_id: 'pat-1' });
    assert.deepEqual(res.body, { error: 'That email address already has a login. Nothing was sent.' }, existing);
    assert.ok(!admin.calls.some(([k]: [string]) => k === 'inviteUserByEmail'), 'no invitation was sent');
    assert.equal(admin.tables.patients[0].portal_user_id, null, 'the patient was not linked to the other login');
    assert.equal(admin.tables.audit_log.length, 0);
  }
});

test('invite: when the list of existing logins cannot be read, nothing is sent (never "no login")', async () => {
  const admin = fakeAdmin({ patients: [{ ...ali(), email: 'ali@gmail.com' }] });
  admin.auth.admin.listUsers = async () => ({ data: null, error: { message: 'down' } });
  const res = await invitePatient({ ...deps(admin), siteUrl: 'https://www.dralirashid.com' }, { patient_id: 'pat-1' });
  assert.deepEqual(res.body, { error: 'down' });
  assert.ok(!admin.calls.some(([k]: [string]) => k === 'inviteUserByEmail'));
  assert.equal(admin.tables.audit_log.length, 0);
});

test('invite: the link to the patient is conditional; when it does not happen nothing is audited and the staff member is told', async () => {
  // another request linked the patient between the check and the link: their link stays
  const raced = fakeAdmin({ patients: [{ ...ali(), email: 'ali@gmail.com' }] });
  raced.beforeLink = () => { raced.tables.patients[0].portal_user_id = 'other-login'; };
  const res = await invitePatient({ ...deps(raced), siteUrl: 'https://www.dralirashid.com' }, { patient_id: 'pat-1' });
  assert.match(String(res.body.error), /could not be linked/);
  assert.equal(raced.tables.patients[0].portal_user_id, 'other-login', 'the other link is kept');
  assert.equal(raced.tables.audit_log.length, 0, 'no PORTAL_INVITE row for an invitation that is linked to nobody');
  // the update itself fails
  const broken = fakeAdmin({ patients: [{ ...ali(), email: 'ali@gmail.com' }] });
  broken.failLink = true;
  const res2 = await invitePatient({ ...deps(broken), siteUrl: 'https://www.dralirashid.com' }, { patient_id: 'pat-1' });
  assert.match(String(res2.body.error), /could not be linked/);
  assert.equal(broken.tables.audit_log.length, 0);
  assert.equal(broken.tables.patients[0].portal_user_id, null);
});

test('invite: no permission, no email, an existing login and an unknown patient are refused as before', async () => {
  const withMail = () => fakeAdmin({ patients: [{ ...ali(), email: 'ali@gmail.com' }] });
  assert.equal((await invitePatient(deps(withMail(), []), { patient_id: 'pat-1' })).status, 403);
  assert.deepEqual((await invitePatient(deps(fakeAdmin({ patients: [ali()] })), { patient_id: 'pat-1' })).body, { error: 'Add the patient\'s email first.' });
  assert.deepEqual((await invitePatient(deps(fakeAdmin({ patients: [{ ...ali(), email: 'a@b.com', portal_user_id: 'u' }] })), { patient_id: 'pat-1' })).body, { error: 'This patient already has a portal login.' });
  assert.deepEqual((await invitePatient(deps(withMail()), { patient_id: 'nope' })).body, { error: 'Patient not found.' });
});

// ---------------------------------------------------------------- create_staff must not adopt a login that already exists
test('findLoginByEmail: finds a login by its address on any page of the list, ignoring case; null when there is none', async () => {
  const users = Array.from({ length: 7 }, (_, i) => ({ id: `u${i}`, email: `user${i}@x.com` }));
  const admin = fakeAdmin({ users });
  assert.equal((await findLoginByEmail(admin, 'USER6@x.com', 3))?.id, 'u6', 'on the third page of three');
  assert.equal(await findLoginByEmail(admin, 'nobody@x.com', 3), null);
  assert.deepEqual(admin.calls.filter(([k]: [string]) => k === 'listUsers').map(([, a]: [string, any]) => a.page), [1, 2, 3, 1, 2, 3], 'pages are read until a short one');
  assert.equal(await findLoginByEmail(fakeAdmin(), 'a@b.com'), null, 'an empty list');
});

test('findLoginByEmail: a list that cannot be read is an error, never "no login"; a list too long to check is an error too', async () => {
  const admin = fakeAdmin();
  admin.auth.admin.listUsers = async () => ({ data: null, error: { message: 'down' } });
  await assert.rejects(() => findLoginByEmail(admin, 'a@b.com'), /down/);
  const huge = fakeAdmin({ users: Array.from({ length: 6 }, (_, i) => ({ id: `u${i}`, email: `u${i}@x.com` })) });
  await assert.rejects(() => findLoginByEmail(huge, 'zzz@x.com', 2, 2), /too many logins/);
});

// ---------------------------------------------------------------- the function itself
test('index.ts routes the actions, lets only self_register in without a login, and keeps the staff address guard on create_staff and update_login', () => {
  const index = readFileSync(new URL('../supabase/functions/admin-users/index.ts', import.meta.url), 'utf8');
  for (const action of ['create_patient_login', 'reset_patient_password', 'portal_login_info', 'self_register', 'reject_registration']) assert.match(index, new RegExp(`'${action}'`));
  assert.equal((index.match(/isPatientLoginName\(email, STAFF_DOMAIN\)/g) || []).length, 2, 'create_staff and update_login');
  // The existing actions are still there, unchanged in name.
  for (const action of ['create_staff', 'ban_user', 'unban_user', 'update_login', 'invite_patient']) assert.match(index, new RegExp(`'${action}'`));
  assert.match(index, /await run\(\{ admin, can, caller, domain: STAFF_DOMAIN \}, body\)/);
  // self_register is answered before the login check; every other action comes after it.
  const selfAt = index.indexOf("action === 'self_register'");
  const loginCheck = index.indexOf("return json({ error: 'Please log in again.' }, 401)");
  assert.ok(selfAt > 0 && loginCheck > selfAt, 'self_register needs no login');
  for (const action of ['create_staff', 'reject_registration', 'create_patient_login', 'invite_patient']) assert.ok(index.indexOf(`'${action}'`, loginCheck) > loginCheck, `${action} after the login check`);
});
