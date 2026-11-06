// AG Studio data sources for the Control Tower: the flat tables served by GET /api/dashboard
// (PACT's own ledger) and GET /api/reconciliation (PayPal Transaction Search + balances), with
// relationships, a calendar and calculated measures. Live updates replace the rows only; the
// structure is fixed at init, as Studio requires.
import type { AgDataSourcesDefinition, AgFieldDefinition, AgFormat, AgRelationDefinition, AgExpressionFieldDefinition } from 'ag-studio';

export interface DashboardPayload {
  asOf: string;
  paymentMode: 'sandbox' | 'simulated';
  llmMode: 'live' | 'replay';
  totals: { held: number; released: number; refunded: number; voided: number; pacts: number; activePacts: number; disputeRate: number; refundRate: number; verdicts: number; refusedVerdicts: number };
  audit: { ok: boolean; count: number; headHash: string; verifiedAt: string };
  pacts: Record<string, unknown>[];
  milestones: Record<string, unknown>[];
  verdicts: Record<string, unknown>[];
  payments: Record<string, unknown>[];
  reputation: (Record<string, unknown> & { trend: number[] })[];
  flows: { source: string; target: string; value: number }[];
}

export interface ReconciliationPayload {
  asOf: string;
  caveat: string;
  paymentMode: string;
  transactions: Record<string, unknown>[];
  balances: Record<string, unknown>[];
  notYetInTransactionSearch: Record<string, unknown>[];
  errors: string[];
}

type FieldSpec = [id: string, name: string, format: AgFormat, hide?: boolean];
const fields = (specs: FieldSpec[]): AgFieldDefinition[] => specs.map(([id, name, format, hide]) => ({ id, name, format, ...(hide && { hide }) }));
const manyToOne = (id: string, source: string, target: string): AgRelationDefinition => {
  const [st, sf] = source.split('.');
  const [tt, tf] = target.split('.');
  return { id, source: { tableId: st, fieldId: sf }, target: { tableId: tt, fieldId: tf }, type: 'many-to-one' };
};
const onCalendar = (tableId: string, fieldId: string): AgRelationDefinition => ({ id: `${tableId}-${fieldId}-calendar`, source: { tableId, fieldId }, target: { calendarId: 'calendar' }, truncate: 'day' });
const ratio = (id: string, name: string, description: string, num: string, den: string): AgExpressionFieldDefinition => ({
  id,
  name,
  description,
  format: 'percentageFormat',
  isMeasure: true,
  expression: { operator: 'divide', inputs: [{ id: num, aggregation: 'sum' }, { id: den, aggregation: 'sum' }] },
});

// Studio needs every row to carry every field: normalise arrays (sparklines) to strings.
const rowsOf = (rows: Record<string, unknown>[]) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v])));

export function buildStudioData(d: DashboardPayload, rec: ReconciliationPayload | null): AgDataSourcesDefinition {
  const today = d.asOf.slice(0, 10);
  const dates = [...d.pacts.map((p) => String(p.createdAt).slice(0, 10)), today].sort();
  const flows = d.flows.length ? d.flows : [{ source: 'Buyers', target: 'PACT escrow (PayPal authorization)', value: 0 }];
  return {
    description:
      'PACT escrow ledger. A pact is a deal between a buyer and a seller; PayPal holds the money (authorization) and PACT releases it milestone by milestone after an AI Verifier approves evidence. ' +
      'Verdicts are AI or human decisions: verifier (approved / rejected / needs_more), arbiter (release / partial / refund), human (appeal review). "refused" means rejected or refunded. Money is in USD major units.',
    sources: [
      {
        id: 'pacts',
        description: 'One row per pact. held = still authorized, released = captured to the seller net of refunds, refunded = returned after capture, voided = authorization released without charging.',
        data: rowsOf(d.pacts),
        fields: fields([
          ['id', 'Pact ID', 'textFormat'],
          ['title', 'Pact', 'textFormat'],
          ['status', 'Pact Status', 'textFormat'],
          ['buyer', 'Buyer', 'textFormat'],
          ['buyerId', 'Buyer ID', 'textFormat', true],
          ['seller', 'Seller', 'textFormat'],
          ['sellerId', 'Seller ID', 'textFormat', true],
          ['currency', 'Currency', 'textFormat', true],
          ['total', 'Total', 'currencyFormat'],
          ['held', 'Held', 'currencyFormat'],
          ['released', 'Released', 'currencyFormat'],
          ['refunded', 'Refunded', 'currencyFormat'],
          ['voided', 'Voided', 'currencyFormat'],
          ['milestones', 'Milestones', 'integerFormat'],
          ['milestonesDone', 'Milestones Settled', 'integerFormat'],
          ['paymentMode', 'Payment Mode', 'textFormat'],
          ['createdAt', 'Created', 'dateTimeFormat'],
          ['deadline', 'Deadline', 'dateFormat'],
        ]),
      },
      {
        id: 'milestones',
        description: 'One row per milestone of a pact (key = pactId:milestoneId).',
        data: rowsOf(d.milestones),
        fields: fields([
          ['key', 'Milestone Key', 'textFormat', true],
          ['pactId', 'Pact ID', 'textFormat', true],
          ['pactTitle', 'Milestone Pact', 'textFormat'],
          ['milestoneId', 'Milestone ID', 'textFormat'],
          ['position', 'Step', 'integerFormat'],
          ['title', 'Milestone', 'textFormat'],
          ['percent', 'Share %', 'integerFormat'],
          ['amount', 'Milestone Amount', 'currencyFormat'],
          ['captured', 'Captured', 'currencyFormat'],
          ['refunded', 'Milestone Refunded', 'currencyFormat'],
          ['status', 'Milestone Status', 'textFormat'],
          ['attempts', 'Evidence Attempts', 'integerFormat'],
          ['deadline', 'Milestone Deadline', 'dateFormat'],
          ['releasedAt', 'Released At', 'dateTimeFormat'],
          ['lastVerdict', 'Last Verdict', 'textFormat'],
          ['lastConfidence', 'Last Confidence', 'decimalFormat'],
          ['evidenceCount', 'Evidence Files', 'integerFormat'],
          ['thumbnailUrl', 'Thumbnail', 'textFormat', true],
          ['seller', 'Milestone Seller', 'textFormat'],
        ]),
      },
      {
        id: 'verdicts',
        description: 'AI Verifier, AI Arbiter and human decisions. refused = rejected or refund.',
        data: rowsOf(d.verdicts),
        fields: fields([
          ['id', 'Verdict ID', 'textFormat'],
          ['pactId', 'Pact ID', 'textFormat', true],
          ['pactTitle', 'Verdict Pact', 'textFormat'],
          ['milestoneKey', 'Milestone Key', 'textFormat', true],
          ['milestoneTitle', 'Verdict Milestone', 'textFormat'],
          ['kind', 'Decided By', 'textFormat'],
          ['status', 'Verdict', 'textFormat'],
          ['refused', 'Refused', 'booleanFormat'],
          ['confidence', 'Confidence', 'decimalFormat'],
          ['reasoning', 'Reasoning', 'textFormat'],
          ['model', 'Model', 'textFormat'],
          ['llmMode', 'LLM Mode', 'textFormat'],
          ['appealStatus', 'Appeal', 'textFormat'],
          ['precheckFailures', 'Pre-check Failures', 'integerFormat'],
          ['createdAt', 'Decided At', 'dateTimeFormat'],
          ['seller', 'Verdict Seller', 'textFormat'],
        ]),
      },
      {
        id: 'payments',
        description: 'PayPal operations recorded by PACT: order, authorization, capture, refund, void, reauthorization, payout.',
        data: rowsOf(d.payments),
        fields: fields([
          ['id', 'Payment ID', 'textFormat', true],
          ['pactId', 'Pact ID', 'textFormat', true],
          ['milestoneKey', 'Milestone Key', 'textFormat', true],
          ['kind', 'Operation', 'textFormat'],
          ['amount', 'Operation Amount', 'currencyFormat'],
          ['currency', 'Operation Currency', 'textFormat', true],
          ['status', 'PayPal Status', 'textFormat'],
          ['mode', 'Mode', 'textFormat'],
          ['paypalId', 'PayPal ID', 'textFormat'],
          ['createdAt', 'Operation Time', 'dateTimeFormat'],
        ]),
      },
      {
        id: 'reputation',
        description: 'Bayesian-smoothed reputation per party (score 0-100). trend = past scores, comma-separated.',
        data: rowsOf(d.reputation),
        fields: fields([
          ['partyId', 'Party ID', 'textFormat', true],
          ['name', 'Party', 'textFormat'],
          ['kind', 'Party Kind', 'textFormat'],
          ['score', 'Reputation', 'decimalFormat'],
          ['tier', 'Tier', 'textFormat'],
          ['completionRate', 'Completion Rate', 'percentageFormat'],
          ['onTimeRate', 'On-time Rate', 'percentageFormat'],
          ['disputeRate', 'Dispute Rate', 'percentageFormat'],
          ['refundRate', 'Refund Rate', 'percentageFormat'],
          ['confidence', 'Score Confidence', 'percentageFormat'],
          ['milestones', 'Settled Milestones', 'integerFormat'],
          ['trend', 'Trend', 'textFormat', true],
        ]),
      },
      {
        id: 'flows',
        name: 'Money Flows',
        description: 'Where escrowed money went: source → target, value in USD.',
        data: flows,
        fields: fields([
          ['source', 'From', 'textFormat'],
          ['target', 'To', 'textFormat'],
          ['value', 'Flow', 'currencyFormat'],
        ]),
      },
      {
        id: 'paypalTransactions',
        name: 'PayPal Transactions',
        description: 'PayPal Transaction Search, last 30 days (activity can take up to 3 hours to appear). matched = PACT knows this PayPal id.',
        data: rowsOf(rec?.transactions.length ? rec.transactions : [{ id: '—', date: d.asOf, eventCode: '', status: '', amount: 0, currency: 'USD', fee: 0, counterparty: '', note: 'No transactions returned yet', pactId: '', pactKind: '', matched: false }]),
        fields: fields([
          ['id', 'Transaction ID', 'textFormat'],
          ['date', 'Transaction Date', 'dateTimeFormat'],
          ['eventCode', 'Event Code', 'textFormat'],
          ['status', 'Transaction Status', 'textFormat'],
          ['amount', 'Transaction Amount', 'currencyFormat'],
          ['currency', 'Transaction Currency', 'textFormat', true],
          ['fee', 'Fee', 'currencyFormat'],
          ['counterparty', 'Counterparty', 'textFormat'],
          ['note', 'Note', 'textFormat'],
          ['pactId', 'Matched Pact', 'textFormat'],
          ['pactKind', 'PACT Operation', 'textFormat'],
          ['matched', 'Matched', 'booleanFormat'],
        ]),
      },
    ],
    relationships: [
      manyToOne('milestone-pact', 'milestones.pactId', 'pacts.id'),
      manyToOne('verdict-pact', 'verdicts.pactId', 'pacts.id'),
      manyToOne('verdict-milestone', 'verdicts.milestoneKey', 'milestones.key'),
      manyToOne('payment-pact', 'payments.pactId', 'pacts.id'),
      onCalendar('pacts', 'createdAt'),
      onCalendar('verdicts', 'createdAt'),
      onCalendar('payments', 'createdAt'),
    ],
    calendars: [
      {
        id: 'calendar',
        label: 'Calendar',
        range: { from: { type: 'date', value: dates[0] }, to: { type: 'date', value: today } },
        fragments: ['year', 'month', 'week', 'day'],
      },
    ],
    expressions: [
      ratio('releaseRate', 'Release Rate', 'Released / total escrowed.', 'pacts.released', 'pacts.total'),
      ratio('refundShare', 'Refund Share', 'Refunded / total escrowed.', 'pacts.refunded', 'pacts.total'),
    ],
  };
}
