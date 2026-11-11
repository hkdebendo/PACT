-- Live video proof: milestones whose evidence must be filmed live through a one-time link, and the
-- capture sessions (random instructions, timing, frames turned into evidence, Muse check result).

CREATE TABLE live_requirements (
  pact_id TEXT NOT NULL REFERENCES pacts(id),
  milestone_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (pact_id, milestone_id)
);

CREATE TABLE live_sessions (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  pact_id TEXT NOT NULL REFERENCES pacts(id),
  milestone_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'recording', 'checking', 'passed', 'failed', 'expired', 'error')),
  challenges_json TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  started_at TEXT,
  submitted_at TEXT,
  video_path TEXT,
  video_mime TEXT,
  video_sha256 TEXT,
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  check_json TEXT,
  failures_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_by TEXT NOT NULL
);
CREATE INDEX live_sessions_milestone ON live_sessions (pact_id, milestone_id);
