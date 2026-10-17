// The Photo inbox's pure rules (web/js/lib/photo-intake.js): capture times from EXIF, file counters, grouping a day's photos into
// sittings, matching the whole day to the city's visits (the ten worked examples of the spec, section 7.11), names, and the edit maths.
// Made-up people only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readExif, withExif, parseExifDate, captureTime, fileSeq, cameraKey, sniffType, inboxPaths, citySlug, karachiDate, karachiClock, dayLabel,
  groupItems, visitFacts, scorePair, assignDay, planDay, planUnchanged, waitSentence, WAIT_REASONS,
  VIEW_KEYS, KINDS, viewName, occasionLabel, viewLabel, downloadName, uniqueNames, editPlan, adjustPixels, GAP_SEC, MIN_PAIR,
  cameraClocks, editTransform, isConnectionProblem, noteMrs, noteMonth, noteWords, noteNameFit, oldPhotoTime, groupOld, ONE_VISIT_SEC,
} from '../web/js/lib/photo-intake.js';
import { storageProblem } from '../web/js/data/supabase-inbox.js';
import { VIEW_KEYS as CORE_VIEWS, KINDS as CORE_KINDS } from '../supabase/functions/photo-ai/core.ts';

const JPEG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xFF, 0xD9]);
const DAY = '2026-10-16';
const at = (hm: string, s = 0, day = DAY) => new Date(`${day}T${hm}:${String(s).padStart(2, '0')}+05:00`).toISOString();

// ---------------------------------------------------------------- EXIF
test('readExif: little and big endian, DateTimeOriginal, offset, sub-seconds, orientation, camera', () => {
  for (const bigEndian of [false, true]) {
    const bytes = withExif(JPEG, { make: 'Apple', model: 'iPhone 13', orientation: 6, dateTimeOriginal: '2026:10:16 18:35:40', offsetTimeOriginal: '+05:00', subSecTimeOriginal: '25' }, { bigEndian });
    const e = readExif(bytes)!;
    assert.equal(e.make, 'Apple');
    assert.equal(e.model, 'iPhone 13');
    assert.equal(e.orientation, 6);
    assert.equal(e.dateTimeOriginal, '2026:10:16 18:35:40');
    assert.equal(e.offsetTimeOriginal, '+05:00');
    assert.equal(e.subSecTimeOriginal, '25');
  }
});
test('readExif: an EXIF block found by scanning (a HEIC-like file), none, cut-off and garbage bytes never throw', () => {
  const withBlock = withExif(JPEG, { make: 'Apple', dateTimeOriginal: '2026:10:16 18:00:00' });
  const app1 = withBlock.subarray(2 + 4); // "Exif\0\0" + TIFF
  const heicLike = new Uint8Array(40 + app1.length);
  heicLike.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63], 0); // ....ftypheic
  heicLike.set(app1, 40);
  assert.equal(readExif(heicLike)?.dateTimeOriginal, '2026:10:16 18:00:00');
  assert.equal(readExif(JPEG), null, 'no EXIF');
  for (let cut = 0; cut < withBlock.length; cut += 7) assert.doesNotThrow(() => readExif(withBlock.subarray(0, cut)));
  const junk = new Uint8Array(4096);
  for (let i = 0; i < junk.length; i++) junk[i] = (i * 7919) & 0xFF;
  junk.set([0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 0x2A, 0, 0xFF, 0xFF, 0xFF, 0x7F], 100);
  assert.doesNotThrow(() => readExif(junk));
  assert.equal(readExif(new Uint8Array(0)), null);
  assert.equal(readExif(null as any), null);
});
test('captureTime: Karachi wall time, Digitized, DateTime only (exif_modified), file date, a picker date, wrong clocks, midnight', () => {
  const upload = Date.parse(at('22:00'));
  const t = captureTime({ exif: { make: 'Apple', model: 'iPhone 13', dateTimeOriginal: '2026:10:16 18:35:00' }, uploadedAt: upload, pickedAt: upload });
  assert.equal(t.taken_at, at('18:35'));
  assert.equal(t.time_source, 'exif');
  assert.ok(t.clock_ok && t.time_ok);
  assert.equal(t.photo_day, DAY);
  assert.equal(t.camera, 'apple|iphone 13');
  const dubai = captureTime({ exif: { dateTimeOriginal: '2026:10:16 18:35:00', offsetTimeOriginal: '+04:00' }, uploadedAt: upload });
  assert.equal(Date.parse(dubai.taken_at!) - Date.parse(t.taken_at!), 60 * 60 * 1000, 'an offset of +04:00 is an hour later');
  assert.equal(captureTime({ exif: { dateTimeDigitized: '2026:10:16 18:35:00' }, uploadedAt: upload }).time_source, 'exif');
  const modified = captureTime({ exif: { dateTime: '2026:10:16 18:35:00' }, uploadedAt: upload });
  assert.equal(modified.time_source, 'exif_modified');
  assert.equal(modified.time_ok, false);
  const fileDate = captureTime({ lastModified: Date.parse(at('17:00')), pickedAt: upload, uploadedAt: upload });
  assert.equal(fileDate.time_source, 'file_date');
  assert.equal(captureTime({ lastModified: upload - 5 * 60 * 1000, pickedAt: upload, uploadedAt: upload }).time_source, 'none', 'a date the picker made up');
  const old = captureTime({ exif: { dateTimeOriginal: '2026:10:08 18:00:00' }, uploadedAt: upload });
  assert.equal(old.clock_ok, false, '8 days old');
  assert.equal(old.photo_day, DAY, 'a wrong clock files under the upload day');
  assert.equal(captureTime({ exif: { dateTimeOriginal: '2026:10:16 22:20:00' }, uploadedAt: upload }).clock_ok, false, '20 minutes in the future');
  assert.equal(captureTime({ exif: { dateTimeOriginal: '2026:10:17 00:05:00' }, uploadedAt: Date.parse(at('01:00', 0, '2026-10-17')) }).photo_day, '2026-10-17');
  assert.equal(captureTime({ exif: { dateTimeOriginal: '0000:00:00 00:00:00' }, uploadedAt: upload }).time_source, 'none');
  assert.equal(parseExifDate('2026:13:01 00:00:00'), null);
  assert.equal(cameraKey('', ''), 'unknown');
  assert.equal(cameraKey(' Samsung ', 'SM  A546E'), 'samsung|sm a546e');
});
test('Karachi dates and clocks', () => {
  assert.equal(karachiDate('2026-10-16T19:30:00Z'), '2026-10-17');
  assert.equal(karachiClock(at('18:35')), '6:35 PM');
  assert.equal(karachiClock(at('00:05')), '12:05 AM');
  assert.equal(dayLabel('2026-10-16'), 'Fri 16 Oct');
});
test('fileSeq: counters and names made of a date', () => {
  assert.deepEqual(fileSeq('IMG_1234.JPG'), { prefix: 'IMG_', seq: 1234 });
  assert.deepEqual(fileSeq('DSC01234.jpg'), { prefix: 'DSC', seq: 1234 });
  assert.equal(fileSeq('IMG_20261017_183012.jpg'), null);
  assert.equal(fileSeq('PXL_20261017_183012345.jpg'), null);
  assert.equal(fileSeq('Screenshot_2026-10-17-18-30-12.png'), null);
  assert.equal(fileSeq('photo.jpg'), null);
});
test('sniffType, paths and city folders', () => {
  assert.deepEqual(sniffType(JPEG, 'a.jpg', 100), { ok: true, ext: 'jpg', mime: 'image/jpeg' });
  assert.deepEqual(sniffType(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), 'b.png', 100), { ok: true, ext: 'png', mime: 'image/png' });
  assert.equal(sniffType(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]), 'c.HEIC', 100).ext, 'heic');
  assert.equal(sniffType(JPEG, 'raw.DNG', 100).reason, 'RAW camera file: choose the JPEG');
  assert.equal(sniffType(new Uint8Array(12), 'clip.mov', 100, 'video/quicktime').reason, 'Not a photo');
  assert.equal(sniffType(JPEG, 'big.jpg', 60 * 1024 * 1024).reason, 'Larger than 50 MB');
  assert.equal(sniffType(new Uint8Array(12), 'broken.jpg', 100).reason, 'Damaged or not a photo');
  const p = inboxPaths({ citySlug: 'karachi', day: DAY, sha: 'ab'.repeat(32), ext: 'jpg' });
  assert.equal(p.path, `inbox/karachi/${DAY}/${'ab'.repeat(32)}.jpg`);
  assert.equal(p.thumb, `inbox/karachi/${DAY}/thumbs/${'ab'.repeat(32)}.jpg`);
  assert.equal(p.editedThumb, `inbox/karachi/${DAY}/edited/thumbs/${'ab'.repeat(32)}.jpg`);
  assert.deepEqual(['Karachi', 'Lahore', 'Islamabad', 'Dera Ghazi Khan'].map(citySlug), ['karachi', 'lahore', 'islamabad', 'dera-ghazi-khan']);
});

// ---------------------------------------------------------------- grouping
let n = 0;
type Item = Record<string, any>;
const item = (t: string | null, o: Item = {}): Item => {
  n += 1;
  const seq = o.seq ?? null;
  return { item_id: o.id || `i${String(n).padStart(4, '0')}`, sha256: `s${n}`, taken_at: t, time_source: t ? 'exif' : 'none', clock_ok: !!t,
    camera: 'apple|iphone 13', branch_hint: null, file_seq_prefix: seq === null ? null : 'IMG_', file_seq: seq, file_name: seq === null ? `photo${n}.jpg` : `IMG_${seq}.JPG`,
    set_id: null, ...o };
};
const ids = (groups: Array<{ item_ids: string[] }>) => groups.map((g) => g.item_ids);

test('groupItems: 179 s stays one set, 181 s starts a new one; the 15-minute cap; counters back or jumping', () => {
  const a = item(at('18:00', 0), { seq: 1 }); const b = item(at('18:02', 59), { seq: 2 }); const c = item(at('18:06', 0), { seq: 3 });
  assert.deepEqual(ids(groupItems([a, b, c])), [[a.item_id, b.item_id], [c.item_id]]);
  const chain = Array.from({ length: 10 }, (_, i) => item(new Date(Date.parse(at('19:01')) + i * 120000).toISOString(), { seq: 10 + i }));
  // 19:01 ... 19:19 every 2 minutes: one set until 15 minutes after its first photo (19:01-19:15), then a new one (19:17, 19:19)
  assert.deepEqual(groupItems(chain).map((x) => x.item_ids.length), [8, 2], 'capped at 15 minutes');
  const back = [item(at('20:00', 0), { seq: 50 }), item(at('20:00', 30), { seq: 49 })];
  assert.equal(groupItems(back).length, 2, 'the counter went back: a second phone of the same model');
  const jump = [item(at('20:10', 0), { seq: 100 }), item(at('20:10', 30), { seq: 140 })];
  assert.equal(groupItems(jump).length, 2, 'the counter jumped more than 30');
  assert.equal(groupItems([item(at('20:20', 0), { seq: 100 }), item(at('20:20', 30), { seq: 125 })]).length, 1);
});
test('groupItems: two cameras interleaved stay apart; photos without a time are each a set; wrong clocks group by gaps', () => {
  const a1 = item(at('18:00', 0)); const b1 = item(at('18:00', 20), { camera: 'samsung|a54' }); const a2 = item(at('18:00', 40)); const b2 = item(at('18:01', 0), { camera: 'samsung|a54' });
  assert.deepEqual(ids(groupItems([a1, b1, a2, b2])).map((x) => x.length), [2, 2]);
  const x1 = item(null); const x2 = item(null);
  assert.equal(groupItems([x1, x2]).length, 2);
  const w1 = item('2019-03-12T11:10:00.000Z', { clock_ok: false }); const w2 = item('2019-03-12T11:11:00.000Z', { clock_ok: false }); const w3 = item('2019-03-12T11:30:00.000Z', { clock_ok: false });
  assert.deepEqual(ids(groupItems([w1, w2, w3])).map((x) => x.length), [2, 1]);
  assert.equal(groupItems([item(at('18:00')), item(at('18:00', 30), { branch_hint: 3 })]).length, 2, 'another branch hint is another stream');
});
test('groupItems: photos right after a filed set of the same camera join it; never a set a person changed', () => {
  const f1 = item(at('18:30', 0), { seq: 5, set_id: 'F' }); const f2 = item(at('18:31', 0), { seq: 6, set_id: 'F' });
  const late = item(at('18:33', 30), { seq: 7 });
  const filed = { set_id: 'F', status: 'filed', manual: false, camera: 'apple|iphone 13', branch_hint: null, items: [f1, f2] };
  assert.deepEqual(groupItems([late], [filed]), [{ item_ids: [late.item_id], join_set_id: 'F' }]);
  assert.deepEqual(groupItems([late], [{ ...filed, manual: true }]), [{ item_ids: [late.item_id], join_set_id: null }]);
  assert.equal(groupItems([item(at('18:35', 0), { seq: 8 })], [filed])[0].join_set_id, null, 'more than 3 minutes after');
  assert.equal(groupItems([item(at('18:32', 0), { seq: 7, clock_ok: false })], [filed])[0].join_set_id, null, 'only photos with a usable time join');
});

// ---------------------------------------------------------------- matching
type V = Record<string, any>;
const visit = (id: string, o: V = {}): V => ({
  visit_id: id, patient_id: `p-${id}`, full_name: `Sample ${id}`, mr_number: `5${id.replace(/\D/g, '').padStart(4, '0')}`, branch_id: 3, visit_date: DAY,
  token_no: 1, status: 'completed', created_at: at('16:00'), checked_in_at: null, started_at: null, completed_at: null, legacy: false,
  photo_required: false, braces_month: null, treatment_label: 'Monthly', photos_uploaded: false, photo_count: 0, filed_set_ids: [], ...o,
});
const day = (visits: V[], items: Item[], sets: V[] = []) => ({ city: { id: 1, name: 'Karachi', slug: 'karachi' }, day: DAY, hold_hours: 24,
  branches: [{ id: 1, code: 'GUL' }, { id: 2, code: 'NN' }, { id: 3, code: 'DHA' }], visits, items, sets });
const sitting = (from: string, count: number, o: Item = {}) => Array.from({ length: count }, (_, i) => item(new Date(Date.parse(at(from)) + i * 20000).toISOString(), { branch_hint: 3, ...o }));
const groupOf = (plan: any, first: Item) => plan.groups.find((g: any) => g.item_ids.includes(first.item_id));

test('visitFacts: imported rows have no times, bulk completions give no end, typed-in-completed rows, start beats check-in', () => {
  const vs = [
    visit('a', { started_at: at('18:00'), checked_in_at: at('17:50'), completed_at: at('20:55', 0) }),
    visit('b', { started_at: at('18:20'), completed_at: at('20:55', 30) }),
    visit('c', { started_at: at('18:40'), completed_at: at('20:56', 30) }),
    visit('d', { legacy: true, created_at: at('05:00'), completed_at: at('01:00') }),
    visit('e', { created_at: at('19:33'), completed_at: at('19:33', 20) }),
    visit('f', { checked_in_at: at('17:20') }),
  ];
  const f = Object.fromEntries(visitFacts(vs).map((x: any) => [x.visit_id, x]));
  assert.equal(f.a.anchor_kind, 'start');
  assert.equal(f.a.end, null, '3 completions within 120 s are marked in one go');
  assert.ok(f.a.bulk_fields.includes('completed_at'));
  assert.equal(f.d.quality, 'none', 'an imported row has no real time');
  assert.equal(f.e.quality, 'late_entry');
  assert.equal(f.e.end, Date.parse(at('19:33')));
  assert.equal(f.f.anchor_kind, 'checkin');
});

test('example 1: the clear case files by itself, with the rule sentence', () => {
  const s = sitting('18:35', 7);
  const vs = [visit('ayesha', { photo_required: true, braces_month: 10, started_at: at('18:31'), completed_at: at('18:49') }),
    visit('bilal', { braces_month: 5, started_at: at('18:13'), completed_at: at('18:23') }),
    visit('hina', { photo_required: true, braces_month: 15, started_at: at('19:48') })];
  const plan = planDay(day(vs, s));
  const g = groupOf(plan, s[0]);
  assert.equal(plan.groups.length, 1);
  assert.equal(g.auto?.visit_id, 'ayesha');
  assert.equal(g.auto.rule, 'Automatic: the only photo-month patient in the chair at 6:35 PM (DHA)');
  assert.equal(g.wait_reason, null);
  assert.equal(g.candidates[0].visit_id, 'ayesha');
  assert.equal(g.candidates[0].score, 160);
});
test('example 2: two photo-month patients overlapping: both wait (AMBIGUOUS), each card with its own proposal first', () => {
  const s1 = sitting('18:28', 3, { branch_hint: 2 }); const s2 = sitting('18:36', 4, { branch_hint: 2 });
  const vs = [visit('danish', { branch_id: 2, photo_required: true, braces_month: 4, started_at: at('18:25') }),
    visit('esha', { branch_id: 2, photo_required: true, braces_month: 7, started_at: at('18:31') })];
  const plan = planDay(day(vs, [...s1, ...s2]));
  const g1 = groupOf(plan, s1[0]); const g2 = groupOf(plan, s2[0]);
  assert.equal(g1.auto, null); assert.equal(g2.auto, null);
  assert.equal(g1.wait_reason, 'AMBIGUOUS'); assert.equal(g2.wait_reason, 'AMBIGUOUS');
  assert.deepEqual(g1.candidates.slice(0, 2).map((c: any) => c.visit_id), ['danish', 'esha']);
  assert.deepEqual(g2.candidates.slice(0, 2).map((c: any) => c.visit_id), ['esha', 'danish']);
  assert.ok(g1.candidates[0].proposal && g2.candidates[0].proposal);
});
test('example 3: completions marked in one go do not stop it; times all marked in one go never file by themselves', () => {
  const s = sitting('17:49', 3, { branch_hint: 1 });
  const vs = [visit('farah', { branch_id: 1, photo_required: true, braces_month: 12, started_at: at('17:44'), completed_at: at('20:55', 0) }),
    visit('ghazal', { branch_id: 1, braces_month: 6, started_at: at('17:36'), completed_at: at('20:55', 40) }),
    visit('huma', { branch_id: 1, photo_required: true, braces_month: 1, started_at: at('18:31'), completed_at: at('20:56', 30) })];
  assert.equal(groupOf(planDay(day(vs, s)), s[0]).auto?.visit_id, 'farah');
  const bulk = vs.map((v, i) => ({ ...v, started_at: at('19:33', i * 10), checked_in_at: at('19:33', i * 10 + 5) }));
  const g = groupOf(planDay(day(bulk, s)), s[0]);
  assert.equal(g.auto, null);
  assert.equal(g.wait_reason, 'WEAK_TIMES');
  assert.deepEqual(g.candidates.slice(0, 2).map((c: any) => c.visit_id).sort(), ['farah', 'huma'], 'photo months first');
});
test('example 4: a Scaling patient in the chair does not stop it; a Bonding patient does', () => {
  const s = sitting('19:50', 4);
  const vs = [visit('imran', { photo_required: true, braces_month: 13, started_at: at('19:48') }), visit('javed', { treatment_label: 'Scaling', started_at: at('19:45') })];
  assert.equal(groupOf(planDay(day(vs, s)), s[0]).auto?.visit_id, 'imran');
  vs[1].treatment_label = 'Bonding';
  const g = groupOf(planDay(day(vs, s)), s[0]);
  assert.equal(g.auto, null);
  assert.equal(g.wait_reason, 'AMBIGUOUS');
});
test('example 5: nobody on the list that day: NO_VISIT_DAY, no candidates', () => {
  const s = sitting('12:00', 2, { branch_hint: null });
  const g = groupOf(planDay(day([], s)), s[0]);
  assert.equal(g.wait_reason, 'NO_VISIT_DAY');
  assert.deepEqual(g.candidates, []);
  assert.match(waitSentence('NO_VISIT_DAY', { city: 'Lahore', day: 'Sun 19 Oct' }), /^Nobody is on the Lahore Aaj ki List for Sun 19 Oct/);
});
test('example 6: two sets for one visit: both wait (TWO_SETS), each with the patient first', () => {
  const a = sitting('18:05', 3); const b = sitting('18:50', 3);
  const vs = [visit('kamran', { photo_required: true, braces_month: 10, started_at: at('18:00'), completed_at: at('18:55') })];
  const plan = planDay(day(vs, [...a, ...b]));
  for (const first of [a[0], b[0]]) {
    const g = groupOf(plan, first);
    assert.equal(g.auto, null);
    assert.equal(g.wait_reason, 'TWO_SETS');
    assert.equal(g.candidates[0].visit_id, 'kamran');
  }
});
test('example 7: photos before the check-in: BEFORE_ARRIVAL with the patient first', () => {
  const s = sitting('17:05', 3);
  const g = groupOf(planDay(day([visit('lubna', { photo_required: true, braces_month: 7, checked_in_at: at('17:20'), status: 'in_treatment' })], s)), s[0]);
  assert.equal(g.wait_reason, 'BEFORE_ARRIVAL');
  assert.equal(g.candidates[0].visit_id, 'lubna');
  assert.equal(g.candidates[0].score, 137.5);
});
test('example 8: an upload the next morning matches like an evening one (the day is the photos\' own)', () => {
  const t = captureTime({ exif: { dateTimeOriginal: '2026:10:16 18:35:00' }, uploadedAt: Date.parse(at('10:00', 0, '2026-10-17')) });
  assert.equal(t.photo_day, DAY);
  assert.ok(t.time_ok);
});
test('example 9: a second phone later the same day: a patient already filed waits with HAS_PHOTOS; the rest of a filed sitting joins it', () => {
  const filedItems = sitting('18:35', 3).map((x) => ({ ...x, set_id: 'SA' }));
  const sets = [{ set_id: 'SA', status: 'filed', manual: false, camera: 'apple|iphone 13', branch_hint: 3, visit_id: 'ayesha', candidates: [], wait_reason: null }];
  const vs = [visit('ayesha', { photo_required: true, braces_month: 10, started_at: at('18:31'), completed_at: at('18:59'), photos_uploaded: true, filed_set_ids: ['SA'] })];
  const phoneB = sitting('18:40', 2, { camera: 'samsung|a54' });
  const rest = [item(new Date(Date.parse(filedItems[2].taken_at) + 60000).toISOString(), { branch_hint: 3 })];
  const plan = planDay(day(vs, [...filedItems, ...phoneB, ...rest], sets));
  assert.equal(groupOf(plan, phoneB[0]).wait_reason, 'HAS_PHOTOS');
  assert.equal(groupOf(plan, phoneB[0]).candidates[0].visit_id, 'ayesha');
  assert.equal(groupOf(plan, rest[0]).join_set_id, 'SA');
});
test('example 10 / AI flags: a set Claude flagged never files by itself', () => {
  const s = sitting('18:35', 3).map((x) => ({ ...x, set_id: 'W1' }));
  const sets = [{ set_id: 'W1', status: 'waiting', manual: false, ai_flag: 'mixed_people', candidates: [], wait_reason: null }];
  const g = groupOf(planDay(day([visit('ayesha', { photo_required: true, braces_month: 10, started_at: at('18:31') })], s, sets)), s[0]);
  assert.equal(g.auto, null);
  assert.equal(g.wait_reason, 'MIXED');
  assert.equal(g.reuse_set_id, 'W1');
});

test('the assignment keeps time order, needs MIN_PAIR and the hinted branch, and breaks ties the same way every time', () => {
  const s1 = sitting('18:10', 2); const s2 = sitting('18:40', 2);
  const vs = [visit('early', { photo_required: true, started_at: at('18:05') }), visit('late', { photo_required: true, started_at: at('18:38') })];
  const plan = planDay(day(vs, [...s1, ...s2]));
  assert.equal(groupOf(plan, s1[0]).candidates[0].visit_id, 'early');
  assert.equal(groupOf(plan, s2[0]).candidates[0].visit_id, 'late');
  assert.deepEqual(planDay(day(vs, [...s2, ...s1])), plan, 'the same answer whatever the order of the input');
  const units = [{ key: 'u', time_ok: true, first: Date.parse(at('23:30')), last: Date.parse(at('23:31')), hint: 3 }];
  assert.equal(assignDay(units, visitFacts([visit('far', { started_at: at('18:00') })])).size, 0, `a score under ${MIN_PAIR} is no pair`);
  assert.equal(assignDay([{ ...units[0], first: Date.parse(at('18:02')), last: Date.parse(at('18:03')) }],
    visitFacts([visit('other', { branch_id: 1, photo_required: true, started_at: at('18:00') })])).size, 0, 'another branch than the hint');
  const { score } = scorePair({ time_ok: true, first: Date.parse(at('18:02')), last: Date.parse(at('18:03')), hint: 3 },
    visitFacts([visit('w', { status: 'waiting', photo_required: true, started_at: at('18:00'), photos_uploaded: true, branch_id: 1 })])[0]);
  assert.equal(score, 100 + 60 - 15 - 40 - 30);
});
test('a branch hint keeps other branches out of the "other photo-month patient" rule', () => {
  const s = sitting('18:35', 3, { branch_hint: 3 });
  const vs = [visit('ayesha', { photo_required: true, started_at: at('18:31') }), visit('elsewhere', { branch_id: 1, photo_required: true, started_at: at('18:33') })];
  assert.equal(groupOf(planDay(day(vs, s)), s[0]).auto?.visit_id, 'ayesha');
  const noHint = sitting('20:35', 3, { branch_hint: null });
  const vs2 = [visit('x', { photo_required: true, started_at: at('20:31') }), visit('y', { branch_id: 1, photo_required: true, started_at: at('20:33') })];
  assert.equal(groupOf(planDay(day(vs2, noHint)), noHint[0]).wait_reason, 'AMBIGUOUS', 'without a hint every branch of the city counts');
});
test('sets a person changed keep their photos and get fresh candidates; a re-plan of an applied plan changes nothing', () => {
  const m = sitting('18:35', 2).map((x) => ({ ...x, set_id: 'M' }));
  const sets = [{ set_id: 'M', status: 'waiting', manual: true, wait_reason: 'UNDONE', candidates: [] }];
  const vs = [visit('ayesha', { photo_required: true, started_at: at('18:31') })];
  const plan = planDay(day(vs, m, sets));
  assert.deepEqual(plan.groups, []);
  assert.deepEqual(plan.regroup_item_ids, []);
  assert.equal(plan.fixed_updates[0].set_id, 'M');
  assert.equal(plan.fixed_updates[0].wait_reason, 'UNDONE');
  assert.equal(plan.fixed_updates[0].candidates[0].visit_id, 'ayesha');
  // Applied: the waiting sets hold exactly the plan's groups, with its candidates and reasons (stored as jsonb, keys in another order).
  const w = sitting('19:10', 2);
  const vs2 = [visit('p', { photo_required: true, started_at: at('19:10') }), visit('q', { photo_required: true, started_at: at('19:12') })];
  const p1 = planDay(day(vs2, w));
  const g = p1.groups[0];
  const shuffle = (o: any): any => (Array.isArray(o) ? o.map(shuffle) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).reverse().map(([k, v]) => [k, shuffle(v)])) : o);
  const applied = day(vs2, w.map((x) => ({ ...x, set_id: 'S1' })), [{ set_id: 'S1', status: 'waiting', manual: false, wait_reason: g.wait_reason, candidates: shuffle(g.candidates) }]);
  const p2 = planDay(applied);
  assert.ok(planUnchanged(p2, applied), 'nothing to apply');
  assert.equal(planUnchanged(planDay(day(vs2, w)), day(vs2, w)), false, 'photos in no set yet: apply');
  const moved = { ...applied, sets: [{ ...applied.sets[0], wait_reason: 'TWO_SETS' }] };
  assert.equal(planUnchanged(planDay(moved), moved), false, 'another reason: apply');
});
test('every wait reason has its sentence', () => {
  for (const code of WAIT_REASONS) assert.ok(waitSentence(code, { city: 'Karachi', day: 'Fri 16 Oct', date: '12 Mar 2019' }).length > 10, code);
  assert.match(waitSentence('CLOCK', { date: '12 Mar 2019, 4:10 PM' }), /12 Mar 2019, 4:10 PM/);
  assert.ok(GAP_SEC === 180);
});

// ---------------------------------------------------------------- names
test('view keys and kinds are the same as the Edge Function\'s', () => {
  assert.deepEqual(VIEW_KEYS, CORE_VIEWS);
  assert.deepEqual(KINDS, CORE_KINDS);
  assert.equal(viewName('intra_upper'), 'Upper arch');
});
test('labels and download names', () => {
  assert.equal(occasionLabel({ braces_month: 6, treatment_label: 'Monthly' }), 'Month 6');
  assert.equal(occasionLabel({ braces_month: null, treatment_label: ' Scaling ' }), 'Scaling');
  assert.equal(occasionLabel({ braces_month: null, treatment_label: '' }), null);
  assert.equal(viewLabel('Month 6', 'intra_front', 1), 'Month 6 · Front');
  assert.equal(viewLabel('Month 6', null, 3), 'Month 6 · Photo 3');
  assert.equal(viewLabel(null, 'intra_front', 1), 'Front');
  const row = { full_name: 'Ayesha Khan', mr_number: '50013', occasion: 'Month 6', view_key: 'intra_front', taken_on: '2026-10-17', kind: 'edited', storage_path: 'inbox/x/y/edited/a.jpg' };
  assert.equal(downloadName(row), 'Ayesha Khan - Mr# 50013 - Month 6 - Front - 17-10-2026.jpg');
  assert.equal(downloadName({ ...row, occasion: null, view_key: 'intra_upper' }), 'Ayesha Khan - Mr# 50013 - Upper arch - 17-10-2026.jpg');
  assert.equal(downloadName({ ...row, view_key: null, view_label: 'Month 6 · Photo 3' }, { position: 3 }), 'Ayesha Khan - Mr# 50013 - Month 6 - Photo 3 - 17-10-2026.jpg');
  assert.equal(downloadName({ ...row, kind: 'raw', storage_path: 'inbox/karachi/2026-10-17/abc.HEIC' }), 'Ayesha Khan - Mr# 50013 - Month 6 - Front - 17-10-2026 - original.heic');
  assert.equal(downloadName({ ...row, full_name: 'A/B: "C"*<D>|?' }), 'A B C D - Mr# 50013 - Month 6 - Front - 17-10-2026.jpg');
  const long = downloadName({ ...row, full_name: 'N'.repeat(300) });
  assert.ok(long.length <= 154 && long.endsWith('.jpg'));
  assert.deepEqual(uniqueNames(['a.jpg', 'b.jpg', 'a.jpg', 'A.jpg']), ['a.jpg', 'b.jpg', 'a (2).jpg', 'A (3).jpg']);
});

// ---------------------------------------------------------------- the edit
test('editPlan: rotation swaps sizes, straightening keeps the inner rectangle, the crop is widened and kept inside, never enlarged', () => {
  const basic = editPlan(null, 4032, 3024);
  assert.deepEqual([basic.sx, basic.sy, basic.sw, basic.sh, basic.angle, basic.flip], [0, 0, 4032, 3024, 0, false]);
  assert.deepEqual([basic.outW, basic.outH], [2048, 1536]);
  const ai = (o: Record<string, unknown>) => ({ kind: 'intraoral', rotate: 0, mirror: false, straighten: 0, crop: { left: 0, top: 0, right: 1, bottom: 1 }, exposure: 'ok', color_cast: 'none', ...o });
  const r90 = editPlan(ai({ rotate: 90 }), 4032, 3024);
  assert.deepEqual([r90.outW, r90.outH], [1536, 2048]);
  const s5 = editPlan(ai({ straighten: 5 }), 1000, 800);
  const a = 5 * Math.PI / 180;
  const k = Math.min(1000 / (1000 * Math.cos(a) + 800 * Math.sin(a)), 800 / (1000 * Math.sin(a) + 800 * Math.cos(a)));
  assert.ok(Math.abs(s5.inner - k) < 1e-12);
  assert.deepEqual([s5.outW, s5.outH], [Math.round(1000 * k), Math.round(800 * k)]);
  const crop = editPlan(ai({ crop: { left: 0.25, top: 0.25, right: 0.75, bottom: 0.75 } }), 1000, 1000);
  assert.deepEqual([crop.sx, crop.sy, crop.sw, crop.sh], [230, 230, 540, 540], '2 % wider on each side');
  const edge = editPlan(ai({ crop: { left: 0, top: 0, right: 0.5, bottom: 1 } }), 1000, 1000);
  assert.deepEqual([edge.sx, edge.sy, edge.sw, edge.sh], [0, 0, 520, 1000], 'kept inside the photo');
  assert.equal(editPlan(ai({ mirror: true }), 100, 100).flip, true);
  const small = editPlan(ai({}), 800, 600);
  assert.deepEqual([small.outW, small.outH, small.scale], [800, 600, 1], 'never enlarged');
  assert.equal(editPlan(ai({ color_cast: 'warm' }), 10, 10).wb, true);
  assert.equal(editPlan(ai({ color_cast: 'warm', kind: 'xray' }), 10, 10).wb, false, 'an X-ray gets levels only');
  assert.equal(editPlan(ai({ exposure: 'dark' }), 10, 10).gammaFloor, 0.7);
});
const pixels = (w: number, h: number, f: (x: number, y: number) => [number, number, number]) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = f(x, y); const i = (y * w + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; }
  return d;
};
test('adjustPixels: a colour cast is corrected within the caps, levels stretch, gamma never darkens, too few neutral pixels skip white balance', () => {
  const warm = pixels(40, 40, (x) => (x < 20 ? [200, 192, 180] : [30 + x, 30 + x, 30 + x]));
  const out = adjustPixels(warm, { width: 40, height: 40, wb: true });
  assert.ok(out.gains.every((g: number) => g >= 0.92 && g <= 1.08));
  assert.ok(out.gains[0] < 1 && out.gains[2] > 1, 'red down, blue up');
  const flat = pixels(20, 20, (x, y) => [60 + ((x + y) % 40), 60 + ((x + y) % 40), 60 + ((x + y) % 40)]);
  const before = flat[0];
  const lv = adjustPixels(flat, { width: 20, height: 20 });
  assert.ok(lv.low <= 20 && lv.high >= 235);
  assert.ok(lv.gamma <= 1 && lv.gamma >= 0.8);
  assert.ok(flat[0] >= before - 20, 'dark pixels are lifted, not crushed');
  const colourful = pixels(20, 20, (x) => [250, 10 * (x % 5), 0]);
  assert.equal(adjustPixels(colourful, { width: 20, height: 20, wb: true }).neutralShare, 0, 'no neutral pixels: no white balance');
  const dark = pixels(20, 20, () => [40, 40, 40]);
  const d = adjustPixels(dark, { width: 20, height: 20, gammaFloor: 0.7 });
  assert.ok(d.gamma >= 0.7 && d.gamma <= 1);
  assert.ok(dark[0] >= 40, 'a dark photo gets brighter');
});

// ---------------------------------------------------------------- review fixes (17 Oct)
test('review: a photo patient who already has photos still stops an automatic filing (a re-plan right after a one-tap filing)', () => {
  const s1 = sitting('17:05', 5); const s2 = sitting('17:30', 3);
  const A = visit('a1', { photo_required: true, braces_month: 6, started_at: at('17:00'), completed_at: at('17:45') });
  const B = visit('b1', { photo_required: true, braces_month: 4, started_at: at('17:10'), completed_at: at('18:00') });
  const p0 = planDay(day([A, B], [...s1, ...s2]));
  assert.equal(groupOf(p0, s1[0]).wait_reason, 'AMBIGUOUS');
  assert.equal(groupOf(p0, s2[0]).wait_reason, 'AMBIGUOUS');
  // staff tap set 1 -> A; matching runs again at once: set 2 may be A's too, so it never goes to B by itself
  const sets = [{ set_id: 'F1', status: 'filed', manual: false, camera: 'apple|iphone 13', branch_hint: 3, visit_id: 'a1' }];
  const p1 = planDay(day([{ ...A, photos_uploaded: true, filed_set_ids: ['F1'] }, B], [...s1.map((x) => ({ ...x, set_id: 'F1' })), ...s2], sets));
  const g2 = groupOf(p1, s2[0]);
  assert.equal(g2.auto, null);
  assert.equal(g2.wait_reason, 'HAS_PHOTOS');
  assert.deepEqual(g2.candidates.slice(0, 2).map((c: any) => c.visit_id), ['b1', 'a1'], 'both photo patients on the card, the one with photos marked');
  assert.ok(g2.candidates[1].reasons.includes('HAS_PHOTOS'));
  // a second phone later the same day, with another photo month in the chair (spec example 9 with an overlap): waits as well
  const filedItems = sitting('18:35', 3).map((x) => ({ ...x, set_id: 'SA' }));
  const vs = [visit('ayesha', { photo_required: true, braces_month: 10, started_at: at('18:31'), completed_at: at('18:59'), photos_uploaded: true, filed_set_ids: ['SA'] }),
    visit('zara', { photo_required: true, braces_month: 7, started_at: at('18:38'), completed_at: at('19:10') })];
  const phoneB = sitting('18:40', 2, { camera: 'samsung|a54' });
  const g = groupOf(planDay(day(vs, [...filedItems, ...phoneB], [{ ...sets[0], set_id: 'SA', visit_id: 'ayesha' }])), phoneB[0]);
  assert.equal(g.auto, null);
  assert.equal(g.wait_reason, 'HAS_PHOTOS');
});

test('review: two phones of the same model (date-named files) uploaded by two people, or one person in two uploads, stay apart', () => {
  const shot = (hm: string, i: number, o: Item) => item(new Date(Date.parse(at(hm)) + i * 30000).toISOString(), { camera: 'samsung|sm-a145f', branch_hint: 3, file_name: `20261016_17${hm.slice(3)}${i}0.jpg`, ...o });
  const a = Array.from({ length: 5 }, (_, i) => shot('17:10', i, { uploaded_by: 'u1', upload_batch: 'b1' }));
  const r = Array.from({ length: 5 }, (_, i) => shot('17:11', i, { uploaded_by: 'u2', upload_batch: 'b2' }));
  assert.equal(fileSeq(a[0].file_name), null, 'no file counter to tell them apart');
  const vs = [visit('a2', { photo_required: true, started_at: at('17:00'), completed_at: at('17:30') }), visit('r2', { treatment_label: 'Scaling', started_at: at('17:05'), completed_at: at('17:30') })];
  const plan = planDay(day(vs, [...a, ...r]));
  assert.equal(plan.groups.length, 2);
  assert.deepEqual(groupOf(plan, a[0]).item_ids, a.map((x) => x.item_id));
  assert.deepEqual(groupOf(plan, r[0]).item_ids, r.map((x) => x.item_id));
  assert.equal(groupOf(plan, r[0]).auto, null, 'the other person\'s photos never go into the photo month\'s file');
  const sameUploader = r.map((x) => ({ ...x, uploaded_by: 'u1' }));
  assert.equal(groupItems([...a, ...sameUploader]).length, 2, 'one person, two uploads: two streams');
});

test('review: a camera clock is judged over the whole upload: running ahead, or a phone on the wrong time zone', () => {
  const up = Date.parse(at('21:00'));
  const t = (hm: string) => captureTime({ exif: { make: 'Samsung', model: 'SM-A145F', dateTimeOriginal: `2026:10:16 ${hm}:00` }, uploadedAt: up, pickedAt: up });
  const ahead = cameraClocks([{ t: t('18:10'), lastModified: up, pickedAt: up }, { t: t('21:08'), lastModified: up, pickedAt: up }], up);
  assert.equal(t('21:08').clock_ok, true, 'each photo alone looks fine');
  assert.deepEqual(ahead.map((c) => [c.camera, c.suspect, c.why]), [['samsung|sm-a145f', true, 'ahead']], 'the newest photo is 8 minutes after the upload: every photo of that camera waits');
  const zone = cameraClocks(['17:00', '17:20', '17:40'].map((hm) => ({ t: t(hm), lastModified: Date.parse(at(hm)) + 60 * 60 * 1000, pickedAt: up })), up);
  assert.equal(zone[0].why, 'zone', 'camera times one hour away from the files\' own times on every photo: the time zone is wrong');
  const fine = cameraClocks(['17:00', '17:20'].map((hm) => ({ t: t(hm), lastModified: Date.parse(at(hm)) + 2000, pickedAt: up })), up);
  assert.equal(fine[0].suspect, false);
  const copied = cameraClocks(['17:00', '17:20', '17:40'].map((hm, i) => ({ t: t(hm), lastModified: up - (3 + i * 7) * 60 * 1000 - 37000, pickedAt: up })), up);
  assert.equal(copied[0].suspect, false, 'files copied later (their own dates have nothing to do with the photo) are not taken for a time zone');
  assert.equal(fine[0].newest, Date.parse(at('17:20')), 'the newest photo time is shown on the upload screen');
  // a photo without a camera time keeps the day of its file date (a next-morning upload is shown with that day's list)
  const next = Date.parse(at('10:00', 0, '2026-10-17'));
  assert.equal(captureTime({ lastModified: Date.parse(at('17:00')), pickedAt: next, uploadedAt: next }).photo_day, DAY);
});

test('review: a patient with two rows that day (a Dr. Ali visit and a photo month) stands for the photo month and counts as in the chair', () => {
  const s = sitting('16:50', 4);
  const vs = [visit('x-drali', { patient_id: 'p-x', treatment_label: 'Dr. Ali', started_at: at('16:10'), completed_at: at('16:20') }),
    visit('x-m6', { patient_id: 'p-x', photo_required: true, braces_month: 6, started_at: at('16:40'), completed_at: at('17:10') }),
    visit('y', { photo_required: true, braces_month: 4, started_at: at('16:45'), completed_at: at('17:20') })];
  const g = groupOf(planDay(day(vs, s)), s[0]);
  assert.equal(g.auto, null, 'not filed to Y by itself');
  assert.equal(g.wait_reason, 'AMBIGUOUS');
  const ids = g.candidates.map((c: any) => c.visit_id);
  assert.ok(ids.includes('x-m6') && !ids.includes('x-drali'), 'a tap on X files to the photo-month visit');
});

test('review: the day\'s order is kept per branch chosen (and per phone without one): one branch\'s set never loses its patient to another branch\'s', () => {
  const gul = sitting('17:05', 3, { branch_hint: 1 }); const dha = sitting('17:15', 3, { branch_hint: 3 });
  const vs = [visit('p1', { branch_id: 1, photo_required: true, started_at: at('17:00') }),
    visit('p2', { branch_id: 3, photo_required: true, started_at: at('16:00'), completed_at: at('17:30') })];
  const plan = planDay(day(vs, [...gul, ...dha]));
  assert.equal(groupOf(plan, gul[0]).auto?.visit_id, 'p1');
  assert.equal(groupOf(plan, dha[0]).auto?.visit_id, 'p2', 'planned together, the DHA set still files (it waited TWO_SETS before)');
  // without a branch, from two phones: the card never highlights a pairing that scores lower than the top one
  const g2 = sitting('17:05', 3, { branch_hint: null, uploaded_by: 'u1' }); const d2 = sitting('17:15', 3, { branch_hint: null, camera: 'samsung|a54', uploaded_by: 'u2' });
  const plan2 = planDay(day(vs, [...g2, ...d2]));
  const c = groupOf(plan2, g2[0]).candidates;
  assert.equal(c[0].visit_id, 'p1');
  assert.ok(c.every((x: any) => !x.proposal || x.score >= c[0].score));
});

test('review: a plan the server refused before is not sent again (nothing changed); the start the page went by is sent with the filing', () => {
  const w = sitting('19:10', 2);
  const vs = [visit('p', { photo_required: true, started_at: at('19:05') })];
  const p1 = planDay(day(vs, w));
  assert.ok(p1.groups[0].auto);
  const refused = day(vs, w.map((x) => ({ ...x, set_id: 'S1' })), [{ set_id: 'S1', status: 'waiting', manual: false, wait_reason: 'SERVER_CHECK', candidates: p1.groups[0].candidates }]);
  const p2 = planDay(refused);
  assert.equal(p2.groups[0].auto, null);
  assert.equal(p2.groups[0].wait_reason, 'SERVER_CHECK');
  assert.ok(planUnchanged(p2, refused), 'matching every 3 minutes writes nothing');
  // starts marked in one go (19:00:00, 19:00:30, 19:01:00) with real check-ins: the page goes by the check-in and says so
  const bulk = [visit('a', { branch_id: 1, photo_required: true, checked_in_at: at('17:20'), started_at: at('19:00', 0) }),
    visit('b', { branch_id: 1, checked_in_at: at('18:00'), started_at: at('19:00', 30) }), visit('c', { branch_id: 1, checked_in_at: at('18:30'), started_at: at('19:01', 0) })];
  const s = sitting('17:30', 3, { branch_hint: 1 });
  const g = groupOf(planDay(day(bulk, s)), s[0]);
  assert.equal(g.auto?.visit_id, 'a');
  assert.equal(g.auto.anchor_at, at('17:20'));
});

test('review: without a chosen branch, a patient in the chair at another branch stops the automatic filing (NO_BRANCH)', () => {
  const vs = [visit('p1', { branch_id: 3, photo_required: true, started_at: at('17:00') }),
    visit('g', { branch_id: 1, treatment_label: 'Scaling', started_at: at('16:50'), completed_at: at('17:30') })];
  const open = sitting('17:05', 3, { branch_hint: null });
  const g = groupOf(planDay(day(vs, open)), open[0]);
  assert.equal(g.auto, null);
  assert.equal(g.wait_reason, 'NO_BRANCH');
  const dha = sitting('18:05', 3, { branch_hint: 3 });
  const vs2 = vs.map((v) => ({ ...v, started_at: v.visit_id === 'p1' ? at('18:00') : at('17:50'), completed_at: v.visit_id === 'g' ? at('18:30') : null }));
  assert.equal(groupOf(planDay(day(vs2, dha)), dha[0]).auto?.visit_id, 'p1', 'with the branch chosen it files');
  assert.match(waitSentence('NO_BRANCH'), /choose the branch before uploading/);
});

test('review: joining a filed set: inside its time too (a photo retried), never when two filed sets would fit, never from another person', () => {
  const f = [item(at('18:30', 0), { set_id: 'F', uploaded_by: 'u1', upload_batch: 'b1' }), item(at('18:31', 0), { set_id: 'F', uploaded_by: 'u1', upload_batch: 'b1' }),
    item(at('18:32', 0), { set_id: 'F', uploaded_by: 'u1', upload_batch: 'b1' })];
  const F = { set_id: 'F', status: 'filed', manual: false, items: f };
  const middle = item(at('18:31', 30), { uploaded_by: 'u1', upload_batch: 'b2' });
  assert.equal(groupItems([middle], [F])[0].join_set_id, 'F', 'a photo from the middle of the sitting, uploaded again later');
  assert.equal(groupItems([{ ...middle, uploaded_by: 'u2' }], [F])[0].join_set_id, null, 'another person\'s photo does not join');
  const fa = [item(at('18:18', 0), { set_id: 'FA' }), item(at('18:20', 0), { set_id: 'FA' })];
  const fb = [item(at('18:25', 0), { set_id: 'FB' }), item(at('18:26', 0), { set_id: 'FB' })];
  const between = item(at('18:22', 30));
  assert.equal(groupItems([between], [{ set_id: 'FA', status: 'filed', manual: false, items: fa }, { set_id: 'FB', status: 'filed', manual: false, items: fb }])[0].join_set_id, null,
    'within 3 minutes of two filed sets: it waits on "Which patient?"');
});

test('review: photos without a usable time get no likely patients (the day cannot be trusted); old photos say so', () => {
  const none = item(null, { item_id: 'nt1', branch_hint: 3 });
  const vs = [visit('ayesha', { photo_required: true, started_at: at('18:31') })];
  const g = groupOf(planDay(day(vs, [none])), none);
  assert.equal(g.wait_reason, 'NO_TIME');
  assert.deepEqual(g.candidates, [], 'no buttons: the person types the name');
  const old = item('2026-10-07T13:00:00.000Z', { item_id: 'old1', clock_ok: false, uploaded_at: at('10:00', 0, '2026-10-16') });
  assert.equal(groupOf(planDay(day(vs, [old])), old).wait_reason, 'OLD');
  assert.match(waitSentence('OLD', { date: 'Wed 7 Oct, 6:00 PM' }), /^Taken more than a week before it was uploaded/);
  const fast = item(at('18:40'), { item_id: 'fast1', clock_ok: false, uploaded_at: at('21:00') });
  assert.equal(groupOf(planDay(day(vs, [fast])), fast).wait_reason, 'CLOCK');
});

test('review: a photo saved on the profile (no occasion, a braces month) downloads with its Month', () => {
  assert.equal(downloadName({ full_name: 'Ayesha Khan', mr_number: '50013', braces_month: 6, view_label: 'Front', taken_on: '2026-10-16', kind: 'edited' }),
    'Ayesha Khan - Mr# 50013 - Month 6 - Front - 16-10-2026.jpg');
});

test('review: the edit transform levels a tilted photo the way Claude means it, mirrored or not', () => {
  const ai = (o: Record<string, unknown>) => ({ kind: 'intraoral', rotate: 0, mirror: false, straighten: 0, crop: { left: 0, top: 0, right: 1, bottom: 1 }, exposure: 'ok', color_cast: 'none', ...o });
  const through = (plan: any, x: number, y: number) => { const m = editTransform(plan); return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]; };
  const rad = (deg: number) => deg * Math.PI / 180;
  // mirrored: the line is tilted +5 degrees in the photo as taken, -5 after the flip; "straighten 5" (clockwise, after the flip) levels it
  const mp = editPlan(ai({ mirror: true, straighten: 5 }), 1000, 800);
  const [, y0] = through(mp, 0, 0);
  const [x1, y1] = through(mp, 100 * Math.cos(rad(5)), 100 * Math.sin(rad(5)));
  assert.ok(Math.abs(y1 - y0) < 1e-9, `level after the flip (was ${y1 - y0})`);
  assert.ok(x1 < mp.outW / 2, 'and flipped left to right');
  // not mirrored: a line tilted -5 degrees is levelled by turning it 5 degrees clockwise
  const np = editPlan(ai({ straighten: 5 }), 1000, 800);
  const [, a0] = through(np, 0, 0);
  const [, a1] = through(np, 100 * Math.cos(rad(-5)), 100 * Math.sin(rad(-5)));
  assert.ok(Math.abs(a1 - a0) < 1e-9);
  // a quarter turn and the flip together: the photo's top edge becomes the right edge, then the left
  const q = editPlan(ai({ rotate: 90, mirror: true }), 1000, 800);
  const [tx] = through(q, 0, -100);
  assert.ok(tx < q.outW / 2, 'turned then flipped');
});

test('review: connection problems are told apart from refusals, and a rate limit is never "storage full"', () => {
  assert.equal(isConnectionProblem({ message: 'TypeError: Failed to fetch' }), true);
  assert.equal(isConnectionProblem({ status: 502, message: 'Bad gateway' }), true);
  assert.equal(isConnectionProblem({ code: 'TIMEOUT', message: 'Timed out' }), true);
  assert.equal(isConnectionProblem({ photoCode: 'PHOTO_STALE', message: 'PHOTO_STALE: someone changed these photos' }), false);
  assert.equal(isConnectionProblem({ message: 'NOT_ALLOWED: no' }), false);
  assert.equal(storageProblem({ status: 429, message: 'Rate limit exceeded' }), 'NETWORK');
  assert.equal(storageProblem({ status: 503, message: 'The service quota was exceeded' }), 'NETWORK');
  assert.equal(storageProblem({ status: 402, message: '' }), 'STORAGE_FULL');
  assert.equal(storageProblem({ status: 400, message: 'The storage quota exceeded for this project' }), 'STORAGE_FULL');
  assert.equal(storageProblem({ status: 413, message: 'Payload too large' }), 'TOO_LARGE');
  assert.equal(storageProblem({ status: 409, message: 'The resource already exists' }), 'ALREADY');
  assert.equal(storageProblem({ status: 403, message: 'new row violates row-level security policy' }), 'NOT_ALLOWED');
  assert.equal(storageProblem({ message: 'Failed to fetch' }), 'NETWORK');
});

// ---------------------------------------------------------------- the note box and old photos (owner, 17 Oct 2026)
// The same notes are read by the database in supabase/tests/43_photo_inbox_notes_test.sql (private.photo_inbox_note_mrs / _note_month).
test('notes: the Mr#s (3-6 digits, old ones with a dash), never a phone number, a date or a year', () => {
  assert.deepEqual(noteMrs('Ayesha Khan Mr# 50013, month 6, phone 0300-5551234, 17-10-2026, Oct 2025'), ['50013']);
  assert.deepEqual(noteMrs('347-1 and 9815'), ['347-1', '9815']);
  assert.deepEqual(noteMrs('#025 mr50013 +92 300 5551234'), ['025', '50013']);
  assert.deepEqual(noteMrs('50013-50014 then 9815, 9815 again'), ['50013', '50014', '9815']);
  assert.deepEqual(noteMrs('12 1234567 2026/10/17 1999 M6'), []);
  assert.deepEqual(noteMrs(''), []);
  assert.deepEqual(noteMrs(null), []);
});
test('notes: the braces month ("Month 6", "M6", "6th month"), not an Mr# or a room', () => {
  assert.equal(noteMonth('Ayesha month 6'), 6);
  assert.equal(noteMonth('M6 front'), 6);
  assert.equal(noteMonth('m 12'), 12);
  assert.equal(noteMonth('Month: 14'), 14);
  assert.equal(noteMonth('her 6th month'), 6);
  assert.equal(noteMonth('Mr 50013'), null);
  assert.equal(noteMonth('room 12'), null);
  assert.equal(noteMonth('month 0'), null);
  assert.equal(noteMonth(''), null);
});
test('notes: name words in their everyday spelling; a whole name or a first name fits, never a surname alone', () => {
  const w = noteWords('Aisha Khan photos Month 6 Mr# 50013 front');
  assert.equal(w.length, 2, `two name words (${w.join(', ')})`);
  assert.ok(!w.includes('photos') && !w.includes('month') && !w.includes('front'), 'note words are not names');
  assert.equal(noteNameFit(w, 'Ayesha Khan'), 'full');
  assert.equal(noteNameFit(w, 'Muhammad Ayesha Khan'), 'full', 'titles left out');
  assert.equal(noteNameFit(w, 'Ayesha Rajpoot'), 'first');
  assert.equal(noteNameFit(w, 'Bilal Khan'), null, 'a surname alone does not fit');
  assert.equal(noteNameFit([], 'Ayesha Khan'), null);
});
test('old photos: the day of their own date (camera or app), else the upload day; never a usable time', () => {
  const upload = Date.parse(at('22:00'));
  const t = oldPhotoTime(captureTime({ exif: { dateTimeOriginal: '2024:03:10 11:00:00' }, uploadedAt: upload, pickedAt: upload }), upload);
  assert.equal(t.photo_day, '2024-03-10');
  assert.equal(t.time_ok, false);
  assert.equal(t.clock_ok, false);
  const app = oldPhotoTime(captureTime({ exif: { dateTime: '2023:12:01 09:00:00' }, uploadedAt: upload }), upload);
  assert.equal(app.photo_day, '2023-12-01', 'the time an app saved it counts for old photos');
  const none = oldPhotoTime(captureTime({ exif: null, lastModified: upload - 3 * 86400000, uploadedAt: upload, pickedAt: upload }), upload);
  assert.equal(none.photo_day, DAY, 'no date of its own: the upload day');
});

const NOTE_BATCH = (id: string, note: string | null, kind = 'day', extra: V = {}) => ({ batch_id: id, kind, note, mr_patients: [], name_patients: [], ...extra });
test('note_mr: an upload of one visit whose note names one Mr# on the list files by itself, even when the time alone waits', () => {
  const s1 = sitting('18:28', 3, { branch_hint: 2, upload_batch: 'b1' }); const s2 = sitting('18:36', 4, { branch_hint: 2, upload_batch: 'b2' });
  const vs = [visit('danish', { branch_id: 2, photo_required: true, braces_month: 4, started_at: at('18:25'), mr_number: '50004', full_name: 'Danish Sample' }),
    visit('esha', { branch_id: 2, photo_required: true, braces_month: 7, started_at: at('18:31'), mr_number: '50007', full_name: 'Esha Sample' })];
  const plan = planDay({ ...day(vs, [...s1, ...s2]), batches: [NOTE_BATCH('b1', null), NOTE_BATCH('b2', 'Esha Mr# 50007 month 7')] });
  const g1 = groupOf(plan, s1[0]); const g2 = groupOf(plan, s2[0]);
  assert.equal(g2.auto?.rule_kind, 'note_mr');
  assert.equal(g2.auto.visit_id, 'esha');
  assert.match(g2.auto.rule, /^Automatic \(note_mr\): the note with these photos names Mr# 50007, on the NN list that day$/);
  assert.equal(g2.candidates[0].visit_id, 'esha');
  assert.ok(g2.candidates[0].reasons.includes('NOTE_MR'));
  assert.equal(g1.auto, null, 'the other upload (no note) still waits');
  assert.equal(g1.wait_reason, 'AMBIGUOUS');
});
test('note: a name alone never files; it only comes first on the card', () => {
  const s2 = sitting('18:36', 4, { branch_hint: 2, upload_batch: 'b2' });
  const vs = [visit('danish', { branch_id: 2, photo_required: true, braces_month: 4, started_at: at('18:25'), full_name: 'Danish Sample' }),
    visit('esha', { branch_id: 2, photo_required: true, braces_month: 7, started_at: at('18:31'), full_name: 'Esha Sample' })];
  const g = groupOf(planDay({ ...day(vs, s2), batches: [NOTE_BATCH('b2', 'Danish, month 4')] }), s2[0]);
  assert.equal(g.auto, null);
  assert.equal(g.candidates[0].visit_id, 'danish', 'the name in the note comes first (an upload of one visit)');
  assert.ok(g.candidates[0].reasons.includes('NOTE_NAME'));
});
test('note_mr guards: not on the list (NOTE_NO_VISIT), a whole day of photos, a time match to someone else (NOTE_OTHER), photos without a time', () => {
  const vs = [visit('ayesha', { photo_required: true, braces_month: 10, started_at: at('18:31'), completed_at: at('18:49'), mr_number: '50010' }),
    visit('bilal', { braces_month: 5, started_at: at('18:13'), completed_at: at('18:23'), mr_number: '50005' })];
  const a = sitting('18:35', 3, { upload_batch: 'b1' });
  assert.equal(groupOf(planDay({ ...day(vs, a), batches: [NOTE_BATCH('b1', 'Mr# 77777')] }), a[0]).wait_reason, 'NOTE_NO_VISIT');
  // a whole day of photos in one upload (18:35 and 21:30): the note is not about every set, so it files nothing by itself
  const b = [...sitting('18:35', 2, { upload_batch: 'b2' }), ...sitting('21:30', 2, { upload_batch: 'b2' })];
  const pb = planDay({ ...day(vs, b), batches: [NOTE_BATCH('b2', 'Bilal 50005')] });
  assert.ok(pb.groups.every((g: any) => g.auto?.rule_kind !== 'note_mr'));
  assert.ok((21.5 - 18.5) * 3600 > ONE_VISIT_SEC);
  // one visit, the time says Ayesha (the clear case), the note names Bilal: a person looks
  const c = sitting('18:35', 3, { upload_batch: 'b3' });
  const gc = groupOf(planDay({ ...day(vs, c), batches: [NOTE_BATCH('b3', 'Bilal 50005')] }), c[0]);
  assert.equal(gc.auto, null);
  assert.equal(gc.wait_reason, 'NOTE_OTHER');
  // the note agrees with the time: filed by the time rule
  const ga = groupOf(planDay({ ...day(vs, c), batches: [NOTE_BATCH('b3', 'Ayesha 50010')] }), c[0]);
  assert.equal(ga.auto?.visit_id, 'ayesha');
  assert.equal(ga.auto.rule_kind, undefined);
  // photos without a camera time (WhatsApp) of an upload naming one Mr#: one set, filed to that patient
  const x = [item(null, { upload_batch: 'b4' }), item(null, { upload_batch: 'b4' }), item(null, { upload_batch: 'b4' })];
  const px = planDay({ ...day(vs, x), batches: [NOTE_BATCH('b4', 'Bilal Mr# 50005')] });
  assert.equal(px.groups.length, 1);
  assert.equal(px.groups[0].auto?.rule_kind, 'note_mr');
  assert.equal(px.groups[0].auto.visit_id, 'bilal');
});
test('old photos: one set per upload (pauses split timed ones), filed by a single Mr# (old_note_mr), else the note\'s patients to tap', () => {
  const p = (id: string, mr: string, name: string, city = 1) => ({ patient_id: id, mr_number: mr, full_name: name, branch_id: 1, city_id: city });
  const old = (b: string, k = 3) => Array.from({ length: k }, (_, i) => item(null, { upload_batch: b, time_source: 'exif_modified', taken_at: '2024-03-10T06:00:00.000Z', clock_ok: false, file_name: `old${i}.jpg` }));
  const timed = [item('2024-03-10T06:00:00.000Z', { upload_batch: 'g', clock_ok: false }), item('2024-03-10T06:01:00.000Z', { upload_batch: 'g', clock_ok: false }),
    item('2024-03-10T07:00:00.000Z', { upload_batch: 'g', clock_ok: false })];
  assert.deepEqual(groupOld([...old('h', 2), ...timed]).map((g) => g.item_ids.length).sort(), [1, 2, 2]);
  const a = old('o1');
  const vs = [visit('ayesha', { photo_required: true, braces_month: 10, started_at: at('18:31'), mr_number: '9820' })];
  const pa = planDay({ ...day(vs, a), batches: [NOTE_BATCH('o1', 'Sana Farooq 9820 M6', 'old', { mr_patients: [p('p-sana', '9820', 'Sana Farooq')] })] });
  assert.equal(pa.groups.length, 1);
  assert.equal(pa.groups[0].auto.visit_id, null);
  assert.equal(pa.groups[0].auto.patient_id, 'p-sana');
  assert.equal(pa.groups[0].auto.rule_kind, 'old_note_mr');
  assert.match(pa.groups[0].auto.rule, /^Automatic \(old_note_mr\): old photos; the note with them names Mr# 9820$/);
  const b = old('o2');
  const pb = planDay({ ...day([], b), batches: [NOTE_BATCH('o2', '9815 9818', 'old', { mr_patients: [p('p-f', '9815', 'Fatima Noor'), p('p-a', '9818', 'Ayesha Kamal', 2)] })] });
  assert.equal(pb.groups[0].auto, null);
  assert.equal(pb.groups[0].wait_reason, 'OLD_SEVERAL');
  assert.deepEqual(pb.groups[0].candidates.map((c: any) => c.patient_id), ['p-f', 'p-a']);
  assert.ok(pb.groups[0].candidates.every((c: any) => c.visit_id === null && c.reasons[0] === 'NOTE_MR'));
  const c = old('o3');
  const pc = planDay({ ...day([], c), batches: [NOTE_BATCH('o3', 'Aisha Khan month 3', 'old', { name_patients: [{ ...p('p-r', '9001', 'Ayesha Rajpoot'), hits: 1 }, { ...p('p-k', '9002', 'Ayesha Khan'), hits: 2 }] })] });
  assert.equal(pc.groups[0].auto, null);
  assert.equal(pc.groups[0].wait_reason, 'OLD_NAME');
  assert.deepEqual(pc.groups[0].candidates.map((x: any) => [x.patient_id, x.reasons[0]]), [['p-k', 'NOTE_NAME_FULL'], ['p-r', 'NOTE_NAME']]);
  const dd = old('o4');
  assert.equal(planDay({ ...day([], dd), batches: [NOTE_BATCH('o4', null, 'old')] }).groups[0].wait_reason, 'OLD_NO_NOTE');
  const e = old('o5');
  assert.equal(planDay({ ...day([], e), batches: [NOTE_BATCH('o5', 'Mr 4444', 'old')] }).groups[0].wait_reason, 'OLD_NOT_FOUND');
});
test('old photos are never matched by time, even at a photo-month patient\'s time', () => {
  const s = sitting('18:35', 4, { upload_batch: 'o9', clock_ok: false, branch_hint: null });
  const vs = [visit('ayesha', { photo_required: true, braces_month: 10, started_at: at('18:31'), completed_at: at('18:49') })];
  const plan = planDay({ ...day(vs, s), batches: [NOTE_BATCH('o9', null, 'old')] });
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.groups[0].auto, null);
  assert.equal(plan.groups[0].wait_reason, 'OLD_NO_NOTE');
  assert.deepEqual(plan.groups[0].candidates, []);
});
