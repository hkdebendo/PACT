// Flat tables for the AG Studio "Control Tower". Studio joins them through the relationships
// declared in apps/web/app/control-tower/studio/data.ts. Money is in major units here because Studio
// formats numbers; the ledger itself stays in minor units.
import { tables } from '@pact/db';
import type { AppContext } from '../context';
import { verifyAudit } from './audit';
import { leaderboard } from './reputation';
import { buildPactView } from './views';

const major = (minor: number) => Math.round(minor) / 100;

export function buildDashboard(ctx: AppContext) {
  const views = ctx.db.select().from(tables.pacts).all().map((r) => buildPactView(ctx, r));
  const disputes = ctx.db.select().from(tables.disputes).all();

  const pacts = views.map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    buyer: p.buyer.name,
    buyerId: p.buyer.id,
    seller: p.seller.name,
    sellerId: p.seller.id,
    currency: p.currency,
    total: major(p.totalMinor),
    held: major(p.heldMinor),
    released: major(p.releasedMinor),
    refunded: major(p.refundedMinor),
    voided: major(p.voidedMinor),
    milestones: p.milestones.length,
    milestonesDone: p.milestones.filter((m) => ['released', 'partially_released', 'refunded', 'voided'].includes(m.status)).length,
    paymentMode: p.paymentMode,
    createdAt: p.createdAt,
    deadline: p.deadline,
  }));

  const milestones = views.flatMap((p) =>
    p.milestones.map((m, i) => {
      const last = m.verdicts.at(-1);
      const photo = [...m.evidence].reverse().find((e) => e.mime.startsWith('image/'));
      return {
        key: `${p.id}:${m.id}`,
        pactId: p.id,
        pactTitle: p.title,
        milestoneId: m.id,
        position: i + 1,
        title: m.title,
        percent: m.percent,
        amount: major(m.amountMinor),
        captured: major(m.capturedMinor),
        refunded: major(m.refundedMinor),
        status: m.status,
        attempts: m.attempts,
        deadline: m.deadline,
        releasedAt: m.releasedAt,
        lastVerdict: last?.status ?? null,
        lastConfidence: last ? Math.round(last.confidence * 100) / 100 : null,
        evidenceCount: m.evidence.length,
        thumbnailUrl: photo ? photo.url : null,
        seller: p.seller.name,
      };
    }),
  );

  const verdicts = views.flatMap((p) =>
    p.milestones.flatMap((m) =>
      m.verdicts.map((v) => ({
        id: v.id,
        pactId: p.id,
        pactTitle: p.title,
        milestoneKey: `${p.id}:${m.id}`,
        milestoneTitle: m.title,
        kind: v.kind,
        status: v.status,
        refused: v.status === 'rejected' || v.status === 'refund',
        confidence: Math.round(v.confidence * 100) / 100,
        reasoning: v.reasoning,
        model: v.model,
        llmMode: v.llmMode,
        appealStatus: v.appealStatus,
        precheckFailures: v.precheckFailures.length,
        createdAt: v.createdAt,
        seller: p.seller.name,
      })),
    ),
  );

  const payments = views.flatMap((p) =>
    p.payments.map((x) => ({
      id: x.id,
      pactId: p.id,
      milestoneKey: x.milestoneId ? `${p.id}:${x.milestoneId}` : null,
      kind: x.kind,
      amount: major(x.amountMinor),
      currency: x.currency,
      status: x.status,
      mode: x.mode,
      paypalId: x.paypalId,
      createdAt: x.createdAt,
    })),
  );

  const reputation = leaderboard(ctx).map((r) => ({
    partyId: r.party.id,
    name: r.party.name,
    kind: r.party.kind,
    score: r.score,
    tier: r.tier,
    completionRate: Math.round(r.completionRate * 1000) / 1000,
    onTimeRate: Math.round(r.onTimeRate * 1000) / 1000,
    disputeRate: Math.round(r.disputeRate * 1000) / 1000,
    refundRate: Math.round(r.refundRate * 1000) / 1000,
    confidence: Math.round(r.confidence * 100) / 100,
    milestones: r.raw.milestonesTotal,
    trend: r.history.map((h) => h.score),
  }));

  const sum = (f: (p: (typeof pacts)[number]) => number) => Math.round(pacts.reduce((a, p) => a + f(p), 0) * 100) / 100;
  const authorized = sum((p) => (p.held + p.released + p.refunded + p.voided > 0 ? p.held + p.released + p.refunded + p.voided : 0));
  const payoutTotal = Math.round(payments.filter((x) => x.kind === 'payout').reduce((a, x) => a + x.amount, 0) * 100) / 100;
  const flows = [
    { source: 'Buyers', target: 'PACT escrow (PayPal authorization)', value: authorized },
    { source: 'PACT escrow (PayPal authorization)', target: 'Sellers', value: Math.max(0, sum((p) => p.released) - payoutTotal) },
    { source: 'PACT escrow (PayPal authorization)', target: 'Subcontractors (Payouts)', value: payoutTotal },
    { source: 'PACT escrow (PayPal authorization)', target: 'Refunded to buyers', value: sum((p) => p.refunded) },
    { source: 'PACT escrow (PayPal authorization)', target: 'Voided (never charged)', value: sum((p) => p.voided) },
    { source: 'PACT escrow (PayPal authorization)', target: 'Still held', value: sum((p) => p.held) },
  ].filter((f) => f.value > 0);

  const terminalMs = milestones.filter((m) => ['released', 'partially_released', 'refunded'].includes(m.status));
  const audit = verifyAudit(ctx);
  return {
    asOf: ctx.now().toISOString(),
    paymentMode: ctx.gateway.mode,
    llmMode: ctx.llm.mode,
    totals: {
      held: sum((p) => p.held),
      released: sum((p) => p.released),
      refunded: sum((p) => p.refunded),
      voided: sum((p) => p.voided),
      pacts: pacts.length,
      activePacts: pacts.filter((p) => ['funded', 'in_progress', 'disputed'].includes(p.status)).length,
      disputeRate: milestones.length ? disputes.length / Math.max(1, terminalMs.length + disputes.filter((d) => d.status === 'open').length) : 0,
      refundRate: terminalMs.length ? terminalMs.filter((m) => m.status !== 'released').length / terminalMs.length : 0,
      verdicts: verdicts.length,
      refusedVerdicts: verdicts.filter((v) => v.refused).length,
    },
    audit: { ok: audit.ok, count: audit.count, headHash: audit.headHash, verifiedAt: audit.verifiedAt },
    pacts,
    milestones,
    verdicts,
    payments,
    reputation,
    flows,
  };
}

export type DashboardPayload = ReturnType<typeof buildDashboard>;
