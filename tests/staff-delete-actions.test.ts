// Delete and Bring back on Admin -> Staff accounts (supabase/functions/admin-users/staff-delete-actions.ts), run in Node against
// stand-ins for the service-role client and the caller's client. What this pins down:
//   - delete_staff switches the account off first, exactly like Switch off (active false, deactivated_at/by, a 100-year ban, sign out),
//     and only then asks staff_records() as the caller, so nothing new is written under the login while it is counted;
//   - no records: the doctor link is taken off, the audit log gets DELETE_LOGIN with the whole staff row BEFORE the login is removed,
//     and the login is removed for good (the staff row and its ticks go with it, the doctor stays);
//   - records: the account stays, switched off and marked deleted (deleted_at, deleted_by), audited as ARCHIVE_LOGIN;
//   - the login cannot be removed (deleteUser fails): it falls back to the deleted mark, puts the doctor link back and says so;
//   - a later step that fails (the lock, the count, the mark) says the account is switched off and nothing was deleted, with a
//     database timeout in plain words (the page would turn "statement timeout" into advice about date ranges);
//   - it refuses the caller's own account, an admin account, an unknown one, a caller without users.manage (403), and a database
//     without the update (before anything is changed);
//   - restore_staff takes the mark off, leaves the account switched off and audits RESTORE_LOGIN;
//   - the email of a deleted account is named as such when someone tries to use it again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteStaff, restoreStaff, emailTakenMessage } from '../supabase/functions/admin-users/staff-delete-actions.ts';

type Row = Record<string, any>;
const NOW = '2026-10-15T09:00:00.000Z';

/** A stand-in for both clients: tables and logins in memory, every call recorded in order, failures on request. */
function fakeWorld(seed: { staff?: Row[]; clinicians?: Row[]; overrides?: Row[]; records?: Record<string, Row> } = {}) {
  const w: any = {
    tables: { staff: seed.staff ?? [], clinicians: seed.clinicians ?? [], staff_permission_overrides: seed.overrides ?? [], audit_log: [] as Row[] } as Record<string, Row[]>,
    users: new Map<string, Row>((seed.staff ?? []).map((s) => [s.id, { id: s.id, email: s.email }])),
    records: seed.records ?? {},
    calls: [] as Array<[string, any]>,
    // 'update staff', 'insert audit_log', 'deleteUser', 'staff_records', 'updateUserById' ... -> message; 'update staff.deleted_at'
    // fails only an update that sets that column first (the deleted mark), not the one that switches the account off.
    fail: {} as Record<string, string>,
    seenAtCount: null as Row | null,    // the staff row as it was when staff_records was asked
  };
  const err = (key: string) => (w.fail[key] ? { message: w.fail[key] } : null);
  w.admin = {
    from(table: string) {
      const rows = w.tables[table] as Row[];
      const filters: Array<(r: Row) => boolean> = [];
      let patch: Row | null = null;
      const hits = () => rows.filter((r) => filters.every((f) => f(r)));
      const run = async () => {
        if (patch) {
          w.calls.push([`update ${table}`, patch]);
          const e = err(`update ${table}`) ?? err(`update ${table}.${Object.keys(patch)[0]}`);
          if (e) return { data: null, error: e };
          for (const r of hits()) Object.assign(r, patch);
          return { data: null, error: null };
        }
        return { data: hits().map((r) => ({ ...r })), error: null };
      };
      const b: any = {
        select() { return b; },
        eq(col: string, v: unknown) { filters.push((r) => r[col] === v); return b; },
        in(col: string, vs: unknown[]) { filters.push((r) => vs.includes(r[col])); return b; },
        update(p: Row) { patch = p; return b; },
        insert(row: Row) {
          w.calls.push([`insert ${table}`, row]);
          const e = err(`insert ${table}`);
          if (!e) rows.push(row);
          return Promise.resolve({ data: null, error: e });
        },
        async maybeSingle() { const r = await run(); return patch ? r : { data: r.data?.[0] ?? null, error: null }; },
        then(resolve: any, reject: any) { return run().then(resolve, reject); },
      };
      return b;
    },
    auth: {
      admin: {
        async updateUserById(id: string, attrs: Row) { w.calls.push(['updateUserById', { id, ...attrs }]); return { data: {}, error: err('updateUserById') }; },
        async signOut(id: string) { w.calls.push(['signOut', id]); return { data: null, error: null }; },
        async deleteUser(id: string) {
          w.calls.push(['deleteUser', id]);
          const e = err('deleteUser') ?? (w.tables.clinicians.some((c: Row) => c.staff_id === id) ? { message: 'violates foreign key constraint clinicians_staff_id_fkey' } : null);
          if (e) return { data: null, error: e };
          // As the database does: the staff row (staff.id references auth.users on delete cascade) and its ticks go with the login.
          w.users.delete(id);
          w.tables.staff = w.tables.staff.filter((s: Row) => s.id !== id);
          w.tables.staff_permission_overrides = w.tables.staff_permission_overrides.filter((o: Row) => o.staff_id !== id);
          return { data: null, error: null };
        },
      },
    },
  };
  w.asCaller = {
    async rpc(name: string, args: Row) {
      w.calls.push([`rpc ${name}`, args]);
      w.seenAtCount = { ...w.tables.staff.find((s: Row) => s.id === args.p_staff) };
      if (w.fail[name]) return { data: null, error: { code: w.fail[name].startsWith('PGRST') ? w.fail[name] : '42501', message: w.fail[name] } };
      return { data: w.records[args.p_staff] ?? { total: 0, parts: [] }, error: null };
    },
  };
  return w;
}

const staffRow = (over: Row) => ({ id: 'x', full_name: 'Somebody', email: 'somebody@dralirashid.com', role: 'front_desk', active: true,
  deactivated_at: null, deactivated_by: null, deleted_at: null, deleted_by: null, restrict_to_branches: false, branch_ids: [], ...over });
const people = () => [
  staffRow({ id: 'admin-1', full_name: 'Dr. Ali Rashid', email: 'ali@dralirashid.com', role: 'admin' }),
  staffRow({ id: 'unused-1', full_name: 'Weekend Desk', email: 'weekend@dralirashid.com', role: 'doctor' }),
  staffRow({ id: 'busy-1', full_name: 'Busy Desk', email: 'busy@dralirashid.com' }),
];
const deps = (w: any, perms: string[] = ['users.manage'], caller = 'admin-1') => ({ admin: w.admin, asCaller: w.asCaller, can: async (k: string) => perms.includes(k), caller, now: () => NOW });
const names = (w: any) => w.calls.map(([k]: [string]) => k);
const staff = (w: any, id: string) => w.tables.staff.find((s: Row) => s.id === id);

// ---------------------------------------------------------------- removed for good
test('delete: an account with no records is switched off, counted, unlinked from its doctor, audited with the whole row, then removed for good', async () => {
  const w = fakeWorld({ staff: people(), clinicians: [{ id: 'cl-1', display_name: 'Dr. Weekend', staff_id: 'unused-1' }, { id: 'cl-2', display_name: 'Dr. Other', staff_id: null }],
    overrides: [{ staff_id: 'unused-1', permission_key: 'billing.view', allowed: true }] });
  const res = await deleteStaff(deps(w), { user_id: 'unused-1' });
  assert.deepEqual(res, { status: 200, body: { ok: true, result: 'removed', total: 0 } });
  assert.deepEqual(names(w), ['update staff', 'updateUserById', 'signOut', 'rpc staff_records', 'update clinicians', 'insert audit_log', 'deleteUser'],
    'switched off first, counted, unlinked, audited, and only then removed');
  assert.deepEqual(w.calls[0][1], { active: false, deactivated_at: NOW, deactivated_by: 'admin-1' }, 'switched off exactly like Switch off');
  assert.deepEqual(w.calls[1][1], { id: 'unused-1', ban_duration: '876000h' }, 'the login is locked like Switch off');
  assert.equal(w.seenAtCount.active, false, 'the account was already switched off when it was counted');
  assert.equal(w.users.has('unused-1'), false, 'the login is gone');
  assert.equal(staff(w, 'unused-1'), undefined, 'the staff row went with it');
  assert.equal(w.tables.staff_permission_overrides.length, 0, 'and so did its personal ticks');
  assert.deepEqual(w.tables.clinicians.map((c: Row) => [c.id, c.staff_id]), [['cl-1', null], ['cl-2', null]], 'the doctor stays, without the login');
  const [audit] = w.tables.audit_log;
  assert.equal(audit.action, 'DELETE_LOGIN');
  assert.equal(audit.table_name, 'staff');
  assert.equal(audit.row_id, 'unused-1');
  assert.equal(audit.actor, 'admin-1');
  assert.equal(audit.old_data.full_name, 'Weekend Desk');
  assert.equal(audit.old_data.email, 'weekend@dralirashid.com');
  assert.equal(audit.old_data.role, 'doctor');
  assert.equal(audit.old_data.active, false, 'the whole row, as it was just before it went');
  assert.deepEqual(audit.new_data, { unlinked_clinicians: ['cl-1'] });
});

test('delete: an account that was switched off long ago keeps the day it was switched off, and is still removed', async () => {
  const w = fakeWorld({ staff: [...people(), staffRow({ id: 'old-1', full_name: 'Old Desk', email: 'old@dralirashid.com', active: false, deactivated_at: '2026-01-02T10:00:00.000Z', deactivated_by: 'admin-1' })] });
  const res = await deleteStaff(deps(w), { user_id: 'old-1' });
  assert.equal(res.body.result, 'removed');
  assert.deepEqual(w.calls[0][1], { active: false, deactivated_at: '2026-01-02T10:00:00.000Z', deactivated_by: 'admin-1' });
});

// ---------------------------------------------------------------- kept as deleted
test('delete: an account with records stays, switched off and marked deleted; nothing is removed', async () => {
  const parts = [{ label: 'visits', one: 'visit', count: 5 }, { label: 'payments', one: 'payment', count: 2 }];
  const w = fakeWorld({ staff: people(), clinicians: [{ id: 'cl-9', staff_id: 'busy-1' }], records: { 'busy-1': { total: 7, parts } } });
  const res = await deleteStaff(deps(w), { user_id: 'busy-1' });
  assert.deepEqual(res, { status: 200, body: { ok: true, result: 'archived', total: 7 } });
  assert.deepEqual(names(w), ['update staff', 'updateUserById', 'signOut', 'rpc staff_records', 'update staff', 'insert audit_log']);
  assert.ok(!names(w).includes('deleteUser'), 'the login is not removed');
  const row = staff(w, 'busy-1');
  assert.equal(row.active, false);
  assert.equal(row.deactivated_at, NOW);
  assert.equal(row.deleted_at, NOW);
  assert.equal(row.deleted_by, 'admin-1');
  assert.equal(w.tables.clinicians[0].staff_id, 'busy-1', 'the doctor link stays (the account may be brought back)');
  assert.deepEqual(w.tables.audit_log.map((a: Row) => [a.action, a.row_id, a.actor]), [['ARCHIVE_LOGIN', 'busy-1', 'admin-1']]);
  assert.deepEqual(w.tables.audit_log[0].new_data, { deleted_at: NOW, deleted_by: 'admin-1', total: 7, parts });
});

test('delete: the page\'s dialog does not decide: an account that has records by the time Delete is pressed is kept, not removed', async () => {
  const w = fakeWorld({ staff: people(), records: { 'unused-1': { total: 1, parts: [{ label: 'visits', one: 'visit', count: 1 }] } } });
  const res = await deleteStaff(deps(w), { user_id: 'unused-1', expect: 'removed' });
  assert.equal(res.body.result, 'archived');
  assert.ok(w.users.has('unused-1'));
});

// ---------------------------------------------------------------- the login cannot be removed
test('delete: when the login cannot be removed, the account is kept as deleted instead, the doctor link is put back, and the answer says so', async () => {
  const w = fakeWorld({ staff: people(), clinicians: [{ id: 'cl-1', staff_id: 'unused-1' }] });
  w.fail.deleteUser = 'Database error deleting user';
  const res = await deleteStaff(deps(w), { user_id: 'unused-1' });
  assert.deepEqual(res, { status: 200, body: { ok: true, result: 'archived', total: 0, fallback: true } });
  assert.ok(w.users.has('unused-1'), 'the login is still there');
  const row = staff(w, 'unused-1');
  assert.equal(row.active, false, 'switched off');
  assert.equal(row.deleted_at, NOW, 'and marked deleted');
  assert.equal(w.tables.clinicians[0].staff_id, 'unused-1', 'the doctor link is back');
  assert.deepEqual(w.tables.audit_log.map((a: Row) => a.action), ['DELETE_LOGIN', 'ARCHIVE_LOGIN']);
  assert.equal(w.tables.audit_log[1].new_data.remove_failed, 'Database error deleting user', 'the audit log says why');
});

test('delete: when the audit row cannot be written, nothing is removed (the account is kept as deleted)', async () => {
  const w = fakeWorld({ staff: people() });
  w.fail['insert audit_log'] = 'permission denied';
  const res = await deleteStaff(deps(w), { user_id: 'unused-1' });
  assert.equal(res.body.result, 'archived');
  assert.equal(res.body.fallback, true);
  assert.ok(!names(w).includes('deleteUser'), 'never removed without its audit row');
  assert.ok(w.users.has('unused-1'));
});

test('delete: the records cannot be counted: the account stays switched off, nothing is deleted, and the answer says so', async () => {
  const w = fakeWorld({ staff: people() });
  w.fail.staff_records = 'PGRST202';
  const res = await deleteStaff(deps(w), { user_id: 'unused-1' });
  assert.match(String(res.body.error), /20261015000200_staff_delete\.sql/);
  assert.match(String(res.body.error), /Weekend Desk's account is switched off; nothing was deleted/);
  assert.equal(staff(w, 'unused-1').active, false);
  assert.equal(staff(w, 'unused-1').deleted_at, null);
  assert.ok(!names(w).includes('deleteUser'));
});

test('delete: the records took the database too long to count: plain words, so the page shows the whole sentence (switched off, nothing deleted)', async () => {
  const w = fakeWorld({ staff: people() });
  w.fail.staff_records = 'canceling statement due to statement timeout';
  const res = await deleteStaff(deps(w), { user_id: 'unused-1' });
  assert.equal(res.body.error, "The account's records could not be counted (the database took too long). Weekend Desk's account is switched off; nothing was deleted.");
  assert.doesNotMatch(String(res.body.error), /statement timeout|canceling statement/, 'no text the page would turn into advice about date ranges');
  assert.equal(staff(w, 'unused-1').active, false);
  assert.ok(!names(w).includes('deleteUser'));
});

test('delete: the login cannot be locked: the answer says the account is switched off, and nothing is counted or removed', async () => {
  const w = fakeWorld({ staff: people() });
  w.fail.updateUserById = 'User not found';
  const res = await deleteStaff(deps(w), { user_id: 'unused-1' });
  assert.deepEqual(res, { status: 200, body: { error: "Weekend Desk's account is switched off, but the login could not be locked: User not found" } });
  assert.deepEqual(names(w), ['update staff', 'updateUserById']);
  assert.equal(staff(w, 'unused-1').active, false, 'switched off');
  assert.equal(staff(w, 'unused-1').deleted_at, null, 'not marked deleted');
  assert.ok(w.users.has('unused-1'));
});

test('delete: an account with records that cannot be marked deleted stays switched off, and the answer says so', async () => {
  const w = fakeWorld({ staff: people(), records: { 'busy-1': { total: 2, parts: [{ label: 'visits', one: 'visit', count: 2 }] } } });
  w.fail['update staff.deleted_at'] = 'permission denied for table staff';
  const res = await deleteStaff(deps(w), { user_id: 'busy-1' });
  assert.deepEqual(res.body, { error: "It could not be moved to Deleted accounts (permission denied for table staff). Busy Desk's account is switched off; nothing was deleted." });
  assert.equal(staff(w, 'busy-1').active, false);
  assert.equal(staff(w, 'busy-1').deleted_at, null);
  assert.deepEqual(w.tables.audit_log, [], 'no ARCHIVE_LOGIN for a mark that was not set');
});

// ---------------------------------------------------------------- refusals
test('delete: the caller\'s own account is refused, and nothing is touched', async () => {
  const w = fakeWorld({ staff: [...people(), staffRow({ id: 'mgr-1', full_name: 'User Manager', email: 'mgr@dralirashid.com', role: 'coordinator' })] });
  const res = await deleteStaff(deps(w, ['users.manage'], 'mgr-1'), { user_id: 'mgr-1' });
  assert.deepEqual(res, { status: 200, body: { error: 'You cannot delete your own account.' } });
  assert.deepEqual(names(w), []);
  assert.equal(staff(w, 'mgr-1').active, true);
});

test('delete: an admin account is refused, even for the admin, and nothing is touched', async () => {
  const w = fakeWorld({ staff: [...people(), staffRow({ id: 'admin-2', full_name: 'Second Admin', email: 'admin2@dralirashid.com', role: 'admin' })] });
  assert.deepEqual((await deleteStaff(deps(w), { user_id: 'admin-2' })).body, { error: 'An admin account cannot be deleted.' });
  assert.deepEqual((await deleteStaff(deps(w, ['users.manage'], 'busy-1'), { user_id: 'admin-1' })).body, { error: 'An admin account cannot be deleted.' });
  assert.deepEqual(names(w), []);
  assert.equal(staff(w, 'admin-2').active, true);
});

test('delete: a caller without users.manage is refused (403) before anything is looked at', async () => {
  const w = fakeWorld({ staff: people() });
  const res = await deleteStaff(deps(w, ['patients.view'], 'busy-1'), { user_id: 'unused-1' });
  assert.deepEqual(res, { status: 403, body: { error: 'Only Dr. Ali can delete staff accounts.' } });
  assert.deepEqual(names(w), []);
  assert.equal(staff(w, 'unused-1').active, true);
});

test('delete: an unknown account, a missing id, and an account already in Deleted accounts', async () => {
  const w = fakeWorld({ staff: [...people(), staffRow({ id: 'arch-1', full_name: 'Gone Desk', email: 'gone@dralirashid.com', active: false, deleted_at: NOW })] });
  assert.deepEqual((await deleteStaff(deps(w), { user_id: 'nobody' })).body, { error: 'Staff account not found.' });
  assert.deepEqual((await deleteStaff(deps(w), {})).body, { error: 'Staff account not found.' });
  assert.deepEqual((await deleteStaff(deps(w), { user_id: 'arch-1' })).body, { error: 'Gone Desk is already in Deleted accounts.' });
  assert.deepEqual(names(w), []);
});

test('delete: a database without the update (no deleted_at column) is refused before the account is switched off', async () => {
  const old = people().map(({ deleted_at, deleted_by, ...rest }) => rest);
  const w = fakeWorld({ staff: old });
  const res = await deleteStaff(deps(w), { user_id: 'unused-1' });
  assert.match(String(res.body.error), /needs the database update 20261015000200_staff_delete\.sql first\. Nothing was changed\./);
  assert.deepEqual(names(w), []);
  assert.equal(staff(w, 'unused-1').active, true);
});

// ---------------------------------------------------------------- bring back
test('restore: Bring back takes the mark off, the account stays switched off, and it is audited', async () => {
  const w = fakeWorld({ staff: [...people(), staffRow({ id: 'arch-1', full_name: 'Gone Desk', email: 'gone@dralirashid.com', active: false, deactivated_at: NOW, deleted_at: NOW, deleted_by: 'admin-1' })] });
  const res = await restoreStaff(deps(w), { user_id: 'arch-1' });
  assert.deepEqual(res, { status: 200, body: { ok: true } });
  const row = staff(w, 'arch-1');
  assert.equal(row.deleted_at, null);
  assert.equal(row.deleted_by, null);
  assert.equal(row.active, false, 'still switched off: Switch on is a separate step');
  assert.ok(!names(w).includes('updateUserById'), 'the login stays locked');
  assert.deepEqual(w.tables.audit_log.map((a: Row) => [a.action, a.row_id, a.actor]), [['RESTORE_LOGIN', 'arch-1', 'admin-1']]);
  assert.deepEqual(w.tables.audit_log[0].old_data, { deleted_at: NOW, deleted_by: 'admin-1' });
});

test('restore: refused without users.manage (403), for an unknown account, and for one that is not deleted', async () => {
  const w = fakeWorld({ staff: [...people(), staffRow({ id: 'arch-1', full_name: 'Gone Desk', active: false, deleted_at: NOW })] });
  assert.deepEqual(await restoreStaff(deps(w, [], 'busy-1'), { user_id: 'arch-1' }), { status: 403, body: { error: 'Only Dr. Ali can bring back staff accounts.' } });
  assert.deepEqual((await restoreStaff(deps(w), { user_id: 'nobody' })).body, { error: 'Staff account not found.' });
  assert.deepEqual((await restoreStaff(deps(w), { user_id: 'busy-1' })).body, { error: 'Busy Desk is not in Deleted accounts.' });
  assert.deepEqual(names(w), []);
  assert.equal(staff(w, 'arch-1').deleted_at, NOW);
});

test('restore: when the mark cannot be taken off, the answer says nothing was changed, and nothing is audited', async () => {
  const w = fakeWorld({ staff: [...people(), staffRow({ id: 'arch-1', full_name: 'Gone Desk', active: false, deleted_at: NOW, deleted_by: 'admin-1' })] });
  w.fail['update staff.deleted_at'] = 'canceling statement due to statement timeout';
  const res = await restoreStaff(deps(w), { user_id: 'arch-1' });
  assert.deepEqual(res.body, { error: 'Gone Desk could not be brought back (the database took too long). Nothing was changed.' });
  assert.equal(staff(w, 'arch-1').deleted_at, NOW);
  assert.deepEqual(w.tables.audit_log, []);
});

// ---------------------------------------------------------------- the email of a deleted account
test('the email of a deleted account is named as such; any other taken email gets the usual answer', () => {
  assert.equal(emailTakenMessage({ full_name: 'Gone Desk', deleted_at: NOW }),
    'That login email belongs to a deleted account (Gone Desk). Bring it back from Deleted accounts, or pick another email.');
  assert.equal(emailTakenMessage({ full_name: 'Busy Desk', deleted_at: null }), 'That login email is already used. Pick another.');
  assert.equal(emailTakenMessage(null), 'That login email is already used. Pick another.');
});
