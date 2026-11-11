// Provider-agnostic LLM client over the OpenAI-compatible Chat Completions API, configured only from
// env and pointed at Meta's Model API (Muse). Adds:
//   - structured outputs from Zod schemas (response_format json_schema, strict)
//   - image input as data URLs
//   - a record/replay cache (LLM_MODE=live|replay) keyed by model + messages + image hashes + schema
//   - per-call token usage and cost accounting
import OpenAI from 'openai';
import { z } from 'zod';
import { ReplayCache, cacheKey, denormaliseOutput, normaliseOutput, normaliseVolatile } from './cache';

export type LlmMode = 'live' | 'replay';
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface LlmConfig {
  mode: LlmMode;
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoningEffort: ReasoningEffort | string;
  cacheDir: string;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; data: Buffer; sha256: string; label?: string };

export interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface UsageRecord {
  role: string;
  model: string;
  mode: LlmMode;
  cacheHit: boolean;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  costUsd: number;
  latencyMs: number;
}

/** USD per 1M tokens (Meta Model API published pricing for muse-spark-1.x). */
export const PRICING: Record<string, { input: number; cachedInput: number; output: number }> = {
  'muse-spark-1.3': { input: 1.25, cachedInput: 0.15, output: 4.25 },
  'muse-spark-1.1': { input: 1.25, cachedInput: 0.15, output: 4.25 },
  'muse-spark-1.3-contributor': { input: 0.1, cachedInput: 0.002, output: 0.2 },
};

export function costOf(model: string, u: { inputTokens: number; cachedTokens: number; outputTokens: number }): number {
  const p = PRICING[model] ?? PRICING['muse-spark-1.3'];
  return ((u.inputTokens - u.cachedTokens) * p.input + u.cachedTokens * p.cachedInput + u.outputTokens * p.output) / 1e6;
}

export class LlmReplayMissError extends Error {
  constructor(public readonly role: string, public readonly key: string) {
    super(
      `Replay mode: no recorded model response for this ${role} input (cache key ${key.slice(0, 12)}…). ` +
        'Only the recorded demo scenario can run without a key. Set META_API_KEY and LLM_MODE=live in .env.local to run Muse on new inputs.',
    );
    this.name = 'LlmReplayMissError';
  }
}

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmConfigError';
  }
}

export class LlmOutputError extends Error {
  constructor(message: string, public readonly raw: string) {
    super(message);
    this.name = 'LlmOutputError';
  }
}

export interface StructuredRequest<T extends z.ZodType> {
  role: string; // parser | verifier.describe | verifier.judge | arbiter | agent | ...
  schema: T;
  schemaName: string;
  messages: ChatMessage[];
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
  pactId?: string | null;
  /** Reference date the prompt is relative to; replayed answers are date-shifted to it. */
  today?: string;
}

export interface StructuredResult<T> {
  value: T;
  usage: UsageRecord;
  model: string;
  mode: LlmMode;
  cacheKey: string;
}

export type UsageSink = (u: UsageRecord & { pactId?: string | null }) => void;

/**
 * Zod → JSON Schema in the strict subset Meta's Model API (and OpenAI strict mode) accept: every
 * object closed (additionalProperties false) with all properties required. Optional values are
 * modelled as nullable in the Zod schemas themselves.
 */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Record<string, unknown>;
  delete json.$schema;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (n.type === 'object' && n.properties && typeof n.properties === 'object') {
      n.additionalProperties = false;
      n.required = Object.keys(n.properties as object);
    }
    Object.values(n).forEach(walk);
  };
  walk(json);
  return json;
}

/** Converts our message format to OpenAI chat messages; images become data URLs. */
export function toChatMessages(messages: ChatMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
    if (m.role !== 'user') throw new Error('Image content is only accepted in user messages (Meta Model API rule).');
    return {
      role: 'user',
      content: m.content.map((p) =>
        p.type === 'text'
          ? { type: 'text' as const, text: p.text }
          : { type: 'image_url' as const, image_url: { url: `data:${p.mime};base64,${p.data.toString('base64')}` } },
      ),
    };
  });
}

/** Messages with image bytes replaced by their hash: the stable part of the cache key. */
export function cacheableMessages(messages: ChatMessage[]): unknown {
  return messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p : { type: 'image', sha256: p.sha256 })),
  }));
}

/** sha256 of every image part, in order. */
export function imageHashes(messages: ChatMessage[]): string[] {
  return messages.flatMap((m) => (typeof m.content === 'string' ? [] : m.content.flatMap((p) => (p.type === 'image' ? [p.sha256] : []))));
}

const sameList = (a: string[] | undefined, b: string[]) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);

export class LlmClient {
  private readonly openai: OpenAI | null;
  readonly cache: ReplayCache;
  private sinks: UsageSink[] = [];

  constructor(readonly config: LlmConfig) {
    this.cache = new ReplayCache(config.cacheDir);
    this.openai = config.apiKey
      ? new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl, maxRetries: 2, timeout: 120_000 })
      : null;
  }

  get mode(): LlmMode {
    return this.config.mode;
  }
  get model(): string {
    return this.config.model;
  }
  get liveAvailable(): boolean {
    return !!this.openai;
  }

  onUsage(sink: UsageSink) {
    this.sinks.push(sink);
  }

  private emit(u: UsageRecord, pactId?: string | null) {
    for (const s of this.sinks) s({ ...u, pactId });
  }

  /**
   * Cache key of a structured call. Image hashes are 64-hex values, which the volatile-value
   * normalisation replaces by placeholders, so they are added to the key separately: two different
   * photos with the same file name must never share a recorded answer.
   */
  keyFor<T extends z.ZodType>(req: Pick<StructuredRequest<T>, 'role' | 'schema' | 'schemaName' | 'messages'>) {
    const norm = normaliseVolatile(cacheableMessages(req.messages));
    const parts = { model: this.config.model, role: req.role, schemaName: req.schemaName, schema: toStrictJsonSchema(req.schema), messages: norm.text };
    const images = imageHashes(req.messages);
    const legacyKey = cacheKey(parts);
    return { key: images.length ? cacheKey({ ...parts, images }) : legacyKey, legacyKey, norm, images };
  }

  private lookup(k: ReturnType<LlmClient['keyFor']>) {
    if (!k.images.length) return this.cache.get(k.key);
    const hit = this.cache.get(k.key);
    if (hit) return sameList(hit.images, k.images) ? hit : null;
    // Recordings made before images were keyed: valid only if they recorded the same images.
    const legacy = this.cache.get(k.legacyKey);
    return legacy && sameList(legacy.images, k.images) ? legacy : null;
  }

  async structured<T extends z.ZodType>(req: StructuredRequest<T>): Promise<StructuredResult<z.infer<T>>> {
    const jsonSchema = toStrictJsonSchema(req.schema);
    const keyed = this.keyFor(req);
    const { key, norm, images } = keyed;

    const cached = this.lookup(keyed);
    if (cached) {
      const value = this.validate(req, denormaliseOutput(cached.output, norm.values, cached.today, req.today));
      const usage: UsageRecord = { ...cached.usage, role: req.role, mode: this.config.mode, cacheHit: true, costUsd: 0, latencyMs: 0 };
      this.emit(usage, req.pactId);
      return { value, usage, model: cached.model, mode: this.config.mode, cacheKey: key };
    }
    if (this.config.mode === 'replay') {
      this.cache.recordMiss(key, req.role, norm.text);
      throw new LlmReplayMissError(req.role, key);
    }
    if (!this.openai) throw new LlmConfigError('LLM_MODE=live but META_API_KEY is not set. Set it in .env.local, or use LLM_MODE=replay.');

    const started = Date.now();
    const completion = await this.openai.chat.completions.create({
      model: this.config.model,
      messages: toChatMessages(req.messages),
      response_format: { type: 'json_schema', json_schema: { name: req.schemaName, schema: jsonSchema, strict: true } },
      // Meta's Model API accepts reasoning_effort minimal|low|medium|high|xhigh.
      reasoning_effort: req.reasoningEffort ?? this.config.reasoningEffort,
      ...(req.maxOutputTokens && { max_completion_tokens: req.maxOutputTokens }),
      temperature: 0,
      seed: 7,
    } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
    const latencyMs = Date.now() - started;
    const text = completion.choices[0]?.message?.content ?? '';
    const u = completion.usage;
    const usage: UsageRecord = {
      role: req.role,
      model: completion.model ?? this.config.model,
      mode: 'live',
      cacheHit: false,
      inputTokens: u?.prompt_tokens ?? 0,
      outputTokens: u?.completion_tokens ?? 0,
      reasoningTokens: u?.completion_tokens_details?.reasoning_tokens ?? 0,
      cachedTokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
      costUsd: 0,
      latencyMs,
    };
    usage.costUsd = costOf(this.config.model, usage);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.emit(usage, req.pactId);
      throw new LlmOutputError(`${req.role}: model output is not valid JSON`, text);
    }
    const value = this.validate(req, parsed);
    this.cache.put(key, { role: req.role, model: usage.model, output: normaliseOutput(parsed, norm.values), usage, recordedAt: new Date().toISOString(), today: req.today ?? null, prompt: norm.text, ...(images.length && { images }) });
    this.emit(usage, req.pactId);
    return { value, usage, model: usage.model, mode: 'live', cacheKey: key };
  }

  private validate<T extends z.ZodType>(req: StructuredRequest<T>, output: unknown): z.infer<T> {
    const r = req.schema.safeParse(output);
    if (!r.success) throw new LlmOutputError(`${req.role}: model output does not match ${req.schemaName}: ${r.error.message}`, JSON.stringify(output));
    return r.data;
  }

  /** Raw chat call with tools, used by the demo agents' tool loop (also cached/replayed). */
  async chatWithTools(req: {
    role: string;
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    tools: OpenAI.Chat.Completions.ChatCompletionTool[];
    pactId?: string | null;
  }): Promise<{ message: OpenAI.Chat.Completions.ChatCompletionMessage; usage: UsageRecord }> {
    const norm = normaliseVolatile({ messages: req.messages, tools: req.tools });
    const key = cacheKey({ model: this.config.model, role: req.role, prompt: norm.text });
    const cached = this.cache.get(key);
    if (cached) {
      const usage: UsageRecord = { ...cached.usage, role: req.role, mode: this.config.mode, cacheHit: true, costUsd: 0, latencyMs: 0 };
      this.emit(usage, req.pactId);
      return { message: denormaliseOutput(cached.output, norm.values) as OpenAI.Chat.Completions.ChatCompletionMessage, usage };
    }
    if (this.config.mode === 'replay') {
      this.cache.recordMiss(key, req.role, norm.text);
      throw new LlmReplayMissError(req.role, key);
    }
    if (!this.openai) throw new LlmConfigError('LLM_MODE=live but META_API_KEY is not set.');
    const started = Date.now();
    const completion = await this.openai.chat.completions.create({
      model: this.config.model,
      messages: req.messages,
      tools: req.tools,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      temperature: 0,
      seed: 7,
      reasoning_effort: 'low',
    } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
    const message = completion.choices[0].message;
    const u = completion.usage;
    const usage: UsageRecord = {
      role: req.role,
      model: completion.model ?? this.config.model,
      mode: 'live',
      cacheHit: false,
      inputTokens: u?.prompt_tokens ?? 0,
      outputTokens: u?.completion_tokens ?? 0,
      reasoningTokens: u?.completion_tokens_details?.reasoning_tokens ?? 0,
      cachedTokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
      costUsd: 0,
      latencyMs: Date.now() - started,
    };
    usage.costUsd = costOf(this.config.model, usage);
    const clean = { role: message.role, content: message.content, tool_calls: message.tool_calls } as OpenAI.Chat.Completions.ChatCompletionMessage;
    this.cache.put(key, { role: req.role, model: usage.model, output: normaliseOutput(clean, norm.values), usage, recordedAt: new Date().toISOString(), prompt: norm.text });
    this.emit(usage, req.pactId);
    return { message: clean, usage };
  }
}
