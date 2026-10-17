// A small zip writer for the Photo library's "Download selected (zip)": store only (JPEG photos do not get smaller when compressed),
// UTF-8 names (general flag bit 11), no ZIP64 (at most 65,535 files and 4 GB, far beyond the library's cap of 300 files and 1.5 GB).
// Pure: no DOM. The page makes new Blob(zipParts(files), { type: 'application/zip' }) and saves it (tests/zip.test.ts reads one back).

let table = null;
/** CRC-32 (the zip and PNG one: polynomial 0xEDB88320). */
export function crc32(bytes) {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const MAX_FILES = 65535;
const MAX_TOTAL = 0xFFFFFFFF;

function dosTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * The parts of a zip file (local headers, the data, the central directory and its end record), in order: [Uint8Array].
 * files: [{ name, bytes: Uint8Array, date: Date }]. Names must already be unique (photo-intake.js uniqueNames). Throws for more than
 * 65,535 files or 4 GB in all.
 */
export function zipParts(files) {
  if (files.length > MAX_FILES) throw new Error('ZIP_TOO_BIG: too many files for one zip. Choose fewer photos.');
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
    const crc = crc32(data);
    const { time, date } = dosTime(f.date);
    if (offset + 30 + name.length + data.length > MAX_TOTAL) throw new Error('ZIP_TOO_BIG: the photos are too large for one zip. Choose fewer photos.');
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    const head = new Uint8Array(46 + name.length);
    const cv = new DataView(head.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // made by
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    head.set(name, 46);
    parts.push(local, data);
    central.push(head);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  if (offset + centralSize + 22 > MAX_TOTAL) throw new Error('ZIP_TOO_BIG: the photos are too large for one zip. Choose fewer photos.');
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return [...parts, ...central, end];
}
