// Durable, append-only operation log for host-side maintenance events.
// One JSON object per line; grep by event. Used by the temporary naming
// migration and deprecated tool aliases so both land in the same file.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const OPERATION_LOG_FILE = 'operation-events.jsonl'

export function appendOperationLog(stateDir, record = {}) {
  if (!stateDir) return null
  const dir = String(stateDir)
  mkdirSync(dir, { recursive: true })
  const entry = { at: Date.now(), ...record }
  appendFileSync(join(dir, OPERATION_LOG_FILE), JSON.stringify(entry) + '\n', { mode: 0o600 })
  return entry
}
