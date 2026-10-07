// LIVE data layer: talks to the clinic's Supabase database. Every request runs
// as the logged-in person, so the database's row-level security decides what
// they can see and change. Same methods (and same return shapes) as demo.js.

import { CONFIG } from '../config.js';
import { todayISO } from '../ui/dom.js';
import { PERMISSIONS } from '../lib/permissions.js';

const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

function check({ data, error }) {
  if (error) throw new Error(error.message || String(error));
  return data;
}

const STOP_WORDS = ['PHOTO MONTH', 'Overrun', 'Dues checkpoint', 'past Month 7'];
const alertLevel = (text) => (STOP_WORDS.some((w) => text.includes(w)) ? 'stop' : text.startsWith('Remind') || text.startsWith('Target') ? 'info' : 'warning');

export async function createSupabaseAdapter() {
  const { createClient } = await import(SUPABASE_JS);
  const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });

  let cachedSession = null;

  async function userId() {
    const { data } = await sb.auth.getUser();
    return data?.user?.id || null;
  }

  async function duesFor(ids) {
    if (!ids.length) return {};
    const rows = check(await sb.rpc('dues_for', { p_patients: ids }));
    return Object.fromEntries(rows.map((r) => [r.patient_id, Number(r.dues)]));
  }
  async function flagsFor(ids) {
    if (!ids.length) return {};
    const rows = check(await sb.from('patient_flags').select('*').in('patient_id', ids).is('cleared_at', null));
    return Object.fromEntries(rows.map((r) => [r.patient_id, r]));
  }

  const VISIT_SELECT = '*, patient:patients(id,mr_number,full_name,phone,medical_history), visit_staff(clinician_id, role, clinician:clinicians(display_name))';
  async function enrichVisits(rows) {
    const ids = [...new Set(rows.map((r) => r.patient_id))];
    const [dues, flags] = await Promise.all([duesFor(ids), flagsFor(ids)]);
    return rows.map((v) => ({
      ...v,
      staff: (v.visit_staff || []).map((s) => ({ clinician_id: s.clinician_id, role: s.role, name: s.clinician?.display_name })),
      dues: dues[v.patient_id] ?? 0,
      see_dr_ali: !!flags[v.patient_id],
    }));
  }
  async function visitById(id) {
    const row = check(await sb.from('visits').select(VISIT_SELECT).eq('id', id).single());
    return (await enrichVisits([row]))[0];
  }
  async function staffNames() {
    const rows = check(await sb.from('staff').select('id,full_name'));
    return Object.fromEntries(rows.map((r) => [r.id, r.full_name]));
  }
  async function attachPatients(rows, key = 'patient_id') {
    const ids = [...new Set(rows.map((r) => r[key]).filter(Boolean))];
    if (!ids.length) return rows;
    const pats = check(await sb.from('patients').select('id,mr_number,full_name,phone,email').in('id', ids));
    const byId = Object.fromEntries(pats.map((p) => [p.id, p]));
    return rows.map((r) => ({ ...r, patient: byId[r[key]] || null }));
  }

  return {
    mode: 'live',

    // ------------------------------------------------------------ auth
    async demoAccounts() { return []; },
    async signInDemo() { throw new Error('Demo accounts are not available on the live system.'); },
    async signIn(email, password) {
      check(await sb.auth.signInWithPassword({ email: email.trim().toLowerCase(), password }));
      cachedSession = null;
      const session = await this.getSession();
      // Login log (security plan): the account records its own sign-in; Dr. Ali reads the log.
      try { if (session) await sb.from('login_events').insert({ user_id: await userId(), kind: session.kind, user_agent: navigator.userAgent.slice(0, 300) }); } catch { /* the log never blocks a login */ }
      return session;
    },
    async sendPasswordReset(email) {
      check(await sb.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo: location.origin + '/reset-password.html' }));
    },
    async updatePassword(password) { check(await sb.auth.updateUser({ password })); },
    async signOut() { cachedSession = null; await sb.auth.signOut(); },
    async getSession() {
      const uid = await userId();
      if (!uid) return null;
      if (cachedSession?.uid === uid) return cachedSession.value;
      const staff = check(await sb.from('staff').select('*').eq('id', uid).maybeSingle());
      let value = null;
      if (staff) {
        if (!staff.active) { await sb.auth.signOut(); throw new Error('This account is switched off. Contact Dr. Ali.'); }
        let perms;
        if (staff.role === 'admin') perms = new Set(PERMISSIONS.map((p) => p.key));
        else {
          const [grid, overrides] = await Promise.all([
            sb.from('role_permissions').select('permission_key,allowed').eq('role', staff.role).then(check),
            sb.from('staff_permission_overrides').select('permission_key,allowed').eq('staff_id', uid).then(check),
          ]);
          const map = Object.fromEntries(grid.map((g) => [g.permission_key, g.allowed]));
          for (const o of overrides) map[o.permission_key] = o.allowed;
          perms = new Set(Object.keys(map).filter((k) => map[k]));
        }
        value = { kind: 'staff', staff, perms };
      } else {
        const patient = check(await sb.from('patients').select('*').eq('portal_user_id', uid).maybeSingle());
        if (patient) value = { kind: 'patient', patient, perms: new Set() };
      }
      cachedSession = { uid, value };
      return value;
    },
    onAuthChange(fn) { sb.auth.onAuthStateChange(() => { cachedSession = null; fn(); }); },

    // ------------------------------------------------------------ reference
    async branches() { return check(await sb.from('branches').select('*').eq('active', true).order('sort_order')); },
    async cities() { return check(await sb.from('cities').select('*').order('id')); },
    async clinicians() { return check(await sb.from('clinicians').select('*').eq('active', true).order('display_name')); },
    async treatments() { return check(await sb.from('treatments').select('*').eq('active', true).order('sort_order')); },
    async expenseCategories() { return check(await sb.from('expense_categories').select('*').eq('active', true).order('sort_order')); },
    async settings() {
      const rows = check(await sb.from('app_settings').select('key,value'));
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },
    async schedule() { return check(await sb.from('dr_ali_schedule').select('*')); },
    async publicCases() {
      const files = check(await sb.storage.from('public-cases').list('', { limit: 60, sortBy: { column: 'created_at', order: 'desc' } }));
      return files.filter((f) => f.name && !f.name.startsWith('.')).map((f) => ({
        id: f.id, url: sb.storage.from('public-cases').getPublicUrl(f.name).data.publicUrl, view_label: f.name,
      }));
    },

    // ------------------------------------------------------------ patients
    async searchPatients(q) {
      const t = (q || '').trim();
      let query = sb.from('patients').select('*').order('created_at', { ascending: false }).limit(50);
      if (t) {
        const digits = t.replace(/\D/g, '');
        const ors = [`full_name.ilike.%${t.replace(/[%,()]/g, '')}%`, `mr_number.eq.${t.replace(/[,()]/g, '')}`];
        if (digits.length >= 4) ors.push(`phone.ilike.%${digits}%`);
        query = query.or(ors.join(','));
      }
      const rows = check(await query);
      const ids = rows.map((r) => r.id);
      const [dues, flags, cases] = await Promise.all([duesFor(ids), flagsFor(ids),
        ids.length ? sb.from('braces_cases').select('patient_id').in('patient_id', ids).eq('status', 'active').then(check) : []]);
      const active = new Set(cases.map((c) => c.patient_id));
      return rows.map((p) => ({ ...p, dues: dues[p.id] ?? 0, see_dr_ali: !!flags[p.id], braces_active: active.has(p.id) }));
    },
    async findDuplicates(name, phone) {
      return check(await sb.rpc('find_possible_duplicates', { p_name: name || '', p_phone: phone || '' }));
    },
    async createPatient(row) {
      const clean = { ...row, first_branch_id: row.first_branch_id ? Number(row.first_branch_id) : null };
      if (!clean.mr_number) delete clean.mr_number;
      return check(await sb.from('patients').insert(clean).select().single());
    },
    async updatePatient(id, changes) {
      return check(await sb.from('patients').update(changes).eq('id', id).select().single());
    },
    async invitePatient(id) {
      const { data, error } = await sb.functions.invoke('admin-users', { body: { action: 'invite_patient', patient_id: id } });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
    },
    async getPatient(id) {
      const p = check(await sb.from('patients').select('*').eq('id', id).single());
      const [visits, invoices, payments, photos, retainers, complaints, cases, dues, flags, ...rest] = await Promise.all([
        sb.from('visits').select(VISIT_SELECT).eq('patient_id', id).order('visit_date', { ascending: false }).then(check).then(enrichVisits),
        sb.from('invoices').select('*, items:invoice_items(*)').eq('patient_id', id).order('issue_date', { ascending: false }).then(check),
        sb.from('payments').select('*').eq('patient_id', id).order('received_at', { ascending: false }).then(check),
        sb.from('photos').select('*').eq('patient_id', id).order('taken_on', { ascending: false }).then(check),
        sb.from('retainer_cases').select('*').eq('patient_id', id).then(check),
        sb.from('complaints').select('*, messages:complaint_messages(*)').eq('patient_id', id).order('created_at', { ascending: false }).then(check),
        sb.from('braces_cases').select('*').eq('patient_id', id).eq('status', 'active').then(check),
        duesFor([id]), flagsFor([id]),
        sb.from('patient_documents').select('*').eq('patient_id', id).order('added_on', { ascending: false }).then(check),
        this.paymentPlans(id).catch(() => []),
      ]);
      for (const ph of photos) {
        const { data } = await sb.storage.from('clinic-photos').createSignedUrl(ph.storage_path, 3600);
        ph.url = data?.signedUrl || null;
      }
      const documents = rest[0] || [];
      const plans = rest[1] || [];
      for (const doc of documents) {
        const { data } = await sb.storage.from('patient-documents').createSignedUrl(doc.storage_path, 3600);
        doc.url = data?.signedUrl || null;
      }
      let braces_case = cases[0] || null;
      if (braces_case) {
        const next = check(await sb.rpc('next_braces_month', { p_case: braces_case.id }));
        braces_case = { ...braces_case, next_month: next };
      }
      return { ...p, dues: dues[id] ?? 0, flag: flags[id] || null, braces_case, visits, invoices, payments, photos, documents, plans, retainers, complaints };
    },

    // ------------------------------------------------------------ braces
    async bracesGuidance(patientId) {
      const g = check(await sb.rpc('braces_guidance', { p_patient: patientId }));
      if (g?.alerts) g.alerts = g.alerts.map((text) => ({ level: alertLevel(text), text }));
      return g;
    },
    async startBracesCase(patientId, fields) {
      return check(await sb.from('braces_cases').insert({
        patient_id: patientId, start_date: fields.start_date || todayISO(), kit_name: fields.kit_name || null,
        total_fee: fields.total_fee ? Number(fields.total_fee) : null, created_by: await userId(),
      }).select().single());
    },
    async updateBracesCase(id, changes) {
      return check(await sb.from('braces_cases').update(changes).eq('id', id).select().single());
    },

    // ------------------------------------------------------------ visits
    async listVisits({ branchId, date }) {
      let q = sb.from('visits').select(VISIT_SELECT).eq('visit_date', date).order('token_no', { ascending: true, nullsFirst: false });
      if (branchId) q = q.eq('branch_id', Number(branchId));
      return enrichVisits(check(await q));
    },
    // Live updates: calls onChange the moment any visit at this branch (or a
    // visit's doctor list) changes. Returns a function that stops listening.
    subscribeVisits(branchId, onChange) {
      const ch = sb.channel(`visits-${branchId || 'all'}-${Math.random().toString(36).slice(2)}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'visits', ...(branchId ? { filter: `branch_id=eq.${Number(branchId)}` } : {}) }, onChange)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'visit_staff' }, onChange)
        .subscribe();
      return () => { sb.removeChannel(ch); };
    },
    async addVisit(row) {
      const insert = { patient_id: row.patient_id, branch_id: Number(row.branch_id), visit_date: row.visit_date || todayISO(),
        status: row.status || 'waiting', treatment_label: row.treatment_label || null, details_text: row.details_text || null, notes: row.notes || null };
      if (row.braces || /monthly/i.test(row.treatment_label || '')) {
        const cases = check(await sb.from('braces_cases').select('id').eq('patient_id', row.patient_id).eq('status', 'active'));
        if (cases[0]) { insert.braces_case_id = cases[0].id; if (row.braces_month) insert.braces_month = row.braces_month; }
      }
      const created = check(await sb.from('visits').insert(insert).select('id').single());
      return visitById(created.id);
    },
    async updateVisit(id, changes) {
      const uid = await userId();
      const patch = { ...changes };
      if (patch.dues_override_by === true) patch.dues_override_by = uid;
      if (patch.protocol_override_by === true) patch.protocol_override_by = uid;
      delete patch.patient; delete patch.staff; delete patch.dues; delete patch.see_dr_ali; delete patch.visit_staff;
      check(await sb.from('visits').update(patch).eq('id', id));
      return visitById(id);
    },
    async setVisitStaff(visitId, clinicianId, role, add = true) {
      if (add) check(await sb.from('visit_staff').insert({ visit_id: visitId, clinician_id: clinicianId, role }));
      else {
        check(await sb.from('visit_staff').delete().match({ visit_id: visitId, clinician_id: clinicianId, role }));
        if (role === 'checker') check(await sb.from('visits').update({ checked_by: null, checked_at: null }).eq('id', visitId).eq('checked_by', clinicianId));
      }
      return visitById(visitId);
    },

    // ------------------------------------------------------------ photos
    async uploadPhoto({ patientId, visitId, file, viewLabel, branchId, kind = 'raw', publicOk = false }) {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
      const folder = kind === 'edited' ? 'edited' : 'raw';
      const path = `${patientId}/${folder}/${todayISO()}_${(viewLabel || 'photo').replace(/\W+/g, '-')}_${crypto.randomUUID().slice(0, 8)}.${ext}`;
      check(await sb.storage.from('clinic-photos').upload(path, file, { contentType: file.type, upsert: false }));
      return check(await sb.from('photos').insert({
        patient_id: patientId, visit_id: visitId || null, branch_id: branchId || null, view_label: viewLabel || null,
        storage_path: path, kind, public_ok: kind === 'edited' && !!publicOk, uploaded_by: await userId(),
      }).select().single());
    },
    // Admin puts a consented, edited before/after photo on the public website gallery.
    async publishPhoto(photo) {
      if (!photo.public_ok) throw new Error('This photo is not marked as allowed on the website.');
      const name = `${photo.taken_on}_${(photo.view_label || 'case').replace(/\W+/g, '-')}_${photo.id.slice(0, 8)}.${photo.storage_path.split('.').pop()}`;
      check(await sb.storage.from('clinic-photos').copy(photo.storage_path, name, { destinationBucket: 'public-cases' }));
      return sb.storage.from('public-cases').getPublicUrl(name).data.publicUrl;
    },
    // Consent forms, ID copies, reports: private "patient-documents" bucket, one folder per patient.
    async uploadDocument({ patientId, file, kind = 'other', title, addedOn }) {
      const ext = (file.name.split('.').pop() || 'pdf').toLowerCase();
      const slug = (title || file.name.replace(/\.[^.]+$/, '')).replace(/\W+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'document';
      const path = `${patientId}/${addedOn || todayISO()}_${slug}_${crypto.randomUUID().slice(0, 8)}.${ext}`;
      check(await sb.storage.from('patient-documents').upload(path, file, { contentType: file.type || undefined, upsert: false }));
      return check(await sb.from('patient_documents').insert({
        patient_id: patientId, kind, title: title || file.name, storage_path: path, added_on: addedOn || todayISO(), uploaded_by: await userId(),
      }).select().single());
    },

    // ------------------------------------------------------------ billing
    async createInvoice({ patient_id, branch_id, items, discount_amount = 0, discount_reason = null, visit_id = null }) {
      const subtotal = items.reduce((s, it) => s + Number(it.quantity || 1) * Number(it.unit_price || 0), 0);
      // Saved as a draft first so its lines can be added, then issued. Discounts above
      // the person's limit stay "pending approval" (the database decides).
      const inv = check(await sb.from('invoices').insert({
        patient_id, branch_id: Number(branch_id), visit_id, subtotal, discount_amount: Number(discount_amount) || 0,
        discount_reason, status: 'draft',
      }).select().single());
      check(await sb.from('invoice_items').insert(items.map((it) => ({
        invoice_id: inv.id, description: it.description, quantity: Number(it.quantity || 1), unit_price: Number(it.unit_price),
      }))));
      if (inv.status === 'draft') check(await sb.from('invoices').update({ status: 'issued' }).eq('id', inv.id));
      return check(await sb.from('invoices').select('*, items:invoice_items(*)').eq('id', inv.id).single());
    },
    async recordPayment({ patient_id, branch_id, amount, method = 'cash', invoice_id = null, notes = null }) {
      return check(await sb.from('payments').insert({ patient_id, branch_id: Number(branch_id), amount: Number(amount), method, invoice_id, notes, received_by: await userId() }).select().single());
    },
    async voidInvoice(id, reason) {
      check(await sb.from('invoices').update({ status: 'void', void_reason: reason }).eq('id', id));
    },
    // Invoices and payments only (no photos): what the payment form needs to match money to invoices.
    async patientBilling(patientId) {
      const [invoices, payments] = await Promise.all([
        sb.from('invoices').select('id,invoice_no,issue_date,subtotal,discount_amount,total,status').eq('patient_id', patientId).order('issue_date').then(check),
        sb.from('payments').select('id,invoice_id,amount,received_at').eq('patient_id', patientId).then(check),
      ]);
      return { invoices, payments };
    },
    // ------------------------------------------------------------ installment plans
    async paymentPlans(patientId) {
      return check(await sb.from('payment_plans').select('*, installments:plan_installments(*)').eq('patient_id', patientId).order('created_at', { ascending: false }));
    },
    async savePaymentPlan({ patient_id, braces_case_id = null, total_fee, starts_on, notes = null, installments }) {
      const plan = check(await sb.from('payment_plans').insert({ patient_id, braces_case_id, total_fee: Number(total_fee), starts_on: starts_on || todayISO(), notes, created_by: await userId() }).select().single());
      check(await sb.from('plan_installments').insert(installments.map((i) => ({ plan_id: plan.id, due_date: i.due_date, amount: Number(i.amount), note: i.note || null }))));
      return plan;
    },
    async deletePaymentPlan(id) { check(await sb.from('payment_plans').delete().eq('id', id)); },
    // Installments that are overdue or due within a week, for the coordinator's call list.
    async installmentsDue() {
      const rows = check(await sb.from('installment_status').select('*').in('status', ['overdue', 'due_soon']).order('due_date'));
      return attachPatients(rows);
    },
    async discountRequests() {
      const rows = check(await sb.from('discount_requests').select('*, invoice:invoices(*)').eq('status', 'pending').order('created_at'));
      const names = await staffNames();
      return attachPatients(rows.map((r) => ({ ...r, patient_id: r.invoice?.patient_id, requested_by_name: names[r.requested_by] })));
    },
    async decideDiscount(id, approve) { check(await sb.rpc('decide_discount', { p_request: id, p_approve: approve })); },

    // ------------------------------------------------------------ flags & complaints
    async raiseFlag(patientId, reason) {
      check(await sb.from('patient_flags').insert({ patient_id: patientId, reason, raised_by: await userId() }));
    },
    async clearFlag(flagId, note) {
      check(await sb.from('patient_flags').update({ cleared_at: new Date().toISOString(), cleared_by: await userId(), cleared_note: note || null }).eq('id', flagId));
    },
    async reviewList() {
      const rows = check(await sb.from('dr_ali_review_list').select('*').order('since', { ascending: false }));
      const flags = check(await sb.from('patient_flags').select('id,patient_id').is('cleared_at', null));
      const flagId = Object.fromEntries(flags.map((f) => [f.patient_id, f.id]));
      return (await attachPatients(rows)).map((r) => ({ ...r, flag_id: r.source === 'flag' ? flagId[r.patient_id] : null }));
    },
    async complaints() {
      const rows = check(await sb.from('complaints').select('*, messages:complaint_messages(*)').order('created_at', { ascending: false }));
      return attachPatients(rows);
    },
    async fileComplaint({ subject, body }) {
      const s = await this.getSession();
      return check(await sb.from('complaints').insert({ patient_id: s.patient.id, branch_id: s.patient.first_branch_id, subject, body }).select().single());
    },
    async replyComplaint(id, body, internal = false) {
      check(await sb.from('complaint_messages').insert({ complaint_id: id, author_staff: await userId(), body, internal_note: internal }));
      check(await sb.from('complaints').update({ status: 'in_progress' }).eq('id', id).eq('status', 'new'));
    },
    async setComplaintStatus(id, status) {
      const patch = { status };
      if (status === 'resolved') { patch.resolved_at = new Date().toISOString(); patch.resolved_by = await userId(); }
      check(await sb.from('complaints').update(patch).eq('id', id));
    },
    async linkComplaintDoctor(id, clinicianId) { check(await sb.from('complaints').update({ clinician_id: clinicianId || null }).eq('id', id)); },

    // ------------------------------------------------------------ coordinator
    async labCases() { return attachPatients(check(await sb.from('lab_cases').select('*').order('sent_date', { ascending: false }).limit(300))); },
    async saveLabCase(row) {
      const { patient, ...data } = row;
      if (data.id) check(await sb.from('lab_cases').update(data).eq('id', data.id));
      else check(await sb.from('lab_cases').insert({ ...data, created_by: await userId() }));
    },
    async retainerCases() { return attachPatients(check(await sb.from('retainer_cases').select('*').order('created_at', { ascending: false }).limit(300))); },
    async saveRetainerCase(row) {
      const { patient, ...data } = row;
      if (data.id) check(await sb.from('retainer_cases').update(data).eq('id', data.id));
      else check(await sb.from('retainer_cases').insert({ ...data, created_by: await userId() }));
    },
    async reminders() { return attachPatients(check(await sb.from('reminders').select('*').neq('status', 'done').order('due_date').limit(500))); },
    async saveReminder(row) {
      const { patient, ...data } = row;
      if (data.id) check(await sb.from('reminders').update(data).eq('id', data.id));
      else check(await sb.from('reminders').insert({ ...data, created_by: await userId() }));
    },
    async dropoffs() { return attachPatients(check(await sb.from('braces_dropoffs').select('*').order('last_visit', { ascending: true, nullsFirst: true }))); },
    async lowRatings() {
      const settings = await this.settings();
      return attachPatients(check(await sb.from('visit_ratings').select('*').lte('stars', Number(settings.low_rating_threshold ?? 3)).is('followed_up_at', null).order('created_at', { ascending: false })));
    },
    async followUpRating(visitId) {
      check(await sb.from('visit_ratings').update({ followed_up_by: await userId(), followed_up_at: new Date().toISOString() }).eq('visit_id', visitId));
    },

    // ------------------------------------------------------------ stock
    async inventory(branchId) {
      const [items, stock, moves] = await Promise.all([
        sb.from('inventory_items').select('*').order('category').order('name').then(check),
        sb.from('inventory_stock').select('*').eq('branch_id', Number(branchId)).then(check),
        sb.from('inventory_moves').select('*').eq('branch_id', Number(branchId)).order('created_at', { ascending: false }).limit(50).then(check).catch(() => []),
      ]);
      return { items, stock, moves };
    },
    async saveInventoryItem(row) {
      const { id, ...data } = row;
      if (id) check(await sb.from('inventory_items').update(data).eq('id', id)); else check(await sb.from('inventory_items').insert(data));
    },
    async moveStock({ branch_id, item_id, change, reason, visit_id = null }) {
      check(await sb.from('inventory_moves').insert({ branch_id: Number(branch_id), item_id: Number(item_id), change: Number(change), reason, visit_id, created_by: await userId() }));
    },
    async setReorderLevel({ branch_id, item_id, reorder_level }) {
      check(await sb.from('inventory_stock').upsert({ branch_id: Number(branch_id), item_id: Number(item_id), reorder_level: Number(reorder_level) }, { onConflict: 'branch_id,item_id' }));
    },

    // ------------------------------------------------------------ accounts
    async expenses({ from, to } = {}) {
      let q = sb.from('expenses').select('*').order('expense_date', { ascending: false }).limit(1000);
      if (from) q = q.gte('expense_date', from);
      if (to) q = q.lte('expense_date', to);
      return check(await q);
    },
    async addExpense(row) {
      const branches = await this.branches();
      const branch = branches.find((b) => b.id === Number(row.branch_id));
      return check(await sb.from('expenses').insert({
        expense_date: row.expense_date, branch_id: branch ? branch.id : null, city_id: branch ? branch.city_id : Number(row.city_id),
        category_id: Number(row.category_id), amount: Number(row.amount), paid_to: row.paid_to || null, method: row.method || 'cash',
        notes: row.notes || null, created_by: await userId(),
      }).select().single());
    },
    // Receipt photo or PDF for an expense: private "receipts" bucket, <expense id>.<ext>.
    async uploadReceipt(expenseId, file) {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const path = `${expenseId}.${ext}`;
      check(await sb.storage.from('receipts').upload(path, file, { contentType: file.type || undefined, upsert: true }));
      check(await sb.from('expenses').update({ receipt_path: path }).eq('id', expenseId));
      return path;
    },
    async receiptUrl(path) {
      const { data, error } = await sb.storage.from('receipts').createSignedUrl(path, 600);
      if (error) throw error;
      return data.signedUrl;
    },
    async branchPnl(month) {
      const first = month + '-01';
      const [rows, branches] = await Promise.all([sb.from('branch_monthly_pnl').select('*').eq('month', first).then(check), this.branches()]);
      // One row per branch, then one row per city for expenses recorded without a branch (branch_id null).
      return [
        ...branches.map((b) => {
          const r = rows.find((x) => x.branch_id === b.id) || {};
          return { branch_id: b.id, branch: b.name, city_id: b.city_id, income: Number(r.income || 0), expenses: Number(r.expenses || 0), profit: Number(r.profit || 0) };
        }),
        ...rows.filter((x) => x.branch_id == null && Number(x.expenses) > 0).map((x) => ({
          branch_id: null, branch: null, city_id: x.city_id, income: 0, expenses: Number(x.expenses), profit: -Number(x.expenses),
        })),
      ];
    },
    async expectedCash(branchId, date) {
      const start = new Date(date + 'T00:00:00+05:00').toISOString();
      const end = new Date(date + 'T23:59:59.999+05:00').toISOString();
      const rows = check(await sb.from('payments').select('amount').eq('branch_id', Number(branchId)).eq('method', 'cash').gte('received_at', start).lte('received_at', end));
      return rows.reduce((s, r) => s + Number(r.amount), 0);
    },
    async closeCash(branchId, date, counted, notes) {
      return check(await sb.rpc('close_cash', { p_branch: Number(branchId), p_date: date, p_counted: Number(counted), p_notes: notes || null }));
    },
    async cashClosings() { return check(await sb.from('cash_closings').select('*').order('closing_date', { ascending: false }).limit(200)); },
    async verifyClosing(id) { check(await sb.from('cash_closings').update({ verified_by: await userId(), verified_at: new Date().toISOString() }).eq('id', id)); },
    // ---- report queries (Reports page): payments, invoices, advances, daily visits in a date range.
    async paymentsReport({ from, to, branchId, method } = {}) {
      let q = sb.from('payments').select('*, invoice:invoices(invoice_no)').order('received_at', { ascending: false }).limit(5000);
      if (from) q = q.gte('received_at', new Date(from + 'T00:00:00+05:00').toISOString());
      if (to) q = q.lt('received_at', new Date(new Date(to + 'T00:00:00+05:00').getTime() + 86400000).toISOString());
      if (branchId) q = q.eq('branch_id', Number(branchId));
      if (method) q = q.eq('method', method);
      const [rows, names] = await Promise.all([q.then(check), staffNames()]);
      return attachPatients(rows.map((r) => ({ ...r, invoice_no: r.invoice?.invoice_no || null, received_by_name: names[r.received_by] || null })));
    },
    async invoicesReport({ from, to, branchId, status, discounted } = {}) {
      let q = sb.from('invoices').select('*').order('issue_date', { ascending: false }).limit(5000);
      if (from) q = q.gte('issue_date', from);
      if (to) q = q.lte('issue_date', to);
      if (branchId) q = q.eq('branch_id', Number(branchId));
      if (status) q = q.eq('status', status);
      if (discounted) q = q.gt('discount_amount', 0);
      const [rows, names] = await Promise.all([q.then(check), staffNames()]);
      return attachPatients(rows.map((r) => ({ ...r, created_by_name: names[r.created_by] || null })));
    },
    async advances() {
      const rows = check(await sb.from('patient_balances').select('patient_id, billed, paid, dues').lt('dues', 0).order('dues', { ascending: true }).limit(500));
      return attachPatients(rows.map((r) => ({ ...r, advance: -Number(r.dues) })));
    },
    async visitsDaily({ from, to, branchId } = {}) {
      let q = sb.from('visits').select('visit_date, branch_id, status, checked_in_at, started_at, patient_id').gte('visit_date', from).lte('visit_date', to).limit(20000);
      if (branchId) q = q.eq('branch_id', Number(branchId));
      return check(await q);
    },
    async todaysPayments(branchId) {
      const d = todayISO();
      let q = sb.from('payments').select('*').gte('received_at', new Date(d + 'T00:00:00+05:00').toISOString()).order('received_at', { ascending: false });
      if (branchId) q = q.eq('branch_id', Number(branchId));
      return attachPatients(check(await q));
    },

    // ------------------------------------------------------------ doctor log
    async doctorLog({ clinicianId, from, to }) {
      // A doctor sees only their own log unless allowed to see everyone's (same rule as demo mode).
      const session = await this.getSession();
      const mayViewAll = session?.staff?.role === 'admin' || session?.perms?.has('doctor_log.view_all');
      if (!mayViewAll && clinicianId !== await this.myClinicianId()) throw new Error('You can only see your own daily log.');
      const rows = check(await sb.from('visit_staff').select('role, visit:visits!inner(' + VISIT_SELECT + ')')
        .eq('clinician_id', clinicianId).eq('visit.status', 'completed').gte('visit.visit_date', from).lte('visit.visit_date', to));
      const visits = await enrichVisits(rows.map((r) => r.visit));
      return visits.map((v, i) => ({ role: rows[i].role, ...v })).sort((a, b) => b.visit_date.localeCompare(a.visit_date));
    },
    async doctorSummary(clinicianId, from, to) { return check(await sb.rpc('doctor_summary', { p_clinician: clinicianId, p_from: from, p_to: to })); },
    async myClinicianId() {
      const uid = await userId();
      const row = check(await sb.from('clinicians').select('id').eq('staff_id', uid).maybeSingle());
      return row?.id || null;
    },

    // ------------------------------------------------------------ admin
    async permissionGrid() {
      const [perms, grid, overrides] = await Promise.all([
        sb.from('permissions').select('*').order('sort_order').then(check),
        sb.from('role_permissions').select('*').then(check),
        sb.from('staff_permission_overrides').select('*').then(check),
      ]);
      const roles = ['front_desk', 'assistant', 'doctor', 'coordinator', 'accountant', 'admin'];
      const g = Object.fromEntries(roles.map((r) => [r, {}]));
      for (const row of grid) g[row.role][row.permission_key] = row.allowed;
      for (const p of perms) g.admin[p.key] = true;
      const o = {};
      for (const row of overrides) (o[row.staff_id] ||= {})[row.permission_key] = row.allowed;
      return { permissions: perms, roles, grid: g, overrides: o };
    },
    async setRolePermission(role, key, allowed) {
      check(await sb.from('role_permissions').upsert({ role, permission_key: key, allowed }));
    },
    async setOverride(staffId, key, allowed) {
      if (allowed === null) check(await sb.from('staff_permission_overrides').delete().match({ staff_id: staffId, permission_key: key }));
      else check(await sb.from('staff_permission_overrides').upsert({ staff_id: staffId, permission_key: key, allowed }));
    },
    async staffList() { return check(await sb.from('staff').select('*').order('full_name')); },
    async createStaff(row) {
      // Creating a login needs the server key, so it goes through an Edge Function.
      const { data, error } = await sb.functions.invoke('admin-users', { body: { action: 'create_staff', ...row } });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      return data.staff;
    },
    async updateStaffLogin(id, { email, password }) {
      const { data, error } = await sb.functions.invoke('admin-users', { body: { action: 'update_login', user_id: id, email, password } });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
    },
    async deactivateStaff(id) {
      check(await sb.rpc('deactivate_staff', { p_staff: id }));
      await sb.functions.invoke('admin-users', { body: { action: 'ban_user', user_id: id } });
    },
    async reactivateStaff(id) {
      check(await sb.from('staff').update({ active: true, deactivated_at: null }).eq('id', id));
      await sb.functions.invoke('admin-users', { body: { action: 'unban_user', user_id: id } });
    },
    async setSetting(key, value) { check(await sb.from('app_settings').update({ value, updated_at: new Date().toISOString() }).eq('key', key)); },
    async discountCaps() {
      const rows = check(await sb.from('discount_caps').select('*'));
      return Object.fromEntries(rows.map((r) => [r.role, { maxPercent: r.max_percent === null ? null : Number(r.max_percent), maxAmount: r.max_amount === null ? null : Number(r.max_amount) }]));
    },
    async setDiscountCap(role, maxPercent, maxAmount) {
      check(await sb.from('discount_caps').upsert({ role, max_percent: maxPercent === '' ? null : maxPercent, max_amount: maxAmount === '' ? null : maxAmount }));
    },
    async saveScheduleRow(row) {
      if (row.id) check(await sb.from('dr_ali_schedule').update(row).eq('id', row.id));
      else check(await sb.from('dr_ali_schedule').insert(row));
    },
    async deleteScheduleRow(id) { check(await sb.from('dr_ali_schedule').delete().eq('id', id)); },
    async staffLogins() { return check(await sb.rpc('staff_logins', { p_limit: 200 })); },
    async auditLog() {
      const [rows, names] = await Promise.all([sb.from('audit_log').select('*').order('at', { ascending: false }).limit(200).then(check), staffNames()]);
      return rows.map((r) => ({ ...r, actor_name: names[r.actor] || null }));
    },
    async dashboard(date) {
      const day = date || todayISO();
      const [branches, visits, closings] = await Promise.all([
        this.branches(),
        sb.from('visits').select('branch_id,status,patient_id').eq('visit_date', day).then(check),
        sb.from('cash_closings').select('*').eq('closing_date', day).then(check),
      ]);
      let income = []; let complaints = []; let dues = {};
      try { income = check(await sb.from('branch_daily_income').select('*').eq('day', day)); } catch { income = []; }
      try { complaints = check(await sb.from('complaints').select('branch_id').eq('status', 'new')); } catch { complaints = []; }
      try { dues = await duesFor([...new Set(visits.map((v) => v.patient_id))]); } catch { dues = {}; }
      return branches.map((b) => {
        const vs = visits.filter((v) => v.branch_id === b.id);
        const withDues = [...new Set(vs.map((v) => v.patient_id))].filter((pid) => (dues[pid] || 0) > 0);
        return { branch: b, patients: vs.length, completed: vs.filter((v) => v.status === 'completed').length,
          waiting: vs.filter((v) => v.status === 'waiting').length,
          received: Number(income.find((i) => i.branch_id === b.id)?.net || 0),
          dues_patients: withDues.length, dues: withDues.reduce((s, pid) => s + dues[pid], 0),
          new_complaints: complaints.filter((c) => c.branch_id === b.id).length,
          closing: closings.find((c) => c.branch_id === b.id) || null };
      });
    },
    async totalDues() {
      const rows = check(await sb.from('patient_balances').select('dues').gt('dues', 0));
      return rows.reduce((t, r) => t + Number(r.dues), 0);
    },
    async commissionRules() { return check(await sb.from('doctor_commission_rules').select('*').eq('active', true)); },
    async report(kind, from, to) { return check(await sb.rpc('clinic_report', { p_kind: kind, p_from: from, p_to: to })) || []; },

    // ------------------------------------------------------------ clinic setup (admin)
    async setupLists() {
      const [branches, cities, clinicians, groups, treatments, categories, staff, rules] = await Promise.all([
        sb.from('branches').select('*').order('sort_order').order('id').then(check),
        this.cities(),
        sb.from('clinicians').select('*').order('is_doctor', { ascending: false }).order('display_name').then(check),
        sb.from('doctor_groups').select('*').order('id').then(check),
        sb.from('treatments').select('*').order('sort_order').order('name').then(check),
        sb.from('expense_categories').select('*').order('sort_order').order('name').then(check),
        sb.from('staff').select('id,full_name,role,active').order('full_name').then(check),
        sb.from('doctor_commission_rules').select('*').order('percent', { ascending: false }).then(check).catch(() => []),
      ]);
      return { branches, cities, clinicians, groups, treatments, categories, staff: staff.filter((s) => s.active), commission_rules: rules };
    },
    async saveSetupRow(table, row) {
      const tables = ['branches', 'clinicians', 'doctor_groups', 'treatments', 'expense_categories', 'doctor_commission_rules'];
      if (!tables.includes(table)) throw new Error('Unknown list ' + table);
      const { id, ...data } = row;
      if (table === 'doctor_groups' && !(await sb.from('doctor_groups').select('id').eq('id', id).then(check)).length) check(await sb.from(table).insert({ id, ...data }));
      else if (id !== undefined && id !== null && id !== '') check(await sb.from(table).update(data).eq('id', id));
      else check(await sb.from(table).insert(data));
    },

    // ------------------------------------------------------------ duplicates (admin)
    async patientDuplicates() { return check(await sb.rpc('patient_duplicates')) || []; },
    async mergePatients(keepId, removeId) { return check(await sb.rpc('merge_patients', { p_keep: keepId, p_remove: removeId })); },

    // ------------------------------------------------------------ import from Healthwire (admin)
    async importHealthwire(kind, rows) { return check(await sb.rpc('import_healthwire', { p_kind: kind, p_rows: rows })); },
    async importAajSheet(rows, createPatients = false) { return check(await sb.rpc('import_aaj_sheet', { p_rows: rows, p_create_patients: !!createPatients })); },
    async patientsByMr(mrs) {
      const out = [];
      for (let i = 0; i < mrs.length; i += 200) out.push(...check(await sb.from('patients').select('mr_number').in('mr_number', mrs.slice(i, i + 200))));
      return out;
    },

    // ------------------------------------------------------------ export
    async exportTable(name) {
      const allowed = ['patients', 'visits', 'invoices', 'payments', 'expenses', 'cash_closings'];
      if (!allowed.includes(name)) return [];
      const out = [];
      for (let from = 0; ; from += 1000) {
        const rows = check(await sb.from(name).select('*').range(from, from + 999));
        out.push(...rows);
        if (rows.length < 1000) break;
      }
      return out;
    },

    // ------------------------------------------------------------ patient portal
    async rateVisit(visitId, stars, comment) {
      const s = await this.getSession();
      check(await sb.from('visit_ratings').insert({ visit_id: visitId, patient_id: s.patient.id, stars: Number(stars), comment: comment || null }));
    },
    async myRatings() { return check(await sb.from('visit_ratings').select('*')); },
  };
}
