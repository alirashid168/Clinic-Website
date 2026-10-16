// "Upload X-ray", "Upload consent form" and Delete for documents on the patient profile: the live adapter (web/js/data/supabase.js)
// against a stand-in for supabase-js (the real library is loaded from a CDN in the browser). What it pins down:
//   - a weak connection: the row is saved but its answer is lost; pressing Upload / Save again (same idempotency key) uploads nothing
//     again, gets "duplicate key" from the database and answers the row that is there: one file, one row, no database error;
//   - a consent form comes back with the patient's "Consent signed" as the record has it after the save (null when it was not ticked);
//   - Delete asks the database function first (once per page) and touches no file while the database update is missing;
//   - Delete for a picture and an X-ray (20261016000200): the database names the files (begin_photo_delete / begin_xray_delete, which
//     writes them in the audit log), the page removes exactly those through Storage, then the row goes (delete_patient_photo /
//     delete_patient_xray); without the update, or when Storage refuses, the row is not asked to go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setMaxListeners } from 'node:events';

// ---- a browser-like page
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k) : null),
  setItem: (k: string, v: unknown) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
};
const page = new EventTarget();
setMaxListeners(0, page);
(globalThis as any).window = page;
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test', onLine: true }, configurable: true, writable: true });

registerHooks({
  resolve(spec, ctx, nextResolve) {
    if (spec.startsWith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@')) {
      return { url: 'data:text/javascript,export const createClient = (...a) => globalThis.__fakeCreateClient(...a);', shortCircuit: true };
    }
    return nextResolve(spec, ctx);
  },
});
const { createSupabaseAdapter } = await import('../web/js/data/supabase.js');

const PATIENT = '22222222-2222-4222-8222-222222222222';
const NIL = '00000000-0000-0000-0000-000000000000';

/** A stand-in for supabase-js: tables with a unique storage_path, a bucket per name, and the delete function (or none). */
function fakeClient() {
  const f: any = {
    uploads: [] as string[], removes: [] as string[], rpcs: [] as Array<[string, any]>,
    tables: { xrays: [], patient_documents: [], patients: [{ id: PATIENT, treatment_consent_at: null }] } as Record<string, any[]>,
    loseNextInsertAnswer: false, // the row is saved, but the page hears "Failed to fetch"
    consentTrigger: true, // the database update that ticks "Consent signed" is there
    missingRpc: false,
    plans: {} as Record<string, Array<{ bucket: string, name: string }>>, // what begin_photo_delete / begin_xray_delete answer, by id
    removeError: null as any, // Storage refuses the next remove()
  };
  f.from = (table: string) => {
    let op = 'select'; let payload: any = null; let single = false;
    const filters: Array<[string, unknown]> = [];
    const b: any = {
      select() { return b; }, order() { return b; }, eq(col: string, v: unknown) { filters.push([col, v]); return b; },
      insert(row: any) { op = 'insert'; payload = row; return b; },
      maybeSingle() { single = true; return b; }, single() { single = true; return b; },
      then(resolve: any, reject: any) {
        const rows = (f.tables[table] ||= []);
        let res: any;
        if (op === 'insert') {
          if (rows.some((r: any) => r.storage_path === payload.storage_path)) {
            res = { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${table}_storage_path_key"` }, status: 409 };
          } else {
            const row = { id: `${table}-${rows.length + 1}`, ...payload };
            rows.push(row);
            const p = f.tables.patients.find((x: any) => x.id === row.patient_id);
            if (table === 'patient_documents' && row.kind === 'consent' && f.consentTrigger && p && !p.treatment_consent_at) p.treatment_consent_at = '2026-10-15T07:00:00Z';
            if (f.loseNextInsertAnswer) { f.loseNextInsertAnswer = false; res = { data: null, error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 }; }
            else res = { data: row, error: null, status: 201 };
          }
        } else {
          const hit = rows.filter((r: any) => filters.every(([c, v]) => r[c] === v));
          res = { data: single ? (hit[0] ?? null) : hit, error: null, status: 200 };
        }
        return Promise.resolve(res).then(resolve, reject);
      },
    };
    return b;
  };
  f.client = () => ({
    auth: {
      storageKey: 'sb-test-auth-token',
      async getSession() { return { data: { session: { access_token: 'jwt-u1', user: { id: 'u1' } } }, error: null }; },
      async getUser() { return { data: { user: { id: 'u1' } }, error: null }; },
      async signOut() { return { error: null }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      stopAutoRefresh() {},
    },
    from: f.from,
    rpc: (name: string, args: any) => {
      f.rpcs.push([name, args]);
      const id = args.p_document ?? args.p_photo ?? args.p_xray;
      const answer = name === 'begin_photo_delete' || name === 'begin_xray_delete' ? { found: id in f.plans, files: f.plans[id] || [] }
        : name === 'delete_patient_photo' ? { deleted: id in f.plans, edited_copies: 0, visit_unticked: id === 'photo-on-visit', visit_asks_photos: id === 'photo-on-visit' }
        : name === 'delete_patient_xray' ? { deleted: id in f.plans }
          : { deleted: id !== NIL, consent_cleared: false, consent_forms_left: 0 };
      const r: any = Promise.resolve(f.missingRpc
        ? { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` }, status: 404 }
        : { data: answer, error: null, status: 200 });
      r.abortSignal = () => r;
      return r;
    },
    functions: { invoke: async () => ({ data: null, error: null }) },
    storage: {
      from: (bucket: string) => ({
        async upload(path: string) {
          const key = `${bucket}/${path}`;
          if (f.uploads.includes(key)) return { data: null, error: { statusCode: '409', message: 'The resource already exists' } };
          f.uploads.push(key);
          return { data: { path }, error: null };
        },
        async remove(paths: string[]) {
          if (f.removeError) { const error = f.removeError; f.removeError = null; return { data: null, error }; }
          f.removes.push(...paths.map((p) => `${bucket}/${p}`)); return { data: [], error: null };
        },
        async createSignedUrls(paths: string[]) { return { data: paths.map((path) => ({ path, signedUrl: `https://signed.test/${path}`, error: null })), error: null }; },
      }),
    },
  });
  return f;
}
async function openPage() {
  const f = fakeClient();
  (globalThis as any).__fakeCreateClient = () => f.client();
  return { f, data: await createSupabaseAdapter() };
}
const png = (name: string) => new File(['bytes'], name, { type: 'image/png' });

test('uploadXray: the row is saved but its answer is lost; Upload again with the same key answers that row (one file, one row, no error)', async () => {
  const { f, data } = await openPage();
  const args = { patientId: PATIENT, file: png('pa-2.png'), kind: 'Periapical (PA)', takenOn: '2026-10-15', idempotencyKey: 'aaaaaaaa-1111-4111-8111-111111111111' };
  f.loseNextInsertAnswer = true;
  await assert.rejects(data.uploadXray(args), /Failed to fetch/);
  assert.equal(f.tables.xrays.length, 1, 'the database has the row');
  const row = await data.uploadXray(args);
  assert.equal(row.id, f.tables.xrays[0].id, 'the row that is there');
  assert.equal(f.tables.xrays.length, 1, 'not saved twice');
  assert.equal(f.uploads.length, 1, 'the file went up once');
  assert.match(f.uploads[0], new RegExp(`^xrays/${PATIENT}/2026-10-15_Periapical-PA_aaaaaaaa\\.png$`));
  assert.equal(await data.uploadXray(args), row, 'a third press answers at once');
});

test('uploadDocument: the same for a consent page, and a consent form comes back with "Consent signed" as the record has it', async () => {
  const { f, data } = await openPage();
  const args = { patientId: PATIENT, file: png('consent-1.png'), kind: 'consent', title: 'Consent and information form (1 of 2)', addedOn: '2026-10-15', idempotencyKey: 'bbbbbbbb-2222-4222-8222-222222222222' };
  f.loseNextInsertAnswer = true;
  await assert.rejects(data.uploadDocument(args), /Failed to fetch/);
  const row = await data.uploadDocument(args);
  assert.equal(f.tables.patient_documents.length, 1, 'one row');
  assert.equal(f.uploads.length, 1, 'one file');
  assert.equal(row.treatment_consent_at, '2026-10-15T07:00:00Z', 'ticked by the database');
  // Before the database update: nothing ticks it, and the page must not say it did.
  const before = await openPage();
  before.f.consentTrigger = false;
  const r2 = await before.data.uploadDocument({ ...args, idempotencyKey: 'cccccccc-3333-4333-8333-333333333333' });
  assert.equal(r2.treatment_consent_at, null);
  const other = await before.data.uploadDocument({ patientId: PATIENT, file: png('id.png'), kind: 'id', title: 'ID copy', addedOn: '2026-10-15' });
  assert.equal('treatment_consent_at' in other, false, 'other kinds do not read the record');
});

test('deleteDocument: without the database update nothing is touched; with it, asked once per page, then the file and the row', async () => {
  const doc = { id: 'doc-1', storage_path: `${PATIENT}/2026-10-15_Consent_dddddddd.png`, kind: 'consent' };
  const missing = await openPage();
  missing.f.missingRpc = true;
  await assert.rejects(missing.data.deleteDocument(doc), (e: any) => e.code === 'DOCUMENTS_DELETE_MISSING' && /20261015001000_patient_documents_delete\.sql/.test(e.message) && /Nothing was deleted/.test(e.message));
  assert.deepEqual(missing.f.removes, [], 'the file stays');

  const { f, data } = await openPage();
  const res = await data.deleteDocument(doc, { clearConsent: true });
  assert.equal(res.deleted, true);
  assert.deepEqual(f.removes, [`patient-documents/${doc.storage_path}`]);
  assert.deepEqual(f.rpcs, [
    ['delete_patient_document', { p_document: NIL, p_clear_consent: false }],
    ['delete_patient_document', { p_document: 'doc-1', p_clear_consent: true }],
  ]);
  await data.deleteDocument({ ...doc, id: 'doc-2' });
  assert.equal(f.rpcs.length, 3, 'asked about no document only the first time');
});

test('deletePhoto / deleteXray: without the database update nothing is touched; with it, the files the database names (never the paths on the row itself), then the row', async () => {
  // The row as the page has it: its thumb_path points at someone else's picture (a row changed through the API). The page does not use it.
  const raw = { id: 'photo-on-visit', kind: 'raw', taken_on: '2026-10-16', view_label: 'Front', public_ok: false,
    storage_path: `${PATIENT}/raw/2026-10-16_Front_eeeeeeee.jpg`, thumb_path: `${PATIENT}/raw/2026-10-16_Other_99999999.jpg` };
  const missing = await openPage();
  missing.f.missingRpc = true;
  await assert.rejects(missing.data.deletePhoto(raw), (e: any) => e.code === 'PHOTOS_DELETE_MISSING' && /20261016000200_photo_xray_delete.sql/.test(e.message) && /Nothing was deleted/.test(e.message));
  await assert.rejects(missing.data.deleteXray({ id: 'x-1', storage_path: `${PATIENT}/2026-10-16_OPG_ffffffff.png` }), (e: any) => e.code === 'PHOTOS_DELETE_MISSING');
  assert.deepEqual(missing.f.removes, [], 'no file is touched');
  assert.deepEqual(missing.f.rpcs.map(([n]: [string]) => n), ['begin_photo_delete', 'begin_xray_delete'], 'and no row is asked to go');

  const { f, data } = await openPage();
  f.plans[raw.id] = [{ bucket: 'clinic-photos', name: raw.storage_path }, { bucket: 'clinic-photos', name: `${PATIENT}/raw/thumbs/2026-10-16_Front_eeeeeeee.jpg` }];
  assert.deepEqual(await data.deletePhoto(raw), { deleted: true, edited_copies: 0, visit_unticked: true, visit_asks_photos: true });
  assert.deepEqual(f.removes, [`clinic-photos/${raw.storage_path}`, `clinic-photos/${PATIENT}/raw/thumbs/2026-10-16_Front_eeeeeeee.jpg`],
    'the picture and the small copy made from its path, as the database named them; not the file named by thumb_path on the row');
  assert.deepEqual(f.rpcs, [['begin_photo_delete', { p_photo: raw.id }], ['delete_patient_photo', { p_photo: raw.id }]]);

  // An edited picture: its website gallery copy too, in one call per bucket.
  const edited = { id: 'abcdef12-0000-4000-8000-000000000001', kind: 'edited', taken_on: '2026-10-12', view_label: 'After · front', public_ok: true,
    storage_path: `${PATIENT}/edited/2026-10-12_After_abcdef12.png`, thumb_path: null };
  f.plans[edited.id] = [{ bucket: 'clinic-photos', name: edited.storage_path }, { bucket: 'public-cases', name: '2026-10-12_After-front_abcdef12.png' }];
  f.removes.length = 0;
  await data.deletePhoto(edited);
  assert.deepEqual(f.removes, [`clinic-photos/${edited.storage_path}`, 'public-cases/2026-10-12_After-front_abcdef12.png']);

  // Storage refuses: the row is not asked to go (it stays on the record to delete again).
  f.rpcs.length = 0;
  f.removeError = { statusCode: '403', message: 'new row violates row-level security policy' };
  await assert.rejects(data.deletePhoto(edited), /row-level security/);
  assert.deepEqual(f.rpcs.map(([n]: [string]) => n), ['begin_photo_delete']);

  // A picture already gone (another tab): nothing to remove, and the answer says so.
  f.removes.length = 0;
  assert.equal((await data.deletePhoto({ ...raw, id: 'gone' })).deleted, false);
  assert.deepEqual(f.removes, []);

  f.removes.length = 0;
  f.rpcs.length = 0;
  const xray = { id: 'x-1', storage_path: `${PATIENT}/2026-10-16_OPG_ffffffff.png` };
  f.plans[xray.id] = [{ bucket: 'xrays', name: xray.storage_path }];
  assert.deepEqual(await data.deleteXray(xray), { deleted: true });
  assert.deepEqual(f.removes, [`xrays/${xray.storage_path}`]);
  assert.deepEqual(f.rpcs, [['begin_xray_delete', { p_xray: 'x-1' }], ['delete_patient_xray', { p_xray: 'x-1' }]]);
});
