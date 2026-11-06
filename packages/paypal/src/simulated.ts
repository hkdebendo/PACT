// SIMULATED PayPal adapter. NOT real PayPal behaviour.
//
// Used when PAYPAL_ENV=simulated or when sandbox credentials are missing, so PACT can be explored
// without a PayPal account, and in unit tests. It mirrors the documented rules PACT relies on
// (authorize → partial captures up to the authorized amount + 15% / 75 USD → final capture, void,
// refund ≤ captured, honor period, 29-day expiry, request-id idempotency), but every object id
// starts with "SIM-" and every API response from PACT carries paymentMode = "simulated" so the UI
// can label it. See docs/SANDBOX_LIMITATIONS.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PayPalError } from './errors';
import type {
  Amount,
  AuthorizationResult,
  BalanceRow,
  CaptureInput,
  CaptureResult,
  CreateOrderInput,
  OrderResult,
  PaymentsGateway,
  PayoutItemInput,
  PayoutResult,
  RefundResult,
  TransactionRow,
  WebhookVerification,
} from './types';

interface SimOrder {
  id: string;
  status: 'CREATED' | 'APPROVED' | 'COMPLETED' | 'VOIDED';
  amount: Amount;
  pactId: string;
  description: string;
  authorizationId: string | null;
  createdAt: string;
}
interface SimAuth {
  id: string;
  orderId: string;
  status: 'CREATED' | 'PARTIALLY_CAPTURED' | 'CAPTURED' | 'VOIDED' | 'EXPIRED';
  amount: Amount;
  capturedMinor: number;
  createdAt: string;
  honorEndsAt: string;
  expiresAt: string;
}
interface SimCapture {
  id: string;
  authorizationId: string;
  amount: Amount;
  refundedMinor: number;
  finalCapture: boolean;
  status: 'COMPLETED' | 'PARTIALLY_REFUNDED' | 'REFUNDED';
  createdAt: string;
}
interface SimRefund {
  id: string;
  captureId: string;
  amount: Amount;
  createdAt: string;
}
interface SimPayout {
  batchId: string;
  items: PayoutResult['items'];
  createdAt: string;
}

export interface SimState {
  orders: Record<string, SimOrder>;
  auths: Record<string, SimAuth>;
  captures: Record<string, SimCapture>;
  refunds: Record<string, SimRefund>;
  payouts: Record<string, SimPayout>;
  idempotency: Record<string, unknown>;
}

const empty = (): SimState => ({ orders: {}, auths: {}, captures: {}, refunds: {}, payouts: {}, idempotency: {} });

export interface SimulatedOptions {
  /** JSON file used to persist state across restarts; omit for in-memory only. */
  statePath?: string;
  now?: () => Date;
  approvalBaseUrl?: string; // e.g. http://localhost:3000/simulated-checkout
}

const DAY = 24 * 3600 * 1000;
const err = (operation: string, status: number, name: string, message: string) =>
  new PayPalError({ operation, status, name, message: `[SIMULATED] ${message}` });

export class SimulatedGateway implements PaymentsGateway {
  readonly mode = 'simulated' as const;
  private state: SimState;
  private readonly now: () => Date;

  constructor(private readonly opts: SimulatedOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.state = opts.statePath && existsSync(opts.statePath) ? JSON.parse(readFileSync(opts.statePath, 'utf8')) : empty();
  }

  private persist() {
    if (!this.opts.statePath) return;
    mkdirSync(dirname(this.opts.statePath), { recursive: true });
    writeFileSync(this.opts.statePath, JSON.stringify(this.state, null, 2));
  }

  private once<T>(requestId: string | undefined, op: string, fn: () => T): T {
    if (requestId) {
      const key = `${op}:${requestId}`;
      if (key in this.state.idempotency) return this.state.idempotency[key] as T;
      const out = fn();
      this.state.idempotency[key] = out;
      this.persist();
      return out;
    }
    const out = fn();
    this.persist();
    return out;
  }

  private id(prefix: string) {
    return `SIM-${prefix}-${randomUUID().slice(0, 12).toUpperCase()}`;
  }

  private refreshExpiry(a: SimAuth) {
    if ((a.status === 'CREATED' || a.status === 'PARTIALLY_CAPTURED') && this.now().toISOString() > a.expiresAt) a.status = 'EXPIRED';
  }

  // --- SIMULATED buyer approval (stands in for the PayPal checkout page) -----------------

  approveOrder(orderId: string): OrderResult {
    const o = this.state.orders[orderId];
    if (!o) throw err('orders.approve', 404, 'RESOURCE_NOT_FOUND', `order ${orderId} not found`);
    if (o.status === 'CREATED') o.status = 'APPROVED';
    this.persist();
    return this.order(o);
  }

  /** Test/demo helper: move the simulated clock forward by changing stored timestamps. */
  ageAuthorization(authorizationId: string, days: number) {
    const a = this.state.auths[authorizationId];
    if (!a) return;
    const shift = (iso: string) => new Date(new Date(iso).getTime() - days * DAY).toISOString();
    a.createdAt = shift(a.createdAt);
    a.honorEndsAt = shift(a.honorEndsAt);
    a.expiresAt = shift(a.expiresAt);
    this.persist();
  }

  private order(o: SimOrder): OrderResult {
    const base = this.opts.approvalBaseUrl ?? 'http://localhost:3000/simulated-checkout';
    return { orderId: o.id, status: o.status, approvalUrl: o.status === 'CREATED' ? `${base}/${o.id}` : null, raw: { simulated: true, ...o } };
  }

  private auth(a: SimAuth): AuthorizationResult {
    return { authorizationId: a.id, status: a.status, amount: a.amount, expiresAt: a.expiresAt, raw: { simulated: true, ...a } };
  }

  // --- PaymentsGateway -------------------------------------------------------------------

  async createAuthorizeOrder(input: CreateOrderInput): Promise<OrderResult> {
    return this.once(input.requestId, 'orders.create', () => {
      if (input.amount.minor <= 0) throw err('orders.create', 422, 'UNPROCESSABLE_ENTITY', 'amount must be positive');
      const o: SimOrder = {
        id: this.id('ORDER'),
        status: 'CREATED',
        amount: input.amount,
        pactId: input.pactId,
        description: input.description,
        authorizationId: null,
        createdAt: this.now().toISOString(),
      };
      this.state.orders[o.id] = o;
      return this.order(o);
    });
  }

  async getOrder(orderId: string): Promise<OrderResult> {
    const o = this.state.orders[orderId];
    if (!o) throw err('orders.get', 404, 'RESOURCE_NOT_FOUND', `order ${orderId} not found`);
    return this.order(o);
  }

  async authorizeOrder(orderId: string, requestId: string): Promise<AuthorizationResult> {
    return this.once(requestId, 'orders.authorize', () => {
      const o = this.state.orders[orderId];
      if (!o) throw err('orders.authorize', 404, 'RESOURCE_NOT_FOUND', `order ${orderId} not found`);
      if (o.status === 'COMPLETED' && o.authorizationId) return this.auth(this.state.auths[o.authorizationId]);
      if (o.status !== 'APPROVED') throw err('orders.authorize', 422, 'ORDER_NOT_APPROVED', 'the payer has not approved the order');
      const now = this.now();
      const a: SimAuth = {
        id: this.id('AUTH'),
        orderId,
        status: 'CREATED',
        amount: o.amount,
        capturedMinor: 0,
        createdAt: now.toISOString(),
        honorEndsAt: new Date(now.getTime() + 3 * DAY).toISOString(),
        expiresAt: new Date(now.getTime() + 29 * DAY).toISOString(),
      };
      this.state.auths[a.id] = a;
      o.status = 'COMPLETED';
      o.authorizationId = a.id;
      return this.auth(a);
    });
  }

  async getAuthorization(id: string): Promise<AuthorizationResult> {
    const a = this.state.auths[id];
    if (!a) throw err('authorizations.get', 404, 'RESOURCE_NOT_FOUND', `authorization ${id} not found`);
    this.refreshExpiry(a);
    return this.auth(a);
  }

  async captureAuthorization(id: string, input: CaptureInput): Promise<CaptureResult> {
    return this.once(input.requestId, 'authorizations.capture', () => {
      const a = this.state.auths[id];
      if (!a) throw err('authorizations.capture', 404, 'RESOURCE_NOT_FOUND', `authorization ${id} not found`);
      this.refreshExpiry(a);
      if (a.status === 'EXPIRED') throw err('authorizations.capture', 422, 'AUTHORIZATION_EXPIRED', 'authorization has expired');
      if (a.status === 'VOIDED') throw err('authorizations.capture', 422, 'AUTHORIZATION_VOIDED', 'authorization was voided');
      if (a.status === 'CAPTURED') throw err('authorizations.capture', 422, 'AUTHORIZATION_ALREADY_CAPTURED', 'a final capture was already made');
      if (input.amount.currency !== a.amount.currency) throw err('authorizations.capture', 422, 'CURRENCY_MISMATCH', 'currency differs from the authorization');
      const cap = Math.min(Math.round(a.amount.minor * 1.15), a.amount.minor + 7500);
      if (a.capturedMinor + input.amount.minor > cap)
        throw err('authorizations.capture', 422, 'MAX_CAPTURE_AMOUNT_EXCEEDED', 'capture exceeds the authorized amount allowance');
      const c: SimCapture = {
        id: this.id('CAPTURE'),
        authorizationId: id,
        amount: input.amount,
        refundedMinor: 0,
        finalCapture: input.finalCapture,
        status: 'COMPLETED',
        createdAt: this.now().toISOString(),
      };
      this.state.captures[c.id] = c;
      a.capturedMinor += input.amount.minor;
      a.status = input.finalCapture ? 'CAPTURED' : 'PARTIALLY_CAPTURED';
      return { captureId: c.id, status: c.status, amount: c.amount, finalCapture: c.finalCapture, raw: { simulated: true, ...c } };
    });
  }

  async voidAuthorization(id: string, requestId: string): Promise<AuthorizationResult> {
    return this.once(requestId, 'authorizations.void', () => {
      const a = this.state.auths[id];
      if (!a) throw err('authorizations.void', 404, 'RESOURCE_NOT_FOUND', `authorization ${id} not found`);
      this.refreshExpiry(a);
      if (a.status === 'CAPTURED' || a.status === 'EXPIRED')
        throw err('authorizations.void', 422, 'CANNOT_BE_VOIDED', `authorization is ${a.status}`);
      a.status = 'VOIDED';
      return this.auth(a);
    });
  }

  async reauthorize(id: string, amount: Amount, requestId: string): Promise<AuthorizationResult> {
    return this.once(requestId, 'authorizations.reauthorize', () => {
      const a = this.state.auths[id];
      if (!a) throw err('authorizations.reauthorize', 404, 'RESOURCE_NOT_FOUND', `authorization ${id} not found`);
      this.refreshExpiry(a);
      if (a.status !== 'CREATED') throw err('authorizations.reauthorize', 422, 'REAUTHORIZATION_NOT_ALLOWED', `authorization is ${a.status}`);
      if (this.now().toISOString() < a.honorEndsAt)
        throw err('authorizations.reauthorize', 422, 'REAUTHORIZATION_TOO_SOON', 'still inside the 3-day honor period');
      const now = this.now();
      const b: SimAuth = {
        ...a,
        id: this.id('AUTH'),
        amount,
        status: 'CREATED',
        createdAt: now.toISOString(),
        honorEndsAt: new Date(now.getTime() + 3 * DAY).toISOString(),
        expiresAt: a.expiresAt, // PayPal keeps the original 29-day validity window
      };
      this.state.auths[b.id] = b;
      return this.auth(b);
    });
  }

  async refundCapture(captureId: string, amount: Amount, _note: string, requestId: string): Promise<RefundResult> {
    return this.once(requestId, 'captures.refund', () => {
      const c = this.state.captures[captureId];
      if (!c) throw err('captures.refund', 404, 'RESOURCE_NOT_FOUND', `capture ${captureId} not found`);
      if (c.refundedMinor + amount.minor > c.amount.minor)
        throw err('captures.refund', 422, 'REFUND_AMOUNT_EXCEEDED', 'refund exceeds the captured amount');
      c.refundedMinor += amount.minor;
      c.status = c.refundedMinor === c.amount.minor ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      const r: SimRefund = { id: this.id('REFUND'), captureId, amount, createdAt: this.now().toISOString() };
      this.state.refunds[r.id] = r;
      return { refundId: r.id, status: 'COMPLETED', amount, raw: { simulated: true, ...r } };
    });
  }

  async createPayout(senderBatchId: string, items: PayoutItemInput[]): Promise<PayoutResult> {
    return this.once(senderBatchId, 'payouts.create', () => {
      const p: SimPayout = {
        batchId: this.id('PAYOUT'),
        items: items.map((i) => ({ payoutItemId: this.id('ITEM'), senderItemId: i.senderItemId, status: 'SUCCESS', receiver: i.receiverEmail, amount: i.amount })),
        createdAt: this.now().toISOString(),
      };
      this.state.payouts[p.batchId] = p;
      return { batchId: p.batchId, status: 'SUCCESS', items: p.items, raw: { simulated: true, ...p } };
    });
  }

  async getPayout(batchId: string): Promise<PayoutResult> {
    const p = this.state.payouts[batchId];
    if (!p) throw err('payouts.get', 404, 'RESOURCE_NOT_FOUND', `payout ${batchId} not found`);
    return { batchId, status: 'SUCCESS', items: p.items, raw: { simulated: true, ...p } };
  }

  async verifyWebhook(headers: Record<string, string | undefined>): Promise<WebhookVerification> {
    const ok = headers['paypal-transmission-sig'] === 'SIMULATED';
    return { verified: ok, method: 'simulated', reason: ok ? 'simulated signature accepted' : 'not a simulated webhook' };
  }

  async searchTransactions(startIso: string, endIso: string): Promise<TransactionRow[]> {
    const inRange = (d: string) => d >= startIso && d <= endIso;
    const rows: TransactionRow[] = [];
    for (const a of Object.values(this.state.auths))
      if (inRange(a.createdAt))
        rows.push({ id: a.id, date: a.createdAt, eventCode: 'T1200', status: 'S', amount: a.amount, fee: null, counterparty: 'sandbox buyer', invoiceId: null, note: 'Authorization (simulated)' });
    for (const c of Object.values(this.state.captures))
      if (inRange(c.createdAt))
        rows.push({ id: c.id, date: c.createdAt, eventCode: 'T0006', status: 'S', amount: c.amount, fee: null, counterparty: 'sandbox buyer', invoiceId: null, note: 'Capture (simulated)' });
    for (const r of Object.values(this.state.refunds))
      if (inRange(r.createdAt))
        rows.push({ id: r.id, date: r.createdAt, eventCode: 'T1107', status: 'S', amount: { ...r.amount, minor: -r.amount.minor }, fee: null, counterparty: 'sandbox buyer', invoiceId: null, note: 'Refund (simulated)' });
    for (const p of Object.values(this.state.payouts))
      if (inRange(p.createdAt))
        for (const i of p.items)
          rows.push({ id: i.payoutItemId ?? p.batchId, date: p.createdAt, eventCode: 'T0001', status: 'S', amount: { ...i.amount, minor: -i.amount.minor }, fee: null, counterparty: i.receiver, invoiceId: null, note: 'Payout (simulated)' });
    return rows.sort((x, y) => x.date.localeCompare(y.date));
  }

  async getBalances(): Promise<BalanceRow[]> {
    const by: Record<string, number> = {};
    for (const c of Object.values(this.state.captures)) by[c.amount.currency] = (by[c.amount.currency] ?? 0) + c.amount.minor - c.refundedMinor;
    for (const p of Object.values(this.state.payouts)) for (const i of p.items) by[i.amount.currency] = (by[i.amount.currency] ?? 0) - i.amount.minor;
    return Object.entries(by).map(([currency, total]) => ({ currency, totalMinor: total, availableMinor: total, withheldMinor: 0 }));
  }
}
