// Supabase Edge Function: creates and switches off logins. Creating a login
// needs the server-side service key, which must never be in the website, so
// the website calls this function and the function checks who is asking.
//
// Actions:
//   create_staff   { full_name, email, role, branch_ids, restrict_to_branches, home_branch_id, clinician_id, password? }  (needs users.manage)
//                  With a password the login works straight away and no email is sent (the address
//                  is only a login name). Without one, an invitation email is sent.
//   update_login   { user_id, email?, password? }  changes a staff login email and/or password                  (needs users.manage)
//   ban_user       { user_id }                                                                                  (needs users.manage)
//   unban_user     { user_id }                                                                                  (needs users.manage)
//   invite_patient { patient_id }  sends the patient an email to set a password for the portal              (needs portal.invite)
//
// Deploy: supabase functions deploy admin-users
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const STAFF_DOMAIN = Deno.env.get('STAFF_EMAIL_DOMAIN') ?? 'dralirashid.com';
// Where invitation links land. Change when the clinic moves to its own domain
// (or set the SITE_URL secret, which takes priority).
const SITE_URL = (Deno.env.get('SITE_URL') ?? 'https://www.dralirashid.com').replace(/\/$/, '');
const ROLES = ['front_desk', 'assistant', 'doctor', 'coordinator', 'accountant'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const authHeader = req.headers.get('Authorization') ?? '';

  // Client acting as the caller: permission checks run through the database's own has_perm().
  const asCaller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: userData } = await asCaller.auth.getUser();
  if (!userData?.user) return json({ error: 'Please log in again.' }, 401);
  const caller = userData.user.id;

  const can = async (key: string) => {
    const { data, error } = await asCaller.rpc('has_perm', { p_key: key });
    return !error && data === true;
  };

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const action = String(body.action ?? '');

  try {
    if (action === 'create_staff') {
      if (!(await can('users.manage'))) return json({ error: 'Only Dr. Ali can create staff accounts.' }, 403);
      const email = String(body.email ?? '').trim().toLowerCase();
      const fullName = String(body.full_name ?? '').trim();
      const role = String(body.role ?? '');
      if (!email.endsWith('@' + STAFF_DOMAIN)) return json({ error: `Staff emails must end with @${STAFF_DOMAIN}` });
      if (fullName.length < 2) return json({ error: 'Write the staff member\'s name.' });
      if (!ROLES.includes(role)) return json({ error: 'Choose a role.' });

      const password = body.password == null ? '' : String(body.password);
      if (password && password.length < 8) return json({ error: 'The password needs at least 8 characters.' });

      const { data: made, error: makeErr } = password
        ? await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } })
        : await admin.auth.admin.inviteUserByEmail(email, {
          redirectTo: SITE_URL ? `${SITE_URL}/reset-password.html` : undefined,
          data: { full_name: fullName },
        });
      if (makeErr) return json({ error: /already|registered|exists/i.test(makeErr.message) ? 'That login email is already used. Pick another.' : makeErr.message });
      const id = made.user.id;
      const branchIds = Array.isArray(body.branch_ids) ? body.branch_ids.map(Number) : [];
      const { data: staff, error: staffErr } = await admin.from('staff').insert({
        id, full_name: fullName, email, role,
        branch_ids: branchIds, restrict_to_branches: Boolean(body.restrict_to_branches) && branchIds.length > 0,
        home_branch_id: body.home_branch_id ? Number(body.home_branch_id) : (branchIds[0] ?? null),
      }).select().single();
      if (staffErr) {
        await admin.auth.admin.deleteUser(id);
        return json({ error: staffErr.message });
      }
      if (body.clinician_id) await admin.from('clinicians').update({ staff_id: id }).eq('id', String(body.clinician_id));
      await admin.from('audit_log').insert({ table_name: 'staff', row_id: id, action: 'CREATE_LOGIN', new_data: staff, actor: caller });
      return json({ staff });
    }

    if (action === 'ban_user' || action === 'unban_user') {
      if (!(await can('users.manage'))) return json({ error: 'Only Dr. Ali can switch accounts on or off.' }, 403);
      const userId = String(body.user_id ?? '');
      if (userId === caller) return json({ error: 'You cannot switch off your own account.' });
      const { data: target } = await admin.from('staff').select('role').eq('id', userId).maybeSingle();
      const callerIsAdmin = (await asCaller.rpc('is_admin')).data === true;
      if (target?.role === 'admin' && !callerIsAdmin) return json({ error: 'Only Dr. Ali can switch an admin account on or off.' }, 403);
      await admin.from('staff').update(action === 'ban_user'
        ? { active: false, deactivated_at: new Date().toISOString(), deactivated_by: caller }
        : { active: true, deactivated_at: null }).eq('id', userId);
      const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: action === 'ban_user' ? '876000h' : 'none' });
      if (error) return json({ error: error.message });
      if (action === 'ban_user') await admin.auth.admin.signOut(userId).catch(() => {});
      return json({ ok: true });
    }

    if (action === 'update_login') {
      if (!(await can('users.manage'))) return json({ error: 'Only Dr. Ali can change staff logins.' }, 403);
      const userId = String(body.user_id ?? '');
      const { data: target } = await admin.from('staff').select('role, email').eq('id', userId).maybeSingle();
      if (!target) return json({ error: 'Staff account not found.' });
      const callerIsAdmin = (await asCaller.rpc('is_admin')).data === true;
      if (target.role === 'admin' && !callerIsAdmin) return json({ error: 'Only Dr. Ali can change an admin login.' }, 403);

      const changes: { email?: string; email_confirm?: boolean; password?: string } = {};
      const email = body.email == null ? '' : String(body.email).trim().toLowerCase();
      if (email && email !== target.email) {
        if (!/^[^@\s]+@[^@\s]+$/.test(email) || !email.endsWith('@' + STAFF_DOMAIN)) return json({ error: `Staff emails must end with @${STAFF_DOMAIN}` });
        const { data: taken } = await admin.from('staff').select('id').eq('email', email).neq('id', userId).maybeSingle();
        if (taken) return json({ error: 'That login email is already used. Pick another.' });
        changes.email = email; changes.email_confirm = true;
      }
      const password = body.password == null ? '' : String(body.password);
      if (password) {
        if (password.length < 8) return json({ error: 'The password needs at least 8 characters.' });
        changes.password = password;
      }
      if (!changes.email && !changes.password) return json({ ok: true, changed: [] });

      const { error } = await admin.auth.admin.updateUserById(userId, changes);
      if (error) return json({ error: /already|registered|exists/i.test(error.message) ? 'That login email is already used. Pick another.' : error.message });
      if (changes.email) {
        const { error: staffErr } = await admin.from('staff').update({ email: changes.email }).eq('id', userId);
        if (staffErr) {
          await admin.auth.admin.updateUserById(userId, { email: target.email, email_confirm: true });
          return json({ error: staffErr.message });
        }
      }
      await admin.from('audit_log').insert({ table_name: 'staff', row_id: userId, action: 'UPDATE_LOGIN', actor: caller,
        old_data: changes.email ? { email: target.email } : null,
        new_data: { email: changes.email ?? target.email, password_changed: Boolean(changes.password) } });
      return json({ ok: true, changed: [changes.email ? 'email' : null, changes.password ? 'password' : null].filter(Boolean) });
    }

    if (action === 'invite_patient') {
      if (!(await can('portal.invite'))) return json({ error: 'You are not allowed to invite patients.' }, 403);
      const { data: patient, error } = await admin.from('patients').select('id, email, full_name, portal_user_id').eq('id', String(body.patient_id ?? '')).single();
      if (error || !patient) return json({ error: 'Patient not found.' });
      if (patient.portal_user_id) return json({ error: 'This patient already has a portal login.' });
      if (!patient.email) return json({ error: 'Add the patient\'s email first.' });
      const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(patient.email.toLowerCase(), {
        redirectTo: SITE_URL ? `${SITE_URL}/reset-password.html` : undefined,
        data: { full_name: patient.full_name, kind: 'patient' },
      });
      if (inviteErr) return json({ error: inviteErr.message });
      await admin.from('patients').update({ portal_user_id: invited.user.id }).eq('id', patient.id);
      await admin.from('audit_log').insert({ table_name: 'patients', row_id: patient.id, action: 'PORTAL_INVITE', actor: caller });
      return json({ ok: true });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
