// Reconciliation poller + webhook handler. PayPal cannot reach localhost, so the poller reads
// orders and authorizations back through the API on an interval; webhooks (when a public URL and
// PAYPAL_WEBHOOK_ID exist) are verified with PayPal's verify-webhook-signature API. Both paths
// end in the same ledger update + audit entry.
import { normaliseWebhook, type LedgerFact, type PayPalWebhookEvent } from '@pact/paypal';
import { eq, tables } from '@pact/db';
import type { AppContext } from '../context';
import { appendAudit } from './audit';
import type { PactService } from './pacts';

export async function reconcile(ctx: AppContext, pacts: PactService) {
  const summary = { ordersChecked: 0, funded: 0, authorizationsChecked: 0, mismatches: 0, errors: 0 };
  const rows = ctx.db.select().from(tables.pacts).all();
  for (const p of rows) {
    try {
      if (p.status === 'proposed' && p.orderId && !p.authorizationId) {
        summary.ordersChecked++;
        const r = await pacts.confirmFunding(p.id, 'system:reconciler');
        if (r.funded) summary.funded++;
      } else if (['funded', 'in_progress', 'disputed'].includes(p.status) && p.authorizationId) {
        summary.authorizationsChecked++;
        const a = await ctx.gateway.getAuthorization(p.authorizationId);
        if (a.status === 'VOIDED' || a.status === 'EXPIRED' || a.status === 'DENIED') {
          summary.mismatches++;
          appendAudit(ctx, { pactId: p.id, actor: 'system:reconciler', type: 'reconcile.mismatch', data: { authorizationId: p.authorizationId, paypalStatus: a.status, pactStatus: p.status } });
          if (a.status === 'EXPIRED') await pacts.expireIfOpen(p.id);
        }
      }
    } catch (e) {
      summary.errors++;
      appendAudit(ctx, { pactId: p.id, actor: 'system:reconciler', type: 'reconcile.error', data: { error: (e as Error).message } });
    }
  }
  return summary;
}

export async function applyLedgerFact(ctx: AppContext, pacts: PactService, fact: LedgerFact, source: string) {
  const at = ctx.now().toISOString();
  const byPaypalId = (id: string | null) => (id ? ctx.db.select().from(tables.payments).where(eq(tables.payments.paypalId, id)).all() : []);
  switch (fact.kind) {
    case 'authorization': {
      const rows = byPaypalId(fact.authorizationId);
      for (const r of rows) ctx.db.update(tables.payments).set({ status: fact.status, updatedAt: at }).where(eq(tables.payments.id, r.id)).run();
      if (!rows.length && fact.orderId) {
        const pact = ctx.db.select().from(tables.pacts).where(eq(tables.pacts.orderId, fact.orderId)).get();
        if (pact && pact.status === 'proposed') await pacts.confirmFunding(pact.id, source);
        return { matched: !!pact, pactId: pact?.id ?? null };
      }
      return { matched: rows.length > 0, pactId: rows[0]?.pactId ?? null };
    }
    case 'capture': {
      const rows = byPaypalId(fact.captureId);
      for (const r of rows) ctx.db.update(tables.payments).set({ status: fact.status, updatedAt: at }).where(eq(tables.payments.id, r.id)).run();
      return { matched: rows.length > 0, pactId: rows[0]?.pactId ?? null };
    }
    case 'refund': {
      const rows = byPaypalId(fact.refundId);
      for (const r of rows) ctx.db.update(tables.payments).set({ status: fact.status, updatedAt: at }).where(eq(tables.payments.id, r.id)).run();
      return { matched: rows.length > 0, pactId: rows[0]?.pactId ?? null };
    }
    case 'payout_batch':
    case 'payout_item': {
      const rows = byPaypalId(fact.batchId);
      for (const r of rows) ctx.db.update(tables.payments).set({ status: fact.status, updatedAt: at }).where(eq(tables.payments.id, r.id)).run();
      return { matched: rows.length > 0, pactId: rows[0]?.pactId ?? null };
    }
    default:
      return { matched: false, pactId: null };
  }
}

export async function handleWebhook(ctx: AppContext, pacts: PactService, headers: Record<string, string | undefined>, rawBody: string) {
  let event: PayPalWebhookEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'invalid JSON' } };
  }
  if (!event?.id || !event.event_type) return { status: 400, body: { error: 'not a PayPal webhook event' } };
  const seen = ctx.db.select().from(tables.webhookEvents).where(eq(tables.webhookEvents.id, event.id)).get();
  if (seen) return { status: 200, body: { duplicate: true, processed: !!seen.processedAt } };

  const verification = await ctx.gateway.verifyWebhook(headers, rawBody);
  const fact = normaliseWebhook(event);
  ctx.db
    .insert(tables.webhookEvents)
    .values({
      id: event.id,
      eventType: event.event_type,
      resourceId: (event.resource?.id as string) ?? null,
      verified: verification.verified,
      verification: `${verification.method}: ${verification.reason}`,
      payloadJson: rawBody,
      createdAt: ctx.now().toISOString(),
    })
    .run();
  if (!verification.verified) {
    appendAudit(ctx, { pactId: null, actor: 'paypal:webhook', type: 'webhook.unverified', data: { eventId: event.id, eventType: event.event_type, verification } });
    return { status: 400, body: { error: 'signature verification failed', verification } };
  }
  const result = await applyLedgerFact(ctx, pacts, fact, 'paypal:webhook');
  ctx.db.update(tables.webhookEvents).set({ processedAt: ctx.now().toISOString() }).where(eq(tables.webhookEvents.id, event.id)).run();
  appendAudit(ctx, { pactId: result.pactId, actor: 'paypal:webhook', type: 'webhook.processed', data: { eventId: event.id, eventType: event.event_type, fact, matched: result.matched } });
  return { status: 200, body: { processed: true, fact, matched: result.matched } };
}
