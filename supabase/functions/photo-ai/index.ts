// Supabase Edge Function: Claude Opus 5.5 looks at the downscaled photos of one sitting and says how to edit them (Photo inbox, owner
// 17 Oct 2026). The Claude key must never be in the website, so the browser sends the small copies here; this function checks who is
// asking, calls Claude, writes the answer and the cost into the database with the service role, and answers the page. The page then
// edits the original in the browser (Edge Functions have about 2 s of CPU: no pixel work here) and saves the edited copy.
//
//   POST { action: 'status' }  -> { ok: true, key: boolean, model }   (key: whether ANTHROPIC_API_KEY is set; never the key itself)
//   POST { action: 'analyze', set_id, items: [{ item_id, image (base64 JPEG <= 1024 px), width, height, reference? }] }   (1-8 photos;
//        the first may be a reference photo of the same set from an earlier call, for the one-sitting check)
//        -> { ok: true, status: 'ok' | 'refused' | 'truncated' | 'invalid' | 'skipped', results: [{ item_id, result }], cost_usd, served_model }
//        or { ok: false, code, retry_after? } with code:
//           BAD_BODY (this function refused the request itself: the page makes a basic edit), NO_KEY, BAD_KEY, BILLING (no credit left
//           at Anthropic), CONFIG (the model or the request size was refused: a setup problem) - the page stops editing and says so;
//           BAD_REQUEST (Anthropic refused these photos: counted as one of the photo's 3 tries); RATE_LIMIT, API_DOWN, NETWORK, SERVER -
//           the page waits and tries again (not counted against the photos).
//        'skipped': none of the photos still waited for Claude (another page did them): nothing was sent.
// Who may: anyone with "Use the Photo inbox" and "View raw clinic photos folder" (public.photo_inbox_ai_allowed), for a set of a city
// they may use (the set must be readable through their own login). Nothing about the patient is sent to Claude (core.ts).
//
// Deploy: supabase functions deploy photo-ai (index.ts and core.ts; verify_jwt on, like admin-users). The key: Supabase dashboard ->
// Edge Functions -> Secrets -> ANTHROPIC_API_KEY (Dr. Ali adds it himself). Without it, status says key false and analyze NO_KEY.
// Time: Supabase ends a request that has not answered within 150 s, so one Claude call waits at most 110 s and is not retried here
// (the page tries the photos again later).
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
// The newest @anthropic-ai/sdk on 17 Oct 2026 (npm view @anthropic-ai/sdk version: 0.135.0); bump on purpose, after testing.
import Anthropic from 'npm:@anthropic-ai/sdk@0.135.0';
import { MODEL, checkAnalyzeBody, runAnalyze } from './core.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const CLAUDE_TIMEOUT_MS = 110_000;

/** The SDK's typed errors, most specific first, as the codes the page acts on. */
function classify(e: unknown): { code: string; retry_after?: number } {
  if (e instanceof Anthropic.RateLimitError) {
    const h = (e as { headers?: unknown }).headers as { get?: (k: string) => string | null } | Record<string, string> | undefined;
    const raw = h && typeof (h as { get?: unknown }).get === 'function' ? (h as { get: (k: string) => string | null }).get('retry-after') : (h as Record<string, string> | undefined)?.['retry-after'];
    const secs = Number(raw);
    return { code: 'RATE_LIMIT', retry_after: Number.isFinite(secs) && secs > 0 ? Math.min(600, Math.ceil(secs)) : 30 };
  }
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return { code: 'BAD_KEY' };
  if (e instanceof Anthropic.BadRequestError) return { code: 'BAD_REQUEST' };
  if (e instanceof Anthropic.APIConnectionError) return { code: 'NETWORK' };
  const status = Number((e as { status?: number })?.status);
  if (status === 402) return { code: 'BILLING' };
  if (status === 404 || status === 413) return { code: 'CONFIG' };
  if (e instanceof Anthropic.APIError && status >= 500) return { code: 'API_DOWN' };
  return { code: 'SERVER' };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, code: 'BAD_REQUEST', error: 'Use POST' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const authHeader = req.headers.get('Authorization') ?? '';
  const asCaller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });

  const { data: userData } = await asCaller.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return json({ ok: false, code: 'LOGIN', error: 'Please log in again.' }, 401);
  const { data: allowed } = await asCaller.rpc('photo_inbox_ai_allowed');
  if (allowed !== true) return json({ ok: false, code: 'NOT_ALLOWED', error: 'The Photo inbox needs "Use the Photo inbox" and "View raw clinic photos folder" in the access list.' }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, code: 'BAD_BODY' }, 400); }
  const apiKey = (Deno.env.get('ANTHROPIC_API_KEY') ?? '').trim();

  if (body?.action === 'status') return json({ ok: true, key: apiKey.length > 0, model: MODEL });
  if (body?.action !== 'analyze') return json({ ok: false, code: 'BAD_BODY', error: 'Unknown action' }, 400);

  const checked = checkAnalyzeBody(body);
  if (!checked.ok) { console.log('photo-ai bad request', checked.why); return json({ ok: false, code: 'BAD_BODY' }, 400); }
  if (!apiKey) return json({ ok: false, code: 'NO_KEY' });
  // The set must be one the caller may see (its city): read through their own login, so the inbox's row rules decide.
  const { data: set } = await asCaller.from('photo_inbox_sets').select('id').eq('id', checked.setId).maybeSingle();
  if (!set) return json({ ok: false, code: 'NOT_ALLOWED', error: 'These photos are not in a city folder you may use.' }, 403);
  // Each photo must be of that set; the ones to answer must still wait for Claude (two pages of one login, or a slow page whose claim ran
  // out, may send the same photos: they are paid for once). A reference photo must be of the set too.
  const ids = checked.items.map((it) => it.item_id);
  const { data: rows } = await asCaller.from('photo_inbox_items').select('id, set_id, ai_status').in('id', ids);
  const known = new Map((rows || []).map((r: { id: string; set_id: string; ai_status: string }) => [r.id, r]));
  const items = checked.items.filter((it) => known.get(it.item_id)?.set_id === checked.setId && (it.reference || known.get(it.item_id)?.ai_status === 'pending'));
  if (!items.some((it) => !it.reference)) return json({ ok: true, status: 'skipped', results: [], cost_usd: 0, served_model: null });

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const record = async (call: Record<string, unknown>, results: unknown[]) => {
    const { data, error } = await admin.rpc('photo_inbox_ai_record', { p_call: { ...call, called_by: userId }, p_results: results });
    if (error) console.log('photo-ai record failed', checked.setId, error.code ?? '', error.message ?? '');
    return data;
  };

  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: CLAUDE_TIMEOUT_MS });
  const started = Date.now();
  try {
    // deno-lint-ignore no-explicit-any
    const out = await runAnalyze({ create: (params) => client.beta.messages.create(params as any) as any, items, setId: checked.setId });
    await record(out.call, out.results);
    console.log('photo-ai', checked.setId, out.status, `photos=${out.call.photo_count}`, `in=${out.call.input_tokens}`, `out=${out.call.output_tokens}`,
      `cache_read=${out.call.cache_read_input_tokens}`, `cache_write=${out.call.cache_creation_input_tokens}`, `model=${out.call.served_model}`, `ms=${out.call.duration_ms}`);
    return json({ ok: true, status: out.status, results: out.results, cost_usd: out.call.cost_usd, served_model: out.call.served_model });
  } catch (e) {
    const c = classify(e);
    console.log('photo-ai error', checked.setId, c.code, `status=${(e as { status?: number })?.status ?? ''}`, `photos=${items.length}`);
    await record({
      set_id: checked.setId, item_ids: items.filter((it) => !it.reference).map((it) => it.item_id), photo_count: items.length, model: MODEL,
      status: 'error', error_code: c.code, duration_ms: Date.now() - started,
      request_id: (e as { requestID?: string; request_id?: string })?.requestID ?? (e as { request_id?: string })?.request_id ?? null,
    }, []).catch(() => null);
    return json({ ok: false, ...c });
  }
});
