// SQLite schema for Ria durable state (tickets, topics, execution state, cognition).
// Logs live under stateDir/logs/YYYY-MM-DD/{router-events,role-context,audit}.jsonl.
export const SCHEMA_VERSION = 1

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
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

-- Cognition is SQLite-authoritative.
CREATE TABLE IF NOT EXISTS cognition_entries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'experience' CHECK (kind IN ('preference','agreement','overview','experience')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disputed','retired')),
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
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cognition_proposals (
  id TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'add' CHECK (kind IN ('add','correct','retire')),
  scope TEXT NOT NULL DEFAULT 'global',
  target_entry_id TEXT,
  ticket_id TEXT,
  body TEXT NOT NULL,
  cause TEXT NOT NULL DEFAULT '',
  sources TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sources)),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal','low')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','deferred','merged')),
  decided_by TEXT,
  decided_at INTEGER,
  rationale TEXT,
  evidence_refs TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_refs)),
  affected_entries TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(affected_entries)),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cog_proposals_status_prio ON cognition_proposals(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_cog_proposals_ticket ON cognition_proposals(ticket_id);
CREATE INDEX IF NOT EXISTS idx_cog_proposals_target ON cognition_proposals(target_entry_id);

-- Durable execution state (migrated from events.jsonl).
CREATE TABLE IF NOT EXISTS work_orders (
  ticket_id TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
);
CREATE TABLE IF NOT EXISTS ticket_reports (
  id TEXT PRIMARY KEY,
  ticket_id TEXT,
  at INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
);
CREATE INDEX IF NOT EXISTS idx_ticket_reports_ticket_at ON ticket_reports(ticket_id, at);
CREATE TABLE IF NOT EXISTS executor_inbox (
  id TEXT PRIMARY KEY,
  ticket_id TEXT,
  executor_id TEXT,
  delivered_at INTEGER,
  discarded_at INTEGER,
  at INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
);
CREATE INDEX IF NOT EXISTS idx_executor_inbox_pending ON executor_inbox(ticket_id, executor_id, delivered_at, discarded_at);
CREATE TABLE IF NOT EXISTS ticket_requests (
  id TEXT PRIMARY KEY,
  ticket_id TEXT,
  created_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
);
CREATE INDEX IF NOT EXISTS idx_ticket_requests_ticket ON ticket_requests(ticket_id);
CREATE TABLE IF NOT EXISTS ticket_feedback (
  id TEXT PRIMARY KEY,
  ticket_id TEXT,
  at INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
);
CREATE INDEX IF NOT EXISTS idx_ticket_feedback_ticket_at ON ticket_feedback(ticket_id, at);
`

const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
const hasColumn = (db, table, column) => db.prepare('PRAGMA table_info(' + table + ')').all().some(col => col.name === column)

/**
 * Ordered, idempotent schema migrations run on writable DB open.
 * Each migration executes inside a single transaction and records itself in schema_migrations.
 */
export const MIGRATIONS = [
  {
    version: 1,
    name: 'merge_cognition_receipts_and_drop_legacy_tables',
    up(db) {
      if (hasTable(db, 'cognition_proposals')) {
        if (!hasColumn(db, 'cognition_proposals', 'evidence_refs')) {
          db.exec("ALTER TABLE cognition_proposals ADD COLUMN evidence_refs TEXT NOT NULL DEFAULT '[]'")
        }
        if (!hasColumn(db, 'cognition_proposals', 'affected_entries')) {
          db.exec("ALTER TABLE cognition_proposals ADD COLUMN affected_entries TEXT NOT NULL DEFAULT '[]'")
        }
        if (hasTable(db, 'cognition_receipts')) {
          const receipts = db.prepare('SELECT * FROM cognition_receipts').all()
          const update = db.prepare(`UPDATE cognition_proposals
            SET status=COALESCE(NULLIF(status,'pending'), ?),
                rationale=COALESCE(rationale, ?),
                decided_by=COALESCE(decided_by, ?),
                decided_at=COALESCE(decided_at, ?),
                evidence_refs=?,
                affected_entries=?
            WHERE id=?`)
          for (const r of receipts) {
            update.run(r.decision, r.rationale, r.decided_by, r.decided_at, r.evidence_refs || '[]', r.affected_entries || '[]', r.proposal_id)
          }
          db.exec('DROP TABLE cognition_receipts')
        }
        db.exec('CREATE INDEX IF NOT EXISTS idx_cog_proposals_ticket ON cognition_proposals(ticket_id)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_cog_proposals_target ON cognition_proposals(target_entry_id)')
      }
      if (hasTable(db, 'cognition_lesson_candidates')) db.exec('DROP TABLE cognition_lesson_candidates')
      if (hasTable(db, 'lessons')) db.exec('DROP TABLE lessons')
    },
  },
  {
    version: 2,
    name: 'normalize_legacy_proposal_statuses_and_authors',
    up(db) {
      if (hasTable(db, 'cognition_proposals')) {
        db.exec("UPDATE cognition_proposals SET status='rejected' WHERE status='denied'")
        db.exec("UPDATE cognition_proposals SET author='executor:legacy' WHERE author='worker'")
      }
    },
  },
]

export function applyMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`)
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(row => Number(row.version)))
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      migration.up(db)
      db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)').run(migration.version, migration.name, Date.now())
      db.exec('COMMIT')
    } catch (cause) {
      try { db.exec('ROLLBACK') } catch { /* retain original failure */ }
      throw cause
    }
  }
}
