// Agent mandates enforced on real MCP calls (Streamable HTTP, per-agent keys), no model involved:
// pacts are created from structured contracts.
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Contract } from '@pact/core';
import { getConfig, openDb } from '@pact/db';
import { LlmClient } from '@pact/llm';
import { SimulatedGateway } from '@pact/paypal';
import { buildApp } from '../src/app';
import { createContext, type AppContext } from '../src/context';

const contract = (title: string, description: string, total: number): Contract => ({
  title,
  description,
  buyer: { name: 'Ada (buyer)', email: null },
  seller: { name: 'Kofi Textiles', email: null },
  currency: 'USD',
  totalAmount: total,
  deadline: '2099-11-13',
  milestones: [
    { id: 'm1', title: 'Production', percent: 30, criteria: [{ id: 'c1', text: 'The goods are shown' }], evidenceTypes: ['photo'], deadline: null },
    { id: 'm2', title: 'Delivery', percent: 70, criteria: [{ id: 'c1', text: 'Tracking shows delivered' }], evidenceTypes: ['tracking'], deadline: null },
  ],
  subcontractors: [],
  disputePolicy: { windowHours: 72, resolution: 'ai_arbiter_with_human_appeal', notes: null },
});

let ctx: AppContext;
let built: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  const sim = new SimulatedGateway();
  const base = getConfig();
  ctx = createContext({
    config: { ...base, paypal: { ...base.paypal, mode: 'simulated' }, app: { ...base.app, agentKeys: [{ name: 'buyer-agent', key: 'test-buyer' }, { name: 'seller-agent', key: 'test-seller' }] } },
    db: openDb(':memory:'),
    gateway: sim,
    simulated: sim,
    llm: new LlmClient({ mode: 'replay', apiKey: '', baseUrl: 'x', model: 'muse-spark-1.3', reasoningEffort: 'low', cacheDir: mkdtempSync(join(tmpdir(), 'pact-llm-')) }),
    evidenceDir: mkdtempSync(join(tmpdir(), 'pact-ev-')),
  });
  built = await buildApp(ctx);
});

let rpc = 0;
async function tool(key: string, name: string, args: Record<string, unknown>) {
  const res = await built.app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { authorization: `Bearer ${key}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    payload: { jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } },
  });
  const result = res.json().result as { isError?: boolean; content: { text: string }[] };
  return { isError: !!result.isError, data: JSON.parse(result.content[0].text) };
}

async function proposedAndAccepted(c: Contract) {
  const created = await tool('test-buyer', 'create_pact', { contract: c, buyerName: 'Ada (buyer)', sellerName: 'Kofi Textiles' });
  expect(created.isError).toBe(false);
  const id = created.data.pact.id as string;
  await tool('test-buyer', 'propose_pact', { pactId: id });
  await tool('test-seller', 'accept_pact', { pactId: id });
  return id;
}

const mandateAudit = () => ctx.db.$client.prepare("SELECT type FROM audit_log WHERE type LIKE 'mandate.%' ORDER BY seq").pluck().all();

describe('agent mandates over MCP', () => {
  it('installs the default mandate for the demo buyer agent', async () => {
    const r = await built.app.inject({ method: 'GET', url: '/api/mandates' });
    const buyer = r.json().agents.find((a: { agent: string }) => a.agent === 'buyer-agent');
    expect(buyer.mandate).toMatchObject({ owner: 'Ada (buyer)', maxPactMinor: 100_000, approvalAboveMinor: 50_000 });
  });

  it('lets the demo deal through silently: same tool results, no extra audit entry', async () => {
    const id = await proposedAndAccepted(contract('50 embroidered t-shirts', 'Kofi Textiles will produce 50 plain white t-shirts with a small blue star.', 450));
    const fund = await tool('test-buyer', 'fund_pact', { pactId: id });
    expect(fund.data.status).toBe('awaiting_buyer_approval');
    expect(JSON.stringify(fund.data)).not.toMatch(/mandate/i);
    expect(mandateAudit()).toEqual([]);
  });

  it('refuses a purchase outside the mandate before any pact exists', async () => {
    const r = await tool('test-buyer', 'create_pact', { contract: contract('3 laptops', 'Three refurbished laptops with chargers.', 2500), buyerName: 'Ada (buyer)', sellerName: 'Kofi Textiles' });
    expect(r.isError).toBe(true);
    expect(r.data.error).toBe('MANDATE_DENIED');
    expect(r.data.details.reasons.join(' ')).toMatch(/per-pact limit.*Category electronics/s);
    expect(ctx.db.$client.prepare('SELECT count(*) FROM pacts').pluck().get()).toBe(0);
    expect(mandateAudit()).toEqual(['mandate.denied']);
  });

  it('holds funding above the threshold until the owner approves', async () => {
    const id = await proposedAndAccepted(contract('40 hoodies', 'Forty grey hoodies with an embroidered logo.', 800));
    const first = await tool('test-buyer', 'fund_pact', { pactId: id });
    expect(first.isError).toBe(true);
    expect(first.data.error).toBe('MANDATE_APPROVAL_REQUIRED');
    const approvalId = first.data.details.approvalId as string;
    // Asking again does not pile up requests.
    expect((await tool('test-buyer', 'fund_pact', { pactId: id })).data.details.approvalId).toBe(approvalId);
    const overview = (await built.app.inject({ method: 'GET', url: '/api/mandates' })).json();
    expect(overview.approvals).toHaveLength(1);
    expect(overview.approvals[0]).toMatchObject({ status: 'pending', pactTitle: '40 hoodies' });

    const ok = await built.app.inject({ method: 'POST', url: `/api/mandates/approvals/${approvalId}/approve`, headers: { 'x-pact-actor': 'human:Ada' } });
    expect(ok.json().status).toBe('approved');
    const second = await tool('test-buyer', 'fund_pact', { pactId: id });
    expect(second.isError).toBe(false);
    expect(second.data.status).toBe('awaiting_buyer_approval');
    expect(mandateAudit()).toEqual(['mandate.approval_requested', 'mandate.approval_approved']);
  });

  it('answers a dry run without writing anything', async () => {
    const before = ctx.db.$client.prepare('SELECT count(*) FROM audit_log').pluck().get();
    const r = await built.app.inject({ method: 'POST', url: '/api/mandates/buyer-agent/check', payload: { title: '3 laptops', amount: 2500 } });
    expect(r.json()).toMatchObject({ outcome: 'denied', categories: ['electronics'], owner: 'Ada (buyer)' });
    const ask = await built.app.inject({ method: 'POST', url: '/api/mandates/buyer-agent/check', payload: { title: '40 hoodies', amount: 800 } });
    expect(ask.json().outcome).toBe('needs_approval');
    expect(ctx.db.$client.prepare('SELECT count(*) FROM audit_log').pluck().get()).toBe(before);
  });

  it('lets the owner change the mandate (audited)', async () => {
    const r = await built.app.inject({
      method: 'POST',
      url: '/api/mandates/buyer-agent',
      headers: { 'x-pact-actor': 'human:Ada' },
      payload: { owner: 'Ada (buyer)', active: true, currency: 'USD', maxPactMinor: 300_000, maxOpenMinor: null, approvalAboveMinor: null, categories: [] },
    });
    expect(r.json()).toMatchObject({ maxPactMinor: 300_000, categories: [] });
    const check = await built.app.inject({ method: 'POST', url: '/api/mandates/buyer-agent/check', payload: { title: '3 laptops', amount: 2500 } });
    expect(check.json().outcome).toBe('allowed');
    expect(mandateAudit()).toEqual(['mandate.updated']);
  });
});
