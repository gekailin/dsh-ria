import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const LESSON_CANDIDATE_IMPORT_MARKER = 'lesson_candidates_import_v1'

const hashId = (scope, body) => 'lc_' + createHash('sha1').update(String(scope || '') + '\n' + String(body || '')).digest('hex')
const sourceList = item => {
  const list = Array.isArray(item.sources) ? item.sources.filter(s => s && s.type && s.ref) : []
  return list.length ? list : [{ type: 'file', ref: 'events.jsonl', at: Number(item.at) || 0 }]
}
const normalize = item => {
  const body = String(item.body || item.text || item.rule || item.scenario || '').trim()
  const scope = String(item.scope || 'global')
  const created = Number(item.createdAt || item.at) || Date.now()
  return {
    id: String(item.id || hashId(scope, body)), scope, title: String(item.title || ''),
    body, cause: String(item.cause || ''), sources: sourceList(item),
    status: ['accepted', 'rejected', 'deferred'].includes(item.status) ? item.status : 'pending',
    ticketId: String(item.ticketId || ''), sessionId: String(item.sessionId || ''),
    createdAt: created, updatedAt: Number(item.updatedAt || created),
    reviewedAt: Number(item.reviewedAt) || null, reviewedBy: String(item.reviewedBy || ''),
    rationale: String(item.rationale || ''),
    recorded: item.cause && sourceList(item).length ? 'complete' : 'partial',
  }
}

export function importLessonCandidates({ db, stateDir, now = Date.now() }) {
  const marker = db.prepare('SELECT value FROM schema_meta WHERE key=?').get(LESSON_CANDIDATE_IMPORT_MARKER)
  if (marker) return { skipped: true, reason: 'already_imported', scanned: 0, inserted: 0, duplicates: 0, failed: 0 }
  const files = existsSync(stateDir) ? readdirSync(stateDir).filter(name => name === 'events.jsonl' || /^events-\d{8}T\d{6}\.jsonl$/.test(name)).sort() : []
  let scanned = 0, inserted = 0, duplicates = 0, failed = 0
  const insert = db.prepare('INSERT OR IGNORE INTO cognition_lesson_candidates(id,scope,title,body,cause,sources,status,ticket_id,session_id,created_at,updated_at,reviewed_at,reviewed_by,rationale,recorded,migration_run_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  for (const file of files) {
    for (const line of readFileSync(join(stateDir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      let event
      try { event = JSON.parse(line) } catch { failed += 1; continue }
      if (!['lesson.candidate', 'lesson.created'].includes(event.kind || event.event)) continue
      const item = normalize(event.payload || event)
      if (!item.body) { failed += 1; continue }
      scanned += 1
      try {
        const info = insert.run(item.id, item.scope, item.title, item.body, item.cause, JSON.stringify(item.sources), item.status, item.ticketId, item.sessionId, item.createdAt, item.updatedAt, item.reviewedAt, item.reviewedBy, item.rationale, item.recorded, LESSON_CANDIDATE_IMPORT_MARKER)
        if (info.changes) inserted += 1; else duplicates += 1
      } catch { failed += 1 }
    }
  }
  db.prepare('INSERT OR REPLACE INTO schema_meta(key,value,updated_at) VALUES(?,?,?)').run(LESSON_CANDIDATE_IMPORT_MARKER, JSON.stringify({ at: now, scanned, inserted, duplicates }), now)
  return { skipped: false, scanned, inserted, duplicates, failed, files: files.length }
}
