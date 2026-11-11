// PactService: the orchestration layer. Every state change goes through `transition()` (XState
// guards + audit), every money movement through the PaymentsGateway with a deterministic
// PayPal-Request-Id, and every AI decision is stored as a verdict and audit-logged.
import {
  applyPactEvent,
  InvalidTransitionError,
  splitByPercent,
  TERMINAL_MILESTONE,
  toMinor,
  validateContract,
  type Contract,
  type EvidenceType,
  type Milestone,
  type PactEvent,
  type PersistedPactState,
} from '@pact/core';
import { and, asc, desc, eq, ne, tables } from '@pact/db';
import { arbitrate, describeEvidence, judgeMilestone, LlmConfigError, LlmOutputError, LlmReplayMissError, runPrechecks } from '@pact/llm';
import { PayPalError } from '@pact/paypal';
import type { AppContext } from '../context';
import { newId } from '../context';
import { appendAudit } from './audit';
import { ServiceError } from './errors';
import { readEvidence, storeEvidence, EvidenceRejected } from './evidence-store';
import { buildPactView, getPactRow, ledger } from './views';
import { snapshotReputation } from './reputation';

type PactRow = typeof tables.pacts.$inferSelect;
type MilestoneRow = typeof tables.milestones.$inferSelect;

export interface PartyInput {
  name: string;
  kind?: 'human' | 'agent';
  email?: string | null;
}

const DAY = 24 * 3600 * 1000;

export class PactService {
  /** One in-flight confirmation per pact: the reconciliation poller, webhooks and the buyer can race. */
  private readonly confirming = new Map<string, Promise<{ funded: boolean; status: string; authorizationId?: string; approvalUrl?: string | null }>>();

  constructor(private readonly ctx: AppContext) {}

  private now() {
    return this.ctx.now().toISOString();
  }

  private audit(pactId: string | null, actor: string, type: string, data: unknown) {
    return appendAudit(this.ctx, { pactId, actor, type, data });
  }

  // --- parties -----------------------------------------------------------------------------

  ensureParty(p: PartyInput) {
    const kind = p.kind ?? 'human';
    // One party per name: the same seller is the same reputation whether it acts through an agent
    // or the web UI (the kind records how it last acted).
    const existing = this.ctx.db.select().from(tables.parties).where(eq(tables.parties.name, p.name)).get();
    if (existing) {
      if (p.kind && existing.kind !== p.kind) {
        this.ctx.db.update(tables.parties).set({ kind: p.kind }).where(eq(tables.parties.id, existing.id)).run();
        return { ...existing, kind: p.kind };
      }
      return existing;
    }
    const row = { id: newId('party'), name: p.name, kind, email: p.email ?? null, createdAt: this.now() };
    this.ctx.db.insert(tables.parties).values(row).run();
    return row;
  }

  // --- loading -----------------------------------------------------------------------------

  row(id: string): PactRow {
    const r = getPactRow(this.ctx, id);
    if (!r) throw new ServiceError('PACT_NOT_FOUND', `Pact ${id} not found`, 404);
    return r;
  }

  view(id: string) {
    return buildPactView(this.ctx, this.row(id));
  }

  list(opts: { status?: string; partyId?: string } = {}) {
    let rows = this.ctx.db.select().from(tables.pacts).orderBy(desc(tables.pacts.createdAt)).all();
    if (opts.status) rows = rows.filter((r) => r.status === opts.status);
    if (opts.partyId) rows = rows.filter((r) => r.buyerId === opts.partyId || r.sellerId === opts.partyId);
    return rows.map((r) => buildPactView(this.ctx, r));
  }

  private milestoneRow(pactId: string, milestoneId: string): MilestoneRow {
    const m = this.ctx.db
      .select()
      .from(tables.milestones)
      .where(and(eq(tables.milestones.pactId, pactId), eq(tables.milestones.id, milestoneId)))
      .get();
    if (!m) throw new ServiceError('MILESTONE_NOT_FOUND', `Milestone ${milestoneId} not found in pact ${pactId}`, 404);
    return m;
  }

  private contractOf(row: PactRow): Contract {
    return JSON.parse(row.contractJson) as Contract;
  }

  private milestoneDef(row: PactRow, milestoneId: string): Milestone {
    const m = this.contractOf(row).milestones.find((x) => x.id === milestoneId);
    if (!m) throw new ServiceError('MILESTONE_NOT_FOUND', `Milestone ${milestoneId} not found`, 404);
    return m;
  }

  // --- state machine -----------------------------------------------------------------------

  /** Applies one machine event, persists the result, audit-logs it. Invalid → 409 + audit. */
  transition(pactId: string, event: PactEvent, actor: string, data: Record<string, unknown> = {}): PersistedPactState {
    const row = this.row(pactId);
    const from = JSON.parse(row.machineJson) as PersistedPactState;
    let next: PersistedPactState;
    try {
      next = applyPactEvent(from, event);
    } catch (e) {
      if (e instanceof InvalidTransitionError) {
        this.audit(pactId, actor, 'transition.rejected', { event, status: from.status, reason: e.message });
        throw new ServiceError('INVALID_TRANSITION', e.message, 409, { event, status: from.status });
      }
      throw e;
    }
    const at = this.now();
    this.ctx.db.$client.transaction(() => {
      this.ctx.db
        .update(tables.pacts)
        .set({ status: next.status, machineJson: JSON.stringify(next), updatedAt: at })
        .where(eq(tables.pacts.id, pactId))
        .run();
      for (const id of next.context.order) {
        const m = next.context.milestones[id];
        this.ctx.db
          .update(tables.milestones)
          .set({ status: m.status, attempts: m.attempts })
          .where(and(eq(tables.milestones.pactId, pactId), eq(tables.milestones.id, id)))
          .run();
      }
    })();
    const changed = next.context.order.filter((id) => next.context.milestones[id].status !== from.context.milestones[id]?.status);
    this.audit(pactId, actor, 'pact.transition', {
      event,
      from: from.status,
      to: next.status,
      milestones: Object.fromEntries(changed.map((id) => [id, { from: from.context.milestones[id].status, to: next.context.milestones[id].status }])),
      ...data,
    });
    this.ctx.bus.publish({ type: 'pact.updated', pactId, status: next.status, at });
    return next;
  }

  // --- create / propose / accept -----------------------------------------------------------

  create(input: { contract: Contract; sourceText?: string | null; buyer: PartyInput; seller: PartyInput; actor: string }) {
    const problems = validateContract(input.contract);
    if (problems.length) throw new ServiceError('INVALID_CONTRACT', problems.join(' '), 422, { problems });
    const c = input.contract;
    const buyer = this.ensureParty({ ...input.buyer, email: input.buyer.email ?? c.buyer.email });
    const seller = this.ensureParty({ ...input.seller, email: input.seller.email ?? c.seller.email });
    if (buyer.id === seller.id) throw new ServiceError('SAME_PARTY', 'Buyer and seller must be different parties', 422);
    const id = newId('pact');
    const at = this.now();
    const totalMinor = toMinor(c.totalAmount);
    const amounts = splitByPercent(totalMinor, c.milestones.map((m) => m.percent));
    const machine: PersistedPactState = {
      status: 'draft',
      context: {
        order: c.milestones.map((m) => m.id),
        milestones: Object.fromEntries(c.milestones.map((m) => [m.id, { status: 'pending', attempts: 0, wasReleased: false }])),
        sellerAccepted: false,
      },
    };
    this.ctx.db.$client.transaction(() => {
      this.ctx.db
        .insert(tables.pacts)
        .values({
          id,
          status: 'draft',
          title: c.title,
          description: c.description,
          sourceText: input.sourceText ?? null,
          currency: c.currency,
          totalMinor,
          deadline: c.deadline,
          buyerId: buyer.id,
          sellerId: seller.id,
          contractJson: JSON.stringify(c),
          machineJson: JSON.stringify(machine),
          paymentMode: this.ctx.gateway.mode,
          createdAt: at,
          updatedAt: at,
        })
        .run();
      c.milestones.forEach((m, i) =>
        this.ctx.db
          .insert(tables.milestones)
          .values({
            pactId: id,
            id: m.id,
            position: i,
            title: m.title,
            percent: m.percent,
            amountMinor: amounts[i],
            deadline: m.deadline ?? c.deadline,
            status: 'pending',
          })
          .run(),
      );
    })();
    this.audit(id, input.actor, 'pact.created', { contract: c, totalMinor, buyerId: buyer.id, sellerId: seller.id, paymentMode: this.ctx.gateway.mode });
    this.ctx.bus.publish({ type: 'pact.updated', pactId: id, status: 'draft', at });
    return this.view(id);
  }

  propose(pactId: string, actor: string) {
    this.transition(pactId, { type: 'PROPOSE' }, actor);
    return this.view(pactId);
  }

  accept(pactId: string, actor: string) {
    this.transition(pactId, { type: 'ACCEPT' }, actor);
    return this.view(pactId);
  }

  // --- funding (Orders v2, intent AUTHORIZE) -----------------------------------------------

  private async paypal<T>(pactId: string, actor: string, operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof PayPalError) {
        this.audit(pactId, actor, 'paypal.error', e.toJSON());
        throw new ServiceError('PAYPAL_ERROR', e.message, e.status >= 500 || e.status === 0 ? 502 : 422, e.toJSON());
      }
      throw e;
    }
  }

  private recordPayment(p: Omit<typeof tables.payments.$inferInsert, 'id' | 'createdAt' | 'updatedAt' | 'mode'>) {
    const at = this.now();
    const row = { ...p, id: newId('pay'), mode: this.ctx.gateway.mode, createdAt: at, updatedAt: at };
    this.ctx.db.insert(tables.payments).values(row).run();
    this.ctx.bus.publish({ type: 'payment.updated', pactId: p.pactId, kind: p.kind, amountMinor: p.amountMinor, at });
    return row;
  }

  async fund(pactId: string, actor: string) {
    const row = this.row(pactId);
    if (row.orderId && row.status === 'proposed') {
      return { orderId: row.orderId, approvalUrl: row.approvalUrl, status: 'CREATED', paymentMode: row.paymentMode, reused: true };
    }
    const state = JSON.parse(row.machineJson) as PersistedPactState;
    if (row.status !== 'proposed' || !state.context.sellerAccepted)
      throw new ServiceError('NOT_FUNDABLE', `Pact must be proposed and accepted by the seller before funding (status ${row.status}, accepted ${state.context.sellerAccepted})`, 409);
    const base = this.ctx.config.app.baseUrl;
    const order = await this.paypal(pactId, actor, 'orders.create', () =>
      this.ctx.gateway.createAuthorizeOrder({
        pactId,
        description: `PACT escrow: ${row.title}`,
        amount: { minor: row.totalMinor, currency: row.currency },
        returnUrl: `${base}/pacts/${pactId}?paypal=approved`,
        cancelUrl: `${base}/pacts/${pactId}?paypal=cancelled`,
        requestId: `pact-${pactId}-order`,
      }),
    );
    this.recordPayment({ pactId, kind: 'order', paypalId: order.orderId, amountMinor: row.totalMinor, currency: row.currency, status: order.status, requestId: `pact-${pactId}-order`, rawJson: JSON.stringify(order.raw) });
    this.ctx.db.update(tables.pacts).set({ orderId: order.orderId, approvalUrl: order.approvalUrl, updatedAt: this.now() }).where(eq(tables.pacts.id, pactId)).run();
    this.audit(pactId, actor, 'paypal.order.created', { orderId: order.orderId, intent: 'AUTHORIZE', amountMinor: row.totalMinor, mode: this.ctx.gateway.mode });
    return { orderId: order.orderId, approvalUrl: order.approvalUrl, status: order.status, paymentMode: this.ctx.gateway.mode, reused: false };
  }

  /** After buyer approval: authorize the order (funds held, not charged). Safe to call repeatedly. */
  confirmFunding(pactId: string, actor: string) {
    const running = this.confirming.get(pactId);
    if (running) return running;
    const p = this.confirmFundingOnce(pactId, actor).finally(() => this.confirming.delete(pactId));
    this.confirming.set(pactId, p);
    return p;
  }

  private async confirmFundingOnce(pactId: string, actor: string): Promise<{ funded: boolean; status: string; authorizationId?: string; approvalUrl?: string | null }> {
    const row = this.row(pactId);
    if (row.authorizationId) return { funded: true, status: row.status, authorizationId: row.authorizationId };
    if (!row.orderId) throw new ServiceError('NO_ORDER', 'Call fund first to create the PayPal order', 409);
    const order = await this.paypal(pactId, actor, 'orders.get', () => this.ctx.gateway.getOrder(row.orderId!));
    if (order.status !== 'APPROVED' && order.status !== 'COMPLETED') return { funded: false, status: order.status, approvalUrl: row.approvalUrl };
    const auth = await this.paypal(pactId, actor, 'orders.authorize', () => this.ctx.gateway.authorizeOrder(row.orderId!, `pact-${pactId}-authorize`));
    const now = this.ctx.now();
    const honorEnds = new Date(now.getTime() + 3 * DAY).toISOString();
    this.recordPayment({ pactId, kind: 'authorization', paypalId: auth.authorizationId, parentPaypalId: row.orderId, amountMinor: auth.amount.minor, currency: auth.amount.currency, status: auth.status, requestId: `pact-${pactId}-authorize`, rawJson: JSON.stringify(auth.raw) });
    this.ctx.db
      .update(tables.pacts)
      .set({ authorizationId: auth.authorizationId, authorizationExpiresAt: auth.expiresAt, honorPeriodEndsAt: honorEnds, approvalUrl: null, updatedAt: this.now() })
      .where(eq(tables.pacts.id, pactId))
      .run();
    this.audit(pactId, actor, 'paypal.authorization.created', { authorizationId: auth.authorizationId, amountMinor: auth.amount.minor, expiresAt: auth.expiresAt, honorPeriodEndsAt: honorEnds });
    this.transition(pactId, { type: 'FUNDED' }, actor, { authorizationId: auth.authorizationId });
    // Jobs: reauthorize once the 3-day honor period ends (if work is still open), expire at day 29.
    enqueueJob(this.ctx, 'reauthorize', { pactId }, new Date(new Date(honorEnds).getTime() + 3600_000), `reauth:${pactId}:${auth.authorizationId}`);
    if (auth.expiresAt) enqueueJob(this.ctx, 'expire', { pactId }, new Date(auth.expiresAt), `expire:${pactId}`);
    return { funded: true, status: 'funded', authorizationId: auth.authorizationId };
  }

  /** SIMULATED checkout approval (simulated mode only). */
  approveSimulated(pactId: string, actor: string) {
    const row = this.row(pactId);
    if (!this.ctx.simulated || row.paymentMode !== 'simulated') throw new ServiceError('NOT_SIMULATED', 'Only simulated pacts can be approved without PayPal', 409);
    if (!row.orderId) throw new ServiceError('NO_ORDER', 'No order to approve', 409);
    this.ctx.simulated.approveOrder(row.orderId);
    this.audit(pactId, actor, 'paypal.order.approved', { orderId: row.orderId, simulated: true });
  }

  private authorizationId(row: PactRow): string {
    const auths = this.ctx.db
      .select()
      .from(tables.payments)
      .where(eq(tables.payments.pactId, row.id))
      .all()
      .filter((p) => p.kind === 'authorization' || p.kind === 'reauthorization');
    const id = auths.at(-1)?.paypalId ?? row.authorizationId;
    if (!id) throw new ServiceError('NOT_FUNDED', 'Pact has no PayPal authorization', 409);
    return id;
  }

  /** PayPal voids only the original authorization (which also voids its reauthorization). */
  private voidableAuthorizationId(row: PactRow): string {
    const original = this.ctx.db
      .select()
      .from(tables.payments)
      .where(eq(tables.payments.pactId, row.id))
      .all()
      .find((p) => p.kind === 'authorization');
    const id = original?.paypalId ?? row.authorizationId;
    if (!id) throw new ServiceError('NOT_FUNDED', 'Pact has no PayPal authorization', 409);
    return id;
  }

  // --- evidence ---------------------------------------------------------------------------

  async submitEvidence(
    pactId: string,
    milestoneId: string,
    file: { filename: string; bytes: Buffer; type: EvidenceType; note?: string | null },
    actor: string,
  ) {
    const row = this.row(pactId);
    const m = this.milestoneRow(pactId, milestoneId);
    let stored;
    try {
      stored = storeEvidence(this.ctx.evidenceDir, file.filename, file.bytes);
    } catch (e) {
      if (e instanceof EvidenceRejected) {
        this.audit(pactId, actor, 'evidence.rejected', { milestoneId, reason: e.message, filename: file.filename });
        throw new ServiceError('EVIDENCE_REJECTED', e.message, 422);
      }
      throw e;
    }
    // Adding more files to an attempt that is still awaiting verification needs no transition.
    if (m.status !== 'evidence_submitted') this.transition(pactId, { type: 'SUBMIT_EVIDENCE', milestoneId }, actor);
    const ev = {
      id: newId('ev'),
      pactId: row.id,
      milestoneId,
      type: file.type,
      filename: stored.filename,
      mime: stored.mime,
      size: stored.size,
      sha256: stored.sha256,
      path: stored.path,
      note: file.note ?? null,
      submittedBy: actor,
      createdAt: this.now(),
    };
    this.ctx.db.insert(tables.evidence).values(ev).run();
    this.audit(pactId, actor, 'evidence.submitted', { milestoneId, evidenceId: ev.id, type: ev.type, sha256: ev.sha256, mime: ev.mime, size: ev.size });
    return ev;
  }

  /** Evidence of the current attempt: everything submitted after the latest verdict on the milestone. */
  private currentEvidence(pactId: string, milestoneId: string) {
    const last = this.ctx.db
      .select()
      .from(tables.verdicts)
      .where(and(eq(tables.verdicts.pactId, pactId), eq(tables.verdicts.milestoneId, milestoneId), eq(tables.verdicts.kind, 'verifier')))
      .orderBy(desc(tables.verdicts.createdAt))
      .get();
    return this.ctx.db
      .select()
      .from(tables.evidence)
      .where(and(eq(tables.evidence.pactId, pactId), eq(tables.evidence.milestoneId, milestoneId)))
      .orderBy(asc(tables.evidence.createdAt))
      .all()
      .filter((e) => !last || e.createdAt > last.createdAt);
  }

  private aiError(pactId: string, actor: string, role: string, e: unknown): never {
    if (e instanceof LlmReplayMissError || e instanceof LlmConfigError) {
      this.audit(pactId, actor, 'ai.unavailable', { role, reason: e.message });
      throw new ServiceError('AI_UNAVAILABLE', e.message, 503);
    }
    if (e instanceof LlmOutputError) {
      this.audit(pactId, actor, 'ai.invalid_output', { role, reason: e.message });
      throw new ServiceError('AI_INVALID_OUTPUT', e.message, 502);
    }
    throw e;
  }

  // --- verification (two-step Verifier) ----------------------------------------------------

  async verifyMilestone(pactId: string, milestoneId: string, actor: string, opts: { autoRelease?: boolean } = {}) {
    const row = this.row(pactId);
    const m = this.milestoneRow(pactId, milestoneId);
    if (m.status !== 'evidence_submitted')
      throw new ServiceError('NOTHING_TO_VERIFY', `Milestone ${milestoneId} is ${m.status}; submit evidence first`, 409);
    const def = this.milestoneDef(row, milestoneId);
    const contract = this.contractOf(row);
    const evidence = this.currentEvidence(pactId, milestoneId);

    // Deterministic pre-checks first (no tokens spent when they fail).
    const reusedIn: Record<string, string[]> = {};
    for (const e of evidence) {
      const others = this.ctx.db.select().from(tables.evidence).where(and(eq(tables.evidence.sha256, e.sha256), ne(tables.evidence.pactId, pactId))).all();
      if (others.length) reusedIn[e.sha256] = [...new Set(others.map((o) => o.pactId))];
    }
    const precheckFailures = runPrechecks(
      evidence.map((e) => ({ id: e.id, type: e.type as EvidenceType, mime: e.mime, size: e.size, sha256: e.sha256, createdAt: e.createdAt })),
      { milestone: def, milestoneDeadline: m.deadline, reusedIn, now: this.ctx.now() },
    );
    this.audit(pactId, 'system:prechecks', 'verifier.prechecks', { milestoneId, evidenceIds: evidence.map((e) => e.id), failures: precheckFailures });

    let verdictPayload: Record<string, unknown>;
    let status: 'approved' | 'rejected' | 'needs_more';
    let confidence: number;
    let reasoning: string;
    let model: string | null = null;
    let mode: string | null = null;

    if (precheckFailures.length) {
      status = 'rejected';
      confidence = 1;
      reasoning = `Rejected by deterministic pre-checks before any AI review: ${precheckFailures.join(' ')}`;
      verdictPayload = { status, confidence, criteria: [], reasoning, missing: [], policyNotes: ['pre-check failure'] };
    } else {
      // Step 1: describe each piece of evidence without the criteria.
      const descriptions = [];
      for (const e of evidence) {
        let description = e.descriptionJson ? JSON.parse(e.descriptionJson) : null;
        if (!description) {
          try {
            const r = await describeEvidence(
              this.ctx.llm,
              { id: e.id, type: e.type, mime: e.mime, filename: e.filename, sha256: e.sha256, bytes: readEvidence(e.path), note: e.note },
              pactId,
            );
            description = r.value;
            this.ctx.db.update(tables.evidence).set({ descriptionJson: JSON.stringify(description) }).where(eq(tables.evidence.id, e.id)).run();
            this.audit(pactId, 'ai:verifier', 'ai.evidence.described', { evidenceId: e.id, model: r.model, mode: r.mode, cacheKey: r.cacheKey, description });
          } catch (err) {
            this.aiError(pactId, actor, 'verifier.describe', err);
          }
        }
        descriptions.push({ evidenceId: e.id, type: e.type, description });
      }
      // Step 2: judge against the criteria.
      try {
        const r = await judgeMilestone(this.ctx.llm, { contract, milestone: def, descriptions, precheckFailures, pactId });
        verdictPayload = r.value;
        status = r.value.status;
        confidence = r.value.confidence;
        reasoning = r.value.reasoning + (r.value.policyNotes.length ? ` [Policy: ${r.value.policyNotes.join(' ')}]` : '');
        model = r.model;
        mode = r.mode;
      } catch (err) {
        this.aiError(pactId, actor, 'verifier.judge', err);
      }
    }

    const verdict = {
      id: newId('vd'),
      pactId,
      milestoneId,
      kind: 'verifier' as const,
      status,
      confidence,
      reasoning,
      payloadJson: JSON.stringify(verdictPayload),
      precheckJson: JSON.stringify(precheckFailures),
      evidenceIdsJson: JSON.stringify(evidence.map((e) => e.id)),
      model,
      llmMode: mode,
      createdAt: this.now(),
    };
    this.ctx.db.insert(tables.verdicts).values(verdict).run();
    this.audit(pactId, 'ai:verifier', 'ai.verdict', { verdictId: verdict.id, milestoneId, status, confidence, model, mode, evidenceIds: evidence.map((e) => e.id), verdict: verdictPayload });
    this.ctx.bus.publish({ type: 'verdict.created', pactId, milestoneId, verdictId: verdict.id, status, at: verdict.createdAt });
    this.transition(pactId, { type: 'VERDICT', milestoneId, status }, 'ai:verifier', { verdictId: verdict.id });

    let release = null;
    if (status === 'approved' && opts.autoRelease !== false) release = await this.releaseMilestone(pactId, milestoneId, 'system:auto-release');
    return { verdict: this.verdictById(verdict.id), release, pact: this.view(pactId) };
  }

  verdictById(id: string) {
    const v = this.ctx.db.select().from(tables.verdicts).where(eq(tables.verdicts.id, id)).get();
    if (!v) throw new ServiceError('VERDICT_NOT_FOUND', `Verdict ${id} not found`, 404);
    return buildPactView(this.ctx, this.row(v.pactId)).milestones.find((m) => m.id === v.milestoneId)!.verdicts.find((x) => x.id === id)!;
  }

  // --- release (partial / final capture) ---------------------------------------------------

  private othersTerminal(pactId: string, milestoneId: string) {
    const state = JSON.parse(this.row(pactId).machineJson) as PersistedPactState;
    return state.context.order.filter((id) => id !== milestoneId).every((id) => TERMINAL_MILESTONE.includes(state.context.milestones[id].status));
  }

  private async capture(row: PactRow, m: MilestoneRow, amountMinor: number, actor: string, tag: string) {
    const authorizationId = this.authorizationId(row);
    const finalCapture = this.othersTerminal(row.id, m.id);
    const requestId = `pact-${row.id}-cap-${m.id}-${tag}`;
    const cap = await this.paypal(row.id, actor, 'authorizations.capture', () =>
      this.ctx.gateway.captureAuthorization(authorizationId, {
        amount: { minor: amountMinor, currency: row.currency },
        finalCapture,
        invoiceId: `${row.id}-${m.id}-${tag}`.slice(0, 127),
        noteToPayer: `PACT milestone "${m.title}" released`,
        requestId,
      }),
    );
    this.recordPayment({ pactId: row.id, milestoneId: m.id, kind: 'capture', paypalId: cap.captureId, parentPaypalId: authorizationId, amountMinor, currency: row.currency, status: cap.status, requestId, rawJson: JSON.stringify(cap.raw) });
    this.ctx.db
      .update(tables.milestones)
      .set({ capturedMinor: m.capturedMinor + amountMinor, releasedAt: this.now() })
      .where(and(eq(tables.milestones.pactId, row.id), eq(tables.milestones.id, m.id)))
      .run();
    this.audit(row.id, actor, 'paypal.capture', { milestoneId: m.id, captureId: cap.captureId, authorizationId, amountMinor, finalCapture, status: cap.status });
    return { ...cap, finalCapture };
  }

  async releaseMilestone(pactId: string, milestoneId: string, actor: string) {
    const row = this.row(pactId);
    const m = this.milestoneRow(pactId, milestoneId);
    if (m.status !== 'approved') {
      // Let the machine produce (and audit) the precise refusal.
      this.transition(pactId, { type: 'RELEASE', milestoneId }, actor);
    }
    const cap = await this.capture(row, m, m.amountMinor, actor, 'release');
    this.transition(pactId, { type: 'RELEASE', milestoneId }, actor, { captureId: cap.captureId });
    const payouts = await this.payoutSubcontractors(pactId, milestoneId, m.amountMinor, actor);
    await this.settleIfDone(pactId, actor, cap.finalCapture);
    if (this.row(pactId).status === 'completed') snapshotReputation(this.ctx, row.sellerId);
    return { captureId: cap.captureId, amountMinor: m.amountMinor, finalCapture: cap.finalCapture, payouts };
  }

  // --- payouts to subcontractors -----------------------------------------------------------

  private async payoutSubcontractors(pactId: string, milestoneId: string, releasedMinor: number, actor: string) {
    const row = this.row(pactId);
    const subs = this.contractOf(row).subcontractors.filter((s) => s.milestoneId === milestoneId && s.email);
    if (!subs.length) return null;
    const batchId = `pact-${pactId}-payout-${milestoneId}`;
    const items = subs.map((s, i) => ({
      receiverEmail: s.email!,
      amount: { minor: Math.floor((releasedMinor * s.percentOfMilestone) / 100), currency: row.currency },
      note: `PACT payout for "${row.title}" milestone ${milestoneId}`,
      senderItemId: `${milestoneId}-${i}`,
    }));
    const p = await this.paypal(pactId, actor, 'payouts.create', () => this.ctx.gateway.createPayout(batchId, items, 'You have a payout from a PACT escrow'));
    for (const it of items)
      this.recordPayment({ pactId, milestoneId, kind: 'payout', paypalId: p.batchId, amountMinor: it.amount.minor, currency: row.currency, status: p.status, requestId: batchId, rawJson: JSON.stringify({ receiver: it.receiverEmail }) });
    this.audit(pactId, actor, 'paypal.payout', { milestoneId, batchId: p.batchId, status: p.status, items: items.map((i) => ({ receiver: i.receiverEmail, amountMinor: i.amount.minor })) });
    return { batchId: p.batchId, status: p.status, count: items.length };
  }

  // --- settlement: void what can no longer be captured --------------------------------------

  private async settleIfDone(pactId: string, actor: string, lastWasFinal = false) {
    const row = this.row(pactId);
    if (!['completed', 'cancelled', 'expired'].includes(row.status)) return;
    const pays = this.ctx.db.select().from(tables.payments).where(eq(tables.payments.pactId, pactId)).all();
    const l = ledger(pays);
    if (l.held <= 0) return;
    if (lastWasFinal) {
      // A final capture makes PayPal void the remaining authorization automatically.
      this.recordPayment({ pactId, kind: 'void', paypalId: this.authorizationId(row), amountMinor: l.held, currency: row.currency, status: 'AUTO_VOIDED_BY_FINAL_CAPTURE' });
      this.audit(pactId, actor, 'paypal.authorization.remainder_released', { amountMinor: l.held, reason: 'final_capture' });
      return;
    }
    const authorizationId = this.voidableAuthorizationId(row);
    const auth = await this.paypal(pactId, actor, 'authorizations.void', () => this.ctx.gateway.voidAuthorization(authorizationId, `pact-${pactId}-void`));
    this.recordPayment({ pactId, kind: 'void', paypalId: authorizationId, amountMinor: l.held, currency: row.currency, status: auth.status, requestId: `pact-${pactId}-void`, rawJson: JSON.stringify(auth.raw) });
    this.audit(pactId, actor, 'paypal.authorization.voided', { authorizationId, amountMinor: l.held, status: auth.status });
  }

  async cancel(pactId: string, actor: string, reason: string) {
    const row = this.row(pactId);
    this.transition(pactId, { type: 'CANCEL' }, actor, { reason });
    if (row.authorizationId) await this.settleIfDone(pactId, actor);
    snapshotReputation(this.ctx, row.sellerId);
    return this.view(pactId);
  }

  // --- disputes & Arbiter ------------------------------------------------------------------

  openDispute(pactId: string, milestoneId: string, party: 'buyer' | 'seller', statement: string, actor: string) {
    this.transition(pactId, { type: 'OPEN_DISPUTE', milestoneId }, actor, { party });
    const d = {
      id: newId('dsp'),
      pactId,
      milestoneId,
      openedBy: party,
      buyerStatement: party === 'buyer' ? statement : null,
      sellerStatement: party === 'seller' ? statement : null,
      status: 'open',
      createdAt: this.now(),
    };
    this.ctx.db.insert(tables.disputes).values(d).run();
    this.audit(pactId, actor, 'dispute.opened', { disputeId: d.id, milestoneId, party, statement });
    return d;
  }

  addStatement(pactId: string, milestoneId: string, party: 'buyer' | 'seller', statement: string, actor: string) {
    const d = this.openDisputeRow(pactId, milestoneId);
    this.ctx.db
      .update(tables.disputes)
      .set(party === 'buyer' ? { buyerStatement: statement } : { sellerStatement: statement })
      .where(eq(tables.disputes.id, d.id))
      .run();
    this.audit(pactId, actor, 'dispute.statement', { disputeId: d.id, party, statement });
    return { ...d, ...(party === 'buyer' ? { buyerStatement: statement } : { sellerStatement: statement }) };
  }

  private openDisputeRow(pactId: string, milestoneId: string) {
    const d = this.ctx.db
      .select()
      .from(tables.disputes)
      .where(and(eq(tables.disputes.pactId, pactId), eq(tables.disputes.milestoneId, milestoneId), eq(tables.disputes.status, 'open')))
      .get();
    if (!d) throw new ServiceError('NO_OPEN_DISPUTE', `No open dispute on milestone ${milestoneId}`, 409);
    return d;
  }

  async arbitrate(pactId: string, milestoneId: string, actor: string) {
    const row = this.row(pactId);
    const d = this.openDisputeRow(pactId, milestoneId);
    const def = this.milestoneDef(row, milestoneId);
    const view = this.view(pactId);
    const mv = view.milestones.find((m) => m.id === milestoneId)!;
    let r;
    try {
      r = await arbitrate(this.ctx.llm, {
        contract: view.contract,
        milestone: def,
        evidence: mv.evidence.map((e) => ({ evidenceId: e.id, type: e.type, description: e.description, note: e.note })),
        verifierHistory: mv.verdicts.filter((v) => v.kind === 'verifier').map((v) => ({ status: v.status, confidence: v.confidence, reasoning: v.reasoning, at: v.createdAt })),
        buyerStatement: d.buyerStatement,
        sellerStatement: d.sellerStatement,
        pactId,
      });
    } catch (e) {
      this.aiError(pactId, actor, 'arbiter', e);
    }
    const decision = r.value;
    const verdict = {
      id: newId('vd'),
      pactId,
      milestoneId,
      kind: 'arbiter' as const,
      status: decision.decision,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      payloadJson: JSON.stringify(decision),
      evidenceIdsJson: JSON.stringify(decision.citedEvidence.map((c) => c.evidenceId)),
      model: r.model,
      llmMode: r.mode,
      createdAt: this.now(),
    };
    this.ctx.db.insert(tables.verdicts).values(verdict).run();
    this.audit(pactId, 'ai:arbiter', 'ai.arbiter.decision', { verdictId: verdict.id, disputeId: d.id, milestoneId, model: r.model, mode: r.mode, decision });
    this.ctx.bus.publish({ type: 'verdict.created', pactId, milestoneId, verdictId: verdict.id, status: decision.decision, at: verdict.createdAt });
    const money = await this.executeResolution(pactId, milestoneId, decision.decision, decision.releasePercent, 'ai:arbiter');
    this.ctx.db.update(tables.disputes).set({ status: 'resolved', verdictId: verdict.id, resolvedAt: this.now() }).where(eq(tables.disputes.id, d.id)).run();
    return { verdict: this.verdictById(verdict.id), money, pact: this.view(pactId) };
  }

  /** Moves the money for a dispute outcome, then applies RESOLVE. */
  private async executeResolution(pactId: string, milestoneId: string, outcome: 'release' | 'partial' | 'refund', releasePercent: number, actor: string) {
    const row = this.row(pactId);
    const m = this.milestoneRow(pactId, milestoneId);
    const result: Record<string, unknown> = { outcome, releasePercent };
    let finalCapture = false;
    if (m.capturedMinor > 0) {
      // Funds already captured: give back the buyer's share as a refund on the capture(s).
      const refundMinor = outcome === 'release' ? 0 : outcome === 'refund' ? m.capturedMinor - m.refundedMinor : Math.round(((m.capturedMinor - m.refundedMinor) * (100 - releasePercent)) / 100);
      if (refundMinor > 0) {
        const capRow = this.ctx.db
          .select()
          .from(tables.payments)
          .where(and(eq(tables.payments.pactId, pactId), eq(tables.payments.milestoneId, milestoneId), eq(tables.payments.kind, 'capture')))
          .orderBy(desc(tables.payments.createdAt))
          .get()!;
        const requestId = `pact-${pactId}-refund-${milestoneId}`;
        const ref = await this.paypal(pactId, actor, 'captures.refund', () =>
          this.ctx.gateway.refundCapture(capRow.paypalId!, { minor: refundMinor, currency: row.currency }, `PACT dispute resolution: ${outcome}`, requestId),
        );
        this.recordPayment({ pactId, milestoneId, kind: 'refund', paypalId: ref.refundId, parentPaypalId: capRow.paypalId, amountMinor: refundMinor, currency: row.currency, status: ref.status, requestId, rawJson: JSON.stringify(ref.raw) });
        this.ctx.db.update(tables.milestones).set({ refundedMinor: m.refundedMinor + refundMinor }).where(and(eq(tables.milestones.pactId, pactId), eq(tables.milestones.id, milestoneId))).run();
        this.audit(pactId, actor, 'paypal.refund', { milestoneId, refundId: ref.refundId, captureId: capRow.paypalId, amountMinor: refundMinor });
        result.refundId = ref.refundId;
        result.refundedMinor = refundMinor;
      }
    } else {
      // Nothing captured yet: capture the seller's share; the rest stays uncaptured and is voided at settlement.
      const captureMinor = outcome === 'refund' ? 0 : outcome === 'release' ? m.amountMinor : Math.round((m.amountMinor * releasePercent) / 100);
      if (captureMinor > 0) {
        const cap = await this.capture(row, m, captureMinor, actor, `resolve-${outcome}`);
        finalCapture = cap.finalCapture;
        result.captureId = cap.captureId;
        result.capturedMinor = captureMinor;
      }
    }
    this.transition(pactId, { type: 'RESOLVE', milestoneId, outcome }, actor, result);
    await this.settleIfDone(pactId, actor, finalCapture && this.othersTerminal(pactId, milestoneId));
    snapshotReputation(this.ctx, row.sellerId);
    return result;
  }

  // --- appeals (human in the loop) ---------------------------------------------------------

  appeal(verdictId: string, party: 'buyer' | 'seller', note: string, actor: string) {
    const v = this.ctx.db.select().from(tables.verdicts).where(eq(tables.verdicts.id, verdictId)).get();
    if (!v) throw new ServiceError('VERDICT_NOT_FOUND', `Verdict ${verdictId} not found`, 404);
    if (v.appealStatus !== 'none') throw new ServiceError('ALREADY_APPEALED', 'This decision was already appealed', 409);
    this.ctx.db.update(tables.verdicts).set({ appealStatus: 'requested', appealNote: `${party}: ${note}` }).where(eq(tables.verdicts.id, verdictId)).run();
    this.audit(v.pactId, actor, 'appeal.requested', { verdictId, party, note });
    this.ctx.bus.publish({ type: 'verdict.created', pactId: v.pactId, milestoneId: v.milestoneId, verdictId, status: v.status, at: this.now() });
    return this.verdictById(verdictId);
  }

  /**
   * A human reviewer decides an appeal. Overturning a Verifier rejection opens a dispute resolved by
   * the human (money moves accordingly). Overturning an Arbiter decision is recorded and audit-logged;
   * the compensating payment is listed as a manual action (see docs/ARCHITECTURE.md, limitations).
   */
  async reviewAppeal(verdictId: string, reviewer: string, outcome: 'upheld' | 'overturned', note: string, decision?: { outcome: 'release' | 'partial' | 'refund'; releasePercent?: number }) {
    const v = this.ctx.db.select().from(tables.verdicts).where(eq(tables.verdicts.id, verdictId)).get();
    if (!v) throw new ServiceError('VERDICT_NOT_FOUND', `Verdict ${verdictId} not found`, 404);
    if (v.appealStatus !== 'requested') throw new ServiceError('NO_APPEAL', 'No pending appeal on this decision', 409);
    const actor = `human:${reviewer}`;
    this.ctx.db.update(tables.verdicts).set({ appealStatus: outcome, appealNote: `${v.appealNote ?? ''} | reviewer ${reviewer}: ${note}` }).where(eq(tables.verdicts.id, verdictId)).run();
    this.audit(v.pactId, actor, `appeal.${outcome}`, { verdictId, note, decision: decision ?? null });
    let money = null;
    if (outcome === 'overturned' && v.kind === 'verifier' && decision) {
      const m = this.milestoneRow(v.pactId, v.milestoneId);
      if (m.status !== 'disputed') this.openDispute(v.pactId, v.milestoneId, 'seller', `Appeal overturned by human reviewer: ${note}`, actor);
      const human = {
        id: newId('vd'),
        pactId: v.pactId,
        milestoneId: v.milestoneId,
        kind: 'human' as const,
        status: decision.outcome,
        confidence: 1,
        reasoning: `Human reviewer ${reviewer}: ${note}`,
        payloadJson: JSON.stringify(decision),
        createdAt: this.now(),
      };
      this.ctx.db.insert(tables.verdicts).values(human).run();
      const pct = decision.outcome === 'release' ? 100 : decision.outcome === 'refund' ? 0 : (decision.releasePercent ?? 50);
      money = await this.executeResolution(v.pactId, v.milestoneId, decision.outcome, pct, actor);
      this.ctx.db.update(tables.disputes).set({ status: 'resolved', verdictId: human.id, resolvedAt: this.now() }).where(and(eq(tables.disputes.pactId, v.pactId), eq(tables.disputes.milestoneId, v.milestoneId), eq(tables.disputes.status, 'open'))).run();
    }
    return { verdict: this.verdictById(verdictId), money, pact: this.view(v.pactId) };
  }

  close(pactId: string, actor: string) {
    this.transition(pactId, { type: 'CLOSE' }, actor);
    snapshotReputation(this.ctx, this.row(pactId).sellerId);
    return this.view(pactId);
  }

  // --- jobs: reauthorization and expiry ------------------------------------------------------

  async reauthorizeIfNeeded(pactId: string) {
    const row = this.row(pactId);
    if (!['funded', 'in_progress', 'disputed'].includes(row.status)) return { skipped: `pact is ${row.status}` };
    const pays = this.ctx.db.select().from(tables.payments).where(eq(tables.payments.pactId, pactId)).all();
    if (pays.some((p) => p.kind === 'capture')) return { skipped: 'already partially captured; PayPal does not allow reauthorizing a partially captured authorization' };
    if (pays.some((p) => p.kind === 'reauthorization')) return { skipped: 'already reauthorized once' };
    const authId = this.authorizationId(row);
    const a = await this.paypal(pactId, 'system:jobs', 'authorizations.reauthorize', () =>
      this.ctx.gateway.reauthorize(authId, { minor: row.totalMinor, currency: row.currency }, `pact-${pactId}-reauth`),
    );
    this.recordPayment({ pactId, kind: 'reauthorization', paypalId: a.authorizationId, parentPaypalId: authId, amountMinor: a.amount.minor, currency: row.currency, status: a.status, requestId: `pact-${pactId}-reauth`, rawJson: JSON.stringify(a.raw) });
    this.ctx.db.update(tables.pacts).set({ authorizationId: a.authorizationId, honorPeriodEndsAt: new Date(this.ctx.now().getTime() + 3 * DAY).toISOString(), updatedAt: this.now() }).where(eq(tables.pacts.id, pactId)).run();
    this.audit(pactId, 'system:jobs', 'paypal.reauthorized', { from: authId, to: a.authorizationId, expiresAt: a.expiresAt });
    return { reauthorized: a.authorizationId };
  }

  async expireIfOpen(pactId: string) {
    const row = this.row(pactId);
    if (!['funded', 'in_progress'].includes(row.status)) return { skipped: `pact is ${row.status}` };
    this.transition(pactId, { type: 'EXPIRE' }, 'system:jobs', { authorizationExpiresAt: row.authorizationExpiresAt });
    await this.settleIfDone(pactId, 'system:jobs').catch((e) => this.audit(pactId, 'system:jobs', 'paypal.void.skipped', { reason: (e as Error).message }));
    return { expired: true };
  }
}

// --- job queue helper (used by PactService and the scheduler) ------------------------------

export function enqueueJob(ctx: AppContext, type: string, payload: unknown, runAt: Date, dedupeKey?: string) {
  const at = ctx.now().toISOString();
  ctx.db
    .insert(tables.jobs)
    .values({ id: newId('job'), type, payloadJson: JSON.stringify(payload), runAt: runAt.toISOString(), dedupeKey: dedupeKey ?? null, createdAt: at, updatedAt: at })
    .onConflictDoNothing()
    .run();
}
