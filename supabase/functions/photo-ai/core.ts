// The Claude part of the photo-ai Edge Function: the request, the answer, the cost. Pure TypeScript with erasable syntax only and no
// imports, so Node runs it in the tests (tests/photo-ai.test.ts) with a stand-in for the SDK. index.ts does the HTTP, the logins and
// the database. What Claude is sent: the downscaled photos of one sitting labelled "Photo 1" ... "Photo N" (canvas copies: no EXIF,
// no GPS), never a name, Mr#, date, file name or branch. What it answers (structured output, a JSON schema): for each photo the kind,
// the view, which way up, a mirror flip, a small straightening angle, a crop box, exposure and colour hints and problems; and whether
// all the photos look like one patient's sitting.

export const MODEL = 'claude-opus-5-5';
// Opus 5.5 always thinks; effort is the control (its default is medium). This is a perception task (what view, which way up, where to
// crop), not long reasoning, so low keeps the thinking short and the cost down. Raise to 'medium' only if real days show wrong views or
// crops: this one constant.
export const EFFORT = 'low';
export const MAX_TOKENS = 16000;
// Server-side refusal fallback: a request a safety classifier declines is run again on the model Anthropic recommends for that
// category, inside the same call ("default" picks it; the beta header goes with that form).
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// Photos per call: a sitting is usually 5-10 photos. 8 keeps one call well inside the Edge Function's 150 s answer limit (index.ts).
// A longer set goes in several calls; each later call starts with one photo of the earlier call as a reference ("already reported"),
// so the one-sitting check also sees the place where one call ends and the next begins (two patients photographed one after the other).
export const MAX_PHOTOS_PER_CALL = 8;
export const MAX_IMAGE_CHARS = 700000; // base64 of a 1024 px JPEG is ~150-250 kB; anything bigger is refused before it costs anything

export const VIEW_KEYS = ['intra_front', 'intra_right', 'intra_left', 'intra_upper', 'intra_lower', 'intra_overjet', 'intra_closeup',
  'face_front', 'face_smile', 'face_profile_right', 'face_profile_left', 'face_oblique', 'xray', 'document', 'other'];
export const KINDS = ['intraoral', 'extraoral', 'xray', 'document', 'not_clinical'];
const CONFIDENCE = ['high', 'medium', 'low'];
const EXPOSURE = ['ok', 'dark', 'bright'];
const COLOR_CAST = ['none', 'warm', 'cool', 'green', 'magenta'];
const ISSUES = ['blurred', 'too_dark', 'too_bright', 'cut_off', 'fingers_or_retractor', 'duplicate_retake', 'not_patient'];
const ONE_SITTING = ['yes', 'unsure', 'no'];

// US dollars per million tokens (input, output, cache write, cache read). Approximate: the invoice at console.anthropic.com -> Usage is
// the authority. A model not in the list (a fallback model added later) is priced as Opus 5.5.
export const PRICES: Record<string, { in: number; out: number; write: number; read: number }> = {
  'claude-opus-5-5': { in: 4.0, out: 20.0, write: 5.0, read: 0.2 },
  'claude-opus-5': { in: 5.0, out: 25.0, write: 6.25, read: 0.5 },
  'claude-opus-4-8': { in: 5.0, out: 25.0, write: 6.25, read: 0.5 },
};

export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['one_sitting', 'photos'],
  properties: {
    one_sitting: { type: 'string', enum: ONE_SITTING },
    photos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'kind', 'view', 'confidence', 'rotate', 'mirror', 'straighten_deg', 'crop', 'exposure', 'color_cast', 'issues'],
        properties: {
          index: { type: 'integer' },
          kind: { type: 'string', enum: KINDS },
          view: { type: 'string', enum: VIEW_KEYS },
          confidence: { type: 'string', enum: CONFIDENCE },
          rotate: { type: 'integer', enum: [0, 90, 180, 270] },
          mirror: { type: 'boolean' },
          straighten_deg: { type: 'number' },
          crop: {
            type: 'object',
            additionalProperties: false,
            required: ['left', 'top', 'right', 'bottom'],
            properties: { left: { type: 'number' }, top: { type: 'number' }, right: { type: 'number' }, bottom: { type: 'number' } },
          },
          exposure: { type: 'string', enum: EXPOSURE },
          color_cast: { type: 'string', enum: COLOR_CAST },
          issues: { type: 'array', items: { type: 'string', enum: ISSUES } },
        },
      },
    },
  },
};

export const SYSTEM_PROMPT = `You prepare clinical photographs for the patient records of an orthodontic and dental clinic. You receive the photos of
one sitting, labelled Photo 1 to Photo N, downscaled. For each photo, report what it shows and the numbers a program needs
to turn it upright, level it and frame it like standard orthodontic photo records. You do not edit pixels yourself.

For each photo report:
- kind: intraoral (inside the mouth: teeth and gums, with or without cheek retractors or a mirror); extraoral (the face or
  head); xray (a radiograph: film, print, or an X-ray on a screen); document (paper, a form, a prescription, a screen with
  text); not_clinical (anything else: floor, ceiling, an accidental or empty shot).
- view, one of:
  intra_front: teeth together, seen from the front.
  intra_right / intra_left: the side teeth of the PATIENT's right / left side. A side photo taken in a mirror shows the
    side reversed; decide which side of the patient's mouth it really is.
  intra_upper: the whole upper arch seen from below (occlusal view). intra_lower: the whole lower arch seen from above.
  intra_overjet: front teeth seen from the side or from below to show the overjet.
  intra_closeup: a close-up of a few teeth, a bracket, a wire or an appliance.
  face_front: the face from the front, lips at rest. face_smile: the face from the front, smiling.
  face_profile_right / face_profile_left: the face from the side, the patient's right / left side toward the camera.
  face_oblique: the face in three-quarter view.
  xray, document: as the kind says. other: none of these, or you are unsure.
- confidence: high, medium or low for the view.
- rotate: 0, 90, 180 or 270: the clockwise turn that makes the photo upright by the conventions below.
- mirror: true when the upright picture must be flipped left to right. Photos taken in an intraoral mirror are mirror
  images: occlusal views nearly always, side views when a mirror was used. Flipping shows the mouth as seen directly.
- straighten_deg: a small extra clockwise rotation in degrees (negative is counter-clockwise), applied after rotate and
  mirror, that levels the picture: front teeth view, the line of the biting edges horizontal and the midline vertical; side
  views, the biting plane horizontal; occlusal views, the arch midline vertical; face front and smile, the line between the
  pupils horizontal; profiles, the line from the ear canal to the lowest point of the eye socket horizontal. Use 0 when it
  is already level or you are unsure. Never more than 12.
- crop: the part to keep, as fractions of the photo as you see it (before rotate and mirror): left, top, right, bottom,
  each between 0 and 1. Keep every tooth and the gums of the arch shown, with a small margin. Cut away retractor handles,
  fingers, the edge of the mirror and background. For face views keep the whole head and hair and the top of the neck with
  a margin; for profiles keep the nose tip and the back of the head. Never cut through a tooth or the face. Use 0, 0, 1, 1
  when the framing is already good or you are unsure.
- exposure: ok, dark or bright.
- color_cast: none, warm (yellow or orange), cool (blue), green or magenta. Report a cast only when white or grey things
  (retractors, mirror, background, highlights) are clearly tinted. Teeth are naturally off-white: never ask to whiten teeth.
- issues: any of blurred, too_dark, too_bright, cut_off (teeth or face cut off at the edge), fingers_or_retractor (in the
  way), duplicate_retake (another photo of the same view in this sitting is better), not_patient.

Conventions for the upright picture:
- intra_front: upper teeth at the top.
- intra_right: back teeth toward the left edge, front teeth toward the right edge. intra_left: back teeth toward the right
  edge, front teeth toward the left edge. Upper teeth at the top in both.
- intra_upper: front teeth at the top of the picture. intra_lower: front teeth at the bottom of the picture.
- face views: the head upright. face_profile_right: the nose points to the right edge. face_profile_left: the nose points
  to the left edge.
- xray and document: upright so that text or the film reads normally.

Finally one_sitting: yes when all photos look like one patient's sitting (same teeth, braces, wires, elastics, appliances,
fillings, clothing and background); no when they clearly come from two or more different patients; unsure otherwise.
Judge only from teeth, braces, appliances, clothing and background. Do not try to recognize or identify anyone.

Report only what you can see. If you are unsure of a photo, use view other with confidence low, rotate 0, mirror false,
straighten_deg 0 and crop 0, 0, 1, 1 unless the right turn is obvious. Return exactly one entry per photo, in order, with
index equal to the photo number.`;

export type AnalyzeItem = { item_id: string; image: string; width: number; height: number; reference?: boolean };
export type Crop = { left: number; top: number; right: number; bottom: number };
export type PhotoResult = {
  index: number; kind: string; view: string; confidence: string; rotate: number; mirror: boolean; straighten: number;
  crop: Crop; exposure: string; color_cast: string; issues: string[];
};
export type Normalized = { one_sitting: string; photos: PhotoResult[] };
export type Status = 'ok' | 'refused' | 'truncated' | 'invalid';

/**
 * The request to Claude for one sitting's photos (1 to MAX_PHOTOS_PER_CALL). Only "Photo k" labels and the images: no patient data. A
 * reference photo (the first, from an earlier call of the same set) is labelled so; it is reported like the others and counts for
 * one_sitting, and its answer is not used again.
 */
export function buildRequest(items: AnalyzeItem[]) {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: `One sitting, ${items.length} photos.` }];
  items.forEach((it, i) => {
    const ref = it.reference ? ', from the same set, already reported in an earlier request: include it in one_sitting' : '';
    content.push({ type: 'text', text: `Photo ${i + 1} (${Math.round(it.width)}x${Math.round(it.height)} pixels${ref})` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: it.image } });
  });
  content.push({ type: 'text', text: 'Report every photo, in order, with index = the photo number.' });
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: EFFORT, format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
  };
}

const num = (v: unknown, dflt = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const VIEW_FITS: Record<string, (v: string) => boolean> = {
  intraoral: (v) => v.startsWith('intra_'),
  extraoral: (v) => v.startsWith('face_'),
  xray: (v) => v === 'xray',
  document: (v) => v === 'document',
  not_clinical: (v) => v === 'other',
};

/**
 * Claude's answer made safe to act on: exactly one entry per photo 1..n (else null: the answer is invalid); a view that does not fit the
 * kind becomes "other" with low confidence; the straightening clamped to 12 degrees and rounded (under 0.3 is none); a crop that is
 * out of order or keeps less than 30 % either way becomes the whole photo; an uncertain photo ("other", low) is left as it is.
 */
export function normalizeResult(raw: unknown, n: number): Normalized | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.photos) || r.photos.length !== n) return null;
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const p of r.photos as Array<Record<string, unknown>>) {
    if (!p || typeof p !== 'object') return null;
    const i = p.index;
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 1 || i > n || byIndex.has(i)) return null;
    byIndex.set(i, p);
  }
  const photos: PhotoResult[] = [];
  for (let i = 1; i <= n; i++) {
    const p = byIndex.get(i)!;
    const kind = String(p.kind);
    if (!KINDS.includes(kind)) return null;
    let view = VIEW_KEYS.includes(String(p.view)) ? String(p.view) : 'other';
    let confidence = CONFIDENCE.includes(String(p.confidence)) ? String(p.confidence) : 'low';
    if (!VIEW_FITS[kind](view)) { view = 'other'; confidence = 'low'; }
    let rotate = [0, 90, 180, 270].includes(num(p.rotate, -1)) ? num(p.rotate) : 0;
    let mirror = p.mirror === true;
    let straighten = Math.round(clamp(num(p.straighten_deg), -12, 12) * 10) / 10;
    if (Math.abs(straighten) < 0.3) straighten = 0;
    const c = (p.crop && typeof p.crop === 'object' ? p.crop : {}) as Record<string, unknown>;
    let crop: Crop = { left: clamp(num(c.left), 0, 1), top: clamp(num(c.top), 0, 1), right: clamp(num(c.right, 1), 0, 1), bottom: clamp(num(c.bottom, 1), 0, 1) };
    if (crop.right - crop.left < 0.3 || crop.bottom - crop.top < 0.3) crop = { left: 0, top: 0, right: 1, bottom: 1 };
    if (confidence === 'low' && view === 'other') { rotate = 0; mirror = false; straighten = 0; crop = { left: 0, top: 0, right: 1, bottom: 1 }; }
    photos.push({
      index: i, kind, view, confidence, rotate, mirror, straighten, crop,
      exposure: EXPOSURE.includes(String(p.exposure)) ? String(p.exposure) : 'ok',
      color_cast: COLOR_CAST.includes(String(p.color_cast)) ? String(p.color_cast) : 'none',
      issues: [...new Set((Array.isArray(p.issues) ? p.issues : []).map(String).filter((x) => ISSUES.includes(x)))],
    });
  }
  return { one_sitting: ONE_SITTING.includes(String(r.one_sitting)) ? String(r.one_sitting) : 'unsure', photos };
}

type Usage = { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null; iterations?: Array<{ type?: string }> | null };
type Block = { type?: string; text?: string };
type Response = { id?: string; model?: string; stop_reason?: string | null; content?: Block[]; usage?: Usage; _request_id?: string | null };

/** The cost of one call in US dollars (approximate; console.anthropic.com -> Usage is the bill). */
export function costUsd(usage: Usage | undefined, servedModel?: string | null) {
  const p = PRICES[String(servedModel || '')] || PRICES[MODEL];
  const u = usage || {};
  const cost = (num(u.input_tokens) * p.in + num(u.output_tokens) * p.out + num(u.cache_creation_input_tokens) * p.write + num(u.cache_read_input_tokens) * p.read) / 1e6;
  return Math.round(cost * 100000) / 100000;
}

/**
 * What the answer says, the stop reason first: 'refusal' (the whole fallback chain declined) -> refused; 'max_tokens' -> truncated (the
 * page retries with half the photos); 'end_turn' -> the last text block is the JSON (thinking and fallback blocks are skipped by type),
 * normalized -> ok, or invalid when it cannot be read. results: [{ item_id, result }] in the order of itemIds.
 */
export function readResponse(response: Response, itemIds: string[]) {
  const content = Array.isArray(response?.content) ? response.content : [];
  const fallbackUsed = content.some((b) => b?.type === 'fallback') || (response?.usage?.iterations || []).some((x) => x?.type === 'fallback_message');
  const base = { served_model: response?.model || null, fallback_used: fallbackUsed, stop_reason: response?.stop_reason || null };
  if (response?.stop_reason === 'refusal') return { ...base, status: 'refused' as Status, results: [], one_sitting: null };
  if (response?.stop_reason === 'max_tokens') return { ...base, status: 'truncated' as Status, results: [], one_sitting: null };
  if (response?.stop_reason !== 'end_turn') return { ...base, status: 'invalid' as Status, results: [], one_sitting: null };
  const text = [...content].reverse().find((b) => b?.type === 'text' && typeof b.text === 'string');
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text.text as string) : null; } catch { parsed = null; }
  const norm = normalizeResult(parsed, itemIds.length);
  if (!norm) return { ...base, status: 'invalid' as Status, results: [], one_sitting: null };
  return { ...base, status: 'ok' as Status, results: norm.photos.map((p, i) => ({ item_id: itemIds[i], result: p })), one_sitting: norm.one_sitting };
}

/**
 * One call: the request, Claude's answer read, and the row for the cost log (photo_ai_calls, with one_sitting). create is
 * (params) => client.beta.messages.create(params), passed in so the tests need no network. Errors from create propagate (index.ts
 * classifies them and still logs the call).
 */
export async function runAnalyze({ create, items, setId, now = () => Date.now() }: {
  create: (params: ReturnType<typeof buildRequest>) => Promise<Response>;
  items: AnalyzeItem[]; setId: string; now?: () => number;
}) {
  const params = buildRequest(items);
  const started = now();
  const response = await create(params);
  const read = readResponse(response, items.map((it) => it.item_id));
  // the reference photo was answered before: its answer here only served the one-sitting check
  const refs = new Set(items.filter((it) => it.reference).map((it) => it.item_id));
  const results = read.results.filter((r) => !refs.has(r.item_id));
  const usage = response?.usage || {};
  const call = {
    set_id: setId,
    item_ids: items.filter((it) => !it.reference).map((it) => it.item_id),
    photo_count: items.length,
    model: MODEL,
    served_model: read.served_model,
    fallback_used: read.fallback_used,
    status: read.status,
    stop_reason: read.stop_reason,
    error_code: null as string | null,
    input_tokens: num(usage.input_tokens),
    output_tokens: num(usage.output_tokens),
    cache_creation_input_tokens: num(usage.cache_creation_input_tokens),
    cache_read_input_tokens: num(usage.cache_read_input_tokens),
    cost_usd: costUsd(usage, read.served_model),
    duration_ms: Math.max(0, Math.round(now() - started)),
    request_id: response?._request_id || response?.id || null,
    one_sitting: read.one_sitting,
  };
  return { status: read.status, results, call };
}

/**
 * The analyze request's body checked: { set_id, items: [{ item_id, image (base64 JPEG), width, height, reference? }] } with 1-8 items; only
 * the first may be a reference, and at least one is not.
 */
export function checkAnalyzeBody(body: unknown): { ok: true; setId: string; items: AnalyzeItem[] } | { ok: false; why: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const setId = String(b.set_id || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(setId)) return { ok: false, why: 'set_id' };
  const list = Array.isArray(b.items) ? b.items as Array<Record<string, unknown>> : [];
  if (list.length < 1 || list.length > MAX_PHOTOS_PER_CALL) return { ok: false, why: 'items' };
  const items: AnalyzeItem[] = [];
  const seen = new Set<string>();
  for (const it of list) {
    const id = String(it?.item_id || '');
    const image = typeof it?.image === 'string' ? it.image : '';
    const w = Number(it?.width);
    const h = Number(it?.height);
    if (!/^[0-9a-f-]{36}$/.test(id) || seen.has(id)) return { ok: false, why: 'item_id' };
    if (!image.startsWith('/9j/') || image.length > MAX_IMAGE_CHARS || !/^[A-Za-z0-9+/=]+$/.test(image)) return { ok: false, why: 'image' };
    if (!(w > 0 && w <= 10000 && h > 0 && h <= 10000)) return { ok: false, why: 'size' };
    if (it?.reference === true && items.length > 0) return { ok: false, why: 'reference' };
    seen.add(id);
    items.push(it?.reference === true ? { item_id: id, image, width: w, height: h, reference: true } : { item_id: id, image, width: w, height: h });
  }
  if (!items.some((it) => !it.reference)) return { ok: false, why: 'reference' };
  return { ok: true, setId, items };
}
