// PayPal-side view for reconciliation: Transaction Search (≤ 31 days per request, activity may take
// up to ~3 hours to appear) and balances, matched against PACT's own ledger. The live dashboard reads
// PACT's ledger; this view is for checking PayPal agrees with it.
import { tables } from '@pact/db';
import type { AppContext } from '../context';

let cache: { at: number; value: unknown } | null = null;

export async function buildReconciliation(ctx: AppContext) {
  if (cache && Date.now() - cache.at < 60_000) return cache.value;
  const end = ctx.now();
  const start = new Date(end.getTime() - 30 * 24 * 3600 * 1000);
  const payments = ctx.db.select().from(tables.payments).all();
  const ours = new Map(payments.filter((p) => p.paypalId).map((p) => [p.paypalId!, p]));
  let transactions: Awaited<ReturnType<typeof ctx.gateway.searchTransactions>> = [];
  let balances: Awaited<ReturnType<typeof ctx.gateway.getBalances>> = [];
  const errors: string[] = [];
  try {
    transactions = await ctx.gateway.searchTransactions(start.toISOString(), end.toISOString());
  } catch (e) {
    errors.push(`Transaction Search: ${(e as Error).message} (the sandbox app needs the "Transaction search" feature enabled)`);
  }
  try {
    balances = await ctx.gateway.getBalances();
  } catch (e) {
    errors.push(`Balances: ${(e as Error).message}`);
  }
  const rows = transactions.map((t) => {
    const match = ours.get(t.id);
    return {
      id: t.id,
      date: t.date,
      eventCode: t.eventCode,
      status: t.status,
      amount: t.amount.minor / 100,
      currency: t.amount.currency,
      fee: t.fee ? t.fee.minor / 100 : null,
      counterparty: t.counterparty,
      note: t.note,
      pactId: match?.pactId ?? null,
      pactKind: match?.kind ?? null,
      matched: !!match,
    };
  });
  const seen = new Set(transactions.map((t) => t.id));
  const pendingInPaypal = payments
    .filter((p) => ['capture', 'refund'].includes(p.kind) && p.paypalId && !seen.has(p.paypalId))
    .map((p) => ({ id: p.paypalId, kind: p.kind, pactId: p.pactId, amount: p.amountMinor / 100, createdAt: p.createdAt }));
  const value = {
    asOf: end.toISOString(),
    range: { start: start.toISOString(), end: end.toISOString() },
    paymentMode: ctx.gateway.mode,
    caveat: 'PayPal Transaction Search covers at most 31 days per request and new activity can take up to 3 hours to appear. The live dashboard therefore reads PACT\'s own ledger; this table is for reconciliation.',
    transactions: rows,
    balances: balances.map((b) => ({ currency: b.currency, total: b.totalMinor / 100, available: b.availableMinor / 100, withheld: b.withheldMinor / 100 })),
    notYetInTransactionSearch: pendingInPaypal,
    errors,
  };
  cache = { at: Date.now(), value };
  return value;
}

export const clearReconciliationCache = () => {
  cache = null;
};
