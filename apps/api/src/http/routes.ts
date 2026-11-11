import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Contract, EvidenceType, Mandate, toMinor } from '@pact/core';
import { desc, tables } from '@pact/db';
import { costOf, parseContract } from '@pact/llm';
import { newId } from '../context';
import type { AppContext } from '../context';
import { listAudit, verifyAudit } from '../services/audit';
import { ServiceError } from '../services/errors';
import { readEvidence } from '../services/evidence-store';
import type { JobRunner } from '../services/jobs';
import type { PactService } from '../services/pacts';
import { enqueueJob } from '../services/pacts';
import { handleWebhook, reconcile } from '../services/reconcile';
import { getReputation, leaderboard } from '../services/reputation';
import { verdictView } from '../services/views';
import { buildDashboard } from '../services/dashboard';
import { buildReconciliation } from '../services/reconciliation-view';
import { runSentinelScan, sentinelBrief } from '../services/sentinel';
import { checkMandate, decideApproval, mandatesOverview, updateMandate } from '../services/mandates';
import { createLiveSession, liveOverview, liveVideo, publicLiveSession, retryLiveSession, setLiveRequired, startLiveSession, submitLiveSession } from '../services/live';
import { defineRoute } from './route';

const PactId = z.object({ id: z.string() });
const PactMilestone = z.object({ id: z.string(), mid: z.string() });
const PartyIn = z.object({ name: z.string().min(1).max(80), kind: z.enum(['human', 'agent']).default('human'), email: z.string().email().nullable().optional() });
const Party = z.enum(['buyer', 'seller']);

export function registerRoutes(app: FastifyInstance, ctx: AppContext, pacts: PactService, jobs: JobRunner) {
  const r = <P extends z.ZodType = z.ZodObject<Record<string, never>>, Q extends z.ZodType = z.ZodObject<Record<string, never>>, B extends z.ZodType = z.ZodObject<Record<string, never>>>(
    spec: Parameters<typeof defineRoute<P, Q, B>>[2],
  ) => defineRoute<P, Q, B>(app, ctx, spec);

  // --- status --------------------------------------------------------------------------------
  r({
    method: 'GET',
    url: '/api/status',
    summary: 'Runtime modes (PayPal sandbox vs simulated, LLM live vs replay) for honest UI labelling',
    tags: ['system'],
    handler: () => ({
      paymentMode: ctx.gateway.mode,
      paymentModeRequested: ctx.config.paypal.requestedMode,
      paypalSimulatedReason:
        ctx.gateway.mode === 'simulated'
          ? ctx.config.paypal.requestedMode === 'simulated'
            ? 'PAYPAL_ENV=simulated'
            : 'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set'
          : null,
      webhookVerification: !!ctx.config.paypal.webhookId,
      llmMode: ctx.llm.mode,
      llmModel: ctx.llm.model,
      llmLiveAvailable: ctx.llm.liveAvailable,
      agStudioLicense: ctx.config.agStudioLicenseSet,
      mcpAgents: ctx.config.app.agentKeys.map((a) => a.name),
      now: ctx.now().toISOString(),
    }),
  });

  // --- contracts -------------------------------------------------------------------------------
  r({
    method: 'POST',
    url: '/api/contracts/parse',
    summary: 'Contract Parser: natural language → structured contract (or clarification questions)',
    tags: ['contracts'],
    body: z.object({
      text: z.string().min(10).max(4000),
      today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      buyerName: z.string().max(80).optional(),
      sellerName: z.string().max(80).optional(),
    }),
    handler: async ({ body }) => {
      try {
        const res = await parseContract(ctx.llm, { ...body, today: body.today ?? ctx.now().toISOString().slice(0, 10) });
        return { result: res.value, problems: res.problems, model: res.model, llmMode: res.mode, usage: res.usage };
      } catch (e) {
        const err = e as Error;
        if (['LlmReplayMissError', 'LlmConfigError'].includes(err.name)) throw new ServiceError('AI_UNAVAILABLE', err.message, 503);
        if (err.name === 'LlmOutputError') throw new ServiceError('AI_INVALID_OUTPUT', err.message, 502);
        throw e;
      }
    },
  });

  // --- pacts -----------------------------------------------------------------------------------
  r({
    method: 'POST',
    url: '/api/pacts',
    summary: 'Create a pact (draft) from a structured contract',
    tags: ['pacts'],
    idempotent: true,
    body: z.object({ contract: Contract, sourceText: z.string().max(4000).nullable().optional(), buyer: PartyIn, seller: PartyIn }),
    handler: ({ body, actor }) => pacts.create({ ...body, actor }),
  });
  r({
    method: 'GET',
    url: '/api/pacts',
    summary: 'List pacts',
    tags: ['pacts'],
    query: z.object({ status: z.string().optional(), partyId: z.string().optional() }),
    handler: ({ query }) => pacts.list(query),
  });
  r({ method: 'GET', url: '/api/pacts/:id', summary: 'Get one pact with milestones, evidence, verdicts and payments', tags: ['pacts'], params: PactId, handler: ({ params }) => pacts.view(params.id) });
  r({ method: 'POST', url: '/api/pacts/:id/propose', summary: 'Buyer proposes the pact to the seller', tags: ['pacts'], params: PactId, idempotent: true, handler: ({ params, actor }) => pacts.propose(params.id, actor) });
  r({ method: 'POST', url: '/api/pacts/:id/accept', summary: 'Seller accepts the proposed pact', tags: ['pacts'], params: PactId, idempotent: true, handler: ({ params, actor }) => pacts.accept(params.id, actor) });
  r({
    method: 'POST',
    url: '/api/pacts/:id/fund',
    summary: 'Create the PayPal order (intent AUTHORIZE); returns the buyer approval URL',
    description: 'Funds are only held after the buyer approves in PayPal checkout and PACT authorizes the order (POST /fund/confirm, or the reconciliation poller).',
    tags: ['payments'],
    params: PactId,
    idempotent: true,
    handler: ({ params, actor }) => pacts.fund(params.id, actor),
  });
  r({ method: 'POST', url: '/api/pacts/:id/fund/confirm', summary: 'Authorize the approved order: funds held, buyer not charged', tags: ['payments'], params: PactId, idempotent: true, handler: ({ params, actor }) => pacts.confirmFunding(params.id, actor) });
  r({
    method: 'POST',
    url: '/api/pacts/:id/simulated-approve',
    summary: 'SIMULATED mode only: stand-in for the buyer approving in PayPal checkout',
    tags: ['payments'],
    params: PactId,
    handler: async ({ params, actor }) => {
      pacts.approveSimulated(params.id, actor);
      return pacts.confirmFunding(params.id, actor);
    },
  });
  r({ method: 'POST', url: '/api/pacts/:id/cancel', summary: 'Cancel the pact and void the remaining authorization', tags: ['pacts'], params: PactId, body: z.object({ reason: z.string().max(500).default('cancelled') }), idempotent: true, handler: ({ params, body, actor }) => pacts.cancel(params.id, actor, body.reason) });
  r({ method: 'POST', url: '/api/pacts/:id/close', summary: 'Close a completed pact (ends the dispute window)', tags: ['pacts'], params: PactId, idempotent: true, handler: ({ params, actor }) => pacts.close(params.id, actor) });

  // --- milestones --------------------------------------------------------------------------
  r({
    method: 'POST',
    url: '/api/pacts/:id/milestones/:mid/evidence',
    summary: 'Submit evidence (multipart field "file", or JSON with base64 content)',
    tags: ['milestones'],
    params: PactMilestone,
    body: z.object({ filename: z.string().max(120), contentBase64: z.string().max(12_000_000), type: EvidenceType, note: z.string().max(500).nullable().optional() }),
    handler: async ({ params, body, actor, req }) => {
      if (req.isMultipart()) {
        let file: { filename: string; bytes: Buffer } | null = null;
        const fields: Record<string, string> = {};
        for await (const part of req.parts()) {
          if (part.type === 'file') file = { filename: part.filename, bytes: await part.toBuffer() };
          else fields[part.fieldname] = String(part.value);
        }
        if (!file) throw new ServiceError('VALIDATION_ERROR', 'Multipart upload needs a "file" field', 400);
        const type = EvidenceType.safeParse(fields.type);
        if (!type.success) throw new ServiceError('VALIDATION_ERROR', 'Field "type" must be photo, document, code or tracking', 400);
        return pacts.submitEvidence(params.id, params.mid, { ...file, type: type.data, note: fields.note ?? null }, actor);
      }
      return pacts.submitEvidence(params.id, params.mid, { filename: body.filename, bytes: Buffer.from(body.contentBase64, 'base64'), type: body.type, note: body.note }, actor);
    },
  });
  r({
    method: 'POST',
    url: '/api/pacts/:id/milestones/:mid/verify',
    summary: 'Run the two-step AI Verifier on the submitted evidence; approved → automatic partial capture',
    tags: ['milestones'],
    params: PactMilestone,
    body: z.object({ autoRelease: z.boolean().default(true), async: z.boolean().default(false) }),
    handler: async ({ params, body, actor }) => {
      if (body.async) {
        enqueueJob(ctx, 'verify', { pactId: params.id, milestoneId: params.mid }, ctx.now());
        void jobs.tick();
        return { queued: true };
      }
      return pacts.verifyMilestone(params.id, params.mid, actor, { autoRelease: body.autoRelease });
    },
  });
  r({ method: 'POST', url: '/api/pacts/:id/milestones/:mid/release', summary: 'Capture an approved milestone (partial or final capture)', tags: ['milestones'], params: PactMilestone, idempotent: true, handler: ({ params, actor }) => pacts.releaseMilestone(params.id, params.mid, actor) });
  r({ method: 'POST', url: '/api/pacts/:id/milestones/:mid/dispute', summary: 'Open a dispute on a milestone', tags: ['disputes'], params: PactMilestone, body: z.object({ party: Party, statement: z.string().min(5).max(2000) }), idempotent: true, handler: ({ params, body, actor }) => pacts.openDispute(params.id, params.mid, body.party, body.statement, actor) });
  r({ method: 'POST', url: '/api/pacts/:id/milestones/:mid/statement', summary: 'Add a party statement to an open dispute', tags: ['disputes'], params: PactMilestone, body: z.object({ party: Party, statement: z.string().min(5).max(2000) }), handler: ({ params, body, actor }) => pacts.addStatement(params.id, params.mid, body.party, body.statement, actor) });
  r({ method: 'POST', url: '/api/pacts/:id/milestones/:mid/arbitrate', summary: 'AI Arbiter decides the dispute (release / partial / refund) and PACT moves the money', tags: ['disputes'], params: PactMilestone, idempotent: true, handler: ({ params, actor }) => pacts.arbitrate(params.id, params.mid, actor) });

  // --- verdicts & appeals ------------------------------------------------------------------
  r({
    method: 'GET',
    url: '/api/verdicts',
    summary: 'List AI and human verdicts (filter by status, kind, since)',
    tags: ['verdicts'],
    query: z.object({ status: z.string().optional(), kind: z.enum(['verifier', 'arbiter', 'human']).optional(), since: z.string().optional(), pactId: z.string().optional() }),
    handler: ({ query }) =>
      ctx.db
        .select()
        .from(tables.verdicts)
        .orderBy(desc(tables.verdicts.createdAt))
        .all()
        .filter((v) => (!query.status || v.status === query.status) && (!query.kind || v.kind === query.kind) && (!query.since || v.createdAt >= query.since) && (!query.pactId || v.pactId === query.pactId))
        .map(verdictView),
  });
  r({ method: 'GET', url: '/api/verdicts/:id', summary: 'Get one verdict', tags: ['verdicts'], params: PactId, handler: ({ params }) => pacts.verdictById(params.id) });
  r({ method: 'POST', url: '/api/verdicts/:id/appeal', summary: 'Appeal an AI decision to a human reviewer', tags: ['verdicts'], params: PactId, body: z.object({ party: Party, note: z.string().min(3).max(1000) }), idempotent: true, handler: ({ params, body, actor }) => pacts.appeal(params.id, body.party, body.note, actor) });
  r({
    method: 'POST',
    url: '/api/verdicts/:id/review',
    summary: 'Human reviewer decides an appeal',
    tags: ['verdicts'],
    params: PactId,
    body: z.object({ reviewer: z.string().min(1).max(80), outcome: z.enum(['upheld', 'overturned']), note: z.string().min(3).max(1000), decision: z.object({ outcome: z.enum(['release', 'partial', 'refund']), releasePercent: z.number().int().min(1).max(99).optional() }).optional() }),
    handler: ({ params, body }) => pacts.reviewAppeal(params.id, body.reviewer, body.outcome, body.note, body.decision),
  });

  // --- evidence files ------------------------------------------------------------------------
  app.get('/api/evidence/:id/file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const e = ctx.db.select().from(tables.evidence).all().find((x) => x.id === id);
    if (!e) return reply.code(404).send({ error: 'EVIDENCE_NOT_FOUND', message: 'not found' });
    reply.header('Content-Type', e.mime).header('Cache-Control', 'private, max-age=3600').header('X-Content-Type-Options', 'nosniff');
    if (!e.mime.startsWith('image/')) reply.header('Content-Disposition', `attachment; filename="${e.filename}"`);
    return reply.send(readEvidence(e.path));
  });

  // --- live video proof ------------------------------------------------------------------------
  const LiveToken = z.object({ token: z.string().regex(/^[0-9a-f]{32}$/) });
  r({ method: 'GET', url: '/api/pacts/:id/live', summary: 'Live video proof state per milestone: requirement, capture sessions, instruction checks', tags: ['live proof'], params: PactId, handler: ({ params }) => liveOverview(ctx, params.id) });
  r({
    method: 'POST',
    url: '/api/pacts/:id/milestones/:mid/live-proof',
    summary: 'Buyer requires (or stops requiring) live video proof on a photo milestone: uploads are then refused',
    tags: ['live proof'],
    params: PactMilestone,
    body: z.object({ required: z.boolean() }),
    handler: ({ params, body, actor }) => setLiveRequired(ctx, pacts, params.id, params.mid, body.required, actor),
  });
  r({ method: 'POST', url: '/api/pacts/:id/milestones/:mid/live-sessions', summary: 'One-time capture link for the seller (valid 30 minutes)', tags: ['live proof'], params: PactMilestone, handler: ({ params, actor }) => createLiveSession(ctx, pacts, params.id, params.mid, actor) });
  r({ method: 'GET', url: '/api/live/:token', summary: 'Capture page data (instructions stay hidden until the recording starts)', tags: ['live proof'], params: LiveToken, handler: ({ params }) => publicLiveSession(ctx, pacts, params.token) });
  r({ method: 'POST', url: '/api/live/:token/start', summary: 'Start the 20-second recording: draws three random instructions now', tags: ['live proof'], params: LiveToken, handler: ({ params }) => startLiveSession(ctx, params.token) });
  r({
    method: 'POST',
    url: '/api/live/:token/submit',
    summary: 'Upload the recording and its timed frames; Muse checks each instruction, then the Verifier judges the milestone',
    tags: ['live proof'],
    params: LiveToken,
    body: z.object({
      video: z.string().min(16).max(17_000_000),
      videoMime: z.string().max(80),
      frames: z.array(z.object({ slot: z.string().max(8), atMs: z.number().int().min(0).max(60_000), data: z.string().max(2_800_000) })).max(12),
    }),
    handler: ({ params, body }) => submitLiveSession(ctx, pacts, params.token, body),
  });
  r({ method: 'POST', url: '/api/live/:token/retry', summary: 'New capture link with new instructions after a failed or expired recording', tags: ['live proof'], params: LiveToken, handler: ({ params }) => retryLiveSession(ctx, pacts, params.token) });
  app.get('/api/live-sessions/:id/video', async (req, reply) => {
    const { id } = req.params as { id: string };
    const v = liveVideo(ctx, id);
    reply.header('Content-Type', v.mime).header('Cache-Control', 'private, max-age=3600').header('X-Content-Type-Options', 'nosniff');
    return reply.send(readEvidence(v.path));
  });

  // --- reputation -----------------------------------------------------------------------------
  r({ method: 'GET', url: '/api/reputation', summary: 'Reputation leaderboard (Bayesian-smoothed)', tags: ['reputation'], handler: () => leaderboard(ctx) });
  r({ method: 'GET', url: '/api/reputation/:id', summary: 'Reputation of one party', tags: ['reputation'], params: PactId, handler: ({ params }) => getReputation(ctx, params.id) });
  r({ method: 'GET', url: '/api/parties', summary: 'List parties', tags: ['reputation'], handler: () => ctx.db.select().from(tables.parties).all() });

  // --- audit ---------------------------------------------------------------------------------
  r({ method: 'GET', url: '/api/audit', summary: 'Hash-chained audit log', tags: ['audit'], query: z.object({ pactId: z.string().optional(), limit: z.coerce.number().int().min(1).max(5000).optional() }), handler: ({ query }) => listAudit(ctx, query) });
  r({ method: 'GET', url: '/api/audit/verify', summary: 'Recompute every hash and report whether the chain is intact', tags: ['audit'], handler: () => verifyAudit(ctx) });

  // --- dashboard & reconciliation -------------------------------------------------------------
  r({ method: 'GET', url: '/api/dashboard', summary: 'Flattened tables for the AG Studio Control Tower', tags: ['dashboard'], handler: () => buildDashboard(ctx) });
  r({ method: 'GET', url: '/api/reconciliation', summary: 'PayPal Transaction Search + balances vs. PACT ledger (as-of timestamp, 3-hour caveat)', tags: ['dashboard'], handler: () => buildReconciliation(ctx) });

  // --- sentinel (anomaly detection) ------------------------------------------------------------
  r({ method: 'GET', url: '/api/sentinel/scan', summary: 'Run the Sentinel rules over the ledger: deterministic anomalies with severity, metric vs baseline and affected pacts', tags: ['sentinel'], handler: () => runSentinelScan(ctx) });
  r({
    method: 'POST',
    url: '/api/sentinel/brief',
    summary: 'Scan, then have Muse write a plain-English briefing of the findings (deterministic template when no model answer is available)',
    tags: ['sentinel'],
    handler: async () => {
      const scan = runSentinelScan(ctx);
      return { scan, brief: await sentinelBrief(ctx, scan) };
    },
  });

  // --- agent mandates ---------------------------------------------------------------------------
  const AgentParam = z.object({ agent: z.string().min(1).max(80) });
  const knownAgent = (agent: string) => {
    if (!ctx.config.app.agentKeys.some((k) => k.name === agent)) throw new ServiceError('NOT_FOUND', `No MCP agent named ${agent} (see AGENT_API_KEYS)`, 404);
  };
  r({ method: 'GET', url: '/api/mandates', summary: 'MCP agents with their mandates, open exposure, approval requests and recent mandate decisions', tags: ['mandates'], handler: () => mandatesOverview(ctx) });
  r({
    method: 'POST',
    url: '/api/mandates/:agent',
    summary: "Set an agent's mandate (per-pact limit, open budget, approval threshold, allowed categories)",
    tags: ['mandates'],
    params: AgentParam,
    body: Mandate.omit({ agent: true }),
    handler: ({ params, body, actor }) => {
      knownAgent(params.agent);
      return updateMandate(ctx, { ...body, agent: params.agent }, actor);
    },
  });
  r({
    method: 'POST',
    url: '/api/mandates/:agent/check',
    summary: 'Dry run: what the mandate would decide for a purchase (allowed, needs the owner, denied) and why. Writes nothing.',
    tags: ['mandates'],
    params: AgentParam,
    body: z.object({ title: z.string().min(1).max(200), description: z.string().max(4000).default(''), amount: z.number().positive(), currency: z.string().length(3).default('USD') }),
    handler: ({ params, body }) => {
      knownAgent(params.agent);
      const { mandate, ...decision } = checkMandate(ctx, params.agent, { title: body.title, text: `${body.title}\n${body.description}`, totalMinor: toMinor(body.amount), currency: body.currency.toUpperCase() });
      return { agent: params.agent, owner: mandate?.owner ?? null, ...decision };
    },
  });
  r({ method: 'POST', url: '/api/mandates/approvals/:id/approve', summary: "The owner approves an agent's pending pact", tags: ['mandates'], params: PactId, handler: ({ params, actor }) => decideApproval(ctx, params.id, 'approved', actor) });
  r({ method: 'POST', url: '/api/mandates/approvals/:id/deny', summary: "The owner refuses an agent's pending pact", tags: ['mandates'], params: PactId, handler: ({ params, actor }) => decideApproval(ctx, params.id, 'denied', actor) });

  // --- admin -----------------------------------------------------------------------------------
  r({
    method: 'GET',
    url: '/api/admin/usage',
    summary: 'Muse token usage and cost',
    tags: ['admin'],
    handler: () => {
      const rows = ctx.db.select().from(tables.llmUsage).orderBy(desc(tables.llmUsage.createdAt)).all();
      const sum = (f: (x: (typeof rows)[number]) => number) => rows.reduce((a, x) => a + f(x), 0);
      const byRole: Record<string, { calls: number; costUsd: number; inputTokens: number; outputTokens: number; cacheHits: number }> = {};
      for (const x of rows) {
        const b = (byRole[x.role] ??= { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheHits: 0 });
        b.calls++;
        b.costUsd += x.costUsd;
        b.inputTokens += x.inputTokens;
        b.outputTokens += x.outputTokens;
        b.cacheHits += x.cacheHit ? 1 : 0;
      }
      return {
        model: ctx.llm.model,
        mode: ctx.llm.mode,
        totals: { calls: rows.length, liveCalls: rows.filter((x) => !x.cacheHit).length, costUsd: sum((x) => x.costUsd), inputTokens: sum((x) => x.inputTokens), outputTokens: sum((x) => x.outputTokens), reasoningTokens: sum((x) => x.reasoningTokens) },
        byRole,
        recent: rows.slice(0, 50),
      };
    },
  });
  r({
    method: 'POST',
    url: '/api/admin/llm-usage',
    summary: 'Record token usage of the AG Studio PACT Auditor (called by the web app proxy)',
    tags: ['admin'],
    body: z.object({
      role: z.string().max(60),
      model: z.string().max(60),
      mode: z.enum(['live', 'replay']),
      cacheHit: z.boolean(),
      inputTokens: z.number().int().min(0),
      outputTokens: z.number().int().min(0),
      reasoningTokens: z.number().int().min(0).default(0),
      cachedTokens: z.number().int().min(0).default(0),
      latencyMs: z.number().int().min(0).default(0),
    }),
    handler: ({ body }) => {
      const costUsd = body.cacheHit ? 0 : costOf(body.model, body);
      ctx.db.insert(tables.llmUsage).values({ id: newId('llm'), ...body, costUsd, createdAt: ctx.now().toISOString() }).run();
      return { ok: true, costUsd };
    },
  });
  r({ method: 'GET', url: '/api/admin/paypal-calls', summary: 'Recent PayPal API calls (sandbox mode; never includes tokens)', tags: ['admin'], handler: () => ctx.paypalCalls });
  r({ method: 'GET', url: '/api/admin/jobs', summary: 'Scheduled jobs', tags: ['admin'], handler: () => ctx.db.select().from(tables.jobs).orderBy(desc(tables.jobs.createdAt)).limit(200).all() });
  r({ method: 'POST', url: '/api/admin/jobs/run', summary: 'Run due jobs now', tags: ['admin'], handler: async () => ({ ran: await jobs.tick() }) });
  r({ method: 'POST', url: '/api/admin/reconcile', summary: 'Run the PayPal reconciliation poller now', tags: ['admin'], handler: () => reconcile(ctx, pacts) });

  // --- webhooks ------------------------------------------------------------------------------
  app.post('/api/webhooks/paypal', async (req, reply) => {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
    const out = await handleWebhook(ctx, pacts, headers, raw);
    return reply.code(out.status).send(out.body);
  });
}
