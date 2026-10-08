// Small copies ("thumbnails") of clinic photos: made in the browser (web/js/ui/photos.js), stored beside the photo and named in
// photos.thumb_path by uploadPhoto (web/js/data/supabase.js), signed with the record by getPatient, shown by the photo grids.
// The live adapter runs here against a stand-in for supabase-js (the real library is loaded from a CDN in the browser). What it pins down:
//   - the thumbnail path: same two folders (so the storage policies cover it), "thumbs", the photo's base name, always .jpg;
//   - the database in both states: with the thumb_path column the row names the copy; without it (PGRST204 / 42703: the audit
//     migration is not applied) the row is saved again without it, once per page load, and later uploads store no copy at all;
//   - a copy that cannot be made or stored never fails the photo, and a retried upload (same idempotency key) repeats nothing;
//   - getPatient signs the copy with the originals in ONE batch and prefers it for thumb_url; a file this role cannot read
//     (a failed signing) leaves the photo in the list with no link instead of failing, and is never replaced by an unsigned URL.
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
const { createSupabaseAdapter, thumbPathFor, isMissingThumbColumn } = await import('../web/js/data/supabase.js');
const { CONFIG } = await import('../web/js/config.js');
const { makeThumbnail, signThumbs } = await import('../web/js/ui/photos.js');
// A second copy of the adapter that was loaded with image transformations switched on (the flag is read once, when the file loads).
CONFIG.IMAGE_TRANSFORMS = true;
const withTransforms = await import('../web/js/data/supabase.js?transforms');
CONFIG.IMAGE_TRANSFORMS = false;

// ---- what supabase-js answers for these requests
const PGRST204 = { code: 'PGRST204', message: "Could not find the 'thumb_path' column of 'photos' in the schema cache" };
const PG42703 = { code: '42703', message: 'column "thumb_path" of relation "photos" does not exist' };
const PATIENT = '11111111-1111-4111-8111-111111111111';

/** A stand-in for supabase-js: records every upload and every photos insert, and answers as the test says. */
function fakeClient() {
  const f: any = {
    uploads: [] as Array<{ path: string; options: any; body: any }>,
    inserts: [] as any[],
    batches: [] as string[][], // every createSignedUrls call on clinic-photos
    single: [] as Array<{ path: string; options: any }>, // every createSignedUrl call
    tables: { photos: [] as any[] } as Record<string, any>,
    uploadError: null as null | ((path: string) => any), // returns an error object, throws an Error, or null
    insertError: null as null | ((row: any) => any),
    unsignable: new Set<string>(), // paths this person may not read
    batchThrows: false,
  };
  const sign = (path: string) => (f.unsignable.has(path)
    ? { path, signedUrl: null, error: 'Either the object does not exist or you do not have access to the object' }
    : { path, signedUrl: `https://signed.test/${path}?t=1`, error: null });
  f.from = (table: string) => {
    let op = 'select'; let payload: any = null; let single = false;
    const b: any = {
      select() { return b; }, eq() { return b; }, in() { return b; }, is() { return b; }, order() { return b; }, limit() { return b; },
      insert(row: any) { op = 'insert'; payload = row; return b; },
      maybeSingle() { single = true; return b; }, single() { single = true; return b; },
      then(resolve: any, reject: any) {
        let res: any;
        if (op === 'insert') {
          f.inserts.push({ table, row: payload });
          const error = f.insertError?.(payload);
          res = error ? { data: null, error, status: 400 } : { data: { id: `row-${f.inserts.length}`, ...payload }, error: null };
        } else {
          const t = f.tables[table];
          const rows = (typeof t === 'function' ? t() : t) ?? [];
          res = { data: single ? (rows[0] ?? null) : rows, error: null };
        }
        return Promise.resolve(res).then(resolve, reject);
      },
    };
    return b;
  };
  f.client = () => ({
    auth: {
      storageKey: 'sb-test-auth-token',
      // userId() reads the stored login first, then has the login server confirm that token.
      async getSession() { return { data: { session: { access_token: 'jwt-u1', user: { id: 'u1' } } }, error: null }; },
      async getUser() { return { data: { user: { id: 'u1' } }, error: null }; },
      async signOut() { return { error: null }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      stopAutoRefresh() {},
    },
    from: f.from,
    rpc: () => { const r: any = Promise.resolve({ data: [], error: null }); r.abortSignal = () => r; return r; },
    functions: { invoke: async () => ({ data: null, error: null }) },
    storage: {
      from: (bucket: string) => ({
        async upload(path: string, body: any, options: any) {
          f.uploads.push({ path, options, body });
          const e = f.uploadError?.(path);
          if (e instanceof Error) throw e;
          return e ? { data: null, error: e } : { data: { path }, error: null };
        },
        async createSignedUrls(paths: string[]) {
          if (bucket === 'clinic-photos') f.batches.push([...paths]);
          if (f.batchThrows) throw new Error('network');
          return { data: paths.map(sign), error: null };
        },
        async createSignedUrl(path: string, _ttl: number, options: any) {
          f.single.push({ path, options });
          const r = sign(path);
          return r.signedUrl ? { data: { signedUrl: r.signedUrl + '&transformed=1' }, error: null } : { data: null, error: { message: r.error } };
        },
      }),
    },
  });
  return f;
}

/** One page load: an adapter (its once-per-page memory is fresh) on a fresh stand-in client. */
async function openPage(mod: any = { createSupabaseAdapter }) {
  const f = fakeClient();
  (globalThis as any).__fakeCreateClient = () => f.client();
  const data = await mod.createSupabaseAdapter();
  return { f, data };
}
const file = (name = 'IMG_0001.PNG', type = 'image/png') => new File(['original bytes'], name, { type });
const thumb = () => new Blob(['small jpeg'], { type: 'image/jpeg' });
const upload = (data: any, over: any = {}) => data.uploadPhoto({ patientId: PATIENT, file: file(), viewLabel: 'Front', kind: 'edited', thumb: thumb(), ...over });

// ======================================================================================= the path
test('thumbPathFor: same two folders, a thumbs folder, the same base name, always .jpg', () => {
  assert.equal(thumbPathFor(`${PATIENT}/edited/2026-10-08_Front_ab12cd34.png`), `${PATIENT}/edited/thumbs/2026-10-08_Front_ab12cd34.jpg`);
  assert.equal(thumbPathFor(`${PATIENT}/raw/2026-10-08_X-ray-OPG_ab12cd34.JPEG`), `${PATIENT}/raw/thumbs/2026-10-08_X-ray-OPG_ab12cd34.jpg`);
  assert.equal(thumbPathFor(`${PATIENT}/raw/a.b.c.heic`), `${PATIENT}/raw/thumbs/a.b.c.jpg`, 'only the last extension goes');
  assert.equal(thumbPathFor(`${PATIENT}/raw/noextension`), `${PATIENT}/raw/thumbs/noextension.jpg`);
  assert.equal(thumbPathFor('demo/9f1c'), 'demo/thumbs/9f1c.jpg');
  // The storage policies read only folder 1 (patient) and folder 2 (raw or edited): the copy must keep both.
  const photo = `${PATIENT}/edited/x.png`;
  assert.deepEqual(thumbPathFor(photo).split('/').slice(0, 2), photo.split('/').slice(0, 2));
  assert.notEqual(thumbPathFor(photo), photo);
});

test('isMissingThumbColumn: the two answers of a database without the column, and nothing else', () => {
  assert.equal(isMissingThumbColumn(PGRST204), true);
  assert.equal(isMissingThumbColumn(PG42703), true);
  assert.equal(isMissingThumbColumn({ message: 'Could not find the thumb_path column' }), true, 'a proxy that drops the code still gives it away');
  assert.equal(isMissingThumbColumn({ code: 'PGRST204', message: "Could not find the 'other_col' column of 'photos' in the schema cache" }), false, 'another missing column is not ours');
  assert.equal(isMissingThumbColumn({ code: '42501', message: 'new row violates row-level security policy for table "photos"' }), false);
  assert.equal(isMissingThumbColumn({ code: '23505', message: 'duplicate key value violates unique constraint "photos_storage_path_key" (thumb_path)' }), false);
  assert.equal(isMissingThumbColumn(null), false);
});

// ======================================================================================= the browser side
type Call = [string, ...any[]];
/** Stand-ins for createImageBitmap and the canvas, recording what the thumbnail code asked of them. */
function browser({ width = 4000, height = 3000, decode = 'ok', toBlob = 'blob' }: { width?: number; height?: number; decode?: 'ok' | 'fail' | 'option-unsupported'; toBlob?: 'blob' | 'null' | 'throw' } = {}) {
  const calls: Call[] = [];
  const state: any = { canvas: null, closed: 0 };
  (globalThis as any).createImageBitmap = async (src: any, options?: any) => {
    calls.push(['createImageBitmap', options]);
    if (decode === 'fail') throw new DOMException('The source image could not be decoded.', 'InvalidStateError');
    if (decode === 'option-unsupported' && options) throw new TypeError("The provided value 'from-image' is not a valid enum value");
    return { width, height, close() { state.closed += 1; } };
  };
  (globalThis as any).document = {
    createElement(tag: string) {
      assert.equal(tag, 'canvas');
      const ctx: any = {
        set fillStyle(v: string) { calls.push(['fillStyle', v]); }, set imageSmoothingQuality(v: string) { calls.push(['smoothing', v]); },
        fillRect(...a: number[]) { calls.push(['fillRect', ...a]); }, drawImage(_b: any, ...a: number[]) { calls.push(['drawImage', ...a]); },
      };
      state.canvas = {
        width: 0, height: 0, getContext: () => ctx,
        toBlob(cb: (b: Blob | null) => void, type: string, quality: number) {
          calls.push(['toBlob', type, quality]);
          if (toBlob === 'throw') throw new Error('canvas is tainted');
          cb(toBlob === 'null' ? null : new Blob(['jpeg'], { type }));
        },
      };
      return state.canvas;
    },
  };
  return { calls, state };
}
const unbrowser = () => { delete (globalThis as any).createImageBitmap; delete (globalThis as any).document; };

test('makeThumbnail: a 4000x3000 photo becomes a 320x240 JPEG at quality 0.8, white background first, camera rotation applied, bitmap released', async () => {
  const { calls, state } = browser();
  const blob = await makeThumbnail(file('a.jpg', 'image/jpeg'));
  assert.equal(blob?.type, 'image/jpeg');
  assert.deepEqual([state.canvas.width, state.canvas.height], [320, 240]);
  assert.deepEqual(calls.find((c) => c[0] === 'createImageBitmap'), ['createImageBitmap', { imageOrientation: 'from-image' }]);
  assert.deepEqual(calls.filter((c) => c[0] === 'toBlob'), [['toBlob', 'image/jpeg', 0.8]]);
  const order = calls.map((c) => c[0]);
  assert.ok(order.indexOf('fillRect') < order.indexOf('drawImage'), 'the white fill comes before the picture (a transparent PNG would turn black)');
  assert.deepEqual(calls.find((c) => c[0] === 'fillStyle'), ['fillStyle', '#fff']);
  assert.deepEqual(calls.find((c) => c[0] === 'fillRect'), ['fillRect', 0, 0, 320, 240]);
  assert.deepEqual(calls.find((c) => c[0] === 'drawImage'), ['drawImage', 0, 0, 320, 240]);
  assert.equal(state.closed, 1);
  unbrowser();
});

test('makeThumbnail: the LONG edge is 320 (portrait too), a small picture is not enlarged, an extreme shape keeps at least 1 px', async () => {
  for (const [w, h, expected] of [[3000, 4000, [240, 320]], [1000, 1000, [320, 320]], [200, 100, [200, 100]], [320, 200, [320, 200]], [5000, 10, [320, 1]], [1, 5000, [1, 320]]] as const) {
    const { state } = browser({ width: w, height: h });
    assert.ok(await makeThumbnail(file()), `${w}x${h}`);
    assert.deepEqual([state.canvas.width, state.canvas.height], expected, `${w}x${h}`);
    unbrowser();
  }
});

test('makeThumbnail: a file the browser cannot decode (HEIC on desktop Chrome) gives null, never an error, and nothing is drawn', async () => {
  const { calls } = browser({ decode: 'fail' });
  assert.equal(await makeThumbnail(file('IMG_0002.HEIC', 'image/heic')), null);
  assert.equal(calls.filter((c) => c[0] === 'createImageBitmap').length, 2, 'tried with the camera-rotation option, then without');
  assert.ok(!calls.some((c) => c[0] === 'drawImage' || c[0] === 'toBlob'));
  unbrowser();
});

test('makeThumbnail: a browser that does not know imageOrientation: from-image still gets its thumbnail', async () => {
  const { calls, state } = browser({ decode: 'option-unsupported' });
  assert.ok(await makeThumbnail(file()));
  assert.deepEqual(state.canvas && [state.canvas.width, state.canvas.height], [320, 240]);
  assert.deepEqual(calls.filter((c) => c[0] === 'createImageBitmap').map((c) => c[1]), [{ imageOrientation: 'from-image' }, undefined]);
  unbrowser();
});

test('makeThumbnail: an encoder that gives nothing or fails, a missing createImageBitmap, no file: all null, and the bitmap is still released', async () => {
  for (const toBlob of ['null', 'throw'] as const) {
    const { state } = browser({ toBlob });
    assert.equal(await makeThumbnail(file()), null, toBlob);
    assert.equal(state.closed, 1, `${toBlob}: bitmap released`);
    unbrowser();
  }
  assert.equal(await makeThumbnail(file()), null, 'no createImageBitmap in this browser');
  browser();
  assert.equal(await makeThumbnail(null), null);
  unbrowser();
});

// ======================================================================================= uploadPhoto: the column is there
test('uploadPhoto, database WITH thumb_path: the original, then the copy at {folder}/thumbs/{name}.jpg, then the row naming it', async () => {
  const { f, data } = await openPage();
  const row = await upload(data, { idempotencyKey: 'aaaaaaaa-0000-4000-8000-000000000001' });
  assert.equal(f.uploads.length, 2);
  const [orig, small] = f.uploads;
  assert.match(orig.path, new RegExp(`^${PATIENT}/edited/[^/]+_Front_aaaaaaaa\\.png$`));
  assert.deepEqual(orig.options, { contentType: 'image/png', upsert: false });
  assert.equal(small.path, thumbPathFor(orig.path));
  assert.match(small.path, new RegExp(`^${PATIENT}/edited/thumbs/[^/]+_Front_aaaaaaaa\\.jpg$`));
  assert.deepEqual(small.options, { contentType: 'image/jpeg', upsert: false }, 'never an upsert: storage has no UPDATE policy, and a stored copy is final');
  assert.equal(f.inserts.length, 1);
  assert.equal(f.inserts[0].row.storage_path, orig.path);
  assert.equal(f.inserts[0].row.thumb_path, small.path);
  assert.equal(row.thumb_path, small.path);
});

test('uploadPhoto: a raw photo keeps its copy in raw/thumbs (same folders as the photo, so the same people may read it)', async () => {
  const { f, data } = await openPage();
  await upload(data, { kind: 'raw' });
  assert.match(f.uploads[1].path, new RegExp(`^${PATIENT}/raw/thumbs/`));
  assert.equal(f.inserts[0].row.thumb_path, f.uploads[1].path);
});

test('uploadPhoto: no copy given (the browser could not read the file): one upload, and the row has no thumb_path at all', async () => {
  const { f, data } = await openPage();
  const row = await upload(data, { thumb: null, file: file('IMG_0003.HEIC', 'image/heic') });
  assert.equal(f.uploads.length, 1);
  assert.ok(!('thumb_path' in f.inserts[0].row));
  assert.ok(row.id);
});

// ======================================================================================= uploadPhoto: the column is missing
for (const [name, error] of [['PGRST204', PGRST204], ['42703', PG42703]] as const) {
  test(`uploadPhoto, database WITHOUT thumb_path (${name}): the photo is saved again without it, and only once per page load`, async () => {
    const { f, data } = await openPage();
    f.insertError = (row: any) => ('thumb_path' in row ? error : null); // what a database without the column answers
    const first = await upload(data);
    assert.equal(f.inserts.length, 2, 'tried with thumb_path, then without');
    assert.ok('thumb_path' in f.inserts[0].row && !('thumb_path' in f.inserts[1].row));
    assert.ok(first.id && !('thumb_path' in first), 'the photo is saved');
    assert.equal(f.uploads.length, 2, 'this first upload had already stored its copy before the row said no');

    // later uploads on this page: no retry dance, and no copy stored that nothing could point to
    const second = await upload(data, { file: file('IMG_0004.PNG') });
    assert.equal(f.inserts.length, 3, 'one insert for the second photo');
    assert.ok(!('thumb_path' in f.inserts[2].row));
    assert.equal(f.uploads.length, 3, 'only the original of the second photo was stored');
    assert.ok(second.id);
    const third = await upload(data, { file: file('IMG_0005.PNG') });
    assert.equal(f.inserts.length, 4);
    assert.ok(third.id);

    // a reload forgets it: the next page tries the column again (the owner may have run the migration meanwhile)
    const reloaded = await openPage();
    reloaded.f.insertError = () => null;
    const row = await upload(reloaded.data);
    assert.equal(row.thumb_path, reloaded.f.uploads[1].path);
  });
}

test('uploadPhoto: any other database error is still an error (no retry without the column, and the column is not written off)', async () => {
  const { f, data } = await openPage();
  f.insertError = () => ({ code: '42501', message: 'new row violates row-level security policy for table "photos"' });
  await assert.rejects(() => upload(data), /row-level security/);
  assert.equal(f.inserts.length, 1, 'no second insert');
  f.insertError = null;
  const row = await upload(data, { file: file('IMG_0006.PNG') });
  assert.ok(row.thumb_path, 'the next upload still tries the column');
  // and a missing OTHER column is not mistaken for ours
  f.insertError = () => ({ code: 'PGRST204', message: "Could not find the 'view_label2' column of 'photos' in the schema cache" });
  await assert.rejects(() => upload(data, { file: file('IMG_0007.PNG') }), /view_label2/);
});

// ======================================================================================= a thumbnail never fails the photo
for (const [name, uploadError] of [
  ['answers with an error', () => ({ message: 'Payload too large', statusCode: '413' })],
  ['throws (network)', () => new Error('Failed to fetch')],
] as const) {
  test(`uploadPhoto: a copy whose upload ${name} does not fail the photo; the row simply has no thumb_path`, async () => {
    const { f, data } = await openPage();
    f.uploadError = (path: string) => (path.includes('/thumbs/') ? uploadError() : null);
    const row = await upload(data);
    assert.equal(f.uploads.length, 2, 'the original went up, the copy was tried');
    assert.equal(f.inserts.length, 1);
    assert.ok(!('thumb_path' in f.inserts[0].row), 'a copy that is not in storage is not named');
    assert.ok(row.id && row.storage_path.includes('/edited/') && !row.storage_path.includes('/thumbs/'));
  });
}

test('uploadPhoto: a copy that "already exists" (an earlier attempt stored it) counts as stored', async () => {
  const { f, data } = await openPage();
  f.uploadError = (path: string) => (path.includes('/thumbs/') ? { message: 'The resource already exists', statusCode: '409' } : null);
  const row = await upload(data);
  assert.equal(row.thumb_path, f.uploads[1].path);
});

test('uploadPhoto: the original failing is still an error, and then no copy is stored and no row is saved', async () => {
  const { f, data } = await openPage();
  f.uploadError = () => ({ message: 'Bucket not found', statusCode: '404' });
  await assert.rejects(() => upload(data), /Bucket not found/);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.inserts.length, 0);
});

// ======================================================================================= retries keep working
test('uploadPhoto: pressing Save again after the row failed repeats no upload, keeps the copy, and a finished photo is answered from memory', async () => {
  const { f, data } = await openPage();
  const key = 'bbbbbbbb-0000-4000-8000-000000000002';
  let failures = 1;
  f.insertError = () => (failures-- > 0 ? { message: 'Failed to fetch', code: '' } : null);
  await assert.rejects(() => upload(data, { idempotencyKey: key }), /Failed to fetch/);
  assert.equal(f.uploads.length, 2, 'original and copy are stored');
  const row = await upload(data, { idempotencyKey: key });
  assert.equal(f.uploads.length, 2, 'the retry uploads nothing again');
  assert.equal(f.inserts.length, 2);
  assert.equal(f.inserts[1].row.thumb_path, f.uploads[1].path, 'the retry still names the copy');
  assert.equal(f.inserts[1].row.storage_path, f.uploads[0].path, 'same path as the first attempt');
  assert.equal(await upload(data, { idempotencyKey: key }), row, 'a third press returns the saved photo');
  assert.equal(f.inserts.length, 2);
});

test('uploadPhoto: a retry whose first attempt could not store the copy tries the copy again, and the original is not uploaded twice', async () => {
  const { f, data } = await openPage();
  const key = 'cccccccc-0000-4000-8000-000000000003';
  let thumbFails = true; let rowFails = true;
  f.uploadError = (path: string) => (path.includes('/thumbs/') && thumbFails ? { message: 'Gateway timeout', statusCode: '504' } : null);
  f.insertError = () => (rowFails ? { message: 'Failed to fetch' } : null);
  await assert.rejects(() => upload(data, { idempotencyKey: key }));
  thumbFails = false; rowFails = false;
  const row = await upload(data, { idempotencyKey: key });
  assert.equal(f.uploads.filter((u: any) => !u.path.includes('/thumbs/')).length, 1, 'the original went up once');
  assert.equal(f.uploads.filter((u: any) => u.path.includes('/thumbs/')).length, 2, 'the copy was tried twice');
  assert.equal(row.thumb_path, thumbPathFor(f.uploads[0].path));
});

// ======================================================================================= getPatient: signing
const photoRow = (id: string, extra: any = {}) => ({ id, patient_id: PATIENT, kind: 'edited', taken_on: '2026-10-08', view_label: id, storage_path: `${PATIENT}/edited/${id}.png`, ...extra });
const thumbOf = (id: string) => `${PATIENT}/edited/thumbs/${id}.jpg`;
async function patientWith(photos: any[], configure?: (f: any) => void, mod?: any) {
  const { f, data } = await openPage(mod);
  f.tables.patients = [{ id: PATIENT, full_name: 'Test Patient' }];
  f.tables.photos = photos;
  configure?.(f);
  return { f, p: await data.getPatient(PATIENT) };
}
const batchesOfPhotos = (f: any) => f.batches;

test('getPatient: a photo with thumb_path gets the copy as thumb_url, signed in the SAME batch as the originals; the full link stays the original', async () => {
  const { f, p } = await patientWith([photoRow('a', { thumb_path: thumbOf('a') }), photoRow('b', { thumb_path: thumbOf('b') })]);
  assert.equal(batchesOfPhotos(f).length, 1, 'one createSignedUrls call for everything');
  assert.deepEqual([...batchesOfPhotos(f)[0]].sort(), [`${PATIENT}/edited/a.png`, `${PATIENT}/edited/b.png`, thumbOf('a'), thumbOf('b')].sort());
  const a = p.photos.find((x: any) => x.id === 'a');
  assert.equal(a.thumb_url, `https://signed.test/${thumbOf('a')}?t=1`);
  assert.equal(a.url, `https://signed.test/${PATIENT}/edited/a.png?t=1`, 'full size is the original');
  assert.ok(a.url_expires_at > Date.now());
  assert.equal(f.single.length, 0, 'no per-image requests');
});

test('getPatient: a photo without thumb_path (every photo from before, or a database without the column) keeps today\'s behaviour: the original is its thumbnail', async () => {
  const { f, p } = await patientWith([photoRow('old')]);
  assert.deepEqual(batchesOfPhotos(f), [[`${PATIENT}/edited/old.png`]]);
  assert.equal(p.photos[0].thumb_url, p.photos[0].url);
  assert.equal(p.photos[0].url, `https://signed.test/${PATIENT}/edited/old.png?t=1`);
});

test('getPatient: a mixed list gets the copy where there is one and the original elsewhere', async () => {
  const { p } = await patientWith([photoRow('new', { thumb_path: thumbOf('new') }), photoRow('old', { thumb_path: null })]);
  const [n, o] = [p.photos.find((x: any) => x.id === 'new'), p.photos.find((x: any) => x.id === 'old')];
  assert.match(n.thumb_url, /thumbs\/new\.jpg/);
  assert.equal(o.thumb_url, o.url);
});

test('getPatient: a copy that cannot be signed falls back to the original link (when this role can sign the original)', async () => {
  const { p } = await patientWith([photoRow('a', { thumb_path: thumbOf('a') })], (f) => f.unsignable.add(thumbOf('a')));
  assert.equal(p.photos[0].thumb_url, p.photos[0].url);
  assert.ok(p.photos[0].url);
});

test('getPatient: a role that may read neither the raw photo nor its copy keeps the photo in the list with no links, and never an unsigned URL', async () => {
  const raw = photoRow('r', { kind: 'raw', storage_path: `${PATIENT}/raw/r.png`, thumb_path: `${PATIENT}/raw/thumbs/r.jpg` });
  const edited = photoRow('e', { thumb_path: thumbOf('e') });
  const { p } = await patientWith([raw, edited], (f) => { f.unsignable.add(raw.storage_path); f.unsignable.add(raw.thumb_path); });
  assert.equal(p.photos.length, 2, 'the entry stays');
  const r = p.photos.find((x: any) => x.id === 'r');
  assert.equal(r.url, null);
  assert.equal(r.thumb_url, null, 'no link at all: the grid shows its placeholder');
  assert.equal(r.url_expires_at > Date.now(), true);
  assert.equal(r.storage_path, `${PATIENT}/raw/r.png`, 'the grid can still say what it is and try again later');
  const e = p.photos.find((x: any) => x.id === 'e');
  assert.match(e.thumb_url, /thumbs\/e\.jpg/, 'the readable photo next to it is not affected');
});

test('getPatient: a signing request that fails altogether leaves every photo in the list without links, and the record still loads', async () => {
  const { p } = await patientWith([photoRow('a', { thumb_path: thumbOf('a') })], (f) => { f.batchThrows = true; });
  assert.equal(p.photos.length, 1);
  assert.equal(p.photos[0].url, null);
  assert.equal(p.photos[0].thumb_url, null);
  assert.equal(p.full_name, 'Test Patient');
});

test('getPatient with image transformations on: stored copy first, then a resized original, then the original', async () => {
  const photos = [photoRow('has', { thumb_path: thumbOf('has') }), photoRow('plain')];
  const { f, p } = await patientWith(photos, undefined, withTransforms);
  const has = p.photos.find((x: any) => x.id === 'has'); const plain = p.photos.find((x: any) => x.id === 'plain');
  assert.match(has.thumb_url, /thumbs\/has\.jpg\?t=1$/, 'the stored copy wins, no transform of the original is asked for');
  assert.match(plain.thumb_url, /plain\.png\?t=1&transformed=1$/, 'a photo without a copy gets the resized original');
  assert.deepEqual(f.single.map((s: any) => [s.path, s.options?.transform?.width]), [[`${PATIENT}/edited/plain.png`, 240]], 'one transform request, for the photo that has no copy');
  assert.equal(plain.url, `https://signed.test/${PATIENT}/edited/plain.png?t=1`, 'full size stays the original');
  assert.equal(f.batches.length, 1);
  // a resized original that cannot be signed leaves the original
  const none = await patientWith([photoRow('x')], (g) => { g.unsignable.add(`${PATIENT}/edited/x.png`); }, withTransforms);
  assert.equal(none.p.photos[0].thumb_url, null);
});

// ======================================================================================= the grids' re-signing
test('signThumbs: stored copies are signed as they are (no resize), the others as resized originals, one call each; what cannot be signed is left out', async () => {
  const calls: any[] = [];
  const d = { async signedUrls(paths: string[], opts?: any) { calls.push([paths, opts]); return new Map(paths.filter((p) => !p.includes('denied')).map((p) => [p, `signed:${p}`])); } };
  const photos = [
    { storage_path: 'p/edited/a.png', thumb_path: 'p/edited/thumbs/a.jpg' },
    { storage_path: 'p/edited/b.png' },
    { storage_path: 'p/raw/denied.png', thumb_path: 'p/raw/thumbs/denied.jpg' },
    { storage_path: 'p/raw/denied2.png' },
  ];
  const out = await signThumbs(d, photos, 240);
  assert.deepEqual(calls, [[['p/edited/thumbs/a.jpg', 'p/raw/thumbs/denied.jpg'], undefined], [['p/edited/b.png', 'p/raw/denied2.png'], { width: 240 }]]);
  assert.deepEqual([...out], [['p/edited/a.png', 'signed:p/edited/thumbs/a.jpg'], ['p/edited/b.png', 'signed:p/edited/b.png']]);
  // a failing request gives an empty answer, not an error
  const broken = { async signedUrls() { throw new Error('offline'); } };
  assert.equal((await signThumbs(broken, photos, 240)).size, 0);
  assert.equal((await signThumbs(d, [], 240)).size, 0);
});

// ======================================================================================= demo mode keeps the same shape
test('demo adapter: an uploaded photo keeps its small copy the way the live site does (thumb_path, thumb_url), and signedUrls answers for both paths', async () => {
  (globalThis as any).FileReader = class {
    result: any; onload: any; onerror: any;
    readAsDataURL(blob: Blob) { blob.arrayBuffer().then((b) => { this.result = `data:${blob.type};base64,${Buffer.from(b).toString('base64')}`; this.onload(); }, (e) => this.onerror(e)); }
  };
  const { createDemoAdapter } = await import('../web/js/data/demo.js');
  const d = createDemoAdapter();
  const staff = (await d.demoAccounts()).find((a: any) => a.role === 'admin');
  await d.signInDemo(staff.id);
  const patient = (await d.searchPatients(''))[0];
  const withCopy = await d.uploadPhoto({ patientId: patient.id, file: file('a.png'), viewLabel: 'Front', kind: 'edited', thumb: thumb() });
  const without = await d.uploadPhoto({ patientId: patient.id, file: file('b.png'), viewLabel: 'Smile', kind: 'edited' });
  assert.equal(withCopy.thumb_path, thumbPathFor(withCopy.storage_path));
  assert.match(withCopy.thumb_url, /^data:image\/jpeg;base64,/);
  assert.match(withCopy.url, /^data:image\/png;base64,/);
  assert.equal(without.thumb_path, null);
  assert.equal(without.thumb_url, null);
  const rec = await d.getPatient(patient.id);
  const got = rec.photos.find((x: any) => x.id === withCopy.id);
  assert.equal(got.thumb_url, withCopy.thumb_url);
  const urls = await d.signedUrls([withCopy.thumb_path, withCopy.storage_path, without.storage_path, 'demo/nothing']);
  assert.equal(urls.get(withCopy.thumb_path), withCopy.thumb_url);
  assert.equal(urls.get(withCopy.storage_path), withCopy.url);
  assert.equal(urls.get(without.storage_path), without.url);
  assert.equal(urls.has('demo/nothing'), false);
  // the same helper the grids use gives the small copy first
  const small = await signThumbs(d, [got], 240);
  assert.equal(small.get(got.storage_path), withCopy.thumb_url);
  delete (globalThis as any).FileReader;
});
