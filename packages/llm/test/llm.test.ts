import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Milestone, VerifierVerdict } from '@pact/core/browser';
import { applyVerdictPolicy, cacheableMessages, cacheKey, LlmClient, LlmReplayMissError, runPrechecks, costOf, toChatMessages } from '../src/index';

const milestone: Milestone = {
  id: 'm1',
  title: 'Production',
  percent: 30,
  criteria: [
    { id: 'c1', text: '50 t-shirts visible' },
    { id: 'c2', text: 'embroidery visible' },
  ],
  evidenceTypes: ['photo'],
  deadline: null,
};
const verdict = (over: Partial<VerifierVerdict>): VerifierVerdict => ({
  status: 'approved',
  confidence: 0.9,
  criteria: [
    { criterionId: 'c1', passed: true, confidence: 0.9, reasoning: 'r' },
    { criterionId: 'c2', passed: true, confidence: 0.9, reasoning: 'r' },
  ],
  reasoning: 'ok',
  missing: [],
  ...over,
});

describe('verdict policy (never a silent approval)', () => {
  it('keeps a confident, complete approval', () => {
    expect(applyVerdictPolicy(verdict({}), milestone, []).status).toBe('approved');
  });
  it('downgrades low confidence approvals', () => {
    const v = applyVerdictPolicy(verdict({ confidence: 0.6 }), milestone, []);
    expect(v.status).toBe('needs_more');
    expect(v.policyNotes[0]).toMatch(/below the 0.75/);
  });
  it('downgrades approvals with an unassessed or failed criterion', () => {
    expect(applyVerdictPolicy(verdict({ criteria: [verdict({}).criteria[0]] }), milestone, []).status).toBe('needs_more');
    const failed = verdict({ criteria: [verdict({}).criteria[0], { criterionId: 'c2', passed: false, confidence: 0.4, reasoning: 'r' }] });
    expect(applyVerdictPolicy(failed, milestone, []).status).toBe('needs_more');
  });
  it('rejects on pre-check failure whatever the model says', () => {
    expect(applyVerdictPolicy(verdict({}), milestone, ['reused']).status).toBe('rejected');
  });
  it('requires a confidently failed criterion to reject', () => {
    const weak = verdict({ status: 'rejected', criteria: [{ criterionId: 'c1', passed: false, confidence: 0.5, reasoning: 'r' }] });
    expect(applyVerdictPolicy(weak, milestone, []).status).toBe('needs_more');
    const strong = verdict({ status: 'rejected', criteria: [{ criterionId: 'c1', passed: false, confidence: 0.95, reasoning: 'r' }] });
    expect(applyVerdictPolicy(strong, milestone, []).status).toBe('rejected');
  });
});

describe('prechecks', () => {
  const base = { id: 'e1', type: 'photo' as const, mime: 'image/jpeg', size: 1000, sha256: 'abc', createdAt: '2026-11-07T10:00:00Z' };
  const ctx = { milestone, milestoneDeadline: '2026-11-13', reusedIn: {}, now: new Date('2026-11-07') };
  it('passes valid evidence', () => expect(runPrechecks([base], ctx)).toEqual([]));
  it('catches wrong type, reuse, size and lateness', () => {
    const f = runPrechecks([{ ...base, type: 'tracking', size: 9e6, createdAt: '2026-11-14T00:00:00Z' }], { ...ctx, reusedIn: { abc: ['p9'] } });
    expect(f.join('\n')).toMatch(/accepts photo/);
    expect(f.join('\n')).toMatch(/byte-identical/);
    expect(f.join('\n')).toMatch(/exceeds/);
    expect(f.join('\n')).toMatch(/after the milestone deadline/);
  });
});

describe('client', () => {
  it('cache keys ignore image bytes but not their hash', () => {
    const a = cacheableMessages([{ role: 'user', content: [{ type: 'image', mime: 'image/png', data: Buffer.from('x'), sha256: 'h1' }] }]);
    const b = cacheableMessages([{ role: 'user', content: [{ type: 'image', mime: 'image/png', data: Buffer.from('y'), sha256: 'h1' }] }]);
    expect(cacheKey(a)).toBe(cacheKey(b));
  });

  it('encodes images as data URLs and refuses them outside user messages', () => {
    const m = toChatMessages([{ role: 'user', content: [{ type: 'image', mime: 'image/png', data: Buffer.from('x'), sha256: 'h' }] }]);
    expect(JSON.stringify(m)).toContain('data:image/png;base64,eA==');
    expect(() => toChatMessages([{ role: 'system', content: [{ type: 'text', text: 'x' }] }])).toThrow(/user messages/);
  });

  it('replay mode fails clearly on unknown inputs', async () => {
    const llm = new LlmClient({ mode: 'replay', apiKey: '', baseUrl: 'x', model: 'muse-spark-1.3', reasoningEffort: 'low', cacheDir: mkdtempSync(join(tmpdir(), 'pact-')) });
    const { ParseResult } = await import('@pact/core/browser');
    const err = await llm.structured({ role: 'parser', schema: ParseResult, schemaName: 'x', messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmReplayMissError);
    expect(err.message).toMatch(/META_API_KEY/);
  });

  it('replays a recorded call and reports it as a cache hit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pact-'));
    const { z } = await import('zod');
    const schema = z.object({ answer: z.string() });
    const llm = new LlmClient({ mode: 'replay', apiKey: '', baseUrl: 'x', model: 'muse-spark-1.3', reasoningEffort: 'low', cacheDir: dir });
    const req = { role: 't', schema, schemaName: 's', messages: [{ role: 'user' as const, content: 'q' }] };
    const miss = await llm.structured(req).catch((e) => e);
    llm.cache.put(miss.key, {
      role: 't',
      model: 'muse-spark-1.3',
      output: { answer: '42' },
      usage: { role: 't', model: 'muse-spark-1.3', mode: 'live', cacheHit: false, inputTokens: 10, outputTokens: 5, reasoningTokens: 0, cachedTokens: 0, costUsd: 0.1, latencyMs: 5 },
      recordedAt: 'x',
    });
    const r = await llm.structured(req);
    expect(r.value.answer).toBe('42');
    expect(r.usage).toMatchObject({ cacheHit: true, costUsd: 0, mode: 'replay' });
  });

  it('prices tokens', () => {
    expect(costOf('muse-spark-1.3', { inputTokens: 1e6, cachedTokens: 0, outputTokens: 1e6 })).toBeCloseTo(5.5);
  });
});
