// Drizzle table definitions mirroring migrations/*.sql (the SQL files are the source of truth for
// DDL; `test/db.test.ts` checks the two stay in sync by round-tripping a row through every table).
import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const parties = sqliteTable('parties', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['human', 'agent'] }).notNull(),
  email: text('email'),
  createdAt: text('created_at').notNull(),
});

export const pacts = sqliteTable('pacts', {
  id: text('id').primaryKey(),
  status: text('status').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  sourceText: text('source_text'),
  currency: text('currency').notNull(),
  totalMinor: integer('total_minor').notNull(),
  deadline: text('deadline').notNull(),
  buyerId: text('buyer_id').notNull(),
  sellerId: text('seller_id').notNull(),
  contractJson: text('contract_json').notNull(),
  machineJson: text('machine_json').notNull(),
  paymentMode: text('payment_mode').notNull(),
  orderId: text('order_id'),
  approvalUrl: text('approval_url'),
  authorizationId: text('authorization_id'),
  authorizationExpiresAt: text('authorization_expires_at'),
  honorPeriodEndsAt: text('honor_period_ends_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const milestones = sqliteTable(
  'milestones',
  {
    pactId: text('pact_id').notNull(),
    id: text('id').notNull(),
    position: integer('position').notNull(),
    title: text('title').notNull(),
    percent: integer('percent').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    capturedMinor: integer('captured_minor').notNull().default(0),
    refundedMinor: integer('refunded_minor').notNull().default(0),
    deadline: text('deadline').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    releasedAt: text('released_at'),
  },
  (t) => [primaryKey({ columns: [t.pactId, t.id] })],
);

export const evidence = sqliteTable('evidence', {
  id: text('id').primaryKey(),
  pactId: text('pact_id').notNull(),
  milestoneId: text('milestone_id').notNull(),
  type: text('type').notNull(),
  filename: text('filename').notNull(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  sha256: text('sha256').notNull(),
  path: text('path').notNull(),
  note: text('note'),
  descriptionJson: text('description_json'),
  submittedBy: text('submitted_by').notNull(),
  createdAt: text('created_at').notNull(),
});

export const verdicts = sqliteTable('verdicts', {
  id: text('id').primaryKey(),
  pactId: text('pact_id').notNull(),
  milestoneId: text('milestone_id').notNull(),
  kind: text('kind', { enum: ['verifier', 'arbiter', 'human'] }).notNull(),
  status: text('status').notNull(),
  confidence: real('confidence').notNull(),
  reasoning: text('reasoning').notNull(),
  payloadJson: text('payload_json'),
  precheckJson: text('precheck_json').notNull().default('[]'),
  evidenceIdsJson: text('evidence_ids_json').notNull().default('[]'),
  model: text('model'),
  llmMode: text('llm_mode'),
  appealStatus: text('appeal_status').notNull().default('none'),
  appealNote: text('appeal_note'),
  createdAt: text('created_at').notNull(),
});

export const disputes = sqliteTable('disputes', {
  id: text('id').primaryKey(),
  pactId: text('pact_id').notNull(),
  milestoneId: text('milestone_id').notNull(),
  openedBy: text('opened_by').notNull(),
  buyerStatement: text('buyer_statement'),
  sellerStatement: text('seller_statement'),
  status: text('status').notNull().default('open'),
  verdictId: text('verdict_id'),
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at'),
});

export const payments = sqliteTable('payments', {
  id: text('id').primaryKey(),
  pactId: text('pact_id').notNull(),
  milestoneId: text('milestone_id'),
  kind: text('kind').notNull(),
  paypalId: text('paypal_id'),
  parentPaypalId: text('parent_paypal_id'),
  amountMinor: integer('amount_minor').notNull(),
  currency: text('currency').notNull(),
  status: text('status').notNull(),
  mode: text('mode').notNull(),
  requestId: text('request_id'),
  rawJson: text('raw_json'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const auditLog = sqliteTable('audit_log', {
  seq: integer('seq').primaryKey(),
  ts: text('ts').notNull(),
  pactId: text('pact_id'),
  actor: text('actor').notNull(),
  type: text('type').notNull(),
  dataJson: text('data_json').notNull(),
  prevHash: text('prev_hash').notNull(),
  hash: text('hash').notNull(),
});

export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  payloadJson: text('payload_json').notNull(),
  runAt: text('run_at').notNull(),
  status: text('status').notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  lastError: text('last_error'),
  dedupeKey: text('dedupe_key'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const idempotency = sqliteTable('idempotency', {
  key: text('key').primaryKey(),
  scope: text('scope').notNull(),
  statusCode: integer('status_code').notNull(),
  responseJson: text('response_json').notNull(),
  createdAt: text('created_at').notNull(),
});

export const llmUsage = sqliteTable('llm_usage', {
  id: text('id').primaryKey(),
  role: text('role').notNull(),
  model: text('model').notNull(),
  mode: text('mode').notNull(),
  cacheHit: integer('cache_hit', { mode: 'boolean' }).notNull().default(false),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  reasoningTokens: integer('reasoning_tokens').notNull().default(0),
  cachedTokens: integer('cached_tokens').notNull().default(0),
  costUsd: real('cost_usd').notNull().default(0),
  latencyMs: integer('latency_ms').notNull().default(0),
  pactId: text('pact_id'),
  createdAt: text('created_at').notNull(),
});

export const webhookEvents = sqliteTable('webhook_events', {
  id: text('id').primaryKey(),
  eventType: text('event_type').notNull(),
  resourceId: text('resource_id'),
  verified: integer('verified', { mode: 'boolean' }).notNull(),
  verification: text('verification').notNull(),
  payloadJson: text('payload_json').notNull(),
  processedAt: text('processed_at'),
  createdAt: text('created_at').notNull(),
});

export const reputationSnapshots = sqliteTable(
  'reputation_snapshots',
  {
    partyId: text('party_id').notNull(),
    at: text('at').notNull(),
    score: real('score').notNull(),
  },
  (t) => [primaryKey({ columns: [t.partyId, t.at] })],
);
