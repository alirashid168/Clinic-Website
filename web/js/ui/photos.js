// Small copies of clinic photos: made in the browser when a photo is uploaded, and signed again by the photo grids.

const THUMB_EDGE = 320; // px, long edge
const THUMB_QUALITY = 0.8;

/**
 * A JPEG copy of an image, its long edge at most THUMB_EDGE px (never enlarged), or null when the browser cannot read the
 * file (HEIC on desktop Chrome, a damaged file): the photo is then saved without a small copy. Never throws.
 */
export async function makeThumbnail(file) {
  if (!file || typeof createImageBitmap !== 'function') return null;
  let bmp;
  try {
    // The camera's rotation (EXIF) is applied, so a portrait phone photo gets a portrait thumbnail. A browser that does not
    // know the option decodes with its own default.
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
    const scale = Math.min(1, THUMB_EDGE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // a transparent PNG would turn black as a JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', THUMB_QUALITY));
    return blob?.size ? blob : null;
  } catch { return null; } finally { bmp?.close?.(); }
}

/**
 * Map(storage_path -> fresh link to the photo's small image), for photos whose link is missing or has expired.
 * A photo with a stored thumbnail (thumb_path) gets that file's link; the others get a resized original (the data layer
 * resizes only when image transformations are on, else it is the original). A file that cannot be signed (the role may
 * not read it) is left out, so the caller keeps whatever it already shows.
 */
export async function signThumbs(d, photos, width) {
  const out = new Map();
  const stored = photos.filter((ph) => ph.thumb_path);
  const rest = photos.filter((ph) => !ph.thumb_path && ph.storage_path);
  const [thumbs, resized] = await Promise.all([
    stored.length ? d.signedUrls(stored.map((ph) => ph.thumb_path)).catch(() => null) : null,
    rest.length ? d.signedUrls(rest.map((ph) => ph.storage_path), { width }).catch(() => null) : null,
  ]);
  for (const ph of stored) { const url = thumbs?.get?.(ph.thumb_path); if (url) out.set(ph.storage_path, url); }
  for (const ph of rest) { const url = resized?.get?.(ph.storage_path); if (url) out.set(ph.storage_path, url); }
  return out;
}
