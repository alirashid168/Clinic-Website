// The patient portal login actions of the admin-users Edge Function, kept apart from index.ts so a test can run them
// in Node with a stand-in for the admin client (tests/patient-login-actions.test.ts). Nothing here touches Deno or the network:
// everything comes in through `deps`.
//
//   create_patient_login   { patient_id, password? }  staff make the patient's login at the clinic: the login name is the Mr#
//                          (mr-50013@<domain>) and the password the patient's mobile number on file, or the one typed (needs portal.invite)
//   reset_patient_password { patient_id, password? }  staff set the password back to the phone on file, or to the one typed (needs portal.invite)
//   portal_login_info      { patient_id }             does the patient have a login, and is it a clinic one             (needs portal.invite)
//   invite_patient         { patient_id }             emails the patient an invitation (real addresses only)             (needs portal.invite)
//   self_register          { full_name, mr, phone, password }  a visitor makes their own login (NO login needed): only when the Mr# and the
//                          mobile number match a patient's file and the name fits; marked pending until staff approve. The answer is the
//                          same sentence whether or not anything matched. Capped per mobile number, per address and per day.
//   reject_registration    { patient_id, reason? }   staff reject a pending registration: the database unlinks it, this removes the login (needs portal.invite)
//
// The owner (17 Oct 2026): "the patient user creation should be simple, and we keep the password, the patient can change it
// themselves later". So: the password is the phone number as on file (digits only), the patient is NOT made to change it at the
// first login (no must_change_password), and "Change password" in the portal menu is there for later.
// The password is only ever passed to the login server. It is never logged, audited or sent back; the audit log only says whether
// it was the phone number or one that was typed.
import { checkPhonePassword, checkPortalPassword, isPatientLoginName, mrLoginEmail, NO_USERNAME_MESSAGE, phonePassword } from './portal-login.ts';

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
  const { data } = await admin.from('patients').select('id, full_name, mr_number, email, phone, portal_user_id').eq('id', patientId).maybeSingle();
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

/**
 * The password for a login made or reset now: the one staff typed (8 to 72 characters, nothing else is asked of it: the patient's own
 * phone number is the normal password, so a rule against digits would make no sense), else the patient's mobile number on file, digits
 * only. { password, kind } for the login server and the audit log, or { error } when the phone cannot be used and nothing was typed.
 */
function chosenPassword(patient: any, body: Record<string, unknown>): { password: string; kind: 'phone' | 'typed' } | { error: string } {
  const typed = body.password == null ? '' : String(body.password);
  if (typed) {
    const problem = checkPortalPassword(typed);
    return problem ? { error: problem } : { password: typed, kind: 'typed' };
  }
  const problem = checkPhonePassword(patient.phone);
  return problem ? { error: problem } : { password: phonePassword(patient.phone), kind: 'phone' };
}

/** The problem with a typed password, checked before anything is looked up (a problem the person can fix is a plain answer), or null. */
const typedPasswordProblem = (body: Record<string, unknown>) => (body.password == null || !String(body.password) ? null : checkPortalPassword(String(body.password)));

export async function createPatientLogin({ admin, can, caller, domain }: ActionDeps, body: Record<string, unknown>): Promise<ActionResult> {
  if (!(await can('portal.invite'))) return refuse('You are not allowed to create patient logins.', 403);
  const typedProblem = typedPasswordProblem(body);
  if (typedProblem) return refuse(typedProblem);

  const patient = await findPatient(admin, body.patient_id);
  if (!patient) return refuse('Patient not found.');
  if (patient.portal_user_id) return refuse('This patient already has a portal login.');
  const chosen = chosenPassword(patient, body);
  if ('error' in chosen) return refuse(chosen.error);
  const { password, kind } = chosen;

  // The login name is the Mr# ("mr-50013@<domain>"): the login page makes the address from a typed Mr# by itself. Every clinic username
  // has the reserved patient shape (that is how create_staff keeps staff addresses apart from it).
  const email = mrLoginEmail(patient.mr_number, domain);
  if (!email || !isPatientLoginName(email, domain)) return refuse(NO_USERNAME_MESSAGE);
  // A staff login can never look like a patient username (create_staff refuses that shape), but never reuse one if it somehow does.
  const { data: staffRow } = await admin.from('staff').select('id').eq('email', email).maybeSingle();
  if (staffRow) return refuse('That username is already used by another login.');

  const { data: made, error: makeErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, // no email is ever sent
    // app_metadata can only be written here (a user cannot edit it): it is what marks this as a login made at the clinic.
    app_metadata: { kind: 'patient', clinic_login: true },
    // No forced change: the owner chose none (17 Oct 2026), so the flag is off from the start. The portal still honours it on a login
    // made before that day; must_change_password is a PROMPT in user_metadata (the patient's own to edit), never a lock.
    user_metadata: { kind: 'patient', must_change_password: false },
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
  await admin.from('audit_log').insert({ table_name: 'patients', row_id: patient.id, action: 'PORTAL_LOGIN_CREATED', actor: caller, new_data: { username: email, password_kind: kind } });
  return ok({ username: email, password_kind: kind });
}

export async function resetPatientPassword({ admin, can, caller, domain }: ActionDeps, body: Record<string, unknown>): Promise<ActionResult> {
  if (!(await can('portal.invite'))) return refuse('You are not allowed to reset patient passwords.', 403);
  const typedProblem = typedPasswordProblem(body);
  if (typedProblem) return refuse(typedProblem);

  const patient = await findPatient(admin, body.patient_id);
  if (!patient) return refuse('Patient not found.');
  if (!patient.portal_user_id) return refuse('This patient has no portal login yet. Create one first.');
  const chosen = chosenPassword(patient, body);
  if ('error' in chosen) return refuse(chosen.error);
  const { password, kind } = chosen;

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
    user_metadata: { ...(user.user_metadata ?? {}), must_change_password: false }, // no forced change (this also clears the prompt of an older login), see createPatientLogin
  });
  if (error) return refuse(error.message);
  await admin.from('audit_log').insert({ table_name: 'patients', row_id: patient.id, action: 'PORTAL_PASSWORD_RESET', actor: caller, new_data: { username: user.email, password_kind: kind } });
  return ok({ username: user.email, password_kind: kind });
}

export async function portalLoginInfo({ admin, can, domain }: ActionDeps, body: Record<string, unknown>): Promise<ActionResult> {
  if (!(await can('portal.invite'))) return refuse('You are not allowed to see patient logins.', 403);
  const patient = await findPatient(admin, body.patient_id);
  if (!patient) return refuse('Patient not found.');
  if (!patient.portal_user_id) return ok({ has_login: false, clinic_login: false, username: null, pending: false });
  const { data: found, error } = await admin.auth.admin.getUserById(patient.portal_user_id);
  if (error || !found?.user) return refuse('The patient\'s login could not be found.');
  const clinic = await isClinicPatientLogin(admin, found.user, domain);
  // Registered on the website and waiting for approval (patient_registrations, 20261017000300); a database without the table says no.
  const { data: waiting } = await admin.from('patient_registrations').select('id').eq('patient_id', patient.id).eq('status', 'pending').maybeSingle();
  return ok({ has_login: true, clinic_login: clinic, username: clinic ? found.user.email : null, pending: !!waiting });
}

// ---------------------------------------------------------------- patients who register themselves

/** What every visitor is told, matched or not (the website shows it as it is). */
export const REGISTERED_MESSAGE = 'Thank you. Your request has been sent to the clinic. Once the clinic approves it, log in here with your Mr# and the password you chose.';
/** The caps: tries per mobile number per day, per address per hour, and in all per day. Beyond them the answer is the same sentence and nothing is made. */
export const REGISTER_CAPS = { perPhoneDay: 3, perIpHour: 10, perDay: 200 };

/** A Pakistani mobile number as digits, "03001234567" whatever way it was written (+92 300 ..., 92300..., 0300-...). '' when there is nothing. */
export function normalizePhone(text: unknown): string {
  let d = String(text ?? '').replace(/[^0-9]/g, '');
  if (d.startsWith('0092')) d = '0' + d.slice(4);
  else if (d.startsWith('92') && d.length === 12) d = '0' + d.slice(2);
  else if (/^3[0-9]{9}$/.test(d)) d = '0' + d;
  return d;
}

const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'md', 'mohd']);
const nameWords = (text: unknown) => String(text ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !TITLES.has(w));

/**
 * Does the name the visitor typed fit the name on file? The same first name (after titles), or every typed word in the file's name,
 * or the two names the same once spaces and symbols are ignored. With the Mr# AND the mobile number already matching, this only keeps
 * a stranger who knows a family's number from registering as another member by typing a different name.
 */
export function nameFits(typed: unknown, onFile: unknown): boolean {
  const a = nameWords(typed); const b = nameWords(onFile);
  if (!a.length || !b.length) return false;
  if (a.join('') === b.join('')) return true;
  if (a[0] === b[0]) return true;
  return a.every((w) => b.includes(w));
}

/** The first 16 hex characters of SHA-256 of the phone digits: the audit log counts tries per number without keeping the number. */
async function phoneHash(digits: string): Promise<string> {
  const bytes = new TextEncoder().encode(digits);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/** How many SELF_REGISTER rows since `since` carry this value in new_data (null when the log cannot be read: the caller then fails closed). */
async function countTries(admin: any, since: Date, key: string | null, value: string | null): Promise<number | null> {
  let q = admin.from('audit_log').select('id', { count: 'exact', head: true }).eq('action', 'SELF_REGISTER').gte('at', since.toISOString());
  if (key) q = q.eq(`new_data->>${key}`, value);
  const { count, error } = await q;
  return error ? null : Number(count ?? 0);
}

export interface RegisterContext { ip: string }

/**
 * A visitor registers. Bad input is said plainly (the form checks the same things first). Everything else answers REGISTERED_MESSAGE:
 * matched and made, no such patient, a wrong number or name, a patient who already has a login, or a cap reached. Every call is one
 * SELF_REGISTER row in the audit log (outcome, the typed Mr#, the address, a hash of the number; never the number or the password), which
 * is also what the caps count, so a flood of guesses is visible to Dr. Ali. A matched patient gets a login (login name mr-<Mr#>, the
 * password they chose, marked self_registered in app_metadata), linked only if they still have none, and a pending registration row;
 * the database shows this login nothing until staff approve (current_patient_id()).
 */
export async function selfRegister({ admin, domain }: Pick<ActionDeps, 'admin' | 'domain'>, body: Record<string, unknown>, { ip }: RegisterContext): Promise<ActionResult> {
  const fullName = String(body.full_name ?? '').trim();
  const mr = String(body.mr ?? '').trim().replace(/^mr\s*#?\s*/i, '');
  const digits = normalizePhone(body.phone);
  const password = body.password == null ? '' : String(body.password);
  if (fullName.length < 2) return refuse('Write your name as the clinic has it.');
  if (!mr || mr.length > 24) return refuse('Type your Mr# (patient number).');
  if (digits.length < 8 || digits.length > 20) return refuse('Type your mobile number, for example 0300 5551234.');
  const passwordProblem = checkPortalPassword(password);
  if (passwordProblem) return refuse(passwordProblem);

  const who = await phoneHash(digits);
  const note = async (outcome: string, extra: Record<string, unknown> = {}) => {
    await admin.from('audit_log').insert({ table_name: 'patients', row_id: null, action: 'SELF_REGISTER', actor: null, new_data: { outcome, mr: mr.slice(0, 20), ip: String(ip ?? '').slice(0, 64), who, ...extra } });
    return ok({ message: REGISTERED_MESSAGE });
  };
  const now = Date.now();
  const [byPhone, byIp, today] = await Promise.all([
    countTries(admin, new Date(now - 24 * 3600 * 1000), 'who', who),
    countTries(admin, new Date(now - 3600 * 1000), 'ip', String(ip ?? '').slice(0, 64)),
    countTries(admin, new Date(now - 24 * 3600 * 1000), null, null),
  ]);
  if (byPhone === null || byIp === null || today === null) return note('capped', { reason: 'log unreadable' });
  if (byPhone >= REGISTER_CAPS.perPhoneDay || byIp >= REGISTER_CAPS.perIpHour || today >= REGISTER_CAPS.perDay) return note('capped');

  const { data: patient } = await admin.from('patients').select('id, full_name, mr_number, phone, portal_user_id').eq('mr_number', mr).maybeSingle();
  if (!patient || normalizePhone(patient.phone) !== digits || !nameFits(fullName, patient.full_name)) return note('no_match');
  if (patient.portal_user_id) return note('has_login');
  const email = mrLoginEmail(patient.mr_number, domain);
  if (!email || !isPatientLoginName(email, domain)) return note('no_username');

  const { data: made, error: makeErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    app_metadata: { kind: 'patient', clinic_login: true, self_registered: true },
    user_metadata: { kind: 'patient', must_change_password: false },
  });
  if (makeErr || !made?.user) return note(ALREADY.test(makeErr?.message ?? '') ? 'has_login' : 'failed', { error: String(makeErr?.message ?? '').slice(0, 120) });
  const userId = made.user.id;
  const { data: linked, error: linkErr } = await admin.from('patients').update({ portal_user_id: userId }).eq('id', patient.id).is('portal_user_id', null).select('id').maybeSingle();
  if (linkErr || !linked) {
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    return note(linkErr ? 'failed' : 'has_login', linkErr ? { error: String(linkErr.message).slice(0, 120) } : {});
  }
  const { error: regErr } = await admin.from('patient_registrations').insert({ patient_id: patient.id, user_id: userId, typed_name: fullName.slice(0, 120), typed_phone: digits, status: 'pending' });
  if (regErr) {
    // Without the pending row the login would open the whole record at once: undo both.
    await admin.from('patients').update({ portal_user_id: null }).eq('id', patient.id).eq('portal_user_id', userId);
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    return note('failed', { error: String(regErr.message).slice(0, 120) });
  }
  return note('registered', { username: email, patient_id: patient.id });
}

/**
 * Staff reject a pending registration: the database function (as the caller, so has_perm decides and the decision is audited) marks it
 * rejected and answers the login's id (from that moment the login is nobody); then, with the service role, the patient is unlinked (the
 * link may only be changed by the service role or Dr. Ali) and the login removed, but only one that self_register made
 * (app_metadata.self_registered, kind patient, not in the staff table). Nothing else is ever deleted.
 */
export async function rejectRegistration({ admin, asCaller, can }: Pick<ActionDeps, 'admin' | 'can'> & { asCaller: any }, body: Record<string, unknown>): Promise<ActionResult> {
  if (!(await can('portal.invite'))) return refuse('You are not allowed to decide registrations.', 403);
  const patientId = String(body.patient_id ?? '');
  if (!patientId) return refuse('Patient not found.');
  const { data: userId, error } = await asCaller.rpc('reject_registration', { p_patient: patientId, p_reason: body.reason == null ? null : String(body.reason).slice(0, 300) });
  if (error) return refuse(error.message);
  let removed = false;
  if (userId) {
    await admin.from('patients').update({ portal_user_id: null }).eq('id', patientId).eq('portal_user_id', String(userId));
    const { data: found } = await admin.auth.admin.getUserById(String(userId));
    const user = found?.user;
    const { data: staffRow } = user ? await admin.from('staff').select('id').eq('id', user.id).maybeSingle() : { data: null };
    if (user && user.app_metadata?.kind === 'patient' && user.app_metadata?.self_registered === true && !staffRow) {
      const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
      removed = !delErr;
    }
  }
  return ok({ removed });
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
  // Inviting an address that already has a login (another patient's invitation nobody has confirmed yet, say) hands back THAT login.
  let existing: any;
  try { existing = await findLoginByEmail(admin, email); } catch (e) { return refuse((e as Error).message || 'The existing logins could not be checked.'); }
  if (existing) return refuse('That email address already has a login. Nothing was sent.');
  const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: siteUrl ? `${siteUrl}/reset-password.html` : undefined,
    data: { full_name: patient.full_name, kind: 'patient' },
  });
  if (inviteErr || !invited?.user) return refuse(inviteErr?.message || 'The invitation could not be sent.');
  // Only link a patient who still has no login, and say so when the link did not happen (the invited login is left alone: it may not be ours).
  const { data: linked, error: linkErr } = await admin.from('patients').update({ portal_user_id: invited.user.id }).eq('id', patient.id).is('portal_user_id', null).select('id').maybeSingle();
  if (linkErr || !linked) return refuse('The invitation could not be linked to this patient. Reload the page to see whether they have a login now, or ask Dr. Ali.');
  // The address is audited: front desk can edit a patient's email, so the log must say where the invitation went.
  await admin.from('audit_log').insert({ table_name: 'patients', row_id: patient.id, action: 'PORTAL_INVITE', actor: caller, new_data: { email } });
  return ok({});
}
