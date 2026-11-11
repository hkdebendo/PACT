// Agent mandates, enforced on the server for MCP agents: a per-pact limit, a budget across the
// agent's open pacts, allowed purchase categories, and an amount above which the agent's human owner
// must approve. A call within the mandate is untouched (no extra output, no extra audit entry);
// a call outside it fails with MANDATE_DENIED or MANDATE_APPROVAL_REQUIRED and is audit-logged.
import { evaluateMandate, Mandate, mandateText, type MandateDecision, type MandateRequest } from '@pact/core';
import { and, desc, eq, inArray, tables } from '@pact/db';
import { newId, type AppContext } from '../context';
import { appendAudit } from './audit';
import { ServiceError } from './errors';

const OPEN_STATUSES = ['draft', 'proposed', 'funded', 'in_progress', 'disputed'];

/** Mandates installed for the local demo agents when none is set. The demo deal (450 USD of
 *  t-shirts) is within it; 800 USD needs the owner; 2,500 USD or electronics are refused. */
export const DEFAULT_MANDATES: Mandate[] = [
  {
    agent: 'buyer-agent',
    owner: 'Ada (buyer)',
    active: true,
    currency: 'USD',
    maxPactMinor: 100_000,
    maxOpenMinor: 150_000,
    approvalAboveMinor: 50_000,
    categories: ['apparel', 'bags & textiles', 'printing'],
  },
];

type Row = typeof tables.agentMandates.$inferSelect;
const fromRow = (r: Row): Mandate => ({
  agent: r.agent,
  owner: r.owner,
  active: r.active,
  currency: r.currency,
  maxPactMinor: r.maxPactMinor,
  maxOpenMinor: r.maxOpenMinor,
  approvalAboveMinor: r.approvalAboveMinor,
  categories: JSON.parse(r.categoriesJson),
});

export function ensureDefaultMandates(ctx: AppContext) {
  const agents = new Set(ctx.config.app.agentKeys.map((k) => k.name));
  for (const m of DEFAULT_MANDATES) {
    if (!agents.has(m.agent) || getMandate(ctx, m.agent)) continue;
    ctx.db
      .insert(tables.agentMandates)
      .values({ ...m, categoriesJson: JSON.stringify(m.categories), updatedAt: ctx.now().toISOString(), updatedBy: 'system:defaults' })
      .run();
  }
}

export function getMandate(ctx: AppContext, agent: string): Mandate | null {
  const r = ctx.db.select().from(tables.agentMandates).where(eq(tables.agentMandates.agent, agent)).get();
  return r ? fromRow(r) : null;
}

/** Pacts the agent started (it called create_pact) that are not settled yet. */
function openPacts(ctx: AppContext, agent: string, exclude?: string) {
  const created = ctx.db
    .select({ pactId: tables.auditLog.pactId })
    .from(tables.auditLog)
    .where(and(eq(tables.auditLog.type, 'pact.created'), eq(tables.auditLog.actor, `agent:${agent}`)))
    .all()
    .map((r) => r.pactId!)
    .filter((id) => id && id !== exclude);
  if (!created.length) return [];
  return ctx.db
    .select({ id: tables.pacts.id, title: tables.pacts.title, status: tables.pacts.status, totalMinor: tables.pacts.totalMinor })
    .from(tables.pacts)
    .where(and(inArray(tables.pacts.id, created), inArray(tables.pacts.status, OPEN_STATUSES)))
    .all();
}

const openMinorOf = (ctx: AppContext, agent: string, exclude?: string) => openPacts(ctx, agent, exclude).reduce((s, p) => s + p.totalMinor, 0);

/** Dry run: what the mandate says about a request. Writes nothing. */
export function checkMandate(ctx: AppContext, agent: string, req: MandateRequest, pactId?: string): MandateDecision & { mandate: Mandate | null } {
  const mandate = getMandate(ctx, agent);
  const approved = !!pactId && !!ctx.db.select().from(tables.mandateApprovals).where(and(eq(tables.mandateApprovals.pactId, pactId), eq(tables.mandateApprovals.status, 'approved'))).get();
  return { ...evaluateMandate(mandate, req, openMinorOf(ctx, agent, pactId), approved), mandate };
}

/** The request the mandate sees for a contract (party names removed from the classified text). */
export function mandateRequest(c: { title: string; description: string; currency: string; milestones: { title: string; criteria: { text: string }[] }[] }, totalMinor: number, parties: string[]): MandateRequest {
  return { title: c.title, text: mandateText(c, parties), totalMinor, currency: c.currency };
}

/**
 * Enforcement for an agent action. `create`: hard limits only (a draft spends nothing).
 * `fund`: hard limits, then the owner's approval when one is needed.
 */
export function enforceMandate(ctx: AppContext, agent: string, stage: 'create' | 'fund', req: MandateRequest, pactId?: string) {
  const d = checkMandate(ctx, agent, req, pactId);
  if (d.outcome === 'allowed' || (stage === 'create' && d.outcome === 'needs_approval')) return d;
  const actor = `agent:${agent}`;
  if (d.outcome === 'denied') {
    appendAudit(ctx, { pactId: pactId ?? null, actor: 'system:mandate', type: 'mandate.denied', data: { agent, stage, title: req.title, totalMinor: req.totalMinor, currency: req.currency, categories: d.categories, reasons: d.reasons } });
    throw new ServiceError('MANDATE_DENIED', `Outside ${agent}'s mandate: ${d.reasons.join(' ')}`, 403, { reasons: d.reasons, categories: d.categories, owner: d.mandate?.owner ?? null });
  }
  // needs_approval at funding: one pending request per pact.
  let pending = ctx.db.select().from(tables.mandateApprovals).where(and(eq(tables.mandateApprovals.pactId, pactId!), eq(tables.mandateApprovals.status, 'pending'))).get();
  if (!pending) {
    const row = { id: newId('apr'), agent, pactId: pactId!, totalMinor: req.totalMinor, currency: req.currency, reasonsJson: JSON.stringify(d.reasons), status: 'pending', createdAt: ctx.now().toISOString(), decidedAt: null, decidedBy: null };
    ctx.db.insert(tables.mandateApprovals).values(row).run();
    appendAudit(ctx, { pactId: pactId!, actor, type: 'mandate.approval_requested', data: { agent, approvalId: row.id, totalMinor: req.totalMinor, reasons: d.reasons } });
    pending = row;
  }
  throw new ServiceError('MANDATE_APPROVAL_REQUIRED', `${d.mandate!.owner} must approve this pact before ${agent} can fund it: ${d.reasons.join(' ')}`, 403, {
    approvalId: pending.id,
    reasons: d.reasons,
    owner: d.mandate!.owner,
    nextSteps: [`Ask ${d.mandate!.owner} to approve request ${pending.id} on the PACT Agents page, then call fund_pact again.`],
  });
}

export function decideApproval(ctx: AppContext, id: string, decision: 'approved' | 'denied', actor: string) {
  const row = ctx.db.select().from(tables.mandateApprovals).where(eq(tables.mandateApprovals.id, id)).get();
  if (!row) throw new ServiceError('NOT_FOUND', `Approval request ${id} not found`, 404);
  if (row.status !== 'pending') throw new ServiceError('ALREADY_DECIDED', `Approval request ${id} is already ${row.status}`, 409);
  ctx.db.update(tables.mandateApprovals).set({ status: decision, decidedAt: ctx.now().toISOString(), decidedBy: actor }).where(eq(tables.mandateApprovals.id, id)).run();
  appendAudit(ctx, { pactId: row.pactId, actor, type: `mandate.approval_${decision}`, data: { agent: row.agent, approvalId: id, totalMinor: row.totalMinor } });
  return ctx.db.select().from(tables.mandateApprovals).where(eq(tables.mandateApprovals.id, id)).get();
}

export function updateMandate(ctx: AppContext, m: Mandate, actor: string) {
  const values = { ...m, categoriesJson: JSON.stringify(m.categories), updatedAt: ctx.now().toISOString(), updatedBy: actor };
  ctx.db.insert(tables.agentMandates).values(values).onConflictDoUpdate({ target: tables.agentMandates.agent, set: values }).run();
  appendAudit(ctx, { pactId: null, actor, type: 'mandate.updated', data: m });
  return getMandate(ctx, m.agent);
}

/** Everything the Agents page shows. */
export function mandatesOverview(ctx: AppContext) {
  const agents = ctx.config.app.agentKeys.map((k) => k.name);
  const approvals = ctx.db.select().from(tables.mandateApprovals).orderBy(desc(tables.mandateApprovals.createdAt)).limit(50).all();
  const pactTitles = new Map(
    approvals.length
      ? ctx.db
          .select({ id: tables.pacts.id, title: tables.pacts.title })
          .from(tables.pacts)
          .where(inArray(tables.pacts.id, [...new Set(approvals.map((a) => a.pactId))]))
          .all()
          .map((p) => [p.id, p.title])
      : [],
  );
  const decisions = ctx.db
    .select()
    .from(tables.auditLog)
    .where(inArray(tables.auditLog.type, ['mandate.denied', 'mandate.approval_requested', 'mandate.approval_approved', 'mandate.approval_denied', 'mandate.updated']))
    .orderBy(desc(tables.auditLog.seq))
    .limit(30)
    .all()
    .map((e) => ({ seq: e.seq, ts: e.ts, type: e.type, actor: e.actor, pactId: e.pactId, data: JSON.parse(e.dataJson) }));
  return {
    agents: agents.map((agent) => {
      const open = openPacts(ctx, agent);
      return { agent, mandate: getMandate(ctx, agent), openMinor: open.reduce((s, p) => s + p.totalMinor, 0), openPacts: open };
    }),
    approvals: approvals.map((a) => ({ ...a, reasons: JSON.parse(a.reasonsJson) as string[], pactTitle: pactTitles.get(a.pactId) ?? null })),
    decisions,
  };
}
