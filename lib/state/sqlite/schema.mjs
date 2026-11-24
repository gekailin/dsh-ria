// P1 owns only tickets and their append-only history. Other domains stay JSON.
export const SCHEMA_VERSION = 1
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL, waiting_on TEXT, executor TEXT,
  goal TEXT NOT NULL, acceptance TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER,
  phase TEXT, project_cwd TEXT,
  attempt_json TEXT NOT NULL CHECK (json_valid(attempt_json)),
  failure_json TEXT NOT NULL CHECK (json_valid(failure_json)),
  resolution_json TEXT NOT NULL CHECK (json_valid(resolution_json)),
  meta TEXT NOT NULL CHECK (json_valid(meta)),
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tickets_status_updated ON tickets(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_tickets_executor ON tickets(executor);
CREATE INDEX IF NOT EXISTS idx_tickets_archive ON tickets(archived_at);
CREATE TABLE IF NOT EXISTS ticket_history (
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  seq INTEGER NOT NULL CHECK (seq >= 0), at INTEGER NOT NULL,
  from_status TEXT, to_status TEXT, actor TEXT, reason TEXT, kind TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (ticket_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_ticket_history_ticket_at ON ticket_history(ticket_id, at);
CREATE TRIGGER IF NOT EXISTS ticket_history_no_update
BEFORE UPDATE ON ticket_history BEGIN
  SELECT RAISE(ABORT, 'ticket_history is append-only');
END;
CREATE TRIGGER IF NOT EXISTS ticket_history_no_delete
BEFORE DELETE ON ticket_history BEGIN
  SELECT RAISE(ABORT, 'ticket_history is append-only');
END;
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project_key TEXT,
  tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  brief TEXT NOT NULL DEFAULT '',
  archived_at INTEGER,
  merged_into TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topics_project_updated ON topics(project_key, updated_at);
CREATE TABLE IF NOT EXISTS topic_links (
  topic_id TEXT NOT NULL REFERENCES topics(id),
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  role TEXT NOT NULL CHECK (role IN ('primary','related')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (topic_id, ticket_id)
);
CREATE INDEX IF NOT EXISTS idx_topic_links_ticket ON topic_links(ticket_id);
CREATE INDEX IF NOT EXISTS idx_topic_links_role ON topic_links(role);
-- DEPRECATED (B-2): table retained for history; data migrated to cognition.
-- DEPRECATED (B-2): table retained for history; data migrated to cognition.
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',
  scenario TEXT NOT NULL DEFAULT '',
  approach TEXT NOT NULL DEFAULT '',
  pitfall TEXT NOT NULL DEFAULT '',
  evidence TEXT CHECK (evidence IS NULL OR json_valid(evidence)),
  ticket_id TEXT,
  report_id TEXT,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_lessons_status ON lessons(status);
CREATE INDEX IF NOT EXISTS idx_lessons_ticket ON lessons(ticket_id);

-- Cognition is SQLite-authoritative (Phase 1). These tables are additive and
-- idempotent; existing DBs get them on the next writable open without a
-- version bump. Markdown cognition/ remains a read-only migration source.
CREATE TABLE IF NOT EXISTS cognition_entries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'experience',
  status TEXT NOT NULL DEFAULT 'active',
  tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  body TEXT NOT NULL,
  cause TEXT,
  recorded TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  sources TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sources)),
  superseded_by TEXT,
  dispute_reason TEXT,
  created_by TEXT NOT NULL DEFAULT 'sage',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  verified_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cog_entries_scope_status ON cognition_entries(scope, status);
CREATE INDEX IF NOT EXISTS idx_cog_entries_status_updated ON cognition_entries(status, updated_at);
CREATE TABLE IF NOT EXISTS cognition_projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspaces TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(workspaces)),
  overview TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cognition_proposals (
  id TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'add',
  scope TEXT NOT NULL DEFAULT 'global',
  target_entry_id TEXT,
  ticket_id TEXT,
  body TEXT NOT NULL,
  cause TEXT NOT NULL DEFAULT '',
  sources TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sources)),
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  decided_at INTEGER,
  rationale TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cog_proposals_status_prio ON cognition_proposals(status, priority, created_at);
-- One verification receipt per proposal decision (Phase 1.4). Additive table;
-- no historical rows are migrated.
CREATE TABLE IF NOT EXISTS cognition_lesson_candidates (
  id TEXT PRIMARY KEY,
  scope TEXT,
  title TEXT,
  body TEXT NOT NULL,
  cause TEXT,
  sources TEXT NOT NULL CHECK (json_valid(sources)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','deferred')),
  ticket_id TEXT,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by TEXT,
  rationale TEXT,
  recorded TEXT,
  migration_run_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_clc_status ON cognition_lesson_candidates(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clc_scope ON cognition_lesson_candidates(scope);

CREATE TABLE IF NOT EXISTS cognition_receipts (
  proposal_id TEXT PRIMARY KEY,
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  evidence_refs TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_refs)),
  affected_entries TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(affected_entries)),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cog_receipts_decision_at ON cognition_receipts(decision, decided_at);
`
