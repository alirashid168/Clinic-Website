// The patient portal login actions of the admin-users Edge Function, kept apart from index.ts so a test can run them
// in Node with a stand-in for the admin client (tests/patient-login-actions.test.ts). Nothing here touches Deno or the network:
// everything comes in through `deps`.
//
//   create_patient_login   { patient_id, password }  staff make the patient's login at the clinic         (needs portal.invite)
//   reset_patient_password { patient_id, password }  staff set a new password for a login made this way    (needs portal.invite)
//   portal_login_info      { patient_id }            does the patient have a login, and is it a clinic one (needs portal.invite)
//   invite_patient         { patient_id }            emails the patient an invitation (real addresses only) (needs portal.invite)
//
// The password is only ever passed to the login server. It is never logged, audited or sent back.
import { checkSlipPassword, isPatientLoginName, NO_USERNAME_MESSAGE, portalLoginEmail } from './portal-login.ts';

export type ActionResult = { status: number; body: Record<string, unknown> };

export interface ActionDeps {
  /** The service-role client (supabase-js): from(), auth.admin.* */
  admin: any;
  /** Asks the database's has_perm() for the caller. */
  can: (key: string) => Promise<boolean>;
  /** The caller's user id, for the audit log. */
  caller: string;
  /** The clinic's login domain (STAFF_EMAIL_DOMAIN). */
  domain: string;
  /** Where invitation links land (SITE_URL), for invite_patient. */
  siteUrl?: string;
}

// Like the rest of the function: a refused permission is 403, a plain "no" the person can fix is 200 with { error }
// (supabase-js hides the body of a non-2xx answer behind a generic message).
const refuse = (error: string, status = 200): ActionResult => ({ status, body: { error } });
const ok = (body: Record<string, unknown>): ActionResult => ({ status: 200, body: { ok: true, ...body } });

const ALREADY = /already|registered|exists|duplicate/i;
const JUST_GIVEN = 'This patient was just given a login. Reload the page and use Reset portal password if you need a new one.';

async function findPatient(admin: any, id: unknown) {
  const patientId = String(id ?? '');
  if (!patientId) return null;
  const { data } = await admin.from('patients').select('id, full_name, mr_number, email, portal_user_id').eq('id', patientId).maybeSingle();
  return data ?? null;
}

/**
 * A login that create_patient_login made, decided ONLY from things a user cannot edit:
 *   - the username has the reserved patient shape (a name, a dash and a number at the clinic domain; create_staff and update_login
 *     refuse that shape for staff),
 *   - app_metadata says so (kind 'patient', clinic_login true). Only this function writes app_metadata; a user can write
 *     user_metadata, so that is never trusted for this,
 *   - and the user id is not in the staff table.
 * Real-email invitations, and staff logins, never match. It fails closed: a failed staff lookup is "no".
 */
export async function isClinicPatientLogin(admin: any, user: any, domain: string): Promise<boolean> {
  if (!user?.id || !isPatientLoginName(String(user.email ?? ''), domain)) return false;
  const app = user.app_metadata ?? {};
  if (app.kind !== 'patient' || app.clinic_login !== true) return false;
  const { data: staffRow, error } = await admin.from('staff').select('id').eq('id', user.id).maybeSingle();
  return !error && !staffRow;
}

/**
 * The login (auth user) that already has this email, or null. supabase-js has no lookup by email, so the list is read page by page.
 * create_staff asks before it sends an invitation: inviting an address that already has an unconfirmed login hands back THAT login,
 * and a staff row would be attached to an account somebody else made. Throws when the list cannot be read or is too long to check.
 */
export async function findLoginByEmail(admin: any, email: string, perPage = 1000, maxPages = 50): Promise<any | null> {
  const wanted = String(email ?? '').trim().toLowerCase();
  for (let page = 1; page <= maxPages; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(error.message || 'The existing logins could not be checked.');
    const users: any[] = data?.users ?? [];
    const hit = users.find((u) => String(u?.email ?? '').toLowerCase() === wanted);
    if (hit) return hit;
    if (users.length < perPage) return null;
  }
  throw new Error('There are too many logins to check this address. Ask for help.');
}

export async function createPatientLogin({ admin, can, caller, domain }: ActionDeps, body: Record<string, unknown>): Promise<ActionResult> {
  if (!(await can('portal.invite'))) return refuse('You are not allowed to create patient logins.', 403);
  const password = body.password == null ? '' : String(body.password);
  const passwordProblem = checkSlipPassword(password);
  if (passwordProblem) return refuse(passwordProblem);

  const patient = await findPatient(admin, body.patient_id);
  if (!patient) return refuse('Patient not found.');
  if (patient.portal_user_id) return refuse('This patient already has a portal login.');

  // Every clinic username has the reserved patient shape (that is how create_staff keeps staff addresses apart from it).
  const email = portalLoginEmail(patient.full_name, patient.mr_number, domain);
  if (!email || !isPatientLoginName(email, domain)) return refuse(NO_USERNAME_MESSAGE);
  // A staff login can never look like a patient username (create_staff refuses that shape), but never reuse one if it somehow does.
  const { data: staffRow } = await admin.from('staff').select('id').eq('email', email).maybeSingle();
  if (staffRow) return refuse('That username is already used by another login.');

  const { data: made, error: makeErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, // no email is ever sent
    // app_metadata can only be written here (a user cannot edit it): it is what marks this as a login made at the clinic.
    app_metadata: { kind: 'patient', clinic_login: true },
    // must_change_password is a PROMPT, deliberately in user_metadata (the patient's own to edit): a patient who clears it without
    // changing the password only weakens their own account. It is not a lock, so nothing may rely on it for security.
    user_metadata: { kind: 'patient', must_change_password: true },
  });
  if (makeErr || !made?.user) {
    if (ALREADY.test(makeErr?.message ?? '')) {
      // Two people pressed Create for this patient at the same moment (the other one made the login), or the username belongs to a login of someone else.
      const now = await findPatient(admin, patient.id);
      return refuse(now?.portal_user_id ? JUST_GIVEN : 'That username is already used by another login.');
    }
    return refuse(makeErr?.message || 'The login could not be made.');
  }
  const userId = made.user.id;

  // Only link a patient who still has no login: a login linked in the meantime is never replaced.
  const { data: linked, error: linkErr } = await admin.from('patients').update({ portal_user_id: userId }).eq('id', patient.id).is('portal_user_id', null).select('id').maybeSingle();
  if (linkErr || !linked) {
    // Undo only the login made just now, so the patient is never left with a login nobody knows about.
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    if (linkErr) return refuse(linkErr.message);
    const now = await findPatient(admin, patient.id);
    return refuse(now?.portal_user_id ? JUST_GIVEN : 'The login could not be linked to the patient. Nothing was saved.');
  }
  await admin.from('audit_log').insert({ table_name: 'patients', row_id: patient.id, action: 'PORTAL_LOGIN_CREATED', actor: caller, new_data: { username: email } });
  return ok({ username: email });
}

export async function resetPatientPassword({ admin, can, caller, domain }: ActionDeps, body: Record<string, unknown>): Promise<ActionResult> {
  if (!(await can('portal.invite'))) return refuse('You are not allowed to reset patient passwords.', 403);
  const password = body.password == null ? '' : String(body.password);
  const passwordProblem = checkSlipPassword(password);
  if (passwordProblem) return refuse(passwordProblem);

  const patient = await findPatient(admin, body.patient_id);
  if (!patient) return refuse('Patient not found.');
  if (!patient.portal_user_id) return refuse('This patient has no portal login yet. Create one first.');

  const { data: found, error: userErr } = await admin.auth.admin.getUserById(patient.portal_user_id);
  const user = found?.user;
  if (userErr || !user) return refuse('The patient\'s login could not be found.');
  if (!(await isClinicPatientLogin(admin, user, domain))) {
    return refuse('This patient logs in with their own email address. They can set a new password with "Forgot password" on the login page.');
  }

  // GoTrue's admin password update deletes every session of this login (UpdatePassword(tx, nil) -> Logout), so all refresh tokens die
  // now; an access token already issued keeps working until it expires (at most an hour). The reset dialog and docs/GO-LIVE.md say so.
  const { error } = await admin.auth.admin.updateUserById(user.id, {
    password,
    user_metadata: { ...(user.user_metadata ?? {}), must_change_password: true }, // a prompt, see createPatientLogin
  });
  if (error) return refuse(error.message);
  await admin.from('audit_log').insert({ table_name: 'patients', row_id: patient.id, action: 'PORTAL_PASSWORD_RESET', actor: caller, new_data: { username: user.email } });
  return ok({ username: user.email });
}

export async function portalLoginInfo({ admin, can, domain }: ActionDeps, body: Record<string, unknown>): Promise<ActionResult> {
  if (!(await can('portal.invite'))) return refuse('You are not allowed to see patient logins.', 403);
  const patient = await findPatient(admin, body.patient_id);
  if (!patient) return refuse('Patient not found.');
  if (!patient.portal_user_id) return ok({ has_login: false, clinic_login: false, username: null });
  const { data: found, error } = await admin.auth.admin.getUserById(patient.portal_user_id);
  if (error || !found?.user) return refuse('The patient\'s login could not be found.');
  const clinic = await isClinicPatientLogin(admin, found.user, domain);
  return ok({ has_login: true, clinic_login: clinic, username: clinic ? found.user.email : null });
}

/**
 * Emails the patient an invitation to set their own password. Only for a real email address: an address at the clinic's own domain
 * would plant a login that a staff account could later be attached to (create_staff), and clinic usernames have Create portal login.
 */
export async function invitePatient({ admin, can, caller, domain, siteUrl }: ActionDeps, body: Record<string, unknown>): Promise<ActionResult> {
  if (!(await can('portal.invite'))) return refuse('You are not allowed to invite patients.', 403);
  const patient = await findPatient(admin, body.patient_id);
  if (!patient) return refuse('Patient not found.');
  if (patient.portal_user_id) return refuse('This patient already has a portal login.');
  if (!patient.email) return refuse('Add the patient\'s email first.');
  const email = String(patient.email).trim().toLowerCase();
  if (email.endsWith('@' + String(domain).trim().toLowerCase())) return refuse('Use Create portal login for clinic usernames.');
  const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: siteUrl ? `${siteUrl}/reset-password.html` : undefined,
    data: { full_name: patient.full_name, kind: 'patient' },
  });
  if (inviteErr) return refuse(inviteErr.message);
  await admin.from('patients').update({ portal_user_id: invited.user.id }).eq('id', patient.id);
  await admin.from('audit_log').insert({ table_name: 'patients', row_id: patient.id, action: 'PORTAL_INVITE', actor: caller });
  return ok({});
}
