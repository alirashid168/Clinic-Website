// The patient portal login actions of the admin-users Edge Function, kept apart from index.ts so a test can run them
// in Node with a stand-in for the admin client (tests/patient-login-actions.test.ts). Nothing here touches Deno or the network:
// everything comes in through `deps`.
//
//   create_patient_login   { patient_id, password }  staff make the patient's login at the clinic         (needs portal.invite)
//   reset_patient_password { patient_id, password }  staff set a new password for a login made this way    (needs portal.invite)
//   portal_login_info      { patient_id }            does the patient have a login, and is it a clinic one (needs portal.invite)
//
// The password is only ever passed to the login server. It is never logged, audited or sent back.
import { checkPortalPassword, portalLoginEmail } from './portal-login.ts';

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
}

// Like the rest of the function: a refused permission is 403, a plain "no" the person can fix is 200 with { error }
// (supabase-js hides the body of a non-2xx answer behind a generic message).
const refuse = (error: string, status = 200): ActionResult => ({ status, body: { error } });
const ok = (body: Record<string, unknown>): ActionResult => ({ status: 200, body: { ok: true, ...body } });

const ALREADY = /already|registered|exists|duplicate/i;

async function findPatient(admin: any, id: unknown) {
  const patientId = String(id ?? '');
  if (!patientId) return null;
  const { data } = await admin.from('patients').select('id, full_name, mr_number, portal_user_id').eq('id', patientId).maybeSingle();
  return data ?? null;
}

/** A login that create_patient_login makes: the clinic's domain and metadata kind 'patient'. Real-email invitations never match. */
export function isClinicPatientLogin(user: any, domain: string): boolean {
  const email = String(user?.email ?? '').toLowerCase();
  return user?.user_metadata?.kind === 'patient' && email.endsWith('@' + String(domain).toLowerCase());
}

export async function createPatientLogin({ admin, can, caller, domain }: ActionDeps, body: Record<string, unknown>): Promise<ActionResult> {
  if (!(await can('portal.invite'))) return refuse('You are not allowed to create patient logins.', 403);
  const password = body.password == null ? '' : String(body.password);
  const passwordProblem = checkPortalPassword(password);
  if (passwordProblem) return refuse(passwordProblem);

  const patient = await findPatient(admin, body.patient_id);
  if (!patient) return refuse('Patient not found.');
  if (patient.portal_user_id) return refuse('This patient already has a portal login.');

  const email = portalLoginEmail(patient.full_name, patient.mr_number, domain);
  if (!email) return refuse('This patient has no usable Mr#, so a username cannot be made.');
  // A staff login can never look like a patient username (create_staff refuses that shape), but never reuse one if it somehow does.
  const { data: staffRow } = await admin.from('staff').select('id').eq('email', email).maybeSingle();
  if (staffRow) return refuse('That username is already used by another login.');

  const { data: made, error: makeErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, // no email is ever sent
    user_metadata: { kind: 'patient', must_change_password: true },
  });
  if (makeErr || !made?.user) {
    return refuse(ALREADY.test(makeErr?.message ?? '') ? 'That username is already used by another login.' : (makeErr?.message || 'The login could not be made.'));
  }
  const userId = made.user.id;

  const { data: linked, error: linkErr } = await admin.from('patients').update({ portal_user_id: userId }).eq('id', patient.id).select('id').maybeSingle();
  if (linkErr || !linked) {
    // Undo only the login made just now, so the patient is never left with a login nobody knows about.
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    return refuse(linkErr?.message || 'The login could not be linked to the patient. Nothing was saved.');
  }
  await admin.from('audit_log').insert({ table_name: 'patients', row_id: patient.id, action: 'PORTAL_LOGIN_CREATED', actor: caller, new_data: { username: email } });
  return ok({ username: email });
}

export async function resetPatientPassword({ admin, can, caller, domain }: ActionDeps, body: Record<string, unknown>): Promise<ActionResult> {
  if (!(await can('portal.invite'))) return refuse('You are not allowed to reset patient passwords.', 403);
  const password = body.password == null ? '' : String(body.password);
  const passwordProblem = checkPortalPassword(password);
  if (passwordProblem) return refuse(passwordProblem);

  const patient = await findPatient(admin, body.patient_id);
  if (!patient) return refuse('Patient not found.');
  if (!patient.portal_user_id) return refuse('This patient has no portal login yet. Create one first.');

  const { data: found, error: userErr } = await admin.auth.admin.getUserById(patient.portal_user_id);
  const user = found?.user;
  if (userErr || !user) return refuse('The patient\'s login could not be found.');
  if (!isClinicPatientLogin(user, domain)) {
    return refuse('This patient logs in with their own email address. They can set a new password with "Forgot password" on the login page.');
  }

  const { error } = await admin.auth.admin.updateUserById(user.id, {
    password,
    user_metadata: { ...(user.user_metadata ?? {}), must_change_password: true },
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
  const clinic = isClinicPatientLogin(found.user, domain);
  return ok({ has_login: true, clinic_login: clinic, username: clinic ? found.user.email : null });
}
