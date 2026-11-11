// Live video proof end to end over REST, with a controllable clock and a scripted Muse.
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIVE_PLAN, type Contract } from '@pact/core';
import { getConfig, openDb } from '@pact/db';
import { LlmClient, type StructuredRequest, type StructuredResult } from '@pact/llm';
import { SimulatedGateway } from '@pact/paypal';
import type { z } from 'zod';
import { buildApp } from '../src/app';
import { createContext, type AppContext } from '../src/context';

class ScriptedLlm extends LlmClient {
  script: Record<string, unknown[]> = {};
  calls: string[] = [];
  constructor() {
    super({ mode: 'replay', apiKey: '', baseUrl: 'x', model: 'muse-spark-1.3', reasoningEffort: 'low', cacheDir: mkdtempSync(join(tmpdir(), 'pact-llm-')) });
  }
  async structured<T extends z.ZodType>(req: StructuredRequest<T>): Promise<StructuredResult<z.infer<T>>> {
    this.calls.push(req.role);
    const next = this.script[req.role]?.shift();
    if (next === undefined) throw new Error(`no scripted answer for ${req.role}`);
    const usage = { role: req.role, model: 'muse-spark-1.3', mode: 'replay' as const, cacheHit: true, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedTokens: 0, costUsd: 0, latencyMs: 0 };
    return { value: req.schema.parse(next), usage, model: 'muse-spark-1.3', mode: 'replay', cacheKey: 'k' };
  }
}

const contract: Contract = {
  title: '2 ceramic mugs',
  description: 'Two handmade ceramic mugs.',
  buyer: { name: 'Ada (buyer)', email: null },
  seller: { name: 'Kofi Ceramics', email: null },
  currency: 'USD',
  totalAmount: 40,
  deadline: '2099-11-13',
  milestones: [
    { id: 'm1', title: 'Mugs finished', percent: 40, criteria: [{ id: 'c1', text: 'Two ceramic mugs are shown' }], evidenceTypes: ['photo'], deadline: null },
    { id: 'm2', title: 'Delivery', percent: 60, criteria: [{ id: 'c1', text: 'Tracking shows delivered' }], evidenceTypes: ['tracking'], deadline: null },
  ],
  subcontractors: [],
  disputePolicy: { windowHours: 72, resolution: 'ai_arbiter_with_human_appeal', notes: null },
};

const jpeg = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`frame-${n}-${Math.random()}`)]).toString('base64');
const webm = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 7)]).toString('base64');
const recording = () => ({ video: webm(), videoMime: 'video/webm', frames: LIVE_PLAN.frames.map((f, i) => ({ slot: f.slot, atMs: f.atMs + 40, data: jpeg(i) })) });
const description = (summary: string) => ({ summary, objects: [], visibleText: [], dates: [], quality: { legible: true, issues: [] } });
const allDone = { instructions: [1, 2, 3].map((index) => ({ index, performed: true, confidence: 0.9, observation: 'done' })), sameScene: true, reasoning: 'All three instructions are visible.' };

let ctx: AppContext;
let llm: ScriptedLlm;
let built: Awaited<ReturnType<typeof buildApp>>;
let clock = Date.parse('2026-11-11T12:00:00Z');

beforeEach(async () => {
  clock = Date.parse('2026-11-11T12:00:00Z');
  llm = new ScriptedLlm();
  const sim = new SimulatedGateway();
  ctx = createContext({
    config: { ...getConfig(), paypal: { ...getConfig().paypal, mode: 'simulated' } },
    db: openDb(':memory:'),
    gateway: sim,
    simulated: sim,
    llm,
    evidenceDir: mkdtempSync(join(tmpdir(), 'pact-ev-')),
    now: () => new Date(clock),
  });
  built = await buildApp(ctx);
});

const api = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
  const res = await built.app.inject({ method, url, payload: payload as object, headers: { 'x-pact-actor': 'test' } });
  return { status: res.statusCode, body: res.json() };
};

async function fundedPactWithLiveProof() {
  const id = (await api('POST', '/api/pacts', { contract, buyer: { name: 'Ada (buyer)' }, seller: { name: 'Kofi Ceramics' } })).body.id as string;
  expect((await api('POST', `/api/pacts/${id}/milestones/m1/live-proof`, { required: true })).status).toBe(200);
  await api('POST', `/api/pacts/${id}/propose`);
  await api('POST', `/api/pacts/${id}/accept`);
  await api('POST', `/api/pacts/${id}/fund`);
  expect((await api('POST', `/api/pacts/${id}/simulated-approve`)).body.funded).toBe(true);
  return id;
}

async function record(id: string) {
  const link = await api('POST', `/api/pacts/${id}/milestones/m1/live-sessions`);
  expect(link.body.url).toMatch(/\/live\/[0-9a-f]{32}$/);
  const token = link.body.token as string;
  const before = await api('GET', `/api/live/${token}`);
  expect(before.body.challenges).toEqual([]); // secret until Start
  const start = await api('POST', `/api/live/${token}/start`);
  expect(start.body.challenges).toHaveLength(3);
  expect(new Set(start.body.challenges.map((c: { id: string }) => c.id)).size).toBe(3);
  return token;
}

describe('live video proof', () => {
  it('refuses uploaded photos once the buyer requires live proof', async () => {
    const id = await fundedPactWithLiveProof();
    const r = await api('POST', `/api/pacts/${id}/milestones/m1/evidence`, { filename: 'a.jpg', contentBase64: jpeg(1), type: 'photo' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('LIVE_PROOF_REQUIRED');
  });

  it('approves and releases when every instruction is performed and the goods match', async () => {
    const id = await fundedPactWithLiveProof();
    const token = await record(id);
    clock += 21_000;
    llm.script['live.check'] = [allDone];
    llm.script['verifier.describe'] = [1, 2, 3, 4].map(() => description('two ceramic mugs and a hand'));
    llm.script['verifier.judge'] = [{ status: 'approved', confidence: 0.9, criteria: [{ criterionId: 'c1', passed: true, confidence: 0.9, reasoning: 'two mugs' }], reasoning: 'Two mugs shown.', missing: [] }];
    const r = await api('POST', `/api/live/${token}/submit`, recording());
    expect(r.status).toBe(200);
    expect(r.body.session.status).toBe('passed');
    expect(r.body.verdict.status).toBe('approved');
    expect(r.body.release).not.toBeNull();
    const overview = (await api('GET', `/api/pacts/${id}/live`)).body.milestones.m1;
    expect(overview.sessions[0]).toMatchObject({ status: 'passed', hasVideo: true });
    expect(overview.sessions[0].evidenceIds).toHaveLength(4);
    const video = await built.app.inject({ method: 'GET', url: `/api/live-sessions/${overview.sessions[0].id}/video` });
    expect(video.headers['content-type']).toBe('video/webm');
  });

  it('rejects without judging the goods when an instruction was not performed, then allows a retry', async () => {
    const id = await fundedPactWithLiveProof();
    const token = await record(id);
    clock += 21_000;
    llm.script['live.check'] = [{ ...allDone, instructions: allDone.instructions.map((x) => (x.index === 2 ? { ...x, performed: false, observation: 'no fingers are visible' } : x)) }];
    const r = await api('POST', `/api/live/${token}/submit`, recording());
    expect(r.body.session.status).toBe('failed');
    expect(r.body.verdict.status).toBe('rejected');
    expect(r.body.verdict.reasoning).toMatch(/^Rejected: the live video proof failed.*Instruction 2 .* was not seen on camera: no fingers are visible/);
    expect(llm.calls).toEqual(['live.check']); // no describe / judge spent on a failed live check
    const retry = await api('POST', `/api/live/${token}/retry`);
    expect(retry.body.token).not.toBe(token);
    expect((await api('GET', `/api/live/${retry.body.token}`)).body.attemptsLeft).toBe(2);
  });

  it('refuses a recording that is too short or too late, and a reused link', async () => {
    const id = await fundedPactWithLiveProof();
    const t1 = await record(id);
    clock += 5_000;
    expect((await api('POST', `/api/live/${t1}/submit`, recording())).body.error).toBe('LIVE_TOO_SHORT');
    expect((await api('POST', `/api/live/${t1}/start`)).body.error).toBe('LIVE_NOT_OPEN');
    const t2 = (await api('POST', `/api/live/${t1}/retry`)).body.token as string;
    await api('POST', `/api/live/${t2}/start`);
    clock += LIVE_PLAN.submitWithinMs + 1_000;
    expect((await api('POST', `/api/live/${t2}/submit`, recording())).body.error).toBe('LIVE_TOO_LATE');
  });

  it('keeps milestones without the option exactly as before', async () => {
    const id = (await api('POST', '/api/pacts', { contract, buyer: { name: 'Ada (buyer)' }, seller: { name: 'Kofi Ceramics' } })).body.id as string;
    await api('POST', `/api/pacts/${id}/propose`);
    await api('POST', `/api/pacts/${id}/accept`);
    await api('POST', `/api/pacts/${id}/fund`);
    await api('POST', `/api/pacts/${id}/simulated-approve`);
    expect((await api('POST', `/api/pacts/${id}/milestones/m1/evidence`, { filename: 'a.jpg', contentBase64: jpeg(9), type: 'photo' })).status).toBe(200);
    expect((await api('POST', `/api/pacts/${id}/milestones/m1/live-sessions`)).body.error).toBe('LIVE_NOT_REQUIRED');
    expect((await api('GET', `/api/pacts/${id}/live`)).body.milestones).toEqual({});
  });
});
