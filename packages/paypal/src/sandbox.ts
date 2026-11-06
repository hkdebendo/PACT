// Real PayPal sandbox client over the REST API (plain fetch, like the official PayPal + AG Studio
// hackathon boilerplate). Every write sends a PayPal-Request-Id so a retried call is idempotent on
// PayPal's side; 429/5xx are retried with exponential backoff; a 401 refreshes the token once.
import { fromMajorString, toMajorString } from '@pact/core/browser';
import { PayPalConfigError, PayPalError } from './errors';
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

export interface SandboxOptions {
  clientId: string;
  clientSecret: string;
  webhookId?: string;
  baseUrl?: string;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onCall?: (info: { operation: string; method: string; path: string; status: number; ms: number; debugId: string | null }) => void;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const money = (a: Amount) => ({ currency_code: a.currency, value: toMajorString(a.minor) });
const parseAmount = (m: { value: string; currency_code: string } | undefined, fallback: Amount): Amount =>
  m ? { minor: fromMajorString(m.value), currency: m.currency_code } : fallback;

export class SandboxGateway implements PaymentsGateway {
  readonly mode = 'sandbox' as const;
  private token: { value: string; expiresAt: number } | null = null;
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: SandboxOptions) {
    if (!opts.clientId || !opts.clientSecret)
      throw new PayPalConfigError('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set for sandbox mode.');
    this.base = opts.baseUrl ?? 'https://api-m.sandbox.paypal.com';
    if (!this.base.includes('sandbox')) throw new PayPalConfigError('PACT only talks to the PayPal sandbox.');
    this.fetch = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // --- transport -------------------------------------------------------------------------

  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64');
    const res = await this.fetch(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Json;
      throw new PayPalError({ operation: 'oauth2.token', status: res.status, name: body.error, message: body.error_description });
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    // Refresh a minute early so a token never expires mid-request.
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
    return this.token.value;
  }

  private async call<T = Json>(
    operation: string,
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; requestId?: string; expectEmpty?: boolean } = {},
  ): Promise<T> {
    const maxRetries = this.opts.maxRetries ?? 3;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await this.accessToken()}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      };
      if (opts.requestId) headers['PayPal-Request-Id'] = opts.requestId;
      let res: Response;
      try {
        res = await this.fetch(`${this.base}${path}`, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
      } catch (err) {
        if (attempt < maxRetries) {
          await this.sleep(backoff(attempt));
          continue;
        }
        throw new PayPalError({ operation, status: 0, name: 'NETWORK_ERROR', message: (err as Error).message });
      }
      const debugId = res.headers.get('paypal-debug-id');
      this.opts.onCall?.({ operation, method, path, status: res.status, ms: Date.now() - started, debugId });

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.accessToken(true);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      const text = await res.text();
      const body = text ? (JSON.parse(text) as Json) : {};
      if (!res.ok) {
        throw new PayPalError({
          operation,
          status: res.status,
          name: body.name ?? body.error,
          message: body.message ?? body.error_description,
          debugId: body.debug_id ?? debugId,
          issues: body.details,
        });
      }
      return body as T;
    }
  }

  // --- orders ------------------------------------------------------------------------------

  async createAuthorizeOrder(input: CreateOrderInput): Promise<OrderResult> {
    const body = await this.call('orders.create', 'POST', '/v2/checkout/orders', {
      requestId: input.requestId,
      body: {
        intent: 'AUTHORIZE',
        purchase_units: [
          {
            reference_id: input.pactId,
            custom_id: input.pactId,
            description: input.description.slice(0, 127),
            amount: money(input.amount),
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: 'PACT escrow (sandbox)',
              user_action: 'CONTINUE',
              shipping_preference: 'NO_SHIPPING',
              return_url: input.returnUrl,
              cancel_url: input.cancelUrl,
            },
          },
        },
      },
    });
    return toOrder(body);
  }

  async getOrder(orderId: string): Promise<OrderResult> {
    return toOrder(await this.call('orders.get', 'GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`));
  }

  async authorizeOrder(orderId: string, requestId: string): Promise<AuthorizationResult> {
    const body = await this.call('orders.authorize', 'POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {
      requestId,
      body: {},
    });
    const auth = body.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!auth) throw new PayPalError({ operation: 'orders.authorize', status: 200, name: 'NO_AUTHORIZATION', message: 'Order authorized but no authorization was returned' });
    return toAuthorization(auth);
  }

  // --- authorizations ----------------------------------------------------------------------

  async getAuthorization(id: string): Promise<AuthorizationResult> {
    return toAuthorization(await this.call('authorizations.get', 'GET', `/v2/payments/authorizations/${encodeURIComponent(id)}`));
  }

  async captureAuthorization(id: string, input: CaptureInput): Promise<CaptureResult> {
    const body = await this.call('authorizations.capture', 'POST', `/v2/payments/authorizations/${encodeURIComponent(id)}/capture`, {
      requestId: input.requestId,
      body: {
        amount: money(input.amount),
        final_capture: input.finalCapture,
        ...(input.invoiceId && { invoice_id: input.invoiceId }),
        ...(input.noteToPayer && { note_to_payer: input.noteToPayer.slice(0, 255) }),
      },
    });
    return {
      captureId: body.id,
      status: body.status,
      amount: parseAmount(body.amount, input.amount),
      finalCapture: body.final_capture ?? input.finalCapture,
      raw: body,
    };
  }

  async voidAuthorization(id: string, requestId: string): Promise<AuthorizationResult> {
    const body = await this.call('authorizations.void', 'POST', `/v2/payments/authorizations/${encodeURIComponent(id)}/void`, {
      requestId,
    });
    // Without a representation PayPal answers 204; read the authorization back to report its state.
    return body.id ? toAuthorization(body) : this.getAuthorization(id);
  }

  async reauthorize(id: string, amount: Amount, requestId: string): Promise<AuthorizationResult> {
    const body = await this.call('authorizations.reauthorize', 'POST', `/v2/payments/authorizations/${encodeURIComponent(id)}/reauthorize`, {
      requestId,
      body: { amount: money(amount) },
    });
    return toAuthorization(body);
  }

  async refundCapture(captureId: string, amount: Amount, note: string, requestId: string): Promise<RefundResult> {
    const body = await this.call('captures.refund', 'POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      requestId,
      body: { amount: money(amount), note_to_payer: note.slice(0, 255) },
    });
    return { refundId: body.id, status: body.status, amount: parseAmount(body.amount, amount), raw: body };
  }

  // --- payouts -----------------------------------------------------------------------------

  async createPayout(senderBatchId: string, items: PayoutItemInput[], emailSubject: string): Promise<PayoutResult> {
    const body = await this.call('payouts.create', 'POST', '/v1/payments/payouts', {
      requestId: senderBatchId,
      body: {
        sender_batch_header: { sender_batch_id: senderBatchId, email_subject: emailSubject },
        items: items.map((i) => ({
          recipient_type: 'EMAIL',
          receiver: i.receiverEmail,
          amount: { value: toMajorString(i.amount.minor), currency: i.amount.currency },
          note: i.note,
          sender_item_id: i.senderItemId,
        })),
      },
    });
    return {
      batchId: body.batch_header?.payout_batch_id,
      status: body.batch_header?.batch_status ?? 'PENDING',
      items: items.map((i) => ({ payoutItemId: null, senderItemId: i.senderItemId, status: 'PENDING', receiver: i.receiverEmail, amount: i.amount })),
      raw: body,
    };
  }

  async getPayout(batchId: string): Promise<PayoutResult> {
    const body = await this.call('payouts.get', 'GET', `/v1/payments/payouts/${encodeURIComponent(batchId)}`);
    return {
      batchId,
      status: body.batch_header?.batch_status,
      items: (body.items ?? []).map((it: Json) => ({
        payoutItemId: it.payout_item_id,
        senderItemId: it.payout_item?.sender_item_id,
        status: it.transaction_status,
        receiver: it.payout_item?.receiver,
        amount: { minor: fromMajorString(it.payout_item?.amount?.value ?? '0'), currency: it.payout_item?.amount?.currency ?? 'USD' },
      })),
      raw: body,
    };
  }

  // --- webhooks ----------------------------------------------------------------------------

  async verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<WebhookVerification> {
    if (!this.opts.webhookId) return { verified: false, method: 'skipped', reason: 'PAYPAL_WEBHOOK_ID is not set' };
    const h = (k: string) => headers[k] ?? headers[k.toLowerCase()];
    const required = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
    const missing = required.filter((k) => !h(k));
    if (missing.length) return { verified: false, method: 'paypal-api', reason: `missing headers: ${missing.join(', ')}` };
    const body = await this.call<{ verification_status: string }>('webhooks.verify', 'POST', '/v1/notifications/verify-webhook-signature', {
      body: {
        auth_algo: h('paypal-auth-algo'),
        cert_url: h('paypal-cert-url'),
        transmission_id: h('paypal-transmission-id'),
        transmission_sig: h('paypal-transmission-sig'),
        transmission_time: h('paypal-transmission-time'),
        webhook_id: this.opts.webhookId,
        webhook_event: JSON.parse(rawBody),
      },
    });
    const ok = body.verification_status === 'SUCCESS';
    return { verified: ok, method: 'paypal-api', reason: `verification_status=${body.verification_status}` };
  }

  // --- reporting ---------------------------------------------------------------------------

  async searchTransactions(startIso: string, endIso: string): Promise<TransactionRow[]> {
    // Transaction Search: at most 31 days per request, no fractional seconds.
    const clean = (s: string) => s.replace(/\.\d+Z$/, 'Z');
    const rows: TransactionRow[] = [];
    for (let page = 1, total = 1; page <= total && page <= 20; page++) {
      const q = new URLSearchParams({ start_date: clean(startIso), end_date: clean(endIso), fields: 'all', page_size: '100', page: String(page) });
      const body = await this.call('reporting.transactions', 'GET', `/v1/reporting/transactions?${q}`);
      total = body.total_pages ?? 1;
      for (const d of body.transaction_details ?? []) {
        const t = d.transaction_info ?? {};
        rows.push({
          id: t.transaction_id,
          date: t.transaction_initiation_date,
          eventCode: t.transaction_event_code,
          status: t.transaction_status,
          amount: parseAmount(t.transaction_amount, { minor: 0, currency: 'USD' }),
          fee: t.fee_amount ? parseAmount(t.fee_amount, { minor: 0, currency: 'USD' }) : null,
          counterparty: d.payer_info?.email_address ?? d.payer_info?.payer_name?.alternate_full_name ?? null,
          invoiceId: t.invoice_id ?? null,
          note: t.transaction_note ?? t.transaction_subject ?? null,
        });
      }
    }
    return rows;
  }

  async getBalances(): Promise<BalanceRow[]> {
    const body = await this.call('reporting.balances', 'GET', '/v1/reporting/balances?include_crypto_currencies=false');
    return (body.balances ?? []).map((b: Json) => ({
      currency: b.currency,
      totalMinor: fromMajorString(b.total_balance?.value ?? '0'),
      availableMinor: fromMajorString(b.available_balance?.value ?? '0'),
      withheldMinor: fromMajorString(b.withheld_balance?.value ?? '0'),
    }));
  }
}

const backoff = (attempt: number) => Math.min(8000, 400 * 2 ** attempt) + Math.floor(Math.random() * 200);

function toOrder(body: Json): OrderResult {
  const link = (body.links ?? []).find((l: Json) => l.rel === 'payer-action' || l.rel === 'approve');
  return { orderId: body.id, status: body.status, approvalUrl: link?.href ?? null, raw: body };
}

function toAuthorization(a: Json): AuthorizationResult {
  return {
    authorizationId: a.id,
    status: a.status,
    amount: parseAmount(a.amount, { minor: 0, currency: 'USD' }),
    expiresAt: a.expiration_time ?? null,
    raw: a,
  };
}
