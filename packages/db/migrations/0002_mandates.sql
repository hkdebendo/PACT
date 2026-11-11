-- Agent mandates: limits a human owner sets for an MCP agent (enforced server-side), and the
-- approval requests an agent raises when a pact needs its owner's go-ahead.

CREATE TABLE agent_mandates (
  agent TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  currency TEXT NOT NULL,
  max_pact_minor INTEGER,
  max_open_minor INTEGER,
  approval_above_minor INTEGER,
  categories_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE mandate_approvals (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  pact_id TEXT NOT NULL REFERENCES pacts(id),
  total_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);
CREATE INDEX mandate_approvals_pact ON mandate_approvals (pact_id);
