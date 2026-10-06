// Supabase Edge Function: copies patient files (consent forms, photos) from
// Healthwire's file CDN into the website's own storage. The website cannot
// fetch those files itself (the CDN sends no CORS headers), so Dr. Ali's
// browser sends the list of file links here and this function does the
// copying with the server-side key. Admin only.
//
//   POST { items: [{ mr, url, kind: 'document' | 'photo', doc_kind?, title?, taken_on?, branch_id?, view_label? }] }
//   ->   { done: [{ mr, path }], skipped: [{ mr, url, why }] }
//
// Deploy: supabase functions deploy import-files
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// Only Healthwire's own CDN is copied from; nothing else can be pulled through this function.
const ALLOWED_HOSTS = new Set(['d3313lwq5y3sh2.cloudfront.net']);
const EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };
const MAX_BYTES = 25 * 1024 * 1024;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const authHeader = req.headers.get('Authorization') ?? '';
  const asCaller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: userData } = await asCaller.auth.getUser();
  if (!userData?.user) return json({ error: 'Please log in again.' }, 401);
  const { data: isAdmin } = await asCaller.rpc('is_admin');
  if (isAdmin !== true) return json({ error: 'Only Dr. Ali can import files.' }, 403);

  let body: { items?: Array<Record<string, unknown>> };
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
  const done: unknown[] = [], skipped: unknown[] = [];

  for (const it of items) {
    const mr = String(it.mr ?? '').trim();
    const src = String(it.url ?? '');
    const kind = it.kind === 'photo' ? 'photo' : 'document';
    try {
      const u = new URL(src);
      if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) throw new Error('not a Healthwire file link');
      const { data: patient } = await admin.from('patients').select('id').eq('mr_number', mr).maybeSingle();
      if (!patient) throw new Error('no patient with this MR number');

      // A stable name from the CDN path (…/photos/004/331/260/original/Form.pdf -> hw-4331260-Form.pdf) so re-runs skip copies already made.
      const parts = u.pathname.split('/').filter(Boolean);
      const fileName = decodeURIComponent(parts[parts.length - 1] ?? 'file');
      const idDigits = parts.slice(-5, -2).join('').replace(/^0+/, '') || crypto.randomUUID().slice(0, 8);
      const res = await fetch(src);
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) throw new Error('empty or too large');
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim() || 'application/octet-stream';
      const ext = EXT[type] ?? (fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : 'bin');
      const slug = fileName.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'file';
      const base = `hw-${idDigits}-${slug}.${ext}`;

      if (kind === 'photo') {
        const path = `${patient.id}/raw/${base}`;
        const { data: exists } = await admin.from('photos').select('id').eq('storage_path', path).maybeSingle();
        if (exists) { done.push({ mr, path, already: true }); continue; }
        const up = await admin.storage.from('clinic-photos').upload(path, bytes, { contentType: type, upsert: true });
        if (up.error) throw up.error;
        const row = {
          patient_id: patient.id, branch_id: it.branch_id ? Number(it.branch_id) : null, taken_on: String(it.taken_on ?? new Date().toISOString().slice(0, 10)),
          kind: 'raw', view_label: String(it.view_label ?? 'Healthwire'), storage_path: path, uploaded_by: userData.user.id,
        };
        const ins = await admin.from('photos').insert(row);
        if (ins.error) throw ins.error;
        done.push({ mr, path });
      } else {
        const path = `${patient.id}/${base}`;
        const { data: exists } = await admin.from('patient_documents').select('id').eq('storage_path', path).maybeSingle();
        if (exists) { done.push({ mr, path, already: true }); continue; }
        const up = await admin.storage.from('patient-documents').upload(path, bytes, { contentType: type, upsert: true });
        if (up.error) throw up.error;
        const docKind = ['consent', 'id', 'report', 'other'].includes(String(it.doc_kind)) ? String(it.doc_kind) : 'other';
        const row = {
          patient_id: patient.id, kind: docKind, title: String(it.title ?? fileName), storage_path: path,
          added_on: String(it.taken_on ?? new Date().toISOString().slice(0, 10)), legacy_source: 'healthwire',
          notes: `Copied from Healthwire (${fileName})`, uploaded_by: userData.user.id,
        };
        const ins = await admin.from('patient_documents').insert(row);
        if (ins.error) throw ins.error;
        done.push({ mr, path });
      }
    } catch (e) {
      skipped.push({ mr, url: src, why: (e as Error).message ?? String(e) });
    }
  }
  return json({ done, skipped });
});
