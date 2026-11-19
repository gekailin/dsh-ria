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
`
