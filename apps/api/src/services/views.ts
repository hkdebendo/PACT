// Builds API view models (PactView etc.) from database rows.
import type { Contract, EvidenceView, MilestoneView, PactView, PartyView, PaymentView, VerdictView } from '@pact/core';
import { asc, eq, tables } from '@pact/db';
import type { AppContext } from '../context';

type PactRow = typeof tables.pacts.$inferSelect;
type VerdictRow = typeof tables.verdicts.$inferSelect;
type EvidenceRow = typeof tables.evidence.$inferSelect;
type PaymentRow = typeof tables.payments.$inferSelect;

export const partyView = (p: typeof tables.parties.$inferSelect): PartyView => ({ id: p.id, name: p.name, kind: p.kind, email: p.email });

export function verdictView(v: VerdictRow): VerdictView {
  const payload = v.payloadJson ? JSON.parse(v.payloadJson) : null;
  return {
    id: v.id,
    pactId: v.pactId,
    milestoneId: v.milestoneId,
    kind: v.kind,
    status: v.status,
    confidence: v.confidence,
    reasoning: v.reasoning,
    verifier: v.kind === 'verifier' ? payload : null,
    arbiter: v.kind === 'arbiter' ? payload : null,
    precheckFailures: JSON.parse(v.precheckJson),
    evidenceIds: JSON.parse(v.evidenceIdsJson),
    model: v.model,
    llmMode: (v.llmMode as VerdictView['llmMode']) ?? null,
    appealStatus: v.appealStatus as VerdictView['appealStatus'],
    appealNote: v.appealNote,
    createdAt: v.createdAt,
  };
}

export const evidenceView = (e: EvidenceRow): EvidenceView => ({
  id: e.id,
  milestoneId: e.milestoneId,
  type: e.type as EvidenceView['type'],
  filename: e.filename,
  mime: e.mime,
  size: e.size,
  sha256: e.sha256,
  url: `/api/evidence/${e.id}/file`,
  note: e.note,
  description: e.descriptionJson ? JSON.parse(e.descriptionJson) : null,
  createdAt: e.createdAt,
});

export const paymentView = (p: PaymentRow): PaymentView => ({
  id: p.id,
  kind: p.kind as PaymentView['kind'],
  paypalId: p.paypalId,
  milestoneId: p.milestoneId,
  amountMinor: p.amountMinor,
  currency: p.currency,
  status: p.status,
  mode: p.mode as PaymentView['mode'],
  createdAt: p.createdAt,
});

/** Ledger totals from payment rows. */
export function ledger(payments: PaymentRow[]) {
  const sum = (kind: string, ok = (s: string) => s !== 'FAILED') =>
    payments.filter((p) => p.kind === kind && ok(p.status)).reduce((a, p) => a + p.amountMinor, 0);
  const authorized = payments
    .filter((p) => p.kind === 'authorization' || p.kind === 'reauthorization')
    .reduce((max, p) => Math.max(max, p.amountMinor), 0);
  const captured = sum('capture');
  const refunded = sum('refund');
  const voided = sum('void');
  const held = Math.max(0, authorized - captured - voided);
  return { authorized, captured, refunded, voided, held, released: captured - refunded };
}

export function getPactRow(ctx: AppContext, id: string): PactRow | undefined {
  return ctx.db.select().from(tables.pacts).where(eq(tables.pacts.id, id)).get();
}

export function buildPactView(ctx: AppContext, row: PactRow): PactView {
  const parties = ctx.db.select().from(tables.parties).all();
  const party = (id: string) => partyView(parties.find((p) => p.id === id)!);
  const ms = ctx.db.select().from(tables.milestones).where(eq(tables.milestones.pactId, row.id)).orderBy(asc(tables.milestones.position)).all();
  const ev = ctx.db.select().from(tables.evidence).where(eq(tables.evidence.pactId, row.id)).orderBy(asc(tables.evidence.createdAt)).all();
  const vd = ctx.db.select().from(tables.verdicts).where(eq(tables.verdicts.pactId, row.id)).orderBy(asc(tables.verdicts.createdAt)).all();
  const pay = ctx.db.select().from(tables.payments).where(eq(tables.payments.pactId, row.id)).orderBy(asc(tables.payments.createdAt)).all();
  const contract = JSON.parse(row.contractJson) as Contract;
  const l = ledger(pay);
  const milestones: MilestoneView[] = ms.map((m) => {
    const def = contract.milestones.find((x) => x.id === m.id)!;
    return {
      id: m.id,
      title: m.title,
      percent: m.percent,
      amountMinor: m.amountMinor,
      capturedMinor: m.capturedMinor,
      refundedMinor: m.refundedMinor,
      status: m.status as MilestoneView['status'],
      attempts: m.attempts,
      deadline: m.deadline,
      criteria: def.criteria,
      evidenceTypes: def.evidenceTypes,
      evidence: ev.filter((e) => e.milestoneId === m.id).map(evidenceView),
      verdicts: vd.filter((v) => v.milestoneId === m.id).map(verdictView),
      releasedAt: m.releasedAt,
    };
  });
  const auth = pay.filter((p) => p.kind === 'authorization' || p.kind === 'reauthorization').at(-1);
  return {
    id: row.id,
    status: row.status as PactView['status'],
    title: row.title,
    description: row.description,
    sourceText: row.sourceText,
    currency: row.currency,
    totalMinor: row.totalMinor,
    heldMinor: l.held,
    releasedMinor: l.released,
    refundedMinor: l.refunded,
    voidedMinor: l.voided,
    deadline: row.deadline,
    buyer: party(row.buyerId),
    seller: party(row.sellerId),
    contract,
    milestones,
    payments: pay.map(paymentView),
    paymentMode: row.paymentMode as PactView['paymentMode'],
    approvalUrl: row.approvalUrl,
    orderId: row.orderId,
    authorizationId: auth?.paypalId ?? row.authorizationId,
    authorizationExpiresAt: row.authorizationExpiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
