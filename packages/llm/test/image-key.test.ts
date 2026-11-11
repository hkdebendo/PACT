import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmClient, LlmReplayMissError, cacheableMessages, cacheKey, normaliseVolatile, toStrictJsonSchema, type ChatMessage } from '../src/index';

const schema = z.object({ summary: z.string() });
const msg = (sha: string): ChatMessage[] => [
  { role: 'system', content: 'Describe.' },
  { role: 'user', content: [{ type: 'text', text: 'Evidence ev_0123456789abcdef: type=photo, file=image.jpg, mime=image/jpeg.' }, { type: 'image', mime: 'image/jpeg', data: Buffer.from(sha), sha256: sha }] },
];
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('image evidence in the replay cache key', () => {
  it('never serves the answer recorded for one photo to a different photo with the same file name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pact-imgkey-'));
    const llm = new LlmClient({ mode: 'replay', apiKey: '', baseUrl: 'x', model: 'muse-spark-1.3', reasoningEffort: 'low', cacheDir: dir });
    // Record an answer for photo A through the public put/get path the client uses.
    const usage = { role: 'verifier.describe', model: 'muse-spark-1.3', mode: 'live' as const, cacheHit: false, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedTokens: 0, costUsd: 0, latencyMs: 0 };
    const keyFor = (sha: string) => llm.keyFor({ role: 'verifier.describe', schema, schemaName: 's', messages: msg(sha) }).key;
    llm.cache.put(keyFor(A), { role: 'verifier.describe', model: 'muse-spark-1.3', output: { summary: 'mugs' }, usage, recordedAt: '', images: [A] });
    const req = (sha: string) => llm.structured({ role: 'verifier.describe', schema, schemaName: 's', messages: msg(sha) });
    expect((await req(A)).value.summary).toBe('mugs');
    await expect(req(B)).rejects.toBeInstanceOf(LlmReplayMissError);
  });

  it('still accepts a legacy recording (key without images) when its recorded image matches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pact-imgkey-'));
    const llm = new LlmClient({ mode: 'replay', apiKey: '', baseUrl: 'x', model: 'muse-spark-1.3', reasoningEffort: 'low', cacheDir: dir });
    const legacy = cacheKey({ model: 'muse-spark-1.3', role: 'verifier.describe', schemaName: 's', schema: toStrictJsonSchema(schema), messages: normaliseVolatile(cacheableMessages(msg(A))).text });
    const usage = { role: 'verifier.describe', model: 'muse-spark-1.3', mode: 'live' as const, cacheHit: false, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedTokens: 0, costUsd: 0, latencyMs: 0 };
    llm.cache.put(legacy, { role: 'verifier.describe', model: 'muse-spark-1.3', output: { summary: 't-shirts' }, usage, recordedAt: '', images: [A] });
    const req = (sha: string) => llm.structured({ role: 'verifier.describe', schema, schemaName: 's', messages: msg(sha) });
    expect((await req(A)).value.summary).toBe('t-shirts');
    await expect(req(B)).rejects.toBeInstanceOf(LlmReplayMissError);
  });
});
