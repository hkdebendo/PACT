// Normalises PayPal webhook events into the few facts PACT's ledger needs. The same normalised
// shape is produced by the reconciliation poller (which reads authorizations back via the API), so
// both paths converge on one handler in the API service.

export const HANDLED_EVENTS = [
  'PAYMENT.AUTHORIZATION.CREATED',
  'PAYMENT.AUTHORIZATION.VOIDED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.PAYOUTSBATCH.SUCCESS',
  'PAYMENT.PAYOUTSBATCH.DENIED',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  'PAYMENT.PAYOUTS-ITEM.FAILED',
] as const;

export type LedgerFact =
  | { kind: 'authorization'; authorizationId: string; orderId: string | null; status: string }
  | { kind: 'capture'; captureId: string; authorizationId: string | null; status: string }
  | { kind: 'refund'; refundId: string; captureId: string | null; status: string }
  | { kind: 'payout_batch'; batchId: string; status: string }
  | { kind: 'payout_item'; batchId: string | null; payoutItemId: string; status: string }
  | { kind: 'ignored'; reason: string };

export interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  create_time?: string;
  resource_type?: string;
  resource: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const linkId = (links: { rel: string; href: string }[] | undefined, rel: string): string | null => {
  const href = links?.find((l) => l.rel === rel)?.href;
  return href ? (href.split('/').pop() ?? null) : null;
};

export function normaliseWebhook(e: PayPalWebhookEvent): LedgerFact {
  const r = e.resource ?? {};
  switch (e.event_type) {
    case 'PAYMENT.AUTHORIZATION.CREATED':
    case 'PAYMENT.AUTHORIZATION.VOIDED':
      return {
        kind: 'authorization',
        authorizationId: r.id,
        orderId: r.supplementary_data?.related_ids?.order_id ?? null,
        status: r.status ?? (e.event_type.endsWith('VOIDED') ? 'VOIDED' : 'CREATED'),
      };
    case 'PAYMENT.CAPTURE.COMPLETED':
    case 'PAYMENT.CAPTURE.PENDING':
    case 'PAYMENT.CAPTURE.DENIED':
      return {
        kind: 'capture',
        captureId: r.id,
        authorizationId: r.supplementary_data?.related_ids?.authorization_id ?? linkId(r.links, 'up'),
        status: r.status,
      };
    case 'PAYMENT.CAPTURE.REFUNDED':
      // The resource is the refund; its "up" link points at the refunded capture.
      return { kind: 'refund', refundId: r.id, captureId: linkId(r.links, 'up'), status: r.status ?? 'COMPLETED' };
    case 'PAYMENT.PAYOUTSBATCH.SUCCESS':
    case 'PAYMENT.PAYOUTSBATCH.DENIED':
      return { kind: 'payout_batch', batchId: r.batch_header?.payout_batch_id, status: r.batch_header?.batch_status };
    case 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED':
    case 'PAYMENT.PAYOUTS-ITEM.FAILED':
      return { kind: 'payout_item', batchId: r.payout_batch_id ?? null, payoutItemId: r.payout_item_id, status: r.transaction_status };
    default:
      return { kind: 'ignored', reason: `event type ${e.event_type} is not used by PACT` };
  }
}
