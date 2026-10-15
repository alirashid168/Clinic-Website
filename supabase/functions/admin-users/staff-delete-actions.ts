// The Delete and Bring back actions of Admin -> Staff accounts, kept apart from index.ts so a test can run them in Node with a
// stand-in for the two clients (tests/staff-delete-actions.test.ts). Nothing here touches Deno or the network: everything comes
// in through `deps`.
//
//   delete_staff  { user_id }  an account nobody used is removed for good; one with records is switched off and kept as deleted (needs users.manage)
//   restore_staff { user_id }  a deleted account is back on the list, still switched off                                      (needs users.manage)
//
// The server decides, never the page: the dialog shows what staff_records() said a moment ago, delete_staff asks again after the
// account is switched off. The database side is 20261015000200_staff_delete.sql (staff.deleted_at, staff_records()).

export type ActionResult = { status: number; body: Record<string, unknown> };

export interface StaffActionDeps {
  /** The service-role client (supabase-js): from(), auth.admin.* */
  admin: any;
  /** The client acting as the caller: rpc('staff_records') runs with the caller's own permission check. */
  asCaller: any;
  /** Asks the database's has_perm() for the caller. */
  can: (key: string) => Promise<boolean>;
  /** The caller's user id, for the audit log. */
  caller: string;
  /** The time to stamp (a test passes a fixed one). */
  now?: () => string;
}

// Like the rest of the function: a refused permission is 403, a plain "no" the person can fix is 200 with { error }
// (supabase-js hides the body of a non-2xx answer behind a generic message).
const refuse = (error: string, status = 200): ActionResult => ({ status, body: { error } });
const ok = (body: Record<string, unknown>): ActionResult => ({ status: 200, body: { ok: true, ...body } });

const NEEDS_UPDATE = 'Deleting staff accounts needs the database update 20261015000200_staff_delete.sql first. Nothing was changed.';

/** What create_staff and update_login say when the email is taken: by a deleted account, they say which and what to do. */
export function emailTakenMessage(owner: { full_name?: string | null; deleted_at?: string | null } | null | undefined): string {
  if (owner?.deleted_at) return `That login email belongs to a deleted account (${owner.full_name || 'no name'}). Bring it back from Deleted accounts, or pick another email.`;
  return 'That login email is already used. Pick another.';
}

async function findStaff(admin: any, id: unknown) {
  const userId = String(id ?? '');
  if (!userId) return { userId, row: null };
  const { data } = await admin.from('staff').select('*').eq('id', userId).maybeSingle();
  return { userId, row: data ?? null };
}

/** Marks a switched-off account deleted and writes ARCHIVE_LOGIN. */
async function archive({ admin, caller }: StaffActionDeps, row: any, stamp: string, extra: Record<string, unknown>) {
  const { error } = await admin.from('staff').update({ deleted_at: stamp, deleted_by: caller }).eq('id', row.id);
  if (error) return error;
  await admin.from('audit_log').insert({ table_name: 'staff', row_id: row.id, action: 'ARCHIVE_LOGIN', actor: caller,
    old_data: { deleted_at: null, deleted_by: null }, new_data: { deleted_at: stamp, deleted_by: caller, ...extra } });
  return null;
}

export async function deleteStaff(deps: StaffActionDeps, body: Record<string, unknown>): Promise<ActionResult> {
  const { admin, asCaller, can, caller } = deps;
  const stamp = (deps.now ?? (() => new Date().toISOString()))();
  if (!(await can('users.manage'))) return refuse('Only Dr. Ali can delete staff accounts.', 403);
  const { userId, row } = await findStaff(admin, body.user_id);
  if (userId && userId === caller) return refuse('You cannot delete your own account.');
  if (!row) return refuse('Staff account not found.');
  if (row.role === 'admin') return refuse('An admin account cannot be deleted.');
  // A database without the update has no deleted_at: say so before anything is changed.
  if (!('deleted_at' in row)) return refuse(NEEDS_UPDATE);
  if (row.deleted_at) return refuse(`${row.full_name} is already in Deleted accounts.`);

  // 1. Switch the account off first, exactly like "Switch off" (ban_user), so nothing new is written under this login while it is
  //    counted. An account that was off already keeps the day it was switched off.
  const off = row.active
    ? { active: false, deactivated_at: stamp, deactivated_by: caller }
    : { active: false, deactivated_at: row.deactivated_at ?? stamp, deactivated_by: row.deactivated_by ?? caller };
  const { error: offErr } = await admin.from('staff').update(off).eq('id', userId);
  if (offErr) return refuse(offErr.message);
  const { error: banErr } = await admin.auth.admin.updateUserById(userId, { ban_duration: '876000h' });
  if (banErr) return refuse(`${row.full_name}'s account is switched off, but the login could not be locked: ${banErr.message}`);
  await admin.auth.admin.signOut(userId).catch(() => {});

  // 2. What the website has with this id on it, asked as the caller (staff_records checks users.manage itself).
  const { data: records, error: countErr } = await asCaller.rpc('staff_records', { p_staff: userId });
  const total = Number(records?.total);
  if (countErr || !Number.isFinite(total)) {
    const missing = /PGRST202|42883|staff_records|could not find the function/i.test(`${countErr?.code ?? ''} ${countErr?.message ?? ''}`);
    return refuse(`${missing ? NEEDS_UPDATE.replace(' Nothing was changed.', '') : `The account's records could not be counted (${countErr?.message ?? 'no answer'}).`} ${row.full_name}'s account is switched off; nothing was deleted.`);
  }
  const before = { ...row, ...off };

  // 3. Records: they keep this person's name, so the account stays, switched off and marked deleted.
  if (total > 0) {
    const err = await archive(deps, before, stamp, { total, parts: records.parts ?? [] });
    if (err) return refuse(`${err.message} ${row.full_name}'s account is switched off; nothing was deleted.`);
    return ok({ result: 'archived', total });
  }

  // 4. Nothing at all: the login is removed for good (the staff row and its personal ticks go with it). A doctor linked to it stays
  //    in the doctors list, without the link. The audit log gets the whole staff row before anything is removed.
  const fallback = async (why: string, unlinked: string[]) => {
    if (unlinked.length) await admin.from('clinicians').update({ staff_id: userId }).in('id', unlinked);
    const err = await archive(deps, before, stamp, { total: 0, remove_failed: why });
    if (err) return refuse(`${err.message} ${row.full_name}'s account is switched off; nothing was deleted.`);
    return ok({ result: 'archived', total: 0, fallback: true });
  };
  const { data: linked, error: linkedErr } = await admin.from('clinicians').select('id').eq('staff_id', userId);
  if (linkedErr) return fallback(linkedErr.message, []);
  const unlinked = (linked ?? []).map((c: any) => String(c.id));
  if (unlinked.length) {
    const { error: unlinkErr } = await admin.from('clinicians').update({ staff_id: null }).in('id', unlinked);
    if (unlinkErr) return fallback(unlinkErr.message, []);
  }
  const { error: auditErr } = await admin.from('audit_log').insert({ table_name: 'staff', row_id: userId, action: 'DELETE_LOGIN', actor: caller,
    old_data: before, new_data: { unlinked_clinicians: unlinked } });
  if (auditErr) return fallback(auditErr.message, unlinked);
  const { error: deleteErr } = await admin.auth.admin.deleteUser(userId);
  if (deleteErr) return fallback(deleteErr.message, unlinked);
  return ok({ result: 'removed', total: 0 });
}

export async function restoreStaff({ admin, can, caller }: StaffActionDeps, body: Record<string, unknown>): Promise<ActionResult> {
  if (!(await can('users.manage'))) return refuse('Only Dr. Ali can bring back staff accounts.', 403);
  const { row } = await findStaff(admin, body.user_id);
  if (!row) return refuse('Staff account not found.');
  if (!row.deleted_at) return refuse(`${row.full_name} is not in Deleted accounts.`);
  // Only the mark goes: the account stays switched off until someone presses Switch on.
  const { error } = await admin.from('staff').update({ deleted_at: null, deleted_by: null }).eq('id', row.id);
  if (error) return refuse(error.message);
  await admin.from('audit_log').insert({ table_name: 'staff', row_id: row.id, action: 'RESTORE_LOGIN', actor: caller,
    old_data: { deleted_at: row.deleted_at, deleted_by: row.deleted_by ?? null }, new_data: { deleted_at: null, deleted_by: null } });
  return ok({});
}
