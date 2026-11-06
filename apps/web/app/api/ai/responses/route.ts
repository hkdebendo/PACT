// Server-side proxy between AG Studio's LLM adapter (browser, OpenAI Responses format) and Meta's
// Model API (Muse). The Meta key never reaches the browser.
//
// - The model is always MUSE_MODEL from .env.local, whatever the browser asks for.
// - Upstream is called non-streaming (`stream: false`) and the reply is re-emitted as the Responses
//   SSE events the adapter reads (output_item.added / *.delta / output_item.done / completed).
//   This works whether or not the provider streams the Responses API.
// - LLM_MODE=live records each reply to fixtures/llm-cache/studio/; LLM_MODE=replay serves only
//   recorded replies (volatile ids/timestamps normalised, as in packages/llm), so the Control Tower
//   chat demo runs without a Meta key.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonical, denormaliseOutput, normaliseOutput, normaliseVolatile } from '@pact/llm/cache';

const ROOT = resolve(process.cwd(), '..', '..');
const CACHE_DIR = resolve(ROOT, 'fixtures', 'llm-cache', 'studio');
const MAX_OUTPUT_TOKENS = 16_000;

const env = (k: string, d = '') => (process.env[k] ?? '').trim() || d;
const error = (status: number, message: string) => Response.json({ error: { message } }, { status });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function sse(response: Json): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const events: Json[] = [];
  for (const [index, item] of (response.output ?? []).entries()) {
    const id = item.id || `item_${index}`;
    if (item.type === 'message') {
      events.push({ type: 'response.output_item.added', output_index: index, item: { ...item, id, content: [] } });
      for (const c of item.content ?? []) if (c.type === 'output_text' && c.text) events.push({ type: 'response.output_text.delta', item_id: id, output_index: index, delta: c.text });
      events.push({ type: 'response.output_item.done', output_index: index, item: { ...item, id } });
    } else if (item.type === 'function_call') {
      events.push({ type: 'response.output_item.added', output_index: index, item: { ...item, id, arguments: '' } });
      events.push({ type: 'response.function_call_arguments.delta', item_id: id, output_index: index, delta: item.arguments ?? '' });
      events.push({ type: 'response.output_item.done', output_index: index, item: { ...item, id } });
    } else if (item.type === 'reasoning') {
      events.push({ type: 'response.output_item.added', output_index: index, item: { ...item, id, summary: [] } });
      for (const s of item.summary ?? []) if (s.text) events.push({ type: 'response.reasoning_summary_text.delta', item_id: id, output_index: index, delta: s.text });
      events.push({ type: 'response.output_item.done', output_index: index, item: { ...item, id, summary: item.summary ?? [] } });
    }
  }
  const out = (response.output ?? []).map((item: Json, i: number) => ({ ...item, id: item.id || `item_${i}`, ...(item.type === 'reasoning' && { summary: item.summary ?? [] }) }));
  events.push({ type: 'response.completed', response: { ...response, output: out, status: response.status ?? 'completed' } });
  return new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

async function recordUsage(response: Json, mode: 'live' | 'replay', cacheHit: boolean, latencyMs: number) {
  const u = response.usage ?? {};
  await fetch(`${env('NEXT_PUBLIC_API_URL', 'http://localhost:4000')}/api/admin/llm-usage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      role: 'studio.pact-auditor',
      model: response.model ?? env('MUSE_MODEL', 'muse-spark-1.3'),
      mode,
      cacheHit,
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
      cachedTokens: u.input_tokens_details?.cached_tokens ?? 0,
      latencyMs,
    }),
  }).catch(() => undefined);
}

export async function POST(request: Request) {
  let body: Json;
  try {
    body = await request.json();
  } catch {
    return error(400, 'Request body must be JSON.');
  }
  const model = env('MUSE_MODEL', 'muse-spark-1.3');
  const mode = env('LLM_MODE', 'live') === 'replay' ? 'replay' : 'live';
  const upstreamBody = { ...body, model, stream: false, max_output_tokens: MAX_OUTPUT_TOKENS };

  // Cache key over the request without volatile values; the reasoning effort is part of it.
  const norm = normaliseVolatile({ ...upstreamBody, stream: undefined, max_output_tokens: undefined });
  const key = createHash('sha256').update(canonical({ model, prompt: norm.text })).digest('hex');
  const file = resolve(CACHE_DIR, key.slice(0, 2), `${key}.json`);

  if (existsSync(file)) {
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    const response = denormaliseOutput(cached.output, norm.values) as Json;
    void recordUsage(response, mode, true, 0);
    return new Response(sse(response), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
  }
  if (mode === 'replay')
    return error(503, 'Replay mode: this question has no recorded Muse answer. Try one of the suggested prompts, or set META_API_KEY and LLM_MODE=live in .env.local to ask anything.');
  const apiKey = env('META_API_KEY');
  if (!apiKey) return error(503, 'The PACT Auditor needs META_API_KEY in .env.local (or LLM_MODE=replay for the recorded demo).');

  const started = Date.now();
  const upstream = await fetch(`${env('META_BASE_URL', 'https://api.meta.ai/v1')}/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(upstreamBody),
    signal: request.signal,
  });
  const text = await upstream.text();
  let json: Json;
  try {
    json = JSON.parse(text);
  } catch {
    return error(502, `Meta Model API returned non-JSON (HTTP ${upstream.status}).`);
  }
  if (!upstream.ok) return error(upstream.status, json.error?.message ?? `Meta Model API error (HTTP ${upstream.status}).`);
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ role: 'studio.pact-auditor', model, output: normaliseOutput(json, norm.values), recordedAt: new Date().toISOString() }, null, 2) + '\n');
  void recordUsage(json, 'live', false, Date.now() - started);
  return new Response(sse(json), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
}
