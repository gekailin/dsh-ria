import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from '../atomic-file.mjs'
import { transaction } from './db.mjs'

export const ARCHIVE_CLEANUP_META_KEY = 'archive_records_cleanup'

const parseMeta = row => {
  try { return JSON.parse(row.meta) } catch { return null }
}

export function inspectArchiveRecords(db) {
  const rows = db.prepare("SELECT id,meta FROM tickets WHERE json_type(meta,'$.archiveRecords') IS NOT NULL ORDER BY id").all()
  const total = Number(db.prepare('SELECT COUNT(*) n FROM tickets').get().n)
  const avg = db.prepare('SELECT avg(length(meta)) a FROM tickets').get().a
  return { rows: rows.length, tickets: total, avgMeta: Number(avg) || 0, bytes: rows.reduce((sum, row) => sum + String(row.meta).length, 0) }
}

export function cleanupArchiveRecords(db, { apply = false, stateDir, now = Date.now(), runId = null } = {}) {
  const before = inspectArchiveRecords(db)
  if (!apply || before.rows === 0) return { ok: true, applied: false, before, after: before, runId: null, journal: null }
  const id = runId || 'archive-records-' + new Date(now).toISOString().replace(/[:.]/g, '-')
  const journal = join(stateDir, 'archive-records-rollback-' + id + '.json')
  const rows = db.prepare("SELECT id,meta FROM tickets WHERE json_type(meta,'$.archiveRecords') IS NOT NULL ORDER BY id").all()
  const backups = []
  const updates = []
  for (const row of rows) {
    const envelope = parseMeta(row)
    if (!envelope || !Object.hasOwn(envelope, 'archiveRecords')) continue
    backups.push({ ticketId: row.id, archiveRecords: envelope.archiveRecords })
    delete envelope.archiveRecords
    updates.push({ ticketId: row.id, meta: JSON.stringify(envelope) })
  }
  if (!updates.length) return { ok: true, applied: false, before, after: before, runId: null, journal: null }
  writeAtomic(journal, JSON.stringify({ runId: id, appliedAt: now, stateDir, backups }, null, 2) + '\n')
  transaction(db, () => {
    const update = db.prepare('UPDATE tickets SET meta=? WHERE id=?')
    for (const item of updates) update.run(item.meta, item.ticketId)
    db.prepare('INSERT INTO schema_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .run(ARCHIVE_CLEANUP_META_KEY, JSON.stringify({ runId: id, appliedAt: now, tickets: updates.length, journal }), now)
  })
  const after = inspectArchiveRecords(db)
  return { ok: true, applied: true, before, after, runId: id, journal, tickets: updates.length, reclaimedBytes: before.bytes - after.bytes }
}

export function rollbackArchiveRecords(db, { stateDir, runId = null } = {}) {
  const markerRow = db.prepare('SELECT value FROM schema_meta WHERE key=?').get(ARCHIVE_CLEANUP_META_KEY)
  if (!markerRow) return { ok: false, code: 'archive_cleanup_missing', message: 'no archiveRecords cleanup marker' }
  let marker
  try { marker = JSON.parse(markerRow.value) } catch { return { ok: false, code: 'archive_cleanup_invalid', message: 'invalid cleanup marker' } }
  if (runId && marker.runId !== runId) return { ok: false, code: 'archive_cleanup_run_mismatch', message: 'cleanup runId does not match', runId: marker.runId }
  if (!existsSync(marker.journal)) return { ok: false, code: 'archive_cleanup_journal_missing', message: 'cleanup journal is missing', journal: marker.journal }
  let journal
  try { journal = JSON.parse(readFileSync(marker.journal, 'utf8')) } catch (cause) {
    return { ok: false, code: 'archive_cleanup_journal_invalid', message: String(cause && cause.message ? cause.message : cause), journal: marker.journal }
  }
  if (!Array.isArray(journal.backups)) return { ok: false, code: 'archive_cleanup_journal_invalid', message: 'cleanup journal has no backups' }
  let restored = 0
  let skipped = 0
  transaction(db, () => {
    for (const item of journal.backups) {
      const row = db.prepare('SELECT meta FROM tickets WHERE id=?').get(item.ticketId)
      if (!row) { skipped += 1; continue }
      const envelope = parseMeta(row)
      if (!envelope || Object.hasOwn(envelope, 'archiveRecords')) { skipped += 1; continue }
      envelope.archiveRecords = item.archiveRecords
      db.prepare('UPDATE tickets SET meta=? WHERE id=?').run(JSON.stringify(envelope), item.ticketId)
      restored += 1
    }
    db.prepare('DELETE FROM schema_meta WHERE key=?').run(ARCHIVE_CLEANUP_META_KEY)
  })
  try { rmSync(marker.journal, { force: true }) } catch { /* journal cleanup is best effort */ }
  return { ok: true, restored, skipped, runId: marker.runId, journal: marker.journal }
}
