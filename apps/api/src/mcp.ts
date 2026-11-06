// PACT MCP server (Streamable HTTP at /mcp, stateless). Any MCP client — Claude, ChatGPT, a custom
// agent — can create and execute pacts. Each call is authenticated with a per-agent key from
// AGENT_API_KEYS, rate-limited, validated with Zod, audit-logged, and returns structured results
// with `nextSteps` hints so an agent knows what to do next.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Contract, EvidenceType, type PactView } from '@pact/core';
import { repoRoot } from '@pact/db';
import { parseContract } from '@pact/llm';
import type { AppContext } from './context';
import { appendAudit } from './services/audit';
import type { PactService } from './services/pacts';
import { getReputation, leaderboard } from './services/reputation';

const summary = (p: PactView) => ({
  id: p.id,
  status: p.status,
  title: p.title,
  currency: p.currency,
  total: p.totalMinor / 100,
  held: p.heldMinor / 100,
  released: p.releasedMinor / 100,
  refunded: p.refundedMinor / 100,
  paymentMode: p.paymentMode,
  buyer: p.buyer.name,
  seller: p.seller.name,
  approvalUrl: p.approvalUrl,
  milestones: p.milestones.map((m) => ({
    id: m.id,
    title: m.title,
    percent: m.percent,
    amount: m.amountMinor / 100,
    status: m.status,
    criteria: m.criteria.map((c) => `${c.id}: ${c.text}`),
    acceptedEvidence: m.evidenceTypes,
    lastVerdict: m.verdicts.at(-1) ? { status: m.verdicts.at(-1)!.status, confidence: m.verdicts.at(-1)!.confidence, reasoning: m.verdicts.at(-1)!.reasoning } : null,
  })),
});

function nextSteps(p: PactView): string[] {
  switch (p.status) {
    case 'draft':
      return ['Buyer: call propose_pact.'];
    case 'proposed':
      return p.orderId
        ? [`Buyer: approve the PayPal order at ${p.approvalUrl ?? '(approval URL)'}; then call fund_pact again to confirm the authorization.`]
        : ['Seller: call accept_pact.', 'Buyer (after acceptance): call fund_pact to get the PayPal approval URL.'];
    case 'funded':
    case 'in_progress':
    case 'disputed': {
      const steps: string[] = [];
      for (const m of p.milestones) {
        if (['pending', 'rejected', 'needs_more'].includes(m.status)) steps.push(`Seller: submit_evidence for milestone ${m.id} (${m.evidenceTypes.join('/')}).`);
        if (m.status === 'evidence_submitted') steps.push(`Anyone: verify_milestone ${m.id}.`);
        if (m.status === 'approved') steps.push(`Buyer: release_funds for milestone ${m.id}.`);
        if (m.status === 'rejected') steps.push(`Seller: or open_dispute on ${m.id} if you disagree.`);
        if (m.status === 'disputed') steps.push(`Anyone: arbitrate_dispute on ${m.id}.`);
      }
      return steps;
    }
    case 'completed':
      return ['All milestones settled. Buyer may open_dispute on a released milestone until the pact is closed.'];
    default:
      return [];
  }
}

const ok = (data: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});
const fail = (e: unknown) => {
  const err = e as Error & { code?: string; details?: unknown };
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: err.code ?? err.name, message: err.message, details: err.details ?? null }) }] };
};

export function buildMcpServer(ctx: AppContext, pacts: PactService, agent: string) {
  const server = new McpServer({ name: 'pact', version: '0.1.0' }, { instructions: 'PACT: escrow for agent commerce. Funds are held by PayPal (sandbox) and released milestone by milestone after AI verification of evidence. Start with create_pact (natural language or structured), then follow nextSteps in every result.' });
  const actor = `agent:${agent}`;

  const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (args: z.infer<z.ZodObject<S>>) => Promise<Record<string, unknown>>) =>
    server.registerTool(name, { description, inputSchema: shape }, (async (args: z.infer<z.ZodObject<S>>) => {
      appendAudit(ctx, { pactId: (args as { pactId?: string }).pactId ?? null, actor, type: 'mcp.call', data: { tool: name, args: redact(args) } });
      try {
        return ok(await run(args));
      } catch (e) {
        return fail(e);
      }
    }) as never);

  tool(
    'create_pact',
    'Create an escrow pact between a buyer and a seller. Pass either `deal` (natural language, parsed by the Muse Contract Parser) or `contract` (structured). Returns the pact, or clarification questions if the deal is ambiguous.',
    {
      deal: z.string().min(10).max(4000).optional().describe('e.g. "50 embroidered t-shirts before Friday, 30% at production, 70% at delivery, 450 USD total"'),
      contract: Contract.optional(),
      buyerName: z.string().max(80),
      sellerName: z.string().max(80),
      today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Reference date for relative deadlines (YYYY-MM-DD)'),
    },
    async (a) => {
      let contract = a.contract;
      if (!contract) {
        if (!a.deal) throw Object.assign(new Error('Pass deal or contract'), { code: 'VALIDATION_ERROR' });
        const r = await parseContract(ctx.llm, { text: a.deal, today: a.today ?? ctx.now().toISOString().slice(0, 10), buyerName: a.buyerName, sellerName: a.sellerName });
        if (r.value.status !== 'ok' || !r.value.contract) return { status: 'needs_clarification', questions: r.value.questions, nextSteps: ['Answer the questions and call create_pact again with a clearer deal.'] };
        if (r.problems.length) return { status: 'invalid_contract', problems: r.problems, nextSteps: ['Rephrase the deal so milestone percentages sum to 100.'] };
        contract = r.value.contract;
      }
      const p = pacts.create({ contract, sourceText: a.deal ?? null, buyer: { name: a.buyerName, kind: 'agent' }, seller: { name: a.sellerName, kind: 'agent' }, actor });
      return { pact: summary(p), nextSteps: nextSteps(p) };
    },
  );

  tool('propose_pact', 'Buyer proposes a draft pact to the seller.', { pactId: z.string() }, async (a) => {
    const p = pacts.propose(a.pactId, actor);
    return { pact: summary(p), nextSteps: nextSteps(p) };
  });

  tool('accept_pact', 'Seller accepts a proposed pact (required before funding).', { pactId: z.string() }, async (a) => {
    const p = pacts.accept(a.pactId, actor);
    return { pact: summary(p), nextSteps: nextSteps(p) };
  });

  tool(
    'fund_pact',
    'Secure the funds with PayPal. First call creates a PayPal order (intent AUTHORIZE) and returns approvalUrl: a human buyer must approve it once in PayPal checkout (this approval is the spending cap the human sets). Later calls confirm the authorization once approved.',
    { pactId: z.string() },
    async (a) => {
      const before = pacts.view(a.pactId);
      if (!before.orderId) {
        const f = await pacts.fund(a.pactId, actor);
        return { status: 'awaiting_buyer_approval', approvalUrl: f.approvalUrl, orderId: f.orderId, paymentMode: f.paymentMode, nextSteps: ['A human buyer opens approvalUrl and approves in PayPal (sandbox).', 'Then call fund_pact again.'] };
      }
      const c = await pacts.confirmFunding(a.pactId, actor);
      const p = pacts.view(a.pactId);
      return { status: c.funded ? 'funded' : 'awaiting_buyer_approval', approvalUrl: p.approvalUrl, pact: summary(p), nextSteps: c.funded ? nextSteps(p) : ['Waiting for the buyer to approve in PayPal.'] };
    },
  );

  tool(
    'submit_evidence',
    'Seller submits evidence for a milestone. Provide `fixture` (a file name from the PACT demo fixtures, e.g. "order_conforming.jpg") or `contentBase64` + `filename`.',
    {
      pactId: z.string(),
      milestoneId: z.string(),
      type: EvidenceType,
      fixture: z.string().regex(/^[A-Za-z0-9._-]+$/).optional(),
      filename: z.string().max(120).optional(),
      contentBase64: z.string().max(12_000_000).optional(),
      note: z.string().max(500).optional(),
    },
    async (a) => {
      let bytes: Buffer;
      let filename: string;
      if (a.fixture) {
        bytes = readFileSync(resolve(repoRoot, 'fixtures', 'evidence', a.fixture));
        filename = a.fixture;
      } else if (a.contentBase64 && a.filename) {
        bytes = Buffer.from(a.contentBase64, 'base64');
        filename = a.filename;
      } else throw Object.assign(new Error('Pass fixture, or filename + contentBase64'), { code: 'VALIDATION_ERROR' });
      const ev = await pacts.submitEvidence(a.pactId, a.milestoneId, { filename, bytes, type: a.type, note: a.note ?? null }, actor);
      const p = pacts.view(a.pactId);
      return { evidenceId: ev.id, sha256: ev.sha256, pact: summary(p), nextSteps: [`Call verify_milestone for ${a.milestoneId}.`] };
    },
  );

  tool(
    'verify_milestone',
    'Run the AI Verifier (deterministic pre-checks, then Muse describes the evidence and judges it against the criteria). Approved milestones are released automatically (partial PayPal capture) unless autoRelease is false.',
    { pactId: z.string(), milestoneId: z.string(), autoRelease: z.boolean().default(true) },
    async (a) => {
      const r = await pacts.verifyMilestone(a.pactId, a.milestoneId, actor, { autoRelease: a.autoRelease });
      return { verdict: { id: r.verdict.id, status: r.verdict.status, confidence: r.verdict.confidence, reasoning: r.verdict.reasoning, criteria: r.verdict.verifier?.criteria ?? [] }, release: r.release, pact: summary(r.pact), nextSteps: nextSteps(r.pact) };
    },
  );

  tool('release_funds', 'Capture the funds of an approved milestone to the seller (partial capture; the last one is a final capture).', { pactId: z.string(), milestoneId: z.string() }, async (a) => {
    const r = await pacts.releaseMilestone(a.pactId, a.milestoneId, actor);
    const p = pacts.view(a.pactId);
    return { release: r, pact: summary(p), nextSteps: nextSteps(p) };
  });

  tool(
    'open_dispute',
    'Open a dispute on a milestone with your statement. Use arbitrate_dispute afterwards to get the AI Arbiter decision (appealable to a human).',
    { pactId: z.string(), milestoneId: z.string(), party: z.enum(['buyer', 'seller']), statement: z.string().min(5).max(2000) },
    async (a) => {
      const d = pacts.openDispute(a.pactId, a.milestoneId, a.party, a.statement, actor);
      return { disputeId: d.id, nextSteps: [`The other party may add a statement (add_statement), then call arbitrate_dispute for ${a.milestoneId}.`] };
    },
  );

  tool('add_statement', 'Add your statement to an open dispute.', { pactId: z.string(), milestoneId: z.string(), party: z.enum(['buyer', 'seller']), statement: z.string().min(5).max(2000) }, async (a) => {
    pacts.addStatement(a.pactId, a.milestoneId, a.party, a.statement, actor);
    return { ok: true, nextSteps: [`Call arbitrate_dispute for ${a.milestoneId}.`] };
  });

  tool('arbitrate_dispute', 'AI Arbiter reads contract, evidence, verifier history and statements and decides release / partial / refund; PACT moves the money. Either party can appeal to a human.', { pactId: z.string(), milestoneId: z.string() }, async (a) => {
    const r = await pacts.arbitrate(a.pactId, a.milestoneId, actor);
    return { decision: r.verdict.arbiter, verdictId: r.verdict.id, money: r.money, pact: summary(r.pact), nextSteps: [...nextSteps(r.pact), `Either party may appeal verdict ${r.verdict.id} to a human (POST /api/verdicts/${r.verdict.id}/appeal).`] };
  });

  tool('get_reputation', 'Reliability score of a party (Bayesian-smoothed completion, on-time, dispute and refund rates). Omit partyName for the leaderboard.', { partyName: z.string().optional() }, async (a) => {
    const board = leaderboard(ctx);
    if (!a.partyName) return { leaderboard: board.map((r) => ({ name: r.party.name, score: r.score, tier: r.tier })) };
    const hit = board.find((r) => r.party.name.toLowerCase() === a.partyName!.toLowerCase());
    if (!hit) return { found: false, note: 'No history yet: a new party starts at the prior (about 80/100).' };
    const r = getReputation(ctx, hit.party.id);
    return { found: true, name: r.party.name, score: r.score, tier: r.tier, completionRate: r.completionRate, onTimeRate: r.onTimeRate, disputeRate: r.disputeRate, refundRate: r.refundRate, confidence: r.confidence };
  });

  tool('get_pact', 'Read one pact with milestones, criteria and last verdicts.', { pactId: z.string() }, async (a) => {
    const p = pacts.view(a.pactId);
    return { pact: summary(p), nextSteps: nextSteps(p) };
  });

  tool('list_pacts', 'List pacts, optionally filtered by status.', { status: z.string().optional() }, async (a) => ({ pacts: pacts.list({ status: a.status }).map((p) => ({ id: p.id, title: p.title, status: p.status, total: p.totalMinor / 100, currency: p.currency, seller: p.seller.name })) }));

  return server;
}

function redact(args: unknown) {
  const a = { ...(args as Record<string, unknown>) };
  if (typeof a.contentBase64 === 'string') a.contentBase64 = `<${a.contentBase64.length} base64 chars>`;
  return a;
}

export function registerMcp(app: FastifyInstance, ctx: AppContext, pacts: PactService) {
  const keys = ctx.config.app.agentKeys;
  const authenticate = (header: string | undefined): string | null => {
    const token = header?.replace(/^Bearer\s+/i, '').trim();
    if (!token) return null;
    return keys.find((k) => k.key === token)?.name ?? null;
  };

  const handler = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const agent = authenticate((req.headers.authorization as string) ?? (req.headers['x-agent-key'] as string));
    if (!agent) {
      return reply.code(401).send({
        jsonrpc: '2.0',
        error: { code: -32001, message: keys.length ? 'Unknown or missing agent key (Authorization: Bearer <key>)' : 'AGENT_API_KEYS is not set in .env.local; no MCP agent can connect.' },
        id: null,
      });
    }
    const server = buildMcpServer(ctx, pacts, agent);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };

  app.post('/mcp', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, handler);
  app.get('/mcp', async (_req, reply) => reply.code(405).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: use POST)' }, id: null }));
}
