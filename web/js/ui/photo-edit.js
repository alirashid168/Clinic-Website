// The Photo inbox's pixel work, in the browser (Supabase Edge Functions have about 2 s of CPU: decoding one 12 MP photo there takes
// about 1 s, so every pixel is handled here): the photo's fingerprint (SHA-256), its first bytes (for the EXIF), the small copy, the
// 1024 px copy Claude sees, and the edited copy (turn, flip, straighten, crop, gentle levels and colour, at most 2048 px). The maths is
// in lib/photo-intake.js (editPlan, adjustPixels); this file only draws. Never more than one decoded photo at a time.
import { THUMB_EDGE, THUMB_QUALITY, AI_EDGE, AI_QUALITY, EDIT_QUALITY, editPlan, editTransform, adjustPixels } from '../lib/photo-intake.js';

/** SHA-256 of a file, lower-case hex. */
export async function sha256Hex(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** The first n bytes of a file (the EXIF block is in the first 256 kB). */
export async function readHead(blob, n = 262144) {
  return new Uint8Array(await blob.slice(0, n).arrayBuffer());
}
/** The photo decoded upright (its EXIF rotation applied), or null when this browser cannot read it (HEIC outside Safari, a damaged file). */
export async function decode(blob) {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(blob));
  } catch { return null; }
}
const canvasOf = (w, h) => {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
};
/**
 * A canvas's 2D context. iPhone Safari caps the memory of all canvases together and frees it only now and then: when the cap is reached
 * it gives no context. That is a passing problem (code CANVAS: the page pauses and tries again), not a photo it cannot read.
 */
const context = (c, opts) => {
  const ctx = c.getContext('2d', opts);
  if (!ctx) throw Object.assign(new Error('CANVAS: this browser is short of memory for pictures just now. It is tried again in a minute.'), { code: 'CANVAS' });
  return ctx;
};
/** Gives a canvas's memory back at once (iPhone Safari keeps it until the page is tidied otherwise). */
const release = (c) => { try { c.width = 0; c.height = 0; } catch { /* already gone */ } };
const toBlob = (canvas, quality) => new Promise((resolve) => canvas.toBlob((b) => resolve(b && b.size ? b : null), 'image/jpeg', quality));
/** A JPEG copy of a decoded photo with its long edge at most `edge` px (never enlarged), white under transparency. */
async function scaled(bmp, edge, quality) {
  const r = Math.min(1, edge / Math.max(bmp.width, bmp.height));
  const c = canvasOf(bmp.width * r, bmp.height * r);
  try {
    const ctx = context(c);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    return { blob: await toBlob(c, quality), width: c.width, height: c.height };
  } finally { release(c); }
}
/**
 * The small copy (320 px, the same settings as the profile's thumbnails) and the photo's upright size: { blob, width, height }, or
 * { blob: null, width: null, height: null } when the browser cannot decode it. Never throws.
 */
export async function makeThumb(file) {
  const bmp = await decode(file);
  if (!bmp) return { blob: null, width: null, height: null };
  try {
    const t = await scaled(bmp, THUMB_EDGE, THUMB_QUALITY);
    return { blob: t.blob, width: bmp.width, height: bmp.height };
  } catch { return { blob: null, width: bmp.width, height: bmp.height }; } finally { bmp.close?.(); }
}
/** The copy Claude sees: 1024 px long edge, JPEG q0.80, as base64 (no EXIF: a canvas copy keeps no metadata). */
export async function aiCopy(bmp) {
  const t = await scaled(bmp, AI_EDGE, AI_QUALITY);
  if (!t.blob) throw Object.assign(new Error('CANVAS: the photo could not be copied just now.'), { code: 'CANVAS' });
  const bytes = new Uint8Array(await t.blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { image: btoa(bin), width: t.width, height: t.height };
}
/**
 * The edited copy of a decoded photo (ai: Claude's normalized numbers, or null for a basic edit: levels only) and its small copy:
 * { blob, thumb, width, height }.
 */
export async function renderEdit(bmp, ai) {
  const plan = editPlan(ai, bmp.width, bmp.height);
  const c = canvasOf(plan.outW, plan.outH);
  try {
    const ctx = context(c, { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    const m = editTransform({ ...plan, outW: c.width, outH: c.height });
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.drawImage(bmp, plan.sx, plan.sy, plan.sw, plan.sh, -plan.sw / 2, -plan.sh / 2, plan.sw, plan.sh);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    let img = ctx.getImageData(0, 0, c.width, c.height);
    adjustPixels(img.data, { width: c.width, height: c.height, wb: plan.wb, gammaFloor: plan.gammaFloor });
    ctx.putImageData(img, 0, 0);
    img = null;
    const blob = await toBlob(c, EDIT_QUALITY);
    if (!blob) throw Object.assign(new Error('CANVAS: the edited photo could not be made just now.'), { code: 'CANVAS' });
    const small = await scaled(c, THUMB_EDGE, THUMB_QUALITY);
    return { blob, thumb: small.blob, width: c.width, height: c.height };
  } finally { release(c); }
}
/** Safari (iPhone, iPad, Mac) decodes HEIC; other browsers do not. */
export function canHeic(ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '')) {
  return /Safari/.test(ua) && !/Chrome|CriOS|Edg|Android|FxiOS|Firefox/.test(ua);
}
