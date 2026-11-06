-- PACT initial schema. Money in integer minor units. JSON payloads in *_json TEXT columns.

CREATE TABLE parties (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  email TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE pacts (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  source_text TEXT,
  currency TEXT NOT NULL,
  total_minor INTEGER NOT NULL,
  deadline TEXT NOT NULL,
  buyer_id TEXT NOT NULL REFERENCES parties(id),
  seller_id TEXT NOT NULL REFERENCES parties(id),
  contract_json TEXT NOT NULL,
  machine_json TEXT NOT NULL,
  payment_mode TEXT NOT NULL,
  order_id TEXT,
  approval_url TEXT,
  authorization_id TEXT,
  authorization_expires_at TEXT,
  honor_period_ends_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX pacts_status ON pacts(status);
CREATE INDEX pacts_order ON pacts(order_id);

CREATE TABLE milestones (
  pact_id TEXT NOT NULL REFERENCES pacts(id),
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  percent INTEGER NOT NULL,
  amount_minor INTEGER NOT NULL,
  captured_minor INTEGER NOT NULL DEFAULT 0,
  refunded_minor INTEGER NOT NULL DEFAULT 0,
  deadline TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  released_at TEXT,
  PRIMARY KEY (pact_id, id)
);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  pact_id TEXT NOT NULL REFERENCES pacts(id),
  milestone_id TEXT NOT NULL,
  type TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  path TEXT NOT NULL,
  note TEXT,
  description_json TEXT,
  submitted_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX evidence_sha ON evidence(sha256);
CREATE INDEX evidence_pact ON evidence(pact_id, milestone_id);

CREATE TABLE verdicts (
  id TEXT PRIMARY KEY,
  pact_id TEXT NOT NULL REFERENCES pacts(id),
  milestone_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('verifier', 'arbiter', 'human')),
  status TEXT NOT NULL,
  confidence REAL NOT NULL,
  reasoning TEXT NOT NULL,
  payload_json TEXT,
  precheck_json TEXT NOT NULL DEFAULT '[]',
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  llm_mode TEXT,
  appeal_status TEXT NOT NULL DEFAULT 'none',
  appeal_note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX verdicts_pact ON verdicts(pact_id, milestone_id);

CREATE TABLE disputes (
  id TEXT PRIMARY KEY,
  pact_id TEXT NOT NULL REFERENCES pacts(id),
  milestone_id TEXT NOT NULL,
  opened_by TEXT NOT NULL,
  buyer_statement TEXT,
  seller_statement TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  verdict_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  pact_id TEXT NOT NULL REFERENCES pacts(id),
  milestone_id TEXT,
  kind TEXT NOT NULL,
  paypal_id TEXT,
  parent_paypal_id TEXT,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  request_id TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX payments_pact ON payments(pact_id);
CREATE INDEX payments_paypal ON payments(paypal_id);

CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  pact_id TEXT,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE
);
CREATE INDEX audit_pact ON audit_log(pact_id);
-- Append-only: the database itself refuses edits and deletes.
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  run_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error TEXT,
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX jobs_due ON jobs(status, run_at);

CREATE TABLE idempotency (
  key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE llm_usage (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  mode TEXT NOT NULL,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  pact_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  resource_id TEXT,
  verified INTEGER NOT NULL,
  verification TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  processed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE reputation_snapshots (
  party_id TEXT NOT NULL REFERENCES parties(id),
  at TEXT NOT NULL,
  score REAL NOT NULL,
  PRIMARY KEY (party_id, at)
);
