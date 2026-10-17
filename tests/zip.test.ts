// The Photo library's zip writer (web/js/lib/zip.js): CRC-32 vectors, and a zip read back with a tiny reader (signatures, sizes, UTF-8
// names, CRC checked with Node's own zlib.crc32); too many files are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { crc32, crc32Blob, zipParts, zipPartsBlobs } from '../web/js/lib/zip.js';

const enc = new TextEncoder();
const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

test('crc32: the standard vectors', () => {
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(crc32(enc.encode('123456789')), 0xCBF43926);
  const bytes = enc.encode('Ayesha Khan - Mr# 50013');
  assert.equal(crc32(bytes), (zlib as any).crc32(bytes));
});

test('a 3-file zip reads back: names (UTF-8), sizes, data and CRCs', () => {
  const files = [
    { name: 'Ayesha Khan - Mr# 50013 - Month 6 - Front - 17-10-2026.jpg', bytes: new Uint8Array([0xFF, 0xD8, 1, 2, 3, 0xFF, 0xD9]), date: new Date(2026, 9, 17, 18, 35, 40) },
    { name: 'Ayesha Khan - Mr# 50013 - Month 6 - Upper arch - 17-10-2026.jpg', bytes: enc.encode('second photo'), date: new Date(2026, 9, 17, 18, 36, 0) },
    { name: 'عائشہ - Mr# 50013 - Photo 3 - 17-10-2026.jpg', bytes: new Uint8Array(1000).fill(7), date: new Date(2026, 9, 17) },
  ];
  const zip = join(zipParts(files));
  const dv = new DataView(zip.buffer);
  const endAt = zip.length - 22;
  assert.equal(dv.getUint32(endAt, true), 0x06054b50, 'end of central directory');
  assert.equal(dv.getUint16(endAt + 10, true), 3);
  let c = dv.getUint32(endAt + 16, true);
  const dec = new TextDecoder();
  for (const f of files) {
    assert.equal(dv.getUint32(c, true), 0x02014b50, 'central header');
    assert.equal(dv.getUint16(c + 8, true) & 0x0800, 0x0800, 'UTF-8 names flag');
    assert.equal(dv.getUint16(c + 10, true), 0, 'stored');
    const crc = dv.getUint32(c + 16, true);
    const size = dv.getUint32(c + 20, true);
    const nameLen = dv.getUint16(c + 28, true);
    const local = dv.getUint32(c + 42, true);
    assert.equal(dec.decode(zip.subarray(c + 46, c + 46 + nameLen)), f.name);
    assert.equal(dv.getUint32(local, true), 0x04034b50, 'local header');
    const lNameLen = dv.getUint16(local + 26, true);
    const data = zip.subarray(local + 30 + lNameLen, local + 30 + lNameLen + size);
    assert.deepEqual([...data], [...f.bytes]);
    assert.equal(crc, (zlib as any).crc32(data));
    c += 46 + nameLen;
  }
});

test('more than 65,535 files are refused (no ZIP64)', () => {
  const many = Array.from({ length: 65536 }, (_, i) => ({ name: `${i}.jpg`, bytes: new Uint8Array(0), date: new Date() }));
  assert.throws(() => zipParts(many), /ZIP_TOO_BIG/);
});

test('a zip made from Blobs (the photos as downloaded, never copied into one array) is the same zip', async () => {
  const big = new Uint8Array(5 * 1024 * 1024 + 123);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xFF;
  assert.equal(await crc32Blob(new Blob([big])), (zlib as any).crc32(big), 'the CRC read 4 MB at a time');
  const files = [
    { name: 'A - Mr# 1 - Month 6 - Front - 17-10-2026.jpg', bytes: new Uint8Array([0xFF, 0xD8, 9, 9, 0xFF, 0xD9]), date: new Date(2026, 9, 17, 18, 0, 0) },
    { name: 'A - Mr# 1 - Month 6 - Upper arch - 17-10-2026.jpg', bytes: big, date: new Date(2026, 9, 17, 18, 1, 0) },
  ];
  const fromBytes = join(zipParts(files));
  const parts = await zipPartsBlobs(files.map((f) => ({ name: f.name, blob: new Blob([f.bytes]), date: f.date })));
  assert.ok(parts.some((x: unknown) => x instanceof Blob), 'the photos stay Blobs');
  const fromBlobs = new Uint8Array(await new Blob(parts).arrayBuffer());
  assert.equal(fromBlobs.length, fromBytes.length);
  assert.ok(fromBlobs.every((b, i) => b === fromBytes[i]), 'byte for byte the same');
});
