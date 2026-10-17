// The photo-ai Edge Function (supabase/functions/photo-ai): its Claude core (core.ts) with a stand-in for the SDK, and index.ts through
// its real request handler with stand-ins for Deno, supabase-js and @anthropic-ai/sdk. No network, no real Claude call. What it pins down:
//   - the request: claude-opus-5-5, adaptive thinking, effort low, structured output (JSON schema), the server-side refusal fallback
//     ("default" + its beta header), the system prompt cached, "Photo k" labels and the images only (no patient data);
//   - the answer: stop reason first (refusal, max_tokens), the last text block parsed, one entry per photo, ranges clamped;
//   - the cost per call (cache reads, a fallback model);
//   - the handler: login (401), permission (403), no key (NO_KEY), status never echoes the key, a set of another city refused, the call
//     recorded through the service role with who asked, the SDK's typed errors as codes (RATE_LIMIT with retry_after, BAD_KEY), and no
//     image data in the logs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import {
  MODEL, EFFORT, MAX_TOKENS, FALLBACK_BETA, SYSTEM_PROMPT, OUTPUT_SCHEMA, buildRequest, readResponse, normalizeResult, costUsd, runAnalyze, checkAnalyzeBody,
} from '../supabase/functions/photo-ai/core.ts';

const IMG = '/9j/4AAQSkZJRgABAQ' + 'A'.repeat(200);
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const SET = '33333333-3333-4333-8333-333333333333';
const items = [{ item_id: ID1, image: IMG, width: 1024, height: 768 }, { item_id: ID2, image: IMG, width: 768, height: 1024 }];
const photo = (index: number, o: Record<string, unknown> = {}) => ({ index, kind: 'intraoral', view: 'intra_front', confidence: 'high', rotate: 0, mirror: false,
  straighten_deg: 0, crop: { left: 0, top: 0, right: 1, bottom: 1 }, exposure: 'ok', color_cast: 'none', issues: [], ...o });
const answer = (body: unknown, o: Record<string, unknown> = {}) => ({
  id: 'msg_1', model: MODEL, stop_reason: 'end_turn', _request_id: 'req_1',
  content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(body) }],
  usage: { input_tokens: 2000, output_tokens: 1500, cache_creation_input_tokens: 0, cache_read_input_tokens: 1600 }, ...o,
});

test('buildRequest: model, thinking, effort, structured output, fallback, cached system prompt, labels and images only', () => {
  const r = buildRequest(items) as any;
  assert.equal(r.model, 'claude-opus-5-5');
  assert.equal(r.max_tokens, MAX_TOKENS);
  assert.deepEqual(r.thinking, { type: 'adaptive' });
  assert.equal(EFFORT, 'low');
  assert.deepEqual(r.output_config, { effort: 'low', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } });
  assert.deepEqual(r.betas, [FALLBACK_BETA]);
  assert.equal(FALLBACK_BETA, 'server-side-fallback-2026-07-01');
  assert.equal(r.fallbacks, 'default');
  assert.deepEqual(r.system, [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
  assert.equal(r.temperature, undefined);
  assert.equal(r.tool_choice, undefined);
  const c = r.messages[0].content;
  assert.equal(r.messages.length, 1);
  assert.deepEqual(c.map((b: any) => b.type), ['text', 'text', 'image', 'text', 'image', 'text']);
  assert.equal(c[0].text, 'One sitting, 2 photos.');
  assert.equal(c[1].text, 'Photo 1 (1024x768 pixels)');
  assert.equal(c[3].text, 'Photo 2 (768x1024 pixels)');
  assert.deepEqual(c[2].source, { type: 'base64', media_type: 'image/jpeg', data: IMG });
  assert.equal(c[5].text, 'Report every photo, in order, with index = the photo number.');
  const texts = JSON.stringify(c.filter((b: any) => b.type === 'text'));
  assert.ok(!/Mr#|[0-9]{4}-[0-9]{2}-[0-9]{2}|IMG_|\.jpg/i.test(texts), 'no names, Mr#, dates or file names');
  assert.ok(SYSTEM_PROMPT.length > 3000, 'the cached prefix is long enough to cache');
  assert.ok(!OUTPUT_SCHEMA.properties.photos.items.properties.straighten_deg.hasOwnProperty('minimum'), 'no minimum/maximum in the schema');
});

test('readResponse: end_turn with thinking and text, refusal, max_tokens, invalid JSON, a wrong count', () => {
  const ok = readResponse(answer({ one_sitting: 'yes', photos: [photo(1), photo(2, { view: 'intra_upper', mirror: true })] }) as any, [ID1, ID2]);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.one_sitting, 'yes');
  assert.deepEqual(ok.results.map((r) => r.item_id), [ID1, ID2]);
  assert.equal(ok.results[1].result.view, 'intra_upper');
  assert.equal(ok.results[1].result.mirror, true);
  assert.equal(ok.fallback_used, false);
  assert.equal(readResponse({ stop_reason: 'refusal', content: [], model: MODEL } as any, [ID1]).status, 'refused');
  assert.equal(readResponse({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"one' }] } as any, [ID1]).status, 'truncated');
  assert.equal(readResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] } as any, [ID1]).status, 'invalid');
  assert.equal(readResponse(answer({ one_sitting: 'yes', photos: [photo(1)] }) as any, [ID1, ID2]).status, 'invalid', 'one photo missing');
  assert.equal(readResponse(answer({ one_sitting: 'yes', photos: [photo(1), photo(1)] }) as any, [ID1, ID2]).status, 'invalid', 'an index twice');
  const fb = readResponse(answer({ one_sitting: 'no', photos: [photo(1)] }, { model: 'claude-opus-4-8', content: [{ type: 'fallback', from: {}, to: {} }, { type: 'text', text: JSON.stringify({ one_sitting: 'no', photos: [photo(1)] }) }] }) as any, [ID1]);
  assert.equal(fb.fallback_used, true);
  assert.equal(fb.served_model, 'claude-opus-4-8');
  assert.equal(fb.one_sitting, 'no');
});

test('normalizeResult: clamps, a view that does not fit the kind, an uncertain photo left alone, issues once', () => {
  const r = normalizeResult({ one_sitting: 'maybe', photos: [
    photo(1, { straighten_deg: 30.27, crop: { left: -0.2, top: 0.1, right: 1.4, bottom: 0.9 }, issues: ['blurred', 'blurred', 'unknown'] }),
    photo(2, { kind: 'extraoral', view: 'intra_front', rotate: 90 }),
    photo(3, { view: 'other', confidence: 'low', rotate: 180, mirror: true, straighten_deg: 4, crop: { left: 0.2, top: 0.2, right: 0.8, bottom: 0.8 } }),
    photo(4, { straighten_deg: 0.2, crop: { left: 0.5, top: 0, right: 0.6, bottom: 1 } }),
  ] }, 4)!;
  assert.equal(r.one_sitting, 'unsure');
  assert.equal(r.photos[0].straighten, 12);
  assert.deepEqual(r.photos[0].crop, { left: 0, top: 0.1, right: 1, bottom: 0.9 });
  assert.deepEqual(r.photos[0].issues, ['blurred']);
  assert.equal(r.photos[1].view, 'other');
  assert.equal(r.photos[1].confidence, 'low');
  assert.deepEqual([r.photos[2].rotate, r.photos[2].mirror, r.photos[2].straighten, r.photos[2].crop], [0, false, 0, { left: 0, top: 0, right: 1, bottom: 1 }]);
  assert.equal(r.photos[3].straighten, 0, 'under 0.3 degrees is none');
  assert.deepEqual(r.photos[3].crop, { left: 0, top: 0, right: 1, bottom: 1 }, 'a crop keeping under 30 % is the whole photo');
  assert.equal(normalizeResult({ photos: [photo(1, { kind: 'cat' })] }, 1), null);
  assert.equal(normalizeResult(null, 1), null);
});

test('costUsd: input, output, cache reads and writes; a fallback model at its own price', () => {
  assert.equal(costUsd({ input_tokens: 1_000_000, output_tokens: 0 }, MODEL), 4);
  assert.equal(costUsd({ input_tokens: 2000, output_tokens: 1500, cache_read_input_tokens: 1600, cache_creation_input_tokens: 0 }, MODEL), 0.03832);
  assert.equal(costUsd({ cache_creation_input_tokens: 1_000_000 }, MODEL), 5);
  assert.equal(costUsd({ output_tokens: 1_000_000 }, 'claude-opus-4-8'), 25);
  assert.equal(costUsd({ output_tokens: 1_000_000 }, 'some-new-model'), 20, 'an unknown model is priced as Opus 5.5');
});

test('runAnalyze: one call through the injected create, the cost log row with one_sitting', async () => {
  let sent: any = null;
  let t = 1000;
  const out = await runAnalyze({ create: async (p) => { sent = p; t += 4321; return answer({ one_sitting: 'yes', photos: [photo(1), photo(2)] }) as any; }, items, setId: SET, now: () => t });
  assert.equal(sent.model, MODEL);
  assert.equal(out.status, 'ok');
  assert.equal(out.call.set_id, SET);
  assert.deepEqual(out.call.item_ids, [ID1, ID2]);
  assert.equal(out.call.photo_count, 2);
  assert.equal(out.call.cost_usd, 0.03832);
  assert.equal(out.call.duration_ms, 4321);
  assert.equal(out.call.one_sitting, 'yes');
  assert.equal(out.call.request_id, 'req_1');
});

test('checkAnalyzeBody: a set, 1-8 photos, base64 JPEGs of a sane size', () => {
  assert.equal(checkAnalyzeBody({ set_id: SET, items }).ok, true);
  assert.equal(checkAnalyzeBody({ set_id: 'x', items }).ok, false);
  assert.equal(checkAnalyzeBody({ set_id: SET, items: [] }).ok, false);
  assert.equal(checkAnalyzeBody({ set_id: SET, items: Array.from({ length: 9 }, (_, i) => ({ ...items[0], item_id: `${String(i).repeat(8)}-1111-4111-8111-111111111111` })) }).ok, false);
  assert.equal(checkAnalyzeBody({ set_id: SET, items: [{ ...items[0], image: 'iVBORw0KGgo=' }] }).ok, false, 'a PNG');
  assert.equal(checkAnalyzeBody({ set_id: SET, items: [{ ...items[0], image: '/9j/' + 'A'.repeat(700001) }] }).ok, false, 'too large');
  assert.equal(checkAnalyzeBody({ set_id: SET, items: [items[0], items[0]] }).ok, false, 'the same photo twice');
  assert.equal(checkAnalyzeBody({ set_id: SET, items: [{ ...items[0], reference: true }, items[1]] }).ok, true, 'a reference photo first');
  assert.equal(checkAnalyzeBody({ set_id: SET, items: [items[0], { ...items[1], reference: true }] }).ok, false, 'a reference photo only first');
  assert.equal(checkAnalyzeBody({ set_id: SET, items: [{ ...items[0], reference: true }] }).ok, false, 'not only a reference photo');
});

test('runAnalyze: a reference photo from an earlier call is labelled, counts for one_sitting, and its answer is not used again', async () => {
  let sent: any = null;
  const out = await runAnalyze({ create: async (p) => { sent = p; return answer({ one_sitting: 'no', photos: [photo(1), photo(2, { view: 'intra_left' })] }) as any; },
    items: [{ ...items[0], reference: true }, items[1]], setId: SET });
  const labels = sent.messages[0].content.filter((b: any) => b.type === 'text').map((b: any) => b.text);
  assert.match(labels[1], /^Photo 1 \(1024x768 pixels, from the same set, already reported in an earlier request: include it in one_sitting\)$/);
  assert.equal(labels[2], 'Photo 2 (768x1024 pixels)');
  assert.deepEqual(out.results.map((r) => r.item_id), [ID2], 'only the new photo is answered');
  assert.deepEqual(out.call.item_ids, [ID2]);
  assert.equal(out.call.photo_count, 2, 'the reference photo is paid for');
  assert.equal(out.call.one_sitting, 'no', 'a change of patient between two calls is seen');
});

// ---------------------------------------------------------------- the handler
const env: Record<string, string> = { SUPABASE_URL: 'http://localhost', SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'service-key' };
const world = { user: 'staff-1' as string | null, allowed: true, setVisible: true, rpcs: [] as Array<[string, any]>, opts: null as any, create: null as any,
  itemRows: null as null | ((ids: string[]) => Array<{ id: string; set_id: string; ai_status: string }>) };
let handler: (req: Request) => Promise<Response>;
(globalThis as any).Deno = { env: { get: (k: string) => env[k] }, serve: (h: typeof handler) => { handler = h; } };
(globalThis as any).__fakeCreateClient = (_url: string, key: string) => (key === 'service-key'
  ? { rpc: async (name: string, args: any) => { world.rpcs.push([name, args]); return { data: { call_id: 1 }, error: null }; } }
  : {
    auth: { getUser: async () => ({ data: { user: world.user ? { id: world.user } : null } }) },
    rpc: async (name: string) => (name === 'photo_inbox_ai_allowed' ? { data: world.allowed, error: null } : { data: null, error: null }),
    from: () => ({ select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: world.setVisible ? { id: SET } : null, error: null }) }),
      in: async (_col: string, ids: string[]) => ({ data: world.itemRows ? world.itemRows(ids) : ids.map((id) => ({ id, set_id: SET, ai_status: 'pending' })), error: null }),
    }) }),
  });
(globalThis as any).__fakeAnthropic = world;
const SDK = `
class APIError extends Error { constructor(status, message, headers) { super(message); this.status = status; this.headers = headers; } }
class APIConnectionError extends APIError {}
class RateLimitError extends APIError {}
class AuthenticationError extends APIError {}
class PermissionDeniedError extends APIError {}
class BadRequestError extends APIError {}
export default class Anthropic {
  constructor(opts) { globalThis.__fakeAnthropic.opts = opts; this.beta = { messages: { create: (p) => globalThis.__fakeAnthropic.create(p) } }; }
}
Object.assign(Anthropic, { APIError, APIConnectionError, RateLimitError, AuthenticationError, PermissionDeniedError, BadRequestError });
globalThis.__AnthropicErrors = Anthropic;`;
registerHooks({
  resolve(spec, ctx, nextResolve) {
    if (spec.startsWith('npm:@supabase/supabase-js@')) return { url: 'data:text/javascript,export const createClient = (...a) => globalThis.__fakeCreateClient(...a);', shortCircuit: true };
    if (spec.startsWith('npm:@anthropic-ai/sdk@')) return { url: `data:text/javascript,${encodeURIComponent(SDK)}`, shortCircuit: true };
    return nextResolve(spec, ctx);
  },
});
await import('../supabase/functions/photo-ai/index.ts');
const E = () => (globalThis as any).__AnthropicErrors;

async function call(body: unknown) {
  const res = await handler(new Request('http://localhost/functions/v1/photo-ai', { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() as any };
}
const reset = (o: Partial<typeof world> = {}) => { Object.assign(world, { user: 'staff-1', allowed: true, setVisible: true, rpcs: [], opts: null, create: null, itemRows: null }, o); delete env.ANTHROPIC_API_KEY; };
const logs: string[] = [];
const origLog = console.log;
console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };

test('handler: 401 without a login, 403 without the Photo inbox, status says whether the key is set and never the key', async () => {
  reset({ user: null });
  assert.equal((await call({ action: 'status' })).status, 401);
  reset({ allowed: false });
  assert.equal((await call({ action: 'status' })).status, 403);
  reset();
  assert.deepEqual((await call({ action: 'status' })).body, { ok: true, key: false, model: MODEL });
  env.ANTHROPIC_API_KEY = 'sk-ant-secret-value';
  const r = await call({ action: 'status' });
  assert.deepEqual(r.body, { ok: true, key: true, model: MODEL });
  assert.ok(!JSON.stringify(r.body).includes('secret'));
});

test('handler: analyze without the key says NO_KEY and calls nobody; a bad body is 400; another city\'s set is 403', async () => {
  reset();
  world.create = async () => { throw new Error('must not be called'); };
  assert.deepEqual((await call({ action: 'analyze', set_id: SET, items })).body, { ok: false, code: 'NO_KEY' });
  assert.deepEqual(await call({ action: 'analyze', set_id: SET, items: [] }), { status: 400, body: { ok: false, code: 'BAD_BODY' } }, 'its own refusal is BAD_BODY, not an Anthropic 400');
  env.ANTHROPIC_API_KEY = 'k';
  world.setVisible = false;
  assert.equal((await call({ action: 'analyze', set_id: SET, items })).status, 403);
  assert.equal(world.rpcs.length, 0);
});

test('handler: analyze calls Claude once (no SDK retries, a time limit under the 150 s answer limit) and records the call through the service role', async () => {
  reset();
  env.ANTHROPIC_API_KEY = 'k';
  let params: any = null;
  world.create = async (p: any) => { params = p; return answer({ one_sitting: 'yes', photos: [photo(1), photo(2)] }); };
  const r = await call({ action: 'analyze', set_id: SET, items });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.status, 'ok');
  assert.equal(r.body.results.length, 2);
  assert.equal(r.body.cost_usd, 0.03832);
  assert.equal(params.fallbacks, 'default');
  assert.equal(world.opts.apiKey, 'k');
  assert.equal(world.opts.maxRetries, 0);
  assert.ok(world.opts.timeout <= 120000);
  const [name, args] = world.rpcs[0];
  assert.equal(name, 'photo_inbox_ai_record');
  assert.equal(args.p_call.called_by, 'staff-1');
  assert.equal(args.p_call.status, 'ok');
  assert.equal(args.p_call.one_sitting, 'yes');
  assert.equal(args.p_results.length, 2);
});

test('handler: the SDK\'s typed errors become codes the page acts on, and the failed call is still logged', async () => {
  reset();
  env.ANTHROPIC_API_KEY = 'k';
  world.create = async () => { throw new (E().RateLimitError)(429, 'rate limited', new Headers({ 'retry-after': '42' })); };
  assert.deepEqual((await call({ action: 'analyze', set_id: SET, items })).body, { ok: false, code: 'RATE_LIMIT', retry_after: 42 });
  assert.equal(world.rpcs.at(-1)![1].p_call.status, 'error');
  assert.equal(world.rpcs.at(-1)![1].p_call.error_code, 'RATE_LIMIT');
  world.create = async () => { throw new (E().AuthenticationError)(401, 'invalid x-api-key'); };
  assert.equal((await call({ action: 'analyze', set_id: SET, items })).body.code, 'BAD_KEY');
  world.create = async () => { throw new (E().APIConnectionError)(undefined, 'timeout'); };
  assert.equal((await call({ action: 'analyze', set_id: SET, items })).body.code, 'NETWORK');
  world.create = async () => { throw new (E().APIError)(529, 'overloaded'); };
  assert.equal((await call({ action: 'analyze', set_id: SET, items })).body.code, 'API_DOWN');
  world.create = async () => { throw new (E().BadRequestError)(400, 'bad'); };
  assert.equal((await call({ action: 'analyze', set_id: SET, items })).body.code, 'BAD_REQUEST');
  assert.equal(world.rpcs.at(-1)![1].p_call.error_code, 'BAD_REQUEST', 'logged with its code (the database counts it as a try)');
  world.create = async () => { throw new (E().APIError)(402, 'credit balance is too low'); };
  assert.equal((await call({ action: 'analyze', set_id: SET, items })).body.code, 'BILLING', 'no credit left: the page stops and says so');
  world.create = async () => { throw new (E().APIError)(404, 'model not found'); };
  assert.equal((await call({ action: 'analyze', set_id: SET, items })).body.code, 'CONFIG');
  world.create = async () => { throw new (E().APIError)(413, 'too large'); };
  assert.equal((await call({ action: 'analyze', set_id: SET, items })).body.code, 'CONFIG');
  world.create = async () => { throw new TypeError('boom'); };
  assert.equal((await call({ action: 'analyze', set_id: SET, items })).body.code, 'SERVER');
});

test('handler: only photos of the set that still wait for Claude are sent (another page did the others: nothing is paid twice)', async () => {
  reset();
  env.ANTHROPIC_API_KEY = 'k';
  world.itemRows = (ids) => ids.map((id) => ({ id, set_id: SET, ai_status: id === ID1 ? 'done' : 'pending' }));
  let sent: any = null;
  world.create = async (p: any) => { sent = p; return answer({ one_sitting: 'yes', photos: [photo(1)] }); };
  const r = await call({ action: 'analyze', set_id: SET, items });
  assert.equal(r.body.status, 'ok');
  assert.equal(sent.messages[0].content.filter((b: any) => b.type === 'image').length, 1, 'only the photo still waiting');
  assert.deepEqual(r.body.results.map((x: any) => x.item_id), [ID2]);
  world.itemRows = (ids) => ids.map((id) => ({ id, set_id: SET, ai_status: 'done' }));
  world.create = async () => { throw new Error('must not be called'); };
  assert.deepEqual((await call({ action: 'analyze', set_id: SET, items })).body, { ok: true, status: 'skipped', results: [], cost_usd: 0, served_model: null });
  world.itemRows = (ids) => ids.map((id) => ({ id, set_id: '44444444-4444-4444-8444-444444444444', ai_status: 'pending' }));
  assert.equal((await call({ action: 'analyze', set_id: SET, items })).body.status, 'skipped', 'photos of another set are never sent');
});

test('handler: nothing of the images (or the key) reaches the logs', () => {
  console.log = origLog;
  const all = logs.join('\n');
  assert.ok(logs.length > 0);
  assert.ok(!all.includes(IMG.slice(0, 30)) && !all.includes('/9j/'), 'no image data');
  assert.ok(!all.includes('sk-ant-secret-value'), 'no key');
});
