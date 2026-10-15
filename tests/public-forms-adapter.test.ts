// The data layer of the homepage forms and the Complaints inbox: the live adapter (web/js/data/supabase.js) run against a stand-in
// for supabase-js (the real library is loaded from a CDN in the browser), and the demo adapter (web/js/data/demo.js), which must
// follow the same rules as the database. Every name, phone and file here is made up. What it pins down:
//   live:  the CV upload sends a copy typed by the file's ending (supabase-js takes the type from the file and drops the
//          contentType option, and the bucket refuses 'application/octet-stream' or 'image/jpg'), or by its type when the
//          name has no ending, with no caching; a refused upload's words;
//          the inbox asks for open complaints and recent resolved ones, each capped, filtered by source on the server;
//          deleting a website form, and "not removed" when the database refused; the Today page's count of New applications.
//   demo:  the same inbox rules, and only an admin deletes, only a website form; the count of New applications; the hidden box.
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

// ---- the SDK import of the adapter (a CDN URL) is answered by this stand-in
registerHooks({
  resolve(spec, ctx, nextResolve) {
    if (spec.startsWith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@')) {
      return { url: 'data:text/javascript,export const createClient = (...a) => globalThis.__fakeCreateClient(...a);', shortCircuit: true };
    }
    return nextResolve(spec, ctx);
  },
});
const { createSupabaseAdapter } = await import('../web/js/data/supabase.js');
const { createDemoAdapter } = await import('../web/js/data/demo.js');
const { CV_TYPES } = await import('../web/js/lib/public-forms.js');

// ======================================================================================= the live adapter
type Op = [string, ...any[]];
/** A stand-in for supabase-js: records every table request (the calls chained before it was awaited), rpc and upload. */
function fakeClient(answer: (table: string, ops: Op[]) => any) {
  const f: any = { requests: [] as Array<{ table: string; ops: Op[] }>, rpcs: [] as Array<{ name: string; args: any }>, uploads: [] as any[],
    rpcAnswer: (_name: string, _args: any): any => ({ data: null, error: null }), uploadAnswer: (): any => ({ data: { path: 'x' }, error: null }) };
  f.from = (table: string) => {
    const ops: Op[] = [];
    const b: any = new Proxy({}, {
      get(_t, name) {
        if (name === 'then') return (res: any, rej: any) => { f.requests.push({ table, ops }); return Promise.resolve(answer(table, ops)).then(res, rej); };
        return (...a: any[]) => { ops.push([String(name), ...a]); return b; };
      },
    });
    return b;
  };
  f.client = () => ({
    auth: {
      storageKey: 'sb-test-auth-token',
      async getSession() { return { data: { session: null }, error: null }; },
      async getUser() { return { data: { user: null }, error: null }; },
      async signOut() { return { error: null }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      stopAutoRefresh() {},
    },
    from: f.from,
    rpc: (name: string, args: any) => { f.rpcs.push({ name, args }); const r: any = Promise.resolve(f.rpcAnswer(name, args)); r.abortSignal = () => r; return r; },
    channel() { const ch: any = { on: () => ch, subscribe: () => ch }; return ch; },
    removeChannel() {},
    functions: { invoke: async () => ({ data: null, error: null }) },
    storage: { from: (bucket: string) => ({ upload: async (path: string, body: any, options: any) => { f.uploads.push({ bucket, path, body, options }); return f.uploadAnswer(); } }) },
  });
  return f;
}
async function openPage(answer: (table: string, ops: Op[]) => any = () => ({ data: [], error: null })) {
  const f = fakeClient(answer);
  (globalThis as any).__fakeCreateClient = () => f.client();
  const data = await createSupabaseAdapter();
  return { f, data };
}
const has = (ops: Op[], name: string, ...args: any[]) => ops.some((o) => o[0] === name && JSON.stringify(o.slice(1)) === JSON.stringify(args));
const UUID_PATH = /^incoming\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|doc|docx|jpg|png)$/;

test('live: the CV is sent as a copy that carries the type of its ending, whatever type the browser gave the file', async () => {
  const { f, data } = await openPage();
  const cases: Array<[string, string, string]> = [
    ['CV.docx', '', CV_TYPES.docx],                                  // Windows without Office, or an Android file manager
    ['CV.docx', 'application/octet-stream', CV_TYPES.docx],
    ['photo.jpg', 'image/jpg', 'image/jpeg'],                         // how some phones name a JPG
    ['scan.JPEG', 'image/jpeg', 'image/jpeg'],
    ['cv.pdf', 'application/pdf', 'application/pdf'],
    ['document', 'application/pdf', 'application/pdf'],               // a phone's file with no name ending, known by its type
    ['IMG-20261012-WA0003', 'image/jpg', 'image/jpeg'],
  ];
  for (const [name, type, want] of cases) {
    const file = new File(['%PDF-1.4 a made-up CV'], name, { type });
    const path = await data.uploadJobCv(file);
    const up = f.uploads.at(-1);
    assert.equal(up.bucket, 'job-cvs');
    assert.equal(up.path, path);
    assert.match(path, UUID_PATH, name);
    assert.ok(path.endsWith('.' + Object.entries(CV_TYPES).find(([, t]) => t === want)![0]), `${name}: the ending of its type (${path})`);
    assert.ok(up.body instanceof Blob, name);
    assert.equal(up.body.type, want, `${name} typed "${type}" is uploaded as ${want}`);
    assert.equal(up.body.size, file.size);
    assert.equal(await up.body.text(), '%PDF-1.4 a made-up CV', 'the very same bytes');
    assert.deepEqual(up.options, { cacheControl: '0', contentType: want, upsert: false }, 'never an overwrite, and no cache keeps a copy');
  }
  assert.equal(new Set(f.uploads.map((u: any) => u.path)).size, cases.length, 'a new random name every time');
});

test('live: a CV the website check refuses is not uploaded at all', async () => {
  const { f, data } = await openPage();
  await assert.rejects(data.uploadJobCv(new File(['x'], 'cv.html', { type: 'text/html' })), (e: any) => /^FORM_CV: Your CV must be a PDF/.test(e.message) && e.field === 'cv');
  await assert.rejects(data.uploadJobCv(new File(['x'], 'cv.pdf', { type: 'text/html' })), /FORM_CV/);
  assert.equal(f.uploads.length, 0);
});

test('live: an upload refused by the limits says "a few minutes", or "tomorrow" once the day is full', async () => {
  const { f, data } = await openPage();
  const file = () => new File(['x'], 'cv.pdf', { type: 'application/pdf' });
  // the trigger on storage.objects (JOB_CV_LIMIT, which Storage gives as 403) or the policy's first check
  f.uploadAnswer = () => ({ data: null, error: { message: 'JOB_CV_LIMIT: no more CV uploads are taken this minute.', statusCode: '403' } });
  f.rpcAnswer = () => ({ data: 'minute', error: null });
  await assert.rejects(data.uploadJobCv(file()), /^Error: FORM_BUSY: many CVs are arriving right now/);
  f.rpcAnswer = () => ({ data: 'day', error: null });
  await assert.rejects(data.uploadJobCv(file()), /^Error: FORM_BUSY_DAY: many CVs have arrived today/);
  assert.deepEqual(f.rpcs.map((r: any) => r.name), ['job_cv_upload_busy', 'job_cv_upload_busy']);
  f.uploadAnswer = () => ({ data: null, error: { message: 'new row violates row-level security policy', statusCode: '403' } });
  await assert.rejects(data.uploadJobCv(file()), /FORM_BUSY_DAY/);
  f.uploadAnswer = () => ({ data: null, error: { message: 'mime type application/octet-stream is not supported', statusCode: '415' } });
  await assert.rejects(data.uploadJobCv(file()), (e: any) => /^FORM_CV: Your CV must be a PDF/.test(e.message) && e.field === 'cv');
  f.uploadAnswer = () => ({ data: null, error: { message: 'The object exceeded the maximum allowed size', statusCode: '413' } });
  await assert.rejects(data.uploadJobCv(file()), /FORM_CV: Your CV is larger than 5 MB/);
});

test('live: the inbox asks for every open complaint and the resolved ones of the last 90 days, each capped, newest first', async () => {
  const { f, data } = await openPage((_t, ops) => ({
    data: has(ops, 'eq', 'status', 'resolved')
      ? [{ id: 'r1', status: 'resolved', created_at: '2026-10-01T10:00:00Z', patient_id: null }]
      : [{ id: 'o1', status: 'new', created_at: '2026-10-12T10:00:00Z', patient_id: null }, { id: 'o2', status: 'in_progress', created_at: '2026-09-02T10:00:00Z', patient_id: null }],
    error: null,
  }));
  const rows = await data.complaints();
  assert.deepEqual(rows.map((r: any) => r.id), ['o1', 'r1', 'o2'], 'the two parts in one list, newest first');
  assert.equal(rows.truncated, undefined, 'nothing was cut');
  const [open, resolved] = f.requests;
  assert.equal(open.table, 'complaints');
  assert.ok(has(open.ops, 'in', 'status', ['new', 'in_progress']));
  assert.ok(has(open.ops, 'limit', 501), 'open complaints: up to 500, asked with one more to see a cut');
  assert.ok(has(resolved.ops, 'eq', 'status', 'resolved'));
  assert.ok(has(resolved.ops, 'limit', 201), 'resolved complaints: up to 200');
  const since = resolved.ops.find((o: Op) => o[0] === 'or')?.[1];
  assert.match(since, /^resolved_at\.gte\.\d{4}-\d{2}-\d{2},created_at\.gte\.\d{4}-\d{2}-\d{2}$/);
  const days = (Date.now() - Date.parse(since.slice(-10))) / 86400000;
  assert.ok(days > 89 && days < 92, 'resolved in the last 90 days: ' + since);
  assert.ok(!f.requests.some((r: any) => r.ops.some((o: Op) => o[0] === 'eq' && o[1] === 'source')), '"Everything": no source filter');
});

test('live: "Patients\' accounts" and "Website form" are filtered by the database; a cut list says so', async () => {
  const many = Array.from({ length: 501 }, (_, i) => ({ id: 'w' + i, status: 'new', created_at: new Date(Date.UTC(2026, 9, 12) - i * 60000).toISOString(), patient_id: null }));
  const { f, data } = await openPage((_t, ops) => ({ data: has(ops, 'eq', 'status', 'resolved') ? [] : many.slice(), error: null }));
  const rows = await data.complaints({ from: 'website' });
  assert.equal(rows.length, 500);
  assert.equal(rows.truncated, true, 'the page shows "Incomplete"');
  assert.equal(rows.cap, 500);
  assert.ok(f.requests.every((r: any) => has(r.ops, 'eq', 'source', 'website')));
  f.requests.length = 0;
  await data.complaints({ from: 'portal' });
  assert.ok(f.requests.length === 2 && f.requests.every((r: any) => has(r.ops, 'eq', 'source', 'portal')), 'a flood of website forms cannot push a patient\'s complaint off this list');
});

test('live: deleting a website form; "not removed" when the database refused (not an admin, or a patient\'s complaint)', async () => {
  let answer: any = { data: [{ id: 'c1' }], error: null };
  const { f, data } = await openPage(() => answer);
  await data.deleteComplaint('c1');
  const { table, ops } = f.requests[0];
  assert.equal(table, 'complaints');
  assert.ok(has(ops, 'delete') && has(ops, 'eq', 'id', 'c1') && has(ops, 'eq', 'source', 'website') && has(ops, 'select', 'id'));
  answer = { data: [], error: null };
  await assert.rejects(data.deleteComplaint('c2'), (e: any) => e.code === 'NOT_REMOVED' && /only Dr\. Ali \(admin\) can delete a website form/.test(e.message));
});

test('live: the Today page asks how many applications are New: a count only, no rows; nothing when the database is not updated yet', async () => {
  let answer: any = { data: null, count: 3, error: null };
  const { f, data } = await openPage(() => answer);
  assert.equal(await data.newJobApplications(), 3);
  const { table, ops } = f.requests[0];
  assert.equal(table, 'job_applications');
  assert.ok(has(ops, 'select', 'id', { count: 'exact', head: true }), 'head: true, so no row is sent');
  assert.ok(has(ops, 'eq', 'status', 'new'));
  answer = { data: null, count: null, error: null };
  assert.equal(await data.newJobApplications(), 0);
  answer = { data: null, count: null, error: { message: 'relation "public.job_applications" does not exist', code: '42P01' } };
  await assert.rejects(data.newJobApplications(), (e: any) => e.code === 'JOBS_MISSING');
});

// ======================================================================================= the demo adapter
async function demoAs(id: string) {
  const d: any = createDemoAdapter();
  await d.signInDemo(id);
  return d;
}

test('demo: the inbox narrows by source like the database, newest first', async () => {
  const d = await demoAs('s-admin');
  const all = await d.complaints();
  const web = await d.complaints({ from: 'website' });
  const portal = await d.complaints({ from: 'portal' });
  assert.ok(web.length >= 2 && web.every((c: any) => c.source === 'website'));
  assert.ok(portal.length >= 1 && portal.every((c: any) => (c.source || 'portal') === 'portal'));
  assert.equal(all.length, web.length + portal.length);
  assert.ok(all.every((c: any, i: number) => i === 0 || all[i - 1].created_at >= c.created_at), 'newest first');
});

test('demo: the number of New applications, for jobs.view only, and the hidden box under its new name', async () => {
  const admin = await demoAs('s-admin');
  const before = await admin.newJobApplications();
  assert.equal(before, (await admin.jobApplications({ status: 'new' })).length);
  assert.ok(before >= 1, 'a made-up New application');
  const coord = await demoAs('s-coord');
  await assert.rejects(coord.newJobApplications(), 'the clinic coordinator has no jobs.view');
  // A feedback form with the hidden box filled is thanked and not stored; one with a "website" field (which autofill may fill) is stored.
  const form = { kind: 'suggestion', topic: 'other', branch: 'none', message: 'A made-up suggestion for the test.', contact_me: false };
  const count = async () => (await admin.complaints({ from: 'website' })).length;
  const n = await count();
  assert.deepEqual(await admin.submitFeedback({ ...form, pf_trap: 'http://spam.example' }), { ok: true });
  assert.equal(await count(), n, 'the honeypot form was dropped');
  assert.deepEqual(await admin.submitFeedback({ ...form, website: 'https://example.com' }), { ok: true });
  assert.equal(await count(), n + 1, 'a filled "website" field drops nothing');
});

test('demo: only an admin deletes, and only a website form; its notes go with it', async () => {
  const coord = await demoAs('s-coord');
  const web = (await coord.complaints({ from: 'website' }))[0];
  await assert.rejects(coord.deleteComplaint(web.id), /NOT_REMOVED/);
  const admin = await demoAs('s-admin');
  const target = (await admin.complaints({ from: 'website' }))[0];
  await admin.replyComplaint(target.id, 'Junk (sample note).', true);
  const portal = (await admin.complaints({ from: 'portal' }))[0];
  await assert.rejects(admin.deleteComplaint(portal.id), /NOT_REMOVED/, "a patient's complaint is never deleted");
  const before = (await admin.complaints()).length;
  await admin.deleteComplaint(target.id);
  const after = await admin.complaints();
  assert.equal(after.length, before - 1);
  assert.ok(!after.some((c: any) => c.id === target.id));
  assert.ok(after.some((c: any) => c.id === portal.id));
});
