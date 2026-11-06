import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Contract } from '@pact/core';
import { getConfig, openDb } from '@pact/db';
import { LlmClient, type StructuredRequest, type StructuredResult } from '@pact/llm';
import { SimulatedGateway } from '@pact/paypal';
import type { z } from 'zod';
import { buildApp } from '../src/app';
import { createContext, type AppContext } from '../src/context';

// A scripted LLM: each role pops its next answer. Lets the test drive approved/rejected verdicts
// without a network or a Meta key.
class ScriptedLlm extends LlmClient {
  script: Record<string, unknown[]> = {};
  constructor() {
    super({ mode: 'replay', apiKey: '', baseUrl: 'x', model: 'muse-spark-1.3', reasoningEffort: 'low', cacheDir: mkdtempSync(join(tmpdir(), 'pact-llm-')) });
  }
  async structured<T extends z.ZodType>(req: StructuredRequest<T>): Promise<StructuredResult<z.infer<T>>> {
    const next = this.script[req.role]?.shift();
    if (next === undefined) throw new Error(`no scripted answer for ${req.role}`);
    const usage = { role: req.role, model: 'muse-spark-1.3', mode: 'replay' as const, cacheHit: true, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedTokens: 0, costUsd: 0, latencyMs: 0 };
    return { value: req.schema.parse(next), usage, model: 'muse-spark-1.3', mode: 'replay', cacheKey: 'k' };
  }
}

const contract: Contract = {
  title: '50 embroidered t-shirts',
  description: 'Fifty plain white t-shirts with a small embroidered mark, delivered before Friday.',
  buyer: { name: 'Ada (buyer)', email: null },
  seller: { name: 'Kofi Textiles', email: null },
  currency: 'USD',
  totalAmount: 450,
  deadline: '2099-11-13',
  milestones: [
    { id: 'm1', title: 'Production', percent: 30, criteria: [{ id: 'c1', text: 'Plain white t-shirts are shown' }, { id: 'c2', text: 'Embroidery is visible' }], evidenceTypes: ['photo'], deadline: null },
    { id: 'm2', title: 'Delivery', percent: 70, criteria: [{ id: 'c1', text: 'Tracking shows delivered' }], evidenceTypes: ['tracking', 'photo'], deadline: null },
  ],
  subcontractors: [],
  disputePolicy: { windowHours: 72, resolution: 'ai_arbiter_with_human_appeal', notes: null },
};

const description = (summary: string) => ({ summary, objects: [], visibleText: [], dates: [], quality: { legible: true, issues: [] } });
const pass = (ids: string[]) => ({ status: 'approved', confidence: 0.92, criteria: ids.map((id) => ({ criterionId: id, passed: true, confidence: 0.92, reasoning: 'visible' })), reasoning: 'All criteria met.', missing: [] });
const reject = { status: 'rejected', confidence: 0.95, criteria: [{ criterionId: 'c1', passed: false, confidence: 0.95, reasoning: 'Mugs, not t-shirts' }], reasoning: 'The photo shows mugs.', missing: [] };

// Distinct tiny PNGs (valid signature + distinct bytes).
const png = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`fake-png-${n}`)]);

let ctx: AppContext;
let llm: ScriptedLlm;
let built: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  llm = new ScriptedLlm();
  const sim = new SimulatedGateway();
  ctx = createContext({
    config: { ...getConfig(), paypal: { ...getConfig().paypal, mode: 'simulated' } },
    db: openDb(':memory:'),
    gateway: sim,
    simulated: sim,
    llm,
    evidenceDir: mkdtempSync(join(tmpdir(), 'pact-ev-')),
  });
  built = await buildApp(ctx);
});

const api = async (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const res = await built.app.inject({ method, url, payload: payload as object, headers: { 'x-pact-actor': 'test', ...headers } });
  return { status: res.statusCode, body: res.json(), headers: res.headers };
};

async function fundedPact() {
  const created = await api('POST', '/api/pacts', { contract, buyer: { name: 'Ada (buyer)' }, seller: { name: 'Kofi Textiles' } });
  expect(created.status).toBe(200);
  const id = created.body.id as string;
  await api('POST', `/api/pacts/${id}/propose`);
  expect((await api('POST', `/api/pacts/${id}/fund`)).status).toBe(409); // not accepted yet
  await api('POST', `/api/pacts/${id}/accept`);
  const fund = await api('POST', `/api/pacts/${id}/fund`);
  expect(fund.body.approvalUrl).toContain('/simulated-checkout/SIM-ORDER-');
  expect((await api('POST', `/api/pacts/${id}/fund/confirm`)).body.funded).toBe(false); // not approved yet
  const approved = await api('POST', `/api/pacts/${id}/simulated-approve`);
  expect(approved.body.funded).toBe(true);
  return id;
}

const evidence = (id: string, mid: string, n: number, type = 'photo') =>
  api('POST', `/api/pacts/${id}/milestones/${mid}/evidence`, { filename: `e${n}.png`, contentBase64: png(n).toString('base64'), type });

describe('PACT money flow (simulated PayPal, scripted Muse)', () => {
  it('runs the demo scenario end to end with partial and final captures', async () => {
    const id = await fundedPact();
    let pact = (await api('GET', `/api/pacts/${id}`)).body;
    expect(pact).toMatchObject({ status: 'funded', heldMinor: 45000, releasedMinor: 0, paymentMode: 'simulated' });

    // Wrong photo → rejected, nothing captured.
    llm.script['verifier.describe'] = [description('A grid of ceramic mugs.')];
    llm.script['verifier.judge'] = [reject];
    await evidence(id, 'm1', 1);
    let v = await api('POST', `/api/pacts/${id}/milestones/m1/verify`, {});
    expect(v.body.verdict.status).toBe('rejected');
    expect(v.body.pact.heldMinor).toBe(45000);

    // Correct photo → approved → automatic 30% partial capture.
    llm.script['verifier.describe'] = [description('About 50 plain white t-shirts with a small blue embroidered mark.')];
    llm.script['verifier.judge'] = [pass(['c1', 'c2'])];
    await evidence(id, 'm1', 2);
    v = await api('POST', `/api/pacts/${id}/milestones/m1/verify`, {});
    expect(v.body.verdict.status).toBe('approved');
    expect(v.body.release).toMatchObject({ amountMinor: 13500, finalCapture: false });
    expect(v.body.pact).toMatchObject({ heldMinor: 31500, releasedMinor: 13500 });

    // Delivery → final capture of 70%.
    llm.script['verifier.describe'] = [description('Tracking page: status Delivered.')];
    llm.script['verifier.judge'] = [pass(['c1'])];
    await evidence(id, 'm2', 3, 'tracking');
    v = await api('POST', `/api/pacts/${id}/milestones/m2/verify`, {});
    expect(v.body.release).toMatchObject({ amountMinor: 31500, finalCapture: true });
    pact = v.body.pact;
    expect(pact).toMatchObject({ status: 'completed', heldMinor: 0, releasedMinor: 45000, refundedMinor: 0 });
    expect(pact.payments.filter((p: { kind: string }) => p.kind === 'capture')).toHaveLength(2);

    // Audit chain intact and records the AI verdicts and captures.
    const audit = await api('GET', '/api/audit/verify');
    expect(audit.body.ok).toBe(true);
    const types = (await api('GET', `/api/audit?pactId=${id}`)).body.map((e: { type: string }) => e.type);
    expect(types).toEqual(expect.arrayContaining(['pact.created', 'paypal.authorization.created', 'ai.verdict', 'paypal.capture']));

    // Reputation and dashboard reflect it.
    const rep = (await api('GET', '/api/reputation')).body;
    expect(rep.find((r: { party: { name: string } }) => r.party.name === 'Kofi Textiles').raw.milestonesTotal).toBe(2);
    const dash = (await api('GET', '/api/dashboard')).body;
    expect(dash.totals.released).toBe(450);
    expect(dash.audit.ok).toBe(true);
  });

  it('fails loudly and audit-logs invalid transitions', async () => {
    const id = await fundedPact();
    const r = await api('POST', `/api/pacts/${id}/milestones/m1/release`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('INVALID_TRANSITION');
    const types = (await api('GET', `/api/audit?pactId=${id}`)).body.map((e: { type: string }) => e.type);
    expect(types).toContain('transition.rejected');
  });

  it('rejects reused evidence by deterministic pre-check without calling the model', async () => {
    const a = await fundedPact();
    llm.script['verifier.describe'] = [description('t-shirts')];
    llm.script['verifier.judge'] = [pass(['c1', 'c2'])];
    await evidence(a, 'm1', 7);
    await api('POST', `/api/pacts/${a}/milestones/m1/verify`, {});
    const b = await fundedPact();
    await evidence(b, 'm1', 7); // same bytes as in pact a
    const v = await api('POST', `/api/pacts/${b}/milestones/m1/verify`, {});
    expect(v.body.verdict.status).toBe('rejected');
    expect(v.body.verdict.precheckFailures[0]).toMatch(/byte-identical/);
  });

  it('dispute → Arbiter refund on an un-captured milestone voids the authorization', async () => {
    const id = await fundedPact();
    llm.script['verifier.describe'] = [description('mugs')];
    llm.script['verifier.judge'] = [reject];
    await evidence(id, 'm1', 11);
    await api('POST', `/api/pacts/${id}/milestones/m1/verify`, {});
    const d = await api('POST', `/api/pacts/${id}/milestones/m1/dispute`, { party: 'seller', statement: 'The shirts are in the back of the photo.' });
    expect(d.status).toBe(200);
    await api('POST', `/api/pacts/${id}/milestones/m1/statement`, { party: 'buyer', statement: 'I only see mugs.' });
    llm.script['arbiter'] = [{ decision: 'refund', releasePercent: 0, reasoning: 'Evidence shows mugs only.', citedEvidence: [], confidence: 0.9 }];
    const arb = await api('POST', `/api/pacts/${id}/milestones/m1/arbitrate`);
    expect(arb.body.verdict.kind).toBe('arbiter');
    expect(arb.body.pact.milestones[0].status).toBe('refunded');
    // Cancel the rest: the remaining authorization is voided, the buyer is never charged.
    const c = await api('POST', `/api/pacts/${id}/cancel`, { reason: 'seller failed' });
    expect(c.body).toMatchObject({ status: 'cancelled', heldMinor: 0, releasedMinor: 0, voidedMinor: 45000 });
    // Appeal path exists on the Arbiter decision.
    const ap = await api('POST', `/api/verdicts/${arb.body.verdict.id}/appeal`, { party: 'seller', note: 'Please look again' });
    expect(ap.body.appealStatus).toBe('requested');
  });

  it('dispute after release → partial refund on the capture', async () => {
    const id = await fundedPact();
    llm.script['verifier.describe'] = [description('shirts'), description('delivered')];
    llm.script['verifier.judge'] = [pass(['c1', 'c2']), pass(['c1'])];
    await evidence(id, 'm1', 21);
    await api('POST', `/api/pacts/${id}/milestones/m1/verify`, {});
    await evidence(id, 'm2', 22, 'tracking');
    await api('POST', `/api/pacts/${id}/milestones/m2/verify`, {});
    await api('POST', `/api/pacts/${id}/milestones/m2/dispute`, { party: 'buyer', statement: 'Only 35 of 50 shirts arrived.' });
    llm.script['arbiter'] = [{ decision: 'partial', releasePercent: 70, reasoning: '35 of 50 delivered.', citedEvidence: [], confidence: 0.8 }];
    const arb = await api('POST', `/api/pacts/${id}/milestones/m2/arbitrate`);
    expect(arb.body.money.refundedMinor).toBe(9450); // 30% of 315.00
    expect(arb.body.pact).toMatchObject({ status: 'completed', releasedMinor: 45000 - 9450, refundedMinor: 9450 });
  });

  it('confirms funding once when the poller and the buyer race', async () => {
    const created = await api('POST', '/api/pacts', { contract, buyer: { name: 'Ada (buyer)' }, seller: { name: 'Kofi Textiles' } });
    const id = created.body.id as string;
    await api('POST', `/api/pacts/${id}/propose`);
    await api('POST', `/api/pacts/${id}/accept`);
    await api('POST', `/api/pacts/${id}/fund`);
    built.pacts.approveSimulated(id, 'test');
    const results = await Promise.all([api('POST', `/api/pacts/${id}/fund/confirm`), api('POST', `/api/pacts/${id}/fund/confirm`), api('POST', '/api/admin/reconcile')]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const pact = (await api('GET', `/api/pacts/${id}`)).body;
    expect(pact.status).toBe('funded');
    expect(pact.payments.filter((p: { kind: string }) => p.kind === 'authorization')).toHaveLength(1);
  });

  it('honours Idempotency-Key on mutations', async () => {
    const body = { contract, buyer: { name: 'Ada (buyer)' }, seller: { name: 'Kofi Textiles' } };
    const a = await api('POST', '/api/pacts', body, { 'idempotency-key': 'k1' });
    const b = await api('POST', '/api/pacts', body, { 'idempotency-key': 'k1' });
    expect(b.body.id).toBe(a.body.id);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect((await api('GET', '/api/pacts')).body).toHaveLength(1);
  });

  it('serves an OpenAPI 3.1 document covering the routes', async () => {
    const doc = (await api('GET', '/openapi.json')).body;
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/api/pacts', '/api/pacts/{id}/milestones/{mid}/verify', '/api/audit/verify']));
  });

  it('protects the MCP endpoint with agent keys', async () => {
    const r = await built.app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(r.statusCode).toBe(401);
  });
});
