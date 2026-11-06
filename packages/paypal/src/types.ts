// The PaymentsGateway interface: everything PACT needs from PayPal. Two implementations:
//   - SandboxGateway  (sandbox.ts):   real calls to https://api-m.sandbox.paypal.com
//   - SimulatedGateway (simulated.ts): SIMULATED in-process stand-in, labelled in the UI and API
// Amounts are integer minor units; conversion to PayPal's decimal strings happens inside the gateway.

export type GatewayMode = 'sandbox' | 'simulated';

export interface Amount {
  minor: number;
  currency: string;
}

export interface CreateOrderInput {
  pactId: string;
  description: string;
  amount: Amount;
  returnUrl: string;
  cancelUrl: string;
  requestId: string;
}

export interface OrderResult {
  orderId: string;
  status: string; // CREATED | APPROVED | COMPLETED | VOIDED | PAYER_ACTION_REQUIRED
  approvalUrl: string | null;
  raw: unknown;
}

export interface AuthorizationResult {
  authorizationId: string;
  status: string; // CREATED | CAPTURED | PARTIALLY_CAPTURED | VOIDED | EXPIRED | DENIED | PENDING
  amount: Amount;
  expiresAt: string | null;
  raw: unknown;
}

export interface CaptureInput {
  amount: Amount;
  finalCapture: boolean;
  invoiceId?: string;
  noteToPayer?: string;
  requestId: string;
}

export interface CaptureResult {
  captureId: string;
  status: string; // COMPLETED | PENDING | DECLINED ...
  amount: Amount;
  finalCapture: boolean;
  raw: unknown;
}

export interface RefundResult {
  refundId: string;
  status: string;
  amount: Amount;
  raw: unknown;
}

export interface PayoutItemInput {
  receiverEmail: string;
  amount: Amount;
  note: string;
  senderItemId: string;
}

export interface PayoutResult {
  batchId: string;
  status: string; // PENDING | PROCESSING | SUCCESS | DENIED ...
  items: { payoutItemId: string | null; senderItemId: string; status: string; receiver: string; amount: Amount }[];
  raw: unknown;
}

export interface WebhookVerification {
  verified: boolean;
  method: 'paypal-api' | 'simulated' | 'skipped';
  reason: string;
}

export interface TransactionRow {
  id: string;
  date: string;
  eventCode: string;
  status: string;
  amount: Amount;
  fee: Amount | null;
  counterparty: string | null;
  invoiceId: string | null;
  note: string | null;
}

export interface BalanceRow {
  currency: string;
  totalMinor: number;
  availableMinor: number;
  withheldMinor: number;
}

export interface PaymentsGateway {
  readonly mode: GatewayMode;
  createAuthorizeOrder(input: CreateOrderInput): Promise<OrderResult>;
  getOrder(orderId: string): Promise<OrderResult>;
  authorizeOrder(orderId: string, requestId: string): Promise<AuthorizationResult>;
  getAuthorization(authorizationId: string): Promise<AuthorizationResult>;
  captureAuthorization(authorizationId: string, input: CaptureInput): Promise<CaptureResult>;
  voidAuthorization(authorizationId: string, requestId: string): Promise<AuthorizationResult>;
  reauthorize(authorizationId: string, amount: Amount, requestId: string): Promise<AuthorizationResult>;
  refundCapture(captureId: string, amount: Amount, note: string, requestId: string): Promise<RefundResult>;
  createPayout(senderBatchId: string, items: PayoutItemInput[], emailSubject: string): Promise<PayoutResult>;
  getPayout(batchId: string): Promise<PayoutResult>;
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<WebhookVerification>;
  searchTransactions(startIso: string, endIso: string): Promise<TransactionRow[]>;
  getBalances(): Promise<BalanceRow[]>;
}
